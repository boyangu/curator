// The back office's read model (src/backoffice): the shared catalogue as a
// person browses it — labels, artists, tracks, and the releases that tie them
// together. Read-only by construction: plain selects, run by the caller in a
// read-only transaction. Nothing here is per-user; watch counts are the only
// trace of who follows what.

import { CATALOG_BROWSE_MAX, type CatalogBrowseResult, type CatalogProvider } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { editionsOf, insightsOf, type Insight } from './insights.js';
import { summaries } from './objects.js';

export type BrowseKind = 'label' | 'artist' | 'recording';
// scanned / stale: newest scan first / longest unscanned first (never scanned leading).
export type BrowseSort = 'name' | 'recent' | 'watched' | 'scanned' | 'stale' | 'tracks' | 'fewest_tracks';

export type BrowseRow = {
	id: string;
	name: string;
	watchers: number;
	providers: string[];
	discoveredAt: number;
	// When its listing was last read for new releases (null: never).
	scannedAt: number | null;
	// label: releases + roster + tracks (unique recordings); artist: releases + tracks; recording: the rest.
	releases?: number;
	roster?: number;
	tracks?: number;
	artists?: string[];
	release?: string | null;
	label?: string | null;
	date?: string | null;
	durationSec?: number | null;
	isrc?: string | null;
};

export type BrowsePage = { total: number; rows: BrowseRow[] };

export type Ref = { id: string; name: string };
// A row's store representations: what a device plays and links (the back
// office shows only the provider names).
export type Handle = { provider: CatalogProvider; id: string; url: string | null };
// `edition`: its edition insight (insights.ts) — two releases of one title ruled apart read apart.
export type ReleaseRow = { id: string; title: string; date: string | null; type: string | null; artists: Ref[]; labels: Ref[]; labelText: string | null; tracks: number; providers: string[]; handles: Handle[]; edition?: string };
export type TrackRow = { id: string; title: string; artists: Ref[]; position: number | null; durationSec: number | null; isrc: string | null; providers: string[]; handles: Handle[] };

export type ObjectView = {
	id: string;
	kind: string;
	name: string;
	watchers: number;
	discoveredAt: number;
	discoveredVia: string;
	updatedAt: number;
	scannedAt: number | null;
	// Set when the id asked for was merged away: the view is of the winner.
	redirectedFrom: string | null;
	attrs: Record<string, unknown>;
	identifiers: { namespace: string; value: string }[];
	sources: { provider: string; kind: string; providerId: string; url: string | null; firstSeenAt: number; lastSeenAt: number }[];
	facts: { field: string; source: string; value: unknown; method: string }[];
	merged: { id: string; name: string }[];
	// What the operator or the agent concluded about it (insights.ts), oldest first.
	insights: Insight[];
	// Per kind; absent when it does not apply.
	releases?: ReleaseRow[];
	releaseCount?: number;
	tracks?: TrackRow[];
	trackCount?: number;
	artists?: (Ref & { releases?: number; role?: string | null })[];
	labels?: (Ref & { releases: number })[];
	roster?: Ref[];
	similar?: Ref[];
	genres?: Ref[];
	playlists?: Ref[];
	charts?: { genre: Ref; provider: string; rank: number; bestRank: number; lastSeenAt: number }[];
	release?: { date: string | null; type: string | null; labelText: string | null };
	durationSec?: number | null;
};

const MAX_LIMIT = 200;
// The owner's-library filter on a column (local-library.ts): '' when off.
const inLibrary = (on: boolean | undefined, col: string) => (on ? ` and exists (select 1 from pg_temp.local_library l where l.object_id = ${col})` : '');
// A label's (o) tracks: the recordings on its releases, each once however
// many releases carry it — and two catalogue copies of one ISRC as one.
const labelTracks = (library: boolean | undefined) => `(select count(distinct coalesce((select min(i.value) from curator.catalog_identifier i where i.object_id = rec.id and i.namespace = 'isrc'), rec.id::text))
	from curator.catalog_edge rl
	join curator.catalog_object r on r.id = rl.src and r.merged_into is null
	join curator.catalog_edge rr on rr.src = r.id and rr.kind = 'release-recording'
	join curator.catalog_object rec on rec.id = rr.dst and rec.merged_into is null
	where rl.dst = o.id and rl.kind = 'release-label'${inLibrary(library, 'rec.id')})`;
const like = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const split = (s: string | null) => (s ? s.split('|') : []);
// `id<US>name` pairs joined by <RS> (chr 31 / 30, never in a name): one
// aggregate per relation instead of a query per row.
const refs = (s: string | null): Ref[] =>
	s
		? s.split('\u001e').map((p) => {
				const [id, name] = p.split('\u001f');
				return { id: id!, name: name ?? '' };
			})
		: [];
const REF_AGG = (alias: string, order: string) => `string_agg(${alias}.id || chr(31) || ${alias}.name, chr(30) order by ${order})`;
// `provider<US>id<US>url` triples joined by <RS>, the object's representations.
const HANDLE_AGG = (object: string) =>
	`(select string_agg(so.provider || chr(31) || so.provider_id || chr(31) || coalesce(so.url, ''), chr(30) order by so.provider, so.first_seen_at) from curator.catalog_source_object so where so.object_id = ${object})`;
const handlesOf = (s: string | null): Handle[] =>
	s
		? s.split('\u001e').map((p) => {
				const [provider, id, url] = p.split('\u001f');
				return { provider: provider as CatalogProvider, id: id!, url: url || null };
			})
		: [];
const providersOf = (h: Handle[]): string[] => [...new Set(h.map((x) => x.provider))].sort();

// A page of one kind, filtered by a fold of `q` anywhere in the name (prefix
// hits first). Contains-search is a scan of the kind's rows, which a back
// office can afford; the per-row relations are counted for the page only.
// `library`: only what the owner's local files are (local-library.ts) — asked
// only by a host that loaded it (the local catalogue).
export async function browseList(tx: Queryable, args: { kind: BrowseKind; q?: string; sort?: BrowseSort; offset?: number; limit?: number; library?: boolean }): Promise<BrowsePage> {
	const fold = args.q ? nameFold(args.q) : '';
	const limit = Math.min(Math.max(args.limit ?? 50, 1), MAX_LIMIT);
	const offset = Math.max(args.offset ?? 0, 0);
	const order =
		args.sort === 'recent'
			? 'o.discovered_at desc, o.name_fold'
			: args.sort === 'watched'
				? 'o.watch_count desc, o.name_fold'
				: args.sort === 'scanned'
					? 'o.scanned_at desc nulls last, o.name_fold'
					: args.sort === 'stale'
						? 'o.scanned_at asc nulls first, o.name_fold'
						: args.sort === 'tracks' && args.kind === 'label'
							? 'o.track_n desc, o.name_fold'
							: args.sort === 'fewest_tracks' && args.kind === 'label'
								? 'o.track_n asc, o.name_fold'
				: fold
					? `(o.name_fold like $2::text || '%') desc, o.name_fold`
					: 'o.name_fold';
	const where = `o.kind = $1::text and o.merged_into is null and ($2::text = '' or o.name_fold like '%' || $2::text || '%')${inLibrary(args.library, 'o.id')}`;
	const params = [args.kind, like(fold)];
	// Labels' track counts: the owner's library's from the table its load
	// counted (local-library.ts; a label with none is not in it, so it drops
	// out); the whole catalogue's over the kind only to sort by them (a few
	// seconds), otherwise for the page's rows alone.
	const libraryLabels = args.kind === 'label' && args.library;
	const allTracks = args.kind === 'label' && (libraryLabels || args.sort === 'tracks' || args.sort === 'fewest_tracks');
	const source = libraryLabels
		? `(select o.*, ll.tracks as track_n from curator.catalog_object o join pg_temp.local_library_label ll on ll.label_id = o.id where ${where})`
		: allTracks
			? `(select o.*, ${labelTracks(false)} as track_n from curator.catalog_object o where ${where})`
			: `(select o.* from curator.catalog_object o where ${where})`;
	// The total needs no counting of tracks unless the library drops labels.
	const [count] = await tx.query<{ n: unknown }>(libraryLabels ? `select count(*) as n from ${source} o` : `select count(*) as n from curator.catalog_object o where ${where}`, params);
	const extra =
		args.kind === 'label'
			? `${allTracks ? 'o.track_n' : labelTracks(args.library)} as tracks,
				(select count(*) from curator.catalog_edge e where e.kind = 'release-label' and e.dst = o.id${inLibrary(args.library, 'e.src')}) as releases,
				(select count(*) from curator.catalog_edge e where e.kind = 'label-artist' and e.src = o.id${inLibrary(args.library, 'e.dst')}) as roster`
			: args.kind === 'artist'
				? `(select count(*) from curator.catalog_edge e where e.kind = 'artist-release' and e.src = o.id${inLibrary(args.library, 'e.dst')}) as releases,
					(select count(*) from curator.catalog_edge e where e.kind = 'recording-artist' and e.dst = o.id${inLibrary(args.library, 'e.src')}) as tracks`
				: `(select string_agg(a.name, '|' order by e.position) from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = o.id and e.kind = 'recording-artist') as artists,
					rel.name as release, to_char(rel.release_at, 'YYYY-MM-DD') as date,
					coalesce((select l.name from curator.catalog_edge e join curator.catalog_object l on l.id = e.dst where e.src = rel.id and e.kind = 'release-label' limit 1), rel.label_text) as label,
					o.duration_sec, (select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc`;
	// A recording's release: the earliest one it appears on.
	const join =
		args.kind === 'recording'
			? `left join lateral (select r.id, r.name, r.release_at, r.label_text from curator.catalog_edge e join curator.catalog_object r on r.id = e.src
				where e.dst = o.id and e.kind = 'release-recording' and r.merged_into is null order by r.release_at nulls last limit 1) rel on true`
			: '';
	const rows = await tx.query<Record<string, unknown> & { id: string; name: string; watch_count: unknown; providers: string | null; discovered_ms: unknown; scanned_ms: unknown }>(
		`select o.id, o.name, o.watch_count, extract(epoch from o.discovered_at) * 1000 as discovered_ms, extract(epoch from o.scanned_at) * 1000 as scanned_ms,
			(select string_agg(distinct so.provider, '|') from curator.catalog_source_object so where so.object_id = o.id) as providers,
			${extra}
		from (select * from ${source} o order by ${order} limit $3::int offset $4::int) o
		${join}
		order by ${order}`,
		[...params, String(limit), String(offset)],
	);
	return {
		total: num(count!.n),
		rows: rows.map((r) => {
			const base: BrowseRow = { id: r.id, name: r.name, watchers: num(r.watch_count), providers: split(r.providers), discoveredAt: num(r.discovered_ms), scannedAt: numOrNull(r.scanned_ms) };
			if (args.kind === 'label') return { ...base, releases: num(r.releases), roster: num(r.roster), tracks: num(r.tracks) };
			if (args.kind === 'artist') return { ...base, releases: num(r.releases), tracks: num(r.tracks) };
			return {
				...base,
				artists: split(r.artists as string | null),
				release: (r.release as string | null) ?? null,
				label: (r.label as string | null) ?? null,
				date: (r.date as string | null) ?? null,
				durationSec: numOrNull(r.duration_sec),
				isrc: (r.isrc as string | null) ?? null,
			};
		}),
	};
}

// Releases matching `cond` (on r), newest first, each with its artists,
// labels and track count.
async function releases(tx: Queryable, cond: string, params: string[], limit: number, library?: boolean): Promise<ReleaseRow[]> {
	const rows = await tx.query<{ id: string; name: string; date: string | null; release_type: string | null; label_text: string | null; artists: string | null; labels: string | null; tracks: unknown; handles: string | null }>(
		`select r.id, r.name, to_char(r.release_at, 'YYYY-MM-DD') as date, r.release_type, r.label_text,
			(select ${REF_AGG('a', 'e.position')} from curator.catalog_edge e join curator.catalog_object a on a.id = e.src where e.dst = r.id and e.kind = 'artist-release') as artists,
			(select ${REF_AGG('l', 'l.name')} from curator.catalog_edge e join curator.catalog_object l on l.id = e.dst where e.src = r.id and e.kind = 'release-label') as labels,
			(select count(*) from curator.catalog_edge e where e.src = r.id and e.kind = 'release-recording'${inLibrary(library, 'e.dst')}) as tracks,
			${HANDLE_AGG('r.id')} as handles
		from curator.catalog_object r
		where r.kind = 'release' and r.merged_into is null and ${cond}${inLibrary(library, 'r.id')}
		order by r.release_at desc nulls last, r.name
		limit ${limit}`,
		params,
	);
	const editions = await editionsOf(tx, rows.map((r) => r.id));
	return rows.map((r) => {
		const handles = handlesOf(r.handles);
		return {
			...(editions.has(r.id) ? { edition: editions.get(r.id)! } : {}),
			id: r.id,
			title: r.name,
			date: r.date,
			type: r.release_type,
			artists: refs(r.artists),
			labels: refs(r.labels),
			labelText: r.label_text,
			tracks: num(r.tracks),
			providers: providersOf(handles),
			handles,
		};
	});
}

// Recordings (`o` in `from`), each with its artists; `pos` is the position
// on a release, where there is one.
async function tracks(tx: Queryable, args: { from: string; pos: string; order: string }, params: string[], limit: number): Promise<TrackRow[]> {
	const { from, pos, order } = args;
	const rows = await tx.query<{ id: string; name: string; pos: unknown; duration_sec: unknown; isrc: string | null; artists: string | null; handles: string | null }>(
		`select o.id, o.name, ${pos} as pos, o.duration_sec,
			(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc,
			(select ${REF_AGG('a', 'e.position')} from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = o.id and e.kind = 'recording-artist') as artists,
			${HANDLE_AGG('o.id')} as handles
		${from}
		order by ${order}
		limit ${limit}`,
		params,
	);
	return rows.map((r) => {
		const handles = handlesOf(r.handles);
		return { id: r.id, title: r.name, artists: refs(r.artists), position: numOrNull(r.pos), durationSec: numOrNull(r.duration_sec), isrc: r.isrc, providers: providersOf(handles), handles };
	});
}

const DETAIL_LIMIT = CATALOG_BROWSE_MAX;

// `library`: a label's and an artist's releases, tracks, artists and counts
// only as far as the owner's library reaches (local-library.ts); a release's
// own tracklist stays whole.
export async function browseObject(tx: Queryable, id: string, opts: { library?: boolean } = {}): Promise<ObjectView | null> {
	const lib = opts.library;
	// Follow a merge chain to the live object, as identity.follow does.
	let live = id;
	for (let i = 0; i < 10; i++) {
		const [r] = await tx.query<{ merged_into: string | null }>(`select merged_into from curator.catalog_object where id = $1`, [live]);
		if (!r) return null;
		if (!r.merged_into) break;
		live = r.merged_into;
	}
	const [o] = await tx.query<{
		id: string;
		kind: string;
		name: string;
		watch_count: unknown;
		discovered_ms: unknown;
		discovered_via: string;
		updated_ms: unknown;
		scanned_ms: unknown;
		attrs: string;
		duration_sec: unknown;
		release_date: string | null;
		release_type: string | null;
		label_text: string | null;
	}>(
		`select id, kind, name, watch_count, extract(epoch from discovered_at) * 1000 as discovered_ms, discovered_via,
			extract(epoch from updated_at) * 1000 as updated_ms, extract(epoch from scanned_at) * 1000 as scanned_ms, attrs::text as attrs, duration_sec,
			to_char(release_at, 'YYYY-MM-DD') as release_date, release_type, label_text
		from curator.catalog_object where id = $1`,
		[live],
	);
	if (!o) return null;
	const attrs = JSON.parse(o.attrs) as Record<string, unknown>;
	delete attrs._src;
	const identifiers = await tx.query<{ namespace: string; value: string }>(`select namespace, value from curator.catalog_identifier where object_id = $1 order by namespace, value`, [live]);
	const sources = (
		await tx.query<{ provider: string; kind: string; provider_id: string; url: string | null; first_ms: unknown; last_ms: unknown }>(
			`select provider, kind, provider_id, url, extract(epoch from first_seen_at) * 1000 as first_ms, extract(epoch from last_seen_at) * 1000 as last_ms
			from curator.catalog_source_object where object_id = $1 order by provider, first_seen_at`,
			[live],
		)
	).map((s) => ({ provider: s.provider, kind: s.kind, providerId: s.provider_id, url: s.url, firstSeenAt: num(s.first_ms), lastSeenAt: num(s.last_ms) }));
	const facts = (
		await tx.query<{ field: string; source: string; value: string; method: string }>(`select field, source, value::text as value, method from curator.catalog_fact where object_id = $1 order by field, source`, [live])
	).map((f) => ({ field: f.field, source: f.source, value: JSON.parse(f.value) as unknown, method: f.method }));
	const merged = await tx.query<Ref>(`select id, name from curator.catalog_object where merged_into = $1 order by name`, [live]);
	const view: ObjectView = {
		id: live,
		kind: o.kind,
		name: o.name,
		watchers: num(o.watch_count),
		discoveredAt: num(o.discovered_ms),
		discoveredVia: o.discovered_via,
		updatedAt: num(o.updated_ms),
		scannedAt: numOrNull(o.scanned_ms),
		redirectedFrom: live === id ? null : id,
		attrs,
		identifiers,
		sources,
		facts,
		merged,
		insights: (await insightsOf(tx, [live])).get(live) ?? [],
	};
	const count = async (sql: string) => num((await tx.query<{ n: unknown }>(sql, [live]))[0]!.n);
	const refList = async (sql: string) => tx.query<Ref>(sql, [live]);

	if (o.kind === 'label') {
		const cond = `exists (select 1 from curator.catalog_edge e where e.kind = 'release-label' and e.src = r.id and e.dst = $1)`;
		view.releases = await releases(tx, cond, [live], DETAIL_LIMIT, lib);
		view.releaseCount = await count(`select count(*) as n from curator.catalog_edge e where kind = 'release-label' and dst = $1${inLibrary(lib, 'e.src')}`);
		view.roster = await refList(`select a.id, a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = $1 and e.kind = 'label-artist'${inLibrary(lib, 'a.id')} order by e.position nulls last, a.name`);
		// Who actually releases on it, by count: the roster is only what a page lists.
		view.artists = (
			await tx.query<{ id: string; name: string; n: unknown }>(
				`select a.id, a.name, count(*) as n
				from curator.catalog_edge rl
				join curator.catalog_edge ar on ar.dst = rl.src and ar.kind = 'artist-release'
				join curator.catalog_object a on a.id = ar.src and a.merged_into is null
				where rl.dst = $1 and rl.kind = 'release-label'${inLibrary(lib, 'rl.src')}${inLibrary(lib, 'a.id')}
				group by a.id, a.name order by n desc, a.name limit 100`,
				[live],
			)
		).map((a) => ({ id: a.id, name: a.name, releases: num(a.n) }));
		view.playlists = await refList(`select p.id, p.name from curator.catalog_edge e join curator.catalog_object p on p.id = e.dst where e.src = $1 and e.kind = 'label-playlist' order by p.name`);
	} else if (o.kind === 'artist') {
		const cond = `exists (select 1 from curator.catalog_edge e where e.kind = 'artist-release' and e.src = $1 and e.dst = r.id)`;
		view.releases = await releases(tx, cond, [live], DETAIL_LIMIT, lib);
		view.releaseCount = await count(`select count(*) as n from curator.catalog_edge e where kind = 'artist-release' and src = $1${inLibrary(lib, 'e.dst')}`);
		view.tracks = await tracks(
			tx,
			{
				from: `from curator.catalog_edge ra join curator.catalog_object o on o.id = ra.src and o.merged_into is null where ra.dst = $1 and ra.kind = 'recording-artist'${inLibrary(lib, 'o.id')}`,
				pos: 'null::int',
				order: 'o.name_fold',
			},
			[live],
			DETAIL_LIMIT,
		);
		view.trackCount = await count(`select count(*) as n from curator.catalog_edge e where kind = 'recording-artist' and dst = $1${inLibrary(lib, 'e.src')}`);
		view.labels = (
			await tx.query<{ id: string; name: string; n: unknown }>(
				`select l.id, l.name, count(*) as n
				from curator.catalog_edge ar
				join curator.catalog_edge rl on rl.src = ar.dst and rl.kind = 'release-label'
				join curator.catalog_object l on l.id = rl.dst and l.merged_into is null
				where ar.src = $1 and ar.kind = 'artist-release'${inLibrary(lib, 'ar.dst')}
				group by l.id, l.name order by n desc, l.name`,
				[live],
			)
		).map((l) => ({ id: l.id, name: l.name, releases: num(l.n) }));
		view.roster = await refList(`select l.id, l.name from curator.catalog_edge e join curator.catalog_object l on l.id = e.src where e.dst = $1 and e.kind = 'label-artist' order by l.name`);
		view.similar = await refList(`select a.id, a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = $1 and e.kind = 'similar-artist' order by e.position nulls last, a.name`);
	} else if (o.kind === 'release') {
		view.release = { date: o.release_date, type: o.release_type, labelText: o.label_text };
		view.artists = (
			await tx.query<Ref & { role: string | null }>(`select a.id, a.name, e.role from curator.catalog_edge e join curator.catalog_object a on a.id = e.src where e.dst = $1 and e.kind = 'artist-release' order by e.position`, [live])
		).map((a) => ({ id: a.id, name: a.name, role: a.role }));
		view.labels = (await refList(`select l.id, l.name from curator.catalog_edge e join curator.catalog_object l on l.id = e.dst where e.src = $1 and e.kind = 'release-label' order by l.name`)).map((l) => ({ ...l, releases: 1 }));
		view.tracks = await tracks(
			tx,
			{
				from: `from curator.catalog_edge rr join curator.catalog_object o on o.id = rr.dst and o.merged_into is null where rr.src = $1 and rr.kind = 'release-recording'`,
				pos: 'rr.position',
				order: 'rr.position nulls last, o.name_fold',
			},
			[live],
			DETAIL_LIMIT,
		);
		view.genres = await refList(`select g.id, g.name from curator.catalog_edge e join curator.catalog_object g on g.id = e.dst where e.src = $1 and e.kind = 'object-genre' order by g.name`);
	} else if (o.kind === 'recording') {
		view.durationSec = numOrNull(o.duration_sec);
		view.artists = (
			await tx.query<Ref & { role: string | null }>(`select a.id, a.name, e.role from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = $1 and e.kind = 'recording-artist' order by e.position`, [live])
		).map((a) => ({ id: a.id, name: a.name, role: a.role }));
		view.releases = await releases(tx, `exists (select 1 from curator.catalog_edge e where e.kind = 'release-recording' and e.src = r.id and e.dst = $1)`, [live], DETAIL_LIMIT);
		view.genres = await refList(`select g.id, g.name from curator.catalog_edge e join curator.catalog_object g on g.id = e.dst where e.src = $1 and e.kind = 'object-genre' order by g.name`);
		view.charts = (
			await tx.query<{ genre_id: string; genre: string; provider: string; rank: unknown; best_rank: unknown; last_ms: unknown }>(
				`select c.genre_id, g.name as genre, c.provider, c.rank, c.best_rank, extract(epoch from c.last_seen_at) * 1000 as last_ms
				from curator.catalog_chart_entry c join curator.catalog_object g on g.id = c.genre_id where c.recording_id = $1 order by c.best_rank`,
				[live],
			)
		).map((c) => ({ genre: { id: c.genre_id, name: c.genre }, provider: c.provider, rank: num(c.rank), bestRank: num(c.best_rank), lastSeenAt: num(c.last_ms) }));
		view.playlists = await refList(
			`select distinct p.id, p.name from curator.catalog_playlist_item i join curator.catalog_object p on p.id = i.playlist_id where i.recording_id = $1 and i.removed_at is null order by p.name`,
		);
	}
	return view;
}

// What a device reads (catalog.browse): the same view, with the back office's
// own fields (facts, sources, merge history, charts) left out and each row's
// store handles kept.
export async function browseForClient(tx: Queryable, id: string): Promise<CatalogBrowseResult | null> {
	const v = await browseObject(tx, id);
	if (!v) return null;
	const object = (await summaries(tx, [v.id])).get(v.id);
	if (!object) return null;
	const release = (r: ReleaseRow) => ({ id: r.id, title: r.title, date: r.date, type: r.type, labelText: r.labelText, artists: r.artists, labels: r.labels, trackCount: r.tracks, handles: r.handles });
	const track = (t: TrackRow) => ({ id: t.id, title: t.title, position: t.position, durationSec: t.durationSec, isrc: t.isrc, artists: t.artists, handles: t.handles });
	return {
		object,
		redirectedFrom: v.redirectedFrom,
		...(v.releases ? { releases: v.releases.map(release) } : {}),
		...(v.releaseCount !== undefined ? { releaseCount: v.releaseCount } : {}),
		// An artist's tracks are every recording credited to it: a release's
		// are its tracklist. Only the release's are what a device browses.
		...(v.kind === 'release' && v.tracks ? { tracks: v.tracks.map(track) } : {}),
		...(v.release ? { release: v.release } : {}),
		...(v.artists ? { artists: v.artists } : {}),
		...(v.labels ? { labels: v.labels } : {}),
		...(v.roster ? { roster: v.roster } : {}),
	};
}
