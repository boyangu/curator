// DJ sets taken out of the catalogue (`catalog repair dj-sets`). A DJ set —
// one long mixed session, a podcast, a live recording — is not a release and
// the catalogue does not map it (2026-11-19); SoundCloud's reader took them
// in as releases and tracks until it learned the difference (isDjSet,
// catalog-readers soundcloud.ts), and they then stood beside the store
// releases as doubtful twins.
//
// What goes: a recording of 45 minutes or more that only SoundCloud holds,
// and a release left holding nothing but such recordings that only
// SoundCloud holds. A release with other tracks only loses the set from its
// tracklist. What stays: a long recording any other store holds (a
// compilation's continuous mix on Apple or Spotify is that store's track —
// counted in the report, not touched), and anything someone watches.
//
// This is the catalogue's one removal: every other correction is a merge or
// an unlink, both undoable. Nothing here is — the rows are deleted, with an
// event the release raised — so the report names each object with its
// SoundCloud page, and the run is logged to the inbox with them. A device
// that already holds such a card keeps it; no event is served again.

import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx, type SystemTx } from '../db/system-tx.js';
import { raise } from './inbox.js';

export const DJ_SET_MIN_SEC = 45 * 60;

export type DjSetGone = { id: string; kind: 'recording' | 'release'; name: string; minutes: number | null; pages: string[] };
export type DjSetReport = {
	dry: boolean;
	recordings: number;
	releases: number;
	// Releases that keep other tracks and lost the set from their tracklist.
	trimmed: { release: string; id: string; set: string }[];
	events: number;
	gone: DjSetGone[];
	// Not removed: watched, or held by another store too.
	watched: string[];
	elsewhere: { count: number; sample: string[] };
	more: boolean;
};

type Candidate = { id: string; name: string; duration_sec: unknown; watch_count: unknown; pages: string | null };

// Long recordings no store but SoundCloud holds.
async function candidates(tx: Queryable, limit: number): Promise<Candidate[]> {
	return tx.query<Candidate>(
		`select o.id, o.name, o.duration_sec, o.watch_count,
			(select string_agg(coalesce(so.url, so.provider || ':' || so.provider_id), ' ') from curator.catalog_source_object so where so.object_id = o.id) as pages
		from curator.catalog_object o
		where o.kind = 'recording' and o.merged_into is null and o.duration_sec >= $1::real
			and exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = 'soundcloud')
			and not exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider <> 'soundcloud')
		order by o.name limit $2::int`,
		[String(DJ_SET_MIN_SEC), String(limit)],
	);
}

// One object out of every table that names it, then the object, with the
// objects folded into it. A table this misses fails the delete on its
// foreign key and the transaction with it: nothing is half removed.
async function removeObject(tx: SystemTx, id: string): Promise<number> {
	const folded = await tx.query<{ id: string }>(`select id from curator.catalog_object where merged_into = $1`, [id]);
	for (const f of folded) await removeObject(tx, f.id);
	const events = await tx.query(`delete from curator.catalog_event where subject_id = $1 returning 1`, [id]);
	for (const sql of [
		`delete from curator.catalog_event_subject where object_id = $1`,
		`delete from curator.catalog_edge where src = $1 or dst = $1`,
		`delete from curator.catalog_playlist_item where playlist_id = $1 or recording_id = $1`,
		`delete from curator.catalog_chart_entry where recording_id = $1 or genre_id = $1`,
		`delete from curator.catalog_identifier where object_id = $1`,
		`delete from curator.catalog_fact where object_id = $1`,
		`delete from curator.catalog_signal where object_id = $1`,
		`delete from curator.catalog_audio where recording_id = $1`,
		`delete from curator.catalog_not_same where object_a = $1 or object_b = $1`,
		`delete from curator.catalog_enrich_task where object_id = $1`,
		`delete from curator.catalog_cursor where object_id = $1`,
		`delete from curator.catalog_review where object_id = $1`,
		`delete from curator.catalog_insight where object_id = $1`,
		`delete from curator.catalog_connect_vote where object_id = $1`,
		`delete from curator.catalog_page_check where object_id = $1`,
		`delete from curator.catalog_work_state where object_id = $1`,
		`delete from curator.catalog_work_followup where release_id = $1`,
		`delete from curator.catalog_source_object where object_id = $1`,
		`delete from curator.catalog_object where id = $1`,
	])
		await tx.query(sql, [id]);
	return events.length;
}

export async function removeDjSets(db: Db, opts: { dry?: boolean; limit?: number; by?: string } = {}): Promise<DjSetReport> {
	const limit = Math.min(opts.limit ?? 500, 2000);
	const found = await withSystemTx(db, (tx) => candidates(tx, limit + 1));
	const elsewhere = `from curator.catalog_object o where o.kind = 'recording' and o.merged_into is null and o.duration_sec >= $1::real
		and exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider <> 'soundcloud')`;
	const [e] = await db.query<{ n: unknown }>(`select count(*) as n ${elsewhere}`, [String(DJ_SET_MIN_SEC)]);
	const sample = await db.query<{ name: string }>(`select o.name ${elsewhere} order by o.duration_sec desc limit 8`, [String(DJ_SET_MIN_SEC)]);
	const report: DjSetReport = { dry: !!opts.dry, recordings: 0, releases: 0, trimmed: [], events: 0, gone: [], watched: [], elsewhere: { count: num(e!.n), sample: sample.map((x) => x.name) }, more: found.length > limit };
	const rollback = new Error('dry run');
	// A transaction a set: PGlite holds one lock per transaction, and the back
	// office's reads wait behind it.
	for (const c of found.slice(0, limit)) {
		if (num(c.watch_count) > 0) {
			report.watched.push(c.name);
			continue;
		}
		try {
			await withSystemTx(db, async (tx) => {
				const [live] = await tx.query(`select 1 from curator.catalog_object where id = $1 and merged_into is null`, [c.id]);
				if (!live) return;
				const releases = await tx.query<{ id: string; name: string; watch_count: unknown; pages: string | null; others: unknown; stores: unknown }>(
					`select r.id, r.name, r.watch_count,
						(select string_agg(coalesce(so.url, so.provider || ':' || so.provider_id), ' ') from curator.catalog_source_object so where so.object_id = r.id) as pages,
						(select count(*) from curator.catalog_edge t join curator.catalog_object x on x.id = t.dst and x.merged_into is null
							where t.src = r.id and t.kind = 'release-recording' and t.dst <> $1
								and not (x.duration_sec >= $2::real and not exists (select 1 from curator.catalog_source_object so where so.object_id = x.id and so.provider <> 'soundcloud'))) as others,
						(select count(*) from curator.catalog_source_object so where so.object_id = r.id and so.provider <> 'soundcloud') as stores
					from curator.catalog_edge e join curator.catalog_object r on r.id = e.src and r.kind = 'release' and r.merged_into is null
					where e.kind = 'release-recording' and e.dst = $1`,
					[c.id, String(DJ_SET_MIN_SEC)],
				);
				const gone: DjSetGone[] = [];
				const trimmed: DjSetReport['trimmed'] = [];
				let events = 0;
				for (const r of releases) {
					// A release of nothing but sets, SoundCloud's alone and unwatched, goes with them.
					if (num(r.others) === 0 && num(r.stores) === 0 && num(r.watch_count) === 0) {
						events += await removeObject(tx, r.id);
						gone.push({ id: r.id, kind: 'release', name: r.name, minutes: null, pages: r.pages?.split(' ') ?? [] });
					} else trimmed.push({ release: r.name, id: r.id, set: c.name });
				}
				events += await removeObject(tx, c.id);
				gone.push({ id: c.id, kind: 'recording', name: c.name, minutes: Math.round(num(c.duration_sec) / 60), pages: c.pages?.split(' ') ?? [] });
				// A dry run rolls each set back, so a release of two sets comes up twice.
				report.gone.push(...gone.filter((g) => !report.gone.some((x) => x.id === g.id)));
				report.trimmed.push(...trimmed);
				report.events += events;
				report.recordings++;
				report.releases = report.gone.filter((g) => g.kind === 'release').length;
				if (opts.dry) throw rollback;
			});
		} catch (err) {
			if (err !== rollback) throw err;
		}
	}
	if (!opts.dry && report.gone.length) {
		await withSystemTx(db, (tx) =>
			raise(tx, {
				kind: 'repair.dj_sets',
				severity: 'audit',
				title: `Removed ${report.recordings} DJ set(s) and ${report.releases} release(s) of nothing else: not releases, not mapped`,
				subjects: report.trimmed.map((t) => t.id).slice(0, 50),
				evidence: { gone: report.gone.slice(0, 500), trimmed: report.trimmed.slice(0, 100), events: report.events },
				actor: opts.by ?? 'claude-code',
			}),
		);
	}
	return report;
}
