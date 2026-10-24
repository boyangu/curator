// "The same music at the same paths": what a second desktop holding the
// master's files would know about them, given to the joiner without opening
// one. For every master row with a local file, the joiner's claim index is
// asked who IS that audio hash (the scanner's rule, claim-bind.ts); the
// master's source_link row (path, size, mtime, hash) is attached to the
// joiner's row for that recording. A local source on a remote row turns it
// into this device's own row in place (migrate.ts track_remote_claimed_link),
// which is what the rekordbox pull then links by path.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ClaimBinder } from '@curator/core/e2e';

type Raw = Database.Database;

export type AttachResult = {
	masterLinks: number;
	attached: number;
	// Master rows whose file has no audio hash (nothing to bind by), whose
	// hash the account's records do not claim, whose recording has no row
	// here, and whose path a row here already holds.
	noHash: number;
	noClaim: number;
	noRow: number;
	duplicatePath: number;
	// Bound, but to another recording than the master row's own: the two
	// devices disagree on what this file is.
	recordingMismatch: number;
	samples: Array<{ reason: string; masterTrackId: string; recordingId: string | null; filePath: string | null }>;
};

type LinkRow = Record<string, unknown> & { id: string; track_id: string; file_path: string | null; audio_hash: string | null; recording_id: string | null };

export function attachLocalSources(master: Raw, joiner: Raw): AttachResult {
	const cols = (joiner.prepare(`PRAGMA table_info(source_link)`).all() as Array<{ name: string }>).map((c) => c.name).filter((c) => c !== 'id' && c !== 'track_id');
	const masterCols = new Set((master.prepare(`PRAGMA table_info(source_link)`).all() as Array<{ name: string }>).map((c) => c.name));
	const shared = cols.filter((c) => masterCols.has(c));
	// In the master's own file order (rowid): a track's first file stays its
	// primary file here too, so a twin pick that no playlist decides falls
	// the same way on both (importer.ts landFirstLink).
	const links = master.prepare(`SELECT sl.*, t.recording_id AS recording_id FROM source_link sl JOIN track t ON t.id = sl.track_id
		WHERE sl.source = 'local' AND t.derived_from_track_id IS NULL AND t.remote_only = 0 ORDER BY sl.track_id, sl.rowid`).all() as LinkRow[];
	const out: AttachResult = { masterLinks: links.length, attached: 0, noHash: 0, noClaim: 0, noRow: 0, duplicatePath: 0, recordingMismatch: 0, samples: [] };
	const note = (reason: string, l: LinkRow): void => {
		if (out.samples.length < 50) out.samples.push({ reason, masterTrackId: l.track_id, recordingId: l.recording_id, filePath: l.file_path });
	};
	const binder = new ClaimBinder(joiner);
	binder.prefetch('audio_hash', links.map((l) => l.audio_hash).filter((h): h is string => !!h));
	const held = joiner.prepare(`SELECT 1 FROM source_link WHERE source = 'local' AND file_path = ?`);
	const insert = joiner.prepare(`INSERT INTO source_link (id, track_id, ${shared.join(', ')}) VALUES (?, ?, ${shared.map(() => '?').join(', ')})`);
	joiner.transaction(() => {
		for (const l of links) {
			if (!l.audio_hash) { out.noHash++; note('no audio hash', l); continue; }
			const b = binder.bind('audio_hash', l.audio_hash);
			if (!b) { out.noClaim++; note('hash not claimed in the account', l); continue; }
			if (!b.trackId) { out.noRow++; note('recording has no row on the joiner', l); continue; }
			if (l.file_path && held.get(l.file_path)) { out.duplicatePath++; note('path already attached', l); continue; }
			if (b.recordingId !== l.recording_id) { out.recordingMismatch++; note(`bound to ${b.recordingId}`, l); }
			insert.run(randomUUID(), b.trackId, ...shared.map((c) => l[c] ?? null));
			out.attached++;
		}
	})();
	return out;
}
