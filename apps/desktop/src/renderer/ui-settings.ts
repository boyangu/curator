// Persisted UI preferences — sidebar width + per-column track-table widths.
// Backed by localStorage so changes survive across sessions without an IPC
// roundtrip per drag tick. Single-user desktop app; no need to sync.
//
// If we ever want this portable across machines, the load/persist pair is
// the only point that needs to swap (DB-backed setting table, exportable
// JSON, etc.) — call sites just use the getters/setters.

import { log } from './data/log.js';

const KEY = 'curator.ui-settings.v1';

interface UISettings {
	sidebarW: number | null;
	// Sidebar collapsed/expanded — independent of sidebarW so expanding
	// restores the user's dragged width.
	sidebarCollapsed: boolean;
	columnWidths: Record<string, number>;
	// Per-column visibility, keyed by Column short code (track-list.ts).
	// Missing entry = visible. Storing only the user's explicit overrides
	// keeps the file small and lets new columns default to visible without
	// a migration.
	columnVisibility: Record<string, boolean>;
	// Column order, as Column short codes. null = the default order
	// (ALL_COLUMNS in track-list.ts). Columns added to the app after the
	// order was saved are appended by the reader, so a new column shows up
	// without a migration; unknown codes (removed columns) are dropped.
	columnOrder: string[] | null;
	// NB: per-source sync preferences deliberately do NOT live here. This
	// store is per browser origin (dev vs packaged renderer differ), and a
	// setting core gates remote writes on must be one value — see
	// app_setting in the shared schema + features/settings.ts.
	// Per-playlist sort memory. Keyed by playlistId, libraryFolderId, or
	// rekordboxFolderId — they're disjoint id spaces so one map is fine.
	// Missing entry means "use the default" (index asc, which mirrors
	// Spotify's Custom order). Stored as raw strings so this file doesn't
	// have to import the SortColumn union from track-list.ts; the renderer
	// narrows at read time.
	playlistSorts: Record<string, { column: string; dir: 'asc' | 'desc' }>;
	// One-time migration flag. When false, the renderer pre-seeds an
	// `Added ↓` (createdAt desc) entry into playlistSorts for every existing
	// Spotify playlist on boot — so the user's library matches the
	// "Recently added" view they're used to seeing in Spotify itself.
	// Set to true after the migration runs so we don't re-seed (which
	// would clobber any subsequent user choices).
	playlistSortsSpotifyBackfilled: boolean;
}

const DEFAULTS: UISettings = {
	sidebarW: null,           // null → use the CSS default (248px)
	sidebarCollapsed: false,
	columnWidths: {},          // keyed by col class (e.g. 'c-title')
	columnVisibility: {},      // keyed by Column short code
	columnOrder: null,
	playlistSorts: {},
	playlistSortsSpotifyBackfilled: false,
};

let cache: UISettings | null = null;

function load(): UISettings {
	if (cache) return cache;
	try {
		const raw = localStorage.getItem(KEY);
		const parsed = raw ? JSON.parse(raw) as Partial<UISettings> : null;
		cache = {
			sidebarW: parsed?.sidebarW ?? DEFAULTS.sidebarW,
			sidebarCollapsed: parsed?.sidebarCollapsed ?? DEFAULTS.sidebarCollapsed,
			columnWidths: parsed?.columnWidths ?? { ...DEFAULTS.columnWidths },
			columnVisibility: parsed?.columnVisibility ?? { ...DEFAULTS.columnVisibility },
			columnOrder: Array.isArray(parsed?.columnOrder) ? parsed!.columnOrder!.filter((c): c is string => typeof c === 'string') : null,
			playlistSorts: parsed?.playlistSorts ?? { ...DEFAULTS.playlistSorts },
			playlistSortsSpotifyBackfilled: parsed?.playlistSortsSpotifyBackfilled ?? DEFAULTS.playlistSortsSpotifyBackfilled,
		};
	} catch {
		cache = {
			sidebarW: DEFAULTS.sidebarW,
			sidebarCollapsed: DEFAULTS.sidebarCollapsed,
			columnWidths: { ...DEFAULTS.columnWidths },
			columnVisibility: { ...DEFAULTS.columnVisibility },
			columnOrder: null,
			playlistSorts: { ...DEFAULTS.playlistSorts },
			playlistSortsSpotifyBackfilled: DEFAULTS.playlistSortsSpotifyBackfilled,
		};
	}
	return cache!;
}

function persist(): void {
	if (!cache) return;
	try { localStorage.setItem(KEY, JSON.stringify(cache)); }
	catch (err) { log.for('ui-settings').warn('persist failed', undefined, err); }
}

export function getSidebarW(): number | null { return load().sidebarW; }
export function setSidebarW(n: number): void { load().sidebarW = n; persist(); }

export function getSidebarCollapsed(): boolean { return load().sidebarCollapsed; }
export function setSidebarCollapsed(v: boolean): void { load().sidebarCollapsed = v; persist(); }

export function getColumnWidth(colClass: string): number | undefined {
	return load().columnWidths[colClass];
}
export function setColumnWidth(colClass: string, n: number): void {
	load().columnWidths[colClass] = n;
	persist();
}
export function getAllColumnWidths(): Readonly<Record<string, number>> {
	return load().columnWidths;
}

// Column visibility — missing key means visible. We persist only explicit
// hides; this keeps new columns visible by default without a migration.
export function getColumnVisibility(col: string): boolean {
	return load().columnVisibility[col] !== false;
}
export function setColumnVisibility(col: string, visible: boolean): void {
	load().columnVisibility[col] = visible;
	persist();
}
export function getAllColumnVisibility(): Readonly<Record<string, boolean>> {
	return load().columnVisibility;
}

// Column order — resolved against the caller's canonical list so codes the
// app no longer knows are dropped and newly added columns land at the end.
// Returns `all` untouched when the user never reordered.
export function getColumnOrder<T extends string>(all: readonly T[]): T[] {
	const stored = load().columnOrder;
	if (!stored) return [...all];
	const known = new Set<string>(all);
	const out = stored.filter((c): c is T => known.has(c));
	for (const c of all) if (!out.includes(c)) out.push(c);
	return out;
}
export function setColumnOrder(order: readonly string[]): void {
	load().columnOrder = [...order];
	persist();
}
export function resetColumnOrder(): void {
	load().columnOrder = null;
	persist();
}

// ─── Per-playlist sort memory ──────────────────────────────────────────
// Remembers the column + direction the user last sorted by while a given
// playlist (or library/Rekordbox folder) was open. On reopen, the caller
// restores that sort. Returns null when nothing's been stored — caller
// falls back to its own default (currently `index asc`, which mirrors
// Spotify's Custom order).

export function getPlaylistSort(id: string): { column: string; dir: 'asc' | 'desc' } | null {
	const stored = load().playlistSorts[id];
	return stored ?? null;
}

export function setPlaylistSort(id: string, sort: { column: string; dir: 'asc' | 'desc' }): void {
	load().playlistSorts[id] = sort;
	persist();
}

export function hasPlaylistSort(id: string): boolean {
	return load().playlistSorts[id] != null;
}

// One-time migration flag — see UISettings.playlistSortsSpotifyBackfilled.
export function isSpotifyBackfillDone(): boolean {
	return load().playlistSortsSpotifyBackfilled === true;
}
export function markSpotifyBackfillDone(): void {
	load().playlistSortsSpotifyBackfilled = true;
	persist();
}
