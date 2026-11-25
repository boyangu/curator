// An artist's audience at each store, read monthly: what the Reach score
// (reach.ts) is made of.
//
//   spotify     monthly listeners, off the public artist page (spotify-page.ts)
//   deezer      fans                     tidal       followers (many a call)
//   soundcloud  followers                youtube     subscribers
//   lastfm      listeners, by name — Last.fm has one page per name
//
// Which artists: the ones somebody follows, and any artist whose page
// somebody opens (queueAudience, beside the page validation's queue). Each
// store page an artist holds is read — not reader name keys, not blocked
// pages, not Deezer pages the page validation found to be several acts or
// someone else — and each reading is kept as a catalog_signal of kind
// 'audience' on the page: a time series, so a score can be set against the
// one of three months before. Then the task waits a month (and a little, so
// the reads spread over it).
//
// Each store is read at its own pace, side by side. A store that says to
// slow down (429), or answers with a page this code does not know, is parked
// for this worker; the others go on.

import { SpotifyPageShapeError, TrackerRateLimitedError, readMonthlyListeners, type DeezerTracker, type FetchLike, type LastfmReader, type SoundCloudTracker, type YouTubeTracker } from '@curator/catalog-readers';
import type { Db, Queryable } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import type { Logger } from '../log.js';
import { WEAK_SQL } from './identity.js';
import type { TidalApp } from './trackers/tidal-app.js';

export const AUDIENCE_PROVIDERS = ['spotify', 'deezer', 'tidal', 'soundcloud', 'youtube', 'lastfm'] as const;
export type AudienceProvider = (typeof AUDIENCE_PROVIDERS)[number];
export const AUDIENCE_METRIC: Record<AudienceProvider, string> = {
	spotify: 'monthly_listeners',
	deezer: 'fans',
	tidal: 'followers',
	soundcloud: 'followers',
	youtube: 'subscribers',
	lastfm: 'listeners',
};
// The stores read through an artist page of theirs; Last.fm is read by name.
const PAGE_PROVIDERS = AUDIENCE_PROVIDERS.filter((p) => p !== 'lastfm');

export const AUDIENCE_NEED = 'audience';
const READ_EVERY_DAYS = 30;
const JITTER_HOURS = 72;
const LEASE_MINUTES = 10;
const SEED_EVERY_MS = 10 * 60_000;
const SEED_LIMIT = 2000;
const SHAPE_PARK_SEC = 6 * 3600;
const RETRY_AFTER_ERROR_MINUTES = 24 * 60;

// A store page that can be read: a store's own id, not a reader's name key
// (a YouTube page id can hold a slash: "c/name", "user/name"), not blocked,
// and not a Deezer page that holds several acts or someone else's.
const USABLE_SQL = `(not ${WEAK_SQL} or s.provider = 'youtube')
	and not exists (select 1 from curator.catalog_source_block b where b.provider = s.provider and b.kind = s.kind and b.provider_id = s.provider_id)
	and not exists (select 1 from curator.catalog_page_check c where c.provider = s.provider and c.kind = s.kind and c.provider_id = s.provider_id and c.verdict in ('mixed', 'foreign'))`;

export type AudiencePage = { sourceId: string | null; providerId: string; url: string | null };
// What a store said for each page it was asked about: a count, null for a
// page with none to say, an Error for that page alone. A page left out was
// not reached (`stop`: the store asked to be left alone, or changed shape).
export type AudienceRead = { values: Map<AudiencePage, number | null | Error>; stop?: { parkSec: number; reason: string } };

export interface AudienceReader {
	readonly provider: AudienceProvider;
	// Artists one pass reads.
	readonly perPass: number;
	read(pages: readonly AudiencePage[], signal: AbortSignal): Promise<AudienceRead>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stopOf = (e: unknown): AudienceRead['stop'] | null =>
	e instanceof TrackerRateLimitedError
		? { parkSec: e.retryAfterSec, reason: 'rate limited' }
		: e instanceof SpotifyPageShapeError
			? { parkSec: SHAPE_PARK_SEC, reason: e.message }
			: null;

// A store asked one page a call, `gapMs` apart.
function perPage(provider: AudienceProvider, perPass: number, gapMs: number, readOne: (page: AudiencePage, signal: AbortSignal) => Promise<number | null>): AudienceReader {
	return {
		provider,
		perPass,
		async read(pages, signal) {
			const values = new Map<AudiencePage, number | null | Error>();
			for (const [i, page] of pages.entries()) {
				if (i) await sleep(gapMs);
				try {
					values.set(page, await readOne(page, signal));
				} catch (e) {
					const stop = stopOf(e);
					if (stop) return { values, stop };
					values.set(page, e instanceof Error ? e : new Error(String(e)));
				}
			}
			return { values };
		},
	};
}

export type AudienceSources = {
	deezer?: DeezerTracker | null;
	tidal?: TidalApp | null;
	soundcloud?: SoundCloudTracker | null;
	youtube?: YouTubeTracker | null;
	lastfm?: LastfmReader | null;
	// The public Spotify artist pages (no credentials): on by configuration.
	spotifyPages?: boolean;
	fetch?: FetchLike;
};

export function audienceReaders(s: AudienceSources): AudienceReader[] {
	const out: AudienceReader[] = [];
	const fetchFn: FetchLike = s.fetch ?? ((u, i) => fetch(u, i));
	// A page every 3 s: a link preview's pace, not a crawler's.
	if (s.spotifyPages) out.push(perPage('spotify', 6, 3000, (p, signal) => readMonthlyListeners(fetchFn, p.providerId, signal)));
	if (s.deezer) {
		const dz = s.deezer;
		out.push(perPage('deezer', 20, 150, (p, signal) => dz.artistFans(p.providerId, signal)));
	}
	if (s.soundcloud) {
		const sc = s.soundcloud;
		out.push(perPage('soundcloud', 10, 500, (p, signal) => sc.userFollowers(p.providerId, p.url, signal)));
	}
	if (s.youtube) {
		const yt = s.youtube;
		out.push(perPage('youtube', 10, 200, (p, signal) => yt.channelSubscribers(p.providerId, signal)));
	}
	if (s.lastfm) {
		const lf = s.lastfm;
		out.push(perPage('lastfm', 20, 250, (p, signal) => lf.artistListeners(p.providerId, signal)));
	}
	if (s.tidal) {
		const tidal = s.tidal;
		// Many artists a call: the rate wall is per call, not per artist.
		out.push({
			provider: 'tidal',
			perPass: 20,
			async read(pages, signal) {
				const values = new Map<AudiencePage, number | null | Error>();
				try {
					const found = await tidal.artistFollowers([...new Set(pages.map((p) => p.providerId))], signal);
					for (const p of pages) values.set(p, found.get(p.providerId) ?? null);
				} catch (e) {
					const stop = stopOf(e);
					if (stop) return { values, stop };
					for (const p of pages) values.set(p, e instanceof Error ? e : new Error(String(e)));
				}
				return { values };
			},
		});
	}
	return out;
}

// What can be read of artists at a store, by artist; one that is gone (merged
// away) is absent.
async function pagesOf(q: Queryable, artistIds: readonly string[], provider: AudienceProvider): Promise<Map<string, AudiencePage[]>> {
	const rows = await q.query<{ artist: string; name: string; id: string | null; provider_id: string | null; url: string | null }>(
		`select o.id as artist, o.name, p.id, p.provider_id, p.url from curator.catalog_object o
		left join lateral (
			select s.id, s.provider_id, s.url from curator.catalog_source_object s
			where s.object_id = o.id and s.provider = $2 and s.kind = 'artist' and ${USABLE_SQL}
		) p on true
		where o.id = any($1::uuid[]) and o.kind = 'artist' and o.merged_into is null
		order by p.provider_id`,
		[`{${artistIds.join(',')}}`, provider],
	);
	const out = new Map<string, AudiencePage[]>();
	for (const r of rows) {
		if (provider === 'lastfm') {
			out.set(r.artist, [{ sourceId: null, providerId: r.name, url: null }]);
			continue;
		}
		const list = out.get(r.artist) ?? [];
		if (r.id !== null) list.push({ sourceId: r.id, providerId: r.provider_id!, url: r.url });
		out.set(r.artist, list);
	}
	return out;
}

// Someone opened an artist's page, or a library holds the artist: each store
// it has a page at is read by the next pass, unless a reading is already due
// or done this month. How many reads were queued.
export async function queueAudience(tx: Queryable, artistId: string): Promise<number> {
	const rows = await tx.query(
		`insert into curator.catalog_enrich_task (object_id, need, provider)
		select o.id, $2, p.provider from curator.catalog_object o
		cross join lateral (
			select distinct s.provider from curator.catalog_source_object s
			where s.object_id = o.id and s.kind = 'artist' and s.provider in (select jsonb_array_elements_text($3::text::jsonb)) and ${USABLE_SQL}
			union select 'lastfm'
		) p
		where o.id = $1 and o.kind = 'artist' and o.merged_into is null
		on conflict do nothing returning 1`,
		[artistId, AUDIENCE_NEED, JSON.stringify(PAGE_PROVIDERS)],
	);
	return rows.length;
}

// Followed artists without a task yet, for the stores this worker reads.
async function seed(db: Db, providers: readonly AudienceProvider[]): Promise<void> {
	const pages = providers.filter((p) => p !== 'lastfm');
	if (pages.length) {
		await db.query(
			`insert into curator.catalog_enrich_task (object_id, need, provider)
			select distinct o.id, $1, s.provider from curator.catalog_object o
			join curator.catalog_source_object s on s.object_id = o.id and s.kind = 'artist' and s.provider in (select jsonb_array_elements_text($2::text::jsonb))
			where o.kind = 'artist' and o.watch_count > 0 and o.merged_into is null and ${USABLE_SQL}
				and not exists (select 1 from curator.catalog_enrich_task t where t.object_id = o.id and t.need = $1 and t.provider = s.provider)
			limit ${SEED_LIMIT}
			on conflict do nothing`,
			[AUDIENCE_NEED, JSON.stringify(pages)],
		);
	}
	if (providers.includes('lastfm')) {
		await db.query(
			`insert into curator.catalog_enrich_task (object_id, need, provider)
			select o.id, $1, 'lastfm' from curator.catalog_object o
			where o.kind = 'artist' and o.watch_count > 0 and o.merged_into is null
				and not exists (select 1 from curator.catalog_enrich_task t where t.object_id = o.id and t.need = $1 and t.provider = 'lastfm')
			limit ${SEED_LIMIT}
			on conflict do nothing`,
			[AUDIENCE_NEED],
		);
	}
}

const seedDue = new WeakMap<Db, number>();
// Stores parked on this worker, until when.
const parked = new WeakMap<Db, Map<AudienceProvider, number>>();

export type AudiencePassDeps = { db: Db; log: Logger; readers: readonly AudienceReader[]; holder: string; now?: () => number };
export type AudienceReport = { read: number; failed: number; parked: string[] };

export async function runAudience(deps: AudiencePassDeps): Promise<AudienceReport> {
	const report: AudienceReport = { read: 0, failed: 0, parked: [] };
	if (!deps.readers.length) return report;
	const now = (deps.now ?? Date.now)();
	if (now >= (seedDue.get(deps.db) ?? 0)) {
		seedDue.set(deps.db, now + SEED_EVERY_MS);
		await seed(deps.db, deps.readers.map((r) => r.provider));
	}
	const parkedHere = parked.get(deps.db) ?? new Map<AudienceProvider, number>();
	parked.set(deps.db, parkedHere);
	await Promise.all(
		deps.readers.map(async (reader) => {
			if ((parkedHere.get(reader.provider) ?? 0) > now) return;
			const r = await readStore(deps, reader).catch((e: unknown) => {
				deps.log.error('audience_store_failed', { provider: reader.provider, error: e });
				return null;
			});
			if (!r) return;
			report.read += r.read;
			report.failed += r.failed;
			if (r.stop) {
				parkedHere.set(reader.provider, now + r.stop.parkSec * 1000);
				report.parked.push(reader.provider);
				deps.log.info('audience_store_parked', { provider: reader.provider, reason: r.stop.reason, seconds: r.stop.parkSec });
			}
		}),
	);
	if (report.read || report.failed) deps.log.info('audience_pass', report);
	return report;
}

async function readStore(deps: AudiencePassDeps, reader: AudienceReader): Promise<{ read: number; failed: number; stop?: AudienceRead['stop'] }> {
	const { db } = deps;
	const due = await db.query<{ object_id: string }>(
		`update curator.catalog_enrich_task t set lease_holder = $3, lease_until = now() + make_interval(mins => ${LEASE_MINUTES})
		where (t.object_id, t.need, t.provider) in (
			select object_id, need, provider from curator.catalog_enrich_task
			where need = $1 and provider = $2 and next_due_at <= now() and (lease_until is null or lease_until < now())
			order by next_due_at limit $4::int for update skip locked
		)
		returning t.object_id`,
		[AUDIENCE_NEED, reader.provider, deps.holder, String(reader.perPass)],
	);
	if (!due.length) return { read: 0, failed: 0 };
	const tasks: { artist: string; pages: AudiencePage[] }[] = [];
	const pagesBy = await pagesOf(db, due.map((t) => t.object_id), reader.provider);
	const gone: string[] = [];
	for (const t of due) {
		const pages = pagesBy.get(t.object_id);
		// Merged away, or no page left to read there: nothing to wait for.
		if (!pages?.length) gone.push(t.object_id);
		else tasks.push({ artist: t.object_id, pages });
	}
	if (gone.length) await db.query(`delete from curator.catalog_enrich_task where object_id = any($1::uuid[]) and need = $2 and provider = $3`, [`{${gone.join(',')}}`, AUDIENCE_NEED, reader.provider]);
	// The store is read outside any transaction: none is held across a call out.
	const { values, stop } = tasks.length ? await reader.read(tasks.flatMap((t) => t.pages), AbortSignal.timeout(120_000)) : { values: new Map(), stop: undefined };
	let read = 0;
	let failed = 0;
	// Kept in one transaction, a statement per table and outcome.
	const signals: unknown[] = [];
	const unreached: string[] = [];
	const erred: { id: string; error: string }[] = [];
	const done: string[] = [];
	for (const t of tasks) {
		const got = t.pages.map((p) => ({ page: p, v: values.get(p) }));
		const counted = got.filter((g): g is { page: AudiencePage; v: number } => typeof g.v === 'number');
		const errors = got.filter((g) => g.v instanceof Error).map((g) => (g.v as Error).message);
		for (const g of counted) signals.push({ artist: t.artist, so: g.page.sourceId, value: { provider: reader.provider, metric: AUDIENCE_METRIC[reader.provider], n: g.v } });
		if (!got.every((g) => g.v !== undefined)) unreached.push(t.artist);
		else if (!counted.length && errors.length) {
			failed++;
			erred.push({ id: t.artist, error: errors[0]!.slice(0, 200) });
		} else {
			read++;
			done.push(t.artist);
		}
	}
	await withSystemTx(db, async (tx) => {
		const key = [AUDIENCE_NEED, reader.provider];
		if (signals.length) {
			await tx.query(
				`insert into curator.catalog_signal (object_id, source_object_id, kind, value)
				select x.artist, x.so, 'audience', x.value from jsonb_to_recordset($1::text::jsonb) as x(artist uuid, so uuid, value jsonb)`,
				[JSON.stringify(signals)],
			);
		}
		// Not reached this pass: due again at once.
		if (unreached.length) await tx.query(`update curator.catalog_enrich_task set lease_holder = null, lease_until = null where object_id = any($1::uuid[]) and need = $2 and provider = $3`, [`{${unreached.join(',')}}`, ...key]);
		if (erred.length) {
			await tx.query(
				`update curator.catalog_enrich_task t set next_due_at = now() + make_interval(mins => ${RETRY_AFTER_ERROR_MINUTES}), attempts = t.attempts + 1, last_error = x.error, lease_holder = null, lease_until = null
				from jsonb_to_recordset($1::text::jsonb) as x(id uuid, error text) where t.object_id = x.id and t.need = $2 and t.provider = $3`,
				[JSON.stringify(erred), ...key],
			);
		}
		if (done.length) {
			await tx.query(
				`update curator.catalog_enrich_task set next_due_at = now() + make_interval(days => ${READ_EVERY_DAYS}) + random() * make_interval(hours => ${JITTER_HOURS}),
					attempts = 0, last_error = null, lease_holder = null, lease_until = null
				where object_id = any($1::uuid[]) and need = $2 and provider = $3`,
				[`{${done.join(',')}}`, ...key],
			);
		}
	});
	return { read, failed, ...(stop ? { stop } : {}) };
}
