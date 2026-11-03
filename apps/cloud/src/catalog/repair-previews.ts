// What SoundCloud's album reader got wrong before 2026-10-28, undone
// (`catalog repair previews`):
//   - a preview track's `duration` (access "preview": the thirty-second
//     preview's length) was kept as the track's, so the recording stood at
//     0:30 and no store's copy could join it (lengths 5 s apart for a key
//     match, 10 s for an ISRC one);
//   - a track whose title names nobody was credited to the account, which on
//     a label's profile is the label's own name ("Maeve").
// Each such recording loses the preview length and the label-named credit,
// then joins the one store copy it is (same title, on a release of the same
// label, a real length; a Spotify or Deezer copy, then one on a release named
// like the track, preferred — exactly one best or nothing), taking its ISRC
// and SoundCloud representation along. A logged merge, undoable like any.

import type { Db, Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { mergeObjects } from './admin.js';
import { addEdge } from './ingest.js';

export type PreviewRepairReport = {
	dry: boolean;
	recordings: number;
	lengthsCleared: number;
	creditsDropped: number;
	merged: { title: string; from: string; into: string; intoRelease: string }[];
	unmatched: { title: string; id: string; why: string }[];
};

const PREVIEW_SEC = 30;

type Held = { id: string; name: string; name_fold: string };

// The recordings SoundCloud gave a preview's length, optionally of one label.
async function previewRecordings(tx: Queryable, labelId: string | null): Promise<Held[]> {
	return tx.query<Held>(
		`select distinct o.id, o.name, o.name_fold from curator.catalog_object o
		join curator.catalog_fact f on f.object_id = o.id and f.field = 'durationSec' and f.source = 'soundcloud'
		where o.kind = 'recording' and o.merged_into is null and abs((f.value #>> '{}')::float8 - ${PREVIEW_SEC}) < 0.5
			and ($1::uuid is null or exists (
				select 1 from curator.catalog_edge rr join curator.catalog_edge rl on rl.src = rr.src and rl.kind = 'release-label' and rl.dst = $1::uuid
				where rr.dst = o.id and rr.kind = 'release-recording'))
		order by o.name`,
		[labelId],
	);
}

// The preview length off the recording: its fact, and the column and folded
// attribute where they came from it (another source's length, if any, takes
// their place).
async function clearPreviewLength(tx: Queryable, id: string): Promise<void> {
	await tx.query(`delete from curator.catalog_fact where object_id = $1 and field = 'durationSec' and source = 'soundcloud'`, [id]);
	const [other] = await tx.query<{ value: unknown }>(`select (value #>> '{}')::float8 as value from curator.catalog_fact where object_id = $1 and field = 'durationSec' order by at limit 1`, [id]);
	const len = other ? numOrNull(other.value) : null;
	await tx.query(
		`update curator.catalog_object set duration_sec = $2::float8,
			attrs = case when $2::float8 is null then (attrs - 'durationSec') #- '{_src,durationSec}' else jsonb_set(attrs, '{durationSec}', to_jsonb($2::float8)) end,
			updated_at = now()
		where id = $1`,
		[id, len === null ? null : String(len)],
	);
}

// Credits on the recording (and on the SoundCloud releases holding it) to an
// artist named exactly like a label the recording's releases are on.
async function dropLabelCredits(tx: Queryable, id: string): Promise<number> {
	const labelFolds = `(select l.name_fold from curator.catalog_edge rr join curator.catalog_edge rl on rl.src = rr.src and rl.kind = 'release-label'
		join curator.catalog_object l on l.id = rl.dst where rr.dst = $1 and rr.kind = 'release-recording')`;
	const onRecording = await tx.query(
		`delete from curator.catalog_edge e using curator.catalog_object a
		where e.src = $1 and e.kind = 'recording-artist' and a.id = e.dst and a.name_fold in ${labelFolds} returning 1`,
		[id],
	);
	const onReleases = await tx.query(
		`delete from curator.catalog_edge e using curator.catalog_object a, curator.catalog_edge rr
		where rr.dst = $1 and rr.kind = 'release-recording' and e.dst = rr.src and e.kind = 'artist-release' and a.id = e.src and a.name_fold in ${labelFolds}
			and exists (select 1 from curator.catalog_source_object so where so.object_id = rr.src and so.provider = 'soundcloud') returning 1`,
		[id],
	);
	return onRecording.length + onReleases.length;
}

// The store copy this recording is: same title, a real length, on a release
// of a label the recording's releases are on, no other ISRC.
async function twinOf(tx: Queryable, r: Held): Promise<{ id: string; release: string } | { why: string }> {
	const rows = await tx.query<{ id: string; release: string; score: unknown }>(
		`with mine as (select rl.dst as label from curator.catalog_edge rr join curator.catalog_edge rl on rl.src = rr.src and rl.kind = 'release-label' where rr.dst = $1 and rr.kind = 'release-recording'),
			my_isrc as (select value from curator.catalog_identifier where object_id = $1 and namespace = 'isrc')
		select t.id, (array_agg(rel.name order by (rel.name_fold = $2) desc, rel.name))[1] as release,
			max((case when exists (select 1 from curator.catalog_source_object so where so.object_id = t.id and so.provider in ('spotify', 'deezer')) then 2 else 0 end)
				+ (case when rel.name_fold = $2 then 1 else 0 end)) as score
		from curator.catalog_object t
		join curator.catalog_edge rr on rr.dst = t.id and rr.kind = 'release-recording'
		join curator.catalog_object rel on rel.id = rr.src
		join curator.catalog_edge rl on rl.src = rel.id and rl.kind = 'release-label' and rl.dst in (select label from mine)
		where t.kind = 'recording' and t.merged_into is null and t.id <> $1 and t.name_fold = $2
			and t.duration_sec is not null and abs(t.duration_sec - ${PREVIEW_SEC}) >= 0.5
			and not exists (select 1 from curator.catalog_identifier i where i.object_id = t.id and i.namespace = 'isrc' and i.value not in (select value from my_isrc))
			and not exists (select 1 from curator.catalog_not_same n where n.object_a = least(t.id, $1::uuid) and n.object_b = greatest(t.id, $1::uuid))
		group by t.id order by score desc, t.id`,
		[r.id, r.name_fold],
	);
	if (!rows.length) return { why: 'no store copy on the label' };
	if (rows.length > 1 && num(rows[0]!.score) === num(rows[1]!.score)) return { why: `${rows.length} copies, none preferred` };
	return { id: rows[0]!.id, release: rows[0]!.release };
}

// The SoundCloud releases holding a recording this repair merged (now or on
// an earlier run: the merge log says), credited with every artist of their
// tracks — once all are merged, so a various-artists set names them all.
// Rerunnable: an artist already credited is kept.
async function recreditRepairedReleases(tx: Queryable): Promise<void> {
	const rels = await tx.query<{ release: string; rep: string }>(
		`select distinct rr.src as release, so.id as rep
		from curator.catalog_merge_log m
		join curator.catalog_edge rr on rr.dst = m.into_id and rr.kind = 'release-recording'
		join curator.catalog_source_object so on so.object_id = rr.src and so.provider = 'soundcloud' and so.kind = 'release'
		where m.evidence->>'repair' = 'soundcloud-previews'`,
	);
	for (const r of rels) {
		const artists = await tx.query<{ id: string }>(
			`select ra.dst as id from curator.catalog_edge rr join curator.catalog_edge ra on ra.src = rr.dst and ra.kind = 'recording-artist'
			where rr.src = $1 and rr.kind = 'release-recording' group by ra.dst order by min(rr.position), ra.dst`,
			[r.release],
		);
		for (const [i, a] of artists.entries()) await addEdge(tx, a.id, 'artist-release', r.release, r.rep, 'main', i);
	}
}

export async function repairPreviews(db: Db, opts: { labelId?: string | null; dry?: boolean; by?: string } = {}): Promise<PreviewRepairReport> {
	const report: PreviewRepairReport = { dry: !!opts.dry, recordings: 0, lengthsCleared: 0, creditsDropped: 0, merged: [], unmatched: [] };
	const rollback = new Error('dry run');
	try {
		await withSystemTx(db, async (tx) => {
			const held = await previewRecordings(tx, opts.labelId ?? null);
			report.recordings = held.length;
			for (const r of held) {
				await clearPreviewLength(tx, r.id);
				report.lengthsCleared++;
				report.creditsDropped += await dropLabelCredits(tx, r.id);
				const twin = await twinOf(tx, r);
				if ('why' in twin) {
					report.unmatched.push({ title: r.name, id: r.id, why: twin.why });
					continue;
				}
				await mergeObjects(tx, r.id, twin.id, opts.by ?? 'claude-code', 'SoundCloud preview copy of a store recording (title, label, ISRC)', { repair: 'soundcloud-previews' });
				report.merged.push({ title: r.name, from: r.id, into: twin.id, intoRelease: twin.release });
			}
			await recreditRepairedReleases(tx);
			if (opts.dry) throw rollback;
		});
	} catch (e) {
		if (e !== rollback) throw e;
	}
	return report;
}
