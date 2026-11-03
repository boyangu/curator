// A label's Spotify catalogue playlists (fake Spotify, made-up names): found
// by search, judged by how they correlate with what else is known of the
// label (Spotify's own label text on their albums, the label's artists, the
// releases the catalogue holds, a recent addition), attached by hand when
// the search cannot find them, read in full to give the catalogue's releases
// their Spotify ids, and then tracked as the label's Spotify source of new
// releases.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { ingestClaims } from './ingest.js';
import { judge, labelCore, labelNames, runCataloguePlaylists, type Signals } from './profile/catalogue-playlists.js';
import type { FetchLike } from './trackers/http.js';
import { SpotifyAppTracker } from './trackers/spotify-app.js';
import { runTrackers } from './trackers/sweep.js';

const quiet = createLogger(() => {});
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const LABEL = 'Northfold Records';
const DAY = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

// The label's releases as Bandcamp gave them: titles and artists, no ISRCs;
// half also on Deezer with their ISRC.
const releases = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, title: `Glass ${i + 1}`, artist: i % 2 ? 'Ilka Rane' : 'Kaske', isrc: `GBNFR26000${String(i + 1).padStart(2, '0')}` }));

async function seedLabel(app: TestApp, name = LABEL, bandId = '2140572776'): Promise<string> {
	const label: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: bandId, name };
	const claims: CatalogClaim[] = [label];
	if (name !== LABEL) return (await withSystemTx(app.db, (tx) => ingestClaims(tx, claims, { reason: 'library_import' }))).outcomes[0]!.objectId;
	for (const r of releases) {
		claims.push({
			provider: 'bandcamp',
			kind: 'release',
			providerId: `bc${r.n}`,
			name: r.title,
			facts: { releaseDate: '2025-01-01', labelText: LABEL },
			artists: [{ provider: 'bandcamp', kind: 'artist', providerId: `2140572776/${r.artist.toLowerCase()}`, name: r.artist }],
			recordings: [{ provider: 'bandcamp', kind: 'recording', providerId: `bct${r.n}`, name: r.title, facts: { durationSec: 400 } }],
			label,
		});
		if (r.n % 2) {
			claims.push({
				provider: 'deezer',
				kind: 'release',
				providerId: `dz${r.n}`,
				name: r.title,
				facts: { releaseDate: '2025-01-01', labelText: LABEL },
				artists: [{ provider: 'deezer', kind: 'artist', providerId: `d-${r.artist}`, name: r.artist }],
				recordings: [{ provider: 'deezer', kind: 'recording', providerId: `dzt${r.n}`, name: r.title, identifiers: [{ namespace: 'isrc', value: r.isrc }], facts: { durationSec: 400 } }],
			});
		}
	}
	const r = await withSystemTx(app.db, (tx) => ingestClaims(tx, claims, { reason: 'library_import' }));
	return r.outcomes[0]!.objectId;
}

// `label` is what Spotify files the album under (the label's own name, with
// "Records" or without, as labels write it).
type Entry = { id: string; title: string; artist: string; isrc: string; added: string; date?: string; label?: string };
const entry = (e: Entry) => ({
	added_at: e.added,
	item: {
		id: e.id,
		name: e.title,
		type: 'track',
		duration_ms: 400_400,
		external_ids: { isrc: e.isrc },
		artists: [{ id: `sp-${e.artist}`, name: e.artist }],
		album: { id: `al-${e.id}`, name: e.title, album_type: 'single', release_date: e.date ?? '2025-01-01', release_date_precision: 'day', artists: [{ id: `sp-${e.artist}`, name: e.artist }] },
	},
});
// The catalogue playlist: every release (ISRCs on all; Bandcamp's copies
// joined by title+artist+date, Deezer's by ISRC), added over the past
// months. The mix: two of the label's among unrelated tracks.
const catalogueEntries = (newest = 10): Entry[] => releases.map((r) => ({ id: `st${r.n}`, title: r.title, artist: r.artist, isrc: r.isrc, added: ago(newest + r.n) }));
const mixEntries = (): Entry[] => [
	...releases.slice(0, 2).map((r) => ({ id: `st${r.n}`, title: r.title, artist: r.artist, isrc: r.isrc, added: ago(5) })),
	...Array.from({ length: 10 }, (_, i) => ({ id: `other${i}`, title: `Other ${i}`, artist: 'Someone Else', isrc: `USXXX26000${i}`, added: ago(5), label: 'Elsewhere Records' })),
];

type Playlists = Record<string, { name: string; owner: string; entries: Entry[]; snapshot: string }>;
function fakeSpotify(state: { playlists: Playlists }, calls: string[] = []): FetchLike {
	return async (input) => {
		const u = new URL(input);
		const offset = Number(u.searchParams.get('offset') ?? 0);
		calls.push(`${u.pathname}${u.searchParams.has('fields') ? '?fields' : ''}${offset ? `?offset=${offset}` : ''}`);
		if (u.hostname === 'accounts.spotify.com') return json({ access_token: 'tok', expires_in: 3600 });
		if (u.pathname === '/v1/search') {
			return json({ playlists: { items: Object.entries(state.playlists).map(([id, p]) => ({ id, name: p.name, owner: { display_name: p.owner }, tracks: { total: p.entries.length } })) } });
		}
		if (u.pathname === '/v1/albums') {
			const ids = u.searchParams.get('ids')!.split(',');
			expect(ids.length).toBeLessThanOrEqual(20);
			const all = new Map<string, Entry>(Object.values(state.playlists).flatMap((p) => p.entries.map((e) => [`al-${e.id}`, e])));
			return json({ albums: ids.map((id) => (all.has(id) ? { id, name: all.get(id)!.title, label: all.get(id)!.label ?? LABEL } : null)) });
		}
		const m = /^\/v1\/playlists\/([^/]+)(\/items)?$/.exec(u.pathname);
		const p = m && state.playlists[m[1]!];
		if (!p) return new Response('{}', { status: 404 });
		if (!m![2]) return json({ snapshot_id: p.snapshot, name: p.name, owner: { display_name: p.owner, id: p.owner.toLowerCase() } });
		const items = p.entries.slice(offset, offset + 100).map(entry);
		return json({ items, total: p.entries.length, next: offset + 100 < p.entries.length ? `https://api.spotify.com/v1/playlists/${m![1]}/items?limit=100&offset=${offset + 100}` : null });
	};
}

const pending = (app: TestApp, labelId: string) => app.db.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'catalogue_playlists', 'spotify') on conflict do nothing`, [labelId]);
const run = (app: TestApp, spotify: SpotifyAppTracker) => runCataloguePlaylists({ db: app.db, log: quiet, spotify, holder: 'test' });
// Spotify ids are 22 characters; `label link` reads them off the URL.
const CAT = 'CAT000000000000000000a';
const CAT2 = 'CAT000000000000000000b';

describe('catalogue playlists', () => {
	it("matches a label's playlists by its core name, and Spotify's label text by the same", () => {
		expect(labelCore('Northfold Records')).toBe('northfold');
		expect(labelCore('Steyoyoke')).toBe('steyoyoke');
		expect(labelCore('Stil Vor Talent')).toBe('stil vor talent');
		// A name that is all label words stays itself.
		expect(labelCore('Music')).toBe('music');
		expect(labelNames('Maeve Records', 'maeve')).toBe(true);
		expect(labelNames('Maeve', 'maeve')).toBe(true);
		// A namesake inside a longer name is another label …
		expect(labelNames('Queen Maeve Records', 'maeve')).toBe(false);
		// … unless the core itself is several words.
		expect(labelNames('Stil Vor Talent Berlin', 'stil vor talent')).toBe(true);
	});

	it('judges by correlation with the label, and by freshness', () => {
		const s = (o: Partial<Signals> = {}): Signals => ({ sampled: 100, fresh: true, labelShare: 0.9, artistShare: 0.7, overlap: 20, knownArtists: 5, ...o });
		expect(judge(s())).toBe('accept');
		// The label's, but nobody adds to it any more: the operator decides.
		expect(judge(s({ fresh: false }))).toBe('review');
		// Spotify files the albums under the label but its artists are not there.
		expect(judge(s({ artistShare: 0.1 }))).toBe('review');
		// The catalogue knows no artists yet: the label text carries it alone.
		expect(judge(s({ artistShare: 0, knownArtists: 0 }))).toBe('accept');
		expect(judge(s({ artistShare: 0, knownArtists: 0, labelShare: 0.7 }))).toBe('review');
		expect(judge(s({ sampled: 8 }))).toBe('review');
		expect(judge(s({ labelShare: 0.1, artistShare: 0.1, overlap: 2 }))).toBe('reject');
		expect(judge(s({ labelShare: 0, artistShare: 0, overlap: 5 }))).toBe('review');
		expect(judge(s({ sampled: 0 }))).toBe('reject');
	});

	it("keeps the label's catalogue playlist, drops a curator's mix, and gives the label's releases their Spotify ids with Spotify's label text — no events", async () => {
		const app = await createTestApp();
		const labelId = await seedLabel(app);
		await pending(app, labelId);
		const state = {
			playlists: {
				[CAT]: { name: 'NORTHFOLD RECORDINGS', owner: '-MK-', entries: [...catalogueEntries(), { id: 'st13', title: 'Glass 13', artist: 'Kaske', isrc: 'GBNFR2600013', added: ago(3), label: 'Northfold Records Ltd.' }], snapshot: 's1' },
				MIX0000000000000000000b: { name: 'Northfold Records Tracks of the Month', owner: 'Northfold Records', entries: mixEntries(), snapshot: 'm1' },
				UNR0000000000000000000c: { name: 'Glass and Stone', owner: 'someone', entries: [], snapshot: 'u1' },
			},
		};
		const calls: string[] = [];
		const spotify = new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fakeSpotify(state, calls));
		const r = await run(app, spotify);
		expect(r).toMatchObject({ attempted: 1, accepted: 1, reviews: 0, releases: 13 });
		const ops = adminOps(app.db, {});
		const v = await ops.labelShow({ q: LABEL });
		expect(v.cataloguePlaylists.map((c) => c.name)).toEqual(['NORTHFOLD RECORDINGS']);
		expect(v).toMatchObject({ releases: 13, onSpotify: 13 });
		// Joined, not duplicated: 13 releases, 13 recordings; every recording has its Spotify id.
		const [n] = await app.db.query<{ rel: unknown; rec: unknown; sp: unknown }>(
			`select (select count(*) from curator.catalog_object where kind = 'release') as rel, (select count(*) from curator.catalog_object where kind = 'recording') as rec,
				(select count(*) from curator.catalog_source_object where provider = 'spotify' and kind = 'recording') as sp`,
		);
		expect([Number(n!.rel), Number(n!.rec), Number(n!.sp)]).toEqual([13, 13, 13]);
		// The Spotify-only release carries the label as Spotify files it, not the label's name assumed.
		expect(await app.db.query<{ label_text: string }>(`select label_text from curator.catalog_object where kind = 'release' and name = 'Glass 13'`)).toEqual([{ label_text: 'Northfold Records Ltd.' }]);
		expect(calls.filter((c) => c === '/v1/albums').length).toBeGreaterThan(0);
		expect(await app.db.query(`select 1 from curator.catalog_event`)).toEqual([]);
		expect(await app.db.query(`select 1 from curator.catalog_enrich_task where need = 'catalogue_playlists'`)).toEqual([]);
	});

	it('waits for the backfills, opens a review in the middle band with its measurements, and a decided attach makes it the catalogue', async () => {
		const app = await createTestApp();
		const labelId = await seedLabel(app);
		await pending(app, labelId);
		await app.db.query(`insert into curator.catalog_enrich_task (object_id, need, provider) values ($1, 'backfill', 'bandcamp')`, [labelId]);
		// Half the label's, half not: 6 of 12.
		const half = [...catalogueEntries().slice(0, 6), ...mixEntries().slice(2, 8)];
		const state = { playlists: { HLF0000000000000000000d: { name: 'Northfold Records Picks', owner: 'a fan', entries: half, snapshot: 'h1' } } };
		const spotify = new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fakeSpotify(state));
		expect((await run(app, spotify)).attempted).toBe(0);
		// A backfill parked hours away (a provider's challenge) is not waited for.
		await app.db.query(`update curator.catalog_enrich_task set next_due_at = now() + interval '6 hours' where need = 'backfill'`);
		expect(await run(app, spotify)).toMatchObject({ attempted: 1, accepted: 0, reviews: 1 });
		await app.db.query(`delete from curator.catalog_enrich_task where need = 'backfill'`);
		const ops = adminOps(app.db, {});
		const [rv] = await ops.list({ kind: 'label_playlist' });
		expect(rv).toMatchObject({ objectId: labelId, evidence: { knownReleases: 12, knownArtists: 2 } });
		expect(rv!.candidates[0]).toMatchObject({ name: 'Northfold Records Picks', evidence: { owner: 'a fan', total: 12, sampled: 12, labelShare: 0.5, artistShare: 0.5, overlap: 6, fresh: true } });
		await ops.decide({ id: rv!.id, decision: { action: 'attach', candidate: 0 }, by: 'claude-code', note: 'a fan keeps it current' });
		// The decision queued the step again; it reads the accepted playlist in full.
		expect(await run(app, spotify)).toMatchObject({ attempted: 1, releases: 12 });
		expect((await ops.labelShow({ q: LABEL })).cataloguePlaylists.map((c) => c.name)).toEqual(['Northfold Records Picks']);
	});

	it("asks the operator when two playlists are the label's, never attaches the other on its own, and takes it by hand", async () => {
		const app = await createTestApp();
		const labelId = await seedLabel(app);
		await pending(app, labelId);
		const state = {
			playlists: {
				[CAT]: { name: 'NORTHFOLD RECORDINGS', owner: '-MK-', entries: catalogueEntries(), snapshot: 's1' },
				[CAT2]: { name: 'Northfold Records Complete', owner: 'Northfold', entries: catalogueEntries(20), snapshot: 's2' },
			},
		};
		const spotify = new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fakeSpotify(state));
		expect(await run(app, spotify)).toMatchObject({ attempted: 1, accepted: 0, reviews: 1, releases: 0 });
		const ops = adminOps(app.db, { spotify });
		const [rv] = await ops.list({ kind: 'label_playlist' });
		expect(rv!.candidates.map((c) => c.name)).toEqual(['NORTHFOLD RECORDINGS', 'Northfold Records Complete']);
		expect(String(rv!.evidence.reason)).toMatch(/^2 playlists look like the label's/);
		await ops.decide({ id: rv!.id, decision: { action: 'attach', candidate: 0 }, by: 'claude-code', note: 'the fuller one' });
		// Re-run: the first is filled; the second, seen by the operator, is not attached by the step.
		expect(await run(app, spotify)).toMatchObject({ attempted: 1, accepted: 0, reviews: 0, releases: 12 });
		expect((await ops.labelShow({ q: LABEL })).cataloguePlaylists.map((c) => c.id)).toEqual([CAT]);
		// By hand: named from Spotify, queued, read on the next pass.
		const v = await ops.labelLink({ q: LABEL, url: `https://open.spotify.com/playlist/${CAT2}?si=abc` });
		expect(v.cataloguePlaylists.map((c) => c.name).sort()).toEqual(['NORTHFOLD RECORDINGS', 'Northfold Records Complete']);
		expect(v.gaps).toContain('catalogue playlists pending (after the backfills)');
		expect(await run(app, spotify)).toMatchObject({ attempted: 1, releases: 24 });
		// Another label cannot take a playlist that is this one's catalogue.
		const other = await seedLabel(app, 'Southfold Records', '99');
		await expect(ops.labelLink({ q: other, url: `https://open.spotify.com/playlist/${CAT2}` })).rejects.toThrow(/already the catalogue of label/);
	});

	it("a strong list nobody updates any more is the operator's call", async () => {
		const app = await createTestApp();
		const labelId = await seedLabel(app);
		await pending(app, labelId);
		const state = { playlists: { [CAT]: { name: 'NORTHFOLD RECORDINGS', owner: '-MK-', entries: catalogueEntries(400), snapshot: 's1' } } };
		const spotify = new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fakeSpotify(state));
		expect(await run(app, spotify)).toMatchObject({ attempted: 1, accepted: 0, reviews: 1 });
		const [rv] = await adminOps(app.db, {}).list({ kind: 'label_playlist' });
		expect(rv!.candidates[0]!.evidence).toMatchObject({ labelShare: 1, artistShare: 1, fresh: false });
		expect(String(rv!.evidence.reason)).toMatch(/^strong match but last updated \d{4}-\d{2}-\d{2}$/);
	});

	it('reads the last page of a long playlist for its newest addition, then every page', async () => {
		const app = await createTestApp();
		const labelId = await seedLabel(app);
		await pending(app, labelId);
		// The oldest additions first, as Spotify lists them; the newest on the last page.
		const big: Entry[] = Array.from({ length: 150 }, (_, i) => ({ id: `big${i}`, title: `Big ${i}`, artist: 'Kaske', isrc: `GBNFR2601${String(i).padStart(3, '0')}`, added: ago(500 - i * 3) }));
		const state = { playlists: { BIG0000000000000000000e: { name: 'Northfold Records', owner: 'Northfold', entries: big, snapshot: 'b1' } } };
		const calls: string[] = [];
		const spotify = new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fakeSpotify(state, calls));
		expect(await run(app, spotify)).toMatchObject({ attempted: 1, accepted: 1, releases: 150 });
		expect(calls.filter((c) => c.startsWith('/v1/playlists/BIG0000000000000000000e/items'))).toEqual([
			'/v1/playlists/BIG0000000000000000000e/items',
			'/v1/playlists/BIG0000000000000000000e/items?offset=50',
			'/v1/playlists/BIG0000000000000000000e/items',
			'/v1/playlists/BIG0000000000000000000e/items?offset=100',
		]);
	});

	it("tracks the catalogue playlist for the label's watchers: one call while unchanged, a new release announced with Spotify ids", async () => {
		const app = await createTestApp();
		const labelId = await seedLabel(app);
		const fan = await app.signIn();
		await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, objectId: labelId, source: 'manual' });
		// Following queued its profile; the playlist step waits for it. Done here.
		await app.db.query(`delete from curator.catalog_enrich_task where need = 'profile'`);
		await pending(app, labelId);
		const state = { playlists: { [CAT]: { name: 'NORTHFOLD RECORDINGS', owner: '-MK-', entries: catalogueEntries(), snapshot: 's1' } } };
		const calls: string[] = [];
		const spotify = new SpotifyAppTracker({ clientId: 'id', clientSecret: 's' }, fakeSpotify(state, calls));
		await run(app, spotify);
		// The label now has a Spotify cursor (requires a catalogue playlist).
		expect(await app.db.query(`select 1 from curator.catalog_cursor where object_id = $1 and provider = 'spotify'`, [labelId])).toHaveLength(1);
		const poll = () => runTrackers({ db: app.db, log: quiet, adapters: [spotify], holder: 'test', sleep: async () => {} }).then((ps) => ps.find((p) => p.kind === 'label' && p.provider === 'spotify'));
		// First poll marks without announcing the back catalogue.
		expect(await poll()).toMatchObject({ polled: 1, events: 0 });
		// Unchanged snapshot: one call.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute' where provider = 'spotify'`);
		calls.length = 0;
		expect(await poll()).toMatchObject({ polled: 1, unchanged: 1, events: 0 });
		expect(calls.filter((c) => c.startsWith('/v1/playlists'))).toEqual([`/v1/playlists/${CAT}?fields`]);
		// A new release added, filed by Spotify under the label's sister imprint.
		const today = new Date().toISOString().slice(0, 10);
		state.playlists[CAT]!.entries.push({ id: 'st99', title: 'Brand New', artist: 'Kaske', isrc: 'GBNFR2600099', added: new Date().toISOString(), date: today, label: 'Northfold Black' });
		state.playlists[CAT]!.snapshot = 's2';
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute' where provider = 'spotify'`);
		expect(await poll()).toMatchObject({ polled: 1, events: 1 });
		await app.pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);
		const { events } = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(events.map((e) => [e.kind, (e.card as { title: string }).title])).toEqual([['new_release', 'Brand New']]);
		const card = events[0]!.card as { handles: { provider: string; id: string }[]; tracks: { handles: { provider: string }[] }[]; label: { id: string | null } };
		expect(card.handles).toContainEqual(expect.objectContaining({ provider: 'spotify', id: 'al-st99' }));
		expect(card.tracks[0]!.handles.map((h) => h.provider)).toContain('spotify');
		expect(card.label?.id).toBe(labelId);
		const rel = await app.db.query<{ name: string; label_text: string; tied: boolean }>(
			`select o.name, o.label_text, exists (select 1 from curator.catalog_edge e where e.src = o.id and e.kind = 'release-label' and e.dst = $1) as tied
			from curator.catalog_object o join curator.catalog_source_object so on so.object_id = o.id and so.provider = 'spotify' and so.provider_id = 'al-st99'`,
			[labelId],
		);
		expect(rel).toEqual([{ name: 'Brand New', label_text: 'Northfold Black', tied: true }]);
	});
});
