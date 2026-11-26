// Catalogue events: the semantic stream devices feed their Discover from.
//
// An event is raised by a tracker only (sweep.ts), in its own short
// transaction after the ingest that found the child committed, and only when
//   - the child is a release whose date (or, without one, the moment the
//     catalogue first saw it) falls within the tracker's window — a first
//     poll of a newly watched artist must not announce their back catalogue;
//   - no event exists for it yet: one per release, ever. A second tracker
//     reaching the same release adds itself as a subject.
// An event's card is a copy of the release as it stood; refreshEvents
// keeps it current (and its subjects with it) by moving the event to a
// fresh seq whenever the card would read differently, for as long as
// devices still hold it.
// `recordings_new` counts the release's recordings the catalogue first saw
// with it; 0 makes the event a reissue (a compilation of known tracks).
//
// The fan-out is a read-time join: an event is stored once and every watcher
// of any of its subjects reads it. A device pages with `afterSeq`, and the
// page stops short of the last minute's events, because identity seqs are
// handed out at insert and a younger, still-open transaction could commit a
// lower one after this read; every event-writing transaction is a few
// statements, far inside that minute.

import {
	CATALOG_RECENT_DAYS,
	FEED_EVENTS_MAX,
	type CatalogEvent,
	type CatalogEventCardV1,
	type CatalogEventCardV2,
	type CatalogEventKind,
	type CatalogEventTrackCardV1,
	type CatalogEventTrackCardV2,
	type CatalogEventTrackContainerV1,
	type CatalogHandle,
	type CatalogKind,
	type CatalogProvider,
} from '@curator/protocol';
import type { Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { WEAK_SQL } from './identity.js';

export const EVENT_SETTLE_SEC = 60;
// How far ahead of today a release date may be and still announce (a label
// channel's premiere ahead of release day).
const MAX_AHEAD_DAYS = 60;

type HandleRow = { object_id: string; provider: string; provider_id: string; url: string | null };

async function handlesOf(tx: Queryable, ids: string[]): Promise<Map<string, CatalogHandle[]>> {
	const out = new Map<string, CatalogHandle[]>();
	if (!ids.length) return out;
	const rows = await tx.query<HandleRow>(
		`select object_id, provider, provider_id, url from curator.catalog_source_object where object_id = any($1::uuid[]) order by provider`,
		[`{${ids.join(',')}}`],
	);
	for (const r of rows) {
		const list = out.get(r.object_id) ?? [];
		list.push({ provider: r.provider as CatalogProvider, id: r.provider_id, url: r.url });
		out.set(r.object_id, list);
	}
	return out;
}

// A recording's canonical genre names (its object-genre edges), '|'-joined
// in one scalar subquery per row: the card's per-track genres.
export const RECORDING_GENRES_SQL = `(select string_agg(g.name, '|' order by g.name) from curator.catalog_edge ge join curator.catalog_object g on g.id = ge.dst
	where ge.src = o.id and ge.kind = 'object-genre') as genres`;

const splitNames = (v: string | null): string[] => (v ? v.split('|') : []);

// A release tied to several labels (its store's own label page, and the name
// another store writes for it — a sister imprint, a parent) shows the one a
// store holds a page for: an order term, 0 for such a label and 1 for a name
// alone. Always the same answer for the same rows, or a rebuilt card would
// differ from the stored one for no reason (refreshEvents).
const LABEL_FIRST = (id: string): string =>
	`(case when exists (select 1 from curator.catalog_source_object s where s.object_id = ${id} and not ${WEAK_SQL}) then 0 else 1 end)`;

// The DJ facts folded onto a recording (fold.ts: Beatport first).
export function recordingFacts(attrs: Record<string, unknown>, genres: string | null): { bpm: number | null; key: string | null; genres: string[] } {
	return {
		bpm: typeof attrs.bpm === 'number' && Number.isFinite(attrs.bpm) ? attrs.bpm : null,
		key: typeof attrs.key === 'string' && attrs.key.trim() ? attrs.key : null,
		genres: splitNames(genres),
	};
}

// The card a device renders without calling back: the release as the
// catalogue knows it at the moment the event is raised. Several at a time, at
// the cost of one.
export async function releaseCard(tx: Queryable, releaseId: string): Promise<CatalogEventCardV2> {
	return (await releaseCards(tx, [releaseId])).get(releaseId)!;
}

export async function releaseCards(tx: Queryable, releaseIds: readonly string[]): Promise<Map<string, CatalogEventCardV2>> {
	const out = new Map<string, CatalogEventCardV2>();
	if (!releaseIds.length) return out;
	const ids = [`{${releaseIds.join(',')}}`];
	const byRelease = <T extends { release: string }>(rows: T[]): Map<string, T[]> => {
		const m = new Map<string, T[]>();
		for (const r of rows) {
			const list = m.get(r.release);
			if (list) list.push(r);
			else m.set(r.release, [r]);
		}
		return m;
	};
	const rels = await tx.query<{ id: string; name: string; attrs: string; release_type: string | null; label_text: string | null; upc: string | null }>(
		`select o.id, o.name, o.attrs::text as attrs, o.release_type, o.label_text,
			(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'upc' limit 1) as upc
		from curator.catalog_object o where o.id = any($1::uuid[])`,
		ids,
	);
	const artistRows = await tx.query<{ release: string; id: string; name: string }>(
		`select e.dst as release, o.id, o.name from curator.catalog_edge e join curator.catalog_object o on o.id = e.src
		where e.dst = any($1::uuid[]) and e.kind = 'artist-release' order by e.position nulls last, o.name`,
		ids,
	);
	const labelRows = await tx.query<{ release: string; id: string; name: string }>(
		`select distinct on (e.src) e.src as release, o.id, o.name from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst
		where e.src = any($1::uuid[]) and e.kind = 'release-label' order by e.src, ${LABEL_FIRST('o.id')}, e.at, e.id`,
		ids,
	);
	const trackRows = await tx.query<{ release: string; id: string; name: string; attrs: string; duration_sec: unknown; isrc: string | null; artists: string | null; genres: string | null }>(
		`select e.src as release, o.id, o.name, o.attrs::text as attrs, o.duration_sec,
			(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc,
			${RECORDING_GENRES_SQL},
			(select string_agg(a.name, '|' order by ra.position) from curator.catalog_edge ra join curator.catalog_object a on a.id = ra.dst
				where ra.src = o.id and ra.kind = 'recording-artist') as artists
		from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst
		where e.src = any($1::uuid[]) and e.kind = 'release-recording' order by e.position nulls last`,
		ids,
	);
	const genreRows = await tx.query<{ release: string; name: string }>(
		`select e.src as release, o.name from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst where e.src = any($1::uuid[]) and e.kind = 'object-genre' order by o.name`,
		ids,
	);
	const handles = await handlesOf(tx, [...new Set([...releaseIds, ...artistRows.map((a) => a.id), ...trackRows.map((t) => t.id)])]);
	const artistsOf = byRelease(artistRows);
	const labelOf = byRelease(labelRows);
	const tracksOf = byRelease(trackRows);
	const genresOf = byRelease(genreRows);
	for (const rel of rels) {
		const attrs = JSON.parse(rel.attrs) as Record<string, unknown>;
		const artists = artistsOf.get(rel.id) ?? [];
		const label = labelOf.get(rel.id)?.[0];
		out.set(rel.id, {
			// CATALOG_EVENT_CARD_VERSION: bump with the shape.
			version: 2,
			kind: 'release',
			title: rel.name,
			artists: artists.map((a) => ({ id: a.id, name: a.name, handles: handles.get(a.id) ?? [] })),
			label: label ? { id: label.id, name: label.name } : rel.label_text ? { id: null, name: rel.label_text } : null,
			coverUrl: typeof attrs.coverUrl === 'string' ? attrs.coverUrl : null,
			releaseType: rel.release_type,
			releaseDate: typeof attrs.releaseDate === 'string' ? attrs.releaseDate : null,
			tracks: (tracksOf.get(rel.id) ?? []).map((t) => ({
				id: t.id,
				title: t.name,
				artists: t.artists ? t.artists.split('|') : artists.map((a) => a.name),
				isrc: t.isrc,
				durationSec: numOrNull(t.duration_sec),
				handles: handles.get(t.id) ?? [],
				...recordingFacts(JSON.parse(t.attrs) as Record<string, unknown>, t.genres),
			})),
			handles: handles.get(rel.id) ?? [],
			genres: (genresOf.get(rel.id) ?? []).map((g) => g.name),
			catalogNumber: typeof attrs.catalogNumber === 'string' && attrs.catalogNumber.trim() ? attrs.catalogNumber : null,
			upc: rel.upc,
		});
	}
	return out;
}

// The watchable objects each release concerns: its artists and label (the
// object whose tracker found it is added by the caller).
async function subjectsOf(tx: Queryable, releaseIds: readonly string[]): Promise<Map<string, string[]>> {
	const rows = await tx.query<{ release: string; id: string }>(
		`select e.dst as release, e.src as id from curator.catalog_edge e where e.dst = any($1::uuid[]) and e.kind = 'artist-release'
		union select e.src, e.dst from curator.catalog_edge e where e.src = any($1::uuid[]) and e.kind = 'release-label'`,
		[`{${releaseIds.join(',')}}`],
	);
	const out = new Map<string, string[]>();
	for (const r of rows) out.set(r.release, [...(out.get(r.release) ?? []), r.id]);
	return out;
}

async function providersOf(tx: Queryable, objectIds: readonly string[]): Promise<Map<string, string[]>> {
	const rows = await tx.query<{ id: string; provider: string }>(`select object_id as id, provider from curator.catalog_source_object where object_id = any($1::uuid[])`, [`{${objectIds.join(',')}}`]);
	const out = new Map<string, string[]>();
	for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), r.provider]);
	return out;
}

// How many providers vouch for the release, as 0..1: one streaming provider
// alone is likely right, a channel upload alone less so.
function confidenceOf(providers: string[]): number {
	const distinct = new Set(providers);
	if (distinct.size >= 3) return 0.97;
	if (distinct.size === 2) return 0.9;
	return distinct.has('youtube') ? 0.55 : 0.75;
}

export type ReleaseFind = { releaseId: string; trackedId: string; publishedAt: number | null };

// Raises the event for a release a tracker found, if it is due one; returns
// its seq, or null when it is too old, too far ahead, or already announced.
// `by`: who reported the poll the event comes from (the cloud's holder, or
// `device:<id>`), kept on the event as `raised_by`.
export type RaiseOpts = { nowMs: number; by?: string };

export async function raiseReleaseEvent(tx: Queryable, find: ReleaseFind, opts: RaiseOpts & { windowDays: number }): Promise<number | null> {
	return (await raiseReleaseEvents(tx, [{ ...find, windowDays: opts.windowDays }], opts))[0]!;
}

// The same for everything a batch of polls found, at the cost of about one:
// a listing is mostly releases too old or announced already, and every one
// asked for by itself made the raising the longest part of a poll. A release
// found twice is raised by its first find, and concerns both trackers' objects.
export async function raiseReleaseEvents(tx: Queryable, finds: readonly (ReleaseFind & { windowDays: number })[], opts: RaiseOpts): Promise<(number | null)[]> {
	const out: (number | null)[] = finds.map(() => null);
	if (!finds.length) return out;
	const day = 86400_000;
	const rels = new Map(
		(
			await tx.query<{ id: string; release_at_ms: unknown; discovered_at_ms: unknown; seq: unknown; card: string | null }>(
				`select o.id, extract(epoch from o.release_at) * 1000 as release_at_ms, extract(epoch from o.discovered_at) * 1000 as discovered_at_ms, ev.seq, ev.card::text as card
				from curator.catalog_object o left join curator.catalog_event ev on ev.dedupe_key = 'release:' || o.id::text
				where o.id = any($1::uuid[]) and o.kind = 'release'`,
				[`{${[...new Set(finds.map((f) => f.releaseId))].join(',')}}`],
			)
		).map((r) => [r.id, r]),
	);
	type Due = { at: number; releaseId: string; releaseAt: number | null; publishedAt: number | null; tracked: Set<string>; seq: number | null; card: string | null };
	const due = new Map<string, Due>();
	for (const [i, f] of finds.entries()) {
		const rel = rels.get(f.releaseId);
		if (!rel) continue;
		const releaseAt = numOrNull(rel.release_at_ms);
		const when = releaseAt ?? f.publishedAt ?? num(rel.discovered_at_ms);
		if (when < opts.nowMs - f.windowDays * day || when > opts.nowMs + MAX_AHEAD_DAYS * day) continue;
		const d = due.get(f.releaseId);
		if (d) d.tracked.add(f.trackedId);
		else due.set(f.releaseId, { at: i, releaseId: f.releaseId, releaseAt, publishedAt: f.publishedAt, tracked: new Set([f.trackedId]), seq: numOrNull(rel.seq), card: rel.card });
	}
	if (!due.size) return out;
	const ids = [...due.keys()];
	const related = await subjectsOf(tx, ids);
	const providers = await providersOf(tx, ids);
	const cards = await releaseCards(tx, ids);
	const subjectsFor = (d: Due): string[] => [...new Set([...d.tracked, ...(related.get(d.releaseId) ?? [])])];

	// Announced already: the tracker's object joins the event's subjects. Its
	// watchers have read past the event, so one that gained a subject is
	// marked to be sent again (refreshEvents); what the poll changed on the
	// card is marked by the writes themselves.
	const announced = [...due.values()].filter((d) => d.seq !== null);
	if (announced.length) {
		const gained = new Set(await insertSubjects(tx, announced.flatMap((d) => subjectsFor(d).map((id) => ({ seq: d.seq!, id })))));
		await markCards(tx, announced.filter((d) => gained.has(d.seq!)).map((d) => d.releaseId), { force: true });
	}

	const fresh = [...due.values()].filter((d) => d.seq === null);
	if (!fresh.length) return out;
	const counts = new Map(
		(
			await tx.query<{ id: string; total: unknown; fresh: unknown }>(
				`select e.src as id, count(*) as total,
					count(*) filter (where o.discovered_at >= r.discovered_at - interval '1 minute') as fresh
				from curator.catalog_edge e
				join curator.catalog_object o on o.id = e.dst
				join curator.catalog_object r on r.id = e.src
				where e.src = any($1::uuid[]) and e.kind = 'release-recording'
				group by e.src`,
				[`{${fresh.map((d) => d.releaseId).join(',')}}`],
			)
		).map((c) => [c.id, { total: num(c.total), fresh: num(c.fresh) }]),
	);
	const rows = fresh.map((d, ord) => {
		const n = counts.get(d.releaseId) ?? { total: 0, fresh: 0 };
		const kind: CatalogEventKind = n.total > 0 && n.fresh === 0 ? 'reissue' : 'new_release';
		return { ord, kind, id: d.releaseId, key: `release:${d.releaseId}`, release_at: d.releaseAt, published: d.publishedAt, fresh: n.fresh, confidence: confidenceOf(providers.get(d.releaseId) ?? []), card: cards.get(d.releaseId) };
	});
	// One a concurrent tracker raised since the read above is not returned.
	const inserted = await tx.query<{ seq: unknown; subject_id: string }>(
		`insert into curator.catalog_event (kind, subject_id, dedupe_key, release_at, source_published_at, recordings_new, confidence, card, raised_by)
		select x.kind, x.id, x.key, to_timestamp(x.release_at / 1000), to_timestamp(x.published / 1000), x.fresh, x.confidence, x.card, $2
		from jsonb_to_recordset($1::text::jsonb) as x(ord int, kind text, id uuid, key text, release_at float8, published float8, fresh int, confidence real, card jsonb)
		order by x.ord
		on conflict (dedupe_key) do nothing
		returning seq, subject_id`,
		[JSON.stringify(rows), opts.by ?? null],
	);
	const seqs = new Map(inserted.map((r) => [r.subject_id, num(r.seq)]));
	await insertSubjects(tx, fresh.flatMap((d) => (seqs.has(d.releaseId) ? subjectsFor(d).map((id) => ({ seq: seqs.get(d.releaseId)!, id })) : [])));
	for (const d of fresh) out[d.at] = seqs.get(d.releaseId) ?? null;
	return out;
}

type StoredCard = CatalogEventCardV1 | CatalogEventCardV2 | CatalogEventTrackCardV1 | CatalogEventTrackCardV2;

// How long after its release an event's card is kept current: devices drop an
// untouched feed item after 30 days, and past this nobody is waiting on it.
export const CARD_REBUILD_DAYS = 60;

// Objects whose cards may have changed, for refreshEvents. The catalogue's
// tables mark themselves (sql/0037: any write to an object, its store ids,
// its identifiers or its relationships); this is for the one change no table
// shows, an event that gained a subject where it stands (`force`).
export async function markCards(tx: Queryable, objectIds: readonly string[], opts: { force?: boolean } = {}): Promise<void> {
	if (!objectIds.length) return;
	await tx.query(`insert into curator.catalog_card_dirty (object_id, force) select unnest($1::uuid[]), $2::boolean`, [`{${[...new Set(objectIds)].join(',')}}`, opts.force === true ? 'true' : 'false']);
}

// Everything a card states, with the order of its unordered lists (store
// ids, genres) and of its keys taken out: a stored card comes back from
// jsonb in jsonb's key order, a built one in the builder's.
function canon(v: unknown, key?: string): unknown {
	if (Array.isArray(v)) {
		const items = v.map((x) => canon(x));
		return key === 'handles' || key === 'genres' ? items.map((x) => JSON.stringify(x)).sort() : items;
	}
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(o)
				.filter((k) => o[k] !== undefined)
				.sort()
				.map((k) => [k, canon(o[k], k)]),
		);
	}
	return v;
}
const cardKey = (c: unknown): string => JSON.stringify(canon(c));

// The events about these objects brought up to date: each one whose card
// would read differently today, or whose release concerns an artist or label
// it did not when announced, moves to a fresh seq with the card rebuilt and
// the subjects it had plus the ones it gained. Devices past the old seq read
// it again and lay it on the row they hold; a watcher of a gained subject
// reads it for the first time. One rule for every writer: a tracker reaching
// an announced release through another store, the store linker and the
// resolver giving its tracks their ids, a credit fill, a merge of two
// "Modd"s, a device's own finding, a label linked afterwards.
// `touched`: object id → force (move it whatever the card says). Releases,
// and anything a card reads through: a release's recordings, artists and
// label, a recording's artists. Only events within CARD_REBUILD_DAYS of
// their release are looked at. Returns the new seqs.
export async function refreshEvents(tx: Queryable, touched: ReadonlyMap<string, boolean>): Promise<number[]> {
	if (!touched.size) return [];
	const evs = await tx.query<{ seq: unknown; subject_id: string; card: string }>(
		`select ev.seq, ev.subject_id, ev.card::text as card from curator.catalog_event ev
		where coalesce(ev.release_at, ev.source_published_at, ev.first_seen_at) > now() - make_interval(days => $2::int)
			and ev.subject_id = any(array(
				select unnest($1::uuid[])
				union select e.src from curator.catalog_edge e where e.kind = 'release-recording' and e.dst = any($1::uuid[])
				union select e.dst from curator.catalog_edge e where e.kind = 'artist-release' and e.src = any($1::uuid[])
				union select e.src from curator.catalog_edge e where e.kind = 'release-label' and e.dst = any($1::uuid[])
				union select e.src from curator.catalog_edge e where e.kind = 'recording-artist' and e.dst = any($1::uuid[])
				union select rr.src from curator.catalog_edge ra join curator.catalog_edge rr on rr.kind = 'release-recording' and rr.dst = ra.src
					where ra.kind = 'recording-artist' and ra.dst = any($1::uuid[])))
		order by ev.seq`,
		[`{${[...touched.keys()].join(',')}}`, String(CARD_REBUILD_DAYS)],
	);
	if (!evs.length) return [];
	const rows = evs.map((e) => ({ seq: num(e.seq), subjectId: e.subject_id, old: JSON.parse(e.card) as StoredCard }));
	const releaseIds = [...new Set(rows.filter((r) => r.old.kind !== 'track').map((r) => r.subjectId))];
	const cards = await releaseCards(tx, releaseIds);
	const related = releaseIds.length ? await subjectsOf(tx, releaseIds) : new Map<string, string[]>();
	const kept = new Map<number, Set<string>>();
	for (const k of await tx.query<{ seq: unknown; object_id: string }>(`select seq, object_id from curator.catalog_event_subject where seq = any($1::bigint[])`, [`{${rows.map((r) => r.seq).join(',')}}`])) {
		const set = kept.get(num(k.seq)) ?? new Set<string>();
		set.add(k.object_id);
		kept.set(num(k.seq), set);
	}
	const moved: number[] = [];
	for (const r of rows) {
		const force = touched.get(r.subjectId) === true;
		if (r.old.kind === 'track') {
			const live = await trackCard(tx, r.subjectId, r.old.container, r.old.rank, r.old.addedAt);
			if (force || cardKey(r.old) !== cardKey(live)) moved.push(await moveEvent(tx, r.seq, r.subjectId, r.old, [], undefined, live));
			continue;
		}
		const live = cards.get(r.subjectId);
		if (!live) continue;
		const subjects = related.get(r.subjectId) ?? [];
		const gained = subjects.some((s) => !kept.get(r.seq)?.has(s));
		if (force || gained || cardKey(r.old) !== cardKey(live)) moved.push(await moveEvent(tx, r.seq, r.subjectId, r.old, subjects, undefined, live));
	}
	return moved;
}

// The event rebuilt with the object's current card, at a fresh seq.
// `live`: the card when the caller built it already.
async function moveEvent(tx: Queryable, seq: number, subjectId: string, old: StoredCard, subjects: string[] = [], by?: string, live?: CatalogEventCardV2 | CatalogEventTrackCardV2): Promise<number> {
	const providers = await tx.query<{ provider: string }>(`select provider from curator.catalog_source_object where object_id = $1`, [subjectId]);
	const card = live ?? (old.kind === 'track' ? await trackCard(tx, subjectId, old.container, old.rank, old.addedAt) : await releaseCard(tx, subjectId));
	const kept = await tx.query<{ object_id: string }>(`select object_id from curator.catalog_event_subject where seq = $1::bigint`, [String(seq)]);
	const [gone] = await tx.query<{ kind: string; dedupe_key: string; release_at: unknown; source_published_at: unknown; recordings_new: unknown; confidence: unknown; raised_by: string | null }>(
		`delete from curator.catalog_event where seq = $1::bigint
		returning kind, dedupe_key, release_at::text as release_at, source_published_at::text as source_published_at, recordings_new, confidence, raised_by`,
		[String(seq)],
	);
	const [moved] = await tx.query<{ seq: unknown }>(
		`insert into curator.catalog_event (kind, subject_id, dedupe_key, release_at, source_published_at, recordings_new, confidence, card, raised_by)
		values ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::int, $7::real, $8::text::jsonb, $9)
		returning seq`,
		[
			gone!.kind,
			subjectId,
			gone!.dedupe_key,
			gone!.release_at === null ? null : String(gone!.release_at),
			gone!.source_published_at === null ? null : String(gone!.source_published_at),
			String(num(gone!.recordings_new)),
			String(old.kind === 'track' ? num(gone!.confidence) : confidenceOf(providers.map((p) => p.provider))),
			JSON.stringify(card),
			by ?? gone!.raised_by,
		],
	);
	const next = num(moved!.seq);
	await insertSubjects(tx, [...new Set([...kept.map((k) => k.object_id), ...subjects])].map((id) => ({ seq: next, id })));
	return next;
}

export type ChartEntry = { genreId: string; recordingId: string; provider: CatalogProvider; rank: number };

// Recordings on a watched genre's chart: each membership row with its best
// rank (kept for every entry the tracker sees), and, the first time the chart
// carries one, one `chart_entry` event per (genre, recording). Null where
// nothing was raised.
export async function raiseChartEntries(tx: Queryable, entries: readonly ChartEntry[], opts: RaiseOpts): Promise<(number | null)[]> {
	const out: (number | null)[] = entries.map(() => null);
	if (!entries.length) return out;
	// A recording on the chart twice (two store ids of one track): its last row
	// is its rank, its best one its best, as a row at a time would leave it.
	const rows = new Map<string, { genre_id: string; provider: string; recording_id: string; rank: number; best: number }>();
	for (const e of entries) {
		const key = `${e.genreId}|${e.provider}|${e.recordingId}`;
		rows.set(key, { genre_id: e.genreId, provider: e.provider, recording_id: e.recordingId, rank: e.rank, best: Math.min(e.rank, rows.get(key)?.best ?? e.rank) });
	}
	await tx.query(
		`insert into curator.catalog_chart_entry (genre_id, provider, recording_id, rank, best_rank)
		select x.genre_id, x.provider, x.recording_id, x.rank, x.best from jsonb_to_recordset($1::text::jsonb) as x(genre_id uuid, provider text, recording_id uuid, rank int, best int)
		order by 1, 2, 3
		on conflict (genre_id, provider, recording_id) do update set rank = excluded.rank, best_rank = least(curator.catalog_chart_entry.best_rank, excluded.best_rank), last_seen_at = now()`,
		[JSON.stringify([...rows.values()])],
	);
	const keyOf = (e: ChartEntry): string => `chart:${e.genreId}:${e.recordingId}`;
	const known = await announcedKeys(tx, entries.map(keyOf));
	for (const [i, e] of entries.entries()) {
		if (known.has(keyOf(e))) continue;
		known.add(keyOf(e));
		const card = await trackCard(tx, e.recordingId, { kind: 'chart', id: e.genreId }, e.rank, opts.nowMs);
		out[i] = await insertTrackEvent(tx, { kind: 'chart_entry', recordingId: e.recordingId, key: keyOf(e), publishedAt: opts.nowMs, card, subject: e.genreId }, opts);
	}
	return out;
}

// Which of these dedupe keys have an event already: a chart or a playlist is
// mostly tracks announced before, whose cards need not be built.
async function announcedKeys(tx: Queryable, keys: readonly string[]): Promise<Set<string>> {
	const rows = await tx.query<{ k: string }>(`select dedupe_key as k from curator.catalog_event where dedupe_key in (select jsonb_array_elements_text($1::text::jsonb))`, [JSON.stringify(keys)]);
	return new Set(rows.map((r) => r.k));
}

async function insertTrackEvent(
	tx: Queryable,
	e: { kind: 'chart_entry' | 'playlist_add'; recordingId: string; key: string; publishedAt: number | null; card: CatalogEventTrackCardV2; subject: string },
	opts: RaiseOpts,
): Promise<number | null> {
	const [ins] = await tx.query<{ seq: unknown }>(
		`insert into curator.catalog_event (kind, subject_id, dedupe_key, release_at, source_published_at, recordings_new, confidence, card, raised_by)
		values ($1, $2, $3, null, to_timestamp($4::float8 / 1000), 0, 0.9, $5::text::jsonb, $6)
		on conflict (dedupe_key) do nothing
		returning seq`,
		[e.kind, e.recordingId, e.key, e.publishedAt === null ? null : String(e.publishedAt), JSON.stringify(e.card), opts.by ?? null],
	);
	if (!ins) return null;
	const seq = num(ins.seq);
	await insertSubjects(tx, [{ seq, id: e.subject }]);
	return seq;
}

export type PlaylistAdd = { playlistId: string; recordingId: string; sourceObjectId: string | null; addedAt: number | null; position: number | null };

// Tracks added to a watched playlist: each membership row (kept for every
// addition the tracker sees) and, when recent, one `playlist_add` event per
// (playlist, recording) ever. Null where nothing was raised.
export async function raisePlaylistAdds(tx: Queryable, adds: readonly PlaylistAdd[], opts: RaiseOpts & { windowDays: number }): Promise<(number | null)[]> {
	const out: (number | null)[] = adds.map(() => null);
	if (!adds.length) return out;
	const rows = new Map<string, unknown>();
	for (const a of adds) {
		const key = `${a.playlistId}|${a.recordingId}`;
		if (!rows.has(key)) rows.set(key, { playlist_id: a.playlistId, recording_id: a.recordingId, position: a.position, added_at: a.addedAt, so: a.sourceObjectId });
	}
	await tx.query(
		`insert into curator.catalog_playlist_item (playlist_id, recording_id, position, added_at, source_object_id)
		select x.playlist_id, x.recording_id, x.position, to_timestamp(x.added_at / 1000), x.so
		from jsonb_to_recordset($1::text::jsonb) as x(playlist_id uuid, recording_id uuid, position int, added_at float8, so uuid)
		where not exists (select 1 from curator.catalog_playlist_item i where i.playlist_id = x.playlist_id and i.recording_id = x.recording_id and i.removed_at is null)`,
		[JSON.stringify([...rows.values()])],
	);
	const keyOf = (a: PlaylistAdd): string => `playlist_add:${a.playlistId}:${a.recordingId}`;
	const recent = (a: PlaylistAdd): boolean => (a.addedAt ?? opts.nowMs) >= opts.nowMs - opts.windowDays * 86400_000;
	const known = await announcedKeys(tx, adds.filter(recent).map(keyOf));
	for (const [i, a] of adds.entries()) {
		if (!recent(a) || known.has(keyOf(a))) continue;
		known.add(keyOf(a));
		const card = await trackCard(tx, a.recordingId, { kind: 'playlist', id: a.playlistId }, null, a.addedAt);
		out[i] = await insertTrackEvent(tx, { kind: 'playlist_add', recordingId: a.recordingId, key: keyOf(a), publishedAt: a.addedAt, card, subject: a.playlistId }, opts);
	}
	return out;
}

async function trackCard(
	tx: Queryable,
	recordingId: string,
	container: { kind: CatalogEventTrackContainerV1['kind']; id: string },
	rank: number | null,
	addedAt: number | null,
): Promise<CatalogEventTrackCardV2> {
	const [rec] = await tx.query<{ name: string; attrs: string; duration_sec: unknown; isrc: string | null; genres: string | null }>(
		`select o.name, o.attrs::text as attrs, o.duration_sec,
			(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc,
			${RECORDING_GENRES_SQL}
		from curator.catalog_object o where o.id = $1`,
		[recordingId],
	);
	const attrs = JSON.parse(rec!.attrs) as Record<string, unknown>;
	const artists = await tx.query<{ id: string; name: string }>(
		`select a.id, a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst
		where e.src = $1 and e.kind = 'recording-artist' order by e.position nulls last`,
		[recordingId],
	);
	const [pl] = await tx.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [container.id]);
	// The label of a release the recording sits on: the entity first, else
	// the release's bare label string.
	const [lab] = await tx.query<{ id: string | null; name: string }>(
		`select id, name from (
			select l.id, l.name, 0 as pri, ${LABEL_FIRST('l.id')} as paged from curator.catalog_edge rr
				join curator.catalog_edge rl on rl.src = rr.src and rl.kind = 'release-label'
				join curator.catalog_object l on l.id = rl.dst
			where rr.dst = $1 and rr.kind = 'release-recording'
			union all
			select null, r.label_text, 1, 1 from curator.catalog_edge rr join curator.catalog_object r on r.id = rr.src
			where rr.dst = $1 and rr.kind = 'release-recording' and r.label_text is not null
		) x order by pri, paged, name, id limit 1`,
		[recordingId],
	);
	const handles = await handlesOf(tx, [recordingId, container.id, ...artists.map((a) => a.id)]);
	const text = (k: string) => (typeof attrs[k] === 'string' ? (attrs[k] as string) : null);
	return {
		// CATALOG_EVENT_CARD_VERSION: bump with the shape.
		version: 2,
		kind: 'track',
		title: rec!.name,
		artists: artists.map((a) => ({ id: a.id, name: a.name, handles: handles.get(a.id) ?? [] })),
		isrc: rec!.isrc,
		durationSec: numOrNull(rec!.duration_sec),
		albumTitle: text('albumTitle'),
		coverUrl: text('coverUrl'),
		releaseDate: text('releaseDate'),
		handles: handles.get(recordingId) ?? [],
		container: { kind: container.kind, id: container.id, name: pl?.name ?? '', handles: handles.get(container.id) ?? [] },
		rank,
		addedAt,
		...recordingFacts(attrs, rec!.genres),
		label: lab ? { id: lab.id, name: lab.name } : null,
	};
}

// Returns the seq of each row that was not there yet.
async function insertSubjects(tx: Queryable, subjects: readonly { seq: number; id: string }[]): Promise<number[]> {
	if (!subjects.length) return [];
	const rows = await tx.query<{ seq: unknown }>(
		`insert into curator.catalog_event_subject (seq, object_id) select distinct x.seq, x.id from jsonb_to_recordset($1::text::jsonb) as x(seq bigint, id uuid) on conflict do nothing returning seq`,
		[JSON.stringify(subjects)],
	);
	return rows.map((r) => num(r.seq));
}

type EventRow = {
	seq: unknown;
	kind: CatalogEventKind;
	subject_id: string;
	release_at_ms: unknown;
	published_ms: unknown;
	first_seen_ms: unknown;
	recordings_new: unknown;
	confidence: unknown;
	card: string;
};

const EVENT_COLUMNS = `e.seq, e.kind, e.subject_id,
	extract(epoch from e.release_at) * 1000 as release_at_ms,
	extract(epoch from e.source_published_at) * 1000 as published_ms,
	extract(epoch from e.first_seen_at) * 1000 as first_seen_ms,
	e.recordings_new, e.confidence, e.card::text as card`;

async function toEvents(tx: Queryable, rows: EventRow[]): Promise<CatalogEvent[]> {
	if (!rows.length) return [];
	const subj = await tx.query<{ seq: unknown; object_id: string; kind: CatalogKind; name: string }>(
		`select s.seq, o.id as object_id, o.kind, o.name from curator.catalog_event_subject s join curator.catalog_object o on o.id = s.object_id
		where s.seq = any($1::bigint[])`,
		[`{${rows.map((r) => String(r.seq)).join(',')}}`],
	);
	const bySeq = new Map<number, CatalogEvent['subjects']>();
	for (const s of subj) {
		const list = bySeq.get(num(s.seq)) ?? [];
		list.push({ objectId: s.object_id, kind: s.kind, name: s.name });
		bySeq.set(num(s.seq), list);
	}
	return rows.map((r) => ({
		seq: num(r.seq),
		kind: r.kind,
		subjectId: r.subject_id,
		subjects: bySeq.get(num(r.seq)) ?? [],
		releaseAt: numOrNull(r.release_at_ms),
		sourcePublishedAt: numOrNull(r.published_ms),
		firstSeenAt: num(r.first_seen_ms),
		recordingsNew: num(r.recordings_new),
		confidence: num(r.confidence),
		card: JSON.parse(r.card) as CatalogEvent['card'],
	}));
}

// feed.events: the caller's watched (unmuted) objects' events after `afterSeq`.
// `nextSeq` moves past every settled event, the caller's or not, so a device
// never rescans the stream from an old cursor.
export async function eventsFor(tx: Queryable, userId: string, afterSeq: number, limit: number): Promise<{ events: CatalogEvent[]; nextSeq: number }> {
	const n = Math.min(Math.max(1, limit), FEED_EVENTS_MAX);
	const rows = await tx.query<EventRow>(
		`select ${EVENT_COLUMNS} from curator.catalog_event e
		where e.seq > $2::bigint and e.first_seen_at <= now() - make_interval(secs => $4::float8)
			and exists (
				select 1 from curator.catalog_event_subject s join curator.catalog_watch w on w.object_id = s.object_id
				where s.seq = e.seq and w.user_id = $1 and not w.muted
			)
		order by e.seq limit $3::int`,
		[userId, String(afterSeq), String(n), String(EVENT_SETTLE_SEC)],
	);
	const events = await toEvents(tx, rows);
	let nextSeq = afterSeq;
	if (events.length === n) nextSeq = events[events.length - 1]!.seq;
	else {
		const [m] = await tx.query<{ s: unknown }>(
			`select coalesce(max(seq), $1::bigint) as s from curator.catalog_event where seq > $1::bigint and first_seen_at <= now() - make_interval(secs => $2::float8)`,
			[String(afterSeq), String(EVENT_SETTLE_SEC)],
		);
		nextSeq = num(m!.s);
	}
	return { events, nextSeq };
}

// "Load more": the caller's watched (unmuted) objects' events first seen in
// the last `days`, newest first, whatever their seq.
export async function recentForUser(tx: Queryable, userId: string, days: number): Promise<CatalogEvent[]> {
	const rows = await tx.query<EventRow>(
		`select ${EVENT_COLUMNS} from curator.catalog_event e
		where e.first_seen_at >= now() - make_interval(days => $2::int)
			and exists (
				select 1 from curator.catalog_event_subject s join curator.catalog_watch w on w.object_id = s.object_id
				where s.seq = e.seq and w.user_id = $1 and not w.muted
			)
		order by e.seq desc limit $3::int`,
		[userId, String(days), String(FEED_EVENTS_MAX)],
	);
	return toEvents(tx, rows);
}

// The last month of an object's events, newest first: what a new watch shows
// at once (its cursor only sees what is raised from now on).
export async function recentFor(tx: Queryable, objectId: string): Promise<CatalogEvent[]> {
	const rows = await tx.query<EventRow>(
		`select ${EVENT_COLUMNS} from curator.catalog_event e
		join curator.catalog_event_subject s on s.seq = e.seq
		where s.object_id = $1 and e.first_seen_at >= now() - make_interval(days => $2::int)
		order by e.seq desc limit 50`,
		[objectId, String(CATALOG_RECENT_DAYS)],
	);
	return toEvents(tx, rows);
}

