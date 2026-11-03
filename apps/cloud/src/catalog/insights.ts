// What the back office learned about an object, in words (sql/0023_catalog_insights.sql): a
// provider's listing short of the release, which edition of a same-titled pair this is, anything
// a reviewer wants the next reader to know. Facts are what providers claim; insights are what the
// operator or the agent concluded, signed. An `edition` insight's body is the release's edition
// label wherever releases are listed (browse.ts, the CLI), so two releases with one title that
// were ruled apart read apart.

import type { Queryable } from '../db/db.js';
import { num } from '../db/db.js';

export type Insight = {
	id: number;
	objectId: string;
	topic: string;
	body: string;
	evidence: Record<string, unknown>;
	actor: string;
	createdAt: number;
	retiredAt: number | null;
	retiredBy: string | null;
};

type Row = { id: unknown; object_id: string; topic: string; body: string; evidence: Record<string, unknown> | string; actor: string; created_ms: unknown; retired_ms: unknown; retired_by: string | null };
const COLUMNS = `id, object_id, topic, body, evidence, actor, extract(epoch from created_at) * 1000 as created_ms, extract(epoch from retired_at) * 1000 as retired_ms, retired_by`;
const toInsight = (r: Row): Insight => ({
	id: num(r.id),
	objectId: r.object_id,
	topic: r.topic,
	body: r.body,
	evidence: typeof r.evidence === 'string' ? (JSON.parse(r.evidence) as Record<string, unknown>) : r.evidence,
	actor: r.actor,
	createdAt: num(r.created_ms),
	retiredAt: r.retired_ms === null ? null : num(r.retired_ms),
	retiredBy: r.retired_by,
});

const TOPIC = /^[a-z][a-z0-9_-]{0,31}$/;

export async function addInsight(tx: Queryable, a: { objectId: string; topic: string; body: string; evidence?: Record<string, unknown>; actor: string }): Promise<Insight> {
	const topic = a.topic.trim().toLowerCase();
	const body = a.body.trim();
	if (!TOPIC.test(topic)) throw new Error(`insight topic "${a.topic}": a short lowercase word (edition, partial, note)`);
	if (!body || body.length > 500) throw new Error('insight text: 1 to 500 characters');
	// Insights live on the object a merge kept; one named by a merged-away id goes there.
	const [o] = await tx.query<{ id: string }>(
		`with recursive chain as (select id, merged_into, 0 as depth from curator.catalog_object where id = $1
			union all select o.id, o.merged_into, c.depth + 1 from curator.catalog_object o join chain c on o.id = c.merged_into where c.depth < 20)
		select id from chain where merged_into is null`,
		[a.objectId],
	);
	if (!o) throw new Error(`no catalogue object ${a.objectId}`);
	const [r] = await tx.query<Row>(
		`insert into curator.catalog_insight (object_id, topic, body, evidence, actor) values ($1, $2, $3, $4::text::jsonb, $5) returning ${COLUMNS}`,
		[o.id, topic, body, JSON.stringify(a.evidence ?? {}), a.actor],
	);
	return toInsight(r!);
}

export async function getInsight(tx: Queryable, id: number): Promise<Insight | null> {
	const [r] = await tx.query<Row>(`select ${COLUMNS} from curator.catalog_insight where id = $1::bigint`, [String(id)]);
	return r ? toInsight(r) : null;
}

// Retired, not deleted: the inbox's undo puts it back, and the log keeps what was said.
export async function retireInsight(tx: Queryable, id: number, by: string): Promise<Insight> {
	const [r] = await tx.query<Row>(`update curator.catalog_insight set retired_at = now(), retired_by = $2 where id = $1::bigint and retired_at is null returning ${COLUMNS}`, [String(id), by]);
	if (!r) throw new Error(`insight ${id} not found or already retired`);
	return toInsight(r);
}

export async function restoreInsight(tx: Queryable, id: number): Promise<void> {
	await tx.query(`update curator.catalog_insight set retired_at = null, retired_by = null where id = $1::bigint`, [String(id)]);
}

// The live insights of these objects, oldest first per object.
export async function insightsOf(tx: Queryable, ids: string[], opts: { retired?: boolean } = {}): Promise<Map<string, Insight[]>> {
	const out = new Map<string, Insight[]>();
	const unique = [...new Set(ids)];
	if (!unique.length) return out;
	const rows = await tx.query<Row>(
		`select ${COLUMNS} from curator.catalog_insight where object_id = any($1::uuid[]) ${opts.retired ? '' : 'and retired_at is null'} order by created_at, id`,
		[`{${unique.join(',')}}`],
	);
	for (const r of rows) {
		const i = toInsight(r);
		out.set(i.objectId, [...(out.get(i.objectId) ?? []), i]);
	}
	return out;
}

// Each object's edition label: its latest live `edition` insight.
export async function editionsOf(tx: Queryable, ids: string[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids)];
	if (!unique.length) return new Map();
	const rows = await tx.query<{ object_id: string; body: string }>(
		`select distinct on (object_id) object_id, body from curator.catalog_insight
		where object_id = any($1::uuid[]) and topic = 'edition' and retired_at is null order by object_id, created_at desc, id desc`,
		[`{${unique.join(',')}}`],
	);
	return new Map(rows.map((r) => [r.object_id, r.body]));
}
