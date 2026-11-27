// Background work (background.ts) through the real procedures: the account's
// main desktop holds the week, its weekly reads queue what they created, and
// its next checks are handed those releases to complete — leased, so a check
// does not hand them twice, freed by the report that carries them.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim, CatalogDeviceProfile, CatalogTracker } from '@curator/protocol';
import { createTestApp, masterOp } from '../../test/harness.js';
import { withSystemTx } from '../../db/system-tx.js';
import { setWorkSetting } from './settings.js';

const ALL: CatalogTracker[] = ['artist/spotify'];
const PROFILE: CatalogDeviceProfile = { form: 'desktop', reader: 1, stores: ['spotify', 'deezer'] };
const ARTIST: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Northfold', url: 'https://open.spotify.com/artist/sa1' };
const NEW_RELEASE: CatalogClaim = { provider: 'spotify', kind: 'release', providerId: 'sr1', name: 'Hollow', url: 'https://open.spotify.com/album/sr1', artists: [ARTIST], facts: { releaseDate: '2026-11-20' } };

async function setup(opts: { background?: boolean } = {}) {
	const app = await createTestApp();
	const main = await app.signIn('desk-main');
	await main.api.account.registerDevice.mutate({ deviceId: 'desk-other', name: 'Studio', platform: 'win32' });
	// The account names its main desktop.
	await main.api.sync.push.mutate({ deviceId: main.deviceId, ops: [masterOp(main.deviceId, main.deviceId)] });
	await withSystemTx(app.db, async (tx) => {
		await setWorkSetting(tx, 'work.enabled', true);
		if (opts.background !== false) await setWorkSetting(tx, 'work.background.enabled', true);
	});
	const w = await main.api.catalog.watch.mutate({ deviceId: main.deviceId, claim: ARTIST, source: 'manual' });
	const due = (deviceId: string, over: { profile?: CatalogDeviceProfile } = {}) => main.api.catalog.workerDue.mutate({ deviceId, providers: ['spotify', 'deezer'], trackers: ALL, ...over });
	// The weekly read of the followed artist, by the main desktop, finding a new release.
	const weeklyRead = async () => {
		const first = await due(main.deviceId);
		const task = first.tasks.find((t) => t.objectId === w.watch.object.id)!;
		await main.api.catalog.workerReport.mutate({ deviceId: main.deviceId, results: [{ objectId: task.objectId, provider: 'spotify', outcome: { poll: { children: [NEW_RELEASE], listingHash: 'h1', cursor: { seen: ['sr1'] }, calls: 1 } } }] });
	};
	const releaseId = async () => (await app.db.query<{ id: string }>(`select id from curator.catalog_object where kind = 'release' and name = 'Hollow'`))[0]!.id;
	const queued = async () => (await app.db.query<{ n: number }>(`select count(*)::int as n from curator.catalog_work_queue`))[0]!.n;
	return { app, main, due, weeklyRead, releaseId, queued };
}

describe('the main desktop', () => {
	it('holds the week, and no other device of the account ever does — not even while it is quiet', async () => {
		const { app, main, due } = await setup();
		expect(await due('desk-other')).toMatchObject({ active: false, tasks: [] });
		expect(await due(main.deviceId)).toMatchObject({ active: true });
		await app.pg.query(`update curator.catalog_worker set checked_in_at = now() - interval '2 days'`);
		expect(await due('desk-other')).toMatchObject({ active: false });
		// Back: it takes the week again at once.
		expect(await due(main.deviceId)).toMatchObject({ active: true });
	});
});

describe('background work', () => {
	it('queues what a weekly read created, and hands it to the main desktop as work, leased to it', async () => {
		const { app, main, due, weeklyRead, releaseId, queued } = await setup();
		await weeklyRead();
		expect(await queued()).toBe(1);
		const id = await releaseId();
		const r = await due(main.deviceId, { profile: PROFILE });
		expect(r.work?.jobs.map((j) => j.id)).toEqual([`release:${id}`]);
		expect(r.work?.jobs[0]).toMatchObject({ kind: 'release', read: [{ provider: 'spotify', id: 'sr1' }] });
		expect(await app.db.query(`select device_id from curator.catalog_work_lease where job_id = $1`, [`release:${id}`])).toEqual([{ device_id: main.deviceId }]);
		// No profile: the desktop has work in hand, and is handed nothing more.
		expect((await due(main.deviceId)).work).toBeUndefined();
		// Asked again with nothing in hand (it restarted mid-run): its own job comes back to it.
		expect((await due(main.deviceId, { profile: PROFILE })).work?.jobs.map((j) => j.id)).toEqual([`release:${id}`]);
	});

	it('is never handed to another device of the account', async () => {
		const { due, weeklyRead } = await setup();
		await weeklyRead();
		expect(await due('desk-other', { profile: PROFILE })).toMatchObject({ active: false });
		expect((await due('desk-other', { profile: PROFILE })).work).toBeUndefined();
	});

	it('frees its lease when reported, and a release with nothing left to ask leaves the queue', async () => {
		const { app, main, due, weeklyRead, releaseId, queued } = await setup();
		await weeklyRead();
		const id = await releaseId();
		await due(main.deviceId, { profile: PROFILE });
		const full: CatalogClaim = { ...NEW_RELEASE, recordings: [{ provider: 'spotify', kind: 'recording', providerId: 'st1', name: 'Hollow', facts: { trackNumber: 1, durationSec: 300 } }] };
		const report = await main.api.catalog.workReport.mutate({
			deviceId: main.deviceId,
			idempotencyKey: 'background-0001:0',
			profile: PROFILE,
			results: [{ jobId: `release:${id}`, kind: 'release', found: [{ how: 'id', claim: full }], notFound: ['deezer'], checks: [] }],
		});
		expect(report.results).toEqual([{ jobId: `release:${id}`, outcome: 'saved' }]);
		expect(await app.db.query(`select 1 from curator.catalog_work_lease`)).toEqual([]);
		// Read, and Deezer said it has none: the next check finds nothing to ask.
		expect((await due(main.deviceId, { profile: PROFILE })).work).toBeUndefined();
		expect(await queued()).toBe(0);
	});

	it('is not queued or handed while background work is off for the account', async () => {
		const { main, due, weeklyRead, queued } = await setup({ background: false });
		await weeklyRead();
		expect(await queued()).toBe(0);
		expect((await due(main.deviceId, { profile: PROFILE })).work).toBeUndefined();
	});

	it("stops for a store once its share of the day is used, and keeps the release for later", async () => {
		const { app, main, due, weeklyRead, queued } = await setup();
		await weeklyRead();
		await withSystemTx(app.db, async (tx) => {
			await setWorkSetting(tx, 'work.per_day', { spotify: 100, deezer: 100 });
			await setWorkSetting(tx, 'work.background.share_pct', 50);
		});
		await app.pg.query(`insert into curator.provider_budget (provider, day, units_used) values ('spotify', (now() at time zone 'utc')::date, 60), ('deezer', (now() at time zone 'utc')::date, 60)
			on conflict (provider, day) do update set units_used = excluded.units_used`);
		expect((await due(main.deviceId, { profile: PROFILE })).work).toBeUndefined();
		expect(await queued()).toBe(1);
	});
});
