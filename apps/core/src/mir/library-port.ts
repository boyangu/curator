// The engine layer's read-only view of curator.db. Kept behind a port so the
// scheduler and similarity code are testable against a fake library, and so
// a hosted core can swap the SQL for a remote read later.

import type Database from 'better-sqlite3';
import type { MirSegmentIn } from './sidecar.js';

export interface MirLibraryPort {
	// Playable tracks (live, has a local file, not a WAV-derived copy) in the
	// order a background backfill should visit them: the user's curated tracks
	// (rated or user-tagged) first, then most recently played, then newest.
	playableTrackIds(): string[];
	trackFile(trackId: string): string | null;
	// Segment boundaries to pool per-segment vectors over: Curator's own
	// analysis when present, else rekordbox phrases.
	trackSegments(trackId: string): MirSegmentIn[];
	isLive(trackId: string): boolean;
}

// WAV-derived copies are excluded on purpose: a derived copy is the same audio
// as its original and would always be the original's nearest neighbour.
// A local link flagged missing_at is a vanished file kept as a re-bind hint
// (scanner.ts), not audio the engine can read.
const PLAYABLE = `
	t.deleted_at IS NULL AND t.derived_from_track_id IS NULL
	AND EXISTS (SELECT 1 FROM source_link sl WHERE sl.track_id = t.id AND sl.source = 'local' AND sl.file_path IS NOT NULL AND sl.missing_at IS NULL)`;

export function sqliteLibraryPort(sqlite: Database.Database): MirLibraryPort {
	const playable = sqlite.prepare(`
		SELECT t.id FROM track t WHERE ${PLAYABLE}
		ORDER BY (COALESCE(t.rating, 0) > 0 OR EXISTS (
				SELECT 1 FROM track_tag tt JOIN tag g ON g.id = tt.tag_id WHERE tt.track_id = t.id AND g.kind = 'user'
			)) DESC,
			COALESCE(t.last_played_at, 0) DESC, t.created_at DESC
	`);
	const file = sqlite.prepare(`
		SELECT file_path FROM source_link WHERE track_id = ? AND source = 'local' AND file_path IS NOT NULL AND missing_at IS NULL
		ORDER BY fetched_at LIMIT 1
	`);
	const segs = sqlite.prepare(`SELECT segments_json, rb_segments_json FROM track_analysis WHERE track_id = ?`);
	const live = sqlite.prepare(`SELECT 1 FROM track WHERE id = ? AND deleted_at IS NULL`);
	return {
		playableTrackIds: () => (playable.all() as { id: string }[]).map((r) => r.id),
		trackFile: (id) => (file.get(id) as { file_path: string } | undefined)?.file_path ?? null,
		trackSegments: (id) => {
			const r = segs.get(id) as { segments_json: string | null; rb_segments_json: string | null } | undefined;
			for (const raw of [r?.segments_json, r?.rb_segments_json]) {
				if (!raw) continue;
				try {
					const arr = JSON.parse(raw) as { startSec: number; endSec: number; label?: string }[];
					const out = arr
						.filter((s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec)
						.map((s) => ({ startSec: s.startSec, endSec: s.endSec, label: s.label ?? null }));
					if (out.length > 0) return out;
				} catch { /* malformed row: fall through to the other slot */ }
			}
			return [];
		},
		isLive: (id) => live.get(id) !== undefined,
	};
}
