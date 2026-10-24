// analysisStore after a reconnect (refreshCurrentAfterReconnect): the
// playing track's spent once-per-session ask is asked again when the player
// shows no waveform or only the lo stand-in, never when it shows hi, and its
// analysis is reloaded either way. The player and the logger are mocked;
// `fetch` serves curator-peaks:// from an in-memory map the way main's
// handler does (hi → lo fallback, X-Peaks-Tier).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ playerCb: null as ((s: { current: { trackId: string } | null }) => void) | null }));

vi.mock('../player.js', () => ({
	subscribe: (cb: (s: { current: { trackId: string } | null }) => void) => { h.playerCb = cb; return () => { /* test */ }; },
}));
vi.mock('../data/log.js', () => {
	const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
	return { log: { for: () => quiet } };
});

// A v1 mono .cpk whose sample rate tells the tiers apart.
function cpk(samplesPerSec: number, n = 4): Uint8Array {
	const buf = new Uint8Array(20 + n * 3);
	buf.set([...'CURPEAKS'].map((c) => c.charCodeAt(0)), 0);
	const dv = new DataView(buf.buffer);
	dv.setUint8(8, 1);
	dv.setUint8(9, 3);
	dv.setUint16(10, samplesPerSec, true);
	dv.setUint32(12, n, true);
	return buf;
}

type Files = Map<string, { lo?: Uint8Array; hi?: Uint8Array }>;
let files: Files;
let fetchPeaks: ReturnType<typeof vi.fn>;
let analysisGet: ReturnType<typeof vi.fn>;
let store: typeof import('./analysisStore.js');

beforeEach(async () => {
	files = new Map();
	fetchPeaks = vi.fn(async () => null);
	analysisGet = vi.fn(async () => null);
	vi.stubGlobal('window', { api: { 'analysis:get': analysisGet, 'analysis:cues': async () => [], 'analysis:fetch-peaks': fetchPeaks } });
	vi.stubGlobal('fetch', async (url: string) => {
		const m = /^curator-peaks:\/\/([^/]+)\/(lo|hi)$/.exec(url)!;
		const f = files.get(decodeURIComponent(m[1]!));
		const hi = m[2] === 'hi' ? f?.hi : undefined;
		const body = hi ?? f?.lo;
		if (!body) return new Response('no peaks for track', { status: 404 });
		return new Response(body as unknown as BodyInit, { headers: { 'X-Peaks-Source': 'essentia', 'X-Peaks-Tier': hi ? 'hi' : 'lo' } });
	});
	vi.resetModules();
	store = await import('./analysisStore.js');
});

afterEach(() => {
	vi.unstubAllGlobals();
});

const play = (trackId: string): void => h.playerCb!({ current: { trackId } });
const sps = (): number | null => store.getCurrentPeaks()?.tier.samplesPerSec ?? null;

describe('refreshCurrentAfterReconnect', () => {
	it('no waveform: the spent ask goes out again, and what it fetched shows', async () => {
		play('t1');
		await vi.waitFor(() => expect(fetchPeaks).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(analysisGet).toHaveBeenCalledTimes(1));
		expect(sps()).toBeNull();
		// Back online, the account answers this time.
		fetchPeaks.mockImplementation(async (id: string) => { files.set(id, { hi: cpk(100) }); return 'hi'; });
		await store.refreshCurrentAfterReconnect();
		await vi.waitFor(() => expect(sps()).toBe(100));
		expect(fetchPeaks).toHaveBeenCalledTimes(2);
		expect(analysisGet).toHaveBeenCalledTimes(2);
	});

	it('the lo stand-in: asks for hi, and swaps it in when it came', async () => {
		files.set('t1', { lo: cpk(10) });
		play('t1');
		await vi.waitFor(() => expect(sps()).toBe(10));
		// A lo-served hi request is answered: no ask at load.
		expect(fetchPeaks).not.toHaveBeenCalled();
		fetchPeaks.mockImplementation(async () => { files.set('t1', { lo: cpk(10), hi: cpk(100) }); return 'hi'; });
		await store.refreshCurrentAfterReconnect();
		await vi.waitFor(() => expect(sps()).toBe(100));
		expect(fetchPeaks).toHaveBeenCalledTimes(1);
	});

	it('the lo stand-in when the account still has only lo: keeps it', async () => {
		files.set('t1', { lo: cpk(10) });
		play('t1');
		await vi.waitFor(() => expect(sps()).toBe(10));
		fetchPeaks.mockImplementation(async () => 'lo');
		await store.refreshCurrentAfterReconnect();
		expect(fetchPeaks).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(analysisGet).toHaveBeenCalledTimes(2));
		expect(sps()).toBe(10);
	});

	it('hi already showing: nothing is asked; the analysis reloads', async () => {
		files.set('t1', { hi: cpk(100) });
		play('t1');
		await vi.waitFor(() => expect(sps()).toBe(100));
		await vi.waitFor(() => expect(analysisGet).toHaveBeenCalledTimes(1));
		await store.refreshCurrentAfterReconnect();
		await vi.waitFor(() => expect(analysisGet).toHaveBeenCalledTimes(2));
		expect(fetchPeaks).not.toHaveBeenCalled();
		expect(sps()).toBe(100);
	});

	it('nothing playing: nothing happens', async () => {
		await store.refreshCurrentAfterReconnect();
		expect(fetchPeaks).not.toHaveBeenCalled();
		expect(analysisGet).not.toHaveBeenCalled();
	});
});
