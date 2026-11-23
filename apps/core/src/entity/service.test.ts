// Entity pages over a seeded temp library and a fake catalogue client (never
// the live database): who a page is about on both sides, what its header
// says, and which library track a catalogue recording is.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogBrowseResult, CatalogObjectSummary, CatalogRef, CatalogTracksResult } from '@curator/protocol';
import type { ZTrackFilterT } from '@curator/shared';
import { migrate } from '@curator/sync-core/db/migrate';
import { matchLibraryTracks } from './ownership.js';
import type { EntityCatalog } from './resolve.js';
import { createEntityPages, OWNED_SOURCES } from './service.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-entity-'));
	const p = join(dir, 'c.db');
	migrate(p);
	db = new Database(p);
	db.prepare(`insert into artist (id, name, name_ascii, created_at, updated_at) values ('a1', 'Marsh', 'marsh', 1, 1), ('a2', 'Nox Vahn', 'noxvahn', 1, 1)`).run();
	db.prepare(`insert into artist_link (artist_id, source, source_id, url) values ('a1', 'spotify', 'spA1', null)`).run();
	db.prepare(`insert into album (id, title, title_key, album_key, label, release_date, cover_url) values ('al1', 'Lailonie', 'lailonie', 'k', 'Anjunadeep', '2026-03-01', 'https://img.test/l.jpg')`).run();
	db.prepare(`insert into album_link (album_id, source, source_id, url) values ('al1', 'spotify', 'spAL1', null)`).run();
	const track = db.prepare(
		`insert into track (id, title, artists, album_id, album_title, label, label_ascii, genre, isrc, membership, state, created_at, updated_at)
		values (?, ?, '[]', ?, ?, ?, ?, ?, ?, 'local', 'backlog', 1, 1)`,
	);
	track.run('t1', 'Lailonie', 'al1', 'Lailonie', 'Anjunadeep', 'anjunadeep', 'Melodic House', 'GBAAA2600001');
	track.run('t2', 'Eu Topos', 'al1', 'Lailonie', 'Anjunadeep', 'anjunadeep', 'Melodic House', null);
	track.run('t3', 'Brainwasher (Marsh Remix)', null, 'Brainwasher Remixes', 'This Never Happened', 'this never happened', 'Progressive House', null);
	db.prepare(`insert into source_link (id, track_id, source, source_track_id) values ('s1', 't1', 'local', 'c:/m/1.flac'), ('s2', 't2', 'spotify', 'spT2'), ('s3', 't3', 'spotify', 'spT3')`).run();
	db.prepare(`insert into track_artist (track_id, artist_id, role, position) values ('t1', 'a1', null, 0), ('t2', 'a1', null, 0), ('t3', 'a2', null, 0), ('t3', 'a1', 'remixer', 1)`).run();
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const summary = (id: string, kind: CatalogObjectSummary['kind'], name: string, handles: CatalogObjectSummary['handles'] = []): CatalogObjectSummary => ({ id, kind, name, handles, coverUrl: null, watchCount: 0 });

type Fake = EntityCatalog & { calls: string[]; reported: { key: string; claims: unknown[] }[] };

function fakeCatalog(over: {
	refs?: Record<string, CatalogObjectSummary>;
	browse?: Record<string, CatalogBrowseResult>;
	find?: CatalogObjectSummary[];
	pages?: boolean;
	available?: boolean;
	tracks?: CatalogTracksResult;
} = {}): Fake {
	const calls: string[] = [];
	const reported: { key: string; claims: unknown[] }[] = [];
	return {
		calls,
		reported,
		async reportEnrichment(claims, key) {
			reported.push({ key, claims });
			return { results: [], created: 0, attached: 1, duplicate: false };
		},
		status: () => (over.available === false ? { available: false, reason: 'signed_out' } : { available: true, reason: 'ok' }),
		offersPages: () => over.pages !== false,
		async resolve(refs: CatalogRef[]) {
			calls.push(`resolve:${refs.map((r) => `${r.provider}/${r.providerId}`).join(',')}`);
			return refs.map((r) => over.refs?.[`${r.provider}:${r.kind}:${r.providerId}`] ?? null);
		},
		async browse(id: string, opts?: { brief?: boolean }) {
			calls.push(`browse:${id}${opts?.brief ? ':brief' : ''}`);
			const b = over.browse?.[id];
			if (!b) throw new Error('catalog_not_found');
			return b;
		},
		async find() {
			calls.push('find');
			return over.find ?? [];
		},
		async tracks(id: string, cursor?: string) {
			calls.push(`tracks:${id}:${cursor ?? ''}`);
			return over.tracks!;
		},
	};
}

// The stores' public lookups, as a fetch: a URL → the JSON it answers.
function fakeFetch(answers: Record<string, unknown>) {
	const asked: string[] = [];
	const fetchFn = async (url: string): Promise<Response> => {
		asked.push(url);
		const hit = Object.entries(answers).find(([k]) => url.includes(k));
		return { ok: !!hit, json: async () => hit?.[1] } as Response;
	};
	return { asked, fetchFn };
}

function pagesOver(catalog: Fake | null, fetchFn: (url: string) => Promise<Response> = async () => ({ ok: false, json: async () => null }) as Response) {
	const counted: ZTrackFilterT[] = [];
	const pages = createEntityPages({
		raw: db,
		fetch: fetchFn,
		catalog: () => catalog,
		countTracks: (f) => {
			counted.push(f);
			return 7;
		},
		albumSummary: (id) => (id === 'al1' ? { id, title: 'Lailonie', artists: [{ id: 'a1', name: 'Marsh' }], various: false, releaseDate: '2026-03-01', label: 'Anjunadeep', genres: ['Melodic House'], albumType: 'single', totalTracks: 2, trackCount: 2, coverTrackId: 't1' } : null),
		artistByName: (name) => (name === 'Marsh' ? { id: 'a1', name: 'Marsh' } : null),
	});
	return { pages, counted };
}

const marshBrowse = (over: Partial<CatalogBrowseResult> = {}): CatalogBrowseResult => ({
	object: { ...summary('art-1', 'artist', 'Marsh', [{ provider: 'spotify', id: 'spA1', url: 'https://open.spotify.com/artist/spA1' }, { provider: 'beatport', id: '77', url: 'https://www.beatport.com/artist/marsh/77' }, { provider: 'user', id: 'local:a1', url: null }]), coverUrl: 'https://img.test/marsh.jpg' },
	redirectedFrom: null,
	releaseCount: 40,
	trackCount: 120,
	labels: [
		{ id: 'lab-new', name: 'Anjunadeep', releases: 12 },
		{ id: 'lab-old', name: 'Silk Music', releases: 30 },
	],
	genres: [{ id: 'g1', name: 'Melodic House & Techno', count: 50 }],
	similar: [{ id: 'art-7', name: 'Nox Vahn' }],
	watch: { muted: false },
	...over,
});

describe('entity header', () => {
	it("answers from the library at once: who it is and its local-file filter — what the artist is waits for the catalogue", async () => {
		const { pages, counted } = pagesOver(fakeCatalog());
		const h = await pages.page({ kind: 'artist', name: 'whatever', libraryId: 'a1' }, { localOnly: true });
		expect(h.ref).toEqual({ kind: 'artist', name: 'Marsh', libraryId: 'a1', catalogId: null, spotifyId: 'spA1' });
		expect(h.owned).toEqual({ count: 7, filter: { artistIds: ['a1'], hasSource: OWNED_SOURCES } });
		expect(counted).toEqual([{ artistIds: ['a1'], hasSource: OWNED_SOURCES }]);
		// Labels and genres are the catalogue's to say, never read off the
		// library's own tracks (the artist is on two labels there).
		expect(h).toMatchObject({ labels: [], genres: [], imageUrl: null });
		expect(h.links).toEqual([{ source: 'spotify', sourceId: 'spA1', url: 'https://open.spotify.com/artist/spA1' }]);
		expect(h.world).toMatchObject({ available: false, reason: 'pending' });
		// Signed out: nothing is pending, the library's side is the page.
		expect((await pagesOver(null).pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' }, { localOnly: true })).world.reason).toBe('signed_out');
	});

	it("lays the catalogue's facts over the library's, reached through the Spotify id the library holds, and remembers the object", async () => {
		const catalog = fakeCatalog({ refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') }, browse: { 'art-1': marshBrowse() } });
		const { pages } = pagesOver(catalog);
		const h = await pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		expect(h.ref).toMatchObject({ libraryId: 'a1', catalogId: 'art-1', spotifyId: 'spA1', name: 'Marsh' });
		expect(h.imageUrl).toBe('https://img.test/marsh.jpg');
		// Most releases first.
		expect(h.labels.map((c) => [c.ref.name, c.ref.catalogId, c.count])).toEqual([['Silk Music', 'lab-old', 30], ['Anjunadeep', 'lab-new', 12]]);
		expect(h.genres).toEqual([{ name: 'Melodic House & Techno', count: 50 }]);
		expect(h.similar.map((c) => c.ref)).toEqual([{ kind: 'artist', name: 'Nox Vahn', catalogId: 'art-7' }]);
		// Nothing about collaborations or activity from a server that sends none.
		expect(h).toMatchObject({ collabs: [], activity: null, badges: [] });
		// The library's link first, the catalogue's other stores added; a reader's key is no page.
		expect(h.links.map((l) => l.source)).toEqual(['beatport', 'spotify']);
		expect(h.follow).toEqual({ following: true, muted: false });
		expect(h.world).toEqual({ available: true, reason: 'ok', releaseCount: 40, trackCount: 120 });
		expect(db.prepare(`select object_id from catalog_ref where entity_kind = 'artist' and entity_id = 'a1'`).get()).toEqual({ object_id: 'art-1' });

		// Asked again: the cached answer, and the remembered object needs no resolve.
		await pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		// The header asks for the object without its release lists.
		expect(catalog.calls).toEqual(['resolve:spotify/spA1,user/local:a1', 'browse:art-1:brief']);
	});

	it("names the labels an artist's releases only state in text beside the catalogue's label objects, and never a distributor", async () => {
		const browse = marshBrowse({ labelTexts: [{ name: 'This Never Happened', releases: 20 }, { name: 'DistroKid', releases: 15 }, { name: 'Colorize', releases: 2 }] });
		const { pages } = pagesOver(fakeCatalog({ refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') }, browse: { 'art-1': browse } }));
		const h = await pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		// One list, most releases first; a label known by name alone carries no catalogue id.
		expect(h.labels.map((c) => [c.ref.name, c.ref.catalogId, c.count])).toEqual([
			['Silk Music', 'lab-old', 30],
			['This Never Happened', undefined, 20],
			['Anjunadeep', 'lab-new', 12],
			['Colorize', undefined, 2],
		]);
	});

	it("carries who the artist makes tracks with, its activity, and the badges they earn", async () => {
		const activity = { firstRelease: '2006-04-01', lastRelease: '2026-10-01', recentDays: 730, recentReleases: 3, recentTracks: 40 };
		const browse = marshBrowse({ releaseCount: 80, collabs: [{ id: 'art-7', name: 'Nox Vahn', tracks: 6 }, { id: 'art-9', name: 'Lane 8', tracks: 2 }], activity });
		const { pages } = pagesOver(fakeCatalog({ refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') }, browse: { 'art-1': browse } }));
		const h = await pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		expect(h.collabs).toEqual([
			{ ref: { kind: 'artist', name: 'Nox Vahn', catalogId: 'art-7' }, count: 6 },
			{ ref: { kind: 'artist', name: 'Lane 8', catalogId: 'art-9' }, count: 2 },
		]);
		expect(h.activity).toEqual(activity);
		expect(h.badges).toEqual(['veteran', 'workhorse', 'prolific']);
	});

	it("looks an artist's picture up at its store when the catalogue has none, shows it, and tells the catalogue — once", async () => {
		const bare = marshBrowse({ object: { ...marshBrowse().object, coverUrl: null } });
		const catalog = fakeCatalog({ refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') }, browse: { 'art-1': bare } });
		const store = fakeFetch({ 'open.spotify.com/oembed': { thumbnail_url: 'https://i.scdn.co/image/marsh' } });
		const { pages } = pagesOver(catalog, store.fetchFn);
		const h = await pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		expect(h.imageUrl).toBe('https://i.scdn.co/image/marsh');
		expect(store.asked).toEqual([`https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/artist/spA1')}`]);
		await Promise.resolve();
		expect(catalog.reported).toEqual([
			{ key: 'artist-picture:spotify:spA1', claims: [{ provider: 'spotify', kind: 'artist', providerId: 'spA1', name: 'Marsh', facts: { coverUrl: 'https://i.scdn.co/image/marsh' } }] },
		]);
		// Asked again (the header cache dropped): the store is not.
		pages.forget();
		expect((await pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' })).imageUrl).toBe('https://i.scdn.co/image/marsh');
		expect(store.asked).toHaveLength(1);
		expect(catalog.reported).toHaveLength(1);

		// A Deezer artist page is never asked for a face (it is every
		// namesake's page); and a picture found by an id only the library
		// holds is shown but not stated to the catalogue.
		const deezerOnly = marshBrowse({ object: summary('art-2', 'artist', 'Marsh', [{ provider: 'deezer', id: '55', url: 'https://www.deezer.com/artist/55' }]) });
		const deezer = fakeFetch({ 'api.deezer.com/artist/55': { picture_xl: 'https://cdn-images.dzcdn.net/images/artist/abc/1000x1000-000000-80-0-0.jpg' } });
		expect((await pagesOver(fakeCatalog({ browse: { 'art-2': deezerOnly } }), deezer.fetchFn).pages.page({ kind: 'artist', name: 'Marsh', catalogId: 'art-2' })).imageUrl).toBeNull();
		expect(deezer.asked).toEqual([]);
		const unknown = fakeCatalog();
		const byLibraryId = await pagesOver(unknown, store.fetchFn).pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		expect(byLibraryId).toMatchObject({ imageUrl: 'https://i.scdn.co/image/marsh', world: { reason: 'unknown' } });
		expect(unknown.reported).toEqual([]);
	});

	it("never joins a catalogue artist to the library's namesake: the library artist is offered as a hint", async () => {
		// A catalogue "Marsh" with no id the library holds.
		const other = marshBrowse({ object: summary('art-9', 'artist', 'Marsh', [{ provider: 'deezer', id: '5', url: 'https://www.deezer.com/artist/5' }]) });
		const { pages } = pagesOver(fakeCatalog({ browse: { 'art-9': other } }));
		const h = await pages.page({ kind: 'artist', name: 'Marsh', catalogId: 'art-9' });
		expect(h.ref).toMatchObject({ libraryId: null, catalogId: 'art-9' });
		expect(h.owned).toEqual({ count: 0, filter: null, nameHint: { kind: 'artist', name: 'Marsh', libraryId: 'a1' } });
		expect(db.prepare(`select count(*) as n from catalog_ref`).get()).toEqual({ n: 0 });
	});

	it("finds the library's artist for a catalogue artist through the Spotify id among its handles", async () => {
		const { pages } = pagesOver(fakeCatalog({ browse: { 'art-1': marshBrowse() } }));
		const h = await pages.page({ kind: 'artist', name: 'Marsh', catalogId: 'art-1' });
		expect(h.ref).toMatchObject({ libraryId: 'a1', catalogId: 'art-1' });
		expect(h.owned.filter).toEqual({ artistIds: ['a1'], hasSource: OWNED_SOURCES });
		expect(h.owned.nameHint).toBeUndefined();
	});

	it("reads a label by its folded name on both sides, and offers the namesakes when the catalogue holds several", async () => {
		const label: CatalogBrowseResult = {
			object: summary('lab-1', 'label', 'Anjunadeep Records', [{ provider: 'beatport', id: '1390', url: 'https://www.beatport.com/label/anjunadeep/1390' }]),
			redirectedFrom: null,
			releaseCount: 900,
			artists: [{ id: 'art-1', name: 'Marsh', releases: 12 }],
			watch: null,
		};
		const { pages, counted } = pagesOver(fakeCatalog({ refs: { 'user:label:name:anjunadeep': summary('lab-1', 'label', 'Anjunadeep Records') }, browse: { 'lab-1': label } }));
		const h = await pages.page({ kind: 'label', name: 'Anjunadeep' });
		expect(h.ref).toMatchObject({ kind: 'label', name: 'Anjunadeep', catalogId: 'lab-1' });
		// The library's spelling and the catalogue's, as index keys.
		expect(h.owned.filter).toEqual({ labelFolds: ['anjunadeep', 'anjunadeep records'], hasSource: OWNED_SOURCES });
		expect(counted.at(-1)).toEqual(h.owned.filter);
		expect(h.artists).toEqual([{ ref: { kind: 'artist', name: 'Marsh', catalogId: 'art-1' }, count: 12 }]);
		expect(h.follow).toEqual({ following: false, muted: false });
		expect(db.prepare(`select object_id from catalog_ref where entity_kind = 'label' and entity_id = 'anjunadeep'`).get()).toEqual({ object_id: 'lab-1' });

		const twins = pagesOver(fakeCatalog({ find: [summary('lab-a', 'label', 'Lost'), summary('lab-b', 'label', 'LOST'), summary('lab-c', 'label', 'Lost & Found')] }));
		const ambiguous = await twins.pages.page({ kind: 'label', name: 'Lost' });
		expect(ambiguous.world).toMatchObject({ available: false, reason: 'ambiguous' });
		expect(ambiguous.world.candidates?.map((c) => c.ref.catalogId)).toEqual(['lab-a', 'lab-b']);
		// The library's side is whole regardless.
		expect(ambiguous.owned.filter).toEqual({ labelFolds: ['lost'], hasSource: OWNED_SOURCES });
	});

	it('resolves a credit named on a feed card among that card\'s own credits, and an album by its Spotify id', async () => {
		const card: CatalogBrowseResult = { object: summary('rel-1', 'release', 'Brainwasher Remixes'), redirectedFrom: null, artists: [{ id: 'art-7', name: 'Nox Vahn' }, { id: 'art-1', name: 'Marsh' }], labels: [{ id: 'lab-2', name: 'This Never Happened', releases: 1 }] };
		const album: CatalogBrowseResult = {
			object: { ...summary('rel-9', 'release', 'Lailonie', [{ provider: 'spotify', id: 'spAL1', url: 'https://open.spotify.com/album/spAL1' }]), coverUrl: 'https://img.test/cat.jpg' },
			redirectedFrom: null,
			release: { date: '2026-03-01', type: 'single', labelText: 'Anjunadeep' },
			artists: [{ id: 'art-1', name: 'Marsh', role: 'main' }],
			labels: [{ id: 'lab-1', name: 'Anjunadeep', releases: 1 }],
			trackCount: 2,
			watch: null,
		};
		const catalog = fakeCatalog({ refs: { 'spotify:release:spAL1': summary('rel-9', 'release', 'Lailonie') }, browse: { 'rel-1': card, 'art-1': marshBrowse(), 'rel-9': album } });
		const { pages } = pagesOver(catalog);
		const credit = await pages.page({ kind: 'artist', name: 'marsh', within: { catalogId: 'rel-1' } });
		expect(credit.ref).toMatchObject({ catalogId: 'art-1', libraryId: 'a1' });
		// The card's object whole (its credits are what is searched), the artist's header brief.
		expect(catalog.calls.slice(0, 2)).toEqual(['browse:rel-1', 'browse:art-1:brief']);

		const h = await pages.page({ kind: 'album', name: 'Lailonie', libraryId: 'al1' });
		expect(h.ref).toMatchObject({ kind: 'album', libraryId: 'al1', catalogId: 'rel-9', spotifyId: 'spAL1' });
		expect(h.owned.filter).toEqual({ albumIds: ['al1'], hasSource: OWNED_SOURCES });
		expect(h).toMatchObject({ imageUrl: 'https://img.test/cat.jpg', coverTrackId: 't1', facts: { releaseDate: '2026-03-01', albumType: 'single' }, follow: null });
		expect(h.artists).toEqual([{ ref: { kind: 'artist', name: 'Marsh', catalogId: 'art-1' } }]);
		expect(h.labels).toEqual([{ ref: { kind: 'label', name: 'Anjunadeep', catalogId: 'lab-1' } }]);
		expect(h.world).toMatchObject({ available: true, releaseCount: 1, trackCount: 2 });
	});

	it('never keeps an answer from while the catalogue could not be asked: the next ask has it the moment it is back', async () => {
		const state = { available: false };
		const catalog = { ...fakeCatalog({ refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') }, browse: { 'art-1': marshBrowse() } }), status: () => (state.available ? { available: true as const, reason: 'ok' as const } : { available: false as const, reason: 'server_off' as const }) };
		const { pages } = pagesOver(catalog);
		const ref = { kind: 'artist' as const, name: 'Marsh', libraryId: 'a1' };
		expect((await pages.page(ref)).world).toMatchObject({ available: false, reason: 'server_off' });
		await expect(pages.tracks(ref)).rejects.toThrow('The catalogue is not reachable right now.');
		// Back a moment later — no forget(), no ten-minute wait.
		state.available = true;
		expect((await pages.page(ref)).world).toMatchObject({ available: true, reason: 'ok' });
		// And a failed lookup (the server answered nothing) is not kept either.
		const flaky = fakeCatalog({ refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') } });
		const second = pagesOver(flaky);
		db.prepare(`delete from catalog_ref`).run();
		expect((await second.pages.page(ref)).world.reason).toBe('server_off');
		flaky.browse = async () => marshBrowse();
		expect((await second.pages.page(ref)).world.reason).toBe('ok');
	});

	it('shows the library side alone when signed out, and no World on a server from before catalogue pages', async () => {
		const out = await pagesOver(fakeCatalog({ available: false })).pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		expect(out.world).toMatchObject({ available: false, reason: 'signed_out' });
		expect(out.follow).toBeNull();

		// An older server still names the object (its links), with no watch answered.
		const old = pagesOver(fakeCatalog({ pages: false, refs: { 'spotify:artist:spA1': summary('art-1', 'artist', 'Marsh') }, browse: { 'art-1': marshBrowse({ watch: undefined }) } }));
		const h = await old.pages.page({ kind: 'artist', name: 'Marsh', libraryId: 'a1' });
		expect(h.world).toMatchObject({ available: false, reason: 'old_server' });
		expect(h.follow).toBeNull();
		expect(h.links.map((l) => l.source)).toEqual(['beatport', 'spotify']);
		await expect(old.pages.tracks(h.ref)).rejects.toThrow(/needs an update before it can list the catalogue/);
	});
});

describe('World tracks', () => {
	const result: CatalogTracksResult = {
		object: { id: 'art-1', kind: 'artist', name: 'Marsh' },
		redirectedFrom: null,
		nextCursor: 'next',
		releaseCount: 2,
		releases: [
			{
				id: 'rel-2', title: 'Lailonie (Deluxe)', date: '2026-06-01', type: 'album', coverUrl: 'https://img.test/d.jpg', labelText: 'Anjunadeep', labels: [], artists: [{ id: 'art-1', name: 'Marsh' }], genres: ['Melodic House & Techno'], handles: [], trackCount: 1, appearance: false,
				tracks: [{ id: 'rec-1', title: 'Lailonie', position: 1, disc: null, durationSec: 400, isrc: 'gbaaa2600001', bpm: 122, key: 'A Minor', genres: [], artists: [], handles: [{ provider: 'tidal', id: 'td1', url: 'https://tidal.com/track/td1' }] }],
			},
			{
				id: 'rel-1', title: 'Lailonie', date: '2026-03-01', type: 'single', coverUrl: null, labelText: null, labels: [{ id: 'lab-1', name: 'Anjunadeep' }], artists: [{ id: 'art-1', name: 'Marsh' }], genres: [], handles: [{ provider: 'spotify', id: 'spAL1', url: 'https://open.spotify.com/album/spAL1' }], trackCount: 3, appearance: false,
				tracks: [
					{ id: 'rec-1', title: 'Lailonie', position: 1, disc: null, durationSec: 400, isrc: 'GBAAA2600001', bpm: null, key: null, genres: ['Deep House'], artists: [{ id: 'art-1', name: 'Marsh', role: 'main' }], handles: [] },
					{ id: 'rec-2', title: 'Eu Topos', position: 2, disc: null, durationSec: 380, isrc: null, bpm: null, key: null, genres: [], artists: [{ id: 'art-1', name: 'Marsh' }], handles: [{ provider: 'spotify', id: 'spT2', url: 'https://open.spotify.com/track/spT2' }, { provider: 'deezer', id: 'label/eu-topos', url: null }] },
					{ id: 'rec-3', title: 'Unreleased Here', position: 3, disc: null, durationSec: null, isrc: null, bpm: null, key: null, genres: [], artists: [{ id: 'art-1', name: 'Marsh' }], handles: [] },
				],
			},
		],
	};

	it("maps a catalogue page onto rows: streaming ids, the library track each recording is, and which row stands for it", async () => {
		const catalog = fakeCatalog({ tracks: result });
		const { pages } = pagesOver(catalog);
		const page = await pages.tracks({ kind: 'artist', name: 'Marsh', catalogId: 'art-1' });
		expect(page.nextCursor).toBe('next');
		expect(page.albums.map((a) => [a.id, a.label, a.links.length])).toEqual([['rel-2', { id: null, name: 'Anjunadeep' }, 0], ['rel-1', { id: 'lab-1', name: 'Anjunadeep' }, 1]]);
		expect(page.tracks.map((t) => [t.releaseId, t.recordingId, t.libraryTrackId, t.libraryPrimary])).toEqual([
			// By ISRC, on a later edition: the library's own album stands for the track.
			['rel-2', 'rec-1', 't1', false],
			['rel-1', 'rec-1', 't1', true],
			// By the Spotify id both sides hold (a streaming-only library track).
			['rel-1', 'rec-2', 't2', true],
			['rel-1', 'rec-3', null, false],
		]);
		expect(page.tracks[0]).toMatchObject({ keyCamelot: '8A', bpm: 122, genre: 'Melodic House & Techno', streamIds: { tidal: 'td1' }, artists: [{ id: 'art-1', name: 'Marsh' }] });
		expect(page.tracks[2]).toMatchObject({ streamIds: { spotify: 'spT2' }, links: [{ source: 'spotify', sourceId: 'spT2' }] });

		// The cloud page is kept; the library is read again each time.
		db.prepare(`update track set deleted_at = 5 where id = 't2'`).run();
		const again = await pages.tracks({ kind: 'artist', name: 'Marsh', catalogId: 'art-1' });
		expect(again.tracks[2]!.libraryTrackId).toBeNull();
		expect(catalog.calls).toEqual(['tracks:art-1:']);
	});

	it('matches by a remembered catalogue recording first, and never a deleted track', () => {
		db.prepare(`insert into catalog_ref (entity_kind, entity_id, object_id, object_kind, resolved_at) values ('track', 't3', 'rec-9', 'recording', 1)`).run();
		const probe = (recordingId: string, over: Partial<Parameters<typeof matchLibraryTracks>[1][number]> = {}) => ({ recordingId, releaseId: 'r', releaseTitle: 'x', releaseDate: null, isrc: null, spotifyId: null, tidalId: null, ...over });
		expect(matchLibraryTracks(db, [probe('rec-9', { spotifyId: 'spT2' }), probe('rec-8', { spotifyId: 'spT3' }), probe('rec-7')])).toEqual([
			{ libraryTrackId: 't3', primary: true },
			{ libraryTrackId: 't3', primary: false },
			null,
		]);
		db.prepare(`update track set deleted_at = 5 where id = 't3'`).run();
		expect(matchLibraryTracks(db, [probe('rec-9'), probe('rec-8', { spotifyId: 'spT3' })])).toEqual([null, null]);
	});
});
