// The measured run, identical on both engines: the product's sync client
// (createSyncClient, unchanged) joins the account as a new device with an
// empty library. The account is the tests' in-memory cloud (fake-cloud.ts)
// holding the real library's snapshot as the master published it, and,
// with `--ops`, real ops after it for the client to pull.
//
//   join --db <replica.db> --data <dir with manifest.json + parts/> --out <dir> [--ops <ops.json>] [--fixed] [--scale 6]
//
// Nothing leaves the process: the transport is the fake cloud's.
//
// And the same client over HTTP, through the transport a phone would use
// (apps/core sync-log/fetch-transport.ts), against the real server code that
// scripts/serve-cloud.ts runs on this machine — a phone reaches it through
// `adb reverse`:
//
//   sync --db <replica.db> --server <server.json> --out <dir> [--tail] [--fixed] [--scale 6]
//
// And the loader alone, fed the same snapshot a small piece at a time
// (scripts/split-snapshot.mjs), then the settle steps the client runs after
// a load — what a bootstrap costs when the snapshot is never held whole:
//
//   stream --db <replica.db> --data <dir with chunks/> --out <dir> [--ops <ops.json>]
//
// `--fixed` is the comparison run: a counted clock, counted ids and a
// counted slice timer, so two engines given the same input must write the
// same database, row for row. Without it the clocks are real and the times
// mean something.

import Database from 'better-sqlite3';
import { platform as P } from 'spike-platform';
import type { Op, SnapshotManifest, StoredOp } from '../../../../packages/protocol/src/index.js';
import { applyOps } from '../../../../apps/core/src/sync-log/apply.js';
import { drainArtistCreditRewritesAsync } from '../../../../apps/core/src/library/artist-alias.js';
import { createFetchCloudTransport } from '../../../../apps/core/src/sync-log/fetch-transport.js';
import { inflateSnapshotText } from '../../../../apps/core/src/sync-log/snapshot-storage.js';
import { createSyncClient, type CloudTransport } from '../../../../apps/core/src/sync-log/client.js';
import { dumpLibrary } from '../../../../apps/core/src/sync-log/dump.js';
import { claimLinkPendingCount, drainClaimLinksAsync, sweepClaimLinksAsync } from '../../../../apps/core/src/sync-log/claim-links.js';
import { healPlayHistoryAsync } from '../../../../apps/core/src/sync-log/play-heal.js';
import { derivePendingCount, drainTrackDerivationsAsync, remotePendingCount } from '../../../../apps/core/src/sync-log/remote-rows.js';
import { drainRemotePendingAsync, sweepRemoteRowsAsync } from '../../../../apps/core/src/sync-log/remote-sweep.js';
import { loadSnapshot, type SnapshotRecord } from '../../../../apps/core/src/sync-log/snapshot.js';
import { readStorageSnapshotBody } from '../../../../apps/core/src/sync-log/snapshot-storage.js';
import { FakeCloud } from '../../../../apps/core/src/test-support/fake-cloud.js';

// After every clock in the data (the library's last issued stamp, 2026-11).
const FIXED_NOW = 1_795_200_000_000;
const USER = 'spike';

function fixTheWorld(): void {
	// One millisecond a reading: time passes (a wait on the clock ends) and
	// two engines that take the same path read the same values.
	let ms = FIXED_NOW;
	const Real = Date;
	class Fixed extends Real {
		constructor(...a: unknown[]) {
			if (a.length === 0) super(ms++);
			else super(...(a as [number]));
		}
		static override now(): number { return ms++; }
	}
	(globalThis as { Date: unknown }).Date = Fixed;
	let n = 0;
	P.fixIds(() => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`);
	// The client sizes its slices by how long the last one took: every
	// reading 5 ms after the one before makes the slicing the same everywhere.
	let t = 0;
	const now = (): number => (t += 5);
	// On the clock object itself where it lets us: Node's fetch asks it for
	// more than `now`. QuickJS's own `now` is fixed in place, so there the
	// object is replaced.
	try {
		Object.defineProperty(globalThis.performance, 'now', { value: now, configurable: true, writable: true });
	} catch {
		(globalThis as { performance: unknown }).performance = { now };
	}
}

function flags(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!a.startsWith('--')) continue;
		const next = args[i + 1];
		out[a.slice(2)] = next !== undefined && !next.startsWith('--') ? args[++i]! : 'true';
	}
	return out;
}

const round = (ms: number): number => Math.round(ms);
const mb = (kb: number): number => Math.round(kb / 1024);

// The account a run syncs with: where its transport leads, how later ops
// reach its log, and what it can say about the run afterwards.
type Account = {
	transport: CloudTransport;
	// Puts the later ops into the account's log; how many. Absent: none to add.
	addTail: (() => Promise<number>) | null;
	pulls(): number;
	pushedByPhone(): number | null;
	facts(): Record<string, unknown>;
};

function fakeAccount(f: Record<string, string>): Account {
	const data = f['data']!;
	const m = JSON.parse(P.readText(`${data}/manifest.json`)) as { seq: number; masterDevice: string | null; manifest: SnapshotManifest };

	// The account: the master's snapshot in the bucket, its seq the base.
	const cloud = new FakeCloud();
	for (const p of m.manifest.parts) cloud.storage.set(p.path, P.readBytes(`${data}/parts/${p.sha256}.cgz`));
	const master = m.masterDevice ?? 'desktop';
	cloud.devices.set(master, { deviceId: master, name: 'Desktop', platform: 'win32', registeredAt: 1, lastSeenAt: null, revokedAt: null });
	cloud.published.push({ seq: m.seq, deviceId: master, manifest: m.manifest });
	cloud.baseSeq = m.seq;
	let seeded = 0;

	const transport = cloud.transport(USER);
	// The fake cloud inflates the snapshot with a Node stream. Where there is
	// none, the same checked body goes through the host's inflater: the
	// transport is the one part of the client a phone writes for itself.
	const inflate = P.inflateText;
	if (inflate) {
		const stock = transport.bootstrap.bind(transport);
		transport.bootstrap = async (input) => {
			const pub = cloud.published.at(-1);
			if (!pub) return stock(input);
			cloud.calls.bootstrap++;
			const body = await readStorageSnapshotBody(pub.manifest, (path) => transport.snapshots!.download(path), { maxBytes: 1 << 30 });
			return { snapshotSeq: pub.seq, baseSeq: cloud.baseSeq, snapshot: inflate(body) };
		};
	}
	return {
		transport,
		addTail: f['ops'] ? async () => {
			let seq = cloud.maxSeq;
			const ops = JSON.parse(P.readText(f['ops']!)) as Op[];
			for (const op of ops) cloud.log.push({ ...op, seq: ++seq, user_id: USER, received_at: op.client_ts } as StoredOp);
			seeded = ops.length;
			return seeded;
		} : null,
		pulls: () => cloud.calls.pull,
		pushedByPhone: () => cloud.log.length - seeded,
		facts: () => ({ cloud: 'in-process fake', snapshot: { seq: m.seq, gzBytes: m.manifest.totalBytes, parts: m.manifest.parts.length }, calls: cloud.calls }),
	};
}

// The real server code on this machine (scripts/serve-cloud.ts), reached
// with the plain-HTTP transport and the platform's own HTTP: Node's fetch,
// or the phone host's socket through `adb reverse`.
function httpAccount(f: Record<string, string>): Account {
	const server = JSON.parse(P.readText(f['server']!)) as { apiUrl: string; userId: string; token: string; snapshotSeq: number };
	const http = P.http;
	if (!http) throw new Error('this platform has no HTTP');
	const calls: Record<string, number> = {};
	const auth = { authorization: `Bearer ${server.token}` };
	let signedIn = true;
	const transport = createFetchCloudTransport({
		apiUrl: server.apiUrl,
		request: async (req) => {
			const proc = /\/trpc\/([^?]+)/.exec(req.url)?.[1] ?? '?';
			calls[proc] = (calls[proc] ?? 0) + 1;
			const res = await http({ ...req, bytes: false });
			return { status: res.status, body: res.text ?? '' };
		},
		session: () => (signedIn ? { userId: server.userId, email: null } : null),
		accessToken: async () => server.token,
		signOut: async () => { signedIn = false; },
		// The bucket as the test server serves it: a part's bytes by its path.
		snapshots: {
			upload: async () => { throw new Error('this device publishes nothing'); },
			remove: async () => {},
			download: async (path) => {
				calls['storage'] = (calls['storage'] ?? 0) + 1;
				const res = await http({ method: 'GET', url: `${server.apiUrl}/storage/${path}`, headers: auth, bytes: true });
				if (res.status !== 200 || !res.bytes) throw new Error(`storage answered ${res.status} for a snapshot part`);
				return res.bytes;
			},
		},
		inflate: (body, opts) => (P.inflateText ? P.inflateText(body) : inflateSnapshotText(body, opts)),
		client: 'spike/0 android',
	});
	return {
		transport,
		// The server pushes the later ops as the master, the way they were made.
		addTail: f['tail'] === 'true' ? async () => {
			const res = await http({ method: 'POST', url: `${server.apiUrl}/control/tail`, headers: auth, bytes: false });
			const r = JSON.parse(res.text ?? '{}') as { accepted?: number; error?: string };
			if (res.status !== 200 || typeof r.accepted !== 'number') throw new Error(`the server could not add the later ops: ${res.status} ${res.text ?? ''}`);
			return r.accepted;
		} : null,
		pulls: () => calls['sync.pull'] ?? 0,
		pushedByPhone: () => null,
		facts: () => ({ cloud: `real server code over HTTP (${server.apiUrl})`, snapshot: { seq: server.snapshotSeq }, calls }),
	};
}

async function syncAs(f: Record<string, string>, account: Account, command: string): Promise<Record<string, unknown>> {
	const t0 = P.now();
	const raw = new Database(f['db']!);
	// As the desktop opens its library (apps/core/src/db/client.ts).
	raw.pragma('journal_mode = WAL');
	raw.pragma('foreign_keys = ON');
	const transport = account.transport;

	// --scale: how much longer than the desktop's a slice may hold the thread (the client's sliceScale).
	const client = createSyncClient({ db: raw, transport, device: { name: 'Spike phone', platform: 'android' }, random: () => 0.5, ...(f['scale'] ? { sliceScale: Number(f['scale']) } : {}) });
	let lastLog = P.now();
	let peakRssKb = 0;
	client.subscribe(() => {
		if (P.now() - lastLog < 5_000) return;
		lastLog = P.now();
		const s = client.status();
		const rss = P.mem().rssKb;
		peakRssKb = Math.max(peakRssKb, rss);
		P.log(`  ${round((P.now() - t0) / 1000)} s  rss ${mb(rss)} MB  seq ${s.lastSeq}${s.bootstrap ? `  snapshot ${s.bootstrap.done}/${s.bootstrap.total}` : ''}`);
	});

	// Cycles until one changes nothing and nothing is queued.
	const cycles: Array<Record<string, unknown>> = [];
	const settle = async (phase: string): Promise<void> => {
		for (let i = 0; i < 8; i++) {
			const t = P.now();
			await client.syncNow();
			const s = client.status();
			const c = {
				phase,
				ms: round(P.now() - t),
				lastSeq: s.lastSeq,
				pendingOps: s.pending,
				remoteRowsQueued: remotePendingCount(raw),
				derivationsQueued: derivePendingCount(raw),
				tracks: raw.prepare(`SELECT count(*) FROM track`).pluck().get() as number,
				pushed: account.pushedByPhone(),
				error: s.lastError,
				rssMb: mb(P.mem().rssKb),
			};
			const prev = cycles[cycles.length - 1];
			cycles.push(c);
			P.log(`cycle ${cycles.length}: ${JSON.stringify(c)}`);
			if (c.error) break;
			if (prev && prev['phase'] === phase && prev['lastSeq'] === c.lastSeq && prev['tracks'] === c.tracks && c.pendingOps === 0 && c.remoteRowsQueued === 0 && c.derivationsQueued === 0) break;
		}
	};
	await settle('join');
	const tJoined = P.now();

	// Then the desktop's later edits land in the log, and the phone pulls them.
	let pull: Record<string, unknown> | null = null;
	if (account.addTail) {
		const before = P.mem(true);
		const joinPeakKb = peakRssKb;
		const added = await account.addTail();
		peakRssKb = 0;
		const pulls0 = account.pulls();
		const t = P.now();
		await settle('pull');
		pull = { ops: added, ms: round(P.now() - t), firstCycleMs: cycles.find((c) => c['phase'] === 'pull')?.['ms'], pages: account.pulls() - pulls0, rssBeforeKb: before.rssKb, jsHeapBeforeKb: before.jsHeapKb, peakRssDuringKb: Math.max(peakRssKb, P.mem().rssKb) };
		peakRssKb = Math.max(peakRssKb, joinPeakKb);
	}
	const tSynced = P.now();
	const afterSync = P.mem(true);
	const status = client.status();
	client.stop();

	const dump = dumpLibrary(raw);
	const tDump = P.now();
	const count = (table: string): number => raw.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
	const counts = {
		tracks: count('track'), playlists: count('playlist'), playlistTracks: count('playlist_track'), trackTags: count('track_tag'), cues: count('cue'),
		artists: count('artist'), albums: count('album'), playEvents: count('play_event'), syncState: count('sync_state'), outbox: count('sync_outbox'), held: count('sync_inbox_held'),
	};
	// The log in one piece and nothing left beside the file, so it can be copied.
	raw.pragma('wal_checkpoint(TRUNCATE)');
	raw.close();
	P.writeText(`${f['out']}/dump.json`, JSON.stringify(dump));
	const end = P.mem();
	return {
		command,
		runtime: P.runtime,
		fixed: f['fixed'] === 'true',
		scale: f['scale'] ? Number(f['scale']) : 1,
		ms: { join: round(tJoined - t0), sync: round(tSynced - t0), dump: round(tDump - tSynced), total: round(tDump - t0) },
		pull,
		cycles,
		status: { lastSeq: status.lastSeq, pending: status.pending, rejected: status.rejected, lastError: status.lastError, initialPushDone: status.initialPushDone, phase: status.phase },
		account: { ...account.facts(), opsPushedByPhone: account.pushedByPhone() },
		mem: { afterSync, end, peakRssKb: Math.max(peakRssKb, end.peakRssKb) },
		counts,
	};
}

async function stream(f: Record<string, string>): Promise<Record<string, unknown>> {
	const t0 = P.now();
	const data = f['data']!;
	const names = JSON.parse(P.readText(`${data}/chunks/index.json`)) as string[];
	const raw = new Database(f['db']!);
	raw.pragma('journal_mode = WAL');
	raw.pragma('foreign_keys = ON');

	let records = 0;
	let maxSliceMs = 0;
	let peakRssKb = 0;
	let lastLog = P.now();
	const maps = new Map<string, { records: number; ms: number }>();
	for (const name of names) {
		const t = P.now();
		const piece = JSON.parse(P.readText(`${data}/chunks/${name}`)) as { map: SnapshotRecord['map']; entries: Array<[string, unknown]> };
		const r = await loadSnapshot(raw, piece.entries.map(([key, value]) => ({ map: piece.map, key, value }) as SnapshotRecord));
		records += piece.entries.length;
		maxSliceMs = Math.max(maxSliceMs, r.maxSliceMs);
		const m = maps.get(piece.map) ?? { records: 0, ms: 0 };
		m.records += piece.entries.length; m.ms += P.now() - t;
		maps.set(piece.map, m);
		if (P.now() - lastLog > 5_000) {
			lastLog = P.now();
			const rss = P.mem().rssKb;
			peakRssKb = Math.max(peakRssKb, rss);
			P.log(`  ${round((P.now() - t0) / 1000)} s  rss ${mb(rss)} MB  ${records} records (${piece.map})`);
		}
	}
	const tLoaded = P.now();
	const afterLoad = P.mem(true);

	// The client's settle steps after a load (client.ts settleRemoteRows,
	// healPlayHistory), in its order.
	const steps: Record<string, number> = {};
	const step = async (name: string, run: () => Promise<unknown>): Promise<void> => {
		const t = P.now();
		await run();
		steps[name] = round(P.now() - t);
		const rss = P.mem().rssKb;
		peakRssKb = Math.max(peakRssKb, rss);
		P.log(`${name}: ${steps[name]} ms, rss ${mb(rss)} MB`);
	};
	await step('remote rows sweep', () => sweepRemoteRowsAsync(raw));
	await step('remote rows queued', async () => { while (remotePendingCount(raw) > 0) await drainRemotePendingAsync(raw); });
	await step('artists and albums', async () => { while (derivePendingCount(raw) > 0) await drainTrackDerivationsAsync(raw); });
	await step('claim links sweep', () => sweepClaimLinksAsync(raw));
	await step('claim links queued', async () => { while (claimLinkPendingCount(raw) > 0) await drainClaimLinksAsync(raw); });
	await step('play history', () => healPlayHistoryAsync(raw));
	const tSettled = P.now();
	const afterSettle = P.mem(true);

	// With --ops: later ops applied in pull-sized pages, as the replay check
	// applies them (applyOps; the client's own pull loop needs its join,
	// which does not fit a phone), then whatever they queued.
	let pull: Record<string, unknown> | null = null;
	if (f['ops']) {
		const ops = JSON.parse(P.readText(f['ops'])) as Op[];
		const pages: number[] = [];
		const t = P.now();
		for (let i = 0; i < ops.length; i += 500) {
			const tp = P.now();
			applyOps(raw, ops.slice(i, i + 500));
			pages.push(P.now() - tp);
		}
		const tApplied = P.now();
		while (remotePendingCount(raw) > 0) await drainRemotePendingAsync(raw);
		while (derivePendingCount(raw) > 0) await drainTrackDerivationsAsync(raw);
		while (claimLinkPendingCount(raw) > 0) await drainClaimLinksAsync(raw);
		await drainArtistCreditRewritesAsync(raw);
		pull = { ops: ops.length, pages: pages.length, applyMs: round(tApplied - t), pageMaxMs: round(Math.max(...pages)), settleMs: round(P.now() - tApplied), rssKb: P.mem().rssKb };
		P.log(`pull: ${JSON.stringify(pull)}`);
	}

	const dump = dumpLibrary(raw);
	const count = (table: string): number => raw.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
	const counts = {
		tracks: count('track'), playlists: count('playlist'), playlistTracks: count('playlist_track'), trackTags: count('track_tag'), cues: count('cue'),
		artists: count('artist'), albums: count('album'), playEvents: count('play_event'), syncState: count('sync_state'), held: count('sync_inbox_held'),
	};
	raw.pragma('wal_checkpoint(TRUNCATE)');
	raw.close();
	P.writeText(`${f['out']}/dump.json`, JSON.stringify(dump));
	const end = P.mem();
	return {
		command: 'stream',
		runtime: P.runtime,
		chunks: names.length,
		records,
		ms: { load: round(tLoaded - t0), settle: round(tSettled - tLoaded), total: round(P.now() - t0) },
		maxSliceMs: round(maxSliceMs),
		maps: Object.fromEntries([...maps].map(([k, m]) => [k, { records: m.records, ms: round(m.ms) }])),
		steps,
		pull,
		mem: { afterLoad, afterSettle, end, peakRssKb: Math.max(peakRssKb, end.peakRssKb) },
		counts,
	};
}

// Ops applied straight onto a library in pages, and how many fingerprint
// claims the records hold after each. This is how the engine's Map bug was
// cornered (host/map-rope-repro.js): kept for the next difference.
//   probe --db <replica.db> --ops <ops.json> [--from 0] [--to 5604] [--page 500] [--trace]
function probe(f: Record<string, string>): Record<string, unknown> {
	const all = JSON.parse(P.readText(f['ops']!)) as Op[];
	const ops = all.slice(Number(f['from'] ?? 0), Number(f['to'] ?? all.length));
	const page = Number(f['page'] ?? 500);
	const raw = new Database(f['db']!);
	raw.pragma('journal_mode = WAL');
	raw.pragma('foreign_keys = ON');
	// With --trace: every write to the records that carries a fingerprint key.
	if (f['trace'] === 'true') {
		const prepare = raw.prepare.bind(raw);
		(raw as unknown as { prepare: unknown }).prepare = (sql: string) => {
			const st = prepare(sql);
			if (/sync_state/.test(sql) && /^\s*(INSERT|DELETE|UPDATE)/i.test(sql)) {
				const run = st.run.bind(st);
				(st as unknown as { run: unknown }).run = (...a: unknown[]) => {
					const r = run(...a);
					if (a.some((x) => typeof x === 'string' && x.includes(':fingerprint:'))) P.log(`${sql.trim().slice(0, 28)} ${JSON.stringify(a.map((x) => (typeof x === 'string' && x.length > 40 ? `<${x.length}>` : x)))} -> ${r.changes}`);
					return r;
				};
			}
			return st;
		};
	}
	const pages: unknown[] = [];
	for (let i = 0; i < ops.length; i += page) {
		const slice = ops.slice(i, i + page);
		const out = applyOps(raw, slice);
		pages.push({
			at: i,
			applied: out.applied,
			fingerprintOps: slice.filter((o) => o.entity === 'recording_claim' && (o.payload as { kind?: string }).kind === 'fingerprint').length,
			fingerprintRecords: raw.prepare(`SELECT count(*) FROM sync_state WHERE map = 'claims' AND key LIKE '%:fingerprint:%'`).pluck().get(),
			records: raw.prepare(`SELECT count(*) FROM sync_state`).pluck().get(),
		});
	}
	raw.close();
	return { command: 'probe', runtime: P.runtime, pages };
}

export async function main(args: string[]): Promise<void> {
	const f = flags(args.slice(1));
	if (f['fixed'] === 'true') fixTheWorld();
	if (args[0] === 'probe') { P.log(JSON.stringify(probe(f), null, 1)); return; }
	if (args[0] !== 'join' && args[0] !== 'sync' && args[0] !== 'stream') throw new Error(`usage: join|sync|stream --db <file> … (got ${args.join(' ')})`);
	const result = args[0] === 'join' ? await syncAs(f, fakeAccount(f), 'join') : args[0] === 'sync' ? await syncAs(f, httpAccount(f), 'sync') : await stream(f);
	const text = JSON.stringify(result, null, 1);
	P.writeText(`${f['out']}/result.json`, text);
	P.log(text);
}
