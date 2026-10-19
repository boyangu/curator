// Navigation history — browser-style back / forward, PER TAB. Every tab in
// the top strip (the source tabs, Discover, Pinned, Basket, Downloads, plus
// the Sync view) owns its own stack of entries, exactly like browser tabs:
// switching tabs activates that tab's stack where it was left and records
// nothing; Back / Forward walk only the active tab's stack. An entry is one
// logical "location" the main pane can show (a tracks scope under a source
// tab, a tag view, Sync, Downloads, a Discover sub-state) plus the view
// state captured when the user left it (scroll, selection, sort, filters)
// so traversal lands exactly where they were, the way a browser's
// back-forward cache does.
//
// Rules of the layer (same as shell.ts): this module owns the stacks as
// pure data + signals and touches no DOM. It records what the user
// navigated TO; the orchestration that applies a location (fetches, scroll
// restores, region mounts) lives with the caller in main.ts. The reducer
// functions are exported standalone so the semantics unit-test without the
// Solid runtime — the `navHistory` store is a thin signal wrapper.

import { createMemo, createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import type { JitPlaylist, SourceTab } from './shell.js';

// What the tracks table is scoped to under a source tab. `playlist` covers
// Spotify/Tidal/rekordbox playlists and Curator-local playlists; `folder` is
// a rekordbox tree folder.
export type TracksScope =
	| { type: 'all' }
	| { type: 'playlist'; id: string }
	| { type: 'folder'; id: string }
	| { type: 'jit'; jit: JitPlaylist };

export type NavLocation =
	| { kind: 'tracks'; source: SourceTab; scope: TracksScope }
	| { kind: 'tag'; view: 'interested' | 'basket' }
	| { kind: 'sync' }
	| { kind: 'downloads' }
	| { kind: 'discover'; mode: 'feed'; archived: boolean; genre: string | null; label: string | null }
	// journeyId null ⇔ the journey list; nodeId is the journey node the user
	// was standing on (traversal re-jumps there, moving the journey's pointer).
	| { kind: 'discover'; mode: 'journeys'; journeyId: string | null; nodeId: string | null }
	| { kind: 'discover'; mode: 'agent-results'; resultSetId: string };

// The top-strip tab a location lives under — the key of its history stack.
export type NavTab = SourceTab | 'discover' | 'interested' | 'basket' | 'downloads' | 'sync';

export function tabOf(loc: NavLocation): NavTab {
	switch (loc.kind) {
		case 'tracks': return loc.source;
		case 'tag': return loc.view;
		case 'discover': return 'discover';
		case 'sync': return 'sync';
		case 'downloads': return 'downloads';
	}
}

// View state captured when an entry is LEFT and re-applied when traversal
// returns to it. Every field is optional: a tracks entry captures the lot,
// Discover captures only its scroll offset, Sync/Downloads nothing.
export interface NavRestore {
	scrollTop?: number;
	// Top-of-viewport track — survives a list that changed length since the
	// capture (a sort change, a track removed) better than a raw offset.
	anchorTrackId?: string | null;
	selectedTrackIds?: string[];
	selectionAnchor?: string | null;
	sort?: { column: string; dir: 'asc' | 'desc' };
	tracksFilter?: string;
	filterText?: string;
}

// Which user gesture created an entry — only consulted for coalescing (a
// run of sidebar ↑/↓ steps collapses into one entry).
export type NavGesture = 'sidebar-step';

export interface NavEntry {
	id: number;
	location: NavLocation;
	label: string;
	restore: NavRestore;
	createdAt: number;
	gesture: NavGesture | null;
	// Drill-down parent: the entry this one was drilled FROM (Drill Into ▶,
	// Find Similar, an artist chip). Null for roots (tabs, sidebar rows,
	// searches). Parent links form a tree over the stacks — a drill from
	// Pinned lands on the source tab's stack with its parent on Pinned's —
	// and the scope title paints the ancestor chain as a breadcrumb whose
	// crumbs are targeted traversals. Back/Forward stay linear per tab.
	parentId: number | null;
}

export interface TabStack {
	entries: readonly NavEntry[];
	// The entry the tab currently shows.
	index: number;
}

export interface HistoryState {
	stacks: Partial<Record<NavTab, TabStack>>;
	// null ⇔ empty (pre-boot).
	activeTab: NavTab | null;
}

export const HISTORY_CAP = 100;
export const EMPTY_HISTORY: HistoryState = { stacks: {}, activeTab: null };

let nextEntryId = 1;

export function makeEntry(location: NavLocation, label: string, opts: { restore?: NavRestore; gesture?: NavGesture | null; parentId?: number | null; now?: number } = {}): NavEntry {
	return {
		id: nextEntryId++,
		location,
		label,
		restore: opts.restore ?? {},
		createdAt: opts.now ?? Date.now(),
		gesture: opts.gesture ?? null,
		parentId: opts.parentId ?? null,
	};
}

// Identity of a location for "am I already there" checks. A JIT is keyed by
// its query (a pinned search loaded from the sidebar and the same search
// re-run from the omnibar are one place); the name is presentation.
export function locationKey(loc: NavLocation): string {
	switch (loc.kind) {
		case 'tracks': {
			const s = loc.scope;
			const scope = s.type === 'all' ? 'all'
				: s.type === 'playlist' ? `playlist:${s.id}`
					: s.type === 'folder' ? `folder:${s.id}`
						: `jit:${s.jit.query}`;
			return `tracks:${loc.source}:${scope}`;
		}
		case 'tag': return `tag:${loc.view}`;
		case 'sync': return 'sync';
		case 'downloads': return 'downloads';
		case 'discover':
			switch (loc.mode) {
				case 'feed': return `discover:feed:${loc.archived ? 'archived' : 'live'}:${loc.genre ?? ''}:${loc.label ?? ''}`;
				case 'journeys': return `discover:journeys:${loc.journeyId ?? ''}:${loc.nodeId ?? ''}`;
				case 'agent-results': return `discover:agent:${loc.resultSetId}`;
			}
	}
}

export function stackOf(state: HistoryState, tab: NavTab): TabStack | null {
	const s = state.stacks[tab];
	return s && s.entries.length > 0 ? s : null;
}

export function activeStack(state: HistoryState): TabStack | null {
	return state.activeTab ? stackOf(state, state.activeTab) : null;
}

// The active tab's current entry.
export function currentEntry(state: HistoryState): NavEntry | null {
	const s = activeStack(state);
	return s ? s.entries[s.index] ?? null : null;
}

export function canBack(state: HistoryState): boolean {
	const s = activeStack(state);
	return !!s && s.index > 0;
}

export function canForward(state: HistoryState): boolean {
	const s = activeStack(state);
	return !!s && s.index < s.entries.length - 1;
}

export function allEntries(state: HistoryState): NavEntry[] {
	return Object.values(state.stacks).flatMap((s) => (s ? [...s.entries] : []));
}

export function locate(state: HistoryState, id: number): { tab: NavTab; index: number } | null {
	for (const [tab, s] of Object.entries(state.stacks) as [NavTab, TabStack | undefined][]) {
		if (!s) continue;
		const index = s.entries.findIndex((e) => e.id === id);
		if (index >= 0) return { tab, index };
	}
	return null;
}

// Drill-down ancestors of an entry, root-first, excluding the entry. Parents
// may sit on another tab's stack. The chain stops at a parent that fell off
// (cap / dead-entry drop).
export function ancestorsOf(state: HistoryState, entry: NavEntry): NavEntry[] {
	const byId = new Map(allEntries(state).map((e) => [e.id, e]));
	const out: NavEntry[] = [];
	const seen = new Set<number>([entry.id]);
	let pid = entry.parentId;
	while (pid != null) {
		const p = byId.get(pid);
		if (!p || seen.has(p.id)) break;
		seen.add(p.id);
		out.unshift(p);
		pid = p.parentId;
	}
	return out;
}

function withStack(state: HistoryState, tab: NavTab, stack: TabStack, activate = true): HistoryState {
	return { stacks: { ...state.stacks, [tab]: stack }, activeTab: activate ? tab : state.activeTab };
}

// Append after the current entry OF THE ENTRY'S TAB, discarding that tab's
// forward entries (the browser rule), and make the tab active. Navigating
// to the location that tab already shows replaces its current entry
// instead of stacking a duplicate — identity, parent and restore state are
// kept since the view didn't change (a drill onto the scope already open
// must not make it its own parent). Oldest entries fall off past `cap`.
export function push(state: HistoryState, entry: NavEntry, cap = HISTORY_CAP): HistoryState {
	const tab = tabOf(entry.location);
	const stack = stackOf(state, tab);
	const cur = stack ? stack.entries[stack.index] ?? null : null;
	if (stack && cur && locationKey(cur.location) === locationKey(entry.location)) {
		const entries = [...stack.entries];
		entries[stack.index] = { ...entry, id: cur.id, parentId: cur.parentId, restore: cur.restore };
		return withStack(state, tab, { entries, index: stack.index });
	}
	let entries = stack ? [...stack.entries.slice(0, stack.index + 1), entry] : [entry];
	if (entries.length > cap) entries = entries.slice(entries.length - cap);
	return withStack(state, tab, { entries, index: entries.length - 1 });
}

// Swap the current entry of the entry's tab in place (forced navigations,
// coalesced steps, a renamed scope) and make the tab active. A tab with no
// stack yet is seeded.
export function replace(state: HistoryState, entry: NavEntry): HistoryState {
	const tab = tabOf(entry.location);
	const stack = stackOf(state, tab);
	if (!stack) return withStack(state, tab, { entries: [entry], index: 0 });
	const entries = [...stack.entries];
	entries[stack.index] = entry;
	return withStack(state, tab, { entries, index: stack.index });
}

// Activate a tab's stack where it was left. A tab with no stack is left
// alone — the caller seeds it with a push.
export function activateTab(state: HistoryState, tab: NavTab): HistoryState {
	if (!stackOf(state, tab) || state.activeTab === tab) return state;
	return { stacks: state.stacks, activeTab: tab };
}

// Move the active tab's pointer by `delta`; past either end is a no-op.
export function go(state: HistoryState, delta: number): HistoryState {
	const tab = state.activeTab;
	const s = activeStack(state);
	if (!tab || !s) return state;
	const next = s.index + delta;
	if (next < 0 || next >= s.entries.length) return state;
	return withStack(state, tab, { entries: s.entries, index: next });
}

export function setIndex(state: HistoryState, tab: NavTab, index: number): HistoryState {
	const s = stackOf(state, tab);
	if (!s || index < 0 || index >= s.entries.length) return state;
	return withStack(state, tab, { entries: s.entries, index });
}

export function updateRestore(state: HistoryState, restore: NavRestore): HistoryState {
	const cur = currentEntry(state);
	if (!cur) return state;
	return replace(state, { ...cur, restore });
}

// Remove a dead entry (its playlist / result set no longer exists) from a
// tab's stack. The pointer keeps naming the same entry when it sat above
// the hole and slides onto the next entry when it was the hole itself —
// callers that traverse past dead entries re-aim it explicitly. A tab
// emptied this way drops its stack.
export function dropAt(state: HistoryState, tab: NavTab, i: number): HistoryState {
	const s = stackOf(state, tab);
	if (!s || i < 0 || i >= s.entries.length) return state;
	const entries = s.entries.filter((_, k) => k !== i);
	if (entries.length === 0) {
		const stacks = { ...state.stacks };
		delete stacks[tab];
		return { stacks, activeTab: state.activeTab === tab ? null : state.activeTab };
	}
	let index = s.index;
	if (index > i) index -= 1;
	if (index >= entries.length) index = entries.length - 1;
	return withStack(state, tab, { entries, index }, false);
}

// A playlist that got re-keyed (Convert-to-WAV playlists become rekordbox
// playlists) keeps its history under the new id, on every tab.
export function rewritePlaylistId(state: HistoryState, oldId: string, newId: string): HistoryState {
	let changed = false;
	const stacks: Partial<Record<NavTab, TabStack>> = {};
	for (const [tab, s] of Object.entries(state.stacks) as [NavTab, TabStack | undefined][]) {
		if (!s) continue;
		stacks[tab] = {
			index: s.index,
			entries: s.entries.map((e) => {
				const loc = e.location;
				if (loc.kind === 'tracks' && loc.scope.type === 'playlist' && loc.scope.id === oldId) {
					changed = true;
					return { ...e, location: { ...loc, scope: { type: 'playlist' as const, id: newId } } };
				}
				return e;
			}),
		};
	}
	return changed ? { stacks, activeTab: state.activeTab } : state;
}

// ── Live store ─────────────────────────────────────────────────────────────

const [historyState, setHistoryState] = createSignal<HistoryState>(EMPTY_HISTORY);

const current: Accessor<NavEntry | null> = createMemo(() => currentEntry(historyState()));
const backEntry: Accessor<NavEntry | null> = createMemo(() => {
	const s = activeStack(historyState());
	return s && s.index > 0 ? s.entries[s.index - 1] ?? null : null;
});
const forwardEntry: Accessor<NavEntry | null> = createMemo(() => {
	const s = activeStack(historyState());
	return s && s.index < s.entries.length - 1 ? s.entries[s.index + 1] ?? null : null;
});
const ancestors: Accessor<NavEntry[]> = createMemo(() => {
	const c = current();
	return c ? ancestorsOf(historyState(), c) : [];
});

export const navHistory = {
	// ── Reads ──
	state: historyState,
	activeTab: createMemo(() => historyState().activeTab),
	current,
	backEntry,
	forwardEntry,
	// Drill-down chain above the current entry (the breadcrumb).
	ancestors,
	canBack: createMemo(() => canBack(historyState())),
	canForward: createMemo(() => canForward(historyState())),
	locate(id: number): { tab: NavTab; index: number } | null { return locate(historyState(), id); },

	// ── Transitions ──
	push(entry: NavEntry): void { setHistoryState((s) => push(s, entry)); },
	replace(entry: NavEntry): void { setHistoryState((s) => replace(s, entry)); },
	// Activate a tab's stack; returns the entry it now shows, or null when
	// the tab has no history yet (the caller seeds it).
	activateTab(tab: NavTab): NavEntry | null {
		const s = stackOf(historyState(), tab);
		if (!s) return null;
		setHistoryState((st) => activateTab(st, tab));
		return s.entries[s.index] ?? null;
	},
	go(delta: number): void { setHistoryState((s) => go(s, delta)); },
	setIndex(tab: NavTab, index: number): void { setHistoryState((s) => setIndex(s, tab, index)); },
	updateCurrentRestore(restore: NavRestore): void { setHistoryState((s) => updateRestore(s, restore)); },
	dropAt(tab: NavTab, i: number): void { setHistoryState((s) => dropAt(s, tab, i)); },
	rewritePlaylistId(oldId: string, newId: string): void { setHistoryState((s) => rewritePlaylistId(s, oldId, newId)); },
	// Boot: the first entry is whatever the restored session shows.
	reset(entry: NavEntry): void { setHistoryState(push(EMPTY_HISTORY, entry)); },
};
