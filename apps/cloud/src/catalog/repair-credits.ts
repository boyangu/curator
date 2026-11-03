// What the SoundCloud and Bandcamp readers' credit splitting got wrong before
// 2026-11-01, undone (`catalog repair credits`). SoundCloud split on `&` and
// both split inside a group's parentheses, so "Keinemusik (Rampa, Adam Port,
// &Me)" was credited as the artists "Keinemusik (Rampa", "Adam Port)" and
// "Me", "Me & You" as "Me" and "You", and "DIN (Efdemin, Marcel Fengler)" as
// "DIN (Efdemin" and "Marcel Fengler)". The readers now split as the library
// does (upload-title.ts).
//
// A broken artist is one known only by such a reader's name key (a `user`
// name claim, or Bandcamp's label-scoped `<band id>/<name>`) whose name leaves
// a bracket open, or which is a piece of an `&`-name credited beside it. Each
// of its credits is decided on its own track or release, because one cut-off
// name can come from several credits ("Me" from "&ME" on one track, from "Me
// & You" on another): the pieces of a bracketed name go to the artists
// credited there, else on the artist's other releases; an `&`-piece only to
// an artist on that very track or release (a store's artist before a
// reader's, then the one with the most credits — a name held twice is its
// own review). A bracketed piece nobody is credited as becomes the artist the
// fixed reader would credit (its name key); an `&`-piece is never invented.
// Once no credit is left the broken artist merges into the artist most of its
// credits went to — a logged merge, so its name key keeps resolving there. A
// store's artist that took a broken name gets its store's name back.

import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import type { SystemTx } from '../db/system-tx.js';
import { withSystemTx } from '../db/system-tx.js';
import { mergeObjects } from './admin.js';
import { WEAK_SQL } from './identity.js';
import { ingestClaims } from './ingest.js';

export type CreditRepairReport = {
	dry: boolean;
	fixed: { name: string; id: string; into: string[]; credits: number; minted: string[] }[];
	renamed: { id: string; from: string; to: string }[];
	left: { name: string; id: string; why: string }[];
};

type Artist = { id: string; name: string };
type Candidate = Artist & { fold: string; store: boolean; credits: number };
type Edge = { id: string; kind: 'recording-artist' | 'artist-release'; src: string; dst: string; role: string | null; position: number | null };

const unbalanced = (s: string) => (s.match(/[([]/g) ?? []).length !== (s.match(/[)\]]/g) ?? []).length;
const UNBALANCED_SQL = `length(regexp_replace(o.name, '[^([]', '', 'g')) <> length(regexp_replace(o.name, '[^)\\]]', '', 'g'))`;
// "&-name" pieces: "me" in "me and you", "and me".
const AMP_PIECE_SQL = `(' ' || b.name_fold || ' ') like ('% and ' || o.name_fold || ' %') or (' ' || b.name_fold || ' ') like ('% ' || o.name_fold || ' and %')`;
// "Sebo & David Dorad Rmx)": the remix segment of a title, its word not a name.
const REMIX_WORD = /\s+(rmx|remix|mix|edit|dub|rework|version|bootleg)$/i;

async function suspects(tx: Queryable): Promise<Artist[]> {
	return tx.query<Artist>(
		`select o.id, o.name from curator.catalog_object o
		where o.kind = 'artist' and o.merged_into is null
			and exists (select 1 from curator.catalog_source_object s where s.object_id = o.id)
			and not exists (select 1 from curator.catalog_source_object s where s.object_id = o.id and not ${WEAK_SQL})
			and (${UNBALANCED_SQL} or exists (
				select 1 from curator.catalog_edge e1
				join curator.catalog_edge e2 on e2.src = e1.src and e2.kind = 'recording-artist'
				join curator.catalog_object b on b.id = e2.dst and b.merged_into is null and b.name like '%&%'
				where e1.dst = o.id and e1.kind = 'recording-artist' and (${AMP_PIECE_SQL})))
		order by o.name`,
	);
}

// A store's artist the broken credit joined by its folded name ("Ilka Rane)"
// folds to "Ilka Rane") took the broken name, an artist's name being its
// latest claim's: it gets the name its store gave back.
async function renameBack(tx: Queryable): Promise<CreditRepairReport['renamed']> {
	const rows = await tx.query<{ id: string; name: string; store: string | null }>(
		`select o.id, o.name, (select s.payload->>'name' from curator.catalog_source_object s where s.object_id = o.id and not ${WEAK_SQL} order by s.last_seen_at desc limit 1) as store
		from curator.catalog_object o
		where o.kind = 'artist' and o.merged_into is null and ${UNBALANCED_SQL}`,
	);
	const out: CreditRepairReport['renamed'] = [];
	for (const r of rows) {
		if (!r.store || unbalanced(r.store) || r.store === r.name) continue;
		await tx.query(`update curator.catalog_object set name = $2, name_fold = $3, updated_at = now() where id = $1`, [r.id, r.store, nameFold(r.store)]);
		out.push({ id: r.id, from: r.name, to: r.store });
	}
	return out;
}

// Who is credited beside one credit: on its track and the releases holding
// it, or on its release and that release's tracks.
const EDGE_SCOPE_SQL = `
	with rel as (
		select $2::uuid as id where $1 = 'artist-release'
		union select rr.src from curator.catalog_edge rr where $1 = 'recording-artist' and rr.dst = $3 and rr.kind = 'release-recording'
	), rec as (
		select $3::uuid as id where $1 = 'recording-artist'
		union select rr.dst from rel join curator.catalog_edge rr on rr.src = rel.id and rr.kind = 'release-recording' where $1 = 'artist-release'
	)
	select e.src as id from rel join curator.catalog_edge e on e.dst = rel.id and e.kind = 'artist-release'
	union select e.dst from rec join curator.catalog_edge e on e.src = rec.id and e.kind = 'recording-artist'`;

// Who is credited on the very track or release: an `&`-piece is told only
// here ("Ben" beside "Ben & Vincent" on one track of a compilation is not the
// "Ben" of another).
const EDGE_ONLY_SQL = `
	select e.src as id from curator.catalog_edge e where $1 = 'artist-release' and e.dst = $2 and e.kind = 'artist-release'
	union select e.dst from curator.catalog_edge e where $1 = 'recording-artist' and e.src = $3 and e.kind = 'recording-artist'`;

// Everyone credited on any release the artist is credited on.
const ARTIST_SCOPE_SQL = `
	with rel as (
		select dst as id from curator.catalog_edge where src = $1 and kind = 'artist-release'
		union select rr.src from curator.catalog_edge ra join curator.catalog_edge rr on rr.dst = ra.src and rr.kind = 'release-recording'
		where ra.dst = $1 and ra.kind = 'recording-artist'
	)
	select e.src as id from rel join curator.catalog_edge e on e.dst = rel.id and e.kind = 'artist-release'
	union select ra.dst from rel join curator.catalog_edge rr on rr.src = rel.id and rr.kind = 'release-recording'
	join curator.catalog_edge ra on ra.src = rr.dst and ra.kind = 'recording-artist'`;

async function candidates(tx: Queryable, scopeSql: string, params: string[], self: string): Promise<Candidate[]> {
	const rows = await tx.query<{ id: string; name: string; fold: string; store: boolean; credits: unknown }>(
		`select o.id, o.name, o.name_fold as fold,
			exists (select 1 from curator.catalog_source_object s where s.object_id = o.id and not ${WEAK_SQL}) as store,
			(select count(*) from curator.catalog_edge c where (c.dst = o.id and c.kind = 'recording-artist') or (c.src = o.id and c.kind = 'artist-release')) as credits
		from (${scopeSql}) w join curator.catalog_object o on o.id = w.id and o.merged_into is null
		where o.id <> $${params.length + 1}`,
		[...params, self],
	);
	return rows.filter((r) => !unbalanced(r.name)).map((r) => ({ ...r, store: r.store === true, credits: num(r.credits) }));
}

const best = (hits: Candidate[]): Candidate | null =>
	hits.length ? [...hits].sort((a, b) => Number(b.store) - Number(a.store) || b.credits - a.credits || a.id.localeCompare(b.id))[0]! : null;

// One piece of a broken name among the artists credited somewhere.
function match(piece: string, among: Candidate[], ampPiece: boolean): Candidate | null {
	const f = nameFold(piece);
	if (!f) return null;
	return (
		best(among.filter((c) => c.fold === f)) ??
		best(among.filter((c) => c.fold === `and ${f}`)) ??
		(ampPiece ? best(among.filter((c) => ` ${c.fold} `.includes(` and ${f} `) || ` ${c.fold} `.includes(` ${f} and `))) : null)
	);
}

// The pieces a bracketed name was cut from: the bracket's sides, a remix
// word off the end.
const bracketPieces = (name: string): string[] =>
	name
		.split(/[()[\]]/)
		.map((p) => p.trim().replace(REMIX_WORD, '').trim())
		.filter(Boolean);

// The artist the fixed reader credits for a piece: the broken artist's own
// name-key namespace with the piece's name.
async function minted(tx: SystemTx, a: Artist, piece: string): Promise<string> {
	const [rep] = await tx.query<{ provider: string; provider_id: string }>(
		`select provider, provider_id from curator.catalog_source_object where object_id = $1 order by provider = 'bandcamp' desc limit 1`,
		[a.id],
	);
	const providerId = rep?.provider === 'bandcamp' ? `${rep.provider_id.split('/')[0]}/${nameFold(piece)}` : `name:${nameFold(piece)}`;
	const provider = rep?.provider === 'bandcamp' ? ('bandcamp' as const) : ('user' as const);
	const out = await ingestClaims(tx, [{ provider, kind: 'artist', providerId, name: piece }], { reason: 'tracker' });
	return out.outcomes[0]!.objectId;
}

// One credit moved to `to`, with its evidence; the broken one goes.
async function moveCredit(tx: Queryable, e: Edge, from: string, to: string): Promise<void> {
	if (to !== from) {
		const [src, dst] = e.kind === 'recording-artist' ? [e.src, to] : [to, e.dst];
		await tx.query(`insert into curator.catalog_edge (src, kind, dst, role, position) values ($1, $2, $3, $4, $5) on conflict (src, kind, dst) do nothing`, [src, e.kind, dst, e.role, e.position === null ? null : String(e.position)]);
		await tx.query(
			`insert into curator.catalog_edge_evidence (edge_id, source_object_id, confidence, at)
			select n.id, ev.source_object_id, ev.confidence, ev.at from curator.catalog_edge_evidence ev, curator.catalog_edge n
			where ev.edge_id = $1 and n.src = $2 and n.kind = $3 and n.dst = $4 on conflict do nothing`,
			[e.id, src, e.kind, dst],
		);
	}
}

// An artist's credits on one release — on it and on its tracks — given to
// another artist by hand (`catalog artist recredit`): what no rule here can
// tell, the operator can ("Me" on a mau5trap compilation is "Me & You").
export async function recreditOn(tx: Queryable, from: string, releaseId: string, to: string): Promise<number> {
	const edges = await tx.query<Edge>(
		`select id, kind, src, dst, role, position from curator.catalog_edge
		where (src = $1 and kind = 'artist-release' and dst = $2)
			or (dst = $1 and kind = 'recording-artist' and src in (select dst from curator.catalog_edge where src = $2 and kind = 'release-recording'))`,
		[from, releaseId],
	);
	for (const e of edges) {
		await moveCredit(tx, e, from, to);
		await tx.query(`delete from curator.catalog_edge where id = $1`, [e.id]);
	}
	return edges.length;
}

async function repairOne(tx: SystemTx, a: Artist, by: string, report: CreditRepairReport): Promise<void> {
	const bracketed = unbalanced(a.name);
	const pieces = bracketed ? bracketPieces(a.name) : [a.name];
	const edges = await tx.query<Edge>(
		`select id, kind, src, dst, role, position from curator.catalog_edge
		where (dst = $1 and kind = 'recording-artist') or (src = $1 and kind = 'artist-release')`,
		[a.id],
	);
	const wide = bracketed ? await candidates(tx, ARTIST_SCOPE_SQL, [a.id], a.id) : [];
	const mintedIds = new Map<string, string>();
	const used = new Map<string, number>();
	let moved = 0;
	let left = 0;
	for (const e of edges) {
		const near = await candidates(tx, bracketed ? EDGE_SCOPE_SQL : EDGE_ONLY_SQL, [e.kind, e.dst, e.src], a.id);
		const targets: string[] = [];
		let ok = true;
		for (const p of pieces) {
			const hit = match(p, near, !bracketed) ?? (bracketed ? match(p, wide, false) : null);
			if (hit) targets.push(hit.id);
			else if (bracketed) {
				if (!mintedIds.has(p)) mintedIds.set(p, await minted(tx, a, p));
				targets.push(mintedIds.get(p)!);
			} else ok = false;
		}
		if (!ok) {
			left++;
			continue;
		}
		for (const t of new Set(targets)) {
			await moveCredit(tx, e, a.id, t);
			used.set(t, (used.get(t) ?? 0) + 1);
		}
		// A piece minted as the broken artist's own key ("Adam Port)" is keyed
		// `name:adam port`) keeps its credit; any other is moved off it.
		if (!targets.includes(a.id)) await tx.query(`delete from curator.catalog_edge where id = $1`, [e.id]);
		moved++;
	}
	if (!moved) {
		report.left.push({ name: a.name, id: a.id, why: `none of its ${edges.length} credit(s) placed` });
		return;
	}
	const names = async (ids: string[]) => (await tx.query<Artist>(`select id, name from curator.catalog_object where id = any($1::uuid[])`, [`{${ids.join(',')}}`])).map((r) => r.name);
	const into = [...used.keys()];
	const mintedNames = [...mintedIds.keys()];
	if (left) report.left.push({ name: a.name, id: a.id, why: `${left} of ${edges.length} credit(s) not placed (kept)` });
	else if (used.has(a.id)) {
		// It is the minted piece: the name the fixed reader gives it.
		const piece = [...mintedIds.entries()].find(([, id]) => id === a.id)![0];
		await tx.query(`update curator.catalog_object set name = $2, name_fold = $3, updated_at = now() where id = $1`, [a.id, piece, nameFold(piece)]);
	} else {
		const top = into.sort((x, y) => used.get(y)! - used.get(x)!)[0]!;
		await mergeObjects(tx, a.id, top, by, 'credit cut apart by the SoundCloud/Bandcamp splitter', { repair: 'split-credits', into });
	}
	report.fixed.push({ name: a.name, id: a.id, into: await names(into), credits: moved, minted: mintedNames });
}

export async function repairCredits(db: Db, opts: { dry?: boolean; by?: string } = {}): Promise<CreditRepairReport> {
	const report: CreditRepairReport = { dry: !!opts.dry, fixed: [], renamed: [], left: [] };
	const rollback = new Error('dry run');
	try {
		await withSystemTx(db, async (tx) => {
			report.renamed = await renameBack(tx);
			for (const a of await suspects(tx)) {
				// An earlier repair may have merged it already.
				const [still] = await tx.query(`select 1 from curator.catalog_object where id = $1 and merged_into is null`, [a.id]);
				if (still) await repairOne(tx, a, opts.by ?? 'claude-code', report);
			}
			if (opts.dry) throw rollback;
		});
	} catch (e) {
		if (e !== rollback) throw e;
	}
	return report;
}
