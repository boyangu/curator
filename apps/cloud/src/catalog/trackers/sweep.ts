// The worker's tracking pass (src/worker/main.ts runs it every minute).
//
// Per enabled tracker (kind × provider) with an adapter on this worker:
//   1. lease up to `batch` due cursors (FOR UPDATE SKIP LOCKED, so several
//      workers split the work and a crashed one's leases lapse);
//   2. per cursor, reserve the poll's calls from the provider's daily budget
//      (catalog_reserve_calls: shared by every worker, never overspent), poll,
//      and spread polls by the tracker's minGapMs;
//   3. an unchanged listing costs one cursor update; a changed one is ingested
//      (reason 'tracker') in one transaction, then the recent releases among
//      the children raise events in a second, short one (events.ts);
//   4. the cursor moves to its next due time (cadence.ts), or backs off on a
//      failure; a provider's rate limit parks the tracker for this pass.
// Objects nobody watches lose their cursors first (watches.ts).

import type { CatalogKind, CatalogProvider } from '@curator/protocol';
import { num } from '../../db/db.js';
import type { Db } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { raiseChartEntry, raisePlaylistAdd, raiseReleaseEvent } from '../events.js';
import { findRepresentation } from '../identity.js';
import { ingestClaims, Ingester, linkReleasesToLabel } from '../ingest.js';
import { repointRepresentation } from '../profile/label-profiler.js';
import { collectCursors } from '../watches.js';
import { backoffAt, nextDueAt, type Cadence } from './cadence.js';
import { TrackerRateLimitedError, type TrackerAdapter, type TrackerPoll } from './types.js';

export type SweepDeps = {
	db: Db;
	log: Logger;
	adapters: readonly TrackerAdapter[];
	// Who holds the leases (host:pid), for the run log and lease ownership.
	holder: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	// Cursors leased per tracker per pass.
	batch?: number;
	leaseMin?: number;
	pollTimeoutMs?: number;
};

type TrackerRow = { kind: CatalogKind; provider: string; cadence: Cadence; budget: { perDay: number; minGapMs: number }; config: { eventWindowDays?: number } };

export type TrackerPassResult = { kind: CatalogKind; provider: string; claimed: number; polled: number; unchanged: number; calls: number; events: number; failed: number; budgetOut: boolean };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runTrackers(deps: SweepDeps): Promise<TrackerPassResult[]> {
	const now = deps.now ?? Date.now;
	await withSystemTx(deps.db, (tx) => collectCursors(tx));
	const trackers = await deps.db.query<{ kind: CatalogKind; provider: string; cadence: string; budget: string; config: string }>(
		`select kind, provider, cadence::text as cadence, budget::text as budget, config::text as config from curator.tracker where enabled order by kind, provider`,
	);
	const results: TrackerPassResult[] = [];
	for (const t of trackers) {
		const adapter = deps.adapters.find((a) => a.provider === t.provider && a.kinds.includes(t.kind));
		// No key on this worker for that provider: skipped, not failed.
		if (!adapter) continue;
		const row: TrackerRow = { kind: t.kind, provider: t.provider, cadence: JSON.parse(t.cadence) as Cadence, budget: JSON.parse(t.budget) as TrackerRow['budget'], config: JSON.parse(t.config) as TrackerRow['config'] };
		results.push(await runTracker(deps, row, adapter, now));
	}
	return results;
}

async function runTracker(deps: SweepDeps, t: TrackerRow, adapter: TrackerAdapter, now: () => number): Promise<TrackerPassResult> {
	const sleep = deps.sleep ?? defaultSleep;
	const r: TrackerPassResult = { kind: t.kind, provider: t.provider, claimed: 0, polled: 0, unchanged: 0, calls: 0, events: 0, failed: 0, budgetOut: false };
	const [run] = await deps.db.query<{ id: unknown }>(`insert into curator.tracker_run (kind, provider, worker) values ($1, $2, $3) returning id`, [t.kind, t.provider, deps.holder]);
	const errors: string[] = [];
	const leased = await deps.db.query<{ object_id: string; name: string; cursor: string; started_ms: unknown; fail_count: unknown }>(
		`update curator.catalog_cursor c set lease_holder = $3, lease_until = now() + make_interval(mins => $5::int)
		from (
			select cc.object_id, cc.provider
			from curator.catalog_cursor cc join curator.catalog_object o on o.id = cc.object_id
			where cc.provider = $1 and o.kind = $2 and o.merged_into is null and cc.next_due_at <= now()
				and (cc.lease_until is null or cc.lease_until < now())
			order by cc.next_due_at
			limit $4::int
			for update of cc skip locked
		) d, curator.catalog_object o
		where c.object_id = d.object_id and c.provider = d.provider and o.id = c.object_id
		returning c.object_id, o.name, c.cursor::text as cursor, extract(epoch from c.tracking_started_at) * 1000 as started_ms, c.fail_count`,
		[t.provider, t.kind, deps.holder, String(deps.batch ?? 50), String(deps.leaseMin ?? 10)],
	);
	r.claimed = leased.length;
	const release = (objectId: string) =>
		deps.db.query(`update curator.catalog_cursor set lease_holder = null, lease_until = null where object_id = $1 and provider = $2 and lease_holder = $3`, [objectId, t.provider, deps.holder]);
	for (let i = 0; i < leased.length; i++) {
		const c = leased[i]!;
		if (r.budgetOut) {
			await release(c.object_id);
			continue;
		}
		const [granted] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [t.provider, String(adapter.callsPerPoll), String(t.budget.perDay)]);
		if (num(granted!.n) < adapter.callsPerPoll) {
			r.budgetOut = true;
			await release(c.object_id);
			continue;
		}
		if (i > 0 && t.budget.minGapMs > 0) await sleep(t.budget.minGapMs);
		const cursor = JSON.parse(c.cursor) as Record<string, unknown>;
		try {
			const [rep] = await deps.db.query<{ provider_id: string; url: string | null }>(
				`select provider_id, url from curator.catalog_source_object where object_id = $1 and provider = $2 order by first_seen_at limit 1`,
				[c.object_id, t.provider],
			);
			// A label read through its catalogue playlists on this provider.
			const related = t.kind === 'label'
				? await deps.db.query<{ provider_id: string; url: string | null }>(
						`select so.provider_id, so.url from curator.catalog_edge e join curator.catalog_source_object so on so.object_id = e.dst and so.provider = $2 and so.kind = 'playlist'
						where e.src = $1 and e.kind = 'label-playlist' and e.role = 'catalogue' order by so.first_seen_at`,
						[c.object_id, t.provider],
					)
				: [];
			const poll = await adapter.poll(
				{
					object: { id: c.object_id, kind: t.kind, name: c.name },
					representation: rep ? { providerId: rep.provider_id, url: rep.url } : null,
					cursor,
					...(related.length ? { related: related.map((r) => ({ providerId: r.provider_id, url: r.url })) } : {}),
				},
				AbortSignal.timeout(deps.pollTimeoutMs ?? 30_000),
			);
			// Before the ingest: the poll's claims name the label by that id.
			if (poll.resolvedId && rep && t.kind === 'label') {
				const outcome = await repointRepresentation(deps.db, c.object_id, { provider: adapter.provider, from: rep.provider_id, to: poll.resolvedId, url: rep.url ?? '' });
				if (outcome === 'owned_elsewhere') throw new Error(`${t.provider}:${poll.resolvedId} (${rep.provider_id}) already belongs to another label`);
			}
			r.polled++;
			r.calls += poll.calls;
			const changed = poll.listingHash !== cursor.listingHash;
			if (!changed) r.unchanged++;
			else r.events += await ingestFound(deps, t, c.object_id, poll, now());
			await deps.db.query(
				`update curator.catalog_cursor set cursor = $3::text::jsonb, next_due_at = to_timestamp($4::float8 / 1000), last_run_at = now(),
					fail_count = 0, last_error = null, lease_holder = null, lease_until = null
				where object_id = $1 and provider = $2`,
				[c.object_id, t.provider, JSON.stringify({ ...poll.cursor, listingHash: poll.listingHash }), String(nextDueAt(now(), t.cadence))],
			);
			// Read through, changed or not: the back office's "last scanned".
			await deps.db.query(`update curator.catalog_object set scanned_at = now() where id = $1`, [c.object_id]);
		} catch (e) {
			r.failed++;
			const msg = e instanceof Error ? e.message : String(e);
			errors.push(msg.slice(0, 200));
			const limited = e instanceof TrackerRateLimitedError;
			const fails = num(c.fail_count) + 1;
			const due = limited ? now() + e.retryAfterSec * 1000 : backoffAt(now(), fails);
			await deps.db.query(
				`update curator.catalog_cursor set next_due_at = to_timestamp($3::float8 / 1000), last_run_at = now(), fail_count = $4::int,
					last_error = $5, lease_holder = null, lease_until = null
				where object_id = $1 and provider = $2`,
				[c.object_id, t.provider, String(due), String(limited ? num(c.fail_count) : fails), msg.slice(0, 300)],
			);
			// The provider asked us to wait: every other cursor of it would too.
			if (limited) r.budgetOut = true;
			deps.log.warn('tracker_poll_failed', { kind: t.kind, provider: t.provider, objectId: c.object_id, limited, error: msg.slice(0, 200) });
		}
	}
	await deps.db.query(
		`update curator.tracker_run set finished_at = now(), claimed = $2::int, calls = $3::int, events = $4::int, failed = $5::int, errors = $6::text::jsonb where id = $1::bigint`,
		[String(run!.id), String(r.claimed), String(r.calls), String(r.events), String(r.failed), JSON.stringify(errors.slice(0, 20))],
	);
	if (r.claimed) deps.log.info('tracker_pass', { ...r });
	return r;
}

// Ingests a changed listing, then raises events for its recent releases.
async function ingestFound(deps: SweepDeps, t: TrackerRow, trackedId: string, poll: TrackerPoll, nowMs: number): Promise<number> {
	const { children, self } = poll;
	const outcomes = await withSystemTx(deps.db, async (tx) => {
		if (self) await ingestClaims(tx, [self], { reason: 'tracker' });
		if (poll.tentative?.length) {
			// An upload the catalogue can place joins its recording; one it
			// cannot is noted on the tracked object, never minted.
			const ingester = new Ingester(tx, { reason: 'tracker' });
			const [rep] = await tx.query<{ id: string }>(`select id from curator.catalog_source_object where object_id = $1 and provider = $2 limit 1`, [trackedId, t.provider]);
			for (const c of poll.tentative) {
				if (await ingester.attachIfKnown(c)) continue;
				await tx.query(
					`insert into curator.catalog_signal (object_id, source_object_id, kind, value, observed_at)
					values ($1, $2, 'announcement', $3::text::jsonb, coalesce(to_timestamp($4::float8 / 1000), now()))`,
					[trackedId, rep?.id ?? null, JSON.stringify({ provider: c.provider, id: c.providerId, title: c.name, url: c.url ?? null, artists: (c.artists ?? []).map((a) => a.name) }), c.publishedAt == null ? null : String(c.publishedAt)],
				);
			}
		}
		const ingested = (await ingestClaims(tx, children, { reason: 'tracker' })).outcomes;
		if (poll.labelOf) {
			await linkReleasesToLabel(tx, trackedId, ingested.map((o, i) => ({ objectId: o.objectId, claim: children[i]! })).filter((r) => r.claim.kind === 'release'));
		}
		return ingested;
	});
	const windowDays = t.config.eventWindowDays ?? 14;
	return withSystemTx(deps.db, async (tx) => {
		let raised = 0;
		// A genre's children are chart rows: the entries are the events, not
		// the releases behind them (a chart carries old releases too).
		if (t.kind === 'genre') {
			for (const e of poll.chart ?? []) {
				const recordingId = await findRepresentation(tx, e.recording);
				if (!recordingId) continue;
				if ((await raiseChartEntry(tx, { genreId: trackedId, recordingId, provider: t.provider as CatalogProvider, rank: e.rank }, { nowMs })) === null) continue;
				raised++;
				// A charted track the catalogue knew already was never queued for
				// its Spotify id; the chart makes it worth one (planner.ts).
				await tx.query(
					`insert into curator.catalog_enrich_task (object_id, need, provider)
					select $1, 'representation', 'spotify'
					where exists (select 1 from curator.catalog_identifier i where i.object_id = $1 and i.namespace = 'isrc')
						and not exists (select 1 from curator.catalog_source_object so where so.object_id = $1 and so.provider = 'spotify')
					on conflict do nothing`,
					[recordingId],
				);
			}
			return raised;
		}
		// A playlist's children are its tracks, each an addition; an artist's
		// or label's are releases.
		const rep = t.kind === 'playlist'
			? (await tx.query<{ id: string }>(`select id from curator.catalog_source_object where object_id = $1 and provider = $2 limit 1`, [trackedId, t.provider]))[0]?.id ?? null
			: null;
		for (const [i, o] of outcomes.entries()) {
			const child = children[i]!;
			let seq: number | null = null;
			if (t.kind === 'playlist' && o.kind === 'recording') {
				seq = await raisePlaylistAdd(tx, { playlistId: trackedId, recordingId: o.objectId, sourceObjectId: rep, addedAt: child.publishedAt ?? null, position: child.facts?.trackNumber ?? null }, { nowMs, windowDays });
			} else if (o.kind === 'release') {
				seq = await raiseReleaseEvent(tx, { releaseId: o.objectId, trackedId, publishedAt: child.publishedAt ?? null }, { nowMs, windowDays });
			}
			if (seq !== null) raised++;
		}
		return raised;
	});
}
