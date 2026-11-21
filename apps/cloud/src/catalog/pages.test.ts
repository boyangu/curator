import type { CatalogClaim } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp, createTestDb } from '../test/harness.js';
import { browseForClient } from './browse.js';
import { ingestClaims } from './ingest.js';
import { pageTracks } from './pages.js';

const artist = (id: string, name: string): CatalogClaim => ({ provider: 'spotify', kind: 'artist', providerId: id, name });
const LABEL: CatalogClaim = { provider: 'user', kind: 'label', providerId: 'name:northfold', name: 'Northfold' };

type TrackSpec = { id: string; title: string; n?: number; disc?: number; artists?: CatalogClaim[]; bpm?: number; key?: string; genres?: string[] };

function release(id: string, title: string, artists: CatalogClaim[], opts: { date?: string | null; tracks?: TrackSpec[]; label?: boolean; genres?: string[]; cover?: string } = {}): CatalogClaim {
	return {
		provider: 'spotify',
		kind: 'release',
		providerId: id,
		name: title,
		facts: { ...(opts.date === null ? {} : { releaseDate: opts.date ?? '2026-01-01' }), releaseType: 'single', ...(opts.cover ? { coverUrl: opts.cover } : {}) },
		artists,
		...(opts.label ? { label: LABEL } : {}),
		...(opts.genres ? { genres: opts.genres } : {}),
		recordings: (opts.tracks ?? [{ id: `${id}-t1`, title }]).map((t) => ({
			provider: 'spotify' as const,
			kind: 'recording' as const,
			providerId: t.id,
			name: t.title,
			facts: { ...(t.n ? { trackNumber: t.n } : {}), ...(t.disc ? { discNumber: t.disc } : {}), ...(t.bpm ? { bpm: t.bpm } : {}), ...(t.key ? { key: t.key } : {}) },
			...(t.artists ? { artists: t.artists } : {}),
			...(t.genres ? { genres: t.genres } : {}),
		})),
	};
}

async function seed(claims: CatalogClaim[]) {
	const { db } = await createTestDb();
	await withSystemTx(db, (tx) => ingestClaims(tx, claims, { reason: 'library_import' }));
	const idOf = async (kind: string, name: string) => (await db.query<{ id: string }>(`select id from curator.catalog_object where kind = $1 and name = $2`, [kind, name]))[0]!.id;
	return { db, idOf };
}

describe('catalog.tracks', () => {
	it("lists an artist's own releases whole and someone else's release with only the artist's tracks on it", async () => {
		const marsh = artist('sa1', 'Marsh');
		const nox = artist('sa2', 'Nox Vahn');
		const { db, idOf } = await seed([
			release('sr1', 'Lailonie', [marsh], { date: '2026-03-01', tracks: [{ id: 'st1', title: 'Lailonie', n: 1 }, { id: 'st2', title: 'Eu Topos', n: 2 }] }),
			release('sr2', 'Brainwasher Remixes', [nox], {
				date: '2026-05-01',
				tracks: [
					{ id: 'st3', title: 'Brainwasher', n: 1 },
					{ id: 'st4', title: 'Brainwasher (Marsh Remix)', n: 2, artists: [nox, marsh] },
				],
			}),
		]);
		const id = await idOf('artist', 'Marsh');
		const page = (await withSystemTx(db, (tx) => pageTracks(tx, id)))!;
		expect(page.object).toMatchObject({ kind: 'artist', name: 'Marsh' });
		expect(page.releaseCount).toBe(2);
		expect(page.nextCursor).toBeNull();
		// Newest first.
		expect(page.releases.map((r) => [r.title, r.appearance, r.trackCount, r.tracks.map((t) => t.title)])).toEqual([
			['Brainwasher Remixes', true, 2, ['Brainwasher (Marsh Remix)']],
			['Lailonie', false, 2, ['Lailonie', 'Eu Topos']],
		]);
		expect(page.releases[0]!.tracks[0]!.artists.map((a) => a.name)).toEqual(['Nox Vahn', 'Marsh']);
		expect(page.releases[1]!.tracks[0]!.handles).toEqual([expect.objectContaining({ provider: 'spotify', id: 'st1' })]);
	});

	it("pages a label's releases newest first, undated last, with no gap and no repeat", async () => {
		const a = artist('sa1', 'Northfold');
		const dates = ['2026-05-01', '2026-04-01', '2026-04-01', '2026-02-01', null];
		const { db, idOf } = await seed(dates.map((date, i) => release(`sr${i}`, `Release ${i}`, [a], { date, label: true })));
		const label = await idOf('label', 'Northfold');
		const seen: string[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = (await withSystemTx(db, (tx) => pageTracks(tx, label, { cursor, limit: 2 })))!;
			expect(page.releaseCount).toBe(pages === 0 ? 5 : undefined);
			seen.push(...page.releases.map((r) => `${r.date}`));
			expect(page.releases.every((r) => !r.appearance && r.labels[0]!.name === 'Northfold')).toBe(true);
			cursor = page.nextCursor ?? undefined;
			pages++;
		} while (cursor);
		expect(pages).toBe(3);
		expect(seen).toEqual(['2026-05-01', '2026-04-01', '2026-04-01', '2026-02-01', 'null']);
		expect(new Set((await db.query<{ id: string }>(`select id from curator.catalog_object where kind = 'release'`)).map((r) => r.id)).size).toBe(5);
	});

	it('orders a multi-disc tracklist by disc, and believes a disc number only where positions repeat', async () => {
		const a = artist('sa1', 'Northfold');
		const { db, idOf } = await seed([
			release('sr1', 'Double Album', [a], {
				tracks: [
					{ id: 'd2t1', title: 'Side C', n: 1, disc: 2 },
					{ id: 'd1t2', title: 'Side B', n: 2, disc: 1 },
					{ id: 'd1t1', title: 'Side A', n: 1, disc: 1 },
					{ id: 'd2t2', title: 'Side D', n: 2, disc: 2 },
				],
			}),
			// One disc: a stray disc number (stated by another release) is ignored.
			release('sr2', 'Single', [a], { date: '2025-01-01', tracks: [{ id: 's1', title: 'One', n: 1, disc: 2 }, { id: 's2', title: 'Two', n: 2 }] }),
		]);
		const [double, one] = [await idOf('release', 'Double Album'), await idOf('release', 'Single')];
		const album = (await withSystemTx(db, (tx) => pageTracks(tx, double)))!;
		expect(album.releases).toHaveLength(1);
		expect(album.releases[0]!.tracks.map((t) => [t.disc, t.position, t.title])).toEqual([
			[1, 1, 'Side A'],
			[1, 2, 'Side B'],
			[2, 1, 'Side C'],
			[2, 2, 'Side D'],
		]);
		const single = (await withSystemTx(db, (tx) => pageTracks(tx, one)))!;
		expect(single.releases[0]!.tracks.map((t) => [t.disc, t.title])).toEqual([[null, 'One'], [null, 'Two']]);
	});

	it('carries the facts a row shows, cuts a page of long tracklists short, and follows a merged id', async () => {
		const a = artist('sa1', 'Northfold');
		const many = (r: number): TrackSpec[] => Array.from({ length: 3 }, (_, i) => ({ id: `r${r}t${i}`, title: `Track ${r}-${i}`, n: i + 1 }));
		const { db, idOf } = await seed([
			release('sr0', 'Glass Rivers', [a], {
				date: '2026-06-01',
				cover: 'https://img.example/glass.jpg',
				genres: ['melodic techno'],
				tracks: [{ id: 'g1', title: 'Glass Rivers', n: 1, bpm: 124, key: 'A Minor', genres: ['melodic techno'] }],
			}),
			release('sr1', 'Compilation One', [a], { date: '2026-05-01', tracks: many(1) }),
			release('sr2', 'Compilation Two', [a], { date: '2026-04-01', tracks: many(2) }),
		]);
		const id = await idOf('artist', 'Northfold');
		const first = (await withSystemTx(db, (tx) => pageTracks(tx, id, { budget: 5 })))!;
		// 1 + 3 fit the budget; the second compilation would pass it.
		expect(first.releases.map((r) => r.title)).toEqual(['Glass Rivers', 'Compilation One']);
		expect(first.releases[0]).toMatchObject({ coverUrl: 'https://img.example/glass.jpg', genres: ['Melodic House & Techno'] });
		expect(first.releases[0]!.tracks[0]).toMatchObject({ bpm: 124, key: 'A Minor', genres: ['Melodic House & Techno'] });
		const second = (await withSystemTx(db, (tx) => pageTracks(tx, id, { cursor: first.nextCursor! })))!;
		expect(second.releases.map((r) => [r.title, r.tracks.length])).toEqual([['Compilation Two', 3]]);
		expect(second.nextCursor).toBeNull();

		// A merged-away id answers with the winner's page.
		const [stub] = await db.query<{ id: string }>(
			`insert into curator.catalog_object (kind, name, name_fold, merged_into, discovered_via) values ('artist', 'Northfold (dup)', 'northfold dup', $1, 'library_import') returning id`,
			[id],
		);
		const redirected = (await withSystemTx(db, (tx) => pageTracks(tx, stub!.id)))!;
		expect(redirected).toMatchObject({ object: { id }, redirectedFrom: stub!.id, releaseCount: 3 });
	});
});

describe('catalog.browse header facts', () => {
	it("answers genres, track counts and the caller's own watch, never another user's", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const other = await app.signIn();
		const a = artist('sa1', 'Northfold');
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					release('sr1', 'Glass Rivers', [a], { label: true, genres: ['melodic techno'], tracks: [{ id: 'g1', title: 'Glass Rivers', n: 1, genres: ['melodic techno'] }, { id: 'g2', title: 'Dub', n: 2 }] }),
				],
				{ reason: 'library_import' },
			),
		);
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: a, source: 'manual' });
		const id = w.watch.object.id;

		const mine = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id });
		expect(mine.watch).toEqual({ muted: false });
		expect(mine.trackCount).toBe(2);
		expect(mine.genres).toEqual([{ id: expect.any(String), name: 'Melodic House & Techno', count: 2 }]);
		expect(mine.labels).toEqual([expect.objectContaining({ name: 'Northfold', releases: 1 })]);
		expect((await other.api.catalog.browse.query({ deviceId: other.deviceId, id })).watch).toBeNull();

		const album = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: mine.releases![0]!.id });
		expect(album).toMatchObject({ trackCount: 2, watch: null, genres: [{ name: 'Melodic House & Techno' }] });

		const page = await fan.api.catalog.tracks.query({ deviceId: fan.deviceId, id });
		expect(page.releases.map((r) => r.tracks.length)).toEqual([2]);

		// `brief`: the same facts without the release / track lists (a page header).
		const brief = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id, brief: true });
		expect(brief.releases).toBeUndefined();
		expect(brief).toMatchObject({ releaseCount: 1, trackCount: 2, watch: { muted: false }, labels: mine.labels, genres: mine.genres });
		const briefAlbum = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: mine.releases![0]!.id, brief: true });
		expect(briefAlbum.tracks).toBeUndefined();
		expect(briefAlbum).toMatchObject({ trackCount: 2, release: album.release, artists: album.artists });
	});
});

describe("catalog.browse: an artist's labels", () => {
	it('counts the releases that only name their label, under the label object of that name or by the name alone', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const a = artist('sa1', 'Northfold');
		// As Spotify states a label: text on the release, no label page.
		const texted = (id: string, title: string, labelText: string): CatalogClaim => {
			const r = release(id, title, [a]);
			return { ...r, facts: { ...r.facts, labelText } };
		};
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					release('sr1', 'Glass Rivers', [a], { label: true }),
					texted('sr2', 'Elsewhere', 'northfold'),
					texted('sr3', 'Low Tide', 'Cobalt Pier'),
					texted('sr4', 'High Tide', 'Cobalt Pier'),
					texted('sr5', 'Slack Water', 'COBALT PIER'),
					texted('sr6', 'Undertow', 'Harbour Lights'),
					release('sr7', 'Unlabelled', [a]),
				],
				{ reason: 'library_import' },
			),
		);
		const [known] = (await fan.api.catalog.resolve.mutate({ deviceId: fan.deviceId, refs: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1' }] })).objects;
		for (const brief of [true, false]) {
			const b = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: known!.id, brief });
			// The label the artist is tied to takes the release that names it in another case.
			expect(b.labels).toEqual([{ id: expect.any(String), name: 'Northfold', releases: 2 }]);
			expect(b.labelTexts).toEqual([{ name: 'Cobalt Pier', releases: 3 }, { name: 'Harbour Lights', releases: 1 }]);
		}
		// A release has its own label line: no texts beside it.
		const album = await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: (await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id: known!.id })).releases![0]!.id });
		expect(album.labelTexts).toBeUndefined();
	});
});

describe("catalog.browse: an artist's collaborations and activity", () => {
	it('counts shared tracks per co-credited artist, and dates releases and new tracks', async () => {
		const marsh = artist('sa1', 'Marsh');
		const nox = artist('sa2', 'Nox Vahn');
		const lane = artist('sa3', 'Lane 8');
		const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
		const { db, idOf } = await seed([
			release('sr1', 'Early', [marsh], { date: '2008-05-01', tracks: [{ id: 'st1', title: 'Early', artists: [marsh, nox] }] }),
			release('sr2', 'Recent', [marsh], {
				date: daysAgo(100),
				tracks: [
					{ id: 'st2', title: 'One', artists: [marsh, nox] },
					{ id: 'st3', title: 'Two', artists: [marsh, lane] },
					{ id: 'st4', title: 'Three' },
				],
			}),
			// A best-of carrying an old track again: a release, not a new track.
			release('sr3', 'Best Of', [marsh], { date: daysAgo(30), tracks: [{ id: 'st1', title: 'Early', artists: [marsh, nox] }] }),
			release('sr4', 'Undated', [marsh], { date: null }),
		]);
		const marshId = await idOf('artist', 'Marsh');
		const b = (await withSystemTx(db, (tx) => browseForClient(tx, marshId, { brief: true })))!;
		expect(b.collabs).toEqual([
			{ id: expect.any(String), name: 'Nox Vahn', tracks: 2 },
			{ id: expect.any(String), name: 'Lane 8', tracks: 1 },
		]);
		expect(b.activity).toEqual({ firstRelease: '2008-05-01', lastRelease: daysAgo(30), recentDays: 730, recentReleases: 2, recentTracks: 3 });
		// A release carries neither.
		const earlyId = await idOf('release', 'Early');
		const rel = (await withSystemTx(db, (tx) => browseForClient(tx, earlyId, { brief: true })))!;
		expect(rel.collabs).toBeUndefined();
		expect(rel.activity).toBeUndefined();
	});
});

// A catalogue the planner has no statistics for (PGlite never auto-analyses;
// a fresh import on any Postgres) used to be read release-first: every
// release in the catalogue walked, the entity's edges probed per release —
// 5 s for an artist at 2,000 releases, minutes at 10,000. The page reads
// from the entity's edges whatever the estimates say (pages.ts, the lateral
// fence); this holds it there. The budget is ~100x what it takes.
describe('catalog.tracks without planner statistics', () => {
	it('pages a big label and a prolific artist from their edges, not by walking every release', async () => {
		const { db, pg } = await createTestDb();
		await pg.exec(`
			create temp table a as select gen_random_uuid() as id, g as n from generate_series(1, 200) g;
			create temp table r as select gen_random_uuid() as id, g as n from generate_series(1, 2000) g;
			create temp table t as select gen_random_uuid() as id, r.id as rid, r.n, k from r, generate_series(1, 2) k;
			create temp table lab as select gen_random_uuid() as id;
			analyze a; analyze r; analyze t;
			insert into curator.catalog_object (id, kind, name, name_fold, discovered_via) select id, 'label', 'Big Label', 'big label', 'migration' from lab;
			insert into curator.catalog_object (id, kind, name, name_fold, discovered_via) select id, 'artist', 'Artist ' || n, 'artist ' || n, 'migration' from a;
			insert into curator.catalog_object (id, kind, name, name_fold, discovered_via, release_at)
				select id, 'release', 'Release ' || n, 'release ' || n, 'migration', timestamptz '2000-01-01' + (n || ' days')::interval from r;
			insert into curator.catalog_object (id, kind, name, name_fold, discovered_via)
				select id, 'recording', 'Track ' || n || '-' || k, 'track ' || n || '-' || k, 'migration' from t;
			insert into curator.catalog_edge (src, kind, dst) select r.id, 'release-label', lab.id from r, lab;
			-- Artist 1: 600 releases of its own, and a track on each of 400 more.
			insert into curator.catalog_edge (src, kind, dst, position)
				select a.id, 'artist-release', r.id, 0 from r join a on a.n = case when r.n <= 600 then 1 else (r.n % 199) + 2 end;
			insert into curator.catalog_edge (src, kind, dst, position) select rid, 'release-recording', id, k from t;
			insert into curator.catalog_edge (src, kind, dst, position)
				select t.id, 'recording-artist', a.id, 0 from t join a on a.n = case when t.n <= 600 then 1 else (t.n % 199) + 2 end;
			insert into curator.catalog_edge (src, kind, dst, position)
				select t.id, 'recording-artist', a.id, 1 from t join a on a.n = 1 where t.n > 600 and t.n <= 1000 and t.k = 2;
		`);
		const idOf = async (kind: string, name: string) => (await db.query<{ id: string }>(`select id from curator.catalog_object where kind = $1 and name = $2`, [kind, name]))[0]!.id;
		for (const [id, releases] of [[await idOf('label', 'Big Label'), 2000], [await idOf('artist', 'Artist 1'), 1000]] as const) {
			const t0 = performance.now();
			const first = (await withSystemTx(db, (tx) => pageTracks(tx, id)))!;
			const next = (await withSystemTx(db, (tx) => pageTracks(tx, id, { cursor: first.nextCursor! })))!;
			expect(performance.now() - t0).toBeLessThan(1500);
			expect(first.releaseCount).toBe(releases);
			expect(first.releases).toHaveLength(40);
			expect(next.releases).toHaveLength(40);
			// Newest first, and the second page carries on where the first stopped.
			expect(first.releases[0]!.date! > first.releases[39]!.date!).toBe(true);
			expect(first.releases[39]!.date! > next.releases[0]!.date!).toBe(true);
		}
		// The header's labels by text are read the same way (browse.ts
		// labelsByText): half of the artist's own releases lose their label
		// object and keep its name.
		await pg.exec(`
			update curator.catalog_object o set label_text = 'Text ' || (r.n % 5) from r where r.id = o.id;
			delete from curator.catalog_edge e using r where e.kind = 'release-label' and e.src = r.id and r.n <= 300;
		`);
		const artistId = await idOf('artist', 'Artist 1');
		const t0 = performance.now();
		const header = (await withSystemTx(db, (tx) => browseForClient(tx, artistId, { brief: true })))!;
		expect(performance.now() - t0).toBeLessThan(1500);
		expect(header.labels).toEqual([expect.objectContaining({ name: 'Big Label', releases: 300 })]);
		expect(header.labelTexts!.map((l) => l.releases)).toEqual([60, 60, 60, 60, 60]);
	});
});

describe("an artist's picture from a device", () => {
	it("is taken only from the store's own image host, and only onto the artist that store id already names", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const a = artist('sa1', 'Northfold');
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [release('sr1', 'Glass Rivers', [a])], { reason: 'library_import' }));
		const r = await fan.api.catalog.ingest.mutate({
			deviceId: fan.deviceId,
			reason: 'enrichment',
			idempotencyKey: 'artist-picture-0001',
			claims: [
				{ ...a, facts: { coverUrl: 'https://evil.example/x.jpg' } },
				// A store id the catalogue does not hold: never matched by the name.
				{ ...artist('sa-unknown', 'Northfold'), facts: { coverUrl: 'https://i.scdn.co/image/zzz' } },
				{ ...a, facts: { coverUrl: 'https://i.scdn.co/image/abc' } },
			],
		});
		expect(r.results).toMatchObject([{ rejected: 'unknown' }, { rejected: 'unknown' }, { created: false }]);
		const [known] = (await fan.api.catalog.resolve.mutate({ deviceId: fan.deviceId, refs: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1' }] })).objects;
		expect(known).toMatchObject({ name: 'Northfold', coverUrl: 'https://i.scdn.co/image/abc' });
		const artists = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_object where kind = 'artist'`);
		expect(Number(artists[0]!.n)).toBe(1);
	});
});
