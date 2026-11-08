// DiscoverView — the Discover feed surface (planning/prds/discover-core.md).
//
// A vertically-scrolling list of feed cards (tracks, albums) fetched page
// by page from feed.db via the feed:* IPC channels. The component owns
// feed state (items, cursor, expanded album details); playback and the
// tag/playlist pickers are delegated to main.ts through callbacks so the
// existing player + dialog plumbing is reused unchanged.
//
// Perf shape: pagination + content-visibility:auto on cards (CSS) keeps
// offscreen cards unpainted. Full virtualization is deferred until feeds
// get big enough to need it — items arrive 50 at a time, so the DOM grows
// only as fast as the user actually scrolls.

import { For, Show, createSignal, createEffect, createRoot, type JSX } from 'solid-js';
import { render } from 'solid-js/web';
import type { FeedItem, FeedItemDetail, FeedTrackRef, FeedSuppressionScope, FeedOrigin, EnrichStatus, JourneySeed, FeedLens, FeedRefreshKind, FeedRefreshResult, FeedRefreshScope } from '@curator/core';
import { openContextMenu, type ContextMenuItem } from './ContextMenu.jsx';
import { ArtistCredits } from './ArtistCredits.jsx';
import { searchFold } from '@curator/shared';
import { buildFeedMenu, feedShow, spotifyPlaylistOrigin, type FeedActions } from '../features/feedCommands.js';
import { BRAND_ICONS, BRAND_ORDER, brandIcon } from '../features/brandIcons.js';
import { discoverSettingsSignal } from '../features/discoverSettings.js';
import { library } from '../data/library.js';
import { KeyChip } from './KeyChip.jsx';
import { catalogApi, shellApi } from '../data/api.js';
import { FollowingPanel } from './FollowingPanel.jsx';
import { ManageFollowingModal } from './ManageFollowingModal.jsx';
import { registerModalOpenSignal } from '../modalGate.js';
import { cardPlayable, isSpotifyArtistId, playableId, providerLabel, storeLinks } from '../features/feedHandles.js';

// The Refresh menu's words for the follow kinds.
const KIND_TITLES: Record<FeedRefreshKind, string> = { artist: 'Artists', label: 'Labels', playlist: 'Playlists', genre: 'Genres' };
const KIND_WORDS: Record<FeedRefreshKind, string> = { artist: 'artists', label: 'labels', playlist: 'playlists', genre: 'genres' };
import { feedRefresh } from '../data/feedRefreshStatus.js';
import { ACTIVITY_TEXT, feedActivity } from '../data/feedActivity.js';
import { progressBody, resultBody } from '../features/feedRefreshText.js';
import type { ProgressToast } from '../ui/toast.js';

// The feed's navigable state — what a history entry records for it. The
// standing lenses are settings, not navigation, so Back never revokes one.
export interface DiscoverFeedNavState {
	archived: boolean;
}

export interface DiscoverViewProps {
	// A feed navigation the view is about to apply itself (Feed ↔ Archived):
	// the target state, reported BEFORE the reload so
	// main.ts can snapshot the view being left onto its history entry.
	onNavigate?: (next: DiscoverFeedNavState) => void;
	onPlay: (req: {
		itemId: string;
		sourceTrackId: string;
		title: string;
		artist: string;
		// Credit names beside the flat string — the now-playing surfaces
		// render one clickable name per artist from these.
		artists: string[];
		coverUrl: string | null;
		durationSec: number | null;
	}) => void | Promise<void>;
	// Toggle play/pause on the player (Space-equivalent). The cover disc calls
	// this when the card is the loaded feed track, so a playing card pauses
	// rather than restarting.
	onTogglePause: () => void;
	// Open the unified Organize modal on tracks that already live in the library
	// (owned feed tracks, and the "Interested + Organize" path once promoted).
	onOpenOrganize: (trackIds: string[]) => void;
	// Open Organize for a not-yet-owned feed track WITHOUT promoting it up front.
	// `promote` runs on the modal's first membership write (creates the unpinned
	// row, returns its curator id); `rollback` undoes it if the modal is closed
	// with nothing applied. Keeps a cancelled Organize from leaving an orphan row.
	onOpenOrganizeDeferred: (session: {
		promote: () => Promise<string>;
		rollback: (trackId: string) => Promise<void>;
	}) => void;
	onToast: (msg: string, kind: 'info' | 'error' | 'success', sub?: string) => void;
	// A toast that stays while a refresh runs and then becomes its result
	// (ui/toast.ts showProgressToast).
	onProgressToast: (title: string, sub?: string) => ProgressToast;
	// Start a discovery journey from a feed track — main.ts flips Discover
	// into Journeys mode and creates the journey from the seed.
	onStartJourney: (seed: JourneySeed) => void;
	// "Show in library" on an artist name — main.ts resolves the name against
	// the library's artist table and opens the "Artist: X" scope.
	onShowArtistInLibrary: (name: string) => void;
	// The playlist name on a "New on <playlist> by <profile>" line — main.ts
	// opens the followed playlist under the Spotify tab (it is synced into
	// the library), or the Spotify app when the library has no row for it yet.
	onOpenSpotifyPlaylist: (spotifyPlaylistId: string) => void;
	// Keeps the Discover tab chip in sync with the visible-item count.
	onTotalChange: (total: number) => void;
	// Seconds the playhead must reach before a track counts as "listened" — the
	// gate that flips an item to played (lenient: seeking there counts). A getter
	// so a Settings change takes effect without remounting Discover.
	listenThresholdSec: () => number;
	// True when the given source track is what the player is audibly playing
	// right now — drives dismiss-advances-playback (dismissing the playing
	// card should not leave silence).
	isCurrentlyPlaying: (sourceTrackId: string) => boolean;
}

export interface DiscoverViewHandle {
	destroy(): void;
	refresh(): void;
	// Natural end-of-track continuation: next track within the playing
	// album, else the next playable feed item. Wired to the player's
	// feed-advance handler in main.ts.
	playNext(): void;
	// A play attempt found the track region-unavailable (403 + is_playable:false
	// probe in player.ts). Persist the flag, dim the row, and skip ahead. Wired
	// to the feed onPlay error handler in main.ts.
	markUnavailable(itemId: string, sourceTrackId: string): void;
	// Reflect what the player is currently holding (feed-sourced track id, or
	// null when nothing feed-related is loaded) so cards + nested rows can paint
	// the now-playing accent. Driven by a player.subscribe in main.ts.
	setNowPlaying(sourceTrackId: string | null): void;
	// Playback-progress tick (position in seconds + whether audio is running)
	// for the now-playing feed track. Drives the "listened" gate: a track flips
	// to played once the playhead reaches listenThresholdSec. Fed at the
	// player's poll rate by a player.subscribe in main.ts.
	notePlayback(positionSec: number, playing: boolean): void;
	// Open the feed context menu for the track the player is currently playing
	// from the feed. No-op (returns false) unless a feed track is what's playing
	// — main.ts wires it to a right-click on the docked Discover player strip.
	openPlayingTrackMenu(evt: MouseEvent): boolean;
	// The standing lenses (id + chip label) — captured into the agent's view
	// context so "drop that filter" can name one.
	getLenses(): { id: string; label: string }[];
	// History: the feed's navigable state, and applying one (traversal / tab
	// re-entry). `reload` re-fetches page 1; a traversal onto the state the
	// feed already shows passes false and keeps the list + scroll as they are.
	getNavState(): DiscoverFeedNavState;
	applyNavState(next: DiscoverFeedNavState, opts: { reload: boolean }): void;
	getScrollTop(): number;
	setScrollTop(n: number): void;
}

function fmtDuration(sec: number | null | undefined): string {
	if (!sec || sec <= 0) return '';
	const m = Math.floor(sec / 60);
	const s = Math.round(sec % 60);
	return `${m}:${String(s).padStart(2, '0')}`;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Format a feed item's date (epoch ms) for the bottom-left date field, per the
// Discover date rules — coarse-to-fine as the item ages:
//   < 2 weeks  → "{n} days"  (0 → "today", 1 → "1 day")
//   < 2 months → "{n} weeks"
//   this year  → "{Mon}"
//   older      → "{Mon} {YYYY}"
// `title` is the full date for the tooltip. The source date is `publishedAt`,
// which already encodes the right notion per producer: the release date for new
// releases, the added-to-playlist date for followed playlists (spotify-producers.ts).
function fmtFeedDate(epochMs: number): { label: string; title: string } {
	const d = new Date(epochMs);
	const now = new Date();
	const title = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
	const days = Math.floor((now.getTime() - epochMs) / 86_400_000);
	let label: string;
	if (days < 14) {
		label = days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
	} else if (days < 60) {
		label = `${Math.floor(days / 7)} weeks`;
	} else if (d.getFullYear() === now.getFullYear()) {
		label = SHORT_MONTHS[d.getMonth()]!;
	} else {
		label = `${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
	}
	return { label, title };
}

// "Added <when>" on a followed-playlist card — the same coarse-to-fine
// steps as fmtFeedDate, worded as a relative time ("3 days ago"); past two
// months, the plain date.
function fmtAddedWhen(epochMs: number): string {
	const d = new Date(epochMs);
	const now = new Date();
	const days = Math.floor((now.getTime() - epochMs) / 86_400_000);
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 14) return `${days} days ago`;
	if (days < 60) { const w = Math.floor(days / 7); return w === 1 ? '1 week ago' : `${w} weeks ago`; }
	const md = `${SHORT_MONTHS[d.getMonth()]} ${d.getDate()}`;
	return d.getFullYear() === now.getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

// A source's release date ("YYYY-MM-DD" / "YYYY-MM" / "YYYY" — Spotify's
// precision varies) as "Oct 31, 2026" / "Oct 2026" / "2026". null when the
// string is not a date at all.
function fmtReleaseDate(raw: string | null | undefined): string | null {
	const m = raw?.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
	if (!m) return null;
	const [, y, mo, d] = m;
	const mon = mo ? SHORT_MONTHS[Number(mo) - 1] : undefined;
	if (!mon) return y!;
	return d ? `${mon} ${Number(d)}, ${y}` : `${mon} ${y}`;
}

// Every service the item is known on, with the page to open there: the
// item's own source, the catalogue's handles and the store the desktop's
// enrichment matched (where BPM/key came from). Only providers with a brand
// mark, in display order. A Tidal-sourced item has no page URL to hand the
// browser (the player owns it), so it shows the mark without a link.
function itemSources(item: FeedItem): { provider: string; url: string | null }[] {
	const urls = new Map<string, string | null>();
	const add = (provider: string, url: string | null | undefined): void => {
		if (!brandIcon(provider)) return;
		if (!urls.has(provider) || (!urls.get(provider) && url)) urls.set(provider, url ?? null);
	};
	if (item.source === 'spotify') add('spotify', item.payload.url ?? `https://open.spotify.com/${item.type === 'track' ? 'track' : 'album'}/${item.sourceId}`);
	if (item.source === 'tidal') add('tidal', null);
	for (const h of item.payload.handles ?? []) add(h.provider, h.url);
	for (const l of item.payload.sourceLinks ?? []) add(l.source, l.url);
	return BRAND_ORDER.filter((p) => urls.has(p)).map((p) => ({ provider: p, url: urls.get(p)! }));
}

// Attribution chip text: which follow brought this item.
function originLabel(item: FeedItem): string {
	const o = item.origin;
	if (!o) return '';
	switch (o.kind) {
		case 'playlist': return `new in ${o.name}`;
		case 'label': return `new on ${o.name}`;
		case 'genre': return o.rank ? `#${o.rank} in ${o.name}` : `charting in ${o.name}`;
		default: return `new release · ${o.name}`;
	}
}

const ORIGIN_PREFIX: Partial<Record<FeedOrigin['kind'], string>> = { artist: 'Artist: ', label: 'Label: ', genre: 'Genre: ' };

// Tooltip body for the "+N sources" badge — every follow that surfaced the
// item, one per line (kinds prefixed so a mixed list reads clearly).
function sourcesTooltip(item: FeedItem): string {
	const list = item.sources ?? (item.origin ? [item.origin] : []);
	const lines = list.map((o) => `${ORIGIN_PREFIX[o.kind] ?? ''}${o.name}`);
	return ['Sources:', ...lines].join('\n');
}

// Short marker for an enrichment outcome that produced no DJ metadata: 'na'
// (Beatport had no match — terminal) → "N/A"; 'err' (the lookup failed — the
// drain will retry) → "ERR". Returns '' for 'ok'/null (metadata shown, or not
// attempted yet) so the caller renders nothing.
function enrichMarker(status: EnrichStatus | null | undefined): string {
	return status === 'na' ? 'N/A' : status === 'err' ? 'ERR' : '';
}

// Sample a cover's left edge into a smooth vertical CSS gradient, used as each
// card's left "spine". Drawing the left ~4px strip downscaled to 1×ROWS
// averages it (the smoothing); the gradient stops then interpolate (the
// stretch). Best-effort + cheap; returns null on a load failure or a
// CORS-tainted canvas, so the caller renders no spine.
// Sampled gradients by cover URL — module-level so remounting the view (tab
// switches) doesn't refetch/redraw covers already sampled this session.
const spineCache = new Map<string, Promise<string | null>>();

async function sampleLeftEdgeGradient(url: string): Promise<string | null> {
	try {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		img.src = url;
		await img.decode();
		const w = img.naturalWidth, h = img.naturalHeight;
		if (!w || !h) return null;
		const ROWS = 20;
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = ROWS;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return null;
		const strip = Math.max(1, Math.min(w, 4));
		ctx.drawImage(img, 0, 0, strip, h, 0, 0, 1, ROWS);
		const data = ctx.getImageData(0, 0, 1, ROWS).data;
		const stops: string[] = [];
		for (let r = 0; r < ROWS; r++) {
			const i = r * 4;
			const pct = Math.round((r / (ROWS - 1)) * 100);
			stops.push(`rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]}) ${pct}%`);
		}
		return `linear-gradient(to bottom, ${stops.join(', ')})`;
	} catch {
		return null;
	}
}

export function mountDiscoverView(host: HTMLElement, props: DiscoverViewProps): DiscoverViewHandle {
	const [items, setItems] = createSignal<FeedItem[]>([]);
	const [nextCursor, setNextCursor] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [refreshing, setRefreshing] = createSignal(false);
	// Any pass in flight, whoever started it (data/feedRefreshStatus.ts).
	const passRunning = (): boolean => feedRefresh.status().pass !== null;
	const [total, setTotal] = createSignal(0);
	// Standing lenses (core feed/lenses.ts): stored in the synced setting
	// feed.lenses and applied by core to every page, so the renderer only
	// shows them as chips and reloads when they change. The genre/label
	// dropdowns are how the user adds those two kinds; options come from
	// feed:filter-options (distinct values across the visible feed).
	const [lenses, setLenses] = createSignal<FeedLens[]>([]);
	const lensValue = (kind: 'genre' | 'label'): string | null => {
		const r = lenses().find((l) => l.rule.kind === kind && !l.inert)?.rule;
		return r && (r.kind === 'genre' || r.kind === 'label') ? r.value : null;
	};
	const [filterOptions, setFilterOptions] = createSignal<{ genres: string[]; labels: string[] }>({ genres: [], labels: [] });
	// 'feed' = the live Discover feed; 'archived' = the set-aside list. The
	// same card list/pager serves both, switching the source channel.
	const [mode, setMode] = createSignal<'feed' | 'archived'>('feed');
	// Who collects the feed (core feed/sync.ts): on a follower — another
	// device is the account's master — no producer runs, so Refresh and Load
	// more are hidden and the view says where the feed comes from. Read on
	// mount and on every refresh (a master switch flips it).
	const [follower, setFollower] = createSignal(false);
	const loadRole = (): void => {
		void window.api['feed:role']().then((r) => setFollower(r.role === 'follower')).catch(() => setFollower(false));
	};
	loadRole();
	// Following (the Global Catalog's watches): the cloud tracks followed
	// artists and labels for every device, so with it a follower device
	// refreshes too (it reads the cloud's stream; core feed/service.ts).
	const [catalogAvailable, setCatalogAvailable] = createSignal(false);
	const [showFollowing, setShowFollowing] = createSignal(false);
	const [followCount, setFollowCount] = createSignal<number | null>(null);
	const [manageOpen, setManageOpen] = createSignal(false);
	// Bumped when Manage following changed the follows: the drawer reloads.
	const [followVersion, setFollowVersion] = createSignal(0);
	registerModalOpenSignal(manageOpen);
	const loadCatalog = (): void => {
		void catalogApi.status().then((s) => {
			setCatalogAvailable(s.available);
			if (s.available) void catalogApi.watches().then((w) => setFollowCount(w.length)).catch(() => {});
		}).catch(() => setCatalogAvailable(false));
	};
	loadCatalog();
	// itemId → detail for expanded album cards (null while loading).
	const [expanded, setExpanded] = createSignal<Map<string, FeedItemDetail | null>>(new Map());
	// sourceTrackIds confirmed region-unavailable. Seeded from the server flag
	// (track items: FeedItem.unavailable; album tracks: detail.unavailable…) and
	// extended live by play failures. Keyed by source track id — global, matching
	// feed.db — so a track dims wherever it appears.
	const [unavailableTracks, setUnavailableTracks] = createSignal<Set<string>>(new Set());
	function noteUnavailable(ids: readonly string[]): void {
		if (ids.length === 0) return;
		setUnavailableTracks((prev) => {
			let next: Set<string> | null = null;
			for (const id of ids) if (!prev.has(id)) (next ??= new Set(prev)).add(id);
			return next ?? prev;
		});
	}
	const isUnavailable = (stid: string): boolean => unavailableTracks().has(stid);
	// Next album track auto-advance may roll into: skip region-unavailable tracks
	// and tracks whose artist the user muted (`muted` = the detail's
	// mutedSourceTrackIds). Muted rows stay manually playable — just not
	// auto-played-into.
	// Rows no player here can play (a catalogue track not on Spotify yet) are
	// skipped too.
	const firstPlayableTrack = (item: FeedItem, tracks: readonly FeedTrackRef[], muted?: ReadonlySet<string>): FeedTrackRef | undefined =>
		tracks.find((t) => playableId(item, t) !== null && !isUnavailable(t.sourceTrackId) && !muted?.has(t.sourceTrackId));
	let loadedOnce = false;
	// A reset requested while a page load is in flight (first mount + an
	// immediate history apply) runs once that load settles instead of being
	// dropped on the floor.
	let reloadQueued = false;
	let scrollEl: HTMLDivElement | undefined;
	// What the feed last handed to the player — dismissing THIS item should
	// advance playback to the next feed item instead of leaving silence. A
	// signal so the now-playing highlight on album cards reacts as the active
	// track moves between an album's nested rows. Carries the FeedItem (and the
	// nested track ref, for album plays) so the docked-player right-click menu can
	// rebuild even after a list reset (filter / Archived / Refresh) dropped the
	// item from the visible window mid-audition.
	const [lastPlayed, setLastPlayed] = createSignal<{ itemId: string; sourceTrackId: string; item: FeedItem; track?: FeedTrackRef } | null>(null);
	// The source track the player is currently holding from the feed — pushed
	// in by main.ts via the handle (player state lives outside this component).
	// Drives the now-playing accent on track cards + nested rows; album cards
	// derive theirs by matching this against lastPlayed.
	const [nowPlaying, setNowPlaying] = createSignal<string | null>(null);
	// Whether the loaded feed track is actually advancing (vs paused). Fed by
	// notePlayback; drives the cover play/pause glyph and freezes the eq chip.
	const [audiblyPlaying, setAudiblyPlaying] = createSignal(false);

	// Keep the visible window stocked: top up the next page when dismissals
	// thin the loaded list out, so the user never scrolls into a dead end.
	const LOW_WATERMARK = 15;

	// "Load more" horizon step — how many days of history each click pulls.
	// Persisted; the selector at the end of the list is the Discover setting.
	const LOAD_MORE_DAYS_KEY = 'curator.discover.loadMoreDays';
	const loadStoredDays = (): number => {
		try {
			const v = Number(localStorage.getItem(LOAD_MORE_DAYS_KEY));
			return [3, 7, 14, 30].includes(v) ? v : 7;
		} catch { return 7; }
	};
	const [loadMoreDays, setLoadMoreDays] = createSignal(loadStoredDays());
	const [loadingMore, setLoadingMore] = createSignal(false);

	function setDaysSetting(days: number): void {
		setLoadMoreDays(days);
		try { localStorage.setItem(LOAD_MORE_DAYS_KEY, String(days)); } catch { /* private mode */ }
	}

	async function loadPage(reset: boolean): Promise<void> {
		if (loading()) { if (reset) reloadQueued = true; return; }
		setLoading(true);
		try {
			const base = { cursor: reset ? null : nextCursor(), limit: 50 };
			const page = mode() === 'archived'
				? await window.api['feed:archived-page'](base)
				: await window.api['feed:get-page'](base);
			// Skip ids already on screen: a re-ranked item (new source accrued →
			// order_ts lifted) can cross the keyset cursor between page loads.
			const have = reset ? null : new Set(items().map((i) => i.id));
			setItems(have ? [...items(), ...page.items.filter((i) => !have.has(i.id))] : page.items);
			// The lazy fill: a card without a Spotify id is matched on Spotify as
			// the page lands (core feed:fill, one at a time; a settled item spends
			// nothing). The expand path fills the rest.
			queueFills(page.items.filter((i) => i.source === 'catalog' && (i.matchStatus === null || i.matchStatus !== 'ok')).map((i) => i.id));
			noteUnavailable(page.items.filter((i) => i.type === 'track' && i.unavailable).map((i) => i.sourceId));
			setNextCursor(page.nextCursor);
			setTotal(page.total);
			// Only the live feed drives the Discover tab chip — the archived
			// count must not overwrite it.
			if (mode() === 'feed') props.onTotalChange(page.total);
		} catch (err) {
			props.onToast('Feed load failed', 'error', err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
			if (reloadQueued) { reloadQueued = false; void loadPage(true); }
		}
	}

	// Fills asked for by page loads, run one after another (core serialises
	// them too; this keeps the IPC quiet). The result folds onto the card the
	// way a live enrichment push does.
	const fillQueue: string[] = [];
	const fillQueued = new Set<string>();
	let filling = false;
	function queueFills(ids: string[]): void {
		for (const id of ids) if (!fillQueued.has(id)) { fillQueued.add(id); fillQueue.push(id); }
		if (filling) return;
		filling = true;
		void (async () => {
			try {
				for (let id = fillQueue.shift(); id !== undefined; id = fillQueue.shift()) {
					fillQueued.delete(id);
					if (!items().some((i) => i.id === id)) continue;
					try {
						const updated = await window.api['feed:fill'](id, { enrich: false });
						if (updated) applyEnriched(updated);
					} catch { /* best effort: the card keeps its store links */ }
				}
			} finally {
				filling = false;
			}
		})();
	}

	function ensureLoaded(): void {
		if (loadedOnce) return;
		loadedOnce = true;
		void loadPage(true);
		void loadFilterOptions();
		void loadLenses();
	}

	async function loadLenses(): Promise<void> {
		try {
			setLenses(await window.api['feed:lenses']());
		} catch { /* no chips; the page still applies whatever core holds */ }
	}

	// A lens change from anywhere (a chip here, the assistant, another device):
	// redraw the chips and reload page 1 — the keyset cursor is lens-specific.
	// Our own writes come back as an event too; an identical list is skipped.
	function lensesChanged(next: FeedLens[]): void {
		if (JSON.stringify(next) === JSON.stringify(lenses())) return;
		setLenses(next);
		if (mode() === 'feed') void loadPage(true);
	}

	async function changeLenses(op: () => Promise<FeedLens[]>, what: string): Promise<void> {
		try {
			lensesChanged(await op());
		} catch (err) {
			props.onToast(`Couldn’t ${what}`, 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Refresh the genre/label dropdown options. Cheap (two DISTINCT queries);
	// called on first load and after ingest/enrichment grows the value set.
	async function loadFilterOptions(): Promise<void> {
		try {
			setFilterOptions(await window.api['feed:filter-options']());
		} catch { /* leave existing options */ }
	}

	// A dropdown pick becomes that kind's lens (replacing it); "All …" removes it.
	function pickFilter(kind: 'genre' | 'label', value: string | null): void {
		if (value) {
			void changeLenses(() => window.api['feed:add-lens']({ rule: { kind, value } }), `filter by ${kind}`);
			return;
		}
		const lens = lenses().find((l) => l.rule.kind === kind);
		if (lens) void changeLenses(() => window.api['feed:remove-lens'](lens.id), `clear the ${kind} filter`);
	}

	const navState = (): DiscoverFeedNavState => ({ archived: mode() === 'archived' });

	// A mode change is a history navigation: report the target state first
	// (props.onNavigate), then apply.
	function userSetViewMode(next: 'feed' | 'archived'): void {
		if (mode() === next) return;
		props.onNavigate?.({ ...navState(), archived: next === 'archived' });
		setViewMode(next);
	}

	// Live enrichment update: fold the freshly landed genre/label/bpm onto the
	// matching card without disturbing local state (seen/played/promotion). Only
	// patches an item already in the list — a dismissed/off-page item is ignored.
	function applyEnriched(updated: FeedItem): void {
		if (!items().some((i) => i.id === updated.id)) return;
		// The same push carries a lazy Spotify match: the row moved to source
		// 'spotify' with its id, so the card becomes playable in place.
		setItems(items().map((i) => i.id === updated.id
			? { ...i, source: updated.source, sourceId: updated.sourceId, payload: updated.payload, enrichStatus: updated.enrichStatus, enrichedAt: updated.enrichedAt, matchStatus: updated.matchStatus, matchedAt: updated.matchedAt }
			: i));
		// A newly surfaced genre/label should appear in the filter dropdowns.
		const { genre, label } = updated.payload;
		const opts = filterOptions();
		if ((genre && !opts.genres.includes(genre)) || (label && !opts.labels.includes(label))) void loadFilterOptions();
	}

	// The progress toasts of the manual passes whose calls are still out. Each
	// follows the scheduler's status (feed:refresh-status) until its call
	// returns: a pass can take minutes (a Spotify walk, a slow catalogue) and
	// was a silent wait before, with one toast at the very end.
	const passToasts = new Set<{ title: string; toast: ProgressToast }>();
	// A root of its own: the view's signals live outside the render root.
	const disposePassToasts = createRoot((dispose) => {
		createEffect(() => {
			const body = progressBody(feedRefresh.status());
			for (const t of passToasts) t.toast.update(t.title, body);
		});
		return dispose;
	});

	// One manual pass with its progress on screen: the toast opens with the
	// click, shows each source's step while the pass runs (or the background
	// pass it queued behind), then turns into the result. Null when the call
	// itself failed.
	async function runPass(opts: {
		title: string;
		call: () => Promise<FeedRefreshResult>;
		// The result's headline when every source went through.
		done: (inserted: number) => string;
		errors: string;
		failed: string;
	}): Promise<FeedRefreshResult | null> {
		const entry = { title: opts.title, toast: props.onProgressToast(opts.title, progressBody(feedRefresh.status())) };
		passToasts.add(entry);
		try {
			const res = await opts.call();
			const inserted = res.producers.reduce((n, p) => n + p.inserted, 0);
			const sub = resultBody(res);
			if (res.producers.some((p) => p.error)) {
				entry.toast.finish(opts.errors, { kind: 'error', sub, durationMs: 9000 });
			} else {
				// A per-source breakdown takes longer to read than one line.
				entry.toast.finish(opts.done(inserted), { kind: inserted > 0 ? 'success' : 'info', sub, durationMs: sub ? 6000 : undefined });
			}
			return res;
		} catch (err) {
			entry.toast.finish(opts.failed, { kind: 'error', sub: err instanceof Error ? err.message : String(err), durationMs: 9000 });
			return null;
		} finally {
			passToasts.delete(entry);
		}
	}

	// Refresh: the feed's producers now. With a scope (the Refresh menu's
	// "check now" rows), the catalogue is first asked to check the follows
	// of that kind on their checked sources — answered in seconds, read by
	// this computer's worker over the following minutes, the releases
	// landing in Discover as they are read (the tab pulses meanwhile).
	async function refreshProducers(scope?: FeedRefreshScope): Promise<void> {
		if (refreshing()) return;
		setRefreshing(true);
		const what = scope?.kind ? `your ${KIND_WORDS[scope.kind]}` : 'everything you follow';
		try {
			const res = await runPass({
				title: scope ? `Checking ${what}…` : 'Refreshing Discover…',
				call: () => window.api['feed:refresh'](scope),
				done: (n) => {
					if (n > 0) return `${n} new items`;
					if (scope) return `Check started — new releases land as they are read`;
					return 'Feed is up to date';
				},
				errors: 'Feed refresh finished with errors',
				failed: 'Feed refresh failed',
			});
			if (!res) return;
			if (scope && !res.producers.length) {
				props.onToast(`Nothing reads ${what} while signed out of Curator Cloud`, 'info');
			}
			await loadPage(true);
			void loadFilterOptions();
		} finally {
			setRefreshing(false);
		}
	}

	// The Refresh menu: a "check now" row per kind, each with its sources as
	// checkboxes — the user's tracking choices (core catalog-worker
	// /settings.ts). Unchecked means nobody reads that source for the user's
	// follows, this computer and the cloud alike.
	async function openRefreshMenu(anchor: HTMLElement): Promise<void> {
		let sources: Awaited<ReturnType<typeof catalogApi.readSources>>;
		try {
			sources = await catalogApi.readSources();
		} catch (err) {
			props.onToast('Could not read your tracking choices', 'error', err instanceof Error ? err.message : String(err));
			return;
		}
		const items: ContextMenuItem[] = [{ kind: 'header', label: 'Check now' }, { kind: 'item', id: 'check-all', label: 'Everything you follow', chip: 'check now', title: 'Make every follow due now on its checked sources' }];
		const handlers: Record<string, () => void | Promise<void>> = { 'check-all': () => refreshProducers({ check: true }) };
		const state = new Map<string, boolean>();
		for (const r of sources) {
			items.push({ kind: 'divider' }, { kind: 'item', id: `check-${r.kind}`, label: KIND_TITLES[r.kind], chip: 'check now', title: `Make your ${KIND_WORDS[r.kind]} due now on the checked sources` });
			handlers[`check-${r.kind}`] = () => refreshProducers({ check: true, kind: r.kind });
			for (const s of r.sources) {
				const key = `${r.kind}/${s.provider}`;
				state.set(key, s.checked);
				items.push({
					kind: 'check',
					id: `src-${key}`,
					label: providerLabel(s.provider),
					checked: s.checked,
					...(s.cloudOnly ? { chip: 'cloud' } : {}),
					title: s.cloudOnly
						? 'Only the cloud can read this source (its keys are the cloud’s). Unchecked, nobody reads it for your follows.'
						: 'Unchecked, nobody reads this source for your follows — not this computer, not the cloud.',
				});
				handlers[`src-${key}`] = async () => {
					const next = !state.get(key);
					state.set(key, next);
					try {
						await catalogApi.setReadSources({ [key]: next });
						setFollowVersion((v) => v + 1);
					} catch (err) {
						props.onToast('Could not save that choice', 'error', err instanceof Error ? err.message : String(err));
					}
				};
			}
		}
		items.push({ kind: 'divider' }, { kind: 'header', label: 'Unchecked sources are read by nobody. The computer reading for you this week decides.' });
		openContextMenu(items, handlers, { anchor, align: 'end', variant: 'popup' });
	}

	// "Load more" — move every producer's history horizon back by the
	// configured days, then continue pagination below the current tail
	// (older items land past the keyset cursor, so we re-derive it from
	// the last loaded row before pulling the next page).
	async function loadMoreHistory(): Promise<void> {
		if (loadingMore()) return;
		setLoadingMore(true);
		const days = loadMoreDays();
		try {
			const res = await runPass({
				title: `Loading ${days} more days…`,
				call: () => window.api['feed:load-more'](days),
				done: (n) => (n > 0 ? `${n} older items loaded` : `No items in the previous ${days} days`),
				errors: 'Load more finished with errors',
				failed: 'Load more failed',
			});
			if (!res) return;
			const last = items()[items().length - 1];
			if (last) setNextCursor(`${last.publishedAt ?? last.fetchedAt}|${last.id}`);
			await loadPage(items().length === 0);
		} finally {
			setLoadingMore(false);
		}
	}

	function removeItemLocally(itemId: string): void {
		setItems(items().filter((i) => i.id !== itemId));
		const t = Math.max(0, total() - 1);
		setTotal(t);
		if (mode() === 'feed') props.onTotalChange(t);
		if (items().length < LOW_WATERMARK && nextCursor() && !loading()) void loadPage(false);
	}

	// Switch between the live feed and the archived list — reset the pager and
	// reload from the matching channel.
	function setViewMode(next: 'feed' | 'archived'): void {
		if (mode() === next) return;
		setMode(next);
		setItems([]);
		setNextCursor(null);
		void loadPage(true);
	}

	// Walk forward from `idx` (the slot the dismissed item vacated) and
	// start the first playable thing: a track card plays directly; an album
	// card auto-expands and plays its first track.
	async function advanceFrom(idx: number): Promise<void> {
		const list = items();
		for (let i = Math.max(0, idx); i < list.length; i++) {
			const it = list[i]!;
			if (it.type === 'track') {
				if (isUnavailable(it.sourceId) || !playableId(it)) continue;
				await play(it);
				return;
			}
			if (it.type === 'album') {
				if (!cardPlayable(it)) continue;
				const det = await loadDetail(it);
				const first = firstPlayableTrack(it, det?.item.payload.tracks ?? [], new Set(det?.mutedSourceTrackIds));
				if (first) {
					await play(it, first);
					return;
				}
			}
		}
	}

	// Album play = first track. loadDetail also expands the card, so the
	// user sees the tracklist light up as it starts.
	async function playAlbum(item: FeedItem): Promise<void> {
		// Idempotent: if this album is already the one playing, don't restart it
		// from track 1 (e.g. double-clicking its cover/card while it plays).
		if (lastPlayed()?.itemId === item.id && nowPlaying()) return;
		if (!cardPlayable(item)) { notOnSpotify(item); return; }
		const det = await loadDetail(item);
		const first = firstPlayableTrack(item, det?.item.payload.tracks ?? [], new Set(det?.mutedSourceTrackIds));
		if (first) await play(item, first);
		else props.onToast('Album has no playable tracks', 'info');
	}

	// Natural end-of-track: continue inside the current album when there's
	// a next track; otherwise move on to the next feed item.
	async function playNextFromLast(): Promise<void> {
		const lp = lastPlayed();
		if (!lp) return;
		const list = items();
		const idx = list.findIndex((i) => i.id === lp.itemId);
		const item = idx >= 0 ? list[idx] : null;
		if (item && item.type === 'album') {
			const det = await loadDetail(item);
			const tracks = det?.item.payload.tracks ?? [];
			const ti = tracks.findIndex((t) => t.sourceTrackId === lp.sourceTrackId);
			const nextTrack = ti >= 0 ? firstPlayableTrack(item, tracks.slice(ti + 1), new Set(det?.mutedSourceTrackIds)) : undefined;
			if (nextTrack) {
				await play(item, nextTrack);
				return;
			}
		}
		// Item gone (dismissed/promoted mid-listen) → start from the top of
		// the loaded window; otherwise continue past the finished item.
		await advanceFrom(idx < 0 ? 0 : idx + 1);
	}

	// A play attempt confirmed the track is region-unavailable. Dim it locally,
	// persist the flag (global, by source track id), and continue past it if it
	// was the one we just tried to start.
	async function handleUnavailable(itemId: string, sourceTrackId: string): Promise<void> {
		noteUnavailable([sourceTrackId]);
		void window.api['feed:action']({ kind: 'unavailable', itemId, sourceTrackId });
		props.onToast('Track unavailable in your region — skipping', 'info');
		const lp = lastPlayed();
		if (lp && lp.sourceTrackId === sourceTrackId) await playNextFromLast();
	}

	async function dismiss(item: FeedItem, scope?: { scope: FeedSuppressionScope; key: string; label: string }): Promise<void> {
		const idx = items().findIndex((i) => i.id === item.id);
		const lp = lastPlayed();
		const wasPlaying = lp?.itemId === item.id && props.isCurrentlyPlaying(lp.sourceTrackId);
		removeItemLocally(item.id); // optimistic — soft remove server-side
		// Dismissing what's playing advances to the next feed item — fire
		// before the IPC roundtrip so the music gap stays minimal.
		if (wasPlaying) void advanceFrom(idx);
		try {
			const res = await window.api['feed:action']({
				kind: 'dismiss',
				itemId: item.id,
				scope: scope ? { scope: scope.scope, key: scope.key } : undefined,
			});
			if (!res.ok) throw new Error(res.error ?? 'delete failed');
			if (scope) {
				props.onToast(`Muted ${scope.label}`, 'info');
				// Scoped dismiss suppresses siblings server-side — reload so
				// they disappear here too.
				await loadPage(true);
			}
		} catch (err) {
			props.onToast(scope ? 'Mute failed' : 'Delete failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Mute a single artist from a card menu. A TRACK card disappears (you've
	// silenced its subject) — that's the existing scoped-dismiss path. An ALBUM
	// stays put: muting one credit must not drop a multi-artist release, so we
	// suppress WITHOUT dismissing and re-pull the detail to paint the "Muted"
	// chip on the affected rows.
	async function muteArtist(item: FeedItem, artistId: string, name: string): Promise<void> {
		if (item.type !== 'album') {
			await dismiss(item, { scope: 'artist', key: `artist:${artistId}`, label: name });
			return;
		}
		try {
			const res = await window.api['feed:action']({ kind: 'mute', scopes: [{ scope: 'artist', key: `artist:${artistId}` }] });
			if (!res.ok) throw new Error(res.error ?? 'mute failed');
			props.onToast(`Muted ${name}`, 'info');
			await refreshDetail(item);
		} catch (err) {
			props.onToast('Mute failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// "Mute all artists" on a multi-artist TRACK: silence every credit in one
	// round-trip and remove the track (dismissItemId). Same optimistic
	// removal + advance-if-playing as a scoped dismiss.
	async function muteArtists(item: FeedItem, artists: { id: string; name: string }[]): Promise<void> {
		const idx = items().findIndex((i) => i.id === item.id);
		const lp = lastPlayed();
		const wasPlaying = lp?.itemId === item.id && props.isCurrentlyPlaying(lp.sourceTrackId);
		removeItemLocally(item.id);
		if (wasPlaying) void advanceFrom(idx);
		try {
			const res = await window.api['feed:action']({
				kind: 'mute',
				scopes: artists.map((a) => ({ scope: 'artist' as const, key: `artist:${a.id}` })),
				dismissItemId: item.id,
			});
			if (!res.ok) throw new Error(res.error ?? 'mute failed');
			props.onToast(`Muted ${artists.length} artists`, 'info');
			// Suppressing every credit may hide siblings server-side — reload.
			await loadPage(true);
		} catch (err) {
			props.onToast('Mute failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Re-pull an already-expanded album's detail in place (no full page reload —
	// the album itself doesn't move). Used after an album-card artist mute so its
	// rows gain their "Muted" chip. No-op when the card isn't expanded; the chip
	// is computed fresh on the next expand anyway.
	async function refreshDetail(item: FeedItem): Promise<void> {
		if (!expanded().has(item.id)) return;
		try {
			const detail = await window.api['feed:detail'](item.id);
			if (!detail) return;
			const after = new Map(expanded());
			after.set(item.id, detail);
			noteUnavailable(detail.unavailableSourceTrackIds);
			setExpanded(after);
		} catch (err) {
			props.onToast('Album refresh failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Archive — set the item aside to the Archived view. Same optimistic
	// removal + advance-if-playing as delete, but recoverable via restore.
	async function archive(item: FeedItem): Promise<void> {
		const idx = items().findIndex((i) => i.id === item.id);
		const lp = lastPlayed();
		const wasPlaying = lp?.itemId === item.id && props.isCurrentlyPlaying(lp.sourceTrackId);
		removeItemLocally(item.id);
		if (wasPlaying) void advanceFrom(idx);
		try {
			const res = await window.api['feed:action']({ kind: 'archive', itemId: item.id });
			if (!res.ok) throw new Error(res.error ?? 'archive failed');
		} catch (err) {
			props.onToast('Archive failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Restore an archived item back to the feed (from the Archived view).
	async function restore(item: FeedItem): Promise<void> {
		removeItemLocally(item.id); // leaves the archived list
		try {
			const res = await window.api['feed:action']({ kind: 'unarchive', itemId: item.id });
			if (!res.ok) throw new Error(res.error ?? 'restore failed');
			props.onToast('Restored to feed', 'success');
		} catch (err) {
			props.onToast('Restore failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Unfollow the source playlist: drops it at Spotify and hard-removes every
	// feed item it produced (server-side), then reloads so siblings vanish here
	// too — the same reload shape scoped-dismiss uses.
	async function unfollowPlaylist(playlistId: string, name: string, catalogId?: string): Promise<void> {
		try {
			const res = await window.api['feed:unfollow-playlist'](playlistId, catalogId);
			if (!res.ok) throw new Error(res.error ?? 'unfollow failed');
			const removed = res.removed ?? 0;
			props.onToast(`Unfollowed ${name}`, 'success', removed ? `Removed ${removed} item${removed === 1 ? '' : 's'}` : undefined);
			await loadPage(true);
		} catch (err) {
			props.onToast('Unfollow failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Unfollow the source artist: drops them at Spotify and hard-removes every
	// feed item they produced or appear on, then reloads — same shape as
	// unfollowPlaylist.
	async function unfollowArtist(artistId: string, name: string, catalogId?: string): Promise<void> {
		try {
			const res = await window.api['feed:unfollow-artist'](artistId, catalogId);
			if (!res.ok) throw new Error(res.error ?? 'unfollow failed');
			const removed = res.removed ?? 0;
			props.onToast(`Unfollowed ${name}`, 'success', removed ? `Removed ${removed} item${removed === 1 ? '' : 's'}` : undefined);
			await loadPage(true);
		} catch (err) {
			props.onToast('Unfollow failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Right-click on one artist name in a credit line (card or album row).
	// Library lookup is by name; mute needs the Spotify artist id, which the
	// feed payload carries position-aligned with the names (absent on
	// legacy items — then the mute entry is simply not offered).
	// `artistId` is a Spotify id, or `catalog:<objectId>` for an artist the
	// catalogue knows without one (mutable all the same, never a Spotify ref).
	function showArtistMenu(evt: MouseEvent, item: FeedItem, name: string, artistId: string | undefined): void {
		const spotifyId = isSpotifyArtistId(artistId) ? artistId : undefined;
		const items: Parameters<typeof openContextMenu>[0] = [
			{ kind: 'header', label: name },
			{ kind: 'item', id: 'library', label: 'Show in library' },
			{ kind: 'item', id: 'journey', label: 'Start journey' },
		];
		if (artistId) items.push({ kind: 'divider' }, { kind: 'item', id: 'mute', label: `Mute artist: ${name}`, danger: true });
		openContextMenu(items, {
			library: () => props.onShowArtistInLibrary(name),
			// Same seed identities the KB already mints: a Spotify artist ref
			// when the feed knows the id, else the name-keyed local ref that
			// library seeding uses — so the journey lands on the existing stub.
			journey: () => props.onStartJourney(spotifyId
				? { kind: 'source-ref', source: 'spotify', sourceKind: 'artist', sourceId: spotifyId, entityKind: 'artist', name }
				: { kind: 'source-ref', source: 'local', sourceKind: 'artist', sourceId: `name:${searchFold(name)}`, entityKind: 'artist', name }),
			mute: () => { if (artistId) void muteArtist(item, artistId, name); },
		}, { at: evt });
	}

	// Right-click on an origin chip — the playlist/artist "name" surface.
	// Browse origins carry no follow, so they fall through to the card menu.
	function showOriginMenu(evt: MouseEvent, origin: FeedOrigin, item: FeedItem): void {
		evt.preventDefault();
		evt.stopPropagation();
		if (origin.kind === 'playlist') {
			openContextMenu([
				{ kind: 'header', label: origin.name },
				{ kind: 'item', id: 'open', label: 'Open playlist in Spotify' },
				{ kind: 'divider' },
				{ kind: 'item', id: 'unfollow', label: 'Unfollow playlist', danger: true },
			], {
				open: () => { void shellApi.openSpotify(`spotify:playlist:${origin.id}`); },
				unfollow: () => { void unfollowPlaylist(origin.id, origin.name, origin.catalogId); },
			}, { at: evt });
		} else if (origin.kind === 'artist') {
			const onSpotify = isSpotifyArtistId(origin.id);
			openContextMenu([
				{ kind: 'header', label: origin.name },
				...(onSpotify ? [{ kind: 'item' as const, id: 'open', label: 'Open artist in Spotify' }, { kind: 'divider' as const }] : []),
				{ kind: 'item', id: 'unfollow', label: 'Unfollow artist', danger: true },
			], {
				open: () => { void shellApi.openSpotify(`spotify:artist:${origin.id}`); },
				unfollow: () => { void unfollowArtist(origin.id, origin.name, origin.catalogId); },
			}, { at: evt });
		} else if ((origin.kind === 'label' || origin.kind === 'genre') && origin.catalogId) {
			const kind = origin.kind;
			const catalogId = origin.catalogId;
			openContextMenu([
				{ kind: 'header', label: origin.name },
				{ kind: 'item', id: 'mute', label: `Mute ${kind}` },
				{ kind: 'divider' },
				{ kind: 'item', id: 'unfollow', label: `Unfollow ${kind}`, danger: true },
			], {
				mute: () => { void muteOrigin(item, kind, catalogId, origin.name); },
				unfollow: () => { void unfollowOrigin(kind, catalogId, origin.name); },
			}, { at: evt });
		}
	}

	// A catalogue label / genre the user follows (a watch): unfollowing it
	// removes the items it brought that no other follow also credits.
	async function unfollowOrigin(kind: 'label' | 'genre', catalogId: string, name: string): Promise<void> {
		try {
			await window.api['catalog:unfollow'](catalogId);
			props.onToast(`Unfollowed ${name}`, 'success');
			void loadPage(true);
		} catch (err) {
			props.onToast('Unfollow failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Mute a label: its watch stops bringing releases (core mutes the watch
	// with the suppression) and what it already brought is hidden. A genre has
	// no feed-side scope: its watch is muted and this item set aside.
	async function muteOrigin(item: FeedItem, kind: 'label' | 'genre', catalogId: string, name: string): Promise<void> {
		try {
			if (kind === 'label') {
				const res = await window.api['feed:action']({ kind: 'mute', scopes: [{ scope: 'label', key: `label:${catalogId}` }] });
				if (!res.ok) throw new Error(res.error ?? 'mute failed');
			} else {
				await window.api['catalog:mute'](catalogId, true);
				await dismiss(item);
			}
			props.onToast(`Muted ${name}`, 'success');
			void loadPage(true);
		} catch (err) {
			props.onToast('Mute failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Promote a feed track into the library, returning its canonical curator id.
	// `pin` adds the `interested` ("Pinned") tag (the Interested actions);
	// pin:false brings it in unpinned (plain Organize). Optimistically removes the
	// track card (album items keep their card — only one of its tracks moved).
	// Silent: throws on failure so callers own the toast + follow-on.
	async function promoteFeedTrack(
		item: FeedItem,
		sourceTrackId: string | undefined,
		opts: { pin: boolean },
	): Promise<string> {
		const res = await window.api['feed:action']({ kind: 'interested', itemId: item.id, sourceTrackId, pin: opts.pin });
		if (!res.ok || !res.promotedTrackId) throw new Error(res.error ?? 'promotion failed');
		if (item.type === 'track') removeItemLocally(item.id);
		else if (sourceTrackId) markNestedRowOwned(item.id, sourceTrackId, res.promotedTrackId, opts.pin);
		return res.promotedTrackId;
	}

	// Nested album row promoted: stamp the owned curator id into the expanded
	// detail so the row's next right-click takes the in-library branch (a single
	// Organize on the real id, with its memberships) instead of offering
	// Interested / a fresh deferred session on the provisional id — which would
	// paint an empty modal and re-promote on its first write. Mirrors what a
	// re-expansion's probe would resolve: owned either way (curated state);
	// pinned → the "library" chip + Not Interested; unpinned → owned, no chip
	// (a bare backlog row has no raw membership tier). The inverse lives in
	// notInterested.
	function markNestedRowOwned(itemId: string, sourceTrackId: string, trackId: string, pinned: boolean): void {
		const det = expanded().get(itemId);
		if (!det) return;
		const next = new Map(expanded());
		next.set(itemId, {
			...det,
			inLibraryTrackIds: { ...det.inLibraryTrackIds, [sourceTrackId]: trackId },
			membershipBySourceTrackId: pinned
				? { ...det.membershipBySourceTrackId, [sourceTrackId]: 'library' }
				: det.membershipBySourceTrackId,
			pinnedSourceTrackIds: pinned && !det.pinnedSourceTrackIds.includes(sourceTrackId)
				? [...det.pinnedSourceTrackIds, sourceTrackId]
				: det.pinnedSourceTrackIds,
		});
		setExpanded(next);
	}

	// Curate a not-yet-owned feed track — see FeedActions.interested for the three
	// shapes. Plain "Organize" (pin:false) defers the library write to the modal's
	// first apply so cancelling promotes nothing; the pin paths promote now.
	async function interested(
		item: FeedItem,
		sourceTrackId: string | undefined,
		opts: { pin: boolean; organize: boolean },
	): Promise<void> {
		if (!opts.pin && opts.organize) {
			props.onOpenOrganizeDeferred({
				promote: () => promoteFeedTrack(item, sourceTrackId, { pin: false }),
				rollback: (trackId) => notInterested(item, trackId),
			});
			return;
		}
		try {
			const trackId = await promoteFeedTrack(item, sourceTrackId, { pin: true });
			props.onToast('Added to library backlog', 'success');
			if (opts.organize) props.onOpenOrganize([trackId]);
		} catch (err) {
			props.onToast('Interested failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Reverse of interested — remove an already-in-library feed track from the
	// library (drops its pinned/interested tag too; the backend deletes the row).
	// Optimistically drops the in-library mark so the chip + menu revert without
	// a refetch: clears the nested-row detail entry and any track-card promotion.
	async function notInterested(item: FeedItem, libraryTrackId: string): Promise<void> {
		try {
			const res = await window.api['feed:action']({ kind: 'uninterested', itemId: item.id, trackId: libraryTrackId });
			if (!res.ok) throw new Error(res.error ?? 'remove failed');
			props.onToast('Removed from library', 'info');
			// Nested album row: strip the source track from the expanded detail
			// (the owned id, its chip tier, and its pinned mark).
			const det = expanded().get(item.id);
			if (det) {
				const stid = Object.keys(det.inLibraryTrackIds).find((k) => det.inLibraryTrackIds[k] === libraryTrackId);
				if (stid) {
					const nextMap = { ...det.inLibraryTrackIds };
					delete nextMap[stid];
					const nextTier = { ...det.membershipBySourceTrackId };
					delete nextTier[stid];
					const next = new Map(expanded());
					next.set(item.id, {
						...det,
						inLibraryTrackIds: nextMap,
						membershipBySourceTrackId: nextTier,
						pinnedSourceTrackIds: det.pinnedSourceTrackIds.filter((s) => s !== stid),
					});
					setExpanded(next);
				}
			}
			// Track card: the row is gone from curator.db, so clear every owned mark
			// (chip + curate menu revert to "Interested") and — for a promoted card —
			// return it to the feed, mirroring the backend.
			setItems(items().map((i) =>
				i.id === item.id && (i.promotedTrackId === libraryTrackId || i.libraryTrackId === libraryTrackId)
					? { ...i, promotedTrackId: null, libraryTrackId: undefined, membership: undefined, state: 'seen' }
					: i));
		} catch (err) {
			props.onToast('Remove failed', 'error', err instanceof Error ? err.message : String(err));
		}
	}

	// Nothing here can play it (a catalogue item not on Spotify yet): say so
	// and point at the store pages it does have.
	function notOnSpotify(item: FeedItem, track?: FeedTrackRef): void {
		const links = storeLinks(track?.handles?.length ? track.handles : item.payload.handles);
		props.onToast('Not on Spotify yet', 'info', links.length > 0 ? `Open it in ${links.map((l) => l.label).join(' or ')} from its menu` : 'The catalogue has not found a playable copy yet');
	}

	async function play(item: FeedItem, track?: FeedTrackRef): Promise<void> {
		if (item.type !== 'track' && !track) return;
		// The Spotify id from the item's handles: a catalogue item's sourceId
		// can be a catalogue id (feedHandles.ts).
		const sourceTrackId = playableId(item, track);
		if (!sourceTrackId) { notOnSpotify(item, track); return; }
		// Already-known dead track — don't bother the player (guards every direct
		// play path: card click, dblclick, track-row button).
		if (isUnavailable(sourceTrackId)) { props.onToast('Track unavailable in your region', 'info'); return; }
		// Idempotent: re-triggering the already-loaded track (e.g. double-clicking
		// its cover/card) must not restart it. Switching to a DIFFERENT track falls
		// through and plays normally.
		if (nowPlaying() === sourceTrackId) return;
		setLastPlayed({ itemId: item.id, sourceTrackId, item, track });
		// "Played" is no longer set on click — it's earned. markListened (driven
		// by notePlayback) flips the item/track once the playhead reaches
		// listenThresholdSec. Starting a new track resets any pending listen gate.
		listen = null;
		await props.onPlay({
			itemId: item.id,
			sourceTrackId,
			title: track ? track.title : item.payload.title,
			artist: (track ? track.artists : item.payload.artists).join(', '),
			artists: track ? track.artists : item.payload.artists,
			coverUrl: item.payload.coverUrl ?? null,
			durationSec: track ? track.durationSec : item.payload.durationSec ?? null,
		});
	}

	// "Listened" gate. A play doesn't mark the item heard — the playhead has to
	// reach listenThresholdSec. `listen` just tracks the active track and whether
	// it's been marked. Deliberately lenient: seeking/skipping to the threshold
	// counts, and it needn't be one continuous run (per user pref, 2026-06-28).
	let listen: { stid: string; marked: boolean } | null = null;

	function markListened(): void {
		const lp = lastPlayed();
		if (!lp) return;
		const { itemId, sourceTrackId } = lp;
		void window.api['feed:action']({ kind: 'played', itemId, sourceTrackId });
		setItems(items().map((i) => (i.id === itemId && !i.playedAt ? { ...i, playedAt: Date.now() } : i)));
		const det = expanded().get(itemId);
		if (det && !det.playedSourceTrackIds.includes(sourceTrackId)) {
			const next = new Map(expanded());
			next.set(itemId, { ...det, playedSourceTrackIds: [...det.playedSourceTrackIds, sourceTrackId] });
			setExpanded(next);
		}
	}

	function notePlayback(positionSec: number, playing: boolean): void {
		setAudiblyPlaying(playing);
		const stid = nowPlaying();
		if (!stid) { listen = null; return; }
		if (!listen || listen.stid !== stid) listen = { stid, marked: false };
		if (listen.marked) return;
		// Lenient: once the playhead reaches the threshold it counts — however it
		// got there (played through, or seeked/skipped past it).
		if (positionSec >= props.listenThresholdSec()) { listen.marked = true; markListened(); }
	}

	// Fetch (or reuse) an item's detail and surface it as expanded. Shared
	// by the click-to-expand path and dismiss-advance (which needs an album
	// tracklist to start its first track).
	async function loadDetail(item: FeedItem): Promise<FeedItemDetail | null> {
		const cur = expanded().get(item.id);
		if (cur) return cur;
		const next = new Map(expanded());
		next.set(item.id, null); // loading marker
		setExpanded(next);
		try {
			const detail = await window.api['feed:detail'](item.id);
			const after = new Map(expanded());
			if (detail) {
				after.set(item.id, detail);
				noteUnavailable(detail.unavailableSourceTrackIds);
				setExpanded(after);
				// Phase 2 — on-view Beatport enrichment. The tracklist already
				// renders (above); this fills the album-level genre/label + each
				// track's bpm/key/genre/label without blocking the rows behind
				// Beatport's ~1.5s/track WAF pacing. Idempotent server-side, so a
				// re-expand of a settled album spends nothing. Fire while the item
				// is unattempted (null) or last errored — an 'err' album retries
				// its failed rows on expand; 'ok'/'na' are terminal.
				if (detail.item.enrichStatus == null || detail.item.enrichStatus === 'err' || detail.item.source === 'catalog') void fillExpanded(item.id);
				return detail;
			}
			after.delete(item.id);
			setExpanded(after);
			return detail;
		} catch (err) {
			const after = new Map(expanded());
			after.delete(item.id);
			setExpanded(after);
			props.onToast('Album load failed', 'error', err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	// Phase-2 enrichment of an expanded card: ask the server to Beatport-enrich
	// the item, then fold the returned payload back onto BOTH the expanded detail
	// (so the tracklist rows gain bpm/key) and the list card (so the collapsed
	// card's genre/label chips light up). Best-effort — a miss leaves the rows
	// as-is. Guarded by the caller on enrichedAt so this fires at most once.
	async function fillExpanded(itemId: string): Promise<void> {
		let updated: FeedItem | null = null;
		try {
			updated = await window.api['feed:fill'](itemId);
		} catch {
			return; // best-effort; leave the rows as they are
		}
		if (!updated) return;
		const det = expanded().get(itemId);
		// Only patch the detail if the card is still expanded (the user may have
		// collapsed it mid-lookup); the list card always reflects the result.
		if (det) {
			const next = new Map(expanded());
			next.set(itemId, { ...det, item: updated });
			setExpanded(next);
		}
		applyEnriched(updated);
	}

	async function toggleExpand(item: FeedItem): Promise<void> {
		if (expanded().has(item.id)) {
			const next = new Map(expanded());
			next.delete(item.id);
			setExpanded(next);
			return;
		}
		void window.api['feed:action']({ kind: 'expanded', itemId: item.id });
		await loadDetail(item);
	}

	// Component-side action surface for the feed command table (features/
	// feedCommands.ts). Maps command ids to the existing closures; the table
	// decides which commands show + their labels for a given card / row / mode.
	const feedActions: FeedActions = {
		play: (item, track) => { void play(item, track); },
		interested: (item, sourceTrackId, opts) => { void interested(item, sourceTrackId, opts); },
		archive: (item) => { void archive(item); },
		restore: (item) => { void restore(item); },
		deleteItem: (item) => { void dismiss(item); },
		muteArtist: (item, artistId, name) => { void muteArtist(item, artistId, name); },
		muteArtists: (item, artists) => { void muteArtists(item, artists); },
		mutePlaylist: (item, playlistId, name) => { void dismiss(item, { scope: 'playlist', key: `playlist:${playlistId}`, label: name }); },
		unfollowArtist: (artistId, name, catalogId) => { void unfollowArtist(artistId, name, catalogId); },
		unfollowPlaylist: (playlistId, name, catalogId) => { void unfollowPlaylist(playlistId, name, catalogId); },
		openSpotifyUrl: (url) => { void shellApi.openSpotify(url); },
		openSpotifyTrack: (sourceTrackId) => { void shellApi.openSpotify(`spotify:track:${sourceTrackId}`); },
		openExternal: (url) => { void shellApi.openExternal(url); },
		unfollowOrigin: (kind, catalogId, name) => { void unfollowOrigin(kind, catalogId, name); },
		muteOrigin: (item, kind, catalogId, name) => { void muteOrigin(item, kind, catalogId, name); },
		copySpotifyUrl: (url) => { void shellApi.copyText(url).then(() => props.onToast('Copied Spotify URL', 'success', url)); },
		isUnavailable,
		notInterested: (item, libraryTrackId) => { void notInterested(item, libraryTrackId); },
		openOrganize: (libraryTrackId) => { props.onOpenOrganize([libraryTrackId]); },
		startJourney: (item, track) => {
			const sourceId = track || item.type === 'track' ? playableId(item, track) : null;
			if (!sourceId) return;
			props.onStartJourney({
				kind: 'source-ref',
				source: 'spotify',
				sourceKind: 'track',
				sourceId,
				entityKind: 'track',
				name: track?.title ?? item.payload.title,
			});
		},
	};

	// Card right-click / "More…" menu — derived from the feed command table.
	function showCardMenu(evt: MouseEvent, item: FeedItem): void {
		evt.preventDefault();
		// In-library case for a track card: the owned curator id stamped by the
		// page decorator (pinned / local / own playlist), falling back to a feed
		// promotion. Album cards carry no per-track id. `pinned` (only pinned tracks
		// get "Not Interested") ⟺ the resolved chip tier is `library`: local files
		// are filtered from track cards, so `library` there is reached only by the
		// pinned path (a promoted card is pinned too).
		const libraryTrackId = item.type === 'track' ? (item.libraryTrackId ?? item.promotedTrackId ?? undefined) : undefined;
		const pinned = item.type === 'track' && (item.membership === 'library' || !!item.promotedTrackId);
		const { items, handlers } = buildFeedMenu({ item, mode: mode(), actions: feedActions, libraryTrackId, pinned });
		openContextMenu(items, handlers, { at: evt });
	}

	// Per-track menu for nested album rows — same table with `track` set, so the
	// row-scoped commands (Play / Interested / Open) target THIS track rather
	// than the album item. Shared by the row hamburger and the row right-click.
	function showTrackMenu(evt: MouseEvent, item: FeedItem, track: FeedTrackRef): void {
		evt.preventDefault();
		evt.stopPropagation();
		// inLibraryTrackIds is the OWNED-only map (pinned / local / own playlist) —
		// a merely-synced followed-playlist track is excluded, so it shows
		// "Interested" (promote). pinnedSourceTrackIds is the pinned subset that
		// additionally gets the destructive "Not Interested" (un-pin).
		const det = expanded().get(item.id);
		const libraryTrackId = det?.inLibraryTrackIds[track.sourceTrackId];
		const pinned = !!det?.pinnedSourceTrackIds.includes(track.sourceTrackId);
		const { items, handlers } = buildFeedMenu({ item, track, mode: mode(), actions: feedActions, libraryTrackId, pinned });
		openContextMenu(items, handlers, { at: evt });
	}

	// Open the feed menu for whatever the player is currently playing from the
	// feed — wired to a right-click on the docked Discover player in main.ts.
	// Self-gating: only fires when the player's current track IS the one the feed
	// last handed over (lastPlayed === nowPlaying), so right-clicks during library
	// playback fall through. Returns whether a menu was shown.
	function openPlayingTrackMenu(evt: MouseEvent): boolean {
		const np = nowPlaying();
		const lp = lastPlayed();
		if (!np || !lp || lp.sourceTrackId !== np) return false;
		// Prefer the live list entry (freshest membership / expanded detail), but
		// fall back to the item cached at play time so the menu still opens when a
		// list reset (filter change, Archived, Refresh) dropped it from the visible
		// window while the track kept playing.
		const item = items().find((i) => i.id === lp.itemId) ?? lp.item;
		// Album playback targets a nested track — resolve its ref so the menu's
		// track-scoped commands (Interested / Search) act on the playing track.
		let track: FeedTrackRef | undefined;
		if (item.type !== 'track') {
			const tracks = expanded().get(item.id)?.item.payload.tracks ?? item.payload.tracks ?? [];
			track = tracks.find((t) => t.sourceTrackId === np) ?? lp.track;
		}
		// In-library: owned track card (decorator-stamped id / promotion), or an
		// OWNED nested album track (inLibraryTrackIds is owned-only — excludes
		// merely-synced followed). `pinned` gates "Not Interested" (un-pin only).
		const det = item.type !== 'track' ? expanded().get(item.id) : undefined;
		const libraryTrackId = item.type === 'track'
			? (item.libraryTrackId ?? item.promotedTrackId ?? undefined)
			: det?.inLibraryTrackIds[np];
		const pinned = item.type === 'track'
			? (item.membership === 'library' || !!item.promotedTrackId)
			: !!det?.pinnedSourceTrackIds.includes(np);
		evt.preventDefault();
		const { items: menuItems, handlers } = buildFeedMenu({ item, track, mode: mode(), actions: feedActions, libraryTrackId, pinned });
		openContextMenu(menuItems, handlers, { at: evt });
		return true;
	}

	function handleScroll(evt: Event): void {
		const el = evt.currentTarget as HTMLElement;
		if (!nextCursor() || loading()) return;
		if (el.scrollTop + el.clientHeight >= el.scrollHeight - 600) void loadPage(false);
	}

	// Reactive left-edge "spine" gradient for a card — sampled from the cover's
	// left strip (see sampleLeftEdgeGradient). Cached per URL so re-renders,
	// pagination, and cards sharing a cover sample once; undefined → no spine.
	function createSpine(coverUrl: () => string | null | undefined): () => string | undefined {
		const [spine, setSpine] = createSignal<string | undefined>(undefined);
		createEffect(() => {
			const cover = coverUrl() ?? null;
			if (!cover) { setSpine(undefined); return; }
			let pending = spineCache.get(cover);
			if (!pending) {
				pending = sampleLeftEdgeGradient(cover);
				spineCache.set(cover, pending);
			}
			void pending.then((g) => {
				if ((coverUrl() ?? null) === cover) setSpine(g ?? undefined);
			});
		});
		return spine;
	}

	// ── card sub-pieces shared by the track + album templates ───────────────

	// Cover art + audition disc. `onActivate` starts playback (the track, or an
	// album's first track). While this card is the loaded feed track (`active`)
	// the disc is pinned visible as a play/pause control — clicking toggles the
	// player rather than restarting — and `playing` flips the glyph (pause while
	// advancing, play while paused). `heard` shows a "listened" tick.
	// A card nothing here can play (a catalogue item not on Spotify yet) swaps
	// the disc for its first store page — the way to hear or buy it — until
	// the catalogue finds it on Spotify and the row becomes playable in place.
	const CardCover = (p: {
		item: FeedItem;
		onActivate: () => void;
		active?: boolean;
		playing?: boolean;
		heard?: boolean;
	}) => {
		const playable = () => cardPlayable(p.item);
		const store = () => (playable() ? undefined : storeLinks(p.item.payload.handles)[0]);
		return (
		<div
			class="feed-card__cover"
			classList={{ 'feed-card__cover--offline': !playable() }}
			onClick={(e) => {
				e.stopPropagation();
				if (!playable()) { const s = store(); if (s) void shellApi.openExternal(s.url); else notOnSpotify(p.item); return; }
				if (p.active) props.onTogglePause(); else p.onActivate();
			}}
			onDblClick={(e) => e.stopPropagation()}
		>
			<Show when={p.item.payload.coverUrl} fallback={<div class="feed-card__cover-ph" />}>
				<img src={p.item.payload.coverUrl!} loading="lazy" alt="" />
			</Show>
			<Show when={p.heard}>
				<span class="feed-card__cover-heard" title="Listened">
					<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 13 4 4L19 7" /></svg>
				</span>
			</Show>
			{/* The cover div owns the click; this button is the visual disc only
			    (out of the tab order). Pinned + accent while the card is loaded. */}
			<Show when={playable()} fallback={
				<Show when={store()}>
					<button class="feed-card__cover-play feed-card__cover-play--store" title={`Not on Spotify yet — open in ${store()!.label}`} tabindex={-1}>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
					</button>
				</Show>
			}>
				<button class="feed-card__cover-play" classList={{ 'feed-card__cover-play--active': !!p.active }} title={p.active ? 'Play / pause' : 'Audition'} tabindex={-1}>
					<Show when={p.playing} fallback={<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>}>
						<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
					</Show>
				</button>
			</Show>
		</div>
		);
	};

	// "Not on Spotify" chip for a card nothing here can play yet.
	const OfflineChip = (p: { item: FeedItem }) => (
		<Show when={!cardPlayable(p.item)}>
			<span class="feed-chip feed-chip--offline" title={(() => { const l = storeLinks(p.item.payload.handles); return l.length ? `On ${l.map((x) => x.label).join(', ')}` : 'No playable copy found yet'; })()}>NOT ON SPOTIFY</span>
		</Show>
	);

	// "Now playing" chip on the loaded feed card. Static play glyph — no animated
	// equaliser (per user pref, 2026-06-28).
	const PlayingChip = () => (
		<span class="feed-np">
			<svg class="feed-np__ico" width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
			NOW PLAYING
		</span>
	);

	// Meta line 1 — interleaves "·" separators between the present fields only, so
	// a missing genre/label/bpm never leaves a dangling dot. Rebuilt on each card
	// render (a card re-creates when its item object is replaced — e.g. when
	// enrichment lands — so it stays current without per-field signals).
	const MetaLine = (p: { nodes: (JSX.Element | null | false)[] }) => {
		const present = p.nodes.filter(Boolean) as JSX.Element[];
		return (
			<div class="feed-card__meta-line">
				{present.map((n, i) => (
					<>{i > 0 && <span class="feed-card__sep">·</span>}{n}</>
				))}
			</div>
		);
	};

	// Bottom-left date — same place in both templates. In the live feed it's
	// `publishedAt` (release date for new releases, added-to-playlist date for
	// followed playlists). In the Archived view the meaningful date is when the
	// user set the item aside, so the labels match the archived-first ordering.
	const CardDate = (p: { item: FeedItem }) => {
		const archived = () => mode() === 'archived';
		const ts = () => archived()
			? (p.item.archivedAt ?? p.item.publishedAt ?? p.item.fetchedAt)
			: (p.item.publishedAt ?? p.item.fetchedAt);
		const fmt = () => fmtFeedDate(ts());
		const title = () => archived() ? `Archived ${fmt().title}` : fmt().title;
		// A followed-playlist card in the live feed says when the track was
		// added to the playlist and, when the source gave one, its release date.
		const playlistAdded = () => !archived() && spotifyPlaylistOrigin(p.item) && p.item.publishedAt ? p.item.publishedAt : null;
		return (
			<Show when={playlistAdded()} fallback={<span class="feed-card__date" title={title()}>{fmt().label}</span>}>
				{(added) => (
					<span class="feed-card__when" title={`Added ${fmtFeedDate(added()).title}`}>
						Added <b>{fmtAddedWhen(added())}</b>
						<Show when={fmtReleaseDate(p.item.payload.releaseDate)}>{(rd) => <>, Released <b>{rd()}</b></>}</Show>
					</span>
				)}
			</Show>
		);
	};

	// The brand marks at the top-right of a card: one per service the item is
	// known on (itemSources). Click opens the item there — the Spotify app for
	// Spotify, the browser for a store. Settings → Discover → Source logos.
	const CardSources = (p: { item: FeedItem }) => (
		<Show when={discoverSettingsSignal().showSourceLogos && itemSources(p.item).length > 0}>
			<span class="feed-card__sources">
				<For each={itemSources(p.item)}>
					{(src) => (
						<button
							class="feed-card__src"
							type="button"
							title={src.url ? `Open on ${providerLabel(src.provider)}` : `On ${providerLabel(src.provider)}`}
							data-url={src.url ?? undefined}
							innerHTML={brandIcon(src.provider)}
							onClick={(e) => {
								e.stopPropagation();
								if (!src.url) return;
								if (src.provider === 'spotify') void shellApi.openSpotify(src.url);
								else void shellApi.openExternal(src.url);
							}}
						/>
					)}
				</For>
			</span>
		</Show>
	);

	// "New on <playlist> by <profile>" for a card raised by a followed Spotify
	// playlist. The playlist name opens it under the Spotify tab, the profile
	// name opens the profile in the Spotify app; right-click keeps the origin
	// menu (open / mute / unfollow). The owner rides the origin when the
	// producer recorded it; older rows fall back to the synced playlist row.
	const SpotifyPlaylistOrigin = (p: { item: FeedItem; origin: FeedOrigin }) => {
		const owner = () => {
			if (p.origin.owner) return p.origin.owner;
			const pl = library.allPlaylists().find((x) => x.source === 'spotify' && x.sourceId === p.origin.id);
			return pl?.ownerId ? { id: pl.ownerId, name: pl.ownerName } : undefined;
		};
		return (
			<span
				class="feed-card__origin feed-card__origin--followable"
				title="Right-click to mute or unfollow"
				onContextMenu={(e) => showOriginMenu(e, p.origin, p.item)}
			>
				New on <b class="feed-card__link" title="Open the playlist under the Spotify tab" onClick={(e) => { e.stopPropagation(); props.onOpenSpotifyPlaylist(p.origin.id); }}>{p.origin.name}</b>
				<Show when={owner()}>
					{(o) => <> by <b class="feed-card__link" title="Open the profile on Spotify" onClick={(e) => { e.stopPropagation(); void shellApi.openSpotify(`spotify:user:${o().id}`); }}>{o().name || o().id}</b></>}
				</Show>
			</span>
		);
	};

	// Origin attribution chip — followable origins (playlist / artist) right-click
	// to unfollow.
	const CardOrigin = (p: { item: FeedItem }) => {
		// Extra sources beyond the one shown in the chip. `sources` includes the
		// primary, so the badge counts the rest.
		const extra = () => Math.max((p.item.sources?.length ?? 0) - 1, 0);
		return (
			<>
				<Show when={spotifyPlaylistOrigin(p.item)}>
					{(o) => <SpotifyPlaylistOrigin item={p.item} origin={o()} />}
				</Show>
				<Show when={p.item.origin && !spotifyPlaylistOrigin(p.item)}>
					{(() => {
						const o = () => p.item.origin!;
						// Every follow kind but a bare browse filing has a menu.
						const followable = () => o().kind !== 'browse' && (o().kind === 'playlist' || o().kind === 'artist' || !!o().catalogId);
						return (
							<span
								class="feed-card__origin"
								classList={{ 'feed-card__origin--followable': followable() }}
								title={followable() ? 'Right-click to unfollow' : undefined}
								onContextMenu={(e) => { if (followable()) showOriginMenu(e, o(), p.item); }}
							>{originLabel(p.item)}</span>
						);
					})()}
				</Show>
				<Show when={extra() > 0}>
					<span class="feed-card__origin-more" title={sourcesTooltip(p.item)}>+{extra()}</span>
				</Show>
			</>
		);
	};

	// Card-level archive / restore / delete / more — the action cluster both
	// templates share (each card owns its own play affordances).
	const CardCommonActions = (p: { item: FeedItem }) => (
		<>
			<Show when={feedShow.archive(mode())}>
				<button class="feed-act feed-act--archive" title="Archive" onClick={() => void archive(p.item)}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>
				</button>
			</Show>
			<Show when={feedShow.restore(mode())}>
				<button class="feed-act feed-act--restore" title="Restore to feed" onClick={() => void restore(p.item)}>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" /></svg>
				</button>
			</Show>
			<button class="feed-act feed-act--menu" title="More…" onClick={(e) => showCardMenu(e, p.item)}>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
			</button>
		</>
	);

	// ── track feed item ─────────────────────────────────────────────────────
	const TrackCard = (cardProps: { item: FeedItem }) => {
		const item = () => cardProps.item;
		const isPlaying = () => nowPlaying() === item().sourceId;
		const unavailable = () => isUnavailable(item().sourceId);
		// Left-edge spine gradient sampled from the cover.
		const spine = createSpine(() => item().payload.coverUrl);
		return (
			<div
				class="feed-card"
				classList={{
					'feed-card--played': !!item().playedAt,
					'feed-card--playing': isPlaying(),
					'feed-card--unavailable': unavailable(),
				}}
				style={{ '--spine': spine() } as JSX.CSSProperties}
				onContextMenu={(e) => showCardMenu(e, item())}
			>
				<div
					class="feed-card__row"
					onDblClick={(e) => {
						// Buttons own their own actions — a fast double-tap on
						// dismiss/interested must not also start playback.
						if ((e.target as HTMLElement).closest('button, .feed-card__link')) return;
						void play(item());
					}}
				>
					<CardCover item={item()} onActivate={() => void play(item())} active={isPlaying()} playing={isPlaying() && audiblyPlaying()} heard={!!item().playedAt} />
					<div class="feed-card__body">
						<div class="feed-card__title-row">
							<span class="feed-card__title" title={item().payload.title}>{item().payload.title}</span>
							<Show when={spotifyPlaylistOrigin(item())} fallback={<span class="feed-chip feed-chip--track">TRACK</span>}>
								<span class="feed-chip feed-chip--sp-playlist" title="From a Spotify playlist you follow"><span class="feed-chip__brand" innerHTML={BRAND_ICONS.spotify} />PLAYLIST</span>
							</Show>
							<OfflineChip item={item()} />
							<Show when={isPlaying()}><PlayingChip /></Show>
							<Show when={item().playedAt && !isPlaying()}><span class="feed-chip feed-chip--played">LISTENED</span></Show>
							<Show when={unavailable()}><span class="feed-chip feed-chip--unavailable">UNAVAILABLE</span></Show>
							{/* Membership tier of a standalone track card. Raw `local`-file
							    items are filtered out before the page, so `library` only
							    surfaces here via the pinned path. */}
							<Show when={item().membership === 'library'}><span class="feed-chip feed-chip--library">IN LIBRARY</span></Show>
							<Show when={item().membership === 'spotify'}><span class="feed-chip feed-chip--spotify">IN SPOTIFY LIBRARY</span></Show>
							<Show when={item().membership === 'tidal'}><span class="feed-chip feed-chip--tidal">IN TIDAL LIBRARY</span></Show>
							<Show when={item().membership === 'followed'}><span class="feed-chip feed-chip--followed">IN FOLLOWED</span></Show>
							<CardSources item={item()} />
						</div>
						<div class="feed-card__artists">
							<ArtistCredits
								artists={item().payload.artists}
								onContextMenu={(evt, name, i) => showArtistMenu(evt, item(), name, item().payload.artistIds?.[i])}
							/>
						</div>
						<div class="feed-card__metablock">
							<MetaLine nodes={[
								item().payload.genre ? <span>{item().payload.genre}</span> : null,
								item().payload.label ? <span>{item().payload.label}</span> : null,
								item().payload.bpm ? <span class="feed-meta-dj">{Math.round(item().payload.bpm!)} BPM</span> : null,
								item().payload.keyCamelot ? <KeyChip keyCamelot={item().payload.keyCamelot} /> : null,
								fmtDuration(item().payload.durationSec) ? <span class="feed-card__dur">{fmtDuration(item().payload.durationSec)}</span> : null,
								// Being matched on Spotify or enriched right now: say so.
								feedActivity.of(item().id)
									? <span class="feed-meta-enrich feed-meta-enrich--busy">{ACTIVITY_TEXT[feedActivity.of(item().id)!]}</span>
									// No DJ metadata landed — show the Beatport outcome (N/A no-match /
									// ERR failed) so the empty line reads as a known state, not loading.
									: (!item().payload.bpm && !item().payload.genre && !item().payload.label && enrichMarker(item().enrichStatus))
										? <span class={`feed-meta-enrich feed-meta-enrich--${item().enrichStatus}`}>{enrichMarker(item().enrichStatus)}</span>
										: null,
							]} />
							<div class="feed-card__meta-line">
								<CardDate item={item()} />
								<Show when={item().origin}><span class="feed-card__sep">·</span></Show>
								<CardOrigin item={item()} />
							</div>
						</div>
					</div>
					<div class="feed-card__actions">
						<Show when={feedShow.quickInterested(item(), mode())}>
							<button class="feed-act feed-act--keep" title="Interested — add to library backlog" onClick={() => { const sid = playableId(item()); if (sid) void interested(item(), sid, { pin: true, organize: false }); }}>
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14" /></svg>
							</button>
						</Show>
						<CardCommonActions item={item()} />
					</div>
				</div>
			</div>
		);
	};

	// ── album feed item ─────────────────────────────────────────────────────
	const AlbumCard = (cardProps: { item: FeedItem }) => {
		const item = () => cardProps.item;
		const detail = () => expanded().get(item().id);
		const isExpanded = () => expanded().has(item().id);
		// All-played dimming: every track listened. The PLAYED chip uses the
		// item's own playedAt (set once any track is heard) — a weaker signal,
		// matching the original behaviour.
		const playedAll = () => {
			const det = detail();
			const n = item().payload.trackCount ?? det?.item.payload.tracks?.length ?? 0;
			if (det && n > 0) return det.playedSourceTrackIds.length >= n;
			return false;
		};
		// Now-playing rides along as the album advances: the accent shows when the
		// active source track is the one this card last handed to the player.
		const isPlaying = () => {
			const np = nowPlaying();
			if (!np) return false;
			const lp = lastPlayed();
			return !!lp && lp.itemId === item().id && lp.sourceTrackId === np;
		};
		// Footer-bar label: collapsed → "{n} tracks"; open → "Hide tracks".
		// Falls back to "Show tracks" when the track count is unknown.
		const footLabel = () => {
			if (isExpanded()) return 'Hide tracks';
			const n = item().payload.trackCount;
			return n ? `${n} ${n === 1 ? 'track' : 'tracks'}` : 'Show tracks';
		};
		// Left-edge spine gradient sampled from the cover.
		const spine = createSpine(() => item().payload.coverUrl);
		return (
			<div
				class="feed-card"
				classList={{
					'feed-card--played': playedAll(),
					'feed-card--expanded': isExpanded(),
					'feed-card--playing': isPlaying(),
				}}
				style={{ '--spine': spine() } as JSX.CSSProperties}
				onContextMenu={(e) => showCardMenu(e, item())}
			>
				<div
					class="feed-card__row"
					onDblClick={(e) => {
						// Buttons own their own actions — a fast double-tap on
						// dismiss/interested must not also start playback.
						if ((e.target as HTMLElement).closest('button, .feed-card__link')) return;
						void playAlbum(item());
					}}
				>
					<CardCover item={item()} onActivate={() => void playAlbum(item())} active={isPlaying()} playing={isPlaying() && audiblyPlaying()} heard={playedAll()} />
					<div class="feed-card__body">
						<div class="feed-card__title-row">
							<span class="feed-card__title" title={item().payload.title}>{item().payload.title}</span>
							<span class="feed-chip feed-chip--album">{item().payload.albumType === 'single' ? 'SINGLE' : 'ALBUM'}</span>
							<OfflineChip item={item()} />
							<Show when={isPlaying()}><PlayingChip /></Show>
							<Show when={item().playedAt && !isPlaying()}><span class="feed-chip feed-chip--played">LISTENED</span></Show>
							<CardSources item={item()} />
						</div>
						<div class="feed-card__artists">
							<ArtistCredits
								artists={item().payload.artists}
								onContextMenu={(evt, name, i) => showArtistMenu(evt, item(), name, item().payload.artistIds?.[i])}
							/>
						</div>
						<div class="feed-card__metablock">
							<MetaLine nodes={[
								item().payload.genre ? <span>{item().payload.genre}</span> : null,
								item().payload.label ? <span>{item().payload.label}</span> : null,
								item().payload.catalogNumber ? <span class="feed-card__catno" title="Catalogue number">{item().payload.catalogNumber}</span> : null,
								// Being matched on Spotify or enriched right now: say so.
								feedActivity.of(item().id) ? <span class="feed-meta-enrich feed-meta-enrich--busy">{ACTIVITY_TEXT[feedActivity.of(item().id)!]}</span> : null,
							]} />
							<div class="feed-card__meta-line">
								<CardDate item={item()} />
								<Show when={item().origin}><span class="feed-card__sep">·</span></Show>
								<CardOrigin item={item()} />
							</div>
						</div>
					</div>
					<div class="feed-card__actions">
						<CardCommonActions item={item()} />
					</div>
				</div>
				{/* Footer expand bar — a full-width, hairline-flanked "open below"
				    divider; collapsed shows the track count, open flips to "Hide
				    tracks". The expand control deliberately isn't in the hover cluster. */}
				<button
					class="feed-card__foot"
					classList={{ 'feed-card__foot--on': isExpanded() }}
					title={isExpanded() ? 'Hide tracks' : 'Show tracks'}
					onClick={() => void toggleExpand(item())}
				>
					<span class="feed-card__foot-line" />
					<span class="feed-card__foot-label">
						{footLabel()}
						<span class="feed-card__foot-chev" classList={{ 'feed-card__foot-chev--up': isExpanded() }}>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6" /></svg>
						</span>
					</span>
					<span class="feed-card__foot-line" />
				</button>
				<Show when={isExpanded()}>
					<div class="feed-card__tracks">
						<Show when={detail()} fallback={<div class="feed-card__tracks-loading">Loading tracklist…</div>}>
							<Show when={(detail()!.item.payload.tracks ?? []).length > 0} fallback={
								<div class="feed-card__tracks-loading">
									{detail()!.tracksError ?? 'Tracklist unavailable.'}{' '}
									<button
										class="feed-tracks-retry"
										onClick={() => {
											const next = new Map(expanded());
											next.delete(item().id);
											setExpanded(next);
											void toggleExpand(item());
										}}
									>Retry</button>
								</div>
							}>
							<div class="feed-track feed-track--head">
								<span class="feed-track__num">#</span>
								<span class="feed-track__title">Title</span>
								<span class="feed-track__artists">Artist</span>
								<span class="feed-track__genre">Genre</span>
								<span class="feed-track__bpm">BPM</span>
								<span class="feed-track__key">Key</span>
								<span class="feed-track__dur">Time</span>
								<span></span>
							</div>
							<For each={detail()!.item.payload.tracks ?? []}>
								{(t) => {
									// Listened (played), membership tier, and deleted all come
									// from the detail probe. tier is disjoint from deleted (a
									// soft-deleted track isn't "in library"), so a row shows at
									// most one membership/deleted chip.
									const listened = () => detail()!.playedSourceTrackIds.includes(t.sourceTrackId);
									const playing = () => nowPlaying() === t.sourceTrackId;
									const tier = () => detail()!.membershipBySourceTrackId[t.sourceTrackId];
									const deleted = () => detail()!.deletedSourceTrackIds.includes(t.sourceTrackId);
									// Artist of this row is muted: keep it visible + playable, just
									// flagged and dimmed (and skipped by autoplay — firstPlayableTrack).
									const muted = () => detail()!.mutedSourceTrackIds.includes(t.sourceTrackId);
									// Not on Spotify yet: the row opens its store page instead.
									const offline = () => playableId(detail()!.item, t) === null;
									const rowStore = () => storeLinks(t.handles?.length ? t.handles : detail()!.item.payload.handles)[0];
									return (
										<div
											class="feed-track"
											classList={{ 'feed-track--listened': listened(), 'feed-track--playing': playing(), 'feed-track--unavailable': isUnavailable(t.sourceTrackId), 'feed-track--muted': muted(), 'feed-track--offline': offline() }}
											title={offline() ? (rowStore() ? `Not on Spotify yet — double-click to open in ${rowStore()!.label}` : 'Not on Spotify yet') : undefined}
											onDblClick={(e) => {
												// Let the row's menu button own its clicks — a double-tap
												// on it must not also re-trigger playback here.
												if ((e.target as HTMLElement).closest('button, .feed-card__link')) return;
												if (offline()) { const s = rowStore(); if (s) void shellApi.openExternal(s.url); return; }
												void play(item(), t);
											}}
											onContextMenu={(e) => showTrackMenu(e, item(), t)}
										>
											{/* Index number, swapped for the now-playing equalizer while
											    this row is the playing track (same indicator as the main
											    tracklist). The play button is gone — double-click or the
											    row menu start playback. */}
											<span class="feed-track__num">
												<Show when={playing()} fallback={
													<Show when={offline()} fallback={t.trackNumber ?? ''}>
														<svg class="feed-track__offline" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-label="not on Spotify"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>
													</Show>
												}>
													<span class="now-playing-eq" aria-label="now playing"><i /><i /><i /><i /></span>
												</Show>
											</span>
											<span class="feed-track__title" title={t.title}>
												<span class="feed-track__title-text">{t.title}</span>
												<Show when={tier() === 'library'}><span class="feed-track__lib-chip feed-track__lib-chip--library">In Library</span></Show>
												<Show when={tier() === 'spotify'}><span class="feed-track__lib-chip feed-track__lib-chip--spotify">In Spotify Library</span></Show>
												<Show when={tier() === 'tidal'}><span class="feed-track__lib-chip feed-track__lib-chip--tidal">In Tidal Library</span></Show>
												<Show when={tier() === 'followed'}><span class="feed-track__lib-chip feed-track__lib-chip--followed">In Followed Playlist</span></Show>
												<Show when={deleted()}><span class="feed-track__lib-chip feed-track__lib-chip--deleted">Deleted</span></Show>
												<Show when={muted()}><span class="feed-track__lib-chip feed-track__lib-chip--muted">Muted</span></Show>
											</span>
											<span class="feed-track__artists" title={t.artists.join(', ')}>
												<ArtistCredits
													artists={t.artists}
													onContextMenu={(evt, name, i) => showArtistMenu(evt, detail()!.item, name, t.artistIds?.[i])}
												/>
											</span>
											<span class="feed-track__genre" title={t.genre ?? ''}>{t.genre ?? ''}</span>
											<span class="feed-track__bpm">
												<Show when={t.bpm} fallback={<span class={`feed-meta-enrich feed-meta-enrich--${t.enrichStatus}`}>{enrichMarker(t.enrichStatus)}</span>}>{Math.round(t.bpm!)}</Show>
											</span>
											<span class="feed-track__key"><KeyChip keyCamelot={t.keyCamelot} /></span>
											<span class="feed-track__dur">{fmtDuration(t.durationSec)}</span>
											<button class="feed-act feed-act--mini feed-act--menu" title="More…" onClick={(e) => showTrackMenu(e, item(), t)}>
												<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
											</button>
										</div>
									);
								}}
							</For>
							</Show>
						</Show>
					</div>
				</Show>
			</div>
		);
	};

	// Dispatch by item type — track and album render distinct templates.
	const Card = (cardProps: { item: FeedItem }) =>
		cardProps.item.type === 'album'
			? <AlbumCard item={cardProps.item} />
			: <TrackCard item={cardProps.item} />;

	const View = () => (
		<div class="feed-root">
			<div class="feed-toolbar">
				<span class="feed-toolbar__title">{mode() === 'archived' ? 'Archived' : 'Discover'}</span>
				<span class="feed-toolbar__count">{total()} items</span>
				<Show when={mode() === 'feed' && follower() && !catalogAvailable()}>
					<span class="feed-toolbar__count" title="Discover is collected on your account's main device. Archive, dismiss and mute decisions made there apply here, and yours sync back. Make this computer the main device in Settings → Account to collect here.">
						Collected on your main device
					</span>
				</Show>
				<Show when={mode() === 'feed' && (!follower() || catalogAvailable())}>
					{/* The icon turns for any pass in flight, the background poll
					    included ("Checking…"); the steps are in the progress toast
					    and on the Discover tab's popover. */}
					<button class="feed-toolbar__refresh" disabled={refreshing()} onClick={() => void refreshProducers()}>
						<svg classList={{ 'feed-toolbar__icon--spin': refreshing() || passRunning() }} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12a9 9 0 1 1-3.4-7" /><path d="M21 4v5h-5" /></svg>
						{refreshing() ? 'Refreshing…' : passRunning() ? 'Checking…' : 'Refresh'}
					</button>
					{/* The Refresh menu: check now per kind, and which sources are
					    read for the follows (openRefreshMenu). */}
					<button class="feed-toolbar__refresh feed-toolbar__refresh-menu" disabled={refreshing()}
						title="Check your follows now, and choose which sources are read for them"
						aria-label="Refresh options"
						onClick={(e) => void openRefreshMenu(e.currentTarget)}>▾</button>
				</Show>
				<Show when={mode() === 'feed'}>
					<select class="feed-toolbar__filter" title="Filter by genre (stays until you remove it)"
						value={lensValue('genre') ?? ''} onChange={(e) => pickFilter('genre', e.currentTarget.value || null)}>
						<option value="">All genres</option>
						<For each={filterOptions().genres}>{(g) => <option value={g}>{g}</option>}</For>
					</select>
					<select class="feed-toolbar__filter" title="Filter by label (stays until you remove it)"
						value={lensValue('label') ?? ''} onChange={(e) => pickFilter('label', e.currentTarget.value || null)}>
						<option value="">All labels</option>
						<For each={filterOptions().labels}>{(l) => <option value={l}>{l}</option>}</For>
					</select>
				</Show>
				<button class="feed-toolbar__refresh" onClick={() => userSetViewMode(mode() === 'feed' ? 'archived' : 'feed')}>
					{mode() === 'feed'
						? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></svg>Archived</>
						: <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>Discover</>}
				</button>
				<button class="feed-toolbar__refresh feed-toolbar__following" classList={{ 'feed-toolbar__following--on': showFollowing() }}
					title="The artists and labels whose new releases come to Discover"
					onClick={() => setShowFollowing((v) => !v)}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 8v6M14 11h6" /></svg>
					Following{followCount() !== null ? ` ${followCount()}` : ''}
				</button>
			</div>
			{/* Standing lenses: each chip is one filter the feed obeys until ×.
			    The label is the user's own words (or the assistant's quote of
			    them) — the chip is the confirmation, there is no dialog. */}
			<Show when={mode() === 'feed' && lenses().length > 0}>
				<div class="feed-lenses" aria-label="Standing filters">
					<For each={lenses()}>{(l) => (
						<span class="feed-lens" classList={{ 'feed-lens--inert': !!l.inert }}
							title={l.inert ? 'Made on a newer version of Curator — not applied here' : l.by === 'assistant' ? 'Set by the assistant. Stays until you remove it.' : 'Stays until you remove it.'}>
							<span class="feed-lens__label">{l.label}</span>
							<button class="feed-lens__x" aria-label={`Remove “${l.label}”`} title="Remove"
								onClick={() => void changeLenses(() => window.api['feed:remove-lens'](l.id), 'remove the filter')}>×</button>
						</span>
					)}</For>
				</div>
			</Show>
			<Show when={showFollowing()}>
				<FollowingPanel
					onClose={() => setShowFollowing(false)}
					onToast={props.onToast}
					onCountChange={(n) => {
						setFollowCount(n);
						loadCatalog();
					}}
					onManage={() => setManageOpen(true)}
					version={followVersion}
				/>
			</Show>
			<Show when={manageOpen()}>
				<ManageFollowingModal
					onClose={() => setManageOpen(false)}
					onToast={props.onToast}
					onChanged={() => {
						setFollowVersion((v) => v + 1);
						loadCatalog();
					}}
				/>
			</Show>
			<div class="feed-scroll" ref={scrollEl} onScroll={handleScroll}>
				<Show when={items().length > 0} fallback={
					<div class="feed-empty">
						<Show when={!loading()} fallback={<span>Loading…</span>}>
							<Show when={mode() === 'archived'} fallback={<>
								<span>Nothing here yet.</span>
								<Show when={follower()} fallback={
									<span class="feed-empty__sub">New tracks from playlists you follow and new releases from artists you follow on Spotify land here. Hit Refresh to poll now.</span>
								}>
									<span class="feed-empty__sub">Discover is collected on your account's main device; the archive, dismiss and mute decisions made there apply to the items here. To collect on this computer, make it the main device in Settings → Account.</span>
								</Show>
							</>}>
								<span>No archived items.</span>
								<span class="feed-empty__sub">Archive a card to set it aside here without deleting it.</span>
							</Show>
						</Show>
					</div>
				}>
					<For each={items()}>{(it) => <Card item={it} />}</For>
					<Show when={loading()}><div class="feed-loading-more">Loading…</div></Show>
				</Show>
				{/* End-of-feed: everything fetched so far is loaded — offer to
				    extend the history horizon. The days selector is the
				    Discover "load more" setting (persisted). */}
				<Show when={mode() === 'feed' && !follower() && !nextCursor() && !loading()}>
					<div class="feed-loadmore">
						<button class="feed-loadmore__btn" disabled={loadingMore()} onClick={() => void loadMoreHistory()}>
							{loadingMore() ? `Loading ${loadMoreDays()} more days…` : `Load ${loadMoreDays()} more days`}
						</button>
						<select
							class="feed-loadmore__days"
							title="How far back each Load More goes"
							value={String(loadMoreDays())}
							disabled={loadingMore()}
							onChange={(e) => setDaysSetting(Number(e.currentTarget.value))}
						>
							<option value="3">3 days</option>
							<option value="7">7 days</option>
							<option value="14">14 days</option>
							<option value="30">30 days</option>
						</select>
					</div>
				</Show>
			</div>
		</div>
	);

	const dispose = render(() => <View />, host);
	ensureLoaded();
	// Live enrichment push — fold fresh genre/label/bpm onto cards as the
	// background drain lands them (no manual refresh). Unsubscribed on destroy.
	const unsubEnriched = window.api.onFeedEnriched?.((item) => applyEnriched(item));
	const unsubLenses = window.api.onFeedLensesChanged?.((next) => lensesChanged(next));
	return {
		destroy: () => { unsubEnriched?.(); unsubLenses?.(); disposePassToasts(); dispose(); },
		refresh: () => { loadRole(); void loadPage(true); },
		playNext: () => { void playNextFromLast(); },
		markUnavailable: (itemId, sourceTrackId) => { void handleUnavailable(itemId, sourceTrackId); },
		setNowPlaying: (sourceTrackId) => { setNowPlaying(sourceTrackId); },
		notePlayback: (positionSec, playing) => { notePlayback(positionSec, playing); },
		openPlayingTrackMenu: (evt) => openPlayingTrackMenu(evt),
		getLenses: () => lenses().map((l) => ({ id: l.id, label: l.label })),
		getNavState: navState,
		applyNavState: (next, { reload }) => {
			const cur = navState();
			const changed = cur.archived !== next.archived;
			if (changed) {
				setMode(next.archived ? 'archived' : 'feed');
				setItems([]);
				setNextCursor(null);
			}
			// The mount-time self-load already serves an unchanged state — don't
			// queue a second page-1 fetch behind it.
			if (changed || (reload && !(loading() && items().length === 0))) void loadPage(true);
		},
		getScrollTop: () => scrollEl?.scrollTop ?? 0,
		setScrollTop: (n) => { if (scrollEl) scrollEl.scrollTop = n; },
	};
}
