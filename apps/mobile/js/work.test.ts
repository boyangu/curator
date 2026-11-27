// The phone's store reading (work.ts) and its fetch seam (shim/store-fetch.ts)
// under Node: the engine is the real one, Kotlin and the cloud are stand-ins.

import { describe, expect, it } from 'vitest';
import type { CatalogJob, CatalogWork, CatalogWorkReportInput } from '@curator/protocol';
import type { WorkReaders } from '@curator/catalog-work';
import { CoreAbortController, createStoreFetch } from './shim/store-fetch.js';
import { createPhoneWork, type PhoneWorkEvent } from './work.js';

const CAT = '11111111-1111-4111-8111-111111111111';
const REL = '22222222-2222-4222-8222-222222222222';
const T1 = '33333333-3333-4333-8333-333333333333';

const work = (jobs: CatalogJob[]): CatalogWork => ({ jobs, limits: { rounds: 3, releases: 20 } });
const page = (genres: string[] = []) => ({ releases: [{ id: REL, tracks: [{ id: T1, genres }] }] }) as never;

function harness(over: { token?: () => Promise<string | null>; offered?: boolean; readers?: Partial<WorkReaders> } = {}) {
	const events: PhoneWorkEvent[] = [];
	const reports: Omit<CatalogWorkReportInput, 'deviceId'>[] = [];
	const w = createPhoneWork({
		emit: (e) => events.push(e),
		offered: () => over.offered ?? true,
		report: async (input) => {
			reports.push(input);
			return { results: input.results.map((r) => ({ jobId: r.jobId, outcome: 'saved' as const })), changed: [CAT] };
		},
		spotifyToken: over.token ?? (async () => 'token'),
		fetch: () => () => Promise.reject(new Error('no network in tests')),
		engine: { sleep: async () => {}, gaps: { spotify: 0, deezer: 0, beatport: 0, bandcamp: 0, traxsource: 0 }, readers: { byIsrc: async () => null, byUpc: async () => null, byName: async () => [], ...over.readers } },
	});
	return { w, events, reports };
}

const settled = async (events: PhoneWorkEvent[], until: (e: PhoneWorkEvent[]) => boolean): Promise<void> => {
	for (let i = 0; i < 200; i++) {
		await new Promise((r) => setTimeout(r, 5));
		if (events.at(-1)?.status.phase === null && until(events)) return;
	}
	throw new Error('the page work did not settle');
};

describe('what the phone says it can read', () => {
	it("is a phone's profile for the page in front only: Spotify, Deezer, Bandcamp — Beatport when Kotlin's reader is there, never Traxsource", () => {
		const { w } = harness();
		expect(w.profile(CAT)).toBeNull();
		w.watch(CAT, 1);
		expect(w.profile(CAT)).toMatchObject({ form: 'phone', stores: ['spotify', 'deezer', 'bandcamp'], visit: { round: 0, taken: 0 } });
		w.settings({ enabled: true, beatport: true });
		expect(w.profile(CAT)!.stores).toEqual(['spotify', 'deezer', 'beatport', 'bandcamp']);
		expect(w.profile('99999999-9999-4999-8999-999999999999')).toBeNull();
		// Switched off in Settings, or a server that hands out no work: nothing asked.
		w.settings({ enabled: false, beatport: true });
		expect(w.profile(CAT)).toBeNull();
		const off = harness({ offered: false });
		off.w.watch(CAT, 1);
		expect(off.w.profile(CAT)).toBeNull();
	});

	it('leaves Spotify out once the cloud said the account has no token to read with', async () => {
		const { w } = harness({ token: async () => null });
		w.watch(CAT, 1);
		await w.ready();
		expect(w.profile(CAT)!.stores).toEqual(['deezer', 'bandcamp']);
	});
});

describe('the work a page read carried', () => {
	const job: CatalogJob = { id: `release:${REL}`, kind: 'release', objectId: REL, release: { title: 'Hollow', artists: ['Northfold'], date: null, upcs: [], tracks: [{ id: T1, title: 'Hollow', artists: ['Northfold'], durationSec: 300, isrc: null, position: 1 }] }, read: [{ provider: 'beatport', id: 'bp1', url: null }], find: [], check: [] };
	const bp = { provider: 'beatport' as const, kind: 'release' as const, providerId: 'bp1', name: 'Hollow', recordings: [{ provider: 'beatport' as const, kind: 'recording' as const, providerId: 'b1', name: 'Hollow', facts: { durationSec: 300, bpm: 122, key: 'A Minor' }, genres: ['Melodic House & Techno'] }] };

	it('is done and reported; Kotlin is told the rows as found and, once, to read the page again', async () => {
		const { w, events, reports } = harness({ readers: { release: async () => bp } });
		w.settings({ enabled: true, beatport: true });
		w.watch(CAT, 7);
		w.read(CAT, page(['Deep House']), work([job]));
		await settled(events, (e) => e.some((x) => x.changed));
		expect(reports).toHaveLength(1);
		expect(reports[0]!.profile).toMatchObject({ form: 'phone' });
		const rows = events.flatMap((e) => e.rows ?? []);
		// Beatport's genre stands over the row's own.
		expect(rows).toEqual([{ recordingId: T1, bpm: 122, keyCamelot: '8A', genre: 'Melodic House & Techno' }]);
		expect(w.patchOf(T1)).toMatchObject({ bpm: 122 });
		expect(events.filter((e) => e.changed)).toHaveLength(1);
		expect(events.every((e) => e.watch === 7)).toBe(true);
	});

	it('stops when the page is left, and says nothing more', async () => {
		let reads = 0;
		const { w, events, reports } = harness({
			readers: {
				release: async () => {
					reads++;
					w.watch(null, 0);
					return null;
				},
			},
		});
		w.settings({ enabled: true, beatport: true });
		w.watch(CAT, 1);
		const second: CatalogJob = { ...job, id: 'release:44444444-4444-4444-8444-444444444444', objectId: '44444444-4444-4444-8444-444444444444' } as CatalogJob;
		w.read(CAT, page(), work([job, second]));
		await new Promise((r) => setTimeout(r, 50));
		expect(reads).toBe(1);
		expect(reports).toEqual([]);
		const before = events.length;
		await new Promise((r) => setTimeout(r, 20));
		expect(events.length).toBe(before);
	});
});

describe('the fetch seam', () => {
	it('asks Kotlin and answers as a Response: status, headers by any case, text and json', async () => {
		const sent: Record<string, unknown>[] = [];
		const f = createStoreFetch((e) => sent.push(e));
		const p = f.via('http')('https://api.deezer.com/album/1', { headers: { accept: 'application/json' } });
		expect(sent).toEqual([{ type: 'fetch', id: 1, via: 'http', method: 'GET', url: 'https://api.deezer.com/album/1', headers: { accept: 'application/json' }, body: null }]);
		f.done({ id: 1, status: 429, headers: { 'Retry-After': '120' }, body: '{"error":true}', error: null });
		const res = await p;
		expect([res.ok, res.status, res.headers.get('retry-after'), res.headers.get('x-none')]).toEqual([false, 429, '120', null]);
		expect(await res.json()).toEqual({ error: true });
	});

	it("tells Kotlin a call was given up, and reads the phone's own trouble apart from the store's", async () => {
		const sent: Record<string, unknown>[] = [];
		const f = createStoreFetch((e) => sent.push(e));
		const ctl = new CoreAbortController();
		const gone = f.via('beatport')('https://www.beatport.com/release/x/1', { signal: ctl.signal as unknown as AbortSignal });
		ctl.abort();
		await expect(gone).rejects.toMatchObject({ name: 'AbortError' });
		expect(sent.at(-1)).toEqual({ type: 'fetchAbort', id: 1 });
		// A late answer for it finds nobody.
		f.done({ id: 1, status: 200, headers: {}, body: '', error: null });

		const offline = f.via('http')('https://api.deezer.com/x');
		f.done({ id: 2, status: 0, headers: {}, body: null, error: 'Unable to resolve host' });
		await expect(offline).rejects.toBeInstanceOf(TypeError);
		const noWindow = f.via('beatport')('https://www.beatport.com/x');
		f.done({ id: 3, status: 0, headers: {}, body: null, error: 'device: no window to read in' });
		await expect(noWindow).rejects.toMatchObject({ name: 'WorkDeviceNotReadyError', message: 'no window to read in' });
	});
});
