// Desktops as catalogue workers ('catalog_workers', protocol catalog-service.ts
// workers section; the plan in ~/.claude/plans/snuggly-percolating-corbato.md).
//
// A desktop reads the catalogue's providers for the objects its user follows
// and reports each poll; the cloud keeps the cursors, budgets, ingest and
// events, and applies a reported poll with the same code as its own
// (trackers/sweep.ts). The master decides nothing per cursor: one row per
// user says which device is the week's worker (catalog_worker), and the
// cursors it may take are the user's watches, joined at lease time.
//
//   workerDue    — every minute: the device offers its providers (never the
//                  cloud's keyed ones) and its user's checked trackers (the
//                  Refresh menu; cloud-only ones included, so the master
//                  knows whether anyone wants them) and how often the user
//                  wants each kind read (the cursors are timed by it:
//                  tracking.ts readCadencesOf), takes or keeps the week, runs
//                  the check a Refresh asked for, and is handed its due
//                  cursors of the checked trackers under a ten-minute lease
//                  with the poll's calls reserved.
//   workerReport — the polls, or the errors the readers met. A result whose
//                  lease the device no longer holds (lapsed, a resend after a
//                  timeout) is `stale`: nothing of it is applied, so a resend
//                  is safe. The calls a poll made beyond its reservation are
//                  debited; one complete tracker_run row per kind × provider
//                  names the device.
//
// A rate limit a device meets parks the provider for that device alone
// (tracking.ts providerPauses by holder): its IP and login are not the
// cloud's.

import { CATALOG_TRACKERS, type CatalogCheckReport, type CatalogProvider, type CatalogReadCadenceChoices, type CatalogWorkerDueInput, type CatalogWorkerDueResult, type CatalogWorkerReportInput, type CatalogWorkerReportResult, type CatalogWorkerTask } from '@curator/protocol';
import { callsPerPoll } from '@curator/catalog-readers';
import type { Caller } from '../account/device-gate.js';
import { num } from '../db/db.js';
import type { Logger } from '../log.js';
import { gated, type CatalogDeps } from './catalog.js';
import { checkNow, providerPauses, retimeCursors } from './tracking.js';
import { applyPolls, deviceHolder, leaseDue, loadTargets, loadTrackers, releaseLeases, reserveCalls, WORKER_LIVE_WINDOW, type LeasedCursor, type PollToApply, type TrackerRow } from './trackers/sweep.js';

export type WorkerDeps = CatalogDeps & { log: Logger };

// Cursors handed out per tracker per call: a tick's work, well inside the
// lease; the next call brings the rest.
const BATCH = 10;
const LEASE_MIN = 10;
// The apply's own hold on a cursor while a report is worked through.
const APPLY_LEASE = `interval '2 minutes'`;
const POLL_TIMEOUT_MS = 30_000;
// Their keys are the cloud's; a device offering them is ignored.
const CLOUD_ONLY: ReadonlySet<string> = new Set(CATALOG_TRACKERS.filter((t) => t.cloudOnly).map((t) => t.provider));

const DAY = 86400_000;

// Monday 00:00 UTC after `nowMs`: when the week's holder is up for replacement.
export function weekEndsAt(nowMs: number): number {
	const d = new Date(nowMs);
	const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	const daysToMonday = (8 - d.getUTCDay()) % 7 || 7;
	return midnight + daysToMonday * DAY;
}

export async function workerDue(deps: WorkerDeps, userId: string, caller: Caller, input: CatalogWorkerDueInput): Promise<CatalogWorkerDueResult> {
	const holder = deviceHolder(input.deviceId);
	const providers = input.providers.filter((p) => !CLOUD_ONLY.has(p));
	// Take the week, keep it, or find it held: one upsert. The holder's row is
	// touched every call; another device's only once it is stale or last week's.
	// The check runs in the same transaction, whoever holds the week: what it
	// makes due is leased below by the holder, or read by the cloud.
	const { active, check } = await gated(deps, userId, caller, input.deviceId, async (tx) => {
		// The choices on record, to see below whether this call changes them.
		const [prev] = input.cadence ? await tx.query<{ cadence: string | null }>(`select cadence::text as cadence from curator.catalog_worker where user_id = $1`, [userId]) : [];
		const rows = await tx.query<{ device_id: string }>(
			`insert into curator.catalog_worker as k (user_id, device_id, providers, trackers, cadence, week_of, checked_in_at)
			values ($1, $2, $3::text[], $4::text[], $5::text::jsonb, (date_trunc('week', now() at time zone 'utc'))::date, now())
			on conflict (user_id) do update set device_id = excluded.device_id, providers = excluded.providers, trackers = excluded.trackers, cadence = excluded.cadence, week_of = excluded.week_of, checked_in_at = now()
				where k.device_id = excluded.device_id or k.week_of < excluded.week_of or k.checked_in_at < now() - ${WORKER_LIVE_WINDOW}
			returning device_id`,
			[userId, input.deviceId, `{${providers.join(',')}}`, `{${input.trackers.join(',')}}`, input.cadence ? JSON.stringify(input.cadence) : null],
		);
		// The holder's choices are the ones that count, like its trackers.
		if (rows.length && input.cadence) {
			const moved = await retimeCursors(tx, userId, prev?.cadence ? (JSON.parse(prev.cadence) as CatalogReadCadenceChoices) : null, input.cadence);
			if (moved) deps.log.info('worker_cadence_retimed', { by: holder, moved, cadence: input.cadence });
		}
		let check: CatalogCheckReport | undefined;
		if (input.check) {
			const r = await checkNow(tx, { ...(input.check.kind ? { kind: input.check.kind } : { all: true }), userId, trackers: input.trackers });
			check = {
				queued: r.queued,
				byProvider: r.byProvider.map((p) => ({ ...p, provider: p.provider as CatalogProvider })),
				pauses: r.pauses.map((p) => ({ provider: p.provider as CatalogProvider, until: p.until })),
			};
		}
		return { active: rows.length > 0, check };
	});
	const ends = weekEndsAt(Date.now());
	const withCheck = <T extends CatalogWorkerDueResult>(r: T): T => (check ? { ...r, check } : r);
	if (!active) return withCheck({ active: false, weekEndsAt: ends, tasks: [], pauses: [] });
	const pauses = await providerPauses(deps.db, { holder });
	const paused = new Set<string>([...pauses.map((p) => p.provider), ...(input.paused ?? []).filter((p) => p.until > Date.now()).map((p) => p.provider)]);
	const offered = new Set<string>(providers);
	const wanted = new Set<string>(input.trackers);
	const tasks: CatalogWorkerTask[] = [];
	for (const t of await loadTrackers(deps.db)) {
		if (!offered.has(t.provider) || paused.has(t.provider) || !wanted.has(`${t.kind}/${t.provider}`)) continue;
		const want = callsPerPoll(t.provider, t.kind);
		const leased = await leaseDue(deps.db, t, { holder, batch: BATCH, leaseMin: LEASE_MIN, worker: { userId } });
		if (!leased.length) continue;
		const granted = Math.floor((await reserveCalls(deps.db, t.provider, want * leased.length, t.budget.perDay)) / want);
		await releaseLeases(deps.db, leased.slice(granted).map((c) => ({ objectId: c.objectId, provider: t.provider })), holder);
		const targets = await loadTargets(deps.db, t, leased.slice(0, granted));
		for (const c of leased.slice(0, granted)) {
			tasks.push({ objectId: c.objectId, provider: t.provider as CatalogProvider, kind: t.kind, target: targets.get(c.objectId)!.target, minGapMs: t.budget.minGapMs, timeoutMs: POLL_TIMEOUT_MS });
		}
	}
	return withCheck({ active: true, weekEndsAt: ends, tasks, pauses: pauses.map((p) => ({ provider: p.provider as CatalogProvider, until: p.until })) });
}

export async function workerReport(deps: WorkerDeps, userId: string, caller: Caller, input: CatalogWorkerReportInput): Promise<CatalogWorkerReportResult> {
	const holder = deviceHolder(input.deviceId);
	await gated(deps, userId, caller, input.deviceId, async () => undefined);
	const trackers = new Map((await loadTrackers(deps.db)).map((t) => [`${t.kind}/${t.provider}`, t]));
	const out: CatalogWorkerReportResult = { applied: 0, stale: 0, events: 0 };
	const runs = new Map<string, { t: TrackerRow; claimed: number; calls: number; events: number; failed: number; errors: string[] }>();
	const nowMs = Date.now();
	// The apply takes the leases over from the device, atomically: a lapsed or
	// foreign lease, or a result already applied, is stale.
	const keyOf = (objectId: string, provider: string): string => `${objectId}|${provider}`;
	const results = new Map<string, CatalogWorkerReportInput['results'][number]>();
	for (const r of input.results) if (!results.has(keyOf(r.objectId, r.provider))) results.set(keyOf(r.objectId, r.provider), r);
	const taken = input.results.length
		? await deps.db.query<{ object_id: string; provider: string; kind: string; name: string; cursor: string; fail_count: unknown }>(
				`update curator.catalog_cursor c set lease_holder = $3, lease_until = now() + ${APPLY_LEASE}
				from jsonb_to_recordset($1::text::jsonb) as x(object_id uuid, provider text), curator.catalog_object o
				where c.object_id = x.object_id and c.provider = x.provider and o.id = c.object_id and c.lease_holder = $2 and c.lease_until > now()
				returning c.object_id, c.provider, o.kind, o.name, c.cursor::text as cursor, c.fail_count`,
				[JSON.stringify([...results.values()].map((r) => ({ object_id: r.objectId, provider: r.provider }))), holder, `apply:${holder}`],
			)
		: [];
	const off: { objectId: string; provider: string }[] = [];
	const byTracker = new Map<TrackerRow, LeasedCursor[]>();
	for (const c of taken) {
		const t = trackers.get(`${c.kind}/${c.provider}`);
		// The tracker was switched off since the lease: let the cursor go.
		if (!t) {
			off.push({ objectId: c.object_id, provider: c.provider });
			continue;
		}
		const list = byTracker.get(t) ?? [];
		list.push({ objectId: c.object_id, name: c.name, cursor: JSON.parse(c.cursor) as Record<string, unknown>, failCount: num(c.fail_count) });
		byTracker.set(t, list);
	}
	await releaseLeases(deps.db, off, `apply:${holder}`);
	const applying = new Map<string, PollToApply>();
	for (const [t, cursors] of byTracker) {
		const targets = await loadTargets(deps.db, t, cursors);
		for (const c of cursors) applying.set(keyOf(c.objectId, t.provider), { t, c, rep: targets.get(c.objectId)!.rep, outcome: results.get(keyOf(c.objectId, t.provider))!.outcome });
	}
	// In the order reported.
	const polls = [...results.keys()].flatMap((k) => applying.get(k) ?? []);
	out.stale = input.results.length - polls.length;
	const extra = new Map<string, { t: TrackerRow; calls: number }>();
	for (const [i, a] of (await applyPolls(deps, polls, { holder, nowMs })).entries()) {
		const { t, outcome } = polls[i]!;
		out.applied++;
		out.events += a.events;
		if ('poll' in outcome) {
			// Reserved at due; only what the poll used beyond that is debited now.
			const over = outcome.poll.calls - callsPerPoll(t.provider, t.kind);
			if (over > 0) extra.set(t.provider, { t, calls: (extra.get(t.provider)?.calls ?? 0) + over });
		}
		const key = `${t.kind}/${t.provider}`;
		const run = runs.get(key) ?? { t, claimed: 0, calls: 0, events: 0, failed: 0, errors: [] };
		run.claimed++;
		run.calls += a.calls;
		run.events += a.events;
		if (a.failed) {
			run.failed++;
			run.errors.push((a.error ?? '').slice(0, 200));
		}
		runs.set(key, run);
	}
	for (const { t, calls } of extra.values()) await reserveCalls(deps.db, t.provider, calls, t.budget.perDay);
	if (runs.size) {
		await deps.db.query(
			`insert into curator.tracker_run (kind, provider, worker, finished_at, claimed, calls, events, failed, errors)
			select x.kind, x.provider, $2, now(), x.claimed, x.calls, x.events, x.failed, x.errors
			from jsonb_to_recordset($1::text::jsonb) as x(kind text, provider text, claimed int, calls int, events int, failed int, errors jsonb)`,
			[JSON.stringify([...runs.values()].map((r) => ({ kind: r.t.kind, provider: r.t.provider, claimed: r.claimed, calls: r.calls, events: r.events, failed: r.failed, errors: r.errors.slice(0, 20) }))), holder],
		);
	}
	if (out.applied) deps.log.info('worker_report', { by: holder, ...out });
	return out;
}
