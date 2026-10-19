// TagPlaylistPickerDialog ("Organize") — the unified center-screen modal that
// replaces the separate Tag and Playlist pickers. One surface answers "where
// does this selection belong?" across three columns:
//
//   Tags (accent) · Local · Rekordbox (orange) · Streaming · Spotify (green)
//
// A single search box filters every column by name + folder path; a docked
// "Associated" pane on the right lists everything currently applied (grouped
// by the same three families) with removable pills + n/N fractions; the
// Recommended row surfaces suggested targets. For a single-track selection
// the header shows the track itself — title, artists, a display-only
// label · genre · BPM · key line, and an inline star rating (editing beyond
// the rating stays in the Edit Track modal).
//
// Mechanics are ported verbatim from the two dialogs it supersedes: the
// three-state chip cycle (all → remove-all, some → add-to-the-missing, none →
// add-all), the membership memo driven by a caller bump-counter, the stale-
// guarded recommend fetch, and the capture-phase keyboard handler. Toggling
// routes through the caller's onApply, which dispatches to the existing
// commitTagChanges / commitPlaylistChanges by item kind — the single source of
// truth for tag/playlist writes is preserved.

import { createSignal, createMemo, createEffect, createDeferred, Show, For, Index, untrack } from 'solid-js';
import type { Accessor, JSX } from 'solid-js';
import { render } from 'solid-js/web';
import type { Track } from '@curator/shared';
import { registerModalOpenSignal } from '../modalGate.js';
import { tristate, columnOf, dataSource, pathString, describeItem, balanceFirstPage, createKindFor, COL_TITLE } from './organizeModel.js';
import type { OrganizeItem, ColKey, Tristate, CreateKind } from './organizeModel.js';
import { KeyChip } from '../components/KeyChip.jsx';
import { formatBpmInt } from '../music-utils.js';
import { log } from '../data/log.js';

// Re-export the public model so consumers (main.ts) keep importing item/source
// types from the dialog module.
export type { OrganizeItem, OrganizeSource, OrganizeKind } from './organizeModel.js';

export interface OrganizeDialogProps {
	// The full unified list (tags + write-eligible playlists), rebuilt by the
	// caller on open. Read through props so the component stays decoupled from
	// the stores.
	getItems: () => readonly OrganizeItem[];
	// Per-track membership lookups — tags via tagsStore, playlists via the
	// caller's snapshot map. The membership memo reads both to count how many
	// of the selection carry each item.
	getTagsForTrack: (trackId: string) => readonly string[];
	getPlaylistsForTrack: (trackId: string) => ReadonlySet<string> | undefined;
	// Reactive Track lookup (tracksData behind it) for the single-selection
	// header. Undefined for a not-yet-promoted feed-provisional id — the
	// header then falls back to the plain "1 track selected" text.
	getTrack: (trackId: string) => Track | undefined;
	// Rating write for the header's inline stars. Caller routes to
	// commitRating — the same IPC + cache-patch + toast seam the tracklist
	// and NowPlayingCard use. Null clears.
	onSetRating: (trackId: string, rating: number | null) => void;
	// False from open until the caller's async membership batch (playlists +
	// tags) has landed for this selection. Chip writes (cycle / removeAll)
	// no-op while false — a diff computed from half-loaded membership would
	// be wrong (e.g. add-all to a playlist the selection is already in).
	// Search, browse, and create flows stay live regardless.
	membershipReady: Accessor<boolean>;
	// Bump-counter incremented on every successful write (tag OR playlist) so
	// the membership + item memos recompute without a manual refresh path.
	rev: Accessor<number>;
	// Backend-scored recommendations — tag AND playlist ids, each with a
	// one-word "why" reason for the tooltip. Fetched on open and re-fetched
	// (debounced) after every association change so the row re-ranks live.
	fetchRecommended: (trackIds: readonly string[]) => Promise<readonly { id: string; reason: string }[]>;
	// Apply a single-item diff. Caller routes to commitTagChanges /
	// commitPlaylistChanges by item.kind, writes, and bumps rev.
	onApply: (item: OrganizeItem, addToTrackIds: readonly string[], removeFromTrackIds: readonly string[]) => Promise<void>;
	// Inline create flows. Caller creates + applies to the selection +
	// refreshes the item list + bumps rev. The streaming one creates a real
	// playlist on the user's Spotify account (and pushes the linked part of
	// the selection), so it's offered only while canCreateStreaming() holds.
	onCreateTag: (name: string, trackIds: readonly string[]) => Promise<void>;
	onCreatePlaylist: (name: string, trackIds: readonly string[]) => Promise<void>;
	onCreateStreamingPlaylist: (name: string, trackIds: readonly string[]) => Promise<void>;
	canCreateStreaming: () => boolean;
	// Ask main to claim OS keyboard focus for the window (win.focus +
	// webContents.focus). Called on open when document.hasFocus() is false —
	// without it the autofocused search box is document.activeElement but
	// keystrokes go to whoever really holds the keyboard (detached DevTools,
	// another app) until the user alt-tabs away and back.
	claimWindowFocus: () => Promise<void>;
	onClose: () => void;
}

export interface OrganizeDialogHandle {
	open(trackIds: readonly string[]): void;
	close(): void;
	isOpen: Accessor<boolean>;
	destroy(): void;
}

// Icons are FUNCTIONS, not element consts: a module-level JSX element is a
// single DOM node, so reusing it across rows would move it rather than clone.
// Each call returns a fresh node.
const CK = (): JSX.Element => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
);
const ICON_SEARCH = (): JSX.Element => (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);
const ICON_PLUS = (): JSX.Element => (
	<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
);

// Recommended row: chips shown before the first "more…", and how many each
// subsequent "more…" reveals from the already-ranked pool.
const RECO_INITIAL = 16;
const RECO_STEP = 10;

export function mountOrganizeDialog(host: HTMLElement, props: OrganizeDialogProps): OrganizeDialogHandle {
	const [isOpen, setIsOpen] = createSignal(false);
	registerModalOpenSignal(isOpen);
	const [trackIds, setTrackIds] = createSignal<readonly string[]>([]);
	const [query, setQuery] = createSignal('');
	// Star the cursor is over in the header rating row; null between hovers.
	const [hoverStar, setHoverStar] = createSignal<number | null>(null);
	const [recommended, setRecommended] = createSignal<readonly { id: string; reason: string }[]>([]);
	// How many recommendations are revealed. Starts at RECO_INITIAL; the "more…"
	// button reveals RECO_STEP more from the already-fetched ranked pool (no
	// refetch). Reset per open.
	const [recoLimit, setRecoLimit] = createSignal(RECO_INITIAL);
	let searchInputRef: HTMLInputElement | null = null;
	let recoTimer: ReturnType<typeof setTimeout> | null = null;

	// Fetch (or re-fetch) recommendations for the current selection. Stale-guard
	// on the captured selection so a fast re-open / rapid re-rank can't paint
	// the wrong suggestions. Debounced by default so a burst of chip clicks
	// coalesces into one backend call; `immediate` skips the wait on open.
	const refreshRecommended = (immediate = false): void => {
		if (recoTimer) { clearTimeout(recoTimer); recoTimer = null; }
		const run = (): void => {
			const captured = trackIds();
			if (!isOpen() || captured.length === 0) return;
			void props.fetchRecommended(captured).then((rec) => {
				if (!isOpen()) return;
				const cur = trackIds();
				if (cur.length !== captured.length || cur.some((x, i) => x !== captured[i])) return;
				setRecommended(rec);
			}).catch((err) => log.for('organize').warn('recommend failed', undefined, err));
		};
		if (immediate) run();
		else recoTimer = setTimeout(run, 250);
	};

	// Re-rank whenever a membership write lands — rev is bumped by every
	// mutation path (chip clicks in here, the player chip row, AND the undo
	// toast's inverse commit), so subscribing here keeps the row honest even
	// for writes the modal didn't initiate. isOpen is untracked: open() bumps
	// rev before the modal flips visible. membershipReady is untracked too,
	// and read here so the FIRST fetch of an open rides the rev bump that
	// lands the membership batch (the caller flips ready before bumping) —
	// scoring against the pre-load empty membership would rank the
	// "complete the association" tier wrong and refetch immediately anyway.
	createEffect(() => {
		props.rev();
		if (untrack(isOpen) && untrack(() => props.membershipReady())) refreshRecommended();
	});

	const open = (ids: readonly string[]): void => {
		setTrackIds([...ids]);
		setQuery('');
		setHoverStar(null);
		setKbd(null); // keyboard highlight back to the default (first reco chip)
		setRecommended([]);
		setRecoLimit(RECO_INITIAL);
		setIsOpen(true);
		// Kick the recommend fetch without blocking the open — but only when
		// membership is already in hand (feed-promotion seeds empty-and-ready;
		// selection membership may be cached from a prior open). A normal open
		// starts not-ready and the rev-driven effect above fires the first
		// fetch when the membership batch lands.
		if (untrack(() => props.membershipReady())) refreshRecommended(true);
		queueMicrotask(() => {
			searchInputRef?.focus();
			// focus() lands even when the window lacks OS keyboard focus —
			// Chromium just parks it, no caret, keys go elsewhere. All open
			// paths are user gestures inside the app, so if the document
			// isn't focused the keyboard is stuck out-of-page (frameless
			// window + detached-DevTools quirk); claim it and re-assert.
			if (!document.hasFocus()) {
				void props.claimWindowFocus().then(() => searchInputRef?.focus());
			}
		});
	};
	const close = (): void => {
		if (!isOpen()) return;
		setIsOpen(false);
		props.onClose();
	};

	// Unified membership count per item id (tags + playlists share one map —
	// their id namespaces don't collide). Tracks rev so writes propagate.
	const membership = createMemo<Map<string, number>>(() => {
		props.rev();
		const ids = trackIds();
		const out = new Map<string, number>();
		if (ids.length === 0) return out;
		for (const trackId of ids) {
			for (const t of props.getTagsForTrack(trackId)) out.set(t, (out.get(t) ?? 0) + 1);
			const pls = props.getPlaylistsForTrack(trackId);
			if (pls) for (const pid of pls) out.set(pid, (out.get(pid) ?? 0) + 1);
		}
		return out;
	});

	const allItems = createMemo<readonly OrganizeItem[]>(() => {
		props.rev();
		return props.getItems();
	});

	// The single-selection Track row (reactive: getTrack reads tracksData's
	// tick, so a rating write repaints the header). Undefined for multi-select
	// AND for a not-yet-promoted feed-provisional id — both fall back to the
	// "N tracks selected" header with no stars (commitRating needs a real
	// curator id, which a provisional row doesn't have yet).
	//
	// getTrack reads a PAGE cache — unchecking the playlist the modal was
	// opened from refetches the now-smaller page and drops this row, which
	// would collapse the header to the generic fallback mid-interaction. So
	// the last resolved Track is kept (keyed by the SELECTION id, so a
	// provisional id that later aliases to a real row still matches) and
	// served when the live lookup misses; live updates keep flowing while
	// the row remains cached.
	let lastSingle: { forId: string; track: Track } | null = null;
	const single = createMemo<Track | undefined>(() => {
		if (trackIds().length !== 1) return undefined;
		const id = trackIds()[0]!;
		const live = props.getTrack(id);
		if (live) { lastSingle = { forId: id, track: live }; return live; }
		return lastSingle?.forId === id ? lastSingle.track : undefined;
	});

	// True when a given track already carries this item (tag or playlist).
	function trackHas(trackId: string, it: OrganizeItem): boolean {
		return it.kind === 'tag'
			? props.getTagsForTrack(trackId).includes(it.id)
			: !!props.getPlaylistsForTrack(trackId)?.has(it.id);
	}
	function assocOf(it: OrganizeItem): Tristate {
		return tristate(membership().get(it.id) ?? 0, trackIds().length);
	}

	// Column contents, phase 1: filter into columns, decorate with a lowercase
	// search key, sort once. Recomputes only on writes (rev bumps membership +
	// allItems) and reopen — NEVER per keystroke; the old shape re-sorted with
	// localeCompare comparators that rebuilt name+path strings per comparison,
	// on every keystroke, which is exactly what made search feel sticky. Order
	// is stable alpha (by name + path) — associations do NOT float to the top,
	// so checking a row leaves it exactly where it was. Non-owned streaming
	// playlists are hidden unless the selection is already in them (checked):
	// we can't add/remove there, so an unchecked one is just disabled noise.
	// Entry objects are cached per ITEM identity — the row <For> keys on the
	// entry, and the rows are permanently mounted, so a colBase recompute
	// (any rev bump: membership landing, catalog refresh, tag write) must
	// hand back the SAME entry object for an unchanged item or every row in
	// the grid rebuilds. WeakMap so entries die with their items when a
	// refresh re-mints them (which is when rows genuinely should rebuild).
	const entryCache = new WeakMap<OrganizeItem, { it: OrganizeItem; key: string }>();
	const colBase = createMemo<Record<ColKey, { it: OrganizeItem; key: string }[]>>(() => {
		const mem = membership();
		const out: Record<ColKey, { it: OrganizeItem; key: string }[]> = { tag: [], local: [], stream: [] };
		for (const it of allItems()) {
			if (it.kind === 'playlist' && !it.ownedByMe && (mem.get(it.id) ?? 0) === 0) continue;
			let e = entryCache.get(it);
			if (!e) { e = { it, key: (it.name + ' ' + pathString(it)).toLowerCase() }; entryCache.set(it, e); }
			out[columnOf(it)].push(e);
		}
		for (const list of Object.values(out)) list.sort((a, b) => a.key.localeCompare(b.key));
		return out;
	});

	// Deferred, trimmed copy of the search box value. The input echoes the raw
	// signal instantly; everything below the header (columns, reco-row
	// visibility, create affordances) reads this idle-deferred copy so a fast
	// typing burst doesn't run a full grid re-render synchronously inside
	// every keystroke handler.
	const dq = createDeferred(() => query().trim());
	const dqLower = createMemo(() => dq().toLowerCase());

	// Phase 2, the per-keystroke path — a VISIBILITY map, not a fresh item
	// list. The columns render colBase in full, permanently; searching toggles
	// an `is-hidden` class per row and ranks matches via flex `order`. This is
	// the load-bearing perf choice: rebuilding the row list per keystroke made
	// Solid create/dispose hundreds of row components in one task (a measured
	// ~98ms main-thread stall when clearing the query against ~580 items) —
	// exactly long enough to swallow the next keystroke's echo. Toggling
	// class/order on stable DOM relayouts the column but mints nothing.
	//
	// Shape: null when no query (all rows visible, natural colBase order);
	// otherwise itemId → rank. Prefix matches rank before substring matches;
	// two O(n) passes over the pre-sorted base, so both tiers inherit alpha
	// order and no sort happens here at all.
	const COL_KEYS: readonly ColKey[] = ['tag', 'local', 'stream'];
	const colSearch = createMemo<Record<ColKey, Map<string, number> | null>>(() => {
		const q = dqLower();
		if (!q) return { tag: null, local: null, stream: null };
		const out: Record<ColKey, Map<string, number>> = { tag: new Map(), local: new Map(), stream: new Map() };
		const base = colBase();
		for (const key of COL_KEYS) {
			const m = out[key];
			let rank = 0;
			for (const e of base[key]) if (e.key.startsWith(q)) m.set(e.it.id, rank++);
			for (const e of base[key]) if (!m.has(e.it.id) && e.key.includes(q)) m.set(e.it.id, rank++);
		}
		return out;
	});
	// Visible-row count per column — the header badge and the empty-state read.
	function colCount(key: ColKey): number {
		const m = colSearch()[key];
		return m ? m.size : colBase()[key].length;
	}

	// Recommended entries: resolve ids → items. FULLY-applied targets drop out
	// (a done recommendation stops making sense); PARTIALLY-applied ones stay —
	// the backend surfaces them as the "complete the association" tier and the
	// chip shows the live k/N. Non-owned playlists drop (can't be written; the
	// backend filters these too — this is defense). Reason rides along for
	// the chip tooltip. The full ranked pool is kind-balanced so the first page
	// is never all-playlists (raw scores favour big playlists); the render
	// slices to recoLimit and "more…" reveals the rest.
	const recommendedItems = createMemo<readonly { item: OrganizeItem; reason: string }[]>(() => {
		const recs = recommended();
		if (recs.length === 0) return [];
		const m = membership();
		const total = trackIds().length;
		const byId = new Map(allItems().map((it) => [it.id, it]));
		const out: { item: OrganizeItem; reason: string }[] = [];
		for (const rec of recs) {
			if ((m.get(rec.id) ?? 0) >= total) continue;
			const it = byId.get(rec.id);
			if (!it) continue;
			if (it.kind === 'playlist' && !it.ownedByMe) continue;
			out.push({ item: it, reason: rec.reason });
		}
		return balanceFirstPage(out, (r) => r.item.kind, RECO_INITIAL, 4);
	});

	// Query-filtered view of the ranked pool. Reuses colSearch as the match
	// source, so a chip stays visible exactly when its column row does (same
	// name+path key, same prefix/substring semantics). Filters the SAME rec
	// objects recommendedItems minted — the chip <For> keys on them, so
	// typing narrows chips without rebuilding the survivors' DOM.
	const recommendedVisible = createMemo<readonly { item: OrganizeItem; reason: string }[]>(() => {
		const recs = recommendedItems();
		if (recs.length === 0) return recs;
		const cs = colSearch();
		return recs.filter((r) => {
			const m = cs[columnOf(r.item)];
			return m === null || m.has(r.item.id);
		});
	});

	// ── keyboard navigation (ALT-chords) ───────────────────────────────────────
	// A roving keyboard highlight over the visible items — reco chips (incl.
	// the "more…" reveal) + the three columns' rows. ALT+Arrows move,
	// ALT+Space / ALT+Enter toggle (same cycle() path as a click). ALT is the
	// load-bearing choice: the search input keeps focus and bare keys forever,
	// so this never fights the caret — which is what killed the earlier
	// modifier-less nav (see the keyboard comment below).
	type Zone = 'reco' | ColKey;
	const ZONES: readonly Zone[] = ['reco', 'tag', 'local', 'stream'];
	const KBD_MORE = '__more'; // sentinel id for the reco "more…" button
	const [kbd, setKbd] = createSignal<{ zone: Zone; id: string } | null>(null);

	// Visible ids per zone in VISUAL order — the same sources the render
	// reads. Column order: colSearch maps insert in rank order, so their key
	// iteration IS the visual (prefix-first) order; no query → base order.
	function colVisibleIds(key: ColKey): string[] {
		const m = colSearch()[key];
		return m ? [...m.keys()] : colBase()[key].map((e) => e.it.id);
	}
	const navLists = createMemo<Record<Zone, string[]>>(() => {
		const vis = recommendedVisible();
		const reco = vis.slice(0, recoLimit()).map((r) => r.item.id);
		if (vis.length > recoLimit()) reco.push(KBD_MORE);
		return { reco, tag: colVisibleIds('tag'), local: colVisibleIds('local'), stream: colVisibleIds('stream') };
	});

	// Stored-with-fallback resolution: the stored item while it's still on
	// screen (so clearing a query restores it); otherwise the first item of
	// the first non-empty zone (reco → tag → local → stream). Movement always
	// starts from the RESOLVED position, so recovery is seamless.
	const kbdResolved = createMemo<{ zone: Zone; id: string } | null>(() => {
		const lists = navLists();
		const cur = kbd();
		if (cur && lists[cur.zone].includes(cur.id)) return cur;
		for (const zone of ZONES) {
			const first = lists[zone][0];
			if (first !== undefined) return { zone, id: first };
		}
		return null;
	});

	// Element lookup for geometry + auto-scroll. Scoped to the host so a
	// (hypothetical) second mount can't cross-match.
	const kbdEl = (zone: Zone, id: string): HTMLElement | null =>
		host.querySelector(`[data-kbd-zone="${zone}"][data-kbd-id="${CSS.escape(id)}"]`);

	// Chip geometry: group the reco chips into VISUAL rows (flex wrap is a
	// layout outcome, so this reads rects — keypress-time only, ~30 reads).
	// Chips come back in flow order, so row tops ascend monotonically.
	function recoRows(): { id: string; x: number; y: number }[][] {
		const rows: { id: string; x: number; y: number }[][] = [];
		let curTop = Number.NaN;
		for (const id of navLists().reco) {
			const el = kbdEl('reco', id);
			if (!el) continue;
			const b = el.getBoundingClientRect();
			if (b.width === 0) continue;
			// New visual row when the top jumps (flex wrap) — and always for the
			// first chip (curTop starts NaN, and NaN comparisons are false, so
			// this must be an explicit case or rows[-1] blows up).
			if (rows.length === 0 || Math.abs(b.top - curTop) > 4) { rows.push([]); curTop = b.top; }
			rows[rows.length - 1]!.push({ id, x: b.x + b.width / 2, y: b.top + b.height / 2 });
		}
		return rows;
	}
	const closestX = (row: { id: string; x: number }[], x: number): string | null => {
		let best: string | null = null, bestD = Infinity;
		for (const c of row) { const d = Math.abs(c.x - x); if (d < bestD) { bestD = d; best = c.id; } }
		return best;
	};
	const centerOf = (zone: Zone, id: string): { x: number; y: number } | null => {
		const b = kbdEl(zone, id)?.getBoundingClientRect();
		return b ? { x: b.x + b.width / 2, y: b.top + b.height / 2 } : null;
	};

	// Which column a screen-X descends into — the ACTUAL column rects (25 /
	// 37.5 / 37.5), not an approximation; empty columns are skipped and the
	// nearest non-empty one (by horizontal distance) wins.
	function columnAtX(x: number): ColKey | null {
		const lists = navLists();
		let best: ColKey | null = null, bestD = Infinity;
		for (const k of ['tag', 'local', 'stream'] as ColKey[]) {
			if (lists[k].length === 0) continue;
			const b = host.querySelector(`.organize__col[data-col="${k}"]`)?.getBoundingClientRect();
			if (!b) continue;
			const d = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
			if (d < bestD) { bestD = d; best = k; }
		}
		return best;
	}
	// Closest visible row to a screen-Y in a column (clamps to ends). Rows
	// scrolled out of the viewport still have valid rects (content-visibility
	// keeps their 35px placeholder box), so this works across the whole list.
	function closestInColByY(key: ColKey, y: number): string | null {
		const ids = navLists()[key];
		let best: string | null = null, bestD = Infinity;
		for (const id of ids) {
			const c = centerOf(key, id);
			if (!c) continue;
			const d = Math.abs(c.y - y);
			if (d < bestD) { bestD = d; best = id; }
		}
		return best ?? ids[0] ?? null;
	}

	function kbdMove(dir: 'up' | 'down' | 'left' | 'right'): void {
		const cur = untrack(kbdResolved);
		if (!cur) return;
		const lists = untrack(navLists);
		let next: { zone: Zone; id: string } | null = null;

		if (cur.zone === 'reco') {
			const flow = lists.reco;
			const idx = flow.indexOf(cur.id);
			const c = centerOf('reco', cur.id);
			const descend = (): void => {
				if (!c) return;
				const col = columnAtX(c.x);
				if (col) { const id = closestInColByY(col, c.y); if (id) next = { zone: col, id }; }
			};
			if (dir === 'left') { if (idx > 0) next = { zone: 'reco', id: flow[idx - 1]! }; }
			else if (dir === 'right') {
				if (idx < flow.length - 1) next = { zone: 'reco', id: flow[idx + 1]! };
				else descend(); // very last chip: same as down
			} else {
				const rows = recoRows();
				const ri = rows.findIndex((r) => r.some((ch) => ch.id === cur.id));
				if (ri >= 0 && c) {
					if (dir === 'up' && ri > 0) { const id = closestX(rows[ri - 1]!, c.x); if (id) next = { zone: 'reco', id }; }
					else if (dir === 'down') {
						if (ri < rows.length - 1) { const id = closestX(rows[ri + 1]!, c.x); if (id) next = { zone: 'reco', id }; }
						else descend();
					}
				}
			}
		} else {
			const list = lists[cur.zone];
			const idx = list.indexOf(cur.id);
			const c = centerOf(cur.zone, cur.id);
			if (dir === 'up') {
				if (idx > 0) next = { zone: cur.zone, id: list[idx - 1]! };
				else if (c) {
					// Top of the column: back into the reco band, last visual
					// row, closest chip by X ("visually above").
					const rows = recoRows();
					const last = rows[rows.length - 1];
					if (last) { const id = closestX(last, c.x); if (id) next = { zone: 'reco', id }; }
				}
			} else if (dir === 'down') {
				if (idx < list.length - 1) next = { zone: cur.zone, id: list[idx + 1]! };
			} else {
				// Horizontal column switch: scan in the direction for the first
				// non-empty column, land on the row closest to our screen-Y.
				const order: ColKey[] = ['tag', 'local', 'stream'];
				const oi = order.indexOf(cur.zone);
				const step = dir === 'left' ? -1 : 1;
				for (let i = oi + step; i >= 0 && i < order.length; i += step) {
					const k = order[i]!;
					if (lists[k].length === 0) continue;
					const id = c ? closestInColByY(k, c.y) : lists[k][0]!;
					if (id) next = { zone: k, id };
					break;
				}
			}
		}
		if (next) setKbd(next);
	}

	function kbdToggle(): void {
		const cur = untrack(kbdResolved);
		if (!cur) return;
		if (cur.zone === 'reco') {
			if (cur.id === KBD_MORE) {
				// Reveal the next page and land the highlight on its first chip.
				const firstNew = untrack(() => recommendedVisible()[recoLimit()]?.item.id);
				setRecoLimit((n) => n + RECO_STEP);
				if (firstNew) setKbd({ zone: 'reco', id: firstNew });
				return;
			}
			const rec = untrack(recommendedVisible).find((r) => r.item.id === cur.id);
			if (rec) void cycle(rec.item);
			return;
		}
		const entry = untrack(colBase)[cur.zone].find((e) => e.it.id === cur.id);
		if (entry) void cycle(entry.it); // disabled rows no-op inside cycle()
	}

	// Keep the highlight in view — the grid is the scroll container; chips
	// are in the fixed band, where 'nearest' is a no-op.
	createEffect(() => {
		const cur = kbdResolved();
		if (!cur || !untrack(isOpen)) return;
		kbdEl(cur.zone, cur.id)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});

	// Everything currently applied, grouped by column — drives the Associated
	// pane. Unifies the old "Tagged" panel + "Currently in" group.
	const associated = createMemo<Record<ColKey, OrganizeItem[]>>(() => {
		const m = membership();
		const groups: Record<ColKey, OrganizeItem[]> = { tag: [], local: [], stream: [] };
		for (const it of allItems()) {
			if ((m.get(it.id) ?? 0) > 0) groups[columnOf(it)].push(it);
		}
		return groups;
	});
	const associatedCount = createMemo<number>(() => {
		const g = associated();
		return g.tag.length + g.local.length + g.stream.length;
	});

	// ── mutations ────────────────────────────────────────────────────────────
	const cycle = async (it: OrganizeItem): Promise<void> => {
		if (!untrack(() => props.membershipReady())) return; // batch still in flight — see prop doc
		const ids = untrack(() => trackIds());
		if (ids.length === 0) return;
		if (it.kind === 'playlist' && !it.ownedByMe) return;
		const cnt = untrack(() => membership().get(it.id) ?? 0);
		const state = tristate(cnt, ids.length);
		// No explicit re-rank here — the rev-driven effect above fires when the
		// write bumps the caller's rev counter.
		if (state === 'all') {
			await props.onApply(it, [], ids);
		} else if (state === 'some') {
			const missing = untrack(() => ids.filter((tid) => !trackHas(tid, it)));
			await props.onApply(it, missing, []);
		} else {
			await props.onApply(it, ids, []);
		}
	};
	const removeAll = async (it: OrganizeItem): Promise<void> => {
		if (!untrack(() => props.membershipReady())) return;
		const ids = untrack(() => trackIds());
		const have = untrack(() => ids.filter((tid) => trackHas(tid, it)));
		if (have.length === 0) return;
		await props.onApply(it, [], have);
	};
	// Whether a column offers a "Create …" affordance for the current query
	// (rules in createKindFor). Reads the DEFERRED query so the affordance
	// appears/disappears in the same batch as the filtered columns, not a
	// keystroke ahead of them.
	function createFor(key: ColKey): CreateKind | null {
		return createKindFor(key, dq(), allItems(), props.canCreateStreaming());
	}
	// A create in flight. A Spotify create is a ~1 s round-trip to the API —
	// without this, a double-click mints two remote playlists.
	const [creating, setCreating] = createSignal(false);
	const runCreate = async (key: ColKey): Promise<void> => {
		if (untrack(creating)) return;
		// The deferred value — matches what the Create button displayed when
		// it was clicked (the raw signal may already be a keystroke ahead).
		const q = dq();
		const kind = untrack(() => createFor(key));
		if (!q || !kind) return;
		const ids = untrack(() => trackIds());
		// Re-rank comes via the rev-driven effect once the create's write lands.
		setCreating(true);
		try {
			if (kind === 'tag') await props.onCreateTag(q, ids);
			else if (kind === 'playlist') await props.onCreatePlaylist(q, ids);
			else await props.onCreateStreamingPlaylist(q, ids);
		} finally {
			setCreating(false);
		}
		setQuery('');
		queueMicrotask(() => searchInputRef?.focus());
	};
	const createLabel = (kind: CreateKind): string =>
		kind === 'tag' ? 'tag' : kind === 'playlist' ? 'playlist' : 'Spotify playlist';

	// ── keyboard — Esc + ALT-chords ────────────────────────────────────────────
	// The earlier MODIFIER-LESS 2-D arrow/Enter navigation was dropped because
	// it fought the search caret and the mouse. The ALT-chord scheme avoids
	// every one of those conflicts: bare keys (arrows, letters) still flow to
	// the search input untouched; only Alt+Arrows move the highlight and
	// Alt+X / Alt+Enter toggle it. Toggle is Alt+X (not Alt+Space) because
	// Alt+Space is claimed as a global OS hotkey by launcher apps (ChatGPT,
	// PowerToys Run) — a global grab the renderer can never see. Capture phase
	// + preventDefault + stopImmediatePropagation so nothing else in the app
	// or Chromium sees the handled chords. `e.code` (physical key) is matched
	// for X so a non-QWERTY layout still toggles on the same key position.
	const onKeyDown = (e: KeyboardEvent): void => {
		if (!isOpen()) return;
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
		if (!e.altKey) return;
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
			kbdMove(e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'left' : 'right');
			return;
		}
		if (e.code === 'KeyX' || e.key === 'x' || e.key === 'X' || e.key === 'Enter') {
			e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
			kbdToggle();
		}
	};
	document.addEventListener('keydown', onKeyDown, true);

	// ── render helpers ─────────────────────────────────────────────────────────
	function checkbox(state: () => Tristate): JSX.Element {
		return <span class="organize__check" data-state={state()}>{CK()}</span>;
	}

	function coverStack(): JSX.Element {
		const ids = trackIds();
		const shown = Math.min(ids.length, 4);
		const extra = ids.length - shown;
		const width = 34 + (shown - 1) * 13;
		return (
			<div class="organize__covers" style={{ width: `${width}px` }}>
				<For each={ids.slice(0, shown)}>
					{(id, i) => (
						<span
							class="organize__cover"
							style={{ left: `${i() * 13}px`, 'z-index': String(i()) }}
						>
							<span
								class="organize__cover-art"
								style={{ 'background-image': `url(curator-cover://${encodeURIComponent(id)})` }}
							/>
							<Show when={i() === shown - 1 && extra > 0}>
								<span class="organize__cover-more">+{extra}</span>
							</Show>
						</span>
					)}
				</For>
			</div>
		);
	}

	// Keyed by item reference (<For> over colBase), so a row keeps its DOM
	// node for as long as the item identity lives — typing NEVER touches the
	// row list (search is a class/order toggle via `search`), and rev bumps
	// only re-mint rows whose items were actually rebuilt (buildOrganizeItems
	// caches tag items on tagsStore's array identity; playlist items reuse
	// the catalog snapshot). Only membership-driven state reads through
	// thunks (same pattern as pillFor below); the item's own fields (name,
	// path, color, ownership) are immutable per identity.
	function rowFor(item: OrganizeItem, search: () => Map<string, number> | null): JSX.Element {
		const state = () => assocOf(item);
		const disabled = item.kind === 'playlist' && !item.ownedByMe;
		const cnt = () => membership().get(item.id) ?? 0;
		const total = () => trackIds().length;
		// Search bindings: hidden when a query is active and this row missed;
		// matches get their prefix-first rank as flex `order` (base DOM order
		// is untouched — the create button sits at order 999999 in CSS).
		const hidden = () => { const m = search(); return m !== null && !m.has(item.id); };
		const order = () => { const m = search(); return m ? String(m.get(item.id) ?? 0) : '0'; };
		const isKbd = () => { const k = kbdResolved(); return k !== null && k.zone === columnOf(item) && k.id === item.id; };
		return (
			<button
				type="button"
				class="organize__row"
				data-source={dataSource(item)}
				data-kbd-zone={columnOf(item)}
				data-kbd-id={item.id}
				classList={{
					'is-hidden': hidden(),
					'is-kbd': isKbd(),
					'is-disabled': disabled,
					'state-all': state() === 'all',
					'state-some': state() === 'some',
					'state-none': state() === 'none',
				}}
				disabled={disabled}
				style={item.color ? { '--tag-color': item.color, order: order() } : { order: order() }}
				title={
					disabled ? 'Owned by another user — can\'t add or remove'
						: state() === 'all' ? 'On every selected track — click to remove from all'
							: state() === 'some' ? `On ${cnt()}/${total()} — click to add to the remaining ${total() - cnt()}`
								: total() === 1 ? 'Click to apply' : `Click to apply to all ${total()}`
				}
				onClick={() => { if (!disabled) void cycle(item); }}
			>
				{checkbox(state)}
				<span class="organize__row-body">
					<span class="organize__row-name">
						<Show when={item.kind === 'tag'}><span class="organize__hash">#</span></Show>
						{item.name}
					</span>
					<Show when={pathString(item)}>
						<span class="organize__row-path">{pathString(item)}</span>
					</Show>
				</span>
				<Show when={state() === 'some'}>
					<span class="organize__frac">{cnt()}/{total()}</span>
				</Show>
			</button>
		);
	}

	// State/count read through thunks, not captured — `<For>` keys pills by
	// item reference, and playlist items keep their identity across rev bumps
	// (buildOrganizeItems reuses the snapshot array), so a captured count would
	// paint stale k/N after a membership change.
	function pillFor(it: OrganizeItem): JSX.Element {
		const state = () => assocOf(it);
		const cnt = () => membership().get(it.id) ?? 0;
		const total = () => trackIds().length;
		// Non-owned streaming playlists are read-only — the selection is in them
		// because the owner put it there; we can't remove it. Show the pill (so
		// the membership is visible) but no remove affordance.
		const removable = !(it.kind === 'playlist' && !it.ownedByMe);
		return (
			<span class="organize__pill" data-source={dataSource(it)} title={describeItem(it)} classList={{ 'state-some': state() === 'some' }} style={it.color ? { '--tag-color': it.color } : undefined}>
				<Show when={it.kind === 'tag'}><span class="organize__hash">#</span></Show>
				<span class="organize__pill-name">{it.name}</span>
				<Show when={state() === 'some'}><span class="organize__pill-frac">{cnt()}/{total()}</span></Show>
				<Show when={removable}>
					<button type="button" class="organize__pill-x" title="Remove" onClick={() => { void removeAll(it); }}>×</button>
				</Show>
			</span>
		);
	}

	// PERMANENTLY MOUNTED — no <Show when={isOpen()}> around the overlay.
	// Unmount-on-close made every reopen re-create the full ~580-row grid in
	// one main-thread task, which is exactly the stall the stable-DOM search
	// exists to kill. The grid mounts once (a background task shortly after
	// boot, when the catalog lands) and closing just display:none's the
	// overlay; reopen is a class flip. The component-scope memos above were
	// already permanent — this only extends that to the DOM.
	const dispose = render(() => (
		<div class="modal-overlay organize-overlay" classList={{ 'is-closed': !isOpen() }} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
				<div class="modal organize-modal" role="dialog" aria-modal="true" aria-labelledby="organize-title">
					{/* ── header ── */}
					<header class="organize__head">
						{/* Single-track area: [cover ×3 rows] [title / artist / label·genre]
						    [stars / BPM / key]. Multi-select keeps the cover stack + count. */}
						<Show
							when={single()}
							fallback={
								<>
									{coverStack()}
									<div class="organize__head-meta">
										<h3 id="organize-title" class="organize__title">
											{trackIds().length === 1 ? '1 track selected' : `${trackIds().length} tracks selected`}
										</h3>
										<div class="organize__sub">Organize · tags &amp; playlists</div>
									</div>
								</>
							}
						>
							{(t) => (
								<div class="organize__track">
									<span
										class="organize__cover-lg"
										style={{ 'background-image': `url(curator-cover://${encodeURIComponent(t().id)})` }}
									/>
									<div class="organize__track-main">
										<h3 id="organize-title" class="organize__title organize__title--track" title={t().title}>{t().title}</h3>
										<div class="organize__sub organize__sub--artist">{t().artists.map((a) => a.name).join(', ')}</div>
										<div class="organize__trackmeta">
											<Show when={t().label}><span class="organize__meta-item">{t().label}</span></Show>
											<Show when={t().genre}><span class="organize__meta-item">{t().genre}</span></Show>
										</div>
									</div>
									<div class="organize__track-stats">
										<span
											class="organize__rating"
											role="group"
											aria-label="Rating"
											title={t().rating != null ? `${t().rating}/5 — click to change, click the same star to clear` : 'Click to rate'}
											onMouseLeave={() => setHoverStar(null)}
										>
											<Index each={[1, 2, 3, 4, 5]}>
												{(n) => (
													<button
														type="button"
														class="organize__star"
														classList={{ 'is-on': (hoverStar() ?? t().rating ?? 0) >= n() }}
														aria-label={`Set rating to ${n()}`}
														onMouseEnter={() => setHoverStar(n())}
														onClick={() => { props.onSetRating(t().id, t().rating === n() ? null : n()); }}
													>★</button>
												)}
											</Index>
										</span>
										<Show when={t().bpm != null}><div class="organize__trackmeta">{formatBpmInt(t().bpm)} BPM</div></Show>
										<Show when={t().keyCamelot}><div class="organize__trackmeta"><KeyChip keyCamelot={t().keyCamelot} /></div></Show>
									</div>
								</div>
							)}
						</Show>
						<div class="organize__search">
							<span class="organize__search-icon">{ICON_SEARCH()}</span>
							<input
								type="text"
								placeholder="Search tags &amp; playlists…"
								ref={(el) => { searchInputRef = el; }}
								value={query()}
								onInput={(e) => { setQuery(e.currentTarget.value); }}
							/>
						</div>
						<button class="modal__close organize__close" type="button" aria-label="Close" onClick={(e) => { e.preventDefault(); close(); }}>×</button>
					</header>

					{/* ── recommended ── */}
					{/* ALWAYS rendered, chips area min-height'd to two rows: the grid
					    below must not jump when recommendations land async after open,
					    when typing filters chips down, or when the last chip drops out.
					    The query filters chips (recommendedVisible) instead of hiding
					    the whole section like it used to. */}
					<div class="organize__reco">
						<div class="organize__reco-label"><span class="organize__spark">✦</span> Recommended</div>
						<div class="organize__reco-chips">
							<For each={recommendedVisible().slice(0, recoLimit())}>
								{(rec) => {
									// Partial ("complete the association") chips carry a live
									// k/N so the user sees what completing means; click routes
									// through cycle() — add-the-missing for partials, add-all
									// for fresh suggestions.
									const cnt = () => membership().get(rec.item.id) ?? 0;
									const isKbd = () => { const k = kbdResolved(); return k !== null && k.zone === 'reco' && k.id === rec.item.id; };
									return (
										<button type="button" class="organize__reco-chip" data-source={dataSource(rec.item)} data-kbd-zone="reco" data-kbd-id={rec.item.id} classList={{ 'is-kbd': isKbd() }} title={`${describeItem(rec.item)} · ${rec.reason}`} onClick={() => { void cycle(rec.item); }}>
											<Show when={rec.item.kind === 'tag'} fallback={<span class="organize__reco-mark">◆</span>}><span class="organize__hash">#</span></Show>
											{rec.item.name}
											<Show when={cnt() > 0}><span class="organize__reco-frac">{cnt()}/{trackIds().length}</span></Show>
										</button>
									);
								}}
							</For>
							<Show when={recommendedVisible().length === 0}>
								<span class="organize__reco-empty">{dq() ? '— no matching suggestions —' : '— none —'}</span>
							</Show>
							<Show when={recommendedVisible().length > recoLimit()}>
								<button
									type="button"
									class="organize__reco-more"
									data-kbd-zone="reco"
									data-kbd-id={KBD_MORE}
									classList={{ 'is-kbd': kbdResolved()?.zone === 'reco' && kbdResolved()?.id === KBD_MORE }}
									title={`Show ${Math.min(RECO_STEP, recommendedVisible().length - recoLimit())} more`}
									onClick={() => setRecoLimit((n) => n + RECO_STEP)}
								>more…</button>
							</Show>
						</div>
					</div>

					{/* ── body: grid + associated pane ── */}
					<div class="organize__body">
						<div class="organize__grid">
							<For each={COL_KEYS as ColKey[]}>
								{(key) => {
									const create = () => createFor(key);
									// The row list renders colBase IN FULL and stays mounted;
									// search only flips is-hidden / order on rows (see colSearch).
									const search = () => colSearch()[key];
									return (
										<div class="organize__col" data-col={key}>
											<div class="organize__col-head" data-col={key}>
												{COL_TITLE[key]} <span class="organize__col-count">{colCount(key)}</span>
											</div>
											<div class="organize__col-body">
												<For each={colBase()[key]}>
													{(e) => rowFor(e.it, search)}
												</For>
												<Show when={colCount(key) === 0 && !create()}>
													<div class="organize__col-empty">— none —</div>
												</Show>
												<Show when={create()}>
													{(kind) => (
														<button type="button" class="organize__create" data-col={key} disabled={creating()} onClick={() => { void runCreate(key); }}>
															<span class="organize__create-plus">{ICON_PLUS()}</span>
															{creating() && kind() === 'spotify-playlist'
																? <>Creating “{dq()}” on Spotify…</>
																: <>Create {createLabel(kind())} “{dq()}”</>}
														</button>
													)}
												</Show>
											</div>
										</div>
									);
								}}
							</For>
						</div>

						<aside class="organize__side">
							<div class="organize__side-head">Associated <span class="organize__col-count">{associatedCount()}</span></div>
							<div class="organize__side-body">
								<For each={(['tag', 'local', 'stream'] as ColKey[])}>
									{(key) => (
										<div class="organize__side-grp">
											<div class="organize__side-grp-h" data-col={key}>{COL_TITLE[key]} <span class="organize__ln" /> {associated()[key].length}</div>
											<div class="organize__side-pills">
												<Show when={associated()[key].length > 0} fallback={<span class="organize__side-empty">— none —</span>}>
													<For each={associated()[key]}>{(it) => pillFor(it)}</For>
												</Show>
											</div>
										</div>
									)}
								</For>
							</div>
						</aside>
					</div>

					{/* ── footer ── */}
					<footer class="organize__foot">
						<div class="organize__foot-keys">
							<span><span class="kbd">Alt+↑↓←→</span> Navigate</span>
							<span><span class="kbd">Alt+X</span> Apply</span>
							<span><span class="kbd">Esc</span> Close</span>
						</div>
						<div class="organize__foot-right">
							<span class="organize__foot-sum"><b>{associatedCount()}</b> associations</span>
							<button type="button" class="organize__done" onClick={() => close()}>Done</button>
						</div>
					</footer>
				</div>
			</div>
	), host);

	return {
		open,
		close,
		isOpen,
		destroy: () => {
			if (recoTimer) { clearTimeout(recoTimer); recoTimer = null; }
			document.removeEventListener('keydown', onKeyDown, true);
			dispose();
		},
	};
}
