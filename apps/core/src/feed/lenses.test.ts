// Standing lenses: the pure rules (matching, thresholds, one per kind, an
// unknown kind kept but inert), the store's projection + archive counts, and
// the feed service paging over the survivors (full pages, exact total, no
// gaps or repeats across the keyset cursor).

import { describe, expect, it } from 'vitest';
import {
	EMPTY_SIGNALS,
	itemArtists,
	nameKey,
	normalizeLenses,
	parseRule,
	passes,
	serializeLenses,
	sqlFilterOf,
	withLens,
	withoutLens,
	type ArtistSignals,
	type FeedLens,
	type FeedLensRule,
} from './lenses.js';
import { SqliteFeedStore } from './store.js';
import { createFeedService, type LibraryPort } from './service.js';
import type { FeedItemDraft } from './types.js';

let n = 0;
const lens = (rule: FeedLensRule): FeedLens => ({ id: `l${++n}`, label: 'x', rule, by: 'user', createdAt: 0 });
const item = (artists: string[], artistIds?: string[]) => ({ payload: { title: 't', artists, ...(artistIds ? { artistIds } : {}) } });
const signals = (s: Partial<ArtistSignals>): ArtistSignals => ({ ...EMPTY_SIGNALS, ...s });

describe('lens rules', () => {
	it('matches an artist by Spotify id first, then by the folded name', () => {
		expect(itemArtists({ artists: ['Ben Böhmer', 'Nobody'], artistIds: ['sp1', ''] })).toEqual([
			{ name: 'Ben Böhmer', keys: ['id:sp1', 'name:benbohmer'] },
			{ name: 'Nobody', keys: ['name:nobody'] },
		]);
		const have = signals({ library: new Set([nameKey('BEN BOHMER')!]) });
		const dontHave = [lens({ kind: 'library-artist', has: false })];
		expect(passes(item(['Ben Böhmer']), dontHave, have)).toBe(false);
		expect(passes(item(['Someone Else']), dontHave, have)).toBe(true);
		expect(passes(item(['Renamed'], ['sp9']), dontHave, signals({ library: new Set(['id:sp9']) }))).toBe(false);
		// One held artist on a collab is enough to read as "have".
		expect(passes(item(['Someone Else', 'Ben Bohmer']), dontHave, have)).toBe(false);
		expect(passes(item(['Ben Böhmer']), [lens({ kind: 'library-artist', has: true })], have)).toBe(true);
		expect(passes(item([]), [lens({ kind: 'library-artist', has: true })], have)).toBe(false);
	});

	it('applies the archive and set-play thresholds, id count before name count', () => {
		const s = signals({
			archives: new Map([['name:a', 3], ['name:b', 2]]),
			setPlays: new Map([['id:spx', 5], ['name:x', 1]]),
		});
		const hide3 = [lens({ kind: 'archived-artist', atLeast: 3 })];
		expect(passes(item(['A']), hide3, s)).toBe(false);
		expect(passes(item(['B']), hide3, s)).toBe(true);
		expect(passes(item(['X'], ['spx']), [lens({ kind: 'set-artist', atLeast: 4 })], s)).toBe(true);
		expect(passes(item(['X']), [lens({ kind: 'set-artist', atLeast: 4 })], s)).toBe(false);
		expect(passes(item(['X']), [lens({ kind: 'set-artist', atLeast: 1 })], s)).toBe(true);
	});

	it('keeps one lens per kind, newest wins, and maps genre/label to SQL', () => {
		let ls = withLens([], { rule: { kind: 'genre', value: 'House' }, by: 'user' }, 1, () => 'a');
		ls = withLens(ls, { rule: { kind: 'library-artist', has: false }, label: '  artists I  don’t have ', by: 'assistant' }, 2, () => 'b');
		ls = withLens(ls, { rule: { kind: 'genre', value: 'Techno' }, by: 'user' }, 3, () => 'c');
		expect(ls.map((l) => [l.id, l.label])).toEqual([['b', 'artists I don’t have'], ['c', 'Techno']]);
		expect(sqlFilterOf(ls)).toEqual({ genre: 'Techno' });
		expect(withoutLens(ls, 'b').map((l) => l.id)).toEqual(['c']);
	});

	it('rejects malformed rules', () => {
		expect(parseRule({ kind: 'genre', value: ' ' })).toBeNull();
		expect(parseRule({ kind: 'archived-artist', atLeast: 0 })).toBeNull();
		expect(parseRule({ kind: 'library-artist' })).toBeNull();
		expect(parseRule({ kind: 'set-artist', atLeast: 2.7 })).toEqual({ kind: 'set-artist', atLeast: 2 });
	});

	it('keeps a lens of an unknown kind as an inert chip and writes it back untouched', () => {
		const stored = [
			{ id: 'n1', label: 'future', rule: { kind: 'bpm-range', min: 120, max: 126 }, by: 'assistant', createdAt: 5 },
			{ id: 'n2', label: 'Techno', rule: { kind: 'genre', value: 'Techno' }, by: 'user', createdAt: 6 },
			{ id: 'n3', label: 'dup', rule: { kind: 'genre', value: 'House' }, by: 'user', createdAt: 7 },
			{ label: 'no id', rule: { kind: 'genre', value: 'x' } },
		];
		const ls = normalizeLenses(stored);
		expect(ls.map((l) => [l.id, !!l.inert])).toEqual([['n1', true], ['n2', false]]);
		expect(passes(item(['A']), ls, EMPTY_SIGNALS)).toBe(true);
		expect(sqlFilterOf(ls)).toEqual({ genre: 'Techno' });
		expect(serializeLenses(ls)[0]).toEqual(stored[0]);
		expect(normalizeLenses('garbage')).toEqual([]);
	});
});

const track = (id: string, artists: string[], at: number, extra: Partial<FeedItemDraft['payload']> = {}): FeedItemDraft => ({
	type: 'track',
	source: 'spotify',
	sourceId: id,
	dedupeKey: `spotify:track:${id}`,
	payload: { title: id, artists, ...extra },
	origin: null,
	publishedAt: at,
	suppressKeys: [],
});

const emptyLibrary = (signalsFor: Pick<ArtistSignals, 'library' | 'setPlays'>): LibraryPort => ({
	membership: async () => ({ membershipByIsrc: {}, membershipBySpotifyId: {}, pinnedByIsrc: new Set(), pinnedBySpotifyId: new Set(), sourceByIsrc: {}, sourceBySpotifyId: {} }) as never,
	promote: async () => 'x',
	libraryTrackIds: async () => ({ bySpotify: {}, byIsrc: {}, tierBySpotify: {}, tierByIsrc: {}, pinnedBySpotify: new Set(), pinnedByIsrc: new Set() }),
	deletedKeys: async () => ({ spotify: new Set(), isrc: new Set() }),
	unpromote: async () => {},
	artistSignals: async () => signalsFor,
});

describe('store: lens projection and archive counts', () => {
	it('projects every visible row in page order with its artists', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([track('t1', ['A'], 1000, { genre: 'House' }), track('t2', ['B', 'C'], 3000), track('t3', ['D'], 2000, { genre: 'House' })]);
		expect((await s.lensProjection()).map((r) => [r.id, r.artists])).toEqual([
			[expect.any(String), ['B', 'C']],
			[expect.any(String), ['D']],
			[expect.any(String), ['A']],
		]);
		expect((await s.lensProjection({ genre: 'House' })).map((r) => r.artists[0])).toEqual(['D', 'A']);
		s.close();
	});

	it('counts archive/dismiss events per artist, including restored items, and refreshes on change', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([track('t1', ['A'], 1000), track('t2', ['A', 'B'], 2000), track('t3', ['C'], 3000)]);
		const ids = (await s.lensProjection()).map((r) => r.id);
		const byTitle = async (t: string) => (await s.getItemsByIds(ids)).find((i) => i.payload.title === t)!.id;
		expect((await s.artistArchiveCounts()).size).toBe(0);
		const t1 = await byTitle('t1');
		const t2 = await byTitle('t2');
		await s.recordSignal({ itemId: t1, kind: 'archive' });
		await s.markState(t1, 'archived');
		await s.recordSignal({ itemId: t2, kind: 'dismiss' });
		await s.markState(t2, 'dismissed');
		let counts = await s.artistArchiveCounts();
		expect(counts.get('name:a')).toBe(2);
		expect(counts.get('name:b')).toBe(1);
		// Restored: the event still counts.
		await s.markState(t1, 'seen');
		counts = await s.artistArchiveCounts();
		expect(counts.get('name:a')).toBe(2);
		s.close();
	});

	it('returns items by id in the order asked', async () => {
		const s = new SqliteFeedStore(':memory:');
		await s.upsertItems([track('t1', ['A'], 1000), track('t2', ['B'], 2000)]);
		const ids = (await s.lensProjection()).map((r) => r.id);
		expect((await s.getItemsByIds([ids[1]!, 'missing', ids[0]!])).map((i) => i.payload.title)).toEqual(['t1', 't2']);
		s.close();
	});
});

describe('feed service: paging through artist lenses', () => {
	it('fills pages from the survivors with an exact total and a gapless cursor', async () => {
		const s = new SqliteFeedStore(':memory:');
		const drafts: FeedItemDraft[] = [];
		// 30 items; every third is by an artist the library holds.
		for (let i = 0; i < 30; i++) drafts.push(track(`t${i}`, [i % 3 === 0 ? 'Held' : `New ${i}`], 1_000_000 - i * 1000));
		await s.upsertItems(drafts);
		let lenses: FeedLens[] = [lens({ kind: 'library-artist', has: false })];
		const svc = createFeedService({
			store: s,
			auth: { getSpotifyAccessToken: async () => null },
			library: emptyLibrary({ library: new Set(['name:held']), setPlays: new Map() }),
			lenses: () => lenses,
		});
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = await svc.getPage({ limit: 7, ...(cursor ? { cursor } : {}) });
			expect(page.total).toBe(20);
			if (page.nextCursor) expect(page.items).toHaveLength(7);
			seen.push(...page.items.map((i) => i.payload.title));
			cursor = page.nextCursor;
			pages++;
		} while (cursor && pages < 10);
		expect(pages).toBe(3);
		expect(seen).toHaveLength(20);
		expect(new Set(seen).size).toBe(20);
		expect(seen.every((t) => Number(t.slice(1)) % 3 !== 0)).toBe(true);
		// Order preserved: newest first.
		expect(seen.slice(0, 3)).toEqual(['t1', 't2', 't4']);

		// A genre lens plus a conflicting genre query: nothing can pass both.
		lenses = [lens({ kind: 'genre', value: 'House' })];
		expect(await svc.getPage({ genre: 'Techno' })).toEqual({ items: [], nextCursor: null, total: 0 });
		// No lenses: today's path.
		lenses = [];
		expect((await svc.getPage({ limit: 50 })).total).toBe(30);
		s.close();
	});
});
