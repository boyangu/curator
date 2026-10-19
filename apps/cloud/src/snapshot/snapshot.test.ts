// The snapshot contract: bootstrap + pull after `snapshotSeq` must land a
// device on exactly the state it would reach by folding every op, compared
// against the protocol's `applyOps` directly.

import { applyOps, createLibraryState, materialize, type LibraryState, type Op, type StoredOp } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, sampleLibrary, type TestApp } from '../test/harness.js';
import { deserializeLibraryState, serializeLibraryState } from '@curator/protocol';
import { decodeSnapshotBase64 } from './codec.js';
import { buildSnapshot, DEFAULT_DUE_OPTIONS, runDueSnapshots } from './job.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

const strip = (ops: StoredOp[]): Op[] =>
	ops.map(({ seq: _s, user_id: _u, received_at: _r, ...op }) => op as Op);

function foldAll(ops: readonly Op[]): LibraryState {
	return applyOps(createLibraryState(), ops).state;
}

async function pullAll(api: Awaited<ReturnType<TestApp['signIn']>>['api'], afterSeq: number): Promise<StoredOp[]> {
	const out: StoredOp[] = [];
	let cursor = afterSeq;
	for (;;) {
		const page = await api.sync.pull.query({ afterSeq: cursor, limit: 25 });
		out.push(...page.ops);
		if (page.ops.length === 0) return out;
		cursor = page.nextSeq;
	}
}

// What a new device does: load the snapshot, then fold what came after it.
async function bootstrapThenPull(api: Awaited<ReturnType<TestApp['signIn']>>['api']): Promise<LibraryState> {
	const boot = await api.sync.bootstrap.query();
	expect(boot.encoding).toBe('curator.library-state.v1+json+gzip+base64');
	const state = await decodeSnapshotBase64(boot.snapshot);
	return applyOps(state, strip(await pullAll(api, boot.snapshotSeq))).state;
}

describe('snapshot codec', () => {
	it('round-trips a folded state byte for byte', () => {
		const state = foldAll(sampleLibrary('codec-device', 3));
		const json = serializeLibraryState(state);
		const back = deserializeLibraryState(json);
		expect(serializeLibraryState(back)).toBe(json);
		expect(materialize(back)).toEqual(materialize(state));
		// The v2 maps ride along: the chain resolved, the withdrawn rule gone.
		expect(materialize(back).artistAlias).toMatchObject({ a0: { name: 'C0', key: 'c0' }, b0: { name: 'C0', key: 'c0' } });
		expect(materialize(back).artistAlias['x0']).toBeUndefined();
		expect(materialize(back).libraryTracks.some((t) => t.state === 'backlog')).toBe(true);
	});

	it('serialises the same ops to the same bytes whatever the arrival order', () => {
		const ops = sampleLibrary('order-device', 2);
		const reversed = [...ops].reverse();
		expect(serializeLibraryState(foldAll(reversed))).toBe(serializeLibraryState(foldAll(ops)));
	});

	it('refuses something that is not a snapshot', () => {
		expect(() => deserializeLibraryState('{"format":"other","version":1,"maps":{}}')).toThrow(/not a curator.library-state/);
		expect(() => deserializeLibraryState('{"format":"curator.library-state","version":1,"maps":{}}')).toThrow(/missing tags/);
	});
});

describe('snapshot job and bootstrap', () => {
	it('bootstraps an account with no snapshot from the empty state at seq 0', async () => {
		const { api } = await app.signIn();
		const boot = await api.sync.bootstrap.query();
		expect(boot.snapshotSeq).toBe(0);
		expect(serializeLibraryState(await decodeSnapshotBase64(boot.snapshot))).toBe(serializeLibraryState(createLibraryState()));
	});

	it('bootstrap + pull after the snapshot equals folding every op', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const all = sampleLibrary(deviceId, 4);
		const cut = 60;
		await api.sync.push.mutate({ deviceId, ops: all.slice(0, cut) });

		const built = await buildSnapshot(app.db, userId, { pageSize: 7, keep: 3 });
		expect(built).toMatchObject({ status: 'built', fromSeq: 0, opsFolded: cut });

		await api.sync.push.mutate({ deviceId, ops: all.slice(cut) });

		const viaSnapshot = await bootstrapThenPull(api);
		const direct = foldAll(all);
		expect(materialize(viaSnapshot)).toEqual(materialize(direct));
		// Raw records too, clocks included: later ops must merge onto the
		// snapshot exactly as onto a replay.
		expect(serializeLibraryState(viaSnapshot)).toBe(serializeLibraryState(direct));
		// And the snapshot alone equals folding the ops it covers.
		const boot = await api.sync.bootstrap.query();
		expect(boot.snapshotSeq).toBe(built.status === 'built' ? built.snapshotSeq : -1);
		expect(serializeLibraryState(await decodeSnapshotBase64(boot.snapshot))).toBe(serializeLibraryState(foldAll(all.slice(0, cut))));
	});

	it('builds incrementally from the previous snapshot and prunes old ones', async () => {
		const { userId, deviceId, api } = await app.signIn();
		const all = sampleLibrary(deviceId, 5);
		const chunks = [all.slice(0, 30), all.slice(30, 61), all.slice(61, 90), all.slice(90)];
		let prev = 0;
		for (const chunk of chunks) {
			await api.sync.push.mutate({ deviceId, ops: chunk });
			const b = await buildSnapshot(app.db, userId, { pageSize: 1000, keep: 2 });
			expect(b).toMatchObject({ status: 'built', fromSeq: prev, opsFolded: chunk.length });
			prev = b.status === 'built' ? b.snapshotSeq : -1;
		}
		expect(await buildSnapshot(app.db, userId)).toEqual({ userId, status: 'up_to_date', snapshotSeq: prev });

		const kept = await app.pg.query<{ n: number }>('select count(*)::int as n from curator.library_snapshot where user_id = $1', [userId]);
		expect(kept.rows[0]!.n).toBe(2);
		const boot = await api.sync.bootstrap.query();
		expect(boot.snapshotSeq).toBe(prev);
		expect(serializeLibraryState(await decodeSnapshotBase64(boot.snapshot))).toBe(serializeLibraryState(foldAll(all)));
	});

	it('the sweep snapshots users past the op threshold or the age threshold, and only them', async () => {
		const busy = await app.signIn();
		const old = await app.signIn();
		const quiet = await app.signIn();
		await busy.api.sync.push.mutate({ deviceId: busy.deviceId, ops: sampleLibrary(busy.deviceId, 2) });
		await old.api.sync.push.mutate({ deviceId: old.deviceId, ops: sampleLibrary(old.deviceId).slice(0, 3) });
		await quiet.api.sync.push.mutate({ deviceId: quiet.deviceId, ops: sampleLibrary(quiet.deviceId).slice(0, 3) });
		await app.pg.query(`update curator.library_op set received_at = now() - interval '2 days' where user_id = $1`, [old.userId]);

		const opts = { ...DEFAULT_DUE_OPTIONS, minOps: 20 };
		const mine = (r: Awaited<ReturnType<typeof runDueSnapshots>>) =>
			r.filter((x) => [busy.userId, old.userId, quiet.userId].includes(x.userId)).map((x) => [x.userId, x.status]);
		const first = await runDueSnapshots(app.db, app.deps.log, opts);
		expect(mine(first).sort()).toEqual(
			[
				[busy.userId, 'built'],
				[old.userId, 'built'],
			].sort(),
		);
		// Nothing new since: not due again.
		expect(mine(await runDueSnapshots(app.db, app.deps.log, opts))).toEqual([]);
	});
});
