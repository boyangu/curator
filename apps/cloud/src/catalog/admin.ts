// The operations the pipeline never takes on its own: attaching a page the
// lookups could not settle, merging two objects that are one, ruling two
// apart. They are reached through the review queue (catalog_review): the
// profiler and the planner open a review where they refuse to guess, the
// duplicates scan opens one per look-alike pair, and a back-office session
// (cli/resolve.ts, driven by Claude Code or an operator) decides each with
// the evidence in front of it. Every decision keeps its author and note; a
// merge logs what it moved (catalog_merge_log).
//
// A merge re-points every layer onto the winner and leaves the loser as an
// alias (merged_into): representations, identifiers, facts (the winner's
// stay), edges with their evidence, events and their subjects, chart and
// playlist rows, tasks, signals, watches (moved as each watcher, the RLS
// way) and open reviews. Genres are not merged: they are the taxonomy.

import { createHash } from 'node:crypto';
import type { CatalogKind, CatalogProvider } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import type { SystemTx } from '../db/system-tx.js';
import { Ingester } from './ingest.js';
import { editionsOf } from './insights.js';
import { plainerLabelName } from './label-names.js';
import { acceptCataloguePlaylist, queueCataloguePlaylists } from './profile/catalogue-playlists.js';
import { ensureCursors } from './watches.js';

export type ReviewKind = 'label_page' | 'artist_link' | 'duplicate' | 'label_playlist';
export type ReviewCandidate = {
	// A page at a provider (label_page, artist_link) …
	provider?: CatalogProvider;
	providerId?: string;
	// … or another catalogue object (duplicate).
	objectId?: string;
	name: string;
	url?: string | null;
	// What the candidate's own listing shows, when the opener had it.
	releases?: string[];
	// What the opener measured of this candidate (a catalogue playlist's
	// label share, artist share, newest addition …), for the reviewer.
	evidence?: Record<string, unknown>;
};
export type ReviewDecision = { action: 'attach' | 'merge' | 'not_same' | 'skip'; candidate?: number };
// open → decided; or escalated (left to the operator) / held (its merge waits
// for the operator) until the inbox resolves it.
export type ReviewStatus = 'open' | 'decided' | 'escalated' | 'held';
export type Review = {
	id: number;
	kind: ReviewKind;
	objectId: string;
	candidates: ReviewCandidate[];
	evidence: Record<string, unknown>;
	status: ReviewStatus;
	decision: ReviewDecision | null;
	decidedBy: string | null;
	note: string | null;
	openedAt: number;
};

const candidateKey = (c: ReviewCandidate): string => (c.objectId ? `obj:${c.objectId}` : `${c.provider}:${c.providerId}`);

// Opens a review unless the same question (kind, object, candidate set) was
// asked before, open or decided. Returns the id, or null when it was.
export async function openReview(tx: Queryable, r: { kind: ReviewKind; objectId: string; candidates: ReviewCandidate[]; evidence?: Record<string, unknown> }): Promise<number | null> {
	if (!r.candidates.length) return null;
	const digest = createHash('sha256').update(`${r.kind}|${r.objectId}|${r.candidates.map(candidateKey).sort().join(',')}`).digest('hex').slice(0, 40);
	const [row] = await tx.query<{ id: unknown }>(
		`insert into curator.catalog_review (kind, object_id, digest, candidates, evidence) values ($1, $2, $3, $4::text::jsonb, $5::text::jsonb)
		on conflict (digest) do nothing returning id`,
		[r.kind, r.objectId, digest, JSON.stringify(r.candidates), JSON.stringify(r.evidence ?? {})],
	);
	return row ? num(row.id) : null;
}

type ReviewRow = { id: unknown; kind: ReviewKind; object_id: string; candidates: string; evidence: string; status: ReviewStatus; decision: string | null; decided_by: string | null; note: string | null; opened_ms: unknown };
const toReview = (r: ReviewRow): Review => ({
	id: num(r.id),
	kind: r.kind,
	objectId: r.object_id,
	candidates: JSON.parse(r.candidates) as ReviewCandidate[],
	evidence: JSON.parse(r.evidence) as Record<string, unknown>,
	status: r.status,
	decision: r.decision ? (JSON.parse(r.decision) as ReviewDecision) : null,
	decidedBy: r.decided_by,
	note: r.note,
	openedAt: num(r.opened_ms),
});
const REVIEW_COLUMNS = `id, kind, object_id, candidates::text as candidates, evidence::text as evidence, status, decision::text as decision, decided_by, note, extract(epoch from opened_at) * 1000 as opened_ms`;

// `related`: only the related-label pairs (label-related.ts), newest first —
// the artist look-alikes can number thousands and would bury them.
export async function listReviews(tx: Queryable, opts: { status?: ReviewStatus; kind?: ReviewKind; limit?: number; related?: boolean } = {}): Promise<Review[]> {
	const rows = await tx.query<ReviewRow>(
		`select ${REVIEW_COLUMNS} from curator.catalog_review
		where status = $1 and ($2::text is null or kind = $2)
			and (not $4::boolean or (kind = 'duplicate' and candidates->0->'evidence'->>'kind' = 'related_label'))
		order by case when $4::boolean then -id else id end, opened_at limit $3::int`,
		[opts.status ?? 'open', opts.kind ?? null, String(opts.limit ?? 20), opts.related ? 'true' : 'false'],
	);
	return rows.map(toReview);
}

export async function getReview(tx: Queryable, id: number): Promise<Review | null> {
	const [r] = await tx.query<ReviewRow>(`select ${REVIEW_COLUMNS} from curator.catalog_review where id = $1::bigint`, [String(id)]);
	return r ? toReview(r) : null;
}

// Was this page (or object) ruled not the label's / artist's already?
export async function ruledNotSame(tx: Queryable, objectId: string, candidate: ReviewCandidate): Promise<boolean> {
	if (candidate.objectId) {
		const [a, b] = [objectId, candidate.objectId].sort();
		const rows = await tx.query(`select 1 from curator.catalog_not_same where object_a = $1 and object_b = $2`, [a!, b!]);
		return rows.length > 0;
	}
	const rows = await tx.query(
		`select 1 from curator.catalog_review r
		where r.object_id = $1 and r.status = 'decided' and r.decision->>'action' = 'not_same'
			and r.candidates->((r.decision->>'candidate')::int) @> $2::text::jsonb limit 1`,
		[objectId, JSON.stringify({ provider: candidate.provider, providerId: candidate.providerId })],
	);
	return rows.length > 0;
}

// `edition`: the release's edition insight (insights.ts), when two of one title were ruled apart.
export type ObjectRelease = { id: string; title: string; artists: string[]; date: string | null; providers: string[]; edition?: string };

// What the catalogue holds for an artist or label: its releases, newest first.
export async function objectReleases(tx: Queryable, objectId: string, limit = 25): Promise<ObjectRelease[]> {
	const rows = await tx.query<{ id: string; name: string; release_at: string | null; artists: string | null; providers: string | null }>(
		`select r.id, r.name, to_char(r.release_at, 'YYYY-MM-DD') as release_at,
			(select string_agg(a.name, '|' order by ar.position) from curator.catalog_edge ar join curator.catalog_object a on a.id = ar.src where ar.dst = r.id and ar.kind = 'artist-release') as artists,
			(select string_agg(distinct so.provider, '|') from curator.catalog_source_object so where so.object_id = r.id) as providers
		from curator.catalog_object r
		where r.kind = 'release' and r.merged_into is null and (
			exists (select 1 from curator.catalog_edge e where e.kind = 'artist-release' and e.src = $1 and e.dst = r.id)
			or exists (select 1 from curator.catalog_edge e where e.kind = 'release-label' and e.src = r.id and e.dst = $1))
		order by r.release_at desc nulls last, r.name limit $2::int`,
		[objectId, String(limit)],
	);
	const editions = await editionsOf(tx, rows.map((r) => r.id));
	return rows.map((r) => ({ id: r.id, title: r.name, artists: r.artists ? r.artists.split('|') : [], date: r.release_at, providers: r.providers ? r.providers.split('|') : [], ...(editions.has(r.id) ? { edition: editions.get(r.id)! } : {}) }));
}

export async function notSame(tx: Queryable, a: string, b: string, by: string, reason: string | null): Promise<void> {
	const [x, y] = [a, b].sort();
	await tx.query(`insert into curator.catalog_not_same (object_a, object_b, reason, by_whom) values ($1, $2, $3, $4) on conflict do nothing`, [x!, y!, reason, by]);
}

const MERGEABLE: readonly CatalogKind[] = ['artist', 'label', 'release', 'recording', 'playlist'];

export type MergeResult = { from: string; into: string; moved: Record<string, number> };

export async function mergeObjects(tx: SystemTx, fromId: string, intoId: string, by: string, reason: string, evidence: Record<string, unknown> = {}): Promise<MergeResult> {
	if (fromId === intoId) throw new Error('merge: same object');
	const objs = await tx.query<{ id: string; kind: CatalogKind; merged_into: string | null }>(`select id, kind, merged_into from curator.catalog_object where id = any($1::uuid[])`, [`{${fromId},${intoId}}`]);
	const from = objs.find((o) => o.id === fromId);
	const into = objs.find((o) => o.id === intoId);
	if (!from || !into) throw new Error('merge: unknown object');
	if (from.merged_into || into.merged_into) throw new Error('merge: already merged');
	if (from.kind !== into.kind) throw new Error(`merge: ${from.kind} into ${into.kind}`);
	if (!MERGEABLE.includes(from.kind)) throw new Error(`merge: ${from.kind} objects are not merged`);
	const [x, y] = [fromId, intoId].sort();
	if ((await tx.query(`select 1 from curator.catalog_not_same where object_a = $1 and object_b = $2`, [x!, y!])).length) throw new Error('merge: ruled not the same');

	const moved: Record<string, number> = {};
	const count = async (name: string, sql: string, params: (string | null)[] = [fromId, intoId]) => {
		moved[name] = (await tx.query(sql, params)).length;
	};
	await count('representations', `update curator.catalog_source_object set object_id = $2 where object_id = $1 returning 1`);
	await count('identifiers', `update curator.catalog_identifier set object_id = $2 where object_id = $1 returning 1`);
	await count('facts', `insert into curator.catalog_fact (object_id, field, source, value, confidence, method, at)
		select $2, field, source, value, confidence, method, at from curator.catalog_fact where object_id = $1
		on conflict do nothing returning 1`);
	await tx.query(`delete from curator.catalog_fact where object_id = $1`, [fromId]);
	// Edges: one that already exists on the winner takes the loser's evidence
	// and goes; the rest are re-pointed. Both ends, then no self-loops.
	for (const end of ['src', 'dst'] as const) {
		const other = end === 'src' ? 'dst' : 'src';
		await tx.query(
			`insert into curator.catalog_edge_evidence (edge_id, source_object_id, confidence, at)
			select e2.id, ev.source_object_id, ev.confidence, ev.at
			from curator.catalog_edge e1 join curator.catalog_edge e2 on e2.${end} = $2 and e2.kind = e1.kind and e2.${other} = e1.${other}
			join curator.catalog_edge_evidence ev on ev.edge_id = e1.id
			where e1.${end} = $1 on conflict do nothing`,
			[fromId, intoId],
		);
		await tx.query(
			`delete from curator.catalog_edge e1 using curator.catalog_edge e2
			where e1.${end} = $1 and e2.${end} = $2 and e2.kind = e1.kind and e2.${other} = e1.${other}`,
			[fromId, intoId],
		);
		await count(`edges_${end}`, `update curator.catalog_edge set ${end} = $2 where ${end} = $1 returning 1`);
	}
	await tx.query(`delete from curator.catalog_edge where src = dst`);
	await count('events', `update curator.catalog_event set subject_id = $2 where subject_id = $1 returning 1`);
	await count('event_subjects', `insert into curator.catalog_event_subject (seq, object_id) select seq, $2 from curator.catalog_event_subject where object_id = $1 on conflict do nothing returning 1`);
	await tx.query(`delete from curator.catalog_event_subject where object_id = $1`, [fromId]);
	for (const col of ['genre_id', 'recording_id']) {
		await tx.query(
			`insert into curator.catalog_chart_entry (genre_id, provider, recording_id, rank, best_rank, first_seen_at, last_seen_at)
			select ${col === 'genre_id' ? '$2' : 'genre_id'}, provider, ${col === 'recording_id' ? '$2' : 'recording_id'}, rank, best_rank, first_seen_at, last_seen_at
			from curator.catalog_chart_entry where ${col} = $1 on conflict do nothing`,
			[fromId, intoId],
		);
		await tx.query(`delete from curator.catalog_chart_entry where ${col} = $1`, [fromId]);
	}
	await count('playlist_items', `update curator.catalog_playlist_item set playlist_id = case when playlist_id = $1 then $2 else playlist_id end, recording_id = case when recording_id = $1 then $2 else recording_id end where playlist_id = $1 or recording_id = $1 returning 1`);
	await tx.query(`insert into curator.catalog_enrich_task (object_id, need, provider, next_due_at, attempts, last_error) select $2, need, provider, next_due_at, attempts, last_error from curator.catalog_enrich_task where object_id = $1 on conflict do nothing`, [fromId, intoId]);
	await tx.query(`delete from curator.catalog_enrich_task where object_id = $1`, [fromId]);
	await count('signals', `update curator.catalog_signal set object_id = $2 where object_id = $1 returning 1`);
	// What was learned about either twin holds for the one release they are.
	await count('insights', `update curator.catalog_insight set object_id = $2 where object_id = $1 returning 1`);
	await tx.query(`delete from curator.catalog_cursor where object_id = $1`, [fromId]);
	await tx.query(`update curator.catalog_review set object_id = $2 where object_id = $1 and status = 'open'`, [fromId, intoId]);
	// Watches are each watcher's rows: moved as them.
	const watches = await tx.query<{ user_id: string; source: string; muted: boolean }>(`select user_id, source, muted from curator.catalog_watch where object_id = $1`, [fromId]);
	for (const w of watches) {
		await tx.asUser(w.user_id, async (q) => {
			await q.query(`insert into curator.catalog_watch (object_id, source, muted) values ($1, $2, $3) on conflict (user_id, object_id) do nothing`, [intoId, w.source, w.muted ? 'true' : 'false']);
			await q.query(`delete from curator.catalog_watch where object_id = $1`, [fromId]);
		});
	}
	moved.watches = watches.length;
	// The winner's facts stay; the loser fills what the winner lacks.
	await tx.query(
		`update curator.catalog_object w set attrs = l.attrs || w.attrs, label_text = coalesce(w.label_text, l.label_text), duration_sec = coalesce(w.duration_sec, l.duration_sec),
			release_at = coalesce(w.release_at, l.release_at), release_type = coalesce(w.release_type, l.release_type), home_provider = coalesce(w.home_provider, l.home_provider), updated_at = now()
		from curator.catalog_object l where w.id = $2 and l.id = $1`,
		[fromId, intoId],
	);
	await tx.query(`update curator.catalog_object set merged_into = $2 where id = $1`, [fromId, intoId]);
	// One label under two names keeps the plainer one, whichever side won.
	if (from.kind === 'label') {
		const names = await tx.query<{ id: string; name: string }>(`select id, name from curator.catalog_object where id = any($1::uuid[])`, [`{${fromId},${intoId}}`]);
		const kept = names.find((n) => n.id === intoId)!.name;
		const name = plainerLabelName(kept, names.find((n) => n.id === fromId)!.name);
		if (name !== kept) {
			await tx.query(`update curator.catalog_object set name = $2, name_fold = $3, updated_at = now() where id = $1`, [intoId, name, nameFold(name)]);
			moved.renamed = 1;
		}
	}
	await tx.query(
		`insert into curator.catalog_merge_log (from_id, into_id, reason, by_whom, evidence, undo) values ($1, $2, $3, $4, $5::text::jsonb, $6::text::jsonb)`,
		[fromId, intoId, reason, by, JSON.stringify(evidence), JSON.stringify({ moved })],
	);
	await ensureCursors(tx, intoId);
	return { from: fromId, into: intoId, moved };
}

// A page attached by decision: the identity rules are the reviewer's now.
export async function attachPage(tx: Queryable, objectId: string, c: ReviewCandidate & { provider: CatalogProvider; providerId: string }, kind: CatalogKind): Promise<void> {
	const ids = c.provider === 'musicbrainz' && kind === 'label' ? [{ namespace: 'mbid_label' as const, value: c.providerId }]
		: c.provider === 'musicbrainz' && kind === 'artist' ? [{ namespace: 'mbid_artist' as const, value: c.providerId }]
		: c.provider === 'discogs' && kind === 'label' ? [{ namespace: 'discogs_label' as const, value: c.providerId }]
		: c.provider === 'discogs' && kind === 'artist' ? [{ namespace: 'discogs_artist' as const, value: c.providerId }]
		: [];
	await new Ingester(tx, { reason: 'enrichment' }).attachTo(objectId, { provider: c.provider, kind, providerId: c.providerId, name: c.name, url: c.url ?? null, identifiers: ids });
	await ensureCursors(tx, objectId);
}

// A skip by the agent leaves the review to the operator (escalated, in the
// inbox); a skip by the operator closes it. The merge's gate — held until the
// operator approves — is the inbox's (admin-ops.ts decide): a held review is
// reopened just before this runs.
export async function decideReview(tx: SystemTx, id: number, decision: ReviewDecision, by: string, note: string | null, opts: { operator?: boolean } = {}): Promise<{ review: Review; merge?: MergeResult }> {
	const review = await getReview(tx, id);
	if (!review) throw new Error(`review ${id} not found`);
	if (review.status === 'decided') throw new Error(`review ${id} already decided by ${review.decidedBy}`);
	if (review.status !== 'open') throw new Error(`review ${id} is ${review.status}: it is the inbox's to resolve`);
	const candidate = decision.candidate === undefined ? null : review.candidates[decision.candidate] ?? null;
	if (decision.action !== 'skip' && !candidate) throw new Error(`review ${id}: candidate ${decision.candidate} is not one of ${review.candidates.length}`);
	if (decision.action === 'skip' && !opts.operator) {
		await tx.query(
			`update curator.catalog_review set status = 'escalated', decision = $2::text::jsonb, decided_by = $3, note = $4 where id = $1::bigint`,
			[String(id), JSON.stringify(decision), by, note],
		);
		return { review: (await getReview(tx, id))! };
	}
	let merge: MergeResult | undefined;
	const [obj] = await tx.query<{ kind: CatalogKind }>(`select kind from curator.catalog_object where id = $1`, [review.objectId]);
	if (decision.action === 'attach' && review.kind === 'label_playlist') {
		// The playlist is the label's catalogue: kept as such, and read on the
		// label's next catalogue-playlist step.
		if (!candidate!.providerId) throw new Error('attach needs a playlist candidate');
		await acceptCataloguePlaylist(tx, review.objectId, { id: candidate!.providerId, name: candidate!.name, url: candidate!.url ?? null });
		await queueCataloguePlaylists(tx, review.objectId);
	} else if (decision.action === 'attach') {
		if (!candidate!.provider || !candidate!.providerId) throw new Error('attach needs a provider candidate');
		await attachPage(tx, review.objectId, candidate as ReviewCandidate & { provider: CatalogProvider; providerId: string }, obj!.kind);
	} else if (decision.action === 'merge') {
		if (!candidate!.objectId) throw new Error('merge needs a catalogue-object candidate');
		merge = await mergeObjects(tx, candidate!.objectId, review.objectId, by, `review ${id}${note ? `: ${note}` : ''}`, { review: id });
	} else if (decision.action === 'not_same' && candidate!.objectId) {
		await notSame(tx, review.objectId, candidate!.objectId, by, note);
	}
	await tx.query(
		`update curator.catalog_review set status = 'decided', decision = $2::text::jsonb, decided_by = $3, note = $4, decided_at = now() where id = $1::bigint`,
		[String(id), JSON.stringify(decision), by, note],
	);
	return { review: (await getReview(tx, id))!, ...(merge ? { merge } : {}) };
}

// A review whose merge waits for the operator: the agent's decision is kept
// on it, and it leaves the agent's queue until the inbox resolves it.
export async function holdReview(tx: Queryable, id: number, decision: ReviewDecision, by: string, note: string | null): Promise<void> {
	await tx.query(
		`update curator.catalog_review set status = 'held', decision = $2::text::jsonb, decided_by = $3, note = $4 where id = $1::bigint and status = 'open'`,
		[String(id), JSON.stringify(decision), by, note],
	);
}

// Back to open (a held or escalated review the inbox resolves, or a ruling undone).
export async function reopenReview(tx: Queryable, id: number): Promise<void> {
	await tx.query(`update curator.catalog_review set status = 'open', decision = null, decided_by = null, note = null, decided_at = null where id = $1::bigint`, [String(id)]);
}

// Look-alikes inside the catalogue: two live artists or labels with the same
// folded name. Each pair becomes a `duplicate` review, with both sides'
// releases as evidence, unless ruled apart or already asked.
export async function scanDuplicates(tx: Queryable, opts: { kind?: 'artist' | 'label'; limit?: number } = {}): Promise<number> {
	const pairs = await tx.query<{ a: string; b: string; name: string; kind: CatalogKind }>(
		`select a.id as a, b.id as b, a.name, a.kind from curator.catalog_object a join curator.catalog_object b
			on b.kind = a.kind and b.name_fold = a.name_fold and b.id > a.id
		where a.merged_into is null and b.merged_into is null and a.kind = any($1::text[])
			and not exists (select 1 from curator.catalog_not_same n where n.object_a = least(a.id, b.id) and n.object_b = greatest(a.id, b.id))
		order by a.name limit $2::int`,
		[opts.kind ? `{${opts.kind}}` : '{artist,label}', String(opts.limit ?? 200)],
	);
	let opened = 0;
	for (const p of pairs) {
		const [mine, theirs] = await Promise.all([objectReleases(tx, p.a, 15), objectReleases(tx, p.b, 15)]);
		const id = await openReview(tx, {
			kind: 'duplicate',
			objectId: p.a,
			candidates: [{ objectId: p.b, name: p.name, releases: theirs.map((r) => r.title) }],
			evidence: { releases: mine.map((r) => r.title), overlap: mine.filter((m) => theirs.some((t) => nameFold(t.title) === nameFold(m.title))).length },
		});
		if (id !== null) opened++;
	}
	return opened;
}

// A page wrongly attached to a label (a namesake's profile, a dead handle) taken
// off it: the identifiers it brought, the edges only it evidenced, and the
// provider's tracker started over on what is left. The page is recorded as
// ruled not the label's (a decided label_page review), so the profiler never
// attaches it again.
export async function unlinkPage(
	tx: SystemTx,
	objectId: string,
	// A page as a link classifies it, or (provider null) any page the object
	// holds, by its URL or its id: the profiler attaches Discogs, MusicBrainz and
	// archived sites no link names.
	page: { provider: CatalogProvider | null; id: string | null; url: string | null },
	by: string,
	note: string | null,
): Promise<UnlinkResult> {
	const norm = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
	const rows = await tx.query<{ id: string; provider: CatalogProvider; provider_id: string; url: string | null; kind: CatalogKind; payload: string }>(
		`select id, provider, provider_id, url, kind, payload::text as payload from curator.catalog_source_object where object_id = $1 and ($2::text is null or provider = $2) and provider <> 'user'`,
		[objectId, page.provider],
	);
	const hits = rows.filter((r) => (page.id !== null && r.provider_id === page.id) || (page.url !== null && r.url !== null && norm(r.url) === norm(page.url)));
	if (hits.length !== 1) throw new Error(`unlink: ${hits.length ? 'several' : 'no'} ${page.provider ?? ''} page(s) of this object match ${page.url ?? page.id} (it has: ${rows.map((r) => `${r.provider}:${r.provider_id}`).join(', ') || 'none'})`);
	const so = hits[0]!;
	const edges = await tx.query(
		`delete from curator.catalog_edge e
		where e.id in (select ev.edge_id from curator.catalog_edge_evidence ev where ev.source_object_id = $1)
			and not exists (select 1 from curator.catalog_edge_evidence o where o.edge_id = e.id and o.source_object_id <> $1)
		returning 1`,
		[so.id],
	);
	// And the ids the page stands for (a Discogs or MusicBrainz label id), however they were recorded.
	const namespace = so.provider === 'discogs' ? 'discogs_label' : so.provider === 'musicbrainz' ? 'mbid_label' : null;
	const identifiers = await tx.query<{ namespace: string; value: string }>(
		`delete from curator.catalog_identifier where object_id = $2 and (source_object_id = $1 or (namespace = $3 and value = $4)) returning namespace, value`,
		[so.id, objectId, namespace, so.provider_id],
	);
	await tx.query(`delete from curator.catalog_source_object where id = $1`, [so.id]);
	// Its tracker read this page: dropped when no other page of the provider is
	// left, else started over on the one that is.
	const [left] = await tx.query<{ n: unknown }>(`select count(*) as n from curator.catalog_source_object where object_id = $1 and provider = $2`, [objectId, so.provider]);
	if (num(left!.n) === 0) await tx.query(`delete from curator.catalog_cursor where object_id = $1 and provider = $2`, [objectId, so.provider]);
	else await tx.query(`update curator.catalog_cursor set cursor = '{}'::jsonb, fail_count = 0, last_error = null, next_due_at = now() where object_id = $1 and provider = $2`, [objectId, so.provider]);
	const [name] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [objectId]);
	const review = await openReview(tx, { kind: 'label_page', objectId, candidates: [{ provider: so.provider, providerId: so.provider_id, name: name?.name ?? '', url: so.url ?? page.url ?? null }], evidence: { reason: 'unlinked by hand: not this label\'s page' } });
	if (review !== null) {
		await tx.query(
			`update curator.catalog_review set status = 'decided', decision = $2::text::jsonb, decided_by = $3, note = $4, decided_at = now() where id = $1::bigint`,
			[String(review), JSON.stringify({ action: 'not_same', candidate: 0 }), by, note],
		);
	}
	return {
		provider: so.provider,
		providerId: so.provider_id,
		edges: edges.length,
		identifiers: identifiers.length,
		review,
		undo: { source: { provider: so.provider, kind: so.kind, providerId: so.provider_id, url: so.url, payload: JSON.parse(so.payload) as Record<string, unknown> }, identifiers, review },
	};
}

export type UnlinkResult = {
	provider: CatalogProvider;
	providerId: string;
	edges: number;
	identifiers: number;
	review: number | null;
	// What relinkPage puts back (the edges only the page evidenced are not: a tracker re-reads them).
	undo: { source: { provider: CatalogProvider; kind: CatalogKind; providerId: string; url: string | null; payload: Record<string, unknown> }; identifiers: { namespace: string; value: string }[]; review: number | null };
};

// An unlink undone: the page is back, with its ids and its tracker, and the
// ruling that kept the profiler off it is gone.
export async function relinkPage(tx: Queryable, objectId: string, u: UnlinkResult['undo']): Promise<void> {
	const [row] = await tx.query<{ id: string }>(
		`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url, payload) values ($1, $2, $3, $4, $5, $6::text::jsonb)
		on conflict (provider, kind, provider_id) do update set object_id = excluded.object_id returning id`,
		[objectId, u.source.provider, u.source.kind, u.source.providerId, u.source.url, JSON.stringify(u.source.payload)],
	);
	for (const i of u.identifiers) {
		await tx.query(`insert into curator.catalog_identifier (namespace, value, object_id, source_object_id) values ($1, $2, $3, $4) on conflict do nothing`, [i.namespace, i.value, objectId, row!.id]);
	}
	// The ruling the unlink recorded is withdrawn (the inbox item refers to the
	// review, so it stays, decided as a skip): the profiler may attach it again.
	if (u.review !== null) await tx.query(`update curator.catalog_review set decision = '{"action":"skip"}'::jsonb, note = coalesce(note || ' — ', '') || 'undone: the page was put back' where id = $1::bigint`, [String(u.review)]);
	await ensureCursors(tx, objectId);
}

// Overrules a "not the same" ruling and merges: for when the owner says two
// objects are one after all. The ruling goes; the merge log keeps why.
export async function mergeOverruling(tx: SystemTx, fromId: string, intoId: string, by: string, note: string): Promise<MergeResult> {
	const [x, y] = [fromId, intoId].sort();
	const ruled = await tx.query(`delete from curator.catalog_not_same where object_a = $1 and object_b = $2 returning 1`, [x!, y!]);
	return mergeObjects(tx, fromId, intoId, by, `${ruled.length ? 'overruled not-same: ' : ''}${note}`, { overruled: ruled.length > 0 });
}

// Returns the name it had, for the undo.
export async function renameObject(tx: Queryable, objectId: string, name: string): Promise<string> {
	const n = name.trim();
	if (!n) throw new Error('rename: empty name');
	const [was] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1 and merged_into is null`, [objectId]);
	if (!was) throw new Error('rename: not a live object');
	await tx.query(`update curator.catalog_object set name = $2, name_fold = $3, updated_at = now() where id = $1`, [objectId, n, nameFold(n)]);
	return was.name;
}
