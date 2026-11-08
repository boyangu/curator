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
// The catalogue id the card carries is deliberately NOT sent: attaching by
// id would skip every identity rule and bind a store match the device's own
// title/artist scorer got wrong to the wrong recording for good.
//
// Sent once per store match (feed_facts_sent), swept from the items enriched
// in the last month so what landed before this existed goes up too, and
// whenever enrichment lands (debounced). Signed out: left for a later sweep.

import { createHash } from 'node:crypto';
import type { CatalogClaim } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import type { FeedItem, FeedTrackRef, SourceLinkDraft } from '../feed/types.js';
import type { FeedStore } from '../feed/store.js';
import { log } from '../log.js';

const flog = log.for('catalog-facts-up');

const STORES = new Set(['beatport', 'traxsource']);
const SWEEP_DAYS = 30;
const SWEEP_LIMIT = 500;
const DEBOUNCE_MS = 10_000;
export const FACTS_BATCH = 200;

export const factsKey = (link: Pick<SourceLinkDraft, 'source' | 'sourceTrackId'>): string => `${link.source}:${link.sourceTrackId}`;

type Ref = Pick<FeedTrackRef, 'title' | 'artists' | 'isrc' | 'durationSec' | 'bpm' | 'genre' | 'label' | 'sourceLinks' | 'catalogId'>;

const refsOf = (item: FeedItem): Ref[] => {
	if (item.type === 'album') return item.payload.tracks ?? [];
	const p = item.payload;
	return [{ title: p.title, artists: p.artists, isrc: p.isrc, durationSec: p.durationSec ?? null, bpm: p.bpm, genre: p.genre, label: p.label, sourceLinks: p.sourceLinks, catalogId: p.catalogId }];
};

const nameClaims = (names: readonly string[]): CatalogClaim[] =>
	names.filter((a) => a.trim()).map((a) => ({ provider: 'user', kind: 'artist', providerId: `name:${nameFold(a)}`, name: a }));

// The Spotify handles this desktop's lazy match found (feed/spotify-match.ts:
// the row moved to 'spotify' with matchStatus 'ok'): the release and each
// paired track, so the catalogue's card plays on every device and the cloud
// need not search. Placed by the catalogue by UPC / ISRC or by title, artist
// and date — never by the catalogue id the card carries.
function spotifyClaims(item: FeedItem): { key: string; claim: CatalogClaim }[] {
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
			},
		});
	}
	return out;
}

// What this desktop found for a card: one claim per store match the
// catalogue can place (it needs the card's ISRC, or a recording the catalogue
// already knows — a card from the catalogue, `catalogId` — so the names can
// find it), and the Spotify handles the lazy match found.
export function claimsFor(item: FeedItem): { key: string; claim: CatalogClaim }[] {
	const out: { key: string; claim: CatalogClaim }[] = spotifyClaims(item);
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
		for (const item of items) for (const { key, claim } of claimsFor(item)) if (!all.has(key)) all.set(key, claim);
		const unsent = await deps.store.unsentFactKeys([...all.keys()]);
		const pending = [...all].filter(([k]) => unsent.has(k));
		for (let i = 0; i < pending.length; i += FACTS_BATCH) {
			const batch = pending.slice(i, i + FACTS_BATCH);
			const key = `enrich-facts:${createHash('sha256').update(batch.map(([k]) => k).join(',')).digest('hex').slice(0, 32)}`;
			const r = await ingest(batch.map(([, c]) => c), key);
			for (const o of r.results) {
				if ('objectId' in o) report.attached++;
				else if (o.rejected === 'unknown') report.unknown++;
			}
			// Unknown ones are not retried: the card's ISRC is all the device has.
			await deps.store.markFactsSent(batch.map(([k]) => k));
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
