// The enrichment planner's first job: give a watched object an id on every
// provider that tracks its kind, so each of those trackers can follow it. A
// followed artist imported from Spotify has only a Spotify id; Deezer's
// artist tracker needs a Deezer one.
//
// A provider's candidate is accepted only with evidence beyond its name: the
// same name (folded) AND at least one of the object's known releases among
// the candidate's own, and exactly one candidate qualifying. With no known
// releases yet the attempt waits (the object's other tracker brings some in
// on its first poll). Attempts back off per object and provider through
// catalog_enrich_task, so a namesake-only artist is not searched every pass.

import type { CatalogClaim, CatalogKind, CatalogProvider } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db } from '../db/db.js';
import { num, numOrNull } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import type { Logger } from '../log.js';
import { openReview, ruledNotSame } from './admin.js';
import { reannounceFor } from './events.js';
import { findRepresentation } from './identity.js';
import { Ingester } from './ingest.js';
import { ensureCursors } from './watches.js';
import { getJson, type FetchLike } from './trackers/http.js';
import { releaseClaim as spotifyReleaseClaim, type SpotifyAppTracker } from './trackers/spotify-app.js';
import { TrackerRateLimitedError } from './trackers/types.js';

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
	const qualifying: (typeof candidates)[number][] = [];
	const seen: FindCandidate[] = [];
	for (const c of candidates.slice(0, 3)) {
		const titles = await releasesOf(c.id);
		calls++;
		seen.push({ ...c, releases: titles.slice(0, 15) });
		if (titles.some((t) => releaseTitles.has(nameFold(t)))) qualifying.push(c);
	}
	if (qualifying.length !== 1) return { hit: null, calls, reason: qualifying.length ? 'ambiguous' : 'no_overlap', candidates: seen };
	return { hit: qualifying[0]!, calls, candidates: [] };
}

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
		const candidates = (s.data ?? []).filter((a) => nameFold(a.name) === want).map((a) => ({ id: String(a.id), name: a.name, url: a.link ?? `https://www.deezer.com/artist/${a.id}` }));
		const r = await confirm(candidates, releaseTitles, async (id) => {
			const l = await getJson<{ data?: { title: string }[] }>(this.fetchFn, 'deezer', `https://api.deezer.com/artist/${id}/albums?limit=100`, { signal, logPath: '/artist/albums' });
			return (l.data ?? []).map((x) => x.title);
		});
		return { claim: r.hit ? { provider: 'deezer', kind: 'artist', providerId: r.hit.id, name: r.hit.name, url: r.hit.url } : null, calls: 1 + r.calls, reason: r.reason, candidates: r.candidates };
	}
}

export class SpotifyFinder implements IdentityFinder {
	readonly provider = 'spotify' as const;
	readonly kinds: readonly CatalogKind[] = ['artist'];
	readonly callsPerFind = 4;
	constructor(private readonly app: SpotifyAppTracker) {}

	async find(object: { name: string }, releaseTitles: Set<string>, signal: AbortSignal): Promise<FindResult> {
		const want = nameFold(object.name);
		// Search is capped at 10 results for Development Mode apps.
		const s = await this.app.get<{ artists?: { items: { id: string; name: string; external_urls?: { spotify?: string } }[] } }>(
			`/search?type=artist&limit=10&q=${encodeURIComponent(object.name)}`,
			signal,
		);
		const candidates = (s.artists?.items ?? [])
			.filter((a) => nameFold(a.name) === want)
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
				await ensureCursors(tx, o.id);
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
// it has one. Spotify's search takes `isrc:` (one call a track, within the
// app's budget); the hit must carry the same ISRC and a length within ten
// seconds of ours (an ISRC reused across an edit and an extended mix). The
// track's album gives its release the Spotify id too, and every event about
// either is re-announced with the new handles (events.ts reannounceFor).
// Queued by ingestion for a tracker's new recordings (ingest.ts recordGaps)
// and by the sweep for charted ones.

export type ResolverDeps = { db: Db; log: Logger; spotify: SpotifyAppTracker; batch?: number; perDay?: number };

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
	for (const r of due) {
		const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls('spotify', 1, $1::int) as n`, [String(deps.perDay ?? 20_000)]);
		if (num(g!.n) < 1) break;
		attempted++;
		try {
			const s = await deps.spotify.get<{ tracks?: { items: SpSearchTrack[] } }>(`/search?type=track&limit=5&q=${encodeURIComponent(`isrc:${r.isrc}`)}`, AbortSignal.timeout(20_000));
			const ours = numOrNull(r.duration_sec);
			const hit = (s.tracks?.items ?? []).find((t) => {
				if ((t.external_ids?.isrc ?? '').toUpperCase() !== r.isrc.toUpperCase()) return false;
				return ours === null || t.duration_ms === undefined || Math.abs(t.duration_ms / 1000 - ours) <= 10;
			});
			if (!hit) {
				await recordAttempt(deps.db, r.id, 'spotify', num(r.attempts), 'not_found');
				continue;
			}
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
				// The release the track sits on, if it has no Spotify id yet.
				const [rel] = await tx.query<{ id: string }>(
					`select e.src as id from curator.catalog_edge e where e.dst = $1 and e.kind = 'release-recording'
					and not exists (select 1 from curator.catalog_source_object so where so.object_id = e.src and so.provider = 'spotify') limit 1`,
					[r.id],
				);
				if (rel && hit.album) {
					const albumOwner = await findRepresentation(tx, { provider: 'spotify', kind: 'release', providerId: hit.album.id });
					if (!albumOwner || albumOwner === rel.id) {
						await ingester.attachTo(rel.id, spotifyReleaseClaim(hit.album));
						await reannounceFor(tx, rel.id);
					}
				}
				await reannounceFor(tx, r.id);
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
