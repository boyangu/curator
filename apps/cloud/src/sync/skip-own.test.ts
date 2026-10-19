// 'pull_skip_own': a device that names itself (and the seq through which it
// holds its own ops) is not sent those ops back, while its cursor still
// moves past them. Plus the push side that makes it safe: clamped stamps and
// the own-seq bounds in PushResult. PGlite runs one connection, so the
// concurrency half of the seq-visibility argument (pull.ts) is reasoned, not
// raced, here; what is checked is every cursor position it implies.

import { randomUUID } from 'node:crypto';
import { SYNC_FEATURES, type Op } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorReason, opsFor, sampleLibrary, type TestApp } from '../test/harness.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

type Api = Awaited<ReturnType<TestApp['signIn']>>['api'];

// One account with two registered devices.
async function twoDevices() {
	const a = await app.signIn();
	const bId = `device-${randomUUID()}`;
	await a.api.account.registerDevice.mutate({ deviceId: bId, name: 'Second desktop', platform: 'win32' });
	return { userId: a.userId, api: a.api, aId: a.deviceId, bId };
}

const tags = (deviceId: string, n: number): Op[] => {
	const op = opsFor(deviceId);
	return Array.from({ length: n }, (_, i) => op('tag', 'create', randomUUID(), { name: `t${i}`, kind: 'user' }));
};

// Pulls to the end the way the desktop does: until an empty page, keeping
// that page's nextSeq too.
async function drain(api: Api, afterSeq: number, extra: { deviceId?: string; ownThroughSeq?: number; limit?: number } = {}) {
	const pages: { ops: string[]; nextSeq: number }[] = [];
	let cursor = afterSeq;
	for (let i = 0; i < 100; i++) {
		const r = await api.sync.pull.query({ afterSeq: cursor, ...extra });
		pages.push({ ops: r.ops.map((o) => o.op_id), nextSeq: r.nextSeq });
		expect(r.nextSeq).toBeGreaterThanOrEqual(cursor);
		cursor = r.nextSeq;
		if (r.ops.length === 0) break;
	}
	return { pages, cursor, ops: pages.flatMap((p) => p.ops) };
}

describe('sync.pull skipping the caller’s own ops', () => {
	it('sends a device none of its own ops and moves its cursor to its own max seq; the other device gets them all', async () => {
		const { api, aId, bId } = await twoDevices();
		const ops = sampleLibrary(aId);
		const pushed = await api.sync.push.mutate({ deviceId: aId, ops });
		expect(pushed.features).toEqual([...SYNC_FEATURES]);
		expect(pushed.batchMaxSeq).toBe(pushed.maxSeq);
		expect(pushed.priorOwnMaxSeq).toBe(0);

		const mine = await api.sync.pull.query({ afterSeq: 0, deviceId: aId, ownThroughSeq: pushed.batchMaxSeq! });
		expect(mine.ops).toEqual([]);
		expect(mine.nextSeq).toBe(pushed.batchMaxSeq);
		expect(mine.features).toEqual([...SYNC_FEATURES]);

		const theirs = await drain(api, 0, { deviceId: bId, ownThroughSeq: 0 });
		expect(theirs.ops).toEqual(ops.map((o) => o.op_id));
		expect(theirs.cursor).toBe(pushed.maxSeq);
	});

	it('pages interleaved ops from two devices with a small limit, never stalling behind a run of own ops', async () => {
		const { api, aId, bId } = await twoDevices();
		// A A A A A  B  A A A A A  B  A  B B  A A A (trailing own ops)
		const runs: [string, number][] = [[aId, 5], [bId, 1], [aId, 5], [bId, 1], [aId, 1], [bId, 2], [aId, 3]];
		const bOps: string[] = [];
		let aThrough = 0;
		for (const [dev, n] of runs) {
			const batch = tags(dev, n);
			const r = await api.sync.push.mutate({ deviceId: dev, ops: batch });
			if (dev === bId) bOps.push(...batch.map((o) => o.op_id));
			else aThrough = r.batchMaxSeq!;
		}
		const head = (await api.sync.pull.query({ afterSeq: 0, limit: 1000 })).ops.at(-1)!.seq;

		for (const limit of [1, 2, 3]) {
			const d = await drain(api, 0, { deviceId: aId, ownThroughSeq: aThrough, limit });
			expect(d.ops).toEqual(bOps);
			// The trailing own ops are stepped over too: the cursor is the head.
			expect(d.cursor).toBe(head);
			// Every full page stops at its last op; only the final empty page
			// jumps to the head.
			const last = d.pages.at(-1)!;
			expect(last).toEqual({ ops: [], nextSeq: head });
		}
		// A limit that ends a page exactly on B's op stops the cursor there.
		const first = await api.sync.pull.query({ afterSeq: 0, deviceId: aId, ownThroughSeq: aThrough, limit: 1 });
		expect(first.ops.map((o) => o.op_id)).toEqual([bOps[0]]);
		expect(first.nextSeq).toBe(first.ops[0]!.seq);
	});

	it('advances past a page that would be all own ops, from any cursor inside the run', async () => {
		const { api, aId, bId } = await twoDevices();
		const own = await api.sync.push.mutate({ deviceId: aId, ops: tags(aId, 12) });
		const pageA = await api.sync.pull.query({ afterSeq: 0, deviceId: aId, ownThroughSeq: own.batchMaxSeq!, limit: 3 });
		expect(pageA).toMatchObject({ ops: [], nextSeq: own.batchMaxSeq });

		const b = tags(bId, 1);
		await api.sync.push.mutate({ deviceId: bId, ops: b });
		await api.sync.push.mutate({ deviceId: aId, ops: tags(aId, 4) });
		const all = (await api.sync.pull.query({ afterSeq: 0 })).ops;
		const mid = all[5]!.seq; // inside A's first run
		const d = await drain(api, mid, { deviceId: aId, ownThroughSeq: all.at(-1)!.seq, limit: 2 });
		expect(d.ops).toEqual([b[0]!.op_id]);
		expect(d.cursor).toBe(all.at(-1)!.seq);
	});

	it('still sends own ops above ownThroughSeq (a restored database gets back what it lost)', async () => {
		const { api, aId } = await twoDevices();
		const held = await api.sync.push.mutate({ deviceId: aId, ops: tags(aId, 3) });
		const lost = tags(aId, 2);
		await api.sync.push.mutate({ deviceId: aId, ops: lost });
		const d = await drain(api, 0, { deviceId: aId, ownThroughSeq: held.batchMaxSeq! });
		expect(d.ops).toEqual(lost.map((o) => o.op_id));
	});

	it('without a device id, sends everything as before', async () => {
		const { api, aId } = await twoDevices();
		const ops = tags(aId, 5);
		await api.sync.push.mutate({ deviceId: aId, ops });
		const r = await api.sync.pull.query({ afterSeq: 0, limit: 3 });
		expect(r.ops.map((o) => o.op_id)).toEqual(ops.slice(0, 3).map((o) => o.op_id));
		expect(r.nextSeq).toBe(r.ops[2]!.seq);
		const rest = await drain(api, r.nextSeq);
		expect(rest.ops).toEqual(ops.slice(3).map((o) => o.op_id));
	});

	it('refuses a device id without its bound, and the bound without a device id', async () => {
		const { api, aId } = await twoDevices();
		expect(await errorReason(api.sync.pull.query({ afterSeq: 0, deviceId: aId } as never))).toMatchObject({ code: 'BAD_REQUEST' });
		expect(await errorReason(api.sync.pull.query({ afterSeq: 0, ownThroughSeq: 5 } as never))).toMatchObject({ code: 'BAD_REQUEST' });
	});

	it('narrows only the caller’s own rows: another account’s device id hides nothing and reveals nothing', async () => {
		const x = await app.signIn();
		const y = await app.signIn();
		const xOps = tags(x.deviceId, 3);
		await x.api.sync.push.mutate({ deviceId: x.deviceId, ops: xOps });
		await y.api.sync.push.mutate({ deviceId: y.deviceId, ops: tags(y.deviceId, 2) });
		const r = await drain(x.api, 0, { deviceId: y.deviceId, ownThroughSeq: Number.MAX_SAFE_INTEGER });
		expect(r.ops).toEqual(xOps.map((o) => o.op_id));
	});

	it('counts only replayable ops toward the far-behind hint', async () => {
		const small = await createTestApp({ pull: { farBehindOps: 10, farBehindMs: 30 * 24 * 3600_000 } });
		try {
			const { userId, deviceId, api } = await small.signIn();
			const pushed = await api.sync.push.mutate({ deviceId, ops: sampleLibrary(deviceId) });
			const { buildSnapshot } = await import('../snapshot/job.js');
			expect((await buildSnapshot(small.db, userId)).status).toBe('built');
			// Everyone else would replay all of them: bootstrap.
			expect((await api.sync.pull.query({ afterSeq: 0 })).snapshotSeq).toBeDefined();
			expect((await api.sync.pull.query({ afterSeq: 0, deviceId: 'other', ownThroughSeq: 0 })).snapshotSeq).toBeDefined();
			// The pushing device would replay none: no reason to bootstrap.
			const mine = await api.sync.pull.query({ afterSeq: 0, deviceId, ownThroughSeq: pushed.batchMaxSeq! });
			expect(mine.snapshotSeq).toBeUndefined();
			expect(mine).toMatchObject({ ops: [], nextSeq: pushed.maxSeq });
		} finally {
			await small.db.close();
		}
	});

	it('logs ops_out as what was sent and the skipped own ops on the stdout line', async () => {
		const { userId, api, aId, bId } = await twoDevices();
		const own = await api.sync.push.mutate({ deviceId: aId, ops: tags(aId, 4) });
		await api.sync.push.mutate({ deviceId: bId, ops: tags(bId, 2) });
		await api.sync.pull.query({ afterSeq: 0, deviceId: aId, ownThroughSeq: own.batchMaxSeq! });
		const line = app.logs.filter((l) => l.msg === 'request' && l.userId === userId && l.procedure === 'sync.pull').at(-1)!;
		expect(line).toMatchObject({ opsOut: 2, opsSkippedOwn: 4 });
		await app.audit.flush();
		const [row] = await app.db.query<{ ops_out: number }>(`select ops_out from curator.request_log where request_id = $1::uuid`, [line.requestId as string]);
		expect(row!.ops_out).toBe(2);
		// A pull without the skip carries no such field.
		await api.sync.pull.query({ afterSeq: 0 });
		const plain = app.logs.filter((l) => l.msg === 'request' && l.userId === userId && l.procedure === 'sync.pull').at(-1)!;
		expect(plain.opsOut).toBe(6);
		expect('opsSkippedOwn' in plain).toBe(false);
	});
});

describe('sync.push results for the own-op skip', () => {
	it('reports clamped ops with the stamp the log holds, including on a re-push of one', async () => {
		const { deviceId, api } = await app.signIn();
		const op = opsFor(deviceId);
		const fast = op('library_track', 'set-rating', randomUUID(), { rating: 2 }, Date.now() + 3600_000);
		const fine = op('library_track', 'set-rating', randomUUID(), { rating: 3 }, Date.now() + 60_000);
		const res = await api.sync.push.mutate({ deviceId, ops: [fast, fine] });
		const [storedFast] = (await api.sync.pull.query({ afterSeq: 0 })).ops;
		expect(res.clamped).toEqual([{ opId: fast.op_id, clientTs: storedFast!.client_ts }]);
		expect(storedFast!.client_ts).toBeLessThan(fast.client_ts);
		// The answer was lost and the device sends it again: the log keeps the
		// first stamp and the result still names it.
		const again = await api.sync.push.mutate({ deviceId, ops: [fast, fine] });
		expect(again.clamped).toEqual([{ opId: fast.op_id, clientTs: storedFast!.client_ts }]);
	});

	it('bounds the device’s own ops: this batch’s highest seq, and its highest seq outside the batch', async () => {
		const { api, aId, bId } = await twoDevices();
		const first = await api.sync.push.mutate({ deviceId: aId, ops: tags(aId, 3) });
		expect(first).toMatchObject({ priorOwnMaxSeq: 0, batchMaxSeq: first.maxSeq });
		// Another device's ops are not this device's.
		const b = await api.sync.push.mutate({ deviceId: bId, ops: tags(bId, 2) });
		expect(b.priorOwnMaxSeq).toBe(0);
		const batch = tags(aId, 2);
		const second = await api.sync.push.mutate({ deviceId: aId, ops: batch });
		expect(second).toMatchObject({ priorOwnMaxSeq: first.batchMaxSeq, batchMaxSeq: second.maxSeq });
		// A re-push of the latest batch with one new op: the re-pushed ops are
		// this call's, so the prior bound stays at the first batch.
		const third = await api.sync.push.mutate({ deviceId: aId, ops: [...batch, ...tags(aId, 1)] });
		expect(third).toMatchObject({ priorOwnMaxSeq: first.batchMaxSeq, batchMaxSeq: third.maxSeq });
		// Re-pushing an old batch alone: nothing new, its own highest seq.
		const old = await api.sync.push.mutate({ deviceId: aId, ops: batch });
		expect(old).toMatchObject({ batchMaxSeq: second.batchMaxSeq, priorOwnMaxSeq: third.maxSeq });
	});
});
