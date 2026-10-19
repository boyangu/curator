import { describe, it, expect } from 'vitest';
import { SpotifyKbResolver, type SpotifyKbClient } from './spotify.js';
import type { KbEntitySnapshot } from '../types.js';

const snapshot = (name = 'Seed'): KbEntitySnapshot => ({ id: 'ent-1', kind: 'artist', name, knownFacts: {} });

function fakeClient(overrides: Partial<SpotifyKbClient> = {}): SpotifyKbClient {
	return {
		async getArtists(ids) {
			return ids.map((id) => ({ id, name: 'Seed', genres: ['melodic techno'], images: [{ url: 'http://img/a.jpg' }] }));
		},
		async getArtistAlbumsPage() { return { href: '', items: [], limit: 50, next: null, offset: 0, previous: null, total: 0 }; },
		async searchArtists() { return []; },
		async getAlbums() { return []; },
		async getAlbumTracks() { return []; },
		async getTracksByIds() { return []; },
		...overrides,
	};
}

describe('SpotifyKbResolver', () => {
	it('artist.detail emits the artist + genre stubs + entity-genre edges', async () => {
		const r = new SpotifyKbResolver(async () => fakeClient());
		const page = await r.fetchPage({ kind: 'artist', aspect: 'detail', sourceId: 'sp1', entity: snapshot(), cursor: null });
		expect(page.cursor).toBeNull();
		expect(page.entities.map((e) => `${e.kind}:${e.name}`)).toEqual(['artist:Seed', 'genre:melodic techno']);
		expect(page.edges).toEqual([
			{ kind: 'entity-genre', src: { entityId: 'ent-1' }, dst: { source: 'spotify', sourceKind: 'genre', sourceId: 'name:melodic techno' } },
		]);
	});

	it('artist.releases pages by offset and credits co-artists as ride-along drafts', async () => {
		const album = (id: string, artists: { id: string; name: string }[]) => ({
			id, name: id, album_type: 'single', album_group: 'single', release_date: '2026-01-01',
			total_tracks: 1, images: [], artists,
		});
		const client = fakeClient({
			async getArtistAlbumsPage(_id, opts) {
				const offset = opts?.offset ?? 0;
				return offset === 0
					? { href: '', items: [album('a1', [{ id: 'sp1', name: 'Seed' }, { id: 'sp2', name: 'Friend' }])], limit: 1, next: 'more', offset: 0, previous: null, total: 2 }
					: { href: '', items: [album('a2', [{ id: 'sp1', name: 'Seed' }])], limit: 1, next: null, offset: 1, previous: null, total: 2 };
			},
		});
		const r = new SpotifyKbResolver(async () => client);
		const p1 = await r.fetchPage({ kind: 'artist', aspect: 'releases', sourceId: 'sp1', entity: snapshot(), cursor: null });
		expect(p1.cursor).toEqual({ offset: 1 });
		// Release draft + co-artist draft; the expanded artist itself edges by KB id.
		expect(p1.entities.map((e) => `${e.kind}:${e.name}`)).toEqual(['release:a1', 'artist:Friend']);
		expect(p1.edges).toHaveLength(2);
		const p2 = await r.fetchPage({ kind: 'artist', aspect: 'releases', sourceId: 'sp1', entity: snapshot(), cursor: p1.cursor });
		expect(p2.cursor).toBeNull();
	});

	it('release.tracks maps label, ISRCs, positions and track-artist credits', async () => {
		const client = fakeClient({
			async getAlbums(ids) {
				return [{ id: ids[0]!, name: 'EP', album_type: 'ep', release_date: '2025-05-05', total_tracks: 1, images: [{ url: 'http://img/ep.jpg', width: 1, height: 1 }], artists: [], label: 'Afterlife' }];
			},
			async getAlbumTracks() {
				return [{ id: 't1', name: 'Opening', duration_ms: 421000, explicit: false, track_number: 1, disc_number: 1, artists: [{ id: 'sp1', name: 'Seed' }] }];
			},
			async getTracksByIds(ids) {
				return ids.map((id) => ({ id, name: 'Opening', duration_ms: 421000, explicit: false, external_ids: { isrc: 'GB-XYZ' }, artists: [{ id: 'sp1', name: 'Seed' }], album: { id: 'al1', name: 'EP', release_date: '2025-05-05', images: [] } }));
			},
		});
		const r = new SpotifyKbResolver(async () => client);
		const page = await r.fetchPage({ kind: 'release', aspect: 'tracks', sourceId: 'al1', entity: { ...snapshot(), kind: 'release' }, cursor: null });
		const kinds = page.entities.map((e) => `${e.kind}:${e.name}`);
		expect(kinds).toContain('label:Afterlife');
		expect(kinds).toContain('track:Opening');
		const track = page.entities.find((e) => e.kind === 'track')!;
		expect(track.isrc).toBe('GB-XYZ');
		expect(track.durationSec).toBe(421);
		expect(page.edges.map((e) => e.kind).sort()).toEqual(['release-label', 'release-track', 'track-artist']);
		expect(page.edges.find((e) => e.kind === 'release-track')!.position).toBe(1);
	});

	it('unifies an id-less artist by exact folded search match; throws on no match', async () => {
		const seen: string[] = [];
		const client = fakeClient({
			async searchArtists(q) {
				seen.push(q);
				return [{ id: 'found-1', name: 'Bén Böhmer' }, { id: 'other', name: 'Ben Bohmer Tribute Band' }];
			},
		});
		const r = new SpotifyKbResolver(async () => client);
		const page = await r.fetchPage({ kind: 'artist', aspect: 'detail', sourceId: null, entity: snapshot('Ben Bohmer'), cursor: null });
		// Detail fetched via the matched id → the draft carries it.
		expect(page.entities[0]!.sourceId).toBe('found-1');
		expect(seen).toEqual(['Ben Bohmer']);
		const none = new SpotifyKbResolver(async () => fakeClient());
		await expect(
			none.fetchPage({ kind: 'artist', aspect: 'detail', sourceId: null, entity: snapshot('Nobody'), cursor: null }),
		).rejects.toThrow(/no exact Spotify match/);
	});

	it('throws cleanly when Spotify is not connected', async () => {
		const r = new SpotifyKbResolver(async () => null);
		await expect(
			r.fetchPage({ kind: 'artist', aspect: 'detail', sourceId: 'sp1', entity: snapshot(), cursor: null }),
		).rejects.toThrow(/not connected/);
	});
});
