// The page validation: is a store's artist page one artist? Judged by what
// Deezer lists on it (a genre per album) against what Beatport says the
// artist is. The numbers of the first case are Deezer 465319 "Fade" as read
// on 2026-11-18; the names in the database cases are made up.

import type { CatalogClaim } from '@curator/protocol';
import type { DeezerListedAlbum, FetchLike } from '@curator/catalog-readers';
import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestDb } from '../test/harness.js';
import { beatportAnchor, familyOf, judgePage, profileOf, queueValidation, runPageValidation, validateArtist, type BeatportAnchor, type PageReader } from './artist-validation.js';
import { listInbox } from './inbox.js';
import { ingestClaims } from './ingest.js';
import { DeezerFinder } from './planner.js';

const quiet = createLogger(() => {});

// A listing of n albums per genre.
const listing = (genres: Record<string, number>, total: number | null = null): { total: number | null; albums: DeezerListedAlbum[] } => ({
	total,
	albums: Object.entries(genres).flatMap(([genre, n]) => Array.from({ length: n }, (_, i) => ({ id: `${genre}-${i}`, title: `${genre} ${i}`, date: null, genre: genre === '?' ? null : genre }))),
});
const FADE = { Electro: 38, 'Rap/Hip Hop': 25, Alternative: 9, Pop: 8, 'Asian Music': 6, Rock: 4, Dance: 4, '?': 3, 'African Music': 2, Classical: 1 };
const electronicArtist: BeatportAnchor = { releases: 1, families: { electronic: 1 }, titles: ['metaflora iv vol 2'] };
const unknownToBeatport: BeatportAnchor = { releases: 0, families: {}, titles: [] };

describe('genre families', () => {
	it("reads Deezer's genres as families, and its catch-all ones as saying nothing", () => {
		expect(familyOf('deezer', 'Electro')).toBe('electronic');
		expect(familyOf('deezer', 'Dance')).toBe('electronic');
		expect(familyOf('deezer', 'Rap/Hip Hop')).toBe('hiphop');
		expect(familyOf('deezer', 'Metal')).toBe('rock');
		for (const soft of ['Pop', 'Alternative', 'R&B', 'Soul & Funk', 'Films/Games', 'Something New']) expect(familyOf('deezer', soft)).toBeNull();
		// Where an act is from, not what it plays.
		for (const regional of ['Asian Music', 'African Music', 'Latin Music', 'Brazilian Music', 'Indian Music']) expect(familyOf('deezer', regional)).toBeNull();
	});

	it("reads Beatport's genres as electronic, but for its open-format ones", () => {
		for (const g of ['Melodic House & Techno', 'Afro House', 'Trap / Future Bass', 'Drum & Bass']) expect(familyOf('beatport', g)).toBe('electronic');
		expect(familyOf('beatport', 'Hip-Hop')).toBe('hiphop');
		expect(familyOf('beatport', 'African')).toBeNull();
		expect(familyOf('beatport', 'Pop')).toBeNull();
	});
});

describe('judging a page', () => {
	it("finds Deezer's Fade to be several acts, whether or not Beatport knows the artist", () => {
		const page = profileOf('465319', listing(FADE, 238));
		expect(page).toMatchObject({ listed: 100, total: 238, families: { electronic: 42, hiphop: 25, rock: 4, classical: 1 } });
		for (const anchor of [electronicArtist, unknownToBeatport, null]) {
			const check = judgePage(page, anchor);
			expect(check).toMatchObject({ verdict: 'mixed', foreign: 30 });
			expect(check.reason).toMatch(/3 kinds of music on one page: electronic 42, hiphop 25, rock 4/);
		}
	});

	it('finds two full bodies of work to be two acts', () => {
		const check = judgePage(profileOf('8', listing({ Electro: 20, 'Rap/Hip Hop': 15, Pop: 5 })), unknownToBeatport);
		expect(check.verdict).toBe('mixed');
		expect(check.reason).toMatch(/two bodies of work/);
	});

	// Real pages, 2026-11-18.
	it('leaves one act alone: a producer who works with rappers, a stray tag, genres that say nothing', () => {
		const pages: Record<string, Record<string, number>> = {
			Kaytranada: { Electro: 27, 'Rap/Hip Hop': 6, Dance: 6, 'R&B': 3 },
			TroyBoi: { Dance: 18, Electro: 15, 'Rap/Hip Hop': 3, Pop: 1, 'Brazilian Music': 1 },
			'Fred again..': { Electro: 83, 'Rap/Hip Hop': 8, Dance: 3, Alternative: 1 },
			'David Guetta': { Dance: 82, Electro: 8, Pop: 7, Reggae: 1, 'African Music': 1, 'Indian Music': 1 },
			'Major Lazer': { Electro: 49, Dance: 38, Pop: 3, 'Latin Music': 3, 'Brazilian Music': 2, 'Rap/Hip Hop': 1, Alternative: 1 },
			'Tale Of Us': { Electro: 8, Dance: 2, Classical: 1 },
			Moby: { Electro: 62, Pop: 26, Dance: 5, Alternative: 3 },
			Gorillaz: { Alternative: 56, 'Rap/Hip Hop': 17, Dance: 12, Pop: 7 },
			'Massive Attack': { Electro: 30, 'Rap/Hip Hop': 5, Pop: 4, 'Films/Games': 4, Dance: 3, Alternative: 1 },
			'Nils Frahm': { Electro: 41, Classical: 6, Alternative: 4 },
		};
		for (const [name, genres] of Object.entries(pages)) {
			for (const anchor of [electronicArtist, unknownToBeatport]) expect([name, judgePage(profileOf(name, listing(genres)), anchor).verdict]).toEqual([name, 'coherent']);
		}
		// An afro house producer's page, filed by where they are from.
		expect(judgePage(profileOf('9', listing({ 'African Music': 30, Dance: 2 })), electronicArtist).verdict).toBe('coherent');
		// Pop and Alternative sit on every kind of artist's albums.
		expect(judgePage(profileOf('4', listing({ Pop: 20, Alternative: 10 })), electronicArtist).verdict).toBe('coherent');
	});

	it("calls a page of another music a namesake's when Beatport knows the artist, and says nothing of a short one", () => {
		// A rapper's page: one kind of music, and coherent for all Deezer says…
		const rap = profileOf('5', listing({ 'Rap/Hip Hop': 40, Pop: 3 }));
		expect(judgePage(rap, unknownToBeatport).verdict).toBe('coherent');
		// …but not the page of an artist Beatport knows as electronic.
		expect(judgePage(rap, electronicArtist)).toMatchObject({ verdict: 'foreign', foreign: 40 });
		// "Muramasa" (Asian Music 10, Metal 9, Rap 1) found for Mura Masa.
		expect(judgePage(profileOf('5335855', listing({ 'Asian Music': 10, Metal: 9, 'Rap/Hip Hop': 1 })), electronicArtist).verdict).toBe('foreign');
		expect(judgePage(profileOf('6', listing({ Electro: 3, 'Rap/Hip Hop': 3 })), electronicArtist).verdict).toBe('thin');
	});
});

// ── with a catalogue ──────────────────────────────────────────────────────────────────────

const artist = (provider: CatalogClaim['provider'], id: string): CatalogClaim => ({ provider, kind: 'artist', providerId: id, name: 'Northfold' });
const release = (provider: CatalogClaim['provider'], id: string, title: string, by: CatalogClaim, extra: Partial<CatalogClaim> = {}): CatalogClaim => ({
	provider,
	kind: 'release',
	providerId: id,
	name: title,
	identifiers: [{ namespace: 'upc', value: '0123456789012' }],
	facts: { releaseDate: '2026-10-08' },
	artists: [by],
	...extra,
});

// Northfold: a Spotify page, a release Beatport holds too, and a Deezer page.
async function seed() {
	const { db } = await createTestDb();
	await withSystemTx(db, (tx) =>
		ingestClaims(
			tx,
			[
				release('spotify', 'sr1', 'Glass Rivers', artist('spotify', 'sa1')),
				release('beatport', 'br1', 'Glass Rivers', artist('beatport', '900'), { genres: ['Melodic House & Techno'] }),
				release('deezer', 'dr1', 'Glass Rivers', artist('deezer', '465319')),
			],
			{ reason: 'library_import' },
		),
	);
	const [a] = await db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'spotify' and kind = 'artist' and provider_id = 'sa1'`);
	return { db, artistId: a!.object_id };
}

const reader = (genres: Record<string, number>, calls: string[] = []): PageReader => ({
	artistAlbums: async (id) => {
		calls.push(id);
		return listing(genres, 238);
	},
});

describe('validating an artist', () => {
	it('knows the artist from Beatport by the releases it credits them on', async () => {
		const { db, artistId } = await seed();
		const anchor = await withSystemTx(db, (tx) => beatportAnchor(tx, artistId));
		expect(anchor).toMatchObject({ releases: 1, families: { electronic: 1 } });
	});

	it('keeps the verdict per page and puts a page of several acts to the operator as a block, once', async () => {
		const { db, artistId } = await seed();
		const [page] = await validateArtist(db, reader(FADE), artistId, { propose: true });
		expect(page).toMatchObject({ provider: 'deezer', providerId: '465319', check: { verdict: 'mixed' } });
		expect(page!.inbox).not.toBeNull();
		const [row] = await db.query<{ verdict: string; object_id: string; evidence: string }>(`select verdict, object_id, evidence::text as evidence from curator.catalog_page_check where provider = 'deezer' and provider_id = '465319'`);
		expect(row).toMatchObject({ verdict: 'mixed', object_id: artistId });
		expect(JSON.parse(row!.evidence)).toMatchObject({ listed: 100, total: 238, genres: { Electro: 38, 'Rap/Hip Hop': 25 }, families: [['electronic', 42], ['hiphop', 25], ['rock', 4], ['classical', 1]], beatport: { releases: 1 } });
		const open = await withSystemTx(db, (tx) => listInbox(tx, { status: 'open', kind: 'artist.page' }));
		expect(open.rows).toHaveLength(1);
		expect(open.rows[0]).toMatchObject({
			severity: 'approval',
			subjects: [artistId],
			apply: { op: 'blockSource', args: { objectId: artistId, provider: 'deezer', kind: 'artist', providerId: '465319' } },
		});
		// Nothing is unlinked without the operator: the page is still the artist's.
		expect(await db.query(`select 1 from curator.catalog_source_object where provider = 'deezer' and kind = 'artist' and object_id = $1`, [artistId])).toHaveLength(1);
		// Read again: the same question is not raised twice.
		const [again] = await validateArtist(db, reader(FADE), artistId, { propose: true });
		expect(again!.inbox).toBeNull();
		expect((await withSystemTx(db, (tx) => listInbox(tx, { status: 'open', kind: 'artist.page' }))).rows).toHaveLength(1);
	});

	it('raises nothing for a page that is one artist', async () => {
		const { db, artistId } = await seed();
		const [page] = await validateArtist(db, reader({ Electro: 30, Dance: 10 }), artistId, { propose: true });
		expect(page).toMatchObject({ check: { verdict: 'coherent' }, inbox: null });
		expect((await withSystemTx(db, (tx) => listInbox(tx, { status: 'open', kind: 'artist.page' }))).rows).toEqual([]);
	});

	it('the pass checks what was queued — an opened page — once, and again only a month on', async () => {
		const { db, artistId } = await seed();
		const calls: string[] = [];
		// Nothing queued, nobody follows the artist: nothing is read.
		expect(await runPageValidation({ db, log: quiet, reader: reader(FADE, calls) })).toEqual({ checked: 0, mixed: 0, foreign: 0 });
		await withSystemTx(db, (tx) => queueValidation(tx, artistId));
		expect(await runPageValidation({ db, log: quiet, reader: reader(FADE, calls) })).toEqual({ checked: 1, mixed: 1, foreign: 0 });
		expect(calls).toEqual(['465319']);
		// The next pass has nothing due, and a checked page is not queued again.
		await withSystemTx(db, (tx) => queueValidation(tx, artistId));
		expect((await runPageValidation({ db, log: quiet, reader: reader(FADE, calls) })).checked).toBe(0);
		expect(calls).toHaveLength(1);
	});
});

describe('the Deezer artist finder', () => {
	const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
	const store = (albums: { id: number; title: string; genre_id: number }[]): FetchLike => async (input) =>
		new URL(input).pathname === '/search/artist' ? json({ data: [{ id: 465319, name: 'Northfold' }] }) : json({ data: albums });
	const albums = (genreIds: number[], per: number) => genreIds.flatMap((g, k) => Array.from({ length: per }, (_, i) => ({ id: k * 100 + i, title: k === 0 && i === 0 ? 'Glass Rivers' : `Album ${k}-${i}`, genre_id: g })));

	it('does not take a page of several acts, though it lists a release of ours', async () => {
		// Electro and Rap/Hip Hop, ten albums each — ours among them.
		const r = await new DeezerFinder(store(albums([106, 116], 10))).find({ name: 'Northfold' }, new Set(['glass rivers']), AbortSignal.timeout(5000));
		expect(r.claim).toBeNull();
		expect(r.reason).toBe('mixed_page:465319');
		expect(r.candidates ?? []).toEqual([]);
	});

	it('takes a page of one kind of music as before', async () => {
		const r = await new DeezerFinder(store(albums([106, 113], 10))).find({ name: 'Northfold' }, new Set(['glass rivers']), AbortSignal.timeout(5000));
		expect(r.claim).toMatchObject({ provider: 'deezer', kind: 'artist', providerId: '465319' });
	});
});
