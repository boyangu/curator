// Reading catalogue objects for a caller: summaries, search, detail, and
// resolving a provider reference to the Curator object behind it.

import type { CatalogHandle, CatalogIdentifier, CatalogKind, CatalogObjectDetail, CatalogObjectSummary, CatalogProvider, CatalogRef } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import { findRepresentation, follow } from './identity.js';

type SummaryRow = { id: string; kind: CatalogKind; name: string; watch_count: unknown; cover: string | null };

export async function summaries(tx: Queryable, ids: string[]): Promise<Map<string, CatalogObjectSummary>> {
	const out = new Map<string, CatalogObjectSummary>();
	if (!ids.length) return out;
	const list = `{${[...new Set(ids)].join(',')}}`;
	const rows = await tx.query<SummaryRow>(
		`select id, kind, name, watch_count, attrs->>'coverUrl' as cover from curator.catalog_object where id = any($1::uuid[])`,
		[list],
	);
	const handles = await tx.query<{ object_id: string; provider: string; provider_id: string; url: string | null }>(
		`select object_id, provider, provider_id, url from curator.catalog_source_object where object_id = any($1::uuid[]) order by provider, first_seen_at`,
		[list],
	);
	const byObject = new Map<string, CatalogHandle[]>();
	for (const h of handles) {
		const l = byObject.get(h.object_id) ?? [];
		l.push({ provider: h.provider as CatalogProvider, id: h.provider_id, url: h.url });
		byObject.set(h.object_id, l);
	}
	for (const r of rows) {
		out.set(r.id, { id: r.id, kind: r.kind, name: r.name, coverUrl: r.cover, watchCount: num(r.watch_count), handles: byObject.get(r.id) ?? [] });
	}
	return out;
}

export async function summary(tx: Queryable, id: string): Promise<CatalogObjectSummary | null> {
	return (await summaries(tx, [id])).get(id) ?? null;
}

// Prefix search on the folded name, most-watched first: what a user looks
// for is usually what others already follow.
export async function search(tx: Queryable, q: string, kind: CatalogKind | undefined, limit: number): Promise<CatalogObjectSummary[]> {
	const fold = nameFold(q);
	if (!fold) return [];
	const rows = await tx.query<{ id: string }>(
		`select id from curator.catalog_object
		where merged_into is null and name_fold like $1 || '%' and ($2::text is null or kind = $2)
		order by watch_count desc, char_length(name_fold), name
		limit $3::int`,
		[fold.replace(/[\\%_]/g, (m) => `\\${m}`), kind ?? null, String(limit)],
	);
	const map = await summaries(
		tx,
		rows.map((r) => r.id),
	);
	return rows.map((r) => map.get(r.id)!).filter(Boolean);
}

export async function resolveRefs(tx: Queryable, refs: CatalogRef[]): Promise<(CatalogObjectSummary | null)[]> {
	const ids = await Promise.all(refs.map((r) => findRepresentation(tx, r)));
	const map = await summaries(
		tx,
		ids.filter((x): x is string => x !== null),
	);
	return ids.map((id) => (id ? (map.get(id) ?? null) : null));
}

export async function detail(tx: Queryable, id: string): Promise<CatalogObjectDetail | null> {
	const live = await follow(tx, id);
	const s = await summary(tx, live);
	if (!s) return null;
	const [row] = await tx.query<{ attrs: string; discovered_ms: unknown; merged_into: string | null }>(
		`select attrs::text as attrs, extract(epoch from discovered_at) * 1000 as discovered_ms, merged_into from curator.catalog_object where id = $1`,
		[live],
	);
	const idents = await tx.query<CatalogIdentifier>(`select namespace, value from curator.catalog_identifier where object_id = $1 order by namespace, value`, [live]);
	const attrs = JSON.parse(row!.attrs) as Record<string, unknown>;
	delete attrs._src;
	return { ...s, attrs, identifiers: idents, discoveredAt: num(row!.discovered_ms), mergedInto: row!.merged_into };
}
