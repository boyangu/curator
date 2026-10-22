// 'snapshot_storage': the master publishes, the server verifies and indexes
// (src/sync/publish-snapshot.ts), bootstrap hands the manifest to a client
// that can read Storage and a bodied snapshot to one that cannot, the sweep
// leaves a freshly published account alone, and pushes of source kinds from
// a non-master device are audited.

import { createHash, randomUUID } from 'node:crypto';
import {
	applyOps,
	createLibraryState,
	MASTER_DEVICE_SETTING,
	serializeLibraryState,
	SNAPSHOT_STORAGE_ENCODING,
	snapshotPartPath,
	type Op,
	type SnapshotManifest,
} from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestApp, errorReason, opsFor, sampleLibrary, uploadBlob, type TestApp } from '../test/harness.js';
import { decodeSnapshotBase64 } from '../snapshot/codec.js';
import { buildSnapshot, DEFAULT_DUE_OPTIONS, runDueSnapshots } from '../snapshot/job.js';
import { verifyPublishedSnapshot } from '../snapshot/verify.js';
import { pull } from './pull.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

type Signed = Awaited<ReturnType<TestApp['signIn']>>;
type Api = Signed['api'];

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

// Parts of the given sizes with made-up content: the server never reads
// the bytes, only the names and sizes Storage records. `shared` reuses
// another manifest's parts (content addressing: equal bytes, equal path).
function manifestOf(userId: string, sizes: number[], opts: { stateSha256?: string; shared?: SnapshotManifest['parts'] } = {}): SnapshotManifest {
	const seed = randomUUID();
	const parts = [
		...(opts.shared ?? []),
		...sizes.map((bytes, i) => {
			const h = sha(`${seed}:${i}`);
			return { path: snapshotPartPath(userId, h), bytes, sha256: h };
		}),
	];
	return {
		encoding: SNAPSHOT_STORAGE_ENCODING,
		parts,
		totalBytes: parts.reduce((n, p) => n + p.bytes, 0),
		sha256: sha(`body:${seed}`),
		stateSha256: opts.stateSha256 ?? sha(`state:${seed}`),
	};
}

async function upload(userId: string, m: SnapshotManifest, skip: ReadonlySet<string> = new Set()): Promise<void> {
	for (const p of m.parts) if (!skip.has(p.path)) await uploadBlob(app.pg, userId, p.path, p.bytes, 'snapshots');
}

// The account's master, stated by `as` (any device may state it).
function masterOp(as: string, master: string, at?: number): Op {
	return opsFor(as)('setting', 'set', MASTER_DEVICE_SETTING, { value: master }, at);
}

async function pushOps(api: Api, deviceId: string, ops: Op[]): Promise<number> {
	return (await api.sync.push.mutate({ deviceId, ops })).maxSeq;
}

// A master with a library: sample ops plus the master setting.
async function masterWithLibrary(n = 1): Promise<Signed & { head: number; ops: Op[] }> {
	const s = await app.signIn();
	const ops = [...sampleLibrary(s.deviceId, n), masterOp(s.deviceId, s.deviceId)];
	const head = await pushOps(s.api, s.deviceId, ops);
	return { ...s, head, ops };
}

// A second device of the same account, on its own session.
async function secondDevice(s: Signed, deviceId = `device-${randomUUID()}`): Promise<{ deviceId: string; api: Api }> {
	const api = app.client(await app.sign(s.userId, { sessionId: `session-${randomUUID()}` }));
	await api.account.registerDevice.mutate({ deviceId, name: 'Second', platform: 'darwin' });
	return { deviceId, api };
}

async function publish(s: { deviceId: string; api: Api }, snapshotSeq: number, manifest: SnapshotManifest) {
	return s.api.sync.publishSnapshot.mutate({ deviceId: s.deviceId, snapshotSeq, manifest });
}

async function events(userId: string, kind: string): Promise<{ device_id: string | null; detail: Record<string, unknown> }[]> {
	await app.audit.flush();
	const r = await app.pg.query<{ device_id: string | null; detail: Record<string, unknown> }>(
		`select device_id, detail from curator.audit_event where user_id = $1 and kind = $2 order by id`,
		[userId, kind],
	);
	return r.rows;
}

const rowsOf = async (userId: string) =>
	(
		await app.pg.query<{ seq: number; bodied: boolean; published_by: string | null }>(
			`select snapshot_seq::float8 as seq, body is not null as bodied, published_by from curator.library_snapshot where user_id = $1 order by snapshot_seq`,
			[userId],
		)
	).rows;

describe('sync.publishSnapshot', () => {
	it('indexes the master’s manifest and audits it', async () => {
		const m = await masterWithLibrary();
		const manifest = manifestOf(m.userId, [5000, 3000]);
		await upload(m.userId, manifest);
		const r = await publish(m, m.head, manifest);
		expect(r).toMatchObject({ status: 'stored', latestSeq: m.head, superseded: [] });
		expect(r.features).toContain('batches');
		const [row] = (
			await app.pg.query<{ storage: SnapshotManifest; state_sha256: string; published_by: string; body: unknown }>(
				`select storage, state_sha256, published_by, body from curator.library_snapshot where user_id = $1`,
				[m.userId],
			)
		).rows;
		expect(row).toEqual({ storage: manifest, state_sha256: manifest.stateSha256, published_by: m.deviceId, body: null });
		expect(await events(m.userId, 'snapshot_published')).toEqual([
			{ device_id: m.deviceId, detail: { snapshotSeq: m.head, bytes: 8000, parts: 2, pruned: 0, superseded: 0 } },
		]);
	});

	it('refuses a manifest whose paths or sizes do not add up (snapshot_part_invalid), before anything else', async () => {
		const m = await masterWithLibrary();
		const other = await app.signIn();
		const good = manifestOf(m.userId, [100, 200]);
		const cases: SnapshotManifest[] = [
			// Another user's prefix.
			manifestOf(other.userId, [100]),
			// A path that is not the part's own hash.
			{ ...good, parts: [{ ...good.parts[0]!, sha256: sha('something else') }, good.parts[1]!] },
			// The same part twice.
			{ ...good, parts: [good.parts[0]!, good.parts[0]!], totalBytes: 200 },
			// Sizes that do not add up.
			{ ...good, totalBytes: 301 },
		];
		for (const manifest of cases) expect(await errorReason(publish(m, m.head, manifest))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'snapshot_part_invalid' });
		// Upper-case hex is not a hash the protocol writes: the input schema refuses it.
		await expect(publish(m, m.head, { ...good, sha256: good.sha256.toUpperCase() })).rejects.toThrow();
		expect(await rowsOf(m.userId)).toEqual([]);
	});

	it('refuses every device but the master (not_master), LWW over the setting ops', async () => {
		// No master stated: nobody publishes.
		const none = await app.signIn();
		const head = await pushOps(none.api, none.deviceId, sampleLibrary(none.deviceId));
		const mNone = manifestOf(none.userId, [10]);
		await upload(none.userId, mNone);
		expect(await errorReason(publish(none, head, mNone))).toMatchObject({ code: 'FORBIDDEN', reason: 'not_master' });

		const m = await masterWithLibrary();
		const b = await secondDevice(m);
		const manifest = manifestOf(m.userId, [10]);
		await upload(m.userId, manifest);
		expect(await errorReason(publish(b, m.head, manifest))).toMatchObject({ reason: 'not_master' });
		// b states itself master with an older stamp: the earlier op still wins.
		await pushOps(b.api, b.deviceId, [masterOp(b.deviceId, b.deviceId, Date.now() - 10 * 3600_000)]);
		expect(await errorReason(publish(b, m.head, manifest))).toMatchObject({ reason: 'not_master' });
		// A later stamp moves it: now b publishes and m is refused.
		const moved = await pushOps(b.api, b.deviceId, [masterOp(b.deviceId, b.deviceId, Date.now())]);
		expect(await errorReason(publish(m, moved, manifest))).toMatchObject({ reason: 'not_master' });
		expect(await publish(b, moved, manifest)).toMatchObject({ status: 'stored', latestSeq: moved });
		// A cleared setting (a non-string value) states no master.
		const cleared = await pushOps(b.api, b.deviceId, [opsFor(b.deviceId)('setting', 'set', MASTER_DEVICE_SETTING, { value: null }, Date.now() + 1000)]);
		const again = manifestOf(m.userId, [11]);
		await upload(m.userId, again);
		expect(await errorReason(publish(b, cleared, again))).toMatchObject({ reason: 'not_master' });
	});

	it('refuses a seq above the visible head (snapshot_ahead), a batch’s fence included', async () => {
		const m = await masterWithLibrary();
		const manifest = manifestOf(m.userId, [10]);
		await upload(m.userId, manifest);
		expect(await errorReason(publish(m, m.head + 1, manifest))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'snapshot_ahead' });
		// A committing batch fenced the log below the head: the head past the
		// fence is not visible yet, so it cannot be published.
		const [batch] = (
			await app.pg.query<{ id: string }>(
				`insert into curator.library_op_batch (user_id, device_id, label, status) values ($1, $2, 'backfill', 'committing') returning id::text as id`,
				[m.userId, m.deviceId],
			)
		).rows;
		const fence = m.head - 3;
		await app.pg.query(`insert into curator.library_op_fence (user_id, batch_id, visible_through) values ($1, $2, $3)`, [m.userId, batch!.id, fence]);
		expect(await errorReason(publish(m, m.head, manifest))).toMatchObject({ reason: 'snapshot_ahead' });
		expect(await publish(m, fence, manifest)).toMatchObject({ status: 'stored', latestSeq: fence });
		await app.pg.query(`delete from curator.library_op_fence where user_id = $1`, [m.userId]);
		await app.pg.query(`update curator.library_op_batch set status = 'aborted' where id = $1`, [batch!.id]);
	});

	it('refuses parts Storage does not hold with the stated size (snapshot_part_missing)', async () => {
		const m = await masterWithLibrary();
		const manifest = manifestOf(m.userId, [100, 200]);
		await upload(m.userId, manifest, new Set([manifest.parts[1]!.path]));
		expect(await errorReason(publish(m, m.head, manifest))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'snapshot_part_missing' });
		// Uploaded, but with another size.
		await uploadBlob(app.pg, m.userId, manifest.parts[1]!.path, 199, 'snapshots');
		expect(await errorReason(publish(m, m.head, manifest))).toMatchObject({ reason: 'snapshot_part_missing' });
		// A part in the catalogue bucket under the same name does not count either.
		const elsewhere = manifestOf(m.userId, [50]);
		await app.pg.query(`insert into storage.objects (bucket_id, name, metadata) values ('catalogue', $1, '{"size": 50}')`, [elsewhere.parts[0]!.path]);
		expect(await errorReason(publish(m, m.head, elsewhere))).toMatchObject({ reason: 'snapshot_part_missing' });
		expect(await rowsOf(m.userId)).toEqual([]);
	});

	it('answers exists for the same seq and stale for an older one, writing nothing, and names the refused upload', async () => {
		const m = await masterWithLibrary();
		const first = manifestOf(m.userId, [100, 100]);
		await upload(m.userId, first);
		const older = m.head - 2;
		expect(await publish(m, m.head, first)).toMatchObject({ status: 'stored' });
		// The same manifest again (an answer lost): exists, nothing to delete.
		expect(await publish(m, m.head, first)).toEqual({ status: 'exists', latestSeq: m.head, superseded: [], features: expect.any(Array) });
		// Another build at the same seq sharing one part: only its own part is named.
		const rebuilt = manifestOf(m.userId, [70], { shared: [first.parts[0]!] });
		await upload(m.userId, rebuilt, new Set([first.parts[0]!.path]));
		expect(await publish(m, m.head, rebuilt)).toMatchObject({ status: 'exists', latestSeq: m.head, superseded: [rebuilt.parts[1]!.path] });
		const late = manifestOf(m.userId, [30]);
		await upload(m.userId, late);
		expect(await publish(m, older, late)).toMatchObject({ status: 'stale', latestSeq: m.head, superseded: [late.parts[0]!.path] });
		expect(await rowsOf(m.userId)).toEqual([{ seq: m.head, bodied: false, published_by: m.deviceId }]);
		expect(await events(m.userId, 'snapshot_published')).toHaveLength(1);
	});

	it('keeps three snapshots and always the newest bodied one; superseded is the pruned parts no kept row lists', async () => {
		const m = await masterWithLibrary();
		// The fold's snapshot: the fallback base.
		const built = await buildSnapshot(app.db, m.userId);
		expect(built.status).toBe('built');
		const bodiedSeq = m.head;
		const published: { seq: number; manifest: SnapshotManifest }[] = [];
		let prevParts: SnapshotManifest['parts'] = [];
		for (let i = 0; i < 4; i++) {
			const seq = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId).slice(0, 2));
			// Each shares its first part with the one before (an unchanged
			// leading stretch of the JSON).
			const manifest = manifestOf(m.userId, [100 + i, 50], { shared: prevParts.slice(0, 1) });
			await upload(m.userId, manifest, new Set(prevParts.map((p) => p.path)));
			const r = await publish(m, seq, manifest);
			expect(r.status).toBe('stored');
			published.push({ seq, manifest });
			prevParts = manifest.parts;
			if (i === 2) {
				// Four rows: three published, plus the bodied one at the bottom.
				expect(r.superseded).toEqual([]);
				expect((await rowsOf(m.userId)).map((x) => [x.seq, x.bodied])).toEqual([[bodiedSeq, true], ...published.map((p) => [p.seq, false])]);
			}
			if (i === 3) {
				// The first published one goes; its parts are named except the
				// one the second still lists.
				const firstParts = published[0]!.manifest.parts.map((p) => p.path);
				const stillListed = new Set(published.slice(1).flatMap((p) => p.manifest.parts.map((q) => q.path)));
				expect(r.superseded).toEqual(firstParts.filter((p) => !stillListed.has(p)).sort());
				expect(r.superseded.length).toBeGreaterThan(0);
				expect((await rowsOf(m.userId)).map((x) => [x.seq, x.bodied])).toEqual([[bodiedSeq, true], ...published.slice(1).map((p) => [p.seq, false])]);
			}
		}
		expect((await events(m.userId, 'snapshot_published')).at(-1)!.detail).toMatchObject({ pruned: 1 });
	});

	it('refuses a revoked device, and audits it as a write from one', async () => {
		const m = await masterWithLibrary();
		const manifest = manifestOf(m.userId, [10]);
		await upload(m.userId, manifest);
		await app.pg.query(`update curator.device set revoked_at = now() where user_id = $1 and device_id = $2`, [m.userId, m.deviceId]);
		expect(await errorReason(publish(m, m.head, manifest))).toMatchObject({ code: 'FORBIDDEN', reason: 'device_revoked' });
		expect(await events(m.userId, 'push_from_revoked_device')).toMatchObject([{ detail: { ops: 0 } }]);
	});

	it('keeps accounts apart: no publishing another’s parts, no reading another’s manifest', async () => {
		const a = await masterWithLibrary();
		const b = await masterWithLibrary();
		const aManifest = manifestOf(a.userId, [10]);
		await upload(a.userId, aManifest);
		expect(await publish(a, a.head, aManifest)).toMatchObject({ status: 'stored' });
		// b names a's parts: they are not b's paths.
		expect(await errorReason(publish(b, b.head, aManifest))).toMatchObject({ reason: 'snapshot_part_invalid' });
		// b cannot plant a part in a's prefix, nor see a's parts or rows.
		await expect(uploadBlob(app.pg, b.userId, snapshotPartPath(a.userId, sha('planted')), 10, 'snapshots')).rejects.toThrow(/row-level security/);
		const seen = await asUser(app.pg, b.userId, async (tx) => ({
			rows: (await tx.query(`select snapshot_seq from curator.library_snapshot where user_id = $1`, [a.userId])).rows,
			objects: (await tx.query(`select name from storage.objects where bucket_id = 'snapshots' and name like $1`, [`${a.userId}/%`])).rows,
		}));
		expect(seen).toEqual({ rows: [], objects: [] });
		// b's own paths, never uploaded, are simply missing.
		const bManifest = manifestOf(b.userId, [10]);
		expect(await errorReason(publish(b, b.head, bManifest))).toMatchObject({ reason: 'snapshot_part_missing' });
		// And b's bootstrap never sees a's manifest.
		expect((await b.api.sync.bootstrap.query({ deviceId: b.deviceId, storage: true })).storage).toBeUndefined();
	});

	it('reads the master in one probe of the partial index', async () => {
		const m = await masterWithLibrary();
		const plan = await asUser(app.pg, m.userId, async (tx) => {
			await tx.query('set local enable_seqscan = off');
			const r = await tx.query<{ 'QUERY PLAN': string }>(
				`explain select device_id from curator.library_op
				where user_id = (select auth.uid()) and entity = 'setting' and entity_id = 'library.master_device'
				order by client_ts desc, device_id collate "C" desc, op_id desc
				limit 1`,
			);
			return r.rows.map((x) => x['QUERY PLAN']).join('\n');
		});
		expect(plan).toMatch(/library_op_master_device/);
		expect(plan).not.toMatch(/Sort/);
	});
});

describe('bootstrap and the far-behind hint with published snapshots', () => {
	it('gives a Storage-capable client the manifest, and any other client the newest bodied snapshot', async () => {
		const m = await masterWithLibrary(2);
		// Published only: an older client gets the empty state, a newer one the manifest.
		const first = manifestOf(m.userId, [10]);
		await upload(m.userId, first);
		await publish(m, m.head, first);
		expect(await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true })).toEqual({
			snapshot: '',
			snapshotSeq: m.head,
			encoding: 'curator.library-state.v1+json+gzip+base64',
			storage: first,
		});
		const empty = await m.api.sync.bootstrap.query({ deviceId: m.deviceId });
		expect(empty.snapshotSeq).toBe(0);
		expect(serializeLibraryState(await decodeSnapshotBase64(empty.snapshot))).toBe(serializeLibraryState(createLibraryState()));

		// More ops, a server fold above it (bodied), then a newer publish.
		const mid = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId));
		await app.pg.query(`update curator.library_snapshot set created_at = now() - interval '8 days' where user_id = $1`, [m.userId]);
		expect(await buildSnapshot(app.db, m.userId)).toMatchObject({ status: 'built', snapshotSeq: mid, fromSeq: 0 });
		const top = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId).slice(0, 3));
		const second = manifestOf(m.userId, [20]);
		await upload(m.userId, second);
		await publish(m, top, second);

		expect((await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true })).storage).toEqual(second);
		// An older client: the bodied snapshot at `mid`, inline or chunked.
		const inline = await m.api.sync.bootstrap.query({ deviceId: m.deviceId });
		expect(inline).toMatchObject({ snapshotSeq: mid });
		expect(inline.storage).toBeUndefined();
		const chunked = await m.api.sync.bootstrap.query({ deviceId: m.deviceId, chunked: true });
		expect(chunked).toMatchObject({ snapshot: '', snapshotSeq: mid, chunked: { totalBytes: Buffer.from(inline.snapshot, 'base64').length } });
		// A Storage client asking chunked still gets the manifest (it is the newest).
		expect(await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true, chunked: true })).toMatchObject({ snapshotSeq: top, storage: second });
		// snapshotChunk serves bodied rows only.
		expect(await errorReason(m.api.sync.snapshotChunk.query({ deviceId: m.deviceId, snapshotSeq: top, offset: 0, length: 10 }))).toMatchObject({ reason: 'snapshot_gone' });
		expect((await m.api.sync.snapshotChunk.query({ deviceId: m.deviceId, snapshotSeq: mid, offset: 0, length: 10 })).data.length).toBeGreaterThan(0);
		await app.audit.flush();
		const served = await app.pg.query<{ detail: Record<string, unknown> }>(
			`select detail from curator.audit_event where user_id = $1 and kind = 'bootstrap_served' and (detail ->> 'storage')::boolean order by id desc limit 1`,
			[m.userId],
		);
		expect(served.rows[0]!.detail).toMatchObject({ snapshotSeq: top, bytes: 20, storage: true });
	});

	it('names a bodied snapshot in the far-behind hint, so an older client is never sent to a seq it cannot load', async () => {
		const m = await masterWithLibrary();
		const caller = { sessionId: null };
		const opts = { farBehindOps: 3, farBehindMs: 1e15 };
		// Only a published snapshot: no hint (nothing every client can load).
		const pub = manifestOf(m.userId, [10]);
		await upload(m.userId, pub);
		await publish(m, m.head, pub);
		expect((await pull(app.db, m.userId, caller, { afterSeq: 0 }, opts)).result.snapshotSeq).toBeUndefined();

		// A bodied snapshot above it (the master went quiet, the fold ran), then
		// a newer publish far above both.
		const mid = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId));
		await app.pg.query(`update curator.library_snapshot set created_at = now() - interval '8 days' where user_id = $1`, [m.userId]);
		expect((await buildSnapshot(app.db, m.userId)).status).toBe('built');
		const top = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId));
		const newer = manifestOf(m.userId, [10]);
		await upload(m.userId, newer);
		await publish(m, top, newer);

		const hint = (await pull(app.db, m.userId, caller, { afterSeq: 0 }, opts)).result.snapshotSeq;
		expect(hint).toBe(mid);
		// The older client bootstraps to exactly that seq...
		const boot = await bootstrapAs(m, false);
		expect(boot.snapshotSeq).toBe(hint);
		// ...and pulling from it is not told to bootstrap again, however far
		// the published snapshot is ahead.
		expect((await pull(app.db, m.userId, caller, { afterSeq: boot.snapshotSeq }, opts)).result.snapshotSeq).toBeUndefined();
		// A Storage client lands at or past the hint.
		expect((await bootstrapAs(m, true)).snapshotSeq).toBe(top);
	});
});

async function bootstrapAs(s: Signed, storage: boolean) {
	return s.api.sync.bootstrap.query({ deviceId: s.deviceId, ...(storage ? { storage: true as const } : {}) });
}

describe('the snapshot sweep with published snapshots', () => {
	const opts = { ...DEFAULT_DUE_OPTIONS, minOps: 1 };
	const mine = (r: Awaited<ReturnType<typeof runDueSnapshots>>, id: string) => r.filter((x) => x.userId === id);

	it('skips an account whose master published within a week, then folds it from the bodied base', async () => {
		const m = await masterWithLibrary();
		const built = await buildSnapshot(app.db, m.userId);
		expect(built.status).toBe('built');
		const bodiedSeq = m.head;
		const mid = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId));
		const manifest = manifestOf(m.userId, [10]);
		await upload(m.userId, manifest);
		await publish(m, mid, manifest);
		const more = sampleLibrary(m.deviceId).slice(0, 5);
		const head = await pushOps(m.api, m.deviceId, more);
		// Worth a snapshot by every other rule: new ops, a quiet log, an old fold.
		await app.pg.query(`update curator.library_op set received_at = now() - interval '2 days' where user_id = $1`, [m.userId]);
		await app.pg.query(`update curator.library_snapshot set created_at = now() - interval '2 days' where user_id = $1 and body is not null`, [m.userId]);
		expect(mine(await runDueSnapshots(app.db, app.deps.log, opts), m.userId)).toEqual([]);

		// The master went quiet: a week-old publish no longer holds the fold back.
		await app.pg.query(`update curator.library_snapshot set created_at = now() - interval '8 days' where user_id = $1 and storage is not null`, [m.userId]);
		const [r] = mine(await runDueSnapshots(app.db, app.deps.log, opts), m.userId);
		expect(r).toMatchObject({ status: 'built', fromSeq: bodiedSeq, snapshotSeq: head });
		// The fold equals every op, and the published row was left for its master to prune.
		const all = (await app.pg.query<{ n: number }>(`select count(*)::int as n from curator.library_op where user_id = $1`, [m.userId])).rows[0]!.n;
		expect(r!.status === 'built' && r!.opsFolded).toBe(all - (m.ops.length));
		const state = await decodeSnapshotBase64((await bootstrapAs(m, false)).snapshot);
		const direct = await foldAllOf(m.userId);
		expect(serializeLibraryState(state)).toBe(serializeLibraryState(direct));
		expect((await rowsOf(m.userId)).map((x) => [x.seq, x.bodied])).toEqual([
			[bodiedSeq, true],
			[mid, false],
			[head, true],
		]);
		// Nothing new: up to date.
		expect(await buildSnapshot(app.db, m.userId)).toEqual({ userId: m.userId, status: 'up_to_date', snapshotSeq: head });
	});

	it('treats a published snapshot at the head as up to date for a direct build', async () => {
		const m = await masterWithLibrary();
		const manifest = manifestOf(m.userId, [10]);
		await upload(m.userId, manifest);
		await publish(m, m.head, manifest);
		expect(await buildSnapshot(app.db, m.userId)).toEqual({ userId: m.userId, status: 'up_to_date', snapshotSeq: m.head });
	});

	it('the fold’s retention prunes bodied rows only', async () => {
		const m = await masterWithLibrary();
		const seqs: number[] = [];
		for (let i = 0; i < 3; i++) {
			const seq = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId).slice(0, 2));
			const manifest = manifestOf(m.userId, [10 + i]);
			await upload(m.userId, manifest);
			await publish(m, seq, manifest);
			seqs.push(seq);
		}
		const head = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId).slice(0, 2));
		expect(await buildSnapshot(app.db, m.userId, { pageSize: 1000, keep: 2 })).toMatchObject({ status: 'built', fromSeq: 0, snapshotSeq: head });
		expect((await rowsOf(m.userId)).map((x) => [x.seq, x.bodied])).toEqual([...seqs.map((s) => [s, false]), [head, true]]);
	});
});

async function foldAllOf(userId: string) {
	const rows = await app.pg.query<{ op: Op }>(
		`select jsonb_build_object('op_id', op_id::text, 'device_id', device_id, 'client_ts', client_ts, 'schema_version', schema_version,
			'entity', entity, 'entity_id', entity_id, 'kind', kind, 'payload', payload) as op
		from curator.library_op where user_id = $1 order by seq`,
		[userId],
	);
	return applyOps(createLibraryState(), rows.rows.map((r) => r.op)).state;
}

describe('the verifier', () => {
	it('matches a published hash of the state the log folds to, and catches one that is not', async () => {
		const m = await masterWithLibrary(2);
		expect(await verifyPublishedSnapshot(app.db, m.userId)).toEqual({ userId: m.userId, status: 'no_published_snapshot' });
		// A bodied base below, so the fold starts from it.
		expect((await buildSnapshot(app.db, m.userId)).status).toBe('built');
		const top = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId));
		const truth = createHash('sha256').update(serializeLibraryState(await foldAllOf(m.userId)), 'utf8').digest('hex');
		const good = manifestOf(m.userId, [10], { stateSha256: truth });
		await upload(m.userId, good);
		await publish(m, top, good);
		expect(await verifyPublishedSnapshot(app.db, m.userId, 7)).toMatchObject({
			status: 'match',
			snapshotSeq: top,
			baseSeq: m.head,
			publishedBy: m.deviceId,
			stateSha256: truth,
			foldSha256: truth,
		});

		const after = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId).slice(0, 2));
		const bad = manifestOf(m.userId, [10], { stateSha256: truth });
		await upload(m.userId, bad);
		await publish(m, after, bad);
		expect(await verifyPublishedSnapshot(app.db, m.userId)).toMatchObject({ status: 'mismatch', snapshotSeq: after, stateSha256: truth });
	});
});

describe('source ops from a device that is not the master', () => {
	const attrs = {
		source: 'local' as const, bpm: 122.5, key_camelot: '8A', key_source: 'rekordbox' as const, explicit: false,
		mbid: null, copyright: null, play_count: 79, provider_refs: [], artist_names: ['Bonobo'],
	};
	const meta = { source: 'local' as const, title: 'Lilac', artists: [{ name: 'Bonobo' }], album_title: null, duration_sec: 312, isrc: null, release_date: null, label: null, genre: null, cover_url: null };

	it('are audited per call with counts by kind, and the master’s are not', async () => {
		const m = await masterWithLibrary();
		const b = await secondDevice(m);
		const ob = opsFor(b.deviceId);
		await pushOps(b.api, b.deviceId, [
			ob('library_track', 'set-attrs', randomUUID(), attrs),
			ob('library_track', 'set-attrs', randomUUID(), attrs),
			ob('library_track', 'set-meta', randomUUID(), meta),
			ob('tag', 'create', randomUUID(), { name: 'not a source kind', kind: 'user' }),
		]);
		expect(await events(m.userId, 'source_from_non_master')).toEqual([
			{ device_id: b.deviceId, detail: { procedure: 'sync.push', master: m.deviceId, byKind: { 'library_track.set-attrs': 2, 'library_track.set-meta': 1 } } },
		]);
		// The ops were kept: audit only.
		const kept = await app.pg.query<{ n: number }>(`select count(*)::int as n from curator.library_op where user_id = $1 and device_id = $2`, [m.userId, b.deviceId]);
		expect(kept.rows[0]!.n).toBe(4);

		const om = opsFor(m.deviceId);
		await pushOps(m.api, m.deviceId, [om('library_track', 'set-meta', randomUUID(), meta), om('library_track', 'set-attrs', randomUUID(), attrs)]);
		// A non-source push from b: no probe, no event.
		await pushOps(b.api, b.deviceId, [ob('tag', 'create', randomUUID(), { name: 'x', kind: 'user' })]);
		expect(await events(m.userId, 'source_from_non_master')).toHaveLength(1);

		// batchPush too.
		const { batchId } = await b.api.sync.batchBegin.mutate({ deviceId: b.deviceId, label: 'backfill' });
		await b.api.sync.batchPush.mutate({ deviceId: b.deviceId, batchId, ops: [ob('album', 'set-meta', 'spotify:al1', { album_type: 'album', total_tracks: 12, release_date: '2022', label: 'L', upc: '1', cover_url: null, artists: ['A'], various: false })] });
		expect((await events(m.userId, 'source_from_non_master')).at(-1)).toEqual({
			device_id: b.deviceId,
			detail: { procedure: 'sync.batchPush', master: m.deviceId, byKind: { 'album.set-meta': 1 } },
		});
		await b.api.sync.batchAbort.mutate({ deviceId: b.deviceId, batchId });
	});

	it('are not audited while the account states no master, or when the call itself makes the caller master', async () => {
		const s = await app.signIn();
		const op = opsFor(s.deviceId);
		await pushOps(s.api, s.deviceId, [op('library_track', 'set-meta', randomUUID(), meta)]);
		// The first device's initial push states itself master alongside its meta.
		const b = await secondDevice(s);
		const ob = opsFor(b.deviceId);
		await pushOps(b.api, b.deviceId, [masterOp(b.deviceId, b.deviceId), ob('library_track', 'set-attrs', randomUUID(), attrs)]);
		// A batch that carries the master setting with its meta counts it too.
		const c = await app.signIn();
		const oc = opsFor(c.deviceId);
		const { batchId } = await c.api.sync.batchBegin.mutate({ deviceId: c.deviceId, label: 'initial-push' });
		await c.api.sync.batchPush.mutate({ deviceId: c.deviceId, batchId, ops: [masterOp(c.deviceId, c.deviceId), oc('library_track', 'set-meta', randomUUID(), meta)] });
		expect(await events(s.userId, 'source_from_non_master')).toEqual([]);
		expect(await events(c.userId, 'source_from_non_master')).toEqual([]);
		await c.api.sync.batchAbort.mutate({ deviceId: c.deviceId, batchId });
	});
});
