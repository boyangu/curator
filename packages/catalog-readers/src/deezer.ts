// Deezer, key-less (CURATOR_FEED_DEEZER=1). The best release detector we can
// reach today: on Guy's library sample it found 87% of the releases Spotify
// listed for followed artists and 98% of recent ISRCs (scratchpad spike,
// 2026-10-26). Its terms want a registered app and non-commercial use, and
// registration is closed; it runs behind a switch, never as a requirement.
//
// artist: /artist/{id}/albums, newest first after sorting (Deezer's own order
// is not by date). A release not expanded before costs two more calls:
// /album/{id} (UPC, label string, genres, contributors) and /album/{id}/tracks
// (ISRCs and positions), so it arrives fully identified.
//
// label (by name): Deezer has no label entity, but its search does:
// search/album?q=label:"X". A hit is kept only when the album's own label
// string folds to the watched label's name, the guard against a search that
// matched loosely. The release carries the label as text, never as an object.

import type { CatalogClaim, CatalogKind } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { getJson, listingHash, rememberSeen, type FetchLike } from './http.js';
import { TrackerRateLimitedError, type TrackerAdapter, type TrackerPoll, type TrackerTarget } from './types.js';

const BASE = 'https://api.deezer.com';
// New releases expanded per poll; the rest wait for the next one.
const EXPAND_PER_POLL = 4;
// Only releases this recent are expanded (two calls each); older ones in an
// artist's listing are ingested from the listing alone, which costs nothing
// and still gives the planner the titles it confirms identities by.
const EXPAND_WITHIN_DAYS = 90;

type DzArtist = { id: number; name: string; link?: string; picture_xl?: string };
type DzAlbumRef = { id: number; title: string; release_date?: string; record_type?: string; cover_xl?: string; link?: string; genre_id?: number };

// Deezer's genres (GET /genre), by id: an album in an artist's listing carries
// the id alone. The list is Deezer's whole taxonomy and has not moved in years.
export const DEEZER_GENRES: Readonly<Record<number, string>> = {
	2: 'African Music',
	16: 'Asian Music',
	75: 'Brazilian Music',
	81: 'Indian Music',
	85: 'Alternative',
	95: 'Kids',
	98: 'Classical',
	106: 'Electro',
	113: 'Dance',
	116: 'Rap/Hip Hop',
	129: 'Jazz',
	132: 'Pop',
	144: 'Reggae',
	152: 'Rock',
	153: 'Blues',
	165: 'R&B',
	169: 'Soul & Funk',
	173: 'Films/Games',
	197: 'Latin Music',
	464: 'Metal',
	466: 'Folk',
};
const genreOf = (a: DzAlbumRef): string | null => (a.genre_id !== undefined ? DEEZER_GENRES[a.genre_id] ?? null : null);

// One album as an artist page lists it: what the page validation reads
// (apps/cloud catalog/artist-validation.ts).
export type DeezerListedAlbum = { id: string; title: string; date: string | null; genre: string | null };
type DzAlbum = DzAlbumRef & {
	upc?: string;
	label?: string;
	genres?: { data: { name: string }[] };
	contributors?: DzArtist[];
	artist?: DzArtist;
	nb_tracks?: number;
};
type DzTrack = { id: number; title: string; isrc?: string; duration?: number; track_position?: number; disk_number?: number; link?: string; artist?: DzArtist };
type DzList<T> = { data?: T[]; total?: number; error?: { code: number; message: string } };

// Deezer answers 200 with { error } for its quota (code 4) and for missing
// objects (800).
export const DZ_NOT_FOUND = 800;
function unwrap<T extends { error?: { code: number } }>(j: T): T {
	if (j.error?.code === 4) throw new TrackerRateLimitedError(10);
	return j;
}

// An old release from the listing alone: no UPC or tracklist (not worth two
// calls), credited to the tracked artist.
function shallowClaim(a: DzAlbumRef, artist: DzArtist): CatalogClaim {
	return {
		provider: 'deezer',
		kind: 'release',
		providerId: String(a.id),
		name: a.title,
		url: a.link ?? `https://www.deezer.com/album/${a.id}`,
		facts: {
			...(a.release_date && /^\d{4}-\d{2}-\d{2}$/.test(a.release_date) ? { releaseDate: a.release_date } : {}),
			...(a.record_type ? { releaseType: a.record_type } : {}),
			...(a.cover_xl ? { coverUrl: a.cover_xl } : {}),
		},
		artists: [artistClaim(artist)],
		// The listing's own genre: all a bare copy says of what kind of music it is.
		...(genreOf(a) ? { genres: [genreOf(a)!] } : {}),
	};
}

const artistClaim = (a: DzArtist): CatalogClaim => ({
	provider: 'deezer',
	kind: 'artist',
	providerId: String(a.id),
	name: a.name,
	url: a.link ?? `https://www.deezer.com/artist/${a.id}`,
});

export class DeezerTracker implements TrackerAdapter {
	readonly provider = 'deezer' as const;
	readonly kinds: readonly CatalogKind[] = ['artist', 'label'];
	readonly callsPerPoll = 1 + 2 * EXPAND_PER_POLL;

	constructor(private readonly fetchFn: FetchLike = (u, i) => fetch(u, i)) {}

	private get<T extends { error?: { code: number } }>(path: string, signal: AbortSignal): Promise<T> {
		return getJson<T>(this.fetchFn, 'deezer', `${BASE}${path}`, { signal, logPath: path.split('?')[0]! }).then(unwrap);
	}

	async poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		return target.object.kind === 'label' ? this.pollLabel(target, signal) : this.pollArtist(target, signal);
	}

	private async pollArtist(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		if (!target.representation) throw new Error('deezer artist tracker needs a Deezer id');
		const list = await this.get<DzList<DzAlbumRef>>(`/artist/${encodeURIComponent(target.representation.providerId)}/albums?limit=100`, signal);
		const albums = (list.data ?? []).sort((a, b) => (b.release_date ?? '').localeCompare(a.release_date ?? ''));
		const cutoff = new Date(Date.now() - EXPAND_WITHIN_DAYS * 86400_000).toISOString().slice(0, 10);
		const self: DzArtist = { id: Number(target.representation.providerId), name: target.object.name };
		return this.expand(albums, target.cursor, signal, 1, undefined, (a) => (a.release_date ?? '9999') < cutoff ? shallowClaim(a, self) : null);
	}

	private async pollLabel(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		const name = target.object.name;
		const list = await this.get<DzList<DzAlbumRef>>(`/search/album?q=${encodeURIComponent(`label:"${name}"`)}&limit=100`, signal);
		const want = nameFold(name);
		return this.expand(list.data ?? [], target.cursor, signal, 1, (al) => nameFold(al.label) === want);
	}

	// How many fans an artist page has (the Reach score). Null: no such page
	// (Deezer answers one with error 800 and a 200).
	async artistFans(artistId: string, signal: AbortSignal): Promise<number | null> {
		const a = await this.get<{ error?: { code: number }; nb_fan?: number }>(`/artist/${encodeURIComponent(artistId)}`, signal);
		return typeof a.nb_fan === 'number' ? a.nb_fan : null;
	}

	// What an artist page lists, each album with Deezer's genre for it, and how
	// many it holds in all: one call, the first hundred. Not a poll — nothing
	// is ingested from it; the page validation judges the page by it (a page
	// of rap, J-pop and techno is several acts filed under one name).
	async artistAlbums(artistId: string, signal: AbortSignal): Promise<{ total: number | null; albums: DeezerListedAlbum[] }> {
		const list = await this.get<DzList<DzAlbumRef>>(`/artist/${encodeURIComponent(artistId)}/albums?limit=100`, signal);
		return {
			total: typeof list.total === 'number' ? list.total : null,
			albums: (list.data ?? []).map((a) => ({ id: String(a.id), title: a.title, date: a.release_date && /^\d{4}-\d{2}-\d{2}$/.test(a.release_date) ? a.release_date : null, genre: genreOf(a) })),
		};
	}

	// One release in full, by its Deezer id or by UPC (`/album/upc:<upc>`):
	// the back office's fill (release-fill.ts). Null when Deezer has no such
	// album (error 800).
	async fetchRelease(ref: { id: string } | { upc: string }, signal: AbortSignal): Promise<CatalogClaim | null> {
		const key = 'id' in ref ? ref.id : `upc:${ref.upc}`;
		const album = await this.get<DzAlbum & { error?: { code: number } }>(`/album/${encodeURIComponent(key)}`, signal);
		// Only 800 says the album is not there; any other error is Deezer
		// failing, and "gone" would be remembered of a page that is not.
		if (album.error) {
			if (album.error.code === DZ_NOT_FOUND) return null;
			throw new Error(`deezer error ${album.error.code}`);
		}
		if (!album.id) return null;
		const tracks = await this.get<DzList<DzTrack>>(`/album/${album.id}/tracks?limit=200`, signal);
		return this.releaseClaim(album, tracks.data ?? []);
	}

	// Albums of exactly this title (by fold), for the back office to judge: a
	// store's copy can carry another UPC (a distributor per store). Never
	// attached from here — the agent checks and links one.
	async searchReleases(title: string, signal: AbortSignal, artist?: string): Promise<{ id: string; title: string; artist: string | null; tracks: number | null; type: string | null; url: string }[]> {
		const q = `${artist ? `artist:"${artist}" ` : ''}album:"${title}"`;
		const list = await this.get<DzList<DzAlbumRef & { nb_tracks?: number; record_type?: string; artist?: DzArtist }>>(`/search/album?q=${encodeURIComponent(q)}&limit=25`, signal);
		const want = nameFold(title);
		return (list.data ?? [])
			.filter((a) => nameFold(a.title) === want)
			.map((a) => ({ id: String(a.id), title: a.title, artist: a.artist?.name ?? null, tracks: a.nb_tracks ?? null, type: a.record_type ?? null, url: a.link ?? `https://www.deezer.com/album/${a.id}` }));
	}

	private async expand(
		albums: DzAlbumRef[],
		cursor: Record<string, unknown>,
		signal: AbortSignal,
		calls: number,
		keep?: (al: DzAlbum) => boolean,
		shallow?: (ref: DzAlbumRef) => CatalogClaim | null,
	): Promise<TrackerPoll> {
		const seen = new Set(Array.isArray(cursor.seen) ? (cursor.seen as string[]) : []);
		const children: CatalogClaim[] = [];
		const expanded: string[] = [];
		const unseen = albums.filter((a) => !seen.has(String(a.id)));
		const toExpand: DzAlbumRef[] = [];
		for (const a of unseen) {
			const flat = shallow?.(a);
			if (flat) {
				children.push(flat);
				expanded.push(String(a.id));
			} else toExpand.push(a);
		}
		const fresh = toExpand.slice(0, EXPAND_PER_POLL);
		for (const ref of fresh) {
			const album = await this.get<DzAlbum & { error?: { code: number } }>(`/album/${ref.id}`, signal);
			const tracks = await this.get<DzList<DzTrack>>(`/album/${ref.id}/tracks?limit=200`, signal);
			calls += 2;
			expanded.push(String(ref.id));
			if (album.error || (keep && !keep(album))) continue;
			children.push(this.releaseClaim(album, tracks.data ?? []));
		}
		// The listing's hash covers only what is fully expanded: a listing with
		// albums left for the next poll must not read as unchanged then.
		const pending = albums.filter((a) => !seen.has(String(a.id)) && !expanded.includes(String(a.id))).length;
		const ids = albums.map((a) => String(a.id));
		return {
			children,
			listingHash: pending ? `pending:${Date.now()}` : listingHash(ids),
			cursor: { seen: rememberSeen(cursor.seen, expanded) },
			calls,
		};
	}

	private releaseClaim(al: DzAlbum, tracks: DzTrack[]): CatalogClaim {
		const artists = al.contributors?.length ? al.contributors : al.artist ? [al.artist] : [];
		// The tracklist names a track's primary artist only (its full credit is
		// on the track's own page, a call a track). On a one-track release the
		// release's credit is the track's; on any other the short one is kept
		// and the catalogue reads the rest elsewhere (apps/cloud catalog/credits.ts).
		const single = tracks.length === 1 && (al.nb_tracks ?? 1) === 1 && artists.length > 0;
		return {
			provider: 'deezer',
			kind: 'release',
			providerId: String(al.id),
			name: al.title,
			url: al.link ?? `https://www.deezer.com/album/${al.id}`,
			identifiers: al.upc ? [{ namespace: 'upc', value: al.upc }] : [],
			facts: {
				...(al.release_date && /^\d{4}-\d{2}-\d{2}$/.test(al.release_date) ? { releaseDate: al.release_date } : {}),
				...(al.record_type ? { releaseType: al.record_type } : {}),
				...(al.label ? { labelText: al.label } : {}),
				...(al.cover_xl ? { coverUrl: al.cover_xl } : {}),
				...(al.nb_tracks !== undefined ? { trackCount: al.nb_tracks } : {}),
			},
			artists: artists.map(artistClaim),
			recordings: tracks.map((t, i) => ({
				provider: 'deezer' as const,
				kind: 'recording' as const,
				providerId: String(t.id),
				name: t.title,
				url: t.link ?? `https://www.deezer.com/track/${t.id}`,
				identifiers: t.isrc ? [{ namespace: 'isrc' as const, value: t.isrc }] : [],
				facts: { ...(t.duration ? { durationSec: t.duration } : {}), trackNumber: t.track_position ?? i + 1, ...(t.disk_number ? { discNumber: t.disk_number } : {}) },
				...(single ? { artists: artists.map(artistClaim) } : t.artist ? { artists: [artistClaim(t.artist)] } : {}),
			})),
			genres: (al.genres?.data ?? []).map((g) => g.name),
		};
	}
}
