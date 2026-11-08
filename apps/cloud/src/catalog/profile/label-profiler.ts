// A watched label's profile: once, when it is first watched, the catalogue
// looks the label up everywhere it can reach and attaches what it finds as
// representations, so the trackers that need an id on their provider
// (Beatport's label pages, Bandcamp's band, later YouTube's channel and
// SoundCloud's uploads) can follow it, and the panel can show its pages
// (Instagram, its website: links only).
//
// Where the pages come from, in order:
//   1. MusicBrainz: label search by name, then its url relations (free, one
//      request a second). On the 2026-10-26 sample 16 of 20 labels carried
//      links: Beatport 16, YouTube 12, SoundCloud 11, Bandcamp 10, Instagram 10.
//   2. Discogs: label search, then its urls (unauthenticated, a request every
//      two seconds); its ids carry a " (2)" suffix for namesakes, dropped
//      before matching.
//   3. Beatport's own label search page (beatport-pages.ts).
//   4. Bandcamp: the band id read off the label's page, then its band details
//      (sites, roster handled by the tracker).
//   5. The label's homepage, for the links the lists lacked.
//   6. SoundCloud's profile page, for the numeric id its API takes.
// Then, once its releases are read (backfills), its Spotify catalogue
// playlists (catalogue-playlists.ts): found by search, kept by overlap.
//
// A match is by folded name, and only when exactly one candidate folds to
// it — a label is never attached by a loose search hit (identity.ts). A page
// another label already owns is left alone and logged: an operator's merge,
// not this pass's. Failures back off per label (a day, three, a week). A
// source that rate-limits (Beatport's Cloudflare challenge parks six hours)
// parks only itself: the other sources still run, the profile completes,
// and it is queued again for when that source may answer.

import type { CatalogProvider } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../../db/db.js';
import { num } from '../../db/db.js';
import { withSystemTx } from '../../db/system-tx.js';
import type { Logger } from '../../log.js';
import { objectReleases, openReview, ruledNotSame, type ReviewCandidate } from '../admin.js';
import { enqueueCase } from '../agent/cases.js';
import { findRepresentation } from '../identity.js';
import { Ingester } from '../ingest.js';
import { ensureCursors } from '../watches.js';
import { BROWSER_USER_AGENT, fetchNextData, queryData } from '@curator/catalog-readers';
import { getJson, type FetchLike } from '@curator/catalog-readers';
import type { SpotifyTracker } from '@curator/catalog-readers';
import { TrackerRateLimitedError } from '@curator/catalog-readers';
import { classifyUrl, extractLinks, websiteLink, type PageLink } from './links.js';

export type ProfilerDeps = {
	db: Db;
	log: Logger;
	fetch?: FetchLike;
	spotify?: SpotifyTracker | null;
	// Which page-reading providers this worker runs (their trackers' switches).
	providers?: { beatport?: boolean; bandcamp?: boolean };
	batch?: number;
	sleep?: (ms: number) => Promise<void>;
};

const API_USER_AGENT = 'curator-catalog/0.1 (+https://github.com/boyangu/curator)';
// The providers whose label listing a backfill reads (release listings, not
// uploads: a channel's videos are announcements, not catalogue).
export const BACKFILL_PROVIDERS = ['beatport', 'bandcamp', 'deezer'] as const;
const RETRY_DAYS = [1, 3, 7];
const MB_GAP_MS = 1100;
const DISCOGS_GAP_MS = 2100;

type Found = {
	links: Map<string, PageLink>;
	identifiers: { namespace: 'mbid_label' | 'discogs_label'; value: string }[];
	// What a source could not settle: namesakes, or near names and no exact
	// one. Opened as reviews for the back office (admin.ts).
	reviews: ReviewCandidate[][];
	// A page the label already had by its slug, now known by the id its
	// provider's API takes: the representation is re-pointed, not doubled.
	resolved: { provider: CatalogProvider; from: string; to: string; url: string }[];
};

// Bandcamp's page link names the band by subdomain; its API by band id,
// which the /music page carries in its links.
export async function resolveBandcampBand(fetchFn: FetchLike, url: string, signal: AbortSignal): Promise<{ id: string; sites: string[] } | null> {
	const page = await htmlOf(fetchFn, `${url.replace(/\/$/, '')}/music`, signal);
	const id = page && /[?&]label=(\d+)/.exec(page)?.[1];
	if (!id) return null;
	const band = await getJson<{ sites?: { url: string }[] }>(fetchFn, 'bandcamp', `https://bandcamp.com/api/mobile/24/band_details?band_id=${id}`, { headers: { 'user-agent': API_USER_AGENT }, signal, logPath: '/api/mobile/24/band_details' }).catch(() => ({ sites: [] }));
	return { id, sites: (band.sites ?? []).map((s) => s.url) };
}

// SoundCloud's profile page carries the numeric id its API takes.
export async function resolveSoundcloudUser(fetchFn: FetchLike, url: string, signal: AbortSignal): Promise<string | null> {
	const page = await htmlOf(fetchFn, url, signal);
	const hydration = page && /window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);<\/script>/.exec(page)?.[1];
	if (!hydration) return null;
	try {
		const user = (JSON.parse(hydration) as { hydratable: string; data?: { id?: number } }[]).find((e) => e.hydratable === 'user')?.data;
		return user?.id ? String(user.id) : null;
	} catch {
		return null;
	}
}

async function htmlOf(fetchFn: FetchLike, url: string, signal: AbortSignal): Promise<string | null> {
	try {
		const res = await fetchFn(url, { headers: { 'user-agent': BROWSER_USER_AGENT, accept: 'text/html' }, signal });
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
}

const keyOf = (l: PageLink) => `${l.provider}:${l.kind}:${l.id}`;
const add = (found: Found, l: PageLink | null): void => {
	if (!l) return;
	// One page per provider: the first source to name it wins (the lists are
	// curated; a homepage's links come last).
	if ([...found.links.values()].some((x) => x.provider === l.provider && x.kind === l.kind)) return;
	found.links.set(keyOf(l), l);
};
// The one candidate whose name folds to the label's, or null — and, when
// there is no such one, the candidates worth a reviewer's look: several
// exact namesakes, or near names (one contains the other) with no exact.
const uniqueFold = <T>(items: T[], name: (t: T) => string, want: string, found?: Found, toCandidate?: (t: T) => ReviewCandidate): T | null => {
	const hits = items.filter((i) => nameFold(name(i)) === want);
	if (hits.length === 1) return hits[0]!;
	if (found && toCandidate) {
		const near = hits.length ? hits : items.filter((i) => {
			const f = nameFold(name(i));
			return f.length >= 4 && want.length >= 4 && (f.includes(want) || want.includes(f));
		});
		if (near.length) found.reviews.push(near.slice(0, 5).map(toCandidate));
	}
	return null;
};

export class LabelProfiler {
	private readonly fetchFn: FetchLike;
	private readonly sleep: (ms: number) => Promise<void>;
	constructor(private readonly deps: ProfilerDeps) {
		this.fetchFn = deps.fetch ?? ((u, i) => fetch(u, i));
		this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	private json<T>(provider: string, url: string, signal: AbortSignal): Promise<T> {
		return getJson<T>(this.fetchFn, provider, url, { headers: { 'user-agent': API_USER_AGENT }, signal, logPath: new URL(url).pathname.replace(/\d{3,}|[0-9a-f-]{36}/g, '<id>') });
	}

	private html(url: string, signal: AbortSignal): Promise<string | null> {
		return htmlOf(this.fetchFn, url, signal);
	}

	private async reserve(provider: string, n: number, cap: number): Promise<boolean> {
		const [g] = await this.deps.db.query<{ n: unknown }>(`select curator.catalog_reserve_calls($1, $2::int, $3::int) as n`, [provider, String(n), String(cap)]);
		return num(g!.n) >= n;
	}

	async musicbrainz(name: string, found: Found, signal: AbortSignal): Promise<void> {
		if (!(await this.reserve('musicbrainz', 2, 2000))) return;
		const want = nameFold(name);
		const s = await this.json<{ labels?: { id: string; name: string; score?: number }[] }>('musicbrainz', `https://musicbrainz.org/ws/2/label?query=${encodeURIComponent(`label:"${name.replace(/"/g, '')}"`)}&fmt=json&limit=10`, signal);
		const hit = uniqueFold(s.labels ?? [], (l) => l.name, want, found, (l) => ({ provider: 'musicbrainz', providerId: l.id, name: l.name, url: `https://musicbrainz.org/label/${l.id}` }));
		if (!hit) return;
		await this.sleep(MB_GAP_MS);
		const l = await this.json<{ relations?: { type: string; url?: { resource: string } }[] }>('musicbrainz', `https://musicbrainz.org/ws/2/label/${hit.id}?inc=url-rels&fmt=json`, signal);
		found.identifiers.push({ namespace: 'mbid_label', value: hit.id });
		add(found, { provider: 'musicbrainz', kind: 'label', id: hit.id, url: `https://musicbrainz.org/label/${hit.id}` });
		for (const r of l.relations ?? []) {
			const u = r.url?.resource;
			if (!u) continue;
			add(found, classifyUrl(u) ?? (r.type === 'official homepage' ? websiteLink(u) : null));
		}
	}

	async discogs(name: string, found: Found, signal: AbortSignal): Promise<void> {
		if (!(await this.reserve('discogs', 2, 800))) return;
		const want = nameFold(name);
		const s = await this.json<{ results?: { id: number; title: string; type: string }[] }>('discogs', `https://api.discogs.com/database/search?type=label&q=${encodeURIComponent(name)}&per_page=10`, signal);
		const hit = uniqueFold((s.results ?? []).filter((r) => r.type === 'label'), (r) => r.title.replace(/\s\(\d+\)$/, ''), want, found, (r) => ({ provider: 'discogs', providerId: String(r.id), name: r.title, url: `https://www.discogs.com/label/${r.id}` }));
		if (!hit) return;
		await this.sleep(DISCOGS_GAP_MS);
		const l = await this.json<{ urls?: string[] }>('discogs', `https://api.discogs.com/labels/${hit.id}`, signal);
		found.identifiers.push({ namespace: 'discogs_label', value: String(hit.id) });
		add(found, { provider: 'discogs', kind: 'label', id: String(hit.id), url: `https://www.discogs.com/label/${hit.id}` });
		for (const u of l.urls ?? []) add(found, classifyUrl(u) ?? websiteLink(u));
	}

	async beatport(name: string, found: Found, signal: AbortSignal): Promise<void> {
		if (!(await this.reserve('beatport', 1, 3000))) return;
		const data = await fetchNextData(this.fetchFn, `/search/labels?q=${encodeURIComponent(name)}`, signal);
		const list = queryData<{ data?: { label_id: number; label_name: string }[] }>(data, (k) => k === 'search-labels')?.data ?? [];
		const hit = uniqueFold(list, (l) => l.label_name, nameFold(name), found, (l) => ({ provider: 'beatport', providerId: String(l.label_id), name: l.label_name, url: `https://www.beatport.com/label/label/${l.label_id}` }));
		if (hit) add(found, { provider: 'beatport', kind: 'label', id: String(hit.label_id), url: `https://www.beatport.com/label/label/${hit.label_id}` });
	}

	async bandcamp(found: Found, signal: AbortSignal): Promise<void> {
		const link = [...found.links.values()].find((l) => l.provider === 'bandcamp');
		if (!link || /^\d+$/.test(link.id) || !(await this.reserve('bandcamp', 2, 2000))) return;
		const band = await resolveBandcampBand(this.fetchFn, link.url, signal);
		found.links.delete(keyOf(link));
		if (!band) return;
		found.links.set(`bandcamp:label:${band.id}`, { provider: 'bandcamp', kind: 'label', id: band.id, url: link.url });
		found.resolved.push({ provider: 'bandcamp', from: link.id, to: band.id, url: link.url });
		for (const s of band.sites) add(found, classifyUrl(s) ?? websiteLink(s));
	}

	async homepage(found: Found, signal: AbortSignal): Promise<void> {
		const site = [...found.links.values()].find((l) => l.provider === 'website');
		if (!site) return;
		const page = await this.html(site.url, signal);
		if (!page) return;
		for (const u of extractLinks(page, site.url)) add(found, classifyUrl(u));
	}

	async soundcloud(found: Found, signal: AbortSignal): Promise<void> {
		const link = [...found.links.values()].find((l) => l.provider === 'soundcloud');
		if (!link || /^\d+$/.test(link.id)) return;
		const id = await resolveSoundcloudUser(this.fetchFn, link.url, signal);
		if (!id) return;
		found.links.delete(keyOf(link));
		found.links.set(`soundcloud:label:${id}`, { ...link, id });
		found.resolved.push({ provider: 'soundcloud', from: link.id, to: id, url: link.url });
	}

	async profile(label: { id: string; name: string }, signal: AbortSignal): Promise<{ attached: number; parked: string[] }> {
		const found: Found = { links: new Map(), identifiers: [], reviews: [], resolved: [] };
		const existing = await this.deps.db.query<{ provider: string; provider_id: string; url: string | null }>(`select provider, provider_id, url from curator.catalog_source_object where object_id = $1`, [label.id]);
		for (const e of existing) found.links.set(`${e.provider}:label:${e.provider_id}`, { provider: e.provider as CatalogProvider, kind: 'label', id: e.provider_id, url: e.url ?? '' });
		const known = new Set(found.links.keys());
		const parked: { source: string; retryAfterSec: number }[] = [];
		const step = async (name: string, run: () => Promise<void>): Promise<void> => {
			try {
				await run();
			} catch (e) {
				if (e instanceof TrackerRateLimitedError) {
					parked.push({ source: name, retryAfterSec: e.retryAfterSec });
					this.deps.log.warn('label_profile_source_parked', { label: label.id, source: name, retryAfterSec: e.retryAfterSec });
					return;
				}
				this.deps.log.warn('label_profile_source_failed', { label: label.id, source: name, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
			}
		};
		await step('musicbrainz', () => this.musicbrainz(label.name, found, signal));
		await step('discogs', () => this.discogs(label.name, found, signal));
		const has = (provider: string) => [...found.links.values()].some((l) => l.provider === provider);
		if (this.deps.providers?.beatport !== false && !has('beatport')) await step('beatport', () => this.beatport(label.name, found, signal));
		if (this.deps.providers?.bandcamp !== false) await step('bandcamp', () => this.bandcamp(found, signal));
		await step('homepage', () => this.homepage(found, signal));
		await step('soundcloud', () => this.soundcloud(found, signal));
		// Its Spotify catalogue playlists come later, once the backfills have
		// told the catalogue what the label released (catalogue-playlists.ts).

		return withSystemTx(this.deps.db, async (tx) => {
			const ingester = new Ingester(tx, { reason: 'enrichment' });
			let attached = 0;
			for (const r of found.resolved) {
				if (!known.has(`${r.provider}:label:${r.from}`)) continue;
				await repointRepresentation(tx, label.id, r);
				known.add(`${r.provider}:label:${r.to}`);
			}
			for (const [key, l] of found.links) {
				if (known.has(key) || l.kind !== 'label') continue;
				// A page a reviewer ruled not this label's stays off it.
				if (await ruledNotSame(tx, label.id, { provider: l.provider, providerId: l.id, name: label.name })) continue;
				const owner = await findRepresentation(tx, { provider: l.provider, kind: 'label', providerId: l.id });
				if (owner && owner !== label.id) {
					this.deps.log.warn('label_profile_page_owned_elsewhere', { label: label.id, provider: l.provider, id: l.id, owner });
					continue;
				}
				const ids = found.identifiers.filter((i) => (i.namespace === 'mbid_label' && l.provider === 'musicbrainz') || (i.namespace === 'discogs_label' && l.provider === 'discogs'));
				await ingester.attachTo(label.id, { provider: l.provider, kind: 'label', providerId: l.id, name: label.name, url: l.url || null, identifiers: ids });
				attached++;
			}
			// What the lookups could not settle goes to the back office, with
			// the label's own releases beside the candidates.
			if (found.reviews.length) {
				const mine = (await objectReleases(tx, label.id, 15)).map((r) => r.title);
				const opened: number[] = [];
				for (const candidates of found.reviews) {
					const id = await openReview(tx, { kind: 'label_page', objectId: label.id, candidates, evidence: { releases: mine } });
					if (id !== null) opened.push(id);
				}
				// The reasoner (catalog/agent) reads the candidates against the
				// label's releases first; what it cannot settle stays a review.
				if (opened.length) await enqueueCase(tx, { kind: 'label_pages', subjects: [label.id], input: { label: label.id, reviews: opened }, key: opened.join(',') });
			}
			await ensureCursors(tx, label.id);
			// Its releases, once, from every provider that can list them
			// (trackers/backfill.ts): what a label looks like in the catalogue
			// whether or not anyone watches it. Deezer lists by name.
			await tx.query(
				`insert into curator.catalog_enrich_task (object_id, need, provider)
				select $1, 'backfill', p from unnest($2::text[]) as p
				where p = 'deezer' or exists (select 1 from curator.catalog_source_object so where so.object_id = $1 and so.provider = p)
				on conflict do nothing`,
				[label.id, `{${BACKFILL_PROVIDERS.join(',')}}`],
			);
			// Then its Spotify catalogue playlists (catalogue-playlists.ts),
			// which wait for those backfills to finish.
			await tx.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'catalogue_playlists', 'spotify') on conflict do nothing`, [label.id]);
			// A parked source gets another look when it may answer; what the
			// rest found is kept either way.
			if (parked.length) {
				const wait = Math.max(3600, ...parked.map((p) => p.retryAfterSec));
				await tx.query(
					`update curator.catalog_enrich_task set next_due_at = now() + make_interval(secs => $2::int), last_error = $3 where object_id = $1 and need = 'profile' and provider = 'catalog'`,
					[label.id, String(wait), `parked: ${parked.map((p) => `${p.source} (${p.retryAfterSec}s)`).join(', ')}`],
				);
			} else await tx.query(`delete from curator.catalog_enrich_task where object_id = $1 and need = 'profile' and provider = 'catalog'`, [label.id]);
			return { attached, parked: parked.map((p) => p.source) };
		});
	}
}

// A page the label had by slug, now by the id its provider's API takes: the
// row is re-pointed (its evidence stays), or dropped when the label already
// has the id. One another label owns is left alone and logged by the caller.
export async function repointRepresentation(tx: Queryable, labelId: string, r: { provider: CatalogProvider; from: string; to: string; url: string }): Promise<'repointed' | 'dropped' | 'owned_elsewhere'> {
	const owner = await findRepresentation(tx, { provider: r.provider, kind: 'label', providerId: r.to });
	if (owner && owner !== labelId) return 'owned_elsewhere';
	if (owner === labelId) {
		await tx.query(`delete from curator.catalog_source_object where object_id = $1 and provider = $2 and kind = 'label' and provider_id = $3`, [labelId, r.provider, r.from]);
		return 'dropped';
	}
	await tx.query(`update curator.catalog_source_object set provider_id = $4, url = coalesce(nullif($5, ''), url) where object_id = $1 and provider = $2 and kind = 'label' and provider_id = $3`, [labelId, r.provider, r.from, r.to, r.url]);
	return 'repointed';
}

export async function runLabelProfiler(deps: ProfilerDeps): Promise<{ attempted: number; attached: number }> {
	const due = await deps.db.query<{ id: string; name: string; attempts: unknown }>(
		`select o.id, o.name, et.attempts
		from curator.catalog_enrich_task et
		join curator.catalog_object o on o.id = et.object_id and o.kind = 'label' and o.merged_into is null
		where et.need = 'profile' and et.provider = 'catalog' and et.next_due_at <= now()
		order by o.watch_count desc, et.next_due_at
		limit $1::int`,
		[String(deps.batch ?? 3)],
	);
	const profiler = new LabelProfiler(deps);
	let attempted = 0;
	let attached = 0;
	for (const l of due) {
		attempted++;
		try {
			const r = await profiler.profile(l, AbortSignal.timeout(60_000));
			attached += r.attached;
			deps.log.info('label_profiled', { label: l.id, name: l.name, attached: r.attached, parked: r.parked });
		} catch (e) {
			const days = RETRY_DAYS[Math.min(num(l.attempts), RETRY_DAYS.length - 1)]!;
			await deps.db.query(
				`update curator.catalog_enrich_task set next_due_at = now() + make_interval(days => $2::int), attempts = attempts + 1, last_error = $3
				where object_id = $1 and need = 'profile' and provider = 'catalog'`,
				[l.id, String(days), e instanceof Error ? e.message.slice(0, 300) : 'error'],
			);
			deps.log.warn('label_profile_failed', { label: l.id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
			if (e instanceof TrackerRateLimitedError) break;
		}
	}
	if (attempted) deps.log.info('label_profile_pass', { attempted, attached });
	return { attempted, attached };
}
