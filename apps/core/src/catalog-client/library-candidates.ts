// What the user could follow, from their own library: the "Manage following"
// modal's four tabs (artists, labels, genres, playlists), each sorted by how
// often it appears in the library.
//
// "Library" here is the user's LOCAL library: tracks with a file on this
// computer (membership 'local'; Guy, 2026-10-26: "should be from the local
// library only"). Streaming-only tracks, in the user's own playlists or in
// followed ones, do not count.
//
// Read-only over curator.db; one statement per tab.

import type Database from 'better-sqlite3';
import type { CatalogClaim } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { isDistributor } from './library-claims.js';

export const FOLLOW_CANDIDATE_KINDS = ['artist', 'label', 'genre', 'playlist'] as const;
export type FollowCandidateKind = (typeof FOLLOW_CANDIDATE_KINDS)[number];

export type FollowCandidateTarget = { claim: CatalogClaim } | { labelName: string } | { genreName: string };

export type FollowCandidate = {
	key: string;
	kind: FollowCandidateKind;
	name: string;
	// Library tracks it appears on (for a playlist: library tracks in it).
	count: number;
	detail: string | null;
	imageUrl: string | null;
	// How to follow it; null when it cannot be followed yet (see `blocked`).
	target: FollowCandidateTarget | null;
	blocked: string | null;
	// Set by the service from the account's watches.
	followedObjectId: string | null;
	// What a watch on it is matched by: a provider handle or a folded name.
	matchKey: string;
};

const OWN = `t.deleted_at is null and t.membership = 'local'`;

export function artistCandidates(raw: Database.Database): FollowCandidate[] {
	const rows = raw
		.prepare(
			`select a.id, a.name, count(distinct t.id) as n,
				(select l.source_id from artist_link l where l.artist_id = a.id and l.source = 'spotify' order by l.fetched_at desc limit 1) as spotify_id,
				(select l.source_id from artist_link l where l.artist_id = a.id and l.source = 'tidal' limit 1) as tidal_id
			from artist a
			join track_artist ta on ta.artist_id = a.id
			join track t on t.id = ta.track_id
			where a.merged_into is null and ${OWN}
			group by a.id
			order by n desc, a.name collate nocase`,
		)
		.all() as { id: string; name: string; n: number; spotify_id: string | null; tidal_id: string | null }[];
	return rows.map((r) => ({
		key: `artist:${r.id}`,
		kind: 'artist',
		name: r.name,
		count: r.n,
		detail: null,
		imageUrl: null,
		// Artists are only followed by a provider id: a name alone is never an
		// artist's identity. Spotify's is what the cloud tracks by today.
		target: r.spotify_id
			? { claim: { provider: 'spotify', kind: 'artist', providerId: r.spotify_id, name: r.name, url: `https://open.spotify.com/artist/${r.spotify_id}` } }
			: null,
		blocked: r.spotify_id ? null : r.tidal_id ? 'Only on Tidal: find it with Following search' : 'No streaming id: find it with Following search',
		followedObjectId: null,
		matchKey: r.spotify_id ? `spotify:${r.spotify_id}` : `artist:${r.id}`,
	}));
}

// Labels as written on tracks (Beatport / Traxsource / tags), one row per
// folded name, shown in its most common spelling.
export function labelCandidates(raw: Database.Database): FollowCandidate[] {
	const rows = raw
		.prepare(
			`select trim(t.label) as label, count(*) as n
			from track t
			where ${OWN} and t.label is not null and trim(t.label) <> ''
			group by trim(t.label)`,
		)
		.all() as { label: string; n: number }[];
	// A distributor's name is no label (library-claims.ts).
	return foldGroups(rows.filter((r) => !isDistributor(r.label)).map((r) => ({ name: r.label, n: r.n }))).map(({ name, n, fold }) => ({
		key: `label:${fold}`,
		kind: 'label',
		name,
		count: n,
		detail: null,
		imageUrl: null,
		target: { labelName: name },
		blocked: null,
		followedObjectId: null,
		matchKey: `name:${fold}`,
	}));
}

export function genreCandidates(raw: Database.Database): FollowCandidate[] {
	const rows = raw
		.prepare(
			`select trim(t.genre) as genre, count(*) as n
			from track t
			where ${OWN} and t.genre is not null and trim(t.genre) <> ''
			group by trim(t.genre)`,
		)
		.all() as { genre: string; n: number }[];
	return foldGroups(rows.map((r) => ({ name: r.genre, n: r.n }))).map(({ name, n, fold }) => ({
		key: `genre:${fold}`,
		kind: 'genre',
		name,
		count: n,
		detail: null,
		imageUrl: null,
		target: { genreName: name },
		blocked: null,
		followedObjectId: null,
		matchKey: `name:${fold}`,
	}));
}

// Streaming playlists the user follows (their own are curation, not a
// source), sorted by how many of the user's local tracks are in them: the
// curators whose taste overlaps most.
export function playlistCandidates(raw: Database.Database, myIds: { spotify: string | null; tidal: string | null }): FollowCandidate[] {
	const rows = raw
		.prepare(
			`select p.id, p.source, p.source_id, p.name, p.owner_name, p.owner_id, p.cover_url, p.url, p.track_count,
				(select count(*) from playlist_track pt join track t on t.id = pt.track_id where pt.playlist_id = p.id and ${OWN}) as n
			from playlist p
			where p.source in ('spotify', 'tidal') and p.source_id <> 'liked-songs'`,
		)
		.all() as {
		id: string;
		source: 'spotify' | 'tidal';
		source_id: string;
		name: string;
		owner_name: string | null;
		owner_id: string | null;
		cover_url: string | null;
		url: string | null;
		track_count: number | null;
		n: number;
	}[];
	return rows
		.filter((r) => !(r.owner_id && r.owner_id === (r.source === 'spotify' ? myIds.spotify : myIds.tidal)))
		.sort((a, b) => b.n - a.n || (b.track_count ?? 0) - (a.track_count ?? 0) || a.name.localeCompare(b.name))
		.map((r) => ({
			key: `playlist:${r.id}`,
			kind: 'playlist',
			name: r.name,
			count: r.n,
			detail: [r.track_count != null ? `${r.track_count} tracks` : null, r.owner_name ? `by ${r.owner_name}` : null, r.source === 'tidal' ? 'Tidal' : 'Spotify']
				.filter(Boolean)
				.join(' · '),
			imageUrl: r.cover_url,
			target: {
				claim: {
					provider: r.source,
					kind: 'playlist',
					providerId: r.source_id,
					name: r.name,
					url: r.url ?? (r.source === 'spotify' ? `https://open.spotify.com/playlist/${r.source_id}` : `https://tidal.com/browse/playlist/${r.source_id}`),
					...(r.cover_url ? { facts: { coverUrl: r.cover_url } } : {}),
				},
			},
			blocked: null,
			followedObjectId: null,
			matchKey: `${r.source}:${r.source_id}`,
		}));
}

// Spellings of one name ("Innervisions", "innervisions") folded together,
// counts summed, shown as the most used spelling; most frequent first.
function foldGroups(rows: { name: string; n: number }[]): { name: string; n: number; fold: string }[] {
	const groups = new Map<string, { best: string; bestN: number; n: number }>();
	for (const r of rows) {
		const fold = nameFold(r.name);
		if (!fold) continue;
		const g = groups.get(fold);
		if (!g) groups.set(fold, { best: r.name, bestN: r.n, n: r.n });
		else {
			g.n += r.n;
			if (r.n > g.bestN) {
				g.best = r.name;
				g.bestN = r.n;
			}
		}
	}
	return [...groups.entries()].map(([fold, g]) => ({ name: g.best, n: g.n, fold })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}
