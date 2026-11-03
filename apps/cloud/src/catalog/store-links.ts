// A release's pages on the stores, by identifier: Spotify, Tidal and Apple
// found through the release's UPCs (every one it holds — each store issues
// its own: Maeve 035 is 4066004975924 on Spotify, 199109285880 on Deezer and
// Tidal), tracks through the album's tracklist, else by ISRC. Deterministic,
// so it runs in the worker's pass (runStoreLinker) for every release that
// gains a UPC, and inside the back office's fill for the releases it just
// read. Nothing is matched by name here: that stays the agent's.
//
// Each store's answer is a claim of the kind the trackers make; applying it
// is the same for all of them (applyReleaseClaims): attached to the release
// first so ingestion resolves to it, its tracks joined onto the ones already
// held (ISRC, else the same slot or title and length), then claimed so the
// tracklist, facts and genres land by the usual rules — empty facts only, so
// a store read later never overwrites an earlier one.

import type { CatalogClaim } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import type { Logger } from '../log.js';
import { openReview } from './admin.js';
import { findRepresentation } from './identity.js';
import { Ingester } from './ingest.js';
import type { AppleLookup } from './trackers/apple.js';
import { fetchAlbums, type SpotifyAppTracker } from './trackers/spotify-app.js';
import type { TidalApp } from './trackers/tidal-app.js';
import { TrackerRateLimitedError } from './trackers/types.js';

export type StoreReaders = { spotify?: SpotifyAppTracker | null; tidal?: TidalApp | null; apple?: AppleLookup | null };
export const STORE_PROVIDERS = ['spotify', 'tidal', 'apple'] as const;
export type StoreProvider = (typeof STORE_PROVIDERS)[number];

// Calls a day per store, shared with everything else on that app (Spotify's
// resolver and trackers draw on the same row), and the gap between calls.
const BUDGET: Record<StoreProvider, { perDay: number; gapMs: number }> = {
	spotify: { perDay: 20_000, gapMs: 400 },
	tidal: { perDay: 8_000, gapMs: 300 },
	apple: { perDay: 2_000, gapMs: 3_000 },
};
// A store that has no such release is asked again this many days later, the
// gaps growing: a release can turn up on a store months after the others.
const RETRY_DAYS = [30, 90, 365];

export type StoreNote = { provider: StoreProvider; note: string };
export type StoreLookup = { claims: CatalogClaim[]; notes: StoreNote[]; calls: Partial<Record<StoreProvider, number>> };

// What the configured stores say about a release, for the stores it is not
// yet on; `upcs` in the order to try. A store that rate-limits is reported,
// not retried here.
export async function storeClaims(readers: StoreReaders, release: { upcs: string[]; on: string[] }, signal: AbortSignal): Promise<StoreLookup> {
	const out: StoreLookup = { claims: [], notes: [], calls: {} };
	const upcs = [...new Set(release.upcs.filter(Boolean))];
	if (!upcs.length) return out;
	const count = (p: StoreProvider, n = 1) => (out.calls[p] = (out.calls[p] ?? 0) + n);
	const attempt = async (p: StoreProvider, fn: () => Promise<CatalogClaim | null>) => {
		if (release.on.includes(p)) return;
		try {
			const c = await fn();
			if (c) out.claims.push(c);
			else out.notes.push({ provider: p, note: `no release with UPC ${upcs.join(' / ')}` });
		} catch (e) {
			out.notes.push({ provider: p, note: e instanceof TrackerRateLimitedError ? `rate limited (${e.retryAfterSec}s)` : `failed: ${e instanceof Error ? e.message : String(e)}` });
		}
	};
	if (readers.spotify) {
		const app = readers.spotify;
		await attempt('spotify', async () => {
			for (const upc of upcs) {
				const s = await app.get<{ albums?: { items: { id: string }[] } }>(`/search?type=album&limit=3&q=${encodeURIComponent(`upc:${upc}`)}`, signal);
				count('spotify');
				const id = s.albums?.items?.[0]?.id;
				if (!id) continue;
				const full = await fetchAlbums(app, [id], signal);
				count('spotify', full.calls);
				const claim = full.claims.get(id);
				if (claim) return claim;
			}
			return null;
		});
	}
	if (readers.tidal) {
		const tidal = readers.tidal;
		await attempt('tidal', async () => {
			for (const upc of upcs) {
				const c = await tidal.albumByUpc(upc, signal);
				count('tidal');
				if (c) return c;
			}
			return null;
		});
	}
	if (readers.apple) {
		const apple = readers.apple;
		await attempt('apple', async () => {
			for (const upc of upcs) {
				const r = await apple.albumByUpc(upc, signal);
				count('apple', r.calls);
				if (r.claim) return r.claim;
			}
			return null;
		});
	}
	return out;
}

export type ApplyResult = { conflicts: { provider: string; id: string; heldBy: string }[]; tracks: number };

// Store claims onto one release, in the caller's transaction. A store id
// that already belongs to another release is not moved: a `duplicate`
// review opens with `why` as its reason.
export async function applyReleaseClaims(tx: Queryable, releaseId: string, claims: CatalogClaim[], why: (c: CatalogClaim) => string): Promise<ApplyResult> {
	const result: ApplyResult = { conflicts: [], tracks: 0 };
	const ingester = new Ingester(tx, { reason: 'enrichment' });
	for (const c of claims) {
		const holder = await findRepresentation(tx, c);
		if (holder && holder !== releaseId) {
			result.conflicts.push({ provider: c.provider, id: c.providerId, heldBy: holder });
			await openReview(tx, { kind: 'duplicate', objectId: releaseId, candidates: [{ objectId: holder, name: c.name }], evidence: { reason: why(c) } });
			continue;
		}
		// On the release first, so the claim below resolves to it and brings
		// its tracklist, label and facts along.
		if (!holder) await ingester.attachTo(releaseId, c);
		await joinTracks(tx, ingester, releaseId, c);
		await ingester.claim(c);
	}
	const [after] = await tx.query<{ n: unknown }>(`select count(*) as n from curator.catalog_edge where src = $1 and kind = 'release-recording'`, [releaseId]);
	result.tracks = num(after!.n);
	return result;
}

// A store's tracks onto the ones the release already holds from another
// store. Without ISRCs (Spotify's and Bandcamp's tracklists carry none) the
// catalogue's title + artists rule misses whenever the stores credit
// differently (Spotify names the featured artist, Deezer the main one only,
// Bandcamp none), and one single becomes three recordings. Within one
// release the evidence is stronger: the same title at the same position, or
// with a length within three seconds, is the same track — and so is the same
// position with a length within two, whatever the title (Bandcamp retitles:
// "… (Featuring X)", a cut-short "Losing Someone"). One match only; anything
// less clear is left to the identity rules.
export async function joinTracks(tx: Queryable, ingester: Ingester, releaseId: string, c: CatalogClaim): Promise<void> {
	if (!c.recordings?.length) return;
	const held = await tx.query<{ id: string; name: string; duration_sec: unknown; position: unknown }>(
		`select o.id, o.name, o.duration_sec, e.position from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst and o.merged_into is null
		where e.src = $1 and e.kind = 'release-recording'`,
		[releaseId],
	);
	if (!held.length) return;
	const artists = (c.artists ?? []).map((a) => nameFold(a.name)).filter(Boolean);
	for (const [i, r] of c.recordings.entries()) {
		if (await findRepresentation(tx, r)) continue;
		const title = trackFold(r.name, artists);
		const pos = r.facts?.trackNumber ?? i + 1;
		const len = r.facts?.durationSec;
		const hits = held.filter((h) => {
			const d = numOrNull(h.duration_sec);
			const near = len != null && d !== null && Math.abs(d - len) <= 3;
			const samePos = numOrNull(h.position) === pos;
			if (samePos && len != null && d !== null && Math.abs(d - len) <= 2) return true;
			return trackFold(h.name, artists) === title && (samePos || near);
		});
		if (hits.length === 1) await ingester.attachTo(hits[0]!.id, r);
	}
}

// A track title compared within a release: folded, without a leading
// "Artist - " (a label's Bandcamp account titles its tracks that way).
function trackFold(title: string, artists: string[]): string {
	const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(title);
	if (m && artists.some((a) => nameFold(m[1]!).includes(a))) return nameFold(m[2]!);
	return nameFold(title);
}

export type LinkerDeps = { db: Db; log: Logger; readers: StoreReaders; batch?: number; now?: () => number };
export type LinkerReport = { releases: number; linked: Partial<Record<StoreProvider, number>>; recordings: number; recordingsLinked: number; parked: StoreProvider[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The worker's pass over releases with a UPC that some configured store has
// not been asked about (or is due again): one album lookup per store, its
// tracks joined; then tracks with an ISRC still off Tidal or Apple, one
// lookup each. Attempts are kept on catalog_enrich_task so a miss is not
// asked daily; a store that rate-limits is left for the next pass.
export async function runStoreLinker(deps: LinkerDeps): Promise<LinkerReport> {
	const providers = STORE_PROVIDERS.filter((p) => deps.readers[p]);
	const report: LinkerReport = { releases: 0, linked: {}, recordings: 0, recordingsLinked: 0, parked: [] };
	if (!providers.length) return report;
	const batch = deps.batch ?? 40;
	const list = `{${providers.join(',')}}`;
	// The tasks ingestion queued for a release's UPC and label text, which a
	// store's full album satisfies (nothing else ever consumed them).
	await deps.db.query(`delete from curator.catalog_enrich_task et using curator.catalog_identifier i where et.need = 'upc' and i.object_id = et.object_id and i.namespace = 'upc'`);
	await deps.db.query(`delete from curator.catalog_enrich_task et using curator.catalog_object o where et.need = 'label' and o.id = et.object_id and (o.attrs ? 'labelText' or exists (select 1 from curator.catalog_edge e where e.src = o.id and e.kind = 'release-label'))`);
	// A task whose release got onto the store another way is done.
	await deps.db.query(
		`delete from curator.catalog_enrich_task et using curator.catalog_source_object so
		where et.need = 'representation' and et.provider = any($1::text[]) and so.object_id = et.object_id and so.provider = et.provider`,
		[list],
	);

	const parked = new Set<StoreProvider>();
	const reserve = async (p: StoreProvider, n: number): Promise<boolean> => {
		if (parked.has(p)) return false;
		const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [p, String(n), String(BUDGET[p].perDay)]);
		if (num(g!.n) >= n) return true;
		parked.add(p);
		return false;
	};
	const settle = async (objectId: string, p: StoreProvider, hit: boolean, attempts: number) => {
		if (hit) {
			await deps.db.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'representation' and provider = $2`, [objectId, p]);
			return;
		}
		const days = RETRY_DAYS[Math.min(attempts, RETRY_DAYS.length - 1)]!;
		await deps.db.query(
			`insert into curator.catalog_enrich_task (object_id, need, provider, next_due_at, attempts, last_error)
			values ($1, 'representation', $2, now() + make_interval(days => $3::int), 1, 'not_found')
			on conflict (object_id, need, provider) do update set next_due_at = excluded.next_due_at, attempts = curator.catalog_enrich_task.attempts + 1, last_error = excluded.last_error`,
			[objectId, p, String(days)],
		);
	};

	// Releases: newest first, those no configured store has been asked about yet ahead of retries.
	const releases = await deps.db.query<{ id: string; name: string; upcs: string; on_providers: string | null; attempts: string | null }>(
		`select r.id, r.name,
			(select string_agg(i.value, '|' order by i.at) from curator.catalog_identifier i where i.object_id = r.id and i.namespace = 'upc') as upcs,
			(select string_agg(distinct so.provider, '|') from curator.catalog_source_object so where so.object_id = r.id) as on_providers,
			(select string_agg(et.provider || ':' || et.attempts, '|') from curator.catalog_enrich_task et where et.object_id = r.id and et.need = 'representation' and et.provider = any($1::text[])) as attempts
		from curator.catalog_object r
		where r.kind = 'release' and r.merged_into is null
			and exists (select 1 from curator.catalog_identifier i where i.object_id = r.id and i.namespace = 'upc')
			and exists (select 1 from unnest($1::text[]) p
				where not exists (select 1 from curator.catalog_source_object so where so.object_id = r.id and so.provider = p)
				and not exists (select 1 from curator.catalog_enrich_task et where et.object_id = r.id and et.need = 'representation' and et.provider = p and et.next_due_at > now()))
		order by r.discovered_at desc
		limit $2::int`,
		[list, String(batch)],
	);
	const signal = AbortSignal.timeout(15 * 60_000);
	for (const r of releases) {
		report.releases++;
		const on = (r.on_providers ?? '').split('|').filter(Boolean);
		const attempts = new Map((r.attempts ?? '').split('|').filter(Boolean).map((x) => x.split(':') as [string, string]));
		const readers: StoreReaders = {};
		for (const p of providers) {
			if (on.includes(p)) continue;
			const due = await deps.db.query(`select 1 from curator.catalog_enrich_task where object_id = $1 and need = 'representation' and provider = $2 and next_due_at > now()`, [r.id, p]);
			if (due.length) continue;
			// Two calls each: Spotify's search then its album, Apple's two storefronts, Tidal per UPC.
			if (await reserve(p, 2)) readers[p] = deps.readers[p] as never;
		}
		if (!Object.keys(readers).length) continue;
		const found = await storeClaims(readers, { upcs: r.upcs.split('|'), on }, signal);
		for (const n of found.notes) {
			if (/rate limited/.test(n.note)) parked.add(n.provider);
			else if (!/^no release/.test(n.note)) deps.log.warn('store_link_failed', { release: r.id, provider: n.provider, note: n.note });
		}
		for (const p of Object.keys(readers) as StoreProvider[]) {
			if (parked.has(p) && found.notes.some((n) => n.provider === p && /rate limited/.test(n.note))) continue;
			const hit = found.claims.some((c) => c.provider === p);
			await settle(r.id, p, hit, Number(attempts.get(p) ?? 0));
			if (hit) report.linked[p] = (report.linked[p] ?? 0) + 1;
		}
		if (found.claims.length) {
			const applied = await withSystemTx(deps.db, (tx) => applyReleaseClaims(tx, r.id, found.claims, (c) => `${c.provider} release ${c.providerId} is on the other one; the store linker found it for this one by UPC`));
			for (const c of applied.conflicts) deps.log.warn('store_link_conflict', { release: r.id, ...c });
		}
		await sleep(Math.max(...Object.keys(readers).map((p) => BUDGET[p as StoreProvider].gapMs)));
	}

	// Tracks by ISRC, on the stores whose album lookup did not reach them.
	const byIsrc = providers.filter((p): p is 'tidal' | 'apple' => p === 'tidal' || p === 'apple');
	if (byIsrc.length) {
		const recs = await deps.db.query<{ id: string; isrc: string; duration_sec: unknown; on_providers: string | null; attempts: string | null }>(
			`select o.id, i.value as isrc, o.duration_sec,
				(select string_agg(distinct so.provider, '|') from curator.catalog_source_object so where so.object_id = o.id) as on_providers,
				(select string_agg(et.provider || ':' || et.attempts, '|') from curator.catalog_enrich_task et where et.object_id = o.id and et.need = 'representation' and et.provider = any($1::text[])) as attempts
			from curator.catalog_object o
			join curator.catalog_identifier i on i.object_id = o.id and i.namespace = 'isrc'
			where o.kind = 'recording' and o.merged_into is null
				and exists (select 1 from unnest($1::text[]) p
					where not exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = p)
					and not exists (select 1 from curator.catalog_enrich_task et where et.object_id = o.id and et.need = 'representation' and et.provider = p and et.next_due_at > now()))
				-- Not while its release is still to be asked about: the album lookup is cheaper.
				and not exists (select 1 from curator.catalog_edge e join curator.catalog_identifier u on u.object_id = e.src and u.namespace = 'upc'
					where e.dst = o.id and e.kind = 'release-recording'
					and exists (select 1 from unnest($1::text[]) p
						where not exists (select 1 from curator.catalog_source_object so where so.object_id = e.src and so.provider = p)
						and not exists (select 1 from curator.catalog_enrich_task et where et.object_id = e.src and et.need = 'representation' and et.provider = p)))
			order by o.discovered_at desc
			limit $2::int`,
			[`{${byIsrc.join(',')}}`, String(batch)],
		);
		for (const rec of recs) {
			report.recordings++;
			const on = (rec.on_providers ?? '').split('|').filter(Boolean);
			const attempts = new Map((rec.attempts ?? '').split('|').filter(Boolean).map((x) => x.split(':') as [string, string]));
			for (const p of byIsrc) {
				if (on.includes(p) || !(await reserve(p, 2))) continue;
				const due = await deps.db.query(`select 1 from curator.catalog_enrich_task where object_id = $1 and need = 'representation' and provider = $2 and next_due_at > now()`, [rec.id, p]);
				if (due.length) continue;
				let claim: CatalogClaim | null = null;
				try {
					claim = p === 'tidal' ? await deps.readers.tidal!.trackByIsrc(rec.isrc, signal) : (await deps.readers.apple!.trackByIsrc(rec.isrc, signal)).claim;
				} catch (e) {
					if (e instanceof TrackerRateLimitedError) {
						parked.add(p);
						continue;
					}
					deps.log.warn('store_link_failed', { recording: rec.id, provider: p, note: e instanceof Error ? e.message : String(e) });
					continue;
				}
				// A copy of another length is another recording with a reused ISRC.
				const ours = numOrNull(rec.duration_sec);
				const len = claim?.facts?.durationSec;
				if (claim && ours !== null && len !== undefined && Math.abs(len - ours) > 10) claim = null;
				await settle(rec.id, p, !!claim, Number(attempts.get(p) ?? 0));
				if (claim) {
					report.recordingsLinked++;
					await withSystemTx(deps.db, async (tx) => {
						const owner = await findRepresentation(tx, claim!);
						if (owner && owner !== rec.id) return;
						await new Ingester(tx, { reason: 'enrichment' }).attachTo(rec.id, claim!);
					});
				}
				await sleep(BUDGET[p].gapMs);
			}
		}
	}
	report.parked = [...parked];
	if (report.releases || report.recordings) deps.log.info('store_link_pass', report);
	return report;
}
