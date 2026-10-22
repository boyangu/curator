// 'batches': staged ops stay invisible to every reader until the commit
// publishes; normal pushes and pulls keep flowing around a batch; the commit
// moves, dedupes and orders, and rings once, building no snapshot (the
// master publishes one after it); no cursor skips an op that becomes
// visible later. Expiry, abort, resume, isolation, revocation and the audit
// trail. Against the real API over PGlite.

import { randomUUID } from 'node:crypto';
import { applyOps, createLibraryState, serializeLibraryState, type LibraryState, type Op, type StoredOp } from '@curator/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestApp, errorReason, insertSnapshot, opsFor, sampleLibrary, wakeups, type TestApp } from '../test/harness.js';
import { DEFAULT_BATCH_OPTIONS, tendBatches, type CommitStep } from './batch.js';

let app: TestApp;
beforeAll(async () => {
	// Small chunks so every commit here runs several move transactions.
	app = await createTestApp({ batch: { moveChunk: 7, moveMin: 3, moveMax: 7 } });
});
afterAll(() => app.db.close());
afterEach(() => {
	app.deps.batch.beforeStep = undefined;
	app.deps.batch.commitWaitMs = 60_000;
});

type Api = Awaited<ReturnType<TestApp['signIn']>>['api'];

const strip = (ops: readonly StoredOp[]): Op[] => ops.map(({ seq: _s, user_id: _u, received_at: _r, ...op }) => op as Op);
const fold = (ops: readonly Op[], into: LibraryState = createLibraryState()): LibraryState => applyOps(into, ops).state;

// A second device of the same user (its own session, so its own gate).
async function secondDevice(userId: string): Promise<{ deviceId: string; api: Api }> {
	const deviceId = `device-${randomUUID()}`;
	const api = app.client(await app.sign(userId, { sessionId: `session-${deviceId}` }));
	await api.account.registerDevice.mutate({ deviceId, name: 'Second desktop', platform: 'win32' });
	return { deviceId, api };
}

// Pull until an empty page, as the desktop does, from `cursor`; returns the
// ops and where the cursor ended. `skipOwn` pulls the way a device with the
// own-op skip does.
async function drain(api: Api, deviceId: string, cursor: number, skipOwn?: number): Promise<{ ops: StoredOp[]; cursor: number; hint: number | undefined }> {
	const ops: StoredOp[] = [];
	let hint: number | undefined;
	for (;;) {
		const page = await api.sync.pull.query({ afterSeq: cursor, limit: 10, deviceId, ...(skipOwn !== undefined ? { ownThroughSeq: skipOwn } : {}) });
		hint ??= page.snapshotSeq;
		ops.push(...page.ops);
		cursor = Math.max(cursor, page.nextSeq);
		if (page.ops.length === 0) return { ops, cursor, hint };
	}
}

async function stage(api: Api, deviceId: string, batchId: string, ops: readonly Op[], size = 40): Promise<void> {
	for (let i = 0; i < ops.length; i += size) {
		const r = await api.sync.batchPush.mutate({ deviceId, batchId, ops: ops.slice(i, i + size) });
		expect(r.rejected).toEqual([]);
	}
}

// Holds a commit before `step` (the nth time it is reached) until released.
function holdAt(step: CommitStep, nth = 1): { reached: Promise<void>; release: () => void } {
	let count = 0;
	let reached!: () => void;
	let release!: () => void;
	const reachedP = new Promise<void>((r) => (reached = r));
	const releaseP = new Promise<void>((r) => (release = r));
	app.deps.batch.beforeStep = async (s) => {
		if (s !== step || ++count !== nth) return;
		reached();
		await releaseP;
	};
	return { reached: reachedP, release };
}

describe('a batch while it is open', () => {
	it('stages ops no reader can see: not a pull, a bootstrap or the far-behind hint', async () => {
		const a = await app.signIn();
		const b = await secondDevice(a.userId);
		const before = sampleLibrary(a.deviceId, 1);
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: before });
		const hidden = sampleLibrary(a.deviceId, 2);
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill', expectedOps: hidden.length });
		await stage(a.api, a.deviceId, batchId, hidden);

		const pulled = await drain(b.api, b.deviceId, 0);
		expect(pulled.ops.map((o) => o.op_id)).toEqual(before.map((o) => o.op_id));
		// The stager's own pull, own-op skip and all, sees no more.
		expect((await drain(a.api, a.deviceId, 0)).ops).toHaveLength(before.length);
		const boot = await b.api.sync.bootstrap.query({ deviceId: b.deviceId, storage: true });
		expect(boot.snapshotSeq).toBe(0);
		const staged = await app.pg.query<{ n: number }>('select count(*)::int as n from curator.library_op_staged where batch_id = $1', [batchId]);
		expect(staged.rows[0]!.n).toBe(hidden.length);
		// Staging rings no doorbell.
		expect((await wakeups(app.pg, a.userId)).length).toBe(1);
	});

	it('lets every device push and pull normally around it', async () => {
		const a = await app.signIn();
		const b = await secondDevice(a.userId);
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, batchId, sampleLibrary(a.deviceId, 1));
		const edit = opsFor(b.deviceId)('tag', 'create', randomUUID(), { name: 'live edit', kind: 'user' });
		const pushed = await b.api.sync.push.mutate({ deviceId: b.deviceId, ops: [edit] });
		expect(pushed.accepted).toBe(1);
		// A's own normal edit flows beside its open batch too.
		const own = opsFor(a.deviceId)('tag', 'create', randomUUID(), { name: 'a edit', kind: 'user' });
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: [own] });
		expect((await drain(a.api, a.deviceId, 0)).ops.map((o) => o.op_id)).toEqual([edit.op_id, own.op_id]);
		expect((await drain(b.api, b.deviceId, 0)).ops.map((o) => o.op_id)).toEqual([edit.op_id, own.op_id]);
	});

	it('resumes per device and label: begin again answers the same batch, re-staging is a no-op', async () => {
		const a = await app.signIn();
		const ops = sampleLibrary(a.deviceId, 1);
		const first = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'initial-push' });
		expect(first).toMatchObject({ status: 'open', resumed: false, stagedOps: 0 });
		await stage(a.api, a.deviceId, first.batchId, ops.slice(0, 20));
		// A restart: same label, same batch, staged count intact.
		const again = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'initial-push' });
		expect(again).toMatchObject({ batchId: first.batchId, status: 'open', resumed: true, stagedOps: 20 });
		// The lost answer's ops sent again, plus the rest.
		const r = await a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId: first.batchId, ops });
		expect(r).toMatchObject({ accepted: ops.length, rejected: [], stagedOps: ops.length });
		// Another label is another batch.
		const other = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		expect(other.batchId).not.toBe(first.batchId);
		// Another device of the account cannot use it.
		const b = await secondDevice(a.userId);
		expect(await errorReason(b.api.sync.batchPush.mutate({ deviceId: b.deviceId, batchId: first.batchId, ops: [] }))).toMatchObject({ reason: 'batch_gone' });
	});

	it('validates and rejects per op exactly like sync.push, and keeps the caps', async () => {
		const a = await app.signIn();
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		const op = opsFor(a.deviceId);
		const good = op('tag', 'create', randomUUID(), { name: 'ok', kind: 'user' });
		const foreign = { ...op('tag', 'create', randomUUID(), { name: 'x', kind: 'user' }), device_id: 'someone-else' };
		const broken = { ...op('tag', 'create', randomUUID(), { name: 'y', kind: 'user' }), payload: { nope: true } };
		const future = op('tag', 'create', randomUUID(), { name: 'z', kind: 'user' }, Date.now() + 3 * 24 * 3600 * 1000);
		const r = await a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops: [good, foreign, broken, future] });
		expect(r.accepted).toBe(2);
		expect(r.rejected).toEqual([
			{ opId: foreign.op_id, reason: 'not_owner' },
			{ opId: broken.op_id, reason: 'invalid_payload' },
		]);
		expect(r.clamped).toEqual([{ opId: future.op_id, clientTs: expect.any(Number) }]);
		expect(r.clamped![0]!.clientTs).toBeLessThan(future.client_ts);
		const many = Array.from({ length: 501 }, () => good);
		expect(await errorReason(a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops: many }))).toMatchObject({ reason: 'batch_too_large' });
		expect(await errorReason(a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId: randomUUID(), ops: [good] }))).toMatchObject({ reason: 'batch_gone' });
	});
});

describe('committing a batch', () => {
	it('moves, dedupes and orders the ops after concurrent pushes and rings once; no cursor misses anything', async () => {
		const a = await app.signIn();
		const b = await secondDevice(a.userId);
		const base = sampleLibrary(a.deviceId, 1);
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: base });
		// B is caught up before the batch exists.
		let bCursor = (await drain(b.api, b.deviceId, 0)).cursor;
		const wakesBefore = (await wakeups(app.pg, a.userId)).length;

		const batch = sampleLibrary(a.deviceId, 3);
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		// Ten of them were already pushed plainly (a desktop mid-backfill on an
		// older build): staged again, stored once.
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: batch.slice(0, 10) });
		await stage(a.api, a.deviceId, batchId, batch);
		// Normal pushes from B while A's batch is open.
		const bOps = sampleLibrary(b.deviceId, 1);
		await b.api.sync.push.mutate({ deviceId: b.deviceId, ops: bOps.slice(0, 15) });
		// A pull mid-batch sees the plain ops, none of the staged rest.
		const mid = await drain(b.api, b.deviceId, bCursor);
		expect(mid.ops.map((o) => o.op_id)).toEqual([...batch.slice(0, 10), ...bOps.slice(0, 15)].map((o) => o.op_id));
		bCursor = mid.cursor;

		const res = await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId });
		expect(res).toMatchObject({ status: 'committed', movedOps: batch.length, totalOps: batch.length, rejected: [] });
		await b.api.sync.push.mutate({ deviceId: b.deviceId, ops: bOps.slice(15) });

		// Stored once each; the batch's new ops got seqs after B's concurrent
		// pushes, in A's order.
		const rows = await app.pg.query<{ op_id: string; seq: number }>(
			'select op_id::text as op_id, seq::float8 as seq from curator.library_op where user_id = $1 order by seq',
			[a.userId],
		);
		expect(rows.rows).toHaveLength(base.length + batch.length + bOps.length);
		const seqOf = new Map(rows.rows.map((r) => [r.op_id, r.seq]));
		const moved = batch.slice(10).map((o) => seqOf.get(o.op_id)!);
		expect(moved).toEqual([...moved].sort((x, y) => x - y));
		expect(Math.min(...moved)).toBeGreaterThan(Math.max(...bOps.slice(0, 15).map((o) => seqOf.get(o.op_id)!)));
		expect(res.committedSeq).toBe(Math.max(...moved));
		// No snapshot inside the commit: the fence alone hid the batch.
		const stored = await app.pg.query<{ n: number }>('select count(*)::int as n from curator.library_snapshot where user_id = $1', [a.userId]);
		expect(stored.rows[0]!.n).toBe(0);
		expect(res.priorOwnMaxSeq).toBe(Math.max(...base.map((o) => seqOf.get(o.op_id)!)));

		// B's cursor from mid-batch picks up everything it had not seen, once.
		const after = await drain(b.api, b.deviceId, bCursor);
		expect(after.ops.map((o) => o.op_id).sort()).toEqual([...batch.slice(10), ...bOps.slice(15)].map((o) => o.op_id).sort());
		// A replay from nothing lands on the fold of every op, the batch's in
		// the order the commit gave them.
		const all = [...base, ...batch, ...bOps];
		expect(serializeLibraryState(fold(strip((await drain(b.api, b.deviceId, 0)).ops)))).toBe(serializeLibraryState(fold(all)));
		// One wake-up for the whole commit (plus the two plain pushes').
		const wakes = await wakeups(app.pg, a.userId);
		expect(wakes.length - wakesBefore).toBe(3 + 1);

		// Asked again (an answer the client lost): the same result.
		expect(await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId })).toEqual(res);
		// Closed: no more staging, and begin opens a fresh batch.
		expect(await errorReason(a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops: [] }))).toMatchObject({ reason: 'batch_gone' });
		expect((await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' })).batchId).not.toBe(batchId);
	});

	it('stays invisible between chunks and until it publishes, while pushes keep landing', async () => {
		const a = await app.signIn();
		const b = await secondDevice(a.userId);
		const base = sampleLibrary(a.deviceId, 1);
		await a.api.sync.push.mutate({ deviceId: a.deviceId, ops: base });
		const first = await drain(b.api, b.deviceId, 0);
		const batch = sampleLibrary(a.deviceId, 2);
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, batchId, batch);

		// Held after the third chunk moved: part of the batch is in library_op.
		const midMove = holdAt('move', 4);
		app.deps.batch.commitWaitMs = 0;
		const started = await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId });
		expect(started.status).toBe('committing');
		await midMove.reached;
		const inLog = await app.pg.query<{ n: number }>(`select count(*)::int as n from curator.library_op where user_id = $1`, [a.userId]);
		expect(inLog.rows[0]!.n).toBeGreaterThan(base.length);
		// A push now lands above the fence: accepted, invisible for now.
		const live = opsFor(b.deviceId)('tag', 'create', randomUUID(), { name: 'during commit', kind: 'user' });
		expect((await b.api.sync.push.mutate({ deviceId: b.deviceId, ops: [live] })).accepted).toBe(1);
		for (const skip of [undefined, 0]) {
			const p = await drain(b.api, b.deviceId, first.cursor, skip);
			expect(p.ops).toEqual([]);
			// The cursor does not move past the fence, not even with the skip.
			expect(p.cursor).toBe(first.cursor);
		}
		expect((await b.api.sync.bootstrap.query({ deviceId: b.deviceId, storage: true })).snapshotSeq).toBe(0);
		const progress = await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId });
		expect(progress).toMatchObject({ status: 'committing', totalOps: batch.length, committedSeq: 0 });
		expect(progress.movedOps).toBeGreaterThan(0);
		expect(progress.movedOps).toBeLessThan(batch.length);

		// Held just before publishing: every op moved, still nothing visible.
		const atPublish = holdAt('publish');
		midMove.release();
		await atPublish.reached;
		expect((await drain(b.api, b.deviceId, first.cursor)).ops).toEqual([]);
		expect((await b.api.sync.bootstrap.query({ deviceId: b.deviceId, storage: true })).snapshotSeq).toBe(0);
		atPublish.release();

		for (let i = 0; i < 100; i++) {
			if ((await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId })).status === 'committed') break;
			await new Promise((r) => setTimeout(r, 20));
		}
		const after = await drain(b.api, b.deviceId, first.cursor);
		expect(after.ops.map((o) => o.op_id).sort()).toEqual([...batch, live].map((o) => o.op_id).sort());
		// Published: a replay takes everything, the push made during the
		// commit included.
		expect((await drain(b.api, b.deviceId, 0)).ops).toHaveLength(base.length + batch.length + 1);
	});

	it('offers a far-behind device the snapshot the master publishes after the commit', async () => {
		const small = await createTestApp({ pull: { farBehindOps: 20, farBehindMs: 90 * 24 * 3600 * 1000 } });
		try {
			const a = await small.signIn();
			const bId = `device-${randomUUID()}`;
			const bApi = small.client(await small.sign(a.userId, { sessionId: 'session-b' }));
			await bApi.account.registerDevice.mutate({ deviceId: bId, name: 'B', platform: 'win32' });
			const batch = sampleLibrary(a.deviceId, 3);
			const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'initial-push' });
			for (let i = 0; i < batch.length; i += 50) await a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops: batch.slice(i, i + 50) });
			const res = await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId });
			expect(res.status).toBe('committed');
			// Right after publishing there is no snapshot to offer: replay.
			const early = await bApi.sync.pull.query({ afterSeq: 0, deviceId: bId });
			expect(early.snapshotSeq).toBeUndefined();
			expect(early.ops.length).toBeGreaterThan(0);
			// The master folds the batch and publishes at the commit's seq.
			const manifest = await insertSnapshot(small.pg, a.userId, res.committedSeq);
			const page = await bApi.sync.pull.query({ afterSeq: 0, deviceId: bId });
			expect(page.snapshotSeq).toBe(res.committedSeq);
			expect(await bApi.sync.bootstrap.query({ deviceId: bId, storage: true })).toEqual({ storage: manifest, snapshotSeq: res.committedSeq, baseSeq: 0 });
			// The pushing device itself skips its own batch: its own-op bound
			// moves to the commit's seq (priorOwnMaxSeq 0), so nothing comes back.
			const own = await a.api.sync.pull.query({ afterSeq: 0, deviceId: a.deviceId, ownThroughSeq: res.committedSeq });
			expect(own.ops).toEqual([]);
			expect(own.snapshotSeq).toBeUndefined();
		} finally {
			await small.db.close();
		}
	});

	it('rejects, at commit, an op id another account already holds', async () => {
		const a = await app.signIn();
		const other = await app.signIn();
		const [theirs] = sampleLibrary(other.deviceId);
		await other.api.sync.push.mutate({ deviceId: other.deviceId, ops: [theirs!] });
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		const mine = opsFor(a.deviceId)('tag', 'create', randomUUID(), { name: 'mine', kind: 'user' });
		const stolen = { ...theirs!, device_id: a.deviceId };
		await a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops: [mine, stolen] });
		const res = await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId });
		expect(res).toMatchObject({ status: 'committed', movedOps: 2, rejected: [{ opId: stolen.op_id, reason: 'not_owner' }] });
		expect((await a.api.sync.pull.query({ afterSeq: 0 })).ops.map((o) => o.op_id)).toEqual([mine.op_id]);
		const kept = await other.api.sync.pull.query({ afterSeq: 0 });
		expect(kept.ops.map((o) => o.device_id)).toEqual([other.deviceId]);
	});

	it('queues a second batch of the same user behind the first one’s fence', async () => {
		const a = await app.signIn();
		const b = await secondDevice(a.userId);
		const one = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		const two = await b.api.sync.batchBegin.mutate({ deviceId: b.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, one.batchId, sampleLibrary(a.deviceId, 1));
		await stage(b.api, b.deviceId, two.batchId, sampleLibrary(b.deviceId, 1));
		const held = holdAt('publish');
		app.deps.batch.commitWaitMs = 0;
		await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId: one.batchId });
		await held.reached;
		app.deps.batch.commitWaitMs = 200;
		expect((await b.api.sync.batchCommit.mutate({ deviceId: b.deviceId, batchId: two.batchId })).status).toBe('committing');
		app.deps.batch.beforeStep = undefined;
		held.release();
		app.deps.batch.commitWaitMs = 60_000;
		for (let i = 0; i < 100; i++) {
			if ((await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId: one.batchId })).status === 'committed') break;
			await new Promise((r) => setTimeout(r, 20));
		}
		expect((await b.api.sync.batchCommit.mutate({ deviceId: b.deviceId, batchId: two.batchId })).status).toBe('committed');
		const fences = await app.pg.query('select 1 from curator.library_op_fence where user_id = $1', [a.userId]);
		expect(fences.rows).toEqual([]);
	});

	it('is finished by the sweep when its runner died mid-way', async () => {
		const a = await app.signIn();
		const b = await secondDevice(a.userId);
		const batch = sampleLibrary(a.deviceId, 1);
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, batchId, batch);
		app.deps.batch.beforeStep = async (step) => {
			if (step === 'publish') throw new Error('machine gone');
		};
		const r = await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId });
		expect(r).toMatchObject({ status: 'committing', movedOps: batch.length });
		// Fenced and stuck: B sees nothing of it.
		expect((await drain(b.api, b.deviceId, 0)).ops).toEqual([]);
		app.deps.batch.beforeStep = undefined;
		const tended = await tendBatches({ db: app.db, log: app.deps.log, audit: app.audit, options: app.deps.batch });
		expect(tended.driven).toBeGreaterThanOrEqual(1);
		expect((await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId })).status).toBe('committed');
		expect((await drain(b.api, b.deviceId, 0)).ops).toHaveLength(batch.length);
	});
});

describe('abort, expiry and access', () => {
	it('aborts an open batch, dropping its staged ops; a committing one cannot be aborted', async () => {
		const a = await app.signIn();
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, batchId, sampleLibrary(a.deviceId, 1));
		expect(await a.api.sync.batchAbort.mutate({ deviceId: a.deviceId, batchId })).toEqual({ status: 'aborted' });
		const staged = await app.pg.query<{ n: number }>('select count(*)::int as n from curator.library_op_staged where batch_id = $1', [batchId]);
		expect(staged.rows[0]!.n).toBe(0);
		expect(await errorReason(a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId }))).toMatchObject({ reason: 'batch_gone' });
		expect(await errorReason(a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops: [] }))).toMatchObject({ reason: 'batch_gone' });
		expect(await a.api.sync.batchAbort.mutate({ deviceId: a.deviceId, batchId })).toEqual({ status: 'aborted' });
		expect((await a.api.sync.pull.query({ afterSeq: 0 })).ops).toEqual([]);

		const next = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, next.batchId, sampleLibrary(a.deviceId, 1));
		const held = holdAt('publish');
		app.deps.batch.commitWaitMs = 0;
		await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId: next.batchId });
		await held.reached;
		expect(await errorReason(a.api.sync.batchAbort.mutate({ deviceId: a.deviceId, batchId: next.batchId }))).toMatchObject({ reason: 'batch_committing' });
		expect(await errorReason(a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId: next.batchId, ops: [] }))).toMatchObject({ reason: 'batch_committing' });
		held.release();
	});

	it('expires a batch idle for a day: staged ops deleted, audited, and the device starts over', async () => {
		const a = await app.signIn();
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, batchId, sampleLibrary(a.deviceId, 1));
		const fresh = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'initial-push' });
		await app.pg.query(`update curator.library_op_batch set updated_at = now() - interval '25 hours' where id = $1`, [batchId]);
		const r = await tendBatches({ db: app.db, log: app.deps.log, audit: app.audit, options: DEFAULT_BATCH_OPTIONS });
		expect(r.expired).toBeGreaterThanOrEqual(1);
		const rows = await app.pg.query<{ id: string; status: string; n: number }>(
			`select b.id::text as id, b.status, (select count(*)::int from curator.library_op_staged s where s.batch_id = b.id) as n
			from curator.library_op_batch b where b.user_id = $1 order by b.created_at`,
			[a.userId],
		);
		expect(rows.rows).toEqual([
			{ id: batchId, status: 'expired', n: 0 },
			{ id: fresh.batchId, status: 'open', n: 0 },
		]);
		expect(await errorReason(a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops: [] }))).toMatchObject({ reason: 'batch_gone' });
		const restarted = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		expect(restarted).toMatchObject({ resumed: false, stagedOps: 0 });
		await app.audit.flush();
		const events = await app.pg.query<{ kind: string; detail: { batchId: string } }>(
			`select kind, detail from curator.audit_event where user_id = $1 and kind like 'batch_%' order by id`,
			[a.userId],
		);
		expect(events.rows.map((e) => e.kind)).toEqual(['batch_begun', 'batch_begun', 'batch_expired', 'batch_begun']);
		expect(events.rows[2]!.detail.batchId).toBe(batchId);
	});

	it('keeps batches, staged ops and fences per user under RLS', async () => {
		const a = await app.signIn();
		const other = await app.signIn();
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await stage(a.api, a.deviceId, batchId, sampleLibrary(a.deviceId, 1));
		// Through the API: another account cannot touch it.
		expect(await errorReason(other.api.sync.batchPush.mutate({ deviceId: other.deviceId, batchId, ops: [] }))).toMatchObject({ reason: 'batch_gone' });
		expect(await errorReason(other.api.sync.batchCommit.mutate({ deviceId: other.deviceId, batchId }))).toMatchObject({ reason: 'batch_gone' });
		expect(await errorReason(other.api.sync.batchAbort.mutate({ deviceId: other.deviceId, batchId }))).toMatchObject({ reason: 'batch_gone' });
		// Underneath it.
		for (const table of ['library_op_batch', 'library_op_staged', 'library_op_fence']) {
			const seen = await asUser(app.pg, other.userId, (tx) => tx.query(`select * from curator.${table}`));
			expect(seen.rows).toEqual([]);
		}
		await expect(
			asUser(app.pg, other.userId, (tx) =>
				tx.query(`insert into curator.library_op_staged (batch_id, user_id, op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload)
					values ($1, $2, gen_random_uuid(), 'x', 1, 1, 'tag', 'x', 'create', '{}')`, [batchId, a.userId]),
			),
		).rejects.toThrow(/row-level security/);
		// A fence planted for another user would freeze their log: refused.
		await expect(
			asUser(app.pg, other.userId, (tx) => tx.query(`insert into curator.library_op_fence (user_id, batch_id, visible_through) values ($1, $2, 0)`, [a.userId, batchId])),
		).rejects.toThrow(/row-level security|violates foreign key/);
		// And the staged rows were never this user's to delete.
		const deleted = await asUser(app.pg, other.userId, (tx) => tx.query(`delete from curator.library_op_staged where batch_id = $1 returning 1`, [batchId]));
		expect(deleted.rows).toEqual([]);
	});

	it('refuses a revoked device on every batch call and audits it as a push', async () => {
		const a = await app.signIn();
		const b = await secondDevice(a.userId);
		const { batchId } = await b.api.sync.batchBegin.mutate({ deviceId: b.deviceId, label: 'backfill' });
		await a.api.account.revokeDevice.mutate({ deviceId: b.deviceId });
		const op = opsFor(b.deviceId)('tag', 'create', randomUUID(), { name: 'x', kind: 'user' });
		expect(await errorReason(b.api.sync.batchBegin.mutate({ deviceId: b.deviceId, label: 'backfill' }))).toMatchObject({ reason: 'device_revoked' });
		expect(await errorReason(b.api.sync.batchPush.mutate({ deviceId: b.deviceId, batchId, ops: [op] }))).toMatchObject({ reason: 'device_revoked' });
		expect(await errorReason(b.api.sync.batchCommit.mutate({ deviceId: b.deviceId, batchId }))).toMatchObject({ reason: 'device_revoked' });
		await app.audit.flush();
		const events = await app.pg.query<{ detail: { ops: number; via: string } }>(
			`select detail from curator.audit_event where user_id = $1 and kind = 'push_from_revoked_device' order by id`,
			[a.userId],
		);
		expect(events.rows.map((e) => e.detail)).toEqual([
			{ ops: 0, via: 'session' },
			{ ops: 1, via: 'session' },
			{ ops: 0, via: 'session' },
		]);
	});

	it('logs every batch call in request_log with its device and op counts', async () => {
		const a = await app.signIn();
		const { batchId } = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		const ops = sampleLibrary(a.deviceId, 1);
		await a.api.sync.batchPush.mutate({ deviceId: a.deviceId, batchId, ops });
		await a.api.sync.batchCommit.mutate({ deviceId: a.deviceId, batchId });
		const second = await a.api.sync.batchBegin.mutate({ deviceId: a.deviceId, label: 'backfill' });
		await a.api.sync.batchAbort.mutate({ deviceId: a.deviceId, batchId: second.batchId });
		await app.audit.flush();
		const rows = await app.pg.query<{ procedure: string; http_status: number; device_id: string; ops_in: number | null; ops_out: number | null }>(
			`select procedure, http_status, device_id, ops_in, ops_out from curator.request_log where user_id = $1 and procedure like 'sync.batch%' order by id`,
			[a.userId],
		);
		expect(rows.rows).toEqual([
			{ procedure: 'sync.batchBegin', http_status: 200, device_id: a.deviceId, ops_in: null, ops_out: null },
			{ procedure: 'sync.batchPush', http_status: 200, device_id: a.deviceId, ops_in: ops.length, ops_out: null },
			{ procedure: 'sync.batchCommit', http_status: 200, device_id: a.deviceId, ops_in: null, ops_out: ops.length },
			{ procedure: 'sync.batchBegin', http_status: 200, device_id: a.deviceId, ops_in: null, ops_out: null },
			{ procedure: 'sync.batchAbort', http_status: 200, device_id: a.deviceId, ops_in: null, ops_out: null },
		]);
		const kinds = await app.pg.query<{ kind: string }>(`select kind from curator.audit_event where user_id = $1 and kind like 'batch_%' order by id`, [a.userId]);
		expect(kinds.rows.map((k) => k.kind)).toEqual(['batch_begun', 'batch_committed', 'batch_begun', 'batch_aborted']);
	});
});
