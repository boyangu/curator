// TrackListView — single source of truth for rendering a list of tracks as a
// table. Composable: multiple independent instances can mount into different
// hosts (split decks, embedded result cards, etc.) without colliding on
// global state. Per-instance ownership of:
//   - row DOM (with optional virtualization)
//   - selection state (with shared "active handle" registry so blurring is
//     automatic on focus change)
//   - sort header + arrow indicator
//   - column resize handles
//
// What the component does NOT know about:
//   - data fetching (caller supplies tracks via update())
//   - persistence (caller wires onColumnResize/onSelectionChange → settings)
//   - playback (caller supplies onPlay; component fires double-click)
//   - context menus (caller supplies onContextMenu / onSrcHeaderContextMenu)
//   - playlist concept, filters
//
// Replaces the inline virtualized renderer that previously lived in
// main.ts (~250 LoC of rowHtml/renderTrackRows/wireTbodyDelegationOnce/…).
// Single row factory, single virtualizer, single selection model.
//
// Two row layouts (TrackListOptions.rowLines): one 30px line per track with
// a column per field (scrolls sideways), or two 52px lines with PAIRED
// columns (title over artist — album, label over released, …) that fit a
// ~1040px pane. And optional grouping (artist / album / label): the
// virtualizer then walks a DISPLAY list of group header rows + track rows
// (trackGroups.ts); `tracks` — what selection, keyboard and the play queue
// see — is the tracks on screen, collapsed groups excluded. `data-index`
// on a row keeps meaning "index in getTracks()".

import type { AlbumSummary, Track } from '@curator/shared';
import { artistCreditParts, formatTrackTitle } from '@curator/shared';
import { artistCreditFormat } from './features/uiSettings.js';
import { Virtualizer, observeElementRect, observeElementOffset, elementScroll } from '@tanstack/virtual-core';
import { getNowPlayingTrackId } from './now-playing.js';
import { analysisStatus } from './data/analysisStatus.js';
import { keyChipHtml, formatBpmInt } from './music-utils.js';
import { similarLevelsFor, type SimilarityDim } from './features/similarity.js';
import { setTrackDragPayload } from './dnd.js';
import { fmtReleaseLabel } from './ui/format.js';
import {
	buildDisplayList, groupHeadInnerHeight, groupIdentity, rowHeight, GROUP_GAP_H, TRACK_ROW_H,
	type DisplayList, type DisplayRow, type GroupBy, type GroupInfo, type RowLines,
} from './trackGroups.js';

export type Column = 'src' | 'idx' | 'match' | 'art' | 'title' | 'artist' | 'album' | 'rel' | 'label' | 'genre' | 'bpm' | 'key' | 'time' | 'rating' | 'lra' | 'diss' | 'dens' | 'bright' | 'power' | 'punch' | 'tags' | 'added' | 'act';
// Paired columns of the two-line layout. Each stacks up to two fields
// (line 1 / line 2) and shows only the fields the per-field visibility
// (TrackRowOptions.fields — the same set the one-line columns use) allows.
// src / idx / match / art / added keep their one-line identity.
export type PairColumn = 'title2' | 'labelrel' | 'genretags' | 'keyfx' | 'timerating';
export type LayoutColumn = Column | PairColumn;
export type SortColumn = 'match' | 'index' | 'title' | 'artist' | 'album' | 'releaseDate' | 'label' | 'genre' | 'bpm' | 'keyCamelot' | 'duration' | 'createdAt' | 'rating' | 'loudnessRangeLu' | 'dissonance' | 'density' | 'brightness' | 'power' | 'dynamicComplexity';
export type SortDir = 'asc' | 'desc';

export interface TrackRowOptions {
	index?: number;                       // shown in `#` column when >= 0 AND the track has no playlistPosition
	columns?: LayoutColumn[];             // subset of columns to render
	// Row layout (default 1). In two-line rows every cell is a `.l1` / `.l2`
	// stack and `fields` decides which of a paired column's fields show.
	lines?: RowLines;
	fields?: ReadonlySet<Column>;
	// The list's grouping: rows never repeat the grouped field (artist
	// grouping drops the artist from the title's second line, …).
	groupBy?: GroupBy;
	covers?: boolean;                     // enable curator-cover:// background
	// Tag resolver — when the 'tags' column is rendered, the row factory
	// calls this with the track id and gets back a display-ready list of
	// chips. Caller decides where the lookup comes from (tagsStore in the
	// main app, or a static map). When omitted the
	// 'tags' cell renders empty.
	tagsForTrack?: (trackId: string) => readonly { id: string; name: string; color: string | null }[];
	// Mark tracks that have a local file with Discover's "In Library" chip.
	inLibraryChip?: boolean;
}

export interface TrackListOptions {
	columns?: LayoutColumn[];
	showHeader?: boolean;
	// Row layout + grouping (see the file header). Both default to the
	// one-line, ungrouped table the embedded lists use.
	rowLines?: RowLines;
	fields?: ReadonlySet<Column>;
	groupBy?: GroupBy;
	// Collapsed group keys. Owned by the caller (session-only memory that
	// survives a remount); the list mutates it on toggle.
	collapsedGroups?: Set<string>;
	// Album group headers: the release details by album id (undefined =
	// not loaded yet), and the hook that asks for the ones the list shows.
	// The caller calls refreshGroupHeaders() when answers land.
	albumInfo?: (albumId: string) => AlbumSummary | null | undefined;
	onNeedAlbums?: (albumIds: string[]) => void;
	// Virtualize when true — only the rows in the viewport (plus a buffer)
	// are in the DOM; top/bottom spacer rows preserve scroll height. Required
	// for large lists (>~100 rows); leave false for embedded small lists.
	virtualize?: boolean;
	// Sort state + change callback. When provided AND showHeader=true, the
	// header cells become click-to-sort and show the current sort arrow.
	sort?: { column: SortColumn; dir: SortDir };
	onSortChange?: (next: { column: SortColumn; dir: SortDir }) => void;
	// Column resize. When set, every column (the last one included — the
	// auto-width title column absorbs the slack, so an explicit width on the
	// rightmost column is honoured) gets a drag handle on its right edge;
	// onColumnResize fires on mouseup with the final width.
	resizableColumns?: boolean;
	onColumnResize?: (colClass: string, widthPx: number) => void;
	initialColumnWidths?: Readonly<Record<string, number>>;
	// Column reorder. When set, header cells are draggable; dropping one
	// before/after another fires onColumnReorder with the full new order of
	// THIS list's columns. The component does not re-layout itself — column
	// order is baked into colgroup + every row, so the caller re-mounts
	// (same path as show/hide columns).
	reorderableColumns?: boolean;
	onColumnReorder?: (order: LayoutColumn[]) => void;
	// Row-level interactions
	onPlay?: (t: Track, all: Track[]) => void;
	onContextMenu?: (evt: MouseEvent, t: Track, all: Track[], selectedIds: string[]) => void;
	// Plain left-click on an artist chip that carries a Curator artist id
	// (`Track.artistIds`, attached by decorated reads). Caller opens the
	// artist scope. Modifier clicks keep their selection meaning instead.
	onArtistClick?: (artistId: string, name: string, t: Track) => void;
	// Plain left-click on a label / genre value or a tag chip — same drill
	// semantics as the artist chip (caller opens a scope for that value).
	onDrillClick?: (kind: 'label' | 'genre' | 'tag', value: string, t: Track) => void;
	// SRC header right-click — caller decides what menu to show. Component
	// just dispatches the event with no opinion on the contents.
	onSrcHeaderContextMenu?: (evt: MouseEvent) => void;
	// Right-click on any other header — fires for every non-SRC th. Caller
	// shows the show/hide columns menu (or whatever else). The component
	// does not preventDefault for the caller; the caller is responsible if
	// it wants to suppress the native menu.
	onHeaderContextMenu?: (evt: MouseEvent, col: LayoutColumn) => void;
	// Drag-reorder. When `reorderable` is true a row drag emits onReorder
	// with the new ordering of the rows' `playlistPosition` values on an
	// in-list drop. (Rows are always draggable regardless — dragging OUT to
	// the sidebar's playlist drop targets works from any view; this flag
	// only gates the in-list reorder gesture.) Caller is responsible
	// for: (a) gating reorderable on (sort=index asc + playlist context),
	// (b) translating onReorder → `playlists:reorder` IPC, (c) refreshing
	// the list once the write lands. We don't write back into the component's
	// `tracks` array — the caller's next `update(...)` does that with the
	// fresh data from the DB. Optimistic reorder is deliberately omitted
	// because a refresh round-trips fast enough on local SQLite that the
	// shimmer of "drop → re-fetch" is invisible (~10ms).
	reorderable?: boolean;
	// Fires after a drop. `newOrder` is the FULL list of playlist positions
	// in their new order — the same shape `playlists:reorder` expects on
	// the wire. Null when reordering wasn't possible (rows missing a
	// playlistPosition); caller should ignore the drop in that case.
	onReorder?: (newOrder: number[]) => void;
	// Fires when selection changes. Caller can mirror to globals / persist /
	// update bound UI. Component owns the canonical selection state — do not
	// call .update() in response to this callback.
	onSelectionChange?: (selectedIds: string[], anchor: string | null) => void;
	// Optional toolbar slotted above the table — caller-supplied DOM.
	toolbar?: HTMLElement;
	// Tag resolver — forwarded to every createTrackRow call so the 'tags'
	// column can render chips. Caller is responsible for kicking the
	// underlying batch fetch (e.g. tagsStore.ensureTracksLoaded) before
	// the next .update() so the resolver returns populated lists; the
	// component itself only reads via this callback.
	tagsForTrack?: (trackId: string) => readonly { id: string; name: string; color: string | null }[];
	// Read at row-construction time (like tagsForTrack) so one mounted list can
	// switch the chip on/off as the caller's view changes — the caller re-renders
	// rows on a view switch anyway.
	inLibraryChip?: () => boolean;
}

export interface TrackListHandle {
	update(tracks: Track[]): void;
	patchOne(track: Track): void;
	// Rebuild every currently-rendered row from the in-memory tracks — same
	// data, fresh DOM. For render-time-computed decorations (similarity
	// highlight) whose inputs changed globally. No DB refetch, no scroll or
	// selection change; O(visible window), not O(list).
	repaintVisibleRows(): void;
	setSort(sort: { column: SortColumn; dir: SortDir }): void;
	// Scroll a specific row into view if not already visible. Returns true
	// if the index was valid. Forces a virt repaint so the row exists in
	// the DOM by the time the next paint commits.
	scrollToIndex(idx: number): boolean;
	// A track inside a collapsed group expands that group first. `align`
	// defaults to 'auto' (only scroll when not visible).
	scrollToTrack(id: string, align?: 'auto' | 'start'): boolean;
	getScrollTop(): number;
	setScrollTop(n: number): void;
	/// Index of the first row whose top edge is at or below the viewport
	/// top — the topmost fully-visible row. Returns -1 when the list is
	/// empty. Used by the global Tab handler to anchor "return focus to
	/// the tracklist" on a row the user actually sees.
	getFirstVisibleIndex(): number;
	destroy(): void;
	focus(): void;
	blur(): void;
	getSelectedIds(): string[];
	setSelectedIds(ids: string[]): void;
	getSelectionAnchor(): string | null;
	setSelectionAnchor(id: string | null): void;
	// Select every currently-loaded track. Silent — does NOT fire
	// onSelectionChange (caller does the persistence write).
	selectAll(): void;
	// Replace selection with the inclusive range [anchorId, leadId]. Used
	// by the keyboard handler for Shift+Up/Down. Silent for the same reason
	// as selectAll.
	setSelectionRange(anchorId: string, leadId: string): void;
	// Hot-swap reorderable state without a full remount. Caller flips this
	// in response to sort/playlist changes so drag handles attach + detach
	// cleanly between renders.
	setReorderable(b: boolean): void;
	// The tracks on screen, in display order (grouped: collapsed groups
	// excluded) — what range selection, keyboard nav and the play queue use.
	getTracks(): readonly Track[];
	// Everything the caller handed to update(), collapsed tracks included.
	getAllTracks(): readonly Track[];
	// Grouping. toggleGroup flips one group (`all` = every group to the
	// opposite of this one's state — Alt+click); collapse/expandAll are the
	// Group menu's bulk actions. refreshGroupHeaders re-renders the header
	// rows in view (album details landed).
	toggleGroup(key: string, all?: boolean): void;
	collapseAll(): void;
	expandAll(): void;
	refreshGroupHeaders(): void;
	// The root element the component owns inside the supplied host.
	el: HTMLElement;
}

// Source markers, in a fixed order. `rekordbox` comes from rekordbox_link
// (decorateTracks unions it into `sources`).
const SOURCE_ORDER = ['spotify', 'tidal', 'beatport', 'rekordbox', 'local'] as const;
const SOURCE_NAMES: Record<(typeof SOURCE_ORDER)[number], string> = {
	spotify: 'Spotify', tidal: 'Tidal', beatport: 'Beatport', rekordbox: 'Rekordbox', local: 'Local file',
};
export const ALL_COLUMNS: Column[] = ['src', 'idx', 'match', 'art', 'title', 'artist', 'album', 'rel', 'label', 'genre', 'bpm', 'key', 'time', 'rating', 'lra', 'diss', 'dens', 'bright', 'power', 'punch', 'tags', 'added'];

// The two-line layout's columns from the visible fields. idx / title are
// always there (locked); a paired column shows when any of its fields is
// visible. The
// cover drops out in album grouping — the group header carries it. Punch,
// density, dissonance and dynamic range have no slot (one-line only).
export function twoLineColumns(visible: (c: Column) => boolean, opts: { groupBy: GroupBy; match: boolean }): LayoutColumn[] {
	const out: LayoutColumn[] = visible('src') ? ['src', 'idx'] : ['idx'];
	if (opts.match) out.push('match');
	if (opts.groupBy !== 'album') out.push('art');
	out.push('title2');
	if (visible('label') || visible('rel')) out.push('labelrel');
	if (visible('genre') || visible('tags')) out.push('genretags');
	if (visible('key') || visible('power') || visible('bpm') || visible('bright')) out.push('keyfx');
	if (visible('time') || visible('rating')) out.push('timerating');
	if (visible('added')) out.push('added');
	return out;
}
const VIRT_BUFFER = 16;
const MIN_COL_W = 32;
// Tag chip cap in the row's "tags" cell. Tracks can carry 8+ tags; squeezing
// them all into a 30px-tall row crowds out everything else. We render the
// first 3 and roll the rest into a `+N` overflow chip whose tooltip lists
// the full set.
const TL_TAG_LIMIT = 3;

const fmt2 = (n: number): string => String(n).padStart(2, '0');
// Group header total time — "1:04:12" past the hour.
const fmtTotal = (sec: number): string => {
	const s = Math.max(0, Math.round(sec));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}:${fmt2(m)}:${fmt2(s % 60)}` : `${m}:${fmt2(s % 60)}`;
};
const initials = (name: string): string => name.split(/\s+/).filter(Boolean).map((w) => w[0]!).join('').slice(0, 2);
const drillSpan = (kind: 'label' | 'genre', v: string | null | undefined): string =>
	v ? `<span class="tl-drill" data-drill="${kind}" data-v="${escapeHtml(v)}">${escapeHtml(v)}</span>` : '';
const fmtTime = (sec: number | null | undefined): string => sec ? `${fmt2(Math.floor(sec / 60))}:${fmt2(sec % 60)}` : '—';
const fmtFixed = (n: number | null | undefined, d: number): string =>
	n == null || !Number.isFinite(n) ? '—' : n.toFixed(d);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Rekordbox 0..5 rating → filled+empty star pair. Null (never imported from
// Rekordbox) renders as the same em-dash placeholder as other null-valued
// numeric cells. Filled stars are spans so CSS can tint them — the bare
// "★" glyph is hard to make legible at 12px without an accent colour.
const ratingCell = (r: number | null | undefined): string => {
	if (r == null) return '<span class="rating-dash">—</span>';
	const n = Math.max(0, Math.min(5, Math.round(r)));
	return `<span class="rating-stars" title="${n}/5">`
		+ '<span class="rating-stars__on">' + '★'.repeat(n) + '</span>'
		+ '<span class="rating-stars__off">' + '★'.repeat(5 - n) + '</span>'
		+ '</span>';
};
// "Added" timestamp, bucketed by recency for at-a-glance scanning:
//   today        → 24-hour clock time  ("14:32")
//   this month   → month + day         ("Aug 13")
//   older        → month + year        ("Aug, 2024") — same shape as the
//                  Release column's month-and-year, so the two date
//                  columns read consistently. `addedAt`/`createdAt` are full timestamps,
//                  so unlike Release this always has a real month + year.
// Buckets are computed in LOCAL calendar terms (getFullYear/Month/Date) — a
// track added at 23:50 stays "today" until local midnight, matching intuition.
const fmtAdded = (d: Date | string | null | undefined): string => {
	if (!d) return '—';
	const date = new Date(d);
	const now = new Date();
	const sameMonth = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
	if (sameMonth && date.getDate() === now.getDate()) return `${fmt2(date.getHours())}:${fmt2(date.getMinutes())}`;
	if (sameMonth) return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
	return `${MONTHS[date.getMonth()]}, ${date.getFullYear()}`;
};
const coverGradient = (i: number): string => {
	const hues = [25, 65, 105, 145, 195, 230, 280, 320];
	const h1 = hues[i % hues.length];
	const h2 = hues[(i * 3 + 2) % hues.length];
	return `linear-gradient(135deg, oklch(0.45 0.16 ${h1}), oklch(0.18 0.08 ${h2}))`;
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Artist cell — one span per credited artist, joined by the static
// separators artistCreditParts decides (the user's separator, "feat.",
// the remix style — Settings → User Interface). A span gets `data-aid`
// (the Curator artist id, position-aligned with `artists`) when the read
// decorated one; that attribute is what the tbody click delegate keys on.
// Static HTML only — the virtualized row factory never attaches listeners;
// main.ts repaints when the format setting changes.
function artistCreditHtml(t: Track): string {
	const parts = artistCreditParts(t.artists, artistCreditFormat());
	if (parts.length === 0) return '—';
	return parts.map((p) => {
		if (p.kind === 'sep') return `<span class="tl-artist-role">${escapeHtml(p.text)}</span>`;
		const id = t.artistIds?.[p.index];
		const a = p.artist;
		return `<span class="tl-artist"${id ? ` data-aid="${escapeHtml(id)}"` : ''}${a.role ? ` data-role="${a.role}"` : ''}>${escapeHtml(a.name)}</span>`;
	}).join('');
}

// ─── createTrackRow ─────────────────────────────────────────────────────────
// Pure factory — takes a Track + render options, returns a fully-formed
// <tr> ready to be inserted into any <tbody>. No event listeners.

// "Tidewater (Original Mix)" → ["Tidewater", "Original Mix"];
// "Saltmarsh - Juno Halde Remix" → ["Saltmarsh", "Juno Halde Remix"]. Only
// the LAST bracketed segment (or a dash suffix that names a version) is the
// version — the two-line title shows it a step dimmer; anything else stays
// in the title.
const VERSION_WORDS = /\b(mix|remix|edit|dub|version|rework|bootleg|vip|instrumental|remaster(ed)?|live|acoustic|extended|radio|reprise)\b/i;
export function splitTitleVersion(title: string): [string, string] {
	const br = title.match(/^(.*\S)\s*[([]([^()[\]]+)[)\]]\s*$/);
	if (br) return [br[1]!, br[2]!.trim()];
	const dash = title.match(/^(.*\S)\s+[-–—]\s+(.+)$/);
	if (dash && VERSION_WORDS.test(dash[2]!)) return [dash[1]!, dash[2]!.trim()];
	return [title, ''];
}

const ALL_FIELDS: ReadonlySet<Column> = new Set(ALL_COLUMNS);

export function createTrackRow(t: Track, opts: TrackRowOptions = {}): HTMLTableRowElement {
	const lines: RowLines = opts.lines ?? 1;
	const cols: LayoutColumn[] = opts.columns ?? ALL_COLUMNS;
	const fields = opts.fields ?? ALL_FIELDS;
	const groupBy: GroupBy = opts.groupBy ?? 'none';
	const i = opts.index ?? 0;
	const keyCell = keyChipHtml(t.keyCamelot);
	const present = new Set(t.sources ?? []);
	const srcs = SOURCE_ORDER.filter((s) => present.has(s));
	const coverBg = opts.covers !== false
		? `url(curator-cover://${encodeURIComponent(t.id)}), ${coverGradient(i)}`
		: coverGradient(i);
	const isNowPlaying = getNowPlayingTrackId() === t.id;
	// `#` cell prefers the canonical playlist position over the visible-array
	// index. Stable across sort + client-side filter — the track's identity
	// within the playlist doesn't move when the user changes how they're
	// looking at it. Falls back to the array index outside a playlist (where
	// playlistPosition is absent).
	const stablePos = t.playlistPosition;
	const idxLabel = stablePos != null
		? fmt2(stablePos)
		: (opts.index != null && opts.index >= 0 ? fmt2(i + 1) : '');
	// Number AND meter in every index cell — CSS shows the meter on the
	// playing row (now-playing.ts only toggles `row-playing`).
	const eq = (cls: string): string => `<span class="now-playing-eq ${cls}" aria-label="now playing"><i></i><i></i><i></i><i></i></span>`;
	const idxCell = `<td class="idx"><span class="idx-num">${idxLabel}</span>${eq('idx-eq')}</td>`;
	// Track.addedAt (membership-relative added timestamp — track_tag.added_at in
	// the Pinned/Basket views) preferred when present, falling back to createdAt
	// for global views.
	const addedSrc = t.addedAt ?? t.createdAt;
	const addedCell = `<td class="added" title="${escapeHtml(addedSrc ? new Date(addedSrc).toLocaleString() : '')}">${fmtAdded(addedSrc)}</td>`;
	// Tag chips — only resolved when tags render. The resolver is supplied by
	// the caller (main.ts wires tagsStore). We cap visible chips at
	// TL_TAG_LIMIT and roll the rest into a `+N` overflow chip (full list in
	// its title attribute for hover discovery).
	const tagsHtml = (): string => {
		if (!opts.tagsForTrack) return '';
		const all = opts.tagsForTrack(t.id);
		if (all.length === 0) return '';
		const visible = all.slice(0, TL_TAG_LIMIT);
		const overflow = all.length - visible.length;
		const chips = visible
			.map((tag) => `<span class="tl-tag" data-drill="tag" data-v="${escapeHtml(tag.name)}" title="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</span>`)
			.join('');
		return chips + (overflow > 0
			? `<span class="tl-tag tl-tag--more" title="${escapeHtml(all.map((g) => g.name).join(', '))}">+${overflow}</span>`
			: '');
	};
	// Similarity highlight — cells whose value neighbours the currently
	// loaded track (Settings → Track Similarity). Read at row-construction
	// time like getNowPlayingTrackId; main.ts repaints the visible window
	// when the loaded track or the settings change. Levels grade closeness
	// within the configured range (closest third = bare sim-hl, solid);
	// levels 2/3 add a modifier that fades the fill.
	const sim = similarLevelsFor(t);
	const simCls = (d: SimilarityDim): string => {
		const l = sim[d];
		return l ? ` sim-hl${l > 1 ? ` sim-hl--${l}` : ''}` : '';
	};
	// Title shows the remix segment in the user's style (Settings → User
	// Interface); the stored title keeps the release's wording.
	const title = formatTrackTitle(t.title, t.artists, artistCreditFormat().remixStyle);
	// `deletedAt` is non-null only for tracks the user deleted from the
	// library that still surface here because a FOLLOWED playlist (one they
	// don't own) keeps the membership. The chip marks them so the row isn't
	// mistaken for a live library track.
	const titleChips = `${t.deletedAt ? '<span class="tl-deleted" title="Deleted from your library">deleted</span>' : ''}${opts.inLibraryChip && present.has('local') ? '<span class="feed-track__lib-chip feed-track__lib-chip--library tl-lib-chip">In Library</span>' : ''}`;

	let cells: Partial<Record<LayoutColumn, string>>;
	if (lines === 2) {
		const marks = srcs.map((s) => `<i data-src="${s}"></i>`).join('');
		const srcTitle = srcs.length ? `Sources: ${srcs.map((s) => SOURCE_NAMES[s]).join(', ')}` : '';
		const [base, version] = splitTitleVersion(title);
		// Line 2 of the title column never repeats the grouped field.
		const showArtist = fields.has('artist') && groupBy !== 'artist';
		const showAlbum = fields.has('album') && groupBy !== 'album';
		const idLine = [
			showArtist ? artistCreditHtml(t) : '',
			showAlbum && t.albumTitle ? `<span class="t-album">${escapeHtml(t.albumTitle)}</span>` : '',
		].filter((x) => x && x !== '—').join('<span class="t-sep"> — </span>');
		const relHtml = fields.has('rel') ? `<span class="t-rel">${escapeHtml(fmtReleaseLabel(t.releaseDate))}</span>` : '';
		// Label grouping: the header names the label, so the column carries
		// only the release date (on line 1 — an empty first line reads as a
		// rendering gap).
		const labelLine = fields.has('label') && groupBy !== 'label'
			? `<span class="sim-cell${simCls('label')}">${drillSpan('label', t.label)}</span>`
			: '';
		const kfx = (on: boolean, cls: string, html: string, tip?: string): string =>
			`<span class="kfx-c sim-cell${cls}"${tip ? ` title="${tip}"` : ''}>${on ? html : ''}</span>`;
		cells = {
			src: `<td class="src2"><span class="src-marks"${srcTitle ? ` title="${srcTitle}" aria-label="${srcTitle}"` : ''}>${marks}</span></td>`,
			idx: idxCell,
			match: `<td class="match">${t.matchScore != null ? Math.round(t.matchScore * 100) : '—'}</td>`,
			art: `<td class="art"><div class="cover2"><div class="cover2__img" style="background-image: ${coverBg};"></div>${eq('np-cover-meter')}</div></td>`,
			title2: `<td class="title2"><div class="l1"><span class="t-name">${escapeHtml(base)}</span>${version ? ` <span class="t-ver">${escapeHtml(version)}</span>` : ''}${titleChips}</div><div class="l2">${idLine}</div></td>`,
			labelrel: labelLine
				? `<td class="labelrel"><div class="l1">${labelLine}</div><div class="l2">${relHtml}</div></td>`
				: `<td class="labelrel"><div class="l1">${relHtml}</div><div class="l2"></div></td>`,
			genretags: `<td class="genretags"><div class="l1">${fields.has('genre') ? drillSpan('genre', t.genre) : ''}</div><div class="l2 l2--tags">${fields.has('tags') ? tagsHtml() : ''}</div></td>`,
			keyfx: `<td class="keyfx"><div class="kfx">${
				kfx(fields.has('key'), simCls('key'), keyCell)
				+ kfx(fields.has('power'), simCls('power'), fmtFixed(t.power, 2), 'Power')
				+ kfx(fields.has('bpm'), simCls('bpm'), formatBpmInt(t.bpm))
				+ kfx(fields.has('bright'), simCls('brightness'), fmtFixed(t.brightness, 2), 'Brightness')
			}</div></td>`,
			timerating: `<td class="timerating"><div class="l1">${fields.has('time') ? fmtTime(t.duration) : ''}</div><div class="l2">${fields.has('rating') ? ratingCell(t.rating) : ''}</div></td>`,
			added: addedCell,
		};
	} else {
		const pips = srcs.map((s) => `<span class="src-pip" data-src="${s}" title="${SOURCE_NAMES[s]}"></span>`).join('');
		cells = {
			src: `<td class="sources"><span class="src-pips">${pips}</span></td>`,
			idx: idxCell,
			// AI similarity (similar:/sounds: scopes only — main.ts hides the
			// column elsewhere). Cosine x100: 100 = identical embedding.
			match: `<td class="match">${t.matchScore != null ? Math.round(t.matchScore * 100) : '—'}</td>`,
			art: `<td class="art"><div class="cover" style="background-image: ${coverBg};"></div></td>`,
			title: `<td class="title">${escapeHtml(title)}${titleChips}</td>`,
			artist: `<td class="artist">${artistCreditHtml(t)}</td>`,
			album: `<td class="album">${escapeHtml(t.albumTitle ?? '')}</td>`,
			// Release date stored as ISO "2021-03-15" or year-only "2021" (Spotify
			// seeds it at sync, the Beatport enricher overrides with the track-level
			// date) — a recent release reads as its age ("12 days").
			rel: `<td class="rel">${escapeHtml(fmtReleaseLabel(t.releaseDate))}</td>`,
			// Label / genre values are drill links (span, so the hover target is the
			// text, not the whole cell); empty values render bare.
			label: `<td class="label${simCls('label')}">${drillSpan('label', t.label)}</td>`,
			genre: `<td class="genre">${drillSpan('genre', t.genre)}</td>`,
			bpm: `<td class="bpm${simCls('bpm')}">${formatBpmInt(t.bpm)}</td>`,
			key: `<td class="key${simCls('key')}">${keyCell}</td>`,
			time: `<td class="dur">${fmtTime(t.duration)}</td>`,
			rating: `<td class="rating">${ratingCell(t.rating)}</td>`,
			lra: `<td class="lra">${fmtFixed(t.loudnessRangeLu, 1)}</td>`,
			diss: `<td class="diss">${fmtFixed(t.dissonance, 2)}</td>`,
			dens: `<td class="dens">${fmtFixed(t.density, 1)}</td>`,
			// brightness is the curator-aligned 0-3 score (analyzer 2.3.0+), not centroid
			// kHz — format as a plain scalar like the other learned metrics.
			bright: `<td class="bright${simCls('brightness')}">${fmtFixed(t.brightness, 2)}</td>`,
			power: `<td class="power${simCls('power')}">${fmtFixed(t.power, 2)}</td>`,
			punch: `<td class="punch">${fmtFixed(t.dynamicComplexity, 1)}</td>`,
			tags: `<td class="tags">${cols.includes('tags') ? tagsHtml() : ''}</td>`,
			added: addedCell,
			act: `<td class="act"></td>`,
		};
	}

	// Now-playing class — every track-list instance uses the same
	// class so the now-playing.ts DOM sweep can find these rows. Named
	// row-playing to avoid colliding with the player footer's pre-existing
	// .now-playing grid-layout class. `has-cover-meter`: the meter sits on
	// the cover (two-line rows) and the `#` keeps its number.
	const np = isNowPlaying ? ' row-playing' : '';
	const coverMeter = lines === 2 && cols.includes('art') ? ' has-cover-meter' : '';
	// Analyzing class — same render-time + DOM-sweep pattern as now-playing.
	// Read here (O(1) lookup) so a row scrolled into view while its track is
	// being analyzed paints with the blinking local pip; main.ts sweeps the
	// class on/off for rows already painted when the status flips.
	const an = analysisStatus.isRunning(t.id) ? ' row-analyzing' : '';

	const host = document.createElement('tbody');
	// Every row is a drag source — dragging out to the sidebar's playlist
	// drop targets works from any view. Whether the drag ALSO reorders
	// in-list is gated separately in onDragStart (reorderable + data-pos).
	const dragAttr = ' draggable="true"';
	// data-pos exposes the canonical playlist position (when present) so the
	// drop handler can reconstruct newOrder without re-walking the tracks
	// array. Absent for non-playlist views — drag-reorder is disabled there.
	const posAttr = stablePos != null ? ` data-pos="${stablePos}"` : '';
	// Two-line rows carry an empty gutter cell at each end (the 16px row
	// padding), so outer padding holds whichever columns are hidden.
	const pad = lines === 2 ? '<td class="pad"></td>' : '';
	host.innerHTML = `
		<tr class="trk${np}${coverMeter}${an}" data-state="${t.state}" data-id="${t.id}" data-title="${escapeHtml(t.title)}" data-index="${i}"${posAttr}${dragAttr}>
			${pad}${cols.map((c) => cells[c] ?? '<td></td>').join('')}${pad}
		</tr>
	`;
	return host.firstElementChild as HTMLTableRowElement;
}

// ─── Group header rows ──────────────────────────────────────────────────────
// One header per group in the display list: chevron, thumb (artist avatar /
// album cover / label tile), title + sub-lines, and the group's stats (keys,
// BPM span, track count, total time). The same markup renders in the pinned
// overlay that follows the scroll (gap omitted there). Album headers prefer
// the release's own details (AlbumSummary) and fall back to what the member
// rows say until those land.
function groupHeadHtml(g: GroupInfo, collapsed: boolean, album: AlbumSummary | null | undefined): string {
	const st = g.stats;
	let thumb: string;
	let title = g.title;
	let sub = '';
	let sub2 = '';
	let countLabel = `${st.count} ${st.count === 1 ? 'track' : 'tracks'}`;
	if (g.field === 'artist') {
		thumb = `<span class="grp-thumb grp-thumb--artist">${g.missing ? '–' : escapeHtml(initials(g.title))}</span>`;
		const labels = st.labels.slice(0, 2).join(', ') + (st.labels.length > 2 ? ', …' : '');
		if (!g.missing) sub = [`${st.releaseCount} ${st.releaseCount === 1 ? 'release' : 'releases'}`, labels].filter(Boolean).join(' · ');
	} else if (g.field === 'label') {
		thumb = `<span class="grp-thumb grp-thumb--label">${g.missing ? '–' : escapeHtml(initials(g.title).toUpperCase())}</span>`;
		if (!g.missing) sub = `${st.artistNames.length} ${st.artistNames.length === 1 ? 'artist' : 'artists'}`;
	} else {
		const coverId = album?.coverTrackId ?? g.tracks.find((t) => t.coverUrl)?.id ?? g.tracks[0]?.id ?? '';
		thumb = g.missing
			? '<span class="grp-thumb grp-thumb--album grp-thumb--none">–</span>'
			: `<span class="grp-thumb grp-thumb--album" style="background-image: url(curator-cover://${encodeURIComponent(coverId)}), ${coverGradient(g.title.length)};"></span>`;
		if (album) title = album.title;
		if (!g.missing) {
			const artists = album
				? (album.various ? 'Various Artists' : album.artists.map((a) => a.name).join(', '))
				: (st.artistNames.length > 1 ? 'Various Artists' : st.artistNames[0] ?? '');
			const type = album?.albumType === 'single' ? 'Single' : album?.albumType === 'compilation' ? 'Compilation' : '';
			const released = album?.releaseDate ?? g.tracks.find((t) => t.releaseDate)?.releaseDate ?? null;
			sub = [artists, type, released ? fmtReleaseLabel(released) : ''].filter(Boolean).join(' · ');
			const genres = (album?.genres.length ? album.genres : st.genres).slice(0, 2).join(', ');
			sub2 = [album?.label ?? st.labels[0] ?? '', genres].filter(Boolean).join(' · ');
			if (album?.totalTracks && album.totalTracks > st.count) countLabel = `${st.count} of ${album.totalTracks} tracks`;
		}
	}
	const bpm = st.bpmLo == null ? '' : st.bpmLo === st.bpmHi ? `${st.bpmLo} BPM` : `${st.bpmLo}–${st.bpmHi} BPM`;
	const keys = st.keys.map((k) => keyChipHtml(k)).join('');
	return `<button type="button" class="grp-btn grp-btn--${g.field}" data-gkey="${escapeHtml(g.key)}" aria-expanded="${collapsed ? 'false' : 'true'}">`
		+ '<svg class="grp-chev" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
		+ thumb
		+ `<span class="grp-text"><span class="grp-title">${escapeHtml(title)}</span>`
		+ (sub ? `<span class="grp-sub">${escapeHtml(sub)}</span>` : '')
		+ (sub2 ? `<span class="grp-sub2">${escapeHtml(sub2)}</span>` : '')
		+ '</span>'
		+ `<span class="grp-stats"><span class="grp-keys">${keys}</span>${bpm ? `<span>${bpm}</span>` : ''}<span>${countLabel}</span><span class="grp-dur">${fmtTotal(st.durationSec)}</span></span>`
		+ '</button>';
}

function createGroupRow(row: Extract<DisplayRow, { kind: 'group' }>, colSpan: number, lines: RowLines, album: AlbumSummary | null | undefined): HTMLTableRowElement {
	const tr = document.createElement('tr');
	tr.className = `grp-head${row.first ? ' grp-head--first' : ''}${row.collapsed ? ' is-collapsed' : ''}`;
	tr.dataset.gkey = row.group.key;
	// Height inline from the same function the virtualizer's estimateSize
	// reads — the two must agree to the pixel (nothing is measured).
	tr.style.height = `${rowHeight(row, lines)}px`;
	const td = document.createElement('td');
	td.colSpan = colSpan;
	td.className = 'grp-cell';
	td.innerHTML = (row.first ? '' : `<div class="grp-gap" style="height:${GROUP_GAP_H}px"></div>`)
		+ groupHeadHtml(row.group, row.collapsed, album);
	tr.appendChild(td);
	return tr;
}

// ─── Column header definitions ──────────────────────────────────────────────
// thLabel = text shown in the header cell.
// sortKey = the SortColumn value emitted via onSortChange when this header is
//           clicked. Headers without a sortKey are non-sortable (no click,
//           no arrow). 'src' is sortable from a header context-menu instead
//           (the SRC header has no left-click sort).
// colClass = the col element's class — also used for persisted widths.
const COL_DEFS: Record<Column, { th: string; thAlign?: 'left' | 'center' | 'right'; colClass: string; sortKey: SortColumn | null; thClass?: string; title?: string }> = {
	src:    { th: 'Src',    colClass: 'c-sources', sortKey: null, thClass: 'sources-h' },
	idx:    { th: '#',      thAlign: 'right',  colClass: 'c-idx',     sortKey: 'index', thClass: 'idx' },
	match:  { th: 'Match',  thAlign: 'right',  colClass: 'c-match',   sortKey: 'match', title: 'AI audio similarity to the seed track(s) / description (cosine × 100).' },
	art:    { th: '',       colClass: 'c-art',     sortKey: null },
	title:  { th: 'Title',  colClass: 'c-title',   sortKey: 'title' },
	artist: { th: 'Artist', colClass: 'c-artist',  sortKey: 'artist' },
	album:  { th: 'Album',  colClass: 'c-album',   sortKey: 'album' },
	rel:    { th: 'Released', thAlign: 'right', colClass: 'c-rel', sortKey: 'releaseDate' },
	label:  { th: 'Label',  colClass: 'c-label',   sortKey: 'label' },
	genre:  { th: 'Genre',  colClass: 'c-genre',   sortKey: 'genre' },
	bpm:    { th: 'BPM',    thAlign: 'right',  colClass: 'c-bpm',     sortKey: 'bpm' },
	key:    { th: 'Key',    thAlign: 'center', colClass: 'c-key',     sortKey: 'keyCamelot' },
	time:   { th: 'Time',   thAlign: 'right',  colClass: 'c-dur',     sortKey: 'duration' },
	rating: { th: 'Rating', thAlign: 'center', colClass: 'c-rating',  sortKey: 'rating' },
	lra:    { th: 'Dyn range', thAlign: 'right',  colClass: 'c-lra',     sortKey: 'loudnessRangeLu',   title: 'EBU R128 loudness range (LU) — quiet-to-loud spread.' },
	diss:   { th: 'Dissonance',thAlign: 'right',  colClass: 'c-diss',    sortKey: 'dissonance',        title: 'Sensory roughness (0–1) — 0 = consonant, 1 = harsh.' },
	dens:   { th: 'Density',   thAlign: 'right',  colClass: 'c-dens',    sortKey: 'density',           title: 'Spectral peak density — sparse vs. layered production.' },
	bright: { th: 'Brightness', thAlign: 'right', colClass: 'c-bright',  sortKey: 'brightness',        title: 'Learned brightness score — trebley vs. bassy/muffled.' },
	power:  { th: 'Power',     thAlign: 'right',  colClass: 'c-power',   sortKey: 'power',             title: 'Learned energy/density score.' },
	punch:  { th: 'Punch',     thAlign: 'right',  colClass: 'c-punch',   sortKey: 'dynamicComplexity', title: 'Dynamic complexity (dB) — how much loudness varies; high = punchy.' },
	// Tags is a set-valued column — sorting on a set has no natural ordering
	// (alphabetic-first-tag would be misleading), so the header isn't
	// clickable. Filter via the omnibar's `#tag` syntax instead.
	tags:   { th: 'Tags',      colClass: 'c-tags',    sortKey: null },
	added:  { th: 'Added',  thAlign: 'right',  colClass: 'c-added',   sortKey: 'createdAt' },
	act:    { th: '',       colClass: 'c-act',     sortKey: null },
};

// Two-line header cells: every label is its own sort target (clicking
// "Released" under "Label" sorts by release date). Two-line columns get
// their own `c2-` col classes so their persisted widths don't fight the
// one-line ones.
function twoLineColClass(c: LayoutColumn): string {
	return `c2-${c}`;
}

function twoLineHeaderHtml(c: LayoutColumn, fields: ReadonlySet<Column>, groupBy: GroupBy, sortable: boolean): { html: string; cls: string; title?: string } {
	const lab = (text: string, sort: SortColumn | null, tip?: string): string =>
		`<span class="th-l"${sort && sortable ? ` data-sort="${sort}"` : ''}${tip ? ` title="${tip}"` : ''}>${text}</span>`;
	const stack = (l1: string, l2: string): string => `<span class="th2"><span class="th2-l">${l1}</span><span class="th2-l">${l2}</span></span>`;
	switch (c) {
		case 'src': return { html: '', cls: 'sources-h' };
		case 'idx': return { html: lab('#', 'index'), cls: 'idx' };
		case 'match': return { html: lab('Match', 'match'), cls: 'match', title: COL_DEFS.match.title };
		case 'art': return { html: '', cls: 'art' };
		case 'title2': {
			const second = [
				fields.has('artist') && groupBy !== 'artist' ? lab('Artist', 'artist') : '',
				fields.has('album') && groupBy !== 'album' ? lab('Album', 'album') : '',
			].filter(Boolean).join('<span class="th-sep"> — </span>');
			return { html: stack(lab('Title', 'title'), second), cls: 'title2' };
		}
		case 'labelrel': {
			const rel = fields.has('rel') ? lab('Released', 'releaseDate') : '';
			return fields.has('label') && groupBy !== 'label'
				? { html: stack(lab('Label', 'label'), rel), cls: 'labelrel' }
				: { html: stack(rel, ''), cls: 'labelrel' };
		}
		case 'genretags': return { html: stack(fields.has('genre') ? lab('Genre', 'genre') : '', fields.has('tags') ? lab('Tags', null) : ''), cls: 'genretags' };
		case 'keyfx':
			return {
				html: `<span class="kfx kfx--head">${fields.has('key') ? lab('Key', 'keyCamelot') : '<span></span>'}${fields.has('power') ? lab('Pwr', 'power', 'Power') : '<span></span>'}${fields.has('bpm') ? lab('BPM', 'bpm') : '<span></span>'}${fields.has('bright') ? lab('Brt', 'brightness', 'Brightness') : '<span></span>'}</span>`,
				cls: 'keyfx',
			};
		case 'timerating': return { html: stack(fields.has('time') ? lab('Time', 'duration') : '', fields.has('rating') ? lab('Rating', 'rating') : ''), cls: 'timerating' };
		case 'added': return { html: lab('Added', 'createdAt'), cls: 'added' };
		default: return { html: '', cls: '' };
	}
}

// ─── Active-handle registry ─────────────────────────────────────────────────
// The most-recently-focused handle is the only one allowed to have a visible
// selection at a time. When another handle gets focus (via click), the prior
// one's selection clears. Caller can call .blur() / .destroy() manually for
// view transitions where focus doesn't pass through a click.
let activeHandle: TrackListHandle | null = null;
function setActive(h: TrackListHandle | null): void {
	if (activeHandle === h) return;
	if (activeHandle) activeHandle.blur();
	activeHandle = h;
}

// ─── mountTrackList ─────────────────────────────────────────────────────────
// Mounts a fully-formed table into `host`. Caller-side state (currentTracks,
// sort, search query) lives in the handle; mutations flow through the
// callbacks back to the caller. The handle is responsible for cleaning up
// every listener and pool it created in destroy().
export function mountTrackList(
	host: HTMLElement,
	initial: Track[],
	opts: TrackListOptions = {},
): TrackListHandle {
	const cols: LayoutColumn[] = opts.columns ?? ALL_COLUMNS;
	const lines: RowLines = opts.rowLines ?? 1;
	const fields: ReadonlySet<Column> = opts.fields ?? ALL_FIELDS;
	const groupBy: GroupBy = opts.groupBy ?? 'none';
	const collapsed: Set<string> = opts.collapsedGroups ?? new Set();
	const rowH = TRACK_ROW_H[lines];
	const showHeader = opts.showHeader ?? false;
	const virtualize = opts.virtualize ?? false;
	// Two-line rows carry an empty gutter cell at each end (see createTrackRow).
	const padded = lines === 2;
	const colSpan = cols.length + (padded ? 2 : 0);
	const colClassOf = (c: LayoutColumn): string => (lines === 2 ? twoLineColClass(c) : COL_DEFS[c as Column].colClass);

	// Build the table shell. The host gets its children replaced — caller is
	// responsible for handing us an empty container (or one whose contents
	// can be safely discarded).
	const padCol = (side: 'l' | 'r'): string => (padded ? `<col class="c2-pad${side}" />` : '');
	const padTh = padded ? '<th class="pad"></th>' : '';
	const colHtml = padCol('l') + cols.map((c) => `<col class="${colClassOf(c)}" />`).join('') + padCol('r');
	const headerHtml = showHeader
		? `<thead><tr>${padTh}${cols.map((c) => {
				if (lines === 2) {
					const h = twoLineHeaderHtml(c, fields, groupBy, !!opts.onSortChange);
					return `<th class="${h.cls}"${h.title ? ` title="${h.title}"` : ''}>${h.html}</th>`;
				}
				const def = COL_DEFS[c as Column];
				const cls = def.thClass ? ` class="${def.thClass}"` : '';
				const style = def.thAlign ? ` style="text-align:${def.thAlign};"` : '';
				const dataSort = def.sortKey && opts.onSortChange ? ` data-sort="${def.sortKey}"` : '';
				const title = def.title ? ` title="${def.title}"` : '';
				return `<th${cls}${dataSort}${style}${title}>${def.th}</th>`;
			}).join('')}${padTh}</tr></thead>`
		: '';
	const root = document.createElement('div');
	root.className = 'tracklist';
	// When virtualized (the main list), the `table--embedded`
	// modifier is omitted so the table inherits the full `.table` CSS.
	const tableClass = `${opts.virtualize ? 'table' : 'table table--embedded'}${lines === 2 ? ' rows-2' : ''}`;
	// The pinned group header — a zero-height sticky strip under the column
	// header whose child overlays the top rows with the header of the group
	// the viewport is inside (a sticky <tr> can't work: the group's own
	// header row unmounts while its tracks are still in view).
	root.innerHTML = `
		${opts.toolbar ? '<div class="tracklist__toolbar"></div>' : ''}
		${groupBy !== 'none' ? '<div class="grp-pin" hidden><div class="grp-pin__inner"></div></div>' : ''}
		<table class="${tableClass}">
			<colgroup>${colHtml}</colgroup>
			${headerHtml}
			<tbody></tbody>
		</table>
	`;
	if (opts.toolbar) root.querySelector('.tracklist__toolbar')!.appendChild(opts.toolbar);
	host.replaceChildren(root);
	const tbody = root.querySelector('tbody') as HTMLTableSectionElement;
	const colEls = Array.from(root.querySelectorAll<HTMLTableColElement>('colgroup > col')).filter((c) => !/\bc2-pad[lr]\b/.test(c.className));
	const thead = root.querySelector('thead');
	const thEls = thead ? Array.from(thead.querySelectorAll<HTMLTableCellElement>('th')).filter((th) => !th.classList.contains('pad')) : [];
	const pinEl = root.querySelector<HTMLElement>('.grp-pin');
	const pinInner = root.querySelector<HTMLElement>('.grp-pin__inner');
	// Row height lives in CSS too (`tr { height: var(--row-h) }`) — set it
	// from the same number the virtualizer uses.
	const table = root.querySelector<HTMLTableElement>('table')!;
	table.style.setProperty('--row-h', `${rowH}px`);
	const theadH = thead ? thead.getBoundingClientRect().height : 0;
	root.style.setProperty('--thead-h', `${theadH}px`);
	const pinH = groupBy === 'none' ? 0 : groupHeadInnerHeight(groupBy);
	if (pinEl) pinEl.style.setProperty('--pin-h', `${pinH}px`);

	// Apply initial column widths AFTER the table exists. Stored class-keyed
	// so re-mounting picks up persisted widths cleanly.
	if (opts.initialColumnWidths) {
		for (const col of colEls) {
			const cls = Array.from(col.classList).find((c) => c.startsWith('c-') || c.startsWith('c2-'));
			if (cls && opts.initialColumnWidths[cls] != null) col.style.width = `${opts.initialColumnWidths[cls]}px`;
		}
	}

	// Keep the table at least as wide as its columns. `table-layout: fixed`
	// + `width: 100%` gives the auto-width title column whatever is left
	// after the explicit <col> widths — and NOTHING when they already exceed
	// the viewport (title silently collapses to 0px and the user just sees
	// "Album" after the cover). The stylesheet's static min-width was sized
	// for an older, shorter column set; with the analyzer/tags/added columns
	// and user-resized widths (the rightmost column included) the sum
	// routinely passes it. So derive the floor from the live column widths
	// plus a title floor, and refresh it whenever a width changes. A stored
	// explicit title width counts as-is (no auto column left to protect).
	// The two-line layout's title floor is lower — it is designed to fit a
	// ~1040px pane without sideways scroll.
	const TITLE_MIN_W = lines === 2 ? 220 : 280;
	const allColEls = Array.from(root.querySelectorAll<HTMLTableColElement>('colgroup > col'));
	const syncTableMinWidth = (): void => {
		let sum = 0;
		for (const col of allColEls) {
			if (col.classList.contains('c-title') || col.classList.contains('c2-title2')) {
				sum += col.style.width ? (parseFloat(col.style.width) || TITLE_MIN_W) : TITLE_MIN_W;
			} else {
				sum += col.style.width ? (parseFloat(col.style.width) || 0) : col.offsetWidth;
			}
		}
		table.style.minWidth = `${Math.ceil(sum)}px`;
	};
	syncTableMinWidth();

	// allTracks = what the caller handed to update(); tracks = what's on
	// screen in display order (the same array when ungrouped); display =
	// the grouped row model (null ⇔ ungrouped — the virtualizer then indexes
	// `tracks` directly, no per-row objects).
	let allTracks: Track[] = [];
	let tracks: Track[] = [];
	let display: DisplayList | null = null;
	let sort = opts.sort;
	let reorderable = opts.reorderable ?? false;
	// Rendered rows keyed by track id, or `g:<group key>` for headers.
	const renderedRows = new Map<string, HTMLTableRowElement>();
	const selected = new Set<string>();
	let anchor: string | null = null;
	let topSpacer: HTMLTableRowElement | null = null;
	let bottomSpacer: HTMLTableRowElement | null = null;

	const rowCount = (): number => (display ? display.rows.length : tracks.length);
	const rowAt = (i: number): DisplayRow | null => {
		if (display) return display.rows[i] ?? null;
		const t = tracks[i];
		return t ? { kind: 'track', track: t, trackIndex: i } : null;
	};
	const rowKey = (r: DisplayRow): string => (r.kind === 'track' ? r.track.id : `g:${r.group.key}`);
	const rowOfTrack = (trackIndex: number): number => (display ? display.trackRow[trackIndex] ?? -1 : trackIndex);
	const heightAt = (i: number): number => {
		if (!display) return rowH;
		const r = display.rows[i];
		return r ? rowHeight(r, lines) : rowH;
	};
	// Start offset of a row (header gaps included) — for keeping a toggled
	// group header in place.
	const rowStart = (i: number): number => {
		let y = 0;
		for (let k = 0; k < i; k++) y += heightAt(k);
		return y;
	};
	const albumOf = (g: GroupInfo): AlbumSummary | null | undefined => (g.albumId ? opts.albumInfo?.(g.albumId) : undefined);

	// The element that scrolls. When virtualizing, this is the immediate parent
	// of root (the .table-wrap host) — that's where overflow:auto is wired in
	// the existing CSS. TanStack reads its rect + scrollOffset to drive the
	// window; the spacer rows below preserve the table's full scroll height.
	const scrollHost: HTMLElement = virtualize ? host : root;

	// ─── Virtualizer (TanStack virtual-core) ────────────────────────────────
	// Row heights come from the display model (track rows by layout, group
	// headers by field, + the gap above every group after the first); no
	// measurement — estimateSize IS the layout, matching the CSS heights. We
	// keep the semantic <table> by translating TanStack's virtual items into
	// the long-standing top/bottom spacer-<tr> strategy (absolute-positioned
	// <tr>s break table layout): topSpacer height = first.start, bottomSpacer
	// = totalSize - last.end. onChange repaints the window. Only constructed
	// in the virtualized path; embedded small lists render all rows once.
	// Scroll padding keeps scroll-into-view targets clear of the pinned group
	// header (start) and the sticky column header (end — item offsets don't
	// include the thead, so the visible bottom is one header short).
	let virtualizer: Virtualizer<HTMLElement, HTMLTableRowElement> | null = null;
	let virtualizerCleanup: (() => void) | null = null;
	if (virtualize) {
		virtualizer = new Virtualizer<HTMLElement, HTMLTableRowElement>({
			count: 0,
			getScrollElement: () => scrollHost,
			estimateSize: heightAt,
			overscan: VIRT_BUFFER,
			scrollPaddingStart: pinH,
			scrollPaddingEnd: theadH,
			observeElementRect,
			observeElementOffset,
			scrollToFn: elementScroll,
			onChange: () => renderWindow(),
		});
		// _didMount wires the scroll/resize observers and returns their
		// teardown; destroy() calls it.
		virtualizerCleanup = virtualizer._didMount();
	}

	function makeSpacer(): HTMLTableRowElement {
		const tr = document.createElement('tr');
		tr.className = 'virt-spacer';
		tr.setAttribute('aria-hidden', 'true');
		const td = document.createElement('td');
		td.colSpan = colSpan;
		td.style.padding = '0';
		td.style.border = '0';
		td.style.height = '0';
		tr.appendChild(td);
		return tr;
	}

	function buildRow(r: DisplayRow): HTMLTableRowElement {
		if (r.kind === 'group') return createGroupRow(r, colSpan, lines, albumOf(r.group));
		const tr = createTrackRow(r.track, { index: r.trackIndex, columns: cols, lines, fields, groupBy, tagsForTrack: opts.tagsForTrack, inLibraryChip: opts.inLibraryChip?.() });
		if (selected.has(r.track.id)) tr.classList.add('selected');
		return tr;
	}

	// Non-virtualized path — render all rows once into tbody.
	function renderAll(): void {
		tbody.replaceChildren();
		renderedRows.clear();
		for (let i = 0; i < rowCount(); i++) {
			const r = rowAt(i)!;
			const tr = buildRow(r);
			tbody.appendChild(tr);
			renderedRows.set(rowKey(r), tr);
		}
	}

	// Virtualized path — read the current window from the virtualizer and
	// reconcile the DOM (reuse rows, build new ones, drop out-of-window).
	function renderWindow(): void {
		if (!virtualizer) return;
		if (!topSpacer || topSpacer.parentElement !== tbody) {
			topSpacer = makeSpacer();
			tbody.appendChild(topSpacer);
		}
		if (!bottomSpacer || bottomSpacer.parentElement !== tbody) {
			bottomSpacer = makeSpacer();
			tbody.appendChild(bottomSpacer);
		}

		if (rowCount() === 0) {
			for (const el of renderedRows.values()) el.remove();
			renderedRows.clear();
			(topSpacer.firstElementChild as HTMLElement).style.height = '0';
			(bottomSpacer.firstElementChild as HTMLElement).style.height = '0';
			updatePin();
			return;
		}

		// Flush pending option/measurement changes into the live range — the
		// framework adapters call this before every getVirtualItems() read;
		// without it the range stays null and the window is empty.
		virtualizer._willUpdate();
		const items = virtualizer.getVirtualItems();
		const totalSize = virtualizer.getTotalSize();
		const startOffset = items.length > 0 ? items[0]!.start : 0;
		const endOffset = items.length > 0 ? items[items.length - 1]!.end : 0;

		(topSpacer.firstElementChild as HTMLElement).style.height = `${startOffset}px`;
		(bottomSpacer.firstElementChild as HTMLElement).style.height = `${Math.max(0, totalSize - endOffset)}px`;

		// Phase 1 — drop rows that scrolled out of the new window.
		const windowRows: DisplayRow[] = [];
		const needed = new Set<string>();
		for (const vi of items) {
			const r = rowAt(vi.index);
			if (!r) continue;
			windowRows.push(r);
			needed.add(rowKey(r));
		}
		for (const [key, el] of renderedRows) {
			if (!needed.has(key)) {
				el.remove();
				renderedRows.delete(key);
			}
		}

		// Phase 2 — walk the target window in order. Reuse existing rows where
		// possible; build only the new ones. Move out-of-order rows with
		// .after() — only happens on jump-scrolls big enough to shuffle the
		// window past the overscan.
		let prev: HTMLTableRowElement = topSpacer;
		for (const r of windowRows) {
			const key = rowKey(r);
			const existing = renderedRows.get(key);
			if (existing) {
				if (prev.nextSibling !== existing) prev.after(existing);
				prev = existing;
			} else {
				const tr = buildRow(r);
				prev.after(tr);
				renderedRows.set(key, tr);
				prev = tr;
			}
		}
		updatePin();
	}

	// ─── Pinned group header ────────────────────────────────────────────────
	// Shows the group the top of the viewport is inside. Item offsets start
	// below the sticky column header, so the row AT scrollTop is the first
	// one visible under it. In a header row's gap the previous group is still
	// the one on screen; past the gap, the header itself is (partly) under
	// the pin, which then shows that same header — it reads as sticking.
	let pinnedKey: string | null = null;
	let pinTop = theadH;
	let viewW = 0;
	function updatePin(): void {
		if (!pinEl || !pinInner) return;
		// Visible width for the sideways-scrolling one-line table's headers
		// (see .grp-btn / .grp-pin in style.css). renderWindow runs on every
		// resize via the virtualizer, so this stays current.
		const w = scrollHost.clientWidth;
		if (w > 0 && w !== viewW) { viewW = w; root.style.setProperty('--view-w', `${w}px`); }
		let g: GroupInfo | null = null;
		let isCollapsed = false;
		if (display && virtualizer && display.rows.length > 0) {
			const top = scrollHost.scrollTop;
			const item = top > 0 ? virtualizer.getVirtualItemForOffset(top) : undefined;
			const r = item ? display.rows[item.index] : undefined;
			if (r?.kind === 'track') {
				const key = display.groupOfTrack.get(r.track.id);
				const gr = key != null ? display.rows[display.groupRow.get(key) ?? -1] : undefined;
				if (gr?.kind === 'group') { g = gr.group; isCollapsed = gr.collapsed; }
			} else if (r?.kind === 'group' && item) {
				const gap = r.first ? 0 : GROUP_GAP_H;
				if (top >= item.start + gap) {
					g = r.group;
					isCollapsed = r.collapsed;
				} else {
					// In the gap: the group above is still the one on screen.
					const idx = display.groups.findIndex((x) => x.key === r.group.key);
					const above = idx > 0 ? display.groups[idx - 1]! : null;
					if (above) {
						g = above;
						isCollapsed = collapsed.has(above.key);
					}
				}
			}
		}
		if (!g) {
			if (!pinEl.hidden) pinEl.hidden = true;
			pinnedKey = null;
			return;
		}
		// The column header's height can only be measured once the list is
		// on screen (a list mounted into a hidden region reads 0).
		const th = thead?.offsetHeight ?? 0;
		if (th > 0 && th !== pinTop) { pinTop = th; root.style.setProperty('--thead-h', `${th}px`); }
		const sig = `${g.key}|${isCollapsed ? 1 : 0}`;
		if (pinnedKey !== sig) {
			pinInner.innerHTML = groupHeadHtml(g, isCollapsed, albumOf(g));
			pinnedKey = sig;
		}
		if (pinEl.hidden) pinEl.hidden = false;
	}
	const onPinClick = (evt: MouseEvent): void => {
		const btn = (evt.target as HTMLElement).closest<HTMLElement>('.grp-btn');
		if (!btn?.dataset.gkey) return;
		evt.preventDefault();
		toggleGroup(btn.dataset.gkey, evt.altKey);
	};
	const onPinMouseDown = (evt: MouseEvent): void => { evt.preventDefault(); };
	pinEl?.addEventListener('click', onPinClick);
	pinEl?.addEventListener('mousedown', onPinMouseDown);

	// Rebuild the display model from allTracks (grouping + collapse) and
	// re-sync `tracks`. Returns true when `tracks` lost ids (caller prunes
	// selection).
	function rebuildDisplay(): void {
		if (groupBy === 'none') {
			display = null;
			tracks = allTracks;
			return;
		}
		display = buildDisplayList(allTracks, groupBy, collapsed);
		tracks = display.visibleTracks;
		if (groupBy === 'album' && opts.onNeedAlbums) {
			const ids = display.groups.map((g) => g.albumId).filter((x): x is string => !!x);
			if (ids.length) opts.onNeedAlbums(ids);
		}
	}

	// Push the current row count into the virtualizer + repaint. Called
	// whenever the dataset or the display model changes.
	function syncVirtualizerCount(): void {
		if (!virtualizer) return;
		virtualizer.setOptions({ ...virtualizer.options, count: rowCount() });
		virtualizer.measure();
		renderWindow();
	}

	// Full re-layout after a model change: every cached <tr> may be at the
	// wrong position, so wipe and let the window rebuild.
	function relayout(): void {
		if (virtualize) {
			tbody.replaceChildren();
			renderedRows.clear();
			topSpacer = null;
			bottomSpacer = null;
			pinnedKey = null;
			syncVirtualizerCount();
		} else {
			renderAll();
		}
	}

	// Prune selection to ids still on screen so a bulk action can't hit a row
	// the user can't see (a collapsed group, a filtered-out track).
	function pruneSelection(): boolean {
		const visible = new Set(tracks.map((t) => t.id));
		let changed = false;
		for (const id of [...selected]) {
			if (!visible.has(id)) { selected.delete(id); changed = true; }
		}
		if (anchor && !visible.has(anchor)) { anchor = null; changed = true; }
		return changed;
	}

	// Collapse / expand. The toggled group's header stays where it was on
	// screen (rows above it don't change; when it was pinned — scrolled past
	// — the view lands on the header instead).
	function toggleGroup(key: string, all = false): void {
		if (!display) return;
		const headRow = display.groupRow.get(key);
		if (headRow == null) return;
		const startBefore = rowStart(headRow);
		const top = scrollHost.scrollTop;
		const wasCollapsed = collapsed.has(key);
		if (all) {
			if (wasCollapsed) collapsed.clear();
			else for (const g of display.groups) collapsed.add(g.key);
		} else if (wasCollapsed) {
			collapsed.delete(key);
		} else {
			collapsed.add(key);
		}
		applyCollapse(key, startBefore, top);
	}

	function applyCollapse(anchorKey: string | null, startBefore: number, top: number): void {
		rebuildDisplay();
		const selectionChanged = pruneSelection();
		relayout();
		if (virtualize && anchorKey && display) {
			const headRow = display.groupRow.get(anchorKey);
			if (headRow != null) {
				const startAfter = rowStart(headRow);
				// Header was under the pin (scrolled past) → bring it to the top;
				// otherwise keep its on-screen position.
				const target = top > startBefore ? startAfter : top + (startAfter - startBefore);
				handle.setScrollTop(Math.max(0, target));
			}
		}
		if (selectionChanged) notifySelection();
	}

	// Group of the first visible row (for bulk collapse/expand anchoring).
	function topGroupKey(): string | null {
		if (!display || !virtualizer) return null;
		const item = virtualizer.getVirtualItemForOffset(scrollHost.scrollTop);
		const r = item ? display.rows[item.index] : display.rows[0];
		if (!r) return null;
		return r.kind === 'group' ? r.group.key : display.groupOfTrack.get(r.track.id) ?? null;
	}

	function bulkCollapse(collapse: boolean): void {
		if (!display) return;
		const key = topGroupKey();
		const headRow = key != null ? display.groupRow.get(key) : undefined;
		const startBefore = headRow != null ? rowStart(headRow) : 0;
		const top = scrollHost.scrollTop;
		if (collapse) for (const g of display.groups) collapsed.add(g.key);
		else collapsed.clear();
		// Bulk actions always land on the group that was at the top.
		applyCollapse(key, startBefore, Math.max(top, startBefore + 1));
	}

	function refreshGroupHeaders(): void {
		if (!display) return;
		for (const [key, el] of renderedRows) {
			if (!key.startsWith('g:')) continue;
			const row = display.rows[display.groupRow.get(key.slice(2)) ?? -1];
			if (row?.kind !== 'group') continue;
			const fresh = createGroupRow(row, colSpan, lines, albumOf(row.group));
			el.replaceWith(fresh);
			renderedRows.set(key, fresh);
		}
		pinnedKey = null;
		updatePin();
	}

	function applySelectionToDom(): void {
		for (const [id, tr] of renderedRows) {
			tr.classList.toggle('selected', selected.has(id));
		}
	}

	function notifySelection(): void {
		opts.onSelectionChange?.([...selected], anchor);
	}

	function selectRow(id: string, evt: MouseEvent): void {
		setActive(handle);
		const isToggle = evt.ctrlKey || evt.metaKey;
		const isRange = evt.shiftKey;
		if (isRange && anchor) {
			const ids = tracks.map((t) => t.id);
			const a = ids.indexOf(anchor);
			const b = ids.indexOf(id);
			if (a >= 0 && b >= 0) {
				selected.clear();
				const [lo, hi] = a <= b ? [a, b] : [b, a];
				for (let k = lo; k <= hi; k++) selected.add(ids[k]!);
			}
		} else if (isToggle) {
			if (selected.has(id)) selected.delete(id);
			else selected.add(id);
			anchor = id;
		} else {
			selected.clear();
			selected.add(id);
			anchor = id;
		}
		applySelectionToDom();
		notifySelection();
	}

	// Scroll + resize are observed by the virtualizer (observeElementOffset /
	// observeElementRect installed by _didMount); its onChange drives
	// renderWindow. No manual scroll listener needed.

	// ─── Row event delegation ───────────────────────────────────────────────
	// Plain mousedown on a row that's already part of a multi-selection
	// must NOT collapse the selection right away — that would kill drag-
	// reorder, which needs the full set still selected when dragstart fires.
	// Defer the collapse until mouseup; cancel it if dragstart wins the race.
	let pendingCollapseId: string | null = null;
	const collapseIfPending = (): void => {
		if (!pendingCollapseId) return;
		const id = pendingCollapseId;
		pendingCollapseId = null;
		selected.clear();
		selected.add(id);
		anchor = id;
		applySelectionToDom();
		notifySelection();
	};
	const onMouseDown = (evt: MouseEvent): void => {
		if (evt.button !== 0) return;
		// Group header buttons never take focus: Space would then both toggle
		// playback (global command) and activate the focused button.
		if ((evt.target as HTMLElement).closest('.grp-btn')) { evt.preventDefault(); return; }
		const row = (evt.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
		if (!row) return;
		const id = row.dataset.id;
		if (!id) return;
		const isMod = evt.ctrlKey || evt.metaKey || evt.shiftKey;
		// Already-selected row in a multi-select, plain click: defer.
		if (!isMod && selected.has(id) && selected.size > 1) {
			setActive(handle);
			pendingCollapseId = id;
			// One-shot mouseup listener — fires if drag didn't start; if it
			// did, onDragStart nulls pendingCollapseId first so collapse
			// becomes a no-op.
			document.addEventListener('mouseup', collapseIfPending, { once: true, capture: true });
			return;
		}
		pendingCollapseId = null;
		selectRow(id, evt);
	};
	const onDblClick = (evt: MouseEvent): void => {
		const row = (evt.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
		if (!row) return;
		const id = row.dataset.id;
		if (!id) return;
		const t = tracks.find((x) => x.id === id);
		if (t) opts.onPlay?.(t, tracks);
	};
	const onContextMenu = (evt: MouseEvent): void => {
		const row = (evt.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
		if (!row) return;
		evt.preventDefault();
		const id = row.dataset.id;
		if (!id) return;
		setActive(handle);
		// Right-click outside the current selection collapses to that row.
		if (!selected.has(id)) {
			selected.clear();
			selected.add(id);
			anchor = id;
			applySelectionToDom();
			notifySelection();
		}
		const t = tracks.find((x) => x.id === id);
		if (t) opts.onContextMenu?.(evt, t, tracks, [...selected]);
	};
	// Artist chip / label / genre / tag chip → scope. `click`, not mousedown —
	// selection has already run for the row, so the link only adds navigation
	// on top. Modifier clicks are selection gestures and fall through untouched.
	const onClick = (evt: MouseEvent): void => {
		if (evt.button !== 0) return;
		// Group header → collapse / expand (Alt = every group).
		const head = (evt.target as HTMLElement).closest<HTMLElement>('.grp-btn');
		if (head?.dataset.gkey) {
			evt.preventDefault();
			toggleGroup(head.dataset.gkey, evt.altKey);
			return;
		}
		if (evt.ctrlKey || evt.metaKey || evt.shiftKey) return;
		const target = evt.target as HTMLElement;
		const artist = opts.onArtistClick ? target.closest<HTMLElement>('.tl-artist[data-aid]') : null;
		const drill = !artist && opts.onDrillClick ? target.closest<HTMLElement>('[data-drill][data-v]') : null;
		const link = artist ?? drill;
		if (!link) return;
		const row = link.closest<HTMLTableRowElement>('tr[data-id]');
		const t = row ? tracks.find((x) => x.id === row.dataset.id) : undefined;
		if (!t) return;
		evt.preventDefault();
		if (artist) opts.onArtistClick!(artist.dataset.aid!, artist.textContent ?? '', t);
		else opts.onDrillClick!(drill!.dataset.drill as 'label' | 'genre' | 'tag', drill!.dataset.v!, t);
	};
	tbody.addEventListener('mousedown', onMouseDown);
	tbody.addEventListener('dblclick', onDblClick);
	tbody.addEventListener('contextmenu', onContextMenu);
	tbody.addEventListener('click', onClick);

	// ─── Drag-reorder ───────────────────────────────────────────────────────
	// HTML5 drag-and-drop on rows. Active only when `reorderable=true` AND
	// the source row carries a playlistPosition (data-pos). We move a
	// contiguous-in-id-order block of selected rows; the user's selection
	// order is normalized to current-list order so multi-track drops always
	// preserve the visible top-to-bottom sequence of the dragged set.
	//
	// Drop indicator is a CSS class painted on the row the cursor is over,
	// flipped based on the cursor's Y position relative to the row's middle
	// (top half → drop above, bottom half → drop below). We avoid hand-
	// computing pixel positions for the inserted block — instead we splice
	// the new order in JS and let the caller re-render after the IPC lands.
	let dragSrcIds: string[] | null = null;        // id-order in the current `tracks`
	let dropTargetId: string | null = null;
	let dropPosition: 'above' | 'below' = 'above';
	let lastDropRow: HTMLTableRowElement | null = null;

	function clearDropMarkers(): void {
		if (lastDropRow) {
			lastDropRow.classList.remove('drop-above', 'drop-below');
			lastDropRow = null;
		}
	}

	const onDragStart = (evt: DragEvent): void => {
		const row = (evt.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
		if (!row) return;
		// Drag won the race against the deferred mouseup-collapse — keep
		// the existing multi-selection intact.
		pendingCollapseId = null;
		const id = row.dataset.id!;
		// If the dragged row is outside the current selection, collapse to
		// it. Otherwise drag whatever's selected — preserving the user's
		// expectation that multi-select followed by drag moves the group.
		if (!selected.has(id)) {
			selected.clear();
			selected.add(id);
			anchor = id;
			applySelectionToDom();
			notifySelection();
		}
		// Normalize selection to current list order so the dropped block
		// reads top-to-bottom regardless of click sequence.
		const orderedIds = tracks.filter((t) => selected.has(t.id)).map((t) => t.id);
		// In-list reorder only participates in a reorderable playlist context;
		// the wire payload below rides along on EVERY drag so external targets
		// (the sidebar's playlist rows) can accept a drop from any view.
		const canReorder = reorderable && !!row.dataset.pos;
		dragSrcIds = canReorder ? orderedIds : null;
		if (evt.dataTransfer) {
			// copyMove keeps both gestures legal from a playlist view: 'move'
			// for the in-list reorder drop, 'copy' for the add-to-playlist
			// drop on the sidebar.
			evt.dataTransfer.effectAllowed = canReorder ? 'copyMove' : 'copy';
			setTrackDragPayload(evt.dataTransfer, orderedIds);
			// A text/plain entry is required on Firefox to actually start a
			// drag; the value doesn't matter — the reorder path reads from
			// the closure (dragSrcIds), external targets read the custom
			// MIME payload.
			try { evt.dataTransfer.setData('text/plain', id); } catch { /* */ }
			// Multi-drag: the default ghost is just the grabbed row, which
			// reads as "dragging one" — swap in a count badge. The engine
			// snapshots the drag image synchronously after the handler
			// returns, so removing it on the next task is safe.
			if (orderedIds.length > 1) {
				const ghost = document.createElement('div');
				ghost.className = 'track-drag-ghost';
				ghost.textContent = `${orderedIds.length} tracks`;
				document.body.appendChild(ghost);
				try { evt.dataTransfer.setDragImage(ghost, 14, 14); } catch { /* */ }
				setTimeout(() => ghost.remove(), 0);
			}
		}
		if (canReorder) row.classList.add('dragging');
	};

	const onDragOver = (evt: DragEvent): void => {
		if (!dragSrcIds) return;
		const row = (evt.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
		if (!row) return;
		evt.preventDefault();   // required to allow drop
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
		// Decide above-or-below based on cursor Y relative to row centre.
		const rect = row.getBoundingClientRect();
		const pos: 'above' | 'below' = evt.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
		if (dropTargetId !== row.dataset.id || dropPosition !== pos) {
			clearDropMarkers();
			dropTargetId = row.dataset.id ?? null;
			dropPosition = pos;
			row.classList.add(pos === 'above' ? 'drop-above' : 'drop-below');
			lastDropRow = row;
		}
	};

	const onDragLeave = (evt: DragEvent): void => {
		// Only fully clear the marker when the cursor leaves the tbody
		// entirely — per-row dragleave fires while moving between rows and
		// would cause flicker. relatedTarget being outside tbody is the
		// "really left" signal.
		const related = evt.relatedTarget as Node | null;
		if (related && tbody.contains(related)) return;
		clearDropMarkers();
		dropTargetId = null;
	};

	const onDrop = (evt: DragEvent): void => {
		if (!dragSrcIds || dragSrcIds.length === 0) { clearDropMarkers(); return; }
		const row = (evt.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
		if (!row) { clearDropMarkers(); return; }
		evt.preventDefault();
		const targetId = row.dataset.id!;
		const pos = dropPosition;
		clearDropMarkers();

		// Compute the new full ordering. Skip when caller hasn't asked for
		// reorder events, or when any participating row lacks a playlist
		// position (would produce an unsortable mixed list).
		if (!opts.onReorder) { dragSrcIds = null; return; }
		const draggingSet = new Set(dragSrcIds);
		const movedTracks = dragSrcIds.map((id) => tracks.find((t) => t.id === id)!).filter(Boolean);
		const remaining = tracks.filter((t) => !draggingSet.has(t.id));
		// Find target's index in `remaining` (not in `tracks` — we want the
		// position AFTER the dragged set is plucked out).
		const targetIdxInRem = remaining.findIndex((t) => t.id === targetId);
		// If the user dropped on a row that was itself dragged, the target
		// disappears from `remaining`; treat that as a no-op.
		if (targetIdxInRem < 0) { dragSrcIds = null; return; }
		const insertAt = pos === 'above' ? targetIdxInRem : targetIdxInRem + 1;
		const reordered = [...remaining.slice(0, insertAt), ...movedTracks, ...remaining.slice(insertAt)];

		// Map to the wire format — playlistPosition of each row in the new
		// order. If any row is missing a position the reorder isn't valid
		// (we shouldn't have been draggable in the first place), bail.
		const newOrder: number[] = [];
		for (const t of reordered) {
			if (t.playlistPosition == null) { dragSrcIds = null; return; }
			newOrder.push(t.playlistPosition);
		}
		// No-op check — if the order didn't actually change, don't round-trip.
		let changed = false;
		for (let i = 0; i < tracks.length; i++) {
			if (tracks[i]!.id !== reordered[i]!.id) { changed = true; break; }
		}
		if (changed) opts.onReorder(newOrder);
		dragSrcIds = null;
	};

	const onDragEnd = (): void => {
		clearDropMarkers();
		dragSrcIds = null;
		// Clear .dragging from any leftover rows (the DOM ref might have
		// scrolled out of the virt window between dragstart and dragend).
		for (const tr of renderedRows.values()) tr.classList.remove('dragging');
	};

	tbody.addEventListener('dragstart', onDragStart);
	tbody.addEventListener('dragover', onDragOver);
	tbody.addEventListener('dragleave', onDragLeave);
	tbody.addEventListener('drop', onDrop);
	tbody.addEventListener('dragend', onDragEnd);

	// ─── Header wiring (sort + right-click menus + column resize) ───────────
	// Right-click routing: SRC column → onSrcHeaderContextMenu (existing
	// behaviour, filter menu). Every other th → onHeaderContextMenu, which
	// the caller wires to the show/hide-columns picker. preventDefault is
	// done here so the caller doesn't have to remember it.
	const colByTh = new Map<HTMLTableCellElement, LayoutColumn>();
	thEls.forEach((th, i) => { if (cols[i]) colByTh.set(th, cols[i]!); });

	const onHeaderCtx = (evt: MouseEvent): void => {
		const th = (evt.target as HTMLElement).closest<HTMLTableCellElement>('th');
		if (!th) return;
		const col = colByTh.get(th);
		if (!col) return;
		if (col === 'src') {
			if (!opts.onSrcHeaderContextMenu) return;
			evt.preventDefault();
			opts.onSrcHeaderContextMenu(evt);
		} else {
			if (!opts.onHeaderContextMenu) return;
			evt.preventDefault();
			opts.onHeaderContextMenu(evt, col);
		}
	};
	const onHeaderClick = (evt: MouseEvent): void => {
		// A th (one-line) or a label inside one (two-line) carries data-sort.
		const th = (evt.target as HTMLElement).closest<HTMLElement>('[data-sort]');
		if (!th || !opts.onSortChange) return;
		const col = th.dataset.sort as SortColumn;
		const next: { column: SortColumn; dir: SortDir } = sort?.column === col
			? { column: col, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
			: { column: col, dir: 'asc' };
		opts.onSortChange(next);
	};
	if (showHeader) {
		if (opts.onSrcHeaderContextMenu || opts.onHeaderContextMenu) {
			thead?.addEventListener('contextmenu', onHeaderCtx);
		}
		if (opts.onSortChange) thead?.addEventListener('click', onHeaderClick);
	}

	// Column resize. Handles attach to the right edge of every th (the last
	// one too: with table-layout fixed + the auto-width title column, the
	// rightmost column's explicit width is honoured and title absorbs the
	// difference) and persist via the caller's onColumnResize callback. The
	// handle stays scoped to this instance — multiple lists don't share handles.
	const resizeCleanups: Array<() => void> = [];
	// Eats the single `click` a resize's mouseup synthesizes on the <th>, so it
	// never reaches the thead sort handler. Shared across all handles — only
	// ever armed (once) for the duration between a resize mouseup and its click.
	const swallowClick = (ce: MouseEvent): void => { ce.preventDefault(); ce.stopImmediatePropagation(); };
	if (showHeader && opts.resizableColumns) {
		thEls.forEach((th, i) => {
			const handle = document.createElement('div');
			handle.className = 'col-resize-handle';
			// NB: no inline `position` here — it beats the stylesheet's
				// `position: sticky` on .table thead th and makes the sticky
				// header scroll away. A sticky th is itself a positioned
				// containing block, so the absolutely-positioned handle anchors.
			th.appendChild(handle);
			const onDown = (e: MouseEvent): void => {
				e.preventDefault();
				e.stopPropagation();
				const col = colEls[i];
				if (!col) return;
				const startX = e.clientX;
				const startW = col.offsetWidth || col.getBoundingClientRect().width;
				document.body.style.cursor = 'col-resize';
				document.body.classList.add('resizing');
				// Coalesce the width writes through rAF — mousemove fires
				// faster than the display refreshes (especially on high-Hz
				// mice), and each col width mutation invalidates the table
				// layout. One write per painted frame is all the user can see.
				let pendingW: number | null = null;
				let moveRaf: number | null = null;
				const onMove = (mv: MouseEvent): void => {
					pendingW = Math.max(MIN_COL_W, startW + (mv.clientX - startX));
					if (moveRaf != null) return;
					moveRaf = requestAnimationFrame(() => {
						moveRaf = null;
						if (pendingW != null) { col.style.width = `${pendingW}px`; syncTableMinWidth(); }
					});
				};
				const onUp = (): void => {
					window.removeEventListener('mousemove', onMove);
					window.removeEventListener('mouseup', onUp);
					if (moveRaf != null) { cancelAnimationFrame(moveRaf); moveRaf = null; }
					// Flush the last pending width so the persisted value
					// matches what the user released at, not the last frame.
					if (pendingW != null) { col.style.width = `${pendingW}px`; syncTableMinWidth(); }
					document.body.style.cursor = '';
					document.body.classList.remove('resizing');
					// The browser synthesizes a `click` on the <th> when this
					// mouseup lands on it — which bubbles to the thead's delegated
					// sort handler and would sort by the just-resized column.
					// stopPropagation on the earlier mousedown can't stop a later,
					// separate click event, so swallow exactly that one click in
					// the capture phase before it reaches onHeaderClick. The
					// timeout removes the listener if no click is synthesized
					// (mouseup released off the header) so it can't eat a real one.
					window.addEventListener('click', swallowClick, { capture: true, once: true });
					setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
					const cls = Array.from(col.classList).find((c) => c.startsWith('c-') || c.startsWith('c2-'));
					if (cls) opts.onColumnResize?.(cls, col.offsetWidth);
				};
				window.addEventListener('mousemove', onMove);
				window.addEventListener('mouseup', onUp);
			};
			handle.addEventListener('mousedown', onDown);
			resizeCleanups.push(() => handle.removeEventListener('mousedown', onDown));
		});
	}

	// Column reorder — native HTML5 drag on the <th>. The payload is a private
	// MIME type so the tbody's row-drop handlers (which key off dragSrcIds)
	// and the sidebar's playlist drop targets never see it as a track drag.
	// The resize handle's mousedown calls preventDefault, which also stops a
	// drag from starting off the handle. A drop paints nothing itself —
	// onColumnReorder's caller re-mounts with the new order.
	const COLUMN_DRAG_MIME = 'application/x-curator-column';
	let colDragSrc: LayoutColumn | null = null;
	let colDropTh: HTMLTableCellElement | null = null;
	const clearColDrop = (): void => {
		colDropTh?.classList.remove('col-drop-before', 'col-drop-after');
		colDropTh = null;
	};
	const onColDragStart = (evt: DragEvent): void => {
		const th = (evt.target as HTMLElement).closest<HTMLTableCellElement>('th');
		const col = th ? colByTh.get(th) : undefined;
		if (!th || !col || !evt.dataTransfer) return;
		colDragSrc = col;
		evt.dataTransfer.setData(COLUMN_DRAG_MIME, col);
		evt.dataTransfer.effectAllowed = 'move';
		th.classList.add('col-dragging');
	};
	const colDropSide = (th: HTMLTableCellElement, x: number): 'before' | 'after' => {
		const r = th.getBoundingClientRect();
		return x < r.left + r.width / 2 ? 'before' : 'after';
	};
	const onColDragOver = (evt: DragEvent): void => {
		if (!colDragSrc) return;
		const th = (evt.target as HTMLElement).closest<HTMLTableCellElement>('th');
		if (!th || !colByTh.has(th)) return;
		evt.preventDefault();
		if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
		const side = colDropSide(th, evt.clientX);
		const cls = side === 'before' ? 'col-drop-before' : 'col-drop-after';
		if (colDropTh !== th || !th.classList.contains(cls)) {
			clearColDrop();
			colDropTh = th;
			th.classList.add(cls);
		}
	};
	const onColDrop = (evt: DragEvent): void => {
		if (!colDragSrc) return;
		const th = (evt.target as HTMLElement).closest<HTMLTableCellElement>('th');
		const target = th ? colByTh.get(th) : undefined;
		const src = colDragSrc;
		clearColDrop();
		if (!th || !target || target === src) return;
		evt.preventDefault();
		const side = colDropSide(th, evt.clientX);
		const order = cols.filter((c) => c !== src);
		const at = order.indexOf(target) + (side === 'after' ? 1 : 0);
		order.splice(at, 0, src);
		opts.onColumnReorder?.(order);
	};
	const onColDragEnd = (): void => {
		thEls.forEach((th) => th.classList.remove('col-dragging'));
		clearColDrop();
		colDragSrc = null;
	};
	if (showHeader && opts.reorderableColumns && thead) {
		thEls.forEach((th) => { th.draggable = true; });
		thead.addEventListener('dragstart', onColDragStart);
		thead.addEventListener('dragover', onColDragOver);
		thead.addEventListener('drop', onColDrop);
		thead.addEventListener('dragend', onColDragEnd);
	}

	// Paint the current sort arrow on the matching header. Called from initial
	// build and from setSort().
	function paintSortArrow(): void {
		if (!showHeader || !sort || !thead) return;
		const arrow = sort.dir === 'asc' ? '↑' : '↓';
		for (const el of thead.querySelectorAll<HTMLElement>('.sorted')) el.classList.remove('sorted');
		for (const el of thead.querySelectorAll('.sort')) el.remove();
		const active = thead.querySelector<HTMLElement>(`[data-sort="${sort.column}"]`);
		if (active) {
			active.classList.add('sorted');
			const span = document.createElement('span');
			span.className = 'sort';
			span.textContent = arrow;
			active.appendChild(span);
		}
	}

	const handle: TrackListHandle = {
		el: root,
		update(next) {
			// Fast path — same ids in the same order as the current dataset.
			// Hot for the filterbox pipeline (re-applying a filter over the
			// same unfiltered array yields the same element refs) and for
			// event-driven repaints that re-push an unchanged page. Same id
			// sequence means the virt window geometry, spacers, scroll and
			// selection are all still valid — only rows whose object
			// identity changed need their DOM refreshed, and only if
			// they're currently rendered. Grouped lists additionally need
			// every changed track to stay in its group (else the geometry
			// moves — slow path); header stats are refreshed in place. Full
			// keyed diffing (moves/inserts/deletes) is deliberately NOT
			// attempted here — those fall through to the wipe-and-rebuild
			// below, which is correct by construction; revisit only with a
			// profile in hand.
			const sameOrder = next.length === allTracks.length
				&& next.every((t, i) => t.id === allTracks[i]!.id);
			if (sameOrder) {
				const prev = allTracks;
				let regroup = false;
				let anyChanged = false;
				for (let i = 0; i < next.length && !regroup; i++) {
					if (next[i] === prev[i]) continue;
					anyChanged = true;
					if (display && groupBy !== 'none' && groupIdentity(next[i]!, groupBy).key !== display.groupOfTrack.get(next[i]!.id)) regroup = true;
				}
				if (!regroup) {
					allTracks = next;
					if (!anyChanged) return;
					if (!display) {
						tracks = next;
						for (let i = 0; i < next.length; i++) {
							const t = next[i]!;
							if (t === prev[i]) continue;
							const old = renderedRows.get(t.id);
							if (!old) continue;
							const fresh = buildRow({ kind: 'track', track: t, trackIndex: i });
							old.replaceWith(fresh);
							renderedRows.set(t.id, fresh);
						}
						return;
					}
					// Grouped: same groups, same geometry — refresh the model
					// (stats, member refs) and repaint the rendered window.
					rebuildDisplay();
					for (let i = 0; i < tracks.length; i++) {
						const t = tracks[i]!;
						const old = renderedRows.get(t.id);
						if (!old) continue;
						const fresh = buildRow({ kind: 'track', track: t, trackIndex: i });
						old.replaceWith(fresh);
						renderedRows.set(t.id, fresh);
					}
					refreshGroupHeaders();
					return;
				}
			}

			allTracks = next;
			rebuildDisplay();
			const selectionChanged = pruneSelection();
			relayout();
			if (selectionChanged) notifySelection();
		},
		patchOne(t) {
			const ai = allTracks.findIndex((x) => x.id === t.id);
			if (ai < 0) return;
			// A patch that moves the track to another group changes the
			// geometry — go through update().
			if (display && groupBy !== 'none' && groupIdentity(t, groupBy).key !== display.groupOfTrack.get(t.id)) {
				const next = [...allTracks];
				next[ai] = t;
				handle.update(next);
				return;
			}
			// Mirror the in-memory lists so subsequent re-renders see the patch.
			allTracks[ai] = t;
			const vi = tracks.findIndex((x) => x.id === t.id);
			if (vi >= 0 && tracks !== allTracks) tracks[vi] = t;
			if (display) {
				const row = display.rows[display.trackRow[vi] ?? -1];
				if (row?.kind === 'track') row.track = t;
			}
			const old = renderedRows.get(t.id);
			if (!old || vi < 0) return;
			const fresh = buildRow({ kind: 'track', track: t, trackIndex: vi });
			old.replaceWith(fresh);
			renderedRows.set(t.id, fresh);
		},
		repaintVisibleRows() {
			if (renderedRows.size === 0) return;
			// One id→index map up front — renderedRows is the small virt
			// window but `tracks` can be tens of thousands; avoid a find()
			// per rendered row.
			const idxById = new Map(tracks.map((t, i) => [t.id, i] as const));
			for (const [id, old] of renderedRows) {
				const i = idxById.get(id);
				if (i == null) continue;
				const fresh = buildRow({ kind: 'track', track: tracks[i]!, trackIndex: i });
				old.replaceWith(fresh);
				renderedRows.set(id, fresh);
			}
		},
		setSort(next) {
			sort = next;
			paintSortArrow();
		},
		scrollToIndex(idx) {
			if (idx < 0 || idx >= tracks.length) return false;
			const row = rowOfTrack(idx);
			if (row < 0) return false;
			if (virtualizer) {
				// 'auto' = only scroll if not already visible (matches the
				// prior hand-rolled behaviour); the virtualizer's onChange
				// repaints the window for us.
				virtualizer.scrollToIndex(row, { align: 'auto' });
				renderWindow();
			} else {
				const rowTop = rowStart(row);
				const rowBottom = rowTop + heightAt(row);
				const viewTop = scrollHost.scrollTop;
				const viewBottom = viewTop + scrollHost.clientHeight;
				if (rowTop < viewTop) scrollHost.scrollTop = rowTop;
				else if (rowBottom > viewBottom) scrollHost.scrollTop = rowBottom - scrollHost.clientHeight;
			}
			return true;
		},
		scrollToTrack(id, align = 'auto') {
			let idx = tracks.findIndex((t) => t.id === id);
			if (idx < 0 && display) {
				// Inside a collapsed group → open it, then find it again.
				const key = display.groupOfTrack.get(id);
				if (key == null || !collapsed.has(key)) return false;
				collapsed.delete(key);
				rebuildDisplay();
				relayout();
				idx = tracks.findIndex((t) => t.id === id);
			}
			if (idx < 0) return false;
			if (align === 'start' && virtualizer) {
				virtualizer.scrollToIndex(rowOfTrack(idx), { align: 'start' });
				renderWindow();
				return true;
			}
			return handle.scrollToIndex(idx);
		},
		getScrollTop() { return scrollHost.scrollTop; },
		setScrollTop(n) {
			scrollHost.scrollTop = n;
			// observeElementOffset picks the new offset up async; repaint now
			// so the restored window is correct on this frame.
			if (virtualize) renderWindow();
		},
		getFirstVisibleIndex() {
			if (tracks.length === 0) return -1;
			if (!virtualizer) {
				// Ceil so partially-clipped rows at the top don't count — the
				// caller wants a row that's actually readable.
				return Math.min(Math.ceil(scrollHost.scrollTop / rowH), tracks.length - 1);
			}
			// First track row whose top is at or below the visible top (under
			// the column header, and under the pinned group header when one
			// shows). Item offsets exclude the thead, so scrollTop is the top.
			virtualizer._willUpdate();
			const top = scrollHost.scrollTop + (pinEl && !pinEl.hidden ? pinH : 0);
			let last = -1;
			for (const vi of virtualizer.getVirtualItems()) {
				const r = rowAt(vi.index);
				if (r?.kind !== 'track') continue;
				last = r.trackIndex;
				if (vi.start >= top - 1) return r.trackIndex;
			}
			return last >= 0 ? last : Math.min(tracks.length - 1, 0);
		},
		destroy() {
			if (activeHandle === handle) activeHandle = null;
			tbody.removeEventListener('mousedown', onMouseDown);
			tbody.removeEventListener('dblclick', onDblClick);
			tbody.removeEventListener('contextmenu', onContextMenu);
			tbody.removeEventListener('click', onClick);
			tbody.removeEventListener('dragstart', onDragStart);
			tbody.removeEventListener('dragover', onDragOver);
			tbody.removeEventListener('dragleave', onDragLeave);
			tbody.removeEventListener('drop', onDrop);
			tbody.removeEventListener('dragend', onDragEnd);
			pinEl?.removeEventListener('click', onPinClick);
			pinEl?.removeEventListener('mousedown', onPinMouseDown);
			virtualizerCleanup?.();
			virtualizerCleanup = null;
			thead?.removeEventListener('contextmenu', onHeaderCtx);
			thead?.removeEventListener('click', onHeaderClick);
			thead?.removeEventListener('dragstart', onColDragStart);
			thead?.removeEventListener('dragover', onColDragOver);
			thead?.removeEventListener('drop', onColDrop);
			thead?.removeEventListener('dragend', onColDragEnd);
			for (const c of resizeCleanups) c();
			host.replaceChildren();
			renderedRows.clear();
			selected.clear();
			anchor = null;
		},
		focus() { setActive(handle); },
		blur() {
			if (selected.size === 0 && !anchor) return;
			selected.clear();
			anchor = null;
			applySelectionToDom();
			notifySelection();
		},
		getSelectedIds() { return [...selected]; },
		setSelectedIds(ids) {
			selected.clear();
			for (const id of ids) selected.add(id);
			applySelectionToDom();
			// Caller is in control here — don't bounce notifySelection back.
		},
		getSelectionAnchor() { return anchor; },
		setSelectionAnchor(id) { anchor = id; },
		getTracks() { return tracks; },
		getAllTracks() { return allTracks; },
		toggleGroup(key, all) { toggleGroup(key, all); },
		collapseAll() { bulkCollapse(true); },
		expandAll() { bulkCollapse(false); },
		refreshGroupHeaders() { refreshGroupHeaders(); },
		selectAll() {
			selected.clear();
			for (const t of tracks) selected.add(t.id);
			if (tracks.length > 0 && !anchor) anchor = tracks[0]!.id;
			applySelectionToDom();
		},
		setSelectionRange(anchorId, leadId) {
			const ids = tracks.map((t) => t.id);
			const a = ids.indexOf(anchorId);
			const b = ids.indexOf(leadId);
			if (a < 0 || b < 0) return;
			selected.clear();
			const [lo, hi] = a <= b ? [a, b] : [b, a];
			for (let k = lo; k <= hi; k++) selected.add(ids[k]!);
			anchor = anchorId;
			applySelectionToDom();
		},
		setReorderable(b) {
			// Rows stay draggable either way (drag-out to sidebar playlists);
			// this flag only gates the in-list reorder path in onDragStart.
			reorderable = b;
		},
	};

	// Initial paint.
	handle.update(initial);
	paintSortArrow();
	return handle;
}
