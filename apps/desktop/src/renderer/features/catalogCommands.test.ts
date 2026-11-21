// A catalogue row's menu: what it offers by what the row and the page know.
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '@curator/shared';

vi.mock('../data/api.js', async (importOriginal) => ({ ...(await importOriginal<object>()) }));

import { buildCatalogRowMenu, type CatalogRowActions } from './catalogCommands.js';

const row = (id: string, over: Partial<Track> = {}, catalog: Partial<NonNullable<Track['catalog']>> = {}): Track =>
	({
		id: `catalog:r1:${id}`, title: 'Aria', artists: [{ name: 'André Moret' }], artistIds: ['catalog:a1'], albumTitle: 'Aria EP', label: 'Nightcolours',
		bpm: null, keyCamelot: null, genre: null, ...over,
		catalog: { recordingId: id, releaseId: 'r1', synthetic: true, libraryTrackId: null, streamIds: {}, links: [], albumArtistId: 'a1', labelId: 'l1', ...catalog },
	}) as unknown as Track;

function menu(t: Track, over: Partial<CatalogRowActions> = {}, selection?: Track[]) {
	const calls: string[] = [];
	const actions: CatalogRowActions = {
		primary: 'spotify',
		play: () => calls.push('play'),
		pin: () => calls.push('pin'),
		open: () => calls.push('open'),
		openLink: (url, source) => calls.push(`open ${source} ${url}`),
		copyLink: (url, service) => calls.push(`copy ${service} ${url}`),
		enrich: (rows) => calls.push(`enrich ${rows.map((r) => r.catalog!.recordingId).join(',')}`),
		enrichBlocked: null,
		...over,
	};
	const built = buildCatalogRowMenu(t, actions, selection);
	const item = (id: string) => built.items.find((i) => i.kind === 'item' && i.id === id) as { label: string; disabled?: boolean; title?: string } | undefined;
	return { ...built, calls, item };
}

describe('catalogue row menu', () => {
	it('searches Beatport for a row with no page there, and opens the page when it has one', () => {
		const bare = menu(row('rec-1'));
		expect(bare.item('search-beatport')?.label).toBe('Search in Beatport');
		bare.handlers['search-beatport']!();
		expect(bare.calls).toEqual(['open beatport https://www.beatport.com/search?q=Aria%20Andr%C3%A9%20Moret']);

		const known = menu(row('rec-1', {}, { links: [{ source: 'beatport', sourceId: '99', url: 'https://www.beatport.com/track/aria/99' }] }));
		expect(known.item('search-beatport')).toBeUndefined();
		expect(known.item('link-beatport')?.label).toBe('Open in Beatport');
	});

	it('copies the row\'s link on the primary streaming service', () => {
		const on = menu(row('rec-1', {}, { streamIds: { spotify: 'sp1', tidal: '77' } }));
		expect(on.item('copy-stream-url')).toMatchObject({ label: 'Copy Spotify URL' });
		on.handlers['copy-stream-url']!();
		expect(on.calls).toEqual(['copy Spotify https://open.spotify.com/track/sp1']);

		const tidal = menu(row('rec-1', {}, { streamIds: { spotify: 'sp1', tidal: '77' } }), { primary: 'tidal' });
		tidal.handlers['copy-stream-url']!();
		expect(tidal.calls).toEqual(['copy Tidal https://tidal.com/browse/track/77']);

		// Not on that service: there, but it says why it cannot.
		expect(menu(row('rec-1')).item('copy-stream-url')).toMatchObject({ disabled: true });
		// No streaming service at all: nothing to name.
		expect(menu(row('rec-1'), { primary: null }).item('copy-stream-url')).toBeUndefined();
	});

	it('offers the store lookup only for rows that lack a fact, over the whole selection', () => {
		const whole = row('rec-2', { bpm: 122, keyCamelot: '4A', genre: 'Progressive House' });
		expect(menu(whole).item('enrich')).toBeUndefined();

		const one = menu(row('rec-1'));
		expect(one.item('enrich')?.label).toBe('Enrich with BPM, Key, Genre, Label');
		one.handlers.enrich!();
		expect(one.calls).toEqual(['enrich rec-1']);

		// Three selected, one of them whole, one the library's own row: two to look up.
		const mine = row('rec-4', {}, { synthetic: false });
		const many = menu(whole, {}, [row('rec-1'), whole, row('rec-3', { bpm: 120 }), mine]);
		expect(many.item('enrich')?.label).toBe('Enrich 2 Tracks with BPM, Key, Genre, Label');
		many.handlers.enrich!();
		expect(many.calls).toEqual(['enrich rec-1,rec-3']);

		// A page still read from the streaming service: shown, and says why not yet.
		expect(menu(row('rec-1'), { enrichBlocked: 'not yet' }).item('enrich')).toMatchObject({ disabled: true, title: 'not yet' });
	});
});
