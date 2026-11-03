// What went wrong on its own, put to the operator (inbox.ts) by the worker's
// pass. Nothing here acts: each detector raises a proposal (approval, with
// the apply the inbox would run) or an observation (notice), and the clearing
// pass closes items whose condition is gone.
//
//   release.twins    an import or backfill minted a release the label already
//                    held under the same title with a shared artist — two
//                    stores' copies the title rule did not join (2026-10-29:
//                    37 on the first Beatport import). Proposes the merges.
//   page.dead        a label page its tracker cannot read any more (a 404, a
//                    SoundCloud handle with no id): proposes the unlink.
//   page.mismatch    a label page whose releases share nothing — no release,
//                    no artist — with the label's other pages, both sides
//                    sizeable: a namesake's page. Proposes the unlink.
//   artist.twins     one artist held twice under one name on a release
//                    (artist-twins.ts, over artists minted lately): merged
//                    outright — the one thing this pass does itself — unless
//                    one store holds both under two ids, then proposed.
//   tracker.failing  a tracker failing run after run for another reason.
//   provider.parked  a provider the pass keeps parking (a challenge, a rate
//                    limit) for a day or more.

import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { artistTwins } from './artist-twins.js';
import { clearInbox, listInbox, raise, type InboxRow } from './inbox.js';

const TWINS_WINDOW_DAYS = 2;
const TWINS_DATE_GAP_DAYS = 14;
const LABELS_PER_PASS = 200;
const FAILING_RUNS = 5;
const MISMATCH_MIN_EACH = 10;
// An unresolved slug is not a dead page: the SoundCloud tracker resolves it
// through the API and says "not found (404)" only when the profile is gone.
const DEAD_ERROR = /\b404\b|not found|does not exist|gone\b|no such user/i;

type Log = { info: (m: string, f?: Record<string, unknown>) => void; warn?: (m: string, f?: Record<string, unknown>) => void };
export type DetectorDeps = { db: Db; log?: Log };
export type DetectorReport = { twins: number; artists: number; pages: number; trackers: number; cleared: number };

export async function runInboxDetectors(deps: DetectorDeps): Promise<DetectorReport> {
	const report: DetectorReport = { twins: 0, artists: 0, pages: 0, trackers: 0, cleared: 0 };
	report.cleared = await withSystemTx(deps.db, (tx) => clearGone(tx));
	report.twins = await withSystemTx(deps.db, (tx) => detectTwins(tx));
	const a = await artistTwins(deps.db, { by: 'worker', recentDays: TWINS_WINDOW_DAYS, mergeLimit: 50, proposeLimit: 5 });
	report.artists = a.merged.reduce((n, m) => n + m.folds.length, 0) + a.proposed.filter((x) => x.item !== null).length;
	const p = await detectPages(deps.db);
	report.pages = p.pages;
	report.trackers = p.trackers;
	report.trackers += await withSystemTx(deps.db, (tx) => detectParked(tx));
	if (report.twins || report.artists || report.pages || report.trackers || report.cleared) deps.log?.info('inbox_detectors_pass', { ...report });
	return report;
}

// ── twins ─────────────────────────────────────────────────────────────────────────────────

type TwinRelease = { id: string; title: string; artists: string[]; date: string | null; providers: string[]; tracks: number; discoveredMs: number };

async function detectTwins(tx: Queryable): Promise<number> {
	const labels = await tx.query<{ id: string; name: string }>(
		`select distinct l.id, l.name from curator.catalog_edge e
			join curator.catalog_object r on r.id = e.src and r.kind = 'release' and r.merged_into is null
			join curator.catalog_object l on l.id = e.dst and l.merged_into is null
		where e.kind = 'release-label' and r.discovered_at > now() - make_interval(days => $1::int)
		order by l.name limit $2::int`,
		[String(TWINS_WINDOW_DAYS), String(LABELS_PER_PASS)],
	);
	let raised = 0;
	for (const l of labels) {
		const rows = await tx.query<{ id: string; title: string; artists: string | null; date: string | null; providers: string | null; tracks: unknown; discovered_ms: unknown }>(
			`select r.id, r.name as title, to_char(r.release_at, 'YYYY-MM-DD') as date, extract(epoch from r.discovered_at) * 1000 as discovered_ms,
				(select string_agg(a.name, '|' order by ar.position) from curator.catalog_edge ar join curator.catalog_object a on a.id = ar.src where ar.dst = r.id and ar.kind = 'artist-release') as artists,
				(select string_agg(distinct so.provider, '|') from curator.catalog_source_object so where so.object_id = r.id) as providers,
				(select count(*) from curator.catalog_edge t where t.src = r.id and t.kind = 'release-recording') as tracks
			from curator.catalog_object r
			where r.kind = 'release' and r.merged_into is null
				and exists (select 1 from curator.catalog_edge e where e.kind = 'release-label' and e.src = r.id and e.dst = $1)
				and r.name_fold in (
					select r2.name_fold from curator.catalog_object r2 join curator.catalog_edge e2 on e2.src = r2.id and e2.kind = 'release-label' and e2.dst = $1
					where r2.kind = 'release' and r2.merged_into is null group by r2.name_fold having count(*) > 1)`,
			[l.id],
		);
		if (rows.length < 2) continue;
		const releases: TwinRelease[] = rows.map((r) => ({ id: r.id, title: r.title, artists: r.artists ? r.artists.split('|') : [], date: r.date, providers: r.providers ? r.providers.split('|') : [], tracks: num(r.tracks), discoveredMs: num(r.discovered_ms) }));
		const apart = await tx.query<{ a: string; b: string }>(`select object_a as a, object_b as b from curator.catalog_not_same where object_a = any($1::uuid[]) and object_b = any($1::uuid[])`, [`{${releases.map((r) => r.id).join(',')}}`]);
		const ruled = new Set(apart.map((p) => `${p.a}|${p.b}`));
		// Pairs already proposed and still open are not proposed again.
		const open = await listInbox(tx, { status: 'open', kind: 'release.twins', subject: l.id, limit: 50 });
		const proposed = new Set(open.rows.flatMap((i) => ((i.evidence.pairs as { keep: { id: string }; fold: { id: string } }[] | undefined) ?? []).flatMap((p) => [p.keep.id, p.fold.id])));
		const groups = twinGroups(releases.filter((r) => !proposed.has(r.id)), ruled);
		if (!groups.length) continue;
		const pairs = groups.flatMap((g) => g.folds.map((f) => ({ keep: view(g.keep), fold: view(f) })));
		const id = await raise(tx, {
			kind: 'release.twins',
			severity: 'approval',
			title: `${pairs.length} twin release(s) on «${l.name}»: the same title and artist held twice`,
			subjects: [l.id],
			evidence: { pairs },
			apply: { op: 'mergeReleases', args: { pairs: pairs.map((p) => ({ keep: p.keep.id, fold: p.fold.id })) } },
			actor: 'worker',
			key: pairs.map((p) => p.fold.id).sort().join(','),
		});
		if (id !== null) raised++;
	}
	return raised;
}

const view = (r: TwinRelease) => ({ id: r.id, title: r.title, artists: r.artists, date: r.date, providers: r.providers, tracks: r.tracks });

// Same folded title, a shared folded artist, dates within the gap (or one
// unknown): one group per such cluster, the best-kept copy as its keep.
export function twinGroups(releases: TwinRelease[], ruled: Set<string>): { keep: TwinRelease; folds: TwinRelease[] }[] {
	const byTitle = new Map<string, TwinRelease[]>();
	for (const r of releases) (byTitle.get(nameFold(r.title)) ?? byTitle.set(nameFold(r.title), []).get(nameFold(r.title))!).push(r);
	const out: { keep: TwinRelease; folds: TwinRelease[] }[] = [];
	for (const group of byTitle.values()) {
		if (group.length < 2) continue;
		// Union-find over pairs that qualify.
		const parent = new Map(group.map((r) => [r.id, r.id]));
		const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
		for (let i = 0; i < group.length; i++) {
			for (let j = i + 1; j < group.length; j++) {
				const a = group[i]!;
				const b = group[j]!;
				const [x, y] = [a.id, b.id].sort();
				if (ruled.has(`${x}|${y}`)) continue;
				const shared = a.artists.some((n) => b.artists.map(nameFold).includes(nameFold(n)));
				if (!shared) continue;
				if (a.date && b.date && Math.abs(Date.parse(a.date) - Date.parse(b.date)) > TWINS_DATE_GAP_DAYS * 86400_000) continue;
				parent.set(find(a.id), find(b.id));
			}
		}
		const clusters = new Map<string, TwinRelease[]>();
		for (const r of group) (clusters.get(find(r.id)) ?? clusters.set(find(r.id), []).get(find(r.id))!).push(r);
		for (const c of clusters.values()) {
			if (c.length < 2) continue;
			const sorted = [...c].sort((a, b) => b.providers.length - a.providers.length || b.tracks - a.tracks || a.discoveredMs - b.discoveredMs);
			out.push({ keep: sorted[0]!, folds: sorted.slice(1) });
		}
	}
	return out;
}

// ── pages and trackers ────────────────────────────────────────────────────────────────────

// A transaction per page checked, not one for them all: the local catalogue's
// PGlite holds one lock per transaction, and the back office's reads wait
// behind it (200 pages' overlap in one took the page down for a minute).
async function detectPages(db: Db): Promise<{ pages: number; trackers: number }> {
	const failingRaised = await withSystemTx(db, (tx) => detectFailing(tx));
	let pages = 0;
	// A namesake's page: its releases share nothing with the label's others.
	const candidates = await withSystemTx(db, (tx) =>
		tx.query<{ label: string; name: string; provider: string; provider_id: string; url: string | null }>(
			`select l.id as label, l.name, so.provider, so.provider_id, so.url
			from curator.catalog_object l join curator.catalog_source_object so on so.object_id = l.id and so.kind = 'label' and so.provider not in ('user', 'musicbrainz', 'discogs', 'instagram', 'website', 'youtube', 'traxsource')
			where l.kind = 'label' and l.merged_into is null
				and exists (select 1 from curator.catalog_edge e join curator.catalog_object r on r.id = e.src where e.kind = 'release-label' and e.dst = l.id and r.discovered_at > now() - make_interval(days => $1::int))
				and (select count(*) from curator.catalog_source_object s2 where s2.object_id = l.id and s2.kind = 'label' and s2.provider = so.provider) = 1
			limit $2::int`,
			[String(TWINS_WINDOW_DAYS), String(LABELS_PER_PASS)],
		),
	);
	for (const c of candidates) {
		const raised = await withSystemTx(db, async (tx) => {
			const m = await pageOverlap(tx, c.label, c.provider);
			if (m.onlyHere < MISMATCH_MIN_EACH || m.onlyElsewhere < MISMATCH_MIN_EACH || m.sharedTitles > 0 || m.sharedArtists > 0) return false;
			const id = await raise(tx, {
				kind: 'page.mismatch',
				severity: 'approval',
				title: `${c.provider}:${c.provider_id} on «${c.name}» lists ${m.onlyHere} releases sharing no title or artist with the label's other ${m.onlyElsewhere}`,
				subjects: [c.label],
				evidence: { provider: c.provider, providerId: c.provider_id, url: c.url, onlyHere: m.onlyHere, onlyElsewhere: m.onlyElsewhere, sampleHere: m.sampleHere, sampleElsewhere: m.sampleElsewhere },
				apply: { op: 'unlinkPage', args: { objectId: c.label, page: { provider: c.provider, id: c.provider_id, url: c.url }, note: 'namesake page: shares nothing with the label' } },
				actor: 'worker',
				key: `${c.provider}:${c.provider_id}`,
			});
			return id !== null;
		});
		if (raised) pages++;
	}
	return { pages: pages + failingRaised.pages, trackers: failingRaised.trackers };
}

async function detectFailing(tx: Queryable): Promise<{ pages: number; trackers: number }> {
	let pages = 0;
	let trackers = 0;
	const failing = await tx.query<{ object_id: string; name: string; provider: string; fail_count: unknown; last_error: string | null; last_run_ms: unknown; handles: string | null }>(
		`select c.object_id, o.name, c.provider, c.fail_count, c.last_error, extract(epoch from c.last_run_at) * 1000 as last_run_ms,
			(select string_agg(so.provider_id || E'\\t' || coalesce(so.url, ''), E'\\n') from curator.catalog_source_object so where so.object_id = c.object_id and so.provider = c.provider and so.kind = o.kind) as handles
		from curator.catalog_cursor c join curator.catalog_object o on o.id = c.object_id and o.merged_into is null
		where c.fail_count >= $1::int`,
		[String(FAILING_RUNS)],
	);
	for (const f of failing) {
		const handles = (f.handles ?? '').split('\n').filter(Boolean).map((h) => ({ id: h.split('\t')[0]!, url: h.split('\t')[1] || null }));
		const dead = DEAD_ERROR.test(f.last_error ?? '') && handles.length === 1;
		const evidence = { provider: f.provider, failCount: num(f.fail_count), lastError: f.last_error, lastRunAt: num(f.last_run_ms), handles };
		const id = dead
			? await raise(tx, {
					kind: 'page.dead',
					severity: 'approval',
					title: `${f.provider}:${handles[0]!.id} on «${f.name}» cannot be read (${num(f.fail_count)}× — ${(f.last_error ?? '').slice(0, 80)})`,
					subjects: [f.object_id],
					evidence,
					apply: { op: 'unlinkPage', args: { objectId: f.object_id, page: { provider: f.provider, id: handles[0]!.id, url: handles[0]!.url }, note: `dead page: ${f.last_error ?? ''}`.slice(0, 200) } },
					actor: 'worker',
					key: `${f.provider}:${handles[0]!.id}`,
				})
			: await raise(tx, {
					kind: 'tracker.failing',
					severity: 'notice',
					title: `Tracker ${f.provider} failing ${num(f.fail_count)}× on «${f.name}»: ${(f.last_error ?? '').slice(0, 100)}`,
					subjects: [f.object_id],
					evidence,
					actor: 'worker',
					key: f.provider,
				});
		if (id !== null) dead ? pages++ : trackers++;
	}
	return { pages, trackers };
}

// What a label's page lists against what its other pages list, by name, not
// by object: a page whose releases never joined the others (Bandcamp's
// "Artist - Title [Label]", label-scoped credits) is the twins problem, not a
// namesake. A release counts as shared when any of its title forms meets one
// on the other side; an artist when its folded name does.
export function titleKeys(title: string): string[] {
	const noLabel = title.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
	const dash = noLabel.indexOf(' - ');
	const keys = [title, noLabel, ...(dash > 0 ? [noLabel.slice(dash + 3)] : [])].map(nameFold).filter((k) => k.length >= 3);
	return [...new Set(keys)];
}
const artistKeys = (names: string[]): string[] => names.flatMap((n) => n.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)).map(nameFold).filter((k) => k.length >= 2);

export async function pageOverlap(tx: Queryable, labelId: string, provider: string): Promise<{ onlyHere: number; onlyElsewhere: number; sharedTitles: number; sharedArtists: number; sampleHere: string; sampleElsewhere: string }> {
	const rows = await tx.query<{ name: string; at_p: boolean; elsewhere: boolean; artists: string | null }>(
		`select r.name,
			exists (select 1 from curator.catalog_source_object so where so.object_id = r.id and so.provider = $2) as at_p,
			exists (select 1 from curator.catalog_source_object so where so.object_id = r.id and so.provider <> $2 and so.provider <> 'user') as elsewhere,
			(select string_agg(a.name, '|') from curator.catalog_edge ar join curator.catalog_object a on a.id = ar.src where ar.dst = r.id and ar.kind = 'artist-release') as artists
		from curator.catalog_object r join curator.catalog_edge e on e.src = r.id and e.kind = 'release-label' and e.dst = $1
		where r.kind = 'release' and r.merged_into is null`,
		[labelId, provider],
	);
	const here = rows.filter((r) => r.at_p && !r.elsewhere);
	const there = rows.filter((r) => r.elsewhere && !r.at_p);
	const titlesThere = new Set(there.flatMap((r) => titleKeys(r.name)));
	const artistsThere = new Set(there.flatMap((r) => artistKeys(r.artists ? r.artists.split('|') : [])));
	// Bandcamp titles carry the artist ("Dnl Mike - My Heart"): the part before the dash is a credit too.
	const creditsHere = (r: { name: string; artists: string | null }) => [...(r.artists ? r.artists.split('|') : []), ...(r.name.includes(' - ') ? [r.name.slice(0, r.name.indexOf(' - '))] : [])];
	return {
		onlyHere: here.length,
		onlyElsewhere: there.length,
		sharedTitles: rows.filter((r) => r.at_p && r.elsewhere).length + here.filter((r) => titleKeys(r.name).some((k) => titlesThere.has(k))).length,
		sharedArtists: new Set(here.flatMap((r) => artistKeys(creditsHere(r))).filter((k) => artistsThere.has(k))).size,
		sampleHere: here.slice(0, 5).map((r) => r.name).join(' | '),
		sampleElsewhere: there.slice(0, 5).map((r) => r.name).join(' | '),
	};
}

// Parks live in the pass; what they leave behind is the error on every task
// and tracker they parked.
async function detectParked(tx: Queryable): Promise<number> {
	const rows = await tx.query<{ provider: string; n: unknown; sample: string }>(
		`select provider, count(*) as n, min(last_error) as sample from (
			select substring(last_error from 'parked: ([a-z]+)') as provider, last_error from curator.catalog_enrich_task where last_error like '%parked: %' and next_due_at > now()
			union all
			select substring(last_error from 'parked: ([a-z]+)') as provider, last_error from curator.catalog_cursor where last_error like '%parked: %' and next_due_at > now()
		) p where provider is not null group by provider`,
	);
	let raised = 0;
	for (const r of rows) {
		const id = await raise(tx, {
			kind: 'provider.parked',
			severity: 'notice',
			title: `${r.provider} is parked: ${num(r.n)} task(s) and tracker(s) waiting (${r.sample.slice(0, 80)})`,
			subjects: [],
			evidence: { provider: r.provider, waiting: num(r.n), sample: r.sample },
			actor: 'worker',
			key: `${r.provider}:${new Date().toISOString().slice(0, 10)}`,
		});
		if (id !== null) raised++;
	}
	return raised;
}

// ── clearing ──────────────────────────────────────────────────────────────────────────────

async function clearGone(tx: Queryable): Promise<number> {
	let cleared = 0;
	const open = await listInbox(tx, { status: 'all', limit: 500 });
	for (const i of open.rows.filter((r) => r.status === 'open')) {
		const why = await gone(tx, i);
		if (!why) continue;
		await clearInbox(tx, i.id, why);
		cleared++;
	}
	return cleared;
}

async function gone(tx: Queryable, i: InboxRow): Promise<string | null> {
	// A held action on an object that was merged away since is moot.
	if (i.apply && i.subjects.length) {
		const live = await tx.query(`select 1 from curator.catalog_object where id = any($1::uuid[]) and merged_into is null`, [`{${i.subjects.join(',')}}`]);
		if (live.length < i.subjects.length) return 'a subject was merged away';
	}
	switch (i.kind) {
		case 'release.twins':
		case 'artist.twins': {
			const pairs = (i.evidence.pairs as { keep: { id: string }; fold: { id: string } }[] | undefined) ?? [];
			const ids = pairs.flatMap((p) => [p.keep.id, p.fold.id]);
			if (!ids.length) return 'no pairs';
			const still = await tx.query(
				`select 1 from curator.catalog_object a join curator.catalog_object b on true
				where a.id = any($1::uuid[]) and b.id = any($1::uuid[]) and a.id < b.id and a.merged_into is null and b.merged_into is null
					and not exists (select 1 from curator.catalog_not_same n where n.object_a = a.id and n.object_b = b.id) limit 1`,
				[`{${ids.join(',')}}`],
			);
			return still.length ? null : 'the twins were merged or ruled apart';
		}
		case 'page.dead':
		case 'tracker.failing': {
			const provider = i.evidence.provider as string;
			const [c] = await tx.query<{ fail_count: unknown }>(`select fail_count from curator.catalog_cursor where object_id = $1 and provider = $2`, [i.subjects[0]!, provider]);
			if (!c) return 'the tracker is gone';
			return num(c.fail_count) === 0 ? 'the tracker recovered' : null;
		}
		case 'page.mismatch': {
			const rows = await tx.query(`select 1 from curator.catalog_source_object where object_id = $1 and provider = $2 and provider_id = $3`, [i.subjects[0]!, i.evidence.provider as string, i.evidence.providerId as string]);
			if (!rows.length) return 'the page is gone';
			// Its releases joined the others since (twins merged), or the check
			// now sees what they share.
			const m = await pageOverlap(tx, i.subjects[0]!, i.evidence.provider as string);
			return m.sharedTitles > 0 || m.sharedArtists > 0 ? 'the page shares titles or artists with the label after all' : null;
		}
		case 'provider.parked': {
			const rows = await tx.query(
				`select 1 from curator.catalog_enrich_task where last_error like $1 and next_due_at > now()
				union all select 1 from curator.catalog_cursor where last_error like $1 and next_due_at > now() limit 1`,
				[`%parked: ${i.evidence.provider as string}%`],
			);
			return rows.length ? null : 'nothing is parked any more';
		}
		default:
			return null;
	}
}
