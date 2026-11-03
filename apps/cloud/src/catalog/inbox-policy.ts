// What the operator is asked about, and what is only logged (inbox.ts). One
// table, so the tiers are read in one place:
//
//   held (approval)  a label merge — irreversible — when it touches a label
//                    someone follows or the owner's library names, or folds in
//                    a label of any size; always when it overrules a ruling.
//   notice           a reversible action (unlink, rename, link, a ruling) on
//                    such a label: done, surfaced, undoable.
//   audit            the same on a label nobody follows; imports and release
//                    work, which the twins detector follows up; and anything
//                    the operator already said yes to in chat (--approved).

import type { CatalogKind } from '@curator/protocol';
import type { Queryable } from '../db/db.js';
import { num } from '../db/db.js';

export type Severity = 'audit' | 'notice' | 'approval';

export type ObjectFacts = { id: string; kind: CatalogKind; name: string; watchers: number; inLibrary: boolean; releases: number };

// Folding in a label this big is a loss of a catalogue, whoever follows it.
export const MERGE_HOLD_RELEASES = 20;

export async function objectFacts(tx: Queryable, ids: string[]): Promise<Map<string, ObjectFacts>> {
	const unique = [...new Set(ids)];
	if (!unique.length) return new Map();
	const rows = await tx.query<{ id: string; kind: CatalogKind; name: string; watch_count: unknown; library: boolean; releases: unknown }>(
		`select o.id, o.kind, o.name, o.watch_count,
			exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = 'user') as library,
			(select count(*) from curator.catalog_edge e join curator.catalog_object r on r.id = e.src and r.merged_into is null
				where e.kind = 'release-label' and e.dst = o.id) as releases
		from curator.catalog_object o where o.id = any($1::uuid[])`,
		[`{${unique.join(',')}}`],
	);
	return new Map(rows.map((r) => [r.id, { id: r.id, kind: r.kind, name: r.name, watchers: num(r.watch_count), inLibrary: r.library === true, releases: num(r.releases) }]));
}

// A label someone follows, or the owner's library names: its changes are shown.
export const matters = (f: ObjectFacts | undefined): boolean => !!f && (f.watchers > 0 || f.inLibrary);

export function mergePolicy(from: ObjectFacts | undefined, into: ObjectFacts | undefined, opts: { overruling?: boolean; approved?: boolean } = {}): Severity {
	if (opts.approved) return 'audit';
	if (opts.overruling || matters(from) || matters(into) || (from?.releases ?? 0) >= MERGE_HOLD_RELEASES) return 'approval';
	return 'notice';
}

export function reversiblePolicy(subject: ObjectFacts | undefined, opts: { approved?: boolean } = {}): Severity {
	if (opts.approved) return 'audit';
	return matters(subject) ? 'notice' : 'audit';
}
