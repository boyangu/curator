// A verdict into the catalogue — never directly: through the same tx-level
// functions the operator's commands run, routed by the inbox policy
// (inbox-policy.ts). Watched or in-library objects, overruled rulings and
// doubtful verdicts are proposed (an approval item with the apply op the
// inbox already knows); the rest is done and logged with its undo. Merges
// are proposals whatever the policy says: nothing un-merges yet.
//
// Every action carries the reasoning on the inbox item — rationale,
// citations, confidence, model, cost — so the operator reads why, and a
// rejected proposal becomes a correction the eval sets learn from.

import { nameFold } from '@curator/library-logic';
import type { SystemTx } from '../../db/system-tx.js';
import { decideReview, getReview, notSame, ruledNotSame } from '../admin.js';
import { addInsight } from '../insights.js';
import { raise, type InboxOp } from '../inbox.js';
import { mergePolicy, objectFacts, reversiblePolicy, type Severity } from '../inbox-policy.js';
import { ingestClaims } from '../ingest.js';
import { pairViews } from '../objects.js';
import { recreditOn } from '../repair-credits.js';
import type { AgentCase, ArtistBucketInput, ArtistTwinInput, CreditInput, LabelPagesInput, ReleaseTwinInput, Verdict } from './cases.js';

export const AGENT_ACTOR = 'agent';

export type Reasoning = { case: number; rationale: string; citations: string[]; confidence: number; model: string; costUsd: number };

export type ApplyOutcome = {
	// What the catalogue now holds (done) and what waits for the operator (proposed).
	applied: string[];
	proposed: string[];
	inboxIds: number[];
};

type Ctx = { tx: SystemTx; c: AgentCase; r: Reasoning; floor: number; by: string };

const sure = (ctx: Ctx, v: { confidence: number }) => v.confidence >= ctx.floor;

async function propose(ctx: Ctx, title: string, subjects: string[], apply: InboxOp, key: string, out: ApplyOutcome, extra: Record<string, unknown> = {}): Promise<void> {
	const id = await raise(ctx.tx, { kind: 'agent.proposal', severity: 'approval', title, subjects, evidence: { ...ctx.r, ...extra }, apply, actor: AGENT_ACTOR, key });
	out.proposed.push(title);
	if (id !== null) out.inboxIds.push(id);
}

async function done(ctx: Ctx, title: string, subjects: string[], severity: Severity, undo: InboxOp | null, out: ApplyOutcome, extra: Record<string, unknown> = {}): Promise<void> {
	const id = await raise(ctx.tx, { kind: 'agent.verdict', severity, title, subjects, evidence: { ...ctx.r, ...extra }, undo, actor: AGENT_ACTOR });
	out.applied.push(title);
	if (id !== null) out.inboxIds.push(id);
}

// Twins, releases or artists: `same` is a merge — proposed, always — and
// `different` a not-same ruling (done where no one watches, else a notice).
async function applyTwins(ctx: Ctx, v: Verdict<'release_twin'> | Verdict<'artist_twin'>, what: 'release' | 'artist', out: ApplyOutcome, extra: Record<string, unknown>): Promise<void> {
	const op = what === 'release' ? 'mergeReleases' : 'mergeArtists';
	const same = v.pairs.filter((p) => p.verdict === 'same');
	const different = sure(ctx, v) ? v.pairs.filter((p) => p.verdict === 'different') : [];
	const unsure = v.pairs.filter((p) => p.verdict === 'unsure' || (p.verdict === 'different' && !sure(ctx, v)));
	const facts = await objectFacts(ctx.tx, v.pairs.flatMap((p) => [p.keep, p.fold]));
	const name = (id: string) => facts.get(id)?.name ?? id;
	// The pairs as the detectors raise them (objects.ts pairViews), in the
	// apply's order: the back office draws its Keep / Fold table from them and
	// an unticked row becomes `except`; the regression set keeps them as the
	// pair looked when decided (a merge leaves nothing else to read it from).
	const views = await pairViews(ctx.tx, v.pairs.flatMap((p) => [p.keep, p.fold]));
	const on = Array.isArray(extra['on']) ? (extra['on'] as string[]).slice(0, 5) : undefined;
	const shown = (ps: { keep: string; fold: string }[]) => ps.map((p) => ({ keep: views.get(p.keep) ?? { id: p.keep, title: name(p.keep), providers: [], tracks: 0 }, fold: views.get(p.fold) ?? { id: p.fold, title: name(p.fold), providers: [], tracks: 0 }, ...(on ? { on } : {}) }));
	const verdicts = (ps: { keep: string; fold: string; verdict: string }[]) => ps.map((p) => p.verdict);
	if (same.length) {
		await propose(ctx, `Merge ${same.length} twin ${what}${same.length > 1 ? 's' : ''}: «${name(same[0]!.keep)}»${sure(ctx, v) ? '' : ' (low confidence)'}`, same.flatMap((p) => [p.keep, p.fold]), { op, args: { pairs: same.map((p) => ({ keep: p.keep, fold: p.fold })) } }, `${ctx.c.id}:same`, out, { ...extra, pairs: shown(same), verdicts: verdicts(same) });
	}
	for (const p of different) {
		if (await ruledNotSame(ctx.tx, p.keep, { objectId: p.fold, name: '' })) continue;
		await notSame(ctx.tx, p.keep, p.fold, AGENT_ACTOR, `agent case ${ctx.c.id}: ${v.rationale.slice(0, 200)}`);
		const severity = reversiblePolicy(facts.get(p.keep)) === 'audit' && reversiblePolicy(facts.get(p.fold)) === 'audit' ? 'audit' : 'notice';
		await done(ctx, `Ruled apart: «${name(p.keep)}» and «${name(p.fold)}» are different ${what}s`, [p.keep, p.fold], severity, { op: 'dropNotSame', args: { a: p.keep, b: p.fold } }, out, { ...extra, pairs: shown([p]), verdicts: ['different'] });
	}
	if (unsure.length) {
		await propose(ctx, `Unsure: ${unsure.length} ${what} pair${unsure.length > 1 ? 's' : ''} on «${name(unsure[0]!.keep)}» — approve merges, reject rules apart`, unsure.flatMap((p) => [p.keep, p.fold]), { op, args: { pairs: unsure.map((p) => ({ keep: p.keep, fold: p.fold })) } }, `${ctx.c.id}:unsure`, out, { ...extra, pairs: shown(unsure), verdicts: verdicts(unsure) });
	}
}

export async function applyVerdict(tx: SystemTx, c: AgentCase, verdict: unknown, r: Reasoning, opts: { floor: number; by?: string }): Promise<ApplyOutcome> {
	const ctx: Ctx = { tx, c, r, floor: opts.floor, by: opts.by ?? AGENT_ACTOR };
	const out: ApplyOutcome = { applied: [], proposed: [], inboxIds: [] };
	switch (c.kind) {
		case 'release_twin': {
			const input = c.input as unknown as ReleaseTwinInput;
			await applyTwins(ctx, verdict as Verdict<'release_twin'>, 'release', out, { label: input.label.name });
			return out;
		}
		case 'artist_twin': {
			const input = c.input as unknown as ArtistTwinInput;
			await applyTwins(ctx, verdict as Verdict<'artist_twin'>, 'artist', out, { on: input.on });
			return out;
		}
		case 'artist_bucket': {
			const input = c.input as unknown as ArtistBucketInput;
			const v = verdict as Verdict<'artist_bucket'>;
			const facts = await objectFacts(tx, [input.artist]);
			const artist = facts.get(input.artist);
			const title = `Block ${input.source.provider} id ${input.source.providerId}: a bucket of namesakes, not «${artist?.name ?? input.artist}»`;
			const apply: InboxOp = { op: 'blockSource', args: { objectId: input.artist, provider: input.source.provider, kind: 'artist', providerId: input.source.providerId, reason: v.rationale, note: `agent case ${c.id}` } };
			if (v.verdict === 'bucket' && sure(ctx, v) && reversiblePolicy(artist) === 'audit') {
				const res = await runBlockSource(tx, apply.args, ctx.by);
				await done(ctx, title, [input.artist], 'audit', { op: 'unblockSource', args: { ...apply.args, relink: res.relink } }, out);
			} else if (v.verdict === 'bucket' || v.verdict === 'unsure') {
				await propose(ctx, `${v.verdict === 'unsure' ? 'Unsure: ' : ''}${title}`, [input.artist], apply, `${c.id}:bucket`, out);
			} else {
				await addInsight(tx, { objectId: input.artist, topic: 'note', body: `${input.source.provider} ${input.source.providerId} is this artist's own profile (agent case ${c.id}): ${v.rationale}`.slice(0, 500), evidence: { case: c.id, citations: v.citations }, actor: AGENT_ACTOR });
				await done(ctx, `«${artist?.name ?? input.artist}»: ${input.source.provider} id ${input.source.providerId} is a clean profile`, [input.artist], 'audit', null, out);
			}
			return out;
		}
		case 'credit': {
			const input = c.input as unknown as CreditInput;
			const v = verdict as Verdict<'credit'>;
			const facts = await objectFacts(tx, [input.release, ...input.pieces]);
			const name = v.name?.trim() || input.creditText || input.pieces.map((p) => facts.get(p)?.name ?? '').filter(Boolean).join(' & ');
			if (v.verdict === 'split') {
				await addInsight(tx, { objectId: input.release, topic: 'note', body: `Credit "${input.creditText ?? name}" is several artists (agent case ${c.id}): ${v.rationale}`.slice(0, 500), evidence: { case: c.id, citations: v.citations }, actor: AGENT_ACTOR });
				await tx.query(`insert into curator.catalog_credit_rule (name_fold, name, kind, pieces, case_id, actor) values ($1, $2, 'split', $3::text[], $4::bigint, $5) on conflict (name_fold) do nothing`, [nameFold(input.creditText ?? name), input.creditText ?? name, `{${input.pieces.map((p) => `"${(facts.get(p)?.name ?? '').replace(/"/g, '')}"`).join(',')}}`, String(c.id), AGENT_ACTOR]);
				await done(ctx, `Credit "${input.creditText ?? name}" stays several artists`, [input.release], 'audit', null, out);
				return out;
			}
			// Compound (or unsure): the re-credit moves credits between artists on
			// a release — a proposal until the operator says so.
			const apply: InboxOp = { op: 'recredit', args: { release: input.release, pieces: input.pieces, name, creditText: input.creditText, caseId: c.id } };
			await propose(ctx, `${v.verdict === 'unsure' ? 'Unsure: ' : ''}Credit "${name}" is one act — re-credit ${input.pieces.length} piece${input.pieces.length > 1 ? 's' : ''} on «${facts.get(input.release)?.name ?? 'the release'}»`, [input.release, ...input.pieces], apply, `${c.id}:credit`, out);
			return out;
		}
		case 'label_pages': {
			const input = c.input as unknown as LabelPagesInput;
			const v = verdict as Verdict<'label_pages'>;
			const facts = await objectFacts(tx, [input.label]);
			const label = facts.get(input.label);
			for (const cand of v.candidates) {
				if (cand.verdict === 'unsure') continue;
				const review = await getReview(tx, cand.review);
				if (!review || review.status !== 'open' || !review.candidates[cand.candidate]) continue;
				const page = review.candidates[cand.candidate]!;
				const decision = { action: cand.verdict === 'attach' ? ('attach' as const) : ('not_same' as const), candidate: cand.candidate };
				const title = `${cand.verdict === 'attach' ? 'Linked' : 'Ruled not this label\'s'}: ${page.provider}:${page.providerId} ${cand.verdict === 'attach' ? 'to' : 'for'} «${label?.name ?? input.label}»`;
				const op: InboxOp = { op: 'decideReview', args: { id: cand.review, decision, by: AGENT_ACTOR, note: `agent case ${c.id}: ${v.rationale.slice(0, 200)}` } };
				if (sure(ctx, v) && reversiblePolicy(label) === 'audit') {
					await decideReview(tx, cand.review, decision, AGENT_ACTOR, `agent case ${c.id}: ${v.rationale.slice(0, 200)}`, { operator: true });
					await done(ctx, title, [input.label], 'audit', cand.verdict === 'attach' ? { op: 'unlinkPage', args: { objectId: input.label, page: { provider: page.provider ?? null, id: page.providerId ?? null, url: page.url ?? null } } } : { op: 'dropNotSame', args: { a: input.label, b: input.label, reviewId: cand.review } }, out, { page });
				} else {
					await propose(ctx, `${sure(ctx, v) ? '' : 'Low confidence: '}${title}`, [input.label], op, `${c.id}:${cand.review}:${cand.candidate}`, out, { page });
				}
			}
			return out;
		}
	}
}

// ── the ops the inbox runs for the reasoner (inbox.ts runApply/runUndo) ───────────────────

// A store id off the artist and blocked for the catalogue: unlinked like a
// wrong label page, then ruled out for every object by catalog_source_block.
export async function runBlockSource(tx: SystemTx, a: Record<string, unknown>, by: string): Promise<{ relink: unknown | null }> {
	const { unlinkPage } = await import('../admin.js');
	const objectId = String(a.objectId);
	const provider = String(a.provider);
	const providerId = String(a.providerId);
	let relink: unknown | null = null;
	const [held] = await tx.query(`select 1 from curator.catalog_source_object where object_id = $1 and provider = $2 and provider_id = $3`, [objectId, provider, providerId]);
	if (held) relink = (await unlinkPage(tx, objectId, { provider: provider as never, id: providerId, url: null }, by, String(a.note ?? 'a bucket of namesakes'), { kind: String(a.kind ?? 'artist') as 'artist' | 'label' })).undo;
	await tx.query(
		`insert into curator.catalog_source_block (provider, kind, provider_id, reason, case_id, by_whom) values ($1, $2, $3, $4, $5::bigint, $6) on conflict (provider, kind, provider_id) do nothing`,
		[provider, String(a.kind ?? 'artist'), providerId, String(a.reason ?? ''), a.caseId === undefined ? null : String(a.caseId), by],
	);
	return { relink };
}

export async function runUnblockSource(tx: SystemTx, a: Record<string, unknown>): Promise<void> {
	await tx.query(`delete from curator.catalog_source_block where provider = $1 and kind = $2 and provider_id = $3`, [String(a.provider), String(a.kind ?? 'artist'), String(a.providerId)]);
	if (a.relink) {
		const { relinkPage } = await import('../admin.js');
		await relinkPage(tx, String(a.objectId), a.relink as never);
	}
}

// The pieces of a cut credit re-credited to the one act (minted under a name
// key when the catalogue has no such artist), and the credit remembered as
// compound so no reader cuts it again.
export async function runRecredit(tx: SystemTx, a: Record<string, unknown>, by: string): Promise<{ credits: number; into: string }> {
	const release = String(a.release);
	const pieces = a.pieces as string[];
	const name = String(a.name);
	const out = await ingestClaims(tx, [{ provider: 'user', kind: 'artist', providerId: `name:${nameFold(name)}`, name }], { reason: 'enrichment' });
	const into = out.outcomes[0]!.objectId;
	// The rule names the pieces as credits read them (ingest.ts matches by
	// folded name), not by the ids of the objects they were minted as.
	const names = (await tx.query<{ name: string }>(`select name from curator.catalog_object where id = any($1::uuid[])`, [`{${pieces.join(',')}}`])).map((r) => r.name);
	let credits = 0;
	for (const p of pieces) if (p !== into) credits += await recreditOn(tx, p, release, into);
	await tx.query(
		`insert into curator.catalog_credit_rule (name_fold, name, kind, pieces, case_id, actor) values ($1, $2, 'compound', $3::text[], $4::bigint, $5) on conflict (name_fold) do nothing`,
		[nameFold(name), name, `{${names.map((n) => `"${n.replace(/["\\]/g, '')}"`).join(',')}}`, a.caseId === undefined || a.caseId === null ? null : String(a.caseId), by],
	);
	return { credits, into };
}
