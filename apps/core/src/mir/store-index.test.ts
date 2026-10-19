import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMirStore } from './store.js';
import { VectorIndex } from './vector-index.js';
import { MirScheduler } from './scheduler.js';
import type { MirLibraryPort } from './library-port.js';
import { mirError, type MirAnalyzeResult, type MirSidecar } from './sidecar.js';
import { DEFAULT_MIR_SETTINGS, type MirEvent, type MirSettings } from './types.js';

const vec = (xs: number[]): Buffer => Buffer.from(new Float32Array(xs).buffer);
const b64 = (xs: number[]): string => vec(xs).toString('base64');
const M = 'mert-v2-fullsong@1';

let dir: string;
let store: SqliteMirStore;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-mir-'));
	store = new SqliteMirStore(join(dir, 'mir.db'));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('SqliteMirStore', () => {
	it('stores track + segment vectors per run and reports coverage', () => {
		store.putResult('a', M, 'local', 1200, vec([1, 0]), [{ index: 0, startSec: 0, endSec: 30, label: 'intro', vec: vec([0, 1]) }]);
		store.putFailure('b', M, 'local', 'decode', 'bad file');
		expect(store.coverage()[M]).toEqual({ done: 1, failed: 1 });
		expect(Array.from(store.trackVector('a', M)!)).toEqual([1, 0]);
		expect(store.loadTrackMatrix(M).ids).toEqual(['a']); // segment rows never enter the track matrix
		expect(store.isSettled('a', M, 2)).toBe(true);
		expect(store.isSettled('b', M, 2)).toBe(false); // one failure: retry allowed
		store.putFailure('b', M, 'local', 'decode', 'bad file');
		expect(store.isSettled('b', M, 2)).toBe(true);
		store.clearFailures(['b'], M);
		expect(store.isSettled('b', M, 2)).toBe(false);
	});

	it('bumps the index version on every vector change', () => {
		const v0 = store.indexVersion();
		store.putResult('a', M, 'local', null, vec([1, 0]), []);
		const v1 = store.indexVersion();
		store.deleteTracks(['a']);
		expect(v1).toBeGreaterThan(v0);
		expect(store.indexVersion()).toBeGreaterThan(v1);
		expect(store.trackVector('a', M)).toBeNull();
	});

	it('merge carries over only the models the winner lacks', () => {
		store.putResult('keep', M, 'local', null, vec([1, 0]), []);
		store.putResult('drop', M, 'local', null, vec([0, 1]), []);
		store.putResult('drop', 'clap@1', 'local', null, vec([5, 5]), []);
		store.moveTrack('drop', 'keep');
		expect(Array.from(store.trackVector('keep', M)!)).toEqual([1, 0]);
		expect(Array.from(store.trackVector('keep', 'clap@1')!)).toEqual([5, 5]);
		expect(store.trackVector('drop', M)).toBeNull();
		expect(store.coverage()[M]).toEqual({ done: 1, failed: 0 });
	});

	it('sweeps rows of tracks the library no longer has', () => {
		store.putResult('live', M, 'local', null, vec([1, 0]), []);
		store.putResult('gone', M, 'local', null, vec([0, 1]), []);
		expect(store.pruneOrphans((id) => id === 'live')).toBe(1);
		expect(store.loadTrackMatrix(M).ids).toEqual(['live']);
	});
});

describe('VectorIndex', () => {
	const index = new VectorIndex({
		ids: ['a', 'b', 'c', 'd'], dim: 2,
		data: new Float32Array([1, 0, 0.9, 0.1, 0, 1, -1, 0]),
	});
	it('ranks by cosine, excluding and restricting as asked', () => {
		const q = index.centroid(['a'])!;
		expect(index.topK(q, 3).map((r) => r.id)).toEqual(['a', 'b', 'c']);
		expect(index.topK(q, 2, null, new Set(['a'])).map((r) => r.id)).toEqual(['b', 'c']);
		expect(index.topK(q, 5, new Set(['c', 'd'])).map((r) => r.id)).toEqual(['c', 'd']);
		expect(index.topK(q, 1)[0]!.score).toBeCloseTo(1, 6);
	});
	it('centroid of several seeds; null when no seed has a vector', () => {
		const c = index.centroid(['a', 'c', 'missing'], 'raw')!;
		expect(c[0]).toBeCloseTo(Math.SQRT1_2, 6);
		expect(index.centroid(['missing'])).toBeNull();
	});
	it('centring removes the direction every vector shares', () => {
		// All rows sit near [10, 10]; raw cosine calls them all ~identical,
		// the centred space still sees x-ish vs y-ish.
		const idx = new VectorIndex({ ids: ['x1', 'x2', 'y1', 'y2'], dim: 2,
			data: new Float32Array([11, 10, 10.9, 10, 10, 11, 10, 10.9]) });
		expect(idx.topK(idx.centroid(['x1'], 'raw')!, 3, null, new Set(['x1']), 'raw')[0]!.score).toBeGreaterThan(0.99);
		const centred = idx.topK(idx.centroid(['x1'])!, 3, null, new Set(['x1']));
		expect(centred[0]!.id).toBe('x2');
		expect(centred[2]!.score).toBeLessThan(0);
	});
});

describe('MirScheduler', () => {
	function setup(behave: (trackId: string) => MirAnalyzeResult | Error, settings: Partial<MirSettings> = {}) {
		const files: Record<string, string> = {};
		for (const id of ['t1', 't2', 't3']) { files[id] = join(dir, `${id}.flac`); writeFileSync(files[id]!, 'x'); }
		const library: MirLibraryPort = {
			playableTrackIds: () => ['t1', 't2', 't3'],
			trackFile: (id) => files[id] ?? null,
			trackSegments: () => [],
			isLive: (id) => id in files,
		};
		const calls: string[] = [];
		const sidecar = {
			ready: true,
			analyze: async (p: { trackId: string }) => {
				calls.push(p.trackId);
				const r = behave(p.trackId);
				if (r instanceof Error) throw r;
				return r;
			},
		} as unknown as MirSidecar;
		const events: MirEvent[] = [];
		const s: MirSettings = { ...DEFAULT_MIR_SETTINGS, enabled: true, ...settings };
		const sched = new MirScheduler({
			store, sidecar, library, settings: () => s, modelId: (k) => (k === 'mert-v2-fullsong' ? M : null),
			onChange: () => {}, onEvent: (e) => events.push(e),
		});
		const drain = async () => { sched.kick(); for (let i = 0; i < 50 && (sched as any).active; i++) await new Promise((r) => setTimeout(r, 5)); };
		return { sched, calls, events, drain, files };
	}
	const ok = (trackId: string): MirAnalyzeResult => ({
		trackId, duration: 300, sourceSampleRate: 44100, decodeMs: 1,
		embeddings: { [M]: { model: 'mert-v2-fullsong', version: 1, dim: 2, vec: b64([1, 2]), segments: [], loadMs: 0, ms: 5 } },
	});

	it('derives the backlog, embeds every playable track once, then idles', async () => {
		const { sched, calls, drain } = setup(ok);
		expect(sched.pendingCount()).toBe(3);
		await drain();
		expect(calls).toEqual(['t1', 't2', 't3']);
		expect(store.coverage()[M]).toEqual({ done: 3, failed: 0 });
		sched.invalidate();
		expect(sched.pendingCount()).toBe(0);
	});

	it('records per-track failures and moves on; retries once, then leaves the track settled', async () => {
		const { calls, drain, sched } = setup((id) => (id === 't2' ? mirError('decode', 'corrupt') : ok(id)));
		await drain();
		expect(calls).toEqual(['t1', 't2', 't3']);
		sched.invalidate();
		await drain(); // second attempt for t2
		sched.invalidate();
		await drain(); // settled after MAX_ATTEMPTS: not tried again
		expect(calls.filter((c) => c === 't2')).toHaveLength(2);
	});

	it('an engine-level model error blocks the lane instead of failing every track', async () => {
		const { calls, drain, sched } = setup(() => mirError('model', 'weights missing'));
		await drain();
		expect(calls).toEqual(['t1']);
		expect(sched.blocked).toBe('weights missing');
		expect(store.coverage()[M]).toBeUndefined();
	});

	it('requests made before the engine reports its models wait instead of being dropped', async () => {
		const { calls, sched } = setup(ok, { enabled: false });
		let known = false;
		(sched as any).d.modelId = (k: string) => (known && k === 'mert-v2-fullsong' ? M : null);
		sched.analyzeNow(['t1', 't2']);
		for (let i = 0; i < 20 && (sched as any).active; i++) await new Promise((r) => setTimeout(r, 5));
		expect(calls).toEqual([]);
		known = true; // capabilities landed
		sched.kick();
		for (let i = 0; i < 50 && (sched as any).active; i++) await new Promise((r) => setTimeout(r, 5));
		expect(calls).toEqual(['t1', 't2']);
	});

	it('analyzeNow runs even with background embedding off, and a missing file is a failure not a crash', async () => {
		const { calls, drain, sched, files } = setup(ok, { enabled: false });
		rmSync(files['t3']!);
		expect(sched.pendingCount()).toBe(0);
		sched.analyzeNow(['t2', 't3']);
		await drain();
		expect(calls).toEqual(['t2']);
		expect(store.coverage()[M]).toEqual({ done: 1, failed: 1 });
	});
});
