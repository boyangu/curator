import type { CatalogEvent, CatalogEventCardV1, FeedEventsResult } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { CloudFeedProducer, eventToDraft, type CatalogFeedPort } from './cloud-producer.js';
import { FeedScheduler } from './scheduler.js';
import { SqliteFeedStore } from './store.js';
import type { FeedItemDraft } from './types.js';

const NOW = Date.UTC(2026, 9, 23);

function card(over: Partial<CatalogEventCardV1> = {}): CatalogEventCardV1 {
	return {
		version: 1,
		title: 'Glass Rivers',
		artists: [
			{ id: 'cat-a1', name: 'Northfold', handles: [{ provider: 'spotify', id: 'sa1', url: null }] },
			{ id: 'cat-a2', name: 'Kaske', handles: [{ provider: 'deezer', id: '92', url: null }] },
		],
		label: { id: null, name: 'Northfold Records' },
		coverUrl: 'https://img.test/c.jpg',
		releaseType: 'single',
		releaseDate: '2026-10-23',
		tracks: [
			{ id: 'cat-r1', title: 'Glass Rivers', artists: ['Northfold', 'Kaske'], isrc: 'GBAAA2600001', durationSec: 401, handles: [{ provider: 'spotify', id: 'st1', url: null }, { provider: 'deezer', id: '11', url: null }] },
			{ id: 'cat-r2', title: 'Deezer Only', artists: ['Northfold'], isrc: null, durationSec: 300, handles: [{ provider: 'deezer', id: '12', url: null }] },
		],
		handles: [
			{ provider: 'spotify', id: 'al1', url: 'https://open.spotify.com/album/al1' },
			{ provider: 'deezer', id: '1', url: 'https://www.deezer.com/album/1' },
		],
		genres: ['Melodic House & Techno'],
		...over,
	};
}

function event(seq: number, over: Partial<CatalogEvent> = {}): CatalogEvent {
	return {
		seq,
		kind: 'new_release',
		subjectId: `rel-${seq}`,
		subjects: [
			{ objectId: 'cat-lbl', kind: 'label', name: 'Northfold Records' },
			{ objectId: 'cat-a1', kind: 'artist', name: 'Northfold' },
			{ objectId: 'cat-a2', kind: 'artist', name: 'Kaske' },
		],
		releaseAt: NOW,
		sourcePublishedAt: null,
		firstSeenAt: NOW,
		recordingsNew: 1,
		confidence: 0.9,
		card: card(),
		...over,
	};
}

describe('eventToDraft', () => {
	it("files a release under the local Spotify producer's keys, the watched artist as origin", () => {
		const d = eventToDraft(event(1), new Set(['cat-a1']))!;
		expect(d).toMatchObject({ type: 'album', source: 'spotify', sourceId: 'al1', dedupeKey: 'spotify:album:al1', publishedAt: NOW });
		expect(d.origin).toEqual({ kind: 'artist', id: 'sa1', name: 'Northfold', catalogId: 'cat-a1' });
		expect(d.payload).toMatchObject({ title: 'Glass Rivers', artists: ['Northfold', 'Kaske'], artistIds: ['sa1', ''], label: 'Northfold Records', isrcResolved: true, genre: 'Melodic House & Techno' });
		expect(d.suppressKeys).toEqual(['artist:sa1', 'source:spotify']);
	});

	it('keeps only tracks the Spotify player can play, with Spotify artist ids by name', () => {
		const d = eventToDraft(event(1), new Set(['cat-a1']))!;
		expect(d.payload.tracks).toEqual([
			{ sourceTrackId: 'st1', title: 'Glass Rivers', artists: ['Northfold', 'Kaske'], artistIds: ['sa1', ''], durationSec: 401, trackNumber: 1, isrc: 'GBAAA2600001' },
		]);
	});

	it('drops what Spotify cannot play, and an artist origin without a Spotify id', () => {
		expect(eventToDraft(event(1, { card: card({ handles: [{ provider: 'deezer', id: '1', url: null }] }) }), new Set(['cat-a1']))).toBeNull();
		expect(eventToDraft(event(1, { card: card({ tracks: [card().tracks[1]!] }) }), new Set(['cat-a1']))).toBeNull();
		expect(eventToDraft(event(1), new Set(['cat-a2']))).toBeNull();
	});

	it('names a watched label as a browse origin when no watched artist is credited', () => {
		const d = eventToDraft(event(1), new Set(['cat-lbl']))!;
		expect(d.origin).toEqual({ kind: 'browse', id: 'catalog:cat-lbl', name: 'Northfold Records', catalogId: 'cat-lbl' });
	});

	it("turns a playlist addition into the local playlist producer's track item", () => {
		const d = eventToDraft(
			event(4, {
				kind: 'playlist_add',
				subjects: [{ objectId: 'cat-pl', kind: 'playlist', name: 'Deep Picks' }],
				card: {
					version: 1,
					kind: 'track',
					title: 'Fresh Add',
					artists: [{ id: 'cat-a1', name: 'Northfold', handles: [{ provider: 'spotify', id: 'sa1', url: null }] }],
					isrc: 'GBAAA2600002',
					durationSec: 400,
					albumTitle: 'Fresh Add EP',
					coverUrl: 'https://img.test/a.jpg',
					releaseDate: '2026-10-01',
					handles: [{ provider: 'spotify', id: 'st2', url: null }],
					container: { kind: 'playlist', id: 'cat-pl', name: 'Deep Picks', handles: [{ provider: 'spotify', id: 'pl1', url: null }] },
					rank: null,
					addedAt: NOW - 1000,
				},
			}),
		)!;
		expect(d).toMatchObject({ type: 'track', source: 'spotify', sourceId: 'st2', dedupeKey: 'isrc:GBAAA2600002', publishedAt: NOW - 1000 });
		expect(d.origin).toEqual({ kind: 'playlist', id: 'pl1', name: 'Deep Picks', catalogId: 'cat-pl' });
		expect(d.payload).toMatchObject({ title: 'Fresh Add', artistIds: ['sa1'], albumTitle: 'Fresh Add EP', durationSec: 400 });
		expect(d.suppressKeys).toEqual(['source:spotify', 'playlist:pl1', 'artist:sa1']);
	});

	it("files a genre's chart entry under the genre, as a browse origin; without a Spotify id it waits", () => {
		const track = (handles: { provider: 'spotify' | 'beatport'; id: string; url: null }[]): CatalogEvent =>
			event(5, {
				kind: 'chart_entry',
				subjects: [{ objectId: 'cat-genre', kind: 'genre', name: 'Melodic House & Techno' }],
				card: {
					version: 1,
					kind: 'track',
					title: 'Stay (Extended Mix)',
					artists: [{ id: 'cat-a1', name: 'Northfold', handles: [{ provider: 'spotify', id: 'sa1', url: null }] }],
					isrc: 'GBAAA2600003',
					durationSec: 351,
					albumTitle: 'Stay',
					coverUrl: null,
					releaseDate: '2026-10-23',
					handles,
					container: { kind: 'chart', id: 'cat-genre', name: 'Melodic House & Techno', handles: [{ provider: 'beatport', id: '90', url: null }] },
					rank: 7,
					addedAt: NOW,
				},
			});
		const d = eventToDraft(track([{ provider: 'beatport', id: '301', url: null }, { provider: 'spotify', id: 'st3', url: null }]))!;
		expect(d).toMatchObject({ type: 'track', sourceId: 'st3', dedupeKey: 'isrc:GBAAA2600003' });
		expect(d.origin).toEqual({ kind: 'browse', id: 'catalog:cat-genre', name: 'Melodic House & Techno', catalogId: 'cat-genre' });
		expect(d.suppressKeys).toEqual(['source:spotify', 'artist:sa1']);
		expect(eventToDraft(track([{ provider: 'beatport', id: '301', url: null }]))).toBeNull();
	});

	it('skips a card version it does not know', () => {
		expect(eventToDraft(event(1, { card: { version: 2, title: 'x' } }))).toBeNull();
	});
});

class FakePort implements CatalogFeedPort {
	asked: number[] = [];
	recentAsked: number[] = [];
	prepared = 0;
	on = true;
	constructor(
		private readonly pages: Map<number, FeedEventsResult>,
		private readonly watched = new Set(['cat-a1']),
		private readonly recentEvents: CatalogEvent[] = [],
	) {}
	available() {
		return this.on;
	}
	async events(afterSeq: number) {
		this.asked.push(afterSeq);
		return this.pages.get(afterSeq) ?? { events: [], nextSeq: afterSeq };
	}
	async recent(days: number) {
		this.recentAsked.push(days);
		return { events: this.recentEvents };
	}
	async watchedIds() {
		return this.watched;
	}
	async prepare() {
		this.prepared++;
	}
}

describe('CloudFeedProducer', () => {
	it('pages the stream with its cursor, runs the follows sync first, and leaves reissues out', async () => {
		const port = new FakePort(
			new Map([
				[0, { events: [event(3), event(5, { kind: 'reissue' })], nextSeq: 5 }],
				[5, { events: [event(9, { card: card({ handles: [{ provider: 'spotify', id: 'al9', url: null }] }) })], nextSeq: 12 }],
			]),
		);
		const r = await new CloudFeedProducer(port).poll(null);
		expect(r.drafts.map((d) => d.sourceId)).toEqual(['al1', 'al9']);
		expect(r.nextCursor).toEqual({ afterSeq: 12 });
		expect(port.asked).toEqual([0, 5, 12]);
		expect(port.prepared).toBe(1);
	});

	it('does nothing while the server does not offer the catalogue', async () => {
		const port = new FakePort(new Map());
		port.on = false;
		expect(await new CloudFeedProducer(port).poll({ afterSeq: 7 })).toEqual({ drafts: [], nextCursor: { afterSeq: 7 } });
		expect(port.asked).toEqual([]);
	});

	it('Load more reads a window of recent events and leaves the cursor alone', async () => {
		const port = new FakePort(new Map(), new Set(['cat-a1']), [event(2)]);
		const r = await new CloudFeedProducer(port).backfill({ afterSeq: 40 }, 14);
		expect(r).toMatchObject({ nextCursor: { afterSeq: 40 } });
		expect(r.drafts.map((d) => d.dedupeKey)).toEqual(['spotify:album:al1']);
		expect(port.recentAsked).toEqual([14]);
	});

	it('collapses onto the album the local Spotify producer already stored', async () => {
		const store = new SqliteFeedStore(':memory:');
		const local: FeedItemDraft = { ...eventToDraft(event(1), new Set(['cat-a1']))!, origin: { kind: 'artist', id: 'sa1', name: 'Northfold' } };
		await store.upsertItems([local]);
		const scheduler = new FeedScheduler(store);
		scheduler.register(new CloudFeedProducer(new FakePort(new Map([[0, { events: [event(1)], nextSeq: 1 }]]))));
		const r = await scheduler.runAll();
		expect(r.producers[0]).toMatchObject({ producerId: 'cloud-catalog', inserted: 0, error: null });
		const page = await store.getPage({ limit: 10 });
		expect(page.items).toHaveLength(1);
		// One artist, one origin: no multi-source boost from the same follow seen twice.
		expect(page.items[0]!.sources?.map((s) => `${s.kind}:${s.id}`)).toEqual(['artist:sa1']);
		store.close();
	});
});
