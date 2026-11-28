// What this desktop does for the entity page in front, beyond showing it
// ('catalog_device_work': the cloud plans, the device reads).
//
// Every catalogue page this desktop reads for the page in front carries what
// it can read now (entity/service.ts asks `profile`), and the catalogue's
// answer may carry work: the entity's store page to read for new releases, a
// release's tracklist or its page at another store, a track's BPM, key and
// genre. The reading engine (@curator/catalog-work, the one the phone runs
// too) does it; this is its host:
//   - one visit per page in front: the engine counts what the visit took
//     across every page read in it, and runs the work of one read after the
//     other;
//   - what is found shows at once — rows patched in place, laid over the page
//     read again before the catalogue has it (`patchOf`) — and when the cloud
//     has kept a report, the page reads the catalogue again (`changed`);
//   - the store reads go out the way the rest of the app's do: Spotify
//     through the process-wide gate the player and the feed share (and not
//     during its quota ban), Beatport and Traxsource lookups through the
//     feed's own enrichers, so the two share one lane and one Cloudflare
//     cool-down. Every store is read: the Refresh menu's checkboxes are
//     about the weekly reads of the user's follows, not about pages.
//
// Two things stay here, outside the engine:
//   - an entity the catalogue does not know, shown from the user's streaming
//     service (@curator/catalog-work streaming, `world.via`): registered as that same
//     read, so the page becomes the catalogue's (a label known only by name
//     is handed to the catalogue's own label lookups);
//   - rows the user asks to have looked up now (`enrich`): one facts job a
//     release, in a visit of their own, so rows already tried are asked again.
//
// Nothing here touches the library.

import { createWorkEngine, type WorkEngine, type WorkEngineDeps, type WorkEvent, type WorkPhase, type WorkReaders, type WorkRowPatch, type WorkVisit, type StreamingCatalog } from '@curator/catalog-work';
import type { FetchLike } from '@curator/catalog-readers';
import { isDistributor } from '@curator/library-logic';
import { ProviderBlockedError } from '@curator/matcher';
import type { CatalogClaim, CatalogDeviceProfile, CatalogFactsJob, CatalogFactsStore, CatalogPageRelease, CatalogRef, CatalogTracksResult, CatalogWork, CatalogWorkStore } from '@curator/protocol';
import { CATALOG_MAX_NESTED } from '@curator/protocol';
import { gatedFetch, isSpotifyQuotaBackoff } from '@curator/spotify';
import { searchFold, type EntityHeader, type EntityRef, type EntityRowPatch, type EntityWorkEvent, type EntityWorkPhase, type EntityWorkStatus } from '@curator/shared';
import type { Enricher } from '@curator/sync-core/enrich/contract';
import { log } from '@curator/sync-core/log';
import type { CatalogClient } from '../catalog-client/service.js';
import { normalizeEntityRef } from './service.js';

const wlog = log.for('entity-work');

// An artist met through the streaming service: this many of its newest
// releases go up with their tracklists (twenty a call there); the older ones
// as the listing names them, their tracklists read when the catalogue asks.
const STREAM_FULL_MAX = 100;
const STREAM_BATCH = 20;
// Saves the cloud reports in a burst are one reload of the page.
const RELOAD_GAP_MS = 3000;
const FACTS_STORES: CatalogFactsStore[] = ['beatport', 'traxsource'];

export type EntityWorkPages = {
	page(ref: EntityRef): Promise<EntityHeader>;
	// The entity's World pages read so far and still held.
	loaded(catalogId: string): Promise<CatalogTracksResult[]>;
	// The catalogue's answer for the entity changed: read it again when asked.
	drop(catalogId: string | null): void;
};

export type EntityWorkDeps = {
	catalog(): Pick<CatalogClient, 'status' | 'offersWork' | 'register' | 'enrichLabels' | 'workReport'> | null;
	pages: EntityWorkPages;
	spotifyToken(): Promise<string | null>;
	// When Spotify's quota ban ends (past: none).
	spotifyBackoffUntil(): number;
	// The streaming service read as a catalogue, when the pages show unknown
	// entities from it (@curator/catalog-work streaming): what a discovery registers.
	streaming?(): StreamingCatalog | null;
	// The store lookups for a row's DJ facts, the feed's (service.ts
	// storeEnrichers, each in its lane).
	enrichers: readonly Enricher[];
	fetch?: FetchLike;
	// Spotify's calls: the process-wide gate, by default.
	spotifyFetch?: FetchLike;
	// Electron's net.fetch (or FlareSolverr) for Beatport and Traxsource
	// pages; without it neither is read.
	beatportFetch?: FetchLike;
	now?: () => number;
	// Tests: the engine's own seams (readers, sleep, gaps).
	engine?: Pick<WorkEngineDeps, 'readers' | 'sleep' | 'gaps' | 'callTimeoutMs'>;
};

export interface EntityWork {
	// The page in front (null: none). `token` comes back on every event.
	watch(ref: EntityRef | null, token: number): void;
	// What this desktop says of itself with a read of a catalogue object's
	// page: the visit's profile when the object is the page in front, else
	// null (no work asked for).
	profile(catalogId: string): CatalogDeviceProfile | null;
	// A World page the catalogue answered (entity/service.ts), with the work
	// it carried and the hints it was read with.
	read(catalogId: string, result: CatalogTracksResult, work: CatalogWork | undefined, hints: CatalogRef[]): void;
	// What the work found for a recording this session: laid over a page read
	// again before the catalogue has it.
	patchOf(recordingId: string): EntityRowPatch | undefined;
	// Rows of the page in front the user asked to have looked up at the stores
	// now (BPM, key, genre, label), once more for rows already tried. Resolves
	// when they have been: `asked` is how many of the rows the page holds,
	// `found` how many a store had something for.
	enrich(recordingIds: readonly string[]): Promise<{ asked: number; found: number }>;
	// Background work ('catalog_background_work'): what this desktop, as its
	// account's main one, is handed on the catalogue worker's check
	// (catalog-worker/service.ts) — the releases its weekly reads created, to
	// complete. Run on this same engine, so the pages and the background share
	// the stores' lanes and cool-downs. `backgroundProfile`: what to ask with,
	// null while device work is not offered.
	backgroundProfile(): CatalogDeviceProfile | null;
	runBackground(work: CatalogWork): Promise<void>;
	subscribe(cb: (e: EntityWorkEvent) => void): () => void;
}

type Front = {
	key: string;
	token: number;
	ref: EntityRef;
	catalogId: string | null;
	abort: AbortController;
	visit: WorkVisit;
	status: EntityWorkStatus;
	// Runs of the engine not yet idle.
	running: number;
	// The rows the page holds, by recording: whether each has a genre of its
	// own (a found genre other than Beatport's only fills one that has none).
	ownGenre: Map<string, boolean>;
	reloadAt: number;
	reloadTimer: ReturnType<typeof setTimeout> | null;
};

const IDLE: EntityWorkStatus = { phase: null, source: null, found: 0, added: 0, done: 0, total: 0 };
const PHASES: Record<WorkPhase, EntityWorkPhase> = { listing: 'updates', tracklists: 'tracklists', details: 'details' };

const refKey = (r: Pick<EntityRef, 'kind' | 'name' | 'libraryId' | 'catalogId' | 'spotifyId'>): string =>
	`${r.kind}:${r.catalogId ? `c:${r.catalogId}` : r.libraryId ? `l:${r.libraryId}` : r.spotifyId ? `s:${r.spotifyId}` : `n:${searchFold(r.name).trim()}`}`;

const clamp = (c: CatalogClaim): CatalogClaim => ({
	...c,
	...(c.recordings ? { recordings: c.recordings.slice(0, CATALOG_MAX_NESTED) } : {}),
	...(c.artists ? { artists: c.artists.slice(0, CATALOG_MAX_NESTED) } : {}),
});

// The feed's enrichers as the engine's facts reader: one lane and one
// cool-down per store for the feed and the pages. A lookup the store turned
// away (cooling down, or blocked while it waited its turn) is a block, not a
// miss; a call that failed throws (ProviderFailedError) and is the engine's
// to judge.
function enricherFacts(enrichers: readonly Enricher[], now: () => number): Pick<WorkReaders, 'facts' | 'blockedUntil'> {
	const of = (store: string): Enricher | undefined => enrichers.find((e) => e.id === store);
	const blocked = (e: Enricher): number | null => {
		const until = e.blockedUntil?.() ?? null;
		return until !== null && until > now() ? until : null;
	};
	return {
		async facts(store, q, signal) {
			const e = of(store);
			if (!e) throw new Error(`no ${store} lookup on this desktop`);
			const target = { query: { title: q.title, artists: q.artists, durationSec: q.durationSec, isrc: q.isrc } };
			if (!e.applicableTo(target)) {
				if (blocked(e)) throw new ProviderBlockedError(store, 0, 'cooldown');
				return null;
			}
			const out = await e.enrich(target, signal);
			if (!out && blocked(e)) throw new ProviderBlockedError(store, 0, 'cooldown');
			if (out?.kind !== 'metadata' || !out.sourceLink?.url) return null;
			const link = out.sourceLink;
			return {
				id: link.sourceTrackId,
				url: link.url!,
				title: link.title ?? q.title,
				mix: null,
				isrc: link.isrc ?? null,
				durationSec: link.duration ?? null,
				bpm: link.bpm ?? out.patch.bpm ?? null,
				key: link.key ?? out.patch.keyCamelot ?? null,
				genre: out.patch.genre ?? null,
				label: out.patch.label ?? null,
				artists: link.artists ?? [],
			};
		},
		blockedUntil(store) {
			const e = of(store);
			return e ? blocked(e) : null;
		},
	};
}

export function createEntityWork(deps: EntityWorkDeps): EntityWork {
	const now = deps.now ?? Date.now;
	const listeners = new Set<(e: EntityWorkEvent) => void>();
	// What the work found this session, by recording.
	const found = new Map<string, EntityRowPatch>();
	// Entities registered this session: a page reopened is not registered twice.
	const registered = new Set<string>();
	let front: Front | null = null;
	// Background runs end when the app does, not when a page is left.
	const backgroundAbort = new AbortController();

	const offered = (): boolean => deps.catalog()?.offersWork() ?? false;

	const engine: WorkEngine = createWorkEngine({
		form: 'desktop',
		enabled: offered,
		// Every store: the Refresh menu's checkboxes say which sources read the
		// user's follows each week, not what a page or the background may read
		// (Guy, 2026-11-27) — those the stores' own rests and the cloud's daily
		// counts hold back.
		allowed: (store) => store !== 'spotify' || deps.spotifyBackoffUntil() <= now(),
		fetch: deps.fetch ?? ((u, i) => fetch(u, i)),
		spotifyFetch: deps.spotifyFetch ?? ((u, i) => gatedFetch(u, i, 'entity:page')),
		...(deps.beatportFetch ? { beatportFetch: deps.beatportFetch, traxsourceFetch: deps.beatportFetch } : {}),
		spotifyToken: () => deps.spotifyToken(),
		// The quota ban is the app's own, not Spotify failing: kept here, and
		// the store rests until it ends.
		classify: (store, e) => (store === 'spotify' && isSpotifyQuotaBackoff(e) ? { mine: true, restMs: Math.max(60_000, deps.spotifyBackoffUntil() - now()) } : null),
		report: (input) => {
			const client = deps.catalog();
			if (!client) return Promise.reject(new Error('the catalogue is not reachable'));
			return client.workReport(input);
		},
		now,
		...deps.engine,
		readers: { ...enricherFacts(deps.enrichers, now), ...deps.engine?.readers },
	});

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

	// The catalogue kept what was reported: the page reads it again — once
	// for a burst of saves, and at the latest when the work goes quiet.
	const reload = (f: Front, at: 'save' | 'idle'): void => {
		if (front !== f) return;
		if (at === 'save' && f.reloadTimer) return;
		const fire = (): void => {
			f.reloadTimer = null;
			f.reloadAt = now();
			deps.pages.drop(f.catalogId);
			emit(f, { changed: 'tracks' });
		};
		if (at === 'idle') {
			if (f.reloadTimer) {
				clearTimeout(f.reloadTimer);
				fire();
			}
			return;
		}
		f.reloadTimer = setTimeout(fire, Math.max(0, f.reloadAt + RELOAD_GAP_MS - now()));
	};

	const remember = (f: Front, rows: readonly WorkRowPatch[]): void => {
		const out: EntityRowPatch[] = [];
		for (const r of rows) {
			const patch: EntityRowPatch = { recordingId: r.recordingId };
			if (r.bpm) patch.bpm = r.bpm;
			if (r.keyCamelot) patch.keyCamelot = r.keyCamelot;
			// Beatport's genre stands over the row's own; any other store's only
			// fills a row that has none (feed: preferBeatportGenre).
			if (r.genre && (r.from === 'beatport' || !f.ownGenre.get(r.recordingId))) patch.genre = r.genre;
			if (r.label) patch.label = r.label;
			if (r.streamIds?.spotify) patch.streamIds = { spotify: r.streamIds.spotify };
			if (Object.keys(patch).length <= 1) continue;
			const prior = found.get(r.recordingId);
			const merged: EntityRowPatch = { ...prior, ...patch, ...(prior?.streamIds || patch.streamIds ? { streamIds: { ...prior?.streamIds, ...patch.streamIds } } : {}) };
			found.set(r.recordingId, merged);
			out.push(merged);
		}
		if (out.length) emit(f, { rows: out });
	};

	const onEvent = (f: Front) => (e: WorkEvent): void => {
		switch (e.type) {
			case 'progress':
				say(f, { phase: PHASES[e.phase], source: e.store, done: e.done, total: e.total });
				break;
			case 'found':
				say(f, { found: f.status.found + e.claims.length });
				break;
			case 'rows':
				remember(f, e.rows);
				break;
			case 'saved':
				reload(f, 'save');
				break;
			case 'refused':
				wlog.info('the catalogue did not take some of the page work', { results: e.results.length, notes: [...new Set(e.results.map((r) => r.note ?? r.outcome))].slice(0, 5) });
				break;
			case 'unsent':
				wlog.warn('page work not reported', { results: e.results, error: e.error });
				break;
			case 'idle':
				break;
		}
	};

	function run(f: Front, work: CatalogWork, hints: CatalogRef[]): void {
		f.running++;
		void engine
			.run(work, { visit: f.visit, hints, signal: f.abort.signal, onEvent: onEvent(f) })
			.catch((err: unknown) => wlog.warn('page work failed', { kind: f.ref.kind }, err))
			.finally(() => {
				f.running--;
				if (f.running) return;
				reload(f, 'idle');
				if (f.status.phase !== null) say(f, { phase: null, source: null, done: 0, total: 0 });
			});
	}

	// ── an entity the catalogue does not know ─────────────────────────────

	// An artist the catalogue is meeting now, from the streaming service its
	// page is already showing: every release it lists, the newest in full.
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

	async function discover(f: Front): Promise<void> {
		const header = await deps.pages.page(f.ref);
		if (f.abort.signal.aborted) return;
		f.catalogId = header.ref.catalogId ?? f.catalogId;
		// Unknown to the catalogue: it said so, or the page is the streaming
		// service's in its place (`via`).
		if (header.world.reason !== 'unknown' && !header.world.via) return;
		const client = deps.catalog();
		const key = refKey(header.ref);
		if (!client?.status().available || registered.has(key)) return;
		const { kind, name } = header.ref;
		let up: CatalogClaim[] = [];
		if (kind === 'label') {
			// A distributor's name is on thousands of unrelated releases: not a label.
			if (isDistributor(name)) return;
			say(f, { phase: 'discover', source: null });
			// By its name: the catalogue finds its pages, and its work reads them.
			await client.enrichLabels([name]);
		} else {
			const stream = deps.streaming?.() ?? null;
			const spotifyId = header.links.find((l) => l.source === 'spotify' && l.sourceId && !l.sourceId.includes('/'))?.sourceId ?? header.ref.spotifyId ?? null;
			if (stream?.service !== 'spotify' || !spotifyId) return;
			say(f, { phase: 'discover', source: 'spotify' });
			if (kind === 'artist') {
				const self: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: spotifyId, name, url: `https://open.spotify.com/artist/${spotifyId}` };
				up = [self, ...(await streamedReleases(f, stream, spotifyId))];
			} else {
				const album = (await stream.releases([spotifyId])).get(spotifyId);
				up = album ? [album] : [];
			}
			if (f.abort.signal.aborted || !up.length) return;
		}
		let added = 0;
		if (up.length) added = (await client.register(up.map(clamp))).made.filter((made, i) => made && up[i]!.kind === 'release').length;
		if (f.abort.signal.aborted) return;
		registered.add(key);
		f.status.added = added;
		// The page as the catalogue knows it now (its reads carry their work).
		deps.pages.drop(null);
		const again = await deps.pages.page(f.ref);
		registered.add(refKey(again.ref));
		f.catalogId = again.ref.catalogId ?? null;
		say(f, { phase: null, source: null });
		emit(f, { changed: 'header' });
		wlog.info('page registered from the streaming service', { kind, added });
	}

	// ── rows looked up by hand ────────────────────────────────────────────

	async function enrichRows(f: Front, ids: readonly string[]): Promise<{ asked: number; found: number }> {
		if (!f.catalogId || !offered()) return { asked: 0, found: 0 };
		const want = new Set(ids);
		const stores = FACTS_STORES;
		const byRelease = new Map<string, { r: CatalogPageRelease; tracks: CatalogFactsJob['tracks'] }>();
		const seen = new Set<string>();
		for (const result of await deps.pages.loaded(f.catalogId)) {
			for (const r of result.releases) {
				for (const t of r.tracks) {
					if (!want.has(t.id) || seen.has(t.id)) continue;
					seen.add(t.id);
					const entry = byRelease.get(r.id) ?? { r, tracks: [] };
					entry.tracks.push({ id: t.id, title: t.title, artists: (t.artists.length ? t.artists : r.artists).map((a) => a.name), durationSec: t.durationSec, isrc: t.isrc, position: t.position, label: r.labels[0]?.name ?? r.labelText });
					byRelease.set(r.id, entry);
				}
			}
		}
		if (front !== f || f.abort.signal.aborted || !seen.size || !stores.length) return { asked: 0, found: 0 };
		const jobs: CatalogFactsJob[] = [...byRelease].map(([id, { tracks }]) => ({ id: `facts:${id}`, kind: 'facts', stores, tracks }));
		const hit = new Set<string>();
		const events = onEvent(f);
		f.running++;
		try {
			// A visit of their own: rows this page's visit tried are asked again.
			await engine.run({ jobs, limits: { rounds: 1, releases: jobs.length } }, {
				visit: engine.visit(),
				signal: f.abort.signal,
				onEvent: (e) => {
					if (e.type === 'rows') for (const r of e.rows) hit.add(r.recordingId);
					events(e);
				},
			});
		} finally {
			f.running--;
			if (!f.running) {
				reload(f, 'idle');
				if (f.status.phase !== null) say(f, { phase: null, source: null, done: 0, total: 0 });
			}
		}
		return { asked: seen.size, found: [...seen].filter((id) => hit.has(id)).length };
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
				if (front.reloadTimer) clearTimeout(front.reloadTimer);
			}
			front = null;
			if (!ref || !key) return;
			const f: Front = { key, token, ref, catalogId: ref.catalogId ?? null, abort: new AbortController(), visit: engine.visit(), status: { ...IDLE }, running: 0, ownGenre: new Map(), reloadAt: 0, reloadTimer: null };
			front = f;
			void discover(f).catch((err: unknown) => {
				if (!f.abort.signal.aborted) wlog.warn('page discovery failed', { kind: f.ref.kind }, err);
				if (f.status.phase === 'discover') say(f, { phase: null, source: null });
			});
		},

		profile(catalogId) {
			const f = front;
			if (!f || f.abort.signal.aborted || !offered()) return null;
			// The page in front, or — before its header said what it is — the
			// first page read for it.
			if (f.catalogId && f.catalogId !== catalogId) return null;
			return engine.profile(f.visit);
		},

		read(catalogId, result, work, hints) {
			const f = front;
			if (!f || f.abort.signal.aborted) return;
			if (f.catalogId && f.catalogId !== catalogId) return;
			f.catalogId ??= catalogId;
			for (const r of result.releases) for (const t of r.tracks) f.ownGenre.set(t.id, t.genres.length > 0);
			if (work?.jobs.length) run(f, work, hints);
		},

		patchOf: (recordingId) => found.get(recordingId),

		backgroundProfile: () => (offered() ? engine.profile() : null),

		async runBackground(work) {
			let changed = false;
			await engine.run(work, {
				visit: engine.visit(),
				signal: backgroundAbort.signal,
				onEvent: (e) => {
					// What it finds shows on the page in front only where it is that
					// page's: its rows patched, and read again once the cloud kept it.
					const f = front;
					if (e.type === 'rows' && f) remember(f, e.rows.filter((r) => f.ownGenre.has(r.recordingId)));
					if (e.type === 'saved' && f && e.changed.some((id) => id === f.catalogId || f.ownGenre.has(id))) changed = true;
					if (e.type === 'unsent') wlog.warn('background work not reported', { results: e.results, error: e.error });
					if (e.type === 'refused') wlog.info('the catalogue did not take some background work', { results: e.results.length });
				},
			});
			const f = front;
			if (changed && f) reload(f, 'save');
			wlog.info('background work done', { jobs: work.jobs.length });
		},

		async enrich(recordingIds) {
			const f = front;
			if (!f || !recordingIds.length) return { asked: 0, found: 0 };
			return enrichRows(f, recordingIds);
		},

		subscribe(cb) {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
	};
}
