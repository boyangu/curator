// The Discover feed on a device with no providers of its own (the phone):
// the cloud's event stream into a feed.db, the account's decisions onto it,
// and the decisions made here back out. The desktop's feed service
// (apps/core feed/service.ts) does this and everything its Spotify and
// Beatport clients add (enrichment, the lazy match, the local producers);
// this is the part that needs only the cloud, over the same store, producer
// and filters.
//
// When it reads: on start once the server has said it serves the catalogue,
// on becoming active, every POLL_MS while active, and on Refresh. Passes are
// serialised (one cursor, one rate limit). The first pass on a new feed.db
// shows the last month at once (`feed.recent`), then walks the stream from
// its start, as a new desktop does, to leave a cursor behind.

import type Database from 'better-sqlite3';
import type { CatalogRef, CatalogWatch, CloudService } from '@curator/protocol';
import type { Db } from '../db/client.js';
import { promoteExternalTrack, type EnsureResult, type ExternalTrackFacts } from '../library/external-track.js';
import { untagTracks } from '../library/mutators.js';
import { log } from '../log.js';
import { CloudTransportError } from '../sync-log/client.js';
import { CLOUD_FEED_PRODUCER_ID, CloudFeedProducer, type CatalogFeedPort } from './cloud-producer.js';
import { ArtistDismissFilter, FeedDedupFilter, LibraryFilter, type FeedStage, type LibraryMembershipLookup } from './filters.js';
import { spotifyIdOf, trackSpotifyIdOf } from './handles.js';
import { runProducerPass } from './pass.js';
import type { FeedStore } from './store.js';
import { createFeedDecisionPort } from './sync.js';
import type { FeedItem, LibraryTier } from './types.js';

type Raw = Database.Database;

const flog = log.for('feed');

const POLL_MS = 30 * 60 * 1000;
// The month a new feed.db shows before the stream's history has been walked.
const FIRST_FILL_DAYS = 30;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// Watches change when the user follows something on a desktop: an origin read
// from a list this old is right for nearly every event, and a wrong one only
// names the event's other subject.
const WATCHES_TTL_MS = 6 * 60 * 60 * 1000;
// The producer reads 5 pages a poll (its MAX_PAGES): a pass that filled them
// has more behind it. Bounded, so a long history is spread over passes.
const PAGES_PER_POLL = 5;
const MAX_CATCH_UP_POLLS = 8;
const RESOLVE_BATCH = 50;

// What is kept of a watch between runs.
export type WatchNote = { id: string; spotifyId: string | null; coverUrl: string | null };
type WatchCache = { at: number; watches: WatchNote[] };

export type DeviceFeedOptions = {
	db: Db;
	raw: Raw;
	store: FeedStore;
	feed: CloudService['feed'];
	catalog: Pick<CloudService['catalog'], 'listWatches' | 'resolve'>;
	// Signed in, and the server serves the catalogue.
	available(): boolean;
	deviceId(): string;
	// The watch list between runs, as text the host keeps.
	cache: { read(): string | null; write(text: string): void };
	// feed.db's rows changed: whoever reads it reloads.
	onChanged(): void;
	now?: () => number;
};

export type FeedRefreshAnswer = { inserted: number; error: string | null; retryAfterMs: number | null };

// One artist a card credits: its catalogue object and its Spotify id, as far
// as the card knows them.
export type FeedArtistRef = { catalogId: string | null; spotifyId: string | null };

export type FeedInterestedInput = { itemId: string; sourceTrackId: string | null; on: boolean; trackId: string | null };
export type FeedInterestedAnswer = { ok: true; trackId: string | null } | { ok: false; reason: 'not-found' | 'not-on-spotify' | 'not-ready' | 'deleted' };

export interface DeviceFeed {
	// The host's status changed (signed in, features heard): the first pass
	// waits for the server to have said it serves the catalogue.
	onStatus(): void;
	setActive(active: boolean): void;
	refresh(): Promise<FeedRefreshAnswer>;
	archive(itemId: string): Promise<void>;
	// Mutes the artist and takes this item off the feed. An album is exempt
	// from artist mutes (store VISIBLE_WHERE), so without the dismissal the
	// card the user acted on would stay.
	muteArtist(itemId: string, artistKey: string): Promise<void>;
	played(itemId: string, sourceTrackId: string | null): Promise<void>;
	interested(input: FeedInterestedInput): Promise<FeedInterestedAnswer>;
	// A picture per artist, keyed `catalogId ?? spotifyId`; null when the
	// catalogue has none. Artists it could not ask about are left out.
	artistPictures(refs: readonly FeedArtistRef[]): Promise<Record<string, string | null>>;
	stop(): void;
}

// The library's membership of these keys as the LibraryFilter reads it. A
// remote row carries where its recording came from on the device that brought
// it, so "there is a file of it" is remote_source there and the derived tier
// on an own row. Only `local` decides anything on this path; the chips are
// the reader's own lookup.
export function rawLibraryLookup(raw: Raw): LibraryMembershipLookup {
	const tierOf = (r: { remote_only: number; remote_source: string | null; membership: string | null }): LibraryTier | null =>
		r.remote_only ? (r.remote_source === 'local' ? 'local' : null) : (r.membership as LibraryTier | null);
	return async ({ isrcs, spotifyTrackIds }) => {
		const membershipByIsrc: Record<string, LibraryTier> = {};
		const membershipBySpotifyId: Record<string, LibraryTier> = {};
		const read = (keys: readonly string[], sql: (marks: string) => string, out: Record<string, LibraryTier>): void => {
			for (let i = 0; i < keys.length; i += 400) {
				const chunk = keys.slice(i, i + 400);
				for (const r of raw.prepare(sql(chunk.map(() => '?').join(','))).all(...chunk) as Array<{ k: string; remote_only: number; remote_source: string | null; membership: string | null }>) {
					const tier = tierOf(r);
					if (tier && out[r.k] !== 'local') out[r.k] = tier;
				}
			}
		};
		read(isrcs, (m) => `SELECT isrc AS k, remote_only, remote_source, membership FROM track WHERE isrc IN (${m}) AND deleted_at IS NULL`, membershipByIsrc);
		for (const table of ['source_link', 'claim_link']) {
			read(spotifyTrackIds, (m) => `SELECT l.source_track_id AS k, t.remote_only, t.remote_source, t.membership FROM ${table} l JOIN track t ON t.id = l.track_id
				WHERE l.source = 'spotify' AND l.source_track_id IN (${m}) AND t.deleted_at IS NULL`, membershipBySpotifyId);
		}
		return { membershipByIsrc, membershipBySpotifyId, pinnedByIsrc: new Set(), pinnedBySpotifyId: new Set(), sourceByIsrc: {}, sourceBySpotifyId: {} };
	};
}

// A feed.db made after this device already held the account's records: the
// mutes in them were never queued for it (feed_sync_pending fills as ops and
// snapshots project, and a ready-made library was projected elsewhere). Item
// decisions need no such pass: an item takes its own as it is inserted
// (store.setDecisionSource).
export function queueKnownSuppressions(raw: Raw): number {
	return raw.prepare(`INSERT OR IGNORE INTO feed_sync_pending (map, key) SELECT map, key FROM sync_state WHERE map = 'feedSuppressions'`).run().changes;
}

// The library facts of one card track. Null when no player can name it: the
// promotion's identity is the Spotify id, as on the desktop.
export function externalFacts(item: FeedItem, sourceTrackId: string | null): ExternalTrackFacts | null {
	const p = item.payload;
	if (item.type === 'track') {
		const id = spotifyIdOf(item);
		if (!id) return null;
		return {
			spotifyTrackId: id, isrc: p.isrc ?? null, title: p.title, artists: p.artists, albumTitle: p.albumTitle ?? null, releaseDate: p.releaseDate ?? null,
			label: p.label ?? null, genre: p.genre ?? null, coverUrl: p.coverUrl ?? null, durationSec: p.durationSec ?? null, trackNumber: null,
			bpm: p.bpm ?? null, keyCamelot: p.keyCamelot ?? null,
		};
	}
	const ref = p.tracks?.find((t) => t.sourceTrackId === sourceTrackId);
	const id = ref ? trackSpotifyIdOf(ref, item) : null;
	if (!ref || !id) return null;
	return {
		spotifyTrackId: id, isrc: ref.isrc ?? null, title: ref.title, artists: ref.artists, albumTitle: p.title, releaseDate: ref.releaseDate ?? p.releaseDate ?? null,
		label: ref.label ?? p.label ?? null, genre: ref.genre ?? p.genre ?? null, coverUrl: p.coverUrl ?? null, durationSec: ref.durationSec, trackNumber: ref.trackNumber ?? null,
		bpm: ref.bpm ?? null, keyCamelot: ref.keyCamelot ?? null,
	};
}

export function createDeviceFeed(o: DeviceFeedOptions): DeviceFeed {
	const now = o.now ?? Date.now;
	const decisions = createFeedDecisionPort(o.raw);
	const stages: FeedStage[] = [new FeedDedupFilter(o.store), new ArtistDismissFilter(o.store), new LibraryFilter(rawLibraryLookup(o.raw))];

	// ── watches ────────────────────────────────────────────────────────────
	let watches: WatchCache | null = null;
	const loadWatches = (): WatchCache | null => {
		if (watches) return watches;
		try {
			const text = o.cache.read();
			watches = text ? (JSON.parse(text) as WatchCache) : null;
		} catch (err) {
			flog.warn('the kept watch list is unreadable', undefined, err);
		}
		return watches;
	};
	const noteOf = (w: CatalogWatch): WatchNote => ({ id: w.object.id, spotifyId: w.object.handles.find((h) => h.provider === 'spotify')?.id ?? null, coverUrl: w.object.coverUrl });
	const currentWatches = async (): Promise<WatchCache | null> => {
		const kept = loadWatches();
		if (kept && now() - kept.at < WATCHES_TTL_MS) return kept;
		watches = { at: now(), watches: (await o.catalog.listWatches({ deviceId: o.deviceId() })).map(noteOf) };
		try {
			o.cache.write(JSON.stringify(watches));
		} catch (err) {
			flog.warn('keeping the watch list failed', undefined, err);
		}
		return watches;
	};

	// ── passes ─────────────────────────────────────────────────────────────
	let fullPages = 0;
	const port: CatalogFeedPort = {
		available: () => o.available(),
		events: async (afterSeq) => {
			const r = await o.feed.events({ deviceId: o.deviceId(), afterSeq });
			if (r.events.length > 0 && r.nextSeq > afterSeq) fullPages++;
			return r;
		},
		recent: (days) => o.feed.recent({ deviceId: o.deviceId(), days }),
		// A stale list is better than none: the origin falls back to the
		// event's first subject only when there has never been one.
		watchedIds: async () => {
			const c = await currentWatches().catch((err: unknown) => {
				flog.info('watches not read', { error: err instanceof Error ? err.message : String(err) });
				return loadWatches();
			});
			return new Set((c?.watches ?? []).map((w) => w.id));
		},
	};
	const producer = new CloudFeedProducer(port);
	const ctx = { report: () => {} };

	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.then(() => undefined, () => undefined);
		return run;
	};

	let timer: ReturnType<typeof setTimeout> | null = null;
	let active = true;
	let stopped = false;
	let started = false;
	let lastPollAt: number | null = null;
	// A rate-limited poll's wait: nothing asks again before it.
	let notBefore = 0;

	const schedule = (ms: number): void => {
		if (timer) clearTimeout(timer);
		timer = null;
		if (stopped || !active) return;
		timer = setTimeout(() => { timer = null; void pass(); }, Math.max(0, ms));
	};

	const doPass = async (): Promise<FeedRefreshAnswer> => {
		let inserted = 0;
		try {
			if (!o.available()) return { inserted: 0, error: 'Curator Cloud is not reachable', retryAfterMs: null };
			if (now() < notBefore) return { inserted: 0, error: 'rate limited', retryAfterMs: notBefore - now() };
			if ((await o.store.getCursor(CLOUD_FEED_PRODUCER_ID)) === null) {
				const r = await runProducerPass(o.store, producer, stages, { mode: 'backfill', fetch: (p, cursor, c) => p.backfill!(cursor, FIRST_FILL_DAYS, c), ctx });
				inserted += r.inserted;
				if (r.inserted > 0) o.onChanged();
			}
			for (let i = 0; i < MAX_CATCH_UP_POLLS; i++) {
				fullPages = 0;
				const r = await runProducerPass(o.store, producer, stages, { mode: 'poll', fetch: (p, cursor, c) => p.poll(cursor, c), ctx });
				inserted += r.inserted;
				if (r.inserted > 0) o.onChanged();
				if (fullPages < PAGES_PER_POLL) break;
			}
			lastPollAt = now();
			const pruned = await o.store.prune(PRUNE_AFTER_MS);
			if (pruned > 0) o.onChanged();
			if (inserted > 0 || pruned > 0) flog.info('feed pass', { inserted, pruned });
			return { inserted, error: null, retryAfterMs: null };
		} catch (err) {
			const wait = err instanceof CloudTransportError && err.kind === 'rate_limited' ? (err.retryAfterMs ?? 60_000) : null;
			if (wait !== null) notBefore = now() + wait;
			flog.warn('feed pass failed', { inserted }, err);
			return { inserted, error: err instanceof Error ? err.message : String(err), retryAfterMs: wait };
		}
	};

	const pass = (): Promise<FeedRefreshAnswer> => serial(async () => {
		const r = await doPass();
		schedule(r.retryAfterMs ?? POLL_MS);
		return r;
	});

	const itemOf = async (itemId: string): Promise<FeedItem | null> => o.store.getItem(itemId);

	return {
		onStatus() {
			if (started || stopped || !o.available()) return;
			started = true;
			void pass();
		},
		setActive(on) {
			active = on;
			if (!on) {
				if (timer) clearTimeout(timer);
				timer = null;
				return;
			}
			if (!started || stopped) return;
			schedule(lastPollAt === null ? 0 : lastPollAt + POLL_MS - now());
		},
		refresh() {
			// A follow made on a desktop since shows its name on the card now.
			if (watches) watches = { ...watches, at: 0 };
			return pass();
		},
		async archive(itemId) {
			const item = await itemOf(itemId);
			if (!item) return;
			await o.store.markState(item.id, 'archived');
			decisions.itemState(item.dedupeKey, 'archived');
			await o.store.recordSignal({ itemId: item.id, kind: 'archive' });
			o.onChanged();
		},
		async muteArtist(itemId, artistKey) {
			const item = await itemOf(itemId);
			if (!item) return;
			const key = `artist:${artistKey}`;
			await o.store.addSuppression('artist', key);
			decisions.suppression(key, 'artist', true);
			await o.store.markState(item.id, 'dismissed');
			decisions.itemState(item.dedupeKey, 'dismissed');
			await o.store.recordSignal({ itemId: item.id, kind: 'dismiss', value: { scope: key } });
			o.onChanged();
		},
		async played(itemId, sourceTrackId) {
			const item = await itemOf(itemId);
			if (!item) return;
			await o.store.markPlayed(item.id);
			decisions.played(item.dedupeKey, item.playedAt ?? now(), sourceTrackId);
			await o.store.recordSignal({ itemId: item.id, kind: 'listen', value: sourceTrackId ? { sourceTrackId } : null });
		},
		async interested({ itemId, sourceTrackId, on, trackId }) {
			const item = await itemOf(itemId);
			if (!item) return { ok: false, reason: 'not-found' };
			if (!on) {
				// The tag comes off and nothing is deleted (decided 2026-11-23: a
				// delete would reach the desktop's rekordbox and streaming pushes).
				const id = trackId ?? item.promotedTrackId;
				if (id) untagTracks(o.db, [id], 'interested', { bump: true });
				if (item.type === 'track' && item.state === 'promoted') {
					await o.store.clearPromotion(item.id);
					decisions.itemState(item.dedupeKey, 'seen');
				}
				o.onChanged();
				return { ok: true, trackId: id };
			}
			const facts = externalFacts(item, sourceTrackId);
			if (!facts) return { ok: false, reason: 'not-on-spotify' };
			const r: EnsureResult = promoteExternalTrack(o.db, facts);
			if (!r.ok) return { ok: false, reason: r.reason };
			await o.store.recordSignal({ itemId: item.id, kind: 'promote', value: { sourceTrackId: facts.spotifyTrackId } });
			// An album item stays as it is (the user may want more of its
			// tracks); only a single-track item flips.
			if (item.type === 'track') {
				await o.store.markState(item.id, 'promoted', { promotedTrackId: r.trackId });
				decisions.itemState(item.dedupeKey, 'promoted', r.trackId);
			}
			o.onChanged();
			return { ok: true, trackId: r.trackId };
		},
		async artistPictures(refs) {
			const out: Record<string, string | null> = {};
			const keyOf = (r: FeedArtistRef): string | null => r.catalogId ?? r.spotifyId;
			// Whom the user follows is in the watch list already: no call each.
			const kept = (loadWatches() ?? (o.available() ? await currentWatches().catch(() => null) : null))?.watches ?? [];
			const byId = new Map(kept.map((w) => [w.id, w]));
			const bySpotify = new Map(kept.flatMap((w) => (w.spotifyId ? [[w.spotifyId, w] as const] : [])));
			const ask: Array<{ key: string; ref: CatalogRef }> = [];
			for (const r of refs) {
				const key = keyOf(r);
				if (!key || key in out) continue;
				const w = (r.catalogId ? byId.get(r.catalogId) : undefined) ?? (r.spotifyId ? bySpotify.get(r.spotifyId) : undefined);
				if (w?.coverUrl) out[key] = w.coverUrl;
				else if (r.spotifyId) ask.push({ key, ref: { provider: 'spotify', kind: 'artist', providerId: r.spotifyId } });
				// Known to the catalogue only, and not followed: it answers such
				// an object one call at a time, which a card's avatar is not worth.
				else out[key] = null;
			}
			if (ask.length === 0 || !o.available()) return out;
			for (let i = 0; i < ask.length; i += RESOLVE_BATCH) {
				const batch = ask.slice(i, i + RESOLVE_BATCH);
				try {
					const { objects } = await o.catalog.resolve({ deviceId: o.deviceId(), refs: batch.map((a) => a.ref) });
					batch.forEach((a, n) => { out[a.key] = objects[n]?.coverUrl ?? null; });
				} catch (err) {
					// Left out: asked again the next time a card needs it.
					flog.info('artist pictures not read', { artists: batch.length, error: err instanceof Error ? err.message : String(err) });
					break;
				}
			}
			return out;
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
