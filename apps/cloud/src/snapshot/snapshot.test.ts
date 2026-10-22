// The snapshot contract: bootstrap + pull after `snapshotSeq` must land a
// device on exactly the state it would reach by folding every op, compared
// against the protocol's `applyOps` directly.

import { applyOps, createLibraryState, materialize, MAX_SNAPSHOT_CHUNK_BYTES, type LibraryState, type Op, type StoredOp } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorReason, sampleLibrary, type TestApp } from '../test/harness.js';
import { deserializeLibraryState, serializeLibraryState } from '@curator/protocol';
import { decodeSnapshotBase64 } from './codec.js';
import type { Db } from '../db/db.js';
import { bootstrap, snapshotChunk } from '../sync/bootstrap.js';
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

	it('chunked bootstrap (snapshot_chunks): the size, then the body in pieces that join to the inline body', async () => {
		const { userId, deviceId, api } = await app.signIn();
		await api.sync.push.mutate({ deviceId, ops: sampleLibrary(deviceId, 6) });
		const built = await buildSnapshot(app.db, userId);
		expect(built.status).toBe('built');
		const inline = await api.sync.bootstrap.query({ deviceId });
		const head = await api.sync.bootstrap.query({ deviceId, chunked: true });
		expect(head.snapshot).toBe('');
		expect(head.snapshotSeq).toBe(inline.snapshotSeq);
		const total = Buffer.from(inline.snapshot, 'base64').length;
		expect(head.chunked).toEqual({ totalBytes: total });
		// Small pieces, so the join is exercised (the real cap is 4 MiB).
		const step = Math.max(1, Math.ceil(total / 5));
		const parts: Buffer[] = [];
		for (let offset = 0; offset < total; offset += step) {
			const c = await api.sync.snapshotChunk.query({ deviceId, snapshotSeq: head.snapshotSeq, offset, length: step });
			expect(c).toMatchObject({ snapshotSeq: head.snapshotSeq, offset, totalBytes: total });
			parts.push(Buffer.from(c.data, 'base64'));
		}
		expect(Buffer.concat(parts).equals(Buffer.from(inline.snapshot, 'base64'))).toBe(true);
		// Past the end: empty. A pruned (or unknown) seq: snapshot_gone.
		expect((await api.sync.snapshotChunk.query({ deviceId, snapshotSeq: head.snapshotSeq, offset: total, length: 10 })).data).toBe('');
		expect(await errorReason(api.sync.snapshotChunk.query({ deviceId, snapshotSeq: head.snapshotSeq + 999, offset: 0, length: 10 }))).toMatchObject({ reason: 'snapshot_gone' });
		// A piece above the cap is refused by the input schema.
		await expect(api.sync.snapshotChunk.query({ deviceId, snapshotSeq: head.snapshotSeq, offset: 0, length: MAX_SNAPSHOT_CHUNK_BYTES + 1 })).rejects.toThrow();
		// An account with no snapshot answers inline, chunked asked or not.
		const fresh = await app.signIn();
		const empty = await fresh.api.sync.bootstrap.query({ deviceId: fresh.deviceId, chunked: true });
		expect(empty.chunked).toBeUndefined();
		expect(empty.snapshotSeq).toBe(0);
		expect(empty.snapshot.length).toBeGreaterThan(0);
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
		// Both logs went quiet a while ago (the quiet-period rule, tested below).
		await app.pg.query(`update curator.library_op set received_at = now() - interval '10 minutes' where user_id = $1`, [busy.userId]);

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

	it('waits for a quiet log (5 min) unless the last snapshot is an hour old, and skips users with a live batch', async () => {
		const opts = { ...DEFAULT_DUE_OPTIONS, minOps: 20 };
		const mine = (r: Awaited<ReturnType<typeof runDueSnapshots>>, ids: string[]) => r.filter((x) => ids.includes(x.userId)).map((x) => x.status);

		// A flood still arriving: worth a snapshot (past minOps), not due.
		const flood = await app.signIn();
		await flood.api.sync.push.mutate({ deviceId: flood.deviceId, ops: sampleLibrary(flood.deviceId, 2) });
		expect(mine(await runDueSnapshots(app.db, app.deps.log, opts), [flood.userId])).toEqual([]);
		// Quiet for 5 minutes: due.
		await app.pg.query(`update curator.library_op set received_at = now() - interval '6 minutes' where user_id = $1`, [flood.userId]);
		expect(mine(await runDueSnapshots(app.db, app.deps.log, opts), [flood.userId])).toEqual(['built']);

		// Still flooding, but the last snapshot is over an hour old: due anyway,
		// so a steady stream gets one an hour, not one per 15-minute sweep.
		await flood.api.sync.push.mutate({ deviceId: flood.deviceId, ops: sampleLibrary(flood.deviceId, 2) });
		expect(mine(await runDueSnapshots(app.db, app.deps.log, opts), [flood.userId])).toEqual([]);
		await app.pg.query(`update curator.library_snapshot set created_at = now() - interval '61 minutes' where user_id = $1`, [flood.userId]);
		expect(mine(await runDueSnapshots(app.db, app.deps.log, opts), [flood.userId])).toEqual(['built']);

		// An open batch: skipped by the sweep, and by a direct build too (it
		// is about to add to the log; the sweep after its commit builds one).
		const batching = await app.signIn();
		await batching.api.sync.push.mutate({ deviceId: batching.deviceId, ops: sampleLibrary(batching.deviceId, 2) });
		await app.pg.query(`update curator.library_op set received_at = now() - interval '1 hour' where user_id = $1`, [batching.userId]);
		await batching.api.sync.batchBegin.mutate({ deviceId: batching.deviceId, label: 'backfill' });
		expect(mine(await runDueSnapshots(app.db, app.deps.log, opts), [batching.userId])).toEqual([]);
		expect(await buildSnapshot(app.db, batching.userId)).toEqual({ userId: batching.userId, status: 'batch_pending' });
	});

	it('moves bodies as bytea: no base64 inside Postgres on build, bootstrap or chunk reads', async () => {
		const seen: string[] = [];
		const spy: Db = {
			query: (text, params) => {
				seen.push(text);
				return app.db.query(text, params);
			},
			exec: (text) => app.db.exec(text),
			begin: (fn) =>
				app.db.begin((tx) =>
					fn({
						query: (text, params) => {
							seen.push(text);
							return tx.query(text, params);
						},
						exec: (text) => tx.exec(text),
					}),
				),
			close: () => Promise.resolve(),
		};
		const { userId, deviceId, api } = await app.signIn();
		const all = sampleLibrary(deviceId, 3);
		await api.sync.push.mutate({ deviceId, ops: all });
		const built = await buildSnapshot(spy, userId);
		expect(built.status).toBe('built');
		// A second, incremental build reads the first body back.
		await api.sync.push.mutate({ deviceId, ops: sampleLibrary(deviceId, 1) });
		expect((await buildSnapshot(spy, userId)).status).toBe('built');
		const caller = { sessionId: null };
		const inline = await bootstrap(spy, userId, caller, {});
		const head = await bootstrap(spy, userId, caller, { chunked: true });
		const piece = await snapshotChunk(spy, userId, caller, { snapshotSeq: head.snapshotSeq, offset: 0, length: head.chunked!.totalBytes });
		expect(piece.data).toBe(inline.snapshot);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen.filter((q) => /encode\s*\(|decode\s*\(|base64/i.test(q))).toEqual([]);
		// And what came back is the snapshot of every op, byte for byte.
		const stored = await app.pg.query<{ body: Uint8Array }>('select body from curator.library_snapshot where user_id = $1 order by snapshot_seq desc limit 1', [userId]);
		expect(Buffer.from(stored.rows[0]!.body).toString('base64')).toBe(inline.snapshot);
	});
});
