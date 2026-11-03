// The reasoner pass (worker/main.ts, cli/local.ts): queued cases, a few per
// pass, each in three steps that never share a transaction — the evidence
// pack in one short tx, the model call outside any tx (PGlite has one
// connection; a model call inside a tx would hold the local server for the
// call's whole minute), the verdict applied in a second short tx. Leases
// make a second worker safe; budgets (calls a day, dollars a day) stop a
// pass before the ceiling, and a failed case retries with backoff.

import type { Db } from '../../db/db.js';
import { num } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { applyVerdict, type ApplyOutcome, type Reasoning } from './apply.js';
import { getCase, parseVerdict, type AgentCase } from './cases.js';
import type { AgentReasonerConfig } from './config.js';
import type { ModelAnswer, ModelCall } from './model.js';
import { buildPack, renderPack } from './pack.js';
import { prefixFor } from './prompts.js';

export type ReasonerDeps = { db: Db; log: Logger; model: ModelCall; cfg: AgentReasonerConfig; holder: string; batch?: number; by?: string };

export type CaseResult = { id: number; kind: string; status: string; verdict: unknown; answer: ModelAnswer | null; outcome: ApplyOutcome | null; error: string | null };
export type ReasonerReport = { leased: number; results: CaseResult[]; parked: string | null; moot: number };

const RETRY_HOURS = [1, 6, 24];
const PROVIDER = 'anthropic';

// Cases whose subjects were merged away, or whose pairs were ruled apart,
// before the reasoner reached them.
async function sweepMoot(db: Db): Promise<number> {
	return withSystemTx(db, async (tx) => {
		const rows = await tx.query(
			`update curator.catalog_agent_case c set status = 'moot', last_error = 'a subject was merged away or ruled apart'
			where c.status in ('queued', 'leased') and (
				exists (select 1 from curator.catalog_object o where o.id = any(c.subjects) and o.merged_into is not null)
				or (c.kind in ('release_twin', 'artist_twin') and not exists (
					select 1 from jsonb_array_elements(c.input->'pairs') p
					where not exists (select 1 from curator.catalog_not_same n where n.object_a = least((p->>'keep')::uuid, (p->>'fold')::uuid) and n.object_b = greatest((p->>'keep')::uuid, (p->>'fold')::uuid))))
			) returning 1`,
		);
		return rows.length;
	});
}

async function lease(db: Db, holder: string, batch: number, only?: number): Promise<AgentCase[]> {
	const ids = await db.query<{ id: unknown }>(
		`update curator.catalog_agent_case c set status = 'leased', lease_holder = $1, lease_until = now() + interval '10 minutes'
		from (
			select id from curator.catalog_agent_case
			where ($3::bigint is null and status = 'queued' and next_due_at <= now() and (lease_until is null or lease_until < now()))
				or ($3::bigint is not null and id = $3::bigint and status in ('queued', 'leased', 'failed'))
			order by kind, created_at limit $2::int
			for update skip locked
		) d where c.id = d.id returning c.id`,
		[holder, String(batch), only === undefined ? null : String(only)],
	);
	const out: AgentCase[] = [];
	for (const r of ids) {
		const c = await withSystemTx(db, (tx) => getCase(tx, num(r.id)));
		if (c) out.push(c);
	}
	return out;
}

async function unlease(db: Db, id: number): Promise<void> {
	await db.query(`update curator.catalog_agent_case set status = 'queued', lease_holder = null, lease_until = null where id = $1::bigint`, [String(id)]);
}

async function overBudget(db: Db, cfg: AgentReasonerConfig): Promise<string | null> {
	const [spent] = await db.query<{ usd: unknown }>(`select coalesce(sum(cost_usd), 0) as usd from curator.catalog_agent_case where decided_at >= date_trunc('day', now())`);
	if (num(spent!.usd) >= cfg.dailyUsd) return `today's spend ${num(spent!.usd).toFixed(2)} USD reached the ceiling ${cfg.dailyUsd}`;
	const [g] = await db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, 1, $2::int) as n`, [PROVIDER, String(cfg.dailyCalls)]);
	if (num(g!.n) < 1) return `today's ${cfg.dailyCalls} calls are used`;
	return null;
}

async function failCase(db: Db, c: AgentCase, error: string): Promise<void> {
	const attempts = c.attempts + 1;
	const hours = RETRY_HOURS[Math.min(attempts, RETRY_HOURS.length) - 1]!;
	await db.query(
		`update curator.catalog_agent_case set status = $2, attempts = $3::int, last_error = $4, lease_holder = null, lease_until = null, next_due_at = now() + make_interval(hours => $5::int) where id = $1::bigint`,
		[String(c.id), attempts >= RETRY_HOURS.length ? 'failed' : 'queued', String(attempts), error.slice(0, 500), String(hours)],
	);
}

// One case through the three steps. `dry`: the pack and the model's answer,
// nothing written (the case stays as it was).
// `research`: overrides the pack's choice (a second look with the web on).
export async function reasonCase(deps: ReasonerDeps, c: AgentCase, opts: { dry?: boolean; research?: boolean } = {}): Promise<CaseResult> {
	const by = deps.by ?? 'agent';
	let answer: ModelAnswer | null = null;
	try {
		const t0 = Date.now();
		const pack = await withSystemTx(deps.db, (tx) => buildPack(tx, c));
		const prefix = prefixFor(c.kind);
		deps.log.info('agent_case_start', { case: c.id, kind: c.kind, packMs: Date.now() - t0, packChars: JSON.stringify(pack.evidence).length });
		answer = await deps.model({ prefix, user: renderPack(pack), research: opts.research ?? pack.research });
		if (answer.declined) {
			if (!opts.dry) await deps.db.query(`update curator.catalog_agent_case set status = 'declined', model = $2, prompt_hash = $3, usage = $4::text::jsonb, cost_usd = $5, pack = $6::text::jsonb, decided_at = now(), lease_holder = null where id = $1::bigint`, [String(c.id), answer.model, prefix.hash, JSON.stringify(answer.usage), String(answer.costUsd), JSON.stringify(pack)]);
			return { id: c.id, kind: c.kind, status: 'declined', verdict: null, answer, outcome: null, error: null };
		}
		if (answer.verdict === null) throw new Error(`the model answered without a verdict (${answer.stopReason}): ${answer.text.slice(0, 200)}`);
		const verdict = parseVerdict(c.kind, answer.verdict);
		// A dry run leaves the case as it was (the caller unleases it).
		if (opts.dry) return { id: c.id, kind: c.kind, status: 'queued', verdict, answer, outcome: null, error: null };
		const reasoning: Reasoning = { case: c.id, rationale: verdict.rationale, citations: verdict.citations, confidence: verdict.confidence, model: answer.model, costUsd: answer.costUsd };
		const outcome = await withSystemTx(deps.db, async (tx) => {
			const o = await applyVerdict(tx, c, verdict, reasoning, { floor: deps.cfg.confidenceFloor, by });
			const status = o.proposed.length ? 'proposed' : 'applied';
			await tx.query(
				`update curator.catalog_agent_case set status = $2, verdict = $3::text::jsonb, confidence = $4, model = $5, prompt_hash = $6, usage = $7::text::jsonb, cost_usd = $8, inbox_id = $9::bigint, pack = $10::text::jsonb, decided_at = now(), lease_holder = null, lease_until = null, last_error = null where id = $1::bigint`,
				[String(c.id), status, JSON.stringify(verdict), String(verdict.confidence), answer!.model, prefix.hash, JSON.stringify(answer!.usage), String(answer!.costUsd), o.inboxIds[0] === undefined ? null : String(o.inboxIds[0]), JSON.stringify(pack)],
			);
			return { ...o, status };
		});
		return { id: c.id, kind: c.kind, status: outcome.status, verdict, answer, outcome, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!opts.dry) await failCase(deps.db, c, message);
		else await unlease(deps.db, c.id);
		deps.log.warn('agent_case_failed', { case: c.id, kind: c.kind, error: message.slice(0, 300) });
		return { id: c.id, kind: c.kind, status: 'failed', verdict: null, answer, outcome: null, error: message };
	}
}

export async function runAgentReasoner(deps: ReasonerDeps, opts: { only?: number; dry?: boolean } = {}): Promise<ReasonerReport> {
	const report: ReasonerReport = { leased: 0, results: [], parked: null, moot: 0 };
	// Asked by hand for one case: the sweep still runs first, so a case whose
	// subject was merged away since is marked moot, not reasoned over.
	report.moot = await sweepMoot(deps.db);
	const cases = await lease(deps.db, deps.holder, opts.only === undefined ? (deps.batch ?? deps.cfg.batch) : 1, opts.only);
	report.leased = cases.length;
	for (const c of cases) {
		if (!opts.dry) {
			const parked = await overBudget(deps.db, deps.cfg);
			if (parked) {
				report.parked = parked;
				await unlease(deps.db, c.id);
				continue;
			}
		}
		report.results.push(await reasonCase(deps, c, opts));
		if (opts.dry) await unlease(deps.db, c.id);
	}
	if (report.results.length || report.parked || report.moot) {
		deps.log.info('agent_reasoner_pass', {
			cases: report.results.length,
			applied: report.results.filter((r) => r.status === 'applied').length,
			proposed: report.results.filter((r) => r.status === 'proposed').length,
			failed: report.results.filter((r) => r.status === 'failed').length,
			usd: report.results.reduce((s, r) => s + (r.answer?.costUsd ?? 0), 0),
			moot: report.moot,
			...(report.parked ? { parked: report.parked } : {}),
		});
	}
	return report;
}
