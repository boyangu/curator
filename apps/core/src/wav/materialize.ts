// Mint the Curator side of a WAV copy: a NEW track row carrying everything
// its FLAC original has (metadata, overrides, rating, colour, comment,
// analysis incl. the rekordbox slot, cues, user tags + MyTags), bound to the
// WAV path by a local source_link — all in one transaction, BEFORE the file
// is renamed into place (see convert-run.ts).
//
// Why bind first: the library watcher sees the renamed file as a chokidar
// `add`. With a source_link already holding that path (and the same mtime/
// size — rename preserves both) the scanner takes its 'skipped' branch.
// Without it, matchOrCreate would score the WAV against the library and bind
// it straight back onto the FLAC's track: same artists and duration, and the
// "[WAV]" title suffix folds to a substring match in the scorer.
//
// Copy, not move (cf. library/merge-tracks.ts, which re-points): the
// original keeps everything. Deliberately NOT copied:
//   - isrc / mbid — startup ISRC dedup (db/migrate.ts) hard-deletes
//     same-ISRC duplicates; the copy also carries derived_from_track_id,
//     which that pass skips, but a null ISRC keeps every other ISRC matcher
//     (Spotify/Tidal sync, scanner) away from it too.
//   - streaming source_links — (source, source_track_id) is unique; the
//     copy is a local file, its provider identity stays with the original.
//   - rekordbox_link — created by the rekordbox push when it creates the
//     WAV's own DjmdContent row.
//   - play history, analysis/download jobs.

import { randomUUID } from 'node:crypto';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import type Database from 'better-sqlite3';
import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import {
	track,
	trackAnalysis,
	cue as cueTable,
	trackTag,
	sourceLink,
	SYSTEM_TAG_BASKET,
	SYSTEM_TAG_INTERESTED,
	type NewTrack,
	type TrackOverrides,
} from '@curator/shared/schema';
import { asciify, withFormatTag } from '@curator/shared';
import type { Db } from '../db/client.js';
import { syncTrackArtists } from '../library/artists.js';
import { syncTrackAlbumsById } from '../library/albums.js';
import { upsertLocalSourceLink } from '../local/scanner.js';

export interface DerivativeRow {
	id: string;
	filePath: string | null;
}

// The live WAV copy of `sourceTrackId`, with its local file path (null when
// the copy's file link is gone — e.g. the user deleted the WAV on disk and
// the watcher orphaned the link).
export function findLiveDerivative(db: Db, sourceTrackId: string): DerivativeRow | null {
	const row = db
		.select({ id: track.id })
		.from(track)
		.where(and(eq(track.derivedFromTrackId, sourceTrackId), isNull(track.deletedAt)))
		.get();
	if (!row) return null;
	const link = db
		.select({ filePath: sourceLink.filePath })
		.from(sourceLink)
		.where(and(eq(sourceLink.trackId, row.id), eq(sourceLink.source, 'local')))
		.get();
	return { id: row.id, filePath: link?.filePath ?? null };
}

export interface MaterializeInput {
	sourceTrackId: string;
	// Normalized final path (the file is still at `<path>.part`).
	wavPath: string;
	stat: { size: number; mtimeMs: number };
	// audioHash() of the written WAV. Equals the FLAC source's value unless
	// the conversion resampled (pcm-md5 is over the raw PCM, container-free).
	// Stored now so the watcher's `add` can take its skip path — a link with
	// no hash is re-parsed on every startup pass.
	audioHash: string | null;
}

function linkPayload(row: Pick<NewTrack, 'title' | 'artists' | 'albumTitle' | 'duration' | 'bpm'>, audioHash: string | null) {
	return {
		isrc: null,
		title: row.title,
		artists: (row.artists ?? []).map((a) => a.name),
		albumTitle: row.albumTitle ?? null,
		duration: row.duration ?? null,
		bpm: row.bpm ?? null,
		// Same value the scanner records for a WAV (music-metadata's
		// container, lowercased), so every reader sees one spelling.
		container: 'wave',
		audioHash,
	};
}

export function materializeWavCopy(db: Db, sqlite: Database.Database, input: MaterializeInput): string {
	const src = db.select().from(track).where(eq(track.id, input.sourceTrackId)).get();
	if (!src) throw new Error(`source track ${input.sourceTrackId} not found`);
	const id = randomUUID();
	const now = new Date();

	const overrides: TrackOverrides | null = src.overrides?.title
		? { ...src.overrides, title: withFormatTag(src.overrides.title, 'WAV') }
		: src.overrides;
	const { id: _srcId, createdAt: _c, updatedAt: _u, ...rest } = src;
	const row: NewTrack = {
		...rest,
		id,
		// Its own recording id, not the source's: the copy is device-local
		// and never synced, and sharing the id would make an op addressed to
		// the recording resolve to two local rows.
		recordingId: recordingIdForTrack(id),
		title: withFormatTag(src.title, 'WAV'),
		overrides,
		isrc: null,
		mbid: null,
		derivedFromTrackId: src.id,
		// Recomputed by the caller's membership pass once the link exists.
		membership: null,
		playCount: 0,
		lastPlayedAt: null,
		addedAt: now,
		deletedAt: null,
		// Marks the copied cue set as Curator-authored: the rekordbox push
		// then writes it even before rb has ever seen this track, and the
		// first pull after creation can't read rb's (initially empty) cue
		// list as "user deleted every cue".
		cuesEditedAt: now,
		createdAt: now,
		updatedAt: now,
	};

	sqlite.transaction(() => {
		db.insert(track).values(asciify(row)).run();
		syncTrackArtists(db, [{ id, artists: row.artists, overrides: row.overrides ?? null }]);
		syncTrackAlbumsById(db, [id]);

		const analysis = db.select().from(trackAnalysis).where(eq(trackAnalysis.trackId, src.id)).get();
		if (analysis) db.insert(trackAnalysis).values({ ...analysis, trackId: id }).run();

		const cues = db.select().from(cueTable).where(eq(cueTable.trackId, src.id)).all();
		for (const c of cues) {
			db.insert(cueTable).values({ ...c, id: randomUUID(), trackId: id, origin: 'curator', createdAt: now }).run();
		}

		// User tags and rekordbox MyTags travel; the Interested/Basket system
		// tags are workflow state about the original, not the copy.
		const tags = db
			.select({ tagId: trackTag.tagId })
			.from(trackTag)
			.where(and(eq(trackTag.trackId, src.id), notInArray(trackTag.tagId, [SYSTEM_TAG_INTERESTED, SYSTEM_TAG_BASKET])))
			.all();
		for (const t of tags) db.insert(trackTag).values({ trackId: id, tagId: t.tagId, addedAt: now }).run();

		upsertLocalSourceLink(db, id, input.wavPath, input.stat, linkPayload(row, input.audioHash));
	})();
	return id;
}

// Re-bind an existing live copy to a freshly written file (its old WAV went
// missing). The copy's relations are left as the user may have curated them
// since; only the file link is renewed.
export function rebindWavCopy(db: Db, sqlite: Database.Database, copyId: string, input: MaterializeInput): void {
	const row = db.select().from(track).where(eq(track.id, copyId)).get();
	if (!row) throw new Error(`WAV copy ${copyId} not found`);
	sqlite.transaction(() => {
		db.delete(sourceLink).where(and(eq(sourceLink.trackId, copyId), eq(sourceLink.source, 'local'))).run();
		upsertLocalSourceLink(db, copyId, input.wavPath, input.stat, linkPayload(row, input.audioHash));
	})();
}

// Compensating delete when the final rename fails after materialize
// committed — the row would otherwise point at a file that never appeared.
// Cascades clear analysis, cues, tags, artists and the source_link.
export function discardWavCopy(db: Db, copyId: string): void {
	db.delete(track).where(eq(track.id, copyId)).run();
}

// Local links of a set of tracks, for planning (format + path). Live links
// only (missing_at IS NULL): the convert planner reads these files, and a
// link the watcher flagged missing has none (see resolveLocalFile).
export function localLinksFor(db: Db, trackIds: string[]): Map<string, Array<{ filePath: string; fileFormat: string | null }>> {
	const out = new Map<string, Array<{ filePath: string; fileFormat: string | null }>>();
	for (let i = 0; i < trackIds.length; i += 500) {
		const rows = db
			.select({ trackId: sourceLink.trackId, filePath: sourceLink.filePath, fileFormat: sourceLink.fileFormat })
			.from(sourceLink)
			.where(and(eq(sourceLink.source, 'local'), isNull(sourceLink.missingAt), inArray(sourceLink.trackId, trackIds.slice(i, i + 500))))
			.all();
		for (const r of rows) {
			if (!r.filePath) continue;
			let list = out.get(r.trackId);
			if (!list) { list = []; out.set(r.trackId, list); }
			list.push({ filePath: r.filePath, fileFormat: r.fileFormat });
		}
	}
	return out;
}
