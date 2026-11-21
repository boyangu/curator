// Entity pages of what the catalogue does not know, shown from the streaming
// service (service.ts over streaming.ts): a seeded temp library, a stand-in
// catalogue client and a stand-in streaming catalogue — never the live
// database, never the network.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogBrowseResult, CatalogClaim, CatalogObjectSummary, CatalogRef, CatalogTracksResult } from '@curator/protocol';
import type { SpotifyTrack } from '@curator/spotify';
import { migrate } from '../db/migrate.js';
import type { SpotifyMatchClient } from '../feed/spotify-match.js';
import type { EntityCatalog } from './resolve.js';
import { createEntityPages } from './service.js';
import type { StreamingCatalog, StreamingHit } from './streaming.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-entity-stream-'));
	const p = join(dir, 'c.db');
	migrate(p);
	db = new Database(p);
	// Marsh is linked to Spotify; Nox Vahn is a local-files-only artist.
	db.prepare(`insert into artist (id, name, name_ascii, created_at, updated_at) values ('a1', 'Marsh', 'marsh', 1, 1), ('a2', 'Nox Vahn', 'noxvahn', 1, 1)`).run();
	db.prepare(`insert into artist_link (artist_id, source, source_id, url) values ('a1', 'spotify', 'spA1', null)`).run();
	const track = db.prepare(
		`insert into track (id, title, artists, duration, isrc, membership, state, created_at, updated_at) values (?, ?, ?, ?, ?, 'local', 'backlog', 1, 1)`,
	);
	track.run('t1', 'Lailonie', '[{"name":"Marsh"}]', 400, null);
	track.run('t2', 'Brainwasher', '[{"name":"Nox Vahn"},{"name":"Marsh"}]', 360, 'GBAAA2600009');
	db.prepare(`insert into source_link (id, track_id, source, source_track_id) values ('s1', 't1', 'spotify', 'spT1'), ('s2', 't2', 'local', 'c:/m/2.flac')`).run();
	db.prepare(`insert into track_artist (track_id, artist_id, role, position) values ('t1', 'a1', null, 0), ('t2', 'a2', null, 0), ('t2', 'a1', null, 1)`).run();
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const summary = (id: string, kind: CatalogObjectSummary['kind'], name: string): CatalogObjectSummary => ({ id, kind, name, handles: [], coverUrl: null, watchCount: 0 });

function fakeCatalog(over: { refs?: Record<string, CatalogObjectSummary>; browse?: Record<string, CatalogBrowseResult>; tracks?: CatalogTracksResult; status?: 'ok' | 'signed_out' | 'server_off' } = {}): EntityCatalog & { calls: string[]; refs: Record<string, CatalogObjectSummary> } {
	const calls: string[] = [];
	const refs = over.refs ?? {};
	return {
		calls,
		refs,
		reportEnrichment: async () => ({ results: [], created: 0, attached: 0, duplicate: false }),
		status: () => (over.status && over.status !== 'ok' ? { available: false, reason: over.status } : { available: true, reason: 'ok' }),
		offersPages: () => true,
		async resolve(asked: CatalogRef[]) {
			calls.push(`resolve:${asked.map((r) => `${r.provider}/${r.providerId}`).join(',')}`);
			return asked.map((r) => refs[`${r.provider}:${r.kind}:${r.providerId}`] ?? null);
		},
		async browse(id: string) {
			const b = over.browse?.[id];
			if (!b) throw new Error('catalog_not_found');
			return b;
		},
		find: async () => [],
		async tracks(id: string, cursor?: string) {
			calls.push(`tracks:${id}:${cursor ?? ''}`);
			return over.tracks!;
		},
	};
}

const release = (id: string, date: string, tracks: [string, string][] = []): CatalogClaim => ({
	provider: 'spotify', kind: 'release', providerId: id, name: `Release ${id}`, url: `https://open.spotify.com/album/${id}`,
	facts: { releaseDate: date, releaseType: 'single', coverUrl: `https://img.test/${id}.jpg`, trackCount: tracks.length || 2, ...(tracks.length ? { labelText: 'Glasshouse' } : {}) },
	artists: [{ provider: 'spotify', kind: 'artist', providerId: 'spA1', name: 'Marsh' }],
	recordings: tracks.map(([tid, name], i) => ({ provider: 'spotify' as const, kind: 'recording' as const, providerId: tid, name, facts: { durationSec: 400, trackNumber: i + 1 } })),
});

function fakeStreaming(over: { listing?: CatalogClaim[]; full?: Record<string, CatalogClaim>; hits?: StreamingHit[]; artist?: boolean } = {}): StreamingCatalog & { asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		service: 'spotify',
		async artist(id) {
			asked.push(`artist:${id}`);
			return over.artist === false ? null : { id, name: 'Marsh (Spotify)', imageUrl: 'https://img.test/marsh.jpg', genres: ['melodic house'], url: `https://open.spotify.com/artist/${id}` };
		},
		async listing(id) {
			asked.push(`listing:${id}`);
			return { total: (over.listing ?? []).length + 5, releases: over.listing ?? [] };
		},
		async releases(ids) {
			asked.push(`releases:${ids.join(',')}`);
			return new Map(ids.flatMap((id) => (over.full?.[id] ? [[id, over.full[id]!] as const] : [])));
		},
		async search(q) {
			asked.push(`search:${q}`);
			return over.hits ?? [];
		},
	};
}

function pagesOver(catalog: ReturnType<typeof fakeCatalog> | null, stream: StreamingCatalog | null, spotifyMatch?: () => Promise<SpotifyMatchClient | null>) {
	return createEntityPages({
		raw: db,
		fetch: async () => ({ ok: false, json: async () => null }) as Response,
		pictureWaitMs: 0,
		catalog: () => catalog,
		countTracks: () => 1,
		albumSummary: () => null,
		artistByName: (name) => (name === 'Marsh' ? { id: 'a1', name: 'Marsh' } : null),
		streaming: () => stream,
		...(spotifyMatch ? { spotifyMatch } : {}),
	});
}

const marsh = { kind: 'artist' as const, name: 'Marsh', libraryId: 'a1' };

describe('a page of what the catalogue does not know', () => {
	it('is the streaming service’s: its header and its releases, with the library’s own tracks recognised', async () => {
		const stream = fakeStreaming({
			listing: [release('al2', '2026-05-01'), release('al1', '2025-01-01')],
			full: { al2: release('al2', '2026-05-01', [['spT9', 'New One']]), al1: release('al1', '2025-01-01', [['spT1', 'Lailonie'], ['spT8', 'Other']]) },
		});
		const catalog = fakeCatalog();
		const pages = pagesOver(catalog, stream);
		const h = await pages.page(marsh);
		expect(h.ref).toMatchObject({ libraryId: 'a1', spotifyId: 'spA1', catalogId: null, name: 'Marsh' });
		expect(h.world).toEqual({ available: true, reason: 'ok', releaseCount: 7, trackCount: null, via: 'spotify' });
		expect(h).toMatchObject({ imageUrl: 'https://img.test/marsh.jpg', genres: [{ name: 'melodic house' }], follow: { following: false, muted: false } });
		expect(h.links).toEqual([{ source: 'spotify', sourceId: 'spA1', url: 'https://open.spotify.com/artist/spA1' }]);

		const page = await pages.tracks(h.ref);
		expect(page.albums.map((a) => [a.id, a.date, a.label, a.trackCount])).toEqual([['spotify_al2', '2026-05-01', { id: null, name: 'Glasshouse' }, 1], ['spotify_al1', '2025-01-01', { id: null, name: 'Glasshouse' }, 2]]);
		expect(page.tracks.map((t) => [t.recordingId, t.releaseId, t.streamIds.spotify, t.libraryTrackId, t.artists.map((a) => a.id)])).toEqual([
			['spotify_spT9', 'spotify_al2', 'spT9', null, ['spotify_spA1']],
			// The library holds this one under the same Spotify id.
			['spotify_spT1', 'spotify_al1', 'spT1', 't1', ['spotify_spA1']],
			['spotify_spT8', 'spotify_al1', 'spT8', null, ['spotify_spA1']],
		]);
		expect(page.nextCursor).toBeNull();
		// The catalogue was asked who this is, never for its pages.
		expect(catalog.calls.every((c) => c.startsWith('resolve:'))).toBe(true);
	});

	it('pages through the listing twenty releases a call, and stays on the service once it began there', async () => {
		const listing = Array.from({ length: 45 }, (_, i) => release(`al${i}`, `20${String(60 - i).padStart(2, '0')}-01-01`));
		const stream = fakeStreaming({ listing, full: Object.fromEntries(listing.map((c) => [c.providerId, release(c.providerId, c.facts!.releaseDate!, [[`${c.providerId}-t`, 'A']])])) });
		const catalog = fakeCatalog();
		const pages = pagesOver(catalog, stream);
		const h = await pages.page(marsh);
		const first = await pages.tracks(h.ref);
		expect([first.albums.length, first.albums[0]!.id, first.nextCursor]).toEqual([20, 'spotify_al0', 's:20']);
		// The catalogue learns the artist between two pages: the list goes on where it began.
		catalog.refs['spotify:artist:spA1'] = summary('art-1', 'artist', 'Marsh');
		const second = await pages.tracks(h.ref, { cursor: first.nextCursor! });
		expect([second.albums.length, second.albums[0]!.id, second.nextCursor]).toEqual([20, 'spotify_al20', 's:40']);
		const last = await pages.tracks(h.ref, { cursor: second.nextCursor! });
		expect([last.albums.length, last.nextCursor]).toEqual([5, null]);
		// Twenty a call: the first page's with the header (on their way before the list asks), then a page each.
		expect(stream.asked.filter((a) => a.startsWith('releases:')).map((a) => a.split(',').length)).toEqual([20, 20, 20, 5]);
		expect(catalog.calls.some((c) => c.startsWith('tracks:'))).toBe(false);
	});

	it('leaves the streaming service alone for what the catalogue knows, and while the catalogue is only out of reach', async () => {
		const stream = fakeStreaming({ listing: [release('al1', '2025-01-01')] });
		const known = fakeCatalog({
			refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') },
			browse: { 'art-1': { object: { ...summary('art-1', 'artist', 'Marsh'), coverUrl: 'https://img.test/c.jpg' }, redirectedFrom: null, releaseCount: 3, watch: null } },
			tracks: { object: { id: 'art-1', kind: 'artist', name: 'Marsh' }, redirectedFrom: null, releases: [], nextCursor: null },
		});
		const pages = pagesOver(known, stream);
		const h = await pages.page(marsh);
		expect(h.world).toMatchObject({ available: true, reason: 'ok', releaseCount: 3 });
		expect(h.world.via).toBeUndefined();
		await pages.tracks(h.ref);
		expect(known.calls).toContain('tracks:art-1:');

		const off = await pagesOver(fakeCatalog({ status: 'server_off' }), stream).page(marsh);
		expect(off.world).toMatchObject({ available: false, reason: 'server_off' });
		expect(stream.asked).toEqual([]);
	});

	it('stands in for the catalogue when there is none to ask', async () => {
		const stream = fakeStreaming({ listing: [release('al1', '2025-01-01')], full: { al1: release('al1', '2025-01-01', [['spT1', 'Lailonie']]) } });
		const pages = pagesOver(null, stream);
		// The library's half says the World side is being asked for.
		expect((await pages.page(marsh, { localOnly: true })).world.reason).toBe('pending');
		const h = await pages.page(marsh);
		expect(h.world).toMatchObject({ available: true, via: 'spotify' });
		// Nothing to follow in: there is no catalogue.
		expect(h.follow).toBeNull();
		expect((await pages.tracks(h.ref)).tracks.map((t) => t.libraryTrackId)).toEqual(['t1']);
		// No streaming service either: the library's side alone, as before.
		const bare = pagesOver(null, null);
		expect((await bare.page(marsh)).world).toMatchObject({ available: false, reason: 'signed_out' });
		await expect(bare.tracks(marsh)).rejects.toThrow(/Sign in to Curator Cloud/);
	});

	it('finds a local artist on the service by a track the library holds, never by the name', async () => {
		const searched: string[] = [];
		const found: SpotifyTrack = { id: 'spT2', name: 'Brainwasher', duration_ms: 361_000, explicit: false, external_ids: { isrc: 'GBAAA2600009' }, artists: [{ id: 'spNOX', name: 'Nox Vahn' }, { id: 'spA1', name: 'Marsh' }], album: { id: 'alX', name: 'Brainwasher', release_date: '2026-01-01', images: [] } };
		const match: SpotifyMatchClient = {
			searchTracks: async (q) => { searched.push(q); return q === 'isrc:GBAAA2600009' ? [found] : []; },
			searchAlbums: async () => [],
			getAlbumTracks: async () => [],
		};
		const stream = fakeStreaming({ listing: [release('al1', '2025-01-01')] });
		const pages = pagesOver(fakeCatalog(), stream, async () => match);
		const nox = { kind: 'artist' as const, name: 'Nox Vahn', libraryId: 'a2' };
		const h = await pages.page(nox);
		expect(h.ref).toMatchObject({ libraryId: 'a2', spotifyId: 'spNOX', name: 'Nox Vahn' });
		expect(h.world).toMatchObject({ available: true, via: 'spotify' });
		expect(stream.asked).toContain('listing:spNOX');
		// Once a session.
		await pages.tracks(h.ref);
		await pages.tracks(nox);
		expect(searched).toEqual(['isrc:GBAAA2600009']);
	});

	it('offers the service’s artists of the name when nothing ties one to the library’s', async () => {
		const hit = (id: string, detail: string | null): StreamingHit => ({ kind: 'artist', id, name: 'Nox Vahn', url: '', imageUrl: null, artists: [], detail, date: null, album: null, release: null });
		const stream = fakeStreaming({ hits: [hit('spN1', 'melodic house'), { ...hit('spZ', null), name: 'Nox Vahnson' }, hit('spN2', null)] });
		const pages = pagesOver(fakeCatalog(), stream, async () => ({ searchTracks: async () => [], searchAlbums: async () => [], getAlbumTracks: async () => [] }));
		const nox = { kind: 'artist' as const, name: 'Nox Vahn', libraryId: 'a2' };
		const h = await pages.page(nox);
		expect(h.world).toMatchObject({ available: false, reason: 'unknown' });
		expect(h.world.candidates).toEqual([
			{ ref: { kind: 'artist', name: 'Nox Vahn', spotifyId: 'spN1' }, detail: 'melodic house' },
			{ ref: { kind: 'artist', name: 'Nox Vahn', spotifyId: 'spN2' } },
		]);
		expect(h.ref.spotifyId).toBeNull();
		await expect(pages.tracks(h.ref)).rejects.toThrow(/does not know this one yet/);
	});

	it('shows an unknown album from the service: its facts, its credits by their own ids, its tracklist', async () => {
		const album = { ...release('alX', '2026-03-03', [['spT1', 'Lailonie'], ['spT5', 'B-side']]), name: 'Lailonie EP' };
		const stream = fakeStreaming({ full: { alX: album } });
		const pages = pagesOver(fakeCatalog(), stream);
		// A ref off a streaming row: the stand-in id in the catalogue's slot.
		const h = await pages.page({ kind: 'album', name: 'whatever', catalogId: 'spotify_alX' });
		expect(h.ref).toMatchObject({ kind: 'album', name: 'Lailonie EP', spotifyId: 'alX', catalogId: null });
		expect(h.world).toEqual({ available: true, reason: 'ok', releaseCount: 1, trackCount: 2, via: 'spotify' });
		expect(h).toMatchObject({ imageUrl: 'https://img.test/alX.jpg', facts: { releaseDate: '2026-03-03', albumType: 'single' }, follow: null });
		expect(h.artists).toEqual([{ ref: { kind: 'artist', name: 'Marsh', spotifyId: 'spA1' } }]);
		expect(h.labels).toEqual([{ ref: { kind: 'label', name: 'Glasshouse' } }]);
		const page = await pages.tracks(h.ref);
		expect(page.tracks.map((t) => [t.title, t.position, t.libraryTrackId])).toEqual([['Lailonie', 1, 't1'], ['B-side', 2, null]]);
	});
});
