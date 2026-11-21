// The context menu of a catalogue row — a Global Catalog recording on an
// entity page's World side that the library does not hold (catalogRows.ts).
//
// None of the library's track commands apply to it (trackCommands.ts refuses
// a selection holding one): there is nothing to tag, rate, edit or delete.
// What a catalogue row offers is the way to it — play it, open where it
// lives (or search Beatport for it), copy its link on the streaming service,
// go to its artist / album / label — the way in: pin it, which brings it
// into the library like a feed track — and, for rows the stores have not
// been asked about yet, looking up their BPM, key, genre and label now.

import type { EntityRef, StreamingService, Track } from '@curator/shared';
import type { ContextMenuHandlers, ContextMenuItem } from '../components/ContextMenu.jsx';
import { catalogArtistId, catalogStreamId, isCatalogRow } from '../catalogRows.js';
import { BRAND_ORDER, brandIcon } from './brandIcons.js';
import { ICON_COPY, searchQuery } from './trackCommands.js';

export interface CatalogRowActions {
	primary: StreamingService | null;
	play(t: Track): void;
	// Bring the recording into the library as an Interested track (through
	// its Spotify id — the one route a promotion has today).
	pin(t: Track): void;
	open(ref: EntityRef, gesture: { newTab: boolean }): void;
	openLink(url: string, source: string): void;
	copyLink(url: string, service: string): void;
	// Look the rows up at the stores now (the page's work, asked for by hand).
	enrich(rows: Track[]): void;
	// Why that cannot be asked on this page right now; null when it can.
	enrichBlocked: string | null;
}

// A row the stores can still add to: no BPM, key, genre or label.
export const lacksDjFacts = (t: Track): boolean => t.bpm == null || !t.keyCamelot || !t.genre || !t.label;

// The row's page on a streaming service, as a link to share.
const STREAM_URL: Record<StreamingService, (id: string) => string> = {
	spotify: (id) => `https://open.spotify.com/track/${id}`,
	tidal: (id) => `https://tidal.com/browse/track/${id}`,
};

const SERVICE_NAMES: Record<string, string> = {
	spotify: 'Spotify', tidal: 'Tidal', beatport: 'Beatport', bandcamp: 'Bandcamp', traxsource: 'Traxsource',
	soundcloud: 'SoundCloud', youtube: 'YouTube', deezer: 'Deezer', apple: 'Apple Music', beatsource: 'Beatsource',
};
const serviceName = (s: string): string => SERVICE_NAMES[s] ?? s.charAt(0).toUpperCase() + s.slice(1);

// The row's pages (artist(s), album, label) as refs by the catalogue's ids.
function pagesOf(t: Track): { label: string; chip: string; ref: EntityRef }[] {
	const out: { label: string; chip: string; ref: EntityRef }[] = [];
	(t.artists ?? []).forEach((a, i) => {
		const id = catalogArtistId(t.artistIds?.[i]);
		if (a.name && id) out.push({ label: a.name, chip: 'Artist', ref: { kind: 'artist', name: a.name, catalogId: id } });
	});
	if (t.catalog && t.albumTitle) out.push({ label: t.albumTitle, chip: 'Album', ref: { kind: 'album', name: t.albumTitle, catalogId: t.catalog.releaseId } });
	if (t.label) out.push({ label: t.label, chip: 'Label', ref: { kind: 'label', name: t.label, catalogId: t.catalog?.labelId ?? null } });
	return out;
}

// `selection`: the rows selected with the one clicked (itself included). Only
// the lookup acts on all of them; the rest of the menu is the clicked row's.
export function buildCatalogRowMenu(t: Track, actions: CatalogRowActions, selection: readonly Track[] = [t]): { items: ContextMenuItem[]; handlers: ContextMenuHandlers } {
	const items: ContextMenuItem[] = [{ kind: 'header', label: t.title }];
	const handlers: ContextMenuHandlers = {};

	const playable = catalogStreamId(t, actions.primary) !== null;
	const why = actions.primary
		? `The catalogue has no ${serviceName(actions.primary)} page for this track`
		: 'Connect Spotify or Tidal to play catalogue tracks';
	items.push({ kind: 'item', id: 'play', label: actions.primary ? `Play on ${serviceName(actions.primary)}` : 'Play', disabled: !playable, ...(playable ? {} : { title: why }), mnemonic: 'P' });
	handlers.play = () => actions.play(t);

	const pinnable = !!t.catalog?.streamIds.spotify;
	items.push({
		kind: 'item', id: 'pin', label: 'Pin to Interested', disabled: !pinnable, mnemonic: 'I',
		...(pinnable ? {} : { title: 'Only tracks the catalogue has on Spotify can be brought into the library for now' }),
	});
	handlers.pin = () => actions.pin(t);

	// Offered while any of the rows still lacks one of the four.
	const bare = selection.filter((row) => isCatalogRow(row) && lacksDjFacts(row));
	if (bare.length > 0) {
		const beatport = brandIcon('beatport');
		items.push({
			kind: 'item', id: 'enrich', mnemonic: 'E', ...(beatport ? { iconHtml: beatport } : {}),
			label: bare.length === 1 ? 'Enrich with BPM, Key, Genre, Label' : `Enrich ${bare.length} Tracks with BPM, Key, Genre, Label`,
			disabled: actions.enrichBlocked !== null, ...(actions.enrichBlocked ? { title: actions.enrichBlocked } : {}),
		});
		handlers.enrich = () => actions.enrich(bare);
	}

	const pages = pagesOf(t);
	if (pages.length > 0) {
		items.push({ kind: 'divider' });
		const row = (prefix: string, newTab: boolean): ContextMenuItem[] =>
			pages.map((p, i) => {
				const id = `${prefix}-${i}`;
				handlers[id] = () => actions.open(p.ref, { newTab });
				return { kind: 'item' as const, id, label: p.label, chip: p.chip };
			});
		items.push({ kind: 'submenu', id: 'go', label: 'Navigate to', items: row('go', false), mnemonic: 'N' });
		items.push({ kind: 'submenu', id: 'tab', label: 'Open in new tab', items: row('tab', true), mnemonic: 'T' });
	}

	const links = [...(t.catalog?.links ?? [])]
		.filter((l) => l.url)
		.sort((a, b) => {
			const rank = (s: string): number => { const i = BRAND_ORDER.indexOf(s); return i < 0 ? BRAND_ORDER.length : i; };
			return rank(a.source) - rank(b.source);
		});
	items.push({ kind: 'divider' });
	for (const l of links) {
		const id = `link-${l.source}`;
		const icon = brandIcon(l.source);
		items.push({ kind: 'item', id, label: `Open in ${serviceName(l.source)}`, ...(icon ? { iconHtml: icon } : {}) });
		handlers[id] = () => actions.openLink(l.url!, l.source);
	}
	// No Beatport page known for it: the store's own search, as on a library track.
	if (!links.some((l) => l.source === 'beatport')) {
		const icon = brandIcon('beatport');
		items.push({ kind: 'item', id: 'search-beatport', label: 'Search in Beatport', ...(icon ? { iconHtml: icon } : {}) });
		handlers['search-beatport'] = () => actions.openLink(`https://www.beatport.com/search?q=${encodeURIComponent(searchQuery(t))}`, 'beatport');
	}
	// The row's link on the service catalogue rows play through.
	if (actions.primary) {
		const service = actions.primary;
		const streamId = catalogStreamId(t, service);
		items.push({
			kind: 'item', id: 'copy-stream-url', label: `Copy ${serviceName(service)} URL`, iconHtml: ICON_COPY,
			disabled: !streamId, ...(streamId ? {} : { title: why }),
		});
		handlers['copy-stream-url'] = () => { if (streamId) actions.copyLink(STREAM_URL[service](streamId), serviceName(service)); };
	}
	return { items, handlers };
}
