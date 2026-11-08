// A label's releases read once, outside tracking: the `backfill` tasks the
// profiler queues (profile/label-profiler.ts) for a label that may have no
// watcher. A task polls that provider's label adapter from an empty cursor —
// the same read a first tracked poll makes — and, while the adapter says it
// left releases for later (a Deezer label search expands four albums a poll),
// polls on from its cursor; a listing longer than a run is continued on the
// next pass from the cursor kept in the task's `state`. Ingested with reason
// 'enrichment': the catalogue learns the label's releases, artists and
// tracks, and nobody's feed hears of it. A watcher's cursor, if one exists,
// keeps its own place; the two never share state. Known limit: Deezer's
// label search returns at most 100 albums, unpaged.

import type { CatalogKind } from '@curator/protocol';
import { num } from '../../db/db.js';
import type { Db } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { ingestClaims } from '../ingest.js';
import { TrackerRateLimitedError, type TrackerAdapter } from '@curator/catalog-readers';

export type BackfillDeps = { db: Db; log: Logger; adapters: readonly TrackerAdapter[]; holder: string; batch?: number; pollTimeoutMs?: number; sleep?: (ms: number) => Promise<void> };

const RETRY_HOURS = [6, 24, 72];
// Polls one task makes in a run before it yields to the others: ~40 Deezer
// albums, ~25 s at its pace. A listing longer than that goes on next pass.
const MAX_POLLS_PER_RUN = 10;

export async function runBackfill(deps: BackfillDeps): Promise<{ attempted: number; done: number; claims: number }> {
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const budgets = new Map<string, { perDay: number; minGapMs: number }>();
	for (const t of await deps.db.query<{ provider: string; budget: string }>(`select provider, budget::text as budget from curator.tracker where kind = 'label'`)) {
		budgets.set(t.provider, JSON.parse(t.budget) as { perDay: number; minGapMs: number });
	}
	const due = await deps.db.query<{ object_id: string; provider: string; kind: CatalogKind; name: string; attempts: unknown; state: string }>(
		`update curator.catalog_enrich_task et set lease_holder = $1, lease_until = now() + interval '10 minutes'
		from (
			select t.object_id, t.provider from curator.catalog_enrich_task t
			where t.need = 'backfill' and t.next_due_at <= now() and (t.lease_until is null or t.lease_until < now())
			order by t.next_due_at limit $2::int
			for update skip locked
		) d, curator.catalog_object o
		where et.object_id = d.object_id and et.provider = d.provider and et.need = 'backfill' and o.id = et.object_id
		returning et.object_id, et.provider, o.kind, o.name, et.attempts, et.state::text as state`,
		[deps.holder, String(deps.batch ?? 10)],
	);
	const parked = new Set<string>();
	let attempted = 0;
	let done = 0;
	let claims = 0;
	for (const [i, t] of due.entries()) {
		const adapter = deps.adapters.find((a) => a.provider === t.provider && a.kinds.includes(t.kind));
		const budget = budgets.get(t.provider);
		if (!adapter || !budget || parked.has(t.provider)) {
			await release(deps.db, t.object_id, t.provider);
			continue;
		}
		const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [t.provider, String(adapter.callsPerPoll), String(budget.perDay)]);
		if (num(g!.n) < adapter.callsPerPoll) {
			parked.add(t.provider);
			await release(deps.db, t.object_id, t.provider);
			continue;
		}
		if (i > 0 && budget.minGapMs > 0) await sleep(budget.minGapMs);
		attempted++;
		try {
			const [rep] = await deps.db.query<{ provider_id: string; url: string | null }>(
				`select provider_id, url from curator.catalog_source_object where object_id = $1 and provider = $2 order by first_seen_at limit 1`,
				[t.object_id, t.provider],
			);
			// A poll expands a few releases and says what it left (`pending:`
			// listing hash): the next one goes on from its cursor, until the
			// listing is read through. Each poll's releases are kept as it lands.
			let cursor = JSON.parse(t.state || '{}') as Record<string, unknown>;
			let pending = false;
			for (let p = 0; p < MAX_POLLS_PER_RUN; p++) {
				if (p > 0) {
					const [more] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [t.provider, String(adapter.callsPerPoll), String(budget.perDay)]);
					if (num(more!.n) < adapter.callsPerPoll) {
						parked.add(t.provider);
						break;
					}
					if (budget.minGapMs > 0) await sleep(budget.minGapMs);
				}
				const poll = await adapter.poll(
					{ object: { id: t.object_id, kind: t.kind, name: t.name }, representation: rep ? { providerId: rep.provider_id, url: rep.url } : null, cursor },
					AbortSignal.timeout(deps.pollTimeoutMs ?? 60_000),
				);
				await withSystemTx(deps.db, async (tx) => {
					if (poll.self && p === 0) await ingestClaims(tx, [poll.self], { reason: 'enrichment' });
					await ingestClaims(tx, poll.children, { reason: 'enrichment' });
				});
				claims += poll.children.length;
				cursor = poll.cursor;
				pending = poll.listingHash.startsWith('pending:');
				if (!pending) break;
			}
			// The back office's "last scanned", once the listing is read through.
			if (!pending) await deps.db.query(`update curator.catalog_object set scanned_at = now() where id = $1`, [t.object_id]);
			if (pending) {
				// Comes due again at once: the next pass reads on from here.
				await deps.db.query(
					`update curator.catalog_enrich_task set state = $3::text::jsonb, next_due_at = now(), attempts = 0, last_error = null, lease_holder = null, lease_until = null
					where object_id = $1 and need = 'backfill' and provider = $2`,
					[t.object_id, t.provider, JSON.stringify(cursor)],
				);
			} else {
				await deps.db.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'backfill' and provider = $2`, [t.object_id, t.provider]);
				done++;
			}
		} catch (e) {
			const limited = e instanceof TrackerRateLimitedError;
			if (limited) parked.add(t.provider);
			const hours = limited ? Math.max(1, Math.ceil(e.retryAfterSec / 3600)) : RETRY_HOURS[Math.min(num(t.attempts), RETRY_HOURS.length - 1)]!;
			await deps.db.query(
				`update curator.catalog_enrich_task set next_due_at = now() + make_interval(hours => $3::int), attempts = attempts + $4::int, last_error = $5, lease_holder = null, lease_until = null
				where object_id = $1 and need = 'backfill' and provider = $2`,
				[t.object_id, t.provider, String(hours), limited ? '0' : '1', e instanceof Error ? e.message.slice(0, 300) : 'error'],
			);
			deps.log.warn('catalog_backfill_failed', { objectId: t.object_id, provider: t.provider, limited, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
		}
	}
	if (attempted) deps.log.info('catalog_backfill_pass', { attempted, done, claims });
	return { attempted, done, claims };
}

function release(db: Db, objectId: string, provider: string): Promise<unknown> {
	return db.query(`update curator.catalog_enrich_task set lease_holder = null, lease_until = null where object_id = $1 and need = 'backfill' and provider = $2`, [objectId, provider]);
}
