// The reading engine against fake stores and a fake cloud: what it reads for
// each job, what it shows the page as it goes, and what it reports.

import { TrackerRateLimitedError, type TrackerPoll } from '@curator/catalog-readers';
import type { CatalogClaim, CatalogJob, CatalogWork, CatalogWorkReportInput, CatalogWorkReportResult, CatalogWorkTrack } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { CATALOG_WORK_READER, createWorkEngine, type WorkEngineDeps, type WorkEvent } from './engine.js';
import type { FactHit, WorkReaders } from './readers.js';

const RELEASE_ID = '75db776e-df95-4b02-b243-6ad2171696e1';
const ARTIST_ID = '11111111-1111-4111-8111-111111111111';
const T1 = '22222222-2222-4222-8222-222222222222';
const T2 = '33333333-3333-4333-8333-333333333333';

const track = (id: string, title: string, durationSec: number, isrc: string | null = null): CatalogWorkTrack => ({ id, title, artists: ['Marsh'], durationSec, isrc, position: null });
const HELD = [track(T1, 'Lailonie', 300, 'GBKQU2600001'), track(T2, 'Eu Topos', 410, 'GBKQU2600002')];

const recording = (provider: CatalogClaim['provider'], id: string, name: string, sec: number, o: { isrc?: string; bpm?: number; key?: string; genre?: string } = {}): CatalogClaim => ({
	provider,
	kind: 'recording',
	providerId: id,
	name,
	identifiers: o.isrc ? [{ namespace: 'isrc', value: o.isrc }] : [],
	facts: { durationSec: sec, ...(o.bpm ? { bpm: o.bpm } : {}), ...(o.key ? { key: o.key } : {}) },
	...(o.genre ? { genres: [o.genre] } : {}),
});
const releaseClaim = (provider: CatalogClaim['provider'], id: string, recordings: CatalogClaim[], title = 'Lailonie'): CatalogClaim => ({
	provider,
	kind: 'release',
	providerId: id,
	name: title,
	artists: [{ provider, kind: 'artist', providerId: `${provider}-marsh`, name: 'Marsh' }],
	recordings,
});

const work = (jobs: CatalogJob[], rounds = 3): CatalogWork => ({ jobs, limits: { rounds, releases: 20 } });
const releaseJob = (o: Partial<CatalogJob & { kind: 'release' }> = {}): CatalogJob => ({
	id: `release:${RELEASE_ID}`,
	kind: 'release',
	objectId: RELEASE_ID,
	release: { title: 'Lailonie', artists: ['Marsh'], date: null, upcs: ['4066004975924'], tracks: HELD },
	read: [],
	find: [],
	check: [],
	...o,
});

type Harness = { events: WorkEvent[]; reports: Omit<CatalogWorkReportInput, 'deviceId'>[]; run(w: CatalogWork, signal?: AbortSignal): Promise<void>; engine: ReturnType<typeof createWorkEngine> };

function harness(readers: Partial<WorkReaders>, o: Partial<WorkEngineDeps> & { answer?: (input: Omit<CatalogWorkReportInput, 'deviceId'>, n: number) => CatalogWorkReportResult } = {}): Harness {
	const events: WorkEvent[] = [];
	const reports: Omit<CatalogWorkReportInput, 'deviceId'>[] = [];
	const engine = createWorkEngine({
		form: 'phone',
		enabled: () => true,
		fetch: () => Promise.reject(new Error('no network in tests')),
		beatportFetch: () => Promise.reject(new Error('no network in tests')),
		traxsourceFetch: () => Promise.reject(new Error('no network in tests')),
		spotifyToken: async () => 'token',
		report: async (input) => {
			reports.push(input);
			return o.answer?.(input, reports.length - 1) ?? { results: input.results.map((r) => ({ jobId: r.jobId, outcome: 'saved' as const })), changed: [] };
		},
		sleep: async () => {},
		gaps: { spotify: 0, deezer: 0, beatport: 0, bandcamp: 0, traxsource: 0 },
		readers,
		...o,
	});
	return {
		events,
		reports,
		engine,
		run: (w, signal = new AbortController().signal) => engine.run(w, { visit: { id: 'visit-0001' }, signal, onEvent: (e) => events.push(e) }),
	};
}

describe('the profile', () => {
	it('names the stores the device can read now, and none while the user has it off', () => {
		let on = true;
		const engine = createWorkEngine({ form: 'phone', enabled: () => on, fetch: async () => new Response('{}'), spotifyToken: async () => 't', report: async () => ({ results: [], changed: [] }) });
		// No browser's fetch for Beatport or Traxsource on this device: not read.
		expect(engine.profile()).toEqual({ form: 'phone', reader: CATALOG_WORK_READER, stores: ['spotify', 'deezer', 'bandcamp'] });
		on = false;
		expect(engine.profile().stores).toEqual([]);
		expect(engine.visit().id.length).toBeGreaterThanOrEqual(8);
	});
});

describe('a find', () => {
	const job: CatalogJob = { id: `find:${ARTIST_ID}:spotify:sa1`, kind: 'find', objectId: ARTIST_ID, of: 'artist', name: 'Marsh', page: { provider: 'spotify', providerId: 'sa1', url: null, cursor: { seen: ['old'] } } };

	it('reads the listing to its end and reports it once, with the cursor that read it, and shows the releases at once', async () => {
		const cursors: unknown[] = [];
		const polls: TrackerPoll[] = [
			{ children: [releaseClaim('spotify', 'sr1', [])], listingHash: 'pending:1', cursor: { seen: ['sr1'] }, calls: 2 },
			{ children: [releaseClaim('spotify', 'sr2', [], 'Glass Rivers'), releaseClaim('spotify', 'sr1', [])], listingHash: 'h-final', cursor: { seen: ['sr1', 'sr2'] }, calls: 3 },
		];
		const h = harness({ listing: async (_store, target) => (cursors.push(target.cursor), polls.shift()!) });
		await h.run(work([job]));
		expect(cursors).toEqual([{ seen: ['old'] }, { seen: ['sr1'] }]);
		expect(h.reports).toHaveLength(1);
		const [result] = h.reports[0]!.results as Extract<CatalogWorkReportInput['results'][number], { kind: 'find' }>[];
		expect(result!.poll).toMatchObject({ listingHash: 'h-final', cursor: { seen: ['sr1', 'sr2'] }, calls: 5 });
		expect(result!.poll!.children.map((c) => c.providerId).sort()).toEqual(['sr1', 'sr2']);
		expect(h.events.find((e) => e.type === 'found')).toMatchObject({ objectId: ARTIST_ID });
		expect(h.reports[0]!.profile).toMatchObject({ form: 'phone', visit: { id: 'visit-0001', round: 0 } });
	});

	it("reads a label's reference page before its probe, and reports the two together", async () => {
		const LABEL = '44444444-4444-4444-8444-444444444444';
		const read: string[] = [];
		const probe: CatalogJob = { id: `find:${LABEL}:bandcamp:222`, kind: 'find', objectId: LABEL, of: 'label', name: 'Monada', page: { provider: 'bandcamp', providerId: '222', url: null, cursor: {}, probe: true } };
		const reference: CatalogJob = { id: `find:${LABEL}:beatport:111`, kind: 'find', objectId: LABEL, of: 'label', name: 'Monada', page: { provider: 'beatport', providerId: '111', url: null, cursor: {} } };
		const h = harness({ listing: async (store) => (read.push(store), { children: [], listingHash: 'h', cursor: {}, calls: 1 }) });
		await h.run(work([probe, reference]));
		expect(read).toEqual(['beatport', 'bandcamp']);
		expect(h.reports.map((r) => r.results.map((x) => x.jobId))).toEqual([[reference.id, probe.id]]);
	});

	it('rests a store that said wait, says so, and asks it nothing more this visit', async () => {
		let polls = 0;
		const h = harness({
			listing: async () => {
				polls++;
				throw new TrackerRateLimitedError(120);
			},
		});
		const other: CatalogJob = { ...job, id: `find:${ARTIST_ID}:spotify:sa2`, page: { ...(job as { page: object }).page, providerId: 'sa2' } as never };
		await h.run(work([job, other]));
		expect(polls).toBe(1);
		expect(h.reports[0]!.results).toEqual([{ jobId: job.id, kind: 'error', store: 'spotify', message: 'rate limited (120s)', rateLimitedSec: 120 }]);
		expect(h.engine.profile().stores).not.toContain('spotify');
		expect(h.engine.profile().resting).toEqual([{ store: 'spotify', until: expect.any(Number) }]);
	});
});

describe('a release', () => {
	it("reads its own page and fills its rows from it, finds it at Spotify by a track's ISRC, and says Deezer has it not", async () => {
		const asked: string[] = [];
		const beatportPage = releaseClaim('beatport', 'bp1', [
			recording('beatport', 'bt1', 'Lailonie (Original Mix)', 301, { bpm: 122, key: 'A Minor', genre: 'Melodic House & Techno' }),
			recording('beatport', 'bt2', 'Eu Topos', 409, { bpm: 124, key: 'F♯ Minor', genre: 'Melodic House & Techno' }),
		]);
		const spotify = releaseClaim('spotify', 'sp1', [recording('spotify', 'st1', 'Lailonie', 300, { isrc: 'GBKQU2600001' }), recording('spotify', 'st2', 'Eu Topos', 410, { isrc: 'GBKQU2600002' })]);
		// Deezer's title search finds a compilation carrying one of the tracks: not this release.
		const compilation = releaseClaim('deezer', 'dz9', [recording('deezer', 'd1', 'Lailonie', 300), recording('deezer', 'd2', 'Other', 200), recording('deezer', 'd3', 'More', 250), recording('deezer', 'd4', 'And More', 260)]);
		const h = harness({
			release: async (handle) => (asked.push(`read ${handle.provider}`), beatportPage),
			byIsrc: async (store, isrc) => (asked.push(`isrc ${store} ${isrc}`), store === 'spotify' ? spotify : null),
			byUpc: async (store) => (asked.push(`upc ${store}`), null),
			byName: async (store) => (asked.push(`name ${store}`), [async () => compilation]),
		});
		await h.run(work([releaseJob({ read: [{ provider: 'beatport', id: 'bp1', url: null }], find: ['spotify', 'deezer'] })]));
		expect(asked).toEqual(['read beatport', 'isrc spotify GBKQU2600001', 'isrc deezer GBKQU2600001', 'isrc deezer GBKQU2600002', 'upc deezer', 'name deezer']);
		const [result] = h.reports[0]!.results as Extract<CatalogWorkReportInput['results'][number], { kind: 'release' }>[];
		expect(result!.found.map((f) => [f.how, f.claim.provider])).toEqual([['id', 'beatport'], ['isrc', 'spotify']]);
		expect(result!.notFound).toEqual(['deezer']);
		const rows = h.events.flatMap((e) => (e.type === 'rows' ? e.rows : []));
		expect(rows).toEqual([
			{ recordingId: T1, from: 'beatport', bpm: 122, keyCamelot: '8A', genre: 'Melodic House & Techno' },
			{ recordingId: T2, from: 'beatport', bpm: 124, keyCamelot: '11A', genre: 'Melodic House & Techno' },
			{ recordingId: T1, from: 'spotify', streamIds: { spotify: 'st1' } },
			{ recordingId: T2, from: 'spotify', streamIds: { spotify: 'st2' } },
		]);
	});

	it('says a page the store no longer has is gone, and compares a bare release by the tracklist its own page brought', async () => {
		const deezerPage = releaseClaim('deezer', 'dz1', [recording('deezer', 'd1', 'One', 200), recording('deezer', 'd2', 'Two', 240)], 'Bare');
		const spotify = releaseClaim('spotify', 'sp7', [recording('spotify', 's1', 'One', 201), recording('spotify', 's2', 'Two', 239)], 'Bare');
		const h = harness({
			release: async (handle) => (handle.provider === 'spotify' ? null : deezerPage),
			byIsrc: async () => null,
			byUpc: async () => null,
			byName: async (store) => (store === 'spotify' ? [async () => spotify] : []),
		});
		const bare = releaseJob({ release: { title: 'Bare', artists: ['Marsh'], date: null, upcs: [], tracks: [] }, read: [{ provider: 'spotify', id: 'gone1', url: null }, { provider: 'deezer', id: 'dz1', url: null }], find: ['spotify'] });
		await h.run(work([bare]));
		const [result] = h.reports[0]!.results as Extract<CatalogWorkReportInput['results'][number], { kind: 'release' }>[];
		expect(result!.checks).toEqual([{ handle: { provider: 'spotify', id: 'gone1', url: null }, verdict: 'gone' }]);
		expect(result!.found.map((f) => [f.how, f.claim.providerId])).toEqual([['id', 'dz1'], ['tracklist', 'sp7']]);
		// No ids of its rows yet: nothing to patch until the page reads the release again.
		expect(h.events.some((e) => e.type === 'rows')).toBe(false);
	});
});

describe('facts', () => {
	const hit = (o: Partial<FactHit>): FactHit => ({ id: '1', url: 'https://www.beatport.com/track/x/1', title: 'Lailonie', mix: null, isrc: null, durationSec: 300, bpm: null, key: null, genre: null, label: null, artists: ['Marsh'], ...o });
	const job: CatalogJob = { id: `facts:${RELEASE_ID}`, kind: 'facts', stores: ['beatport', 'traxsource'], tracks: HELD.map((t) => ({ ...t, label: null })) };

	it("asks Beatport, then Traxsource for only what Beatport left; Beatport's genre stands; a miss is said", async () => {
		const asked: string[] = [];
		const h = harness({
			facts: async (store, q) => {
				asked.push(`${store} ${q.title}`);
				if (q.title === 'Eu Topos') return null;
				return store === 'beatport' ? hit({ id: 'b1', bpm: 122, key: 'A Minor', genre: 'Melodic House & Techno' }) : hit({ id: 't1', url: 'https://www.traxsource.com/track/1', genre: 'Deep House', label: 'Monada' });
			},
		});
		await h.run(work([job]));
		// Lailonie is whole after Beatport; Eu Topos is asked of both.
		expect(asked).toEqual(['beatport Lailonie', 'beatport Eu Topos', 'traxsource Eu Topos']);
		const [result] = h.reports[0]!.results as Extract<CatalogWorkReportInput['results'][number], { kind: 'facts' }>[];
		expect(result!.rows).toEqual([
			{
				recordingId: T1,
				claim: {
					provider: 'beatport',
					kind: 'recording',
					providerId: 'b1',
					name: 'Lailonie',
					url: 'https://www.beatport.com/track/x/1',
					// The store's own codes only: the catalogue's would vouch for the match.
					identifiers: [],
					artists: [{ provider: 'user', kind: 'artist', providerId: 'name:marsh', name: 'Marsh' }],
					facts: { durationSec: 300, bpm: 122, key: 'A Minor' },
					genres: ['Melodic House & Techno'],
				},
			},
		]);
		expect(result!.notFound).toEqual([{ recordingId: T2, store: 'beatport' }, { recordingId: T2, store: 'traxsource' }]);
		expect(h.events.filter((e) => e.type === 'rows')).toEqual([{ type: 'rows', rows: [{ recordingId: T1, from: 'beatport', bpm: 122, keyCamelot: '8A', genre: 'Melodic House & Techno' }] }]);
	});
});

describe('the visit', () => {
	it("runs the cloud's follow-up work in the next round, while the visit's rounds last, and never a job twice", async () => {
		const listing = async (): Promise<TrackerPoll> => ({ children: [], listingHash: 'h', cursor: {}, calls: 1 });
		const find: CatalogJob = { id: `find:${ARTIST_ID}:spotify:sa1`, kind: 'find', objectId: ARTIST_ID, of: 'artist', name: 'Marsh', page: { provider: 'spotify', providerId: 'sa1', url: null, cursor: {} } };
		const next = releaseJob({ find: ['deezer'] });
		const h = harness(
			{ listing, byIsrc: async () => null, byUpc: async () => null, byName: async () => [] },
			{ answer: (input) => ({ results: [], changed: [ARTIST_ID], work: work([next, find]) }) },
		);
		await h.run(work([find], 2));
		expect(h.reports.map((r) => [r.profile.visit?.round, r.results.map((x) => x.jobId)])).toEqual([
			[0, [find.id]],
			[1, [next.id]],
		]);
		// One release handed in all; the keys are the visit's, in order.
		expect(h.reports[1]!.profile.visit?.taken).toBe(1);
		expect(h.reports.map((r) => r.idempotencyKey)).toEqual(['visit-0001:0', 'visit-0001:1']);
		expect(h.events.filter((e) => e.type === 'saved')).toHaveLength(2);
	});

	it('sends a report again as it was when the cloud did not take it, and gives up after its retries', async () => {
		const keys: string[] = [];
		let fail = 1;
		const h = harness(
			{ byIsrc: async () => null, byUpc: async () => null, byName: async () => [] },
			{
				report: async (input) => {
					keys.push(input.idempotencyKey);
					if (fail-- > 0) throw new Error('timeout');
					return { results: [], changed: [] };
				},
			},
		);
		await h.run(work([releaseJob({ find: ['deezer'] })]));
		expect(keys).toEqual(['visit-0001:0', 'visit-0001:0']);
		fail = 9;
		const again = harness({ byIsrc: async () => null, byUpc: async () => null, byName: async () => [] }, { report: async () => Promise.reject(new Error('offline')) });
		await again.run(work([releaseJob({ find: ['deezer'] })]));
		expect(again.events.find((e) => e.type === 'unsent')).toEqual({ type: 'unsent', results: 1, error: 'offline' });
	});

	it('stops when the page is left, and still reports what it found by then — not what a call cut short said', async () => {
		const leave = new AbortController();
		let n = 0;
		const h = harness({
			facts: async () => {
				if (++n === 2) leave.abort();
				return null;
			},
		});
		await h.run(work([{ id: `facts:${RELEASE_ID}`, kind: 'facts', stores: ['beatport'], tracks: HELD.map((t) => ({ ...t, label: null })) }]), leave.signal);
		expect(n).toBe(2);
		expect(h.reports).toHaveLength(1);
		expect(h.reports[0]!.results).toEqual([{ jobId: `facts:${RELEASE_ID}`, kind: 'facts', rows: [], notFound: [{ recordingId: T1, store: 'beatport' }] }]);
		expect(h.events.at(-1)).toEqual({ type: 'idle' });
	});
});

describe('the stores, as the engine reads them', () => {
	it("counts every Spotify call the work made, and reports them with its results", async () => {
		const urls: string[] = [];
		const fetch = async (url: string): Promise<Response> => {
			urls.push(url);
			if (url.includes('/search?type=track')) return Response.json({ tracks: { items: [{ album: { id: 'sp1' } }] } });
			if (url.includes('/albums?ids=sp1'))
				return Response.json({
					albums: [{ id: 'sp1', name: 'Lailonie', artists: [{ id: 'a', name: 'Marsh' }], tracks: { items: [{ id: 'st1', name: 'Lailonie', duration_ms: 300_000, track_number: 1 }, { id: 'st2', name: 'Eu Topos', duration_ms: 410_000, track_number: 2 }] } }],
				});
			return new Response('{}', { status: 404 });
		};
		const h = harness({}, { fetch });
		await h.run(work([releaseJob({ find: ['spotify'] })]));
		expect(urls.length).toBe(2);
		expect(h.reports[0]!.calls).toEqual({ spotify: 2 });
		const [result] = h.reports[0]!.results as Extract<CatalogWorkReportInput['results'][number], { kind: 'release' }>[];
		expect(result!.found.map((f) => [f.how, f.claim.providerId])).toEqual([['isrc', 'sp1']]);
	});
});

// The third review's defects (2026-11-27), each where it was found.
describe('a visit read more than once', () => {
	it('numbers its reports across runs, counts its releases across them, and does no job twice', async () => {
		const h = harness({ byIsrc: async () => null, byUpc: async () => null, byName: async () => [] });
		const v = h.engine.visit();
		const other = releaseJob({ id: 'release:55555555-5555-4555-8555-555555555555', objectId: '55555555-5555-4555-8555-555555555555', find: ['deezer'] });
		const go = (w: CatalogWork): Promise<void> => h.engine.run(w, { visit: v, signal: new AbortController().signal, onEvent: () => {} });
		await go(work([releaseJob({ find: ['deezer'] })]));
		// The page's next read hands the same job again and a new one.
		await go(work([releaseJob({ find: ['deezer'] }), other]));
		expect(h.reports.map((r) => r.idempotencyKey)).toEqual([`${v.id}:0`, `${v.id}:1`]);
		expect(h.reports[1]!.results.map((r) => r.jobId)).toEqual([other.id]);
		expect(h.engine.profile(v).visit).toEqual({ id: v.id, round: 0, taken: 2 });
	});

	it('runs one visit at a time: a second run waits for the first', async () => {
		const order: string[] = [];
		let open!: () => void;
		const gate = new Promise<void>((r) => (open = r));
		const h = harness({
			byIsrc: async (store) => {
				order.push(`start ${store}`);
				if (store === 'deezer') await gate;
				order.push(`end ${store}`);
				return null;
			},
			byUpc: async () => null,
			byName: async () => [],
		});
		const v = h.engine.visit();
		const go = (store: 'deezer' | 'spotify', id: string): Promise<void> =>
			h.engine.run(work([releaseJob({ id: `release:${id}`, objectId: id, find: [store], release: { title: 'L', artists: [], date: null, upcs: [], tracks: [HELD[0]!] } })]), { visit: v, signal: new AbortController().signal, onEvent: () => {} });
		const a = go('deezer', RELEASE_ID);
		const b = go('spotify', '55555555-5555-4555-8555-555555555555');
		await new Promise((r) => setTimeout(r, 5));
		open();
		await Promise.all([a, b]);
		expect(order).toEqual(['start deezer', 'end deezer', 'start spotify', 'end spotify']);
	});
});

describe('failures that are not the store failing', () => {
	const listingJob: CatalogJob = { id: `find:${ARTIST_ID}:spotify:sa1`, kind: 'find', objectId: ARTIST_ID, of: 'artist', name: 'Marsh', page: { provider: 'spotify', providerId: 'sa1', url: null, cursor: {} } };

	it('reports nothing of a store when the page is left in the middle of a call', async () => {
		const leave = new AbortController();
		const h = harness({
			listing: async () => {
				leave.abort();
				throw new Error('aborted');
			},
		});
		await h.run(work([listingJob]), leave.signal);
		expect(h.reports).toEqual([]);
		// And the store is not rested for it.
		expect(h.engine.profile().stores).toContain('spotify');
	});

	it("keeps the device's own trouble to itself: no network, or the host says so", async () => {
		const offline = harness({ listing: async () => Promise.reject(new TypeError('fetch failed')) });
		await offline.run(work([listingJob]));
		expect(offline.reports).toEqual([]);
		expect(offline.engine.profile().resting?.map((r) => r.store)).toEqual(['spotify']);

		const banned = harness({ listing: async () => Promise.reject(new Error('spotify gate: banned until 15:00')) }, { classify: () => ({ mine: true, restMs: 3_600_000 }) });
		await banned.run(work([listingJob]));
		expect(banned.reports).toEqual([]);
		expect(banned.engine.profile().stores).not.toContain('spotify');
	});

	it('rests a store that fails twice in a row for no reason it gives', async () => {
		let calls = 0;
		const h = harness({
			byIsrc: async () => {
				calls++;
				throw new Error('HTTP 502');
			},
			byUpc: async () => null,
			byName: async () => [],
		});
		const jobs = [0, 1, 2, 3].map((i) => releaseJob({ id: `release:5555555${i}-5555-4555-8555-555555555555`, objectId: `5555555${i}-5555-4555-8555-555555555555`, find: ['deezer'] }));
		await h.run(work(jobs));
		expect(calls).toBe(2);
		expect(h.reports.flatMap((r) => r.results).filter((r) => r.kind === 'error')).toHaveLength(2);
		expect(h.engine.profile().stores).not.toContain('deezer');
	});

	it('says a facts store failed, never that it had nothing, when its call fails (the real client)', async () => {
		const job: CatalogJob = { id: `facts:${RELEASE_ID}`, kind: 'facts', stores: ['beatport'], tracks: HELD.map((t) => ({ ...t, label: null })) };
		const h = harness({}, { beatportFetch: async () => new Response('busy', { status: 500 }) });
		await h.run(work([job]));
		const results = h.reports.flatMap((r) => r.results);
		expect(results.some((r) => r.kind === 'facts')).toBe(false);
		expect(results).toEqual([expect.objectContaining({ kind: 'error', store: 'beatport', rateLimitedSec: null })]);
	});
});

describe('the wire', () => {
	it('sends a listing longer than a poll may carry in parts, each but the last saying more is to come', async () => {
		const job: CatalogJob = { id: `find:${ARTIST_ID}:bandcamp:9`, kind: 'find', objectId: ARTIST_ID, of: 'label', name: 'Big', page: { provider: 'bandcamp', providerId: '9', url: null, cursor: { from: 'before' } } };
		const children = Array.from({ length: 600 }, (_, i) => releaseClaim('bandcamp', `b${i}`, [], `Title ${i}`));
		const h = harness({ listing: async () => ({ children, listingHash: 'h600', cursor: { from: 'after' }, calls: 1 }) });
		await h.run(work([job]));
		const polls = h.reports.map((r) => (r.results[0] as Extract<CatalogWorkReportInput['results'][number], { kind: 'find' }>).poll!);
		expect(polls.map((p) => [p.children.length, p.listingHash, p.cursor])).toEqual([
			[500, 'pending:h600', { from: 'before' }],
			[100, 'h600', { from: 'after' }],
		]);
		expect(new Set(h.reports.map((r) => r.idempotencyKey)).size).toBe(2);
	});

	it('tells the host what the cloud would not take', async () => {
		const h = harness({ byIsrc: async () => null, byUpc: async () => null, byName: async () => [] }, { answer: (input) => ({ results: input.results.map((r) => ({ jobId: r.jobId, outcome: 'refused' as const, note: 'no' })), changed: [] }) });
		await h.run(work([releaseJob({ find: ['deezer'] })]));
		expect(h.events.find((e) => e.type === 'refused')).toEqual({ type: 'refused', results: [{ jobId: `release:${RELEASE_ID}`, outcome: 'refused', note: 'no' }] });
	});

	it('says nothing of a store it had nothing to ask by', async () => {
		const h = harness({ byIsrc: async () => null, byUpc: async () => null, byName: async () => [] });
		await h.run(work([releaseJob({ find: ['deezer'], release: { title: 'L', artists: [], date: null, upcs: [], tracks: [track(T1, 'L', 300)] } })]));
		expect(h.reports).toEqual([]);
	});
});

describe('politeness', () => {
	it('reads a name search candidate only while none has confirmed', async () => {
		const loaded: string[] = [];
		const spotify = releaseClaim('spotify', 'sp1', [recording('spotify', 'st1', 'Lailonie', 300), recording('spotify', 'st2', 'Eu Topos', 410)]);
		const h = harness({
			byIsrc: async () => null,
			byUpc: async () => null,
			byName: async () => ['a', 'b', 'c'].map((id) => async () => (loaded.push(id), spotify)),
		});
		await h.run(work([releaseJob({ find: ['spotify'] })]));
		expect(loaded).toEqual(['a']);
	});

	it("reads a page's own Spotify releases twenty to a call, and a lookup's rungs that land on one album read it once", async () => {
		const urls: string[] = [];
		const album = (id: string) => ({ id, name: 'Lailonie', artists: [{ id: 'a', name: 'Marsh' }], tracks: { items: [{ id: `${id}-1`, name: 'Lailonie', duration_ms: 300_000, track_number: 1 }, { id: `${id}-2`, name: 'Eu Topos', duration_ms: 410_000, track_number: 2 }] } });
		const fetch = async (url: string): Promise<Response> => {
			urls.push(url);
			if (url.includes('/albums?ids=')) return Response.json({ albums: decodeURIComponent(url.split('ids=')[1]!).split(',').map(album) });
			if (url.includes('/search?type=track')) return Response.json({ tracks: { items: [{ album: { id: 'sp9' } }] } });
			return new Response('{}', { status: 404 });
		};
		const ids = ['66666661', '66666662', '66666663'].map((p) => `${p}-6666-4666-8666-666666666666`);
		const h = harness({}, { fetch });
		await h.run(work(ids.map((id, i) => releaseJob({ id: `release:${id}`, objectId: id, read: [{ provider: 'spotify', id: `own${i}`, url: null }] }))));
		expect(urls.filter((u) => u.includes('/albums?ids='))).toEqual(['https://api.spotify.com/v1/albums?ids=own0,own1,own2']);

		// Two ISRCs, one album: searched twice, read once — and refused once.
		urls.length = 0;
		const twice = harness({}, { fetch });
		const unlike = [track(T1, 'Nothing Alike', 100, 'GBKQU2600001'), track(T2, 'At All', 120, 'GBKQU2600002')];
		await twice.run(work([releaseJob({ find: ['spotify'], release: { title: 'X', artists: [], date: null, upcs: [], tracks: unlike } })]));
		expect(urls.filter((u) => u.includes('/albums?ids='))).toHaveLength(1);
	});
});
