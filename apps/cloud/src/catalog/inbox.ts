// The operator's inbox (catalog_inbox): what the agent and the worker put to
// Guy, one step above the review queue. An item is one of three things:
//
//   approval  a held action — a label merge, the merges a twins detector
//             proposes, an unlink of a dead page — with its `apply` payload;
//             approve runs it, reject discards it (and for detector pairs
//             rules them apart, so they are never proposed again);
//   notice    a done action with its `undo` payload — an unlink, a rename, a
//             ruling on a followed label — or a worker's observation (a
//             tracker failing); approve acknowledges, reject undoes;
//   audit     what happened, logged at birth; the "All activity" list.
//
// Which tier an action lands in is the policy's (inbox-policy.ts); the items
// are raised by the write ops in admin-ops.ts and by inbox-detectors.ts, and
// every apply or undo here calls the same tx-level functions the agent's
// commands do (admin.ts), so a resolution does what the command would have.

import { createHash, randomUUID } from 'node:crypto';
import type { CatalogKind, CatalogProvider } from '@curator/protocol';
import type { Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import type { SystemTx } from '../db/system-tx.js';
import { decideReview, mergeObjects, mergeOverruling, notSame, relinkPage, renameObject, reopenReview, unlinkPage, type ReviewDecision, type UnlinkResult } from './admin.js';
import { artistTwinsOn } from './artist-twins.js';
import { restoreInsight, retireInsight } from './insights.js';
import type { Severity } from './inbox-policy.js';
import { summaries } from './objects.js';

// The one operator the back office has; a hosted version would carry the
// admin user's id instead.
export const OPERATOR = 'guy';

export type InboxStatus = 'open' | 'approved' | 'rejected' | 'cleared' | 'logged';
export type InboxOp = { op: string; args: Record<string, unknown> };
export type InboxItem = {
	id: number;
	kind: string;
	severity: Severity;
	status: InboxStatus;
	title: string;
	subjects: string[];
	evidence: Record<string, unknown>;
	apply: InboxOp | null;
	undo: InboxOp | null;
	actor: string;
	approvedBy: string | null;
	reviewId: number | null;
	raisedAt: number;
	snoozedUntil: number | null;
	resolvedAt: number | null;
	resolvedBy: string | null;
	resolution: string | null;
	note: string | null;
	lastError: string | null;
};
export type InboxRow = InboxItem & { subjectNames: { id: string; kind: CatalogKind; name: string }[] };

export type RaiseInput = {
	kind: string;
	severity: Severity;
	title: string;
	subjects: string[];
	evidence?: Record<string, unknown>;
	apply?: InboxOp | null;
	undo?: InboxOp | null;
	actor: string;
	approvedBy?: string | null;
	reviewId?: number | null;
	// What makes this item the same question as an earlier one (a detector's
	// pairs, a page, a day). Absent, the item is its own occurrence.
	key?: string;
};

// Raises an item; null when the same question is already there (any state
// but cleared). Audit entries are born logged.
export async function raise(tx: Queryable, r: RaiseInput): Promise<number | null> {
	const digest = createHash('sha256').update(`${r.kind}|${[...r.subjects].sort().join(',')}|${r.key ?? randomUUID()}`).digest('hex').slice(0, 40);
	const [row] = await tx.query<{ id: unknown }>(
		`insert into curator.catalog_inbox (kind, severity, status, title, subjects, evidence, apply, undo, actor, approved_by, review_id, digest)
		values ($1, $2, $3, $4, $5::uuid[], $6::text::jsonb, $7::text::jsonb, $8::text::jsonb, $9, $10, $11::bigint, $12)
		on conflict (digest) where status <> 'cleared' do nothing returning id`,
		[
			r.kind,
			r.severity,
			r.severity === 'audit' ? 'logged' : 'open',
			r.title.slice(0, 300),
			`{${r.subjects.join(',')}}`,
			JSON.stringify(r.evidence ?? {}),
			r.apply ? JSON.stringify(r.apply) : null,
			r.undo ? JSON.stringify(r.undo) : null,
			r.actor,
			r.approvedBy ?? null,
			r.reviewId === undefined || r.reviewId === null ? null : String(r.reviewId),
			digest,
		],
	);
	return row ? num(row.id) : null;
}

type Row = {
	id: unknown; kind: string; severity: Severity; status: InboxStatus; title: string; subjects: string; evidence: string; apply: string | null; undo: string | null;
	actor: string; approved_by: string | null; review_id: unknown; raised_ms: unknown; snoozed_ms: unknown; resolved_ms: unknown; resolved_by: string | null; resolution: string | null; note: string | null; last_error: string | null;
};
const COLUMNS = `id, kind, severity, status, title, subjects::text as subjects, evidence::text as evidence, apply::text as apply, undo::text as undo, actor, approved_by, review_id,
	extract(epoch from raised_at) * 1000 as raised_ms, extract(epoch from snoozed_until) * 1000 as snoozed_ms, extract(epoch from resolved_at) * 1000 as resolved_ms, resolved_by, resolution, note, last_error`;
const toItem = (r: Row): InboxItem => ({
	id: num(r.id),
	kind: r.kind,
	severity: r.severity,
	status: r.status,
	title: r.title,
	subjects: r.subjects === '{}' ? [] : r.subjects.slice(1, -1).split(','),
	evidence: JSON.parse(r.evidence) as Record<string, unknown>,
	apply: r.apply ? (JSON.parse(r.apply) as InboxOp) : null,
	undo: r.undo ? (JSON.parse(r.undo) as InboxOp) : null,
	actor: r.actor,
	approvedBy: r.approved_by,
	reviewId: numOrNull(r.review_id),
	raisedAt: num(r.raised_ms),
	snoozedUntil: numOrNull(r.snoozed_ms),
	resolvedAt: numOrNull(r.resolved_ms),
	resolvedBy: r.resolved_by,
	resolution: r.resolution,
	note: r.note,
	lastError: r.last_error,
});

async function withNames(tx: Queryable, items: InboxItem[]): Promise<InboxRow[]> {
	const names = await summaries(tx, items.flatMap((i) => i.subjects));
	return items.map((i) => ({ ...i, subjectNames: i.subjects.map((id) => ({ id, kind: names.get(id)?.kind ?? ('label' as CatalogKind), name: names.get(id)?.name ?? id })) }));
}

export type InboxFilter = { status?: 'open' | 'snoozed' | 'all'; severity?: Severity; kind?: string; subject?: string; limit?: number; offset?: number };

// `open` is what waits for the operator now (snoozed ones hidden until due);
// `all` is the whole log, newest first.
export async function listInbox(tx: Queryable, f: InboxFilter = {}): Promise<{ total: number; rows: InboxRow[] }> {
	const status = f.status ?? 'open';
	const where = `where ($1::text = 'all'
			or ($1::text = 'open' and status = 'open' and (snoozed_until is null or snoozed_until <= now()))
			or ($1::text = 'snoozed' and status = 'open' and snoozed_until > now()))
		and ($2::text is null or severity = $2) and ($3::text is null or kind = $3) and ($4::uuid is null or $4::uuid = any(subjects))`;
	const params = [status, f.severity ?? null, f.kind ?? null, f.subject ?? null];
	const [t] = await tx.query<{ n: unknown }>(`select count(*) as n from curator.catalog_inbox ${where}`, params);
	const rows = await tx.query<Row>(`select ${COLUMNS} from curator.catalog_inbox ${where} order by id desc limit $5::int offset $6::int`, [...params, String(Math.min(f.limit ?? 50, 500)), String(f.offset ?? 0)]);
	return { total: num(t!.n), rows: await withNames(tx, rows.map(toItem)) };
}

export async function inboxCounts(tx: Queryable): Promise<{ approval: number; notice: number; snoozed: number }> {
	const rows = await tx.query<{ k: string; n: unknown }>(
		`select case when snoozed_until > now() then 'snoozed' else severity end as k, count(*) as n
		from curator.catalog_inbox where status = 'open' group by 1`,
	);
	const by = Object.fromEntries(rows.map((r) => [r.k, num(r.n)]));
	return { approval: by.approval ?? 0, notice: by.notice ?? 0, snoozed: by.snoozed ?? 0 };
}

export async function getInbox(tx: Queryable, id: number): Promise<InboxRow | null> {
	const [r] = await tx.query<Row>(`select ${COLUMNS} from curator.catalog_inbox where id = $1::bigint`, [String(id)]);
	return r ? (await withNames(tx, [toItem(r)]))[0]! : null;
}

export type InboxChoice = { action: 'attach' | 'merge' | 'not_same'; candidate: number };
// `except`: on approving a twins item, the pairs (by index) the operator rules not twins.
export type InboxDecision = { action: 'approve' | 'reject'; choice?: InboxChoice; except?: number[]; note?: string | null; by: string };

// Resolves an open item: a held action is applied or discarded, a done one
// acknowledged or undone. One transaction; a throw leaves the item as it was
// (the caller records the error on it).
export async function decideInbox(tx: SystemTx, id: number, d: InboxDecision): Promise<InboxRow> {
	const item = await getInbox(tx, id);
	if (!item) throw new Error(`inbox item ${id} not found`);
	if (item.status !== 'open') throw new Error(`inbox item ${id} is ${item.status}`);
	let resolution: string;
	if (d.except?.length && (d.action !== 'approve' || !['mergeReleases', 'mergeArtists'].includes(item.apply?.op ?? ''))) throw new Error('--except names pairs of a twins item being approved');
	if (d.action === 'approve') {
		if (item.apply) {
			await runApply(tx, item, d);
			resolution = d.except?.length ? `applied except pair${d.except.length > 1 ? 's' : ''} ${d.except.join(', ')} (not twins)` : 'applied';
		} else resolution = 'acknowledged';
	} else if (item.apply) {
		await runDiscard(tx, item, d);
		resolution = 'discarded';
	} else if (item.undo) {
		await runUndo(tx, item, d);
		resolution = 'undone';
	} else resolution = 'dismissed';
	await tx.query(
		`update curator.catalog_inbox set status = $2, resolved_at = now(), resolved_by = $3, resolution = $4, note = $5, last_error = null where id = $1::bigint`,
		[String(id), d.action === 'approve' ? 'approved' : 'rejected', d.by, resolution, d.note ?? null],
	);
	return (await getInbox(tx, id))!;
}

export async function snoozeInbox(tx: Queryable, id: number, until: Date | null): Promise<InboxRow> {
	const rows = await tx.query(`update curator.catalog_inbox set snoozed_until = $2 where id = $1::bigint and status = 'open' returning 1`, [String(id), until ? until.toISOString() : null]);
	if (!rows.length) throw new Error(`inbox item ${id} is not open`);
	return (await getInbox(tx, id))!;
}

// The condition went away on its own (the detector pass): out of the inbox,
// and the question may be asked again later.
export async function clearInbox(tx: Queryable, id: number, why: string): Promise<void> {
	await tx.query(`update curator.catalog_inbox set status = 'cleared', resolved_at = now(), resolved_by = 'worker', resolution = $2 where id = $1::bigint and status = 'open'`, [String(id), why]);
}

export async function failInbox(tx: Queryable, id: number, error: string): Promise<void> {
	await tx.query(`update curator.catalog_inbox set last_error = $2 where id = $1::bigint`, [String(id), error.slice(0, 500)]);
}

// ── apply / discard / undo ──────────────────────────────────────────────────────────────────

type Page = { provider: CatalogProvider | null; id: string | null; url: string | null };
type Pair = { keep: string; fold: string };
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v));

async function runApply(tx: SystemTx, item: InboxItem, d: InboxDecision): Promise<void> {
	const a = item.apply!.args;
	switch (item.apply!.op) {
		case 'decideReview': {
			// A held merge replays the agent's decision; an escalated review takes
			// the operator's choice.
			const id = num(a.id);
			const decision = (a.decision as ReviewDecision | undefined) ?? d.choice;
			if (!decision) throw new Error('this review needs a choice: attach:<n>, merge:<n> or not-same:<n>');
			await reopenReview(tx, id);
			await decideReview(tx, id, decision, a.decision ? str(a.by) : d.by, (a.note as string | null | undefined) ?? d.note ?? null, { operator: true });
			return;
		}
		case 'mergeLabels': {
			if (a.overruling) await mergeOverruling(tx, str(a.from), str(a.into), d.by, str(a.note ?? d.note ?? 'approved in the inbox'));
			else await mergeObjects(tx, str(a.from), str(a.into), d.by, str(a.note ?? d.note ?? 'approved in the inbox'), { inbox: item.id });
			return;
		}
		case 'mergeReleases':
		case 'mergeArtists': {
			const pairs = a.pairs as Pair[];
			const except = new Set(d.except ?? []);
			for (const i of except) if (!Number.isInteger(i) || i < 0 || i >= pairs.length) throw new Error(`no pair ${i}: this item has pairs 0–${pairs.length - 1}`);
			// The rulings first: a release twinned twice (one keep, two folds) must
			// not reach the excluded fold through the merged one.
			for (const i of except) await notSame(tx, pairs[i]!.keep, pairs[i]!.fold, d.by, d.note ?? 'not twins (inbox)');
			const merged: string[] = [];
			for (const [i, p] of pairs.entries()) {
				if (except.has(i)) continue;
				const live = await tx.query<{ id: string }>(`select id from curator.catalog_object where id = any($1::uuid[]) and merged_into is null`, [`{${p.keep},${p.fold}}`]);
				if (live.length !== 2) continue;
				await mergeObjects(tx, p.fold, p.keep, d.by, `twin ${item.apply!.op === 'mergeArtists' ? 'artist' : 'release'} (inbox ${item.id})${d.note ? `: ${d.note}` : ''}`, { inbox: item.id });
				merged.push(p.keep);
			}
			// Two releases made one put each store's copy of the artist on one
			// release: joined now by the twins rule, not left for a sweep.
			if (item.apply!.op === 'mergeReleases' && merged.length) await artistTwinsOn(tx, [...new Set(merged)], d.by);
			return;
		}
		case 'unlinkPage': {
			await unlinkPage(tx, str(a.objectId), a.page as Page, d.by, d.note ?? (a.note as string | null) ?? null);
			return;
		}
		default:
			throw new Error(`inbox: no apply for ${item.apply!.op}`);
	}
}

async function runDiscard(tx: SystemTx, item: InboxItem, d: InboxDecision): Promise<void> {
	const a = item.apply!.args;
	switch (item.apply!.op) {
		case 'decideReview': {
			const id = num(a.id);
			await reopenReview(tx, id);
			const held = a.decision as ReviewDecision | undefined;
			// Rejecting a merge says they are not one; leaving an escalated review
			// closes it as the operator's skip.
			if (held?.action === 'merge') await decideReview(tx, id, { action: 'not_same', candidate: held.candidate }, d.by, d.note ?? null, { operator: true });
			else await decideReview(tx, id, { action: 'skip' }, d.by, d.note ?? null, { operator: true });
			return;
		}
		case 'mergeReleases':
		case 'mergeArtists': {
			for (const p of a.pairs as Pair[]) await notSame(tx, p.keep, p.fold, d.by, d.note ?? 'not twins (inbox)');
			return;
		}
		case 'mergeLabels':
		case 'unlinkPage':
			return;
		default:
			throw new Error(`inbox: no discard for ${item.apply!.op}`);
	}
}

async function runUndo(tx: SystemTx, item: InboxItem, d: InboxDecision): Promise<void> {
	const a = item.undo!.args;
	switch (item.undo!.op) {
		case 'relinkPage':
			await relinkPage(tx, str(a.objectId), a.undo as UnlinkResult['undo']);
			return;
		case 'rename':
			await renameObject(tx, str(a.objectId), str(a.name));
			return;
		case 'dropNotSame': {
			const [x, y] = [str(a.a), str(a.b)].sort();
			await tx.query(`delete from curator.catalog_not_same where object_a = $1 and object_b = $2`, [x!, y!]);
			if (a.reviewId !== undefined && a.reviewId !== null) await reopenReview(tx, num(a.reviewId));
			return;
		}
		case 'unlinkPage':
			await unlinkPage(tx, str(a.objectId), a.page as Page, d.by, d.note ?? 'undone in the inbox');
			return;
		case 'retireInsight':
			await retireInsight(tx, num(a.id), d.by);
			return;
		case 'restoreInsight':
			await restoreInsight(tx, num(a.id));
			return;
		default:
			throw new Error(`inbox: no undo for ${item.undo!.op}`);
	}
}
