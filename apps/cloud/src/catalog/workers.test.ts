// Desktops as catalogue workers: a device takes its user's week, is handed
// the due cursors of the user's follows, reports polls the cloud applies as
// its own, and never parks the cloud with a rate limit of its own. Made-up
// names.

import { describe, expect, it } from 'vitest';
import { CATALOG_TRACKERS, trackerKey, type CatalogClaim, type CatalogTrackerPoll, type CatalogWorkerDueInput } from '@curator/protocol';
import type { TrackerAdapter, TrackerPoll, TrackerTarget } from '@curator/catalog-readers';
import { createLogger } from '../log.js';
import { createTestApp, errorReason, type TestApp } from '../test/harness.js';
import { providerPauses } from './tracking.js';
import { runTrackers } from './trackers/sweep.js';

const quiet = createLogger(() => {});
const DAY = 86400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const artist = (id: string, name: string): CatalogClaim => ({ provider: 'spotify', kind: 'artist', providerId: id, name, url: `https://open.spotify.com/artist/${id}` });
const release = (id: string, title: string, by: CatalogClaim[], date: string): CatalogClaim => ({
	provider: 'spotify',
	kind: 'release',
	providerId: id,
	name: title,
	url: `https://open.spotify.com/album/${id}`,
	facts: { releaseDate: date },
	artists: by,
	recordings: [{ provider: 'spotify', kind: 'recording', providerId: `${id}-1`, name: `${title} (Original Mix)`, artists: by, facts: { trackNumber: 1 } }],
});
// What a desktop's reader would report for the artist: one fresh single.
const pollOf = (children: CatalogClaim[], calls = 2): CatalogTrackerPoll => ({ children, listingHash: `h:${children.map((c) => c.providerId).join(',')}`, cursor: { seen: children.map((c) => c.providerId) }, calls });

// Events are visible to feed.events once their first_seen_at has settled.
const settle = (app: TestApp) => app.pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);

// The cloud's own Spotify reader, for the pass that must stand aside.
class CloudSpotify implements TrackerAdapter {
	readonly provider = 'spotify' as const;
	readonly kinds = ['artist'] as const;
	readonly callsPerPoll = 4;
	polled: string[] = [];
	async poll(target: TrackerTarget): Promise<TrackerPoll> {
		this.polled.push(target.object.name);
		return pollOf([release('cloud-new', 'Cloud Single', [artist('sa1', 'Northfold')], iso(Date.now() - DAY))]);
	}
}

// Every tracker checked: the Refresh menu's default.
const ALL_TRACKERS = CATALOG_TRACKERS.map((t) => trackerKey(t.kind, t.provider));

async function setup() {
	const app = await createTestApp();
	const fan = await app.signIn('desk-1');
	const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: artist('sa1', 'Northfold'), source: 'manual' });
	const due = (providers: ('spotify' | 'deezer' | 'youtube')[] = ['spotify', 'deezer'], paused?: { provider: 'spotify' | 'deezer'; until: number }[], over: Partial<CatalogWorkerDueInput> = {}) =>
		fan.api.catalog.workerDue.mutate({ deviceId: fan.deviceId, providers, trackers: ALL_TRACKERS, ...(paused ? { paused } : {}), ...over });
	const cloud = new CloudSpotify();
	const cloudPass = () => runTrackers({ db: app.db, log: quiet, adapters: [cloud], holder: 'cloud:1', sleep: async () => {} });
	return { app, fan, objectId: w.watch.object.id, due, cloud, cloudPass };
}

const cursorOf = (app: TestApp, objectId: string) =>
	app.db
		.query<{ lease_holder: string | null; last_reported_by: string | null; last_error: string | null; fail_count: unknown; due_in_s: unknown; ran: boolean }>(
			`select lease_holder, last_reported_by, last_error, fail_count, extract(epoch from next_due_at - now()) as due_in_s, last_run_at is not null as ran
			from curator.catalog_cursor where object_id = $1 and provider = 'spotify'`,
			[objectId],
		)
		.then((r) => r[0]!);

describe('workerDue', () => {
	it('takes the week, is handed the due cursors of its user’s follows, and the cloud stands aside', async () => {
		const { app, fan, objectId, due, cloud, cloudPass } = await setup();
		const r = await due();
		expect(r).toMatchObject({ active: true, tasks: [{ objectId, provider: 'spotify', kind: 'artist', target: { object: { name: 'Northfold' }, representation: { providerId: 'sa1' }, cursor: {} }, minGapMs: 1000 }] });
		expect(r.weekEndsAt).toBeGreaterThan(Date.now());
		expect(await cursorOf(app, objectId)).toMatchObject({ lease_holder: `device:${fan.deviceId}` });
		const [budget] = await app.db.query<{ used: unknown }>(`select units_used as used from curator.provider_budget where provider = 'spotify'`);
		expect(Number(budget!.used)).toBe(4);

		// Leased: a second call hands nothing more; the cloud's pass reads around it.
		expect((await due()).tasks).toEqual([]);
		expect((await cloudPass())[0]!.claimed).toBe(0);
		expect(cloud.polled).toEqual([]);

		// The lease lapsed without a report and the worker is still live: the cloud leaves the cursor to it...
		await app.pg.query(`update curator.catalog_cursor set lease_until = now() - interval '1 minute'`);
		expect((await cloudPass())[0]!.claimed).toBe(0);
		// ...until it is a day overdue.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '25 hours'`);
		expect((await cloudPass())[0]).toMatchObject({ claimed: 1, polled: 1 });
		expect(cloud.polled).toEqual(['Northfold']);
	});

	it('refuses a provider the device does not offer, and the cloud’s keyed ones', async () => {
		const { app, due } = await setup();
		await app.pg.query(`insert into curator.catalog_cursor (object_id, provider) select id, 'youtube' from curator.catalog_object where kind = 'artist'`);
		expect((await due(['deezer', 'youtube'])).tasks).toEqual([]);
	});

	it('gives a second device of the same user nothing until the first goes quiet', async () => {
		const { app, fan, due } = await setup();
		await fan.api.account.registerDevice.mutate({ deviceId: 'desk-2', name: 'Studio', platform: 'win32' });
		const second = () => fan.api.catalog.workerDue.mutate({ deviceId: 'desk-2', providers: ['spotify'], trackers: ALL_TRACKERS });
		expect(await due()).toMatchObject({ active: true });
		expect(await second()).toMatchObject({ active: false, tasks: [] });
		await app.pg.query(`update curator.catalog_worker set checked_in_at = now() - interval '7 hours'`);
		expect(await second()).toMatchObject({ active: true });
		expect(await due()).toMatchObject({ active: false });
		// A new week: whoever asks first.
		await app.pg.query(`update curator.catalog_worker set week_of = week_of - 7`);
		expect(await due()).toMatchObject({ active: true });
	});

	it('is refused for a device the account does not know', async () => {
		const { fan } = await setup();
		expect(await errorReason(fan.api.catalog.workerDue.mutate({ deviceId: 'ghost', providers: ['spotify'], trackers: ALL_TRACKERS }))).toMatchObject({ reason: 'device_not_registered' });
	});

	// The Refresh menu's checkboxes: unchecked means nobody reads it.
	it('reads only the trackers its user checked, and the cloud reads an unchecked one for nobody', async () => {
		const { app, due, cloudPass, cloud } = await setup();
		// Artists on Spotify unchecked: the device is handed nothing of it...
		expect((await due(['spotify', 'deezer'], undefined, { trackers: ['artist/deezer', 'label/spotify'] })).tasks).toEqual([]);
		// ...and the cloud leaves it too, even once it is a day overdue.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '25 hours'`);
		expect((await cloudPass())[0]!.claimed).toBe(0);
		expect(cloud.polled).toEqual([]);
		// Checked again: read.
		expect((await due()).tasks).toHaveLength(1);
	});

	it('leaves a checked source the device cannot read to the cloud, and a never-said user to the defaults', async () => {
		const { app, fan, objectId, due, cloudPass, cloud } = await setup();
		// Spotify checked but not offered (no login vends): the cloud reads it as before.
		expect((await due(['deezer'])).tasks).toEqual([]);
		expect((await cloudPass())[0]).toMatchObject({ claimed: 1, polled: 1 });
		expect(cloud.polled).toEqual(['Northfold']);

		// A second user follows the same artist and never ran the worker: wanted
		// by their defaults even when the first unchecked it.
		const other = await app.signIn('desk-9');
		await other.api.catalog.watch.mutate({ deviceId: other.deviceId, objectId, source: 'manual' });
		await due(['spotify', 'deezer'], undefined, { trackers: ['artist/deezer'] });
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now(), lease_until = null where object_id = $1`, [objectId]);
		expect((await cloudPass())[0]).toMatchObject({ claimed: 1 });
		expect(cloud.polled).toEqual(['Northfold', 'Northfold']);
		void fan;
	});

	// A Refresh from the desktop: the user's follows of a kind become due on
	// the checked sources, in the same call that leases them.
	it('checks the user’s follows of a kind now, leaves the hour’s reads alone and another user’s follows untouched', async () => {
		const { app, fan, objectId, due } = await setup();
		const other = await app.signIn('desk-9');
		const theirs = await other.api.catalog.watch.mutate({ deviceId: other.deviceId, claim: artist('sa7', 'Amber Tide'), source: 'manual' });
		const label = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'beatport', kind: 'label', providerId: 'l1', name: 'Northfold Records' }, source: 'manual' });
		// Everything read ten minutes ago, nothing due: a check leaves it alone.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() + interval '1 day', last_run_at = now() - interval '10 minutes'`);
		const recent = await due(['spotify', 'deezer'], undefined, { check: { kind: 'artist' } });
		expect(recent.check).toMatchObject({ queued: 0, byProvider: [{ provider: 'spotify', queued: 0, recent: 1 }] });
		expect(recent.tasks).toEqual([]);

		// Read two hours ago: due now, and leased by the same call.
		await app.pg.query(`update curator.catalog_cursor set last_run_at = now() - interval '2 hours'`);
		const r = await due(['spotify', 'deezer'], undefined, { check: { kind: 'artist' } });
		expect(r.check).toMatchObject({ queued: 1, byProvider: [{ provider: 'spotify', queued: 1 }] });
		expect(r.tasks.map((t) => [t.objectId, t.provider])).toEqual([[objectId, 'spotify']]);
		const dueNow = async () => app.db.query<{ object_id: string; provider: string }>(`select object_id, provider from curator.catalog_cursor where next_due_at <= now() order by provider`);
		expect(await dueNow()).toEqual([{ object_id: objectId, provider: 'spotify' }]);

		// No kind: every checked kind of the user's. The label's Beatport cursor
		// joins (the artist's is being read now); the other user's artist never does.
		const all = await due(['spotify', 'deezer'], undefined, { check: {}, trackers: ['artist/spotify', 'label/beatport'] });
		expect(all.check).toMatchObject({ queued: 1, byProvider: [{ provider: 'beatport', queued: 1 }, { provider: 'spotify', reading: 1 }] });
		expect(await dueNow()).toEqual([{ object_id: label.watch.object.id, provider: 'beatport' }, { object_id: objectId, provider: 'spotify' }]);
		void theirs;
	});
});

describe('workerReport', () => {
	it('applies a poll as the cloud would: the cursor moves, the event is raised and says who, the run names the device', async () => {
		const { app, fan, objectId, due } = await setup();
		await due();
		const poll = pollOf([release('new', 'New Single', [artist('sa1', 'Northfold')], iso(Date.now() - 2 * DAY)), release('old', 'Old Album', [artist('sa1', 'Northfold')], iso(Date.now() - 400 * DAY))], 6);
		const r = await fan.api.catalog.workerReport.mutate({ deviceId: fan.deviceId, results: [{ objectId, provider: 'spotify', outcome: { poll } }] });
		expect(r).toEqual({ applied: 1, stale: 0, events: 1 });

		expect(await cursorOf(app, objectId)).toMatchObject({ lease_holder: null, last_reported_by: `device:${fan.deviceId}`, last_error: null, ran: true });
		// Daily, or the Friday window if that comes first (cadence.ts).
		expect(Number((await cursorOf(app, objectId)).due_in_s)).toBeGreaterThan(3600);
		await settle(app);
		const { events } = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(events.map((e) => [e.kind, (e.card as { title: string }).title])).toEqual([['new_release', 'New Single']]);
		expect(await app.db.query(`select raised_by from curator.catalog_event`)).toEqual([{ raised_by: `device:${fan.deviceId}` }]);
		expect(await app.db.query(`select worker, claimed, calls, events, failed, finished_at is not null as done from curator.tracker_run`)).toEqual([
			{ worker: `device:${fan.deviceId}`, claimed: 1, calls: 6, events: 1, failed: 0, done: true },
		]);
		// Reserved 4 at due; the two extra calls debited once.
		const [budget] = await app.db.query<{ used: unknown }>(`select units_used as used from curator.provider_budget where provider = 'spotify'`);
		expect(Number(budget!.used)).toBe(6);

		// A resend meets a lease the apply cleared: stale, nothing twice.
		const again = await fan.api.catalog.workerReport.mutate({ deviceId: fan.deviceId, results: [{ objectId, provider: 'spotify', outcome: { poll } }] });
		expect(again).toEqual({ applied: 0, stale: 1, events: 0 });
		expect(await app.db.query(`select count(*)::int as n from curator.catalog_event`)).toEqual([{ n: 1 }]);
	});

	it('is stale for a cursor the device does not hold', async () => {
		const { app, fan, objectId } = await setup();
		await fan.api.account.registerDevice.mutate({ deviceId: 'desk-2', name: 'Studio', platform: 'win32' });
		await fan.api.catalog.workerDue.mutate({ deviceId: fan.deviceId, providers: ['spotify'], trackers: ALL_TRACKERS });
		const r = await fan.api.catalog.workerReport.mutate({ deviceId: 'desk-2', results: [{ objectId, provider: 'spotify', outcome: { poll: pollOf([]) } }] });
		expect(r).toEqual({ applied: 0, stale: 1, events: 0 });
		expect(await cursorOf(app, objectId)).toMatchObject({ lease_holder: `device:${fan.deviceId}`, ran: false });
	});

	it('a Spotify wait one device met parks the cloud too: one client id, one quota', async () => {
		const { app, fan, objectId, due, cloudPass, cloud } = await setup();
		// A second follow on the same provider, due as well.
		const other = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: artist('sa2', 'Amber Tide'), source: 'manual' });
		const first = await due();
		expect(first.tasks).toHaveLength(2);
		const r = await fan.api.catalog.workerReport.mutate({
			deviceId: fan.deviceId,
			results: [
				{ objectId, provider: 'spotify', outcome: { error: { message: 'rate limited (3600s)', rateLimitedSec: 3600 } } },
				{ objectId: other.watch.object.id, provider: 'spotify', outcome: { error: { message: 'rate limited (3600s)', rateLimitedSec: 3600 } } },
			],
		});
		expect(r).toEqual({ applied: 2, stale: 0, events: 0 });
		const c = await cursorOf(app, objectId);
		expect(c).toMatchObject({ last_error: 'rate limited (3600s)', last_reported_by: `device:${fan.deviceId}` });
		expect(Number(c.fail_count)).toBe(0);
		expect(Number(c.due_in_s)).toBeGreaterThan(3500);

		expect(await providerPauses(app.db)).toMatchObject([{ provider: 'spotify' }]);
		expect(await providerPauses(app.db, { holder: `device:${fan.deviceId}` })).toMatchObject([{ provider: 'spotify' }]);
		// The first cursor comes due while the pause holds (the pause is the
		// latest poll's wait, the second cursor's): the master tells the device
		// and hands it no Spotify, and reads none itself either — Spotify's
		// limit is per client id, which the master shares with the device —
		// not even once the cursor is a day overdue.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() where object_id = $1`, [objectId]);
		const next = await due();
		expect(next.pauses).toMatchObject([{ provider: 'spotify' }]);
		expect(next.tasks).toEqual([]);
		expect((await cloudPass())[0]).toMatchObject({ claimed: 0, budgetOut: true });
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '25 hours' where object_id = $1`, [objectId]);
		expect((await cloudPass())[0]).toMatchObject({ claimed: 0, budgetOut: true });
		// The wait over (the second cursor's too), the overdue cursor is the
		// cloud's to read around the live worker.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute' where object_id = $1`, [other.watch.object.id]);
		expect((await cloudPass())[0]).toMatchObject({ claimed: 1, polled: 1 });
		expect(cloud.polled).toEqual(['Northfold']);
	});

	it('backs a failed poll off, and a provider the device parked itself is not handed out', async () => {
		const { app, fan, objectId, due } = await setup();
		await due();
		await fan.api.catalog.workerReport.mutate({ deviceId: fan.deviceId, results: [{ objectId, provider: 'spotify', outcome: { error: { message: 'HTTP 500', rateLimitedSec: null } } }] });
		const c = await cursorOf(app, objectId);
		expect(c).toMatchObject({ last_error: 'HTTP 500' });
		expect(Number(c.fail_count)).toBe(1);
		expect(Number(c.due_in_s)).toBeGreaterThan(14 * 60);
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now()`);
		expect((await due(['spotify', 'deezer'], [{ provider: 'spotify', until: Date.now() + 60_000 }])).tasks).toEqual([]);
		expect((await due()).tasks).toHaveLength(1);
	});
});
