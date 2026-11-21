// The omnibar's World search (world-search.ts): each part by itself, over
// stand-ins — no network, no database.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim, CatalogKind, CatalogObjectSummary, CatalogTracksResult } from '@curator/protocol';
import type { EntityTracksPage } from '@curator/shared';
import type { StreamingCatalog, StreamingHit } from './streaming.js';
import { createWorldSearch, type WorldSearchDeps } from './world-search.js';

const hit = (kind: StreamingHit['kind'], id: string, name: string, over: Partial<StreamingHit> = {}): StreamingHit => ({ kind, id, name, url: '', imageUrl: null, artists: [], detail: null, date: null, album: null, release: null, ...over });

const trackRelease: CatalogClaim = {
	provider: 'spotify', kind: 'release', providerId: 'al1', name: 'Glass Rivers',
	artists: [{ provider: 'spotify', kind: 'artist', providerId: 'spA', name: 'Northfold' }],
	recordings: [{ provider: 'spotify', kind: 'recording', providerId: 't9', name: 'Elsewhere', facts: { durationSec: 240, trackNumber: 3 } }],
};

function streamingOf(hits: StreamingHit[]): StreamingCatalog & { searched: string[] } {
	const searched: string[] = [];
	return { searched, service: 'spotify', artist: async () => null, listing: async () => ({ total: 0, releases: [] }), releases: async () => new Map(), search: async (q) => { searched.push(q); return hits; } };
}

const object = (id: string, kind: CatalogKind, name: string, handles: CatalogObjectSummary['handles'] = []): CatalogObjectSummary => ({ id, kind, name, handles, coverUrl: null, watchCount: 0 });

function searchOver(over: Partial<WorldSearchDeps> & { find?: Partial<Record<CatalogKind, CatalogObjectSummary[] | Error>>; known?: Record<string, CatalogObjectSummary>; available?: boolean }) {
	const paged: CatalogTracksResult[] = [];
	const found: string[] = [];
	const search = createWorldSearch({
		streaming: () => null,
		catalog: () => ({
			status: () => (over.available === false ? { available: false, reason: 'signed_out' } : { available: true, reason: 'ok' }),
			find: async (q, kind) => {
				found.push(`${kind}:${q}`);
				const r = over.find?.[kind] ?? [];
				if (r instanceof Error) throw r;
				return r;
			},
			resolve: async (refs) => refs.map((r) => over.known?.[`${r.provider}:${r.providerId}`] ?? null),
		}),
		rows: (result) => {
			paged.push(result);
			return { albums: [], tracks: [], nextCursor: null, template: {} } as unknown as EntityTracksPage;
		},
		...over,
	});
	return { search, paged, found };
}

describe('world search', () => {
	it('asks the streaming service once for artists, albums and tracks, and hands the tracks back as rows', async () => {
		const stream = streamingOf([
			hit('artist', 'spA', 'Northfold', { detail: 'melodic house', imageUrl: 'https://img.test/a.jpg' }),
			hit('album', 'al1', 'Glass Rivers', { artists: [{ id: 'spA', name: 'Northfold' }], date: '2026-02-02' }),
			hit('track', 't9', 'Elsewhere', { artists: [{ id: 'spA', name: 'Northfold' }], album: { id: 'al1', name: 'Glass Rivers' }, release: trackRelease }),
		]);
		const { search, paged } = searchOver({ streaming: () => stream });
		const r = await search.search(' north ', 'streaming');
		expect(r.hits).toEqual([
			{ kind: 'artist', name: 'Northfold', detail: 'melodic house', imageUrl: 'https://img.test/a.jpg', ref: { kind: 'artist', name: 'Northfold', spotifyId: 'spA' }, keys: ['spotify:artist:spA'], sources: ['spotify'] },
			{ kind: 'album', name: 'Glass Rivers', detail: 'Northfold · 2026', imageUrl: null, ref: { kind: 'album', name: 'Glass Rivers', spotifyId: 'al1' }, keys: ['spotify:release:al1'], sources: ['spotify'] },
			// A track opens its album, and plays from its row.
			{ kind: 'track', name: 'Elsewhere', detail: 'Northfold · Glass Rivers', imageUrl: null, ref: { kind: 'album', name: 'Glass Rivers', spotifyId: 'al1' }, keys: ['spotify:recording:t9'], sources: ['spotify'], recordingId: 'spotify_t9' },
		]);
		expect(r.rows).toBeTruthy();
		expect(paged[0]!.releases.map((x) => [x.id, x.tracks.map((t) => t.id)])).toEqual([['spotify_al1', ['spotify_t9']]]);
		// The same text again: what was answered, not another call.
		await search.search('north', 'streaming');
		expect(stream.searched).toEqual(['north']);
	});

	it('says so when there is no streaming service to ask, and asks again once there is', async () => {
		let stream: StreamingCatalog | null = null;
		const { search } = searchOver({ streaming: () => stream });
		expect(await search.search('north', 'streaming')).toEqual({ part: 'streaming', hits: [], note: 'not_connected' });
		stream = streamingOf([hit('artist', 'spA', 'Northfold')]);
		expect((await search.search('north', 'streaming')).hits).toHaveLength(1);
		// Too short to mean anything: nobody is asked.
		expect(await search.search('n', 'streaming')).toEqual({ part: 'streaming', hits: [] });
	});

	it("lists the catalogue's artists, labels and releases by every id they are known by", async () => {
		const { search, found } = searchOver({
			find: {
				artist: [object('art-1', 'artist', 'Northfold', [{ provider: 'spotify', id: 'spA', url: null }, { provider: 'deezer', id: 'user/x', url: null }, { provider: 'user', id: 'local:a1', url: null }])],
				label: [object('lab-1', 'label', 'Northfold Records', [{ provider: 'beatport', id: '77', url: null }])],
				release: new Error('busy'),
			},
		});
		const r = await search.search('north', 'catalog');
		expect(found.sort()).toEqual(['artist:north', 'label:north', 'release:north']);
		expect(r.hits).toEqual([
			{ kind: 'artist', name: 'Northfold', detail: null, imageUrl: null, ref: { kind: 'artist', name: 'Northfold', catalogId: 'art-1', spotifyId: 'spA' }, keys: ['catalog:art-1', 'spotify:artist:spA'], sources: ['catalog'] },
			{ kind: 'label', name: 'Northfold Records', detail: null, imageUrl: null, ref: { kind: 'label', name: 'Northfold Records', catalogId: 'lab-1' }, keys: ['catalog:lab-1', 'beatport:label:77'], sources: ['catalog'] },
		]);
		expect(await searchOver({ available: false }).search.search('north', 'catalog')).toEqual({ part: 'catalog', hits: [], note: 'signed_out' });
		expect((await searchOver({ find: { artist: new Error('x'), label: new Error('x'), release: new Error('x') } }).search.search('north', 'catalog')).note).toBe('failed');
	});

	it('survives a store that turns the desktop away', async () => {
		const { search } = searchOver({ beatportFetch: async () => ({ ok: false, status: 403, headers: new Headers(), text: async () => 'challenge' }) as Response });
		expect(await search.search('north', 'stores')).toEqual({ part: 'stores', hits: [], note: 'failed' });
	});
});
