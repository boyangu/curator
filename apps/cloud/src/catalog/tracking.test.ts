// The back office's Tracking page: what the trackers are doing, "check now"
// and the provider pause they both respect. Made-up names.

import { describe, expect, it } from 'vitest';
import { createBackofficeHandler } from '../backoffice/handler.js';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { ingestClaims } from './ingest.js';
import { runTrackers } from './trackers/sweep.js';
import { TrackerRateLimitedError, type TrackerAdapter, type TrackerPoll } from '@curator/catalog-readers';
import { providerPauses } from './tracking.js';
import { ensureCursors } from './watches.js';

const quiet = createLogger(() => {});
const label = (id: string, name: string) => ({ provider: 'beatport' as const, kind: 'label' as const, providerId: id, name });

// Two followed labels with a Beatport page each, one unfollowed, and a
// followed artist Deezer tracks. Followed by a real user (a cursor is read
// only while some follower wants it: tracking.ts wantedSql).
async function seeded(): Promise<{ app: TestApp; fan: Awaited<ReturnType<TestApp['signIn']>>; north: string; amber: string; cold: string; glass: string }> {
	const app = await createTestApp();
	const ids = await withSystemTx(app.db, async (tx) => {
		const { outcomes } = await ingestClaims(
			tx,
			[label('l1', 'Northfold Records'), label('l2', 'Amber Tide'), label('l3', 'Cold Shore'), { provider: 'deezer', kind: 'artist', providerId: 'a1', name: 'Glass Rivers' }],
			{ reason: 'library_import' },
		);
		const [north, amber, cold, glass] = outcomes.map((o) => o.objectId) as [string, string, string, string];
		return { north, amber, cold, glass };
	});
	const fan = await app.signIn('desk-1');
	for (const objectId of [ids.north, ids.amber, ids.glass]) await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, objectId, source: 'manual' });
	await withSystemTx(app.db, async (tx) => {
		await ensureCursors(tx, ids.north);
		await ensureCursors(tx, ids.amber);
		await ensureCursors(tx, ids.glass);
		// Deezer tracks labels by name too; one source per label reads simpler here.
		await tx.query(`delete from curator.catalog_cursor where provider = 'deezer' and object_id = any($1::uuid[])`, [`{${ids.north},${ids.amber}}`]);
		// Nothing is due unless a test says so.
		await tx.query(`update curator.catalog_cursor set next_due_at = now() + interval '1 day', last_run_at = now() - interval '1 day'`);
	});
	return { app, fan, ...ids };
}

const poll = (): TrackerPoll => ({ children: [], listingHash: 'same', cursor: {}, calls: 1 });
function beatport(answer: () => TrackerPoll, log: string[]): TrackerAdapter {
	return {
		provider: 'beatport',
		kinds: ['label'],
		callsPerPoll: 1,
		poll: async (t) => {
			log.push(t.object.name);
			return answer();
		},
	};
}
const sweep = (app: TestApp, adapter: TrackerAdapter) => runTrackers({ db: app.db, log: quiet, adapters: [adapter], holder: 'test', sleep: async () => {} });
const dueCount = async (app: TestApp, provider: string) =>
	Number((await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_cursor where provider = $1 and next_due_at <= now()`, [provider]))[0]!.n);

describe('trackingCheck', () => {
	it('makes everything followed due, by object, kind or provider, and says so', async () => {
		const { app, north, glass } = await seeded();
		const ops = adminOps(app.db, {});

		expect(await ops.trackingCheck({ id: north })).toMatchObject({ queued: 1, byProvider: [{ provider: 'beatport', queued: 1 }], started: false });
		expect(await dueCount(app, 'beatport')).toBe(1);

		// The first is due already: said, not moved.
		expect(await ops.trackingCheck({ kind: 'label' })).toMatchObject({ queued: 1, byProvider: [{ provider: 'beatport', queued: 1, alreadyDue: 1 }] });
		expect(await dueCount(app, 'deezer')).toBe(0);

		expect(await ops.trackingCheck({ all: true, provider: 'deezer' })).toMatchObject({ queued: 1, byProvider: [{ provider: 'deezer', queued: 1 }] });
		expect(await dueCount(app, 'deezer')).toBe(1);
		expect((await ops.trackingCheck({ id: glass })).queued).toBe(0);
	});

	it('refuses a check that names nothing', async () => {
		const { app } = await seeded();
		await expect(adminOps(app.db, {}).trackingCheck({})).rejects.toThrow(/what to check/);
	});

	it('leaves what was read within the hour when checking in bulk, not when asked by name', async () => {
		const { app, north } = await seeded();
		await app.db.query(`update curator.catalog_cursor set last_run_at = now() - interval '10 minutes' where object_id = $1`, [north]);
		const ops = adminOps(app.db, {});
		expect(await ops.trackingCheck({ kind: 'label' })).toMatchObject({ queued: 1, byProvider: [{ queued: 1, recent: 1 }] });
		expect(await ops.trackingCheck({ id: north })).toMatchObject({ queued: 1 });
	});

	it('does not touch a cursor being read', async () => {
		const { app, north } = await seeded();
		await app.db.query(`update curator.catalog_cursor set lease_holder = 'w', lease_until = now() + interval '5 minutes' where object_id = $1`, [north]);
		const r = await adminOps(app.db, {}).trackingCheck({ id: north });
		expect(r).toMatchObject({ queued: 0, byProvider: [{ reading: 1 }] });
		const [c] = await app.db.query<{ lease_holder: string }>(`select lease_holder from curator.catalog_cursor where object_id = $1`, [north]);
		expect(c!.lease_holder).toBe('w');
	});

	it('kicks the host’s pass only when it queued something', async () => {
		const { app, north } = await seeded();
		let kicks = 0;
		const ops = adminOps(app.db, {}, { kick: () => { kicks++; } });
		expect(await ops.trackingCheck({ id: north })).toMatchObject({ queued: 1, started: true });
		expect(kicks).toBe(1);
		expect(await ops.trackingCheck({ id: north })).toMatchObject({ queued: 0, started: false });
		expect(kicks).toBe(1);
	});
});

describe('a provider that asked us to wait', () => {
	it('gets no call until the wait has passed, and a success ends the pause', async () => {
		const { app } = await seeded();
		await app.db.query(`update curator.catalog_cursor set next_due_at = now() where provider = 'beatport'`);
		const asked: string[] = [];
		let limited = true;
		const adapter = beatport(() => {
			if (limited) throw new TrackerRateLimitedError(3600);
			return poll();
		}, asked);

		const [first] = await sweep(app, adapter);
		expect(first).toMatchObject({ polled: 0, failed: 1, budgetOut: true });
		expect(asked).toHaveLength(1);
		const [pause] = await providerPauses(app.db);
		expect(pause).toMatchObject({ provider: 'beatport', error: 'rate limited (3600s)' });
		expect(pause!.until).toBeGreaterThan(Date.now() + 3500_000);

		// The other label is still due, and is not tried: the block would answer
		// the same and push the wait out again.
		const [second] = await sweep(app, adapter);
		expect(second).toMatchObject({ claimed: 0, budgetOut: true });
		expect(asked).toHaveLength(1);
		expect((await providerPauses(app.db))[0]!.until).toBe(pause!.until);

		// A check leaves it alone too.
		const r = await adminOps(app.db, {}).trackingCheck({ kind: 'label' });
		expect(r).toMatchObject({ queued: 0, byProvider: [{ provider: 'beatport', paused: 2 }], pauses: [{ provider: 'beatport' }] });

		// The wait passes: the next poll goes out, and a success clears the pause.
		await app.db.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 second' where provider = 'beatport'`);
		limited = false;
		await sweep(app, adapter);
		expect(await providerPauses(app.db)).toEqual([]);
		expect(asked).toHaveLength(3);
	});

	it('an old limit on one cursor is no pause once a later poll went through', async () => {
		const { app, north, amber } = await seeded();
		await app.db.query(`update curator.catalog_cursor set last_error = 'rate limited (21600s)', last_run_at = now() - interval '2 hours', next_due_at = now() + interval '4 hours' where object_id = $1`, [north]);
		await app.db.query(`update curator.catalog_cursor set last_error = null, last_run_at = now() - interval '1 hour' where object_id = $1`, [amber]);
		expect(await providerPauses(app.db)).toEqual([]);
	});
});

describe('the Tracking page’s reads', () => {
	const get = async (app: TestApp, path: string, opts = {}) => {
		const res = await createBackofficeHandler(app.db, opts)(new Request(`http://127.0.0.1/backoffice/api/${path}`));
		return { status: res!.status, body: (await res!.json()) as any };
	};

	it('sums the trackers per kind × source, with who reads them and the pass in flight', async () => {
		const { app, north } = await seeded();
		await app.db.query(`update curator.catalog_cursor set next_due_at = now(), last_error = 'HTTP 500', fail_count = 2 where object_id = $1`, [north]);
		await app.db.query(`insert into curator.tracker_run (kind, provider, worker, claimed, events, failed) values ('label', 'beatport', 'w', 2, 3, 1)`);
		const worker = { running: true, step: 'trackers', startedAt: 1, finishedAt: null };
		const { body } = await get(app, 'tracking', { worker: () => worker, readers: () => [{ provider: 'beatport', kinds: ['label'] }] });

		expect(body.worker).toEqual(worker);
		expect(body.kinds).toEqual([
			{ kind: 'artist', followed: 1, tracked: 1 },
			{ kind: 'label', followed: 2, tracked: 2 },
			{ kind: 'playlist', followed: 0, tracked: 0 },
			{ kind: 'genre', followed: 0, tracked: 0 },
		]);
		const row = (kind: string, provider: string) => body.trackers.find((t: any) => t.kind === kind && t.provider === provider);
		expect(row('label', 'beatport')).toMatchObject({ reader: true, cursors: 2, due: 1, failing: 1, never: 0, checkedDay: 0, read: 2, events: 3, failed: 1 });
		expect(row('artist', 'deezer')).toMatchObject({ reader: false, cursors: 1 });

		const away = (await get(app, 'tracking')).body;
		expect(away.worker).toBeNull();
		expect(away.trackers.find((t: any) => t.kind === 'label' && t.provider === 'beatport').reader).toBeNull();
	});

	it('lists what is followed by kind, source, state and name, most overdue first', async () => {
		const { app, north, amber, cold } = await seeded();
		await app.db.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 hour' where object_id = $1`, [north]);
		const names = async (qs: string) => (await get(app, `tracking/objects?${qs}`)).body.rows.map((r: { name: string }) => r.name);

		expect(await names('')).toEqual(['Northfold Records', 'Amber Tide', 'Glass Rivers']);
		expect(await names('kind=label')).toEqual(['Northfold Records', 'Amber Tide']);
		expect(await names('provider=deezer')).toEqual(['Glass Rivers']);
		expect(await names('kind=label&provider=beatport&state=due')).toEqual(['Northfold Records']);
		expect(await names('q=amber')).toEqual(['Amber Tide']);
		expect(await names('q=%25')).toEqual([]);

		const row = (await get(app, `tracking/objects?id=${amber}`)).body.rows[0];
		expect(row).toMatchObject({ name: 'Amber Tide', watchers: 1, cursors: [{ provider: 'beatport', reading: false, failCount: 0, lastError: null }] });
		// Named, an object nobody follows still answers, with no cursors.
		expect((await get(app, `tracking/objects?id=${cold}`)).body.rows[0]).toMatchObject({ watchers: 0, cursors: [] });
		expect((await get(app, 'tracking/objects?id=nope')).status).toBe(400);
	});

	it('shows the queue as lanes: waiting, processing, blocked and why, and the pace', async () => {
		const { app, north, amber, glass } = await seeded();
		// Beatport: one being read, one waiting, one read in the last hour.
		await app.db.query(`update curator.catalog_cursor set next_due_at = now() - interval '2 hours', lease_holder = 'w', lease_until = now() + interval '5 minutes' where object_id = $1`, [north]);
		await app.db.query(`update curator.catalog_cursor set next_due_at = now() - interval '30 minutes', last_run_at = now() - interval '10 minutes' where object_id = $1`, [amber]);
		// Deezer: due, but this process has no Deezer reader.
		await app.db.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 hour' where object_id = $1`, [glass]);
		await app.db.query(`insert into curator.catalog_enrich_task (object_id, need, provider, last_error) values ($1, 'backfill', 'beatport', 'HTTP 500')`, [north]);
		const opts = { readers: () => [{ provider: 'beatport', kinds: ['label'] }], readerNotes: () => [{ provider: 'deezer', kind: 'artist', why: 'no Deezer here' }] };
		const { body } = await get(app, 'queue', opts);

		const lane = (kind: string, provider: string) => body.lanes.find((l: any) => l.kind === kind && l.provider === provider);
		expect(lane('label', 'beatport')).toMatchObject({ lane: 'tracker', waiting: 1, processing: 1, blocked: 0, doneHour: 1, etaMin: 60 });
		expect(lane('label', 'beatport').oldestDueAt).toBeLessThan(Date.now() - 25 * 60_000);
		expect(lane('artist', 'deezer')).toMatchObject({ waiting: 0, blocked: 1, blockedWhy: 'no Deezer here' });
		expect(lane('backfill', 'beatport')).toMatchObject({ lane: 'task', waiting: 1, failing: 1, doneHour: null });
		// The seeding's ingest queues tasks of its own; the totals are the lanes' sums.
		const sum = (f: string) => body.lanes.reduce((n: number, l: any) => n + (l[f] ?? 0), 0);
		expect(body.totals).toEqual({ waiting: sum('waiting'), processing: 1, blocked: 1, failing: sum('failing'), doneHour: 1 });
		expect(body.worker).toBeNull();

		// A paused provider blocks its tasks too, and says until when.
		await app.db.query(`update curator.catalog_cursor set last_error = 'rate limited (3600s)', last_run_at = now(), next_due_at = now() + interval '1 hour' where object_id = $1`, [amber]);
		const paused = (await get(app, 'queue', opts)).body;
		expect(paused.lanes.find((l: any) => l.kind === 'backfill').blockedWhy).toBe('beatport asked us to wait');
		expect(paused.lanes.find((l: any) => l.kind === 'backfill').blockedUntil).toBeGreaterThan(Date.now() + 3500_000);
	});

	// The Refresh menu's choices reach the page: a source every follower
	// unchecked is counted as switched off and its due cursors as blocked.
	it('counts the cursors every follower switched off, and blocks them in the queue for that reason', async () => {
		const { app, fan, north } = await seeded();
		await app.db.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 hour' where provider = 'beatport'`);
		const opts = { readers: () => [{ provider: 'beatport', kinds: ['label'] }] };
		const row = async () => (await get(app, 'tracking', opts)).body.trackers.find((t: any) => t.kind === 'label' && t.provider === 'beatport');
		const lane = async () => (await get(app, 'queue', opts)).body.lanes.find((l: any) => l.kind === 'label' && l.provider === 'beatport');

		// Followed, but the one follower never ran the worker: wanted by default.
		expect(await row()).toMatchObject({ cursors: 2, unwanted: 0 });
		expect(await lane()).toMatchObject({ waiting: 2, blocked: 0, blockedWhy: null });

		await fan.api.catalog.workerDue.mutate({ deviceId: fan.deviceId, providers: ['deezer'], trackers: ['label/spotify'] });
		expect(await row()).toMatchObject({ cursors: 2, unwanted: 2, reader: true });
		expect(await lane()).toMatchObject({ waiting: 0, blocked: 2, blockedWhy: 'switched off by its followers' });

		// A second follower with defaults wants it again.
		const other = await app.signIn('desk-2');
		await other.api.catalog.watch.mutate({ deviceId: other.deviceId, objectId: north, source: 'manual' });
		expect(await row()).toMatchObject({ unwanted: 1 });
		expect(await lane()).toMatchObject({ waiting: 1, blocked: 1 });
	});

	it('finds what is followed but nothing can read, and a source filter does not break that', async () => {
		const { app, cold } = await seeded();
		await app.db.query(`update curator.catalog_object set watch_count = 1 where id = $1`, [cold]);
		const { body } = await get(app, 'tracking/objects?state=untracked&provider=beatport');
		expect(body).toMatchObject({ total: 1, rows: [{ name: 'Cold Shore', cursors: [] }] });
	});
});
