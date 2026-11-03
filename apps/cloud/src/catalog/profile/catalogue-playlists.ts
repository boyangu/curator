// A label's catalogue playlists on Spotify: "STEYOYOKE RECORDINGS" (376
// tracks) and "STEYOYOKE BLACK" (167), kept by whoever runs the label's
// Spotify — here not the label's own account but `-MK-` (2026-10-28). Each
// lists the label's releases track by track, with Spotify ids and ISRCs:
// read with the app's own token, 100 tracks a call, they give the label's
// whole catalogue its Spotify ids in a handful of calls, where searching
// each track by ISRC would take thousands. Kept as the label's Spotify
// tracker afterwards (spotify-app.ts pollLabel): what a catalogue playlist
// gains is what the label released.
//
// The step (`catalogue_playlists` enrich task, queued by the profiler, by
// `label refresh` and by `label link <playlist url>`) runs once the label's
// profile and backfills are done, unless it already has a catalogue
// playlist to read:
//   1. search `type=playlist` for the label's name and a few catalogue
//      wordings; candidates whose name contains the label's;
//   2. read each candidate's first page (and its last, for the newest
//      addition) and the sampled albums' own `label` from Spotify, then
//      measure how the playlist correlates with what else is known of the
//      label: the share of albums Spotify files under the label's name, the
//      share of tracks by the label's known artists (roster and credits),
//      the overlap with releases the catalogue already holds, and whether
//      the playlist gained anything in the past year;
//   3. one strong candidate is the catalogue; two or more go to the operator
//      as one review (`review decide … attach:<n>`, the other by `label
//      link`); a middle band — a strong list nobody updates any more, a
//      fan's selection — is a review too; a curator's "tracks of the month"
//      mixing labels lands under it and is dropped;
//   4. read every page of each catalogue playlist and ingest its tracks as
//      Spotify releases (reason 'enrichment', no events), tied to the label,
//      each with the label Spotify names for it.

import type { CatalogClaim } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../../db/db.js';
import { num } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { objectReleases, openReview, type ReviewCandidate } from '../admin.js';
import { addEdge, ingestClaims, linkReleasesToLabel } from '../ingest.js';
import { fetchAlbumLabels, readPlaylistItems, releaseClaimFromTrack, trackOf, type SpotifyAppTracker, type SpPlaylistTrack } from '../trackers/spotify-app.js';
import { TrackerRateLimitedError } from '../trackers/types.js';
import { ensureCursors } from '../watches.js';

const QUERIES = (name: string) => [...new Set([name, labelCore(name), `${labelCore(name)} recordings`, `${labelCore(name)} all releases`])];
const MAX_CANDIDATES = 6;
// Albums whose label is read per candidate: two calls.
const SAMPLE_ALBUMS = 40;
// A catalogue playlist nobody has added to in a year is a list, not a feed.
const FRESH_DAYS = 365;
const RETRY_HOURS = [6, 24, 72];
// Four searches, then per candidate two pages and two album calls.
const CALLS_PER_LABEL = 40;

type Known = { isrcs: Set<string>; titles: Map<string, Set<string>>; artists: Set<string>; releases: number };
type Candidate = { id: string; name: string; owner: string; url: string; total: number | null };
export type Signals = { sampled: number; fresh: boolean; labelShare: number; artistShare: number; overlap: number; knownArtists: number };
export type Verdict = { candidate: Candidate; signals: Signals; newestAddedAt: string | null; sample: string[]; outcome: 'accept' | 'review' | 'reject' };

// What the catalogue knows of the label: its releases (tied by edge, or
// naming it as their label) with their titles, artists and recordings'
// ISRCs, and its artists — the roster, and whoever is credited on those
// releases.
async function knownCatalogue(tx: Queryable, label: { id: string; name: string }): Promise<Known> {
	const rows = await tx.query<{ id: string; name_fold: string; artists: string | null; isrcs: string | null }>(
		`with r as (
			select o.id, o.name_fold from curator.catalog_object o
			where o.kind = 'release' and o.merged_into is null
				and (exists (select 1 from curator.catalog_edge e where e.src = o.id and e.kind = 'release-label' and e.dst = $1)
					or lower(o.label_text) = lower($2))
		)
		select r.id, r.name_fold,
			(select string_agg(a.name_fold, '|') from curator.catalog_edge ar join curator.catalog_object a on a.id = ar.src where ar.dst = r.id and ar.kind = 'artist-release') as artists,
			(select string_agg(i.value, '|') from curator.catalog_edge rr join curator.catalog_identifier i on i.object_id = rr.dst and i.namespace = 'isrc' where rr.src = r.id and rr.kind = 'release-recording') as isrcs
		from r`,
		[label.id, label.name],
	);
	const roster = await tx.query<{ name_fold: string }>(
		`select a.name_fold from curator.catalog_edge e join curator.catalog_object a on a.id = e.dst where e.src = $1 and e.kind = 'label-artist' and a.merged_into is null`,
		[label.id],
	);
	const known: Known = { isrcs: new Set(), titles: new Map(), artists: new Set(roster.map((r) => r.name_fold)), releases: rows.length };
	for (const r of rows) {
		for (const i of r.isrcs?.split('|') ?? []) known.isrcs.add(i.toUpperCase());
		const set = known.titles.get(r.name_fold) ?? new Set<string>();
		for (const a of r.artists?.split('|') ?? []) {
			set.add(a);
			known.artists.add(a);
		}
		known.titles.set(r.name_fold, set);
	}
	return known;
}

const artistsOf = (t: SpPlaylistTrack): string[] => [...(t.album?.artists ?? []), ...(t.artists ?? [])].map((a) => nameFold(a.name));

function matches(t: SpPlaylistTrack, known: Known): boolean {
	const isrc = t.external_ids?.isrc?.toUpperCase();
	if (isrc && known.isrcs.has(isrc)) return true;
	const artists = known.titles.get(nameFold(t.album?.name ?? ''));
	if (!artists) return false;
	return artistsOf(t).some((a) => artists.has(a));
}

// Spotify's label text is the label's own name, often with "Records" or a
// year appended; the core must be the label's — "Queen Maeve Records" is
// not Maeve.
export function labelNames(albumLabel: string, core: string): boolean {
	const l = labelCore(albumLabel);
	return l === core || (core.split(' ').length >= 2 && l.includes(core));
}

export function judge(s: Signals): Verdict['outcome'] {
	if (!s.sampled) return 'reject';
	// The label's artists are in it — or the catalogue knows none yet and
	// Spotify's own label text has to carry the whole weight.
	const artistsFit = s.artistShare >= 0.4 || (s.knownArtists === 0 && s.labelShare >= 0.8);
	if (s.sampled >= 10 && s.fresh && s.labelShare >= 0.6 && artistsFit) return 'accept';
	if (s.labelShare >= 0.3 || s.artistShare >= 0.3 || s.overlap >= 5) return 'review';
	return 'reject';
}

// A label's name without the words that only say it is a label: "Northfold
// Records" keeps a playlist called "NORTHFOLD RECORDINGS". What the core
// lets through, the correlation check judges.
const LABEL_WORDS = new Set(['records', 'recordings', 'record', 'recs', 'rec', 'music', 'label', 'ltd', 'limited', 'audio', 'digital', 'productions', 'the']);
export function labelCore(name: string): string {
	const words = nameFold(name).split(' ').filter(Boolean);
	const core = words.filter((w, i) => !(LABEL_WORDS.has(w) && (i > 0 || words.length > 1)));
	return (core.length ? core : words).join(' ');
}

async function search(app: SpotifyAppTracker, name: string, signal: AbortSignal): Promise<{ candidates: Candidate[]; calls: number }> {
	const want = labelCore(name);
	const out = new Map<string, Candidate>();
	let calls = 0;
	for (const q of QUERIES(name)) {
		// Search is capped at 10 results for Development Mode apps.
		const r = await app.get<{ playlists?: { items: ({ id: string; name: string; owner?: { display_name?: string; id?: string }; external_urls?: { spotify?: string }; tracks?: { total?: number }; items?: { total?: number } } | null)[] } }>(
			`/search?type=playlist&limit=10&q=${encodeURIComponent(q)}`,
			signal,
		);
		calls++;
		for (const p of r.playlists?.items ?? []) {
			if (!p || out.has(p.id) || !nameFold(p.name).includes(want)) continue;
			out.set(p.id, {
				id: p.id,
				name: p.name,
				owner: p.owner?.display_name ?? p.owner?.id ?? '',
				url: p.external_urls?.spotify ?? `https://open.spotify.com/playlist/${p.id}`,
				total: p.tracks?.total ?? p.items?.total ?? null,
			});
		}
	}
	// Biggest first: a label's all-releases playlist is its longest.
	return { candidates: [...out.values()].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, MAX_CANDIDATES), calls };
}

type Page = Awaited<ReturnType<typeof readPlaylistItems>>;
const newestOf = (pages: Page[]): string | null => pages.flatMap((p) => p.entries.map((e) => e.added_at ?? '')).reduce<string | null>((m, a) => (a && (!m || a > m) ? a : m), null);

// One candidate measured: its first page (and last, for the newest
// addition), the sampled albums' labels, and the four signals.
async function measure(app: SpotifyAppTracker, c: Candidate, label: { name: string }, known: Known, now: number, signal: AbortSignal): Promise<{ verdict: Verdict; first: Page; labels: Map<string, string> }> {
	const first = await readPlaylistItems(app, c.id, signal, { maxPages: 1 });
	const tracks = first.entries.map(trackOf).filter((x): x is SpPlaylistTrack => !!x);
	const albumIds = [...new Set(tracks.map((t) => t.album?.id).filter((id): id is string => !!id))].slice(0, SAMPLE_ALBUMS);
	const { labels } = await fetchAlbumLabels(app, albumIds, signal);
	const pages = [first];
	if (first.total !== null && first.total > first.entries.length) pages.push(await readPlaylistItems(app, c.id, signal, { maxPages: 1, offset: Math.max(0, first.total - 100) }));
	const newestAddedAt = newestOf(pages);
	const core = labelCore(label.name);
	const signals: Signals = {
		sampled: tracks.length,
		fresh: newestAddedAt !== null && Date.parse(newestAddedAt) >= now - FRESH_DAYS * 86400_000,
		labelShare: albumIds.length ? albumIds.filter((id) => labelNames(labels.get(id) ?? '', core)).length / albumIds.length : 0,
		artistShare: tracks.length ? tracks.filter((t) => artistsOf(t).some((a) => known.artists.has(a))).length / tracks.length : 0,
		overlap: tracks.filter((t) => matches(t, known)).length,
		knownArtists: known.artists.size,
	};
	const sample = [...new Set(tracks.map((x) => x.album?.name ?? x.name))].slice(0, 25);
	return { verdict: { candidate: c, signals, newestAddedAt, sample, outcome: judge(signals) }, first, labels };
}

const candidateOf = (v: Verdict): ReviewCandidate => ({
	provider: 'spotify',
	providerId: v.candidate.id,
	name: v.candidate.name,
	url: v.candidate.url,
	releases: v.sample,
	evidence: { owner: v.candidate.owner, total: v.candidate.total, newestAddedAt: v.newestAddedAt, ...v.signals },
});

const pct = (x: number) => `${Math.round(x * 100)} %`;
function reasonFor(strong: Verdict[], band: Verdict[]): string {
	if (strong.length >= 2) return `${strong.length} playlists look like the label's — attach one; the other can be linked by hand`;
	const v = band[0]!;
	if (v.signals.labelShare >= 0.6 && !v.signals.fresh) return `strong match but last updated ${v.newestAddedAt?.slice(0, 10) ?? 'never'}`;
	return `label ${pct(v.signals.labelShare)}, artists ${pct(v.signals.artistShare)}, overlap ${v.signals.overlap} of ${v.signals.sampled}`;
}

// Playlists the operator has seen for this label, in a review open or
// decided: never judged again by the step, never attached on its own.
async function reviewedPlaylists(tx: Queryable, labelId: string): Promise<Set<string>> {
	const rows = await tx.query<{ id: string }>(
		`select c->>'providerId' as id from curator.catalog_review r, jsonb_array_elements(r.candidates) c
		where r.object_id = $1 and r.kind = 'label_playlist' and c->>'provider' = 'spotify'`,
		[labelId],
	);
	return new Set(rows.map((r) => r.id));
}

// The playlist made a catalogue playlist of the label: its object, the edge
// (role 'catalogue') with its Spotify representation as evidence, and the
// label's Spotify tracker if the label is watched.
export async function acceptCataloguePlaylist(tx: Queryable, labelId: string, p: { id: string; name: string; url?: string | null }): Promise<string> {
	const claim: CatalogClaim = { provider: 'spotify', kind: 'playlist', providerId: p.id, name: p.name, url: p.url ?? `https://open.spotify.com/playlist/${p.id}` };
	const playlistId = (await ingestClaims(tx, [claim], { reason: 'enrichment' })).outcomes[0]!.objectId;
	const [rep] = await tx.query<{ id: string }>(`select id from curator.catalog_source_object where provider = 'spotify' and kind = 'playlist' and provider_id = $1`, [p.id]);
	await addEdge(tx, labelId, 'label-playlist', playlistId, rep!.id, 'catalogue');
	// An edge from before the role existed keeps its null on conflict.
	await tx.query(`update curator.catalog_edge set role = 'catalogue' where src = $1 and kind = 'label-playlist' and dst = $2 and role is null`, [labelId, playlistId]);
	await ensureCursors(tx, labelId);
	return playlistId;
}

// The step queued (again) for a label: new candidates searched, every
// catalogue playlist read in full.
export async function queueCataloguePlaylists(tx: Queryable, labelId: string): Promise<void> {
	await tx.query(
		`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'catalogue_playlists', 'spotify')
		on conflict (object_id, need, provider) do update set next_due_at = now(), attempts = 0, last_error = null`,
		[labelId],
	);
}

// Every track of a catalogue playlist as a Spotify release of the label,
// each with the label Spotify files its album under.
async function fill(
	deps: { db: Db; app: SpotifyAppTracker },
	label: { id: string; name: string },
	playlistSpotifyId: string,
	signal: AbortSignal,
	had: { first?: Page; labels?: Map<string, string> } = {},
): Promise<{ calls: number; releases: number }> {
	const first = had.first;
	const read = first && first.total !== null && first.entries.length >= first.total ? first : await readPlaylistItems(deps.app, playlistSpotifyId, signal);
	let calls = read === first ? 0 : read.calls;
	const tracks = read.entries.map(trackOf).filter((x): x is SpPlaylistTrack => !!x);
	const labels = new Map(had.labels ?? []);
	const missing = tracks.map((t) => t.album?.id).filter((id): id is string => !!id && !labels.has(id));
	const more = await fetchAlbumLabels(deps.app, missing, signal);
	calls += more.calls;
	for (const [id, l] of more.labels) labels.set(id, l);
	const byAlbum = new Map<string, CatalogClaim>();
	for (const t of tracks) {
		const claim = releaseClaimFromTrack(t, t.album?.id ? labels.get(t.album.id) : undefined);
		if (!claim) continue;
		const had = byAlbum.get(claim.providerId);
		// Two tracks of one release: one claim carrying both.
		if (had) had.recordings = [...(had.recordings ?? []), ...(claim.recordings ?? [])];
		else byAlbum.set(claim.providerId, claim);
	}
	const claims = [...byAlbum.values()];
	for (let i = 0; i < claims.length; i += 50) {
		const batch = claims.slice(i, i + 50);
		await withSystemTx(deps.db, async (tx) => {
			const r = await ingestClaims(tx, batch, { reason: 'enrichment' });
			await linkReleasesToLabel(tx, label.id, r.outcomes.map((o, k) => ({ objectId: o.objectId, claim: batch[k]! })));
		});
	}
	return { calls, releases: claims.length };
}

export type CatalogueDeps = { db: Db; log: Logger; spotify: SpotifyAppTracker | null; holder: string; batch?: number; now?: () => number };

export async function runCataloguePlaylists(deps: CatalogueDeps): Promise<{ attempted: number; accepted: number; reviews: number; releases: number }> {
	const stats = { attempted: 0, accepted: 0, reviews: 0, releases: 0 };
	if (!deps.spotify) return stats;
	const app = deps.spotify;
	const now = deps.now ?? Date.now;
	// After the label's profile and backfills: they tell the catalogue what
	// the label released, which the candidates are judged against. One parked
	// hours away (a provider's challenge, retried indefinitely) is not waited
	// for. A label that already has a catalogue playlist (linked by hand,
	// say) has it read without waiting.
	const due = await deps.db.query<{ object_id: string; name: string; attempts: unknown }>(
		`update curator.catalog_enrich_task et set lease_holder = $1, lease_until = now() + interval '10 minutes'
		from (
			select t.object_id from curator.catalog_enrich_task t
			where t.need = 'catalogue_playlists' and t.provider = 'spotify' and t.next_due_at <= now() and (t.lease_until is null or t.lease_until < now())
				and (exists (select 1 from curator.catalog_edge e where e.src = t.object_id and e.kind = 'label-playlist' and e.role = 'catalogue')
					or not exists (select 1 from curator.catalog_enrich_task o where o.object_id = t.object_id and o.need in ('profile', 'backfill') and o.next_due_at <= now() + interval '1 hour'))
			order by t.next_due_at limit $2::int
			for update skip locked
		) d, curator.catalog_object o
		where et.object_id = d.object_id and et.need = 'catalogue_playlists' and et.provider = 'spotify' and o.id = et.object_id
		returning et.object_id, o.name, et.attempts`,
		[deps.holder, String(deps.batch ?? 5)],
	);
	for (const t of due) {
		const [g] = await deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls('spotify', $1::int, 40000) as n`, [String(CALLS_PER_LABEL)]);
		if (num(g!.n) < CALLS_PER_LABEL) {
			await deps.db.query(`update curator.catalog_enrich_task set lease_holder = null, lease_until = null where object_id = $1 and need = 'catalogue_playlists'`, [t.object_id]);
			break;
		}
		stats.attempted++;
		const label = { id: t.object_id, name: t.name };
		const signal = AbortSignal.timeout(120_000);
		try {
			const { known, catalogue, reviewed } = await withSystemTx(deps.db, async (tx) => {
				const existing = await tx.query<{ provider_id: string }>(
					`select so.provider_id from curator.catalog_edge e join curator.catalog_source_object so on so.object_id = e.dst and so.provider = 'spotify' and so.kind = 'playlist'
					where e.src = $1 and e.kind = 'label-playlist' and e.role = 'catalogue'`,
					[label.id],
				);
				return { known: await knownCatalogue(tx, label), catalogue: new Set(existing.map((r) => r.provider_id)), reviewed: await reviewedPlaylists(tx, label.id) };
			});
			const { candidates } = await search(app, label.name, signal);
			const verdicts: Verdict[] = [];
			const measured = new Map<string, { first: Page; labels: Map<string, string> }>();
			for (const c of candidates) {
				if (catalogue.has(c.id) || reviewed.has(c.id)) continue;
				const m = await measure(app, c, label, known, now(), signal);
				verdicts.push(m.verdict);
				measured.set(c.id, m);
			}
			const strong = verdicts.filter((v) => v.outcome === 'accept');
			const band = verdicts.filter((v) => v.outcome === 'review');
			await withSystemTx(deps.db, async (tx) => {
				if (strong.length === 1) {
					await acceptCataloguePlaylist(tx, label.id, strong[0]!.candidate);
					catalogue.add(strong[0]!.candidate.id);
					stats.accepted++;
				}
				// Several strong: the operator picks. The middle band is asked
				// about either way.
				const asked = strong.length >= 2 ? [...strong, ...band] : band;
				if (asked.length) {
					const mine = (await objectReleases(tx, label.id, 15)).map((r) => r.title);
					const opened = await openReview(tx, {
						kind: 'label_playlist',
						objectId: label.id,
						candidates: asked.map(candidateOf),
						evidence: { knownReleases: known.releases, knownArtists: known.artists.size, releases: mine, reason: reasonFor(strong, band) },
					});
					if (opened !== null) stats.reviews++;
				}
			});
			for (const id of catalogue) stats.releases += (await fill({ db: deps.db, app }, label, id, signal, measured.get(id) ?? {})).releases;
			await deps.db.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'catalogue_playlists' and provider = 'spotify'`, [label.id]);
			deps.log.info('catalogue_playlists', {
				label: label.id,
				name: label.name,
				known: known.releases,
				verdicts: verdicts.map((v) => `${v.candidate.name}: label ${pct(v.signals.labelShare)} artists ${pct(v.signals.artistShare)} overlap ${v.signals.overlap}/${v.signals.sampled} ${v.signals.fresh ? 'fresh' : 'stale'} ${v.outcome}`),
				catalogue: catalogue.size,
			});
		} catch (e) {
			const limited = e instanceof TrackerRateLimitedError;
			const hours = limited ? Math.max(1, Math.ceil(e.retryAfterSec / 3600)) : RETRY_HOURS[Math.min(num(t.attempts), RETRY_HOURS.length - 1)]!;
			await deps.db.query(
				`update curator.catalog_enrich_task set next_due_at = now() + make_interval(hours => $2::int), attempts = attempts + $3::int, last_error = $4, lease_holder = null, lease_until = null
				where object_id = $1 and need = 'catalogue_playlists' and provider = 'spotify'`,
				[label.id, String(hours), limited ? '0' : '1', e instanceof Error ? e.message.slice(0, 300) : 'error'],
			);
			deps.log.warn('catalogue_playlists_failed', { label: label.id, limited, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
			if (limited) break;
		}
	}
	if (stats.attempted) deps.log.info('catalogue_playlists_pass', stats);
	return stats;
}
