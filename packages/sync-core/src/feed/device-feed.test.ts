// The phone's feed (device-feed.ts) over a scripted cloud: the first fill and
// the cursor behind it, what a rate limit does, decisions out and in, and
// Interested. Generated temp DBs only.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { opSchemaVersion, type CatalogEvent, type CatalogEventCardV2, type CatalogEventTrackCardV2, type CatalogWatch, type CloudService, type Op } from '@curator/protocol';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { applyOps, INITIAL_PUSH_KEY } from '../sync-log/apply.js';
import { CloudTransportError } from '../sync-log/client.js';
import { recordServerV4 } from '../sync-log/features.js';
import { readOutbox } from '../sync-log/outbox.js';
import { FIRST_PULL_KEY } from '../sync-log/role.js';
import { tmpDir, type TmpDir } from '../test-support/tmp.js';
import { createDeviceFeed, queueKnownSuppressions, type DeviceFeed } from './device-feed.js';
import { SqliteFeedStore } from './store.js';
import { applyPendingFeedDecisionsAsync, syncedItemsFor } from './sync.js';

const NOW = Date.now();

let tmp: TmpDir;
let db: Db;
let raw: Database.Database;
let store: SqliteFeedStore;
let feed: DeviceFeed;

// The cloud: events by seq, the watches, and what it was asked.
let events: CatalogEvent[];
let watches: CatalogWatch[];
let pictures: Map<string, string>;
let failing: Error | null;
let offered: boolean;
let asked: string[];
let changes: number;
let kept: string | null;

const cloud: { feed: CloudService['feed']; catalog: Pick<CloudService['catalog'], 'listWatches' | 'resolve'> } = {
	feed: {
		events: async ({ afterSeq }) => {
			asked.push(`events ${afterSeq}`);
			if (failing) throw failing;
			const page = events.filter((e) => e.seq > afterSeq).slice(0, 2);
			return { events: page, nextSeq: page.length ? page[page.length - 1]!.seq : Math.max(afterSeq, ...events.map((e) => e.seq)) };
		},
		recent: async ({ days }) => {
			asked.push(`recent ${days}`);
			if (failing) throw failing;
			return { events: [...events].reverse().slice(0, 2) };
		},
	},
	catalog: {
		listWatches: async () => { asked.push('watches'); return watches; },
		resolve: async ({ refs }) => {
			asked.push(`resolve ${refs.map((r) => r.providerId).join(',')}`);
			return { objects: refs.map((r) => { const c = pictures.get(r.providerId); return c ? { id: 'x', kind: 'artist', name: 'x', handles: [], coverUrl: c, watchCount: 0 } : null; }) };
		},
	},
};

function open(): DeviceFeed {
	return createDeviceFeed({
		db, raw, store, ...cloud,
		available: () => offered, deviceId: () => 'phone',
		cache: { read: () => kept, write: (t) => { kept = t; } },
		onChanged: () => { changes++; },
	});
}

beforeEach(() => {
	tmp = tmpDir('curator-device-feed-');
	const path = join(tmp.path, 'library.db');
	migrate(path);
	const made = createDb(path);
	db = made.db;
	raw = tmp.track(made.sqlite);
	for (const k of [FIRST_PULL_KEY, INITIAL_PUSH_KEY]) raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1) ON CONFLICT(key) DO NOTHING`).run(k);
	recordServerV4(raw, true);
	store = tmp.track(new SqliteFeedStore(join(tmp.path, 'feed.db')));
	store.setDecisionSource((keys) => syncedItemsFor(raw, keys));
	[events, watches, pictures, failing, offered, asked, changes, kept] = [[], [], new Map(), null, true, [], 0, null];
	feed = open();
});
afterEach(async () => { feed.stop(); await tmp.cleanup(); });

const handle = (id: string) => [{ provider: 'spotify' as const, id, url: null }];
function trackCard(over: Partial<CatalogEventTrackCardV2> = {}): CatalogEventTrackCardV2 {
	return {
		version: 2, kind: 'track', title: 'Lailonie', artists: [{ id: 'cat-marsh', name: 'Marsh', handles: handle('ar-marsh') }], isrc: 'GBAAA2600001', durationSec: 384,
		albumTitle: 'Lailonie', coverUrl: 'https://img.test/c.jpg', releaseDate: '2026-10-23', handles: handle('sp1'),
		container: { kind: 'playlist', id: 'cat-pl', name: 'Hot / Cold', handles: handle('pl1') }, rank: null, addedAt: NOW - 86_400_000,
		bpm: 123, key: 'E Minor', genres: ['Melodic House'], label: { id: 'cat-lbl', name: 'Anjunadeep' }, ...over,
	};
}
function releaseCard(): CatalogEventCardV2 {
	return {
		version: 2, kind: 'release', title: 'Glass Rivers', artists: [{ id: 'cat-a1', name: 'Northfold', handles: handle('ar-n') }], label: null, coverUrl: null,
		releaseType: 'single', releaseDate: '2026-10-23', handles: handle('al1'), genres: [], catalogNumber: null, upc: null,
		tracks: [
			{ id: 'cat-r1', title: 'One', artists: ['Northfold'], isrc: 'GBAAA2600011', durationSec: 300, handles: handle('st1'), bpm: 120, key: null, genres: [] },
			{ id: 'cat-r2', title: 'Two', artists: ['Northfold'], isrc: null, durationSec: 300, handles: [], bpm: null, key: null, genres: [] },
		],
	};
}
function event(seq: number, over: Partial<CatalogEvent> = {}): CatalogEvent {
	return { seq, kind: 'playlist_add', subjectId: `rec-${seq}`, subjects: [], releaseAt: null, sourcePublishedAt: null, firstSeenAt: NOW - seq * 1000, recordingsNew: 1, confidence: 1, card: trackCard({ title: `T${seq}`, isrc: `GBAAA26${String(seq).padStart(5, '0')}`, handles: handle(`sp${seq}`) }), ...over };
}
const release = (seq: number): CatalogEvent => event(seq, { kind: 'new_release', subjectId: `rel-${seq}`, subjects: [{ objectId: 'cat-lbl', kind: 'label', name: 'Some Label' }, { objectId: 'cat-a1', kind: 'artist', name: 'Northfold' }], card: releaseCard() });
const watch = (id: string, name: string, spotifyId: string, coverUrl: string | null): CatalogWatch => ({ object: { id, kind: 'artist', name, handles: handle(spotifyId), coverUrl, watchCount: 1 }, source: 'manual', muted: false, createdAt: 1, tracking: [] });
const titles = async (): Promise<string[]> => (await store.getPage({ limit: 50 })).items.map((i) => i.payload.title).sort();
const itemId = async (title: string): Promise<string> => (await store.getPage({ limit: 50 })).items.find((i) => i.payload.title === title)!.id;
const ops = (): Array<[string, string, unknown]> => readOutbox(raw).map((o: Op) => [`${o.entity}.${o.kind}`, o.entity_id, o.payload]);

describe('reading the stream', () => {
	it('shows the last month first, then walks the stream from its start and keeps the cursor', async () => {
		events = [1, 2, 3, 4, 5].map((n) => event(n));
		expect(await feed.refresh()).toEqual({ inserted: 5, error: null, retryAfterMs: null });
		expect(asked.filter((a) => a !== 'watches')).toEqual(['recent 30', 'events 0', 'events 2', 'events 4', 'events 5']);
		expect(await titles()).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
		expect(changes).toBeGreaterThan(0);
		// The next pass asks only for what came after, with no first fill.
		asked = [];
		events.push(event(6));
		expect(await feed.refresh()).toMatchObject({ inserted: 1 });
		expect(asked.filter((a) => a !== 'watches')).toEqual(['events 5', 'events 6']);
	});

	it('names the followed artist as the release’s origin, from the watch list it keeps', async () => {
		watches = [watch('cat-a1', 'Northfold', 'ar-n', null)];
		events = [release(1)];
		await feed.refresh();
		expect((await store.getPage({ limit: 5 })).items[0]!.origin).toMatchObject({ kind: 'artist', name: 'Northfold' });
		expect(JSON.parse(kept!).watches).toEqual([{ id: 'cat-a1', spotifyId: 'ar-n', coverUrl: null }]);
	});

	it('waits for a server that serves the catalogue, then reads once on its own', async () => {
		offered = false;
		feed.onStatus();
		expect(await feed.refresh()).toMatchObject({ inserted: 0, error: expect.any(String) });
		expect(asked).toEqual([]);
		offered = true;
		events = [event(1)];
		feed.onStatus();
		feed.onStatus();
		await feed.refresh();
		expect(asked.filter((a) => a.startsWith('recent'))).toHaveLength(1);
		expect(await titles()).toEqual(['T1']);
	});

	it('a rate limit says how long, and nothing is asked again before then', async () => {
		failing = new CloudTransportError('rate_limited', 'rate limited', 30_000);
		expect(await feed.refresh()).toMatchObject({ inserted: 0, retryAfterMs: 30_000 });
		const n = asked.length;
		const again = await feed.refresh();
		expect(again.retryAfterMs).toBeGreaterThan(0);
		expect(asked).toHaveLength(n);
	});

	it('keeps what it has when the network is gone', async () => {
		events = [event(1)];
		await feed.refresh();
		failing = new CloudTransportError('network', 'offline');
		expect(await feed.refresh()).toMatchObject({ inserted: 0, error: 'offline', retryAfterMs: null });
		expect(await titles()).toEqual(['T1']);
	});

	it('leaves out a track whose file the library holds, and keeps one it only streams', async () => {
		const rec = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
		let ts = 1_760_000_000_000;
		const op = (entityId: string, kind: string, payload: unknown): Record<string, unknown> => ({ op_id: crypto.randomUUID(), device_id: 'desk', client_ts: ts++, schema_version: opSchemaVersion({ entity: 'library_track', kind, entity_id: entityId }), entity: 'library_track', entity_id: entityId, kind, payload });
		const meta = (source: string, isrc: string) => ({ source, title: 'x', artists: [{ name: 'x' }], album_title: null, duration_sec: 1, isrc, release_date: null, label: null, genre: null, cover_url: null, track_number: null, disc_number: null });
		applyOps(raw, [op(rec(1), 'create', {}), op(rec(1), 'set-meta', meta('local', 'GBAAA2600001')), op(rec(2), 'create', {}), op(rec(2), 'set-meta', meta('spotify', 'GBAAA2600002'))]);
		events = [event(1), event(2)];
		await feed.refresh();
		expect(await titles()).toEqual(['T2']);
	});
});

describe('decisions', () => {
	it('an archived card and a muted artist leave the feed and are stated to the account', async () => {
		events = [event(1), release(2), event(3)];
		await feed.refresh();
		await feed.archive(await itemId('T1'));
		await feed.muteArtist(await itemId('Glass Rivers'), 'ar-n');
		expect(await titles()).toEqual(['T3']);
		expect(ops()).toEqual([
			['feed_item.set-state', 'catalog:recording:rec-1', { state: 'archived', promoted_recording_id: null }],
			['feed_suppression.set', 'artist:ar-n', { scope: 'artist', active: true }],
			['feed_item.set-state', 'catalog:release:rel-2', { state: 'dismissed', promoted_recording_id: null }],
		]);
	});

	it('what another device decided applies to the rows here, and to rows that arrive later', async () => {
		events = [event(1)];
		await feed.refresh();
		let ts = 1_760_000_000_000;
		const op = (entity: string, id: string, kind: string, payload: unknown): Record<string, unknown> => ({ op_id: crypto.randomUUID(), device_id: 'desk', client_ts: ts++, schema_version: 4, entity, entity_id: id, kind, payload });
		applyOps(raw, [
			op('feed_item', 'catalog:recording:rec-1', 'set-state', { state: 'archived' }),
			op('feed_item', 'catalog:recording:rec-2', 'set-state', { state: 'dismissed' }),
			op('feed_suppression', 'playlist:pl1', 'set', { scope: 'playlist', active: true }),
		]);
		await applyPendingFeedDecisionsAsync(raw, store);
		expect(await titles()).toEqual([]);
		events.push(event(2), release(3));
		await feed.refresh();
		expect(await titles()).toEqual(['Glass Rivers']);
	});

	it('a new feed.db takes the mutes the records already held', async () => {
		raw.prepare(`DELETE FROM feed_sync_pending`).run();
		applyOps(raw, [{ op_id: crypto.randomUUID(), device_id: 'desk', client_ts: 1_760_000_000_000, schema_version: 4, entity: 'feed_suppression', entity_id: 'playlist:pl1', kind: 'set', payload: { scope: 'playlist', active: true } }]);
		raw.prepare(`DELETE FROM feed_sync_pending`).run();
		expect(queueKnownSuppressions(raw)).toBe(1);
		await applyPendingFeedDecisionsAsync(raw, store);
		events = [event(1)];
		await feed.refresh();
		expect(await titles()).toEqual([]);
	});

	it('a play is stated once for the item and by track for a release', async () => {
		events = [release(1)];
		await feed.refresh();
		await feed.played(await itemId('Glass Rivers'), 'st1');
		expect(ops().map(([k, , p]) => [k, k.endsWith('listened') ? p : null])).toEqual([['feed_item.mark-played', null], ['feed_item.mark-listened', { source_track_id: 'st1' }]]);
	});
});

describe('Interested', () => {
	it('takes a track card into the library and marks the card promoted; taking it off deletes nothing', async () => {
		events = [event(1)];
		await feed.refresh();
		const id = await itemId('T1');
		const on = await feed.interested({ itemId: id, sourceTrackId: null, on: true, trackId: null });
		if (!on.ok) throw new Error(on.reason);
		expect(await store.getItem(id)).toMatchObject({ state: 'promoted', promotedTrackId: on.trackId });
		expect(raw.prepare(`SELECT state, remote_only, bpm, key_camelot FROM track WHERE id = ?`).get(on.trackId)).toEqual({ state: 'backlog', remote_only: 1, bpm: 123, key_camelot: '9A' });
		const off = await feed.interested({ itemId: id, sourceTrackId: null, on: false, trackId: on.trackId });
		expect(off).toEqual({ ok: true, trackId: on.trackId });
		expect(await store.getItem(id)).toMatchObject({ state: 'seen', promotedTrackId: null });
		expect(raw.prepare(`SELECT count(*) FROM track_tag`).pluck().get()).toBe(0);
		expect(raw.prepare(`SELECT deleted_at FROM track WHERE id = ?`).pluck().get(on.trackId)).toBeNull();
		expect(ops().some(([k]) => k === 'library_track.delete')).toBe(false);
	});

	it('takes one track of a release, leaving the card where it is', async () => {
		events = [release(1)];
		await feed.refresh();
		const id = await itemId('Glass Rivers');
		const r = await feed.interested({ itemId: id, sourceTrackId: 'st1', on: true, trackId: null });
		if (!r.ok) throw new Error(r.reason);
		expect(raw.prepare(`SELECT title, album_title, track_number FROM track WHERE id = ?`).get(r.trackId)).toEqual({ title: 'One', album_title: 'Glass Rivers', track_number: 1 });
		expect((await store.getItem(id))!.state).toBe('fresh');
		// Not on Spotify: nothing names it to a library.
		expect(await feed.interested({ itemId: id, sourceTrackId: 'cat-r2', on: true, trackId: null })).toEqual({ ok: false, reason: 'not-on-spotify' });
	});

	it('a second tap changes nothing', async () => {
		events = [event(1)];
		await feed.refresh();
		const input = { itemId: await itemId('T1'), sourceTrackId: null, on: true, trackId: null };
		const a = await feed.interested(input);
		const n = ops().length;
		expect(await feed.interested(input)).toEqual(a);
		expect(ops()).toHaveLength(n);
		expect(raw.prepare(`SELECT count(*) FROM track`).pluck().get()).toBe(1);
	});
});

describe('artist pictures', () => {
	it('reads followed artists from the watch list, asks for the rest at once, and leaves out what failed', async () => {
		watches = [watch('cat-a1', 'Northfold', 'ar-n', 'https://img.test/n.jpg')];
		pictures.set('ar-k', 'https://img.test/k.jpg');
		await feed.refresh();
		asked = [];
		const got = await feed.artistPictures([{ catalogId: 'cat-a1', spotifyId: null }, { catalogId: 'cat-k', spotifyId: 'ar-k' }, { catalogId: null, spotifyId: 'ar-x' }, { catalogId: 'cat-z', spotifyId: null }]);
		expect(got).toEqual({ 'cat-a1': 'https://img.test/n.jpg', 'cat-k': 'https://img.test/k.jpg', 'ar-x': null, 'cat-z': null });
		expect(asked).toEqual(['watches', 'resolve ar-k,ar-x']);
	});
});
