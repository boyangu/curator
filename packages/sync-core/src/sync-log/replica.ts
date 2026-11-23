// Ready-made libraries ('replica_storage', protocol cloud-service.ts).
//
// A device that joins folds the master's snapshot record by record: the
// 39k-track library took about two minutes on a phone even after tuning, and
// 72 s on a laptop with the database entirely in memory — per-record work,
// not storage (measured 2026-11-21). So the master does it once, here
// (`buildReplica`): the same client, joining the snapshot it just published,
// against an account that exists only in this process and holds nothing but
// that snapshot, into an empty library. The database is compacted and cut
// into parts, each slice of the file gzipped on its own, and published beside
// the snapshot. A device whose library is empty installs it instead of
// joining (`installReplica`): download, check, inflate part by part onto the
// end of a staging file, move it into place, migrate it up to this app, take
// a device identity of its own (remint.ts, as a restored backup does), then
// sync as any device that already holds the account up to the replica's seq.
// On the phone: 6.7 s to a usable library, against 109–120 s for the join
// (spike, 2026-11-21).
//
// Built from the snapshot, never copied from the master's own library, so it
// holds the account and nothing local to the master. The join must not emit
// an op: whatever it did would be in the replica and never on the server. The
// builder's account refuses pushes, and an outbox left non-empty fails the
// build.

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
	MAX_SNAPSHOT_PARTS,
	REPLICA_STORAGE_ENCODING,
	SNAPSHOT_PART_MAX_BYTES,
	snapshotPartPath,
	SYNC_FEATURES,
	type DeviceInfo,
	type PullInput,
	type ReplicaManifest,
	type ReplicaOffer,
	type SnapshotPart,
} from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { claimLinkPendingCount } from './claim-links.js';
import { CloudTransportError, createSyncClient, type CloudTransport } from './client.js';
import { remintDeviceIdentityAt } from './remint.js';
import { derivePendingCount, remotePendingCount } from './remote-rows.js';
import { inflateSnapshotText } from './snapshot-storage.js';

// The replica's format. Bump it when a schema change would trip an app from
// before it that installs a replica built after it (a newer app migrates an
// older replica up, as it does any old library): such an app then gets
// none and joins the snapshot instead.
export const REPLICA_SCHEMA = 1;

export type ReplicaBuildOk = {
	ok: true;
	snapshotSeq: number;
	manifest: ReplicaManifest;
	// The local file of each part, in manifest order, all in `dir`, which the
	// caller removes once it is done with them.
	files: string[];
	dir: string;
	joinMs: number;
	buildMs: number;
	// The builder process's peak resident set, when it ran in one of its own.
	peakRssBytes?: number;
};

// What the sync client is given (SnapshotPublishOptions.replica): the
// desktop injects one that runs in its snapshot utility process; tests and
// the CLI build inline (`inlineReplicaBuilder`).
export type ReplicaBuilder = (req: { userId: string; masterDeviceId: string; snapshotSeq: number; snapshotFiles: readonly string[] }) => Promise<ReplicaBuildOk>;

// A slice of the database per part: ~4× smaller gzipped on the main library,
// so well under the part cap; a slice that gzips past it is halved.
const SLICE_START_BYTES = 24 * 1024 * 1024;
const SLICE_MIN_BYTES = 256 * 1024;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// The account the builder joins: this process's own, holding the snapshot
// and nothing after it. The master registered first (whoever founds an
// empty account is read off registration order, client.ts), the builder's
// device after it. Pull answers "bootstrap from the snapshot" below its seq
// and an empty page at it; push refuses (the header).
function snapshotAccount(userId: string, masterDeviceId: string, snapshotSeq: number, body: Buffer): CloudTransport {
	const features = [...SYNC_FEATURES];
	const devices = new Map<string, DeviceInfo>([[masterDeviceId, { deviceId: masterDeviceId, name: 'Master', platform: 'win32', registeredAt: 1, lastSeenAt: null, revokedAt: null }]]);
	return {
		session: () => ({ userId, email: null }),
		signOut: async () => {},
		account: {
			registerDevice: async (d) => {
				devices.set(d.deviceId, { ...d, registeredAt: devices.get(d.deviceId)?.registeredAt ?? Date.now(), lastSeenAt: null, revokedAt: null });
				return { ok: true as const };
			},
			devices: async () => [...devices.values()],
			revokeDevice: async () => { throw new CloudTransportError('bad_request', 'the replica builder revokes nothing'); },
		},
		sync: {
			push: async (input) => {
				const kinds = new Map<string, number>();
				for (const op of input.ops as Array<{ entity?: string; kind?: string }>) kinds.set(`${op.entity}.${op.kind}`, (kinds.get(`${op.entity}.${op.kind}`) ?? 0) + 1);
				throw new CloudTransportError('bad_request', `the replica builder pushes nothing (refused: ${[...kinds].map(([k, n]) => `${n}× ${k}`).join(', ')})`);
			},
			pull: async (input: PullInput) =>
				input.afterSeq < snapshotSeq ? { ops: [], nextSeq: input.afterSeq, snapshotSeq, features } : { ops: [], nextSeq: input.afterSeq, features },
		},
		bootstrap: async () => ({ snapshotSeq, baseSeq: snapshotSeq, snapshot: inflateSnapshotText(body, { maxBytes: 4 * 1024 * 1024 * 1024 }) }),
	};
}

// The join a fresh device would run, into `dbPath`: cycles until one changes
// nothing and nothing is queued.
async function joinSnapshot(dbPath: string, account: CloudTransport, snapshotSeq: number): Promise<void> {
	migrate(dbPath);
	const raw = new Database(dbPath);
	raw.pragma('journal_mode = WAL');
	raw.pragma('foreign_keys = ON');
	try {
		const client = createSyncClient({ db: raw, transport: account, device: { name: 'Replica builder', platform: 'linux' } });
		try {
			const tracks = raw.prepare(`SELECT count(*) FROM track`).pluck();
			let prev = '';
			for (let i = 0; i < 12; i++) {
				await client.syncNow();
				const s = client.status();
				if (s.lastError) throw new Error(`the replica's join failed: ${s.lastError}`);
				const queued = remotePendingCount(raw) + derivePendingCount(raw) + claimLinkPendingCount(raw);
				const now = `${s.lastSeq}:${tracks.get() as number}:${queued}`;
				if (s.lastSeq >= snapshotSeq && queued === 0 && now === prev) break;
				prev = now;
			}
		} finally {
			client.stop();
		}
		const emitted = raw.prepare(`SELECT count(*) FROM sync_outbox`).pluck().get() as number;
		if (emitted > 0) throw new Error(`the replica's join emitted ${emitted} op(s); a replica holds the account and nothing else`);
		raw.pragma('wal_checkpoint(TRUNCATE)');
	} finally {
		raw.close();
	}
}

// The compacted database, cut into gzip parts (the header), written to
// `outDir` under their content-addressed names.
function cutIntoParts(file: string, outDir: string, userId: string, partMaxBytes: number): { parts: SnapshotPart[]; files: string[]; rawBytes: number; rawSha256: string; totalBytes: number } {
	const parts: SnapshotPart[] = [];
	const files: string[] = [];
	const whole = createHash('sha256');
	const size = statSync(file).size;
	const fd = openSync(file, 'r');
	try {
		let slice = SLICE_START_BYTES;
		for (let at = 0; at < size;) {
			const n = Math.min(slice, size - at);
			const buf = Buffer.alloc(n);
			readSync(fd, buf, 0, n, at);
			const gz = gzipSync(buf, { level: 6 });
			const sha = sha256(gz);
			const path = snapshotPartPath(userId, sha);
			// Too big for a part, or the same bytes as an earlier part (a path
			// may appear once in a manifest): the slice is cut differently.
			if ((gz.length > partMaxBytes || parts.some((p) => p.path === path)) && n > SLICE_MIN_BYTES) {
				slice = gz.length > partMaxBytes ? Math.floor(slice / 2) : n - 4096;
				continue;
			}
			if (gz.length > partMaxBytes) throw new Error(`a ${n}-byte slice of the replica gzips to ${gz.length} bytes, past the part cap`);
			const out = join(outDir, `${sha}.cgz`);
			writeFileSync(out, gz);
			parts.push({ path, bytes: gz.length, sha256: sha });
			files.push(out);
			whole.update(buf);
			at += n;
			// Back up towards the starting size: one stretch that compresses
			// badly (analysis blobs) must not leave every later part small.
			slice = Math.min(SLICE_START_BYTES, Math.round(slice * 1.5));
		}
	} finally {
		closeSync(fd);
	}
	if (parts.length > MAX_SNAPSHOT_PARTS) throw new Error(`the replica needs ${parts.length} parts, past the ${MAX_SNAPSHOT_PARTS} allowed`);
	return { parts, files, rawBytes: size, rawSha256: whole.digest('hex'), totalBytes: parts.reduce((s, p) => s + p.bytes, 0) };
}

// The master's half (the header): the library a fresh device builds from the
// snapshot whose gzip parts are `snapshotFiles` (snapshot-build.ts, in
// order), as replica parts under `outDir`.
export async function buildReplica(input: { userId: string; masterDeviceId: string; snapshotSeq: number; snapshotFiles: readonly string[]; outDir: string; partMaxBytes?: number }): Promise<ReplicaBuildOk> {
	const started = performance.now();
	mkdirSync(input.outDir, { recursive: true });
	// The join's library in a folder of its own: migrating an empty library
	// leaves one-off backups beside it (migrate.ts backupDatabase).
	const joinDir = join(input.outDir, 'join');
	mkdirSync(joinDir, { recursive: true });
	const work = join(joinDir, 'library.db');
	const compact = join(input.outDir, 'replica.db');
	const body = Buffer.concat(input.snapshotFiles.map((f) => readFileSync(f)));
	try {
		await joinSnapshot(work, snapshotAccount(input.userId, input.masterDeviceId, input.snapshotSeq, body), input.snapshotSeq);
		const joinMs = Math.round(performance.now() - started);
		const db = new Database(work, { readonly: true });
		try { db.exec(`VACUUM INTO '${compact.replaceAll("'", "''")}'`); } finally { db.close(); }
		const cut = cutIntoParts(compact, input.outDir, input.userId, Math.min(input.partMaxBytes ?? SNAPSHOT_PART_MAX_BYTES, SNAPSHOT_PART_MAX_BYTES));
		return {
			ok: true,
			snapshotSeq: input.snapshotSeq,
			manifest: { encoding: REPLICA_STORAGE_ENCODING, schema: REPLICA_SCHEMA, parts: cut.parts, totalBytes: cut.totalBytes, rawBytes: cut.rawBytes, rawSha256: cut.rawSha256 },
			files: cut.files,
			dir: input.outDir,
			joinMs,
			buildMs: Math.round(performance.now() - started),
		};
	} finally {
		rmSync(joinDir, { recursive: true, force: true });
		rmSync(compact, { force: true });
	}
}

// The fallback when the host injects no builder (tests, CLI): the same build
// on this thread, into a fresh directory under `tmpRoot`.
export function inlineReplicaBuilder(tmpRoot: string): ReplicaBuilder {
	let n = 0;
	return async (req) => {
		const outDir = join(tmpRoot, `curator-replica-${process.pid}-${Date.now()}-${n++}`);
		try {
			return await buildReplica({ ...req, outDir });
		} catch (err) {
			rmSync(outDir, { recursive: true, force: true });
			throw err;
		}
	};
}

export type ReplicaInstallResult = {
	snapshotSeq: number;
	parts: number;
	gzBytes: number;
	rawBytes: number;
	deviceId: string;
	ms: { download: number; verify: number; inflateWrite: number; identity: number; total: number };
};

// The new device's half (the header): `offer` (sync.bootstrap's `replica`)
// installed as the library at `dbPath`, which must not exist yet — a
// replica is for a device with no library of its own. `download` reads a
// part from the `snapshots` bucket. Nothing is at `dbPath` until every part
// checked out and the file is whole.
// Parts in flight at once while a replica installs (each at most 8 MB).
const REPLICA_DOWNLOADS_AHEAD = 3;

export async function installReplica(input: { offer: ReplicaOffer; dbPath: string; download(path: string): Promise<Uint8Array> }): Promise<ReplicaInstallResult> {
	const { offer, dbPath } = input;
	const m = offer.manifest;
	if (m.encoding !== REPLICA_STORAGE_ENCODING || m.schema > REPLICA_SCHEMA) throw new Error(`replica format ${m.encoding} v${m.schema} is newer than this app reads (v${REPLICA_SCHEMA})`);
	if (existsSync(dbPath)) throw new Error(`a library already exists at ${dbPath}; a replica is installed only where there is none`);
	const started = performance.now();
	const staging = `${dbPath}.replica`;
	rmSync(staging, { force: true });
	const ms = { download: 0, verify: 0, inflateWrite: 0, identity: 0, total: 0 };
	const whole = createHash('sha256');
	let rawBytes = 0;
	let gzBytes = 0;
	// Up to AHEAD parts download while the one before them is checked and
	// written: the network and the inflate overlap instead of taking turns.
	// `download` counts only the time spent waiting for a part.
	const fetches: Array<Promise<Uint8Array>> = [];
	const fetchPart = (i: number): void => {
		if (i >= m.parts.length || fetches[i]) return;
		const p = input.download(m.parts[i]!.path);
		// Awaited in order below; a failure ahead is not "unhandled" meanwhile.
		p.catch(() => {});
		fetches[i] = p;
	};
	try {
		for (let i = 0; i < m.parts.length; i++) {
			const part = m.parts[i]!;
			for (let k = i; k < i + REPLICA_DOWNLOADS_AHEAD; k++) fetchPart(k);
			let t = performance.now();
			const bytes = await fetches[i]!;
			delete fetches[i];
			ms.download += performance.now() - t;
			t = performance.now();
			if (bytes.length !== part.bytes || sha256(bytes) !== part.sha256) throw new Error(`replica part ${part.path} does not match its manifest`);
			ms.verify += performance.now() - t;
			t = performance.now();
			const slice = gunzipSync(bytes);
			whole.update(slice);
			appendFileSync(staging, slice);
			ms.inflateWrite += performance.now() - t;
			rawBytes += slice.length;
			gzBytes += bytes.length;
		}
		if (rawBytes !== m.rawBytes || whole.digest('hex') !== m.rawSha256) throw new Error('the replica, put together, does not match its manifest');
		renameSync(staging, dbPath);
	} catch (err) {
		rmSync(staging, { force: true });
		throw err;
	}
	const t = performance.now();
	// This app's migrations (a replica of an older format comes up to date),
	// then an identity of its own: the replica carries the builder's.
	migrate(dbPath);
	const remint = remintDeviceIdentityAt(dbPath, `replica:${offer.snapshotSeq}:${m.rawSha256}`);
	ms.identity = performance.now() - t;
	ms.total = performance.now() - started;
	return {
		snapshotSeq: offer.snapshotSeq,
		parts: m.parts.length,
		gzBytes,
		rawBytes,
		deviceId: remint.newDeviceId,
		ms: { download: Math.round(ms.download), verify: Math.round(ms.verify), inflateWrite: Math.round(ms.inflateWrite), identity: Math.round(ms.identity), total: Math.round(ms.total) },
	};
}

// For a host about to open a library that does not exist yet: the account's
// replica installed at `dbPath`, or null when the transport or the account
// has none for this app. The client opened afterwards pulls from its seq.
export async function joinFromReplica(transport: CloudTransport, dbPath: string): Promise<ReplicaInstallResult | null> {
	if (!transport.replica || !transport.snapshots) return null;
	const offer = await transport.replica(REPLICA_SCHEMA);
	if (!offer) return null;
	const store = transport.snapshots;
	return installReplica({ offer, dbPath, download: (path) => store.download(path) });
}
