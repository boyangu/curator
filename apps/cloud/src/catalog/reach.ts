// Reach: how big an artist's audience is, as one open-ended number.
//
//   Reach = 10 · log10(audience)        1,000 → 30 · 100,000 → 50 · 1M → 60 · 100M → 80
//
// Every +10 is ten times the audience and nothing caps it (Guy, 2026-11-19:
// "a score, a rank, essentially limitless", the Klout of twenty years ago).
// A score alone, in the end: the catalogue holds a sliver of all artists,
// so a place among them would say little.
//
// `audience` is in Spotify-monthly-listener equivalents. Each store counts
// something else — Deezer fans, Tidal and SoundCloud followers, YouTube
// subscribers, Last.fm's all-time listeners — and ten thousand of one is not
// ten thousand of another. So each is calibrated onto Spotify's listeners
// over the artists that have both (a straight line in log-log space, refitted
// every pass), and the artist's audience is the weighted mean of what its
// sources say, in logs: a geometric mean, so one big number does not drown
// the rest. An artist Spotify does not know still gets a score in the same
// unit.
//
// A reading the artist's other sources contradict by more than 30× is left
// out (and kept in `parts`, marked): a store page that is a namesake's, a
// wrong link, Last.fm's one page per name. Last.fm alone never makes a score.
//
// Readings come from audience.ts (catalog_signal, kind 'audience'); the
// score is written as a catalog_fact (field 'reach', source 'curator') that
// catalog.browse hands the artist's page header.

import type { CatalogReach } from '@curator/protocol';
import type { Db } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import type { Logger } from '../log.js';
import { AUDIENCE_METRIC, AUDIENCE_PROVIDERS, type AudienceProvider } from './audience.js';

// How directly each source measures listening.
export const REACH_WEIGHT: Record<AudienceProvider, number> = { spotify: 1, lastfm: 0.8, deezer: 0.6, tidal: 0.5, soundcloud: 0.5, youtube: 0.5 };
// log10(spotify listeners) ≈ a + b · log10(metric), before there are pairs to
// fit: rough priors from a handful of artists (Daft Punk's 5.2M Deezer fans
// against 27.8M Spotify listeners, 2026-11-19). The fit replaces them.
const SEED: Record<Exclude<AudienceProvider, 'spotify'>, Line> = {
	deezer: { a: 0.7, b: 1 },
	lastfm: { a: 0.7, b: 1 },
	tidal: { a: 1.5, b: 1 },
	soundcloud: { a: 0.5, b: 1 },
	youtube: { a: 0.7, b: 1 },
};
const MIN_PAIRS = 40;
// A slope outside this is a fit on bad pairs, not a relation between stores.
const SLOPE_MIN = 0.5;
const SLOPE_MAX = 1.5;
const OUTLIER_LOG = Math.log10(30);
// A reading counts this long; "change" is measured against the score the
// readings of three months before gave.
const FRESH_DAYS = 120;
const THEN_FROM_DAYS = 75;
const THEN_TO_DAYS = 165;
const DAY = 86_400_000;
// The full pass runs when there are readings newer than the last scores, at
// most this often; in between, the artists read in the last day are scored
// on its calibration, a batch a pass.
const SCORE_EVERY_MS = 60 * 60_000;
const FRESH_WINDOW_HOURS = 24;
const FRESH_LIMIT = 200;
const WRITE_CHUNK = 500;

type Line = { a: number; b: number };
export type Calibration = Record<AudienceProvider, Line & { pairs: number; fitted: boolean }>;
export type Reading = { provider: AudienceProvider; n: number; at: number };

const lg = (n: number): number => Math.log10(Math.max(0, n) + 1);
const round1 = (x: number): number => Math.round(x * 10) / 10;

function line(points: readonly [number, number][]): Line | null {
	if (points.length < 2) return null;
	const mx = points.reduce((s, p) => s + p[0], 0) / points.length;
	const my = points.reduce((s, p) => s + p[1], 0) / points.length;
	const sxx = points.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
	if (sxx === 0) return null;
	const b = points.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
	return { a: my - b * mx, b };
}

// Each store's line onto Spotify's listeners, from the artists that have
// both. A wrong page (a namesake's handful of fans against thousands of
// listeners) sits far out and would drag a least-squares line to itself, so
// the pairs are first judged against a line no few of them can move — slope
// one through the median offset — and those more than 30× off it are left
// out of the fit.
export function calibrate(byArtist: ReadonlyMap<string, ReadonlyMap<AudienceProvider, number>>): Calibration {
	const out = { spotify: { a: 0, b: 1, pairs: 0, fitted: true } } as Calibration;
	for (const p of AUDIENCE_PROVIDERS) {
		if (p === 'spotify') continue;
		const pairs: [number, number][] = [];
		for (const r of byArtist.values()) {
			const x = r.get(p);
			const y = r.get('spotify');
			if (x !== undefined && y !== undefined && x > 0 && y > 0) pairs.push([lg(x), lg(y)]);
		}
		let fit: Line | null = null;
		if (pairs.length >= MIN_PAIRS) {
			const offsets = pairs.map(([x, y]) => y - x).sort((p, q) => p - q);
			const offset = offsets[offsets.length >> 1]!;
			fit = line(pairs.filter(([x, y]) => Math.abs(offset + x - y) <= OUTLIER_LOG));
		}
		const ok = !!fit && fit.b >= SLOPE_MIN && fit.b <= SLOPE_MAX;
		out[p] = ok ? { ...fit!, pairs: pairs.length, fitted: true } : { ...SEED[p], pairs: pairs.length, fitted: false };
	}
	return out;
}

export type Scored = { score: number; parts: { provider: AudienceProvider; n: number; outlier: boolean }[] };

// One artist's score from its readings (one per store), or null when they
// cannot make one (none, or Last.fm alone).
export function reachOf(readings: ReadonlyMap<AudienceProvider, number>, cal: Calibration): Scored | null {
	// The most direct measure first: the order `parts` is shown in.
	const est = [...readings]
		.map(([provider, n]) => ({ provider, n, e: cal[provider].a + cal[provider].b * lg(n), w: REACH_WEIGHT[provider], outlier: false }))
		.sort((x, y) => y.w - x.w || AUDIENCE_PROVIDERS.indexOf(x.provider) - AUDIENCE_PROVIDERS.indexOf(y.provider));
	if (!est.length) return null;
	if (est.length >= 3) {
		// Against the weighted median of all of them.
		const sorted = [...est].sort((x, y) => x.e - y.e);
		const half = sorted.reduce((s, x) => s + x.w, 0) / 2;
		let acc = 0;
		const median = sorted.find((x) => (acc += x.w) >= half)!.e;
		for (const x of est) x.outlier = Math.abs(x.e - median) > OUTLIER_LOG;
	} else if (est.length === 2 && Math.abs(est[0]!.e - est[1]!.e) > OUTLIER_LOG) {
		// Two that disagree: the more direct measure stands.
		(est[0]!.w >= est[1]!.w ? est[1]! : est[0]!).outlier = true;
	}
	const kept = est.filter((x) => !x.outlier);
	if (!kept.length || kept.every((x) => x.provider === 'lastfm')) return null;
	const w = kept.reduce((s, x) => s + x.w, 0);
	return { score: round1((10 * kept.reduce((s, x) => s + x.w * x.e, 0)) / w), parts: est.map((x) => ({ provider: x.provider, n: x.n, outlier: x.outlier })) };
}

// ── the pass ──────────────────────────────────────────────────────────────────────────────

type Row = { artist: string; provider: string; page: string; n: unknown; at: unknown };

// The artists' readings: the newest per store page, and per store the
// biggest of its pages (an artist with two Spotify pages is one audience
// counted twice at most, never summed). A reading follows its page to the
// artist that holds it now (a merge, an unlink); Last.fm's, which has no
// page, follows its artist's merge. Pages since blocked, and Deezer pages the
// page validation found to hold several acts or someone else, are not read.
// `objects`: only the readings taken for those artists.
async function readings(db: Db, from: number, to: number, objects?: readonly string[]): Promise<Map<string, Map<AudienceProvider, { n: number; at: number }>>> {
	const rows = await db.query<Row>(
		`select distinct on (artist, provider, page) artist, provider, page, n, at from (
			select coalesce(so.object_id, o.merged_into, o.id) as artist, sg.value->>'provider' as provider,
				coalesce(sg.source_object_id::text, '') as page, (sg.value->>'n')::float8 as n,
				extract(epoch from sg.observed_at) * 1000 as at
			from curator.catalog_signal sg
			join curator.catalog_object o on o.id = sg.object_id
			left join curator.catalog_source_object so on so.id = sg.source_object_id
			where sg.kind = 'audience' and sg.observed_at >= to_timestamp($1::float8 / 1000) and sg.observed_at < to_timestamp($2::float8 / 1000)
				and ($3::text is null or sg.object_id in (select (jsonb_array_elements_text($3::text::jsonb))::uuid))
				and (so.id is null or not exists (select 1 from curator.catalog_source_block b where b.provider = so.provider and b.kind = so.kind and b.provider_id = so.provider_id))
				and (so.id is null or not exists (select 1 from curator.catalog_page_check c where c.provider = so.provider and c.kind = so.kind and c.provider_id = so.provider_id and c.verdict in ('mixed', 'foreign')))
		) x
		order by artist, provider, page, at desc`,
		[String(from), String(to), objects ? JSON.stringify(objects) : null],
	);
	const out = new Map<string, Map<AudienceProvider, { n: number; at: number }>>();
	for (const r of rows) {
		if (!(AUDIENCE_PROVIDERS as readonly string[]).includes(r.provider)) continue;
		const provider = r.provider as AudienceProvider;
		const n = num(r.n);
		const at = num(r.at);
		const mine = out.get(r.artist) ?? new Map<AudienceProvider, { n: number; at: number }>();
		const had = mine.get(provider);
		if (!had || n > had.n) mine.set(provider, { n, at });
		out.set(r.artist, mine);
	}
	return out;
}

const counts = (m: Map<string, Map<AudienceProvider, { n: number; at: number }>>): Map<string, Map<AudienceProvider, number>> =>
	new Map([...m].map(([id, r]) => [id, new Map([...r].map(([p, v]) => [p, v.n]))]));

// The scores of these artists (all, without `objects`), as facts to write:
// each against its readings of three months before.
async function scoresOf(db: Db, cal: Calibration, now: number, objects?: readonly string[]): Promise<{ id: string; v: CatalogReach }[]> {
	const fresh = await readings(db, now - FRESH_DAYS * DAY, now + DAY, objects);
	const then = counts(await readings(db, now - THEN_TO_DAYS * DAY, now - THEN_FROM_DAYS * DAY, objects));
	const out: { id: string; v: CatalogReach }[] = [];
	for (const [id, r] of counts(fresh)) {
		const s = reachOf(r, cal);
		if (!s) continue;
		const before = then.get(id);
		const prev = before ? reachOf(before, cal) : null;
		const at = fresh.get(id)!;
		out.push({
			id,
			v: {
				score: s.score,
				change: prev ? round1(s.score - prev.score) : null,
				at: now,
				parts: s.parts.map((p) => ({ provider: p.provider, metric: AUDIENCE_METRIC[p.provider], n: p.n, at: at.get(p.provider)!.at, ...(p.outlier ? { outlier: true } : {}) })),
			},
		});
	}
	return out;
}

async function write(db: Db, values: readonly { id: string; v: CatalogReach }[], opts: { dropOthers: boolean }): Promise<void> {
	await withSystemTx(db, async (tx) => {
		for (let i = 0; i < values.length; i += WRITE_CHUNK) {
			await tx.query(
				`insert into curator.catalog_fact (object_id, field, source, value, method, at)
				select x.id, 'reach', 'curator', x.v, 'inferred', now() from jsonb_to_recordset($1::text::jsonb) as x(id uuid, v jsonb)
				on conflict (object_id, field, source) do update set value = excluded.value, at = excluded.at`,
				[JSON.stringify(values.slice(i, i + WRITE_CHUNK))],
			);
		}
		if (opts.dropOthers) {
			await tx.query(
				`delete from curator.catalog_fact where field = 'reach' and source = 'curator'
					and object_id not in (select (jsonb_array_elements_text($1::text::jsonb))::uuid)`,
				[JSON.stringify(values.map((v) => v.id))],
			);
		}
	});
}

// Readings newer than the newest score.
async function newerReadings(db: Db): Promise<boolean> {
	const [w] = await db.query<{ scored: unknown; read: unknown }>(
		`select (select extract(epoch from max(at)) * 1000 from curator.catalog_fact where field = 'reach') as scored,
			(select extract(epoch from max(observed_at)) * 1000 from curator.catalog_signal where kind = 'audience') as read`,
	);
	const read = w?.read == null ? null : num(w.read);
	const scored = w?.scored == null ? null : num(w.scored);
	return read !== null && (scored === null || read > scored);
}

// The last full pass's calibration, and when it ran, per database.
const calibrations = new WeakMap<Db, Calibration>();
const lastFull = new WeakMap<Db, number>();

export type ReachPassDeps = { db: Db; log: Logger; now?: () => number; force?: boolean };
export type ReachReport = { scored: number; full: boolean };

// Every pass: the artists read since their last score are scored at once,
// on the last full pass's calibration — an artist page opened for the first
// time has its score within minutes. Hourly, when readings newer than the
// scores have landed (and on a fresh process, which has no calibration
// yet): the full pass, which refits the calibration, scores every artist
// with a reading of the last four months, and drops the score of an artist
// it no longer scores.
export async function runReachScores(deps: ReachPassDeps): Promise<ReachReport | null> {
	const { db } = deps;
	const now = (deps.now ?? Date.now)();
	let cal = calibrations.get(db);
	if (deps.force || now >= (lastFull.get(db) ?? 0) + SCORE_EVERY_MS) {
		lastFull.set(db, now);
		if (deps.force || !cal || (await newerReadings(db))) {
			cal = calibrate(counts(await readings(db, now - FRESH_DAYS * DAY, now + DAY)));
			calibrations.set(db, cal);
			const values = await scoresOf(db, cal, now);
			await write(db, values, { dropOthers: true });
			deps.log.info('reach_pass', { scored: values.length, fitted: Object.entries(cal).filter(([, c]) => c.fitted).map(([p, c]) => `${p}:${c.pairs}`) });
			return { scored: values.length, full: true };
		}
	}
	if (!cal) return null;
	const unscored = await db.query<{ id: string }>(
		`select distinct sg.object_id as id from curator.catalog_signal sg
		join curator.catalog_object o on o.id = sg.object_id and o.merged_into is null
		where sg.kind = 'audience' and sg.observed_at > now() - make_interval(hours => ${FRESH_WINDOW_HOURS})
			and not exists (select 1 from curator.catalog_fact f where f.object_id = sg.object_id and f.field = 'reach' and f.source = 'curator' and f.at >= sg.observed_at)
		limit ${FRESH_LIMIT}`,
	);
	if (!unscored.length) return null;
	const values = await scoresOf(db, cal, now, unscored.map((u) => u.id));
	if (values.length) await write(db, values, { dropOthers: false });
	return { scored: values.length, full: false };
}
