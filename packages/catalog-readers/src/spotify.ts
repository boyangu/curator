// Spotify's artist releases and a label's catalogue playlists, read with
// whatever token the host hands in: the cloud's app credentials (a
// client-credentials grant, apps/cloud catalog/spotify-app-token.ts — no user,
// so Development Mode's five-user cap does not apply; the endpoint limits do)
// or, on a desktop, the user's own login. The same endpoints answer both.
//
// artist: /artists/{id}/albums (album, single), newest first; a release not
// expanded before costs one more call, /albums/{id}: its UPC (external_ids,
// kept by Spotify's March 2026 reversal) and tracklist. Spotify's tracklist
// carries no ISRCs; the planner fills them from Deezer by title and length.
//
// The app's rate limit is shared with every desktop's calls through the same
// client id, so the tracker paces itself (tracker.budget.minGapMs) and a 429
// parks it for the pass with Spotify's Retry-After.

import type { CatalogClaim, CatalogKind } from '@curator/protocol';
import { getJson, listingHash, rememberSeen, type FetchLike } from './http.js';
import type { TrackerAdapter, TrackerPoll, TrackerTarget } from './types.js';

const API = 'https://api.spotify.com/v1';
const EXPAND_PER_POLL = 3;
// As for Deezer: only recent releases cost the extra call.
const EXPAND_WITHIN_DAYS = 90;

type SpArtistRef = { id: string; name: string; external_urls?: { spotify?: string } };
type SpAlbumRef = {
	id: string;
	name: string;
	album_type?: string;
	release_date?: string;
	release_date_precision?: 'year' | 'month' | 'day';
	total_tracks?: number;
	images?: { url: string }[];
	artists?: SpArtistRef[];
	external_urls?: { spotify?: string };
};
type SpTrackRef = { id: string; name: string; duration_ms?: number; track_number?: number; disc_number?: number; artists?: SpArtistRef[]; external_urls?: { spotify?: string } };
type SpAlbum = SpAlbumRef & { external_ids?: { upc?: string; ean?: string }; tracks?: { items: SpTrackRef[] }; genres?: string[]; label?: string };

// A bearer token for Spotify's API, good at the time of the call. The host
// refreshes behind it (an app token a minute before expiry; a desktop's vended
// user token through its own auth).
export type SpotifyTokenSource = (signal?: AbortSignal) => Promise<string>;

// What the enrichment steps need of a tracker: its authenticated GET.
export type SpotifyReader = Pick<SpotifyTracker, 'get'>;

const artistClaim = (a: SpArtistRef): CatalogClaim => ({
	provider: 'spotify',
	kind: 'artist',
	providerId: a.id,
	name: a.name,
	url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}`,
});

export class SpotifyTracker implements TrackerAdapter {
	readonly provider = 'spotify' as const;
	// label: through its catalogue playlists (profile/catalogue-playlists.ts),
	// handed in as `target.related`.
	readonly kinds: readonly CatalogKind[] = ['artist', 'label'];
	readonly callsPerPoll = 1 + EXPAND_PER_POLL;

	constructor(
		private readonly deps: { token: SpotifyTokenSource },
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly now: () => number = Date.now,
	) {}

	async get<T>(path: string, signal?: AbortSignal): Promise<T> {
		const token = await this.deps.token(signal);
		return getJson<T>(this.fetchFn, 'spotify', `${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal, logPath: path.split('?')[0]! });
	}

	// A label's new releases: what its catalogue playlists gained since the
	// last poll. One call a playlist while its snapshot is unchanged; a changed
	// one is read from the top (newest additions sit anywhere, so every page)
	// and only entries added after the cursor's mark become children. The
	// first poll marks without announcing (a playlist's whole history is the
	// back catalogue, filled by the catalogue-playlist step, not news).
	private async pollLabel(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		const playlists = target.related ?? [];
		if (!playlists.length) throw new Error('spotify label tracker needs a catalogue playlist');
		const snapshots = (target.cursor.snapshots ?? {}) as Record<string, string>;
		const marks = (target.cursor.marks ?? {}) as Record<string, string>;
		const children: CatalogClaim[] = [];
		const seenAlbums = new Set<string>();
		let calls = 0;
		const nextSnapshots: Record<string, string> = {};
		const nextMarks: Record<string, string> = {};
		for (const p of playlists) {
			const meta = await this.get<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(p.providerId)}?fields=snapshot_id`, signal);
			calls++;
			const snap = meta.snapshot_id ?? '';
			nextSnapshots[p.providerId] = snap;
			nextMarks[p.providerId] = marks[p.providerId] ?? '';
			if (snap && snapshots[p.providerId] === snap) continue;
			const r = await readPlaylistItems(this, p.providerId, signal);
			calls += r.calls;
			const mark = marks[p.providerId];
			let newest = mark ?? '';
			const added: { t: SpPlaylistTrack; at: string }[] = [];
			for (const e of r.entries) {
				const at = e.added_at ?? '';
				if (at > newest) newest = at;
				if (mark === undefined || at <= mark) continue;
				const t = trackOf(e);
				if (t?.album?.id && !seenAlbums.has(t.album.id)) {
					seenAlbums.add(t.album.id);
					added.push({ t, at });
				}
			}
			// The new albums' labels, Spotify's own: a catalogue playlist may
			// carry a sister label's release, and the label text says which.
			const labels = await fetchAlbumLabels(this, added.map((a) => a.t.album!.id), signal);
			calls += labels.calls;
			for (const a of added) {
				const claim = releaseClaimFromTrack(a.t, labels.labels.get(a.t.album!.id));
				if (claim) children.push({ ...claim, publishedAt: Date.parse(a.at) || null });
			}
			nextMarks[p.providerId] = newest;
		}
		return {
			children,
			// The sweep ties each child to the tracked label (`labelOf`).
			labelOf: true,
			listingHash: listingHash(Object.entries(nextSnapshots).map(([k, v]) => `${k}:${v}`).sort()),
			cursor: { snapshots: nextSnapshots, marks: nextMarks },
			calls,
		};
	}

	async poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		if (target.object.kind === 'label') return this.pollLabel(target, signal);
		if (!target.representation) throw new Error('spotify artist tracker needs a Spotify id');
		const id = encodeURIComponent(target.representation.providerId);
		const page = await this.get<{ items: SpAlbumRef[] }>(`/artists/${id}/albums?include_groups=album,single&limit=20`, signal);
		const albums = [...page.items].sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
		const seen = new Set(Array.isArray(target.cursor.seen) ? (target.cursor.seen as string[]) : []);
		const cutoff = new Date(this.now() - EXPAND_WITHIN_DAYS * 86400_000).toISOString().slice(0, 10);
		const unseen = albums.filter((a) => !seen.has(a.id));
		const old = unseen.filter((a) => (a.release_date ?? '9999') < cutoff);
		const fresh = unseen.filter((a) => !old.includes(a)).slice(0, EXPAND_PER_POLL);
		// Old releases from the listing alone (it carries their artists).
		const children: CatalogClaim[] = old.map((a) => releaseClaim(a));
		let calls = 1;
		for (const ref of fresh) {
			const album = await this.get<SpAlbum>(`/albums/${encodeURIComponent(ref.id)}`, signal);
			calls++;
			children.push(releaseClaim(album));
		}
		const pending = unseen.length > old.length + fresh.length;
		return {
			children,
			listingHash: pending ? `pending:${this.now()}` : listingHash(albums.map((a) => a.id)),
			cursor: { seen: rememberSeen(target.cursor.seen, [...fresh, ...old].map((a) => a.id)) },
			calls,
		};
	}
}

// Albums in full (UPC, label, tracklist), twenty a call: the back office's
// fill (release-fill.ts). An id Spotify no longer knows comes back null and
// is left out.
export async function fetchAlbums(app: SpotifyReader, ids: readonly string[], signal: AbortSignal): Promise<{ claims: Map<string, CatalogClaim>; calls: number }> {
	const claims = new Map<string, CatalogClaim>();
	const distinct = [...new Set(ids)];
	let calls = 0;
	for (let i = 0; i < distinct.length; i += 20) {
		const r = await app.get<{ albums?: (SpAlbum | null)[] }>(`/albums?ids=${distinct.slice(i, i + 20).map(encodeURIComponent).join(',')}`, signal);
		calls++;
		for (const a of r.albums ?? []) if (a?.id) claims.set(a.id, releaseClaim(a));
	}
	return { claims, calls };
}

// ── playlists read with the app's own token ─────────────────────────────────
//
// A label's catalogue playlist ("STEYOYOKE RECORDINGS": every release, kept by
// whoever runs the label's Spotify) lists each release's tracks with their
// ISRCs and albums: the label's catalogue with Spotify ids, 100 tracks a call.
// The 2026 owner/collaborator rule would withhold its items from an app
// token; Guy's app is under the postponement, so they come (2026-10-28).

export type SpPlaylistTrack = SpTrackRef & {
	type?: string;
	external_ids?: { isrc?: string };
	album?: SpAlbumRef;
};
export type SpPlaylistEntry = { added_at?: string; is_local?: boolean; track?: SpPlaylistTrack | null; item?: SpPlaylistTrack | null };
type SpPlaylistPage = { items?: SpPlaylistEntry[]; next?: string | null; total?: number };

export async function readPlaylistItems(
	app: SpotifyReader,
	playlistId: string,
	signal: AbortSignal,
	opts: { maxPages?: number; offset?: number } = {},
): Promise<{ entries: SpPlaylistEntry[]; calls: number; total: number | null }> {
	const entries: SpPlaylistEntry[] = [];
	let calls = 0;
	let total: number | null = null;
	let next: string | null = `/playlists/${encodeURIComponent(playlistId)}/items?limit=100&offset=${opts.offset ?? 0}`;
	for (let page = 0; next && page < (opts.maxPages ?? 50); page++) {
		const body: SpPlaylistPage = await app.get<SpPlaylistPage>(next.replace(API, ''), signal);
		calls++;
		// No items: withheld (the owner/collaborator rule), never "empty".
		if (!Array.isArray(body.items)) throw new Error("Spotify withheld this playlist's items");
		total = body.total ?? total;
		entries.push(...body.items);
		next = body.next ?? null;
	}
	return { entries, calls, total };
}

export const trackOf = (e: SpPlaylistEntry): SpPlaylistTrack | null => {
	const t = e.item ?? e.track ?? null;
	return t?.id && !e.is_local && (!t.type || t.type === 'track') ? t : null;
};

// A playlist's name and keeper: what a hand-linked catalogue playlist is
// recorded as.
export async function fetchPlaylistMeta(app: SpotifyReader, playlistId: string, signal: AbortSignal): Promise<{ name: string; owner: string; ownerId: string | null; snapshotId: string | null }> {
	const p = await app.get<{ name?: string; owner?: { display_name?: string; id?: string }; snapshot_id?: string }>(
		`/playlists/${encodeURIComponent(playlistId)}?fields=name,owner(display_name,id),snapshot_id`,
		signal,
	);
	return { name: p.name ?? '', owner: p.owner?.display_name ?? p.owner?.id ?? '', ownerId: p.owner?.id ?? null, snapshotId: p.snapshot_id ?? null };
}

// The label each album names, Spotify's own `label` field: the playlist's
// items carry the album without it, and /albums gives twenty a call.
export async function fetchAlbumLabels(app: SpotifyReader, ids: readonly string[], signal: AbortSignal): Promise<{ labels: Map<string, string>; calls: number }> {
	const labels = new Map<string, string>();
	const distinct = [...new Set(ids)];
	let calls = 0;
	for (let i = 0; i < distinct.length; i += 20) {
		const r = await app.get<{ albums?: (SpAlbum | null)[] }>(`/albums?ids=${distinct.slice(i, i + 20).map(encodeURIComponent).join(',')}`, signal);
		calls++;
		for (const a of r.albums ?? []) if (a?.id && a.label) labels.set(a.id, a.label);
	}
	return { labels, calls };
}

// One playlist track as its release, carrying the track (Spotify's album
// tracklist has no ISRCs; the playlist's track does). `labelText` is the
// album's own label as Spotify names it (fetchAlbumLabels), never assumed
// from the playlist: a label's catalogue playlist can list a sister label's.
export function releaseClaimFromTrack(t: SpPlaylistTrack, labelText?: string): CatalogClaim | null {
	const al = t.album;
	if (!al?.id) return null;
	const date = dateOf(al);
	return {
		provider: 'spotify',
		kind: 'release',
		providerId: al.id,
		name: al.name,
		url: al.external_urls?.spotify ?? `https://open.spotify.com/album/${al.id}`,
		facts: {
			...(date ? { releaseDate: date } : {}),
			...(al.album_type ? { releaseType: al.album_type } : {}),
			...(al.images?.[0]?.url ? { coverUrl: al.images[0].url } : {}),
			...(al.total_tracks !== undefined ? { trackCount: al.total_tracks } : {}),
			...(labelText ? { labelText } : {}),
		},
		artists: (al.artists ?? t.artists ?? []).map(artistClaim),
		recordings: [
			{
				provider: 'spotify',
				kind: 'recording',
				providerId: t.id,
				name: t.name,
				url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
				identifiers: t.external_ids?.isrc ? [{ namespace: 'isrc', value: t.external_ids.isrc }] : [],
				facts: {
					...(t.duration_ms ? { durationSec: Math.round(t.duration_ms / 100) / 10 } : {}),
					...(t.track_number ? { trackNumber: t.track_number } : {}),
					...(t.disc_number ? { discNumber: t.disc_number } : {}),
				},
				...(t.artists?.length ? { artists: t.artists.map(artistClaim) } : {}),
			},
		],
	};
}

// Spotify dates are as precise as `release_date_precision` says.
function dateOf(al: SpAlbumRef): string | undefined {
	const d = al.release_date;
	if (!d) return undefined;
	return /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d) ? d : undefined;
}

export function releaseClaim(al: SpAlbum | SpAlbumRef): CatalogClaim {
	const full = al as SpAlbum;
	const upc = full.external_ids?.upc ?? full.external_ids?.ean;
	const date = dateOf(al);
	return {
		provider: 'spotify',
		kind: 'release',
		providerId: al.id,
		name: al.name,
		url: al.external_urls?.spotify ?? `https://open.spotify.com/album/${al.id}`,
		identifiers: upc ? [{ namespace: 'upc', value: upc }] : [],
		facts: {
			...(date ? { releaseDate: date } : {}),
			...(al.album_type ? { releaseType: al.album_type } : {}),
			...(al.images?.[0]?.url ? { coverUrl: al.images[0].url } : {}),
			...(al.total_tracks !== undefined ? { trackCount: al.total_tracks } : {}),
			// The label as Spotify files it (full albums only): text, never a label object.
			...(full.label ? { labelText: full.label } : {}),
		},
		artists: (al.artists ?? []).map(artistClaim),
		recordings: (full.tracks?.items ?? []).map((t, i) => ({
			provider: 'spotify' as const,
			kind: 'recording' as const,
			providerId: t.id,
			name: t.name,
			url: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
			facts: {
				...(t.duration_ms ? { durationSec: Math.round(t.duration_ms / 100) / 10 } : {}),
				trackNumber: t.track_number ?? i + 1,
				...(t.disc_number ? { discNumber: t.disc_number } : {}),
			},
			...(t.artists?.length ? { artists: t.artists.map(artistClaim) } : {}),
		})),
		...(full.genres?.length ? { genres: full.genres } : {}),
	};
}
