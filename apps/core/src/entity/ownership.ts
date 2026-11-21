// Which library track a catalogue recording is: what lets a World page show
// the library's own row (its tags, rating, sources) where the user already
// has the track, in place of a bare catalogue row.
//
// Three routes, strongest first: a catalog_ref row naming the recording, the
// streaming id the catalogue and the library both hold (source_link), the
// ISRC. Batched reads over indexed columns, a page of recordings at a time.

import type Database from 'better-sqlite3';
import { searchFold } from '@curator/shared';

type Raw = Database.Database;

export type OwnershipProbe = {
	recordingId: string;
	releaseId: string;
	releaseTitle: string;
	releaseDate: string | null;
	isrc: string | null;
	spotifyId: string | null;
	tidalId: string | null;
};

export type OwnershipMatch = { libraryTrackId: string; primary: boolean };

const CHUNK = 500;

function inChunks<T>(values: string[], read: (chunk: string[], placeholders: string) => T[]): T[] {
	const out: T[] = [];
	const distinct = [...new Set(values)];
	for (let i = 0; i < distinct.length; i += CHUNK) {
		const chunk = distinct.slice(i, i + CHUNK);
		out.push(...read(chunk, chunk.map(() => '?').join(',')));
	}
	return out;
}

// One answer per probe, in order (null: not in the library). A recording on
// several releases matches the one library track on each of them; `primary`
// marks the row that stands for it — the release whose title is the track's
// own album, else the earliest release.
export function matchLibraryTracks(raw: Raw, probes: readonly OwnershipProbe[]): (OwnershipMatch | null)[] {
	if (!probes.length) return [];
	const byRecording = new Map<string, string>();
	for (const r of inChunks(probes.map((p) => p.recordingId), (c, ph) =>
		raw.prepare(`select r.object_id as k, t.id from catalog_ref r join track t on t.id = r.entity_id and t.deleted_at is null
			where r.entity_kind = 'track' and r.object_id in (${ph})`).all(...c) as { k: string; id: string }[])) byRecording.set(r.k, r.id);

	const byStream = new Map<string, string>();
	for (const source of ['spotify', 'tidal'] as const) {
		const ids = probes.map((p) => (source === 'spotify' ? p.spotifyId : p.tidalId)).filter((x): x is string => !!x);
		for (const r of inChunks(ids, (c, ph) =>
			raw.prepare(`select s.source_track_id as k, t.id from source_link s join track t on t.id = s.track_id and t.deleted_at is null
				where s.source = ? and s.source_track_id in (${ph})`).all(source, ...c) as { k: string; id: string }[])) byStream.set(`${source}:${r.k}`, r.id);
	}

	const byIsrc = new Map<string, string>();
	for (const r of inChunks(probes.map((p) => p.isrc?.toUpperCase()).filter((x): x is string => !!x), (c, ph) =>
		raw.prepare(`select upper(isrc) as k, id from track where isrc in (${ph}) and deleted_at is null`).all(...c) as { k: string; id: string }[])) {
		if (!byIsrc.has(r.k)) byIsrc.set(r.k, r.id);
	}

	const matched = probes.map(
		(p) =>
			byRecording.get(p.recordingId) ??
			(p.spotifyId ? byStream.get(`spotify:${p.spotifyId}`) : undefined) ??
			(p.tidalId ? byStream.get(`tidal:${p.tidalId}`) : undefined) ??
			(p.isrc ? byIsrc.get(p.isrc.toUpperCase()) : undefined) ??
			null,
	);

	// Pick each library track's standing row among the probes that matched it.
	const rowsOf = new Map<string, number[]>();
	matched.forEach((id, i) => {
		if (id) rowsOf.set(id, [...(rowsOf.get(id) ?? []), i]);
	});
	const shared = [...rowsOf].filter(([, rows]) => rows.length > 1).map(([id]) => id);
	const albumOf = new Map<string, string>();
	for (const r of inChunks(shared, (c, ph) => raw.prepare(`select id, album_title from track where id in (${ph})`).all(...c) as { id: string; album_title: string | null }[])) {
		albumOf.set(r.id, searchFold(r.album_title));
	}
	const primary = new Set<number>();
	for (const [id, rows] of rowsOf) {
		const album = albumOf.get(id);
		const own = album ? rows.find((i) => searchFold(probes[i]!.releaseTitle) === album) : undefined;
		// Undated sorts last: a release with a date is the better original.
		const earliest = [...rows].sort((a, b) => (probes[a]!.releaseDate ?? '9999').localeCompare(probes[b]!.releaseDate ?? '9999'))[0]!;
		primary.add(own ?? earliest);
	}
	return matched.map((id, i) => (id ? { libraryTrackId: id, primary: primary.has(i) } : null));
}
