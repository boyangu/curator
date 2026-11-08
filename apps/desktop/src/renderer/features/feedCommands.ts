// Feed command layer — the declarative source of truth for actions on Discover
// feed items (cards) and the nested album-track rows. Mirrors features/
// trackCommands.ts: each command declares a sync `isAvailable(ctx)` over the
// feed context and a `build(ctx)` that emits its menu item(s) + handlers. The
// card menu, the nested-row menu, AND the inline card buttons all derive their
// visibility from the same predicates, so "what shows here" lives in one place.
//
// Unlike the track layer, feed actions are pure component closures (they touch
// DiscoverView's signals), so they're injected per-call via `ctx.actions`
// rather than a module-global deps object — no init step, nothing to wire in
// boot().

import type { FeedItem, FeedOrigin, FeedTrackRef } from '@curator/core';
import type { ContextMenuItem, ContextMenuHandlers } from '../components/ContextMenu.jsx';
import { allLinks, playableId } from './feedHandles.js';
import { BRAND_ICONS } from './brandIcons.js';

// The component-side action surface. DiscoverView implements this from its
// existing closures (play / interested / dismiss / archive / …); the commands
// only decide *whether* and *with what label* to surface each one.
export interface FeedActions {
	play(item: FeedItem, track?: FeedTrackRef): void;
	// Bring a not-yet-owned feed track into the library. `pin` adds the
	// `interested` ("Pinned") tag; `organize` opens the Organize modal after.
	//   • { pin:true,  organize:false } → "Interested"
	//   • { pin:true,  organize:true  } → "Interested + Organize…" (pin, then organize)
	//   • { pin:false, organize:true  } → "Organize…" (deferred: the row is created
	//     only when the user actually applies a tag/playlist — no orphan on cancel)
	interested(item: FeedItem, sourceTrackId: string, opts: { pin: boolean; organize: boolean }): void;
	archive(item: FeedItem): void;
	restore(item: FeedItem): void;
	deleteItem(item: FeedItem): void;                                  // soft remove (dismiss, no scope)
	muteArtist(item: FeedItem, artistId: string, name: string): void;  // mute one artist (track → dismiss; album → chip)
	muteArtists(item: FeedItem, artists: { id: string; name: string }[]): void; // multi-artist track: mute every credit + remove
	mutePlaylist(item: FeedItem, playlistId: string, name: string): void; // scoped dismiss: playlist
	// `catalogId`: the Global Catalog watch the item's origin names, if any.
	unfollowArtist(artistId: string, name: string, catalogId?: string): void;
	unfollowPlaylist(playlistId: string, name: string, catalogId?: string): void;
	// A catalogue label / genre the item's origin names (a watch, never a
	// provider follow).
	unfollowOrigin(kind: 'label' | 'genre', catalogId: string, name: string): void;
	muteOrigin(item: FeedItem, kind: 'label' | 'genre', catalogId: string, name: string): void;
	openSpotifyUrl(url: string): void;
	openSpotifyTrack(sourceTrackId: string): void;
	openExternal(url: string): void;
	copySpotifyUrl(url: string): void;
	isUnavailable(sourceTrackId: string): boolean;
	// In-library actions — operate on the resolved curator track id (see
	// FeedCommandContext.libraryTrackId).
	notInterested(item: FeedItem, libraryTrackId: string): void; // remove from pinned + library
	openOrganize(libraryTrackId: string): void; // open the unified tag/playlist modal
	// Start a discovery journey seeded from this feed track (card or nested
	// row) — jumps to Discover's Journeys mode.
	startJourney(item: FeedItem, track?: FeedTrackRef): void;
}

export type FeedMode = 'feed' | 'archived';

export interface FeedCommandContext {
	item: FeedItem;
	// Present for a nested album-track row; absent for a card (the menu then
	// targets the whole feed item).
	track?: FeedTrackRef;
	mode: FeedMode;
	actions: FeedActions;
	// Set when the targeted feed track is already OWNED by the library (the
	// curator track id) — pinned, a local file, or in one of the user's own
	// playlists, but NOT a merely-followed track. Flips the curate group off the
	// "Interested" (promote) face onto "Tag / Add to playlist" (the track is
	// already added). Resolved by the caller (item.libraryTrackId for a track
	// card; detail.inLibraryTrackIds for a nested album row).
	libraryTrackId?: string;
	// True when that owned track carries the `interested` ("Pinned") tag. Gates
	// the destructive "Not Interested" (un-pin + remove) so it shows for pinned
	// tracks only — a track owned merely via a local file / own playlist offers
	// just the non-destructive Tag / Add to playlist (removing it would delete the
	// file or push a live playlist removal). Resolved alongside libraryTrackId.
	pinned?: boolean;
}

// Group = divider boundary + render order.
type Group = 'play' | 'curate' | 'archive' | 'mute' | 'open';
const GROUP_ORDER: Group[] = ['play', 'curate', 'archive', 'mute', 'open'];

interface FeedCommand {
	id: string;
	group: Group;
	isAvailable(ctx: FeedCommandContext): boolean;
	// May emit 0..N items (mute-artist fans out one row per credited artist).
	build(ctx: FeedCommandContext): { items: ContextMenuItem[]; handlers: ContextMenuHandlers };
}

// ── predicates ───────────────────────────────────────────────────────────────
// A card menu acts on the whole feed item; a nested-row menu acts on one track.
const isCard = (c: FeedCommandContext): boolean => !c.track;
// One track is targeted: a nested row, or a track card (album cards have
// none → track-scoped actions stay hidden).
const hasTrack = (c: FeedCommandContext): boolean => !!c.track || c.item.type === 'track';
// The Spotify track an action targets, when the targeted track is on Spotify
// (feedHandles.ts) — what promotion, journeys and "open in Spotify" need. A
// catalogue track no player can play has none.
const targetStid = (c: FeedCommandContext): string | undefined =>
	hasTrack(c) ? playableId(c.item, c.track) ?? undefined : undefined;
// The store pages of the target: the row's own, else the release's.
// Every page the target has, Spotify's left to "Open in Spotify" when that
// item is offered (it opens the app, not the browser).
const targetLinks = (c: FeedCommandContext) => {
	const t = c.track;
	const links = t ? allLinks(t.handles?.length ? t.handles : c.item.payload.handles, t.sourceLinks) : allLinks(c.item.payload.handles, c.item.payload.sourceLinks);
	const spotifyOffered = c.track ? !!targetStid(c) : playableId(c.item) !== null;
	return spotifyOffered ? links.filter((l) => l.provider !== 'spotify') : links;
};

// Browser-search query for a feed track — title + primary artist, from the
// nested track when present, else the card payload. Feed items carry only a
// Spotify reference, so cross-source discovery is search (not deep-link) for
// Tidal/Beatport.
const feedQuery = (c: FeedCommandContext): string => {
	const title = c.track ? c.track.title : c.item.payload.title;
	const artist = (c.track ? c.track.artists : c.item.payload.artists)[0] ?? '';
	return artist ? `${title} ${artist}` : title;
};

// Shareable https://open.spotify.com/… link for the menu target — a nested row
// derives it from its sourceTrackId; a card uses the payload url (track cards
// fall back to deriving from the source id; an album card without a url has
// nothing to copy).
const feedSpotifyUrl = (c: FeedCommandContext): string | null => {
	const stid = targetStid(c);
	if (c.track) return stid ? `https://open.spotify.com/track/${stid}` : null;
	if (!playableId(c.item)) return null;
	if (c.item.payload.url?.includes('open.spotify.com')) return c.item.payload.url;
	return stid ? `https://open.spotify.com/track/${stid}` : null;
};

// The Spotify playlist a card was raised from, when its origin is one — a
// catalogue playlist origin the catalogue knows no Spotify id for
// (`catalog:<id>`, cloud-producer.ts) is not. Shared with the card so the
// PLAYLIST chip, the "New on … by …" line and this menu row agree.
export const spotifyPlaylistOrigin = (item: FeedItem): FeedOrigin | null =>
	item.origin?.kind === 'playlist' && !item.origin.id.startsWith('catalog:') ? item.origin : null;

// Exported for the inline card buttons so their show/hide matches the menu.
export const feedShow = {
	// The inline "+" promotes a track into the backlog — hidden once the library
	// already owns it (libraryTrackId set), since promoting an owned track is a
	// no-op. A followed-only track has no libraryTrackId, so it still offers it.
	quickInterested: (item: FeedItem, mode: FeedMode): boolean =>
		mode === 'feed' && item.type === 'track' && !item.libraryTrackId && playableId(item) !== null,
	archive: (mode: FeedMode): boolean => mode === 'feed',
	restore: (mode: FeedMode): boolean => mode === 'archived',
};

// Single-item leaf helper.
function leaf(
	id: string,
	label: string,
	run: () => void,
	opts?: { danger?: boolean; disabled?: boolean; iconHtml?: string },
): { items: ContextMenuItem[]; handlers: ContextMenuHandlers } {
	return {
		items: [{ kind: 'item', id, label, danger: opts?.danger, disabled: opts?.disabled, iconHtml: opts?.iconHtml }],
		handlers: { [id]: run },
	};
}

// ── command table ────────────────────────────────────────────────────────────
const FEED_COMMANDS: FeedCommand[] = [
	// play — nested rows only (cards play via the cover / dedicated buttons).
	{
		id: 'play', group: 'play', isAvailable: (c) => !!c.track,
		build: (c) => leaf('play', 'Play', () => c.actions.play(c.item, c.track), { disabled: !targetStid(c) || c.actions.isUnavailable(c.track!.sourceTrackId) }),
	},
	// curate — two faces of the same group:
	//   • not yet owned → Interested (pin) / Interested + Organize (pin, then the
	//     modal) / Organize (bring in WITHOUT pinning, deferred to first write);
	//   • already owned → a single Organize (tags + playlists in one modal), plus
	//     "Not Interested" (remove) for PINNED tracks only — see the pinned gate.
	// Hidden entirely for album cards (no single track to target — use a row).
	{
		id: 'interested', group: 'curate', isAvailable: (c) => targetStid(c) !== undefined && !c.libraryTrackId,
		build: (c) => leaf('interested', 'Interested', () => c.actions.interested(c.item, targetStid(c)!, { pin: true, organize: false })),
	},
	{
		id: 'interested-organize', group: 'curate', isAvailable: (c) => targetStid(c) !== undefined && !c.libraryTrackId,
		build: (c) => leaf('interested-organize', 'Interested + Organize…', () => c.actions.interested(c.item, targetStid(c)!, { pin: true, organize: true })),
	},
	{
		id: 'organize', group: 'curate', isAvailable: (c) => targetStid(c) !== undefined && !c.libraryTrackId,
		build: (c) => leaf('organize', 'Organize…', () => c.actions.interested(c.item, targetStid(c)!, { pin: false, organize: true })),
	},
	{
		// Destructive (removes from library — deletes a local file / pushes a live
		// playlist removal), so offered for PINNED tracks only: un-pinning a
		// discovery candidate is its natural inverse. A track owned merely via a
		// local file / own playlist gets just Organize below.
		id: 'not-interested', group: 'curate', isAvailable: (c) => !!c.libraryTrackId && !!c.pinned,
		build: (c) => leaf('not-interested', 'Not Interested', () => c.actions.notInterested(c.item, c.libraryTrackId!), { danger: true }),
	},
	{
		id: 'lib-organize', group: 'curate', isAvailable: (c) => !!c.libraryTrackId,
		build: (c) => leaf('lib-organize', 'Organize…', () => c.actions.openOrganize(c.libraryTrackId!)),
	},
	// archive — card-level set-aside / restore / delete.
	{
		id: 'archive', group: 'archive', isAvailable: (c) => isCard(c) && c.mode === 'feed',
		build: (c) => leaf('archive', 'Archive', () => c.actions.archive(c.item)),
	},
	{
		id: 'restore', group: 'archive', isAvailable: (c) => isCard(c) && c.mode === 'archived',
		build: (c) => leaf('restore', 'Restore to feed', () => c.actions.restore(c.item)),
	},
	{
		id: 'delete', group: 'archive', isAvailable: (c) => isCard(c),
		build: (c) => leaf('delete', 'Delete', () => c.actions.deleteItem(c.item), { danger: true }),
	},
	// mute / unfollow — feed-mode card menus only. Mute-artist fans out one row
	// per credited artist; unfollow + mute-playlist key off the origin chip.
	{
		id: 'mute-artist', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && (c.item.payload.artistIds ?? []).some(Boolean),
		build: (c) => {
			const items: ContextMenuItem[] = [];
			const handlers: ContextMenuHandlers = {};
			const credited = (c.item.payload.artistIds ?? [])
				.map((id, i) => ({ id, name: c.item.payload.artists[i] ?? 'artist' }))
				.filter((a): a is { id: string; name: string } => !!a.id);
			// Multi-artist TRACK only: one "Mute all artists" that silences every
			// credit and removes the track. Albums fan out per-artist — muting
			// there chips the offending tracks, never drops the release — so a
			// blanket "mute all" would have no card-level effect there.
			if (c.item.type === 'track' && credited.length > 1) {
				items.push({ kind: 'item', id: 'mute-all-artists', label: 'Mute all artists' });
				handlers['mute-all-artists'] = () => c.actions.muteArtists(c.item, credited);
			}
			credited.forEach((a, i) => {
				const id = `mute-artist-${i}`;
				items.push({ kind: 'item', id, label: `Mute artist: ${a.name}` });
				handlers[id] = () => c.actions.muteArtist(c.item, a.id, a.name);
			});
			return { items, handlers };
		},
	},
	{
		id: 'unfollow-artist', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && c.item.origin?.kind === 'artist',
		build: (c) => leaf('unfollow-artist', `Unfollow artist: ${c.item.origin!.name}`, () => c.actions.unfollowArtist(c.item.origin!.id, c.item.origin!.name, c.item.origin!.catalogId), { danger: true }),
	},
	{
		id: 'mute-playlist', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && c.item.origin?.kind === 'playlist',
		build: (c) => leaf('mute-playlist', `Mute playlist: ${c.item.origin!.name}`, () => c.actions.mutePlaylist(c.item, c.item.origin!.id, c.item.origin!.name)),
	},
	{
		id: 'mute-label', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && c.item.origin?.kind === 'label' && !!c.item.origin.catalogId,
		build: (c) => leaf('mute-label', `Mute label: ${c.item.origin!.name}`, () => c.actions.muteOrigin(c.item, 'label', c.item.origin!.catalogId!, c.item.origin!.name)),
	},
	{
		id: 'unfollow-label', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && c.item.origin?.kind === 'label' && !!c.item.origin.catalogId,
		build: (c) => leaf('unfollow-label', `Unfollow label: ${c.item.origin!.name}`, () => c.actions.unfollowOrigin('label', c.item.origin!.catalogId!, c.item.origin!.name), { danger: true }),
	},
	{
		id: 'mute-genre', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && c.item.origin?.kind === 'genre' && !!c.item.origin.catalogId,
		build: (c) => leaf('mute-genre', `Mute genre: ${c.item.origin!.name}`, () => c.actions.muteOrigin(c.item, 'genre', c.item.origin!.catalogId!, c.item.origin!.name)),
	},
	{
		id: 'unfollow-genre', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && c.item.origin?.kind === 'genre' && !!c.item.origin.catalogId,
		build: (c) => leaf('unfollow-genre', `Unfollow genre: ${c.item.origin!.name}`, () => c.actions.unfollowOrigin('genre', c.item.origin!.catalogId!, c.item.origin!.name), { danger: true }),
	},
	{
		id: 'unfollow-playlist', group: 'mute',
		isAvailable: (c) => isCard(c) && c.mode === 'feed' && c.item.origin?.kind === 'playlist',
		build: (c) => leaf('unfollow-playlist', `Unfollow playlist: ${c.item.origin!.name}`, () => c.actions.unfollowPlaylist(c.item.origin!.id, c.item.origin!.name, c.item.origin!.catalogId), { danger: true }),
	},
	// open / search — Open in Spotify (the feed's native source) is always
	// present; cross-source discovery is browser search on Tidal + Beatport,
	// shown wherever there's a single track to search (track cards + nested
	// rows). Feed items don't carry Tidal/Beatport links, so there's nothing to
	// deep-link there — only search.
	{
		// Journey seeding — any single feed track (card or nested row) can
		// embark. Album cards without a target track stay journey-less; their
		// rows offer it individually.
		id: 'start-journey', group: 'open', isAvailable: (c) => targetStid(c) !== undefined,
		build: (c) => leaf('start-journey', 'Start Journey', () => c.actions.startJourney(c.item, c.track)),
	},
	{
		id: 'open-spotify', group: 'open', isAvailable: (c) => (c.track ? !!targetStid(c) : playableId(c.item) !== null),
		build: (c) => {
			if (c.track) {
				const stid = targetStid(c)!;
				return leaf('open-spotify', 'Open in Spotify', () => c.actions.openSpotifyTrack(stid));
			}
			const url = feedSpotifyUrl(c) ?? c.item.payload.url;
			return leaf('open-spotify', 'Open in Spotify', () => { if (url) c.actions.openSpotifyUrl(url); });
		},
	},
	{
		// The followed Spotify playlist this card came from, in the Spotify
		// app. A catalogue playlist origin without a Spotify id has no page
		// there to open.
		id: 'open-spotify-playlist', group: 'open', isAvailable: (c) => isCard(c) && !!spotifyPlaylistOrigin(c.item),
		build: (c) => leaf('open-spotify-playlist', 'Open Playlist on Spotify', () => c.actions.openSpotifyUrl(`spotify:playlist:${spotifyPlaylistOrigin(c.item)!.id}`), { iconHtml: BRAND_ICONS.spotify }),
	},
	{
		// Every page the target has (Beatport, Bandcamp, SoundCloud, Deezer,
		// Tidal, …, and the store the enrichment matched): the way to hear or
		// buy it anywhere, not only what the player here can play.
		id: 'open-store', group: 'open', isAvailable: (c) => targetLinks(c).length > 0,
		build: (c) => {
			const links = targetLinks(c);
			return {
				items: links.map((l) => ({ kind: 'item' as const, id: `open-store-${l.provider}`, label: `Open in ${l.label}` })),
				handlers: Object.fromEntries(links.map((l) => [`open-store-${l.provider}`, () => c.actions.openExternal(l.url)])),
			};
		},
	},
	{
		// Copies the shareable https link (Open in Spotify uses the spotify: app
		// URI) — the feed peer of the library menu's copy-spotify-url.
		id: 'copy-spotify-url', group: 'open', isAvailable: (c) => feedSpotifyUrl(c) !== null,
		build: (c) => leaf('copy-spotify-url', 'Copy Spotify URL', () => c.actions.copySpotifyUrl(feedSpotifyUrl(c)!)),
	},
	{
		id: 'search-tidal', group: 'open', isAvailable: (c) => hasTrack(c) && !targetLinks(c).some((l) => l.provider === 'tidal'),
		build: (c) => leaf('search-tidal', 'Search in Tidal', () => c.actions.openExternal(`https://tidal.com/search?q=${encodeURIComponent(feedQuery(c))}`)),
	},
	{
		id: 'search-beatport', group: 'open', isAvailable: (c) => hasTrack(c) && !targetLinks(c).some((l) => l.provider === 'beatport'),
		build: (c) => leaf('search-beatport', 'Search in Beatport', () => c.actions.openExternal(`https://www.beatport.com/search?q=${encodeURIComponent(feedQuery(c))}`)),
	},
];

// Derive the menu (items + handler map) for a feed context by filtering the
// command table and grouping with dividers. Header is the thing's title.
export function buildFeedMenu(ctx: FeedCommandContext): { items: ContextMenuItem[]; handlers: ContextMenuHandlers } {
	const items: ContextMenuItem[] = [
		{ kind: 'header', label: ctx.track ? ctx.track.title : ctx.item.payload.title },
	];
	const handlers: ContextMenuHandlers = {};
	let emittedGroup = false;
	for (const group of GROUP_ORDER) {
		const built = FEED_COMMANDS.filter((c) => c.group === group && c.isAvailable(ctx)).map((c) => c.build(ctx));
		const groupItems = built.flatMap((b) => b.items);
		if (groupItems.length === 0) continue;
		if (emittedGroup) items.push({ kind: 'divider' });
		items.push(...groupItems);
		for (const b of built) Object.assign(handlers, b.handlers);
		emittedGroup = true;
	}
	return { items, handlers };
}
