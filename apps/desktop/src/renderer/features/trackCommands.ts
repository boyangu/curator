// Track command layer — the single declarative source of truth for the
// actions that apply to library tracks (Spotify/Tidal/Local rows + the
// Pinned/Basket tag views). Each command declares a PURE, SYNCHRONOUS
// `isAvailable(ctx)` predicate over the selected `Track[]`, plus a `run(ctx)`
// handler that may do async work (resolve an open-URL, a file path). Menus are
// *derived* by filtering this one table — and the same `isAvailable` is what a
// future button surface queries to decide visibility.
//
// Why availability is sync: every track carries a `sources` array (decorated by
// getTracks() from source_link rows), so local-vs-streaming and per-source
// reference presence are already in hand — no IPC needed to decide what to
// show. Only execution reaches for the network.
//
// IPC goes through the data/api.ts facades, never the raw preload bridge
// (boundary-checked at build time). This module never imports main.ts — the
// flows that still live there arrive via the deps interface (shared with
// contextMenus.ts) wired in boot().

import type { Playlist, Track } from '@curator/shared';
import type { RemovableTrackSource } from '@curator/core';
import type { ActiveView, JitPlaylist, SourceTab } from '../viewmodel/shell.js';
import type { ContextMenusFeatureDeps } from './contextMenus.js';
import { openContextMenu, type ContextMenuItem, type ContextMenuHandlers } from '../components/ContextMenu.jsx';
import { tracksData } from '../data/tracks.js';
import { tracksApi, libraryApi, enrichApi, tidalApi, shellApi, downloadsApi, mirApi } from '../data/api.js';
import { showToast } from '../ui/toast.js';
import { buildExactAttr, extractSqlPrefilter, parseQuery } from '../query.js';
import { openTrackEditor } from './editTrack.js';
import { anyRemoteRow, REMOTE_ONLY_REASON } from '../remoteRows.js';
import { log } from '../data/log.js';

// Well-known system tag ids — seeded in apps/core/src/db/migrate.ts. Owned here
// (the curate commands are their only remaining consumers) and re-exported from
// contextMenus.ts for the callers that still import them from there.
export const SYSTEM_TAG_INTERESTED = 'interested';
export const SYSTEM_TAG_BASKET = 'basket';

// ── deps wiring ──────────────────────────────────────────────────────────────
// Shares the exact deps object main.ts injects into contextMenus.ts. main.ts
// calls initTrackCommands(deps) alongside initContextMenusFeature(deps).
let deps: ContextMenusFeatureDeps;
export function initTrackCommands(d: ContextMenusFeatureDeps): void {
	deps = d;
}

// ── context + command shape ──────────────────────────────────────────────────

// The navigate-to "in playlists" rows come straight from tracks:playlists, whose
// wire shape uses string dates (not the Date-typed shared `Playlist`). Derive
// the element type from the facade so we don't fight the serialized form.
type TrackPlaylistEntry = Awaited<ReturnType<typeof tracksApi.playlists>>[number];

export interface TrackCommandContext {
	// The selected tracks (1..N). Carry `sources` — the basis for every predicate.
	tracks: Track[];
	view: ActiveView;     // shell.activeView() — 'tracks' | 'interested' | …
	source: SourceTab;    // shell.activeSource()
	// Populated by showTrackMenu for SINGLE selection only (one async pre-fetch).
	// Predicates/labels read these; multi-selection leaves them undefined and
	// the single-only commands that need them are hidden anyway.
	tagIds?: Set<string>;
	drillPlaylists?: TrackPlaylistEntry[];
	// The real, editable playlist the tracklist is showing (main.ts
	// currentEditablePlaylist) — null/absent for All tracks, a library
	// folder, an rb folder, a search/JIT scope, a smart playlist, and the
	// now-playing menu. Gates "Remove from playlist".
	playlist?: Playlist | null;
	// The JIT scope the tracklist shows (shell.currentJit) — a `similar:` /
	// `sounds:` scope enables "Add to Similarity Match". Absent elsewhere.
	jit?: JitPlaylist | null;
}

// The selection-only slice of the context — what callers pass to open the menu
// AND what the keyboard shortcuts pass to delegate. showTrackMenu layers the
// single-selection extras (tagIds/drillPlaylists) on top; keyboard-bound
// commands (edit/rate/delete) don't need them.
export type TrackSelectionContext = { tracks: Track[]; view: ActiveView; source: SourceTab; playlist?: Playlist | null; jit?: JitPlaylist | null };

// Group = divider boundary + render order. Commands within a group keep their
// table order; a divider is emitted between consecutive non-empty groups.
type Group = 'curate' | 'enrich' | 'navigate' | 'open' | 'sync' | 'destructive';
const GROUP_ORDER: Group[] = ['curate', 'enrich', 'navigate', 'open', 'sync', 'destructive'];

// Commands that share a `submenu` key render as children of one submenu row
// (at the position of the first available one). The children keep their own
// ids, so keyboard delegation (runTrackCommand) still finds them.
type SubmenuKey = 'sync' | 'delete';

export interface TrackCommand {
	id: string;
	group: Group;
	// Pure + sync — the one place "can this run on the current selection?" lives.
	isAvailable(ctx: TrackCommandContext): boolean;
	// Needs the audio or writes a device-local link (file, rekordbox, a
	// provider match), so it never runs while the selection holds a remote
	// row (track.remoteOnly — not on this device; see remoteRows.ts).
	// 'explain' keeps it in the menu, disabled with the reason, so the user
	// learns why Analyze / Sync to Rekordbox are out of reach; 'hide' drops it.
	device?: 'explain' | 'hide';
	// Leaf rendering (omitted when `build` supplies a custom item, e.g. navigate-to).
	label?: (ctx: TrackCommandContext) => string;
	iconHtml?: string | ((ctx: TrackCommandContext) => string);
	danger?: boolean;
	mnemonic?: string;
	// Render under this submenu instead of at the top level.
	submenu?: SubmenuKey;
	run?: (ctx: TrackCommandContext) => void | Promise<void>;
	// Custom builder — overrides leaf rendering for non-leaf commands (the
	// navigate-to submenu, whose child rows + handlers are data-driven).
	build?: (ctx: TrackCommandContext) => { item: ContextMenuItem; handlers: ContextMenuHandlers };
}

// ── pure predicate helpers (over ctx.tracks) ─────────────────────────────────
const idsOf = (c: TrackCommandContext): string[] => c.tracks.map((t) => t.id);
const single = (c: TrackCommandContext): boolean => c.tracks.length === 1;
const any = (c: TrackCommandContext): boolean => c.tracks.length >= 1;
const hasLocal = (t: Track): boolean => (t.sources ?? []).includes('local');
const hasSrc = (t: Track, s: string): boolean => (t.sources ?? []).includes(s);
// "all must qualify" semantics — a command is available for a multi-selection
// only when EVERY selected track qualifies (confirmed product decision).
const allLocal = (c: TrackCommandContext): boolean => any(c) && c.tracks.every(hasLocal);
const allStream = (c: TrackCommandContext): boolean => any(c) && c.tracks.every((t) => !hasLocal(t));
const allHave = (c: TrackCommandContext, s: string): boolean => any(c) && c.tracks.every((t) => hasSrc(t, s));
const noneHave = (c: TrackCommandContext, s: string): boolean => any(c) && c.tracks.every((t) => !hasSrc(t, s));
// Open-in / Copy URL / Search-in only: the provider id may also be one the
// account knows from another device (Track.claimSources — a claim-derived
// link). Everything else (download, delete, sync) keeps to `sources`: a
// derived id is never this device's to act on.
const knows = (t: Track, s: string): boolean => hasSrc(t, s) || (t.claimSources ?? []).includes(s);
const allKnow = (c: TrackCommandContext, s: string): boolean => any(c) && c.tracks.every((t) => knows(t, s));
const noneKnow = (c: TrackCommandContext, s: string): boolean => any(c) && c.tracks.every((t) => !knows(t, s));
// Single-selection only: `ctx.tagIds` is fetched just for one row (see showTrackMenu).
const hasTag = (c: TrackCommandContext, tagId: string): boolean => single(c) && !!c.tagIds?.has(tagId);
const displayName = (c: TrackCommandContext): string => (single(c) ? c.tracks[0]!.title : `${c.tracks.length} tracks`);

// The sources the Delete dialog offers (metadata links like beatport travel
// with the row). Delete is available when every selected track has ≥1.
const REMOVABLE: readonly RemovableTrackSource[] = ['local', 'spotify', 'tidal', 'rekordbox'];
const allRemovable = (c: TrackCommandContext): boolean => any(c) && c.tracks.every((t) => REMOVABLE.some((s) => hasSrc(t, s)));

// Browser search query — title + primary artist, falling back to title alone.
const searchQuery = (t: Track): string => {
	const artist = t.artists?.[0]?.name ?? '';
	return artist ? `${t.title} ${artist}` : t.title;
};

// ── icons ────────────────────────────────────────────────────────────────────
const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/></svg>';
// Flag glyph — outline = "mark", filled = "remove". Pin glyph is used in the
// Pinned view where the action reads as "Unpin".
const iconInterested = (filled: boolean): string =>
	`<svg width="12" height="12" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6v6l3 3v2H6v-2l3-3z"/><path d="M12 15v5"/></svg>`;
const ICON_PIN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><g transform="rotate(45 12 12)"><path d="M9.5 2.5h5v4h-5z"/><path d="M7.5 6.5h9v7h-9z"/><line x1="12" y1="13.5" x2="12" y2="22"/></g></svg>';
const ICON_BASKET = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 6h18l-2 12H5z"/><path d="M9 10v6M15 10v6"/></svg>';
const ICON_TAG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-9-9V3h10z"/><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor"/></svg>';
const ICON_ANALYZE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14l4-7 4 4 4-7 4 5 2-2"/><path d="M3 20h18"/></svg>';
// Brand marks in their own colours (not currentColor) so the service reads at a
// glance — used for both Open-in and Search-in, linked or not.
const ICON_BEATPORT = '<svg class="ctx-brand" width="13" height="13" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#01FF95"/><path d="M8.5 5v13" stroke="#000" stroke-width="2.4" stroke-linecap="round"/><circle cx="12.6" cy="14" r="3.9" fill="none" stroke="#000" stroke-width="2.4"/></svg>';
const ICON_TIDAL = '<svg class="ctx-brand" width="13" height="13" viewBox="0 0 24 24" fill="#efeff2"><path d="M6 5l3.4 3.4L6 11.8 2.6 8.4z"/><path d="M12 5l3.4 3.4L12 11.8 8.6 8.4z"/><path d="M18 5l3.4 3.4L18 11.8l-3.4-3.4z"/><path d="M12 11.6l3.4 3.4-3.4 3.4-3.4-3.4z"/></svg>';
const ICON_SPOTIFY = '<svg class="ctx-brand" width="13" height="13" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#1DB954"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M6.3 9.4c3.7-1.2 8.2-.9 11.5 1" stroke-width="2.1"/><path d="M7 12.8c3-.9 6.6-.6 9.3.9" stroke-width="1.8"/><path d="M7.8 15.9c2.3-.6 4.8-.4 6.9.7" stroke-width="1.5"/></g></svg>';
const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_DOWNLOAD = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 4v12"/><path d="m6 10 6 6 6-6"/><path d="M5 20h14"/></svg>';
const ICON_FOLDER = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2z"/></svg>';
const ICON_SYNC_RB = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 17 3 3 3-3"/><path d="M12 4v16"/><rect x="4" y="3" width="16" height="4" rx="1"/></svg>';
// Pull-direction mirror — arrow points up, out of the disc at the bottom.
const ICON_SYNC_RB_FROM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m9 7 3-3 3 3"/><path d="M12 4v16"/><rect x="4" y="17" width="16" height="4" rx="1"/></svg>';
const ICON_DRILL = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13"/><path d="M3 12h10"/><path d="M3 18h7"/><path d="m17 9 4 3-4 3"/></svg>';
// Two circular arrows — the Sync submenu.
const ICON_SYNC = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.6-4.5"/><path d="M5 3v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5"/><path d="M19 21v-4h-4"/></svg>';
// Venn diagram — Find Similar (overlap = what the tracks share).
const ICON_SIMILAR = '<svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="12" r="6.5" fill="currentColor" fill-opacity="0.12"/><circle cx="15" cy="12" r="6.5" fill="currentColor" fill-opacity="0.12"/></svg>';
const ICON_DELETE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';

const SUBMENUS: Record<SubmenuKey, { label: string; iconHtml?: string }> = {
	sync: { label: 'Sync', iconHtml: ICON_SYNC },
	delete: { label: 'Delete', iconHtml: ICON_DELETE },
};

// ── shared async helpers (used by run handlers) ──────────────────────────────

// Derive a browser URL from source + sourceTrackId when the stored `url` is
// null/empty — older enrichments wrote source_link rows without the URL field.
function deriveSourceUrl(source: string, id: string): string | null {
	switch (source) {
		case 'spotify':  return `https://open.spotify.com/track/${id}`;
		case 'tidal':    return `https://tidal.com/browse/track/${id}`;
		case 'beatport': return `https://www.beatport.com/track/-/${id}`;
		default:         return null;
	}
}

// Resolve a track's per-source "open in…" URLs from its source_link rows,
// and the claim-derived ids for providers it has no own link for.
// Availability of the open-* commands is already decided synchronously from
// `sources`; this only runs on click to get the actual URL.
async function resolveTrackSourceUrls(trackId: string): Promise<{ spotifyUrl?: string; tidalUrl?: string; beatportUrl?: string }> {
	const links = await tracksApi.sourceLinks(trackId).catch(() => []);
	// Core lists a provider's primary first (own links, then the claim-derived
	// ones by rank) — a row may know several ids of one provider, and the
	// first is the one to open.
	const bySource = new Map<string, string>();
	for (const l of links) {
		const url = l.url ?? deriveSourceUrl(l.source, l.sourceTrackId);
		if (url && !bySource.has(l.source)) bySource.set(l.source, url);
	}
	return { spotifyUrl: bySource.get('spotify'), tidalUrl: bySource.get('tidal'), beatportUrl: bySource.get('beatport') };
}

// Enqueue N tracks for Tidal download, enabling downloads on demand, then
// surface the Downloads view. Gating already guaranteed every track is
// tidal-matched, so no per-track skip here. Already-local tracks are allowed
// through on the Tidal tab — core writes those to the redownload folder
// without touching the existing local binding.
async function downloadTracksViaTidal(trackIds: string[]): Promise<void> {
	const items = trackIds.map((id) => {
		const t = tracksData.get(id);
		return { trackId: id, trackTitle: t?.title ?? '(unknown)', artistName: t?.artists?.[0]?.name ?? '' };
	});
	try {
		const status = await downloadsApi.status();
		if (!status.enabled) {
			showToast('Enabling Tidal downloads…', { sub: 'Sign in to listen.tidal.com in the popup', kind: 'info', durationMs: 4000 });
			await downloadsApi.enable();
		}
		await downloadsApi.enqueue(items);
		deps.openDownloadsView();
	} catch (err) {
		showToast('Download failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	}
}

// Match the selection against Tidal (acquire/refresh a tidal source link).
// Single: rich feedback — patch the cache's tidal pip + flash the row. Multi:
// one batch call + a count toast (rows pick up the new pip on next render).
async function syncTracksWithTidal(c: TrackCommandContext): Promise<void> {
	// Only match tracks that aren't already linked — the command is offered for a
	// multi-selection even when some are mapped, but re-matching the linked ones
	// is wasted work.
	const targets = c.tracks.filter((t) => !hasSrc(t, 'tidal'));
	if (targets.length === 0) { showToast('Already synced with Tidal', { kind: 'info' }); return; }
	if (targets.length === 1) {
		const t = targets[0]!;
		showToast('Searching Tidal…', { sub: t.title, kind: 'info', durationMs: 1500 });
		try {
			const res = await tidalApi.matchTrack(t.id);
			if (!res) { showToast('No Tidal match', { sub: t.title, kind: 'error' }); return; }
			showToast('Matched on Tidal', { sub: t.title, kind: 'success' });
			const cached = tracksData.get(t.id);
			if (cached) {
				cached.sources = [...new Set([...(cached.sources ?? []), 'tidal'])];
				deps.getMainTrackList()?.patchOne(cached);
			}
			const row = document.querySelector<HTMLTableRowElement>(`tr[data-id="${deps.cssEscape(t.id)}"]`);
			if (row) { row.classList.add('row-enriched'); setTimeout(() => row.classList.remove('row-enriched'), 700); }
		} catch (err) {
			showToast('Tidal match failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
		}
		return;
	}
	showToast(`Searching Tidal for ${targets.length} tracks…`, { kind: 'info', durationMs: 2000 });
	try {
		const res = await tidalApi.matchTracks(targets.map((t) => t.id));
		showToast(`Tidal: ${res.matched}/${res.scanned}`, { kind: res.matched > 0 ? 'success' : 'error', durationMs: 3500 });
	} catch (err) {
		showToast('Bulk Tidal match failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// Toggle a system tag across the selection. `remove` adds when false. Used by
// the interested + basket curate commands so their add/remove/bulk paths stay
// in one place. Re-renders the matching tag view so toggled rows drop in/out.
async function toggleTagForSelection(
	ctx: TrackCommandContext,
	tagId: string,
	remove: boolean,
	verbs: { added: string; removed: string },
): Promise<void> {
	const list = idsOf(ctx);
	try {
		await Promise.all(list.map((id) => (remove ? tracksApi.removeTag(id, tagId) : tracksApi.addTag(id, tagId))));
		const label = remove ? verbs.removed : verbs.added;
		showToast(single(ctx) ? label : `${label} · ${list.length} tracks`, {
			sub: single(ctx) ? ctx.tracks[0]!.title : undefined,
			kind: remove ? 'info' : 'success',
		});
		await deps.refreshTagCounts();
		// Removing the active view's tag drops the row from the (now-shorter) list.
		if ((tagId === SYSTEM_TAG_INTERESTED && ctx.view === 'interested') || (tagId === SYSTEM_TAG_BASKET && ctx.view === 'basket')) {
			await deps.renderTracks();
		}
	} catch (err) {
		showToast('Tag write failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
	}
}

// Drill-into entries — per-attribute JIT scopes (artist/album/label/genre) plus
// the playlists the track is in. Single-selection only; `ctx.drillPlaylists` is
// pre-fetched by showTrackMenu. Built once, read by both isAvailable (length)
// and the submenu builder.
function buildDrillEntries(ctx: TrackCommandContext): { id: string; label: string; chip: string; activate: () => void }[] {
	if (!single(ctx)) return [];
	const t = ctx.tracks[0]!;
	const entries: { id: string; label: string; chip: string; activate: () => void }[] = [];
	(t.artists ?? []).forEach((a, i) => {
		if (!a.name) return;
		const name = a.name;
		// Id-keyed scope when the read decorated one (exact, indexed SQL
		// pushdown; survives renames); name-keyed exact attr otherwise.
		const aid = t.artistIds?.[i];
		const query = aid ? buildExactAttr('artistid', aid) : buildExactAttr('artist', name);
		entries.push({ id: `drill-artist-${entries.length}`, label: name, chip: 'Artist', activate: () => deps.enterJitScope({ name: `Artist: ${name}`, query }) });
	});
	if (t.albumTitle) {
		const v = t.albumTitle;
		// By release id when the album seam assigned one (every track on that
		// release, whichever source spelled the title); the title match
		// otherwise.
		const query = t.albumId ? buildExactAttr('albumid', t.albumId) : buildExactAttr('album', v);
		entries.push({ id: 'drill-album', label: v, chip: 'Album', activate: () => deps.enterJitScope({ name: `Album: ${v}`, query }) });
	}
	if (t.label) {
		const v = t.label;
		entries.push({ id: 'drill-label', label: v, chip: 'Label', activate: () => deps.enterJitScope({ name: `Label: ${v}`, query: buildExactAttr('label', v) }) });
	}
	if (t.genre) {
		const v = t.genre;
		entries.push({ id: 'drill-genre', label: v, chip: 'Genre', activate: () => deps.enterJitScope({ name: `Genre: ${v}`, query: buildExactAttr('genre', v) }) });
	}
	for (const entry of ctx.drillPlaylists ?? []) {
		const breadcrumb = entry.folderPath.map((f) => f.name).join('/');
		const label = breadcrumb ? `${breadcrumb} · ${entry.playlist.name}` : entry.playlist.name;
		const pid = entry.playlist.id;
		entries.push({ id: `open-playlist-${entries.length}`, label, chip: 'Playlist', activate: () => { void deps.openPlaylistById(pid); } });
	}
	return entries;
}

// ── the command table ────────────────────────────────────────────────────────
// Order within a group is render order. See planning notes for the per-command
// rationale; the `isAvailable` column IS the spec.
const TRACK_COMMANDS: TrackCommand[] = [
	// curate ──────────────────────────────────────────────────────────────────
	// Unified Organize picker (tags + playlists in one modal) — works on any
	// selection regardless of source (a track row exists for the membership
	// write). The menu peer of the `O` keyboard shortcut, which routes through
	// this same command so there's one definition for the action.
	{
		id: 'organize', group: 'curate', isAvailable: any, mnemonic: 'o', iconHtml: ICON_TAG,
		label: () => 'Organize…',
		run: (c) => { deps.openOrganize(idsOf(c)); },
	},
	{
		id: 'edit', group: 'curate', isAvailable: single, mnemonic: 'e', iconHtml: ICON_EDIT,
		label: () => 'Edit Metadata…',
		run: (c) => openTrackEditor(c.tracks[0]!.id),
	},
	{
		// Essentia analysis + (as a flag in the modal) AI-engine embeddings.
		id: 'analyze', group: 'curate', isAvailable: allLocal, device: 'explain', mnemonic: 'a', iconHtml: ICON_ANALYZE,
		label: () => 'Analyze…',
		run: (c) => { deps.getAnalyzeModal()?.open(idsOf(c)); },
	},
	{
		id: 'interested', group: 'curate',
		// In the Pinned view every row is already interested, so Unpin applies to
		// any selection (single + multi) regardless of source — incl. pinned
		// tracks that also have a local file. Elsewhere, marking interested is
		// streaming-only (no point pinning a track you already own locally).
		// A single already-interested track must stay removable even after it
		// gained a local file (download / scanner bind) — otherwise the tag is
		// stuck with no menu path out of it.
		isAvailable: (c) => (c.view === 'interested' ? any(c) : allStream(c) || hasTag(c, SYSTEM_TAG_INTERESTED)),
		// Pinned view → "Unpin"; single already-interested → "Remove"; else "Mark".
		iconHtml: (c) => (c.view === 'interested' ? ICON_PIN : iconInterested(hasTag(c, SYSTEM_TAG_INTERESTED))),
		label: (c) => (c.view === 'interested' ? 'Unpin' : hasTag(c, SYSTEM_TAG_INTERESTED) ? 'Remove from Interested' : 'Mark as Interested'),
		run: (c) => {
			const remove = c.view === 'interested' || hasTag(c, SYSTEM_TAG_INTERESTED);
			return toggleTagForSelection(c, SYSTEM_TAG_INTERESTED, remove, {
				added: c.tracks.length > 1 ? 'Marked as Interested' : 'Marked Interested',
				removed: c.view === 'interested' ? 'Unpinned' : 'Removed from Interested',
			});
		},
	},
	{
		id: 'basket', group: 'curate', iconHtml: ICON_BASKET,
		// Same shape as `interested`: Basket view → remove applies to any
		// selection; elsewhere adding is streaming-only but a single basketed
		// track stays removable even once it has a local file.
		isAvailable: (c) => (c.view === 'basket' ? any(c) : allStream(c) || hasTag(c, SYSTEM_TAG_BASKET)),
		label: (c) => (c.view === 'basket' || hasTag(c, SYSTEM_TAG_BASKET) ? 'Remove from Basket' : 'Add to Basket'),
		run: (c) => {
			const remove = c.view === 'basket' || hasTag(c, SYSTEM_TAG_BASKET);
			return toggleTagForSelection(c, SYSTEM_TAG_BASKET, remove, { added: 'Added to Basket', removed: 'Removed from Basket' });
		},
	},
	// enrich ────────────────────────────────────────────────────────────────────
	{
		// Shown unless every selected track is already Beatport-synced — a partial
		// selection still offers it. Runs only on the not-yet-synced subset.
		id: 'enrich-beatport', group: 'enrich', isAvailable: (c) => !allHave(c, 'beatport'), device: 'hide', iconHtml: ICON_BEATPORT,
		label: () => 'Enhance with BPM, Key, Label, Genre',
		run: async (c) => {
			const targets = c.tracks.filter((t) => !hasSrc(t, 'beatport')).map((t) => t.id);
			if (targets.length === 0) { showToast('Already enriched with Beatport', { kind: 'info' }); return; }
			if (targets.length === 1) {
				enrichApi.beatportTrack(targets[0]!).catch((err) => log.for('track-commands').error('beatport track enrichment failed', err));
				return;
			}
			showToast(`Enriching ${targets.length} tracks…`, { kind: 'info', durationMs: 2000 });
			try {
				const res = await enrichApi.beatportTracks(targets);
				showToast(`Beatport: ${res.enriched}/${res.scanned}`, { kind: res.enriched > 0 ? 'success' : 'error', durationMs: 3500 });
			} catch (err) {
				showToast('Bulk enrichment failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 5000 });
			}
		},
	},
	{
		// Multi-selection: always offered — re-matching already-linked tracks is
		// harmless (refreshes the match), and a partial selection shouldn't hide
		// it. Single: only when not already linked (a redundant re-match on one
		// track isn't worth the row; "Open in Tidal" covers the linked case).
		id: 'sync-tidal', group: 'enrich', device: 'hide', iconHtml: ICON_TIDAL,
		isAvailable: (c) => c.tracks.length >= 2 || (single(c) && noneHave(c, 'tidal')),
		label: () => 'Enhance with Tidal',
		run: (c) => { void syncTracksWithTidal(c); },
	},
	// navigate ──────────────────────────────────────────────────────────────────
	{
		// AI similarity: a JIT scope of the tracks that sound most like the
		// selection (multi-select = more like all of these). Lands in the
		// tracklist in Match order, pinnable like any search.
		id: 'find-similar', group: 'navigate', isAvailable: any, iconHtml: ICON_SIMILAR,
		label: (c) => (single(c) ? 'Find Similar' : `Find Similar to ${c.tracks.length} Tracks`),
		run: (c) => { void findSimilar(c); },
	},
	{
		// Inside a similarity scope: fold the selection into the current
		// match's seeds and re-rank. Opens as a new (child) history entry, so
		// Back returns to the previous match with its scroll and selection.
		id: 'add-to-similar', group: 'navigate', iconHtml: ICON_SIMILAR,
		isAvailable: (c) => {
			const seeds = similaritySeeds(c);
			return seeds !== null && c.tracks.some((t) => !seeds.includes(t.id));
		},
		label: (c) => (single(c) ? 'Add to Similarity Match' : `Add ${c.tracks.length} to Similarity Match`),
		run: (c) => { void addToSimilarityMatch(c); },
	},
	{
		// Embark on a discovery journey seeded with this track — Discover's
		// Journeys mode takes over (KB entity minted from the library row).
		// Hidden from the track menu for now (the user's call, 2026-10-15);
		// journeys still start from Discover cards.
		id: 'start-journey', group: 'navigate', isAvailable: () => false,
		label: () => 'Start Journey',
		run: (c) => { deps.startJourneyFromTrack(c.tracks[0]!.id); },
	},
	{
		id: 'open-spotify', group: 'open', isAvailable: (c) => single(c) && allKnow(c, 'spotify'), iconHtml: ICON_SPOTIFY,
		label: () => 'Open in **Spotify**',
		run: async (c) => { const { spotifyUrl } = await resolveTrackSourceUrls(c.tracks[0]!.id); if (spotifyUrl) shellApi.openSpotify(spotifyUrl); },
	},
	{
		// Copies the shareable https://open.spotify.com/track/… link (not the
		// spotify: app URI Open-in-Spotify uses). Same availability as open-spotify.
		id: 'copy-spotify-url', group: 'open', isAvailable: (c) => single(c) && allKnow(c, 'spotify'), iconHtml: ICON_COPY,
		label: () => 'Copy **Spotify** URL',
		run: async (c) => {
			const { spotifyUrl } = await resolveTrackSourceUrls(c.tracks[0]!.id);
			if (!spotifyUrl) { showToast('No Spotify URL', { kind: 'error' }); return; }
			await shellApi.copyText(spotifyUrl);
			showToast('Copied Spotify URL', { sub: spotifyUrl, kind: 'success' });
		},
	},
	{
		id: 'search-spotify', group: 'open', isAvailable: (c) => single(c) && noneKnow(c, 'spotify'), iconHtml: ICON_SPOTIFY,
		label: () => 'Search in **Spotify**',
		run: (c) => shellApi.openExternal(`https://open.spotify.com/search/${encodeURIComponent(searchQuery(c.tracks[0]!))}`),
	},
	{
		id: 'open-tidal', group: 'open', isAvailable: (c) => single(c) && allKnow(c, 'tidal'), iconHtml: ICON_TIDAL,
		label: () => 'Open in **Tidal**',
		run: async (c) => { const { tidalUrl } = await resolveTrackSourceUrls(c.tracks[0]!.id); if (tidalUrl) shellApi.openExternal(tidalUrl); },
	},
	{
		id: 'search-tidal', group: 'open', isAvailable: (c) => single(c) && noneKnow(c, 'tidal'), iconHtml: ICON_TIDAL,
		label: () => 'Search in **Tidal**',
		run: (c) => shellApi.openExternal(`https://tidal.com/search?q=${encodeURIComponent(searchQuery(c.tracks[0]!))}`),
	},
	{
		id: 'open-beatport', group: 'open', isAvailable: (c) => single(c) && allKnow(c, 'beatport'), iconHtml: ICON_BEATPORT,
		label: () => 'Open in **Beatport**',
		run: async (c) => { const { beatportUrl } = await resolveTrackSourceUrls(c.tracks[0]!.id); if (beatportUrl) shellApi.openExternal(beatportUrl); },
	},
	{
		id: 'search-beatport', group: 'open', isAvailable: (c) => single(c) && noneKnow(c, 'beatport'), iconHtml: ICON_BEATPORT,
		label: () => 'Search in **Beatport**',
		// /search (mixed results) reads more naturally for a browser visit than /search/tracks.
		run: (c) => shellApi.openExternal(`https://www.beatport.com/search?q=${encodeURIComponent(searchQuery(c.tracks[0]!))}`),
	},
	{
		id: 'open-local-folder', group: 'open', isAvailable: (c) => single(c) && allLocal(c), device: 'hide', iconHtml: ICON_FOLDER,
		label: () => 'Open File Location',
		run: async (c) => { const local = await libraryApi.trackLocalFile(c.tracks[0]!.id).catch(() => null); if (local?.path) shellApi.showInFolder(local.path); },
	},
	{
		// Stream-only selections can download from anywhere; the Tidal tab
		// additionally allows already-local tracks — core routes those to the
		// separate redownload folder and leaves the local binding untouched.
		id: 'download', group: 'enrich', isAvailable: (c) => allHave(c, 'tidal') && (allStream(c) || c.source === 'tidal'), device: 'hide', iconHtml: ICON_DOWNLOAD,
		label: () => 'Download from Tidal',
		run: (c) => { void downloadTracksViaTidal(idsOf(c)); },
	},
	// navigate (cont.) — the "Navigate to" submenu: this track's artists,
	// album, label, genre and playlists (was "Drill Into").
	{
		id: 'navigate-to', group: 'navigate',
		isAvailable: (c) => single(c) && buildDrillEntries(c).length > 0,
		build: (c) => {
			const entries = buildDrillEntries(c);
			return {
				item: {
					kind: 'submenu', id: 'navigate-to', label: 'Navigate to', iconHtml: ICON_DRILL,
					items: entries.map((d) => ({ kind: 'item' as const, id: d.id, label: d.label, chip: d.chip })),
				},
				handlers: Object.fromEntries(entries.map((d) => [d.id, d.activate])),
			};
		},
	},
	// sync ▸ ─────────────────────────────────────────────────────────────────────
	{
		// Pull rb's current metadata/cues/grids/waveforms for these tracks into
		// Curator. Available only for tracks already linked to rekordbox — a
		// pull has nothing to read otherwise.
		id: 'sync-from-rekordbox', group: 'sync', submenu: 'sync', isAvailable: (c) => allHave(c, 'rekordbox'), iconHtml: ICON_SYNC_RB_FROM,
		label: () => 'Sync from Rekordbox…',
		run: (c) => { void deps.openSyncFromRekordboxModal({ kind: 'tracks', ids: idsOf(c), displayName: displayName(c) }); },
	},
	{
		id: 'sync-to-rekordbox', group: 'sync', submenu: 'sync', isAvailable: allLocal, device: 'explain', iconHtml: ICON_SYNC_RB,
		label: () => 'Sync to Rekordbox…',
		run: (c) => { void deps.openSyncToRekordboxModal({ kind: 'tracks', ids: idsOf(c), displayName: displayName(c) }); },
	},
	{
		// Local tracks rekordbox doesn't know yet: create them there (then the
		// usual push writes metadata, cues and MyTags). A mixed selection
		// adds only the missing ones — the already-linked tracks are just
		// re-synced.
		id: 'add-to-rekordbox', group: 'sync', submenu: 'sync', iconHtml: ICON_SYNC_RB,
		isAvailable: (c) => any(c) && c.tracks.some((t) => hasLocal(t) && !hasSrc(t, 'rekordbox')),
		label: (c) => {
			const n = c.tracks.filter((t) => hasLocal(t) && !hasSrc(t, 'rekordbox')).length;
			return single(c) || n === c.tracks.length ? 'Add to Rekordbox…' : `Add ${n} to Rekordbox…`;
		},
		run: (c) => {
			const ids = c.tracks.filter((t) => hasLocal(t)).map((t) => t.id);
			const n = c.tracks.filter((t) => hasLocal(t) && !hasSrc(t, 'rekordbox')).length;
			void deps.openSyncToRekordboxModal({
				kind: 'tracks', ids, createMissing: true,
				displayName: n === 1 && single(c) ? c.tracks[0]!.title : `${n} track${n === 1 ? '' : 's'} to add`,
			});
		},
	},
	// delete ▸ ───────────────────────────────────────────────────────────────────
	// Shift+Delete / Shift+Backspace. Opens the per-source Delete dialog.
	{
		id: 'delete', group: 'destructive', submenu: 'delete', isAvailable: allRemovable, danger: true, iconHtml: ICON_DELETE,
		label: () => 'Delete from Library…',
		run: (c) => { void deleteTracksWithDialog(c.tracks); },
	},
	// Deleted rows still show where a delete leaves them (followed playlists,
	// feed albums: the "deleted" chip). Restoring is the deliberate way back
	// for a deleted track — the scanner never revives one on its own.
	{
		id: 'undelete', group: 'destructive', submenu: 'delete', iconHtml: ICON_DELETE,
		isAvailable: (c) => any(c) && c.tracks.every((t) => !!t.deletedAt),
		label: () => 'Restore to Library',
		run: (c) => { void undeleteTracks(c.tracks); },
	},
	// Plain Delete / Backspace. Only while a real playlist is on screen.
	// Confirmed in a Curator modal (a streaming playlist's removal hits the
	// live account), then the 10 s Undo toast is the way back.
	{
		id: 'remove-from-playlist', group: 'destructive', submenu: 'delete', danger: true, iconHtml: ICON_DELETE,
		isAvailable: (c) => any(c) && !!c.playlist,
		label: () => 'Delete from Playlist…',
		run: (c) => { void removeFromCurrentPlaylist(c); },
	},
];

// ── builder + entrypoint ─────────────────────────────────────────────────────

// The command's own predicate AND the remote-row gate — what the menu, the
// keyboard delegation and a future button surface all ask.
function commandAvailable(c: TrackCommand, ctx: TrackSelectionContext): boolean {
	return c.isAvailable(ctx) && !(c.device && anyRemoteRow(ctx.tracks));
}

// Derive the menu (items + handler map) for a selection by filtering the command
// table. Pure + sync — a button surface can reuse the same `isAvailable` filter.
export function buildTrackMenu(ctx: TrackCommandContext): { items: ContextMenuItem[]; handlers: ContextMenuHandlers } {
	const items: ContextMenuItem[] = [
		{ kind: 'header', label: single(ctx) ? ctx.tracks[0]!.title : `${ctx.tracks.length} tracks selected` },
	];
	const handlers: ContextMenuHandlers = {};
	const remote = anyRemoteRow(ctx.tracks);
	const explained = (c: TrackCommand): boolean => remote && c.device === 'explain';
	const leaf = (c: TrackCommand): ContextMenuItem => {
		const icon = typeof c.iconHtml === 'function' ? c.iconHtml(ctx) : c.iconHtml;
		// No handler and no mnemonic: a disabled item never dispatches.
		if (explained(c)) return { kind: 'item', id: c.id, label: c.label!(ctx), iconHtml: icon, disabled: true, title: REMOTE_ONLY_REASON, chip: 'Other device' };
		handlers[c.id] = () => c.run!(ctx);
		return { kind: 'item', id: c.id, label: c.label!(ctx), iconHtml: icon, danger: c.danger, mnemonic: c.mnemonic };
	};
	let emittedGroup = false;
	for (const group of GROUP_ORDER) {
		const cmds = TRACK_COMMANDS.filter((c) => c.group === group && (commandAvailable(c, ctx) || explained(c)));
		if (cmds.length === 0) continue;
		if (emittedGroup) items.push({ kind: 'divider' });
		// Submenu rows are placed where their first available child sits.
		const subs = new Map<SubmenuKey, ContextMenuItem[]>();
		for (const c of cmds) {
			if (c.submenu) {
				let children = subs.get(c.submenu);
				if (!children) {
					children = [];
					subs.set(c.submenu, children);
					const { label, iconHtml } = SUBMENUS[c.submenu];
					items.push({ kind: 'submenu', id: `sub-${c.submenu}`, label, iconHtml, items: children });
				}
				children.push(leaf(c));
			} else if (c.build) {
				const built = c.build(ctx);
				items.push(built.item);
				Object.assign(handlers, built.handlers);
			} else {
				items.push(leaf(c));
			}
		}
		emittedGroup = true;
	}
	return { items, handlers };
}

// Open the unified track context menu. Pre-fetches the single-selection extras
// (tag membership for toggle labels; playlists for Drill Into) so the menu
// builds with correct labels on first paint — the same two awaits the old
// per-track menu did.
export async function showTrackMenu(evt: MouseEvent, base: TrackSelectionContext): Promise<void> {
	if (base.tracks.length === 0) return;
	const ctx: TrackCommandContext = { ...base };
	if (base.tracks.length === 1) {
		const id = base.tracks[0]!.id;
		const [tagIds, drillPlaylists] = await Promise.all([
			tracksApi.tags(id).catch(() => [] as string[]),
			tracksApi.playlists(id).catch(() => [] as TrackPlaylistEntry[]),
		]);
		ctx.tagIds = new Set(tagIds);
		ctx.drillPlaylists = drillPlaylists;
	}
	const { items, handlers } = buildTrackMenu(ctx);
	openContextMenu(items, handlers, { at: evt });
}

// ── keyboard delegation ──────────────────────────────────────────────────────
// The keyboard shortcuts (main.ts `tracks.edit/rate/removeFromPlaylist/delete`) share their gating
// and behavior with the menu by routing through the table: a command's `when`
// consults trackCommandAvailable and its `run` calls runTrackCommand, so there's
// one definition per action. The single-selection extras (tagIds/drillPlaylists)
// aren't needed — no keyboard-bound command reads them.
export function trackCommandAvailable(id: string, sel: TrackSelectionContext): boolean {
	const cmd = TRACK_COMMANDS.find((c) => c.id === id);
	return !!cmd && commandAvailable(cmd, sel);
}
export function runTrackCommand(id: string, sel: TrackSelectionContext): boolean {
	const cmd = TRACK_COMMANDS.find((c) => c.id === id);
	if (!cmd || !commandAvailable(cmd, sel)) return false;
	void cmd.run?.(sel);
	return true;
}

// ── destructive flows (shared with the keyboard Delete / Shift+Delete) ───────

async function removeFromCurrentPlaylist(c: TrackCommandContext): Promise<void> {
	const pl = c.playlist;
	if (!pl || c.tracks.length === 0) return;
	const confirmed = await deps.confirm({
		title: 'Remove from playlist',
		message: c.tracks.length === 1
			? `Remove “${c.tracks[0]!.title}” from “${pl.name}”?`
			: `Remove ${c.tracks.length} tracks from “${pl.name}”?`,
		note: REMOVE_NOTE[pl.source] ?? 'The tracks stay in your library.',
		confirmLabel: 'DELETE',
		danger: true,
	});
	if (!confirmed) return;
	const idSet = new Set(idsOf(c));
	const ok = await deps.removeTracksFromPlaylist(pl.id, [...idSet]);
	if (!ok) return;
	// commitPlaylistChanges already spliced the rows out of the visible list;
	// prune them from the selection (anchor follows if it went).
	const remaining = [...deps.getSelectedTrackIds()].filter((id) => !idSet.has(id));
	const anchor = deps.getSelectionAnchor();
	deps.setTrackSelection(remaining, anchor && !idSet.has(anchor) ? anchor : remaining[0] ?? null);
}

// Where a playlist removal lands beyond Curator. Streaming pushes are subject
// to the write-sync setting, hence "can".
const REMOVE_NOTE: Partial<Record<Playlist['source'], string>> = {
	spotify: 'The tracks stay in your library. This can also change the playlist on your live Spotify account.',
	tidal: 'The tracks stay in your library. This can also change the playlist on your live Tidal account.',
	rekordbox: 'The tracks stay in your library. Run Sync to Rekordbox to push the change.',
};

const SOURCE_LABEL: Record<RemovableTrackSource, string> ={ local: 'Local file', spotify: 'Spotify', tidal: 'Tidal', rekordbox: 'Rekordbox' };
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

// Library delete: the Curator dialog picks which sources go, core strips
// exactly those (tombstoning only rows that lost every source), then the
// local caches mirror it — tombstoned rows leave the list, survivors get
// their SRC pips patched in place.
export async function deleteTracksWithDialog(tracks: readonly Track[]): Promise<void> {
	if (tracks.length === 0) return;
	const sources = await deps.openDeleteTracksDialog([...tracks]);
	if (!sources || sources.length === 0) return;
	const ids = tracks.map((t) => t.id);
	try {
		const res = await tracksApi.removeSources(ids, sources);
		const gone = new Set(res.tombstonedTrackIds);
		if (gone.size > 0) {
			// Snapshot the playlist base BEFORE splice — deleting the min row
			// shifts the visible base up. Infinity outside a playlist view →
			// compaction no-op.
			const base = deps.currentPlaylistPositionBase();
			deps.setMainTracksUnfiltered(deps.getMainTracksUnfiltered().filter((t) => !gone.has(t.id)));
			tracksData.removeMany(gone);
			if (Number.isFinite(base)) deps.compactCurrentPlaylistPositions(base);
			deps.applyFilterToMainList();
			const remaining = [...deps.getSelectedTrackIds()].filter((id) => !gone.has(id));
			const anchor = deps.getSelectionAnchor();
			deps.setTrackSelection(remaining, anchor && !gone.has(anchor) ? anchor : remaining[0] ?? null);
		}
		for (const row of res.updated) {
			const cached = tracksData.get(row.id);
			if (cached) {
				cached.sources = row.sources;
				deps.getMainTrackList()?.patchOne(cached);
			}
		}
		// A survivor may have lost the source the current tab lists (or left
		// the playlist on screen) — re-run the scope query so it drops out.
		if (res.updated.length > 0) await deps.renderTracks();
		void deps.refreshPlaylistsForSyncView();
		await deps.refreshAll();

		const removed = sources.map((s) => SOURCE_LABEL[s]).join(' / ');
		const title = gone.size > 0
			? `Deleted ${plural(gone.size, 'track')}`
			: `Removed ${removed} from ${plural(tracks.length, 'track')}`;
		const parts: string[] = [];
		if (gone.size > 0 && res.updated.length > 0) parts.push(`${removed} removed from ${res.updated.length} more`);
		if (res.filesTrashed > 0) parts.push(`${plural(res.filesTrashed, 'file')} trashed`);
		for (const src of ['spotify', 'tidal'] as const) {
			const n = res.playlistsTouched[src];
			if (n > 0) parts.push(`${n} ${SOURCE_LABEL[src]} playlist${n === 1 ? '' : 's'} updated`);
		}
		if (res.rekordboxTombstoned > 0 || res.playlistsTouched.rekordbox > 0) parts.push('run Sync to Rekordbox to push');
		if (res.followedKept > 0) parts.push(`kept in ${plural(res.followedKept, 'followed playlist')}`);
		if (res.errors.length > 0) {
			log.for('tracks:delete').warn('partial errors', { errors: res.errors });
			showToast(`${title} · ${plural(res.errors.length, 'issue')}`, { sub: res.errors[0]?.message, kind: 'info', durationMs: 6000 });
		} else {
			showToast(title, { sub: parts.join(' · ') || undefined, kind: 'success', durationMs: 4500 });
		}
	} catch (err) {
		showToast('Delete failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	}
}

async function undeleteTracks(tracks: readonly Track[]): Promise<void> {
	try {
		const { restored } = await tracksApi.undelete(tracks.map((t) => t.id));
		await deps.renderTracks();
		await deps.refreshAll();
		showToast(restored.length > 0 ? `Restored ${plural(restored.length, 'track')}` : 'Nothing to restore', { kind: restored.length > 0 ? 'success' : 'info' });
	} catch (err) {
		showToast('Restore failed', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	}
}

// ── AI engine commands ───────────────────────────────────────────────────────

async function analyzeWithEngine(ids: string[]): Promise<void> {
	try {
		const { queued } = await mirApi.analyzeNow(ids);
		showToast(queued === 1 ? 'Analyzing with AI engine' : `Analyzing ${queued} tracks with AI engine`, { kind: 'info' });
	} catch (err) {
		showToast('AI engine unavailable', { sub: err instanceof Error ? err.message : String(err), kind: 'error', durationMs: 6000 });
	}
}

// Probe the engine for which of `tracks` have vectors. Returns false (after
// telling the user why and queuing local ones for analysis) when none do —
// a seed without a vector can't rank anything.
async function ensureAnalyzed(tracks: Track[], retryLabel: string): Promise<boolean> {
	const ids = tracks.map((t) => t.id);
	let missing: string[] = [];
	try {
		missing = (await mirApi.similar({ seeds: ids, k: 1 })).missingSeeds;
	} catch (err) {
		log.for('mir').warn('similarity probe failed', { err: String(err) });
	}
	if (missing.length === ids.length) {
		const local = tracks.filter(hasLocal).map((t) => t.id);
		if (local.length === 0) {
			showToast('No AI analysis for this track', { sub: 'The AI engine analyzes local audio files; streaming-only tracks have none.', kind: 'info', durationMs: 5000 });
			return false;
		}
		await analyzeWithEngine(local);
		showToast('Not analyzed yet', { sub: `Queued for the AI engine — try ${retryLabel} again in a few seconds.`, kind: 'info', durationMs: 5000 });
		return false;
	}
	if (missing.length > 0) {
		showToast(`${missing.length} of ${ids.length} tracks not analyzed yet`, { sub: 'Ranking by the analyzed ones.', kind: 'info' });
	}
	return true;
}

async function findSimilar(c: TrackCommandContext): Promise<void> {
	if (!(await ensureAnalyzed(c.tracks, 'Find Similar'))) return;
	const ids = idsOf(c);
	const name = single(c) ? `Similar: ${c.tracks[0]!.title}` : `Similar to ${ids.length} tracks`;
	await deps.enterJitScope({ name, query: `similar={${ids.join(',')}}` });
}

// Seeds of the similarity scope on screen, or null when the tracklist isn't
// showing one. A text-only `sounds:` scope is a similarity scope with no
// seeds yet ([]).
function similaritySeeds(c: TrackCommandContext): string[] | null {
	if (!c.jit) return null;
	const st = extractSqlPrefilter(parseQuery(c.jit.query)).similarTo;
	return st ? (st.seeds ?? []) : null;
}

// Mirrors ZTrackFilter.similarTo.seeds' cap (packages/shared/src/types.ts).
const MAX_SIMILAR_SEEDS = 50;

async function addToSimilarityMatch(c: TrackCommandContext): Promise<void> {
	const seeds = similaritySeeds(c);
	if (!seeds || !c.jit) return;
	const added = c.tracks.filter((t) => !seeds.includes(t.id));
	if (added.length === 0) return;
	if (seeds.length + added.length > MAX_SIMILAR_SEEDS) {
		showToast('Similarity match is full', { sub: `Up to ${MAX_SIMILAR_SEEDS} seed tracks.`, kind: 'info' });
		return;
	}
	if (!(await ensureAnalyzed(added, 'Add to Similarity Match'))) return;
	// Append a term rather than rewriting the query: the current scope's other
	// terms (a sounds: description, bpm bounds) carry over, and the grammar
	// unions seeds across similar: terms.
	const query = `${c.jit.query} similar={${added.map((t) => t.id).join(',')}}`;
	const total = seeds.length + added.length;
	const name = `Similar to ${total} track${total === 1 ? '' : 's'}`;
	await deps.enterJitScope({ name, query });
}

