// The worker's tracking pass (src/worker/main.ts runs it every minute), and
// the pieces a desktop worker's polls go through (../workers.ts).
//
// Per enabled tracker (kind × provider) with an adapter on this worker:
//   1. lease up to `batch` due cursors (FOR UPDATE SKIP LOCKED, so several
//      workers split the work and a crashed one's leases lapse) — leaving to
//      the devices the cursors their users' live workers read (below);
//   2. per cursor, reserve the poll's calls from the provider's daily budget
//      (catalog_reserve_calls: shared by every worker, never overspent), poll,
//      and spread polls by the tracker's minGapMs;
//   3. an unchanged listing costs one cursor update; a changed one is ingested
//      (reason 'tracker') in one transaction, then the recent releases among
//      the children raise events in a second, short one (events.ts);
//   4. the cursor moves to its next due time (cadence.ts), or backs off on a
//      failure; a provider's rate limit parks every tracker of that provider
//      until the wait it named has passed (tracking.ts providerPauses).
// Objects nobody watches lose their cursors first (watches.ts).
//
// A desktop reading for its user ('catalog_workers'): the same lease, the
// same apply, with the poll made elsewhere. `leaseDue` with a `worker` leases
// only the cursors of that user's watches; without one — the cloud's own
// pass — it leases a cursor only when some watcher wants the tracker
// (`wantedSql`: the user's Refresh-menu choices, sent as catalog_worker
// .trackers; no row or null = defaults, all on) and no watcher's live worker
// both wants it and can read its provider, unless the cursor is overdue by a
// day (or its cadence, if longer): the worker was not there, the cloud reads
// it once. A tracker every follower switched off is read by nobody.
// `applyPoll` takes a poll, or the error the reader met, from either.

import type { CatalogKind, CatalogProvider } from '@curator/protocol';
import { num } from '../../db/db.js';
import type { Db } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { raiseChartEntry, raisePlaylistAdd, raiseReleaseEvent } from '../events.js';
import { findRepresentation } from '../identity.js';
import { ingestClaims, Ingester, linkReleasesToLabel } from '../ingest.js';
import { repointRepresentation } from '../profile/label-profiler.js';
import { providerPauses, wantedSql } from '../tracking.js';
import { collectCursors } from '../watches.js';
import { backoffAt, nextDueAt, spreadOf, type Cadence } from './cadence.js';
import { TrackerRateLimitedError, type TrackerAdapter, type TrackerPoll, type TrackerTarget } from '@curator/catalog-readers';

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

export type TrackerRow = { kind: CatalogKind; provider: string; cadence: Cadence; budget: { perDay: number; minGapMs: number }; config: { eventWindowDays?: number } };

export type TrackerPassResult = { kind: CatalogKind; provider: string; claimed: number; polled: number; unchanged: number; calls: number; events: number; failed: number; budgetOut: boolean };

// A worker's holder string, and how to tell one from the cloud's (host:pid).
export const DEVICE_HOLDER_PREFIX = 'device:';
export const deviceHolder = (deviceId: string): string => `${DEVICE_HOLDER_PREFIX}${deviceId}`;

// How long a worker may go without checking in before the cloud reads for it
// (tracking.ts liveWorkers says the same).
export const WORKER_LIVE_WINDOW = `interval '6 hours'`;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function loadTrackers(db: Pick<Db, 'query'>): Promise<TrackerRow[]> {
	const rows = await db.query<{ kind: CatalogKind; provider: string; cadence: string; budget: string; config: string }>(
		`select kind, provider, cadence::text as cadence, budget::text as budget, config::text as config from curator.tracker where enabled order by kind, provider`,
	);
	return rows.map((t) => ({ kind: t.kind, provider: t.provider, cadence: JSON.parse(t.cadence) as Cadence, budget: JSON.parse(t.budget) as TrackerRow['budget'], config: JSON.parse(t.config) as TrackerRow['config'] }));
}

export async function runTrackers(deps: SweepDeps): Promise<TrackerPassResult[]> {
	const now = deps.now ?? Date.now;
	await withSystemTx(deps.db, (tx) => collectCursors(tx));
	const results: TrackerPassResult[] = [];
	for (const t of await loadTrackers(deps.db)) {
		const adapter = deps.adapters.find((a) => a.provider === t.provider && a.kinds.includes(t.kind));
		// No key on this worker for that provider: skipped, not failed.
		if (!adapter) continue;
		// The provider asked us to wait: not one call until then. Trying the next
		// cursor every pass would try the block itself (a Cloudflare challenge
		// answers each attempt the same) and push the wait out every time.
		if ((await providerPauses(deps.db)).some((p) => p.provider === t.provider)) {
			results.push({ kind: t.kind, provider: t.provider, claimed: 0, polled: 0, unchanged: 0, calls: 0, events: 0, failed: 0, budgetOut: true });
			continue;
		}
		results.push(await runTracker(deps, t, adapter, now));
	}
	return results;
}

export type LeasedCursor = { objectId: string; name: string; cursor: Record<string, unknown>; failCount: number };

// Leases up to `batch` of a tracker's due cursors to `holder` for `leaseMin`
// minutes. With `worker`, only the cursors of that user's watches (a desktop
// reads for its user; the master already kept this tracker to the device's
// checked ones); without, the cloud's share (header).
export async function leaseDue(
	db: Pick<Db, 'query'>,
	t: TrackerRow,
	opts: { holder: string; batch: number; leaseMin: number; worker?: { userId: string } },
): Promise<LeasedCursor[]> {
	const scope = opts.worker
		? `and exists (select 1 from curator.catalog_watch w where w.object_id = cc.object_id and w.user_id = $6::uuid)`
		: `and ${wantedSql('cc', '$7')}
			and (
				not exists (
					select 1 from curator.catalog_watch w join curator.catalog_worker k on k.user_id = w.user_id
					where w.object_id = cc.object_id and $7 = any(k.trackers) and cc.provider = any(k.providers) and k.checked_in_at > now() - ${WORKER_LIVE_WINDOW}
				)
				or cc.next_due_at < now() - greatest(interval '1 day', make_interval(mins => $6::int))
			)`;
	const rows = await db.query<{ object_id: string; name: string; cursor: string; fail_count: unknown }>(
		`update curator.catalog_cursor c set lease_holder = $3, lease_until = now() + make_interval(mins => $5::int)
		from (
			select cc.object_id, cc.provider
			from curator.catalog_cursor cc join curator.catalog_object o on o.id = cc.object_id
			where cc.provider = $1 and o.kind = $2 and o.merged_into is null and cc.next_due_at <= now()
				and (cc.lease_until is null or cc.lease_until < now())
				${scope}
			order by cc.next_due_at
			limit $4::int
			for update of cc skip locked
		) d, curator.catalog_object o
		where c.object_id = d.object_id and c.provider = d.provider and o.id = c.object_id
		returning c.object_id, o.name, c.cursor::text as cursor, c.fail_count`,
		[t.provider, t.kind, opts.holder, String(opts.batch), String(opts.leaseMin), ...(opts.worker ? [opts.worker.userId] : [String(t.cadence.everyMin), `${t.kind}/${t.provider}`])],
	);
	return rows.map((c) => ({ objectId: c.object_id, name: c.name, cursor: JSON.parse(c.cursor) as Record<string, unknown>, failCount: num(c.fail_count) }));
}

export function releaseLease(db: Pick<Db, 'query'>, objectId: string, provider: string, holder: string): Promise<unknown> {
	return db.query(`update curator.catalog_cursor set lease_holder = null, lease_until = null where object_id = $1 and provider = $2 and lease_holder = $3`, [objectId, provider, holder]);
}

// Calls granted from the provider's day, up to `want`.
export async function reserveCalls(db: Pick<Db, 'query'>, provider: string, want: number, perDay: number): Promise<number> {
	const [granted] = await db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [provider, String(want), String(perDay)]);
	return num(granted!.n);
}

export type Representation = { providerId: string; url: string | null };

// What a reader is handed for one cursor: the object's representation on
// the provider and, for a label, the catalogue playlists it is read through.
export async function loadTarget(db: Pick<Db, 'query'>, t: TrackerRow, c: Pick<LeasedCursor, 'objectId' | 'name' | 'cursor'>): Promise<{ target: TrackerTarget; rep: Representation | null }> {
	const [rep] = await db.query<{ provider_id: string; url: string | null }>(
		`select provider_id, url from curator.catalog_source_object where object_id = $1 and provider = $2 order by first_seen_at limit 1`,
		[c.objectId, t.provider],
	);
	const related = t.kind === 'label'
		? await db.query<{ provider_id: string; url: string | null }>(
				`select so.provider_id, so.url from curator.catalog_edge e join curator.catalog_source_object so on so.object_id = e.dst and so.provider = $2 and so.kind = 'playlist'
				where e.src = $1 and e.kind = 'label-playlist' and e.role = 'catalogue' order by so.first_seen_at`,
				[c.objectId, t.provider],
			)
		: [];
	return {
		target: {
			object: { id: c.objectId, kind: t.kind, name: c.name },
			representation: rep ? { providerId: rep.provider_id, url: rep.url } : null,
			cursor: c.cursor,
			...(related.length ? { related: related.map((r) => ({ providerId: r.provider_id, url: r.url })) } : {}),
		},
		rep: rep ? { providerId: rep.provider_id, url: rep.url } : null,
	};
}

// What a poll came to: the reader's result, or the error it met (a rate
// limit says how long the provider asked to wait).
export type PollOutcome = { poll: TrackerPoll } | { error: { message: string; rateLimitedSec: number | null } };
export type ApplyResult = { polled: boolean; unchanged: boolean; calls: number; events: number; failed: boolean; limited: boolean; error: string | null };

// Applies one poll's outcome to its cursor: ingest and events for a changed
// listing, the cursor's next due time, the object's scanned_at; or the
// failure's backoff. `holder` is recorded as the cursor's `last_reported_by`
// and the events' `raised_by`. The lease is cleared either way.
export async function applyPoll(
	deps: { db: Db; log: Logger },
	t: TrackerRow,
	c: Pick<LeasedCursor, 'objectId' | 'cursor' | 'failCount'>,
	rep: Representation | null,
	outcome: PollOutcome,
	opts: { holder: string; nowMs: number },
): Promise<ApplyResult> {
	const r: ApplyResult = { polled: false, unchanged: false, calls: 0, events: 0, failed: false, limited: false, error: null };
	let err: { message: string; rateLimitedSec: number | null } | null = 'error' in outcome ? outcome.error : null;
	if ('poll' in outcome) {
		const { poll } = outcome;
		try {
			// Before the ingest: the poll's claims name the label by that id.
			if (poll.resolvedId && rep && t.kind === 'label') {
				const o = await repointRepresentation(deps.db, c.objectId, { provider: t.provider as CatalogProvider, from: rep.providerId, to: poll.resolvedId, url: rep.url ?? '' });
				if (o === 'owned_elsewhere') throw new Error(`${t.provider}:${poll.resolvedId} (${rep.providerId}) already belongs to another label`);
			}
			r.polled = true;
			r.calls = poll.calls;
			const changed = poll.listingHash !== c.cursor.listingHash;
			if (!changed) r.unchanged = true;
			else r.events = await ingestFound(deps.db, t, c.objectId, poll, opts.nowMs, opts.holder);
			await deps.db.query(
				`update curator.catalog_cursor set cursor = $3::text::jsonb, next_due_at = to_timestamp($4::float8 / 1000), last_run_at = now(),
					fail_count = 0, last_error = null, last_reported_by = $5, lease_holder = null, lease_until = null
				where object_id = $1 and provider = $2`,
				[c.objectId, t.provider, JSON.stringify({ ...poll.cursor, listingHash: poll.listingHash }), String(nextDueAt(opts.nowMs, t.cadence, spreadOf(c.objectId))), opts.holder],
			);
			// Read through, changed or not: the back office's "last scanned".
			await deps.db.query(`update curator.catalog_object set scanned_at = now() where id = $1`, [c.objectId]);
			return r;
		} catch (e) {
			err = { message: e instanceof Error ? e.message : String(e), rateLimitedSec: e instanceof TrackerRateLimitedError ? e.retryAfterSec : null };
		}
	}
	const { message, rateLimitedSec } = err!;
	r.failed = true;
	r.limited = rateLimitedSec !== null;
	r.error = message;
	const fails = c.failCount + 1;
	const due = rateLimitedSec !== null ? opts.nowMs + rateLimitedSec * 1000 : backoffAt(opts.nowMs, fails);
	// tracking.ts providerPauses matches this text.
	const lastError = rateLimitedSec !== null ? new TrackerRateLimitedError(rateLimitedSec).message : message.slice(0, 300);
	await deps.db.query(
		`update curator.catalog_cursor set next_due_at = to_timestamp($3::float8 / 1000), last_run_at = now(), fail_count = $4::int,
			last_error = $5, last_reported_by = $6, lease_holder = null, lease_until = null
		where object_id = $1 and provider = $2`,
		[c.objectId, t.provider, String(due), String(rateLimitedSec !== null ? c.failCount : fails), lastError, opts.holder],
	);
	deps.log.warn('tracker_poll_failed', { kind: t.kind, provider: t.provider, objectId: c.objectId, limited: r.limited, by: opts.holder, error: message.slice(0, 200) });
	return r;
}

async function runTracker(deps: SweepDeps, t: TrackerRow, adapter: TrackerAdapter, now: () => number): Promise<TrackerPassResult> {
	const sleep = deps.sleep ?? defaultSleep;
	const r: TrackerPassResult = { kind: t.kind, provider: t.provider, claimed: 0, polled: 0, unchanged: 0, calls: 0, events: 0, failed: 0, budgetOut: false };
	const [run] = await deps.db.query<{ id: unknown }>(`insert into curator.tracker_run (kind, provider, worker) values ($1, $2, $3) returning id`, [t.kind, t.provider, deps.holder]);
	const errors: string[] = [];
	const leased = await leaseDue(deps.db, t, { holder: deps.holder, batch: deps.batch ?? 50, leaseMin: deps.leaseMin ?? 10 });
	r.claimed = leased.length;
	for (let i = 0; i < leased.length; i++) {
		const c = leased[i]!;
		if (r.budgetOut) {
			await releaseLease(deps.db, c.objectId, t.provider, deps.holder);
			continue;
		}
		if ((await reserveCalls(deps.db, t.provider, adapter.callsPerPoll, t.budget.perDay)) < adapter.callsPerPoll) {
			r.budgetOut = true;
			await releaseLease(deps.db, c.objectId, t.provider, deps.holder);
			continue;
		}
		if (i > 0 && t.budget.minGapMs > 0) await sleep(t.budget.minGapMs);
		const { target, rep } = await loadTarget(deps.db, t, c);
		let outcome: PollOutcome;
		try {
			outcome = { poll: await adapter.poll(target, AbortSignal.timeout(deps.pollTimeoutMs ?? 30_000)) };
		} catch (e) {
			outcome = { error: { message: e instanceof Error ? e.message : String(e), rateLimitedSec: e instanceof TrackerRateLimitedError ? e.retryAfterSec : null } };
		}
		const a = await applyPoll(deps, t, c, rep, outcome, { holder: deps.holder, nowMs: now() });
		if (a.polled) r.polled++;
		if (a.unchanged) r.unchanged++;
		r.calls += a.calls;
		r.events += a.events;
		if (a.failed) {
			r.failed++;
			errors.push((a.error ?? '').slice(0, 200));
			// The provider asked us to wait: every other cursor of it would too.
			if (a.limited) r.budgetOut = true;
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
async function ingestFound(db: Db, t: TrackerRow, trackedId: string, poll: TrackerPoll, nowMs: number, by: string): Promise<number> {
	const { children, self } = poll;
	const outcomes = await withSystemTx(db, async (tx) => {
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
	return withSystemTx(db, async (tx) => {
		let raised = 0;
		// A genre's children are chart rows: the entries are the events, not
		// the releases behind them (a chart carries old releases too).
		if (t.kind === 'genre') {
			for (const e of poll.chart ?? []) {
				const recordingId = await findRepresentation(tx, e.recording);
				if (!recordingId) continue;
				if ((await raiseChartEntry(tx, { genreId: trackedId, recordingId, provider: t.provider as CatalogProvider, rank: e.rank }, { nowMs, by })) === null) continue;
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
				seq = await raisePlaylistAdd(tx, { playlistId: trackedId, recordingId: o.objectId, sourceObjectId: rep, addedAt: child.publishedAt ?? null, position: child.facts?.trackNumber ?? null }, { nowMs, windowDays, by });
			} else if (o.kind === 'release') {
				seq = await raiseReleaseEvent(tx, { releaseId: o.objectId, trackedId, publishedAt: child.publishedAt ?? null }, { nowMs, windowDays, by });
			}
			if (seq !== null) raised++;
		}
		return raised;
	});
}
