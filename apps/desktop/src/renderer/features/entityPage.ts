// Entity pages — the artist / label / album page's data, between core
// (entity:page, entity:tracks) and the two things that show it: the header
// (components/EntityHeader.tsx reads the signals here) and the main track
// list (main.ts asks for the rows).
//
// A page has a header and one of two lists. Owned is the library's local
// files — main.ts lists them through the ordinary `tracks:list` with the
// header's filter, nothing of it lives here. World is the Global Catalog's
// releases, paged by core and held here as list rows (catalogRows.ts) per
// entity, so Owned ↔ World and Back / Forward do not refetch. For an artist or
// an album the catalogue does not know, core answers World from the user's
// streaming service instead (the header's `world.via`): the same rows, held
// under the service's id until the catalogue takes the page over.
//
// The header arrives twice: at once from the library (`local`), then with
// what the catalogue knows (`full`) — a page never waits on the network to
// show what the library has.
//
// While a page is open core works for it (apps/core entity/work.ts): it
// reads the stores for what the catalogue lacks and fills in the rows. This
// module tells core which page is in front (`entity:watch`) and takes what
// comes back (`entity:work`): the progress the header shows, rows patched in
// place, and "the catalogue's answer changed" — the header and the loaded
// pages are then read again.

import { createSignal } from 'solid-js';
import type { AlbumSummary, EntityHeader, EntityRef, EntityRowPatch, EntityTracksPage, EntityWorkEvent, EntityWorkStatus, Track } from '@curator/shared';
import { albumSummaryOf, CATALOG_ROW_PREFIX, heldTrackIds, patchRow, toRows } from '../catalogRows.js';
import { entityApi, tracksApi } from '../data/api.js';
import { log } from '../data/log.js';
import { entityKey, sameEntity } from '../viewmodel/navHistory.js';

const elog = log.for('entity-page');

// How many tracks a sort or a filter over a partly loaded World list will
// load to before it stops: past this the page says it is showing part.
export const WORLD_FILL_CAP = 3000;
const WORLD_CACHE_MAX = 10;
// A page of the catalogue that failed to load is not asked for again by the
// next repaint (the list repaints on every library event — a failing call
// used to be retried dozens of times a second): only after this long, or
// when the user asks.
const WORLD_RETRY_MS = 10_000;
// While a page says "the catalogue is not reachable", it asks again by
// itself: quickly at first (a busy server answers within seconds), then
// every half minute, and gives up after a few minutes (Try again remains).
const REASK_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
const REASK_MAX = 14;

export interface WorldProgress {
	// 'loading': a page of the catalogue is on its way.
	state: 'idle' | 'loading' | 'error';
	releases: number;
	tracks: number;
	// Releases the catalogue holds for the entity (first page's count).
	total: number | null;
	// More pages remain.
	more: boolean;
	error: string | null;
}

const IDLE: WorldProgress = { state: 'idle', releases: 0, tracks: 0, total: null, more: false, error: null };

interface WorldList {
	rows: Track[];
	albums: Map<string, AlbumSummary>;
	nextCursor: string | null;
	// Pages read so far: a reload reads as many again.
	pages: number;
	started: boolean;
	loading: Promise<boolean> | null;
	error: string | null;
	failedAt: number;
}

interface OpenPage {
	ref: EntityRef;
	local: Promise<EntityHeader>;
	full: Promise<EntityHeader>;
	// How many times the header was asked again since the catalogue last answered.
	reasks: number;
}

const [header, setHeader] = createSignal<EntityHeader | null>(null);
// The catalogue's half of the header is still on its way.
const [headerPending, setHeaderPending] = createSignal(false);
const [world, setWorld] = createSignal<WorldProgress>(IDLE);
// What core is doing for the open page right now (null: nothing to say).
const [work, setWork] = createSignal<EntityWorkStatus | null>(null);

let open: OpenPage | null = null;
const worlds = new Map<string, WorldList>();

// What a page's World list is held under: the catalogue's object, or — while
// the page is the streaming service's — the service's id for the entity. The
// two are different lists: when the catalogue learns the entity the page
// reads its World side again, from there.
function worldKey(h: EntityHeader | null): string | null {
	if (!h) return null;
	if (h.ref.catalogId) return h.ref.catalogId;
	return h.world.via && h.ref.spotifyId ? `${h.world.via}:${h.ref.kind}:${h.ref.spotifyId}` : null;
}
// What core decides the page's work by: asked again when it changes.
const worldState = (h: EntityHeader | null | undefined): string => (h ? `${h.world.reason}:${h.world.via ?? ''}` : '');
let reaskTimer: ReturnType<typeof setTimeout> | null = null;

// The list's side of the work events, set by main.ts: rows changed in place
// (repaint those), or the World list was read again (repaint the list).
let listPort: { rowsPatched(rows: Track[]): void; worldReloaded(): void } | null = null;
// The number the open page is watched under; 0: no page is.
let watchSeq = 0;
let watching = 0;
let subscribed = false;

// Tell core which page is in front. Asked again when the catalogue's answer
// about the page changes kind (not reachable → reachable, unknown → known):
// core decides what there is to do from the header it reads itself.
function watch(ref: EntityRef | null): void {
	if (!ref && !watching) return;
	watching = ref ? ++watchSeq : 0;
	setWork(null);
	if (ref && !subscribed) {
		subscribed = true;
		entityApi.onWork(onWork);
	}
	void entityApi.watch(ref, watching).catch((e: unknown) => elog.warn('page watch failed', undefined, e));
}

function onWork(e: EntityWorkEvent): void {
	if (!open || e.watch !== watching) return;
	setWork(e.status.phase !== null || e.status.added > 0 ? e.status : null);
	if (e.rows?.length) patchWorldRows(e.rows);
	if (e.changed) {
		// The header first (the entity is known now; its release count, its
		// labels or its genres moved), then — where it was the releases that
		// changed — the loaded pages.
		const tracks = e.changed === 'tracks';
		void entityPage.refresh()
			.then(() => (tracks ? reloadWorld() : undefined))
			.catch((err: unknown) => elog.warn('reload after page work failed', undefined, err));
	}
}

function patchWorldRows(patches: readonly EntityRowPatch[]): void {
	const id = worldKey(header());
	const w = id ? worlds.get(id) : undefined;
	if (!w) return;
	const by = new Map(patches.map((p) => [p.recordingId, p]));
	const changed: Track[] = [];
	w.rows = w.rows.map((row) => {
		const p = row.catalog ? by.get(row.catalog.recordingId) : undefined;
		const next = p ? patchRow(row, p) : row;
		if (next !== row) changed.push(next);
		return next;
	});
	if (changed.length) listPort?.rowsPatched(changed);
}

// A header just landed for `page`. One that says the catalogue could not be
// reached is asked for again after a moment; one from the catalogue clears
// what an earlier failure left on its World list.
function settle(page: OpenPage, h: EntityHeader): void {
	if (reaskTimer) { clearTimeout(reaskTimer); reaskTimer = null; }
	if (h.world.reason !== 'server_off') {
		page.reasks = 0;
		const key = worldKey(h);
		const w = key ? worlds.get(key) : undefined;
		if (w?.error && h.world.available) { w.error = null; w.failedAt = 0; }
		return;
	}
	if (page.reasks >= REASK_MAX) return;
	const delay = REASK_DELAYS_MS[Math.min(page.reasks, REASK_DELAYS_MS.length - 1)]!;
	page.reasks++;
	reaskTimer = setTimeout(() => {
		reaskTimer = null;
		if (open === page) void entityPage.refresh().catch((e: unknown) => elog.warn('header re-ask failed', undefined, e));
	}, delay);
}

// The World list of a catalogue object, made on first ask; oldest dropped.
function worldOf(catalogId: string): WorldList {
	let w = worlds.get(catalogId);
	if (!w) {
		w = { rows: [], albums: new Map(), nextCursor: null, pages: 0, started: false, loading: null, error: null, failedAt: 0 };
		worlds.set(catalogId, w);
		while (worlds.size > WORLD_CACHE_MAX) worlds.delete(worlds.keys().next().value!);
	}
	return w;
}

function publishWorld(h: EntityHeader | null): void {
	const id = worldKey(h);
	const w = id ? worlds.get(id) : undefined;
	if (!h || !w) { setWorld(IDLE); return; }
	setWorld({
		state: w.loading ? 'loading' : w.error ? 'error' : 'idle',
		releases: w.albums.size,
		tracks: w.rows.length,
		total: h.world.releaseCount,
		more: w.nextCursor !== null,
		error: w.error,
	});
}

// One page of the catalogue as rows, with its releases' details.
async function readPage(h: EntityHeader, cursor: string | null): Promise<{ rows: Track[]; albums: [string, AlbumSummary][]; nextCursor: string | null }> {
	const page = await entityApi.tracks(h.ref, cursor ? { cursor } : undefined);
	// The library's own rows for the recordings it holds, one read for the page.
	const ids = heldTrackIds(page);
	const library = new Map((ids.length ? await tracksApi.list({ ids }) : []).map((t) => [t.id, t]));
	return { rows: toRows(page, library), albums: page.albums.map((a) => [`${CATALOG_ROW_PREFIX}${a.id}`, albumSummaryOf(a)]), nextCursor: page.nextCursor };
}

async function loadPage(h: EntityHeader, w: WorldList): Promise<boolean> {
	const page = await readPage(h, w.started ? w.nextCursor : null);
	for (const [id, album] of page.albums) w.albums.set(id, album);
	w.rows = [...w.rows, ...page.rows];
	w.nextCursor = page.nextCursor;
	w.pages++;
	w.started = true;
	return page.rows.length > 0 || page.nextCursor !== null;
}

// As many pages as the list holds, read again from the top and swapped in
// whole — the list never shows a half-read state, and keeps its length.
async function rereadPages(h: EntityHeader, w: WorldList): Promise<boolean> {
	const rows: Track[] = [];
	const albums = new Map<string, AlbumSummary>();
	let cursor: string | null = null;
	let pages = 0;
	do {
		const page = await readPage(h, cursor);
		rows.push(...page.rows);
		for (const [id, album] of page.albums) albums.set(id, album);
		cursor = page.nextCursor;
		pages++;
	} while (cursor !== null && pages < w.pages);
	w.rows = rows;
	w.albums = albums;
	w.nextCursor = cursor;
	w.pages = pages;
	return true;
}

// One read at a time per list: a second ask while one runs joins it.
function run(h: EntityHeader, w: WorldList, read: () => Promise<boolean>): Promise<boolean> {
	w.error = null;
	const p: Promise<boolean> = read()
		.catch((e: unknown) => {
			// "Error invoking remote method 'entity:tracks': Error: …" → the message.
			w.error = (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
			w.failedAt = Date.now();
			elog.warn('catalogue page failed', { kind: h.ref.kind }, e);
			return false;
		})
		.finally(() => {
			if (w.loading === p) w.loading = null;
			if (open && header() && sameEntity(header()!.ref, h.ref)) publishWorld(header());
		});
	w.loading = p;
	publishWorld(h);
	return p;
}

function load(h: EntityHeader): Promise<boolean> {
	const w = worldOf(worldKey(h)!);
	return w.loading ?? run(h, w, () => loadPage(h, w));
}

// Core registered releases or tracklists for the open page: its loaded pages
// again, behind whatever read is already running.
async function reloadWorld(): Promise<void> {
	const h = header();
	const key = worldKey(h);
	const w = key ? worlds.get(key) : undefined;
	if (!h || !key || !w || !w.started) return;
	if (w.loading) await w.loading;
	if (worlds.get(key) !== w) return;
	if (await run(h, w, () => rereadPages(h, w))) listPort?.worldReloaded();
}

export const entityPage = {
	// ── Reads (signals) ──
	header,
	headerPending,
	world,
	work,

	// main.ts's side of the work events (set once at boot).
	setListPort(port: typeof listPort): void {
		listPort = port;
	},

	// Open a page's data: the library's header now, the catalogue's when it
	// answers. Re-opening the entity already open (Back onto it, Owned ↔
	// World) reuses what is loaded.
	open(ref: EntityRef): OpenPage {
		if (open && sameEntity(open.ref, ref)) return open;
		const page: OpenPage = {
			ref,
			local: entityApi.page(ref, { localOnly: true }),
			full: entityApi.page(ref),
			reasks: 0,
		};
		open = page;
		if (reaskTimer) { clearTimeout(reaskTimer); reaskTimer = null; }
		setHeader(null);
		setWorld(IDLE);
		setHeaderPending(true);
		void page.local.then((h) => { if (open === page && header() === null) setHeader(h); }).catch(() => {});
		void page.full
			.then((h) => {
				if (open !== page) return;
				// What later calls name the entity by: every id the lookup found.
				page.ref = h.ref;
				settle(page, h);
				setHeader(h);
				publishWorld(h);
				watch(h.ref);
			})
			.catch((e: unknown) => elog.warn('header failed', { kind: ref.kind }, e))
			.finally(() => { if (open === page) setHeaderPending(false); });
		return page;
	},

	current: (): OpenPage | null => open,

	close(): void {
		open = null;
		watch(null);
		if (reaskTimer) { clearTimeout(reaskTimer); reaskTimer = null; }
		setHeader(null);
		setHeaderPending(false);
		setWorld(IDLE);
	},

	// The header again from core (a follow changed, a page was connected).
	async refresh(): Promise<void> {
		const page = open;
		if (!page) return;
		const h = await entityApi.page(page.ref);
		if (open !== page) return;
		const before = worldState(header());
		page.ref = h.ref;
		page.full = Promise.resolve(h);
		settle(page, h);
		setHeader(h);
		publishWorld(h);
		// A catalogue that came back, an entity it knows now: core looks
		// again at what there is to do for the page.
		if (before !== worldState(h)) { watch(null); watch(h.ref); }
	},

	// The user asked again (the header's "Try again"): the header from core,
	// and the World list's failure forgotten so the next paint loads it.
	async retry(): Promise<void> {
		const page = open;
		if (!page) return;
		page.reasks = 0;
		for (const w of worlds.values()) if (w.error) { w.error = null; w.failedAt = 0; }
		await entityPage.refresh();
	},

	// A catalogue release's details for its album group header.
	albumInfo(albumId: string): AlbumSummary | null {
		const id = worldKey(header());
		return (id ? worlds.get(id)?.albums.get(albumId) : undefined) ?? null;
	},

	// The World list as loaded so far, in the catalogue's order, loading the
	// first page when nothing is. `h` is the full header (it names the
	// catalogue object).
	async worldRows(h: EntityHeader): Promise<Track[]> {
		const key = worldKey(h);
		if (!key) return [];
		const w = worldOf(key);
		if (!w.started && !(w.error && Date.now() - w.failedAt < WORLD_RETRY_MS)) await load(h);
		publishWorld(h);
		return w.rows;
	},

	// The next page, if there is one. Resolves true when rows were added.
	async loadMore(h: EntityHeader): Promise<boolean> {
		const key = worldKey(h);
		if (!key) return false;
		const w = worldOf(key);
		if (!w.started || w.nextCursor === null) return false;
		if (w.error && Date.now() - w.failedAt < WORLD_RETRY_MS) return false;
		const before = w.rows.length;
		await load(h);
		return w.rows.length > before;
	},

	// Every remaining page up to the cap, one after another (the read bucket
	// is per user: no parallel pages). `onPage` after each that added rows.
	async loadAll(h: EntityHeader, onPage: () => void): Promise<void> {
		const key = worldKey(h);
		if (!key) return;
		const w = worldOf(key);
		while (w.nextCursor !== null && w.rows.length < WORLD_FILL_CAP && !w.error) {
			if (!open || !sameEntity(open.ref, h.ref)) return;
			if (await entityPage.loadMore(h)) onPage();
			else break;
		}
	},

	// A library row changed under a World list (a rating, a download): the
	// row the list holds is replaced in place.
	patchLibraryRow(t: Track): void {
		for (const w of worlds.values()) {
			const i = w.rows.findIndex((r) => r.id === t.id);
			if (i >= 0 && w.rows[i]!.catalog) w.rows[i] = { ...t, catalog: w.rows[i]!.catalog, trackNumber: w.rows[i]!.trackNumber, discNumber: w.rows[i]!.discNumber, albumTitle: w.rows[i]!.albumTitle };
		}
	},

	// Forget every World list (the library changed in a way that moves
	// ownership: an import, a delete).
	forgetWorlds(): void {
		worlds.clear();
		publishWorld(header());
	},

	keyOf: entityKey,
	worldKey,

	// World rows that are not a page's: the omnibar's track hits (core
	// entity/world-search.ts), as the same rows a page would show — the
	// library's own row where the library holds the recording.
	async rowsOf(page: EntityTracksPage): Promise<Track[]> {
		const ids = heldTrackIds(page);
		const library = new Map((ids.length ? await tracksApi.list({ ids }) : []).map((t) => [t.id, t]));
		return toRows(page, library);
	},
};
