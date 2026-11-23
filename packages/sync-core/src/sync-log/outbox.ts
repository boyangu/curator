// emitOps: every library write lands in the outbox in the same transaction as
// the write itself (cloud design: "Client apply on the desktop"), so a crash
// can neither lose an op nor apply a change without recording it.
//
// Per op: stamp op_id, device_id, client_ts (hybrid-lite clock, persisted so
// it is monotonic across restarts) and schema_version (the version that
// introduced the op's kind, so older clients only hold at what they cannot
// read: protocol ops.ts `opSchemaVersion`); validate with
// `parseOp`; append to sync_outbox with the next seq_local; and fold it into
// the reducer records (store.ts), which is what lets a later incoming op lose
// to this device's newer write. A delete/remove lands in `tombstone` as part
// of that fold.
//
// No-op suppression: before an op is written, it is checked against the
// records just loaded for the fold (reduce.ts `isRestatement`). An op that
// would only re-stamp a value the records already hold is dropped — no
// outbox row, no clock tick. Safe because those records only ever hold
// values that came from an op in this device's outbox or from the log
// (pull, snapshot), so every replica already converges on that value; and
// conservative because anything the records have not seen (a row from
// before the op log, ahead of its initial push) is a change and emits. It
// also means a re-import that restates what it read last time costs reads,
// not 30k outbox rows per run (2026-10-18: every rekordbox sync re-emitted
// the whole play history). Known edge: a value whose op the server rejected
// stays in the local records, so restating it is suppressed too — the
// rejection already left this device diverged on that cell.
//
// A validation failure is a programming error: it throws, and the caller's
// transaction — the user's write — rolls back with it. Builders in rows.ts
// coerce what legacy rows can hold but the wire cannot.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { applyOp, isRestatement, nextClientTs, opSchemaVersion, parseOp, tombstoneKey, type NewOp, type Op } from '@curator/protocol';
import { getDeviceId } from './device.js';
import { SyncStateStore } from './store.js';
import { folderCreateOp, memberAddOp, pinnedCreateOp, playlistCreateOps, tagCreateOp } from './rows.js';

type Raw = Database.Database;

// An op as a mutator hands it over. `client_ts` is set only by the initial
// push, which replays rows with their original timestamps (design D10).
export type EmitOp = NewOp & { client_ts?: number };

export type EmitOptions = {
	// Stamp every op of the call with one clock: the recording merge's
	// re-assert ops must carry the merge's own clock (cloud plan B1 note).
	sameClock?: boolean;
	// Skip the prerequisite creates (initial push emits every row itself).
	noPrerequisites?: boolean;
	// The ops are a one-time backlog's (the initial push, a backfill), not a
	// user's edit: recorded on their outbox rows so the sync client can
	// upload them as a server batch ('batches', client.ts) while edits keep
	// flowing as plain pushes. Only ever passed by the backfill drivers
	// themselves, per call: a scope spanning their yields would also catch
	// a user's edit made in between.
	batchLabel?: BatchLabel;
	// The founder fold (initial-push.ts foldLibraryAsync): the op is stamped
	// and folded into the records exactly as an emitted one, but it is never
	// sent — no outbox row, no seq_local, no wake-up. The first device of an
	// account states its library as the account's BASE, which the master
	// publishes whole as a snapshot (snapshot-build.ts); the log carries only
	// what changes after it. The records still need the op's clock (op_id,
	// device_id, client_ts): every later write anywhere is compared against
	// it, and the snapshot carries it to every other device.
	local?: boolean;
};

// The batch labels the client uploads under (protocol BATCH_LABEL_PATTERN):
// one live server batch per device and label. 'initial-push': a library's
// first upload. 'backfill': everything stated once later (rekordbox units,
// recordings and claims, track meta / attributes, the v4 statements, album
// metadata, feed decisions, and a backlog found pending at upgrade).
export const BATCH_LABELS = ['initial-push', 'backfill'] as const;
export type BatchLabel = (typeof BATCH_LABELS)[number];

// ── clock state ─────────────────────────────────────────────────────────────
// Device-local, in app_setting (never an account key, so it can never ride
// an op): the last client_ts issued, the last server time seen (written by
// the pull client in cloud plan C), and the last seq_local. Read and written
// inside the caller's transaction, so two processes on one DB serialise on
// SQLite's write lock instead of racing a cached copy.

export const CLOCK_KEY = 'sync.clock';

type ClockState = { lastIssuedTs: number; lastServerTs: number; lastSeqLocal: number };

function readClock(raw: Raw): ClockState {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(CLOCK_KEY) as { value: string } | undefined;
	const blank: ClockState = { lastIssuedTs: 0, lastServerTs: 0, lastSeqLocal: 0 };
	if (!row) {
		// First op on this DB: continue after anything already in the outbox
		// (a DB that predates the clock row, or one restored from a backup
		// that lost it) so seq_local never repeats.
		const max = raw.prepare(`SELECT COALESCE(MAX(seq_local), 0) AS s, COALESCE(MAX(client_ts), 0) AS t FROM sync_outbox`).get() as { s: number; t: number };
		return { ...blank, lastSeqLocal: max.s, lastIssuedTs: max.t };
	}
	try {
		const v = JSON.parse(row.value) as Partial<ClockState>;
		return {
			lastIssuedTs: Number(v.lastIssuedTs) || 0,
			lastServerTs: Number(v.lastServerTs) || 0,
			lastSeqLocal: Number(v.lastSeqLocal) || 0,
		};
	} catch {
		return blank;
	}
}

function writeClock(raw: Raw, c: ClockState): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(CLOCK_KEY, JSON.stringify(c), Date.now());
}

// For the pull client (plan C): every server time seen raises the floor the
// next client_ts is stamped above.
export function observeServerTs(raw: Raw, serverTs: number): void {
	raw.transaction(() => {
		const c = readClock(raw);
		if (serverTs > c.lastServerTs) writeClock(raw, { ...c, lastServerTs: serverTs });
	})();
}

// ── prerequisites ───────────────────────────────────────────────────────────
// A container created before the op log existed has no create on record, and
// the reducer treats a container with no create as invisible: an assignment
// to a legacy tag would vanish on every other device, and a later incoming
// op on it would hide it here too. So the first op that references such a
// container (or edits a legacy membership row) records its create first,
// built from the local row. The initial push covers the rest wholesale.

function withPrerequisites(raw: Raw, store: SyncStateStore, ops: readonly EmitOp[]): EmitOp[] {
	const out: EmitOp[] = [];
	const settled = new Set<string>();
	const recorded = (map: 'tags' | 'playlists' | 'playlistFolders' | 'pinnedSearches', entity: 'tag' | 'playlist' | 'playlist_folder' | 'pinned_search', id: string): boolean => {
		const rec = store.ensure(map, id) as { created: unknown } | undefined;
		return !!rec?.created || store.ensureTombstone(tombstoneKey(entity, id)) !== undefined;
	};
	const ensure = (entity: 'tag' | 'playlist' | 'playlist_folder' | 'pinned_search', id: string): void => {
		const key = `${entity}:${id}`;
		if (settled.has(key)) return;
		settled.add(key);
		switch (entity) {
			case 'tag':
				if (!recorded('tags', entity, id)) { const op = tagCreateOp(raw, id); if (op) out.push(op); }
				return;
			case 'playlist':
				if (!recorded('playlists', entity, id)) out.push(...playlistCreateOps(raw, id));
				return;
			case 'playlist_folder':
				if (!recorded('playlistFolders', entity, id)) { const op = folderCreateOp(raw, id); if (op) out.push(op); }
				return;
			case 'pinned_search':
				if (!recorded('pinnedSearches', entity, id)) { const op = pinnedCreateOp(raw, id); if (op) out.push(op); }
				return;
		}
	};
	for (const op of ops) {
		switch (op.entity) {
			case 'tag':
			case 'playlist':
			case 'playlist_folder':
			case 'pinned_search':
				// The op's own create/delete settles the container either way.
				if (op.kind === 'create' || op.kind === 'delete') settled.add(`${op.entity}:${op.entity_id}`);
				else ensure(op.entity, op.entity_id);
				break;
			case 'track_tag':
				ensure('tag', op.entity_id.slice(op.entity_id.indexOf(':') + 1));
				break;
			case 'playlist_track':
				if (op.kind === 'add') {
					ensure('playlist', op.payload.playlist_id);
					settled.add(`row:${op.entity_id}`);
				} else if (op.kind === 'move' && !settled.has(`row:${op.entity_id}`)) {
					settled.add(`row:${op.entity_id}`);
					const rec = store.ensure('playlistTracks', op.entity_id) as { added: unknown } | undefined;
					if (!rec?.added) {
						const add = memberAddOp(raw, op.entity_id);
						if (add && add.entity === 'playlist_track' && add.kind === 'add') {
							ensure('playlist', add.payload.playlist_id);
							out.push(add);
						}
					}
				}
				break;
			default:
				break;
		}
		out.push(op);
	}
	return out;
}

// ── emit ────────────────────────────────────────────────────────────────────

type Stmts = { insert: Database.Statement<[string, number, string, number, number, string, string, string, string, number, string | null]> };
const STMTS = new WeakMap<Raw, Stmts>();
function stmts(raw: Raw): Stmts {
	let s = STMTS.get(raw);
	if (!s) {
		s = {
			insert: raw.prepare(`INSERT INTO sync_outbox (op_id, seq_local, device_id, client_ts, schema_version, entity, entity_id, kind, payload, state, created_at, batch_label)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`),
		};
		STMTS.set(raw, s);
	}
	return s;
}

// ── append listeners ────────────────────────────────────────────────────────
// The sync client's push loop wakes on a local write instead of waiting for
// its 60 s fallback tick: the "visible on another device within 5 s" target
// starts at local commit. Listeners fire synchronously from inside the
// caller's transaction, so they must only schedule work (the client
// debounces onto a timer, which by construction runs after the commit).
// Per handle: a second process on the same DB (the core sidecar) has its
// own handle and no listener, and the fallback tick covers its writes.

const APPEND_LISTENERS = new WeakMap<Raw, Set<() => void>>();

export function onOutboxAppend(raw: Raw, cb: () => void): () => void {
	let set = APPEND_LISTENERS.get(raw);
	if (!set) APPEND_LISTENERS.set(raw, (set = new Set()));
	set.add(cb);
	return () => { set!.delete(cb); };
}

function notifyAppend(raw: Raw): void {
	const set = APPEND_LISTENERS.get(raw);
	if (!set) return;
	for (const cb of set) {
		try { cb(); } catch { /* a listener must never fail the user's write */ }
	}
}

export function emitOps(raw: Raw, ops: readonly EmitOp[], opts: EmitOptions = {}): Op[] {
	if (ops.length === 0) return [];
	// The op and the write it records commit together or not at all.
	if (!raw.inTransaction) throw new Error('emitOps must run inside the caller\'s transaction');

	const store = new SyncStateStore(raw);
	// Batch-load the records the prerequisite check reads (a reorder's moves
	// probe each row's add) before it probes them one by one.
	if (!opts.noPrerequisites) store.prefetch(ops as readonly Op[]);
	const all = opts.noPrerequisites ? ops : withPrerequisites(raw, store, ops);
	// No-op suppression (see reduce.ts `isRestatement` for the rule): an op
	// whose value every replica already converges on is not written. Only for
	// ops stamped here with a fresh clock: the merge re-assert (sameClock)
	// restates on purpose, its clock is the point, and the initial push
	// (explicit client_ts) replays history the records do not hold yet.
	const suppress = !opts.sameClock && !opts.noPrerequisites;
	// One batched load for everything the loop below reads (records, the
	// tombstones the no-op check compares against, merge folds); touch()
	// only fills what an earlier op of the batch re-resolved.
	store.prefetch(all as readonly Op[], { forRestatement: suppress });
	const device = getDeviceId(raw);
	const clock = readClock(raw);
	const now = Date.now();
	const s = stmts(raw);
	let shared: number | null = null;
	const stamped: Op[] = [];
	// Applied op by op, so the second of two ops on one entity in a batch
	// (an add then a remove) is judged against the first.
	for (const op of all) {
		let ts: number;
		if (op.client_ts !== undefined) {
			ts = op.client_ts;
		} else if (opts.sameClock) {
			if (shared === null) shared = clock.lastIssuedTs = nextClientTs(now, clock.lastServerTs, clock.lastIssuedTs);
			ts = shared;
		} else {
			// Each op its own tick, so two ops of one call on the same entity
			// (an add then a remove) keep their order under LWW. Committed to
			// the clock only once the op is kept.
			ts = nextClientTs(now, clock.lastServerTs, clock.lastIssuedTs);
		}
		const { client_ts: _ignored, ...body } = op;
		const full = parseOp({ ...body, op_id: randomUUID(), device_id: device, client_ts: ts, schema_version: opSchemaVersion(body) });
		// Judged on the parsed op: its payload is what the records hold.
		store.touch(full, { forRestatement: suppress });
		if (suppress && op.client_ts === undefined && isRestatement(store.state, full)) continue;
		if (op.client_ts === undefined && !opts.sameClock) clock.lastIssuedTs = ts;
		if (!opts.local) {
			clock.lastSeqLocal++;
			s.insert.run(full.op_id, clock.lastSeqLocal, device, ts, full.schema_version, full.entity, full.entity_id, full.kind, JSON.stringify(full.payload), now, opts.batchLabel ?? null);
		}
		stamped.push(full);
		applyOp(store.state, full);
	}
	if (stamped.length === 0) return stamped;
	// A local fold still advances the issued clock: its stamps are in the
	// records, and the next real op must sort after them.
	writeClock(raw, clock);
	store.flush();
	if (opts.local) return stamped;
	for (const sink of CAPTURES.get(raw) ?? []) sink.push(...stamped);
	notifyAppend(raw);
	return stamped;
}

// ── retention ───────────────────────────────────────────────────────────────
// Acked rows are kept for a week, then deleted (the sync client, after a
// cycle that left nothing pending): a row's work is done once the server has
// it — the own-op skip (apply.ts) needs it only until this device's pull
// cursor has passed the op, which a drained pull guarantees, and the
// restore-safe bound (client.ts ownThroughSeq) is a seq, not a row. The
// main library's outbox was ~230k acked rows that nothing read.
//
// Before anything is deleted the clock row is pinned to what the outbox
// holds: readClock derives lastIssuedTs / lastSeqLocal from the outbox's
// maxima only while the row is missing (a DB from before the row, or a
// restore that lost it), and once rows are gone those maxima can only
// shrink — a clock that regressed would re-issue a seq_local and stamp an
// op below one already in the log.

export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function pinClock(raw: Raw): void {
	raw.transaction(() => {
		const c = readClock(raw);
		const max = raw.prepare(`SELECT COALESCE(MAX(seq_local), 0) AS s, COALESCE(MAX(client_ts), 0) AS t FROM sync_outbox`).get() as { s: number; t: number };
		writeClock(raw, { ...c, lastIssuedTs: Math.max(c.lastIssuedTs, max.t), lastSeqLocal: Math.max(c.lastSeqLocal, max.s) });
	})();
}

// Deletes at most `max` acked rows created before `olderThanMs` ago, oldest
// first, in chunks of 2,000 per transaction (the writer lock is never held
// for the whole sweep). Returns how many went.
export function pruneAckedOutbox(raw: Raw, opts: { olderThanMs?: number; max?: number; now?: number } = {}): number {
	const cutoff = (opts.now ?? Date.now()) - (opts.olderThanMs ?? OUTBOX_RETENTION_MS);
	let left = Math.max(0, opts.max ?? 20_000);
	let deleted = 0;
	if (left === 0) return 0;
	pinClock(raw);
	const del = raw.prepare(`DELETE FROM sync_outbox WHERE op_id IN (SELECT op_id FROM sync_outbox WHERE state = 'acked' AND created_at < ? ORDER BY seq_local LIMIT ?)`);
	while (left > 0) {
		const chunk = Math.min(2_000, left);
		const n = del.run(cutoff, chunk).changes;
		deleted += n;
		left -= n;
		if (n < chunk) break;
	}
	return deleted;
}

// The ops a write emits, for a caller that must refer to them afterwards by
// op id (the upstream acks, F23: an ack names the op that implied the
// external write). The mutators stay unchanged: emitOps reports into every
// capture open on the handle. Run inside the caller's transaction, so a
// rollback discards the write and the captured list with it.
const CAPTURES = new WeakMap<Raw, Op[][]>();
export function captureEmitted<T>(raw: Raw, fn: () => T): { result: T; ops: Op[] } {
	const sink: Op[] = [];
	let stack = CAPTURES.get(raw);
	if (!stack) CAPTURES.set(raw, (stack = []));
	stack.push(sink);
	try {
		return { result: fn(), ops: sink };
	} finally {
		stack.splice(stack.lastIndexOf(sink), 1);
	}
}

// Convenience for single-entity writers: run `write` and the ops it returns
// in one transaction (a savepoint when the caller already holds one).
export function writeAndEmit<T>(raw: Raw, write: () => { result: T; ops: EmitOp[] }, opts?: EmitOptions): T {
	return raw.transaction(() => {
		const { result, ops } = write();
		emitOps(raw, ops, opts);
		return result;
	})();
}

// Read the outbox back as wire ops, oldest first (tests, replay-check, and
// the push loop in plan C).
export function readOutbox(raw: Raw, opts: { state?: 'pending' | 'acked' | 'rejected' } = {}): Op[] {
	const rows = (opts.state
		? raw.prepare(`SELECT * FROM sync_outbox WHERE state = ? ORDER BY seq_local`).all(opts.state)
		: raw.prepare(`SELECT * FROM sync_outbox ORDER BY seq_local`).all()) as Array<{
		op_id: string; device_id: string; client_ts: number; schema_version: number; entity: string; entity_id: string; kind: string; payload: string;
	}>;
	return rows.map((r) => parseOp({
		op_id: r.op_id,
		device_id: r.device_id,
		client_ts: r.client_ts,
		schema_version: r.schema_version,
		entity: r.entity,
		entity_id: r.entity_id,
		kind: r.kind,
		payload: JSON.parse(r.payload),
	}));
}
