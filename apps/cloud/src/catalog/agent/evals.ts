// The regression set: the operator's own twin decisions, exported as cases
// the reasoner can be replayed on (apps/cloud/evals, promptfoo). A pack
// change ships only when the set still agrees with what Guy decided.
//
// Where a decision lives: an inbox item whose apply merges pairs
// (release.twins, artist.twins, artist.merge, agent.proposal), resolved by
// the operator. Rejected: every pair is "different". Approved: the pairs the
// resolution names as excepted are "different"; the rest are "same" only
// where the merge log shows the fold merged by that item (a pair skipped
// because a side was already gone is no decision). The evidence is the case's
// stored pack when the reasoner raised the item (full fidelity, 0025), else
// the pair views the item kept (agent/pack.ts packFromSnapshot).

import type { Queryable } from '../../db/db.js';
import { num } from '../../db/db.js';
import { packFromSnapshot, type EvidencePack } from './pack.js';

export type EvalExpected = 'same' | 'different';
export type EvalCase = {
	id: string;
	kind: 'release_twin' | 'artist_twin';
	inbox: number;
	case: number | null;
	by: string | null;
	decidedAt: number;
	// The pairs the pack asks about, in its order; `expected` null = asked but
	// not decided (a stored pack covers every pair the case had).
	pairs: { keep: string; fold: string }[];
	expected: (EvalExpected | null)[];
	// What the reasoner answered when it raised the item: a correction is
	// where these differ from `expected`.
	modelSaid: string[] | null;
	packSource: 'case' | 'snapshot';
	pack: EvidencePack;
};

type Row = { id: unknown; status: string; resolution: string | null; resolved_by: string | null; resolved_ms: unknown; evidence: string; apply: string; label: string | null };
type View = { id: string; title?: string };

// "applied except pair 1 (not twins)" / "applied except pairs 1, 16 (not twins)" (inbox.ts decideInbox).
export function exceptedPairs(resolution: string | null): Set<number> {
	const m = /except pairs? ([\d, ]+)/.exec(resolution ?? '');
	return new Set(m ? m[1]!.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0) : []);
}

export async function exportEvalCases(tx: Queryable, opts: { since?: number } = {}): Promise<{ cases: EvalCase[]; skipped: { inbox: number; why: string }[] }> {
	const rows = await tx.query<Row>(
		`select i.id, i.status, i.resolution, i.resolved_by, extract(epoch from i.resolved_at) * 1000 as resolved_ms, i.evidence::text as evidence, i.apply::text as apply,
			(select o.name from curator.catalog_object o where o.id = i.subjects[1] and o.kind = 'label') as label
		from curator.catalog_inbox i
		where i.apply->>'op' in ('mergeReleases', 'mergeArtists') and i.status in ('approved', 'rejected')
			and ($1::timestamptz is null or i.resolved_at >= $1::timestamptz)
		order by i.id`,
		[opts.since === undefined ? null : new Date(opts.since).toISOString()],
	);
	const cases: EvalCase[] = [];
	const skipped: { inbox: number; why: string }[] = [];
	for (const r of rows) {
		const inbox = num(r.id);
		const evidence = JSON.parse(r.evidence) as Record<string, unknown>;
		const apply = JSON.parse(r.apply) as { op: string; args: { pairs: { keep: string; fold: string }[] } };
		const pairs = apply.args.pairs;
		const kind = apply.op === 'mergeReleases' ? 'release_twin' : 'artist_twin';
		const caseId = typeof evidence.case === 'number' ? evidence.case : null;
		let expected: (EvalExpected | null)[];
		if (r.status === 'rejected') expected = pairs.map(() => 'different');
		else {
			const except = exceptedPairs(r.resolution);
			const merged = new Set((await tx.query<{ from_id: string }>(`select from_id from curator.catalog_merge_log where evidence->>'inbox' = $1`, [String(inbox)])).map((m) => m.from_id));
			expected = pairs.map((p, i) => (except.has(i) ? 'different' : merged.has(p.fold) ? 'same' : null));
		}
		const decided = expected.flatMap((e, i) => (e === null ? [] : [i]));
		if (!decided.length) {
			skipped.push({ inbox, why: 'no pair was decided (a side was gone before the merge)' });
			continue;
		}
		const said = Array.isArray(evidence.verdicts) ? (evidence.verdicts as unknown[]).map(String) : null;
		const base = { id: `inbox-${inbox}`, kind, inbox, case: caseId, by: r.resolved_by, decidedAt: num(r.resolved_ms) } as const;
		if (caseId !== null) {
			const [c] = await tx.query<{ pack: string | null }>(`select pack::text as pack from curator.catalog_agent_case where id = $1::bigint`, [String(caseId)]);
			if (c?.pack) {
				// The stored pack asks about every pair of the case, not only the
				// ones this item proposed: grade the item's pairs, by ids.
				const pack = JSON.parse(c.pack) as EvidencePack;
				const asked = ((pack.evidence.pairs as { keep: View | null; fold: View | null }[] | undefined) ?? []).map((p) => ({ keep: p.keep?.id ?? '', fold: p.fold?.id ?? '' }));
				const verdictOf = (p: { keep: string; fold: string }) => {
					const i = pairs.findIndex((q) => q.keep === p.keep && q.fold === p.fold);
					return i < 0 ? null : expected[i]!;
				};
				const saidOf = (p: { keep: string; fold: string }) => {
					const i = pairs.findIndex((q) => q.keep === p.keep && q.fold === p.fold);
					return i < 0 || !said ? '' : (said[i] ?? '');
				};
				cases.push({ ...base, pairs: asked, expected: asked.map(verdictOf), modelSaid: said ? asked.map(saidOf) : null, packSource: 'case', pack });
				continue;
			}
		}
		const views = Array.isArray(evidence.pairs) ? (evidence.pairs as { keep: View; fold: View; on?: string[] }[]) : null;
		if (!views || views.length !== pairs.length) {
			skipped.push({ inbox, why: 'no stored pack and no pair views on the item' });
			continue;
		}
		const kept = decided.map((i) => views[i]!);
		const label = r.label ?? (typeof evidence.label === 'string' ? evidence.label : undefined);
		const on = [...new Set(kept.flatMap((v) => v.on ?? []))];
		cases.push({
			...base,
			pairs: decided.map((i) => pairs[i]!),
			expected: decided.map((i) => expected[i]!),
			modelSaid: said ? decided.map((i) => said[i] ?? '') : null,
			packSource: 'snapshot',
			pack: packFromSnapshot(kind, { label, on, pairs: kept }),
		});
	}
	return { cases, skipped };
}

// The set a routine run replays: every case with a "different" pair (the
// rare class, where a reasoner that says "same" to everything is caught),
// every case the reasoner itself raised (its corrections), and a fixed
// sample of the all-"same" rest up to `size` cases. The sample is by a hash
// of the inbox id, so two runs replay the same cases and their scores
// compare. The operator's approvals are mostly "same" (2026-11-03: 957 of
// 990 pairs): without this a run costs the whole log and grades nothing.
export function coreSet(cases: EvalCase[], size = 80): EvalCase[] {
	const must = cases.filter((c) => c.expected.includes('different') || c.case !== null);
	const rest = cases
		.filter((c) => !must.includes(c))
		.map((c) => ({ c, h: hash(c.id) }))
		.sort((a, b) => a.h - b.h)
		.map((x) => x.c);
	return [...must, ...rest.slice(0, Math.max(0, size - must.length))].sort((a, b) => a.inbox - b.inbox);
}

function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
	return h;
}
