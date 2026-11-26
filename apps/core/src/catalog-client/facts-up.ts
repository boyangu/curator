// Findings up: what this desktop found for a card — its Beatport /
// Traxsource lookups (feed/enrichment.ts: bpm, key, genre, label, the store's
// track id) and its lazy Spotify match (feed/spotify-match.ts: the release's
// and tracks' Spotify ids) — sent to the Global Catalog as fill-only claims
// (reason 'enrichment'; apps/cloud catalog.ts attachFacts), so every device's
// cards carry them and none re-searches what another found.
//
// A claim names the recording by the store's id and the card's ISRC; the
// catalogue attaches it by ISRC with its length guard (identity.ts), or by
// the recording key the names make, and creates nothing for an unknown one.
// Where the server reads it ('catalog_claim_about'), a claim also says
// which catalogue object the card was (`about`): the catalogue takes that
// only when its own rules name nothing and the claim agrees with the object
// (title and length; title and an act), so a store match this device's
// scorer got wrong is refused there, not bound for good. It is what lets a
// release with no UPC, or a track with no ISRC, gain what a device found.
//
// Sent once per finding (feed_facts_sent), swept from the items enriched or
// matched in the last month so what landed before this existed goes up
// too, and whenever a finding lands (debounced). One the catalogue could
// not place is asked again after a week: the catalogue may hold the object
// by then. Signed out: left for a later sweep.

import { createHash } from 'node:crypto';
import type { CatalogClaim } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { FeedItem, FeedTrackRef, SourceLinkDraft } from '@curator/sync-core/feed/types';
import type { FeedStore } from '@curator/sync-core/feed/store';
import { log } from '@curator/sync-core/log';

const flog = log.for('catalog-facts-up');

const STORES = new Set(['beatport', 'traxsource']);
const SWEEP_DAYS = 30;
const SWEEP_LIMIT = 500;
const DEBOUNCE_MS = 10_000;
const RETRY_UNPLACED_DAYS = 7;
export const FACTS_BATCH = 200;

export const factsKey = (link: Pick<SourceLinkDraft, 'source' | 'sourceTrackId'>): string => `${link.source}:${link.sourceTrackId}`;

type Ref = Pick<FeedTrackRef, 'title' | 'artists' | 'isrc' | 'durationSec' | 'bpm' | 'genre' | 'label' | 'sourceLinks' | 'catalogId'>;

const refsOf = (item: FeedItem): Ref[] => {
	if (item.type === 'album') return item.payload.tracks ?? [];
	const p = item.payload;
	return [{ title: p.title, artists: p.artists, isrc: p.isrc, durationSec: p.durationSec ?? null, bpm: p.bpm, genre: p.genre, label: p.label, sourceLinks: p.sourceLinks, catalogId: p.catalogId }];
};

export const nameClaims = (names: readonly string[]): CatalogClaim[] =>
	names.filter((a) => a.trim()).map((a) => ({ provider: 'user', kind: 'artist', providerId: `name:${nameFold(a)}`, name: a }));

// The Spotify handles this desktop's lazy match found (feed/spotify-match.ts:
// the row moved to 'spotify' with matchStatus 'ok'): the release and each
// paired track, so the catalogue's card plays on every device and the cloud
// need not search. Placed by the catalogue by UPC / ISRC or by title, artist
// and date — never by the catalogue id the card carries.
function spotifyClaims(item: FeedItem, about: About): { key: string; claim: CatalogClaim }[] {
	if (item.source !== 'spotify' || item.matchStatus !== 'ok' || !item.payload.catalogId) return [];
	const out: { key: string; claim: CatalogClaim }[] = [];
	const p = item.payload;
	if (item.type === 'album') {
		const facts: NonNullable<CatalogClaim['facts']> = {};
		if (p.releaseDate) facts.releaseDate = p.releaseDate;
		if (p.albumType) facts.releaseType = p.albumType;
		out.push({
			key: `spotify:album:${item.sourceId}`,
			claim: {
				provider: 'spotify',
				kind: 'release',
				providerId: item.sourceId,
				name: p.title,
				url: p.url ?? `https://open.spotify.com/album/${item.sourceId}`,
				identifiers: p.upc ? [{ namespace: 'upc', value: p.upc }] : [],
				artists: nameClaims(p.artists),
				facts,
				...about(p.catalogId),
			},
		});
		for (const ref of p.tracks ?? []) {
			const id = ref.handles?.find((h) => h.provider === 'spotify')?.id;
			if (!id || (!ref.isrc && !ref.catalogId)) continue;
			out.push({
				key: `spotify:track:${id}`,
				claim: {
					provider: 'spotify',
					kind: 'recording',
					providerId: id,
					name: ref.title,
					url: `https://open.spotify.com/track/${id}`,
					identifiers: ref.isrc ? [{ namespace: 'isrc', value: ref.isrc }] : [],
					artists: nameClaims(ref.artists),
					facts: ref.durationSec ? { durationSec: ref.durationSec } : {},
					...about(ref.catalogId),
				},
			});
		}
	} else {
		out.push({
			key: `spotify:track:${item.sourceId}`,
			claim: {
				provider: 'spotify',
				kind: 'recording',
				providerId: item.sourceId,
				name: p.title,
				url: p.url ?? `https://open.spotify.com/track/${item.sourceId}`,
				identifiers: p.isrc ? [{ namespace: 'isrc', value: p.isrc }] : [],
				artists: nameClaims(p.artists),
				facts: p.durationSec ? { durationSec: p.durationSec } : {},
				...about(p.catalogId),
			},
		});
	}
	return out;
}

// The `about` field of a claim, or nothing when the server does not read it.
type About = (catalogId: string | null | undefined) => { about?: string };
const aboutOf = (send: boolean): About => (id) => (send && id ? { about: id } : {});

// What this desktop found for a card: one claim per store match the
// catalogue can place (it needs the card's ISRC, or a recording the catalogue
// already knows — a card from the catalogue, `catalogId` — so the names can
// find it), and the Spotify handles the lazy match found.
// `about`: say which object each claim is about ('catalog_claim_about').
export function claimsFor(item: FeedItem, opts: { about?: boolean } = {}): { key: string; claim: CatalogClaim }[] {
	const about = aboutOf(opts.about === true);
	const out: { key: string; claim: CatalogClaim }[] = spotifyClaims(item, about);
	for (const ref of refsOf(item)) {
		const link = ref.sourceLinks?.find((l) => STORES.has(l.source));
		if (!link?.sourceTrackId) continue;
		const isrc = ref.isrc ?? link.isrc ?? null;
		if (!isrc && !ref.catalogId) continue;
		const name = link.title ?? ref.title;
		const artists = (link.artists?.length ? link.artists : ref.artists).filter((a) => a.trim());
		const facts: NonNullable<CatalogClaim['facts']> = {};
		const bpm = link.bpm ?? ref.bpm;
		if (bpm) facts.bpm = bpm;
		if (link.key) facts.key = link.key;
		const duration = link.duration ?? ref.durationSec;
		if (duration) facts.durationSec = duration;
		if (ref.label) facts.labelText = ref.label;
		if (!Object.keys(facts).length && !ref.genre) continue;
		out.push({
			key: factsKey(link),
			claim: {
				provider: link.source as CatalogClaim['provider'],
				kind: 'recording',
				providerId: link.sourceTrackId,
				name,
				url: link.url ?? null,
				identifiers: isrc ? [{ namespace: 'isrc', value: isrc }] : [],
				artists: nameClaims(artists),
				facts,
				...(ref.genre ? { genres: [ref.genre] } : {}),
				...about(ref.catalogId),
			},
		});
	}
	return out;
}

export type FactsUpReport = { sent: number; attached: number; unknown: number };

export type FactsUpDeps = {
	store: Pick<FeedStore, 'listEnrichedSince' | 'unsentFactKeys' | 'markFactsSent'>;
	// The procedure, or null while signed out / the server has no catalogue.
	ingest: (() => ((claims: CatalogClaim[], idempotencyKey: string) => Promise<{ results: ({ objectId: string } | { rejected: string })[] }>) | null);
	// Enrichment completions (feed service subscribeEnriched).
	subscribe: (cb: (item: FeedItem) => void) => () => void;
	// The server reads a claim's `about` ('catalog_claim_about').
	about?: () => boolean;
	debounceMs?: number;
	now?: () => number;
};

export interface FactsUp {
	start(): void;
	stop(): void;
	// Sweep now: the month's enriched items, the unsent matches among them, up.
	flush(): Promise<FactsUpReport>;
}

export function createFactsUp(deps: FactsUpDeps): FactsUp {
	const now = deps.now ?? Date.now;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let unsub: (() => void) | null = null;
	let running: Promise<FactsUpReport> | null = null;

	const schedule = (): void => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, deps.debounceMs ?? DEBOUNCE_MS);
		timer.unref?.();
	};

	async function sweep(): Promise<FactsUpReport> {
		const report: FactsUpReport = { sent: 0, attached: 0, unknown: 0 };
		const ingest = deps.ingest();
		if (!ingest) return report;
		const items = await deps.store.listEnrichedSince(now() - SWEEP_DAYS * 86400_000, SWEEP_LIMIT);
		const all = new Map<string, CatalogClaim>();
		const about = deps.about?.() === true;
		for (const item of items) for (const { key, claim } of claimsFor(item, { about })) if (!all.has(key)) all.set(key, claim);
		const unsent = await deps.store.unsentFactKeys([...all.keys()], { retryUnplacedBefore: now() - RETRY_UNPLACED_DAYS * 86400_000 });
		const pending = [...all].filter(([k]) => unsent.has(k));
		for (let i = 0; i < pending.length; i += FACTS_BATCH) {
			const batch = pending.slice(i, i + FACTS_BATCH);
			const key = `enrich-facts:${createHash('sha256').update(batch.map(([k]) => k).join(',')).digest('hex').slice(0, 32)}`;
			// A retry is a new request: the server answers a repeated key with its
			// first answer.
			const r = await ingest(batch.map(([, c]) => c), `${key}:${Math.floor(now() / 86400_000)}`);
			const unplaced = new Set<string>();
			for (const [i, o] of r.results.entries()) {
				if ('objectId' in o) report.attached++;
				else if (o.rejected === 'unknown') {
					report.unknown++;
					unplaced.add(batch[i]![0]);
				}
			}
			await deps.store.markFactsSent(batch.map(([k]) => k), unplaced);
			report.sent += batch.length;
		}
		if (report.sent) flog.info('enrichment findings sent to the catalogue', report);
		return report;
	}

	const flush = (): Promise<FactsUpReport> => {
		if (running) return running;
		running = sweep()
			.catch((err: unknown) => {
				flog.warn('facts-up sweep failed', undefined, err);
				return { sent: 0, attached: 0, unknown: 0 };
			})
			.finally(() => {
				running = null;
			});
		return running;
	};

	return {
		start() {
			if (unsub) return;
			unsub = deps.subscribe(() => schedule());
			schedule();
		},
		stop() {
			unsub?.();
			unsub = null;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		flush,
	};
}
