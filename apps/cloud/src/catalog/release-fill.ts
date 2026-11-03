// Tracklists for releases the catalogue holds only as stubs — the back
// office's job (`catalog release stubs | fill | link`), run by an agent.
//
// A tracker ingests an old release from its provider's listing alone (title,
// artists, date: Spotify and Deezer artist albums, Bandcamp and Beatport
// label pages past 90 days), and a static object is never read again. The
// stub keeps the store ids it was seen with, so filling it is one more read
// per store: Spotify's /albums (twenty a call; UPC, label, tracks), Deezer's
// album by id or by that UPC (tracks with ISRCs), Beatport's release page
// (ISRCs, BPM, key), Bandcamp's tralbum_details under the label's account.
//
// Each full release is attached to the stub first and then claimed, so
// ingestion finds the stub by representation and attaches the tracklist,
// label and facts by its usual rules (empty facts only, recordings joined by
// ISRC or title + artists + length). A store id that already belongs to
// another release is not moved: a `duplicate` review opens instead. Reason
// 'enrichment': nothing reaches anyone's feed. `dry` reads everything and
// rolls the writes back.

import type { CatalogClaim } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { mergeObjects, openReview } from './admin.js';
import { artistTwinsOn } from './artist-twins.js';
import { storeRef } from './agent-import.js';
import { findRepresentation } from './identity.js';
import { Ingester } from './ingest.js';
import { applyReleaseClaims, storeClaims, type StoreReaders } from './store-links.js';
import type { BandcampTracker } from './trackers/bandcamp.js';
import type { BeatportTracker } from './trackers/beatport.js';
import type { DeezerTracker } from './trackers/deezer.js';
import { TrackerRateLimitedError } from './trackers/types.js';
import { fetchAlbums, type SpotifyAppTracker } from './trackers/spotify-app.js';

export type ReleaseScope = { labelId?: string; artistId?: string; ids?: string[] };

export type ReleaseStub = {
	id: string;
	title: string;
	date: string | null;
	artists: string[];
	labels: { id: string; name: string; bandcampId: string | null }[];
	// What a provider said it holds, when one did; else one is expected.
	expected: number | null;
	have: number;
	handles: { provider: string; id: string; url: string | null }[];
	upc: string | null;
};

export type FillFetchers = StoreReaders & {
	deezer?: DeezerTracker | null;
	beatport?: BeatportTracker | null;
	bandcamp?: BandcampTracker | null;
};

export type FillSource = { provider: string; tracks: number | null; note?: string };
export type FillOutcome = {
	id: string;
	title: string;
	before: number;
	after: number;
	expected: number | null;
	sources: FillSource[];
	conflicts: { provider: string; id: string; heldBy: string }[];
	// Same-titled albums on a store the fill could not key (another UPC):
	// for the agent to check and `release link`, never attached here.
	candidates: { provider: string; id: string; title: string; artist: string | null; tracks: number | null; url: string }[];
};
export type FillReport = { dry: boolean; stubs: number; filled: number; outcomes: FillOutcome[]; parked: string[] };

// Stores a fill can read, in the order it reads them: Spotify first, for the
// UPC that finds the Deezer copy.
export const FILL_PROVIDERS = ['spotify', 'deezer', 'beatport', 'bandcamp'] as const;
const PACE_MS = 250;
const MAX_LIMIT = 100;

const short = `(select count(*) from curator.catalog_edge t where t.src = r.id and t.kind = 'release-recording')
	< greatest(case when r.attrs->>'trackCount' ~ '^[0-9]+$' then (r.attrs->>'trackCount')::int else 1 end, 1)`;

function scopeSql(scope: ReleaseScope): { cond: string; params: string[] } {
	if (scope.ids?.length) return { cond: 'r.id = any($1::uuid[])', params: [`{${scope.ids.join(',')}}`] };
	if (scope.labelId) return { cond: `exists (select 1 from curator.catalog_edge e where e.kind = 'release-label' and e.src = r.id and e.dst = $1::uuid)`, params: [scope.labelId] };
	if (scope.artistId) return { cond: `exists (select 1 from curator.catalog_edge e where e.kind = 'artist-release' and e.src = $1::uuid and e.dst = r.id)`, params: [scope.artistId] };
	return { cond: 'true', params: [] };
}

// Releases in scope holding fewer tracks than their providers said (or none),
// newest first, with the store ids a fill would read. An explicit id list is
// returned whatever its tracklist holds: the caller asked for those.
export async function releaseStubs(tx: Queryable, scope: ReleaseScope, limit = 50): Promise<{ total: number; rows: ReleaseStub[] }> {
	const { cond, params } = scopeSql(scope);
	const where = `r.kind = 'release' and r.merged_into is null and ${cond}${scope.ids?.length ? '' : ` and ${short}`}`;
	const [count] = await tx.query<{ n: unknown }>(`select count(*) as n from curator.catalog_object r where ${where}`, params);
	const rows = await tx.query<{
		id: string;
		name: string;
		date: string | null;
		expected: unknown;
		have: unknown;
		artists: string | null;
		labels: string | null;
		handles: string | null;
		upc: string | null;
	}>(
		`select r.id, r.name, to_char(r.release_at, 'YYYY-MM-DD') as date,
			case when r.attrs->>'trackCount' ~ '^[0-9]+$' then (r.attrs->>'trackCount')::int end as expected,
			(select count(*) from curator.catalog_edge t where t.src = r.id and t.kind = 'release-recording') as have,
			(select string_agg(a.name, chr(30) order by e.position) from curator.catalog_edge e join curator.catalog_object a on a.id = e.src where e.dst = r.id and e.kind = 'artist-release') as artists,
			(select string_agg(l.id || chr(31) || l.name || chr(31) || coalesce((select so.provider_id from curator.catalog_source_object so where so.object_id = l.id and so.provider = 'bandcamp' and so.kind = 'label' limit 1), ''), chr(30))
				from curator.catalog_edge e join curator.catalog_object l on l.id = e.dst where e.src = r.id and e.kind = 'release-label') as labels,
			(select string_agg(so.provider || chr(31) || so.provider_id || chr(31) || coalesce(so.url, ''), chr(30) order by so.provider) from curator.catalog_source_object so where so.object_id = r.id and so.kind = 'release') as handles,
			(select i.value from curator.catalog_identifier i where i.object_id = r.id and i.namespace = 'upc' limit 1) as upc
		from curator.catalog_object r
		where ${where}
		order by r.release_at desc nulls last, r.name
		limit ${Math.min(Math.max(limit, 1), 500)}`,
		params,
	);
	const parts = (s: string | null) => (s ? s.split('\u001e').map((p) => p.split('\u001f')) : []);
	return {
		total: num(count!.n),
		rows: rows.map((r) => ({
			id: r.id,
			title: r.name,
			date: r.date,
			artists: r.artists ? r.artists.split('\u001e') : [],
			labels: parts(r.labels).map(([id, name, bc]) => ({ id: id!, name: name ?? '', bandcampId: bc || null })),
			expected: numOrNull(r.expected),
			have: num(r.have),
			handles: parts(r.handles).map(([provider, id, url]) => ({ provider: provider!, id: id ?? '', url: url || null })),
			upc: r.upc,
		})),
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fillReleases(db: Db, fetchers: FillFetchers, scope: ReleaseScope, opts: { limit?: number; dry?: boolean } = {}): Promise<FillReport> {
	const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_LIMIT);
	const { rows: stubs } = await withSystemTx(db, (tx) => releaseStubs(tx, scope, limit));
	const report: FillReport = { dry: !!opts.dry, stubs: stubs.length, filled: 0, outcomes: [], parked: [] };
	const parked = new Set<string>();
	const signal = AbortSignal.timeout(10 * 60_000);
	// A provider that rate-limits or blocks is left alone for the rest of the run.
	const read = async <T>(provider: string, src: FillSource[], fn: () => Promise<T>): Promise<T | null> => {
		if (parked.has(provider)) {
			src.push({ provider, tracks: null, note: 'parked for this run (rate limited earlier)' });
			return null;
		}
		try {
			return await fn();
		} catch (e) {
			// A Cloudflare challenge reads as rate limited too (beatport-pages.ts).
			if (e instanceof TrackerRateLimitedError) parked.add(provider);
			src.push({ provider, tracks: null, note: `failed: ${e instanceof Error ? e.message : String(e)}` });
			return null;
		}
	};

	// Spotify in batches up front: twenty albums a call.
	const spotifyIds = stubs.flatMap((s) => s.handles.filter((h) => h.provider === 'spotify').map((h) => h.id));
	let spotifyAlbums = new Map<string, CatalogClaim>();
	let spotifyNote: string | null = null;
	if (spotifyIds.length && fetchers.spotify) {
		try {
			spotifyAlbums = (await fetchAlbums(fetchers.spotify, spotifyIds, signal)).claims;
		} catch (e) {
			spotifyNote = `failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	} else if (spotifyIds.length) spotifyNote = 'no Spotify app credentials (CURATOR_SPOTIFY_APP_CLIENT_SECRET)';

	for (const stub of stubs) {
		const sources: FillSource[] = [];
		const claims: CatalogClaim[] = [];
		const handle = (p: string) => stub.handles.find((h) => h.provider === p);
		const keep = (c: CatalogClaim | null, provider: string, note?: string) => {
			if (!c) return;
			claims.push(c);
			sources.push({ provider, tracks: c.recordings?.length ?? 0, ...(note ? { note } : {}) });
		};

		const sp = handle('spotify');
		if (sp) {
			if (spotifyNote) sources.push({ provider: 'spotify', tracks: null, note: spotifyNote });
			else if (spotifyAlbums.has(sp.id)) keep(spotifyAlbums.get(sp.id)!, 'spotify');
			else sources.push({ provider: 'spotify', tracks: null, note: 'Spotify no longer lists this album' });
		}
		// The store's own spelling first: the catalogue keeps UPCs normalised
		// (no leading zero), which Deezer's lookup may not match.
		const upc = claims.flatMap((c) => c.identifiers ?? []).find((i) => i.namespace === 'upc')?.value ?? stub.upc;
		const dz = handle('deezer');
		if (fetchers.deezer && (dz || upc)) {
			const c = await read('deezer', sources, async () =>
				dz
					? fetchers.deezer!.fetchRelease({ id: dz.id }, signal)
					: ((await fetchers.deezer!.fetchRelease({ upc: upc! }, signal)) ?? (/^\d{12}$/.test(upc!) ? fetchers.deezer!.fetchRelease({ upc: `0${upc}` }, signal) : null)),
			);
			if (c) keep(c, 'deezer', dz ? undefined : `found by UPC ${upc}`);
			else if (!dz && !sources.some((s) => s.provider === 'deezer')) sources.push({ provider: 'deezer', tracks: null, note: `no Deezer album with UPC ${upc}` });
			await sleep(PACE_MS);
		}
		// Not on Deezer under any id or UPC we hold: same-titled albums there,
		// for the agent (Deezer is where the ISRCs come from).
		const searchDeezer = fetchers.deezer && !claims.some((c) => c.provider === 'deezer');
		const bp = handle('beatport');
		if (bp && fetchers.beatport) {
			keep(await read('beatport', sources, () => fetchers.beatport!.fetchRelease(bp.id, bp.url, signal)), 'beatport');
			await sleep(PACE_MS);
		}
		const bc = handle('bandcamp');
		if (bc && fetchers.bandcamp) {
			const label = stub.labels.find((l) => l.bandcampId);
			if (!label) sources.push({ provider: 'bandcamp', tracks: null, note: "no label with a Bandcamp account to read it under" });
			else {
				const c = await read('bandcamp', sources, () => fetchers.bandcamp!.fetchRelease(bc.id, { provider: 'bandcamp', kind: 'label', providerId: label.bandcampId!, name: label.name }, signal));
				if (c) keep(c, 'bandcamp');
				else if (!sources.some((s) => s.provider === 'bandcamp')) sources.push({ provider: 'bandcamp', tracks: null, note: 'Bandcamp does not know this item any more' });
				await sleep(PACE_MS);
			}
		}
		for (const h of stub.handles) {
			if (!(FILL_PROVIDERS as readonly string[]).includes(h.provider) && !sources.some((s) => s.provider === h.provider)) sources.push({ provider: h.provider, tracks: null, note: 'no reader for this store: find it on Spotify, Deezer or Beatport and `release link` it, or `label import` the tracks' });
		}

		const outcome: FillOutcome = { id: stub.id, title: stub.title, before: stub.have, after: stub.have, expected: stub.expected, sources, conflicts: [], candidates: [] };
		if (searchDeezer) {
			// By a credited artist where there is one: a title alone finds every
			// namesake album. Kept only when Deezer's artist is one of ours (or a
			// compilation of several).
			const credited = stub.artists.find((a) => !/^various artists$/i.test(a));
			const found = await read('deezer', sources, () => fetchers.deezer!.searchReleases(stub.title, signal, credited));
			const ours = new Set(stub.artists.map(nameFold));
			const fits = (artist: string | null) => !!artist && (ours.has(nameFold(artist)) || (/^various artists$/i.test(artist) && ours.size > 1));
			outcome.candidates.push(...(found ?? []).filter((a) => fits(a.artist)).slice(0, 5).map((a) => ({ provider: 'deezer', ...a })));
			await sleep(PACE_MS);
		}
		// The other stores, by every UPC now known (each store issues its own):
		// Spotify, Tidal and Apple pages for the release and its tracks.
		const upcs = [...new Set([...(stub.upc ? [stub.upc] : []), ...claims.flatMap((c) => (c.identifiers ?? []).filter((i) => i.namespace === 'upc').map((i) => i.value))])];
		const on = [...new Set([...stub.handles.map((h) => h.provider), ...claims.map((c) => c.provider)])];
		const byStore = new Set(claims.map((c) => c.provider));
		const stores = await storeClaims(fetchers, { upcs, on }, signal);
		for (const c of stores.claims) {
			claims.push(c);
			sources.push({ provider: c.provider, tracks: c.recordings?.length ?? 0, note: 'found by UPC' });
		}
		for (const n of stores.notes) {
			if (/rate limited/.test(n.note)) parked.add(n.provider);
			sources.push({ provider: n.provider, tracks: null, note: n.note });
		}
		if (claims.length) {
			const rollback = new Error('dry run');
			try {
				await withSystemTx(db, async (tx) => {
					const applied = await applyReleaseClaims(tx, stub.id, claims, (c) => `${c.provider} release ${c.providerId} is on the other one; the fill read it for this one (by ${byStore.has(c.provider) && c.provider !== 'deezer' ? 'store id' : 'UPC'})`);
					outcome.conflicts.push(...applied.conflicts);
					outcome.after = applied.tracks;
					if (opts.dry) throw rollback;
				});
			} catch (e) {
				if (e !== rollback) throw e;
			}
		}
		if (outcome.after > outcome.before) report.filled++;
		report.outcomes.push(outcome);
	}
	report.parked = [...parked];
	return report;
}

// Tracks a release holds twice — the same slot from two stores that the
// join above missed (a fill run before it knew a retitle) — merged into one
// (`release dedupe`). Same position, one title (sameTrackTitle) and lengths within two seconds; never
// two recordings with different ISRCs (a radio and an extended mix can share
// a slot on different releases, not on one). The survivor is the one with
// more store copies (ISRC first). Logged merges: undoable like any other.
//
// A SoundCloud preview is the other shape: a label's set uploaded ahead of
// the stores holds clips (2:00 of a 3:20 track, "… ft. JAW", no ISRC), which a
// twins merge brings onto the store release beside the full tracks
// (2026-10-31, Watergate "Tell Me More About You"). Same slot, SoundCloud its
// only copy, no ISRC, shorter than the store track, and the same title once
// credits and bracket tags are set aside: merged into the store track.
export type DedupeReport = { dry: boolean; releases: number; merged: { release: string; from: string; into: string; title: string }[] };

// A title with its credits ("ft. JAW", "feat. …") and bracket tags ("[Heimlich
// Musik]") set aside, and "Title - Mix" read as "Title (Mix)".
export const coreTitle = (t: string): string =>
	t.toLowerCase().normalize('NFKD').replace(/\[[^\]]*\]/g, ' ').replace(/\b(?:ft|feat|featuring)\.?\s+[^()[\]-]+/g, ' ').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// One track's two titles: equal at their core, one holding the other ("Low
// Tide" in "Low Tide (Radio Edit)"), or a typo apart ("Nostagia 92"). Two
// different tracks in one slot — a compilation's discs both number from 1
// (2026-10-31, Anjunadeep 07: "Glass Voices" and "Red Sky") — are none of these.
export function sameTrackTitle(a: string, b: string): boolean {
	const [x, y] = [coreTitle(a), coreTitle(b)];
	if (!x || !y) return false;
	if (x === y || x.includes(y) || y.includes(x)) return true;
	let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
	for (let i = 1; i <= x.length; i++) {
		const cur = [i];
		for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[y.length]! <= Math.max(1, Math.floor(Math.max(x.length, y.length) * 0.15));
}

export async function dedupeTracks(db: Db, scope: ReleaseScope, opts: { dry?: boolean; by?: string } = {}): Promise<DedupeReport> {
	const { cond, params } = scopeSql(scope);
	const releases = await withSystemTx(db, (tx) => tx.query<{ id: string; name: string }>(`select r.id, r.name from curator.catalog_object r where r.kind = 'release' and r.merged_into is null and ${cond} limit 2000`, params));
	const report: DedupeReport = { dry: !!opts.dry, releases: releases.length, merged: [] };
	for (const rel of releases) {
		const rollback = new Error('dry run');
		try {
			await withSystemTx(db, async (tx) => {
				const held = await tx.query<{ id: string; name: string; position: unknown; duration_sec: unknown; isrc: string | null; reps: unknown; providers: string | null }>(
					`select o.id, o.name, e.position, o.duration_sec,
						(select i.value from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc' limit 1) as isrc,
						(select count(*) from curator.catalog_source_object so where so.object_id = o.id) as reps,
						(select string_agg(distinct so.provider, '|') from curator.catalog_source_object so where so.object_id = o.id) as providers
					from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst and o.merged_into is null
					where e.src = $1 and e.kind = 'release-recording' order by e.position, o.id`,
					[rel.id],
				);
				const gone = new Set<string>();
				for (const a of held) {
					if (gone.has(a.id)) continue;
					for (const b of held) {
						if (b.id === a.id || gone.has(b.id) || gone.has(a.id)) continue;
						const da = numOrNull(a.duration_sec);
						const dbs = numOrNull(b.duration_sec);
						if (numOrNull(a.position) !== numOrNull(b.position) || da === null || dbs === null) continue;
						if (a.isrc && b.isrc && a.isrc !== b.isrc) continue;
						if (!sameTrackTitle(a.name, b.name)) continue;
						// b, a preview of a: SoundCloud only, no ISRC, shorter.
						const preview = b.providers === 'soundcloud' && !b.isrc && a.providers !== 'soundcloud' && dbs < da - 2;
						if (Math.abs(da - dbs) > 2 && !preview) continue;
						const score = (x: typeof a) => (x.isrc ? 1000 : 0) + num(x.reps);
						const [into, from] = preview ? [a, b] : score(a) >= score(b) ? [a, b] : [b, a];
						await mergeObjects(tx, from.id, into.id, opts.by ?? 'claude-code', preview ? 'SoundCloud preview of the store track in its slot' : 'same slot on one release (position, length)', { release: rel.id, position: numOrNull(a.position), lengths: [da, dbs] });
						gone.add(from.id);
						report.merged.push({ release: rel.name, from: from.name, into: into.name, title: into.name });
					}
				}
				// Two copies of a track made one credit each store's copy of its
				// artist on one track: the twins rule joins them now.
				if (gone.size) await artistTwinsOn(tx, [rel.id], opts.by ?? 'claude-code');
				if (opts.dry) throw rollback;
			});
		} catch (e) {
			if (e !== rollback) throw e;
		}
	}
	return report;
}

// A store page the agent found for a release (`release link`): attached as a
// representation so the next fill reads it. Refused when that page already
// belongs to another release — a duplicate review opens instead.
export async function linkReleasePage(db: Db, releaseId: string, url: string): Promise<{ provider: string; id: string; conflict: string | null }> {
	const ref = storeRef(url);
	if (!ref || ref.kind !== 'release') throw new Error(`"${url}" is not a release page I can key (Spotify album, Deezer album, Beatport release, Traxsource title, Apple or Tidal album)`);
	return withSystemTx(db, async (tx) => {
		const [r] = await tx.query<{ name: string; kind: string; merged_into: string | null }>(`select name, kind, merged_into from curator.catalog_object where id = $1`, [releaseId]);
		if (!r || r.kind !== 'release') throw new Error(`release ${releaseId} not found`);
		if (r.merged_into) throw new Error(`release ${releaseId} was merged into ${r.merged_into}`);
		const holder = await findRepresentation(tx, { provider: ref.provider, kind: 'release', providerId: ref.id });
		if (holder && holder !== releaseId) {
			await openReview(tx, { kind: 'duplicate', objectId: releaseId, candidates: [{ objectId: holder, name: r.name }], evidence: { reason: `${ref.provider} release ${ref.id} is on the other one; the agent found it for this one`, link: url } });
			return { provider: ref.provider, id: ref.id, conflict: holder };
		}
		if (!holder) await new Ingester(tx, { reason: 'enrichment' }).attachTo(releaseId, { provider: ref.provider, kind: 'release', providerId: ref.id, name: r.name, url });
		return { provider: ref.provider, id: ref.id, conflict: null };
	});
}

// ── the worker's fill (`fill` tasks) ────────────────────────────────────────
//
// The same fill, run by the worker for the releases a library import named
// (catalog.ts queueLibraryFollowUps): a library's copy of a release holds only
// its owner's tracks, so each is read in full from its stores — tracklist,
// ISRCs, UPC, label, cover — and the release then stands as the stores have
// it. Leased in arrival order (a library sends its biggest labels first), a
// batch at a time, the calls reserved against the providers' daily budgets
// like every other worker step. A release is done when it holds its tracks,
// or when every store it is on has answered and none had more; a store that
// rate-limited or failed brings it back later.

const FILL_RETRY_HOURS = [6, 24, 72];
const FILL_PARK_HOURS = 6;
// Caps shared with the resolver and the store linker (store-links.ts).
const FILL_BUDGETS = { spotify: 20000, deezer: 200000 } as const;

export type FillerDeps = { db: Db; fetchers: FillFetchers; holder: string; batch?: number; log?: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void } };

export async function runReleaseFiller(deps: FillerDeps): Promise<{ attempted: number; done: number; later: number; parked: string[] }> {
	const due = await deps.db.query<{ object_id: string; attempts: unknown }>(
		`update curator.catalog_enrich_task et set lease_holder = $1, lease_until = now() + interval '15 minutes'
		from (
			select t.object_id from curator.catalog_enrich_task t
			join curator.catalog_object o on o.id = t.object_id and o.kind = 'release' and o.merged_into is null
			where t.need = 'fill' and t.provider = 'catalog' and t.next_due_at <= now() and (t.lease_until is null or t.lease_until < now())
			order by t.next_due_at limit $2::int
			for update of t skip locked
		) d
		where et.object_id = d.object_id and et.need = 'fill' and et.provider = 'catalog'
		returning et.object_id, et.attempts`,
		[deps.holder, String(deps.batch ?? 20)],
	);
	// A release merged away while queued is its winner's business now.
	await deps.db.query(
		`delete from curator.catalog_enrich_task t using curator.catalog_object o
		where t.need = 'fill' and t.provider = 'catalog' and o.id = t.object_id and (o.kind <> 'release' or o.merged_into is not null)`,
	);
	const report = { attempted: 0, done: 0, later: 0, parked: [] as string[] };
	if (!due.length) return report;
	const release = (ids: string[]) =>
		deps.db.query(`update curator.catalog_enrich_task set lease_holder = null, lease_until = null where need = 'fill' and provider = 'catalog' and object_id = any($1::uuid[])`, [`{${ids.join(',')}}`]);
	// Spotify: /albums twenty a call, and a UPC search + album for a release
	// not on Spotify yet; Deezer: the album, its tracks, a search.
	const n = due.length;
	const want = { spotify: Math.ceil(n / 20) + 2 * n, deezer: 3 * n };
	for (const [provider, calls] of Object.entries(want) as [keyof typeof FILL_BUDGETS, number][]) {
		const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [provider, String(calls), String(FILL_BUDGETS[provider])]);
		if (num(g!.n) < calls) {
			// Out of today's budget: the releases wait for tomorrow's.
			await release(due.map((d) => d.object_id));
			report.parked.push(provider);
			deps.log?.info('release_fill_budget_out', { provider, wanted: calls });
			return report;
		}
	}
	report.attempted = n;
	const fill = await fillReleases(deps.db, deps.fetchers, { ids: due.map((d) => d.object_id) }, { limit: Math.min(n, MAX_LIMIT) });
	report.parked = fill.parked;
	const attempts = new Map(due.map((d) => [d.object_id, num(d.attempts)]));
	for (const o of fill.outcomes) {
		const complete = o.after >= Math.max(o.expected ?? 1, 1);
		const parkedHere = o.sources.some((s) => s.note?.startsWith('parked') || (s.note && /rate limited/i.test(s.note)));
		const failedHere = o.sources.some((s) => s.note?.startsWith('failed'));
		if (complete || (!parkedHere && !failedHere)) {
			await deps.db.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'fill' and provider = 'catalog'`, [o.id]);
			report.done++;
			continue;
		}
		const tries = attempts.get(o.id) ?? 0;
		const hours = parkedHere ? FILL_PARK_HOURS : FILL_RETRY_HOURS[Math.min(tries, FILL_RETRY_HOURS.length - 1)]!;
		await deps.db.query(
			`update curator.catalog_enrich_task set next_due_at = now() + make_interval(hours => $2::int), attempts = attempts + $3::int, last_error = $4, lease_holder = null, lease_until = null
			where object_id = $1 and need = 'fill' and provider = 'catalog'`,
			[o.id, String(hours), parkedHere ? '0' : '1', o.sources.filter((s) => s.note && (s.note.startsWith('parked') || s.note.startsWith('failed') || /rate limited/i.test(s.note))).map((s) => `${s.provider}: ${s.note}`).join('; ').slice(0, 300)],
		);
		report.later++;
	}
	// Leased but not reached (a fill run ends at its limit): back in the queue.
	const reached = new Set(fill.outcomes.map((o) => o.id));
	const left = due.map((d) => d.object_id).filter((id) => !reached.has(id));
	if (left.length) await release(left);
	if (report.attempted) deps.log?.info('release_fill_pass', { attempted: report.attempted, done: report.done, later: report.later, parked: report.parked });
	return report;
}
