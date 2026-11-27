// The page work (work.ts): the host of the reading engine for the entity page
// in front. No database and no network: the catalogue, the pages, the stores
// and the lookups are stand-ins; the engine is the real one.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim, CatalogJob, CatalogPageRelease, CatalogPageTrack, CatalogTracker, CatalogTracksResult, CatalogWork, CatalogWorkReportInput, CatalogWorkReportResult } from '@curator/protocol';
import type { WorkReaders } from '@curator/catalog-work';
import type { EntityHeader, EntityRef, EntityWorkEvent } from '@curator/shared';
import type { Enricher, EnricherOutput } from '@curator/sync-core/enrich/contract';
import type { StreamingCatalog } from './streaming.js';
import { createEntityWork, type EntityWorkDeps } from './work.js';

const ALL: CatalogTracker[] = ['artist/spotify', 'label/beatport', 'label/bandcamp'];
const CAT = '11111111-1111-4111-8111-111111111111';
const REL = '22222222-2222-4222-8222-222222222222';
const T1 = '33333333-3333-4333-8333-333333333333';
const T2 = '44444444-4444-4444-8444-444444444444';

function header(ref: EntityRef, over: Partial<EntityHeader> & { reason?: EntityHeader['world']['reason'] } = {}): EntityHeader {
	const reason = over.reason ?? 'ok';
	return {
		ref,
		imageUrl: null,
		coverTrackId: null,
		facts: {},
		genres: [],
		labels: [],
		artists: [],
		similar: [],
		collabs: [],
		activity: null,
		badges: [],
		reach: null,
		links: [],
		follow: null,
		owned: { count: 0, filter: null },
		world: { available: reason === 'ok', reason, releaseCount: null, trackCount: null },
		...over,
	};
}

const pageTrack = (id: string, title: string, over: Partial<CatalogPageTrack> = {}): CatalogPageTrack => ({ id, title, position: 1, disc: null, durationSec: 300, isrc: null, bpm: null, key: null, genres: [], artists: [{ id: 'a1', name: 'Northfold' }], handles: [], ...over });
const pageRelease = (id: string, title: string, tracks: CatalogPageTrack[], over: Partial<CatalogPageRelease> = {}): CatalogPageRelease => ({
	id, title, date: '2026-01-02', type: 'single', coverUrl: null, labelText: null, labels: [], artists: [{ id: 'a1', name: 'Northfold' }], genres: [], handles: [], trackCount: tracks.length, appearance: false, tracks, ...over,
});
const page = (releases: CatalogPageRelease[]): CatalogTracksResult => ({ object: { id: CAT, kind: 'artist', name: 'Northfold' }, redirectedFrom: null, releases, nextCursor: null });
const work = (jobs: CatalogJob[]): CatalogWork => ({ jobs, limits: { rounds: 3, releases: 100 } });
const recording = (provider: CatalogClaim['provider'], id: string, name: string, o: { bpm?: number; key?: string; genre?: string; sec?: number } = {}): CatalogClaim => ({
	provider, kind: 'recording', providerId: id, name, facts: { durationSec: o.sec ?? 300, ...(o.bpm ? { bpm: o.bpm } : {}), ...(o.key ? { key: o.key } : {}) }, ...(o.genre ? { genres: [o.genre] } : {}),
});

const ARTIST: EntityRef = { kind: 'artist', name: 'Northfold', catalogId: CAT };

function harness(over: {
	header?: EntityHeader | (() => EntityHeader);
	readers?: Partial<WorkReaders>;
	enrichers?: Enricher[];
	trackers?: CatalogTracker[];
	offers?: boolean;
	banUntil?: number;
	loaded?: CatalogTracksResult[];
	streaming?: StreamingCatalog;
	made?: (c: CatalogClaim) => boolean;
	answer?: (input: Omit<CatalogWorkReportInput, 'deviceId'>) => CatalogWorkReportResult;
} = {}) {
	const reports: Omit<CatalogWorkReportInput, 'deviceId'>[] = [];
	const registered: CatalogClaim[][] = [];
	const labels: string[][] = [];
	const dropped: (string | null)[] = [];
	const events: EntityWorkEvent[] = [];
	const deps: EntityWorkDeps = {
		catalog: () => ({
			status: () => ({ available: true, reason: 'ok' as const }),
			offersWork: () => over.offers ?? true,
			register: async (claims: CatalogClaim[]) => {
				registered.push(claims);
				const made = claims.map((c) => over.made?.(c) ?? true);
				return { created: made.filter(Boolean).length, attached: 0, made };
			},
			enrichLabels: async (names: string[]) => {
				labels.push(names);
				return { labels: names.length, registered: names.length, queued: 0 };
			},
			workReport: async (input) => {
				reports.push(input);
				return over.answer?.(input) ?? { results: input.results.map((r) => ({ jobId: r.jobId, outcome: 'saved' as const })), changed: [CAT] };
			},
		}),
		pages: {
			page: async (ref) => (typeof over.header === 'function' ? over.header() : over.header ?? header(ref)),
			loaded: async () => over.loaded ?? [],
			drop: (id) => void dropped.push(id),
		},
		trackers: () => over.trackers ?? ALL,
		spotifyToken: async () => 'token',
		spotifyBackoffUntil: () => over.banUntil ?? 0,
		...(over.streaming ? { streaming: () => over.streaming! } : {}),
		enrichers: over.enrichers ?? [],
		fetch: () => Promise.reject(new Error('no network in tests')),
		spotifyFetch: () => Promise.reject(new Error('no network in tests')),
		beatportFetch: () => Promise.reject(new Error('no network in tests')),
		engine: { sleep: async () => {}, gaps: { spotify: 0, deezer: 0, beatport: 0, bandcamp: 0, traxsource: 0 }, readers: { byIsrc: async () => null, byUpc: async () => null, byName: async () => [], ...over.readers } },
	};
	const w = createEntityWork(deps);
	w.subscribe((e) => events.push(e));
	return { w, reports, registered, labels, dropped, events };
}

// Until the page work is at rest: no phase, nothing left to settle.
const settled = async (events: EntityWorkEvent[], until: (e: EntityWorkEvent[]) => boolean = () => true): Promise<void> => {
	for (let i = 0; i < 200; i++) {
		await new Promise((r) => setTimeout(r, 5));
		const last = events.at(-1);
		if (last && last.status.phase === null && until(events)) return;
	}
	throw new Error('the page work did not settle');
};

describe('the profile a read carries', () => {
	it("is the visit's for the page in front, and nobody's for another page, a page left, or a server that hands out no work", () => {
		const { w } = harness();
		expect(w.profile(CAT)).toBeNull();
		w.watch(ARTIST, 1);
		expect(w.profile(CAT)).toMatchObject({ form: 'desktop', stores: ['spotify', 'beatport', 'bandcamp', 'traxsource'], visit: { round: 0, taken: 0 } });
		expect(w.profile('99999999-9999-4999-8999-999999999999')).toBeNull();
		w.watch(null, 2);
		expect(w.profile(CAT)).toBeNull();
		const off = harness({ offers: false });
		off.w.watch(ARTIST, 1);
		expect(off.w.profile(CAT)).toBeNull();
	});

	it('says nothing of Spotify during its quota ban, and nothing of a source the user unchecked', () => {
		const { w } = harness({ banUntil: Date.now() + 3_600_000, trackers: ['artist/spotify'] });
		w.watch(ARTIST, 1);
		expect(w.profile(CAT)!.stores).toEqual(['traxsource']);
	});
});

describe('the work a read carried', () => {
	it("is done and reported under the page's visit; rows show as found, Beatport's genre over the row's own and another store's only where it has none", async () => {
		const bp = { provider: 'beatport' as const, kind: 'release' as const, providerId: 'bp1', name: 'Hollow', recordings: [recording('beatport', 'b1', 'Hollow', { bpm: 122, key: 'A Minor', genre: 'Melodic House & Techno' }), recording('beatport', 'b2', 'Vessel', { bpm: 124, sec: 410 })] };
		const { w, reports, events } = harness({ readers: { release: async () => bp } });
		w.watch(ARTIST, 7);
		const v = w.profile(CAT)!.visit!;
		const rows = [pageTrack(T1, 'Hollow', { genres: ['Deep House'] }), pageTrack(T2, 'Vessel', { durationSec: 410 })];
		const job: CatalogJob = { id: `release:${REL}`, kind: 'release', objectId: REL, release: { title: 'Hollow', artists: ['Northfold'], date: null, upcs: [], tracks: rows.map((t) => ({ id: t.id, title: t.title, artists: ['Northfold'], durationSec: t.durationSec, isrc: null, position: 1 })) }, read: [{ provider: 'beatport', id: 'bp1', url: null }], find: [], check: [] };
		w.read(CAT, page([pageRelease(REL, 'Hollow', rows)]), work([job]), [{ provider: 'spotify', kind: 'artist', providerId: 'sa1' }]);
		await settled(events, (e) => e.some((x) => x.changed));
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({ profile: { visit: { id: v.id } }, hints: [{ provider: 'spotify', kind: 'artist', providerId: 'sa1' }] });
		expect(w.patchOf(T1)).toEqual({ recordingId: T1, bpm: 122, keyCamelot: '8A', genre: 'Melodic House & Techno' });
		expect(w.patchOf(T2)).toEqual({ recordingId: T2, bpm: 124 });
		expect(events.every((e) => e.watch === 7)).toBe(true);
	});

	it('reads the page again once the catalogue kept a burst of reports — one reload, when the work goes quiet', async () => {
		const jobs: CatalogJob[] = [0, 1, 2].map((i) => ({ id: `release:5555555${i}-5555-4555-8555-555555555555`, kind: 'release', objectId: `5555555${i}-5555-4555-8555-555555555555`, release: { title: 'X', artists: ['Northfold'], date: null, upcs: [], tracks: [{ id: T1, title: 'X', artists: ['Northfold'], durationSec: 300, isrc: null, position: 1 }] }, read: [], find: ['spotify'], check: [] }));
		const { w, dropped, events } = harness();
		w.watch(ARTIST, 1);
		w.read(CAT, page([]), work(jobs), []);
		await settled(events, (e) => e.some((x) => x.changed));
		expect(events.filter((e) => e.changed === 'tracks')).toHaveLength(1);
		expect(dropped).toEqual([CAT]);
	});

	it('is dropped for a page that is not the one in front, and stops when the page is left', async () => {
		let reads = 0;
		const leaveOn = { at: 1 };
		const { w, reports, events } = harness({
			readers: {
				release: async () => {
					reads++;
					if (reads === leaveOn.at) w.watch(null, 2);
					return null;
				},
			},
		});
		w.watch(ARTIST, 1);
		w.read('99999999-9999-4999-8999-999999999999', page([]), work([{ id: `release:${REL}`, kind: 'release', objectId: REL, release: { title: 'H', artists: [], date: null, upcs: [], tracks: [] }, read: [{ provider: 'beatport', id: 'bp1', url: null }], find: [], check: [] }]), []);
		await new Promise((r) => setTimeout(r, 20));
		expect(reads).toBe(0);
		const two = [REL, '66666666-6666-4666-8666-666666666666'].map((id): CatalogJob => ({ id: `release:${id}`, kind: 'release', objectId: id, release: { title: 'H', artists: [], date: null, upcs: [], tracks: [] }, read: [{ provider: 'beatport', id: `bp-${id}`, url: null }], find: [], check: [] }));
		w.read(CAT, page([]), work(two), []);
		await new Promise((r) => setTimeout(r, 50));
		// Left during the first read: the second is not read, and nothing the cut call said goes up.
		expect(reads).toBe(1);
		expect(reports).toEqual([]);
		expect(events.some((e) => e.watch === 2)).toBe(false);
	});
});

describe('an entity the catalogue does not know', () => {
	const stream = (releases: CatalogClaim[]): StreamingCatalog =>
		({ service: 'spotify', listing: async () => ({ releases }), releases: async (ids: readonly string[]) => new Map(ids.map((id) => [id, { ...releases.find((r) => r.providerId === id)!, recordings: [recording('spotify', `${id}-1`, 'One')] }])) }) as unknown as StreamingCatalog;

	it('is registered as the streaming service showed it, once a session, and the page is read again', async () => {
		const ref: EntityRef = { kind: 'artist', name: 'Northfold', spotifyId: 'sa1' };
		let known = false;
		const { w, registered, events } = harness({
			header: () => (known ? header({ ...ref, catalogId: CAT }) : header(ref, { reason: 'unknown', links: [{ source: 'spotify', sourceId: 'sa1', url: null }] })),
			streaming: stream([{ provider: 'spotify', kind: 'release', providerId: 'sr1', name: 'Hollow' }]),
			made: (c) => (known = true) && c.kind === 'release',
		});
		w.watch(ref, 1);
		await settled(events, (e) => e.some((x) => x.changed === 'header'));
		expect(registered).toHaveLength(1);
		expect(registered[0]!.map((c) => [c.kind, c.providerId, c.recordings?.length ?? 0])).toEqual([['artist', 'sa1', 0], ['release', 'sr1', 1]]);
		expect(events.at(-1)!.status.added).toBe(1);
		expect(w.profile(CAT)).not.toBeNull();
		known = false;
		w.watch(null, 2);
		w.watch(ref, 3);
		await new Promise((r) => setTimeout(r, 20));
		expect(registered).toHaveLength(1);
	});

	it('is handed to the catalogue by name when it is a label — not when the name is a distributor', async () => {
		const label = (name: string): EntityRef => ({ kind: 'label', name });
		const one = harness({ header: () => header(label('Northfold Records'), { reason: 'unknown' }) });
		one.w.watch(label('Northfold Records'), 1);
		await settled(one.events, (e) => e.some((x) => x.changed === 'header'));
		expect(one.labels).toEqual([['Northfold Records']]);
		const dist = harness({ header: () => header(label('Believe'), { reason: 'unknown' }) });
		dist.w.watch(label('Believe'), 1);
		await new Promise((r) => setTimeout(r, 20));
		expect(dist.labels).toEqual([]);
	});
});

describe('rows looked up by hand', () => {
	const bpHit = (o: { genre?: string; bpm?: number } = {}): EnricherOutput => ({
		kind: 'metadata',
		patch: { bpm: o.bpm ?? 122, keyCamelot: '8A', genre: o.genre ?? 'Melodic House & Techno' },
		sourceLink: { source: 'beatport', sourceTrackId: 'b1', url: 'https://www.beatport.com/track/hollow/1', title: 'Hollow', duration: 300, bpm: o.bpm ?? 122, key: 'A Minor', artists: ['Northfold'] },
	});
	const enricher = (id: string, answer: () => Promise<EnricherOutput | null>, blockedUntil: () => number | null = () => null): Enricher => ({ id, produces: 'metadata', applicableTo: () => !blockedUntil(), enrich: answer, blockedUntil });

	it("are asked of the feed's own lookups, once more for rows already tried, and say how many were found", async () => {
		let asked = 0;
		const rows = [pageTrack(T1, 'Hollow'), pageTrack(T2, 'Vessel')];
		const { w, reports } = harness({
			loaded: [page([pageRelease(REL, 'Hollow', rows)])],
			enrichers: [enricher('beatport', async () => (++asked, asked === 1 ? bpHit() : null)), enricher('traxsource', async () => null)],
		});
		w.watch(ARTIST, 1);
		w.read(CAT, page([pageRelease(REL, 'Hollow', rows)]), undefined, []);
		expect(await w.enrich([T1, T2])).toEqual({ asked: 2, found: 1 });
		const facts = reports.flatMap((r) => r.results).find((r) => r.kind === 'facts') as Extract<CatalogWorkReportInput['results'][number], { kind: 'facts' }>;
		expect(facts.rows.map((r) => [r.recordingId, r.claim.providerId, r.claim.url])).toEqual([[T1, 'b1', 'https://www.beatport.com/track/hollow/1']]);
		// Their calls count against the day: the lookups do not go through the engine's fetch.
		expect(reports.some((r) => (r.calls?.beatport ?? 0) > 0)).toBe(true);
		// Asked again by hand: looked up again.
		await w.enrich([T1]);
		expect(asked).toBe(3);
	});

	it('say a store turned the lookup away, never that it had nothing', async () => {
		const until = Date.now() + 600_000;
		let block = false;
		const { w, reports } = harness({
			loaded: [page([pageRelease(REL, 'Hollow', [pageTrack(T1, 'Hollow')])])],
			trackers: ['label/beatport'],
			enrichers: [enricher('beatport', async () => ((block = true), null), () => (block ? until : null)), enricher('traxsource', async () => null)],
		});
		w.watch(ARTIST, 1);
		await w.enrich([T1]);
		const results = reports.flatMap((r) => r.results);
		expect(results.find((r) => r.kind === 'error')).toMatchObject({ store: 'beatport', rateLimitedSec: expect.any(Number) });
		expect(results.some((r) => r.kind === 'facts' && r.notFound.some((n) => n.store === 'beatport'))).toBe(false);
		expect(w.profile(CAT)!.stores).not.toContain('beatport');
	});
});
