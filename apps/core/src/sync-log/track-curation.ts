// A track's curation on the op log (protocol v4 `library_track.set-curation`):
// its comment and its colour label — rekordbox's Comments and Colour, which
// the user sets there or in Curator. Decided 2026-10-21 (Guy): curation set
// on any device reaches every device's library AND its rekordbox ("tagging a
// track on a mobile device, the tag finds itself in rekordbox eventually"),
// so these are last-write-wins across devices, like a rating — not
// master-wins source data (track-attrs.ts), and a received value replaces
// an own row's value, not only an empty one. The row's next "Sync updates"
// carries it into that machine's rekordbox through the exporter (the
// projection bumps updated_at, which puts a linked row in its scope; the
// exporter's own confirmation and omit-if-empty rules apply unchanged).
//
// THE COMMENT IS SYNCED AS FREE TEXT. rekordbox's "Add MyTag to Comments"
// keeps a `/* tag / tag */` block at the end of the comment, in the order
// that machine's rekordbox added the tags (rekordbox/tag-comment.ts), and
// Curator's exporter rebuilds it from the row's rb tags on every push. The
// block is a per-machine derivation of the tags (which sync on their own):
// carried in the op, two machines that list the same tags in different
// orders would each import their own order, see a "change", state it, and
// rewrite the other's — forever. So a device states only the text before
// the block, and a received text is written in front of the row's OWN block
// (kept as it is; the exporter rebuilds it from the tags on push). A change
// of the block alone — tags edited, a re-import in another order — is no
// change of the comment.
//
// Baseline: `track_curation_seen.seen` (JSON, field → wire value), what this
// row last stated or took from the account; a field absent from it was never
// either. It decides:
//   - the drain (part of the track-attrs drain) states a field whose value
//     differs from it: a local edit, or a rekordbox import that changed it.
//     An import restating the same text (or only a different block) emits
//     nothing;
//   - the projection writes a received value only where the column still
//     holds the baseline: a column that differs is a local change the drain
//     has not stated yet, and the drain settles it.
// The CLOCK of a statement is when the edit was made, not when the drain ran
// (the drain runs at the next sync, so two devices editing offline would
// otherwise be ordered by who synced last): `track_curation_edit` is stamped
// by triggers on every write of the column; a field never edited since v4
// (a library from before it) carries the row's updated_at. When the account
// already holds a LATER value than that, the row takes the account's
// instead of stating its own — the op would lose anyway, and the row would
// otherwise keep a value no other device shows.

import type Database from 'better-sqlite3';
import { CURATION_CELL_PREFIX, CURATION_FIELDS, type CurationField, type LwwRecord } from '@curator/protocol';
import { parseTagComment } from '../rekordbox/tag-comment.js';
import type { EmitOp } from './outbox.js';

type Raw = Database.Database;
type Seen = Partial<Record<CurationField, string | null>>;

// The comment's free text: what precedes rekordbox's MyTag block; null when
// there is none.
export function commentFreeText(comment: string | null | undefined): string | null {
	const { prefix } = parseTagComment(comment);
	return prefix.trim().length > 0 ? prefix.slice(0, 8192) : null;
}

// A comment with `free` as its text and the row's own block (if any) kept.
// Same shape rekordbox and the exporter write: one space before the block,
// a block-only comment starting with that space.
export function composeComment(existing: string | null | undefined, free: string | null): string | null {
	const { tokens } = parseTagComment(existing);
	if (tokens && tokens.length > 0) return `${free ?? ''} /* ${tokens.join(' / ')} */`;
	return free;
}

const colour = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 32 ? v : null);

export type CurationRow = { id: string; comment: string | null; color_label: string | null; updated_at: number };

export function curationOf(row: Pick<CurationRow, 'comment' | 'color_label'>): Record<CurationField, string | null> {
	return { comment: commentFreeText(row.comment), color_label: colour(row.color_label) };
}

function readSeen(raw: Raw, trackId: string): Seen | null {
	const json = raw.prepare(`SELECT seen FROM track_curation_seen WHERE track_id = ?`).pluck().get(trackId) as string | undefined;
	if (json === undefined) return null;
	try { return JSON.parse(json) as Seen; } catch { return {}; }
}

function writeSeen(raw: Raw, trackId: string, seen: Seen): void {
	raw.prepare(`INSERT INTO track_curation_seen (track_id, seen) VALUES (?, ?) ON CONFLICT(track_id) DO UPDATE SET seen = excluded.seen`).run(trackId, JSON.stringify(seen));
}

type Cell = { value: unknown; clock: { ts: number } };

// One own row's curation ops (the recording's speaking row), inside the
// drain's transaction. `cells`: the recording's curation cells as the
// records hold them. May also write the row (the account's later value).
export function curationOps(raw: Raw, recordingId: string, row: CurationRow, cells: Partial<Record<CurationField, Cell>>): EmitOp[] {
	const now = curationOf(row);
	const seenRow = readSeen(raw, row.id);
	const seen = seenRow ?? {};
	const next: Seen = { ...seen };
	const ops: EmitOp[] = [];
	const set: Record<string, unknown> = {};
	const edits = raw.prepare(`SELECT comment_at, color_label_at FROM track_curation_edit WHERE track_id = ?`).get(row.id) as { comment_at: number | null; color_label_at: number | null } | undefined;
	for (const f of CURATION_FIELDS) {
		const v = now[f];
		const cell = cells[f];
		const known = f in seen;
		// Nothing to state: unchanged since stated, or never anything here.
		if (known ? seen[f] === v : v === null) { if (!known) next[f] = v; continue; }
		next[f] = v;
		// The account already says the same.
		if (cell && (cell.value ?? null) === v) continue;
		const editedAt = f === 'comment' ? edits?.comment_at : edits?.color_label_at;
		const at = Math.max(0, Math.round(editedAt ?? row.updated_at));
		// The account holds a later value: the row takes it.
		if (cell && cell.clock.ts > at) {
			const take = (cell.value as string | null) ?? null;
			set[f] = f === 'comment' ? composeComment(row.comment, take) : take;
			next[f] = take;
			continue;
		}
		ops.push({ entity: 'library_track', entity_id: recordingId, kind: 'set-curation', payload: { field: f, value: v } as never, client_ts: at });
	}
	const cols = Object.keys(set);
	if (cols.length > 0) raw.prepare(`UPDATE track SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => set[c] as never), Date.now(), row.id);
	if (seenRow === null || JSON.stringify(next) !== JSON.stringify(seen)) writeSeen(raw, row.id, next);
	return ops;
}

// The recording's curation cells, from its record.
export function curationCells(rec: Pick<LwwRecord, 'fields'> | undefined): Partial<Record<CurationField, Cell>> {
	const out: Partial<Record<CurationField, Cell>> = {};
	if (!rec) return out;
	for (const f of CURATION_FIELDS) {
		const c = rec.fields[`${CURATION_CELL_PREFIX}${f}`];
		if (c) out[f] = c as Cell;
	}
	return out;
}

// The record's curation onto every catalogue row of the recording, own and
// remote, where the column still holds the baseline. Returns the rows
// written (the caller bumps updated_at, which is what puts a rekordbox-linked
// row in the exporter's "Sync updates" scope).
export function projectCuration(raw: Raw, recordingId: string, rec: LwwRecord): string[] {
	const cells = curationCells(rec);
	if (Object.keys(cells).length === 0) return [];
	const touched: string[] = [];
	const rows = raw.prepare(`SELECT id, comment, color_label, remote_only FROM track WHERE recording_id = ? AND +derived_from_track_id IS NULL`).all(recordingId) as Array<CurationRow & { remote_only: number }>;
	for (const row of rows) {
		const cur = curationOf(row);
		const seen = readSeen(raw, row.id);
		const next: Seen = { ...(seen ?? {}) };
		const set: Record<string, unknown> = {};
		for (const f of CURATION_FIELDS) {
			const cell = cells[f];
			if (!cell) continue;
			const v = (cell.value as string | null) ?? null;
			if (row.remote_only !== 1) {
				// A local change not stated yet (or a value never stated, which
				// the drain settles by clock): left for the drain.
				const known = seen !== null && f in seen;
				if (known ? seen![f] !== cur[f] : cur[f] !== null && cur[f] !== v) {
					raw.prepare(`INSERT INTO track_attrs_dirty (track_id) VALUES (?) ON CONFLICT DO NOTHING`).run(row.id);
					continue;
				}
			}
			next[f] = v;
			if (cur[f] === v) continue;
			set[f] = f === 'comment' ? composeComment(row.comment, v) : v;
		}
		const cols = Object.keys(set);
		if (cols.length > 0) {
			raw.prepare(`UPDATE track SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => set[c] as never), row.id);
			touched.push(row.id);
		}
		if (JSON.stringify(next) !== JSON.stringify(seen ?? {})) writeSeen(raw, row.id, next);
	}
	return touched;
}
