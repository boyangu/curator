// Omnibar — global CMD/CTRL-K quick-open surface. Lives over the entire
// .app-shell and offers a single search input that filters tracks +
// playlists across the user's library.
//
// Scope is set either by a prefix at the head of the query (`s/foo`, `l/foo`,
// `r/foo`, `t/foo`) or by the pill row above the input. Tab cycles enabled
// pills; typing a prefix updates the active pill and strips the prefix from
// the searchable term.
//
// Grammar lives in renderer/query.ts (shared with the tracklist filterbox)
// — freetext + `attr:val` / `attr={val}` + comparisons + `#tag` + boolean
// operators. The omnibar pulls a best-effort SQL prefilter out of the AST
// to narrow the candidate set server-side, then runs matchTrack on the
// fetched rows for the precise grammar (OR branches, substring attrs,
// analyzer-scalar comparisons). The "Syntax" button at top-right swaps
// the body for a static cheatsheet of the full grammar.
//
// Online searches (Spotify Web API / Tidal search) are deliberately out of
// scope for this iteration; the source-pill prefixes still work, they just
// narrow the local DB to that source.
//
// Lifecycle: mountOmnibar() wires the DOM once at boot. open()/close()
// toggle visibility. State (last query, "keep between sessions" toggle) is
// persisted to localStorage so a re-open feels like a continuation.

import type { Track, Playlist, PlaylistFolder } from '@curator/shared';
import { searchFold } from '@curator/shared';
import * as tagsStore from './stores/tagsStore.js';
import { keyChipHtml, formatBpmInt } from './music-utils.js';
import { parseQuery, matchTrack, extractSqlPrefilter, extractFolderSyntax, isEmptyExpr, collectTagNames } from './query.js';
import type { Expr, SqlPrefilter } from './query.js';
import { attachTagSuggest, type TagSuggestHandle } from './tagSuggest.js';
import { registerModalOpenSignal, isModalOpen } from './modalGate.js';
import { log } from './data/log.js';

export type OmnibarSource = 'all' | 'spotify' | 'tidal' | 'rekordbox';

export interface OmnibarDeps {
	// Map of every playlist the renderer knows about. We re-read this on open
	// so newly-synced playlists show up without remounting.
	getPlaylists(): Iterable<Playlist>;
	// Imported Rekordbox folder + playlist tree. Folders are surfaced as their
	// own result kind, and folder-name path syntax (zen/uplifting/) narrows
	// the search scope to the matching subtree.
	getRekordboxTree(): { folders: PlaylistFolder[]; playlists: Playlist[] };
	// Per-source availability gates the pill list. Sources reported false are
	// hidden from the pill row (and the user's typed prefix is silently
	// coerced back to "all").
	isSourceEnabled(src: Exclude<OmnibarSource, 'all'>): boolean;
	// Fired when the user picks a track row. Caller dispatches to player.play
	// with the full result list as the queue.
	onPickTrack(track: Track, list: Track[]): void | Promise<void>;
	// Fired when the user picks a playlist row. Caller navigates the main UI
	// to that playlist (or rekordbox folder, since we just pass an id + src).
	onPickPlaylist(playlist: Playlist): void | Promise<void>;
	// Fired when the user picks a folder row. Caller switches to the
	// Rekordbox tab and selects the folder (aggregate-tracks view).
	onPickFolder(folder: PlaylistFolder): void | Promise<void>;
	// Fired on Shift+Enter — the user wants the full result set loaded
	// into the main tracklist as a JIT scope (see main.ts:enterJitScope).
	// `selectTrackId` is the highlighted track at submit time; the caller
	// selects (but does not play) that row once the JIT lands, so a
	// follow-up Enter in the tracklist starts playback. Caller closes
	// the omnibar after the swap.
	onLoadAsJit(query: string, name: string, selectTrackId: string | null): void | Promise<void>;
}

// Persisted across sessions. `q` is only restored if `keep` is true at the
// time of open(); otherwise the input opens empty even if a stale q is on
// disk.
interface PersistedState {
	keep: boolean;
	q: string;
	scope: OmnibarSource;
}

const LS_KEY = 'curator.omnibar.v1';
const MAX_RESULTS = 10;
// Minimum free-text length before we hit SQLite. Single-char queries match
// most rows on the multi-column LIKE — full table scans whose results are
// too noisy to be useful. Field= narrows, folder paths, and explicit scope
// pills still fire below this threshold (they have their own indexes /
// equality filters).
const MIN_FREETEXT_CHARS = 2;

const PILL_DEFS: { src: OmnibarSource; label: string; prefix: string | null }[] = [
	{ src: 'all',       label: 'All',       prefix: null },
	{ src: 'spotify',   label: 'Spotify',   prefix: 's/' },
	{ src: 'tidal',     label: 'Tidal',     prefix: 't/' },
	{ src: 'rekordbox', label: 'Rekordbox', prefix: 'r/' },
];

type Result =
	| { kind: 'track'; track: Track }
	| { kind: 'playlist'; playlist: Playlist }
	| { kind: 'folder'; folder: PlaylistFolder; path: string };

let mounted = false;
let deps: OmnibarDeps;
let isOpen = false;
let scope: OmnibarSource = 'all';
let keep = false;
let activeIdx = 0;
let results: Result[] = [];
let lastTracksFetch: Track[] = [];
let fetchSeq = 0;
let debounceHandle: ReturnType<typeof setTimeout> | null = null;
let escClearedOnce = false; // tracks single-vs-double Esc when keep=true

// Cached DOM lookups, wired in mount(). null until then.
let overlayEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let pillsEl: HTMLElement | null = null;
let resultsEl: HTMLElement | null = null;
let keepEl: HTMLInputElement | null = null;
let scopeChipEl: HTMLElement | null = null;
// Search view + Syntax view DOM. The Syntax view is a static cheatsheet
// that swaps in when the user clicks the Syntax button — toggling is just
// the `hidden` attribute on the two .omnibar__view divs.
let searchViewEl: HTMLElement | null = null;
let syntaxViewEl: HTMLElement | null = null;
let syntaxBtnEl: HTMLButtonElement | null = null;
let syntaxBackEl: HTMLButtonElement | null = null;

// `#tag` autocomplete popover — shared with the tracklist filterbox via
// renderer/tagSuggest.ts. Mounted once when the omnibar wires up.
let tagSuggest: TagSuggestHandle | null = null;

function loadState(): PersistedState {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return { keep: false, q: '', scope: 'all' };
		const data = JSON.parse(raw) as Partial<PersistedState>;
		// A persisted scope that no longer exists as a pill (the retired Local
		// tab's `l/`) falls back to All rather than filtering by a ghost.
		const scope = PILL_DEFS.some((p) => p.src === data.scope) ? (data.scope as OmnibarSource) : 'all';
		return {
			keep: !!data.keep,
			q: typeof data.q === 'string' ? data.q : '',
			scope,
		};
	} catch {
		return { keep: false, q: '', scope: 'all' };
	}
}

function saveState(): void {
	const s: PersistedState = { keep, q: keep ? (inputEl?.value ?? '') : '', scope };
	try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore quota */ }
}

export function mountOmnibar(d: OmnibarDeps): void {
	if (mounted) return;
	mounted = true;
	deps = d;
	// The omnibar counts as a modal for the keyboard gate — while it owns the
	// surface, the main-view command dispatcher stands down (and vice-versa,
	// the Ctrl-K hotkey below won't stack the omnibar over another modal).
	registerModalOpenSignal(() => isOpen);
	overlayEl = document.getElementById('omnibar-overlay');
	inputEl = document.getElementById('omnibar-input') as HTMLInputElement | null;
	pillsEl = document.getElementById('omnibar-pills');
	resultsEl = document.getElementById('omnibar-results');
	keepEl = document.getElementById('omnibar-keep') as HTMLInputElement | null;
	scopeChipEl = document.getElementById('omnibar-scope-chip');
	searchViewEl = document.getElementById('omnibar-view-search');
	syntaxViewEl = document.getElementById('omnibar-view-syntax');
	syntaxBtnEl = document.getElementById('omnibar-syntax-btn') as HTMLButtonElement | null;
	syntaxBackEl = document.getElementById('omnibar-syntax-back') as HTMLButtonElement | null;
	if (!overlayEl || !inputEl || !pillsEl || !resultsEl || !keepEl) return;

	const persisted = loadState();
	keep = persisted.keep;
	scope = persisted.scope;
	keepEl.checked = keep;

	// Trigger button label uses the platform-appropriate modifier.
	const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
	const kbdEl = document.getElementById('omnibar-btn-kbd');
	if (kbdEl) kbdEl.textContent = isMac ? '⌘ K' : 'Ctrl K';
	const btn = document.getElementById('omnibar-btn');
	if (btn) {
		btn.title = isMac ? 'Quick open (⌘K)' : 'Quick open (Ctrl+K)';
		btn.addEventListener('click', () => open());
	}

	// Backdrop click closes (but click inside the panel does not).
	overlayEl.addEventListener('mousedown', (e) => {
		if (e.target === overlayEl) close();
	});

	keepEl.addEventListener('change', () => {
		keep = keepEl!.checked;
		saveState();
	});

	pillsEl.addEventListener('click', (e) => {
		const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-src]');
		if (!btn) return;
		const next = btn.dataset.src as OmnibarSource;
		setScope(next, { syncInput: true });
		inputEl!.focus();
		scheduleQuery();
	});

	inputEl.addEventListener('input', () => {
		applyPrefixFromInput();
		scheduleQuery();
	});

	inputEl.addEventListener('keydown', onInputKeydown);

	// `#tag` autocomplete — handles caret-context detection, popover
	// rendering, and Up/Down/Enter/Tab/Esc intercepts (capture phase, so
	// they preempt our own onInputKeydown).
	const searchRowEl = overlayEl.querySelector<HTMLElement>('.omnibar__search');
	if (searchRowEl) {
		tagSuggest = attachTagSuggest({
			inputEl,
			anchorEl: searchRowEl,
			onCommit: () => scheduleQuery(),
		});
	}

	resultsEl.addEventListener('click', (e) => {
		const row = (e.target as HTMLElement).closest<HTMLElement>('[data-result-idx]');
		if (!row) return;
		const idx = Number(row.dataset.resultIdx);
		if (Number.isFinite(idx)) pick(idx);
	});

	resultsEl.addEventListener('mousemove', (e) => {
		const row = (e.target as HTMLElement).closest<HTMLElement>('[data-result-idx]');
		if (!row) return;
		const idx = Number(row.dataset.resultIdx);
		if (Number.isFinite(idx) && idx !== activeIdx) {
			activeIdx = idx;
			highlightActive();
		}
	});

	// Global hotkey. Capture phase so other input fields can't swallow it.
	window.addEventListener('keydown', (e) => {
		const mod = e.ctrlKey || e.metaKey;
		if (mod && (e.key === 'k' || e.key === 'K')) {
			e.preventDefault();
			if (isOpen) { close(); return; }
			// Don't open the omnibar on top of an already-open modal — that
			// dialog owns the keyboard until it closes.
			if (isModalOpen()) return;
			open();
		}
	}, true);

	// Syntax view toggle. Click "Syntax" → swap the search body for the
	// cheatsheet; Back → swap back and re-focus the input. Tag-suggest
	// hides on enter so a still-open popover doesn't bleed over the syntax
	// view's static text.
	syntaxBtnEl?.addEventListener('click', () => showSyntaxView());
	syntaxBackEl?.addEventListener('click', () => showSearchView());
	// Esc while on the syntax view returns to search (instead of closing
	// the omnibar entirely). Capture so we intercept before the input-row
	// handler can close the modal.
	overlayEl.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && syntaxViewVisible()) {
			e.preventDefault();
			e.stopPropagation();
			showSearchView();
		}
	}, true);
}

function showSyntaxView(): void {
	if (!searchViewEl || !syntaxViewEl) return;
	searchViewEl.hidden = true;
	syntaxViewEl.hidden = false;
	syntaxBackEl?.focus();
}

function showSearchView(): void {
	if (!searchViewEl || !syntaxViewEl || !inputEl) return;
	syntaxViewEl.hidden = true;
	searchViewEl.hidden = false;
	inputEl.focus();
	inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

// True when the cheatsheet is visible. Used by open() to reset to the
// search view on each open.
function syntaxViewVisible(): boolean {
	return syntaxViewEl?.hidden === false;
}

export function openOmnibar(): void { open(); }

// ─── Controller integration (PRD: controllers-pioneer) ──────────────────
// Hooks the FLX10 BROWSE knob into omnibar result navigation when the
// omnibar has focus — see apps/desktop/src/renderer/controllers.ts.

/** True while the omnibar overlay is visible. Used by the controller
 * dispatch to route BROWSE rotate / press into the omnibar instead of
 * the tracklist or sidebar. */
export function isOmnibarOpen(): boolean { return isOpen; }

/** Move the result-list highlight by ±1 per call. Mirrors the
 * ArrowDown/ArrowUp keyboard behaviour: wraps at both ends; no-op when
 * the result list is empty. Called once per FLX10 rotary detent. */
export function stepOmnibarSelection(delta: number): void {
	if (!isOpen || results.length === 0) return;
	const step = delta >= 0 ? 1 : -1;
	activeIdx = (activeIdx + step + results.length) % results.length;
	highlightActive(true);
}

/** Activate the currently-highlighted result — same path as Enter
 * keyboard. No-op when nothing's highlighted or results are empty. */
export function pickOmnibarSelection(): void {
	if (!isOpen || results.length === 0) return;
	pick(activeIdx);
}

function open(): void {
	if (!overlayEl || !inputEl) return;
	isOpen = true;
	overlayEl.hidden = false;
	escClearedOnce = false;
	// Each open starts on the search view — landing on the cheatsheet would
	// be disorienting after a Cmd-K invocation. If the syntax view is still
	// visible from a previous session, swap it back here.
	if (syntaxViewVisible()) {
		if (searchViewEl) searchViewEl.hidden = false;
		if (syntaxViewEl) syntaxViewEl.hidden = true;
	}
	// Restore query only when the user opted in.
	if (keep) {
		const persisted = loadState();
		inputEl.value = persisted.q;
	} else {
		inputEl.value = '';
	}
	// Make sure the current scope still has a visible pill (e.g. Spotify was
	// disconnected since last open). Fall back to 'all' if not.
	renderPills();
	applyPrefixFromInput();
	// Select the contents so a fresh keystroke replaces the restored query.
	inputEl.focus();
	inputEl.select();
	runQuery();
}

function close(): void {
	if (!overlayEl) return;
	isOpen = false;
	overlayEl.hidden = true;
	saveState();
}

function setScope(next: OmnibarSource, opts: { syncInput?: boolean } = {}): void {
	if (next === scope) return;
	if (next !== 'all' && !deps.isSourceEnabled(next as Exclude<OmnibarSource, 'all'>)) return;
	scope = next;
	saveState();
	renderPills();
	if (opts.syncInput && inputEl) {
		// Rewrite the input to carry the chosen prefix (or strip any existing
		// one when scope='all'). Preserves whatever the user has typed after
		// the prefix.
		const { term } = parseInputRaw(inputEl.value);
		const def = PILL_DEFS.find((p) => p.src === scope);
		inputEl.value = def?.prefix ? `${def.prefix}${term}` : term;
		// Move caret to end so typing continues after the prefix.
		inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
	}
	updateScopeChip();
}

function renderPills(): void {
	if (!pillsEl) return;
	const visible = PILL_DEFS.filter((p) => p.src === 'all' || deps.isSourceEnabled(p.src as Exclude<OmnibarSource, 'all'>));
	// If our active scope is no longer in the visible set, fall back.
	if (!visible.some((p) => p.src === scope)) scope = 'all';
	pillsEl.innerHTML = visible.map((p) => {
		const active = p.src === scope ? ' active' : '';
		const prefix = p.prefix ? `<span class="pill-prefix">${p.prefix}</span>` : '';
		return `<button class="omnibar__pill${active}" data-src="${p.src}" role="tab" aria-selected="${p.src === scope}">${p.label}${prefix}</button>`;
	}).join('');
	updateScopeChip();
}

function updateScopeChip(): void {
	if (!scopeChipEl) return;
	if (scope === 'all') { scopeChipEl.hidden = true; return; }
	const def = PILL_DEFS.find((p) => p.src === scope);
	scopeChipEl.hidden = false;
	scopeChipEl.textContent = def?.label ?? scope;
}

// Splits raw input into a prefix + remaining searchable term, but does NOT
// touch `scope`. Used by both prefix-detection and scope-sync paths.
function parseInputRaw(raw: string): { prefix: string | null; term: string } {
	const m = raw.match(/^([sltr])\/(.*)$/i);
	if (m && m[1] !== undefined) return { prefix: m[1].toLowerCase(), term: m[2] ?? '' };
	return { prefix: null, term: raw };
}

// When the user types a prefix at the head of the input (s/, l/, …), promote
// it into the scope. The prefix stays visible in the input — we don't strip
// it, since that would be visually confusing. The downstream query uses
// parseInputRaw to get the bare term.
function applyPrefixFromInput(): void {
	if (!inputEl) return;
	const { prefix } = parseInputRaw(inputEl.value);
	if (!prefix) return;
	const map: Record<string, OmnibarSource> = { s: 'spotify', t: 'tidal', r: 'rekordbox' };
	const next = map[prefix];
	if (next && next !== scope && deps.isSourceEnabled(next as Exclude<OmnibarSource, 'all'>)) {
		scope = next;
		saveState();
		renderPills();
	}
}

function onInputKeydown(e: KeyboardEvent): void {
	// Tag-suggest popover intercepts Up/Down/Enter/Tab/Esc in capture phase
	// when it's visible (see renderer/tagSuggest.ts) — so by the time we
	// get here, those keys are ours to handle for results navigation.

	if (e.key === 'ArrowDown') {
		e.preventDefault();
		if (results.length === 0) return;
		activeIdx = (activeIdx + 1) % results.length;
		highlightActive(true);
	} else if (e.key === 'ArrowUp') {
		e.preventDefault();
		if (results.length === 0) return;
		activeIdx = (activeIdx - 1 + results.length) % results.length;
		highlightActive(true);
	} else if (e.key === 'Tab') {
		e.preventDefault();
		cycleScope(e.shiftKey ? -1 : 1);
	} else if (e.key === 'Enter') {
		e.preventDefault();
		if (e.shiftKey) {
			// Shift+Enter — load the current query as a JIT scope in the
			// main tracklist and start playback from the highlighted track
			// (if any). Falls through to a no-op when neither query text
			// nor results exist (nothing meaningful to load).
			loadAsJit();
		} else if (results.length > 0) {
			pick(activeIdx);
		}
	} else if (e.key === 'Escape') {
		e.preventDefault();
		const hasContent = (inputEl?.value ?? '').length > 0;
		// keep=true → first ESC clears the input, second closes. Without the
		// keep toggle, ESC always closes.
		if (keep && hasContent && !escClearedOnce) {
			if (inputEl) inputEl.value = '';
			escClearedOnce = true;
			scheduleQuery();
			return;
		}
		close();
	} else {
		// Any other key resets the double-Esc tracking so the user has to
		// stop typing for the close-on-Esc behaviour to kick in again.
		escClearedOnce = false;
	}
}

function cycleScope(dir: 1 | -1): void {
	const visible = PILL_DEFS.filter((p) => p.src === 'all' || deps.isSourceEnabled(p.src as Exclude<OmnibarSource, 'all'>));
	if (visible.length === 0) return;
	const i = visible.findIndex((p) => p.src === scope);
	const next = visible[(i + dir + visible.length) % visible.length];
	if (!next) return;
	setScope(next.src, { syncInput: true });
	scheduleQuery();
}

function scheduleQuery(): void {
	if (debounceHandle) clearTimeout(debounceHandle);
	debounceHandle = setTimeout(runQuery, 150);
}

// Query parsing — full grammar lives in query.ts (shared with the tracklist
// filterbox). The Syntax view in the omnibar (top-right "Syntax" button)
// renders the user-facing cheatsheet of that grammar.
//
// `#tag` autocomplete lives in renderer/tagSuggest.ts — also shared with
// the tracklist filterbox. The factory takes ownership of the popover's
// DOM, keyboard intercepts (capture phase), and lifecycle.

// Resolve a folder-name path against the rekordbox tree. Returns the set of
// folder ids matched at the deepest path level — these are the folders whose
// subtrees we filter against. Each segment is a case-insensitive substring
// match on folder name; subsequent segments only match folders nested under
// a previous-segment match.
function resolveFolderPath(path: string[], tree: { folders: PlaylistFolder[] }): PlaylistFolder[] {
	if (path.length === 0) return [];
	const all = tree.folders;
	const childrenByParent = new Map<string, PlaylistFolder[]>();
	for (const f of all) {
		const key = f.parentFolderId ?? '';
		if (!childrenByParent.has(key)) childrenByParent.set(key, []);
		childrenByParent.get(key)!.push(f);
	}
	// Seed with all root folders matching the first segment. We don't restrict
	// to roots after the first level — but each subsequent segment is matched
	// only against direct children of the previous level's matches.
	let current = all.filter((f) => f.name.toLowerCase().includes(path[0]!.toLowerCase()));
	for (let i = 1; i < path.length; i++) {
		const seg = path[i]!.toLowerCase();
		const next: PlaylistFolder[] = [];
		for (const parent of current) {
			for (const child of childrenByParent.get(parent.id) ?? []) {
				if (child.name.toLowerCase().includes(seg)) next.push(child);
			}
		}
		current = next;
		if (current.length === 0) break;
	}
	return current;
}

// Build the parent-folder display path for a folder, e.g. "Zen / Uplifting".
// Used in the result-row sub-label so the user can disambiguate two folders
// with the same name living under different parents.
function folderDisplayPath(folder: PlaylistFolder, tree: { folders: PlaylistFolder[] }): string {
	const byId = new Map(tree.folders.map((f) => [f.id, f]));
	const chain: string[] = [folder.name];
	let cur: PlaylistFolder | undefined = folder;
	while (cur?.parentFolderId) {
		cur = byId.get(cur.parentFolderId);
		if (!cur) break;
		chain.unshift(cur.name);
	}
	return chain.join(' / ');
}

// Walk a folder's subtree and collect every descendant playlist id. Mirrors
// the same helper in main.ts — duplicated here to keep omnibar.ts free of
// main-state coupling beyond the deps object.
function descendantPlaylistIds(folderId: string, tree: { folders: PlaylistFolder[]; playlists: Playlist[] }): string[] {
	const childrenByParent = new Map<string, PlaylistFolder[]>();
	for (const f of tree.folders) {
		const key = f.parentFolderId ?? '';
		if (!childrenByParent.has(key)) childrenByParent.set(key, []);
		childrenByParent.get(key)!.push(f);
	}
	const playlistsByParent = new Map<string, Playlist[]>();
	for (const p of tree.playlists) {
		const key = p.parentFolderId ?? '';
		if (!playlistsByParent.has(key)) playlistsByParent.set(key, []);
		playlistsByParent.get(key)!.push(p);
	}
	const out: string[] = [];
	const walk = (fid: string): void => {
		for (const p of playlistsByParent.get(fid) ?? []) out.push(p.id);
		for (const f of childrenByParent.get(fid) ?? []) walk(f.id);
	};
	walk(folderId);
	return out;
}

async function runQuery(): Promise<void> {
	if (!isOpen || !inputEl || !resultsEl) return;
	const seq = ++fetchSeq;
	const { term: rawTerm } = parseInputRaw(inputEl.value);
	// Parse to AST, then peel off the omnibar-specific folder-path syntax
	// (`zen/up/track`) which predates the boolean grammar and doesn't
	// compose with it. What remains is a regular Expr that we evaluate
	// either via the SQL prefilter (fast path) or matchTrack (full
	// semantics).
	const fullExpr = parseQuery(rawTerm);
	const { path: folderPath, leaf, remaining: queryExpr } = extractFolderSyntax(fullExpr);
	const trimmedLeaf = leaf.trim();
	// Build the ascii-folded set of playlist names so the resolver can route
	// `#name` to playlist matches (merged `#` namespace — see playlist→tag
	// design memo). Streaming + rekordbox playlists both live in deps.getPlaylists,
	// so one iteration covers all sources.
	const playlistNameSet = (() => {
		const s = new Set<string>();
		for (const p of deps.getPlaylists()) s.add(searchFold(p.name));
		return s;
	})();
	const tagResolver = {
		idsForTrack: (id: string) => tagsStore.getTagsForTrack(id),
		nameToId: (name: string) => tagsStore.resolveTagByName(name)?.id ?? null,
		hasPlaylistName: (ascii: string) => playlistNameSet.has(ascii),
	};
	const prefilter = extractSqlPrefilter(queryExpr, tagResolver);
	saveState();

	const tree = deps.getRekordboxTree();
	// Folder-path mode is the rekordbox subtree filter. Folders are only
	// meaningful for rekordbox, so the path implicitly narrows the scope
	// when used from 'all'.
	const pathMatchedFolders = folderPath.length > 0 ? resolveFolderPath(folderPath, tree) : [];
	const inFolderMode = folderPath.length > 0;

	// Build the SQL filter from the prefilter + scope/folder context. The
	// prefilter already encodes the AST's top-level MUSTs that map cleanly
	// onto indexed columns; anything else flows through `prefilter.complete`
	// so we know whether to also run matchTrack on the result set.
	const filter: {
		search?: string;
		source?: 'spotify' | 'tidal';
		playlistIds?: string[];
		nameClauses?: { tagIds: string[]; playlistNamesAscii: string[] }[];
		keyCamelot?: string;
		genre?: string;
		label?: string;
		bpmMin?: number;
		bpmMax?: number;
		scalarBounds?: SqlPrefilter['scalarBounds'];
		hasSource?: string | string[];
		artistIds?: string[];
		albumIds?: string[];
		similarTo?: { seeds?: string[]; text?: string };
	} = {};
	// Set when the Rekordbox pill claims the single hasSource slot over a
	// `source:` term the user typed — the term then rides the in-memory pass.
	let pillTookSourceSlot = false;
	// Prefer the folder leaf as the search needle when in folder mode — it
	// matches what the user is visually narrowing toward. Outside folder
	// mode the AST's longest FREE term (via prefilter.search) is the most
	// selective LIKE pattern.
	const searchNeedle = inFolderMode ? trimmedLeaf : (prefilter.search ?? '');
	if (searchNeedle) filter.search = searchNeedle;
	if (prefilter.nameClauses && prefilter.nameClauses.length > 0) filter.nameClauses = prefilter.nameClauses;
	if (prefilter.keyCamelot) filter.keyCamelot = prefilter.keyCamelot;
	if (prefilter.bpmMin != null) filter.bpmMin = prefilter.bpmMin;
	if (prefilter.bpmMax != null) filter.bpmMax = prefilter.bpmMax;
	if (prefilter.scalarBounds && prefilter.scalarBounds.length > 0) filter.scalarBounds = prefilter.scalarBounds;
	// `source:` terms typed in the query itself — independent of (ANDed with)
	// the scope pill handled below.
	if (prefilter.hasSource) filter.hasSource = prefilter.hasSource;
	if (prefilter.artistIds && prefilter.artistIds.length > 0) filter.artistIds = prefilter.artistIds;
	if (prefilter.albumIds && prefilter.albumIds.length > 0) filter.albumIds = prefilter.albumIds;
	if (prefilter.similarTo) filter.similarTo = prefilter.similarTo;

	if (inFolderMode) {
		// Folder path collapses every other scope hint — we restrict to the
		// union of descendant playlists of every matched folder.
		const ids = new Set<string>();
		for (const f of pathMatchedFolders) {
			for (const pid of descendantPlaylistIds(f.id, tree)) ids.add(pid);
		}
		if (ids.size > 0) filter.playlistIds = Array.from(ids);
		// Empty match set → no tracks possible. We still let the query run so
		// the result list comes back empty rather than stale.
	} else if (scope === 'spotify' || scope === 'tidal') {
		filter.source = scope;
	} else if (scope === 'rekordbox') {
		// The Rekordbox pill mirrors the Rekordbox tab root: the collection
		// plus local files rekordbox doesn't have yet. Membership (hasSource),
		// not the source_link join — rb provenance lives in rekordbox_link.
		// Same any-of the Shift+Enter JIT bakes in (`(source:rekordbox |
		// source:local)`), so the preview and the loaded list can't disagree.
		// hasSource is one slot: a `source:` term typed alongside yields it to
		// the pill and is enforced by the matchTrack pass instead (the term
		// is in the AST; the pill isn't).
		if (filter.hasSource !== undefined) pillTookSourceSlot = true;
		filter.hasSource = ['rekordbox', 'local'];
	}

	// Unknown-tag short-circuit: a typed `#name` in a top-level MUST
	// position that doesn't resolve to a known tag means the user typed a
	// typo — surfacing the rest of the library would be misleading. Tags
	// inside an OR are NOT short-circuited (the prefilter extractor only
	// flags MUSTs), so `#typo | #real` still works.
	if (prefilter.hasUnresolvedRequiredTag) {
		results = [];
		activeIdx = 0;
		render();
		return;
	}

	// Empty query (no leaf, no AST content, no folder path) → show a few
	// "recent" suggestions so the popup never reads blank on first open.
	const queryIsEmpty = isEmptyExpr(queryExpr) && !inFolderMode;
	if (queryIsEmpty) {
		if (scope === 'all') {
			const pls = Array.from(deps.getPlaylists()).slice(0, MAX_RESULTS);
			results = pls.map((p) => ({ kind: 'playlist', playlist: p } as Result));
			activeIdx = 0;
			render();
			return;
		}
	}

	let tracks: Track[] = [];
	// Gate the backend call. Skip when:
	//   • Folder mode with zero matches — would scan the whole library.
	//   • Free-text is exactly 1 char and no other constraints — the
	//     multi-column LIKE has no index that can help a leading wildcard,
	//     so single-char queries are 7 full table scans whose results are
	//     too noisy to be useful. Comparisons (bpm<…), tag joins, and key=
	//     filters all hit indexes so they still fire below MIN_FREETEXT_CHARS.
	const hasIndexedConstraint =
		filter.nameClauses !== undefined
		|| filter.keyCamelot !== undefined
		|| filter.bpmMin !== undefined
		|| filter.bpmMax !== undefined;
	const tooShortForLike =
		searchNeedle.length > 0
		&& searchNeedle.length < MIN_FREETEXT_CHARS
		&& !hasIndexedConstraint
		&& !inFolderMode;
	const skipBackend = (inFolderMode && filter.playlistIds === undefined) || tooShortForLike;
	// When the AST has structure that SQL can't push (OR, parens, analyzer-
	// scalar comparisons, multi-FREE phrases, attr substrings), we pull a
	// wider candidate window and let matchTrack do the precise pass. The
	// limit is bounded so a complex query never reads the full library.
	const sqlComplete = prefilter.complete && !pillTookSourceSlot;
	const fetchLimit = sqlComplete ? MAX_RESULTS * 2 : 500;
	if (!skipBackend) {
		try {
			tracks = await window.api['tracks:list'](filter as never, undefined, fetchLimit);
		} catch (err) {
			log.for('omnibar').error('tracks:list failed', err);
		}
	}
	if (seq !== fetchSeq) return; // a newer query has superseded us

	// Decide whether the SQL fetch alone fully expresses the AST. Skip the
	// matchTrack post-pass when it does — important because matchTrack
	// re-evaluates tag MUSTs against tagsStore, which is a lazy per-track
	// cache that returns [] for tracks the renderer hasn't loaded yet. If
	// SQL has already filtered to the right tracks (via tagIds), re-checking
	// against an empty local cache would drop every result.
	//
	// Cases that still need matchTrack:
	//   • prefilter.complete is false — OR branches, attr substrings, or
	//     analyzer-scalar comparisons that SQL can't push.
	//   • folder mode — we used the folder leaf as the SQL `search` instead
	//     of prefilter.search, so any other AST FREE/CMP/tag constraint is
	//     still unenforced.
	//   • the Rekordbox pill took the hasSource slot from a typed `source:`
	//     term (sqlComplete is false then).
	const needsClientPass = !isEmptyExpr(queryExpr) && (!sqlComplete || inFolderMode);
	if (needsClientPass) {
		// Preload tag memberships when the AST references tags — otherwise
		// matchTrack's tag-check path reads an empty local cache and drops
		// SQL-correct rows.
		if (collectTagNames(queryExpr).length > 0) {
			await tagsStore.ensureTracksLoaded(tracks.map((t) => t.id));
			if (seq !== fetchSeq) return;
		}
		tracks = tracks.filter((t) => matchTrack(queryExpr, t, tagResolver));
	}
	if (tracks.length > MAX_RESULTS * 2) tracks = tracks.slice(0, MAX_RESULTS * 2);
	lastTracksFetch = tracks;

	// Folder + playlist matches. Two regimes:
	//   • folder-path mode: enumerate the matched folders' direct children
	//     (subfolders + child playlists), filter by `leaf` if present.
	//   • normal mode: match folders + playlists by name across the scoped
	//     subset. Rekordbox folders show up in 'all' and 'rekordbox' scopes;
	//     they're hidden from spotify/tidal scopes since the scope wouldn't
	//     lead anywhere meaningful.
	const folderResults: Result[] = [];
	const playlistResults: Result[] = [];

	if (inFolderMode) {
		const allowFolders = scope === 'all' || scope === 'rekordbox';
		const childrenByParent = new Map<string, PlaylistFolder[]>();
		for (const f of tree.folders) {
			const k = f.parentFolderId ?? '';
			if (!childrenByParent.has(k)) childrenByParent.set(k, []);
			childrenByParent.get(k)!.push(f);
		}
		const playlistsByParent = new Map<string, Playlist[]>();
		for (const p of tree.playlists) {
			const k = p.parentFolderId ?? '';
			if (!playlistsByParent.has(k)) playlistsByParent.set(k, []);
			playlistsByParent.get(k)!.push(p);
		}
		const seenF = new Set<string>();
		const seenP = new Set<string>();
		for (const f of pathMatchedFolders) {
			if (allowFolders) {
				for (const sub of childrenByParent.get(f.id) ?? []) {
					if (seenF.has(sub.id)) continue;
					if (trimmedLeaf && !sub.name.toLowerCase().includes(trimmedLeaf.toLowerCase())) continue;
					seenF.add(sub.id);
					folderResults.push({ kind: 'folder', folder: sub, path: folderDisplayPath(sub, tree) });
				}
			}
			for (const pl of playlistsByParent.get(f.id) ?? []) {
				if (seenP.has(pl.id)) continue;
				if (trimmedLeaf && !pl.name.toLowerCase().includes(trimmedLeaf.toLowerCase())) continue;
				seenP.add(pl.id);
				playlistResults.push({ kind: 'playlist', playlist: pl });
			}
		}
	} else {
		// Folder-by-name search (no path). Only meaningful in scopes where
		// Rekordbox playlists/folders are reachable. `searchNeedle` is the
		// AST's longest FREE term — the same one used as the SQL `search`
		// for tracks, so playlists/folders narrow with the same word.
		const nameNeedle = searchNeedle.toLowerCase();
		const allowFolders = scope === 'all' || scope === 'rekordbox';
		if (allowFolders && nameNeedle) {
			for (const f of tree.folders) {
				if (!f.name.toLowerCase().includes(nameNeedle)) continue;
				folderResults.push({ kind: 'folder', folder: f, path: folderDisplayPath(f, tree) });
			}
		}
		// Playlists: scope-filtered substring match on name. Curator-local
		// playlists live on the Rekordbox tab, so the rekordbox scope includes them.
		const pls = Array.from(deps.getPlaylists())
			.filter((p) => scope === 'all' || p.source === scope || (scope === 'rekordbox' && p.source === 'local'))
			.filter((p) => !nameNeedle || p.name.toLowerCase().includes(nameNeedle));
		for (const p of pls) playlistResults.push({ kind: 'playlist', playlist: p });
	}

	// Mix: folders (max 3), then playlists (max 3), then tracks, capped at
	// MAX_RESULTS so the popup never grows past the user's eye-line.
	const merged: Result[] = [];
	for (const r of folderResults.slice(0, 3)) merged.push(r);
	for (const r of playlistResults.slice(0, 3)) {
		if (merged.length >= MAX_RESULTS) break;
		merged.push(r);
	}
	for (const t of tracks) {
		if (merged.length >= MAX_RESULTS) break;
		merged.push({ kind: 'track', track: t });
	}
	results = merged;
	activeIdx = 0;
	render();
}

function highlight(s: string, q: string): string {
	if (!q) return escapeHtml(s);
	const needle = q.toLowerCase();
	const hay = s.toLowerCase();
	const i = hay.indexOf(needle);
	if (i < 0) return escapeHtml(s);
	return `${escapeHtml(s.slice(0, i))}<mark>${escapeHtml(s.slice(i, i + needle.length))}</mark>${escapeHtml(s.slice(i + needle.length))}`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => (
		c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
	));
}

function render(): void {
	if (!resultsEl || !inputEl) return;
	const { term: rawTerm } = parseInputRaw(inputEl.value);
	// Highlight needle for matched text spans. The SQL prefilter's longest
	// FREE term — or the folder-path leaf when in folder mode — is the
	// most useful single word to highlight in result rows.
	const expr = parseQuery(rawTerm);
	const { leaf, remaining } = extractFolderSyntax(expr);
	const pre = extractSqlPrefilter(remaining);
	const q = (leaf || pre.search || '').trim();

	if (results.length === 0) {
		resultsEl.innerHTML = `
			<div class="omnibar__empty">
				<strong>No matches</strong><br/>
				Try a different term, or change scope with <kbd>Tab</kbd>.
			</div>`;
		return;
	}

	const rows: string[] = [];
	results.forEach((r, idx) => {
		const active = idx === activeIdx ? ' is-active' : '';
		if (r.kind === 'track') {
			const t = r.track;
			const artistText = (t.artists ?? []).map((a) => a.name).join(', ');
			rows.push(`
				<div class="omnibar__row${active}" data-result-idx="${idx}" data-kind="track" role="option" aria-selected="${idx === activeIdx}">
					<div class="omnibar__row-kind" title="Track">♪</div>
					<div class="omnibar__row-art" style="background-image: url(curator-cover://${encodeURIComponent(t.id)});"></div>
					<div class="omnibar__row-main">
						<div class="omnibar__row-title">${highlight(t.title, q)}</div>
						<div class="omnibar__row-sub">${highlight(artistText || '—', q)}${t.albumTitle ? ' · ' + highlight(t.albumTitle, q) : ''}</div>
					</div>
					<div class="omnibar__row-bpm">${formatBpmInt(t.bpm)}</div>
					<div class="omnibar__row-key">${keyChipHtml(t.keyCamelot)}</div>
				</div>`);
		} else if (r.kind === 'playlist') {
			const p = r.playlist;
			const sub = `${p.source} · ${p.trackCount ?? '—'} tracks`;
			rows.push(`
				<div class="omnibar__row${active}" data-result-idx="${idx}" data-kind="playlist" role="option" aria-selected="${idx === activeIdx}">
					<div class="omnibar__row-kind" title="Playlist">PL</div>
					<div class="omnibar__row-art" style="background-image: ${p.coverUrl ? `url(${JSON.stringify(p.coverUrl)})` : 'linear-gradient(135deg,var(--bg-3),var(--bg-2))'};"></div>
					<div class="omnibar__row-main">
						<div class="omnibar__row-title">${highlight(p.name, q)}</div>
						<div class="omnibar__row-sub">${escapeHtml(sub)}</div>
					</div>
					<div class="omnibar__row-bpm"></div>
					<div class="omnibar__row-key"></div>
				</div>`);
		} else {
			const f = r.folder;
			rows.push(`
				<div class="omnibar__row${active}" data-result-idx="${idx}" data-kind="folder" role="option" aria-selected="${idx === activeIdx}">
					<div class="omnibar__row-kind" title="Folder">▸</div>
					<div class="omnibar__row-art omnibar__row-art--folder">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a1 1 0 0 1 1-1h4l2 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z"/></svg>
					</div>
					<div class="omnibar__row-main">
						<div class="omnibar__row-title">${highlight(f.name, q)}</div>
						<div class="omnibar__row-sub">rekordbox · ${escapeHtml(r.path)}</div>
					</div>
					<div class="omnibar__row-bpm"></div>
					<div class="omnibar__row-key"></div>
				</div>`);
		}
	});
	resultsEl.innerHTML = rows.join('');
}

function highlightActive(scrollIntoView = false): void {
	if (!resultsEl) return;
	resultsEl.querySelectorAll<HTMLElement>('[data-result-idx]').forEach((el) => {
		const i = Number(el.dataset.resultIdx);
		el.classList.toggle('is-active', i === activeIdx);
		el.setAttribute('aria-selected', String(i === activeIdx));
	});
	if (scrollIntoView) {
		const active = resultsEl.querySelector<HTMLElement>(`[data-result-idx="${activeIdx}"]`);
		active?.scrollIntoView({ block: 'nearest' });
	}
}

function pick(idx: number): void {
	const r = results[idx];
	if (!r) return;
	if (r.kind === 'track') {
		const list = lastTracksFetch.length > 0 ? lastTracksFetch : results.filter((x): x is Extract<Result, { kind: 'track' }> => x.kind === 'track').map((x) => x.track);
		void deps.onPickTrack(r.track, list);
	} else if (r.kind === 'playlist') {
		void deps.onPickPlaylist(r.playlist);
	} else {
		void deps.onPickFolder(r.folder);
	}
	close();
}

// Shift+Enter handler — swap the main tracklist to a JIT scope whose
// query equals the omnibar's current input. The highlighted track (if
// any) is passed along so the renderer can pre-select that row once
// the JIT lands — the user then presses Enter to play.
function loadAsJit(): void {
	if (!inputEl) return;
	const raw = inputEl.value.trim();
	// Nothing meaningful to load — bail without closing so the user
	// can keep typing.
	if (!raw && results.length === 0) return;
	const { term } = parseInputRaw(inputEl.value);
	const queryText = term.trim();
	// The JIT re-runs the query string through the shared grammar — the
	// scope pill isn't part of that string, so bake it in as a `source:`
	// term. Without this the JIT loaded ALL sources while its name claimed
	// a scoped search (the omnibar preview and the loaded list disagreed).
	// Works for the typed-prefix path too: applyPrefixFromInput already
	// promoted `r/` into `scope` on input. The Rekordbox pill is the tab
	// root's any-of (collection ∪ local files) — a parenthesised source
	// disjunction, which the prefilter pushes whole as hasSource[].
	const scopeTerm = scope === 'rekordbox' ? '(source:rekordbox | source:local)' : `source:${scope}`;
	const jitQuery = scope !== 'all'
		? (queryText ? `${scopeTerm} ${queryText}` : scopeTerm)
		: queryText;
	// Pick the track-to-select from the highlighted result row when
	// it's a track; playlist / folder rows don't have a track-id to
	// seed selection with.
	const active = results[activeIdx];
	const selectTrackId = active && active.kind === 'track' ? active.track.id : null;
	void deps.onLoadAsJit(jitQuery, buildJitName(queryText, scope), selectTrackId);
	close();
}

// Render-friendly JIT name from the raw query (scope term NOT baked in —
// the label carries that) + the active scope. Keyed on `scope`, not the
// typed prefix, so a pill-selected scope names the JIT too. Truncates long
// queries so the title slot doesn't blow out. Folder-path queries get a
// "Folder:" prefix instead of "Search:" since the user's intent is the
// path, not the term.
function buildJitName(query: string, src: OmnibarSource): string {
	const scopeLabel = src === 'all' ? null : (PILL_DEFS.find((p) => p.src === src)?.label ?? null);
	const trimmed = query.length > 50 ? query.slice(0, 50).trimEnd() + '…' : query;
	if (query.includes('/') && !query.includes(' ')) {
		// Folder-path query (e.g. "zen/uplifting/") — surface the path
		// directly without the "Search:" prefix since it's not a search.
		return `Folder: ${trimmed}`;
	}
	if (!trimmed) {
		// Empty query with a scope — name reads as the scope alone
		// (e.g. "Search · Spotify").
		return scopeLabel ? `Search · ${scopeLabel}` : 'Search';
	}
	return scopeLabel ? `Search · ${scopeLabel}: ${trimmed}` : `Search: ${trimmed}`;
}
