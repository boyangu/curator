// What ingestion reads and writes, a batch of claims at a time.
//
// A claim resolved on its own costs about twenty statements, and a label's
// listing is a few hundred claims: at a network hop per statement one poll
// took a minute from the API's own machine and the upkeep run could not be
// used from home at all (2026-11-25). Here the whole batch is read in at most
// three statements and written in one, whatever its size:
//
//   prefetch — 1. the representations, identifiers, genre aliases and objects
//              the claims name; 2. for what that did not resolve, the
//              recordings and releases the identity rules would consider;
//              3. the tracklists and credits around the releases and
//              recordings found, for the slot and corroboration rules.
//   flush    — everything the batch decided, in one statement.
//
// In between, the Ingester (ingest.ts) asks and writes here, in memory: every
// answer is the database's as prefetched plus what this batch has queued, so
// claims in one batch see each other's results exactly as they did row by
// row. An answer this cannot give (a question the prefetch did not foresee)
// flushes first and asks identity.ts's own SQL, which stays the rule's
// definition; the matchers below are that SQL over the batch's rows.
//
// Ids are minted here, so a new object's rows need no answer from the server.
// A representation another transaction inserted meanwhile keeps its own id,
// and the rows queued against ours follow it (flush).

import { randomUUID } from 'node:crypto';
import type { CatalogClaim, CatalogKind } from '@curator/protocol';
import { creditsShareAct, nameFold, recordingKey } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { releaseAtOf } from './fold.js';
import { type ClaimParent, corroborated, findByIdentifier, findRepresentation, NAMESPACE_KIND, normalizeIdentifier, recordingByKey, releaseByTitle } from './identity.js';
import { heldTracks, type HeldTrack } from './slots.js';

// `last_seen_at` is shown as a day; a representation seen again within one is
// not rewritten.
const SEEN_EVERY = `interval '1 day'`;

// An object as the batch knows it. `base` is what the database holds of the
// attributes; the flush writes the difference.
export type Obj = {
	id: string;
	kind: CatalogKind;
	name: string;
	nameFold: string;
	attrs: Record<string, unknown>;
	base: Record<string, unknown>;
	durationSec: number | null;
	releaseAtMs: number | null;
	discoveredMs: number;
	// Not in the database yet, with the columns its insert carries.
	fresh: boolean;
	renamed: boolean;
	// Columns a later claim fills where they are still empty.
	fill: { durationSec?: number; releaseAtMs?: number; releaseType?: string; labelText?: string };
	// First values of the columns, and of what only an insert sets.
	recKey: string | null;
	homeProvider: string | null;
	dirty: boolean;
};

type Rep = { id: string; objectId: string; url: string | null; stale: boolean };
type RepInfo = { n: number; strong: Set<string> };

type ObjRow = { id: string; kind: CatalogKind; name: string; fold: string; attrs: Record<string, unknown>; dur: number | null; rel: number | null; disc: number; merged: string | null };

const OBJ_JSON = (o: string): string =>
	`jsonb_build_object('id', ${o}.id, 'kind', ${o}.kind, 'name', ${o}.name, 'fold', ${o}.name_fold, 'attrs', ${o}.attrs, 'dur', ${o}.duration_sec::float8,
		'rel', (extract(epoch from ${o}.release_at) * 1000)::float8, 'disc', (extract(epoch from ${o}.discovered_at) * 1000)::float8, 'merged', ${o}.merged_into)`;

const repKey = (c: Pick<CatalogClaim, 'provider' | 'kind' | 'providerId'>): string => `${c.provider}|${c.kind}|${c.providerId}`;
const isWeakId = (provider: string, providerId: string): boolean => (provider === 'user' && providerId.startsWith('name:')) || providerId.includes('/');
const add = <K, V>(m: Map<K, Set<V>>, k: K, v: V): void => {
	const s = m.get(k);
	if (s) s.add(v);
	else m.set(k, new Set([v]));
};
const real = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : Math.fround(n));

// A claim the prefetch reads for: itself as it will be resolved (store blocks
// and credit rules already applied), without its children.
export type FlatClaim = { claim: CatalogClaim; parent: CatalogClaim | null };

export class IngestBatch {
	constructor(
		private readonly tx: Queryable,
		private readonly reason: string,
	) {}

	// ── what is known ──────────────────────────────────────────────────────
	private readonly reps = new Map<string, Rep | null>();
	private readonly idents = new Map<string, string | null>();
	private readonly objs = new Map<string, Obj>();
	private readonly aliases = new Map<string, string | null | undefined>();
	// rec_key → the live recordings under it; only keys that were asked for.
	private readonly recKeys = new Map<string, Set<string>>();
	private readonly recKeysRead = new Set<string>();
	// name_fold → releases; credits by release. Probes read: `fold|ms`.
	private readonly relFolds = new Map<string, Set<string>>();
	private readonly relProbes = new Set<string>();
	private readonly credits = new Map<string, Map<string, string>>();
	// A release that gained its date in this batch was not a candidate when the
	// title probes were read.
	private readonly dated = new Set<string>();
	// Around the releases and recordings found (prefetch 3) and what the batch
	// added since.
	private readonly releaseArtists = new Map<string, Set<string>>();
	private readonly recordingArtists = new Map<string, Set<string>>();
	private readonly tracks = new Map<string, Set<string>>();
	private readonly releasesOf = new Map<string, Set<string>>();
	private readonly releaseLabels = new Map<string, Set<string>>();
	private readonly rosters = new Map<string, Set<string>>();
	private readonly heldRows = new Map<string, HeldTrack[]>();
	private readonly slots = new Map<string, Map<string, number | null>>();
	private readonly repInfo = new Map<string, RepInfo>();
	private readonly nodes = new Set<string>();
	private readonly folds = new Set<string>();
	private edgesAdded = false;
	// name_fold → the live labels of that name (only folds that were asked
	// for), the ones this batch made, and what ranks them (labelNamed).
	private readonly labelFolds = new Map<string, Set<string>>();
	private readonly freshLabels = new Map<string, Set<string>>();
	private readonly labelInfo = new Map<string, { n: number; strong: Set<string> }>();

	// ── what is queued ─────────────────────────────────────────────────────
	private readonly fresh: Obj[] = [];
	private newReps = new Map<string, { id: string; object_id: string; provider: string; kind: string; provider_id: string; url: string | null; payload: unknown }>();
	private seen = new Map<string, { id: string; url: string | null }>();
	private newIdents = new Map<string, { namespace: string; value: string; object_id: string; so: string }>();
	private facts = new Map<string, { object_id: string; field: string; source: string; value: unknown; live: boolean }>();
	private newAliases = new Map<string, { provider: string; raw_fold: string }>();
	private edges = new Map<string, { id: string; src: string; kind: string; dst: string; role: string | null; position: number | null }>();
	private evidence = new Map<string, { src: string; kind: string; dst: string; so: string }>();
	private tasks = new Map<string, { object_id: string; need: string; provider: string }>();
	private dirty = new Set<Obj>();

	// ── prefetch ───────────────────────────────────────────────────────────

	async prefetch(flat: readonly FlatClaim[], objectIds: readonly string[] = []): Promise<void> {
		const reps = new Map<string, { p: string; k: string; i: string }>();
		const idents = new Map<string, { n: string; v: string }>();
		const aliases = new Map<string, { p: string; f: string }>();
		for (const { claim: c } of flat) {
			const key = repKey(c);
			if (!this.reps.has(key)) reps.set(key, { p: c.provider, k: c.kind, i: c.providerId });
			for (const ident of c.identifiers ?? []) {
				if (NAMESPACE_KIND[ident.namespace] !== c.kind) continue;
				const v = normalizeIdentifier(ident.namespace, ident.value);
				if (v && !this.idents.has(`${ident.namespace}|${v}`)) idents.set(`${ident.namespace}|${v}`, { n: ident.namespace, v });
			}
			for (const g of c.genres ?? []) {
				const f = nameFold(g);
				if (f && !this.aliases.has(`${c.provider}|${f}`)) aliases.set(`${c.provider}|${f}`, { p: c.provider, f });
			}
		}
		const ids = objectIds.filter((id) => !this.objs.has(id));
		if (reps.size || idents.size || aliases.size || ids.length) await this.readNamed([...reps.values()], [...idents.values()], [...aliases.values()], ids);
		const labels = new Set<string>();
		for (const { claim: c } of flat) {
			const f = c.kind === 'label' && !this.reps.get(repKey(c)) ? nameFold(c.name) : '';
			if (f && !this.labelFolds.has(f)) labels.add(f);
		}
		if (labels.size) await this.readLabels([...labels]);
		await this.readCandidates(flat);
		await this.readAround(flat);
	}

	private async readNamed(reps: { p: string; k: string; i: string }[], idents: { n: string; v: string }[], aliases: { p: string; f: string }[], ids: string[]): Promise<void> {
		const rows = await this.tx.query<{ t: string; j: string }>(
			`with rep as (
				select s.provider, s.kind, s.provider_id, s.id, s.object_id, s.url, s.last_seen_at < now() - ${SEEN_EVERY} as stale
				from jsonb_to_recordset($1::text::jsonb) as w(p text, k text, i text)
				join curator.catalog_source_object s on s.provider = w.p and s.kind = w.k and s.provider_id = w.i
			), ident as (
				select i.namespace, i.value, i.object_id
				from jsonb_to_recordset($2::text::jsonb) as w(n text, v text)
				join curator.catalog_identifier i on i.namespace = w.n and i.value = w.v
			), ids as (
				select object_id as id from rep union select object_id from ident union select value::uuid from jsonb_array_elements_text($4::text::jsonb)
			)
			select 'rep' as t, jsonb_build_object('p', provider, 'k', kind, 'i', provider_id, 'id', id, 'o', object_id, 'u', url, 's', stale)::text as j from rep
			union all select 'ident', jsonb_build_object('n', namespace, 'v', value, 'o', object_id)::text from ident
			union all select 'alias', jsonb_build_object('p', g.provider, 'f', g.raw_fold, 'g', g.genre_id)::text
				from jsonb_to_recordset($3::text::jsonb) as w(p text, f text) join curator.genre_alias g on g.provider = w.p and g.raw_fold = w.f
			union all select 'obj', ${OBJ_JSON('o')}::text from ids join curator.catalog_object o on o.id = ids.id`,
			[JSON.stringify(reps), JSON.stringify(idents), JSON.stringify(aliases), JSON.stringify(ids)],
		);
		const merged = new Map<string, string>();
		const parsed = rows.map((r) => ({ t: r.t, j: JSON.parse(r.j) as Record<string, unknown> }));
		const take = (o: ObjRow): void => {
			// One asked for by its own id is wanted as it is.
			if (o.merged && !ids.includes(o.id)) merged.set(o.id, o.merged);
			else this.take(o);
		};
		for (const r of parsed) if (r.t === 'obj') take(r.j as unknown as ObjRow);
		// Objects merged away answer for their winners: rare, so asked for only
		// when met.
		for (let hop = 0; hop < 8; hop++) {
			const missing = [...new Set(merged.values())].filter((id) => !this.objs.has(id) && !merged.has(id));
			if (!missing.length) break;
			const more = await this.tx.query<{ j: string }>(`select ${OBJ_JSON('o')}::text as j from curator.catalog_object o where o.id = any($1::uuid[])`, [`{${missing.join(',')}}`]);
			if (!more.length) break;
			for (const r of more) take(JSON.parse(r.j) as ObjRow);
		}
		const live = (id: string): string => {
			let at = id;
			for (let hop = 0; hop < 8 && merged.has(at); hop++) at = merged.get(at)!;
			return this.objs.has(at) ? at : id;
		};
		for (const r of parsed) {
			if (r.t === 'rep') this.reps.set(`${r.j.p}|${r.j.k}|${r.j.i}`, { id: r.j.id as string, objectId: live(r.j.o as string), url: (r.j.u as string | null) ?? null, stale: r.j.s === true });
			else if (r.t === 'ident') this.idents.set(`${r.j.n}|${r.j.v}`, live(r.j.o as string));
			else if (r.t === 'alias') this.aliases.set(`${r.j.p}|${r.j.f}`, (r.j.g as string | null) ?? null);
		}
		for (const r of reps) if (!this.reps.has(`${r.p}|${r.k}|${r.i}`)) this.reps.set(`${r.p}|${r.k}|${r.i}`, null);
		for (const i of idents) if (!this.idents.has(`${i.n}|${i.v}`)) this.idents.set(`${i.n}|${i.v}`, null);
		// Undefined: known to be missing. `has` says it was asked.
		for (const a of aliases) if (!this.aliases.has(`${a.p}|${a.f}`)) this.aliases.set(`${a.p}|${a.f}`, undefined);
	}

	// The live labels under these names, each with how many releases are on it
	// and the stores that hold it under an id of their own.
	private async readLabels(folds: string[]): Promise<void> {
		const rows = await this.tx.query<{ j: string; n: unknown; i: string | null }>(
			`select ${OBJ_JSON('o')}::text as j,
				(select count(*) from curator.catalog_edge e where e.dst = o.id and e.kind = 'release-label') as n,
				(select jsonb_agg(jsonb_build_array(s.provider, s.provider_id)) from curator.catalog_source_object s where s.object_id = o.id and s.kind = 'label')::text as i
			from (select distinct value as v from jsonb_array_elements_text($1::text::jsonb)) w
			join curator.catalog_object o on o.kind = 'label' and o.name_fold = w.v and o.merged_into is null`,
			[JSON.stringify(folds)],
		);
		for (const f of folds) if (!this.labelFolds.has(f)) this.labelFolds.set(f, new Set());
		for (const r of rows) {
			const o = this.take(JSON.parse(r.j) as ObjRow);
			add(this.labelFolds, o.nameFold, o.id);
			if (!this.labelInfo.has(o.id)) {
				const ids = (r.i ? JSON.parse(r.i) : []) as [string, string][];
				this.labelInfo.set(o.id, { n: Number(r.n), strong: new Set(ids.filter(([p, i]) => !isWeakId(p, i)).map(([p]) => p)) });
			}
		}
	}

	private async readCandidates(flat: readonly FlatClaim[]): Promise<void> {
		const keys = new Set<string>();
		const probes = new Map<string, { f: string; at: number }>();
		for (const { claim: c, parent } of flat) {
			if (this.reps.get(repKey(c))) continue;
			if (c.kind === 'recording') {
				const key = recKeyOf(c, parent);
				if (!this.recKeysRead.has(key)) keys.add(key);
			} else if (c.kind === 'release') {
				const at = releaseAtOf(c.facts?.releaseDate);
				const f = nameFold(c.name);
				if (at !== null && !this.relProbes.has(`${f}|${at}`)) probes.set(`${f}|${at}`, { f, at });
			}
		}
		if (!keys.size && !probes.size) return;
		const rows = await this.tx.query<{ t: string; k: string | null; j: string; credits: string | null }>(
			`select 'rec' as t, o.rec_key as k, ${OBJ_JSON('o')}::text as j, null as credits
			from (select distinct value as v from jsonb_array_elements_text($1::text::jsonb)) w
			join curator.catalog_object o on o.rec_key = w.v and o.kind = 'recording' and o.merged_into is null
			union all
			select 'rel', null, ${OBJ_JSON('r')}::text, (
					select jsonb_agg(jsonb_build_array(a.id, a.name) order by e.position)
					from curator.catalog_edge e join curator.catalog_object a on a.id = e.src
					where e.dst = r.id and e.kind = 'artist-release')::text
			from (
				select distinct r.id from jsonb_to_recordset($2::text::jsonb) as w(f text, at float8)
				join curator.catalog_object r on r.kind = 'release' and r.name_fold = w.f and r.merged_into is null and r.release_at is not null
					and abs(extract(epoch from r.release_at) - w.at / 1000) <= 2 * 86400
			) hit join curator.catalog_object r on r.id = hit.id`,
			[JSON.stringify([...keys]), JSON.stringify([...probes.values()])],
		);
		for (const r of rows) {
			const o = this.take(JSON.parse(r.j) as ObjRow);
			if (r.t === 'rec') add(this.recKeys, r.k!, o.id);
			else {
				add(this.relFolds, o.nameFold, o.id);
				const known = this.credits.get(o.id) ?? new Map<string, string>();
				for (const [id, name] of (r.credits ? JSON.parse(r.credits) : []) as [string, string][]) if (!known.has(id)) known.set(id, name);
				this.credits.set(o.id, known);
			}
		}
		for (const k of keys) this.recKeysRead.add(k);
		for (const p of probes.keys()) this.relProbes.add(p);
	}

	private async readAround(flat: readonly FlatClaim[]): Promise<void> {
		const folds = new Set<string>();
		const releases = new Set<string>();
		const recordings = new Set<string>();
		const artists = new Set<string>();
		const labels = new Set<string>();
		let unresolved = false;
		const mark = (id: string | null | undefined): void => {
			const o = id ? this.objs.get(id) : undefined;
			if (!o) return;
			if (o.kind === 'release') releases.add(o.id);
			else if (o.kind === 'recording') recordings.add(o.id);
			else if (o.kind === 'artist') artists.add(o.id);
			else if (o.kind === 'label') labels.add(o.id);
		};
		for (const { claim: c, parent } of flat) {
			const rep = this.reps.get(repKey(c));
			mark(rep?.objectId);
			for (const ident of c.identifiers ?? []) {
				if (NAMESPACE_KIND[ident.namespace] !== c.kind) continue;
				const v = normalizeIdentifier(ident.namespace, ident.value);
				if (v) mark(this.idents.get(`${ident.namespace}|${v}`));
			}
			if (rep) continue;
			if (c.kind === 'recording') for (const id of this.recKeys.get(recKeyOf(c, parent)) ?? []) mark(id);
			if (c.kind === 'release') for (const id of this.relFolds.get(nameFold(c.name)) ?? []) mark(id);
			if (!parent) continue;
			if (c.kind === 'artist' || c.kind === 'label') folds.add(nameFold(c.name));
			if (c.kind === 'artist' || c.kind === 'label' || c.kind === 'recording') unresolved = true;
		}
		if (!unresolved) return;
		const want = [...releases, ...recordings, ...labels].filter((id) => !this.nodes.has(id) && !this.objs.get(id)!.fresh);
		const newFolds = [...folds].filter((f) => !this.folds.has(f));
		const askArtists = [...artists].filter((id) => !this.repInfo.has(id));
		// A fold asked for later needs the nodes read again for it: the names
		// are what the statement filters by.
		if (want.length || (newFolds.length && releases.size + recordings.size + labels.size > 0) || askArtists.length) {
			const of = (s: Set<string>): string => `{${[...s].filter((id) => !this.objs.get(id)!.fresh).join(',')}}`;
			const rows = await this.tx.query<{ t: string; a: string; b: string | null; j: string | null }>(
				`with r0 as materialized (select id from unnest($1::uuid[]) as x(id)),
				t1 as materialized (
					select id from unnest($2::uuid[]) as x(id)
					union select e.dst from r0 join curator.catalog_edge e on e.src = r0.id and e.kind = 'release-recording'
				),
				r1 as materialized (
					select id from r0
					union select e.src from t1 join curator.catalog_edge e on e.dst = t1.id and e.kind = 'release-recording'
				),
				named as materialized (
					select o.id from (select distinct value as v from jsonb_array_elements_text($3::text::jsonb)) w
					join curator.catalog_object o on o.kind = 'artist' and o.name_fold = w.v and o.merged_into is null
				),
				ar as materialized (
					select e.src, e.dst from r1 join curator.catalog_edge e on e.dst = r1.id and e.kind = 'artist-release' join named on named.id = e.src
				),
				ra as materialized (
					select e.src, e.dst from (select rr.dst as id from r1 join curator.catalog_edge rr on rr.src = r1.id and rr.kind = 'release-recording' union select id from t1) t2
					join curator.catalog_edge e on e.src = t2.id and e.kind = 'recording-artist' join named on named.id = e.dst
				),
				ros as materialized (
					select distinct rl.dst as label, ar2.src as artist from unnest($5::uuid[]) as x(id)
					join curator.catalog_edge rl on rl.dst = x.id and rl.kind = 'release-label'
					join curator.catalog_edge ar2 on ar2.dst = rl.src and ar2.kind = 'artist-release'
					join named on named.id = ar2.src
				),
				art as materialized (select src as id from ar union select dst from ra union select artist from ros union select id from unnest($4::uuid[]) as x(id))
				select 'ar' as t, src::text as a, dst::text as b, null as j from ar
				union all select 'ra', src::text, dst::text, null from ra
				union all select 'rr', e.src::text, e.dst::text, null from r1 join curator.catalog_edge e on e.src = r1.id and e.kind = 'release-recording'
					where e.dst in (select id from t1) or e.dst in (select src from ra)
				union all select 'rl', e.src::text, e.dst::text, ${OBJ_JSON('l')}::text from r0 join curator.catalog_edge e on e.src = r0.id and e.kind = 'release-label'
					join curator.catalog_object l on l.id = e.dst and l.kind = 'label' and l.merged_into is null
				union all select 'ros', label::text, artist::text, null from ros
				union all select 'held', e.src::text, e.dst::text, jsonb_build_object('n', o.name, 'd', o.duration_sec::float8, 'p', e.position, 'm', o.merged_into is not null)::text
					from r0 join curator.catalog_edge e on e.src = r0.id and e.kind = 'release-recording' join curator.catalog_object o on o.id = e.dst
				union all select 'art', o.id::text, null, jsonb_build_object('o', ${OBJ_JSON('o')},
						'n', (select count(*) from curator.catalog_source_object s where s.object_id = o.id),
						'i', (select jsonb_agg(jsonb_build_array(s.provider, s.provider_id)) from curator.catalog_source_object s where s.object_id = o.id and s.kind = 'artist'))::text
					from art join curator.catalog_object o on o.id = art.id and o.kind = 'artist' and o.merged_into is null`,
				[of(releases), of(recordings), JSON.stringify([...folds, ...this.folds]), `{${askArtists.join(',')}}`, of(labels)],
			);
			for (const id of releases) {
				this.nodes.add(id);
				if (!this.heldRows.has(id) && !this.objs.get(id)!.fresh) this.heldRows.set(id, []);
			}
			for (const id of [...recordings, ...labels]) this.nodes.add(id);
			for (const r of rows) {
				if (r.t === 'ar') add(this.releaseArtists, r.b!, r.a);
				else if (r.t === 'ra') add(this.recordingArtists, r.a, r.b!);
				else if (r.t === 'rr') {
					add(this.tracks, r.a, r.b!);
					add(this.releasesOf, r.b!, r.a);
				} else if (r.t === 'rl') {
					this.take(JSON.parse(r.j!) as ObjRow);
					add(this.releaseLabels, r.a, r.b!);
				} else if (r.t === 'ros') add(this.rosters, r.a, r.b!);
				else if (r.t === 'held') {
					const h = JSON.parse(r.j!) as { n: string; d: number | null; p: number | null; m: boolean };
					// A held track is as much a node as the release it is on.
					this.nodes.add(r.b!);
					const list = this.heldRows.get(r.a)!;
					if (!h.m && !list.some((x) => x.id === r.b)) list.push({ id: r.b!, name: h.n, durationSec: h.d, position: h.p });
				} else if (r.t === 'art') {
					const a = JSON.parse(r.j!) as { o: ObjRow; n: number; i: [string, string][] | null };
					this.take(a.o);
					if (!this.repInfo.has(a.o.id)) this.repInfo.set(a.o.id, { n: a.n, strong: new Set((a.i ?? []).filter(([p, i]) => !isWeakId(p, i)).map(([p]) => p)) });
				}
			}
		}
		for (const f of folds) this.folds.add(f);
	}

	private take(r: ObjRow): Obj {
		const known = this.objs.get(r.id);
		if (known) return known;
		const o: Obj = {
			id: r.id,
			kind: r.kind,
			name: r.name,
			nameFold: r.fold,
			attrs: r.attrs,
			base: r.attrs,
			durationSec: r.dur,
			releaseAtMs: r.rel,
			discoveredMs: r.disc,
			fresh: false,
			renamed: false,
			fill: {},
			recKey: null,
			homeProvider: null,
			dirty: false,
		};
		this.objs.set(o.id, o);
		return o;
	}

	// ── the questions ──────────────────────────────────────────────────────

	async object(id: string): Promise<Obj> {
		if (!this.objs.has(id)) await this.readNamed([], [], [], [id]);
		const o = this.objs.get(id);
		if (!o) throw new Error(`no live catalogue object ${id}`);
		return o;
	}

	async representation(c: CatalogClaim): Promise<string | null> {
		const r = this.reps.get(repKey(c));
		if (r !== undefined) return r?.objectId ?? null;
		await this.flush();
		return findRepresentation(this.tx, c);
	}

	async byIdentifier(c: CatalogClaim): Promise<{ id: string; namespace: string } | null> {
		for (const ident of c.identifiers ?? []) {
			if (NAMESPACE_KIND[ident.namespace] !== c.kind) continue;
			const v = normalizeIdentifier(ident.namespace, ident.value);
			if (!v) continue;
			const hit = this.idents.get(`${ident.namespace}|${v}`);
			if (hit === undefined) {
				await this.flush();
				return findByIdentifier(this.tx, c);
			}
			if (hit) return { id: hit, namespace: ident.namespace };
		}
		return null;
	}

	// identity.ts recordingByIsrcOk.
	async isrcOk(objectId: string, durationSec: number | undefined): Promise<boolean> {
		if (durationSec === undefined) return true;
		const o = await this.object(objectId);
		return o.durationSec === null || Math.abs(o.durationSec - durationSec) <= 10;
	}

	async recordingByKey(key: string, durationSec: number | undefined): Promise<string | null> {
		if (!this.recKeysRead.has(key)) {
			await this.flush();
			return recordingByKey(this.tx, key, durationSec);
		}
		const hits = [...(this.recKeys.get(key) ?? [])].filter((id) => {
			const d = this.objs.get(id)!.durationSec;
			return durationSec === undefined || d === null || Math.abs(d - durationSec) <= 5;
		});
		return hits.length === 1 ? hits[0]! : null;
	}

	async releaseByTitle(fold: string, artistNames: string[], releaseAtMs: number | null): Promise<string | null> {
		if (!artistNames.length || releaseAtMs === null) return null;
		if (!this.relProbes.has(`${fold}|${releaseAtMs}`) || this.dated.has(fold)) {
			await this.flush();
			return releaseByTitle(this.tx, fold, artistNames, releaseAtMs);
		}
		const hits = [...(this.relFolds.get(fold) ?? [])].filter((id) => {
			const at = this.objs.get(id)!.releaseAtMs;
			if (at === null || Math.abs(at - releaseAtMs) > 2 * 86400_000) return false;
			const names = [...(this.credits.get(id)?.values() ?? [])];
			return names.length > 0 && creditsShareAct(artistNames, names);
		});
		return hits.length === 1 ? hits[0]! : null;
	}

	async held(releaseId: string): Promise<HeldTrack[]> {
		const o = this.objs.get(releaseId);
		const base = this.heldRows.get(releaseId);
		if (!o || (!o.fresh && !base && !this.minted.has(releaseId))) {
			await this.flush();
			return heldTracks(this.tx, releaseId);
		}
		const out = [...(base ?? [])];
		for (const [id, position] of this.slots.get(releaseId) ?? []) {
			if (out.some((h) => h.id === id)) continue;
			const rec = this.objs.get(id)!;
			out.push({ id, name: rec.name, durationSec: rec.durationSec, position });
		}
		return out;
	}

	async corroborated(kind: 'artist' | 'label', fold: string, parent: ClaimParent, provider: string): Promise<string | null> {
		const known = (id: string): boolean => this.nodes.has(id) || this.minted.has(id);
		const sql = async (): Promise<string | null> => {
			await this.flush();
			return corroborated(this.tx, kind, fold, parent, provider);
		};
		if (!known(parent.id) || (parent.release && !known(parent.release)) || !this.folds.has(fold)) return sql();
		const named = (id: string): boolean => {
			const o = this.objs.get(id);
			return !!o && o.kind === kind && o.nameFold === fold;
		};
		if (kind === 'artist' && (parent.kind === 'release' || parent.kind === 'recording')) {
			const rel = new Set<string>(parent.kind === 'release' ? [parent.id] : (this.releasesOf.get(parent.id) ?? []));
			if (parent.release) rel.add(parent.release);
			const away = new Map<string, number>();
			if (parent.kind === 'recording') for (const a of this.recordingArtists.get(parent.id) ?? []) away.set(a, 0);
			const far = (a: string): void => {
				if (!away.has(a)) away.set(a, 1);
			};
			for (const r of rel) {
				for (const a of this.releaseArtists.get(r) ?? []) far(a);
				for (const t of this.tracks.get(r) ?? []) for (const a of this.recordingArtists.get(t) ?? []) far(a);
			}
			const hits: { id: string; away: number; n: number; at: number }[] = [];
			for (const [id, d] of away) {
				if (!named(id)) continue;
				const info = this.repInfo.get(id);
				if (!info) return sql();
				if (d > 0 && info.strong.has(provider)) continue;
				hits.push({ id, away: d, n: info.n, at: this.objs.get(id)!.discoveredMs });
			}
			hits.sort((x, y) => x.away - y.away || y.n - x.n || x.at - y.at || (x.id < y.id ? -1 : 1));
			return hits[0]?.id ?? null;
		}
		let hits: string[];
		if (kind === 'label' && parent.kind === 'release') hits = [...(this.releaseLabels.get(parent.id) ?? [])].filter(named);
		else if (kind === 'artist' && parent.kind === 'label') {
			// The roster was read before this batch's own releases landed.
			if (this.edgesAdded) return sql();
			hits = [...(this.rosters.get(parent.id) ?? [])].filter(named);
		} else return null;
		return hits.length === 1 ? hits[0]! : null;
	}

	// The label of this name a claim joins when nothing surer names one. A
	// label is the label of its name: a store's text, a library's tag and a
	// store's own label page all write the same thing down, and a label's
	// followers want the release whichever of them found it (2026-11-26). The
	// one thing that tells two labels of a name apart is a store holding both:
	// a claim under a store's own id never joins a label that store already
	// holds under another. Several left: the one more releases are on, then
	// the older.
	async labelNamed(fold: string, c: Pick<CatalogClaim, 'provider' | 'providerId'>): Promise<string | null> {
		if (!fold) return null;
		if (!this.labelFolds.has(fold)) await this.readLabels([fold]);
		const weak = isWeakId(c.provider, c.providerId);
		const hits = [...new Set([...(this.labelFolds.get(fold) ?? []), ...(this.freshLabels.get(fold) ?? [])])]
			.map((id) => ({ id, at: this.objs.get(id)!.discoveredMs, info: this.labelInfo.get(id) ?? { n: 0, strong: new Set<string>() } }))
			.filter((l) => weak || !l.info.strong.has(c.provider));
		hits.sort((x, y) => y.info.n - x.info.n || x.at - y.at || (x.id < y.id ? -1 : 1));
		return hits[0]?.id ?? null;
	}

	// Undefined: no alias row (one is queued); null: an unmapped one.
	async alias(provider: string, fold: string): Promise<string | null> {
		const key = `${provider}|${fold}`;
		if (!this.aliases.has(key)) await this.readNamed([], [], [{ p: provider, f: fold }], []);
		const g = this.aliases.get(key);
		if (g === undefined) {
			this.aliases.set(key, null);
			this.newAliases.set(key, { provider, raw_fold: fold });
		}
		return g ?? null;
	}

	// ── the writes ─────────────────────────────────────────────────────────

	private readonly minted = new Set<string>();

	create(c: CatalogClaim, recKey: string | null): Obj {
		const f = c.facts ?? {};
		const releaseAt = c.kind === 'release' ? releaseAtOf(f.releaseDate) : null;
		const o: Obj = {
			id: randomUUID(),
			kind: c.kind,
			name: c.name,
			nameFold: nameFold(c.name),
			attrs: {},
			base: {},
			durationSec: c.kind === 'recording' ? real(f.durationSec) : null,
			releaseAtMs: releaseAt,
			// Younger than anything the database holds.
			discoveredMs: Number.MAX_SAFE_INTEGER,
			fresh: true,
			renamed: false,
			fill: c.kind === 'release' ? { releaseType: f.releaseType, labelText: f.labelText } : {},
			recKey,
			homeProvider: c.kind === 'playlist' ? c.provider : null,
			dirty: false,
		};
		this.objs.set(o.id, o);
		this.minted.add(o.id);
		this.fresh.push(o);
		this.repInfo.set(o.id, { n: 0, strong: new Set() });
		if (recKey) add(this.recKeys, recKey, o.id);
		if (o.kind === 'release') {
			add(this.relFolds, o.nameFold, o.id);
			this.credits.set(o.id, new Map());
		}
		if (o.kind === 'label') {
			add(this.freshLabels, o.nameFold, o.id);
			this.labelInfo.set(o.id, { n: 0, strong: new Set() });
		}
		return o;
	}

	// The representation's id, and whether this batch is what adds it.
	async represent(c: CatalogClaim, objectId: string): Promise<{ id: string; inserted: boolean }> {
		const key = repKey(c);
		if (!this.reps.has(key)) await this.readNamed([{ p: c.provider, k: c.kind, i: c.providerId }], [], [], []);
		const held = this.reps.get(key);
		if (held) {
			const url = c.url ?? null;
			if (held.stale || (url !== null && url !== held.url)) {
				held.stale = false;
				held.url = url ?? held.url;
				const mine = this.newReps.get(key);
				if (mine) mine.url = held.url;
				else this.seen.set(held.id, { id: held.id, url });
			}
			return { id: held.id, inserted: false };
		}
		const rep: Rep = { id: randomUUID(), objectId, url: c.url ?? null, stale: false };
		this.reps.set(key, rep);
		this.newReps.set(key, {
			id: rep.id,
			object_id: objectId,
			provider: c.provider,
			kind: c.kind,
			provider_id: c.providerId,
			url: rep.url,
			payload: { name: c.name, ...(c.facts ? { facts: c.facts } : {}) },
		});
		const info = this.repInfo.get(objectId);
		if (info) {
			info.n++;
			if (c.kind === 'artist' && !isWeakId(c.provider, c.providerId)) info.strong.add(c.provider);
		}
		if (c.kind === 'label' && !isWeakId(c.provider, c.providerId)) this.labelInfo.get(objectId)?.strong.add(c.provider);
		return { id: rep.id, inserted: true };
	}

	// The representation's own id, when there is one.
	async heldRepresentation(c: CatalogClaim): Promise<string | null> {
		const key = repKey(c);
		if (!this.reps.has(key)) await this.readNamed([{ p: c.provider, k: c.kind, i: c.providerId }], [], [], []);
		return this.reps.get(key)?.id ?? null;
	}

	identify(namespace: string, value: string, objectId: string, sourceObjectId: string): void {
		const key = `${namespace}|${value}`;
		if (this.idents.get(key)) return;
		this.idents.set(key, objectId);
		this.newIdents.set(key, { namespace, value, object_id: objectId, so: sourceObjectId });
	}

	fact(objectId: string, field: string, source: string, value: unknown, live: boolean): void {
		const key = `${objectId}|${field}|${source}`;
		if (!live && this.facts.has(key)) return;
		this.facts.set(key, { object_id: objectId, field, source, value, live });
	}

	// The folded attributes, and the columns they fill where still empty.
	fold(o: Obj, next: Record<string, unknown>, c: CatalogClaim, rename: boolean): void {
		o.attrs = next;
		if (rename) {
			o.name = c.name;
			o.nameFold = nameFold(c.name);
			o.renamed = true;
		}
		const f = c.facts ?? {};
		if (c.kind === 'recording' && o.durationSec === null && f.durationSec !== undefined) {
			o.durationSec = real(f.durationSec);
			o.fill.durationSec = f.durationSec;
		}
		if (c.kind === 'release') {
			const at = releaseAtOf(f.releaseDate);
			if (at !== null && o.releaseAtMs === null) {
				o.releaseAtMs = at;
				o.fill.releaseAtMs = at;
				if (!o.fresh) this.dated.add(o.nameFold);
			}
			o.fill.releaseType ??= f.releaseType;
			o.fill.labelText ??= f.labelText;
		}
		if (!o.fresh) this.dirty.add(o);
	}

	edge(src: string, kind: string, dst: string, sourceObjectId: string, role: string | null, position: number | null): void {
		const key = `${src}|${kind}|${dst}`;
		if (!this.edges.has(key)) this.edges.set(key, { id: randomUUID(), src, kind, dst, role, position });
		this.evidence.set(`${key}|${sourceObjectId}`, { src, kind, dst, so: sourceObjectId });
		this.edgesAdded = true;
		if (kind === 'artist-release') {
			add(this.releaseArtists, dst, src);
			const credits = this.credits.get(dst);
			if (credits && !credits.has(src)) credits.set(src, this.objs.get(src)?.name ?? '');
		} else if (kind === 'recording-artist') add(this.recordingArtists, src, dst);
		else if (kind === 'release-recording') {
			add(this.tracks, src, dst);
			add(this.releasesOf, dst, src);
			const s = this.slots.get(src) ?? new Map<string, number | null>();
			if (!s.has(dst)) s.set(dst, position);
			this.slots.set(src, s);
		} else if (kind === 'release-label') add(this.releaseLabels, src, dst);
	}

	task(objectId: string, need: string, provider: string): void {
		this.tasks.set(`${objectId}|${need}|${provider}`, { object_id: objectId, need, provider });
	}

	// ── flush ──────────────────────────────────────────────────────────────

	// Everything queued, in one statement: one part per table, each in key
	// order so two transactions writing the same rows take them alike. Foreign
	// keys are judged when the statement ends, so the parts need no order.
	async flush(): Promise<void> {
		const params: string[] = [];
		const p = (rows: readonly unknown[]): string => {
			params.push(JSON.stringify(rows));
			return `$${params.length}::text::jsonb`;
		};
		const parts: string[] = [];
		const sorted = <T>(m: Map<string, T>): T[] => [...m.keys()].sort().map((k) => m.get(k)!);

		if (this.fresh.length) {
			const rows = this.fresh.map((o) => ({
				id: o.id,
				kind: o.kind,
				name: o.name,
				name_fold: o.nameFold,
				attrs: o.attrs,
				duration_sec: o.durationSec,
				rec_key: o.recKey,
				release_at: o.releaseAtMs,
				release_type: o.fill.releaseType ?? null,
				label_text: o.fill.labelText ?? null,
				home_provider: o.homeProvider,
			}));
			params.push(this.reason);
			const via = `$${params.length}`;
			parts.push(`obj as (
				insert into curator.catalog_object (id, kind, name, name_fold, attrs, discovered_via, duration_sec, rec_key, release_at, release_type, label_text, home_provider)
				select x.id, x.kind, x.name, x.name_fold, x.attrs, ${via}, x.duration_sec, x.rec_key, to_timestamp(x.release_at / 1000), x.release_type, x.label_text, x.home_provider
				from jsonb_to_recordset(${p(rows)}) as x(id uuid, kind text, name text, name_fold text, attrs jsonb, duration_sec float8, rec_key text, release_at float8, release_type text, label_text text, home_provider text))`);
		}
		// What each new representation's id turned out to be: ours, or the one a
		// concurrent transaction gave it. The rows below follow it.
		let soOf = (x: string): string => `${x}.so`;
		let soJoin = (_x: string): string => '';
		if (this.newReps.size) {
			const rows = sorted(this.newReps);
			const src = p(rows);
			parts.push(`so as (
				insert into curator.catalog_source_object (id, object_id, provider, kind, provider_id, url, payload)
				select x.id, x.object_id, x.provider, x.kind, x.provider_id, x.url, x.payload
				from jsonb_to_recordset(${src}) as x(id uuid, object_id uuid, provider text, kind text, provider_id text, url text, payload jsonb)
				on conflict (provider, kind, provider_id) do update set last_seen_at = now(), url = coalesce(excluded.url, curator.catalog_source_object.url)
				returning id, provider, kind, provider_id)`);
			parts.push(`sid as materialized (
				select x.id as asked, so.id as actual
				from jsonb_to_recordset(${src}) as x(id uuid, provider text, kind text, provider_id text)
				join so on so.provider = x.provider and so.kind = x.kind and so.provider_id = x.provider_id)`);
			soOf = (x) => `coalesce(sid.actual, ${x}.so)`;
			soJoin = (x) => ` left join sid on sid.asked = ${x}.so`;
		}
		if (this.seen.size) {
			parts.push(`seen as (
				update curator.catalog_source_object s set last_seen_at = now(), url = coalesce(x.url, s.url)
				from jsonb_to_recordset(${p(sorted(this.seen))}) as x(id uuid, url text) where s.id = x.id)`);
		}
		if (this.newIdents.size) {
			parts.push(`ident as (
				insert into curator.catalog_identifier (namespace, value, object_id, source_object_id)
				select x.namespace, x.value, x.object_id, ${soOf('x')} from jsonb_to_recordset(${p(sorted(this.newIdents))}) as x(namespace text, value text, object_id uuid, so uuid)${soJoin('x')}
				on conflict do nothing)`);
		}
		const facts = sorted(this.facts);
		for (const live of [false, true]) {
			const rows = facts.filter((f) => f.live === live);
			if (!rows.length) continue;
			// Static: the first value a source gave is the one kept. Live: the
			// source's current value replaces its previous one.
			parts.push(`fact_${live ? 'live' : 'static'} as (
				insert into curator.catalog_fact (object_id, field, source, value)
				select x.object_id, x.field, x.source, x.value from jsonb_to_recordset(${p(rows)}) as x(object_id uuid, field text, source text, value jsonb)
				on conflict (object_id, field, source) do ${live ? 'update set value = excluded.value, at = now()' : 'nothing'})`);
		}
		if (this.dirty.size) {
			const rows = [...this.dirty].sort((a, b) => (a.id < b.id ? -1 : 1)).map((o) => {
				const { _src: src, ...rest } = o.attrs;
				const { _src: srcBase, ...restBase } = o.base;
				return {
					id: o.id,
					patch: changed(rest, restBase),
					src: changed((src ?? {}) as Record<string, unknown>, (srcBase ?? {}) as Record<string, unknown>),
					name: o.renamed ? o.name : null,
					name_fold: o.renamed ? o.nameFold : null,
					duration_sec: o.fill.durationSec ?? null,
					release_at: o.fill.releaseAtMs ?? null,
					release_type: o.fill.releaseType ?? null,
					label_text: o.fill.labelText ?? null,
				};
			});
			// Only what changed, onto the attributes as they are now: a field
			// another transaction wrote since the prefetch is kept.
			parts.push(`upd as (
				update curator.catalog_object o set
					attrs = o.attrs || x.patch || case when x.src = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('_src', coalesce(o.attrs->'_src', '{}'::jsonb) || x.src) end,
					updated_at = now(),
					name = coalesce(x.name, o.name),
					name_fold = coalesce(x.name_fold, o.name_fold),
					duration_sec = coalesce(o.duration_sec, x.duration_sec),
					release_at = coalesce(o.release_at, to_timestamp(x.release_at / 1000)),
					release_type = coalesce(o.release_type, x.release_type),
					label_text = coalesce(o.label_text, x.label_text)
				from jsonb_to_recordset(${p(rows)}) as x(id uuid, patch jsonb, src jsonb, name text, name_fold text, duration_sec float8, release_at float8, release_type text, label_text text)
				where o.id = x.id)`);
		}
		if (this.newAliases.size) {
			parts.push(`ali as (
				insert into curator.genre_alias (provider, raw_fold, genre_id)
				select x.provider, x.raw_fold, null from jsonb_to_recordset(${p(sorted(this.newAliases))}) as x(provider text, raw_fold text) on conflict do nothing)`);
		}
		if (this.edges.size) {
			const src = p(sorted(this.edges));
			parts.push(`ed as (
				insert into curator.catalog_edge (id, src, kind, dst, role, position)
				select x.id, x.src, x.kind, x.dst, x.role, x.position from jsonb_to_recordset(${src}) as x(id uuid, src uuid, kind text, dst uuid, role text, position int)
				on conflict (src, kind, dst) do nothing
				returning id, src, kind, dst)`);
			parts.push(`eid as materialized (
				select id, src, kind, dst from ed
				union all
				select e.id, e.src, e.kind, e.dst from jsonb_to_recordset(${src}) as x(src uuid, kind text, dst uuid)
				join curator.catalog_edge e on e.src = x.src and e.kind = x.kind and e.dst = x.dst)`);
			parts.push(`evi as (
				insert into curator.catalog_edge_evidence (edge_id, source_object_id)
				select distinct eid.id, ${soOf('x')} as so from jsonb_to_recordset(${p(sorted(this.evidence))}) as x(src uuid, kind text, dst uuid, so uuid)
				join eid on eid.src = x.src and eid.kind = x.kind and eid.dst = x.dst${soJoin('x')}
				on conflict do nothing)`);
		}
		if (this.tasks.size) {
			parts.push(`task as (
				insert into curator.catalog_enrich_task (object_id, need, provider)
				select x.object_id, x.need, x.provider from jsonb_to_recordset(${p(sorted(this.tasks))}) as x(object_id uuid, need text, provider text) on conflict do nothing)`);
		}
		if (!parts.length) return;
		await this.tx.query(`with ${parts.join(',\n')}\nselect 1 as done`, params);

		for (const o of [...this.fresh, ...this.dirty]) {
			o.base = o.attrs;
			o.fresh = false;
			o.renamed = false;
			o.fill = {};
		}
		this.fresh.length = 0;
		for (const m of [this.newReps, this.seen, this.newIdents, this.facts, this.newAliases, this.edges, this.evidence, this.tasks, this.dirty]) m.clear();
	}
}

// A tracklist entry's own credits, or the release's (ingest.ts
// attachRelationships hands it those before it is resolved).
function recKeyOf(c: CatalogClaim, parent: CatalogClaim | null): string {
	const artists = c.artists?.length ? c.artists : parent?.kind === 'release' ? parent.artists : undefined;
	return recordingKey(c.name, (artists ?? []).map((a) => a.name));
}

function changed(next: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(next)) if (v !== undefined && JSON.stringify(v) !== JSON.stringify(base[k])) out[k] = v;
	return out;
}
