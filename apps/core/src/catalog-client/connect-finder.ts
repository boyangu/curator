// "Connect the dots" without the user: this desktop looks for the store pages
// its user's follows lack, and keeps the queue of the ones a person is needed
// for.
//
// The follows and the pages each already has are in the Following list this
// device holds, so the cloud is never asked what is missing (it used to count
// that over every follow, at every ask: connect.ts on the cloud). From the
// list come the slots: a followed label without its Beatport, Bandcamp or
// SoundCloud page, a followed artist without Spotify or Deezer — the stores a
// tracker reads them through (protocol CATALOG_CONNECT_QUEUE_STORES). Each
// slot is searched once, a few seconds apart, with the same search the modal
// runs (connect.ts), and comes to one of:
//
//   a clear match   one page of that name sharing two of the object's
//                   releases, and no other page near it (the cloud finders'
//                   rule, apps/cloud catalog/planner.ts confirm). Sent as an
//                   'auto' answer: the cloud attaches it for a trusted
//                   account, with an undo, and holds it for its operator
//                   otherwise.
//   nothing         the store has no page of that name, or only namesakes
//                   whose own list shares nothing with an object the
//                   catalogue knows well. Looked for again in three months:
//                   stores gain pages.
//   unclear         a page of that name that may be theirs — it shares one
//                   release, or two pages do, or the store gives no list to
//                   compare (SoundCloud) — or a candidate the catalogue's own
//                   finders left open. Left for the user: these are the
//                   modal's queue and the number on its button.
//
// What the store returned under another name ("Magnetik Music" for "Magnifik
// Music") is never a question: a person would only say no to it, and the
// modal still shows it when they open that label themselves.
//
// A store that turns this machine away (a challenge, a rate limit, no
// connection) is left alone for a while; nothing is recorded for its slots.
//
// One device a user: the one that reads the catalogue's sources for them this
// week (catalog-worker), so two desktops do not both search. What each slot
// came to is this device's to remember (an app_setting): a "none of these" is
// a fact about a search, not about the catalogue.
//
// Network-bound and slow by design, on the main process like the worker.
// Nothing here writes the library.

import { log } from '@curator/sync-core/log';
import { CATALOG_CONNECT_QUEUE_STORES, type CatalogConnectAnswer, type CatalogConnectAnswerResult, type CatalogConnectCandidate, type CatalogConnectItem, type CatalogProvider, type CatalogWatch } from '@curator/protocol';
import { connectFold, type CatalogConnect, type ConnectQueue, type ConnectSearch } from './connect.js';

const flog = log.for('catalog');

// The first search after start: the window, the first sync and the worker's
// first ask come first.
const FIRST_AFTER_MS = 2 * 60_000;
// Between two searches; a store asked gently is a store that keeps answering.
const PACE_MS: Partial<Record<CatalogProvider, number>> = { beatport: 15_000 };
const PACE_DEFAULT_MS = 5_000;
// Nothing to search: when the follows are looked at again.
const IDLE_MS = 30 * 60_000;
// Not this device's to do right now (signed out, another device's week).
const OFF_MS = 10 * 60_000;
// How long a store is left alone after it did not answer.
const PARK_MS: Record<NonNullable<ConnectSearch['note']>, number> = { blocked: 6 * 3600_000, failed: 30 * 60_000, not_connected: 3600_000, no_search: 24 * 3600_000 };
// A slot that came to nothing, or whose answer is with the operator, is
// looked at again after this long.
const AGAIN_MS = 90 * 86_400_000;
// An object's titles and candidates are kept this long between its stores.
const ITEM_TTL_MS = 10 * 60_000;
const CLEAR_MIN_SHARED = 2;
// With this many of its releases known, an object's page would share one: a
// namesake's list that shares none is someone else's.
const WELL_KNOWN_TITLES = 5;
const PAGE = 20;

type SlotState = 'unclear' | 'none' | 'sent';
type Slot = { objectId: string; kind: 'artist' | 'label'; name: string; provider: CatalogProvider };
const keyOf = (objectId: string, provider: string): string => `${objectId}|${provider}`;

// A reader's name key, not a store's own id (apps/cloud catalog/identity.ts
// WEAK_SQL): the object is not on that store by it.
const readerKey = (provider: string, id: string): boolean => (provider === 'user' && id.startsWith('name:')) || id.includes('/');

// The slots of a Following list: labels first (a label's page brings a whole
// catalogue), each by name.
export function connectSlots(watches: readonly CatalogWatch[]): Slot[] {
	const out: Slot[] = [];
	for (const w of watches) {
		const kind = w.object.kind;
		if (w.muted || (kind !== 'artist' && kind !== 'label')) continue;
		const on = new Set(w.object.handles.filter((h) => !readerKey(h.provider, h.id)).map((h) => h.provider));
		for (const provider of CATALOG_CONNECT_QUEUE_STORES[kind]) if (!on.has(provider)) out.push({ objectId: w.object.id, kind, name: w.object.name, provider });
	}
	return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) || a.objectId.localeCompare(b.objectId) : a.kind === 'label' ? -1 : 1));
}

// The one page that is the object's by what it lists: of the store's pages
// under the object's name, the one sharing two releases with it and at least
// twice as many as any other. Null when none stands out.
export function clearMatch(name: string, candidates: readonly CatalogConnectCandidate[]): CatalogConnectCandidate | null {
	const want = connectFold(name);
	const ranked = candidates
		.filter((c) => connectFold(c.name) === want && (c.shared?.length ?? 0) > 0)
		.sort((a, b) => b.shared!.length - a.shared!.length);
	const [top, next] = ranked;
	if (!top || top.shared!.length < CLEAR_MIN_SHARED) return null;
	return next && top.shared!.length < 2 * next.shared!.length ? null : top;
}

// Whether a person could tell more than the search did: a page of the
// object's name that shares something, or whose list could not be read, or
// that belongs to an object the catalogue barely knows.
export function worthAsking(name: string, titles: readonly string[], candidates: readonly CatalogConnectCandidate[]): boolean {
	const want = connectFold(name);
	return candidates.some((c) => connectFold(c.name) === want && ((c.shared?.length ?? 0) > 0 || !c.releases?.length || titles.length < WELL_KNOWN_TITLES));
}

export type ConnectFinderDeps = {
	connect: CatalogConnect;
	watches: () => Promise<CatalogWatch[]>;
	// Whether this device searches now: signed in to a server that offers it,
	// and the device that reads for its user this week.
	active: () => boolean;
	// What each slot came to, as one string kept across launches.
	load: () => string | null;
	save: (state: string) => void;
	// A store this machine must leave alone for now (Spotify's quota wait).
	paused?: (provider: CatalogProvider) => boolean;
	now?: () => number;
};

export interface ConnectFinder {
	start(): void;
	stop(): void;
	// How many follows a person is needed for.
	pending(): { count: number };
	// A page of them, as the modal asks about them: each with only the stores
	// this device could not settle.
	queue(opts?: { limit?: number; exclude?: string[] }): Promise<ConnectQueue>;
	// The user's own answers: a store they settled leaves the queue.
	settled(answers: readonly CatalogConnectAnswer[], results: CatalogConnectAnswerResult['results']): void;
	// One step, for the loop and for tests: the wait before the next.
	step(): Promise<number>;
}

export function createConnectFinder(deps: ConnectFinderDeps): ConnectFinder {
	const now = deps.now ?? Date.now;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = false;
	let slots: Slot[] | null = null;
	let derivedAt = 0;
	const parked = new Map<CatalogProvider, number>();
	const items = new Map<string, { at: number; item: CatalogConnectItem | null }>();

	const state = new Map<string, { s: SlotState; at: number }>();
	try {
		const kept = JSON.parse(deps.load() ?? '{}') as { v?: number; slots?: Record<string, [SlotState, number]> };
		if (kept.v === 1) for (const [k, [s, at]] of Object.entries(kept.slots ?? {})) state.set(k, { s, at });
	} catch {
		// Unreadable: every slot is searched again.
	}
	const persist = (): void => deps.save(JSON.stringify({ v: 1, slots: Object.fromEntries([...state].map(([k, v]) => [k, [v.s, v.at]])) }));
	const put = (objectId: string, provider: string, s: SlotState): void => {
		state.set(keyOf(objectId, provider), { s, at: now() });
	};

	async function derive(): Promise<Slot[]> {
		const next = connectSlots(await deps.watches());
		const live = new Set(next.map((s) => keyOf(s.objectId, s.provider)));
		const t = now();
		let changed = false;
		for (const [k, v] of state) {
			// The page arrived, the follow ended, or it is time to look again.
			if (live.has(k) && (v.s === 'unclear' || t - v.at < AGAIN_MS)) continue;
			state.delete(k);
			changed = true;
		}
		if (changed) persist();
		slots = next;
		derivedAt = t;
		return next;
	}
	const current = async (): Promise<Slot[]> => (!slots || now() - derivedAt > IDLE_MS ? derive() : slots);

	// The stores of an object left for a person, and the objects that have
	// one — in the slots' order once the follows were read this launch; what
	// was kept from the last one counts until then.
	const unclear = (objectId: string): CatalogProvider[] =>
		[...state].filter(([k, v]) => v.s === 'unclear' && k.startsWith(`${objectId}|`)).map(([k]) => k.slice(objectId.length + 1) as CatalogProvider);
	const waiting = (): string[] => {
		const ids = new Set([...state].filter(([, v]) => v.s === 'unclear').map(([k]) => k.slice(0, k.indexOf('|'))));
		return [...new Set([...(slots ?? []).map((s) => s.objectId).filter((id) => ids.has(id)), ...ids])];
	};

	// What the cloud holds of an object: its titles to compare with, and the
	// stores it still lacks. Null when it has nothing to ask about it.
	async function itemOf(objectId: string): Promise<CatalogConnectItem | null> {
		const kept = items.get(objectId);
		if (kept && now() - kept.at < ITEM_TTL_MS) return kept.item;
		const item = (await deps.connect.queue({ objectIds: [objectId], compare: true })).items[0] ?? null;
		items.set(objectId, { at: now(), item });
		return item;
	}

	async function search(slot: Slot): Promise<void> {
		const item = await itemOf(slot.objectId);
		const asked = item?.missing.find((m) => m.provider === slot.provider);
		// The cloud has the page by now, or the user's pick for it.
		if (!item || !asked) return put(slot.objectId, slot.provider, 'sent');
		const r = await deps.connect.search({ kind: slot.kind, name: item.object.name, titles: item.titles, detail: item.detail }, slot.provider);
		if (r.note) {
			parked.set(slot.provider, now() + PARK_MS[r.note]);
			flog.info('connect finder: store left alone', { provider: slot.provider, why: r.note });
			return;
		}
		const match = clearMatch(item.object.name, r.candidates);
		// A candidate the catalogue's own finders left open that is another page
		// is a doubt a search does not settle.
		if (match && asked.candidates.every((c) => c.providerId === match.providerId)) {
			const releases = [...new Set([...(match.shared ?? []), ...(match.releases ?? [])])].slice(0, 30);
			const { results } = await deps.connect.answer([{ objectId: slot.objectId, provider: slot.provider, verdict: 'is', url: match.url, name: match.name, source: 'auto', releases }]);
			const outcome = results[0]?.outcome ?? 'invalid';
			flog.info('connect finder: clear match sent', { kind: slot.kind, provider: slot.provider, outcome, shared: match.shared?.length ?? 0 });
			return put(slot.objectId, slot.provider, outcome === 'invalid' ? 'unclear' : 'sent');
		}
		put(slot.objectId, slot.provider, asked.candidates.length || worthAsking(item.object.name, item.titles, r.candidates) ? 'unclear' : 'none');
	}

	async function step(): Promise<number> {
		if (!deps.active()) return OFF_MS;
		const list = await current();
		const t = now();
		const open = list.filter((s) => !state.has(keyOf(s.objectId, s.provider)));
		const next = open.find((s) => (parked.get(s.provider) ?? 0) <= t && !deps.paused?.(s.provider));
		if (!next) return IDLE_MS;
		try {
			await search(next);
			persist();
		} catch (e) {
			// The cloud did not answer (offline, signed out mid-call): later.
			flog.warn('connect finder: step failed', { provider: next.provider }, e);
			return OFF_MS;
		}
		return PACE_MS[next.provider] ?? PACE_DEFAULT_MS;
	}

	const schedule = (ms: number): void => {
		if (!running) return;
		timer = setTimeout(() => {
			timer = null;
			step().catch((e: unknown) => {
				flog.warn('connect finder: step failed', undefined, e);
				return OFF_MS;
			}).then(schedule);
		}, ms);
		// The app does not stay open for a search.
		timer.unref?.();
	};

	return {
		start() {
			if (running) return;
			running = true;
			schedule(FIRST_AFTER_MS);
		},
		stop() {
			running = false;
			if (timer) clearTimeout(timer);
			timer = null;
		},
		pending() {
			return { count: waiting().length };
		},
		async queue(opts = {}) {
			await current();
			const skip = new Set(opts.exclude ?? []);
			const page = waiting().filter((id) => !skip.has(id)).slice(0, opts.limit ?? PAGE);
			if (!page.length) return { items: [], total: waiting().length };
			const got = new Map((await deps.connect.queue({ objectIds: page })).items.map((i) => [i.object.id, i]));
			const out: CatalogConnectItem[] = [];
			for (const id of page) {
				const item = got.get(id);
				const mine = unclear(id);
				const missing = item?.missing.filter((m) => mine.includes(m.provider)) ?? [];
				// A store the cloud no longer lacks was settled elsewhere.
				for (const p of mine) if (!missing.some((m) => m.provider === p)) put(id, p, 'sent');
				if (item && missing.length) out.push({ ...item, missing });
			}
			persist();
			return { items: out, total: waiting().length };
		},
		settled(answers, results) {
			let changed = false;
			answers.forEach((a, i) => {
				const outcome = results[i]?.outcome;
				// Only the queue's own stores: the rest are asked when the user names the object.
				const mine = state.has(keyOf(a.objectId, a.provider)) || (slots ?? []).some((s) => s.objectId === a.objectId && s.provider === a.provider);
				if (!mine || !outcome || outcome === 'invalid' || a.verdict === 'not') return;
				put(a.objectId, a.provider, a.verdict === 'none' ? 'none' : 'sent');
				changed = true;
			});
			if (changed) persist();
		},
		step,
	};
}
