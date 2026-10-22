// A batch the size of the main library's v4 backfill (~116k ops, 2026-10-21):
// staged, committed with the production chunking, and timed per statement.
// The point is the statement sizes: every one must stay far inside the API
// role's 30 s statement_timeout (sql/roles.sql), which a single
// INSERT ... SELECT of the whole batch would not on a saturated database.
//
// PGlite is single-threaded WASM, so absolute times are an upper-bound proxy
// for the real Postgres, not a measurement of it; the shape (how statement
// time grows with chunk size, and that it does not grow with the batch) is
// what carries over. The numbers are printed for the record.
//
// 20k ops in the regular run (~10 s); CURATOR_BATCH_SCALE_OPS=120000 runs
// the full size (~2 min). Measured 2026-10-21 at 120k set-meta ops, PGlite
// on the dev machine: staging 53 ms median / 72 ms max per 500-op call; the
// commit's move in 16 statements of up to ~8k ops (the size follows a 3 s
// target), median 2.97 s, max 3.31 s; the whole commit 57 s including the
// 15.2 s snapshot build it ran then. The server builds no snapshot any more
// (the master publishes), so the commit is the moves plus the publish.

import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, opSchemaVersion, type Op } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createTestApp, opsFor, type TestApp } from '../test/harness.js';
import type { CommitStep } from './batch.js';

const OPS = Number(process.env['CURATOR_BATCH_SCALE_OPS'] ?? 20_000);

let app: TestApp;
beforeAll(async () => {
	// batchCommit waits for the whole commit, however long PGlite takes.
	app = await createTestApp({ batch: { commitWaitMs: 30 * 60_000 } });
});
afterAll(() => app.db.close());

// Set-meta ops: the backfill's commonest kind and its biggest rows (~400
// bytes of payload each).
function backfillOps(deviceId: string, n: number): Op[] {
	const op = opsFor(deviceId);
	const out: Op[] = [];
	for (let i = 0; i < n; i++) {
		out.push(
			op('library_track', 'set-meta', randomUUID(), {
				source: 'spotify',
				title: `Generated Track Title Number ${i} (Extended Mix)`,
				artists: [{ name: `Artist ${i % 997}`, role: 'main' }, { name: `Featured ${i % 31}`, role: 'featured' }],
				album_title: `An Album Of Generated Music ${i % 4001}`,
				duration_sec: 300 + (i % 120),
				isrc: `GBXYZ${String(i).padStart(7, '0')}`,
				release_date: '2024-05-17',
				label: `Label ${i % 211}`,
				genre: 'Melodic House & Techno',
				cover_url: `https://i.scdn.co/image/ab67616d0000b273${i.toString(16).padStart(24, '0')}`,
				track_number: (i % 12) + 1,
				disc_number: 1,
			}),
		);
	}
	return out;
}

describe(`a ${OPS.toLocaleString('en')}-op batch`, () => {
	it('stages, commits in bounded statements, and publishes', { timeout: 30 * 60_000 }, async () => {
		const { userId, deviceId, api } = await app.signIn();
		const ops = backfillOps(deviceId, OPS);
		expect(opSchemaVersion(ops[0]!)).toBeLessThanOrEqual(SCHEMA_VERSION);
		const { batchId } = await api.sync.batchBegin.mutate({ deviceId, label: 'backfill', expectedOps: OPS });

		// Staging through the API, timed: what each of the desktop's ~240
		// batchPush calls costs the database.
		const stageMs: number[] = [];
		const viaApi = Math.min(OPS, 10 * 500);
		for (let i = 0; i < viaApi; i += 500) {
			const t0 = performance.now();
			const r = await api.sync.batchPush.mutate({ deviceId, batchId, ops: ops.slice(i, i + 500) });
			stageMs.push(performance.now() - t0);
			expect(r.rejected).toEqual([]);
		}
		// The rest straight into the staging table as the user (the same
		// rows; the API path is proven above and in batch.test.ts).
		for (let i = viaApi; i < OPS; i += 5000) {
			const chunk = ops.slice(i, i + 5000);
			await asUser(app.pg, userId, (tx) =>
				tx.query(
					`insert into curator.library_op_staged (batch_id, op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload)
					select $2::uuid, (e.op ->> 'op_id')::uuid, e.op ->> 'device_id', (e.op ->> 'client_ts')::bigint,
						(e.op ->> 'schema_version')::int, e.op ->> 'entity', e.op ->> 'entity_id', e.op ->> 'kind', e.op -> 'payload'
					from jsonb_array_elements($1::text::jsonb) with ordinality as e(op, ord) order by e.ord`,
					[JSON.stringify(chunk), batchId],
				),
			);
		}
		await app.pg.query(`update curator.library_op_batch set staged_ops = $2 where id = $1`, [batchId, OPS]);

		// The commit with production chunking, each step timed from the hook.
		const steps: Array<{ step: CommitStep; at: number }> = [];
		app.deps.batch.beforeStep = async (step) => {
			steps.push({ step, at: performance.now() });
		};
		const t0 = performance.now();
		const res = await api.sync.batchCommit.mutate({ deviceId, batchId });
		const totalMs = performance.now() - t0;
		app.deps.batch.beforeStep = undefined;
		expect(res).toMatchObject({ status: 'committed', movedOps: OPS, totalOps: OPS, rejected: [] });

		// A move step runs from one 'move' hook to the next (the last one
		// finds nothing and hands over to the publish).
		const moveMs: number[] = [];
		for (let i = 0; i < steps.length - 1; i++) if (steps[i]!.step === 'move' && steps[i + 1]!.step === 'move') moveMs.push(steps[i + 1]!.at - steps[i]!.at);
		const stats = (xs: number[]) => {
			const s = [...xs].sort((a, b) => a - b);
			return { n: s.length, median: Math.round(s[Math.floor(s.length / 2)] ?? 0), p90: Math.round(s[Math.floor(s.length * 0.9)] ?? 0), max: Math.round(s[s.length - 1] ?? 0) };
		};
		// A pull right after publishing pages the log as usual.
		const page = await api.sync.pull.query({ afterSeq: 0, deviceId });
		expect(page.ops.length).toBe(1000);
		const report = {
			ops: OPS,
			stagePer500: stats(stageMs),
			moveChunks: stats(moveMs),
			commitTotalMs: Math.round(totalMs),
		};
		console.log('batch scale', JSON.stringify(report));

		// Every statement far inside 30 s, even on PGlite.
		expect(report.moveChunks.max).toBeLessThan(15_000);
		expect(report.stagePer500.max).toBeLessThan(15_000);
		const n = await app.pg.query<{ n: number }>(`select count(*)::int as n from curator.library_op where user_id = $1`, [userId]);
		expect(n.rows[0]!.n).toBe(OPS);
	});
});
