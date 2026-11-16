// "Open Artist in ▸" — one submenu for an artist wherever one is named: a
// Discover credit or origin chip, a track row in any library tab, the
// sidebar's Artists folder.
//
//   Open Locally        the local (Rekordbox) collection scoped to the artist
//   Open in Spotify     when Spotify is connected: the artist's page in the
//                       desktop app, or a search for the name when no id is known
//   Open in Tidal       when Tidal is connected: the same
//   Open in SoundCloud  only when the artist's page there is known
//   Open in Beatport    only when the artist's page there is known
//   Help connect…       when the catalogue lacks a store's page for the artist
//                       (features/connectDots.ts)
//
// The pages come from one read (artists:pages): the library's links joined
// with the Global Catalog's. That read may take a moment on the first ask
// for an artist, so the menu opens without it — Spotify and Tidal wait for
// it on click, and the two stores that show only with a known page arrive as
// a late item (ContextMenu.tsx) once it answers.

import type { ArtistLink, ArtistPages, ArtistPagesTarget } from '@curator/shared';
import type { ContextMenuHandlers, ContextMenuItem } from '../components/ContextMenu.jsx';
import { artistsApi, shellApi } from '../data/api.js';
import { connectDots } from './connectDots.js';

export interface ArtistOpenDeps {
	connected(): { spotify: boolean; tidal: boolean };
	// The Rekordbox tab scoped to the library artist; `libraryArtistId` null =
	// the library holds no artist of that id or name (the caller says so).
	openLocally(target: ArtistPagesTarget, libraryArtistId: string | null): void;
}

let deps: ArtistOpenDeps | null = null;
export function configureArtistOpen(d: ArtistOpenDeps): void {
	deps = d;
}

const NONE: ArtistPages = { catalogId: null, libraryArtistId: null, pages: [] };
const page = (p: ArtistPages, source: string): ArtistLink | undefined => p.pages.find((l) => l.source === source && l.url);

// The stores "Help us connect the dots" asks about for an artist: with any of
// them unknown, the submenu ends in the way to say where the artist is.
const CONNECTABLE = ['beatport', 'soundcloud', 'bandcamp', 'spotify', 'deezer', 'tidal'] as const;

// Stores shown only with a known page, in menu order.
const KNOWN_ONLY = [
	{ source: 'soundcloud', label: 'Open in SoundCloud' },
	{ source: 'beatport', label: 'Open in Beatport' },
] as const;

// One artist's entries. `key` keeps ids apart when a menu names several.
export function artistOpenEntries(target: ArtistPagesTarget, key: string): { items: ContextMenuItem[]; handlers: ContextMenuHandlers } {
	const on = deps?.connected() ?? { spotify: false, tidal: false };
	const pages = artistsApi.pages(target).catch(() => NONE);
	const items: ContextMenuItem[] = [{ kind: 'item', id: `${key}-local`, label: 'Open Locally' }];
	const handlers: ContextMenuHandlers = {
		[`${key}-local`]: async () => deps?.openLocally(target, target.artistId ?? (await pages).libraryArtistId),
	};
	if (on.spotify) {
		items.push({ kind: 'item', id: `${key}-spotify`, label: 'Open in Spotify' });
		handlers[`${key}-spotify`] = async () => {
			await shellApi.openSpotify(page(await pages, 'spotify')?.url ?? `spotify:search:${encodeURIComponent(target.name)}`);
		};
	}
	if (on.tidal) {
		items.push({ kind: 'item', id: `${key}-tidal`, label: 'Open in Tidal' });
		handlers[`${key}-tidal`] = async () => {
			await shellApi.openExternal(page(await pages, 'tidal')?.url ?? `https://listen.tidal.com/search/artists?q=${encodeURIComponent(target.name)}`);
		};
	}
	items.push({
		kind: 'late',
		load: async () => {
			const p = await pages;
			const late: ContextMenuItem[] = [];
			const lateHandlers: ContextMenuHandlers = {};
			for (const s of KNOWN_ONLY) {
				const url = page(p, s.source)?.url;
				if (!url) continue;
				late.push({ kind: 'item', id: `${key}-${s.source}`, label: s.label });
				lateHandlers[`${key}-${s.source}`] = async () => { await shellApi.openExternal(url); };
			}
			// Needs the catalogue's own artist: a library name alone is nobody there.
			const catalogId = p.catalogId;
			if (catalogId && connectDots.available() && CONNECTABLE.some((s) => !page(p, s))) {
				late.push({ kind: 'divider' }, { kind: 'item', id: `${key}-connect`, label: 'Help connect this artist…' });
				lateHandlers[`${key}-connect`] = () => connectDots.openFor([catalogId]);
			}
			return { items: late, handlers: lateHandlers };
		},
	});
	return { items, handlers };
}

// The submenu for one artist, or for a track's several (a header per artist:
// submenus scroll, so they do not nest).
export function artistOpenSubmenu(targets: readonly ArtistPagesTarget[], id = 'open-artist-in'): { item: ContextMenuItem; handlers: ContextMenuHandlers } | null {
	const named = targets.filter((t) => t.name.trim());
	if (!named.length) return null;
	const items: ContextMenuItem[] = [];
	const handlers: ContextMenuHandlers = {};
	named.forEach((t, i) => {
		const e = artistOpenEntries(t, `${id}-${i}`);
		if (named.length > 1) items.push(...(i ? [{ kind: 'divider' as const }] : []), { kind: 'header', label: t.name });
		items.push(...e.items);
		Object.assign(handlers, e.handlers);
	});
	return { item: { kind: 'submenu', id, label: 'Open Artist in', items }, handlers };
}
