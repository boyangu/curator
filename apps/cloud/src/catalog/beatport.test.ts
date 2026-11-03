// Beatport through its pages: what the adapter reads off a label's and a
// genre's `__NEXT_DATA__` (fake pages, made-up names), how a Cloudflare
// challenge parks it, and the chart_entry events a watched genre's chart
// raises for its watchers.

import { describe, expect, it } from 'vitest';
import type { CatalogEventTrackCardV1 } from '@curator/protocol';
import { createLogger } from '../log.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { BeatportTracker } from './trackers/beatport.js';
import type { FetchLike } from './trackers/http.js';
import { runTrackers } from './trackers/sweep.js';
import { TrackerRateLimitedError } from './trackers/types.js';

const quiet = createLogger(() => {});
const today = new Date().toISOString().slice(0, 10);
const DAY = 86400_000;

type Query = { queryKey: unknown[]; state: { data: unknown } };
const page = (queries: Query[], pageProps: Record<string, unknown> = {}): string =>
	`<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { ...pageProps, dehydratedState: { queries } } } })}</script></body></html>`;
const q = (key: string, data: unknown): Query => ({ queryKey: [key], state: { data } });

const label = { id: 804, name: 'Northfold Records', slug: 'northfold-records' };
const northfold = { id: 77, name: 'Northfold', slug: 'northfold' };
const kaske = { id: 78, name: 'Kaske', slug: 'kaske' };
const trackRow = (id: number, name: string, isrc: string, release: { id: number; name: string; slug: string; new_release_date: string }, artists = [northfold]) => ({
	id,
	name,
	mix_name: 'Extended Mix',
	slug: name.toLowerCase().replace(/\W+/g, '-'),
	isrc,
	length_ms: 401_000,
	number: 1,
	artists,
	remixers: [],
	genre: { id: 90, name: 'Melodic House & Techno' },
	bpm: 124,
	key: { name: 'A Minor' },
	release: { ...release, label, artists },
	new_release_date: release.new_release_date,
	publish_date: release.new_release_date,
});

function fakePages(state: { chart: ReturnType<typeof trackRow>[]; challenge?: boolean }): { fetch: FetchLike; calls: string[] } {
	const calls: string[] = [];
	const fresh = { id: 1, name: 'Glass Rivers', slug: 'glass-rivers', upc: '0123456789012', artists: [northfold], label, new_release_date: today, publish_date: today, track_count: 1, catalog_number: 'NF001' };
	const old = { id: 2, name: 'Old Album', slug: 'old-album', upc: '0123456789029', artists: [northfold, kaske], label, new_release_date: new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10), track_count: 8 };
	const fetch: FetchLike = async (input) => {
		const u = new URL(input);
		calls.push(u.pathname);
		if (state.challenge) return new Response('<html><title>Just a moment...</title><div id="cf-chl-widget"></div></html>', { status: 403 });
		const html = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
		if (u.pathname === '/label/northfold-records/804/releases') {
			return html(page([q('label-804', { ...label, image_url: 'https://img.test/l.jpg' }), q('releases-label_id=804&per_page=21&order_by=-release_date', { results: [fresh, old], next: null })]));
		}
		if (u.pathname === '/release/glass-rivers/1') {
			return html(page([q('release-1', { ...fresh, tracks: ['…'] }), { queryKey: ['tracks', { release_id: 1 }], state: { data: { results: [trackRow(11, 'Glass Rivers', 'GBAAA2600001', fresh)] } } }]));
		}
		if (u.pathname === '/genre/melodic-house-techno/90/top-100') {
			return html(page([q('genre-90-top-100-tracks-per_page=100&hype=false', { results: state.chart, next: null }), q('genre-90', { id: 90, name: 'Melodic House & Techno', slug: 'melodic-house-techno' })], { genre: { id: 90, slug: 'melodic-house-techno', name: 'Melodic House & Techno' } }));
		}
		return new Response('not found', { status: 404 });
	};
	return { fetch, calls };
}

const chartOf = (...names: [number, string, string][]) =>
	names.map(([id, name, isrc]) => trackRow(id, name, isrc, { id: 100 + id, name, slug: name.toLowerCase().replace(/\W+/g, '-'), new_release_date: today }));

const target = (kind: 'label' | 'genre', name: string, providerId: string, url: string, cursor: Record<string, unknown> = {}) => ({
	object: { id: '00000000-0000-4000-8000-000000000001', kind, name },
	representation: { providerId, url },
	cursor,
});

describe('BeatportTracker', () => {
	it("reads a label's releases: recent ones expanded with their tracks, old ones from the listing, the label as an entity", async () => {
		const { fetch, calls } = fakePages({ chart: [] });
		const bp = new BeatportTracker(fetch);
		const first = await bp.poll(target('label', 'Northfold Records', '804', 'https://www.beatport.com/label/northfold-records/804'), AbortSignal.timeout(5000));
		expect(calls).toEqual(['/label/northfold-records/804/releases', '/release/glass-rivers/1']);
		expect(first.calls).toBe(2);
		expect(first.self).toMatchObject({ kind: 'label', providerId: '804', name: 'Northfold Records' });
		const [old, fresh] = first.children;
		expect(old).toMatchObject({ kind: 'release', providerId: '2', identifiers: [{ namespace: 'upc', value: '0123456789029' }], label: { kind: 'label', providerId: '804' } });
		expect(old!.artists!.map((a) => a.name)).toEqual(['Northfold', 'Kaske']);
		expect(old!.recordings).toEqual([]);
		expect(fresh).toMatchObject({ providerId: '1', facts: { releaseDate: today, catalogNumber: 'NF001', labelText: 'Northfold Records' }, genres: ['Melodic House & Techno'] });
		expect(fresh!.recordings![0]).toMatchObject({ name: 'Glass Rivers (Extended Mix)', identifiers: [{ namespace: 'isrc', value: 'GBAAA2600001' }], facts: { durationSec: 401, bpm: 124, key: 'A Minor', trackNumber: 1 } });

		// Nothing new: one page, same listing.
		calls.length = 0;
		const again = await bp.poll(target('label', 'Northfold Records', '804', 'https://www.beatport.com/label/northfold-records/804', first.cursor), AbortSignal.timeout(5000));
		expect(calls).toEqual(['/label/northfold-records/804/releases']);
		expect(again.children).toEqual([]);
		expect(again.listingHash).toBe(first.listingHash);
	});

	it("reads a genre's top 100 as one release claim per row with the ranks beside", async () => {
		const { fetch } = fakePages({ chart: chartOf([21, 'Stay', 'GBAAA2600021'], [22, 'Drift', 'GBAAA2600022'], [23, 'Tide', 'GBAAA2600023']) });
		const r = await new BeatportTracker(fetch).poll(target('genre', 'Melodic House & Techno', '90', 'https://www.beatport.com/genre/melodic-house-techno/90'), AbortSignal.timeout(5000));
		expect(r.calls).toBe(1);
		expect(r.children.map((c) => [c.kind, c.name, c.recordings![0]!.identifiers![0]!.value])).toEqual([
			['release', 'Stay', 'GBAAA2600021'],
			['release', 'Drift', 'GBAAA2600022'],
			['release', 'Tide', 'GBAAA2600023'],
		]);
		expect(r.chart).toEqual([
			{ index: 0, rank: 1, recording: { provider: 'beatport', kind: 'recording', providerId: '21' } },
			{ index: 1, rank: 2, recording: { provider: 'beatport', kind: 'recording', providerId: '22' } },
			{ index: 2, rank: 3, recording: { provider: 'beatport', kind: 'recording', providerId: '23' } },
		]);
	});

	it('a Cloudflare challenge parks the tracker for hours', async () => {
		const { fetch } = fakePages({ chart: [], challenge: true });
		await expect(new BeatportTracker(fetch).poll(target('genre', 'X', '90', null as unknown as string), AbortSignal.timeout(5000))).rejects.toSatisfy(
			(e: unknown) => e instanceof TrackerRateLimitedError && e.retryAfterSec === 6 * 3600,
		);
	});
});

const settle = (app: TestApp) => app.pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);
const due = (app: TestApp) => app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
const run = (app: TestApp, fetch: FetchLike) => runTrackers({ db: app.db, log: quiet, adapters: [new BeatportTracker(fetch)], holder: 'test', sleep: async () => {} });

describe('watched genres and labels through Beatport', () => {
	it("a watched genre's chart raises one chart_entry per track, once, and queues their Spotify ids", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const [genre] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_genre where slug = 'melodic-house-techno'`);
		await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, objectId: genre!.object_id, source: 'manual' });
		const [cur] = await app.db.query<{ provider: string }>(`select provider from curator.catalog_cursor where object_id = $1`, [genre!.object_id]);
		expect(cur?.provider).toBe('beatport');

		const state = { chart: chartOf([21, 'Stay', 'GBAAA2600021'], [22, 'Drift', 'GBAAA2600022']) };
		const { fetch } = fakePages(state);
		expect((await run(app, fetch))[0]).toMatchObject({ polled: 1, events: 2 });
		await settle(app);
		const first = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(first.events.map((e) => e.kind)).toEqual(['chart_entry', 'chart_entry']);
		const card = first.events[0]!.card as CatalogEventTrackCardV1;
		expect(card).toMatchObject({ kind: 'track', title: 'Stay (Extended Mix)', isrc: 'GBAAA2600021', rank: 1, container: { kind: 'chart', id: genre!.object_id, name: 'Melodic House & Techno' } });
		expect(card.container.handles).toEqual([{ provider: 'beatport', id: '90', url: 'https://www.beatport.com/genre/melodic-house-techno/90' }]);
		expect(first.events[0]!.subjects.map((s) => s.kind)).toEqual(['genre']);
		// Each charted track waits for its Spotify id.
		const [tasks] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_enrich_task where need = 'representation' and provider = 'spotify'`);
		expect(Number(tasks!.n)).toBe(2);

		// The chart turns: a new entry raises, a track that stays or climbs does not.
		state.chart = chartOf([22, 'Drift', 'GBAAA2600022'], [23, 'Tide', 'GBAAA2600023'], [21, 'Stay', 'GBAAA2600021']);
		await due(app);
		expect((await run(app, fetch))[0]!.events).toBe(1);
		await settle(app);
		const more = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: first.nextSeq });
		expect(more.events.map((e) => (e.card as CatalogEventTrackCardV1).title)).toEqual(['Tide (Extended Mix)']);
		const ranks = await app.db.query<{ rank: unknown; best_rank: unknown }>(`select rank, best_rank from curator.catalog_chart_entry ce join curator.catalog_source_object so on so.object_id = ce.recording_id and so.provider_id = '21'`);
		expect(ranks.map((r) => [Number(r.rank), Number(r.best_rank)])).toEqual([[3, 1]]);
	});

	it("a watched label's new release is announced with the label as an entity; its back catalogue is not", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold Records', url: 'https://www.beatport.com/label/northfold-records/804' }, source: 'manual' });
		expect(w.watch.tracking.map((t) => t.provider).sort()).toEqual(['beatport', 'deezer']);
		const { fetch } = fakePages({ chart: [] });
		expect((await run(app, fetch)).find((p) => p.kind === 'label')).toMatchObject({ polled: 1, events: 1 });
		await settle(app);
		const { events } = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(events.map((e) => [e.kind, (e.card as { title: string }).title])).toEqual([['new_release', 'Glass Rivers']]);
		expect((events[0]!.card as { label: { id: string | null; name: string } }).label).toEqual({ id: w.watch.object.id, name: 'Northfold Records' });
		const [edges] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_edge where kind = 'release-label' and dst = $1`, [w.watch.object.id]);
		expect(Number(edges!.n)).toBe(2);
	});
});
