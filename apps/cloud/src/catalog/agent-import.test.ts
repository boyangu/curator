// Releases an agent gathered by browsing a label's website (made-up label):
// joined to what the catalogue has by store id or by title/artists/date,
// store ids attached, the label tied, conflicts sent to review — and a dry
// run that writes nothing.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { storeRef, type AgentImport } from './agent-import.js';
import { ingestClaims } from './ingest.js';

describe('store links', () => {
	it('reads the ids the trackers key on', () => {
		expect(storeRef('https://open.spotify.com/album/0mQdrb1eXKEWhbJP1vw7cj')).toEqual({ provider: 'spotify', kind: 'release', id: '0mQdrb1eXKEWhbJP1vw7cj' });
		expect(storeRef('https://open.spotify.com/intl-de/track/4CtZ2UYTV8vnFPGCDs5N9Z?si=x')).toEqual({ provider: 'spotify', kind: 'recording', id: '4CtZ2UYTV8vnFPGCDs5N9Z' });
		expect(storeRef('https://www.beatport.com/release/velvet-abyss/7122578')).toEqual({ provider: 'beatport', kind: 'release', id: '7122578' });
		expect(storeRef('https://www.traxsource.com/title/2541234/velvet-abyss')).toEqual({ provider: 'traxsource', kind: 'release', id: '2541234' });
		expect(storeRef('https://geo.music.apple.com/it/album/6783917939?app=music&ct=SYYK299')).toEqual({ provider: 'apple', kind: 'release', id: '6783917939' });
		expect(storeRef('https://www.deezer.com/en/album/1234567')).toEqual({ provider: 'deezer', kind: 'release', id: '1234567' });
		expect(storeRef('https://northfold.bandcamp.com/album/velvet-abyss')).toBeNull();
	});
});

async function seed(app: TestApp): Promise<string> {
	const r = await withSystemTx(app.db, (tx) =>
		ingestClaims(
			tx,
			[
				{ provider: 'user', kind: 'label', providerId: 'name:northfold records', name: 'Northfold Records' },
				// Known from Spotify: Glass Rivers (and Drift, under another title).
				{ provider: 'spotify', kind: 'release', providerId: '0mQdrb1eXKEWhbJP1vw7cj', name: 'Glass Rivers', facts: { releaseDate: '2026-07-10' }, artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Ilka Rane' }] },
				{ provider: 'spotify', kind: 'release', providerId: '1111111111111111111111', name: 'Drift (Edit)', facts: { releaseDate: '2025-03-01' }, artists: [{ provider: 'spotify', kind: 'artist', providerId: 'sa2', name: 'Kaske' }] },
			],
			{ reason: 'library_import' },
		),
	);
	return r.outcomes[0]!.objectId;
}

const site: AgentImport = {
	source: 'https://northfold.example/releases/',
	releases: [
		{
			title: 'Glass Rivers',
			artists: ['Ilka Rane'],
			date: '2026-07-10',
			catalogNumber: 'NFR299',
			url: 'https://northfold.example/releases/ilka-rane-glass-rivers/',
			links: { spotify: 'https://open.spotify.com/album/0mQdrb1eXKEWhbJP1vw7cj', beatport: 'https://www.beatport.com/release/glass-rivers/7122578', apple: 'https://music.apple.com/it/album/6783917939' },
		},
		{
			title: 'Lanterns',
			artists: ['Kaske', 'Lumen Vale'],
			date: '2026-08-01',
			catalogNumber: 'NFR300',
			url: 'https://northfold.example/releases/kaske-lumen-vale-lanterns/',
			links: { beatport: 'https://www.beatport.com/release/lanterns/7122999', bandcamp: 'https://northfold.bandcamp.com/album/lanterns' },
			tracks: [{ title: 'Lanterns', isrc: 'GBNFR2600300', links: { spotify: 'https://open.spotify.com/track/2222222222222222222222' } }],
		},
		{
			// The site's Spotify link names an album the catalogue holds under another title.
			title: 'Drift',
			artists: ['Kaske'],
			date: '2026-01-01',
			url: 'https://northfold.example/releases/kaske-drift/',
			links: { beatport: 'https://www.beatport.com/release/drift/7000001', spotify: 'https://open.spotify.com/album/1111111111111111111111' },
		},
	],
};

describe('label import', () => {
	it('a dry run reports and writes nothing', async () => {
		const app = await createTestApp();
		await seed(app);
		const r = await adminOps(app.db, {}).labelImport({ q: 'Northfold Records', data: site, dry: true });
		expect(r).toMatchObject({ dry: true, releases: 3, matched: 2, created: 1 });
		expect(await app.db.query(`select 1 from curator.catalog_source_object where kind = 'release' and provider in ('website', 'beatport', 'apple')`)).toEqual([]);
		expect(await app.db.query(`select 1 from curator.catalog_edge where kind = 'release-label'`)).toEqual([]);
		expect(await app.db.query(`select 1 from curator.catalog_object where scanned_at is not null`)).toEqual([]);
	});

	it('joins by store id, creates what is new, attaches store ids and catalogue numbers, ties the label, raises nothing', async () => {
		const app = await createTestApp();
		const labelId = await seed(app);
		const ops = adminOps(app.db, {});
		const r = await ops.labelImport({ q: 'Northfold Records', data: site });
		expect(r).toMatchObject({ releases: 3, matched: 2, created: 1, conflicts: [] });
		expect(r.unread.map((u) => u.link)).toEqual(['https://northfold.bandcamp.com/album/lanterns']);
		const reps = async (title: string) =>
			(
				await app.db.query<{ p: string }>(
					`select so.provider || ':' || so.provider_id as p from curator.catalog_source_object so join curator.catalog_object o on o.id = so.object_id where o.kind = 'release' and o.name = $1 order by 1`,
					[title],
				)
			).map((x) => x.p);
		expect(await reps('Glass Rivers')).toEqual(['apple:6783917939', 'beatport:7122578', 'spotify:0mQdrb1eXKEWhbJP1vw7cj', 'website:northfold.example/releases/ilka-rane-glass-rivers']);
		expect(await reps('Lanterns')).toEqual(['beatport:7122999', 'website:northfold.example/releases/kaske-lumen-vale-lanterns']);
		// "Drift" joined the album its Spotify link named (held as "Drift (Edit)").
		expect(await reps('Drift (Edit)')).toEqual(['beatport:7000001', 'spotify:1111111111111111111111', 'website:northfold.example/releases/kaske-drift']);
		const v = await ops.labelShow({ q: 'Northfold Records' });
		expect(v.releases).toBe(3);
		const [cat] = await app.db.query<{ value: string }>(`select f.value::text as value from curator.catalog_fact f join curator.catalog_object o on o.id = f.object_id where o.name = 'Glass Rivers' and f.field = 'catalogNumber'`);
		expect(cat?.value).toBe('"NFR299"');
		// The track's Spotify id is on Lanterns' track.
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'spotify' and kind = 'recording' and provider_id = '2222222222222222222222'`)).toHaveLength(1);
		expect(await app.db.query(`select 1 from curator.catalog_event`)).toEqual([]);
		// The label was read: its "last scanned" is now.
		expect(await app.db.query(`select 1 from curator.catalog_object where id = $1 and scanned_at > now() - interval '1 minute'`, [labelId])).toHaveLength(1);
	});

	it("joins the label's release of that title and artist even when the site's date is weeks off", async () => {
		const app = await createTestApp();
		const labelId = await seed(app);
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [{ provider: 'bandcamp', kind: 'release', providerId: 'bc9', name: 'Lanterns', facts: { releaseDate: '2026-06-01', labelText: 'Northfold Records' }, artists: [{ provider: 'bandcamp', kind: 'artist', providerId: 'x/kaske', name: 'Kaske' }] }], { reason: 'library_import' }),
		);
		const r = await adminOps(app.db, {}).labelImport({ q: 'Northfold Records', data: { source: 'x', releases: [site.releases[1]!] } });
		expect(r).toMatchObject({ matched: 1, created: 0 });
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'release' and name = 'Lanterns'`)).toHaveLength(1);
		void labelId;
	});

	it('joins "Lanterns EP" to "Lanterns", and a release held twice to its better-held copy, never minting a third', async () => {
		const app = await createTestApp();
		await seed(app);
		const kaske = (p: 'bandcamp' | 'spotify') => [
			{ provider: p, kind: 'artist' as const, providerId: p === 'spotify' ? 'K'.repeat(22) : 'x/kaske', name: 'Kaske' },
			...(p === 'spotify' ? [{ provider: p, kind: 'artist' as const, providerId: 'I'.repeat(22), name: 'Ilka Rane' }] : []),
		];
		// The twin a Bandcamp copy and a Spotify copy left (credits apart, dates
		// four days apart, so the joins missed it); the import's date between them.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					{ provider: 'bandcamp', kind: 'release', providerId: 'bc9', name: 'Lanterns', facts: { releaseDate: '2026-06-01', labelText: 'Northfold Records' }, artists: kaske('bandcamp') },
					{ provider: 'spotify', kind: 'release', providerId: 'L'.repeat(22), name: 'Lanterns', facts: { releaseDate: '2026-06-05', labelText: 'Northfold Records' }, artists: kaske('spotify'), identifiers: [{ namespace: 'upc', value: '0123456789012' }] },
					// The same store release on Deezer, joined to the Spotify copy by its UPC.
					{ provider: 'deezer', kind: 'release', providerId: '900009', name: 'Lanterns', facts: { releaseDate: '2026-06-05', labelText: 'Northfold Records' }, artists: [{ provider: 'deezer', kind: 'artist', providerId: '77', name: 'Kaske' }], identifiers: [{ namespace: 'upc', value: '0123456789012' }] },
				],
				{ reason: 'library_import' },
			),
		);
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'release' and name = 'Lanterns'`)).toHaveLength(2);
		const r = await adminOps(app.db, {}).labelImport({ q: 'Northfold Records', data: { source: 'x', releases: [{ title: 'Lanterns EP', artists: ['Kaske'], date: '2026-06-03', url: 'https://www.beatport.com/release/lanterns-ep/7000009' }] } });
		expect(r).toMatchObject({ matched: 1, created: 0 });
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'release' and name_fold like 'lanterns%'`)).toHaveLength(2);
		const [held] = await app.db.query<{ name: string }>(`select o.name from curator.catalog_source_object so join curator.catalog_object o on o.id = so.object_id where so.provider = 'beatport' and so.provider_id = '7000009'`);
		// The store copy (Spotify and Deezer) against Bandcamp's one page.
		expect(held?.name).toBe('Lanterns');
		const [onSpotify] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_source_object a join curator.catalog_source_object b on b.object_id = a.object_id where a.provider = 'beatport' and a.provider_id = '7000009' and b.provider = 'spotify'`);
		expect(Number(onSpotify!.n)).toBe(1);
	});

	it('a store id already on another release opens a review instead of moving', async () => {
		const app = await createTestApp();
		await seed(app);
		const ops = adminOps(app.db, {});
		// Glass Rivers arrives from the site with Drift's Spotify album as a second link.
		const r = await ops.labelImport({
			q: 'Northfold Records',
			data: { source: 'x', releases: [{ ...site.releases[0]!, links: { spotify: 'https://open.spotify.com/album/0mQdrb1eXKEWhbJP1vw7cj', other: 'https://open.spotify.com/album/1111111111111111111111' } }] },
		});
		expect(r.conflicts).toHaveLength(1);
		const [rv] = await ops.list({ kind: 'duplicate' });
		expect(rv?.evidence.reason).toMatch(/spotify release 1111111111111111111111 is on the other one/);
	});
});
