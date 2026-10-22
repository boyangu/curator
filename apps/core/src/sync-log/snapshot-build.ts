// The master device's snapshot, built from its own records ('snapshot_storage';
// protocol cloud-service.ts). The master holds the fold of the log in its
// reducer records (store.ts: sync_state, tombstone, recording_alias), so the
// account's snapshot is those records serialised — no 227 MB fold in the
// cloud API's 512 MB process. The body must be byte-identical to
// `serializeLibraryState` of the server's fold at the same seq (the server's
// verifier compares sha256 of the JSON), so this reads the records exactly
// as the reducer holds them and writes them with the protocol's streaming
// writer, never building the whole state or one string of it.
//
// Consistency: ONE read transaction on a connection of its own (read-only),
// which sees the records, the preconditions and the cursor as of one
// instant whatever the app writes meanwhile. The preconditions are what make
// the records equal to the fold through the cursor:
//   - no pending outbox row: every local op is in the log (and so in the
//     fold), and no local op the log lacks is in the records;
//   - no rejected row: a refused op's effect stays in the local records only
//     (outbox.ts "Known edge");
//   - nothing held (sync_inbox_held): every op through the cursor applied;
//   - no clamp repair owed (needsRepair) and no own op past the cursor
//     (ownThroughSeq ≤ cursor);
//   - the records are complete (the initial push ran).
// A failed precondition is not an error: the caller tries a later cycle.
//
// Output: the JSON, gzipped as it is written and cut into parts of at most
// SNAPSHOT_PART_MAX_BYTES, each a file named by its sha256 in `outDir`, plus
// the manifest the server is told. Runs in a utility process in the desktop
// app (main/cloud/snapshot-host.ts); tests and the CLI run it inline.
//
// The digest-only form (`buildSnapshotDigest`) streams the same JSON through
// the sha256 alone, no gzip, no parts: a secondary at the master's published
// seq compares its own records' digest with the manifest's stateSha256
// (client.ts, the cross-device check that replaced the server's fold) — a
// difference means its records drifted from the base, and it reloads.

import Database from 'better-sqlite3';
import { createHash, type Hash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
	compareSnapshotKeys,
	createLibraryState,
	MAX_SNAPSHOT_PARTS,
	rebuildArtistAlias,
	serializeLibraryStateChunks,
	SNAPSHOT_PART_MAX_BYTES,
	SNAPSHOT_STORAGE_ENCODING,
	snapshotPartPath,
	tombstoneKey,
	type ArtistAliasRecord,
	type Entity,
	type LibraryStateMapName,
	type SnapshotManifest,
} from '@curator/protocol';
import { RECORDS_COMPLETE_KEY } from './apply.js';
import { CLIENT_STATE_KEY, readCursor } from './client.js';
import { STATE_MAPS, tombClock, type StateMap } from './store.js';

type Raw = Database.Database;

export type SnapshotSkipReason = 'pending_ops' | 'rejected_ops' | 'held_ops' | 'needs_repair' | 'own_ops_ahead' | 'records_incomplete' | 'empty_log';

export type SnapshotBuildOk = {
	ok: true;
	digestOnly?: false;
	snapshotSeq: number;
	manifest: SnapshotManifest;
	// The local file of each part, in manifest order. All of them live in
	// `dir`, which the caller removes once it is done with them.
	files: string[];
	dir: string;
	jsonBytes: number;
	records: number;
	buildMs: number;
	// The builder process's peak resident set, when it ran in one of its own.
	peakRssBytes?: number;
};
export type SnapshotDigestOk = {
	ok: true;
	digestOnly: true;
	snapshotSeq: number;
	// sha256 of the serialised JSON: what SnapshotManifest.stateSha256 holds.
	stateSha256: string;
	records: number;
	buildMs: number;
	peakRssBytes?: number;
};
export type SnapshotBuildSkipped = { ok: false; skipped: SnapshotSkipReason; count?: number };
export type SnapshotBuildResult = SnapshotBuildOk | SnapshotDigestOk | SnapshotBuildSkipped;

// What the sync client is given (CoreServiceOptions.cloud.snapshot): the
// desktop injects one that runs in a utility process, like parseAudio;
// without it the build runs inline (tests, CLI). Builds the snapshot of
// `userId`'s library from this database's records — or, with `digestOnly`,
// only its digest (above).
export type SnapshotBuilder = (req: { userId: string; digestOnly?: boolean }) => Promise<SnapshotBuildResult>;

// The JSON handed to gzip in pieces of about this many UTF-16 units: big
// enough that zlib sees long runs, small enough to hold nothing large.
const FLUSH_CHARS = 1 << 20;

// Every entry of one persisted map in the protocol's key order. SQLite's
// primary-key order is UTF-8 byte order, which equals the protocol's UTF-16
// code-unit order unless a key mixes astral characters with U+E000..U+FFFF;
// the keys are read first to check, and a map where the two differ is read
// key by key in the protocol's order instead.
function* stateEntries(db: Raw, map: StateMap): Generator<[string, unknown]> {
	const keys = db.prepare(`SELECT key FROM sync_state WHERE map = ? ORDER BY key`).pluck().all(map) as string[];
	let ordered = true;
	for (let i = 1; i < keys.length && ordered; i++) ordered = keys[i - 1]! < keys[i]!;
	if (ordered) {
		for (const r of db.prepare(`SELECT key, value FROM sync_state WHERE map = ? ORDER BY key`).iterate(map) as IterableIterator<{ key: string; value: string }>) {
			yield [r.key, JSON.parse(r.value)];
		}
		return;
	}
	keys.sort(compareSnapshotKeys);
	const get = db.prepare(`SELECT value FROM sync_state WHERE map = ? AND key = ?`).pluck();
	for (const k of keys) yield [k, JSON.parse(get.get(map, k) as string)];
}

// The tombstone table as the reducer's `tombstones` map holds it: key
// `${entity}:${entityId}`, value the delete's whole clock. Small rows; read
// whole and sorted here, since the table's (entity, entity_id) order is not
// the composite key's.
function tombstoneEntries(db: Raw): Array<[string, unknown]> {
	const rows = db.prepare(`SELECT entity, entity_id, client_ts, device_id, op_id FROM tombstone`).all() as Array<{ entity: string; entity_id: string; client_ts: number; device_id: string | null; op_id: string | null }>;
	return rows.map((r): [string, unknown] => [tombstoneKey(r.entity as Entity, r.entity_id), tombClock(r)]).sort(([a], [b]) => compareSnapshotKeys(a, b));
}

// `recordingAlias` is persisted flattened (recording_alias); `artistAlias`
// is derived from the rules by the reducer's own rebuild, as SyncStateStore
// does on load.
function recordingAliasEntries(db: Raw): Array<[string, unknown]> {
	const rows = db.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>;
	return rows.map((r): [string, unknown] => [r.loser, r.winner]).sort(([a], [b]) => compareSnapshotKeys(a, b));
}

function artistAliasEntries(db: Raw): Array<[string, unknown]> {
	const state = createLibraryState();
	for (const r of db.prepare(`SELECT key, value FROM sync_state WHERE map = 'artistAliases'`).all() as Array<{ key: string; value: string }>) {
		state.artistAliases.set(r.key, JSON.parse(r.value) as ArtistAliasRecord);
	}
	rebuildArtistAlias(state);
	return [...state.artistAlias.entries()].sort(([a], [b]) => compareSnapshotKeys(a, b));
}

const PERSISTED = new Set<string>(STATE_MAPS);

function entriesOf(db: Raw, map: LibraryStateMapName): Iterable<readonly [string, unknown]> {
	if (PERSISTED.has(map)) return stateEntries(db, map as StateMap);
	switch (map) {
		case 'tombstones': return tombstoneEntries(db);
		case 'recordingAlias': return recordingAliasEntries(db);
		case 'artistAlias': return artistAliasEntries(db);
		default: throw new TypeError(`snapshot map ${map} has no source in the desktop records`);
	}
}

// The preconditions and the seq, read inside the build's transaction.
function readPreconditions(db: Raw): { seq: number } | { skipped: SnapshotSkipReason; count?: number } {
	if (db.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(RECORDS_COMPLETE_KEY) === undefined) return { skipped: 'records_incomplete' };
	const counts = new Map((db.prepare(`SELECT state, count(*) AS n FROM sync_outbox WHERE state IN ('pending', 'rejected') GROUP BY state`).all() as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));
	if (counts.get('pending')) return { skipped: 'pending_ops', count: counts.get('pending')! };
	if (counts.get('rejected')) return { skipped: 'rejected_ops', count: counts.get('rejected')! };
	const held = db.prepare(`SELECT count(*) FROM sync_inbox_held`).pluck().get() as number;
	if (held > 0) return { skipped: 'held_ops', count: held };
	const seq = readCursor(db).lastSeq;
	if (seq < 1) return { skipped: 'empty_log' };
	const json = db.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(CLIENT_STATE_KEY) as string | undefined;
	let st: { needsRepair?: boolean; ownThroughSeq?: number } = {};
	try { st = json ? JSON.parse(json) : {}; } catch { /* a blank state: nothing owed */ }
	if (st.needsRepair) return { skipped: 'needs_repair' };
	if ((st.ownThroughSeq ?? 0) > seq) return { skipped: 'own_ops_ahead', count: st.ownThroughSeq! - seq };
	return { seq };
}

// gzip output into content-addressed part files.
class PartWriter {
	readonly files: string[] = [];
	readonly parts: SnapshotManifest['parts'] = [];
	readonly body: Hash = createHash('sha256');
	total = 0;
	private cur: { fd: number; tmp: string; bytes: number; hash: Hash } | null = null;

	constructor(private readonly dir: string, private readonly userId: string, private readonly max: number) {}

	write(chunk: Buffer): void {
		this.body.update(chunk);
		this.total += chunk.length;
		for (let off = 0; off < chunk.length;) {
			if (!this.cur) {
				const tmp = join(this.dir, `part-${this.parts.length}.tmp`);
				this.cur = { fd: openSync(tmp, 'w'), tmp, bytes: 0, hash: createHash('sha256') };
			}
			const n = Math.min(chunk.length - off, this.max - this.cur.bytes);
			const piece = chunk.subarray(off, off + n);
			writeSync(this.cur.fd, piece);
			this.cur.hash.update(piece);
			this.cur.bytes += n;
			off += n;
			if (this.cur.bytes === this.max) this.cut();
		}
	}

	cut(): void {
		const c = this.cur;
		if (!c) return;
		this.cur = null;
		closeSync(c.fd);
		const sha256 = c.hash.digest('hex');
		const file = join(this.dir, `${sha256}.cgz`);
		renameSync(c.tmp, file);
		this.files.push(file);
		this.parts.push({ path: snapshotPartPath(this.userId, sha256), bytes: c.bytes, sha256 });
	}

	abort(): void {
		if (this.cur) { try { closeSync(this.cur.fd); } catch { /* closed */ } this.cur = null; }
	}
}

// The JSON, streamed in pieces of about FLUSH_CHARS to `feed`, inside one
// read transaction on the build's own connection; the preconditions and the
// seq are read in the same transaction. `feed` may await (gzip's drain):
// that keeps a sync_state iterator open across the await, which is safe on
// a connection nothing else uses.
async function streamSnapshot(dbPath: string, feed: (s: string) => Promise<void>): Promise<{ seq: number; records: number } | SnapshotBuildSkipped> {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	let open = false;
	try {
		db.exec('BEGIN');
		open = true;
		const pre = readPreconditions(db);
		if ('skipped' in pre) return { ok: false, skipped: pre.skipped, ...(pre.count !== undefined ? { count: pre.count } : {}) };
		const pieces: string[] = [];
		let pending = 0;
		let records = 0;
		const counted = (map: LibraryStateMapName): Iterable<readonly [string, unknown]> => {
			const src = entriesOf(db, map);
			return (function* () { for (const e of src) { records++; yield e; } })();
		};
		for (const piece of serializeLibraryStateChunks(counted)) {
			pieces.push(piece);
			pending += piece.length;
			if (pending >= FLUSH_CHARS) {
				await feed(pieces.join(''));
				pieces.length = 0;
				pending = 0;
			}
		}
		if (pieces.length > 0) await feed(pieces.join(''));
		db.exec('COMMIT');
		open = false;
		return { seq: pre.seq, records };
	} finally {
		if (open) { try { db.exec('ROLLBACK'); } catch { /* the transaction already ended */ } }
		db.close();
	}
}

export async function buildSnapshotParts(input: { dbPath: string; outDir: string; userId: string; partMaxBytes?: number }): Promise<SnapshotBuildOk | SnapshotBuildSkipped> {
	const started = performance.now();
	const parts = new PartWriter(input.outDir, input.userId, Math.min(input.partMaxBytes ?? SNAPSHOT_PART_MAX_BYTES, SNAPSHOT_PART_MAX_BYTES));
	try {
		mkdirSync(input.outDir, { recursive: true });
		const gz = createGzip();
		gz.on('data', (chunk: Buffer) => parts.write(chunk));
		const json = createHash('sha256');
		let jsonBytes = 0;
		const r = await streamSnapshot(input.dbPath, async (s) => {
			const buf = Buffer.from(s, 'utf8');
			json.update(buf);
			jsonBytes += buf.length;
			if (!gz.write(buf)) await once(gz, 'drain');
		});
		if ('skipped' in r) { gz.destroy(); parts.abort(); return r; }
		gz.end();
		await finished(gz);
		parts.cut();
		if (parts.parts.length > MAX_SNAPSHOT_PARTS) throw new Error(`snapshot of ${parts.total} gzip bytes needs ${parts.parts.length} parts, past the ${MAX_SNAPSHOT_PARTS} allowed`);
		return {
			ok: true,
			snapshotSeq: r.seq,
			manifest: {
				encoding: SNAPSHOT_STORAGE_ENCODING,
				parts: parts.parts,
				totalBytes: parts.total,
				sha256: parts.body.digest('hex'),
				stateSha256: json.digest('hex'),
			},
			files: parts.files,
			dir: input.outDir,
			jsonBytes,
			records: r.records,
			buildMs: Math.round(performance.now() - started),
		};
	} catch (err) {
		parts.abort();
		throw err;
	}
}

// The digest alone (header): the same JSON, hashed, nothing written.
export async function buildSnapshotDigest(input: { dbPath: string }): Promise<SnapshotDigestOk | SnapshotBuildSkipped> {
	const started = performance.now();
	const json = createHash('sha256');
	const r = await streamSnapshot(input.dbPath, async (s) => { json.update(Buffer.from(s, 'utf8')); });
	if ('skipped' in r) return r;
	return { ok: true, digestOnly: true, snapshotSeq: r.seq, stateSha256: json.digest('hex'), records: r.records, buildMs: Math.round(performance.now() - started) };
}

// The fallback when the host injects no builder (tests, CLI): the same
// build on this thread, into a fresh directory under `tmpRoot`.
export function inlineSnapshotBuilder(dbPath: string, tmpRoot: string = tmpdir()): SnapshotBuilder {
	return async ({ userId, digestOnly }) => {
		if (digestOnly) return buildSnapshotDigest({ dbPath });
		mkdirSync(tmpRoot, { recursive: true });
		const outDir = mkdtempSync(join(tmpRoot, 'curator-snapshot-'));
		try {
			const r = await buildSnapshotParts({ dbPath, outDir, userId });
			if (!r.ok) rmSync(outDir, { recursive: true, force: true });
			return r;
		} catch (err) {
			rmSync(outDir, { recursive: true, force: true });
			throw err;
		}
	};
}
