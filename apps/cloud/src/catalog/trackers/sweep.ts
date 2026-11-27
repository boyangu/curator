// The worker's tracking pass (src/worker/pass.ts runs it every minute), and
// the pieces a desktop worker's polls go through (../workers.ts).
//
// Per enabled tracker (kind × provider) with an adapter on this worker:
//   1. lease up to `batch` due cursors (FOR UPDATE SKIP LOCKED, so several
//      workers split the work and a crashed one's leases lapse) — leaving to
//      the devices the cursors their users' live workers read (below);
//   2. per cursor, reserve the poll's calls from the provider's daily budget
//      (catalog_reserve_calls: shared by every worker, never overspent), poll,
//      and spread polls by the tracker's minGapMs;
//   3. polls are applied ten at a time (applyPolls): the changed listings are
//      ingested (reason 'tracker') in one transaction, then the recent
//      releases among their children raise events in a second, short one
//      (events.ts), and the cursors move in one statement — a poll that fails
//      is applied alone, and fails alone;
//   4. the cursor moves to its next due time — the tracker's cadence, slowed
//      to what its followers chose (cadence.ts nextDueFor) — or backs off on a
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
// `applyPolls` takes the polls, or the errors the readers met, from either.

import type { CatalogKind, CatalogProvider } from '@curator/protocol';
import { num } from '../../db/db.js';
import type { Db, Queryable } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { raiseChartEntries, raisePlaylistAdds, raiseReleaseEvents } from '../events.js';
import { findRepresentations } from '../identity.js';
import { BATCH_NODES, Ingester, linkReleasesToLabel, nodes, type IngestOutcome } from '../ingest.js';
import { repointRepresentation } from '../profile/label-profiler.js';
import { providerPauses, readCadencesOf, wantedSql } from '../tracking.js';
import { collectCursors } from '../watches.js';
import { backoffAt, nextDueFor, spreadOf, type Cadence } from './cadence.js';
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

export function releaseLeases(db: Pick<Db, 'query'>, cursors: readonly { objectId: string; provider: string }[], holder: string): Promise<unknown> {
	if (!cursors.length) return Promise.resolve();
	return db.query(
		`update curator.catalog_cursor c set lease_holder = null, lease_until = null
		from jsonb_to_recordset($1::text::jsonb) as x(object_id uuid, provider text)
		where c.object_id = x.object_id and c.provider = x.provider and c.lease_holder = $2`,
		[JSON.stringify(cursors.map((c) => ({ object_id: c.objectId, provider: c.provider }))), holder],
	);
}

// Calls granted from the provider's day, up to `want`.
export async function reserveCalls(db: Pick<Db, 'query'>, provider: string, want: number, perDay: number): Promise<number> {
	const [granted] = await db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [provider, String(want), String(perDay)]);
	return num(granted!.n);
}

export type Representation = { providerId: string; url: string | null };

export type Target = { target: TrackerTarget; rep: Representation | null };

// What a reader is handed for each cursor, by object id: the object's
// representation on the provider and, for a label, the catalogue playlists it
// is read through.
export async function loadTargets(db: Pick<Db, 'query'>, t: TrackerRow, cursors: readonly Pick<LeasedCursor, 'objectId' | 'name' | 'cursor'>[]): Promise<Map<string, Target>> {
	const out = new Map<string, Target>();
	if (!cursors.length) return out;
	const rows = await db.query<{ object_id: string; related: boolean; provider_id: string; url: string | null }>(
		`select * from (
			select distinct on (so.object_id) so.object_id, false as related, so.provider_id, so.url, so.first_seen_at
			from curator.catalog_source_object so where so.object_id = any($1::uuid[]) and so.provider = $2
			order by so.object_id, so.first_seen_at
		) own
		union all
		select e.src, true, so.provider_id, so.url, so.first_seen_at
		from curator.catalog_edge e join curator.catalog_source_object so on so.object_id = e.dst and so.provider = $2 and so.kind = 'playlist'
		where $3 = 'label' and e.src = any($1::uuid[]) and e.kind = 'label-playlist' and e.role = 'catalogue'
		order by 5`,
		[`{${cursors.map((c) => c.objectId).join(',')}}`, t.provider, t.kind],
	);
	for (const c of cursors) {
		const own = rows.find((r) => r.object_id === c.objectId && !r.related);
		const rep = own ? { providerId: own.provider_id, url: own.url } : null;
		const related = rows.filter((r) => r.object_id === c.objectId && r.related).map((r) => ({ providerId: r.provider_id, url: r.url }));
		out.set(c.objectId, { target: { object: { id: c.objectId, kind: t.kind, name: c.name }, representation: rep, cursor: c.cursor, ...(related.length ? { related } : {}) }, rep });
	}
	return out;
}

// What a poll came to: the reader's result, or the error it met (a rate
// limit says how long the provider asked to wait).
export type PollOutcome = { poll: TrackerPoll } | { error: { message: string; rateLimitedSec: number | null } };
// `created`: the releases the poll brought into the catalogue (a main
// desktop completes them: catalog/work/background.ts).
export type ApplyResult = { polled: boolean; unchanged: boolean; calls: number; events: number; failed: boolean; limited: boolean; error: string | null; created: string[] };

export type PollToApply = { t: TrackerRow; c: Pick<LeasedCursor, 'objectId' | 'cursor' | 'failCount'>; rep: Representation | null; outcome: PollOutcome };

const errorOf = (e: unknown): { message: string; rateLimitedSec: number | null } => ({
	message: e instanceof Error ? e.message : String(e),
	rateLimitedSec: e instanceof TrackerRateLimitedError ? e.retryAfterSec : null,
});

// Applies polls' outcomes to their cursors: ingest and events for the changed
// listings, each cursor's next due time, the objects' scanned_at; or a
// failure's backoff. `holder` is recorded as the cursors' `last_reported_by`
// and the events' `raised_by`. The leases are cleared either way. The polls
// share their transactions; where one fails, each is applied on its own, so
// it fails alone.
export async function applyPolls(deps: { db: Db; log: Logger }, polls: readonly PollToApply[], opts: { holder: string; nowMs: number }): Promise<ApplyResult[]> {
	const results: ApplyResult[] = polls.map(() => ({ polled: false, unchanged: false, calls: 0, events: 0, failed: false, limited: false, error: null, created: [] }));
	const errors = new Map<number, { message: string; rateLimitedSec: number | null }>();
	const changed: Found[] = [];
	for (const [i, { t, c, rep, outcome }] of polls.entries()) {
		if ('error' in outcome) {
			errors.set(i, outcome.error);
			continue;
		}
		const { poll } = outcome;
		try {
			// Before the ingest: the poll's claims name the label by that id.
			if (poll.resolvedId && rep && t.kind === 'label') {
				const o = await repointRepresentation(deps.db, c.objectId, { provider: t.provider as CatalogProvider, from: rep.providerId, to: poll.resolvedId, url: rep.url ?? '' });
				if (o === 'owned_elsewhere') throw new Error(`${t.provider}:${poll.resolvedId} (${rep.providerId}) already belongs to another label`);
			}
		} catch (e) {
			errors.set(i, errorOf(e));
			continue;
		}
		results[i]!.polled = true;
		results[i]!.calls = poll.calls;
		if (poll.listingHash === c.cursor.listingHash) results[i]!.unchanged = true;
		else changed.push({ i, t, trackedId: c.objectId, poll });
	}
	// Together, then one by one if that failed.
	const each = async <T>(found: readonly Found[], run: (f: readonly Found[]) => Promise<T[]>): Promise<[Found, T][]> => {
		if (!found.length) return [];
		try {
			return (await run(found)).map((r, k) => [found[k]!, r]);
		} catch (e) {
			if (found.length === 1) {
				errors.set(found[0]!.i, errorOf(e));
				return [];
			}
			const out: [Found, T][] = [];
			for (const f of found) out.push(...(await each([f], run)));
			return out;
		}
	};
	const ingested = await each(changed, (f) => ingestFound(deps.db, f));
	const outcomes = new Map(ingested.map(([f, o]) => [f.i, o]));
	for (const [f, o] of ingested) results[f.i]!.created = o.filter((x) => x.kind === 'release' && x.created).map((x) => x.objectId);
	for (const [f, n] of await each(ingested.map(([f]) => f), (found) => raiseFound(deps.db, found.map((f) => ({ ...f, outcomes: outcomes.get(f.i)! })), opts.nowMs, opts.holder))) results[f.i]!.events = n;

	const done = polls.map((p, i) => ({ ...p, i })).filter((p): p is typeof p & { outcome: { poll: TrackerPoll } } => 'poll' in p.outcome && !errors.has(p.i));
	if (done.length) {
		const choices = await readCadencesOf(deps.db, done.map((p) => ({ objectId: p.c.objectId, kind: p.t.kind, provider: p.t.provider })));
		// scanned_at: read through, changed or not — the back office's "last scanned".
		await deps.db.query(
			`with x as materialized (select * from jsonb_to_recordset($1::text::jsonb) as x(object_id uuid, provider text, cursor jsonb, due float8)),
			seen as (update curator.catalog_object o set scanned_at = now() where o.id in (select object_id from x))
			update curator.catalog_cursor c set cursor = x.cursor, next_due_at = to_timestamp(x.due / 1000), last_run_at = now(),
				fail_count = 0, last_error = null, last_reported_by = $2, lease_holder = null, lease_until = null
			from x where c.object_id = x.object_id and c.provider = x.provider`,
			[
				JSON.stringify(
					done.map((p) => ({
						object_id: p.c.objectId,
						provider: p.t.provider,
						cursor: { ...p.outcome.poll.cursor, listingHash: p.outcome.poll.listingHash },
						due: nextDueFor(opts.nowMs, p.t.cadence, choices.get(`${p.c.objectId}|${p.t.provider}`)!, spreadOf(p.c.objectId)),
					})),
				),
				opts.holder,
			],
		);
	}
	const failed: unknown[] = [];
	for (const [i, { message, rateLimitedSec }] of errors) {
		const { t, c } = polls[i]!;
		const r = results[i]!;
		r.events = 0;
		r.failed = true;
		r.limited = rateLimitedSec !== null;
		r.error = message;
		const fails = c.failCount + 1;
		failed.push({
			object_id: c.objectId,
			provider: t.provider,
			due: rateLimitedSec !== null ? opts.nowMs + rateLimitedSec * 1000 : backoffAt(opts.nowMs, fails),
			fails: rateLimitedSec !== null ? c.failCount : fails,
			// tracking.ts providerPauses matches this text.
			error: rateLimitedSec !== null ? new TrackerRateLimitedError(rateLimitedSec).message : message.slice(0, 300),
		});
		deps.log.warn('tracker_poll_failed', { kind: t.kind, provider: t.provider, objectId: c.objectId, limited: r.limited, by: opts.holder, error: message.slice(0, 200) });
	}
	if (failed.length) {
		await deps.db.query(
			`update curator.catalog_cursor c set next_due_at = to_timestamp(x.due / 1000), last_run_at = now(), fail_count = x.fails,
				last_error = x.error, last_reported_by = $2, lease_holder = null, lease_until = null
			from jsonb_to_recordset($1::text::jsonb) as x(object_id uuid, provider text, due float8, fails int, error text)
			where c.object_id = x.object_id and c.provider = x.provider`,
			[JSON.stringify(failed), opts.holder],
		);
	}
	return results;
}

// Polls applied together: a minute's reading at the slowest provider's pace,
// well inside the lease.
const APPLY_EVERY = 10;

async function runTracker(deps: SweepDeps, t: TrackerRow, adapter: TrackerAdapter, now: () => number): Promise<TrackerPassResult> {
	const sleep = deps.sleep ?? defaultSleep;
	const r: TrackerPassResult = { kind: t.kind, provider: t.provider, claimed: 0, polled: 0, unchanged: 0, calls: 0, events: 0, failed: 0, budgetOut: false };
	const [run] = await deps.db.query<{ id: unknown }>(`insert into curator.tracker_run (kind, provider, worker) values ($1, $2, $3) returning id`, [t.kind, t.provider, deps.holder]);
	const errors: string[] = [];
	const leased = await leaseDue(deps.db, t, { holder: deps.holder, batch: deps.batch ?? 50, leaseMin: deps.leaseMin ?? 10 });
	r.claimed = leased.length;
	for (let at = 0; at < leased.length; at += APPLY_EVERY) {
		const chunk = leased.slice(at, at + APPLY_EVERY);
		// The chunk's calls in one reservation; what was not granted ends the pass.
		const granted = r.budgetOut ? 0 : Math.floor((await reserveCalls(deps.db, t.provider, adapter.callsPerPoll * chunk.length, t.budget.perDay)) / adapter.callsPerPoll);
		if (granted < chunk.length) r.budgetOut = true;
		const targets = await loadTargets(deps.db, t, chunk.slice(0, granted));
		const polls: PollToApply[] = [];
		const left: LeasedCursor[] = [...chunk.slice(granted)];
		let limited = false;
		for (const [k, c] of chunk.slice(0, granted).entries()) {
			// The provider asked us to wait: every other cursor of it would too.
			if (limited) {
				left.push(c);
				continue;
			}
			if (at + k > 0 && t.budget.minGapMs > 0) await sleep(t.budget.minGapMs);
			const { target, rep } = targets.get(c.objectId)!;
			let outcome: PollOutcome;
			try {
				outcome = { poll: await adapter.poll(target, AbortSignal.timeout(deps.pollTimeoutMs ?? 30_000)) };
			} catch (e) {
				outcome = { error: errorOf(e) };
			}
			limited = 'error' in outcome && outcome.error.rateLimitedSec !== null;
			polls.push({ t, c, rep, outcome });
		}
		if (limited) r.budgetOut = true;
		for (const a of await applyPolls(deps, polls, { holder: deps.holder, nowMs: now() })) {
			if (a.polled) r.polled++;
			if (a.unchanged) r.unchanged++;
			r.calls += a.calls;
			r.events += a.events;
			if (a.failed) {
				r.failed++;
				errors.push((a.error ?? '').slice(0, 200));
			}
		}
		await releaseLeases(deps.db, left.map((c) => ({ objectId: c.objectId, provider: t.provider })), deps.holder);
	}
	await deps.db.query(
		`update curator.tracker_run set finished_at = now(), claimed = $2::int, calls = $3::int, events = $4::int, failed = $5::int, errors = $6::text::jsonb where id = $1::bigint`,
		[String(run!.id), String(r.claimed), String(r.calls), String(r.events), String(r.failed), JSON.stringify(errors.slice(0, 20))],
	);
	if (r.claimed) deps.log.info('tracker_pass', { ...r });
	return r;
}

type Found = { i: number; t: TrackerRow; trackedId: string; poll: TrackerPoll };

// Ingests changed listings in one transaction: what each poll's children are.
async function ingestFound(db: Db, found: readonly Found[]): Promise<IngestOutcome[][]> {
	return withSystemTx(db, async (tx) => {
		const ingester = new Ingester(tx, { reason: 'tracker' });
		const selves = found.flatMap((f) => (f.poll.self ? [f.poll.self] : []));
		await ingester.claims(selves);
		const out: IngestOutcome[][] = [];
		const unplaced: { object_id: string; provider: string; at: number | null; value: unknown }[] = [];
		const claimsOf = (f: Found) => [...(f.poll.tentative ?? []), ...f.poll.children];
		const size = (f: Found): number => claimsOf(f).reduce((n, c) => n + nodes(c), 0);
		for (let at = 0; at < found.length; ) {
			let end = at;
			for (let n = 0; end < found.length && (end === at || n + size(found[end]!) <= BATCH_NODES); end++) n += size(found[end]!);
			const chunk = found.slice(at, end);
			const run = async (): Promise<void> => {
				for (const f of chunk) {
					ingester.forget();
					// An upload the catalogue can place joins its recording; one it
					// cannot is noted on the tracked object, never minted.
					for (const c of f.poll.tentative ?? []) {
						if (await ingester.attachIfKnown(c)) continue;
						unplaced.push({ object_id: f.trackedId, provider: f.t.provider, at: c.publishedAt ?? null, value: { provider: c.provider, id: c.providerId, title: c.name, url: c.url ?? null, artists: (c.artists ?? []).map((a) => a.name) } });
					}
					ingester.forget();
					out.push(await ingester.claims(f.poll.children));
				}
			};
			// One listing larger than a batch splits itself (Ingester.claims).
			if (chunk.length === 1 && size(chunk[0]!) > BATCH_NODES) await run();
			else await ingester.batch(chunk.flatMap(claimsOf), run);
			at = end;
		}
		if (unplaced.length) await noteUnplaced(tx, unplaced);
		for (const [k, f] of found.entries()) {
			if (f.poll.labelOf) await linkReleasesToLabel(tx, f.trackedId, out[k]!.map((o, j) => ({ objectId: o.objectId, claim: f.poll.children[j]! })).filter((r) => r.claim.kind === 'release'));
		}
		return out;
	});
}

function noteUnplaced(tx: Queryable, unplaced: readonly { object_id: string; provider: string; at: number | null; value: unknown }[]): Promise<unknown> {
	return tx.query(
		`insert into curator.catalog_signal (object_id, source_object_id, kind, value, observed_at)
		select x.object_id, (select s.id from curator.catalog_source_object s where s.object_id = x.object_id and s.provider = x.provider limit 1),
			'announcement', x.value, coalesce(to_timestamp(x.at / 1000), now())
		from jsonb_to_recordset($1::text::jsonb) as x(object_id uuid, provider text, at float8, value jsonb)`,
		[JSON.stringify(unplaced)],
	);
}

// Raises the events of ingested listings: how many, per listing.
async function raiseFound(db: Db, found: readonly (Found & { outcomes: IngestOutcome[] })[], nowMs: number, by: string): Promise<number[]> {
	const raised = found.map(() => 0);
	const windowOf = (t: TrackerRow): number => t.config.eventWindowDays ?? 14;
	await withSystemTx(db, async (tx) => {
		const releases: { k: number; releaseId: string; trackedId: string; publishedAt: number | null; windowDays: number }[] = [];
		for (const [k, f] of found.entries()) {
			const { t, trackedId, poll, outcomes } = f;
			// A genre's children are chart rows: the entries are the events, not
			// the releases behind them (a chart carries old releases too).
			if (t.kind === 'genre') {
				const chart = poll.chart ?? [];
				const ids = await findRepresentations(tx, chart.map((e) => e.recording));
				const entries = chart.flatMap((e) => {
					const recordingId = ids.get(`${e.recording.provider}|${e.recording.kind}|${e.recording.providerId}`);
					return recordingId ? [{ genreId: trackedId, recordingId, provider: t.provider as CatalogProvider, rank: e.rank }] : [];
				});
				const seqs = await raiseChartEntries(tx, entries, { nowMs, by });
				const fresh = entries.filter((_, j) => seqs[j] !== null).map((e) => e.recordingId);
				raised[k] = fresh.length;
				// A charted track the catalogue knew already was never queued for
				// its Spotify id; the chart makes it worth one (planner.ts).
				if (fresh.length) {
					await tx.query(
						`insert into curator.catalog_enrich_task (object_id, need, provider)
						select x.id, 'representation', 'spotify' from unnest($1::uuid[]) as x(id)
						where exists (select 1 from curator.catalog_identifier i where i.object_id = x.id and i.namespace = 'isrc')
							and not exists (select 1 from curator.catalog_source_object so where so.object_id = x.id and so.provider = 'spotify')
						on conflict do nothing`,
						[`{${fresh.join(',')}}`],
					);
				}
				continue;
			}
			// A playlist's children are its tracks, each an addition; an artist's
			// or label's are releases.
			const adds = t.kind === 'playlist' ? outcomes.flatMap((o, j) => (o.kind === 'recording' ? [{ o, child: poll.children[j]! }] : [])) : [];
			if (adds.length) {
				const [rep] = await tx.query<{ id: string }>(`select id from curator.catalog_source_object where object_id = $1 and provider = $2 limit 1`, [trackedId, t.provider]);
				const seqs = await raisePlaylistAdds(
					tx,
					adds.map(({ o, child }) => ({ playlistId: trackedId, recordingId: o.objectId, sourceObjectId: rep?.id ?? null, addedAt: child.publishedAt ?? null, position: child.facts?.trackNumber ?? null })),
					{ nowMs, windowDays: windowOf(t), by },
				);
				raised[k] = seqs.filter((s) => s !== null).length;
			}
			for (const [j, o] of outcomes.entries()) {
				if (o.kind === 'release') releases.push({ k, releaseId: o.objectId, trackedId, publishedAt: poll.children[j]!.publishedAt ?? null, windowDays: windowOf(t) });
			}
		}
		const seqs = await raiseReleaseEvents(tx, releases, { nowMs, by });
		for (const [j, r] of releases.entries()) if (seqs[j] !== null) raised[r.k]!++;
	});
	return raised;
}
