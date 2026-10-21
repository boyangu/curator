// The rekordbox slot of track_analysis (rb_beatgrid, rb_downbeats,
// rb_key_camelot, rb_segments_json) — one home for how it is read and
// written, shared by the importer (rekordbox's own values) and the op-log
// projection (another device's rekordbox values, sync-log/project.ts), so a
// unit arriving from elsewhere lands in exactly the columns a local import
// would have written.
//
// The slot rides a track_analysis row. A track with no row yet gets the same
// placeholder the importer has always minted (analyzer_version 'rekordbox':
// "rb data present, no Curator analysis yet"); the analyzer overwrites the
// marker when it runs, and the catalogue treats a hash-less row with no
// Curator units as fillable, so the placeholder blocks neither.

import type Database from 'better-sqlite3';
import type { SegmentRecord } from '@curator/shared/schema';

type Raw = Database.Database;

export type RbSlotRow = {
	rb_beatgrid: Buffer | null;
	rb_downbeats: Buffer | null;
	rb_key_camelot: string | null;
	rb_segments_json: string | null;
	// rekordbox's tempo and key confidence (protocol v4 units bpm /
	// key_strength). The importer does not write them today; the values on a
	// library come from the dual-slot migration, and the op log carries them
	// to other devices.
	rb_bpm?: number | null;
	rb_key_strength?: number | null;
};

const STMTS = new WeakMap<Raw, { read: Database.Statement<[string], RbSlotRow> }>();

export function readRbSlot(raw: Raw, trackId: string): RbSlotRow | null {
	let s = STMTS.get(raw);
	if (!s) {
		s = { read: raw.prepare(`SELECT rb_beatgrid, rb_downbeats, rb_key_camelot, rb_segments_json, rb_bpm, rb_key_strength FROM track_analysis WHERE track_id = ?`) };
		STMTS.set(raw, s);
	}
	return s.read.get(trackId) ?? null;
}

export function float32Buffer(vals: readonly number[]): Buffer {
	const arr = new Float32Array(vals);
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function decodeFloat32(buf: Buffer | null): number[] {
	if (!buf || buf.byteLength < 4) return [];
	// Copy: a Buffer's byteOffset need not be 4-aligned.
	const copy = new Uint8Array(buf.byteLength - (buf.byteLength % 4));
	copy.set(buf.subarray(0, copy.byteLength));
	return [...new Float32Array(copy.buffer)];
}

// Intro/outro lengths from rekordbox phrases, mirrored onto the track row for
// the list's sort/filter. Only these translate: rb's vocabulary is song-form
// (verse/chorus/bridge), so first-drop / drop-count / breakdown-count have no
// faithful mapping.
export function rbIntroOutro(segments: readonly SegmentRecord[]): { introLengthSec: number | null; outroLengthSec: number | null } {
	let introLengthSec: number | null = null;
	let outroLengthSec: number | null = null;
	const intro = segments.find((s) => s.label === 'Intro' || s.label === 'Intro 1' || s.label === 'Intro 2');
	if (intro) introLengthSec = intro.endSec - intro.startSec;
	for (let i = segments.length - 1; i >= 0; i--) {
		const s = segments[i]!;
		if (s.label === 'Outro' || s.label === 'Outro 1' || s.label === 'Outro 2') {
			outroLengthSec = s.endSec - s.startSec;
			break;
		}
	}
	return { introLengthSec, outroLengthSec };
}

export type RbSlotPatch = {
	beatgrid?: Buffer | null;
	downbeats?: Buffer | null;
	keyCamelot?: string | null;
	segmentsJson?: string | null;
	bpm?: number | null;
	keyStrength?: number | null;
};

// Upsert only the given rb_* columns (placeholder row when there is none).
export function writeRbSlot(raw: Raw, trackId: string, patch: RbSlotPatch): void {
	const cols: Array<[string, unknown]> = [];
	if (patch.beatgrid !== undefined) cols.push(['rb_beatgrid', patch.beatgrid]);
	if (patch.downbeats !== undefined) cols.push(['rb_downbeats', patch.downbeats]);
	if (patch.keyCamelot !== undefined) cols.push(['rb_key_camelot', patch.keyCamelot]);
	if (patch.segmentsJson !== undefined) cols.push(['rb_segments_json', patch.segmentsJson]);
	if (patch.bpm !== undefined) cols.push(['rb_bpm', patch.bpm]);
	if (patch.keyStrength !== undefined) cols.push(['rb_key_strength', patch.keyStrength]);
	if (cols.length === 0) return;
	raw.prepare(`INSERT INTO track_analysis (track_id, analyzer_version, analyzed_at, ${cols.map((c) => c[0]).join(', ')})
		VALUES (?, 'rekordbox', ?, ${cols.map(() => '?').join(', ')})
		ON CONFLICT(track_id) DO UPDATE SET ${cols.map((c) => `${c[0]} = excluded.${c[0]}`).join(', ')}`)
		.run(trackId, Date.now(), ...cols.map((c) => c[1]));
}
