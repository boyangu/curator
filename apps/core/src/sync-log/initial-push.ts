// The initial push (design D10, "The existing library"): ops for every
// library row the op log has not recorded yet, stamped with the row's own
// timestamps (added_at, created_at, cues_edited_at, updated_at, deleted_at)
// so anything the user does afterwards — recorded with a current clock —
// wins over them on every device.
//
// Rows that already have a record (a mutator emitted for them, or a previous
// run of this got that far) are skipped, so it is resumable and safe to run
// again. Device-local rows yield nothing (see rows.ts). Ops go into the
// outbox in chunks of `chunk` per transaction, so the writer lock is never
// held for the whole library; when every chunk is in, the initial-push
// marker lets applyOps run (apply.ts INITIAL_PUSH_KEY).
//
// Two drivers over one op generator: `initialPush` runs it to completion
// synchronously (tests, replay-check, the headless CLI), and
// `initialPushAsync` yields to the event loop between chunks — the desktop
// runs core in Electron's main process, and B measured 18 s for the 127k ops
// of the real library, which would freeze every window if run in one go.
// The generator is lazy, so each chunk's "already recorded?" probes see the
// chunks emitted before it (and any mutator write made in between: a user
// edit during the push records its container's create first, and the push
// then skips it).
//
// Past artist renames/merges ARE reconstructed, from the artist table's
// alias rows and curated spellings (artist_alias rules). Not reconstructed:
// past recording merges (the soft-deleted losers carry no record of which
// row won), rekordbox analysis units (no set-rb-analysis
// writer yet), track creates and claims (catalogue workstream D).

import type Database from 'better-sqlite3';
import { cueEntityId, isAccountSettingKey, trackTagEntityId, type JsonValue } from '@curator/protocol';
import { markRecordsComplete } from './apply.js';
import { emitOps, type EmitOp } from './outbox.js';
import { cueUpsertOp, folderCreateOp, overrideOp, parseOverrides, pinnedCreateOp, playlistCreateOps, ratingOp, recordingResolver, stateOp, tagCreateOp, OVERRIDE_KEYS, OVERRIDE_FIELD_OF, type CueRow } from './rows.js';
import { eventAppendOp, sessionAppendOp } from '../library/mutators.js';

type Raw = Database.Database;

export type InitialPushResult = { ops: number; byEntity: Record<string, number>; ms: number };

export type InitialPushProgress = {
	// Ops written to the outbox so far, and an upper bound of the total (the
	// source row counts; rows that are device-local or already recorded
	// yield nothing, so `done` may finish below it).
	done: number;
	estimate: number;
};

export type InitialPushAsyncResult = InitialPushResult & {
	chunks: number;
	// Longest synchronous slice between two yields: the worst main-loop
	// stall the push caused.
	maxSliceMs: number;
};

// Every op the initial push would emit, in library order, each stamped with
// its row's own time.
function* initialPushOps(raw: Raw): Generator<EmitOp> {
	const stamp = (op: EmitOp, at: number | null | undefined): EmitOp => ({ ...op, client_ts: Math.max(0, Math.round(at ?? 0)) });

	// Rows are read with .all(), not .iterate(): better-sqlite3 refuses a
	// write on a connection with an open iterator, and the chunks flush
	// mid-scan.
	const record = raw.prepare(`SELECT value FROM sync_state WHERE map = ? AND key = ?`);
	const has = (map: string, key: string, field?: string): boolean => {
		const row = record.get(map, key) as { value: string } | undefined;
		if (!row) return false;
		if (!field) return true;
		const v = JSON.parse(row.value) as Record<string, unknown>;
		if (field === 'created' || field === 'added') return v[field] != null;
		return (v['fields'] as Record<string, unknown> | undefined)?.[field] !== undefined;
	};
	const tomb = raw.prepare(`SELECT 1 FROM tombstone WHERE entity = ? AND entity_id = ?`);
	const tombstoned = (entity: string, id: string): boolean => tomb.get(entity, id) !== undefined;
	const rec = recordingResolver(raw);

	// Containers.
	for (const r of raw.prepare(`SELECT id, created_at FROM tag ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>) {
		if (has('tags', r.id, 'created') || tombstoned('tag', r.id)) continue;
		const op = tagCreateOp(raw, r.id);
		if (op) yield stamp(op, r.created_at);
	}
	for (const r of raw.prepare(`SELECT id, created_at FROM playlist_folder ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>) {
		if (has('playlistFolders', r.id, 'created') || tombstoned('playlist_folder', r.id)) continue;
		const op = folderCreateOp(raw, r.id);
		if (op) yield stamp(op, r.created_at);
	}
	const playlists = raw.prepare(`SELECT id, created_at FROM playlist WHERE is_smart = 0 AND derived_from_playlist_id IS NULL ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>;
	const playlistCreated = new Map<string, number>();
	for (const r of playlists) {
		playlistCreated.set(r.id, r.created_at);
		if (has('playlists', r.id, 'created') || tombstoned('playlist', r.id)) continue;
		for (const op of playlistCreateOps(raw, r.id)) yield stamp(op, r.created_at);
	}
	for (const r of raw.prepare(`SELECT id, created_at FROM pinned_search ORDER BY created_at, id`).all() as Array<{ id: string; created_at: number }>) {
		if (has('pinnedSearches', r.id, 'created') || tombstoned('pinned_search', r.id)) continue;
		const op = pinnedCreateOp(raw, r.id);
		if (op) yield stamp(op, r.created_at);
	}

	// Membership, in playlist order so the outbox reads like the library.
	for (const r of raw.prepare(`SELECT id, playlist_id, track_id, order_key, added_at FROM playlist_track ORDER BY playlist_id, order_key, id`).all() as Array<{ id: string; playlist_id: string; track_id: string; order_key: string; added_at: number | null }>) {
		const created = playlistCreated.get(r.playlist_id);
		if (created === undefined) continue; // device-local playlist
		if (has('playlistTracks', r.id, 'added') || tombstoned('playlist_track', r.id)) continue;
		const recording = rec(r.track_id);
		if (!recording) continue;
		yield stamp({ entity: 'playlist_track', entity_id: r.id, kind: 'add', payload: { playlist_id: r.playlist_id, recording_id: recording, order_key: r.order_key } }, r.added_at ?? created);
	}

	// Tag assignments.
	for (const r of raw.prepare(`SELECT track_id, tag_id, added_at FROM track_tag ORDER BY track_id, tag_id`).all() as Array<{ track_id: string; tag_id: string; added_at: number }>) {
		const recording = rec(r.track_id);
		if (!recording) continue;
		const key = trackTagEntityId(recording, r.tag_id);
		if (has('trackTags', key) || tombstoned('track_tag', key)) continue;
		yield stamp({ entity: 'track_tag', entity_id: key, kind: 'add', payload: {} }, r.added_at);
	}

	// Cues, at the track's cue-edit stamp (or the cue's own creation).
	for (const r of raw.prepare(`SELECT c.track_id, c.slot, c.kind, c.position_sec, c.length_sec, c.color, c.name, c.created_at, t.cues_edited_at
		FROM cue c JOIN track t ON t.id = c.track_id WHERE c.slot >= 0 ORDER BY c.track_id, c.kind, c.slot`).all() as Array<CueRow & { track_id: string; created_at: number; cues_edited_at: number | null }>) {
		const recording = rec(r.track_id);
		if (!recording) continue;
		const key = cueEntityId(recording, r.slot, r.kind);
		if (has('cues', key) || tombstoned('cue', key)) continue;
		yield stamp(cueUpsertOp(recording, r), r.cues_edited_at ?? r.created_at);
	}

	// Track state: rating, curation stage (only away from the default a new
	// row gets everywhere), overrides, soft deletes.
	for (const r of raw.prepare(`SELECT id, rating, state, state_changed_at, overrides, deleted_at, updated_at FROM track
		WHERE derived_from_track_id IS NULL AND (rating IS NOT NULL OR state != 'unsorted' OR overrides IS NOT NULL OR deleted_at IS NOT NULL)`).all() as Array<{ id: string; rating: number | null; state: string; state_changed_at: number | null; overrides: string | null; deleted_at: number | null; updated_at: number }>) {
		const recording = rec(r.id);
		if (!recording) continue;
		if (r.rating != null && !has('libraryTracks', recording, 'rating')) yield stamp(ratingOp(recording, r.rating), r.updated_at);
		if (r.state !== 'unsorted' && !has('libraryTracks', recording, 'state')) {
			const op = stateOp(recording, r.state);
			if (op) yield stamp(op, r.state_changed_at ?? r.updated_at);
		}
		const ov = parseOverrides(r.overrides);
		for (const k of OVERRIDE_KEYS) {
			if (ov[k] === undefined || ov[k] === null) continue;
			if (has('libraryTracks', recording, `override.${OVERRIDE_FIELD_OF[k]}`)) continue;
			yield stamp(overrideOp(recording, k, ov[k]), r.updated_at);
		}
		if (r.deleted_at != null && !has('libraryTracks', recording, 'deleted_at')) {
			yield stamp({ entity: 'library_track', entity_id: recording, kind: 'delete', payload: {} }, r.deleted_at);
		}
	}

	// Play history.
	for (const r of raw.prepare(`SELECT id, started_at FROM play_session ORDER BY started_at, id`).all() as Array<{ id: string; started_at: number }>) {
		if (has('playSessions', r.id, 'created')) continue;
		const op = sessionAppendOp(raw, r.id);
		if (op) yield stamp(op, r.started_at);
	}
	for (const r of raw.prepare(`SELECT e.id, COALESCE(e.played_at, s.started_at) AS at FROM play_event e JOIN play_session s ON s.id = e.session_id ORDER BY at, e.id`).all() as Array<{ id: string; at: number }>) {
		if (has('playEvents', r.id)) continue;
		const op = eventAppendOp(raw, r.id, rec);
		if (op) yield stamp(op, r.at);
	}

	// Artist renames and merges made before the op log: each alias row is a
	// rule to its live artist's spelling, each curated spelling a spelling
	// rule, so another device's canonical credits follow them too.
	const artistRows = raw.prepare(`SELECT id, name, name_ascii, merged_into, name_curated_at, updated_at FROM artist`).all() as Array<{ id: string; name: string; name_ascii: string; merged_into: string | null; name_curated_at: number | null; updated_at: number }>;
	const artistById = new Map(artistRows.map((a) => [a.id, a]));
	const liveArtist = (a: (typeof artistRows)[number]): (typeof artistRows)[number] => {
		let cur = a;
		for (let hops = 0; cur.merged_into && hops < 8; hops++) {
			const next = artistById.get(cur.merged_into);
			if (!next) break;
			cur = next;
		}
		return cur;
	};
	for (const a of artistRows) {
		if (!a.name_ascii || has('artistAliases', a.name_ascii)) continue;
		const live = a.merged_into ? liveArtist(a) : null;
		if (live && live.id !== a.id && live.name_ascii && live.name_ascii !== a.name_ascii) {
			yield stamp({ entity: 'artist_alias', entity_id: a.name_ascii, kind: 'set', payload: { from: a.name, to: live.name, to_key: live.name_ascii } }, a.updated_at);
		} else if (!a.merged_into && a.name_curated_at != null) {
			yield stamp({ entity: 'artist_alias', entity_id: a.name_ascii, kind: 'set', payload: { from: a.name, to: a.name, to_key: a.name_ascii } }, a.name_curated_at);
		}
	}

	// Account settings.
	for (const r of raw.prepare(`SELECT key, value, updated_at FROM app_setting`).all() as Array<{ key: string; value: string; updated_at: number }>) {
		if (!isAccountSettingKey(r.key) || has('settings', r.key)) continue;
		yield stamp({ entity: 'setting', entity_id: r.key, kind: 'set', payload: { value: JSON.parse(r.value) as JsonValue } }, r.updated_at);
	}
}

// Upper bound of the op count, for a progress bar: one COUNT per source.
export function estimateInitialPush(raw: Raw): number {
	const n = (sql: string): number => (raw.prepare(sql).get() as { n: number }).n;
	return n(`SELECT count(*) AS n FROM tag`)
		+ n(`SELECT count(*) AS n FROM playlist_folder`)
		+ n(`SELECT count(*) AS n FROM playlist WHERE is_smart = 0 AND derived_from_playlist_id IS NULL`)
		+ n(`SELECT count(*) AS n FROM pinned_search`)
		+ n(`SELECT count(*) AS n FROM playlist_track`)
		+ n(`SELECT count(*) AS n FROM track_tag`)
		+ n(`SELECT count(*) AS n FROM cue WHERE slot >= 0`)
		+ n(`SELECT count(*) AS n FROM track WHERE derived_from_track_id IS NULL AND (rating IS NOT NULL OR state != 'unsorted' OR overrides IS NOT NULL OR deleted_at IS NOT NULL)`)
		+ n(`SELECT count(*) AS n FROM artist WHERE merged_into IS NOT NULL OR name_curated_at IS NOT NULL`)
		+ n(`SELECT count(*) AS n FROM play_session`)
		+ n(`SELECT count(*) AS n FROM play_event`);
}

function emitChunk(raw: Raw, batch: EmitOp[], byEntity: Record<string, number>): void {
	raw.transaction(() => { emitOps(raw, batch, { noPrerequisites: true }); })();
	for (const op of batch) byEntity[op.entity] = (byEntity[op.entity] ?? 0) + 1;
}

export function initialPush(raw: Raw, opts: { chunk?: number } = {}): InitialPushResult {
	const started = Date.now();
	const chunk = opts.chunk ?? 500;
	const byEntity: Record<string, number> = {};
	let total = 0;
	let pending: EmitOp[] = [];
	for (const op of initialPushOps(raw)) {
		pending.push(op);
		total++;
		if (pending.length >= chunk) { emitChunk(raw, pending, byEntity); pending = []; }
	}
	if (pending.length > 0) emitChunk(raw, pending, byEntity);
	markRecordsComplete(raw);
	return { ops: total, byEntity, ms: Date.now() - started };
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The chunked, event-loop-friendly driver. Chunks are capped at 2,000 ops
// (the plan's ceiling); the default 500 keeps each slice to tens of ms on the
// real library. A slice is generation (row probes) plus one chunk's emit
// transaction; `setImmediate` between slices lets queued IPC, timers and
// paints run. `signal` stops between chunks — what is in stays in (the push
// is resumable), and the marker is only written by a run that finished.
export async function initialPushAsync(
	raw: Raw,
	opts: { chunk?: number; onProgress?: (p: InitialPushProgress) => void; signal?: { aborted: boolean } } = {},
): Promise<InitialPushAsyncResult> {
	const started = Date.now();
	const chunk = Math.max(1, Math.min(2_000, opts.chunk ?? 500));
	const byEntity: Record<string, number> = {};
	const estimate = estimateInitialPush(raw);
	let total = 0;
	let chunks = 0;
	let maxSliceMs = 0;
	const gen = initialPushOps(raw);
	for (;;) {
		if (opts.signal?.aborted) {
			gen.return(undefined);
			return { ops: total, byEntity, ms: Date.now() - started, chunks, maxSliceMs };
		}
		const sliceStart = performance.now();
		const batch: EmitOp[] = [];
		let done = false;
		while (batch.length < chunk) {
			const next = gen.next();
			if (next.done) { done = true; break; }
			batch.push(next.value);
		}
		if (batch.length > 0) {
			emitChunk(raw, batch, byEntity);
			total += batch.length;
			chunks++;
		}
		if (done) markRecordsComplete(raw);
		maxSliceMs = Math.max(maxSliceMs, performance.now() - sliceStart);
		opts.onProgress?.({ done: total, estimate: Math.max(estimate, total) });
		if (done) break;
		await yieldToLoop();
	}
	return { ops: total, byEntity, ms: Date.now() - started, chunks, maxSliceMs };
}
