import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { SqliteFeedStore } from './store.js';
import type { FeedItemDraft } from './types.js';

function draft(type: 'track' | 'album', sourceId: string, dedupeKey: string, extra?: Partial<FeedItemDraft['payload']>): FeedItemDraft {
	return {
		type,
		source: 'spotify',
		sourceId,
		dedupeKey,
		payload: { title: sourceId, artists: ['A'], ...extra },
		origin: null,
		publishedAt: null,
		suppressKeys: [],
	};
}

describe('SqliteFeedStore v10 → v11: reopen misses stamped behind the Beatport block', () => {
	it('reopens na tracks and refs enriched since 2026-11-08 as err, already answered by Traxsource', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'feed-v11-'));
		const path = join(dir, 'feed.db');
		try {
			const s = new SqliteFeedStore(path);
			await s.upsertItems([
				draft('track', 'blocked', 'spotify:track:blocked'),
				draft('track', 'old', 'spotify:track:old'),
				draft('track', 'linked', 'spotify:track:linked', { sourceLinks: [{ source: 'traxsource', sourceTrackId: '1' }] }),
				draft('album', 'al', 'spotify:album:al', { tracks: [
					{ sourceTrackId: 'r1', title: 'miss', artists: ['A'], durationSec: 1, enrichStatus: 'na' },
					{ sourceTrackId: 'r2', title: 'hit', artists: ['A'], durationSec: 1, enrichStatus: 'ok', bpm: 120 },
				] }),
			]);
			s.close();
			const during = Date.UTC(2026, 10, 16);
			const raw = new Database(path);
			raw.prepare(`UPDATE feed_item SET enrich_status = 'na', enriched_at = ? WHERE source_id IN ('blocked', 'linked')`).run(during);
			raw.prepare(`UPDATE feed_item SET enrich_status = 'na', enriched_at = ? WHERE source_id = 'old'`).run(Date.UTC(2026, 9, 1));
			raw.prepare(`UPDATE feed_item SET enrich_status = 'ok', enriched_at = ? WHERE source_id = 'al'`).run(during);
			raw.exec(`UPDATE feed_meta SET value = '10' WHERE key = 'schema_version'`);
			raw.close();

			const s2 = new SqliteFeedStore(path);
			const byId = new Map((await s2.listUnenriched(50)).map((i) => [i.sourceId, i]));
			expect([...byId.keys()].sort()).toEqual(['al', 'blocked']);
			expect(byId.get('blocked')!.enrichStatus).toBe('err');
			expect(byId.get('blocked')!.payload.enrichAsked).toEqual(['traxsource']);
			const [r1, r2] = byId.get('al')!.payload.tracks!;
			expect(r1).toMatchObject({ enrichStatus: 'err', enrichAsked: ['traxsource'] });
			expect(r2!.enrichStatus).toBe('ok');
			expect(r2!.enrichAsked).toBeUndefined();
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('SqliteFeedStore v11 → v12: Bandcamp-tag genres cleared for re-enrichment', () => {
	it('clears genres and enrich state on cards with a Bandcamp page, leaves the rest', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'feed-v12-'));
		const path = join(dir, 'feed.db');
		const bc = { provider: 'bandcamp' as const, id: '1', url: 'https://x.bandcamp.com/album/a' };
		try {
			const s = new SqliteFeedStore(path);
			await s.upsertItems([
				draft('album', 'al', 'catalog:release:al', { genre: 'Ambient / Experimental', handles: [bc], tracks: [
					{ sourceTrackId: 'r1', title: 'one', artists: ['A'], durationSec: 1, genre: 'Ambient / Experimental', bpm: 128, enrichStatus: 'ok', enrichAsked: ['traxsource'], sourceLinks: [{ source: 'traxsource', sourceTrackId: '9' }] },
				] }),
				draft('track', 'tr', 'catalog:recording:tr', { genre: 'House', handles: [{ ...bc, url: 'https://x.bandcamp.com/track/t' }] }),
				draft('track', 'plain', 'spotify:track:plain', { genre: 'Techno' }),
			]);
			s.close();
			const raw = new Database(path);
			raw.prepare(`UPDATE feed_item SET enrich_status = 'ok', enriched_at = 1`).run();
			raw.exec(`UPDATE feed_meta SET value = '11' WHERE key = 'schema_version'`);
			raw.close();

			const s2 = new SqliteFeedStore(path);
			const byId = new Map((await s2.listUnenriched(50)).map((i) => [i.sourceId, i]));
			expect([...byId.keys()].sort()).toEqual(['al', 'tr']);
			const al = byId.get('al')!;
			expect(al.enrichStatus).toBeNull();
			expect(al.payload.genre).toBeNull();
			const [r1] = al.payload.tracks!;
			expect(r1!.genre).toBeNull();
			expect(r1!.enrichStatus).toBeUndefined();
			expect(r1!.enrichAsked).toBeUndefined();
			// What the stores already said stays: the re-run merges into it.
			expect(r1!).toMatchObject({ bpm: 128, sourceLinks: [{ source: 'traxsource', sourceTrackId: '9' }] });
			expect(byId.get('tr')!.payload.genre).toBeNull();
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('SqliteFeedStore v12 → v13: Traxsource-only facts sent back to Beatport', () => {
	it('marks the values that are Traxsource’s provisional and reopens the track for Beatport alone', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'feed-v13-'));
		const path = join(dir, 'feed.db');
		const tx = (bpm: number, key: string, genre: string) => ({ source: 'traxsource', sourceTrackId: '9', bpm, key, payload: { genre } });
		try {
			const s = new SqliteFeedStore(path);
			await s.upsertItems([
				draft('album', 'al', 'catalog:release:al', { genre: 'Electronica', tracks: [
					// The card's own key (from the catalogue) differs from Traxsource's: it stands.
					{ sourceTrackId: 'r1', title: 'one', artists: ['A'], durationSec: 1, genre: 'Electronica', bpm: 124, keyCamelot: '8A', enrichStatus: 'ok', sourceLinks: [tx(124, 'C#maj', 'Electronica')] },
					{ sourceTrackId: 'r2', title: 'two', artists: ['A'], durationSec: 1, genre: 'Organic House', bpm: 93, enrichStatus: 'ok', sourceLinks: [{ source: 'beatport', sourceTrackId: '7' }, tx(124, 'A#min', 'Electronica')] },
				] }),
				draft('track', 'tr', 'spotify:track:tr', { genre: 'Melodic / Progressive House', bpm: 122, keyCamelot: '3A', sourceLinks: [tx(122, 'A#min', 'Melodic / Progressive House')] }),
				draft('track', 'plain', 'spotify:track:plain', { genre: 'Techno' }),
			]);
			s.close();
			const raw = new Database(path);
			raw.prepare(`UPDATE feed_item SET enrich_status = 'ok', enriched_at = 1`).run();
			raw.exec(`UPDATE feed_meta SET value = '12' WHERE key = 'schema_version'`);
			raw.close();

			const s2 = new SqliteFeedStore(path);
			const byId = new Map((await s2.listUnenriched(50)).map((i) => [i.sourceId, i]));
			expect([...byId.keys()].sort()).toEqual(['al', 'tr']);
			const al = byId.get('al')!;
			expect(al.enrichStatus).toBe('err');
			expect(al.payload.enrichProvisional).toEqual(['genre']);
			const [r1, r2] = al.payload.tracks!;
			expect(r1).toMatchObject({ enrichStatus: 'err', enrichAsked: ['traxsource'], enrichProvisional: ['bpm', 'genre'], keyCamelot: '8A' });
			// Beatport already matched it: settled.
			expect(r2!.enrichStatus).toBe('ok');
			expect(r2!.enrichProvisional).toBeUndefined();
			expect(byId.get('tr')!.payload).toMatchObject({ enrichAsked: ['traxsource'], enrichProvisional: ['bpm', 'keyCamelot', 'genre'] });
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('SqliteFeedStore filter probes', () => {
	it('existingDedupeKeys returns only stored keys', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([draft('track', 't1', 'isrc:A')]);
		expect([...(await s.existingDedupeKeys(['isrc:A', 'isrc:B']))]).toEqual(['isrc:A']);
		expect([...(await s.existingDedupeKeys([]))]).toEqual([]);
		s.close();
	});

	it('suppressedKeys returns keys for the requested scope only', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.addSuppression('artist', 'artist:X');
		await s.addSuppression('label', 'label:Y');
		expect([...(await s.suppressedKeys('artist'))]).toEqual(['artist:X']);
		s.close();
	});

	it('removeOriginItems(artist) evicts only when the unfollowed artist is the last followed one, and only artist-origin items', async () => {
		const s = new SqliteFeedStore(':memory:');
		const artistOrigin = (id: string, name: string) => ({ kind: 'artist' as const, id, name });
		await s.upsertItems([
			// Solo A release — A is the only credit. Evicted.
			{ ...draft('album', 'soloA', 'spotify:album:soloA'), origin: artistOrigin('A', 'A'),
				suppressKeys: ['source:spotify', 'artist:A'] },
			// A & B release surfaced via A; B still followed. Kept.
			{ ...draft('album', 'aAndB', 'spotify:album:aAndB'), origin: artistOrigin('A', 'A'),
				suppressKeys: ['source:spotify', 'artist:A', 'artist:B'] },
			// A & C release; C NOT followed. Evicted (A was the last followed).
			{ ...draft('album', 'aAndC', 'spotify:album:aAndC'), origin: artistOrigin('A', 'A'),
				suppressKeys: ['source:spotify', 'artist:A', 'artist:C'] },
			// Playlist-origin track that merely features A — out of scope, kept.
			{ ...draft('track', 'plA', 'isrc:PLA'), origin: { kind: 'playlist', id: 'P1', name: 'P1' },
				suppressKeys: ['source:spotify', 'playlist:P1', 'artist:A'] },
		]);
		const removed = await s.removeOriginItems('artist', 'A', new Set(['B']));
		expect(removed).toBe(2);
		const remaining = (await s.getPage()).items.map((i) => i.sourceId).sort();
		expect(remaining).toEqual(['aAndB', 'plA']);
		s.close();
	});

	it('removeOriginItems(playlist) keeps a track still in a followed playlist, evicting only when it was the last', async () => {
		const s = new SqliteFeedStore(':memory:');
		const plOrigin = (id: string) => ({ kind: 'playlist' as const, id, name: id });
		// Same track (isrc:X) surfaced via P1 then P2 — the second draft dedupes
		// but its 'playlist:P2' key must accrue onto the existing row.
		await s.upsertItems([
			{ ...draft('track', 'shared', 'isrc:X'), origin: plOrigin('P1'),
				suppressKeys: ['source:spotify', 'playlist:P1'] },
		]);
		await s.upsertItems([
			{ ...draft('track', 'shared', 'isrc:X'), origin: plOrigin('P2'),
				suppressKeys: ['source:spotify', 'playlist:P2'] },
		]);
		// Solo-P1 track — only in P1.
		await s.upsertItems([
			{ ...draft('track', 'soloP1', 'isrc:Y'), origin: plOrigin('P1'),
				suppressKeys: ['source:spotify', 'playlist:P1'] },
		]);
		// Unfollow P1 while P2 is still followed: shared stays, soloP1 goes.
		expect(await s.removeOriginItems('playlist', 'P1', new Set(['P2']))).toBe(1);
		expect((await s.getPage()).items.map((i) => i.sourceId).sort()).toEqual(['shared']);
		// Now unfollow P2 (nothing else followed): shared is evicted.
		expect(await s.removeOriginItems('playlist', 'P2', new Set())).toBe(1);
		expect((await s.getPage()).items).toEqual([]);
		s.close();
	});

	it('accrues every named origin onto sources (primary first) for a cross-source track', async () => {
		const s = new SqliteFeedStore(':memory:');
		const plOrigin = (id: string, name: string) => ({ kind: 'playlist' as const, id, name });
		// Same recording surfaced via two followed playlists → one row, two sources.
		await s.upsertItems([
			{ ...draft('track', 'shared', 'isrc:X'), origin: plOrigin('P1', 'Deep House Weekly'),
				suppressKeys: ['source:spotify', 'playlist:P1'] },
		]);
		await s.upsertItems([
			{ ...draft('track', 'shared', 'isrc:X'), origin: plOrigin('P2', 'Melodic Techno'),
				suppressKeys: ['source:spotify', 'playlist:P2'] },
		]);
		const item = (await s.getPage()).items[0]!;
		expect(item.origin?.id).toBe('P1'); // primary unchanged — first insert wins
		expect(item.sources?.map((o) => o.name)).toEqual(['Deep House Weekly', 'Melodic Techno']);
		s.close();
	});

	it('a single-source item reports exactly one source (no badge)', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			{ ...draft('track', 'solo', 'isrc:S'), origin: { kind: 'playlist', id: 'P1', name: 'P1' },
				suppressKeys: ['source:spotify', 'playlist:P1'] },
		]);
		const item = (await s.getPage()).items[0]!;
		expect(item.sources).toHaveLength(1);
		s.close();
	});

	it('archived items leave the feed page and appear on the archived page; restore returns them', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			draft('track', 't1', 'isrc:A'),
			draft('track', 't2', 'isrc:B'),
		]);
		const t1 = (await s.getPage()).items.find((i) => i.sourceId === 't1')!;
		await s.markState(t1.id, 'archived');
		// Gone from the feed, present on the archived page.
		expect((await s.getPage()).items.map((i) => i.sourceId)).toEqual(['t2']);
		const archived = await s.getArchivedPage();
		expect(archived.items.map((i) => i.sourceId)).toEqual(['t1']);
		expect(archived.total).toBe(1);
		// Restore (→ 'seen') brings it back to the feed and empties the archive.
		await s.markState(t1.id, 'seen');
		expect((await s.getPage()).items.map((i) => i.sourceId).sort()).toEqual(['t1', 't2']);
		expect((await s.getArchivedPage()).items).toEqual([]);
		s.close();
	});

	it('archived page orders by archive time, not published time', async () => {
		const s = new SqliteFeedStore(':memory:');
		// t1 has the NEWER release date, so a publish-ordered archive page would
		// list it first. We archive it FIRST, so an archive-ordered page lists it
		// last — proving the page keys off set-aside time.
		await s.upsertItems([
			{ ...draft('track', 't1', 'isrc:A'), publishedAt: 2000 },
			{ ...draft('track', 't2', 'isrc:B'), publishedAt: 1000 },
		]);
		const id = async (sid: string) => (await s.getPage()).items.find((i) => i.sourceId === sid)!.id;
		await s.markState(await id('t1'), 'archived');
		await new Promise((r) => setTimeout(r, 5)); // separate the archive timestamps
		await s.markState(await id('t2'), 'archived');
		const archived = await s.getArchivedPage();
		expect(archived.items.map((i) => i.sourceId)).toEqual(['t2', 't1']);
		expect(archived.items[0]!.archivedAt!).toBeGreaterThan(archived.items[1]!.archivedAt!);
		s.close();
	});

	it('getPage genre/label filter narrows the page + count; filterOptions lists distinct visible values', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			draft('track', 't1', 'isrc:1', { genre: 'House', label: 'Anjuna' }),
			draft('track', 't2', 'isrc:2', { genre: 'House', label: 'Drumcode' }),
			draft('album', 'a1', 'spotify:album:a1', { genre: 'Techno', label: 'Drumcode' }),
			draft('track', 't3', 'isrc:3'), // un-enriched — no genre/label
		]);
		// Genre filter.
		const house = await s.getPage({ genre: 'House' });
		expect(house.items.map((i) => i.sourceId).sort()).toEqual(['t1', 't2']);
		expect(house.total).toBe(2);
		// Label filter.
		const drumcode = await s.getPage({ label: 'Drumcode' });
		expect(drumcode.items.map((i) => i.sourceId).sort()).toEqual(['a1', 't2']);
		// Combined genre + label — both must match.
		const combined = await s.getPage({ genre: 'House', label: 'Drumcode' });
		expect(combined.items.map((i) => i.sourceId)).toEqual(['t2']);
		// No filter → everything (including the un-enriched row).
		expect((await s.getPage()).total).toBe(4);
		// Distinct, sorted, non-null facets.
		const opts = await s.filterOptions();
		expect(opts.genres).toEqual(['House', 'Techno']);
		expect(opts.labels).toEqual(['Anjuna', 'Drumcode']);
		s.close();
	});

	it('artist mute hides track items but keeps albums; other scopes still hide albums', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			// Multi-artist album crediting the muted artist X — must SURVIVE an
			// artist mute (its X tracks chip instead; see getItemDetail).
			{ ...draft('album', 'al1', 'spotify:album:al1'), suppressKeys: ['source:spotify', 'artist:X', 'artist:Z'] },
			// Standalone track by X — still hidden by the artist mute.
			{ ...draft('track', 't1', 'isrc:1'), suppressKeys: ['source:spotify', 'artist:X'] },
			// Album reachable via a playlist — used to prove a PLAYLIST mute still
			// hides albums (you silenced the whole origin, not one contributor).
			{ ...draft('album', 'al2', 'spotify:album:al2'), suppressKeys: ['source:spotify', 'playlist:P', 'artist:Q'] },
		]);
		await s.addSuppression('artist', 'artist:X');
		// al1 (album) stays despite the artist mute; t1 (track by X) is gone.
		expect((await s.getPage()).items.map((i) => i.sourceId).sort()).toEqual(['al2', 'al1'].sort());
		// Non-artist scopes are unaffected by the exemption: muting the playlist
		// removes the album that came through it.
		await s.addSuppression('playlist', 'playlist:P');
		expect((await s.getPage()).items.map((i) => i.sourceId)).toEqual(['al1']);
		s.close();
	});

	it('filterOptions excludes suppressed/dismissed items', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			draft('track', 't1', 'isrc:1', { genre: 'House' }),
			{ ...draft('track', 't2', 'isrc:2', { genre: 'Trance' }), suppressKeys: ['artist:X'] },
		]);
		await s.addSuppression('artist', 'artist:X');
		// t2's 'Trance' is suppressed out of both the page and the facet list.
		expect((await s.filterOptions()).genres).toEqual(['House']);
		expect((await s.getPage({ genre: 'Trance' })).items).toEqual([]);
		s.close();
	});

	it('listUnenriched includes tracks and albums-with-tracks, excludes albums without a tracklist', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			draft('track', 't1', 'spotify:track:t1'),
			draft('album', 'alWith', 'spotify:album:alWith', {
				tracks: [{ sourceTrackId: 'x', title: 'x', artists: ['A'], durationSec: 1 }],
			}),
			draft('album', 'alNo', 'spotify:album:alNo'),
		]);
		const ids = (await s.listUnenriched(50)).map((i) => i.sourceId).sort();
		expect(ids).toEqual(['alWith', 't1']);
		s.close();
	});
});

// Track ↔ album collapse + multi-source ranking (v8). The same song surfacing
// as a playlist TRACK and inside a followed artist's release ALBUM shows once:
// the album wins and carries the playlist as an extra source.
describe('SqliteFeedStore recording collapse', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const T0 = Date.parse('2026-10-01T00:00:00Z');
	const ref = (id: string, title: string, artists = ['Nicky']) => ({ sourceTrackId: id, title, artists, durationSec: 200 });
	const plTrack = (id: string, title: string, playlist: string, at = T0): FeedItemDraft => ({
		...draft('track', id, `isrc:${id}`, { title, artists: ['Nicky'] }),
		origin: { kind: 'playlist', id: playlist, name: `PL ${playlist}` },
		publishedAt: at,
		suppressKeys: ['source:spotify', `playlist:${playlist}`, 'artist:nicky'],
	});
	const release = (id: string, tracks: ReturnType<typeof ref>[], at = T0): FeedItemDraft => ({
		...draft('album', id, `spotify:album:${id}`, { title: id, artists: ['Nicky'], tracks }),
		origin: { kind: 'artist', id: 'nicky', name: 'Nicky' },
		publishedAt: at,
		suppressKeys: ['source:spotify', 'artist:nicky'],
	});
	const visible = async (s: SqliteFeedStore) => (await s.getPage()).items.map((i) => i.sourceId);

	it('track first, then its release: the track folds into the album, which gains the playlist source', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([plTrack('t1', 'Sparklestar', 'P1')]);
		await s.upsertItems([release('single', [ref('a1', 'Sparklestar')])]);
		const page = await s.getPage();
		expect(page.items.map((i) => i.sourceId)).toEqual(['single']);
		expect(page.total).toBe(1);
		expect(page.items[0]!.sources?.map((o) => o.name)).toEqual(['Nicky', 'PL P1']);
		s.close();
	});

	it('release first, then the playlist track: same outcome', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([release('single', [ref('a1', 'Sparklestar')])]);
		await s.upsertItems([plTrack('t1', 'Sparklestar', 'P1')]);
		expect(await visible(s)).toEqual(['single']);
		expect((await s.getPage()).items[0]!.sources).toHaveLength(2);
		s.close();
	});

	it('matches across title formatting but keeps distinct versions apart', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			plTrack('t1', 'In Your Mind - Tim Engelhardt Remix', 'P1'),
			plTrack('t2', 'In Your Mind - Extended Mix', 'P1'),
		]);
		await s.upsertItems([release('rmx', [ref('a1', 'In Your Mind (Tim Engelhardt Remix)')])]);
		expect((await visible(s)).sort()).toEqual(['rmx', 't2']);
		s.close();
	});

	it('multi-source items rank above same-age single-source items', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([plTrack('solo', 'Other', 'P1', T0 + DAY), plTrack('t1', 'Sparklestar', 'P1', T0)]);
		expect(await visible(s)).toEqual(['solo', 't1']);
		// Same release day as t1's add — the boost alone must lift the album.
		await s.upsertItems([release('single', [ref('a1', 'Sparklestar')], T0)]);
		expect(await visible(s)).toEqual(['single', 'solo']);
		s.close();
	});

	it('a release made only of already-handled recordings stays hidden; one with anything new still shows', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([plTrack('t1', 'Sparklestar', 'P1')]);
		const t1 = (await s.getPage()).items[0]!;
		await s.markState(t1.id, 'archived');
		await s.upsertItems([
			release('single', [ref('a1', 'Sparklestar')]),
			release('ep', [ref('b1', 'Sparklestar'), ref('b2', 'Moonfall'), ref('b3', 'Dusk')]),
		]);
		expect(await visible(s)).toEqual(['ep']);
		// Restoring the track un-handles the recording: the single comes back
		// (and the restored track folds into a release — album wins).
		await s.markState(t1.id, 'seen');
		expect((await visible(s)).sort()).toEqual(['ep', 'single']);
		s.close();
	});

	it('releases never collapse into each other', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([
			release('single', [ref('a1', 'You Will Shine - Kraak Remix')]),
			release('pack', [ref('b1', 'You Will Shine - Kraak Remix'), ref('b2', 'You Will Shine - Dub')]),
		]);
		expect((await visible(s)).sort()).toEqual(['pack', 'single']);
		s.close();
	});

	it('unfollowing the artist removes the release and gives the playlist track back', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([plTrack('t1', 'Sparklestar', 'P1'), release('single', [ref('a1', 'Sparklestar')])]);
		expect(await visible(s)).toEqual(['single']);
		expect(await s.removeOriginItems('artist', 'nicky', new Set())).toBe(1);
		const page = await s.getPage();
		expect(page.items.map((i) => i.sourceId)).toEqual(['t1']);
		expect(page.items[0]!.sources).toHaveLength(1);
		s.close();
	});

	it('a lazily-resolved tracklist (setPayload) folds matching tracks in', async () => {
		const s = new SqliteFeedStore(':memory:');
		const bare = release('single', []);
		delete bare.payload.tracks;
		await s.upsertItems([plTrack('t1', 'Sparklestar', 'P1'), bare]);
		expect((await visible(s)).sort()).toEqual(['single', 't1']);
		const album = (await s.getPage()).items.find((i) => i.sourceId === 'single')!;
		await s.setPayload(album.id, { ...album.payload, tracks: [ref('a1', 'Sparklestar')] });
		expect(await visible(s)).toEqual(['single']);
		s.close();
	});

	it('accrueSources records a later sighting on the stored row and re-ranks it', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([plTrack('t1', 'Sparklestar', 'P1', T0), plTrack('t2', 'Other', 'P1', T0 + DAY)]);
		expect(await visible(s)).toEqual(['t2', 't1']);
		await s.accrueSources([plTrack('t1', 'Sparklestar', 'P2', T0 + 2 * DAY)]);
		const page = await s.getPage();
		expect(page.items.map((i) => i.sourceId)).toEqual(['t1', 't2']);
		expect(page.items[0]!.sources?.map((o) => o.id)).toEqual(['P1', 'P2']);
		// Unfollowing P1 keeps it (still in P2) — the accrued key counts.
		expect(await s.removeOriginItems('playlist', 'P1', new Set(['P2']))).toBe(1);
		expect(await visible(s)).toEqual(['t1']);
		s.close();
	});

	it('a release its source dates ahead is dated when it reached the feed, not on that day', async () => {
		const s = new SqliteFeedStore(':memory:');
		const before = Date.now();
		const ahead = before + 22 * DAY;
		await s.upsertItems([release('early', [ref('a1', 'Sparklestar')], ahead)]);
		const early = (await s.getPage()).items[0]!;
		expect(early.publishedAt).toBeGreaterThanOrEqual(before);
		expect(early.publishedAt).toBe(early.fetchedAt);
		const raw = (s as unknown as { db: Database.Database }).db;
		expect(raw.prepare(`SELECT order_ts FROM feed_item`).get()).toEqual({ order_ts: early.fetchedAt });
		// A second follow announcing it with the same date is a sighting now.
		await s.accrueSources([{ ...release('early', [ref('a1', 'Sparklestar')], ahead), origin: { kind: 'label', id: 'lbl', name: 'Label' } }]);
		expect(raw.prepare(`SELECT COUNT(*) AS n FROM feed_item_origin WHERE seen_at > ?`).get(Date.now())).toEqual({ n: 0 });
		s.close();
	});

	it('v9 → v10 migration pulls rows dated ahead back to their fetch time', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'feed-v10-'));
		const path = join(dir, 'feed.db');
		try {
			const s = new SqliteFeedStore(path);
			await s.upsertItems([release('early', [ref('a1', 'Sparklestar')]), plTrack('t2', 'Other', 'P1', T0 + DAY)]);
			s.close();
			// Rewind to a v9 row stored with the source's future date.
			const ahead = Date.now() + 22 * DAY;
			const raw = new Database(path);
			raw.prepare(`UPDATE feed_item SET published_at = ?, order_ts = ?, fetched_at = ? WHERE source_id = 'early'`).run(ahead, ahead, T0 + 2 * DAY);
			raw.prepare(`UPDATE feed_item_origin SET seen_at = ? WHERE origin_id = 'nicky'`).run(ahead);
			raw.exec(`UPDATE feed_meta SET value = '9' WHERE key = 'schema_version'`);
			raw.close();
			const s2 = new SqliteFeedStore(path);
			const early = (await s2.getPage()).items.find((i) => i.sourceId === 'early')!;
			expect(early.publishedAt).toBe(T0 + 2 * DAY);
			const raw2 = new Database(path, { readonly: true });
			expect(raw2.prepare(`SELECT order_ts FROM feed_item WHERE source_id = 'early'`).get()).toEqual({ order_ts: T0 + 2 * DAY });
			expect(raw2.prepare(`SELECT seen_at FROM feed_item_origin WHERE origin_id = 'nicky'`).get()).toEqual({ seen_at: T0 + 2 * DAY });
			raw2.close();
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('v7 → v8 migration indexes recordings and folds existing duplicate pairs', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'feed-v8-'));
		const path = join(dir, 'feed.db');
		try {
			const s = new SqliteFeedStore(path);
			await s.upsertItems([plTrack('t1', 'Sparklestar', 'P1'), release('single', [ref('a1', 'Sparklestar')])]);
			s.close();
			// Rewind to a v7-shaped DB: no recordings, nothing covered, no seen_at.
			const raw = new Database(path);
			raw.exec(`
				DELETE FROM feed_item_recording;
				UPDATE feed_item SET covered_by = NULL;
				UPDATE feed_item_origin SET seen_at = NULL;
				UPDATE feed_meta SET value = '7' WHERE key = 'schema_version';
			`);
			raw.close();
			const s2 = new SqliteFeedStore(path);
			expect(await visible(s2)).toEqual(['single']);
			expect((await s2.getPage()).items[0]!.sources).toHaveLength(2);
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('SqliteFeedStore catalogue identity (v9 aliases)', () => {
	const catalogAlbum = (relId: string, spotifyAlbum: string | null, extra?: Partial<FeedItemDraft['payload']>): FeedItemDraft => ({
		type: 'album',
		source: spotifyAlbum ? 'spotify' : 'catalog',
		sourceId: spotifyAlbum ?? relId,
		dedupeKey: `catalog:release:${relId}`,
		aliasKeys: spotifyAlbum ? [`spotify:album:${spotifyAlbum}`] : [],
		payload: {
			title: 'Glass Rivers',
			artists: ['A'],
			catalogId: relId,
			label: 'Cat',
			handles: spotifyAlbum ? [{ provider: 'spotify', id: spotifyAlbum, url: null }] : [{ provider: 'bandcamp', id: '9', url: 'https://a.bandcamp.com/album/g' }],
			tracks: [{ sourceTrackId: spotifyAlbum ? 'st1' : 'r1', catalogId: 'r1', title: 'Glass Rivers', artists: ['A'], durationSec: 300 }],
			...extra,
		},
		origin: { kind: 'label', id: 'lbl', name: 'Cat', catalogId: 'lbl' },
		publishedAt: null,
		suppressKeys: ['label:lbl'],
	});
	const localAlbum = (): FeedItemDraft => ({
		...draft('album', 'al1', 'spotify:album:al1', { tracks: [{ sourceTrackId: 'st1', title: 'Glass Rivers', artists: ['A'], durationSec: 300 }] }),
		origin: { kind: 'artist', id: 'sa1', name: 'A' },
		suppressKeys: ['artist:sa1'],
	});

	it('a local Spotify album, then the catalogue card for it: one row, both keys, the card fills the facts', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([localAlbum()]);
		expect(await s.upsertItems([catalogAlbum('rel1', 'al1')])).toEqual({ inserted: 0 });
		const { items } = await s.getPage();
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ dedupeKey: 'spotify:album:al1', payload: { catalogId: 'rel1', label: 'Cat' } });
		expect(items[0]!.sources?.map((o) => o.kind).sort()).toEqual(['artist', 'label']);
		expect(await s.existingDedupeKeys(['catalog:release:rel1', 'spotify:album:al1'])).toEqual(new Set(['catalog:release:rel1', 'spotify:album:al1']));
		s.close();
	});

	it('the catalogue card first, then the local album: still one row', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([catalogAlbum('rel1', 'al1')]);
		expect(await s.upsertItems([localAlbum()])).toEqual({ inserted: 0 });
		const { items } = await s.getPage();
		expect(items.map((i) => i.dedupeKey)).toEqual(['catalog:release:rel1']);
		s.close();
	});

	it('a release no player could play becomes playable in place when it is announced again with a Spotify id', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([catalogAlbum('rel1', null)]);
		const before = (await s.getPage()).items[0]!;
		expect(before).toMatchObject({ source: 'catalog', sourceId: 'rel1' });
		await s.upsertItems([catalogAlbum('rel1', 'al1', { url: 'https://open.spotify.com/album/al1' })]);
		const after = (await s.getPage()).items;
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({ id: before.id, source: 'spotify', sourceId: 'al1', payload: { url: 'https://open.spotify.com/album/al1' } });
		expect(after[0]!.payload.handles?.map((h) => h.provider)).toEqual(['bandcamp', 'spotify']);
		expect(after[0]!.payload.tracks?.[0]?.sourceTrackId).toBe('st1');
		s.close();
	});

	it('a decision another device stated under the Spotify key finds the catalogue row', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([catalogAlbum('rel1', 'al1')]);
		s.applySyncedDecisions([{ dedupeKey: 'spotify:album:al1', state: 'archived', stateAt: 5, promotedTrackId: null, playedAt: null, listened: [] }], []);
		expect((await s.getPage()).items).toEqual([]);
		expect((await s.getArchivedPage()).items.map((i) => i.dedupeKey)).toEqual(['catalog:release:rel1']);
		s.close();
	});

	it('v8 → v9 migration seeds each row’s Spotify and ISRC keys as aliases', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'feed-v9-'));
		const path = join(dir, 'feed.db');
		try {
			const s = new SqliteFeedStore(path);
			await s.upsertItems([draft('track', 'st9', 'isrc:GBAAA2600009', { isrc: 'GBAAA2600009' })]);
			s.close();
			const raw = new Database(path);
			raw.exec(`DELETE FROM feed_item_alias; UPDATE feed_meta SET value = '8' WHERE key = 'schema_version';`);
			raw.close();
			const s2 = new SqliteFeedStore(path);
			expect(await s2.existingDedupeKeys(['spotify:track:st9'])).toEqual(new Set(['spotify:track:st9']));
			s2.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
