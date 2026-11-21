import { describe, expect, it } from 'vitest';
import type { WorldHit, WorldSearchPart, WorldSearchResult } from '@curator/shared';
import { normalizeCatalogRef } from './catalogRows.js';
import { mergeWorldHits, worldSourcesText, worldStatusText } from './worldHits.js';

const hit = (kind: WorldHit['kind'], name: string, keys: string[], source: string, over: Partial<WorldHit> = {}): WorldHit => ({
	kind, name, detail: null, imageUrl: null, ref: { kind: kind === 'track' ? 'album' : kind, name }, keys, sources: [source], ...over,
});
const parts = (over: Partial<Record<WorldSearchPart, WorldHit[]>>): Map<WorldSearchPart, WorldSearchResult> =>
	new Map((Object.entries(over) as [WorldSearchPart, WorldHit[]][]).map(([part, hits]) => [part, { part, hits }]));

describe('world hits', () => {
	it('shows one row for a thing two parts found, opened by every id either carries', () => {
		const merged = mergeWorldHits(parts({
			// Arrival order is not merge order: the catalogue answered first here.
			catalog: [hit('artist', 'Northfold', ['catalog:art-1', 'spotify:artist:spA'], 'catalog', { ref: { kind: 'artist', name: 'Northfold', catalogId: 'art-1' }, imageUrl: 'https://img.test/c.jpg' })],
			streaming: [hit('artist', 'Northfold', ['spotify:artist:spA'], 'spotify', { ref: { kind: 'artist', name: 'Northfold', spotifyId: 'spA' }, detail: 'melodic house' })],
		}), 'north');
		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({
			ref: { kind: 'artist', name: 'Northfold', spotifyId: 'spA', catalogId: 'art-1' },
			detail: 'melodic house',
			imageUrl: 'https://img.test/c.jpg',
			sources: ['spotify', 'catalog'],
			keys: ['spotify:artist:spA', 'catalog:art-1'],
		});
		expect(worldSourcesText(merged[0]!)).toBe('Spotify · Catalogue');
	});

	it('never merges by name: two artists of one name are two rows', () => {
		const merged = mergeWorldHits(parts({
			streaming: [hit('artist', 'Fade', ['spotify:artist:a'], 'spotify'), hit('artist', 'Fade', ['spotify:artist:b'], 'spotify')],
			catalog: [hit('artist', 'Fade', ['catalog:x', 'spotify:artist:b'], 'catalog'), hit('artist', 'Fade', ['catalog:y'], 'catalog')],
		}), 'fade');
		expect(merged.map((h) => h.keys)).toEqual([['spotify:artist:a'], ['spotify:artist:b', 'catalog:x'], ['catalog:y']]);
	});

	it('puts a name that is exactly the query first, then artists, labels, albums, tracks', () => {
		const merged = mergeWorldHits(parts({
			streaming: [
				hit('artist', 'Glass Rivers Band', ['s:1'], 'spotify'),
				hit('album', 'Glass Rivers', ['s:2'], 'spotify'),
				hit('track', 'Glass Rivers (Edit)', ['s:3'], 'spotify', { recordingId: 'spotify_t' }),
			],
			stores: [hit('label', 'Glass Rivers Records', ['beatport:label:9'], 'beatport')],
		}), 'glass rivers');
		expect(merged.map((h) => `${h.kind}:${h.name}`)).toEqual(['album:Glass Rivers', 'artist:Glass Rivers Band', 'label:Glass Rivers Records', 'track:Glass Rivers (Edit)']);
	});

	it('says which parts are still out and why one has nothing to add', () => {
		const answered = new Map<WorldSearchPart, WorldSearchResult>([['streaming', { part: 'streaming', hits: [], note: 'not_connected' }], ['catalog', { part: 'catalog', hits: [], note: 'signed_out' }]]);
		expect(worldStatusText(answered, new Set(['stores']))).toBe('Searching the stores… · Spotify is not available right now · Sign in to Curator Cloud to search the catalogue too');
		expect(worldStatusText(new Map(), new Set(['streaming', 'catalog', 'stores']))).toBe('Searching your streaming service, the catalogue, the stores…');
		expect(worldStatusText(parts({ streaming: [] }), new Set())).toBeNull();
	});
});

describe('a ref off a streaming row', () => {
	it('names the entity by the service, not by a catalogue object', () => {
		expect(normalizeCatalogRef({ kind: 'artist', name: 'Fade', catalogId: 'spotify_6ybV' })).toEqual({ kind: 'artist', name: 'Fade', catalogId: null, spotifyId: '6ybV' });
		const real = { kind: 'artist' as const, name: 'Fade', catalogId: '75db776e-df95-4b02-b243-6ad2171696e1' };
		expect(normalizeCatalogRef(real)).toBe(real);
		expect(normalizeCatalogRef({ kind: 'label', name: 'X' })).toEqual({ kind: 'label', name: 'X' });
	});
});
