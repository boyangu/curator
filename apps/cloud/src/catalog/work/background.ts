// Background work ('catalog_background_work'): what an account's main desktop
// does on the check it already makes every minute (catalog.workerDue), with
// nobody's page open — completing the releases its weekly reads created:
// their tracklists, their pages at the other stores, their tracks' facts.
//
// The weekly read queues what it created (queueBackground, from
// workers.ts workerReport); each check of the main desktop is planned a few
// of them (planBackground) by the same planner the pages use (plan.ts
// planPage), so whatever a page visit on any device answered meanwhile is not
// asked again — a release is planned only for what is still due, and leaves
// the queue once nothing is. Unlike a page's work, a background job is leased
// to the device it was handed to (catalog_work_lease): the next check must
// not hand it again while the first is still reading. A report frees the
// leases of what it carried (releaseLeases, from report.ts); a lapsed lease
// lets the job be handed again.
//
// The main desktop off or asleep: nothing is handed, and the queue waits for
// its next check (Guy, 2026-11-27).

import type { CatalogDeviceProfile, CatalogJob, CatalogWork, CatalogWorkStore } from '@curator/protocol';
import type { Queryable } from '../../db/db.js';
import { pageTracks } from '../pages.js';
import { factsJobId, planPage, releaseJobId, scopeOf } from './plan.js';
import type { PlanInputs } from './settings.js';

// Queued releases looked at per check, beyond the ones planned: a few of the
// oldest may have nothing left to ask, and leave the queue.
const LOOK_AHEAD = 3;
// A queued release no weekly read is about any more.
export const QUEUE_KEEP_DAYS = 30;

// The releases a weekly read created, for the account's main desktop.
export async function queueBackground(q: Queryable, userId: string, releaseIds: readonly string[]): Promise<number> {
	if (!releaseIds.length) return 0;
	const rows = await q.query(
		`insert into curator.catalog_work_queue (user_id, object_id, reason)
		select $1::uuid, r, 'weekly' from unnest($2::uuid[]) as r
		on conflict do nothing returning 1`,
		[userId, `{${[...new Set(releaseIds)].join(',')}}`],
	);
	return rows.length;
}

// Background work holds back a share of each store's day for the pages people
// open: past it, a store is spent here while a page may still be handed work.
export function backgroundInputs(inputs: PlanInputs): PlanInputs {
	const share = inputs.settings.background.sharePct / 100;
	const perDay: PlanInputs['settings']['perDay'] = {};
	for (const [store, n] of Object.entries(inputs.settings.perDay) as [CatalogWorkStore, number][]) perDay[store] = Math.floor(n * share);
	return { ...inputs, settings: { ...inputs.settings, perDay } };
}

export async function planBackground(tx: Queryable, p: { userId: string; deviceId: string; profile: CatalogDeviceProfile; inputs: PlanInputs; nowMs: number }): Promise<CatalogWork | undefined> {
	const { background } = p.inputs.settings;
	if (!background.enabled) return undefined;
	// A visit's rounds and room are a page's: the check is a visit of its own.
	const { visit: _visit, ...profile } = p.profile;
	const scope = scopeOf(backgroundInputs(p.inputs), profile, p.nowMs);
	if (!scope) return undefined;
	// Only a plan over every store the desktop reads says a release is done: one
	// planned while a store is spent or resting has only not been asked yet.
	const whole = scope.stores.length === new Set(profile.stores).size;
	const queued = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_work_queue where user_id = $1 order by queued_at limit $2::int`, [p.userId, String(background.releases + LOOK_AHEAD)]);
	if (!queued.length) return undefined;
	// Jobs another device holds now.
	const ids = queued.flatMap((r) => [releaseJobId(r.object_id), factsJobId(r.object_id)]);
	const held = new Set(
		(await tx.query<{ job_id: string }>(`select job_id from curator.catalog_work_lease where job_id = any($1::text[]) and until > now() and device_id <> $2`, [`{${ids.join(',')}}`, p.deviceId])).map((r) => r.job_id),
	);
	const jobs: CatalogJob[] = [];
	const done: string[] = [];
	let planned = 0;
	for (const { object_id: id } of queued) {
		if (planned >= background.releases) break;
		if (held.has(releaseJobId(id)) && held.has(factsJobId(id))) continue;
		const page = await pageTracks(tx, id, { limit: 1 });
		const w = page?.releases.length ? await planPage(tx, { userId: p.userId, profile, object: page.object, releases: page.releases, first: false, nowMs: p.nowMs, scope }) : undefined;
		const mine = (w?.jobs ?? []).filter((j) => !held.has(j.id));
		if (!w?.jobs.length) {
			// Answered, by this desktop or any other: nothing more to ask of it.
			if (whole || !page?.releases.length) done.push(id);
			continue;
		}
		if (!mine.length) continue;
		jobs.push(...mine);
		planned++;
	}
	if (done.length) await tx.query(`delete from curator.catalog_work_queue where user_id = $1 and object_id = any($2::uuid[])`, [p.userId, `{${done.join(',')}}`]);
	if (!jobs.length) return undefined;
	await tx.query(
		`insert into curator.catalog_work_lease (job_id, user_id, device_id, until)
		select j, $2::uuid, $3, now() + make_interval(mins => $4::int) from unnest($1::text[]) as j
		on conflict (job_id) do update set user_id = excluded.user_id, device_id = excluded.device_id, until = excluded.until
			where curator.catalog_work_lease.until <= now() or curator.catalog_work_lease.device_id = excluded.device_id`,
		[`{${jobs.map((j) => j.id).join(',')}}`, p.userId, p.deviceId, String(background.leaseMin)],
	);
	return { jobs, limits: { rounds: 1, releases: planned } };
}

// A report carried these jobs: their leases go.
export async function releaseLeases(q: Queryable, userId: string, deviceId: string, jobIds: readonly string[]): Promise<void> {
	if (!jobIds.length) return;
	await q.query(`delete from curator.catalog_work_lease where user_id = $1 and device_id = $2 and job_id = any($3::text[])`, [userId, deviceId, `{${[...new Set(jobIds)].join(',')}}`]);
}
