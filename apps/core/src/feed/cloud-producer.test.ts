import type { CatalogCheckReport, CatalogEvent, CatalogEventCardV1, CatalogEventCardV2, FeedEventsResult } from '@curator/protocol';
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

const spotifyHandles = (id: string) => [{ provider: 'spotify' as const, id, url: null }];

describe('eventToDraft', () => {
	it('keys a release by its catalogue id, with the Spotify album as an alias and the watched artist as origin', () => {
		const d = eventToDraft(event(1), new Set(['cat-a1']))!;
		expect(d).toMatchObject({ type: 'album', source: 'spotify', sourceId: 'al1', dedupeKey: 'catalog:release:rel-1', aliasKeys: ['spotify:album:al1'], publishedAt: NOW });
		expect(d.origin).toEqual({ kind: 'artist', id: 'sa1', name: 'Northfold', catalogId: 'cat-a1' });
		expect(d.payload).toMatchObject({
			title: 'Glass Rivers',
			artists: ['Northfold', 'Kaske'],
			artistIds: ['sa1', 'catalog:cat-a2'],
			label: 'Northfold Records',
			isrcResolved: true,
			genre: 'Melodic House & Techno',
			catalogId: 'rel-1',
			url: 'https://open.spotify.com/album/al1',
		});
		expect(d.payload.handles?.map((h) => h.provider)).toEqual(['spotify', 'deezer']);
		expect(d.suppressKeys).toEqual(['artist:sa1', 'artist:catalog:cat-a2', 'source:spotify']);
	});

	it('keeps every track, Spotify ids where the player can play them and catalogue ids where not', () => {
		const d = eventToDraft(event(1), new Set(['cat-a1']))!;
		expect(d.payload.tracks?.map((t) => [t.sourceTrackId, t.catalogId, t.artistIds, t.genre, t.label])).toEqual([
			['st1', 'cat-r1', ['sa1', 'catalog:cat-a2'], 'Melodic House & Techno', 'Northfold Records'],
			['cat-r2', 'cat-r2', ['sa1'], 'Melodic House & Techno', 'Northfold Records'],
		]);
	});

	it('shows a release no Spotify player can play as a catalogue item with its store handles', () => {
		const bandcamp = [{ provider: 'bandcamp' as const, id: '9', url: 'https://northfold.bandcamp.com/album/glass-rivers' }];
		const d = eventToDraft(event(1, { card: card({ handles: bandcamp, tracks: [card().tracks[1]!] }) }), new Set(['cat-a2']))!;
		expect(d).toMatchObject({ source: 'catalog', sourceId: 'rel-1', dedupeKey: 'catalog:release:rel-1', aliasKeys: [] });
		expect(d.payload.url).toBe('https://northfold.bandcamp.com/album/glass-rivers');
		expect(d.payload.tracks).toHaveLength(1);
		// An artist the catalogue knows without a Spotify id is the origin, by its object.
		expect(d.origin).toEqual({ kind: 'artist', id: 'catalog:cat-a2', name: 'Kaske', catalogId: 'cat-a2' });
		expect(d.suppressKeys).not.toContain('source:spotify');
	});

	it('names a watched label as a label origin, keyed by its catalogue id', () => {
		const d = eventToDraft(event(1, { card: card({ label: { id: 'cat-lbl', name: 'Northfold Records' } }) }), new Set(['cat-lbl']))!;
		expect(d.origin).toEqual({ kind: 'label', id: 'cat-lbl', name: 'Northfold Records', catalogId: 'cat-lbl' });
		expect(d.suppressKeys).toContain('label:cat-lbl');
	});

	it('reads the v2 facts: catalogue number, UPC and per-track BPM, key and genre', () => {
		const v1 = card();
		const v2: CatalogEventCardV2 = {
			...v1,
			version: 2,
			catalogNumber: 'NFR042',
			upc: '123456789012',
			tracks: v1.tracks.map((t, i) => ({ ...t, bpm: i === 0 ? 122 : null, key: i === 0 ? 'A Minor' : null, genres: i === 0 ? ['Progressive House'] : [] })),
		};
		const d = eventToDraft(event(1, { card: v2 }), new Set(['cat-a1']))!;
		expect(d.payload).toMatchObject({ catalogNumber: 'NFR042', upc: '123456789012' });
		expect(d.payload.tracks?.map((t) => [t.bpm, t.keyCamelot, t.genre])).toEqual([
			[122, '8A', 'Progressive House'],
			[null, null, 'Melodic House & Techno'],
		]);
	});

	it("turns a playlist addition into a catalogue track item aliased to the local playlist producer's keys", () => {
		const d = eventToDraft(
			event(4, {
				kind: 'playlist_add',
				subjectId: 'rec-4',
				subjects: [{ objectId: 'cat-pl', kind: 'playlist', name: 'Deep Picks' }],
				card: {
					version: 2,
					kind: 'track',
					title: 'Fresh Add',
					artists: [{ id: 'cat-a1', name: 'Northfold', handles: spotifyHandles('sa1') }],
					isrc: 'GBAAA2600002',
					durationSec: 400,
					albumTitle: 'Fresh Add EP',
					coverUrl: 'https://img.test/a.jpg',
					releaseDate: '2026-10-01',
					handles: spotifyHandles('st2'),
					container: { kind: 'playlist', id: 'cat-pl', name: 'Deep Picks', handles: spotifyHandles('pl1') },
					rank: null,
					addedAt: NOW - 1000,
					bpm: 124,
					key: 'F♯ Minor',
					genres: ['Deep House'],
					label: { id: 'cat-lbl', name: 'Northfold Records' },
				},
			}),
		)!;
		expect(d).toMatchObject({ type: 'track', source: 'spotify', sourceId: 'st2', dedupeKey: 'catalog:recording:rec-4', aliasKeys: ['isrc:GBAAA2600002', 'spotify:track:st2'], publishedAt: NOW - 1000 });
		expect(d.origin).toEqual({ kind: 'playlist', id: 'pl1', name: 'Deep Picks', catalogId: 'cat-pl' });
		expect(d.payload).toMatchObject({ title: 'Fresh Add', artistIds: ['sa1'], albumTitle: 'Fresh Add EP', durationSec: 400, bpm: 124, keyCamelot: '11A', genre: 'Deep House', label: 'Northfold Records' });
		expect(d.suppressKeys).toEqual(['source:spotify', 'playlist:pl1', 'artist:sa1']);
	});

	it("files a genre's chart entry under the genre with its rank; without a Spotify id it still shows", () => {
		const track = (handles: { provider: 'spotify' | 'beatport'; id: string; url: null }[]): CatalogEvent =>
			event(5, {
				kind: 'chart_entry',
				subjectId: 'rec-5',
				subjects: [{ objectId: 'cat-genre', kind: 'genre', name: 'Melodic House & Techno' }],
				card: {
					version: 1,
					kind: 'track',
					title: 'Stay (Extended Mix)',
					artists: [{ id: 'cat-a1', name: 'Northfold', handles: spotifyHandles('sa1') }],
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
		expect(d).toMatchObject({ type: 'track', source: 'spotify', sourceId: 'st3', dedupeKey: 'catalog:recording:rec-5' });
		expect(d.origin).toEqual({ kind: 'genre', id: 'cat-genre', name: 'Melodic House & Techno', catalogId: 'cat-genre', rank: 7 });
		expect(d.suppressKeys).toEqual(['source:spotify', 'genre:cat-genre', 'artist:sa1']);
		// A v1 card: the facts read empty.
		expect(d.payload).toMatchObject({ bpm: null, keyCamelot: null, genre: null, label: null });
		expect(eventToDraft(track([{ provider: 'beatport', id: '301', url: null }]))).toMatchObject({ source: 'catalog', sourceId: 'rec-5', aliasKeys: ['isrc:GBAAA2600003'] });
	});

	it('skips a card version it does not know', () => {
		expect(eventToDraft(event(1, { card: { version: 3, title: 'x' } }))).toBeNull();
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

	// A Refresh from the menu: the check is asked for first, only on a manual
	// pass with a scope, and its report rides the result as the note.
	it('asks for the check on a manual scoped pass only, and keeps the report as its note', async () => {
		const asks: (string | undefined)[] = [];
		const port = Object.assign(new FakePort(new Map([[0, { events: [], nextSeq: 0 }]])), {
			checkNow: async (kind?: string): Promise<CatalogCheckReport | null> => {
				asks.push(kind);
				return { queued: 12, byProvider: [{ provider: 'spotify', queued: 12, alreadyDue: 0, recent: 3, reading: 0, paused: 0 }], pauses: [] };
			},
		});
		const p = new CloudFeedProducer(port);
		const lines: string[] = [];
		const r = await p.poll(null, { report: (d) => lines.push(d), manual: true, scope: { check: true, kind: 'artist' } });
		expect(asks).toEqual(['artist']);
		expect(r.note).toBe('Checked your artists on spotify: 12 queued, 3 read within the hour');
		expect(lines).toContain(r.note);
		// A timer's pass, and a plain Refresh: no check.
		await p.poll(null, { report: () => {}, manual: false, scope: { check: true } });
		await p.poll(null, { report: () => {}, manual: true });
		expect(asks).toEqual(['artist']);
		// Every kind, and a worker that could not ask.
		expect((await p.poll(null, { report: () => {}, manual: true, scope: { check: true } })).note).toBe('Checked your follows on spotify: 12 queued, 3 read within the hour');
		port.checkNow = async () => null;
		expect((await p.poll(null, { report: () => {}, manual: true, scope: { check: true, kind: 'label' } })).note).toBe('Could not ask the catalogue to check your labels now');
	});

	it('does nothing while the server does not offer the catalogue, and says so', async () => {
		const port = new FakePort(new Map());
		port.on = false;
		expect(await new CloudFeedProducer(port).poll({ afterSeq: 7 })).toEqual({
			drafts: [],
			nextCursor: { afterSeq: 7 },
			skipped: 'Curator Cloud is signed out or its catalogue is not reachable',
		});
		expect(port.asked).toEqual([]);
	});

	it('Load more reads a window of recent events and leaves the cursor alone', async () => {
		const port = new FakePort(new Map(), new Set(['cat-a1']), [event(2)]);
		const r = await new CloudFeedProducer(port).backfill({ afterSeq: 40 }, 14);
		expect(r).toMatchObject({ nextCursor: { afterSeq: 40 } });
		expect(r.drafts.map((d) => d.dedupeKey)).toEqual(['catalog:release:rel-2']);
		expect(port.recentAsked).toEqual([14]);
	});

	it('collapses onto the album the local Spotify producer already stored, through the alias', async () => {
		const store = new SqliteFeedStore(':memory:');
		const fromCloud = eventToDraft(event(1), new Set(['cat-a1']))!;
		const local: FeedItemDraft = {
			type: 'album',
			source: 'spotify',
			sourceId: 'al1',
			dedupeKey: 'spotify:album:al1',
			payload: { title: 'Glass Rivers', artists: ['Northfold'], artistIds: ['sa1'], tracks: [{ sourceTrackId: 'st1', title: 'Glass Rivers', artists: ['Northfold', 'Kaske'], durationSec: 401 }] },
			origin: { kind: 'artist', id: 'sa1', name: 'Northfold' },
			publishedAt: NOW,
			suppressKeys: ['artist:sa1', 'source:spotify'],
		};
		await store.upsertItems([local]);
		const scheduler = new FeedScheduler(store);
		scheduler.register(new CloudFeedProducer(new FakePort(new Map([[0, { events: [event(1)], nextSeq: 1 }]]))));
		const r = await scheduler.runAll();
		expect(r.producers[0]).toMatchObject({ producerId: 'cloud-catalog', inserted: 0, error: null });
		const page = await store.getPage({ limit: 10 });
		expect(page.items).toHaveLength(1);
		const item = page.items[0]!;
		// The local row keeps its key; the card's facts fill what it lacked.
		expect(item.dedupeKey).toBe('spotify:album:al1');
		expect(item.payload).toMatchObject({ catalogId: 'rel-1', label: 'Northfold Records', genre: 'Melodic House & Techno' });
		expect(item.payload.tracks?.[0]).toMatchObject({ sourceTrackId: 'st1', catalogId: 'cat-r1', isrc: 'GBAAA2600001' });
		// One artist, one origin: no multi-source boost from the same follow seen twice.
		expect(item.sources?.map((s) => `${s.kind}:${s.id}`)).toEqual(['artist:sa1']);
		// The catalogue key now finds the row too.
		expect(await store.existingDedupeKeys([fromCloud.dedupeKey])).toEqual(new Set([fromCloud.dedupeKey]));
		store.close();
	});
});
