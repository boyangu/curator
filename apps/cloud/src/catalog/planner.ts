// The enrichment planner's first job: give a watched object an id on every
// provider that tracks its kind, so each of those trackers can follow it. A
// followed artist imported from Spotify has only a Spotify id; Deezer's
// artist tracker needs a Deezer one.
//
// A provider's candidate is accepted only with evidence beyond its name: the
// same name (folded, a store's namesake tag "(tr)" aside) AND at least one of
// the object's known releases among the candidate's own — the one candidate
// qualifying, or of several the one overlapping clearly more (2026-11-09:
// Deezer's namesake bucket "Elif" listed two of ELIF's releases among 27 and
// was taken; her own page "Elif (tr)" was not even a candidate). With no known
// releases yet the attempt waits (the object's other tracker brings some in
// on its first poll). Attempts back off per object and provider through
// catalog_enrich_task, so a namesake-only artist is not searched every pass.

import type { CatalogClaim, CatalogKind, CatalogProvider } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import type { Logger } from '../log.js';
import { mergeObjects, openReview, ruledNotSame } from './admin.js';
import { findRepresentation, storeTagless } from './identity.js';
import { Ingester } from './ingest.js';
import { ensureCursors } from './watches.js';
import { DEEZER_GENRES, getJson, type FetchLike } from '@curator/catalog-readers';
import { judgePage, profileOf } from './artist-validation.js';
import { fetchAlbums, spotifyReleaseClaim, type SpotifyTracker } from '@curator/catalog-readers';
import { applyReleaseClaims } from './store-links.js';
import { TrackerRateLimitedError } from '@curator/catalog-readers';
export type FindCandidate = { id: string; name: string; url: string; releases: string[] };
// `candidates`: the namesakes a find could not choose between (reason
// 'ambiguous' / 'no_overlap'), with the releases each lists — a review for
// the back office (admin.ts) rather than a guess.
export type FindResult = { claim: CatalogClaim | null; calls: number; reason?: string; candidates?: FindCandidate[] };

export interface IdentityFinder {
	readonly provider: CatalogProvider;
	readonly kinds: readonly CatalogKind[];
	readonly callsPerFind: number;
	find(object: { id: string; kind: CatalogKind; name: string }, releaseTitles: Set<string>, signal: AbortSignal): Promise<FindResult>;
}

// Of name-matching candidates, the one whose releases overlap the object's.
async function confirm(
	candidates: { id: string; name: string; url: string }[],
	releaseTitles: Set<string>,
	releasesOf: (id: string) => Promise<string[]>,
): Promise<{ hit: (typeof candidates)[number] | null; calls: number; reason?: string; candidates: FindCandidate[] }> {
	if (!releaseTitles.size) return { hit: null, calls: 0, reason: 'no_known_releases', candidates: [] };
	let calls = 0;
	const qualifying: { c: (typeof candidates)[number]; n: number }[] = [];
	const seen: FindCandidate[] = [];
	for (const c of candidates.slice(0, 3)) {
		const titles = await releasesOf(c.id);
		calls++;
		seen.push({ ...c, releases: titles.slice(0, 15) });
		const n = titles.filter((t) => releaseTitles.has(nameFold(t))).length;
		if (n) qualifying.push({ c, n });
	}
	qualifying.sort((a, b) => b.n - a.n);
	const [top, next] = qualifying;
	if (!top) return { hit: null, calls, reason: 'no_overlap', candidates: seen };
	// Two namesakes both listing a release of ours: the one listing clearly
	// more (two at least, twice the other's) is the page; one title each, or
	// a close call, is the reviewer's.
	if (next && !(top.n >= 2 && top.n >= 2 * next.n)) return { hit: null, calls, reason: 'ambiguous', candidates: seen };
	return { hit: top.c, calls, candidates: [] };
}

// A store's artist whose name is ours, its namesake tag aside.
const namesake = (want: string, name: string): boolean => storeTagless(name) === want;

export class DeezerFinder implements IdentityFinder {
	readonly provider = 'deezer' as const;
	readonly kinds: readonly CatalogKind[] = ['artist'];
	readonly callsPerFind = 4;
	constructor(private readonly fetchFn: FetchLike = (u, i) => fetch(u, i)) {}

	async find(object: { name: string }, releaseTitles: Set<string>, signal: AbortSignal): Promise<FindResult> {
		const want = nameFold(object.name);
		const s = await getJson<{ data?: { id: number; name: string; link?: string }[]; error?: { code: number } }>(
			this.fetchFn,
			'deezer',
			`https://api.deezer.com/search/artist?q=${encodeURIComponent(object.name)}&limit=10`,
			{ signal, logPath: '/search/artist' },
		);
		if (s.error?.code === 4) throw new TrackerRateLimitedError(10);
		const candidates = (s.data ?? []).filter((a) => namesake(want, a.name)).map((a) => ({ id: String(a.id), name: a.name, url: a.link ?? `https://www.deezer.com/artist/${a.id}` }));
		// Each candidate's listing is kept as read: the page is judged by it
		// before it is taken (artist-validation.ts).
		const listings = new Map<string, { id: number; title: string; release_date?: string; genre_id?: number }[]>();
		const r = await confirm(candidates, releaseTitles, async (id) => {
			const l = await getJson<{ data?: { id: number; title: string; release_date?: string; genre_id?: number }[] }>(this.fetchFn, 'deezer', `https://api.deezer.com/artist/${id}/albums?limit=100`, { signal, logPath: '/artist/albums' });
			listings.set(id, l.data ?? []);
			return (l.data ?? []).map((x) => x.title);
		});
		// A page of several acts lists a release of every one of them — ours
		// too, which is all `confirm` asks (Deezer's "Fade", 2026-11-18). It is
		// not the artist's page: not attached, and not a candidate to review.
		if (r.hit) {
			const albums = (listings.get(r.hit.id) ?? []).map((a) => ({ id: String(a.id), title: a.title, date: a.release_date ?? null, genre: a.genre_id !== undefined ? DEEZER_GENRES[a.genre_id] ?? null : null }));
			const check = judgePage(profileOf(r.hit.id, { total: null, albums }), null);
			if (check.verdict === 'mixed') return { claim: null, calls: 1 + r.calls, reason: `mixed_page:${r.hit.id}` };
		}
		return { claim: r.hit ? { provider: 'deezer', kind: 'artist', providerId: r.hit.id, name: r.hit.name, url: r.hit.url } : null, calls: 1 + r.calls, reason: r.reason, candidates: r.candidates };
	}
}

export class SpotifyFinder implements IdentityFinder {
	readonly provider = 'spotify' as const;
	readonly kinds: readonly CatalogKind[] = ['artist'];
	readonly callsPerFind = 4;
	constructor(private readonly app: SpotifyTracker) {}

	async find(object: { name: string }, releaseTitles: Set<string>, signal: AbortSignal): Promise<FindResult> {
		const want = nameFold(object.name);
		// Search is capped at 10 results for Development Mode apps.
		const s = await this.app.get<{ artists?: { items: { id: string; name: string; external_urls?: { spotify?: string } }[] } }>(
			`/search?type=artist&limit=10&q=${encodeURIComponent(object.name)}`,
			signal,
		);
		const candidates = (s.artists?.items ?? [])
			.filter((a) => namesake(want, a.name))
			.map((a) => ({ id: a.id, name: a.name, url: a.external_urls?.spotify ?? `https://open.spotify.com/artist/${a.id}` }));
		const r = await confirm(candidates, releaseTitles, async (id) => {
			const l = await this.app.get<{ items: { name: string }[] }>(`/artists/${encodeURIComponent(id)}/albums?include_groups=album,single&limit=50`, signal);
			return l.items.map((x) => x.name);
		});
		return { claim: r.hit ? { provider: 'spotify', kind: 'artist', providerId: r.hit.id, name: r.hit.name, url: r.hit.url } : null, calls: 1 + r.calls, reason: r.reason, candidates: r.candidates };
	}
}

export type PlannerDeps = { db: Db; log: Logger; finders: readonly IdentityFinder[]; batch?: number; perDay?: Partial<Record<CatalogProvider, number>> };

// Backoff for a failed attempt: a day, then 3, then a week.
const RETRY_DAYS = [1, 3, 7];

export async function runPlanner(deps: PlannerDeps): Promise<{ attempted: number; linked: number }> {
	const due = await deps.db.query<{ id: string; kind: CatalogKind; name: string; provider: CatalogProvider; attempts: unknown; per_day: unknown }>(
		`select o.id, o.kind, o.name, t.provider, coalesce(et.attempts, 0) as attempts, coalesce((t.budget->>'perDay')::int, 1000) as per_day
		from curator.catalog_object o
		join curator.tracker t on t.kind = o.kind and t.enabled and coalesce(t.config->>'requires', 'representation') = 'representation'
		left join curator.catalog_enrich_task et on et.object_id = o.id and et.need = 'representation' and et.provider = t.provider
		where o.watch_count > 0 and o.merged_into is null
			and not exists (select 1 from curator.catalog_source_object so where so.object_id = o.id and so.provider = t.provider)
			and (et.next_due_at is null or et.next_due_at <= now())
		order by o.watch_count desc
		limit $1::int`,
		[String(deps.batch ?? 20)],
	);
	let linked = 0;
	let attempted = 0;
	const parked = new Set<string>();
	for (const o of due) {
		const finder = deps.finders.find((f) => f.provider === o.provider && f.kinds.includes(o.kind));
		if (!finder || parked.has(o.provider)) continue;
		const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [o.provider, String(finder.callsPerFind), String(num(o.per_day))]);
		if (num(g!.n) < finder.callsPerFind) {
			parked.add(o.provider);
			continue;
		}
		attempted++;
		try {
			const titles = new Set(
				(
					await deps.db.query<{ name_fold: string }>(
						`select r.name_fold from curator.catalog_edge e join curator.catalog_object r on r.id = e.dst
						where e.src = $1 and e.kind = 'artist-release' limit 500`,
						[o.id],
					)
				).map((r) => r.name_fold),
			);
			const r = await finder.find(o, titles, AbortSignal.timeout(30_000));
			const outcome = await withSystemTx(deps.db, async (tx) => {
				if (!r.claim) {
					if (r.candidates?.length) {
						await openReview(tx, {
							kind: 'artist_link',
							objectId: o.id,
							candidates: r.candidates.map((c) => ({ provider: o.provider, providerId: c.id, name: c.name, url: c.url, releases: c.releases })),
							evidence: { releases: [...titles].slice(0, 15), reason: r.reason },
						});
					}
					return r.reason ?? 'not_found';
				}
				// A page a reviewer ruled not this artist's is not attached again.
				if (await ruledNotSame(tx, o.id, { provider: r.claim.provider, providerId: r.claim.providerId, name: r.claim.name })) return 'ruled_not_same';
				const owner = await findRepresentation(tx, r.claim);
				// That provider id already belongs to another object: two objects for
				// one artist, an operator's merge to make, not this planner's.
				if (owner && owner !== o.id) return `owned_by:${owner}`;
				await new Ingester(tx, { reason: 'enrichment' }).attachTo(o.id, r.claim);
				await ensureCursors(tx, [o.id]);
				await tx.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'representation' and provider = $2`, [o.id, o.provider]);
				return null;
			});
			if (outcome === null) linked++;
			else await recordAttempt(deps.db, o.id, o.provider, num(o.attempts), outcome);
		} catch (e) {
			if (e instanceof TrackerRateLimitedError) parked.add(o.provider);
			await recordAttempt(deps.db, o.id, o.provider, num(o.attempts), e instanceof Error ? e.message.slice(0, 200) : 'error');
		}
	}
	if (attempted) deps.log.info('identity_pass', { attempted, linked });
	return { attempted, linked };
}

// ── recordings: the Spotify id Discover plays by ────────────────────────────
//
// A track Beatport or Deezer found carries an ISRC but no Spotify id, and the
// desktop's Discover plays Spotify only, so its card is dropped there until
// it has one. When the catalogue already knows the Spotify album of a release
// the track sits on, that album is read in full first (one call, every track
// on it placed by the slot rule — 2026-11-09, Rummel "Machine Language": the
// album known from one track's lookup, three tracks waiting their turn in a
// 700-deep queue). Else Spotify's search takes `isrc:` (one call a track,
// within the app's budget); the hit must carry the same ISRC and a length
// within ten seconds of ours (an ISRC reused across an edit and an extended
// mix), and its album is read in full for the release too. Every event about
// the track, and every release holding it, is sent again with the new
// handles (the writes mark them; card-rebuild.ts). Queued by
// ingestion for a tracker's new recordings (ingest.ts recordGaps) and by the
// sweep for charted ones.

export type ResolverDeps = { db: Db; log: Logger; spotify: SpotifyTracker; batch?: number; perDay?: number };

type SpSearchTrack = {
	id: string;
	name: string;
	duration_ms?: number;
	external_ids?: { isrc?: string };
	external_urls?: { spotify?: string };
	artists?: { id: string; name: string; external_urls?: { spotify?: string } }[];
	album?: { id: string; name: string; album_type?: string; release_date?: string; release_date_precision?: 'year' | 'month' | 'day'; total_tracks?: number; images?: { url: string }[]; artists?: { id: string; name: string }[]; external_urls?: { spotify?: string } };
};

export async function runRecordingResolver(deps: ResolverDeps): Promise<{ attempted: number; resolved: number }> {
	// A task whose recording got its Spotify id another way is done.
	await deps.db.query(
		`delete from curator.catalog_enrich_task et using curator.catalog_source_object so
		where et.need = 'representation' and et.provider = 'spotify' and so.object_id = et.object_id and so.provider = 'spotify'`,
	);
	const due = await deps.db.query<{ id: string; name: string; duration_sec: unknown; isrc: string; attempts: unknown }>(
		`select o.id, o.name, o.duration_sec, i.value as isrc, et.attempts
		from curator.catalog_enrich_task et
		join curator.catalog_object o on o.id = et.object_id and o.kind = 'recording' and o.merged_into is null
		join curator.catalog_identifier i on i.object_id = o.id and i.namespace = 'isrc'
		where et.need = 'representation' and et.provider = 'spotify' and et.next_due_at <= now()
		order by et.next_due_at
		limit $1::int`,
		[String(deps.batch ?? 50)],
	);
	let attempted = 0;
	let resolved = 0;
	const signal = AbortSignal.timeout(20_000);
	const reserve = async () => num((await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls('spotify', 1, $1::int) as n`, [String(deps.perDay ?? 20_000)]))[0]!.n) >= 1;
	// The Spotify album of a release this recording sits on, or null.
	const albumOf = (recId: string) =>
		deps.db
			.query<{ id: string; release: string }>(
				`select so.provider_id as id, e.src as release from curator.catalog_edge e join curator.catalog_source_object so on so.object_id = e.src and so.provider = 'spotify' and so.kind = 'release'
				where e.dst = $1 and e.kind = 'release-recording' limit 1`,
				[recId],
			)
			.then((rows) => rows[0] ?? null);
	const hasSpotify = async (recId: string) => (await deps.db.query(`select 1 from curator.catalog_source_object where object_id = $1 and provider = 'spotify'`, [recId])).length > 0;
	// An album read in full (its tracklist), once a pass; null when Spotify has
	// no such album or the budget is spent (`exhausted` then ends the pass).
	const albums = new Map<string, CatalogClaim | null>();
	let exhausted = false;
	const readAlbum = async (albumId: string): Promise<CatalogClaim | null> => {
		if (albums.has(albumId)) return albums.get(albumId)!;
		if (!(await reserve())) {
			exhausted = true;
			return null;
		}
		const full = await fetchAlbums(deps.spotify, [albumId], signal);
		const claim = full.claims.get(albumId) ?? null;
		albums.set(albumId, claim);
		return claim;
	};
	// The album's tracklist onto the release by the slot rule and the usual
	// claim (store-links.ts).
	const applyAlbum = (releaseId: string, claim: CatalogClaim) =>
		withSystemTx(deps.db, async (tx) => {
			await applyReleaseClaims(tx, releaseId, [claim], (c) => `${c.provider} release ${c.providerId} is on the other one; the resolver found it for this one by a track's ISRC`);
		});
	const done = (recId: string) => deps.db.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'representation' and provider = 'spotify'`, [recId]);

	for (const r of due) {
		if (exhausted) break;
		attempted++;
		try {
			// The release's Spotify album, when the catalogue has it already (a
			// sibling's lookup brought it, a UPC did): one read gives every track
			// on it its id — this one included — instead of a search per track.
			// Once: a second attempt means the album did not carry this track.
			if (num(r.attempts) === 0) {
				const album = await albumOf(r.id);
				if (album) {
					const claim = await readAlbum(album.id);
					if (claim) await applyAlbum(album.release, claim);
					if (await hasSpotify(r.id)) {
						await done(r.id);
						resolved++;
						continue;
					}
					if (exhausted) break;
				}
			}
			if (!(await reserve())) break;
			const s = await deps.spotify.get<{ tracks?: { items: SpSearchTrack[] } }>(`/search?type=track&limit=5&q=${encodeURIComponent(`isrc:${r.isrc}`)}`, signal);
			const ours = numOrNull(r.duration_sec);
			const hit = (s.tracks?.items ?? []).find((t) => {
				if ((t.external_ids?.isrc ?? '').toUpperCase() !== r.isrc.toUpperCase()) return false;
				return ours === null || t.duration_ms === undefined || Math.abs(t.duration_ms / 1000 - ours) <= 10;
			});
			if (!hit) {
				await recordAttempt(deps.db, r.id, 'spotify', num(r.attempts), 'not_found');
				continue;
			}
			// The release the track sits on, if it has no Spotify id yet: read
			// in full, so its other tracks get their ids with it.
			const [rel] = await deps.db.query<{ id: string }>(
				`select e.src as id from curator.catalog_edge e where e.dst = $1 and e.kind = 'release-recording'
				and not exists (select 1 from curator.catalog_source_object so where so.object_id = e.src and so.provider = 'spotify') limit 1`,
				[r.id],
			);
			const full = rel && hit.album ? await readAlbum(hit.album.id) : null;
			await withSystemTx(deps.db, async (tx) => {
				const ingester = new Ingester(tx, { reason: 'enrichment' });
				const owner = await findRepresentation(tx, { provider: 'spotify', kind: 'recording', providerId: hit.id });
				if (owner && owner !== r.id) throw new Error(`owned_by:${owner}`);
				await ingester.attachTo(r.id, {
					provider: 'spotify',
					kind: 'recording',
					providerId: hit.id,
					name: hit.name,
					url: hit.external_urls?.spotify ?? `https://open.spotify.com/track/${hit.id}`,
					identifiers: [{ namespace: 'isrc', value: r.isrc }],
					facts: hit.duration_ms ? { durationSec: Math.round(hit.duration_ms / 100) / 10 } : {},
				});
				if (rel && hit.album) {
					if (full) {
						await applyReleaseClaims(tx, rel.id, [full], (c) => `${c.provider} release ${c.providerId} is on the other one; the resolver found it for this one by a track's ISRC`);
					} else {
						const albumOwner = await findRepresentation(tx, { provider: 'spotify', kind: 'release', providerId: hit.album.id });
						if (!albumOwner || albumOwner === rel.id) await ingester.attachTo(rel.id, spotifyReleaseClaim(hit.album));
					}
				}
				await tx.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'representation' and provider = 'spotify'`, [r.id]);
			});
			resolved++;
		} catch (e) {
			if (e instanceof TrackerRateLimitedError) break;
			await recordAttempt(deps.db, r.id, 'spotify', num(r.attempts), e instanceof Error ? e.message.slice(0, 200) : 'error');
		}
	}
	if (attempted) deps.log.info('recording_resolve_pass', { attempted, resolved });
	return { attempted, resolved };
}

// ── recordings: the ISRC Spotify's tracklists leave out ─────────────────────
//
// Spotify's album and single tracklists are simplified track objects — no
// external_ids — so a recording a Spotify tracker minted has no ISRC, and the
// identity rule by ISRC cannot join it to the Deezer, Beatport or Tidal copy
// (2026-11-09, Marsh "Home": two "Run Away" recordings on one slot). The fill
// reads the `isrc` gaps of recordings that have a Spotify id, fifty a call
// (/tracks?ids=), and attaches the ISRC; one that already names another
// recording of the same length is a twin the ISRC rule would have joined, so
// the thinner copy folds into the richer and the releases it sits on are
// re-announced with the shorter tracklist. A gap Spotify cannot fill either
// is closed, not retried. Gaps of recordings without a Spotify id stay for
// another provider.

const ISRC_BATCH = 50;

type SpFullTrack = { id: string; duration_ms?: number; external_ids?: { isrc?: string } };

export async function runIsrcFill(deps: ResolverDeps): Promise<{ attempted: number; filled: number; merged: number }> {
	const due = await deps.db.query<{ id: string; spotify_id: string; duration_sec: unknown }>(
		`select distinct on (o.id) o.id, so.provider_id as spotify_id, o.duration_sec
		from curator.catalog_enrich_task et
		join curator.catalog_object o on o.id = et.object_id and o.kind = 'recording' and o.merged_into is null
		join curator.catalog_source_object so on so.object_id = o.id and so.provider = 'spotify' and so.kind = 'recording'
		where et.need = 'isrc' and et.next_due_at <= now()
			and not exists (select 1 from curator.catalog_identifier i where i.object_id = o.id and i.namespace = 'isrc')
		order by o.id, so.first_seen_at
		limit $1::int`,
		[String(deps.batch ?? ISRC_BATCH * 4)],
	);
	let attempted = 0;
	let filled = 0;
	let merged = 0;
	for (let i = 0; i < due.length; i += ISRC_BATCH) {
		const batch = due.slice(i, i + ISRC_BATCH);
		const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls('spotify', 1, $1::int) as n`, [String(deps.perDay ?? 20_000)]);
		if (num(g!.n) < 1) break;
		let tracks: SpFullTrack[];
		try {
			tracks = (await deps.spotify.get<{ tracks?: (SpFullTrack | null)[] }>(`/tracks?ids=${batch.map((r) => encodeURIComponent(r.spotify_id)).join(',')}`, AbortSignal.timeout(20_000))).tracks?.filter((t): t is SpFullTrack => !!t) ?? [];
		} catch (e) {
			if (e instanceof TrackerRateLimitedError) break;
			deps.log.warn('isrc_fill_failed', { error: e instanceof Error ? e.message : String(e) });
			break;
		}
		const byId = new Map(tracks.map((t) => [t.id, t]));
		attempted += batch.length;
		const claims = new Map<string, CatalogClaim>();
		for (const r of batch) {
			const isrc = byId.get(r.spotify_id)?.external_ids?.isrc;
			if (isrc) claims.set(r.id, { provider: 'spotify', kind: 'recording', providerId: r.spotify_id, name: '', identifiers: [{ namespace: 'isrc', value: isrc }] });
		}
		// Two recordings of one ISRC: the ISRC's holder keeps the id and the copy
		// folds into it.
		const twins: { r: (typeof batch)[number]; holder: string; isrc: string }[] = [];
		await withSystemTx(deps.db, async (tx) => {
			const ingester = new Ingester(tx, { reason: 'enrichment' });
			await ingester.batch([...claims.values()], async () => {
				for (const r of batch) {
					const claim = claims.get(r.id);
					if (!claim) continue;
					const holder = await ingester.named(claim, numOrNull(r.duration_sec) ?? undefined);
					if (holder && holder.id !== r.id && holder.fits) twins.push({ r, holder: holder.id, isrc: claim.identifiers![0]!.value });
					else if (!holder || holder.id === r.id) {
						await ingester.attachIdentifiersOnly(r.id, claim);
						filled++;
					}
				}
			});
			const settled = batch.filter((r) => !twins.some((t) => t.r.id === r.id)).map((r) => r.id);
			await tx.query(`delete from curator.catalog_enrich_task where need = 'isrc' and object_id = any($1::uuid[])`, [`{${settled.join(',')}}`]);
		});
		const gone = new Map<string, string>();
		for (const { r, holder, isrc } of twins) {
			// A holder merged a moment ago answers through the one it went into.
			let into = holder;
			while (gone.has(into)) into = gone.get(into)!;
			await withSystemTx(deps.db, async (tx) => {
				// The gap is closed first: the merge carries the recording's tasks
				// onto the ISRC's holder, which has its ISRC already.
				await tx.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'isrc'`, [r.id]);
				if (into === r.id) return;
				await mergeObjects(tx, r.id, into, 'worker', 'same ISRC after the Spotify fill', { isrc });
				gone.set(r.id, into);
				merged++;
			});
		}
	}
	if (attempted) deps.log.info('isrc_fill_pass', { attempted, filled, merged });
	return { attempted, filled, merged };
}

async function recordAttempt(db: Db, objectId: string, provider: string, attempts: number, error: string): Promise<void> {
	// Waiting for releases is not a failed attempt: retry in an hour.
	const hours = error === 'no_known_releases' ? 1 : 24 * RETRY_DAYS[Math.min(attempts, RETRY_DAYS.length - 1)]!;
	await db.query(
		`insert into curator.catalog_enrich_task (object_id, need, provider, next_due_at, attempts, last_error)
		values ($1, 'representation', $2, now() + make_interval(hours => $3::int), 1, $4)
		on conflict (object_id, need, provider) do update set next_due_at = excluded.next_due_at,
			attempts = curator.catalog_enrich_task.attempts + case when $4 = 'no_known_releases' then 0 else 1 end, last_error = excluded.last_error`,
		[objectId, provider, String(hours), error],
	);
}
