// The local collection as Global Catalog claims: what the collection import
// (cli/catalog-import.ts; later the app's own "import my collection") sends
// so each track lands on its release and the release on its label. The
// catalogue then reads each release in full from its stores and each label's
// whole catalogue (apps/cloud catalog/library-import.ts, release-fill.ts).
//
// "Collection" is the LOCAL library: tracks with a file on this computer
// (membership 'local'), as for the follow candidates.
//
// How a claim is keyed decides what it joins (apps/cloud catalog/identity.ts):
//   - a release by its Spotify album id when the album has one (an exact
//     representation: whatever a Spotify tracker or fill made of it), else
//     `user`/`album:<id>`, which joins by UPC or by title + artist + date;
//   - a track by its Spotify id, else `user`/`recording:<recording_id>`,
//     which joins by ISRC (lengths within 10 s) or title + artists + length;
//   - an artist by its Spotify id, else `user`/`local:<artist id>`: scoped to
//     this library, never a bare name — a name alone would merge every
//     namesake in the catalogue — and joined to a store's artist only by the
//     corroboration rule (the same name credited on the same release);
//   - a label by its folded name (`user`/`name:<fold>`), the one rule for
//     labels written as text (catalog-client/service.ts labelClaim), except a
//     distributor's name ("DistroKid", "1461444 Records DK"): that stays text.
//
// A catalogue object keeps the first value each source gives it, so a claim
// keyed as Spotify's carries only what came from Spotify's album (the album
// row) — never a file's tag, which would stand in for Spotify's own value.
//
// Read-only over curator.db: two statements and the grouping in memory.

import type Database from 'better-sqlite3';
import type { CatalogClaim } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';

const OWN = `t.deleted_at is null and t.membership = 'local'`;

// Distribution services, not labels: an artist releasing through one has no
// label. DistroKid also names imprints "<number> Records DK" (DK2…).
const DISTRIBUTORS = new Set(
	[
		'distrokid',
		'cd baby',
		'cdbaby',
		'tunecore',
		'believe',
		'believe digital',
		'amuse',
		'amuseio ab',
		'ditto music',
		'ditto',
		'routenote',
		'symphonic',
		'symphonic distribution',
		'label worx',
		'labelworx',
		'kudos records',
		'onerpm',
		'awal',
		'united masters',
		'unitedmasters',
		'level',
		'record union',
		'spinnup',
		'soundrop',
		'emubands',
		'self released',
		'self-released',
		'independent',
		'not on label',
	].map((n) => nameFold(n)),
);
const DISTROKID_IMPRINT = /^\d+ records dk\d*$/;

export function isDistributor(name: string): boolean {
	const fold = nameFold(name);
	return !fold || DISTRIBUTORS.has(fold) || DISTROKID_IMPRINT.test(fold);
}

export type LibraryLabelClaim = { claim: CatalogClaim; fold: string; name: string; tracks: number };
export type LibraryReleaseClaim = {
	claim: CatalogClaim;
	// The album it is (null: a track with no album, sent as a one-track release).
	albumId: string | null;
	trackIds: string[];
	labelFold: string | null;
};
export type LibraryClaims = { labels: LibraryLabelClaim[]; releases: LibraryReleaseClaim[] };

type AlbumRow = {
	id: string;
	title: string | null;
	label: string | null;
	upc: string | null;
	release_date: string | null;
	album_type: string | null;
	total_tracks: number | null;
	cover_url: string | null;
	spotify_id: string | null;
	spotify_url: string | null;
};
type TrackRow = {
	id: string;
	album_id: string | null;
	recording_id: string | null;
	title: string | null;
	album_title: string | null;
	isrc: string | null;
	duration: number | null;
	track_number: number | null;
	disc_number: number | null;
	bpm: number | null;
	key_camelot: string | null;
	label: string | null;
	release_date: string | null;
	cover_url: string | null;
	spotify_id: string | null;
};
type ArtistRow = { owner: string; id: string; name: string; spotify_id: string | null; role: string | null };

const MAX_NAME = 500;
const MAX_RECORDINGS = 100;
const DATE = /^(\d{4})(-\d{2}(-\d{2})?)?/;

// The shapes the catalogue takes ("2017-11-24T00:00:00" is a date).
const cleanDate = (d: string | null): string | undefined => {
	const m = d ? DATE.exec(d.trim()) : null;
	return m ? m[0] : undefined;
};
const cleanUrl = (u: string | null): string | undefined => (u && /^https?:\/\/\S+$/.test(u) ? u : undefined);
const clamp = (s: string) => s.trim().slice(0, MAX_NAME);
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const isrcOf = (v: string | null) => {
	const s = v?.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
	return s && ISRC.test(s) ? s : null;
};

function artistClaim(a: ArtistRow): CatalogClaim {
	return a.spotify_id && SPOTIFY_ID.test(a.spotify_id)
		? { provider: 'spotify', kind: 'artist', providerId: a.spotify_id, name: clamp(a.name), url: `https://open.spotify.com/artist/${a.spotify_id}` }
		: { provider: 'user', kind: 'artist', providerId: `local:${a.id}`, name: clamp(a.name) };
}

export function libraryClaims(raw: Database.Database): LibraryClaims {
	const tracks = raw
		.prepare(
			`select t.id, t.album_id, t.recording_id, t.title, t.album_title, t.isrc, t.duration, t.track_number, t.disc_number, t.bpm, t.key_camelot,
				t.label, t.release_date, t.cover_url,
				(select s.source_track_id from source_link s where s.track_id = t.id and s.source = 'spotify' order by s.fetched_at desc limit 1) as spotify_id
			from track t where ${OWN}
			order by t.album_id, t.disc_number, t.track_number, t.title`,
		)
		.all() as TrackRow[];
	const albumIds = [...new Set(tracks.map((t) => t.album_id).filter((id): id is string => !!id))];
	const albums = new Map<string, AlbumRow>();
	const credits = new Map<string, ArtistRow[]>();
	const byOwner = (rows: ArtistRow[]) => {
		for (const r of rows) {
			const list = credits.get(r.owner) ?? [];
			list.push(r);
			credits.set(r.owner, list);
		}
	};
	const artistCols = `a.id, a.name, (select l.source_id from artist_link l where l.artist_id = a.id and l.source = 'spotify' order by l.fetched_at desc limit 1) as spotify_id`;
	for (let i = 0; i < albumIds.length; i += 500) {
		const ids = albumIds.slice(i, i + 500);
		const marks = ids.map(() => '?').join(',');
		for (const a of raw
			.prepare(
				`select al.id, al.title, al.label, al.upc, al.release_date, al.album_type, al.total_tracks, al.cover_url,
					(select l.source_id from album_link l where l.album_id = al.id and l.source = 'spotify' limit 1) as spotify_id,
					(select l.url from album_link l where l.album_id = al.id and l.source = 'spotify' limit 1) as spotify_url
				from album al where al.id in (${marks})`,
			)
			.all(...ids) as AlbumRow[])
			albums.set(a.id, a);
		byOwner(
			raw
				.prepare(`select aa.album_id as owner, ${artistCols}, null as role from album_artist aa join artist a on a.id = aa.artist_id where aa.album_id in (${marks}) order by aa.album_id, aa.position`)
				.all(...ids) as ArtistRow[],
		);
	}
	const trackIds = tracks.map((t) => t.id);
	for (let i = 0; i < trackIds.length; i += 500) {
		const ids = trackIds.slice(i, i + 500);
		byOwner(
			raw
				.prepare(
					`select ta.track_id as owner, ${artistCols}, ta.role from track_artist ta join artist a on a.id = ta.artist_id
					where ta.track_id in (${ids.map(() => '?').join(',')}) order by ta.track_id, ta.position`,
				)
				.all(...ids) as ArtistRow[],
		);
	}
	// Remixers are read off titles by the catalogue (its credit rules), as in
	// the library: a track's credits here are its main artists.
	const mainArtists = (trackId: string) => (credits.get(trackId) ?? []).filter((a) => a.role !== 'remixer');

	// One release per album; a track with no album is its own release.
	const groups = new Map<string, TrackRow[]>();
	for (const t of tracks) {
		const key = t.album_id && albums.has(t.album_id) ? `album:${t.album_id}` : `track:${t.id}`;
		const g = groups.get(key) ?? [];
		g.push(t);
		groups.set(key, g);
	}

	// Labels as the album names them, else as its tracks do (the commonest
	// spelling); counted by tracks, which is the order everything goes in.
	const labelOf = (album: AlbumRow | null, ts: TrackRow[]): string | null => {
		if (album?.label?.trim()) return album.label.trim();
		const counts = new Map<string, number>();
		for (const t of ts) if (t.label?.trim()) counts.set(t.label.trim(), (counts.get(t.label.trim()) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
	};
	const labelStats = new Map<string, { spellings: Map<string, number>; tracks: number }>();
	const planned: { key: string; album: AlbumRow | null; ts: TrackRow[]; label: string | null; fold: string | null }[] = [];
	for (const [key, ts] of groups) {
		const album = key.startsWith('album:') ? albums.get(key.slice(6))! : null;
		const label = labelOf(album, ts);
		const fold = label && !isDistributor(label) ? nameFold(label) : null;
		if (fold) {
			const s = labelStats.get(fold) ?? { spellings: new Map(), tracks: 0 };
			s.spellings.set(label!, (s.spellings.get(label!) ?? 0) + ts.length);
			s.tracks += ts.length;
			labelStats.set(fold, s);
		}
		planned.push({ key, album, ts, label, fold });
	}
	const labels: LibraryLabelClaim[] = [...labelStats.entries()]
		.map(([fold, s]) => {
			const name = clamp([...s.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]);
			return { fold, name, tracks: s.tracks, claim: { provider: 'user' as const, kind: 'label' as const, providerId: `name:${fold}`, name } };
		})
		.sort((a, b) => b.tracks - a.tracks || a.fold.localeCompare(b.fold));
	const rank = new Map(labels.map((l, i) => [l.fold, i]));
	const labelClaimOf = (fold: string | null) => (fold ? labels[rank.get(fold)!]!.claim : undefined);

	const releases: LibraryReleaseClaim[] = planned
		.sort((a, b) => (a.fold === null ? 1 : 0) - (b.fold === null ? 1 : 0) || (rank.get(a.fold ?? '') ?? 0) - (rank.get(b.fold ?? '') ?? 0) || (cleanDate(b.album?.release_date ?? b.ts[0]!.release_date) ?? '').localeCompare(cleanDate(a.album?.release_date ?? a.ts[0]!.release_date) ?? ''))
		.map(({ album, ts, label, fold }) => {
			const spotify = album?.spotify_id && SPOTIFY_ID.test(album.spotify_id) ? album.spotify_id : null;
			const first = ts[0]!;
			const releaseArtists = album ? (credits.get(album.id) ?? []) : [];
			const artists = (releaseArtists.length ? releaseArtists : mainArtists(first.id)).map(artistClaim);
			const date = cleanDate(album ? album.release_date : first.release_date);
			const upc = album?.upc?.replace(/\D/g, '');
			// From Spotify's album (the album row) when keyed as Spotify's;
			// a file's tags only on a release the library itself names.
			const labelText = spotify ? album?.label?.trim() || undefined : label ?? undefined;
			const recordings: CatalogClaim[] = ts.slice(0, MAX_RECORDINGS).map((t) => {
				const isrc = isrcOf(t.isrc);
				const own = t.spotify_id && SPOTIFY_ID.test(t.spotify_id) ? t.spotify_id : null;
				const credited = mainArtists(t.id).map(artistClaim);
				return {
					provider: own ? 'spotify' : 'user',
					kind: 'recording',
					providerId: own ?? `recording:${t.recording_id ?? t.id}`,
					...(own ? { url: `https://open.spotify.com/track/${own}` } : {}),
					name: clamp(t.title || 'Untitled'),
					identifiers: isrc ? [{ namespace: 'isrc' as const, value: isrc }] : [],
					facts: {
						...(t.duration && t.duration > 0 ? { durationSec: Math.round(t.duration * 10) / 10 } : {}),
						...(t.track_number && t.track_number > 0 ? { trackNumber: t.track_number } : {}),
						...(t.disc_number && t.disc_number > 0 ? { discNumber: t.disc_number } : {}),
						// The library's own analysis: not Spotify's to state.
						...(!own && t.bpm && t.bpm > 0 ? { bpm: t.bpm } : {}),
						...(!own && t.key_camelot ? { key: t.key_camelot } : {}),
					},
					...(credited.length ? { artists: credited } : {}),
				} satisfies CatalogClaim;
			});
			const claim: CatalogClaim = {
				provider: spotify ? 'spotify' : 'user',
				kind: 'release',
				providerId: spotify ?? (album ? `album:${album.id}` : `track:${first.id}`),
				...(spotify ? { url: cleanUrl(album!.spotify_url) ?? `https://open.spotify.com/album/${spotify}` } : {}),
				name: clamp(album?.title || first.album_title || first.title || 'Untitled'),
				identifiers: upc && upc.length >= 6 ? [{ namespace: 'upc', value: upc }] : [],
				facts: {
					...(date ? { releaseDate: date } : {}),
					...(album?.album_type ? { releaseType: album.album_type } : !album ? { releaseType: 'single' } : {}),
					...(album?.total_tracks && album.total_tracks > 0 ? { trackCount: album.total_tracks } : !album ? { trackCount: 1 } : {}),
					...(cleanUrl(album ? album.cover_url : first.cover_url) ? { coverUrl: cleanUrl(album ? album.cover_url : first.cover_url)! } : {}),
					...(labelText ? { labelText: clamp(labelText) } : {}),
				},
				artists,
				recordings,
				...(fold ? { label: labelClaimOf(fold)! } : {}),
			};
			return { claim, albumId: album?.id ?? null, trackIds: ts.map((t) => t.id), labelFold: fold };
		});
	return { labels, releases };
}
