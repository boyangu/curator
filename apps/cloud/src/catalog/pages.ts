// What a device's artist, label and album pages list ('catalog_pages',
// catalog.tracks): an object's releases newest first, each with its
// tracklist in order, a page of releases at a time. Read-only, like
// browse.ts whose row shapes it shares — but paged by keyset and answered in
// three statements a page, where a browse per release would be one round
// trip (and one read-bucket token) per album.

import { CATALOG_TRACKS_BUDGET, CATALOG_TRACKS_PAGE, type CatalogKind, type CatalogPageRelease, type CatalogPageTrack, type CatalogTracksResult } from '@curator/protocol';
import type { Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { HANDLE_AGG, REF_AGG, handlesOf, refs } from './browse.js';
import { deezerOnlySql } from './credits.js';
import { recordingFacts, RECORDING_GENRES_SQL } from './events.js';
import { follow } from './identity.js';

// The sort key of a release: its date as epoch seconds, undated last. Numeric
// text end to end, so the cursor compares exactly what the order sorted.
const UNDATED = '-1e18';
const SORT_KEY = `coalesce(extract(epoch from r.release_at), ${UNDATED})`;

type Cursor = { at: string; id: string };

const encodeCursor = (c: Cursor): string => Buffer.from(`${c.at}|${c.id}`).toString('base64url');

// A cursor is ours to mint and the client's to hand back: anything else is
// read as "from the start" rather than refused, so a stale one from before a
// format change costs a re-read, not an error.
function decodeCursor(s: string | undefined): Cursor | null {
	if (!s) return null;
	const [at, id] = Buffer.from(s, 'base64url').toString().split('|');
	if (!at || !id || !/^-?\d+(\.\d+)?(e\d+)?$/.test(at) || !/^[0-9a-f-]{36}$/.test(id)) return null;
	return { at, id };
}

// The releases a page is about, with whether each is the object's own. An
// artist's are the releases it is credited on plus every release carrying a
// recording it is credited on — a remix on someone else's EP, a track on a
// compilation — which read as `appearance`.
function releaseSet(kind: CatalogKind): string | null {
	if (kind === 'artist')
		return `select e.dst as id, true as own from curator.catalog_edge e where e.src = $1 and e.kind = 'artist-release'
			union all
			select rr.src as id, false as own from curator.catalog_edge ra
			join curator.catalog_edge rr on rr.dst = ra.src and rr.kind = 'release-recording'
			where ra.dst = $1 and ra.kind = 'recording-artist'`;
	if (kind === 'label') return `select e.src as id, true as own from curator.catalog_edge e where e.dst = $1 and e.kind = 'release-label'`;
	if (kind === 'release') return `select $1::uuid as id, true as own`;
	return null;
}

const list = (ids: string[]) => `{${ids.join(',')}}`;

type TrackSqlRow = { release_id: string; id: string; name: string; pos: unknown; duration_sec: unknown; attrs: string; isrc: string | null; artists: string | null; deezer_only: boolean | null; genres: string | null; handles: string | null };

function trackOf(r: TrackSqlRow): CatalogPageTrack & { attrDisc: number | null } {
	const attrs = JSON.parse(r.attrs) as Record<string, unknown>;
	const artists = r.artists
		? r.artists.split('\u001e').map((p) => {
				const [id, name, role] = p.split('\u001f');
				return { id: id!, name: name ?? '', role: role || null };
			})
		: [];
	return {
		id: r.id,
		title: r.name,
		position: numOrNull(r.pos),
		disc: null,
		attrDisc: typeof attrs.discNumber === 'number' && Number.isFinite(attrs.discNumber) ? attrs.discNumber : null,
		durationSec: numOrNull(r.duration_sec),
		isrc: r.isrc,
		...recordingFacts(attrs, r.genres),
		artists,
		handles: handlesOf(r.handles),
	};
}

// A tracklist in playing order. The edge's position is the release's own
// truth; a recording's disc number is a fact of whichever release stated it,
// so it is believed only where this release's positions repeat — the mark of
// several discs each numbered from 1.
function ordered(rows: (CatalogPageTrack & { attrDisc: number | null })[]): CatalogPageTrack[] {
	const seen = new Set<number>();
	const multiDisc = rows.some((t) => t.position !== null && (seen.has(t.position) || !seen.add(t.position)));
	const out = rows.map(({ attrDisc, ...t }) => ({ ...t, disc: multiDisc ? (attrDisc ?? 1) : null }));
	return out.sort((a, b) => (a.disc ?? 0) - (b.disc ?? 0) || (a.position ?? Infinity) - (b.position ?? Infinity) || a.title.localeCompare(b.title));
}

// `shortCredits` collects the page's releases listing a track only Deezer
// credited (credits.ts), read in the tracks' own statement: the caller queues
// them for the stores that credit in full.
export async function pageTracks(tx: Queryable, id: string, opts: { cursor?: string; limit?: number; budget?: number; shortCredits?: string[] } = {}): Promise<CatalogTracksResult | null> {
	const live = await follow(tx, id);
	const [o] = await tx.query<{ id: string; kind: CatalogKind; name: string }>(`select id, kind, name from curator.catalog_object where id = $1`, [live]);
	if (!o) return null;
	const set = releaseSet(o.kind);
	const base = { object: { id: o.id, kind: o.kind, name: o.name }, redirectedFrom: live === id ? null : id };
	if (!set) return { ...base, releases: [], nextCursor: null };

	const limit = Math.max(opts.limit ?? CATALOG_TRACKS_PAGE, 1);
	const cursor = decodeCursor(opts.cursor);
	// The entity's releases, read FROM ITS EDGES and then each by primary key.
	// The lateral subquery with `offset 0` pins that order: as a plain join
	// the planner is free to walk every release in the catalogue and probe
	// the edges per release, which it does whenever it underestimates the
	// releases (no statistics on a never-analysed PGlite catalogue) — 5 s for
	// an artist at 2,000 releases, and quadratic from there (measured
	// 2026-11-18). The kind / merged test sits OUTSIDE the fence for the same
	// reason: inside it, the planner may fetch by the kind index and filter
	// on the id. The fence costs nothing when the estimates are right.
	const rel = `(select s.id, o.release_at, s.own
		from (select u.id, bool_or(u.own) as own from (${set}) u group by u.id) s
		cross join lateral (
			select x.release_at, x.kind, x.merged_into from curator.catalog_object x where x.id = s.id offset 0
		) o
		where o.kind = 'release' and o.merged_into is null) r`;
	// One more than the page: whether anything follows, without a count.
	const page = await tx.query<{ id: string; at: string; own: boolean; tracks: unknown }>(
		`select r.id, ${SORT_KEY}::text as at, r.own,
			(select count(*) from curator.catalog_edge e where e.src = r.id and e.kind = 'release-recording') as tracks
		from ${rel}
		where $2::text is null or (${SORT_KEY}, r.id) < ($2::numeric, $3::uuid)
		order by ${SORT_KEY} desc, r.id desc
		limit ${limit + 1}`,
		[o.id, cursor?.at ?? null, cursor?.id ?? null],
	);
	// Cut the page where its tracklists pass the budget (a label of
	// compilations), but never below one release.
	let take = 0;
	for (let budget = opts.budget ?? CATALOG_TRACKS_BUDGET; take < Math.min(page.length, limit); take++) {
		budget -= num(page[take]!.tracks);
		if (budget < 0 && take > 0) break;
	}
	const rows = page.slice(0, take);
	const last = rows[rows.length - 1];
	const nextCursor = last && page.length > take ? encodeCursor({ at: last.at, id: last.id }) : null;
	const releaseCount = cursor ? undefined : num((await tx.query<{ n: unknown }>(`select count(*) as n from ${rel}`, [o.id]))[0]!.n);
	if (!rows.length) return { ...base, releases: [], nextCursor: null, ...(releaseCount !== undefined ? { releaseCount } : {}) };

	const ids = rows.map((r) => r.id);
	const details = await tx.query<{ id: string; name: string; date: string | null; release_type: string | null; label_text: string | null; cover: string | null; artists: string | null; labels: string | null; genres: string | null; handles: string | null }>(
		`select r.id, r.name, to_char(r.release_at, 'YYYY-MM-DD') as date, r.release_type, r.label_text, r.attrs->>'coverUrl' as cover,
			(select ${REF_AGG('a', 'e.position')} from curator.catalog_edge e join curator.catalog_object a on a.id = e.src where e.dst = r.id and e.kind = 'artist-release') as artists,
			(select ${REF_AGG('l', 'l.name')} from curator.catalog_edge e join curator.catalog_object l on l.id = e.dst where e.src = r.id and e.kind = 'release-label') as labels,
			(select string_agg(g.name, '|' order by g.name) from curator.catalog_edge e join curator.catalog_object g on g.id = e.dst where e.src = r.id and e.kind = 'object-genre') as genres,
			${HANDLE_AGG('r.id')} as handles
		from curator.catalog_object r where r.id = any($1::uuid[])`,
		[list(ids)],
	);
	// An appearance lists only the artist's own recordings on it.
	const appearances = rows.filter((r) => !r.own).map((r) => r.id);
	const trackRows = await tx.query<TrackSqlRow>(
		`select rr.src as release_id, o.id, o.name, rr.position as pos, o.duration_sec, o.attrs::text as attrs,
			(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc,
			(select string_agg(a.id || chr(31) || a.name || chr(31) || coalesce(e.role, ''), chr(30) order by e.position)
				from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = o.id and e.kind = 'recording-artist') as artists,
			${deezerOnlySql('o.id')} as deezer_only,
			${RECORDING_GENRES_SQL},
			${HANDLE_AGG('o.id')} as handles
		from curator.catalog_edge rr join curator.catalog_object o on o.id = rr.dst and o.merged_into is null
		where rr.kind = 'release-recording' and rr.src = any($1::uuid[])
			and (rr.src <> all($2::uuid[]) or exists (
				select 1 from curator.catalog_edge ra where ra.src = o.id and ra.kind = 'recording-artist' and ra.dst = $3::uuid))`,
		[list(ids), list(appearances), o.id],
	);
	const tracksOf = new Map<string, (CatalogPageTrack & { attrDisc: number | null })[]>();
	for (const t of trackRows) {
		const l = tracksOf.get(t.release_id) ?? [];
		l.push(trackOf(t));
		tracksOf.set(t.release_id, l);
		if (t.deezer_only === true && opts.shortCredits && !opts.shortCredits.includes(t.release_id)) opts.shortCredits.push(t.release_id);
	}
	const detailOf = new Map(details.map((d) => [d.id, d]));
	const releases: CatalogPageRelease[] = rows.map((r) => {
		const d = detailOf.get(r.id)!;
		return {
			id: r.id,
			title: d.name,
			date: d.date,
			type: d.release_type,
			coverUrl: d.cover,
			labelText: d.label_text,
			labels: refs(d.labels),
			artists: refs(d.artists),
			genres: d.genres ? d.genres.split('|') : [],
			handles: handlesOf(d.handles),
			trackCount: num(r.tracks),
			appearance: !r.own,
			tracks: ordered(tracksOf.get(r.id) ?? []),
		};
	});
	return { ...base, releases, nextCursor, ...(releaseCount !== undefined ? { releaseCount } : {}) };
}
