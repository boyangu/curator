// The stores only the cloud can ask, for the releases devices just completed
// ('catalog_device_work'): Tidal and Apple answer a caller holding Curator's
// own key, which no app can carry, so a release a device found at its stores
// is looked up there by its UPCs right after (report.ts queues it in
// catalog_work_followup). Run by the API on a timer (server.ts), so the links
// arrive whether or not anyone's machine runs the upkeep pass — the one
// narrow exception to "the cloud's own machines read no stores" (Guy,
// 2026-11-26): official APIs, our keys, a few calls per release a device
// reported.
//
// A miss is not remembered beyond the queue: the upkeep's store linker
// (store-links.ts) asks again on its own schedule, and records its misses. A
// release without a UPC has nothing to look up by, and is left to it too.
//
// A release leaves the queue when every store was asked. One a store could
// not be asked about — it told us to wait, or its day is spent — stays, with
// the stores that WERE asked (never asked twice for it) and the time to come
// back: a quarter of an hour after a wait, the next day's count after a spent
// day. So a spent day at one store costs the other nothing, and the queue is
// not walked every half minute for a store that will not answer till midnight.

import type { Db } from '../../db/db.js';
import { num } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { applyReleaseClaims, storeClaims, type StoreProvider, type StoreReaders } from '../store-links.js';

export type FollowUpReaders = Pick<StoreReaders, 'tidal' | 'apple'>;
export type FollowUpReport = { releases: number; linked: number; requeued: number };

// Per run: a release costs two or three calls a store.
const BATCH = 10;
// The day's calls per store, shared with the upkeep's linker on the same row.
const PER_DAY: Record<'tidal' | 'apple', number> = { tidal: 8_000, apple: 2_000 };
// A store that asked us to wait is asked again after this.
const WAIT_MINUTES = 15;

export async function drainFollowUps(deps: { db: Db; log: Logger; readers: FollowUpReaders; batch?: number }): Promise<FollowUpReport> {
	const report: FollowUpReport = { releases: 0, linked: 0, requeued: 0 };
	const stores = (['tidal', 'apple'] as const).filter((p) => deps.readers[p]);
	if (!stores.length) return report;
	// Taken out of the queue in one short transaction; what a crash loses is
	// still the upkeep linker's.
	const taken = await withSystemTx(deps.db, async (tx) => {
		const [lock] = await tx.query<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtext('curator.catalog_work_followup')) as ok`);
		if (!lock?.ok) return [];
		return tx.query<{ id: string; asked: string | null; upcs: string | null; on_providers: string | null }>(
			`with taken as (
				delete from curator.catalog_work_followup where release_id in (
					select release_id from curator.catalog_work_followup where not_before <= now() order by not_before, queued_at limit $1::int)
				returning release_id, asked)
			select t.release_id as id, array_to_string(t.asked, '|') as asked,
				(select string_agg(i.value, '|' order by i.at) from curator.catalog_identifier i where i.object_id = t.release_id and i.namespace = 'upc') as upcs,
				(select string_agg(distinct so.provider, '|') from curator.catalog_source_object so where so.object_id = t.release_id) as on_providers
			from taken t`,
			[String(deps.batch ?? BATCH)],
		);
	});
	const signal = AbortSignal.timeout(5 * 60_000);
	// Stores not asked any more this run, and why.
	const parked = new Map<StoreProvider, 'wait' | 'spent'>();
	for (const r of taken) {
		const on = (r.on_providers ?? '').split('|').filter(Boolean);
		const upcs = (r.upcs ?? '').split('|').filter(Boolean);
		if (!upcs.length) continue;
		report.releases++;
		const asked = new Set((r.asked ?? '').split('|').filter(Boolean));
		const wanted = stores.filter((p) => !on.includes(p) && !asked.has(p));
		const readers: StoreReaders = {};
		for (const p of wanted) {
			if (parked.has(p)) continue;
			const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, 3, $2::int) as n`, [p, String(PER_DAY[p])]);
			if (num(g!.n) >= 3) readers[p] = deps.readers[p] as never;
			// The day is spent for this store: nothing more of it this run.
			else parked.set(p, 'spent');
		}
		const found = Object.keys(readers).length ? await storeClaims(readers, { upcs, on }, signal) : { claims: [], notes: [], calls: {} };
		for (const n of found.notes) if (/rate limited/.test(n.note)) parked.set(n.provider, 'wait');
		// Asked, whatever it answered: not again for this release.
		for (const p of wanted) if (readers[p] && parked.get(p) !== 'wait') asked.add(p);
		const unasked = wanted.filter((p) => !asked.has(p));
		if (unasked.length) {
			// Back when the soonest of them can be asked: after a wait, or with
			// the next day's count (UTC, as provider_budget counts).
			const soon = unasked.some((p) => parked.get(p) === 'wait');
			await deps.db.query(
				`insert into curator.catalog_work_followup (release_id, asked, not_before)
				values ($1, $2::text[], case when $3::boolean then now() + make_interval(mins => ${WAIT_MINUTES}) else ((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc' end)
				on conflict (release_id) do update set asked = excluded.asked, not_before = excluded.not_before`,
				[r.id, `{${[...asked].join(',')}}`, String(soon)],
			);
			report.requeued++;
		}
		for (const n of found.notes) if (!/rate limited|^no release/.test(n.note)) deps.log.warn('work_followup_failed', { release: r.id, provider: n.provider, note: n.note });
		if (!found.claims.length) continue;
		const applied = await withSystemTx(deps.db, (tx) =>
			applyReleaseClaims(tx, r.id, found.claims, (c) => `${c.provider} release ${c.providerId} is on the other one; found for this one by UPC after a device completed it`),
		);
		report.linked += found.claims.length - applied.conflicts.length;
	}
	return report;
}
