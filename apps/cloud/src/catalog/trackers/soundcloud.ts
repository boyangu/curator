// A label's SoundCloud profile, through the official API with the app's
// credentials (CURATOR_SOUNDCLOUD_CLIENT_ID / _SECRET; client-credentials
// token, cached: SoundCloud allows fifty token requests in twelve hours).
// The profile's id is the numeric one the profiler read off its page, or,
// when it could not, the one the poll resolves through the API's /resolve.
//
// An upload with an ISRC is a release the label announced (often ahead of
// the stores): a release claim with that one track, the label as entity, so
// it raises for the label's watchers and the resolver finds its Spotify id.
// One without an ISRC is tentative, like a YouTube upload: attached to the
// recording it names when known, else an announcement signal. Playback
// stays with the user's own provider: SoundCloud's terms allow no mixing.
//
// The profile's albums (its /albums tab: sets typed album, EP, single,
// compilation — not its loose playlists) are the label's releases as it
// files them: "Maeve 034 - Jonathan Kaspar - Can't Stop", a date, the
// tracks (ISRCs on the newer ones). Each is a release claim; the back
// catalogue arrives on the first poll and raises nothing (the event window).

import type { CatalogClaim, CatalogKind } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { getJson, listingHash, ProviderHttpError, rememberSeen, type FetchLike } from './http.js';
import { TrackerRateLimitedError, type TrackerAdapter, type TrackerPoll, type TrackerTarget } from './types.js';
import { parseUploadTitle, splitCatalogNumber, splitCredit, stripFormatWord } from './upload-title.js';

const API = 'https://api.soundcloud.com';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const ANNOUNCE_WITHIN_DAYS = 60;
const ALBUM_TYPES = new Set(['album', 'ep', 'single', 'compilation']);

export type SoundCloudCredentials = { clientId: string; clientSecret: string };

type ScTrack = {
	id: number;
	urn?: string;
	title: string;
	permalink_url?: string;
	artwork_url?: string | null;
	created_at?: string;
	duration?: number;
	// "playable" | "preview" | "blocked": a preview track's `duration` is the
	// thirty-second preview's, not the track's.
	access?: string | null;
	// The artists as the uploader filled them in ("Mano Le Tough, DJ Koze").
	metadata_artist?: string | null;
	isrc?: string | null;
	label_name?: string | null;
	genre?: string | null;
	bpm?: number | null;
	key_signature?: string | null;
	release_date?: string | null;
	release_year?: number | null;
	release_month?: number | null;
	release_day?: number | null;
	user?: { id?: number; username?: string };
};
type ScSet = {
	id: number;
	title: string;
	permalink_url?: string;
	artwork_url?: string | null;
	created_at?: string;
	// "album" | "ep" | "single" | "compilation" | "PLAYLIST" — `playlist_type`
	// on the live API (2026-10-28), `set_type` in older documentation.
	playlist_type?: string | null;
	set_type?: string | null;
	label_name?: string | null;
	genre?: string | null;
	release_date?: string | null;
	release_year?: number | null;
	release_month?: number | null;
	release_day?: number | null;
	track_count?: number;
	user?: { id?: number; username?: string };
	tracks?: ScTrack[];
};

// SoundCloud's own date spelling: "2026/10/24 10:00:00 +0000".
const parseScDate = (s?: string | null): number | null => {
	if (!s) return null;
	const t = Date.parse(s.replace(/^(\d{4})\/(\d{2})\/(\d{2}) /, '$1-$2-$3T').replace(/ \+0000$/, 'Z'));
	return Number.isFinite(t) ? t : null;
};
const isoDay = (ms: number | null): string | undefined => (ms === null ? undefined : new Date(ms).toISOString().slice(0, 10));
const pad = (n: number) => String(n).padStart(2, '0');
// The release date as the uploader set it (year, month, day: as much as
// given), else the upload's own.
const releaseDateOf = (x: Pick<ScTrack, 'release_year' | 'release_month' | 'release_day' | 'release_date'>, at: number | null): string | undefined =>
	x.release_year ? `${x.release_year}${x.release_month ? `-${pad(x.release_month)}${x.release_day ? `-${pad(x.release_day)}` : ''}` : ''}` : isoDay(parseScDate(x.release_date) ?? at);
const cover = (url?: string | null) => (url ? { coverUrl: url.replace('-large.', '-t500x500.') } : {});
const userArtist = (name: string): CatalogClaim => ({ provider: 'user', kind: 'artist', providerId: `name:${nameFold(name)}`, name });

// Who a track is by: the uploader's own artist field, else the title's
// credit, else the uploading account when it is not the label's own (a set
// on the label's profile lists the artists' uploads). Never the label's name.
function trackArtists(t: ScTrack, titleArtists: string[], labelUserId: string): string[] {
	const meta = splitCredit(t.metadata_artist ?? '');
	if (meta.length) return meta;
	if (titleArtists.length) return titleArtists;
	return t.user?.username && String(t.user.id ?? '') !== labelUserId ? [t.user.username] : [];
}

function recordingOf(t: ScTrack, title: string, artists: CatalogClaim[], at: number | null): CatalogClaim {
	return {
		provider: 'soundcloud',
		kind: 'recording',
		providerId: String(t.id),
		name: title || t.title,
		url: t.permalink_url ?? null,
		identifiers: t.isrc ? [{ namespace: 'isrc', value: t.isrc }] : [],
		facts: {
			...(t.duration && (t.access ?? 'playable') === 'playable' ? { durationSec: Math.round(t.duration / 100) / 10 } : {}),
			...(t.bpm ? { bpm: t.bpm } : {}),
			...(t.key_signature ? { key: t.key_signature } : {}),
			...(t.metadata_artist?.trim() ? { creditText: t.metadata_artist.trim().slice(0, 500) } : {}),
			...cover(t.artwork_url),
		},
		artists,
		publishedAt: at,
	};
}

export class SoundCloudTracker implements TrackerAdapter {
	readonly provider = 'soundcloud' as const;
	readonly kinds: readonly CatalogKind[] = ['label'];
	// The uploads, then the albums.
	readonly callsPerPoll = 2;
	private token: { value: string; expiresAt: number } | null = null;

	constructor(
		private readonly creds: SoundCloudCredentials,
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly now: () => number = Date.now,
	) {}

	async accessToken(signal?: AbortSignal): Promise<string> {
		if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token.value;
		const res = await this.fetchFn(TOKEN_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json; charset=utf-8',
				authorization: `Basic ${Buffer.from(`${this.creds.clientId}:${this.creds.clientSecret}`).toString('base64')}`,
			},
			body: 'grant_type=client_credentials',
			signal,
		});
		if (res.status === 429) throw new TrackerRateLimitedError(3600);
		if (!res.ok) throw new Error(`soundcloud token ${res.status}`);
		const j = (await res.json()) as { access_token: string; expires_in?: number };
		this.token = { value: j.access_token, expiresAt: this.now() + (j.expires_in ?? 3600) * 1000 };
		return j.access_token;
	}

	async get<T>(path: string, signal: AbortSignal): Promise<T> {
		const token = await this.accessToken(signal);
		return getJson<T>(this.fetchFn, 'soundcloud', `${API}${path}`, { headers: { authorization: `OAuth ${token}` }, signal, logPath: path.split('?')[0]!.replace(/\d+/g, '<id>') });
	}

	async poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		if (!target.representation) throw new Error('soundcloud label tracker needs a user id');
		const stored = target.representation.providerId;
		// A permalink the profiler could not resolve off the profile page (the
		// page's hydration is not always served to a server fetch) is resolved
		// here through the API, which says plainly whether the profile exists:
		// a 404 is a dead page, anything else a transient failure. One call
		// beyond the poll's reservation, once per label.
		const userId = /^\d+$/.test(stored) ? stored : await this.resolveUser(target.representation.url ?? `https://soundcloud.com/${stored}`, stored, signal);
		const r = await this.get<{ collection?: ScTrack[] } | ScTrack[]>(`/users/${userId}/tracks?limit=50&linked_partitioning=true`, signal);
		const tracks = Array.isArray(r) ? r : r.collection ?? [];
		const seen = new Set(Array.isArray(target.cursor.seen) ? (target.cursor.seen as string[]) : []);
		const cutoff = this.now() - ANNOUNCE_WITHIN_DAYS * 86400_000;
		const label: CatalogClaim = { provider: 'soundcloud', kind: 'label', providerId: userId, name: target.object.name, url: target.representation.url };
		const children: CatalogClaim[] = [];
		const tentative: CatalogClaim[] = [];
		for (const t of tracks) {
			const id = String(t.id);
			if (seen.has(id)) continue;
			const at = parseScDate(t.created_at);
			if (at === null || at < cutoff) continue;
			const credit = parseUploadTitle(t.title);
			const artists = trackArtists(t, credit.artists, userId).map(userArtist);
			const releaseDate = releaseDateOf(t, at);
			const recording = recordingOf(t, credit.title, artists, at);
			if (t.isrc && artists.length) {
				children.push({
					provider: 'soundcloud',
					kind: 'release',
					providerId: id,
					name: credit.title || t.title,
					url: t.permalink_url ?? null,
					facts: {
						...(releaseDate ? { releaseDate } : {}),
						releaseType: 'single',
						labelText: t.label_name ?? target.object.name,
						...cover(t.artwork_url),
						trackCount: 1,
					},
					artists,
					recordings: [recording],
					label,
					...(t.genre ? { genres: [t.genre] } : {}),
					publishedAt: at,
				});
			} else tentative.push(recording);
		}
		const s = await this.get<{ collection?: ScSet[] } | ScSet[]>(`/users/${userId}/playlists?limit=50&linked_partitioning=true&show_tracks=true`, signal);
		const typeOf = (a: ScSet) => (a.playlist_type ?? a.set_type ?? '').toLowerCase();
		const albums = (Array.isArray(s) ? s : s.collection ?? []).filter((a) => ALBUM_TYPES.has(typeOf(a)) && !/\bsnippets?\b/i.test(a.title));
		for (const a of albums) {
			const id = `set:${a.id}`;
			if (seen.has(id)) continue;
			const at = parseScDate(a.created_at);
			const { catalogNumber, rest } = splitCatalogNumber(a.title, target.object.name);
			const credit = parseUploadTitle(rest);
			const trackCredits = (a.tracks ?? []).map((t) => {
				const c = parseUploadTitle(t.title);
				return { title: c.title, artists: trackArtists(t, c.artists, userId) };
			});
			// The set's own credit, else whoever its tracks are by (a
			// various-artists release names them all). Never the label's name.
			const names = credit.artists.length ? credit.artists : [...new Set(trackCredits.flatMap((c) => c.artists))];
			const artists = names.map(userArtist);
			const releaseDate = releaseDateOf(a, at);
			const releaseType = typeOf(a);
			children.push({
				provider: 'soundcloud',
				kind: 'release',
				providerId: id,
				name: stripFormatWord(credit.title || rest || a.title, releaseType),
				url: a.permalink_url ?? null,
				facts: {
					...(releaseDate ? { releaseDate } : {}),
					releaseType,
					labelText: a.label_name ?? target.object.name,
					...(catalogNumber ? { catalogNumber } : {}),
					...cover(a.artwork_url),
					trackCount: a.tracks?.length ?? a.track_count ?? 0,
				},
				artists,
				recordings: (a.tracks ?? []).map((t, i) => recordingOf(t, trackCredits[i]!.title, trackCredits[i]!.artists.length ? trackCredits[i]!.artists.map(userArtist) : artists, parseScDate(t.created_at) ?? at)),
				label,
				...(a.genre ? { genres: [a.genre] } : {}),
				publishedAt: at,
			});
		}
		const ids = [...tracks.map((t) => String(t.id)), ...albums.map((a) => `set:${a.id}`)];
		return { children, tentative, listingHash: listingHash(ids), cursor: { seen: rememberSeen(target.cursor.seen, ids) }, calls: userId === stored ? 2 : 3, ...(userId === stored ? {} : { resolvedId: userId }) };
	}

	private async resolveUser(url: string, permalink: string, signal: AbortSignal): Promise<string> {
		try {
			const u = await this.get<{ id?: number; kind?: string }>(`/resolve?url=${encodeURIComponent(url)}`, signal);
			if (u.kind === 'user' && u.id) return String(u.id);
		} catch (e) {
			if (e instanceof ProviderHttpError && e.status === 404) throw new Error(`soundcloud profile ${permalink} not found (404)`);
			throw e;
		}
		// The url resolved to a track or a set: not a profile at all.
		throw new Error(`soundcloud page ${permalink} is not a profile (not found)`);
	}
}
