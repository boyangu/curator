// What this desktop does for the entity page in front, beyond showing it.
//
// The Global Catalog knows what its trackers have read, and they read only
// what somebody follows. A page the user opens can be of an artist nobody
// follows, or of one whose older releases arrived as a listing's bare copies
// (a title and a date, no tracklist). The desktop is at the stores anyway —
// its own network, its user's Spotify login — so while the page is in front
// it does three things, one after another, and says which (`subscribe`):
//
//   discover / updates   reads the stores' listings of the entity and
//                        registers the releases the catalogue lacks. For an
//                        entity the catalogue does not know at all this is
//                        what makes the page ('discover').
//   tracklists           reads, release by release, the tracklists of the
//                        loaded releases the catalogue lists without one.
//   details              fills in what the loaded rows lack: a page on the
//                        user's streaming service (the feed's Spotify match)
//                        and BPM / key / genre / label (the feed's Beatport
//                        and Traxsource lookups). Rows change in place.
//
// An artist or an album the catalogue does not know is on screen already,
// read from the user's streaming service (entity/streaming.ts, `world.via`
// on its header). Discovering it is then registering that same read — the
// service is not asked twice — and the page becomes the catalogue's when the
// registration lands.
//
// Everything found goes up to the catalogue, so the next page — on any
// device — has it from there: listings and tracklists as registrations
// (catalog.ingest 'manual_registration': no watch, no events), row facts as
// fill-only claims ('enrichment', like catalog-client/facts-up.ts).
//
// One page at a time: `watch` names the page in front, and naming another
// (or none) stops the work for the one before. The readers are the
// catalogue's own (@curator/catalog-readers), under the same rules as the
// worker next door (catalog-worker/service.ts): a source the user unchecked
// in the Refresh menu is not read, Spotify goes through the process-wide
// gate and is left alone during a quota ban. Nothing here touches the
// library.
//
// Deezer is read last and for one thing only: a release's tracklist, by the
// release's own Deezer id, when no other store has it. It is never asked who
// an artist is. Deezer files every artist of one name under one artist id
// (its "Fade" holds 238 albums of a dozen people, 2026-11-18), so a listing
// read from such a page — or a credit taken from it — hands one artist the
// catalogue of all their namesakes. No artist listing, no label search by
// name, and the credits on what it does read are left behind.

import { createHash } from 'node:crypto';
import { CATALOG_MAX_NESTED, type CatalogClaim, type CatalogHandle, type CatalogPageRelease, type CatalogPageTrack, type CatalogProvider, type CatalogRef, type CatalogTracker, type CatalogTracksResult } from '@curator/protocol';
import { BandcampTracker, BeatportTracker, DeezerTracker, fetchAlbums, SpotifyTracker, TrackerRateLimitedError, type FetchLike, type TrackerPoll, type TrackerTarget } from '@curator/catalog-readers';
import { gatedFetch, isSpotifyQuotaBackoff, type SpotifySimplifiedTrack } from '@curator/spotify';
import { searchFold, type EntityHeader, type EntityRef, type EntityRowPatch, type EntityWorkEvent, type EntityWorkStatus, type StreamingService } from '@curator/shared';
import { nameClaims } from '../catalog-client/facts-up.js';
import { isDistributor } from '../catalog-client/library-claims.js';
import type { CatalogClient } from '../catalog-client/service.js';
import type { Enricher } from '@curator/sync-core/enrich/contract';
import { enrichOne } from '../enrich/runner.js';
import { findSpotifyAlbum, pairTracks, type SpotifyMatchClient } from '../feed/spotify-match.js';
import { log } from '@curator/sync-core/log';
import { normalizeEntityRef, type StreamingCatalog } from './streaming.js';

const wlog = log.for('entity-work');

// A page reopened within this long does not read the stores' listings again.
// In memory: a restart reads once more, which is what a first open costs.
const CHECK_TTL_MS = 6 * 3600_000;
// A reader hands out a few releases in full per poll and keeps the rest for
// the next (it was built for a tracker's minute): this many polls in a row.
const LISTING_ROUNDS = 3;
const READ_TIMEOUT_MS = 20_000;
// Between polls of one listing, and between release pages read at one store
// (Beatport's are pages a browser would open; Deezer counts calls per 5 s).
const ROUND_GAP_MS = 1000;
const RELEASE_GAP_MS: Record<string, number> = { beatport: 1500, deezer: 250 };
// Between this page's store lookups for a row (the feed's pace).
const FACTS_PACING_MS = 1500;
const CLAIMS_FLUSH = 20;
// An artist met through the streaming service: this many of its newest
// releases go up with their tracklists (twenty a call there); the older ones
// as the listing names them, their tracklists read when their page is.
const STREAM_FULL_MAX = 100;
const STREAM_BATCH = 20;
const STORES = new Set(['beatport', 'traxsource']);

// What the work reads the stores through. The default is the catalogue's own
// readers; tests hand in their own.
export type EntityReaders = {
	// One poll of a store's listing of the entity (the reader contract).
	listing(provider: CatalogProvider, target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll>;
	// One release in full, by the store's own id for it. Null: the store
	// does not have it.
	beatportRelease(id: string, url: string | null, signal: AbortSignal): Promise<CatalogClaim | null>;
	deezerRelease(id: string, signal: AbortSignal): Promise<CatalogClaim | null>;
	// Albums in full, twenty a call; one Spotify no longer has is left out.
	spotifyAlbums(ids: readonly string[], signal: AbortSignal): Promise<Map<string, CatalogClaim>>;
};

export type EntityWorkPages = {
	page(ref: EntityRef): Promise<EntityHeader>;
	// The entity's World pages read so far and still held.
	loaded(catalogId: string): Promise<CatalogTracksResult[]>;
	// The catalogue's answer for the entity changed: read it again when asked.
	drop(catalogId: string | null): void;
};

export type EntityWorkDeps = {
	catalog(): Pick<CatalogClient, 'status' | 'resolve' | 'register' | 'reportEnrichment' | 'enrichLabels'> | null;
	pages: EntityWorkPages;
	// The user's checked sources (catalog-worker/settings.ts): unchecked
	// means nobody reads it, a page included.
	trackers(): CatalogTracker[];
	// The user's Spotify, or null while it is not connected or is serving a
	// quota ban.
	spotify(): Promise<SpotifyMatchClient | null>;
	spotifyToken(): Promise<string | null>;
	primary(): Promise<StreamingService | null>;
	// The streaming service read as a catalogue, when the pages show unknown
	// entities from it (entity/streaming.ts): what a discovery registers.
	streaming?(): StreamingCatalog | null;
	// The store lookups for a row's DJ facts, in order (enrich/runner.ts).
	enrichers: readonly Enricher[];
	fetch?: FetchLike;
	// Electron's net.fetch for Beatport; plain fetch otherwise.
	beatportFetch?: FetchLike;
	readers?: EntityReaders;
	now?: () => number;
	// Tests: no waiting between lookups.
	pacingMs?: number;
};

export interface EntityWork {
	// The page in front (null: none). `token` comes back on every event.
	watch(ref: EntityRef | null, token: number): void;
	// A World page of an entity was read (entity/service.ts tracks()).
	pageLoaded(catalogId: string, result: CatalogTracksResult): void;
	// What the lookups found for a recording this session: laid over a page
	// read again before the catalogue has it.
	patchOf(recordingId: string): EntityRowPatch | undefined;
	// Rows of the page in front the user asked to have looked up at the stores
	// now (BPM, key, genre, label): ahead of the page's own order, and once
	// more for rows already tried. Resolves when they have been: `asked` is
	// how many of the rows the page holds, `found` how many a store had
	// something for. Leaving the page settles what is left as not found.
	enrich(recordingIds: readonly string[]): Promise<{ asked: number; found: number }>;
	subscribe(cb: (e: EntityWorkEvent) => void): () => void;
}

type AskedRow = { r: CatalogPageRelease; t: CatalogPageTrack; settle: (found: boolean) => void };

type Front = {
	key: string;
	token: number;
	ref: EntityRef;
	catalogId: string | null;
	abort: AbortController;
	status: EntityWorkStatus;
	lane: Promise<void>;
	waiting: number;
	// Releases already handed to a page task.
	queued: Set<string>;
	// Bumped when the catalogue's answer for the page changed: the page
	// reads its releases again, and tasks holding the old copies stand down.
	gen: number;
	// Row findings on their way up, by what each was found as.
	claims: { key: string; claim: CatalogClaim }[];
	// Rows asked for by hand (`enrich`), by recording; and the ones done, which
	// the page's own pass then steps over.
	asked: Map<string, AskedRow>;
	askedDone: Set<string>;
};

const IDLE: EntityWorkStatus = { phase: null, source: null, found: 0, added: 0, done: 0, total: 0 };

const refKey = (r: Pick<EntityRef, 'kind' | 'name' | 'libraryId' | 'catalogId' | 'spotifyId'>): string =>
	`${r.kind}:${r.catalogId ? `c:${r.catalogId}` : r.libraryId ? `l:${r.libraryId}` : r.spotifyId ? `s:${r.spotifyId}` : `n:${searchFold(r.name).trim()}`}`;

// A store's own id for the object: not a reader's name key.
const handleOf = (handles: readonly CatalogHandle[], provider: string): CatalogHandle | null => handles.find((h) => h.provider === provider && !h.id.includes('/')) ?? null;

const claimKey = (c: Pick<CatalogClaim, 'provider' | 'kind' | 'providerId'>): string => `${c.provider}:${c.kind}:${c.providerId}`;

// A row the lookups have nothing to add to. A release's genre alone does not
// settle it (a store's broad word for the whole release).
const hasDjFacts = (t: CatalogPageTrack): boolean => t.bpm != null && !!t.key && t.genres.length > 0;

function defaultReaders(deps: EntityWorkDeps): EntityReaders {
	const fetchFn: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i));
	const token = async (): Promise<string> => {
		const t = await deps.spotifyToken();
		if (!t) throw new Error('Spotify is not connected');
		return t;
	};
	const deezer = new DeezerTracker(fetchFn);
	const beatport = new BeatportTracker(deps.beatportFetch ?? fetchFn);
	const bandcamp = new BandcampTracker(fetchFn);
	// Through the process-wide gate the player and the feed share.
	const spotify = new SpotifyTracker({ token }, (u, i) => gatedFetch(u, i, 'entity:page'));
	// Deezer has no listing reader here (see the head of this file).
	const adapters = { beatport, bandcamp, spotify } as const;
	return {
		listing(provider, target, signal) {
			const adapter = adapters[provider as keyof typeof adapters];
			if (!adapter) throw new Error(`no reader for ${provider}`);
			return adapter.poll(target, signal);
		},
		beatportRelease: (id, url, signal) => beatport.fetchRelease(id, url, signal),
		deezerRelease: (id, signal) => deezer.fetchRelease({ id }, signal),
		spotifyAlbums: async (ids, signal) => (await fetchAlbums(spotify, ids, signal)).claims,
	};
}

export function createEntityWork(deps: EntityWorkDeps): EntityWork {
	const now = deps.now ?? Date.now;
	const readers = deps.readers ?? defaultReaders(deps);
	const listeners = new Set<(e: EntityWorkEvent) => void>();
	// Session memory, across pages: what was read, tried and found.
	const checkedAt = new Map<string, number>();
	const cursors = new Map<string, Record<string, unknown>>();
	const fillTried = new Set<string>();
	const matchTried = new Set<string>();
	const rowsTried = new Set<string>();
	const found = new Map<string, EntityRowPatch>();
	// Stores resting after a refusal, until when; and when each was last read.
	const resting = new Map<string, number>();
	const lastRead = new Map<string, number>();
	let front: Front | null = null;

	const pause = (ms: number): Promise<void> => (deps.pacingMs === 0 || ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

	const emit = (f: Front, extra: Pick<EntityWorkEvent, 'changed' | 'rows'> = {}): void => {
		// A page since left says nothing more.
		if (front !== f) return;
		const event: EntityWorkEvent = { watch: f.token, status: { ...f.status }, ...extra };
		for (const l of listeners) {
			try {
				l(event);
			} catch (err) {
				wlog.warn('listener failed', undefined, err);
			}
		}
	};
	const say = (f: Front, patch: Partial<EntityWorkStatus>): void => {
		Object.assign(f.status, patch);
		emit(f);
	};

	// One thing at a time per page; a task that throws leaves the rest to run.
	const enqueue = (f: Front, what: string, task: () => Promise<void>): void => {
		f.waiting++;
		f.lane = f.lane.then(async () => {
			try {
				if (!f.abort.signal.aborted) await task();
			} catch (err) {
				if (!f.abort.signal.aborted) wlog.warn('page work failed', { what, kind: f.ref.kind }, err);
			}
			f.waiting--;
			// Nothing queued behind: the page is at rest (`added` stays, it is
			// what the header says the check found).
			if (!f.waiting && f.status.phase !== null) say(f, { phase: null, source: null, done: 0, total: 0 });
		});
	};

	const signalOf = (f: Front): AbortSignal => AbortSignal.any([f.abort.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
	const allowed = (tracker: CatalogTracker): boolean => deps.trackers().includes(tracker);
	// A release is read at a store unless the user unchecked that store everywhere.
	const storeAllowed = (provider: string): boolean => deps.trackers().some((t) => t.endsWith(`/${provider}`));

	// ── listings: discover, or look for updates ───────────────────────────
	// A store's listing of the entity as release claims: a few polls in a row
	// while the reader holds releases back for its next one. The cursor is
	// kept for the session, so a later check costs only what is new.
	async function readListing(f: Front, provider: CatalogProvider, kind: 'artist' | 'label', name: string, rep: { providerId: string; url: string | null } | null): Promise<CatalogClaim[]> {
		const ck = `${f.key}|${provider}`;
		const out: CatalogClaim[] = [];
		for (let round = 0; round < LISTING_ROUNDS && !f.abort.signal.aborted; round++) {
			const poll = await readers.listing(provider, { object: { id: f.catalogId ?? '', kind, name }, representation: rep, cursor: cursors.get(ck) ?? {} }, signalOf(f));
			cursors.set(ck, poll.cursor);
			out.push(...poll.children.filter((c) => c.kind === 'release'));
			say(f, { found: f.status.found + poll.children.length });
			if (!poll.listingHash.startsWith('pending:')) break;
			await pause(ROUND_GAP_MS);
		}
		return out;
	}

	// An artist the catalogue is meeting now, from the streaming service its
	// page is already showing: every release it lists, the newest in full.
	// What the page read is held there and not read again.
	async function streamedReleases(f: Front, stream: StreamingCatalog, artistId: string): Promise<CatalogClaim[]> {
		const listing = await stream.listing(artistId);
		say(f, { found: f.status.found + listing.releases.length });
		const out: CatalogClaim[] = [];
		for (let i = 0; i < listing.releases.length && !f.abort.signal.aborted; i += STREAM_BATCH) {
			const part = listing.releases.slice(i, i + STREAM_BATCH);
			const full = i < STREAM_FULL_MAX ? await stream.releases(part.map((c) => c.providerId)) : new Map<string, CatalogClaim>();
			out.push(...part.map((c) => full.get(c.providerId) ?? c));
		}
		return out;
	}

	async function readStores(f: Front, header: EntityHeader, unknown: boolean): Promise<{ claims: CatalogClaim[]; read: boolean; self: CatalogClaim | null }> {
		const kind = header.ref.kind;
		const name = header.ref.name;
		const link = (source: string) => header.links.find((l) => l.source === source && l.sourceId && !l.sourceId.includes('/')) ?? null;
		const claims: CatalogClaim[] = [];
		let read = false;
		let self: CatalogClaim | null = null;
		const from = async (provider: CatalogProvider, run: () => Promise<CatalogClaim[]>): Promise<CatalogClaim[]> => {
			if (f.abort.signal.aborted) return [];
			// The page says it is being looked up only once a store is asked.
			if (f.status.phase === null) f.status = { ...IDLE, phase: unknown ? 'discover' : 'updates' };
			say(f, { source: provider });
			try {
				const got = await run();
				read = true;
				claims.push(...got);
				return got;
			} catch (err) {
				// Rate-limited, blocked, offline: the other stores still answer.
				if (!f.abort.signal.aborted) wlog.info('store listing not read', { provider, kind, error: err instanceof Error ? err.message : String(err) });
				return [];
			}
		};

		if (kind === 'artist') {
			// The artist's Spotify page — the id the library holds comes first
			// among the header's links. Not the Deezer page: it is not one artist's.
			const spotifyId = link('spotify')?.sourceId ?? header.ref.spotifyId ?? null;
			if (spotifyId && allowed('artist/spotify') && (await deps.spotify())) {
				const url = `https://open.spotify.com/artist/${spotifyId}`;
				self = { provider: 'spotify', kind: 'artist', providerId: spotifyId, name, url };
				const stream = unknown ? deps.streaming?.() ?? null : null;
				await from('spotify', () => (stream?.service === 'spotify' ? streamedReleases(f, stream, spotifyId) : readListing(f, 'spotify', 'artist', name, { providerId: spotifyId, url })));
			}
		} else if (kind === 'label') {
			const beatport = link('beatport');
			const bandcamp = link('bandcamp');
			if (beatport && allowed('label/beatport')) await from('beatport', () => readListing(f, 'beatport', 'label', name, { providerId: beatport.sourceId, url: beatport.url }));
			// The reader needs Bandcamp's band id; a pasted page's subdomain is not one.
			if (bandcamp && /^\d+$/.test(bandcamp.sourceId) && allowed('label/bandcamp')) await from('bandcamp', () => readListing(f, 'bandcamp', 'label', name, { providerId: bandcamp.sourceId, url: bandcamp.url }));
			// A label the catalogue is meeting now has no store page yet: it is
			// registered by name (listing()), and the catalogue finds its pages.
		} else if (unknown) {
			const spotifyId = link('spotify')?.sourceId ?? header.ref.spotifyId ?? null;
			if (spotifyId && (await deps.spotify())) {
				await from('spotify', async () => {
					const stream = deps.streaming?.() ?? null;
					const album = (stream?.service === 'spotify' ? await stream.releases([spotifyId]) : await readers.spotifyAlbums([spotifyId], signalOf(f))).get(spotifyId);
					say(f, { found: f.status.found + (album ? 1 : 0) });
					return album ? [album] : [];
				});
			}
		}
		const seen = new Set<string>();
		return { claims: claims.filter((c) => !seen.has(claimKey(c)) && !!seen.add(claimKey(c))), read, self };
	}

	// The claims the catalogue holds no object for (by the store's own id).
	async function unknownTo(client: NonNullable<ReturnType<EntityWorkDeps['catalog']>>, claims: CatalogClaim[]): Promise<CatalogClaim[]> {
		const refs: CatalogRef[] = claims.map((c) => ({ provider: c.provider, kind: c.kind, providerId: c.providerId }));
		const known = await client.resolve(refs);
		return claims.filter((_, i) => !known[i]);
	}

	// A release as a store read it, without who it is by: its own facts, its
	// identifiers and its tracklist. The catalogue keeps the credits it has.
	const withoutCredits = (c: CatalogClaim): CatalogClaim => {
		const bare = (x: CatalogClaim): CatalogClaim => {
			const out = { ...x };
			delete out.artists;
			return out;
		};
		return { ...bare(c), ...(c.recordings ? { recordings: c.recordings.map(bare) } : {}) };
	};

	const clamp = (c: CatalogClaim): CatalogClaim => ({
		...c,
		...(c.recordings ? { recordings: c.recordings.slice(0, CATALOG_MAX_NESTED) } : {}),
		...(c.artists ? { artists: c.artists.slice(0, CATALOG_MAX_NESTED) } : {}),
	});

	async function listing(f: Front): Promise<void> {
		const header = await deps.pages.page(f.ref);
		if (f.abort.signal.aborted) return;
		// Unknown to the catalogue: it said so, or the page is the streaming
		// service's in its place (`via`).
		const unknown = header.world.reason === 'unknown' || !!header.world.via;
		// Signed out, the server off or old, several candidates: nothing to read for.
		if (!unknown && !header.world.available) return;
		f.catalogId = header.ref.catalogId ?? f.catalogId;
		const client = deps.catalog();
		if (!client?.status().available) return;
		const key = refKey(header.ref);
		const fresh = (k: string): boolean => now() - (checkedAt.get(k) ?? -Infinity) < CHECK_TTL_MS;
		if (!fresh(key) && !fresh(f.key)) {
			const kind = header.ref.kind;
			const name = header.ref.name;
			// A distributor's name is on thousands of unrelated releases: not a label to read.
			if (kind === 'label' && isDistributor(name)) return;
			const { claims, read, self } = await readStores(f, header, unknown);
			if (f.abort.signal.aborted) return;
			say(f, { source: null });
			let added = 0;
			let sent = 0;
			let known = !unknown;
			// Releases that are new to the catalogue (a store's copy of one it
			// holds is attached, not added).
			const count = (up: CatalogClaim[], made: boolean[]): number => up.filter((c, i) => c.kind === 'release' && made[i]).length;
			if (unknown) {
				// The entity itself first, so the page exists even where the
				// stores listed nothing: a label by its name (the catalogue then
				// finds its pages and reads them), an artist by the store id.
				if (kind === 'label') {
					say(f, { phase: 'discover' });
					await client.enrichLabels([name]);
					known = true;
				}
				const up = [...(self ? [self] : []), ...claims].map(clamp);
				if (up.length) {
					added = count(up, (await client.register(up)).made);
					known = true;
				}
			} else if (claims.length) {
				const missing = (await unknownTo(client, claims)).map(clamp);
				if (missing.length) added = count(missing, (await client.register(missing)).made);
				sent = missing.length;
			}
			if (f.abort.signal.aborted) return;
			// A check where no store answered is not a check: the next open asks again.
			if (read) for (const k of [key, f.key]) checkedAt.set(k, now());
			f.status.added = added;
			if (unknown && known) {
				deps.pages.drop(null);
				// The page as the catalogue knows it now. Its new name for the
				// entity is checked too: the page is watched again under it,
				// and that must not read the stores a second time.
				const again = await deps.pages.page(f.ref);
				f.catalogId = again.ref.catalogId ?? null;
				if (read) checkedAt.set(refKey(again.ref), now());
				changed(f, 'header');
			} else if (sent > 0) {
				// New releases, or a store's page for ones the catalogue held
				// (a tracklist can be read there now).
				changed(f, 'tracks');
			}
			if (read) wlog.info(unknown ? 'page discovered at the stores' : 'page checked for updates', { kind, found: claims.length, added });
		}
		// Pages read before this page came to the front (Back onto it).
		if (f.catalogId) for (const result of await deps.pages.loaded(f.catalogId)) queuePage(f, result);
	}

	// ── a loaded page: tracklists, then details ───────────────────────────
	function queuePage(f: Front, result: CatalogTracksResult): void {
		const releases = result.releases.filter((r) => !f.queued.has(r.id));
		if (!releases.length) return;
		for (const r of releases) f.queued.add(r.id);
		const gen = f.gen;
		enqueue(f, 'page', async () => {
			if (gen === f.gen) await pageTask(f, releases);
		});
	}

	// The catalogue's answer for the page changed: have the page read it again
	// (its releases come back through pageLoaded), from the catalogue where it
	// is the releases that changed — a header just read is the new answer.
	const changed = (f: Front, what: 'header' | 'tracks'): void => {
		f.gen++;
		f.queued.clear();
		if (what === 'tracks') deps.pages.drop(f.catalogId);
		emit(f, { changed: what });
	};

	// The releases whose tracklists were read and registered.
	async function fillTracklists(f: Front, empty: CatalogPageRelease[]): Promise<CatalogPageRelease[]> {
		const client = deps.catalog();
		if (!client?.status().available) return [];
		say(f, { phase: 'tracklists', source: null, done: 0, total: empty.length });
		const claims: CatalogClaim[] = [];
		const filled: CatalogPageRelease[] = [];
		const take = (r: CatalogPageRelease, claim: CatalogClaim | null | undefined): boolean => {
			if (!claim?.recordings?.length) return false;
			claims.push(clamp(claim));
			filled.push(r);
			return true;
		};
		// Where each release can be read. One with no store page yet is not
		// "tried": it is asked for again once it has one.
		const left = empty.map((r) => ({
			r,
			beatport: storeAllowed('beatport') ? handleOf(r.handles, 'beatport') : null,
			spotify: storeAllowed('spotify') ? handleOf(r.handles, 'spotify') : null,
			deezer: storeAllowed('deezer') ? handleOf(r.handles, 'deezer') : null,
			done: false,
		}));
		for (const x of left) if (x.beatport || x.spotify || x.deezer) fillTried.add(x.r.id);
		// One release page at a store, paced; a store that rate-limits is left
		// alone for as long as it asked and the next store reads the rest.
		const readOne = async (provider: 'beatport' | 'deezer', read: () => Promise<CatalogClaim | null>): Promise<CatalogClaim | null> => {
			if ((resting.get(provider) ?? 0) > now()) return null;
			say(f, { source: provider });
			await pause((lastRead.get(provider) ?? 0) + RELEASE_GAP_MS[provider]! - now());
			lastRead.set(provider, now());
			try {
				return await read();
			} catch (err) {
				if (err instanceof TrackerRateLimitedError) {
					resting.set(provider, now() + err.retryAfterSec * 1000);
					wlog.info('store rate-limited this page; rested', { provider, retryAfterSec: err.retryAfterSec });
				} else if (!f.abort.signal.aborted) wlog.debug('tracklist not read', { provider, error: err instanceof Error ? err.message : String(err) });
				return null;
			}
		};
		const progress = (): void => say(f, { done: left.filter((x) => x.done).length });

		// Beatport first: its page carries BPM, key and genre with the tracklist.
		for (const x of left) {
			if (f.abort.signal.aborted) break;
			const page = x.beatport;
			if (!page) continue;
			x.done = take(x.r, await readOne('beatport', () => readers.beatportRelease(page.id, page.url, signalOf(f))));
			progress();
		}
		// Then Spotify, twenty albums a call.
		const viaSpotify = left.filter((x) => !x.done && x.spotify);
		if (viaSpotify.length && !f.abort.signal.aborted && (await deps.spotify())) {
			say(f, { source: 'spotify' });
			try {
				const albums = await readers.spotifyAlbums(viaSpotify.map((x) => x.spotify!.id), signalOf(f));
				for (const x of viaSpotify) x.done = take(x.r, albums.get(x.spotify!.id));
			} catch (err) {
				// The ban, or Spotify failing: these releases are asked for again
				// the next time their page is read (unless Deezer reads them now).
				for (const x of viaSpotify) if (!x.deezer) fillTried.delete(x.r.id);
				if (!isSpotifyQuotaBackoff(err)) wlog.debug('tracklists not read', { provider: 'spotify', error: err instanceof Error ? err.message : String(err) });
			}
			progress();
		}
		// Deezer last, for what no other store read — and for the tracklist
		// alone: who the release is by is not Deezer's to say (head of file).
		for (const x of left) {
			if (f.abort.signal.aborted) break;
			const page = x.deezer;
			if (x.done || !page) continue;
			const claim = await readOne('deezer', () => readers.deezerRelease(page.id, signalOf(f)));
			x.done = take(x.r, claim ? withoutCredits(claim) : null);
			progress();
		}
		say(f, { source: null, done: empty.length });
		if (!claims.length) return [];
		await client.register(claims);
		wlog.info('tracklists read for a page', { kind: f.ref.kind, asked: empty.length, read: claims.length });
		return filled;
	}

	const remember = (f: Front, patch: EntityRowPatch): void => {
		const prior = found.get(patch.recordingId);
		const merged: EntityRowPatch = { ...prior, ...patch, ...(prior?.streamIds || patch.streamIds ? { streamIds: { ...prior?.streamIds, ...patch.streamIds } } : {}) };
		found.set(patch.recordingId, merged);
		emit(f, { rows: [merged] });
	};

	async function flushClaims(f: Front): Promise<void> {
		const batch = f.claims.splice(0);
		const client = deps.catalog();
		if (!batch.length || !client?.status().available) return;
		const key = `page-facts:${createHash('sha256').update(batch.map((c) => c.key).join(',')).digest('hex').slice(0, 32)}`;
		try {
			await client.reportEnrichment(batch.map((c) => c.claim), key);
			// The catalogue counts an artist's or a label's genres off its
			// recordings': the header read before these findings is behind
			// them now. The rows are not — they were patched as each was found.
			if (batch.some((c) => c.claim.genres?.length)) {
				deps.pages.drop(null);
				emit(f, { changed: 'header' });
			}
		} catch (err) {
			wlog.warn('page findings not sent to the catalogue', { claims: batch.length }, err);
		}
	}

	// A release's rows on Spotify: the album the catalogue names, or the one
	// the names find and the tracklist confirms (the feed's rules).
	async function matchRelease(f: Front, r: CatalogPageRelease, client: SpotifyMatchClient): Promise<void> {
		const ours = r.tracks.map((t) => ({ t, title: t.title, durationSec: t.durationSec, isrc: t.isrc }));
		const artists = r.artists.map((a) => a.name);
		const known = handleOf(r.handles, 'spotify');
		let albumId = known?.id ?? null;
		let pairs: Map<(typeof ours)[number], SpotifySimplifiedTrack> | null = null;
		if (albumId) pairs = pairTracks(ours, await client.getAlbumTracks(albumId));
		else {
			const hit = await findSpotifyAlbum(client, { title: r.title, artists, tracks: ours });
			albumId = hit?.album.id ?? null;
			pairs = hit?.pairs ?? null;
		}
		if (!albumId || !pairs) return;
		if (!known) {
			f.claims.push({
				key: `spotify:album:${albumId}`,
				claim: {
					provider: 'spotify',
					kind: 'release',
					providerId: albumId,
					name: r.title,
					url: `https://open.spotify.com/album/${albumId}`,
					artists: nameClaims(artists),
					facts: { ...(r.date ? { releaseDate: r.date } : {}), ...(r.type ? { releaseType: r.type } : {}) },
				},
			});
		}
		for (const [o, sp] of pairs) {
			if (handleOf(o.t.handles, 'spotify')) continue;
			f.claims.push({
				key: `spotify:track:${sp.id}`,
				claim: {
					provider: 'spotify',
					kind: 'recording',
					providerId: sp.id,
					name: o.t.title,
					url: `https://open.spotify.com/track/${sp.id}`,
					identifiers: o.t.isrc ? [{ namespace: 'isrc', value: o.t.isrc }] : [],
					artists: nameClaims((o.t.artists.length ? o.t.artists : r.artists).map((a) => a.name)),
					facts: o.t.durationSec ? { durationSec: o.t.durationSec } : {},
				},
			});
			remember(f, { recordingId: o.t.id, streamIds: { spotify: sp.id } });
		}
	}

	// A row's BPM, key, genre and label at Beatport, then Traxsource. Only
	// what the row lacks is taken: the catalogue's facts are never replaced.
	// True when something was found for it.
	async function factsRow(f: Front, r: CatalogPageRelease, t: CatalogPageTrack): Promise<boolean> {
		const artists = (t.artists.length ? t.artists : r.artists).map((a) => a.name);
		const label = r.labels[0]?.name ?? r.labelText ?? null;
		const res = await enrichOne({ query: { title: t.title, artists, durationSec: t.durationSec, isrc: t.isrc, label } }, deps.enrichers, { pacingMs: deps.pacingMs ?? FACTS_PACING_MS, signal: f.abort.signal });
		// A lookup that failed (blocked, offline) is not a miss: asked again later.
		if (res.errored && !res.patch) rowsTried.delete(t.id);
		if (!res.patch) return false;
		const patch: EntityRowPatch = { recordingId: t.id };
		if (t.bpm == null && res.patch.bpm) patch.bpm = res.patch.bpm;
		if (!t.key && res.patch.keyCamelot) patch.keyCamelot = res.patch.keyCamelot;
		if (!t.genres.length && res.patch.genre) patch.genre = res.patch.genre;
		if (!label && res.patch.label) patch.label = res.patch.label;
		const link = res.sourceLinks.find((l) => STORES.has(l.source) && l.sourceTrackId);
		if (link) {
			const isrc = t.isrc ?? link.isrc ?? null;
			const facts: NonNullable<CatalogClaim['facts']> = {};
			const bpm = link.bpm ?? res.patch.bpm;
			if (bpm) facts.bpm = bpm;
			if (link.key) facts.key = link.key;
			const duration = link.duration ?? t.durationSec;
			if (duration) facts.durationSec = duration;
			if (res.patch.label) facts.labelText = res.patch.label;
			if (Object.keys(facts).length || res.patch.genre) {
				f.claims.push({
					key: `${link.source}:${link.sourceTrackId}`,
					claim: {
						provider: link.source as CatalogClaim['provider'],
						kind: 'recording',
						providerId: link.sourceTrackId,
						name: link.title ?? t.title,
						url: link.url ?? null,
						identifiers: isrc ? [{ namespace: 'isrc', value: isrc }] : [],
						artists: nameClaims(link.artists?.length ? link.artists : artists),
						facts,
						...(res.patch.genre ? { genres: [res.patch.genre] } : {}),
					},
				});
			}
		}
		if (Object.keys(patch).length <= 1) return false;
		remember(f, patch);
		return true;
	}

	// The rows asked for by hand, before whatever row would be next.
	async function askedRows(f: Front): Promise<void> {
		if (!f.asked.size) return;
		if (f.status.phase !== 'details') say(f, { phase: 'details', source: null, done: 0, total: 0 });
		while (f.asked.size) {
			const [id, row] = f.asked.entries().next().value!;
			f.asked.delete(id);
			if (f.abort.signal.aborted) {
				row.settle(false);
				continue;
			}
			rowsTried.add(id);
			say(f, { total: f.status.total + 1 });
			let got = false;
			try {
				got = await factsRow(f, row.r, row.t);
			} catch (err) {
				wlog.debug('asked row lookup failed', { error: err instanceof Error ? err.message : String(err) });
			}
			f.askedDone.add(id);
			say(f, { done: f.status.done + 1 });
			row.settle(got);
		}
		// What was asked for is wanted now: up without waiting for a full batch.
		await flushClaims(f);
	}

	async function pageTask(f: Front, releases: CatalogPageRelease[]): Promise<void> {
		const empty = releases.filter((r) => r.trackCount === 0 && !fillTried.has(r.id));
		const filled = empty.length ? await fillTracklists(f, empty) : [];
		if (f.abort.signal.aborted) return;
		// The page reads the filled releases again — their rows show at once —
		// and hands them back for their own details, behind this page's.
		if (filled.length) {
			for (const r of filled) f.queued.delete(r.id);
			deps.pages.drop(f.catalogId);
			emit(f, { changed: 'tracks' });
		}
		await details(f, releases.filter((r) => r.tracks.length > 0));
	}

	async function details(f: Front, listed: CatalogPageRelease[]): Promise<void> {
		let spotify = (await deps.primary()) === 'spotify' ? await deps.spotify() : null;
		const lacksSpotify = (t: CatalogPageTrack): boolean => !handleOf(t.handles, 'spotify') && !found.get(t.id)?.streamIds?.spotify;
		const plan = listed.map((r) => ({
			r,
			match: !!spotify && !matchTried.has(r.id) && r.tracks.some(lacksSpotify),
			rows: deps.enrichers.length ? r.tracks.filter((t) => !rowsTried.has(t.id) && !hasDjFacts(t)) : [],
		}));
		// A recording on two of the page's releases is looked up once.
		const seen = new Set<string>();
		for (const p of plan) p.rows = p.rows.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
		const total = plan.reduce((n, p) => n + (p.match ? 1 : 0) + p.rows.length, 0);
		if (!total) return;
		say(f, { phase: 'details', source: null, done: 0, total });
		try {
			// Release by release, so the top of the page is whole first.
			for (const p of plan) {
				if (p.match && spotify) {
					if (f.abort.signal.aborted) return;
					matchTried.add(p.r.id);
					try {
						await matchRelease(f, p.r, spotify);
					} catch (err) {
						// Not a miss: asked again when the page is next read.
						matchTried.delete(p.r.id);
						// The quota ban landed: no more Spotify for this page.
						if (isSpotifyQuotaBackoff(err)) spotify = null;
						else wlog.debug('spotify match failed', { error: err instanceof Error ? err.message : String(err) });
					}
				}
				if (p.match) say(f, { done: f.status.done + 1 });
				for (const t of p.rows) {
					if (f.abort.signal.aborted) return;
					await askedRows(f);
					if (f.abort.signal.aborted) return;
					// Looked up by hand since this pass was planned: its place counts, no second lookup.
					if (f.askedDone.has(t.id)) {
						say(f, { done: f.status.done + 1 });
						continue;
					}
					rowsTried.add(t.id);
					await factsRow(f, p.r, t);
					say(f, { done: f.status.done + 1 });
					if (f.claims.length >= CLAIMS_FLUSH) await flushClaims(f);
				}
			}
		} finally {
			// What was found goes up even when the page was left midway.
			await flushClaims(f);
		}
	}

	return {
		watch(asked, token) {
			const ref = asked ? normalizeEntityRef(asked) : null;
			const key = ref ? refKey(ref) : null;
			if (front && key && front.key === key) {
				front.token = token;
				emit(front);
				return;
			}
			if (front) {
				front.abort.abort();
				// Nothing more is looked up for a page that was left.
				for (const row of front.asked.values()) row.settle(false);
				front.asked.clear();
			}
			front = null;
			if (!ref || !key) return;
			const f: Front = { key, token, ref, catalogId: ref.catalogId ?? null, abort: new AbortController(), status: { ...IDLE }, lane: Promise.resolve(), waiting: 0, queued: new Set(), gen: 0, claims: [], asked: new Map(), askedDone: new Set() };
			front = f;
			enqueue(f, 'listing', () => listing(f));
		},

		pageLoaded(catalogId, result) {
			if (front && front.catalogId === catalogId) queuePage(front, result);
		},

		patchOf: (recordingId) => found.get(recordingId),

		async enrich(recordingIds) {
			const f = front;
			if (!f?.catalogId || !deps.enrichers.length || !recordingIds.length) return { asked: 0, found: 0 };
			const want = new Set(recordingIds);
			const rows = new Map<string, { r: CatalogPageRelease; t: CatalogPageTrack }>();
			for (const result of await deps.pages.loaded(f.catalogId)) {
				for (const r of result.releases) for (const t of r.tracks) if (want.has(t.id) && !rows.has(t.id)) rows.set(t.id, { r, t });
			}
			if (front !== f || f.abort.signal.aborted || !rows.size) return { asked: 0, found: 0 };
			const settled = [...rows].map(([id, row]) => new Promise<boolean>((resolve) => {
				// Asked twice before it ran: one lookup answers both.
				const prior = f.asked.get(id);
				f.asked.set(id, { ...row, settle: (got) => { prior?.settle(got); resolve(got); } });
			}));
			// The page's own pass takes them before its next row; with none
			// running, this does.
			enqueue(f, 'asked rows', () => askedRows(f));
			const got = await Promise.all(settled);
			return { asked: got.length, found: got.filter(Boolean).length };
		},

		subscribe(cb) {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
	};
}
