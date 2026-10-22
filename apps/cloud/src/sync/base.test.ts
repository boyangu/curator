// The base model (sql/0009_library_base.sql, src/sync/base.ts,
// src/sync/compact.ts): a cursor below the base is sent to bootstrap and
// never paged across the hole; bootstrap answers the base; compaction
// deletes exactly what the base covers, keeps the master-device ops, stops
// at its limit and refuses a base above the oldest snapshot; the heads a
// push, a batch's fence and a publish answer never fall below the base; and
// none of it crosses accounts.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestApp, errorReason, insertSnapshot, masterOp, opsFor, sampleLibrary, storageManifest, uploadBlob, type TestApp } from '../test/harness.js';
import { compactDueUsers, compactOnce, compactUser, setBaseSeq } from './compact.js';
import { pull } from './pull.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp({ pull: { farBehindOps: 1e9, farBehindMs: 1e15 } });
});
afterAll(() => app.db.close());

type Signed = Awaited<ReturnType<TestApp['signIn']>>;

const DAY = 24 * 3600 * 1000;

async function opCount(userId: string): Promise<number> {
	return (await app.pg.query<{ n: number }>(`select count(*)::int as n from curator.library_op where user_id = $1`, [userId])).rows[0]!.n;
}

async function seqsOf(userId: string): Promise<number[]> {
	return (await app.pg.query<{ seq: number }>(`select seq::float8 as seq from curator.library_op where user_id = $1 order by seq`, [userId])).rows.map((r) => r.seq);
}

async function baseRow(userId: string): Promise<{ base: number; compacted: boolean } | undefined> {
	return (await app.pg.query<{ base: number; compacted: boolean }>(`select base_seq::float8 as base, compacted_at is not null as compacted from curator.library_base where user_id = $1`, [userId])).rows[0];
}

// A library of `n` sample sets, pushed as two pushes so the seqs straddle a
// point: returns every seq and the head.
async function library(s: Signed, n = 2): Promise<{ seqs: number[]; head: number }> {
	const ops = sampleLibrary(s.deviceId, n);
	const cut = Math.floor(ops.length / 2);
	await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: ops.slice(0, cut) });
	const head = (await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: ops.slice(cut) })).maxSeq;
	return { seqs: await seqsOf(s.userId), head };
}

describe('pull against the base', () => {
	it('sends a cursor below the base to the newest snapshot with no page and the cursor unmoved; a cursor at or above it pages as usual', async () => {
		const s = await app.signIn();
		const { seqs, head } = await library(s);
		const mid = seqs[Math.floor(seqs.length / 2)]!;
		const older = await insertSnapshot(app.pg, s.userId, mid);
		const newest = await insertSnapshot(app.pg, s.userId, head);
		await setBaseSeq(app.db, s.userId, mid);

		for (const afterSeq of [0, mid - 1]) {
			const r = await s.api.sync.pull.query({ afterSeq, deviceId: s.deviceId });
			expect(r).toEqual({ ops: [], nextSeq: afterSeq, snapshotSeq: head, published: { seq: head, stateSha256: newest.stateSha256 }, features: expect.any(Array) });
			// The own-op skip changes nothing: still no page across the hole.
			const skip = await s.api.sync.pull.query({ afterSeq, deviceId: s.deviceId, ownThroughSeq: afterSeq });
			expect(skip).toMatchObject({ ops: [], nextSeq: afterSeq, snapshotSeq: head });
		}
		// At the base: the ops above it, and no hint (the far-behind rule is
		// off in this app, so only the base can raise one).
		const at = await s.api.sync.pull.query({ afterSeq: mid, deviceId: s.deviceId });
		expect(at.ops.map((o) => o.seq)).toEqual(seqs.filter((q) => q > mid));
		expect(at.snapshotSeq).toBeUndefined();
		expect(at.published).toEqual({ seq: head, stateSha256: newest.stateSha256 });
		expect(older.stateSha256).not.toBe(newest.stateSha256);
	});

	it('the far-behind hint names the newest snapshot, whichever one the base rests on', async () => {
		const small = await createTestApp({ pull: { farBehindOps: 2, farBehindMs: 1e15 } });
		try {
			const s = await small.signIn();
			const ops = sampleLibrary(s.deviceId);
			await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: ops.slice(0, 10) });
			const mid = (await s.api.sync.pull.query({ afterSeq: 0 })).nextSeq;
			const head = (await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: ops.slice(10) })).maxSeq;
			await insertSnapshot(small.pg, s.userId, mid);
			const newest = await insertSnapshot(small.pg, s.userId, head);
			await setBaseSeq(small.db, s.userId, mid);
			// Far behind, above the base: the page comes, the hint is the newest.
			const r = await s.api.sync.pull.query({ afterSeq: mid, deviceId: s.deviceId });
			expect(r.ops.length).toBeGreaterThan(2);
			expect(r.snapshotSeq).toBe(head);
			expect(r.published).toEqual({ seq: head, stateSha256: newest.stateSha256 });
		} finally {
			await small.db.close();
		}
	});
});

describe('bootstrap against the base', () => {
	it('answers the newest manifest with the base, the empty state only for an account with no base, and refuses a client that cannot read Storage', async () => {
		const s = await app.signIn();
		expect(await s.api.sync.bootstrap.query({ deviceId: s.deviceId, storage: true })).toEqual({ snapshotSeq: 0, baseSeq: 0 });
		expect(await errorReason(s.api.sync.bootstrap.query({ deviceId: s.deviceId }))).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'update_required' });
		const { seqs, head } = await library(s);
		const mid = seqs[3]!;
		await insertSnapshot(app.pg, s.userId, mid);
		const newest = await insertSnapshot(app.pg, s.userId, head);
		await setBaseSeq(app.db, s.userId, mid);
		expect(await s.api.sync.bootstrap.query({ deviceId: s.deviceId, storage: true })).toEqual({ storage: newest, snapshotSeq: head, baseSeq: mid });
	});

	it('treats a base with no snapshot as a server fault: internal error, audited, never the empty state', async () => {
		const s = await app.signIn();
		const { head } = await library(s);
		await insertSnapshot(app.pg, s.userId, head);
		await setBaseSeq(app.db, s.userId, head);
		// The invariant broken behind the API's back.
		await app.pg.query(`delete from curator.library_snapshot where user_id = $1`, [s.userId]);
		expect(await errorReason(s.api.sync.bootstrap.query({ deviceId: s.deviceId, storage: true }))).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', reason: null });
		expect(await errorReason(s.api.sync.pull.query({ afterSeq: 0, deviceId: s.deviceId }))).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
		// A cursor at the base still pages: nothing below it is asked for.
		await expect(s.api.sync.pull.query({ afterSeq: head, deviceId: s.deviceId })).resolves.toMatchObject({ ops: [] });
		await app.audit.flush();
		const audited = await app.pg.query<{ detail: Record<string, unknown> }>(
			`select detail from curator.audit_event where user_id = $1 and kind = 'base_without_snapshot' order by id`,
			[s.userId],
		);
		expect(audited.rows.map((r) => r.detail)).toEqual([
			{ procedure: 'sync.bootstrap', baseSeq: head },
			{ procedure: 'sync.pull', baseSeq: head },
		]);
	});
});

describe('set_base_seq and compact_ops', () => {
	it('refuses a base above the oldest kept snapshot, or any base at all without a snapshot; never lowers it', async () => {
		const s = await app.signIn();
		const { seqs, head } = await library(s);
		await expect(setBaseSeq(app.db, s.userId, 1)).rejects.toThrow(/above the oldest kept snapshot \(none\)/);
		expect(await setBaseSeq(app.db, s.userId, 0)).toBe(0);
		const mid = seqs[4]!;
		await insertSnapshot(app.pg, s.userId, mid);
		await insertSnapshot(app.pg, s.userId, head);
		await expect(setBaseSeq(app.db, s.userId, mid + 1)).rejects.toThrow(/above the oldest kept snapshot/);
		expect(await setBaseSeq(app.db, s.userId, mid)).toBe(mid);
		// Lower: stays. Same: stays.
		expect(await setBaseSeq(app.db, s.userId, seqs[1]!)).toBe(mid);
		expect(await setBaseSeq(app.db, s.userId, mid)).toBe(mid);
		expect(await baseRow(s.userId)).toEqual({ base: mid, compacted: false });
	});

	it('deletes exactly the ops at or below the base, in chunks, keeping the master-device setting ops', async () => {
		const s = await app.signIn();
		// The master setting first, so it sits below the base; a later one
		// above it, both kept.
		await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [masterOp(s.deviceId, s.deviceId, Date.now() - 2 * DAY)] });
		const { seqs, head } = await library(s, 2);
		const masterSeq = seqs[0]!;
		const mid = seqs[Math.floor(seqs.length / 2)]!;
		const laterMaster = (await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [masterOp(s.deviceId, s.deviceId, Date.now() - DAY)] })).maxSeq;
		await insertSnapshot(app.pg, s.userId, mid);
		await insertSnapshot(app.pg, s.userId, laterMaster);

		// Nothing happens below a base of 0.
		expect(await compactOnce(app.db, s.userId, 10)).toBe(0);
		expect(await opCount(s.userId)).toBe(seqs.length + 1);

		await setBaseSeq(app.db, s.userId, mid);
		const below = seqs.filter((q) => q <= mid && q !== masterSeq);
		// Chunked: the first call takes the limit, lowest seqs first.
		expect(await compactOnce(app.db, s.userId, 5)).toBe(5);
		expect(await seqsOf(s.userId)).toEqual([masterSeq, ...seqs.filter((q) => q > mid || below.slice(5).includes(q)), laterMaster]);
		expect(await baseRow(s.userId)).toEqual({ base: mid, compacted: false });
		// The rest, then nothing: compacted_at set.
		const r = await compactUser(app.db, s.userId, mid, { limit: 5 });
		expect(r).toMatchObject({ userId: s.userId, through: mid, baseSeq: mid, deleted: below.length - 5 });
		expect(await seqsOf(s.userId)).toEqual([masterSeq, ...seqs.filter((q) => q > mid), laterMaster]);
		expect(await baseRow(s.userId)).toEqual({ base: mid, compacted: true });
		expect(await compactOnce(app.db, s.userId, 5000)).toBe(0);
		// Above the base, untouched: the account's head is still its head.
		expect((await s.api.sync.pull.query({ afterSeq: mid, deviceId: s.deviceId })).ops.map((o) => o.seq)).toEqual([...seqs.filter((q) => q > mid), laterMaster]);
		expect(head).toBeLessThan(laterMaster);
		// The master is still readable from the log: the master publishes.
		const manifest = storageManifest(s.userId, [10]);
		for (const p of manifest.parts) await uploadBlob(app.pg, s.userId, p.path, p.bytes, 'snapshots');
		expect(await s.api.sync.publishSnapshot.mutate({ deviceId: s.deviceId, snapshotSeq: laterMaster, manifest })).toMatchObject({ status: 'exists' });
	});

	it('rebases: every op below the base gone, the heads stay the account’s, a publish at or below the base is stale', async () => {
		const s = await app.signIn();
		await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [masterOp(s.deviceId, s.deviceId)] });
		const { head } = await library(s);
		await insertSnapshot(app.pg, s.userId, head);
		const r = await compactUser(app.db, s.userId, head);
		expect(r.deleted).toBeGreaterThan(0);
		// Only the master-device op is left.
		expect(await opCount(s.userId)).toBe(1);

		// Push: maxSeq is the account's head, not the single op's seq; the
		// new op lands above the base.
		const edit = opsFor(s.deviceId)('tag', 'create', randomUUID(), { name: 'after the rebase', kind: 'user' });
		const pushed = await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [edit] });
		expect(pushed.batchMaxSeq).toBeGreaterThan(head);
		expect(pushed.maxSeq).toBe(pushed.batchMaxSeq);
		// A pull from the base gets just it; from below, the hint.
		expect((await s.api.sync.pull.query({ afterSeq: head, deviceId: s.deviceId })).ops.map((o) => o.op_id)).toEqual([edit.op_id]);
		expect((await s.api.sync.pull.query({ afterSeq: head - 1, deviceId: s.deviceId })).snapshotSeq).toBe(head);

		// Publish: at the base, stale (exists is the snapshot at that seq);
		// below it, stale; at the head, stored; above, ahead.
		const manifest = storageManifest(s.userId, [10]);
		for (const p of manifest.parts) await uploadBlob(app.pg, s.userId, p.path, p.bytes, 'snapshots');
		const publish = (seq: number) => s.api.sync.publishSnapshot.mutate({ deviceId: s.deviceId, snapshotSeq: seq, manifest });
		expect(await publish(head - 1)).toMatchObject({ status: 'stale', latestSeq: head });
		expect(await publish(head)).toMatchObject({ status: 'exists', latestSeq: head });
		expect(await errorReason(publish(pushed.maxSeq + 1))).toMatchObject({ reason: 'snapshot_ahead' });
		expect(await publish(pushed.maxSeq)).toMatchObject({ status: 'stored', latestSeq: pushed.maxSeq });
		// Even with the one snapshot gone (the invariant broken by hand), a
		// publish below the base is stale, never stored.
		await app.pg.query(`delete from curator.library_snapshot where user_id = $1 and snapshot_seq = $2`, [s.userId, head]);
		await app.pg.query(`delete from curator.library_snapshot where user_id = $1 and snapshot_seq = $2`, [s.userId, pushed.maxSeq]);
		expect(await publish(head - 1)).toMatchObject({ status: 'stale', latestSeq: 0 });
	});

	it('a batch’s fence is raised at the base when the log holds nothing above it', async () => {
		const s = await app.signIn();
		await s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [masterOp(s.deviceId, s.deviceId)] });
		const { head } = await library(s);
		await insertSnapshot(app.pg, s.userId, head);
		await compactUser(app.db, s.userId, head);
		const batch = sampleLibrary(s.deviceId, 1);
		const { batchId } = await s.api.sync.batchBegin.mutate({ deviceId: s.deviceId, label: 'backfill' });
		await s.api.sync.batchPush.mutate({ deviceId: s.deviceId, batchId, ops: batch });
		const res = await s.api.sync.batchCommit.mutate({ deviceId: s.deviceId, batchId });
		expect(res.status).toBe('committed');
		const [row] = (await app.pg.query<{ fence: number }>(`select fence_seq::float8 as fence from curator.library_op_batch where id = $1`, [batchId])).rows;
		expect(row!.fence).toBe(head);
		expect(res.committedSeq).toBeGreaterThan(head);
		expect((await s.api.sync.pull.query({ afterSeq: head, deviceId: s.deviceId })).ops).toHaveLength(batch.length);
	});
});

describe('the compaction sweep', () => {
	it('compacts accounts whose oldest kept snapshot is older than the age and above their base, one at a time, and audits each', async () => {
		const due = await app.signIn();
		const fresh = await app.signIn();
		const done = await app.signIn();
		const none = await app.signIn();
		const libs = { due: await library(due), fresh: await library(fresh), done: await library(done), none: await library(none) };
		// due: an 8-day-old snapshot at mid, a fresh one at the head.
		const dueMid = libs.due.seqs[5]!;
		await insertSnapshot(app.pg, due.userId, dueMid, { ageMs: 8 * DAY });
		await insertSnapshot(app.pg, due.userId, libs.due.head);
		// fresh: a 6-day-old snapshot: not yet.
		await insertSnapshot(app.pg, fresh.userId, libs.fresh.head, { ageMs: 6 * DAY });
		// done: old, but already the base.
		await insertSnapshot(app.pg, done.userId, libs.done.head, { ageMs: 30 * DAY });
		await compactUser(app.db, done.userId, libs.done.head);
		const doneCount = await opCount(done.userId);
		// none: no snapshot at all.

		const listed = await app.db.query<{ user_id: string; through: number }>(`select user_id::text as user_id, through::float8 as through from curator.users_due_for_compaction(interval '7 days')`);
		const mine = listed.filter((r) => [due.userId, fresh.userId, done.userId, none.userId].includes(r.user_id));
		expect(mine).toEqual([{ user_id: due.userId, through: dueMid }]);

		const results = (await compactDueUsers({ db: app.db, log: app.deps.log, audit: app.audit, options: { limit: 3, minAgeMs: 7 * DAY } })).filter((r) => r.userId === due.userId);
		expect(results).toEqual([{ userId: due.userId, through: dueMid, baseSeq: dueMid, deleted: libs.due.seqs.filter((q) => q <= dueMid).length, calls: expect.any(Number) }]);
		expect(await seqsOf(due.userId)).toEqual(libs.due.seqs.filter((q) => q > dueMid));
		expect(await baseRow(due.userId)).toEqual({ base: dueMid, compacted: true });
		// The others are exactly as they were.
		expect(await opCount(fresh.userId)).toBe(libs.fresh.seqs.length);
		expect(await baseRow(fresh.userId)).toBeUndefined();
		expect(await opCount(done.userId)).toBe(doneCount);
		expect(await opCount(none.userId)).toBe(libs.none.seqs.length);
		await app.audit.flush();
		const audited = await app.pg.query<{ device_id: string | null; request_id: string | null; detail: Record<string, unknown> }>(
			`select device_id, request_id, detail from curator.audit_event where user_id = $1 and kind = 'ops_compacted'`,
			[due.userId],
		);
		expect(audited.rows).toEqual([{ device_id: null, request_id: null, detail: { through: dueMid, baseSeq: dueMid, deleted: results[0]!.deleted } }]);
		// Not due again until a newer snapshot ages past the base.
		expect((await app.db.query<{ user_id: string }>(`select user_id::text as user_id from curator.users_due_for_compaction(interval '7 days')`)).some((r) => r.user_id === due.userId)).toBe(false);
		await app.pg.query(`update curator.library_snapshot set created_at = now() - interval '8 days' where user_id = $1 and snapshot_seq = $2`, [due.userId, libs.due.head]);
		await app.pg.query(`delete from curator.library_snapshot where user_id = $1 and snapshot_seq = $2`, [due.userId, dueMid]);
		expect(await app.db.query(`select user_id::text as user_id, through::float8 as through from curator.users_due_for_compaction(interval '7 days')`)).toContainEqual({ user_id: due.userId, through: libs.due.head });
	});

	it('one account’s failure does not stop the sweep', async () => {
		const bad = await app.signIn();
		const good = await app.signIn();
		const libs = { bad: await library(bad), good: await library(good) };
		await insertSnapshot(app.pg, bad.userId, libs.bad.head, { ageMs: 8 * DAY });
		await insertSnapshot(app.pg, good.userId, libs.good.head, { ageMs: 8 * DAY });
		// `bad` is listed, then loses its snapshot before its turn: set_base_seq
		// refuses, the sweep logs it and goes on.
		const db = {
			...app.db,
			query: async <T extends Record<string, unknown>>(text: string, params?: readonly (string | null)[]): Promise<T[]> => {
				if (text.includes('set_base_seq') && params?.[0] === bad.userId) await app.pg.query(`delete from curator.library_snapshot where user_id = $1`, [bad.userId]);
				return app.db.query<T>(text, params);
			},
		};
		const results = (await compactDueUsers({ db, log: app.deps.log, audit: null })).filter((r) => [bad.userId, good.userId].includes(r.userId));
		expect(results.map((r) => r.userId)).toEqual([good.userId]);
		expect(app.logs.some((l) => l.msg === 'compact_failed' && l.userId === bad.userId)).toBe(true);
		expect(await opCount(bad.userId)).toBe(libs.bad.seqs.length);
		expect(await opCount(good.userId)).toBe(0);
	});
});

describe('isolation', () => {
	it('compacts one account only, and another account can neither read the base nor call the writers', async () => {
		const a = await app.signIn();
		const b = await app.signIn();
		const la = await library(a);
		const lb = await library(b);
		await insertSnapshot(app.pg, a.userId, la.head);
		await compactUser(app.db, a.userId, la.head);
		expect(await opCount(a.userId)).toBe(0);
		expect(await opCount(b.userId)).toBe(lb.seqs.length);
		expect(await baseRow(b.userId)).toBeUndefined();
		// b's view: no base, its own ops; a's base row is not there.
		expect(await b.api.sync.bootstrap.query({ deviceId: b.deviceId, storage: true })).toEqual({ snapshotSeq: 0, baseSeq: 0 });
		const seen = await asUser(app.pg, b.userId, async (tx) => (await tx.query(`select * from curator.library_base`)).rows);
		expect(seen).toEqual([]);
		for (const sql of [`select curator.set_base_seq('${b.userId}', 0)`, `select curator.compact_ops('${b.userId}', 10)`, `select * from curator.users_due_for_compaction(interval '1 day')`]) {
			await expect(asUser(app.pg, b.userId, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
		}
		await expect(asUser(app.pg, b.userId, (tx) => tx.query(`insert into curator.library_base (user_id, base_seq) values ($1, 1)`, [b.userId]))).rejects.toThrow(/permission denied/);
	});
});
