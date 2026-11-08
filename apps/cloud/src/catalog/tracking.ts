// What the trackers are doing, and "check now": the back office's Tracking
// page (backoffice/handler.ts reads, admin-ops.ts trackingCheck writes).
//
// A check only moves cursors' next_due_at: the worker's pass reads them, under
// the same leases, budgets and gaps as any other poll (trackers/sweep.ts), so
// no click can outrun a provider's limits. Three things keep a bulk check from
// costing more than it is worth: a provider that asked us to wait is left
// alone, a cursor read within the hour stays where it is, and a cursor being
// read now is not touched.

import type { Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';

export const TRACKING_KINDS = ['artist', 'label', 'playlist', 'genre'] as const;
export type TrackingKind = (typeof TRACKING_KINDS)[number];
export const TRACKING_STATES = ['due', 'reading', 'failing', 'never', 'untracked'] as const;
export type TrackingState = (typeof TRACKING_STATES)[number];

// A provider that asked us to wait: its most recent poll, of any object, was
// answered with a rate limit, and the wait it named has not passed. A later
// success ends it at once, so an old limit on one cursor says nothing.
//
// Per reader: a limit answered to one desktop (its IP, its login) says
// nothing about the cloud's reads or another desktop's, so the cloud looks
// only at polls it made itself (`last_reported_by` not a device's), and a
// device only at its own.
export type ProviderPause = { provider: string; until: number; error: string };

// Providers whose limit is per app, not per caller: a wait one device was
// asked for binds the cloud's own readers as well (they share the client id
// — Spotify allows one app per developer, cli/local.ts), so the cloud's view
// of the pauses takes a device's poll of them into account.
const SHARED_QUOTA_PROVIDERS = ['spotify'] as const;
const sharedQuotaSql = SHARED_QUOTA_PROVIDERS.map((p) => `'${p}'`).join(', ');

// The cursor's last_error as sweep.ts writes it from TrackerRateLimitedError.
const latestPolls = (holder: string | undefined): string =>
	`select distinct on (provider) provider, last_error, next_due_at
	from curator.catalog_cursor where last_run_at is not null
		and ${holder === undefined ? `(coalesce(last_reported_by, '') not like 'device:%' or provider in (${sharedQuotaSql}))` : `last_reported_by = $1`}
	order by provider, last_run_at desc`;
const PAUSED_WHERE = `last_error like 'rate limited%' and next_due_at > now()`;

// `holder`: a device's (`device:<id>`); absent, the cloud's own view.
export async function providerPauses(q: Queryable, opts: { holder?: string } = {}): Promise<ProviderPause[]> {
	const rows = await q.query<{ provider: string; last_error: string; until_ms: unknown }>(
		`select provider, last_error, extract(epoch from next_due_at) * 1000 as until_ms from (${latestPolls(opts.holder)}) l where ${PAUSED_WHERE} order by provider`,
		opts.holder === undefined ? [] : [opts.holder],
	);
	return rows.map((r) => ({ provider: r.provider, until: num(r.until_ms), error: r.last_error }));
}

// Whether some watcher of the cursor's object wants its tracker read: a
// watcher whose worker row lists the tracker (`trackerExpr`, 'kind/provider'
// as an SQL expression), or who never said (no row, or a row from before the
// choices existed: null). The lease (trackers/sweep.ts leaseDue) and this
// page share it, so they count the same cursors as switched off.
export const wantedSql = (cursor: string, trackerExpr: string): string =>
	`exists (
		select 1 from curator.catalog_watch w left join curator.catalog_worker k on k.user_id = w.user_id
		where w.object_id = ${cursor}.object_id and (k.trackers is null or ${trackerExpr} = any(k.trackers))
	)`;
export const SWITCHED_OFF = 'switched off by its followers';

// The devices reading for their users this week, as the back office shows
// them (cli/local.ts / worker/main.ts hand their own adapters in beside).
// `providers`: what the device can read right now; `trackers`: what its user
// checked ('kind/provider'), null when it never said.
export type CatalogWorkerView = { userId: string; deviceId: string; name: string; providers: string[]; trackers: string[] | null; weekOf: string; checkedInAt: number; live: boolean };

export async function liveWorkers(q: Queryable): Promise<CatalogWorkerView[]> {
	const rows = await q.query<{ user_id: string; device_id: string; name: string; providers: string; trackers: string | null; week_of: string; checked_ms: unknown; live: boolean }>(
		`select w.user_id, w.device_id, d.name, array_to_json(w.providers)::text as providers, array_to_json(w.trackers)::text as trackers, w.week_of::text as week_of,
			extract(epoch from w.checked_in_at) * 1000 as checked_ms, w.checked_in_at > now() - interval '6 hours' as live
		from curator.catalog_worker w join curator.device d on d.user_id = w.user_id and d.device_id = w.device_id
		order by w.checked_in_at desc`,
	);
	return rows.map((r) => ({
		userId: r.user_id,
		deviceId: r.device_id,
		name: r.name,
		providers: JSON.parse(r.providers) as string[],
		trackers: r.trackers === null ? null : (JSON.parse(r.trackers) as string[]),
		weekOf: r.week_of,
		checkedInAt: num(r.checked_ms),
		live: r.live,
	}));
}

// A live device reads the tracker when its user checked it (or never said)
// and it can read the provider now.
export const workerReads = (w: CatalogWorkerView, kind: string, provider: string): boolean =>
	w.live && w.providers.includes(provider) && (w.trackers === null || w.trackers.includes(`${kind}/${provider}`));

export type TrackerOverview = {
	kind: TrackingKind;
	provider: string;
	enabled: boolean;
	// Whether this host's worker can read it (no key, no adapter: its cursors
	// stay due). Null when the host runs no worker (the cloud back office).
	reader: boolean | null;
	everyMin: number | null;
	cursors: number;
	// Cursors no follower wants read on this source (every one of them
	// unchecked it in their Refresh menu): read by nobody, cloud included.
	unwanted: number;
	checkedDay: number;
	due: number;
	reading: number;
	failing: number;
	never: number;
	lastCheckedAt: number | null;
	nextDueAt: number | null;
	// The provider's calls today, shared by its trackers, against this one's cap.
	callsToday: number;
	callsPerDay: number | null;
	// Its passes over the last day (tracker_run).
	read: number;
	events: number;
	failed: number;
};

export type TrackingOverview = {
	at: number;
	kinds: { kind: TrackingKind; followed: number; tracked: number }[];
	trackers: TrackerOverview[];
	pauses: ProviderPause[];
	// The devices reading for their users (catalog_worker), live or not.
	workers: CatalogWorkerView[];
};

// Whether something reads a tracker: an adapter in this process (`readers`,
// when the host runs a worker pass), or a device checked in within the
// window offering the provider. Null when the host knows neither.
function readerOf(readers: readonly { provider: string; kinds: readonly string[] }[] | undefined, workers: CatalogWorkerView[], provider: string, kind: string): boolean | null {
	const here = readers?.some((r) => r.provider === provider && r.kinds.includes(kind)) ?? false;
	const byWorker = workers.some((w) => workerReads(w, kind, provider));
	if (!readers && !workers.some((w) => w.live)) return null;
	return here || byWorker;
}

// tracker_run gains a row per tracker per pass and has no index on time. Its
// newest rows by id are enough for a day, on any number of workers we run.
const RUN_WINDOW_ROWS = 30_000;

export async function trackingOverview(q: Queryable, readers?: readonly { provider: string; kinds: readonly string[] }[]): Promise<TrackingOverview> {
	const workers = await liveWorkers(q);
	const [kinds, trackers, runs, pauses] = [
		await q.query<{ kind: TrackingKind; followed: unknown; tracked: unknown }>(
			`select o.kind, count(*) as followed, count(*) filter (where exists (select 1 from curator.catalog_cursor c where c.object_id = o.id)) as tracked
			from curator.catalog_object o
			where o.watch_count > 0 and o.merged_into is null and o.kind = any($1::text[])
			group by o.kind`,
			[`{${TRACKING_KINDS.join(',')}}`],
		),
		await q.query<{ kind: TrackingKind; provider: string; enabled: boolean; cadence: string; budget: string; cursors: unknown; unwanted: unknown; checked_day: unknown; due: unknown; reading: unknown; failing: unknown; never: unknown; last_ms: unknown; next_ms: unknown; used: unknown }>(
			`select t.kind, t.provider, t.enabled, t.cadence::text as cadence, t.budget::text as budget,
				count(c.object_id) as cursors,
				count(*) filter (where c.object_id is not null and not ${wantedSql('c', `(t.kind || '/' || t.provider)`)}) as unwanted,
				count(*) filter (where c.last_run_at > now() - interval '1 day') as checked_day,
				count(*) filter (where c.next_due_at <= now()) as due,
				count(*) filter (where c.lease_until > now()) as reading,
				count(*) filter (where c.last_error is not null) as failing,
				count(*) filter (where c.object_id is not null and c.last_run_at is null) as never,
				extract(epoch from max(c.last_run_at)) * 1000 as last_ms,
				extract(epoch from min(c.next_due_at) filter (where c.next_due_at > now())) * 1000 as next_ms,
				coalesce((select b.units_used from curator.provider_budget b where b.provider = t.provider and b.day = (now() at time zone 'utc')::date), 0) as used
			from curator.tracker t
			left join (curator.catalog_cursor c join curator.catalog_object o on o.id = c.object_id and o.merged_into is null) on c.provider = t.provider and o.kind = t.kind
			where t.kind = any($1::text[])
			group by t.kind, t.provider, t.enabled, t.cadence::text, t.budget::text
			order by t.kind, t.provider`,
			[`{${TRACKING_KINDS.join(',')}}`],
		),
		await q.query<{ kind: string; provider: string; read: unknown; events: unknown; failed: unknown }>(
			`select kind, provider, sum(claimed) as read, sum(events) as events, sum(failed) as failed
			from curator.tracker_run
			where id > (select coalesce(max(id), 0) - $1::bigint from curator.tracker_run) and started_at > now() - interval '1 day'
			group by kind, provider`,
			[String(RUN_WINDOW_ROWS)],
		),
		await providerPauses(q),
	];
	const runOf = new Map(runs.map((r) => [`${r.kind}/${r.provider}`, r]));
	return {
		at: Date.now(),
		kinds: TRACKING_KINDS.map((kind) => {
			const k = kinds.find((r) => r.kind === kind);
			return { kind, followed: k ? num(k.followed) : 0, tracked: k ? num(k.tracked) : 0 };
		}),
		trackers: trackers.map((t) => {
			const run = runOf.get(`${t.kind}/${t.provider}`);
			const cadence = JSON.parse(t.cadence) as { everyMin?: number };
			const budget = JSON.parse(t.budget) as { perDay?: number };
			return {
				kind: t.kind,
				provider: t.provider,
				enabled: t.enabled,
				reader: readerOf(readers, workers, t.provider, t.kind),
				everyMin: cadence.everyMin ?? null,
				cursors: num(t.cursors),
				unwanted: num(t.unwanted),
				checkedDay: num(t.checked_day),
				due: num(t.due),
				reading: num(t.reading),
				failing: num(t.failing),
				never: num(t.never),
				lastCheckedAt: numOrNull(t.last_ms),
				nextDueAt: numOrNull(t.next_ms),
				callsToday: num(t.used),
				callsPerDay: budget.perDay ?? null,
				read: run ? num(run.read) : 0,
				events: run ? num(run.events) : 0,
				failed: run ? num(run.failed) : 0,
			};
		}),
		pauses,
		workers,
	};
}

export type TrackingCursor = { provider: string; lastCheckedAt: number | null; nextDueAt: number; reading: boolean; failCount: number; lastError: string | null };
export type TrackingRow = { id: string; kind: TrackingKind; name: string; watchers: number; scannedAt: number | null; cursors: TrackingCursor[] };
export type TrackingFilter = { id?: string; kind?: TrackingKind; provider?: string; state?: TrackingState; q?: string; offset?: number; limit?: number };

const CURSOR_STATE: Record<Exclude<TrackingState, 'untracked'>, string> = {
	due: 'c.next_due_at <= now()',
	reading: 'c.lease_until > now()',
	failing: 'c.last_error is not null',
	never: 'c.last_run_at is null',
};

// The followed objects and their cursors, most overdue first. `provider` and
// `state` read as one question: "the labels whose Beatport check is due".
// A named object is answered whether anyone follows it or not, so its page can
// say so.
export async function trackingObjects(q: Queryable, f: TrackingFilter): Promise<{ total: number; rows: TrackingRow[] }> {
	const params: string[] = [`{${TRACKING_KINDS.join(',')}}`];
	const bind = (v: string): string => `$${params.push(v)}`;
	const where = ['o.merged_into is null', 'o.kind = any($1::text[])'];
	if (f.id) where.push(`o.id = ${bind(f.id)}::uuid`);
	else where.push('o.watch_count > 0');
	if (f.kind) where.push(`o.kind = ${bind(f.kind)}`);
	if (f.q) where.push(`o.name ilike ${bind(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`)}`);
	if (f.state === 'untracked') {
		where.push(`not exists (select 1 from curator.catalog_cursor c where c.object_id = o.id)`);
	} else if (f.state || f.provider) {
		const on = ['c.object_id = o.id'];
		if (f.provider) on.push(`c.provider = ${bind(f.provider)}`);
		if (f.state) on.push(CURSOR_STATE[f.state]);
		where.push(`exists (select 1 from curator.catalog_cursor c where ${on.join(' and ')})`);
	}
	const from = `from curator.catalog_object o where ${where.join(' and ')}`;
	const [count] = await q.query<{ n: unknown }>(`select count(*) as n ${from}`, params);
	const rows = await q.query<{ id: string; kind: TrackingKind; name: string; watch_count: unknown; scanned_ms: unknown }>(
		`select o.id, o.kind, o.name, o.watch_count, extract(epoch from o.scanned_at) * 1000 as scanned_ms ${from}
		order by (select min(c.next_due_at) from curator.catalog_cursor c where c.object_id = o.id) nulls last, o.name, o.id
		limit ${Math.min(Math.max(f.limit ?? 50, 1), 200)} offset ${Math.max(f.offset ?? 0, 0)}`,
		params,
	);
	if (!rows.length) return { total: num(count!.n), rows: [] };
	const cursors = await q.query<{ object_id: string; provider: string; last_ms: unknown; next_ms: unknown; reading: boolean; fail_count: unknown; last_error: string | null }>(
		`select object_id, provider, extract(epoch from last_run_at) * 1000 as last_ms, extract(epoch from next_due_at) * 1000 as next_ms,
			coalesce(lease_until > now(), false) as reading, fail_count, last_error
		from curator.catalog_cursor where object_id = any($1::uuid[]) order by provider`,
		[`{${rows.map((r) => r.id).join(',')}}`],
	);
	return {
		total: num(count!.n),
		rows: rows.map((r) => ({
			id: r.id,
			kind: r.kind,
			name: r.name,
			watchers: num(r.watch_count),
			scannedAt: numOrNull(r.scanned_ms),
			cursors: cursors
				.filter((c) => c.object_id === r.id)
				.map((c) => ({ provider: c.provider, lastCheckedAt: numOrNull(c.last_ms), nextDueAt: num(c.next_ms), reading: c.reading, failCount: num(c.fail_count), lastError: c.last_error })),
		})),
	};
}

// What to check: one object, or everything followed (all, or of one kind),
// optionally on one provider. A device's check (workers.ts workerDue) adds
// its user: only that user's follows, and only on the trackers the user
// checked ('kind/provider').
export type CheckScope = { id?: string; kind?: TrackingKind; all?: boolean; provider?: string; userId?: string; trackers?: readonly string[] };

// Per provider, what became of its cursors:
//   queued      due now, the worker reads them next;
//   alreadyDue  were due anyway;
//   recent      read within the hour, left where they are (bulk only: a
//               check of one named object is a deliberate ask);
//   reading     being read right now;
//   paused      the provider asked us to wait (`pauses` says until when).
export type CheckProviderReport = { provider: string; queued: number; alreadyDue: number; recent: number; reading: number; paused: number };
export type CheckReport = { queued: number; byProvider: CheckProviderReport[]; pauses: ProviderPause[]; started: boolean };

// ---- the worker's queue ----------------------------------------------------
//
// Everything the worker's pass picks up, as lanes: a tracker (kind × source)
// reads due cursors, a task (need × provider) works the enrichment queue
// (profile, backfill, fill, …), the reasoner its cases. Per lane: what waits,
// what is being worked on (leased) right now, what cannot move and why, what
// comes due within the hour, and — for trackers, whose reads leave a stamp —
// how many went through in the last hour, so the wait can be estimated.

export type QueueLane = {
	lane: 'tracker' | 'task' | 'reasoner';
	// A tracker's object kind, a task's need, the reasoner's case kind.
	kind: string;
	provider: string;
	waiting: number;
	processing: number;
	// Due but unable to move: the provider asked us to wait, nothing in this
	// process can read it, or every follower switched the source off.
	// `blockedWhy` says which.
	blocked: number;
	blockedWhy: string | null;
	// When a provider's pause ends (the page says it in local time).
	blockedUntil: number | null;
	failing: number;
	// The longest-waiting due item became due at this time.
	oldestDueAt: number | null;
	upcomingHour: number;
	// Gone through in the last hour (trackers only: a task row is deleted when done).
	doneHour: number | null;
	// Minutes until the waiting ones are through at the last hour's pace.
	etaMin: number | null;
};

export type QueueOverview = {
	at: number;
	totals: { waiting: number; processing: number; blocked: number; failing: number; doneHour: number };
	lanes: QueueLane[];
	pauses: ProviderPause[];
};

export type ReaderNote = { provider: string; kind: string; why: string };

export async function queueOverview(
	q: Queryable,
	opts: { readers?: readonly { provider: string; kinds: readonly string[] }[]; notes?: readonly ReaderNote[] } = {},
): Promise<QueueOverview> {
	const pauses = await providerPauses(q);
	const pausedUntil = new Map(pauses.map((p) => [p.provider, p.until]));
	const workers = await liveWorkers(q);
	const blockedWhy = (kind: string, provider: string, tracker: boolean): string | null => {
		const until = pausedUntil.get(provider);
		if (until) return `${provider} asked us to wait`;
		if (!tracker) return null;
		const reader = readerOf(opts.readers, workers, provider, kind);
		if (reader !== false) return null;
		return opts.notes?.find((n) => n.provider === provider && n.kind === kind)?.why ?? 'nothing in this process or on a checked-in desktop can read it';
	};
	const trackers = await q.query<{ kind: string; provider: string; due: unknown; unwanted: unknown; leased: unknown; failing: unknown; oldest_ms: unknown; upcoming: unknown; done: unknown }>(
		`select o.kind, c.provider,
			count(*) filter (where c.next_due_at <= now() and not coalesce(c.lease_until > now(), false)) as due,
			count(*) filter (where c.next_due_at <= now() and not coalesce(c.lease_until > now(), false) and not ${wantedSql('c', `(o.kind || '/' || c.provider)`)}) as unwanted,
			count(*) filter (where c.lease_until > now()) as leased,
			count(*) filter (where c.last_error is not null) as failing,
			extract(epoch from min(c.next_due_at) filter (where c.next_due_at <= now())) * 1000 as oldest_ms,
			count(*) filter (where c.next_due_at > now() and c.next_due_at <= now() + interval '1 hour') as upcoming,
			count(*) filter (where c.last_run_at > now() - interval '1 hour') as done
		from curator.catalog_cursor c
		join curator.catalog_object o on o.id = c.object_id and o.merged_into is null
		join curator.tracker t on t.kind = o.kind and t.provider = c.provider and t.enabled
		group by o.kind, c.provider`,
	);
	const tasks = await q.query<{ need: string; provider: string; due: unknown; leased: unknown; failing: unknown; oldest_ms: unknown; upcoming: unknown }>(
		`select need, provider,
			count(*) filter (where next_due_at <= now() and not coalesce(lease_until > now(), false)) as due,
			count(*) filter (where lease_until > now()) as leased,
			count(*) filter (where last_error is not null) as failing,
			extract(epoch from min(next_due_at) filter (where next_due_at <= now())) * 1000 as oldest_ms,
			count(*) filter (where next_due_at > now() and next_due_at <= now() + interval '1 hour') as upcoming
		from curator.catalog_enrich_task group by need, provider`,
	);
	const cases = await q.query<{ kind: string; due: unknown; leased: unknown; oldest_ms: unknown }>(
		`select kind,
			count(*) filter (where status = 'queued' and next_due_at <= now()) as due,
			count(*) filter (where status = 'leased') as leased,
			extract(epoch from min(next_due_at) filter (where status = 'queued' and next_due_at <= now())) * 1000 as oldest_ms
		from curator.catalog_agent_case where status in ('queued', 'leased') group by kind`,
	);
	// `unwanted` (trackers only): due cursors every follower switched off. A
	// pause or a missing reader blocks the whole lane and is the reason given;
	// otherwise those alone are blocked, for that reason.
	const lane = (l: Omit<QueueLane, 'blocked' | 'blockedWhy' | 'blockedUntil' | 'etaMin'>, tracker: boolean, unwanted = 0): QueueLane => {
		let why = l.waiting > 0 ? blockedWhy(l.kind, l.provider, tracker) : null;
		let blocked = why ? l.waiting : 0;
		if (!why && unwanted > 0) {
			why = SWITCHED_OFF;
			blocked = unwanted;
		}
		const waiting = l.waiting - blocked;
		return { ...l, waiting, blocked, blockedWhy: why, blockedUntil: why ? (pausedUntil.get(l.provider) ?? null) : null, etaMin: waiting > 0 && l.doneHour ? Math.ceil((waiting / l.doneHour) * 60) : null };
	};
	const lanes: QueueLane[] = [
		...trackers.map((r) => lane({ lane: 'tracker', kind: r.kind, provider: r.provider, waiting: num(r.due), processing: num(r.leased), failing: num(r.failing), oldestDueAt: numOrNull(r.oldest_ms), upcomingHour: num(r.upcoming), doneHour: num(r.done) }, true, num(r.unwanted))),
		...tasks.map((r) => lane({ lane: 'task', kind: r.need, provider: r.provider, waiting: num(r.due), processing: num(r.leased), failing: num(r.failing), oldestDueAt: numOrNull(r.oldest_ms), upcomingHour: num(r.upcoming), doneHour: null }, false)),
		...cases.map((r) => lane({ lane: 'reasoner', kind: r.kind, provider: 'agent', waiting: num(r.due), processing: num(r.leased), failing: 0, oldestDueAt: numOrNull(r.oldest_ms), upcomingHour: 0, doneHour: null }, false)),
	]
		.filter((l) => l.waiting + l.processing + l.blocked + l.failing + l.upcomingHour > 0 || (l.doneHour ?? 0) > 0)
		.sort((a, b) => b.processing - a.processing || b.waiting - a.waiting || b.blocked - a.blocked || a.kind.localeCompare(b.kind));
	const sum = (f: (l: QueueLane) => number) => lanes.reduce((n, l) => n + f(l), 0);
	return {
		at: Date.now(),
		totals: { waiting: sum((l) => l.waiting), processing: sum((l) => l.processing), blocked: sum((l) => l.blocked), failing: sum((l) => l.failing), doneHour: sum((l) => l.doneHour ?? 0) },
		lanes,
		pauses,
	};
}

export async function checkNow(tx: Queryable, scope: CheckScope): Promise<Omit<CheckReport, 'started'>> {
	if (!scope.id && !scope.kind && !scope.all) throw new Error('say what to check: an object id, a kind, or all');
	const params: string[] = [];
	const bind = (v: string): string => `$${params.push(v)}`;
	const where = ['o.merged_into is null', 't.enabled'];
	if (scope.id) where.push(`o.id = ${bind(scope.id)}::uuid`);
	if (scope.kind) where.push(`o.kind = ${bind(scope.kind)}`);
	if (scope.provider) where.push(`c.provider = ${bind(scope.provider)}`);
	if (scope.userId) where.push(`exists (select 1 from curator.catalog_watch w where w.object_id = o.id and w.user_id = ${bind(scope.userId)}::uuid)`);
	if (scope.trackers) where.push(`(o.kind || '/' || c.provider) = any(${bind(`{${scope.trackers.join(',')}}`)}::text[])`);
	const recent = scope.id ? 'false' : `c.last_run_at > now() - interval '1 hour'`;
	const rows = await tx.query<{ provider: string; outcome: keyof Omit<CheckProviderReport, 'provider'>; n: unknown }>(
		`with paused as (select provider from (${latestPolls(undefined)}) l where ${PAUSED_WHERE}),
		picked as (
			select c.object_id, c.provider,
				case
					when c.lease_until > now() then 'reading'
					when c.provider in (select provider from paused) then 'paused'
					when c.next_due_at <= now() then 'alreadyDue'
					when ${recent} then 'recent'
					else 'queued'
				end as outcome
			from curator.catalog_cursor c
			join curator.catalog_object o on o.id = c.object_id
			join curator.tracker t on t.kind = o.kind and t.provider = c.provider
			where ${where.join(' and ')}
		),
		moved as (
			update curator.catalog_cursor c set next_due_at = now()
			from picked p where p.outcome = 'queued' and c.object_id = p.object_id and c.provider = p.provider
			returning 1
		)
		select provider, outcome, count(*) as n from picked group by provider, outcome order by provider`,
		params,
	);
	const byProvider = new Map<string, CheckProviderReport>();
	for (const r of rows) {
		const p = byProvider.get(r.provider) ?? { provider: r.provider, queued: 0, alreadyDue: 0, recent: 0, reading: 0, paused: 0 };
		p[r.outcome] = num(r.n);
		byProvider.set(r.provider, p);
	}
	const list = [...byProvider.values()];
	return { queued: list.reduce((n, p) => n + p.queued, 0), byProvider: list, pauses: await providerPauses(tx) };
}
