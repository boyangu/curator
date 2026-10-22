// 'snapshot_storage': the master publishes, the server verifies and indexes
// (src/sync/publish-snapshot.ts), retention keeps the newest three, bootstrap
// hands the manifest to a client that can read Storage, the far-behind hint
// names the newest snapshot, and pushes of source kinds from a non-master
// device are audited.

import { randomUUID } from 'node:crypto';
import { MASTER_DEVICE_SETTING, snapshotPartPath, type Op, type SnapshotManifest } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestApp, errorReason, masterOp, opsFor, sampleLibrary, storageManifest, uploadBlob, type TestApp } from '../test/harness.js';
import { pull } from './pull.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

type Signed = Awaited<ReturnType<TestApp['signIn']>>;
type Api = Signed['api'];

const manifestOf = storageManifest;

async function upload(userId: string, m: SnapshotManifest, skip: ReadonlySet<string> = new Set()): Promise<void> {
	for (const p of m.parts) if (!skip.has(p.path)) await uploadBlob(app.pg, userId, p.path, p.bytes, 'snapshots');
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
		await app.pg.query<{ seq: number; published_by: string }>(
			`select snapshot_seq::float8 as seq, published_by from curator.library_snapshot where user_id = $1 order by snapshot_seq`,
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
			await app.pg.query<{ storage: SnapshotManifest; state_sha256: string; published_by: string }>(
				`select storage, state_sha256, published_by from curator.library_snapshot where user_id = $1`,
				[m.userId],
			)
		).rows;
		expect(row).toEqual({ storage: manifest, state_sha256: manifest.stateSha256, published_by: m.deviceId });
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
			{ ...good, parts: [{ ...good.parts[0]!, sha256: 'b'.repeat(64) }, good.parts[1]!] },
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
		expect(await rowsOf(m.userId)).toEqual([{ seq: m.head, published_by: m.deviceId }]);
		expect(await events(m.userId, 'snapshot_published')).toHaveLength(1);
	});

	it('keeps the newest three snapshots; superseded is the pruned parts no kept row lists', async () => {
		const m = await masterWithLibrary();
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
				expect(r.superseded).toEqual([]);
				expect((await rowsOf(m.userId)).map((x) => x.seq)).toEqual(published.map((p) => p.seq));
			}
			if (i === 3) {
				// The first published one goes; its parts are named except the
				// one the second still lists.
				const firstParts = published[0]!.manifest.parts.map((p) => p.path);
				const stillListed = new Set(published.slice(1).flatMap((p) => p.manifest.parts.map((q) => q.path)));
				expect(r.superseded).toEqual(firstParts.filter((p) => !stillListed.has(p)).sort());
				expect(r.superseded.length).toBeGreaterThan(0);
				expect((await rowsOf(m.userId)).map((x) => x.seq)).toEqual(published.slice(1).map((p) => p.seq));
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
		await expect(uploadBlob(app.pg, b.userId, snapshotPartPath(a.userId, 'c'.repeat(64)), 10, 'snapshots')).rejects.toThrow(/row-level security/);
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
	it('gives a Storage-capable client the newest manifest, and refuses any other client (update_required)', async () => {
		const m = await masterWithLibrary(2);
		const first = manifestOf(m.userId, [10]);
		await upload(m.userId, first);
		await publish(m, m.head, first);
		expect(await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true })).toEqual({ storage: first, snapshotSeq: m.head, baseSeq: 0 });
		expect(await errorReason(m.api.sync.bootstrap.query({ deviceId: m.deviceId }))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'update_required' });
		expect(await errorReason(m.api.sync.bootstrap.query())).toMatchObject({ reason: 'update_required' });

		// A newer publish: the newest manifest.
		const top = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId).slice(0, 3));
		const second = manifestOf(m.userId, [20]);
		await upload(m.userId, second);
		await publish(m, top, second);
		expect(await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true })).toEqual({ storage: second, snapshotSeq: top, baseSeq: 0 });
		await app.audit.flush();
		const served = await app.pg.query<{ detail: Record<string, unknown> }>(
			`select detail from curator.audit_event where user_id = $1 and kind = 'bootstrap_served' order by id desc limit 1`,
			[m.userId],
		);
		expect(served.rows[0]!.detail).toEqual({ snapshotSeq: top, baseSeq: 0, bytes: 20, storage: true });
	});

	it('names the newest snapshot in the far-behind hint and carries its digest as `published`', async () => {
		const m = await masterWithLibrary();
		const caller = { sessionId: null };
		const opts = { farBehindOps: 3, farBehindMs: 1e15 };
		// No snapshot: no hint, nothing published.
		const none = (await pull(app.db, m.userId, caller, { afterSeq: 0 }, opts)).result;
		expect(none.snapshotSeq).toBeUndefined();
		expect(none.published).toBeUndefined();

		const pub = manifestOf(m.userId, [10]);
		await upload(m.userId, pub);
		await publish(m, m.head, pub);
		const hinted = (await pull(app.db, m.userId, caller, { afterSeq: 0 }, opts)).result;
		expect(hinted.snapshotSeq).toBe(m.head);
		expect(hinted.published).toEqual({ seq: m.head, stateSha256: pub.stateSha256 });

		// A newer publish far above: the hint moves to it, and a device that
		// bootstrapped to the older one is sent on (it can load the newer).
		const top = await pushOps(m.api, m.deviceId, sampleLibrary(m.deviceId));
		const newer = manifestOf(m.userId, [10]);
		await upload(m.userId, newer);
		await publish(m, top, newer);
		const again = (await pull(app.db, m.userId, caller, { afterSeq: m.head }, opts)).result;
		expect(again.snapshotSeq).toBe(top);
		expect(again.published).toEqual({ seq: top, stateSha256: newer.stateSha256 });
		// A bootstrap lands exactly on the hinted seq, and pulling from there
		// is not told again: `published` still rides along for the digest check.
		const boot = await m.api.sync.bootstrap.query({ deviceId: m.deviceId, storage: true });
		expect(boot.snapshotSeq).toBe(top);
		const at = (await pull(app.db, m.userId, caller, { afterSeq: boot.snapshotSeq }, opts)).result;
		expect(at.snapshotSeq).toBeUndefined();
		expect(at.published).toEqual({ seq: top, stateSha256: newer.stateSha256 });
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
