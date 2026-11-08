// Catalogue events: the semantic stream devices feed their Discover from.
//
// An event is raised by a tracker only (sweep.ts), in its own short
// transaction after the ingest that found the child committed, and only when
//   - the child is a release whose date (or, without one, the moment the
//     catalogue first saw it) falls within the tracker's window — a first
//     poll of a newly watched artist must not announce their back catalogue;
//   - no event exists for it yet: one per release, ever. A second tracker
//     reaching the same release adds itself as a subject; a provider the
//     card did not have yet re-announces it (reannounceIfNewProvider).
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
const RECORDING_GENRES_SQL = `(select string_agg(g.name, '|' order by g.name) from curator.catalog_edge ge join curator.catalog_object g on g.id = ge.dst
	where ge.src = o.id and ge.kind = 'object-genre') as genres`;

const splitNames = (v: string | null): string[] => (v ? v.split('|') : []);

// The DJ facts folded onto a recording (fold.ts: Beatport first).
function recordingFacts(attrs: Record<string, unknown>, genres: string | null): { bpm: number | null; key: string | null; genres: string[] } {
	return {
		bpm: typeof attrs.bpm === 'number' && Number.isFinite(attrs.bpm) ? attrs.bpm : null,
		key: typeof attrs.key === 'string' && attrs.key.trim() ? attrs.key : null,
		genres: splitNames(genres),
	};
}

// The card a device renders without calling back: the release as the
// catalogue knows it at the moment the event is raised.
export async function releaseCard(tx: Queryable, releaseId: string): Promise<CatalogEventCardV2> {
	const [rel] = await tx.query<{ name: string; attrs: string; release_type: string | null; label_text: string | null; upc: string | null }>(
		`select o.name, o.attrs::text as attrs, o.release_type, o.label_text,
			(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'upc' limit 1) as upc
		from curator.catalog_object o where o.id = $1`,
		[releaseId],
	);
	const attrs = JSON.parse(rel!.attrs) as Record<string, unknown>;
	const artists = await tx.query<{ id: string; name: string }>(
		`select o.id, o.name from curator.catalog_edge e join curator.catalog_object o on o.id = e.src
		where e.dst = $1 and e.kind = 'artist-release' order by e.position nulls last, o.name`,
		[releaseId],
	);
	const [label] = await tx.query<{ id: string; name: string }>(
		`select o.id, o.name from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst where e.src = $1 and e.kind = 'release-label' limit 1`,
		[releaseId],
	);
	const tracks = await tx.query<{ id: string; name: string; attrs: string; duration_sec: unknown; isrc: string | null; artists: string | null; genres: string | null }>(
		`select o.id, o.name, o.attrs::text as attrs, o.duration_sec,
			(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc,
			${RECORDING_GENRES_SQL},
			(select string_agg(a.name, '|' order by ra.position) from curator.catalog_edge ra join curator.catalog_object a on a.id = ra.dst
				where ra.src = o.id and ra.kind = 'recording-artist') as artists
		from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst
		where e.src = $1 and e.kind = 'release-recording' order by e.position nulls last`,
		[releaseId],
	);
	const genres = await tx.query<{ name: string }>(
		`select o.name from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst where e.src = $1 and e.kind = 'object-genre' order by o.name`,
		[releaseId],
	);
	const handles = await handlesOf(tx, [releaseId, ...artists.map((a) => a.id), ...tracks.map((t) => t.id)]);
	return {
		// CATALOG_EVENT_CARD_VERSION: bump with the shape.
		version: 2,
		kind: 'release',
		title: rel!.name,
		artists: artists.map((a) => ({ id: a.id, name: a.name, handles: handles.get(a.id) ?? [] })),
		label: label ? { id: label.id, name: label.name } : rel!.label_text ? { id: null, name: rel!.label_text } : null,
		coverUrl: typeof attrs.coverUrl === 'string' ? attrs.coverUrl : null,
		releaseType: rel!.release_type,
		releaseDate: typeof attrs.releaseDate === 'string' ? attrs.releaseDate : null,
		tracks: tracks.map((t) => ({
			id: t.id,
			title: t.name,
			artists: t.artists ? t.artists.split('|') : artists.map((a) => a.name),
			isrc: t.isrc,
			durationSec: numOrNull(t.duration_sec),
			handles: handles.get(t.id) ?? [],
			...recordingFacts(JSON.parse(t.attrs) as Record<string, unknown>, t.genres),
		})),
		handles: handles.get(releaseId) ?? [],
		genres: genres.map((g) => g.name),
		catalogNumber: typeof attrs.catalogNumber === 'string' && attrs.catalogNumber.trim() ? attrs.catalogNumber : null,
		upc: rel!.upc,
	};
}

// The watchable objects a release concerns: its artists and label, plus the
// object whose tracker found it.
async function subjectsOf(tx: Queryable, releaseId: string, trackedId: string): Promise<string[]> {
	const rows = await tx.query<{ id: string }>(
		`select e.src as id from curator.catalog_edge e where e.dst = $1 and e.kind = 'artist-release'
		union select e.dst from curator.catalog_edge e where e.src = $1 and e.kind = 'release-label'`,
		[releaseId],
	);
	return [...new Set([trackedId, ...rows.map((r) => r.id)])];
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
	const [rel] = await tx.query<{ kind: string; release_at_ms: unknown; discovered_at_ms: unknown }>(
		`select kind, extract(epoch from release_at) * 1000 as release_at_ms, extract(epoch from discovered_at) * 1000 as discovered_at_ms
		from curator.catalog_object where id = $1`,
		[find.releaseId],
	);
	if (!rel || rel.kind !== 'release') return null;
	const releaseAt = numOrNull(rel.release_at_ms);
	const when = releaseAt ?? find.publishedAt ?? num(rel.discovered_at_ms);
	const day = 86400_000;
	if (when < opts.nowMs - opts.windowDays * day || when > opts.nowMs + MAX_AHEAD_DAYS * day) return null;

	const dedupeKey = `release:${find.releaseId}`;
	const [existing] = await tx.query<{ seq: unknown }>(`select seq from curator.catalog_event where dedupe_key = $1`, [dedupeKey]);
	const subjects = await subjectsOf(tx, find.releaseId, find.trackedId);
	if (existing) {
		await insertSubjects(tx, num(existing.seq), subjects);
		return reannounceIfNewProvider(tx, find.releaseId, num(existing.seq), subjects, opts.by);
	}
	const [counts] = await tx.query<{ total: unknown; fresh: unknown }>(
		`select count(*) as total,
			count(*) filter (where o.discovered_at >= r.discovered_at - interval '1 minute') as fresh
		from curator.catalog_edge e
		join curator.catalog_object o on o.id = e.dst
		join curator.catalog_object r on r.id = e.src
		where e.src = $1 and e.kind = 'release-recording'`,
		[find.releaseId],
	);
	const total = num(counts!.total);
	const fresh = num(counts!.fresh);
	const kind: CatalogEventKind = total > 0 && fresh === 0 ? 'reissue' : 'new_release';
	const providers = await tx.query<{ provider: string }>(`select provider from curator.catalog_source_object where object_id = $1`, [find.releaseId]);
	const card = await releaseCard(tx, find.releaseId);
	const [ins] = await tx.query<{ seq: unknown }>(
		`insert into curator.catalog_event (kind, subject_id, dedupe_key, release_at, source_published_at, recordings_new, confidence, card, raised_by)
		values ($1, $2, $3, to_timestamp($4::float8 / 1000), to_timestamp($5::float8 / 1000), $6::int, $7::real, $8::text::jsonb, $9)
		on conflict (dedupe_key) do nothing
		returning seq`,
		[
			kind,
			find.releaseId,
			dedupeKey,
			releaseAt === null ? null : String(releaseAt),
			find.publishedAt === null ? null : String(find.publishedAt),
			String(fresh),
			String(confidenceOf(providers.map((p) => p.provider))),
			JSON.stringify(card),
			opts.by ?? null,
		],
	);
	// A concurrent tracker raised it between the check and the insert.
	if (!ins) return null;
	const seq = num(ins.seq);
	await insertSubjects(tx, seq, subjects);
	return seq;
}

// A release announced through one provider and later found on another: the
// event's card is rebuilt with the new handles and the event moves to a fresh
// seq, so devices that read past it read it again. Still one event per
// release; a device that already holds the item dedupes it, and one that
// could not use the first card (Discover plays Spotify only, so a card that
// had only Deezer was dropped) now gets the release. Once per provider: the
// rebuilt card carries it.
async function reannounceIfNewProvider(tx: Queryable, releaseId: string, seq: number, subjects: string[], by?: string): Promise<number | null> {
	return reannounce(tx, seq, releaseId, subjects, by);
}

// The same for any event whose subject gained a provider its card lacks: the
// resolver (planner.ts) calls it after giving a recording or release its
// Spotify id. Returns the new seq, or null when the card already had every
// provider.
// `by`: the reporter of the poll that brought the new provider; the resolver
// passes none and the event keeps its first reporter.
export async function reannounce(tx: Queryable, seq: number, subjectId: string, subjects: string[] = [], by?: string): Promise<number | null> {
	const [ev] = await tx.query<{ kind: CatalogEventKind; card: string }>(`select kind, card::text as card from curator.catalog_event where seq = $1::bigint`, [String(seq)]);
	if (!ev) return null;
	// A stored card of any version: only the fields v1 and v2 share are read.
	const old = JSON.parse(ev.card) as CatalogEventCardV1 | CatalogEventCardV2 | CatalogEventTrackCardV1 | CatalogEventTrackCardV2;
	const announced = new Set(old.handles.map((h) => h.provider));
	const providers = await tx.query<{ provider: string }>(`select provider from curator.catalog_source_object where object_id = $1`, [subjectId]);
	if (providers.every((p) => announced.has(p.provider as CatalogProvider))) return null;
	const card = old.kind === 'track' ? await trackCard(tx, subjectId, old.container, old.rank, old.addedAt) : await releaseCard(tx, subjectId);
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
	await insertSubjects(tx, next, [...new Set([...kept.map((k) => k.object_id), ...subjects])]);
	return next;
}

// Every event about this object (a release's, or a recording's playlist and
// chart events) re-announced if its card lacks a provider the object now has.
export async function reannounceFor(tx: Queryable, subjectId: string): Promise<number> {
	const rows = await tx.query<{ seq: unknown }>(`select seq from curator.catalog_event where subject_id = $1 order by seq`, [subjectId]);
	let n = 0;
	for (const r of rows) if ((await reannounce(tx, num(r.seq), subjectId)) !== null) n++;
	return n;
}

export type ChartEntry = { genreId: string; recordingId: string; provider: CatalogProvider; rank: number };

// A recording on a watched genre's chart: the membership row with its best
// rank (kept for every entry the tracker sees), and, the first time the
// chart carries it, one `chart_entry` event per (genre, recording).
export async function raiseChartEntry(tx: Queryable, entry: ChartEntry, opts: RaiseOpts): Promise<number | null> {
	await tx.query(
		`insert into curator.catalog_chart_entry (genre_id, provider, recording_id, rank, best_rank)
		values ($1, $2, $3, $4::int, $4::int)
		on conflict (genre_id, provider, recording_id) do update set rank = excluded.rank, best_rank = least(curator.catalog_chart_entry.best_rank, excluded.rank), last_seen_at = now()`,
		[entry.genreId, entry.provider, entry.recordingId, String(entry.rank)],
	);
	const card = await trackCard(tx, entry.recordingId, { kind: 'chart', id: entry.genreId }, entry.rank, opts.nowMs);
	const [ins] = await tx.query<{ seq: unknown }>(
		`insert into curator.catalog_event (kind, subject_id, dedupe_key, release_at, source_published_at, recordings_new, confidence, card, raised_by)
		values ('chart_entry', $1, $2, null, to_timestamp($3::float8 / 1000), 0, 0.9, $4::text::jsonb, $5)
		on conflict (dedupe_key) do nothing
		returning seq`,
		[entry.recordingId, `chart:${entry.genreId}:${entry.recordingId}`, String(opts.nowMs), JSON.stringify(card), opts.by ?? null],
	);
	if (!ins) return null;
	const seq = num(ins.seq);
	await insertSubjects(tx, seq, [entry.genreId]);
	return seq;
}

export type PlaylistAdd ={ playlistId: string; recordingId: string; sourceObjectId: string | null; addedAt: number | null; position: number | null };

// A track added to a watched playlist: its membership row (kept for every
// addition the tracker sees) and, when recent, one `playlist_add` event per
// (playlist, recording) ever.
export async function raisePlaylistAdd(tx: Queryable, add: PlaylistAdd, opts: RaiseOpts & { windowDays: number }): Promise<number | null> {
	await tx.query(
		`insert into curator.catalog_playlist_item (playlist_id, recording_id, position, added_at, source_object_id)
		select $1, $2, $3::int, to_timestamp($4::float8 / 1000), $5
		where not exists (select 1 from curator.catalog_playlist_item where playlist_id = $1 and recording_id = $2 and removed_at is null)`,
		[add.playlistId, add.recordingId, add.position === null ? null : String(add.position), add.addedAt === null ? null : String(add.addedAt), add.sourceObjectId],
	);
	const when = add.addedAt ?? opts.nowMs;
	if (when < opts.nowMs - opts.windowDays * 86400_000) return null;
	const card = await trackCard(tx, add.recordingId, { kind: 'playlist', id: add.playlistId }, null, add.addedAt);
	const [ins] = await tx.query<{ seq: unknown }>(
		`insert into curator.catalog_event (kind, subject_id, dedupe_key, release_at, source_published_at, recordings_new, confidence, card, raised_by)
		values ('playlist_add', $1, $2, null, to_timestamp($3::float8 / 1000), 0, 0.9, $4::text::jsonb, $5)
		on conflict (dedupe_key) do nothing
		returning seq`,
		[add.recordingId, `playlist_add:${add.playlistId}:${add.recordingId}`, add.addedAt === null ? null : String(add.addedAt), JSON.stringify(card), opts.by ?? null],
	);
	if (!ins) return null;
	const seq = num(ins.seq);
	await insertSubjects(tx, seq, [add.playlistId]);
	return seq;
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
			select l.id, l.name, 0 as pri from curator.catalog_edge rr
				join curator.catalog_edge rl on rl.src = rr.src and rl.kind = 'release-label'
				join curator.catalog_object l on l.id = rl.dst
			where rr.dst = $1 and rr.kind = 'release-recording'
			union all
			select null, r.label_text, 1 from curator.catalog_edge rr join curator.catalog_object r on r.id = rr.src
			where rr.dst = $1 and rr.kind = 'release-recording' and r.label_text is not null
		) x order by pri limit 1`,
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

async function insertSubjects(tx: Queryable, seq: number, objectIds: string[]): Promise<void> {
	for (const id of objectIds) {
		await tx.query(`insert into curator.catalog_event_subject (seq, object_id) values ($1::bigint, $2) on conflict do nothing`, [String(seq), id]);
	}
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

