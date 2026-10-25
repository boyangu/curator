// Pull-before-compute in the analyzer queue (queue.ts dispatchOne →
// layer.ts prepare): a background job asks the catalogue first and runs
// only what is left; a manual job never asks; an offline device pays at most
// one wait before the breaker; a disabled or signed-out one makes no call.
// Generated temp libraries, fake server, Storage and analyzer only.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analysisFlagsToOptions, DEFAULT_AUTO_FLAGS } from '../analyzer/flags.js';
import {
	FakeCatalogueServer,
	POLICY_D_A,
	POLICY_D_B,
	addLocalTrack,
	jobState,
	makeTestDevice,
	pcmMd5,
	seedAnalysed,
	waitFor,
	writeFlac,
	type TestDevice,
} from '../test-support/catalogue-fakes.js';
import { budgetMs } from '../test-support/timing.js';
import type { CatalogueLayerDeps } from './layer.js';

const USER = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const AUTO = analysisFlagsToOptions(DEFAULT_AUTO_FLAGS);

let root: string;
let server: FakeCatalogueServer;
const open: TestDevice[] = [];
const device = (name: string, layer: Partial<CatalogueLayerDeps> = {}): TestDevice => {
	const d = makeTestDevice(join(root, name), server, USER, { layer });
	open.push(d);
	return d;
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'curator-cat-queue-'));
	server = new FakeCatalogueServer();
});
afterEach(() => {
	for (const d of open.splice(0)) d.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

async function localFile(d: TestDevice, trackId: string, md5: string): Promise<string> {
	const file = join(d.dir, 'lib', `${trackId}.flac`);
	writeFlac(file, md5, `TITLE=${trackId} here`);
	return addLocalTrack(d, trackId, file);
}

// B learns what the account holds BEFORE it has the file, so nothing is
// hydrated ahead of the job: the pull has to happen in dispatch.
async function knowsButLacks(b: TestDevice, trackId: string, md5: string): Promise<void> {
	await b.layer.syncNow();
	await localFile(b, trackId, md5);
}

async function runBackground(d: TestDevice, ids: string[], options = AUTO): Promise<void> {
	d.queue.enqueue(ids, { priority: 0, analyzeOptions: options });
	d.queue.setAutoEnabled(true);
	await waitFor(() => ids.every((id) => jobState(d, id) === 'done'), 'background jobs');
}

describe('pull-before-compute', () => {
	it('a partial hit turns what the account holds into skips and computes the rest', async () => {
		// The account only holds rhythm and key for this audio.
		server.policy = { allow: [{ unit: 'rhythm', variants: null }, { unit: 'key', variants: null }] };
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(1) }], { upload: true });
		server.policy = POLICY_D_A;
		const b = device('b');
		await knowsButLacks(b, 't', pcmMd5(1));
		const lookups = server.calls.lookup;
		await runBackground(b, ['t']);
		expect(server.calls.lookup).toBe(lookups + 1);
		expect(b.analyzer.calls).toHaveLength(1);
		const o = b.analyzer.calls[0]!.options ?? {};
		// Key pulled → skipped. Rhythm pulled → its override dropped so the
		// pulled grid is injected for the segments, which are still computed.
		expect(o.skipKey).toBe(true);
		expect(o.overrideBeatgrid ?? false).toBe(false);
		expect(o.skipBeatgrid ?? false).toBe(false);
		expect(o.priorBpm).toBe(124.5);
		expect(o.skipSegments ?? false).toBe(false);
		expect(o.skipFingerprint ?? false).toBe(false);
		expect(o.skipPeaks ?? false).toBe(false);
		expect(b.analyzer.calls[0]!.outPeaksLoPath).toBe(join(b.peaksDir, 'lo', 't.cpk'));
	});

	it('a full hit finishes the job without the analyzer (hi tier allowed by the policy)', async () => {
		server.policy = POLICY_D_B;
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(2) }], { upload: true });
		const b = device('b');
		await knowsButLacks(b, 't', pcmMd5(2));
		await runBackground(b, ['t']);
		expect(b.analyzer.calls).toHaveLength(0);
		expect(existsSync(join(b.peaksDir, 'lo', 't.cpk'))).toBe(true);
		expect(existsSync(join(b.peaksDir, 'hi', 't.cpk'))).toBe(true);
		expect(b.events.some((e) => e.kind === 'completed' && e.trackId === 't')).toBe(true);
	});

	it('under D-a the hi tier on the server is never fetched: the analyzer computes it, keeping the pulled lo tier', async () => {
		server.policy = POLICY_D_B;
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(3) }], { upload: true });
		server.policy = POLICY_D_A;
		const b = device('b');
		await knowsButLacks(b, 't', pcmMd5(3));
		await runBackground(b, ['t']);
		expect(b.blobs.downloads).toBe(1);
		expect(b.analyzer.calls).toHaveLength(1);
		const call = b.analyzer.calls[0]!;
		expect(call.options?.skipPeaks ?? false).toBe(false);
		expect(call.outPeaksLoPath).not.toBe(join(b.peaksDir, 'lo', 't.cpk'));
		expect(server.calls.lookupHashes.flat().length).toBeGreaterThan(0);
	});

	it('a manual job never consults the catalogue, and its result is uploaded', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(4) }], { upload: true });
		const b = device('b');
		await knowsButLacks(b, 't', pcmMd5(4));
		await localFile(b, 'new', pcmMd5(40));
		const lookups = server.calls.lookup;
		b.queue.enqueue(['t', 'new'], { priority: 100, analyzeOptions: AUTO });
		await waitFor(() => jobState(b, 't') === 'done' && jobState(b, 'new') === 'done', 'manual jobs');
		expect(server.calls.lookup).toBe(lookups);
		expect(b.analyzer.calls).toHaveLength(2);
		expect(b.analyzer.calls.every((c) => !c.options?.skipKey && !c.options?.skipBeatgrid)).toBe(true);
		await b.layer.uploadNow();
		const newHash = (b.sqlite.prepare(`SELECT audio_hash AS h FROM source_link WHERE track_id = 'new'`).get() as { h: string }).h;
		// rhythm, key, structure, fingerprint and the lo tier (AUTO computes no
		// advanced scores; D-a ships no hi tier).
		expect(server.items(USER).filter((i) => i.audioHash === newHash).map((i) => `${i.unit}:${i.variant}`).sort())
			.toEqual(['fingerprint:default', 'key:default', 'peaks:lo', 'rhythm:default', 'structure:default']);
	});

	it('offline: one bounded wait, then the breaker lets every later job through at once', async () => {
		const a = device('a');
		await seedAnalysed(a, [1, 2, 3].map((i) => ({ trackId: `s${i}`, md5: pcmMd5(50 + i) })), { upload: true });
		const b = device('b', { prepareTimeoutMs: 300 });
		await b.layer.syncNow();
		for (const i of [1, 2, 3]) await localFile(b, `t${i}`, pcmMd5(50 + i));
		server.mode = 'hang';
		const lookups = server.calls.lookup;
		const t0 = Date.now();
		// One at a time, so "at most one wait" is about the breaker, not
		// about prepares overlapping.
		(b.queue as unknown as { concurrency: number }).concurrency = 1;
		await runBackground(b, ['t1', 't2', 't3']);
		expect(server.calls.lookup).toBe(lookups + 1);
		// The waits are fixed; only the overhead around them scales with load.
		expect(Date.now() - t0).toBeLessThan(300 * 2 + budgetMs(500, 'offline overhead'));
		expect(b.analyzer.calls).toHaveLength(3);
		expect(b.layer.status().lastError).toMatch(/Offline/);
	});

	it('offline with an immediate network error: no wait at all, one call, then the breaker', async () => {
		const a = device('a');
		await seedAnalysed(a, [1, 2].map((i) => ({ trackId: `s${i}`, md5: pcmMd5(60 + i) })), { upload: true });
		const b = device('b');
		await b.layer.syncNow();
		for (const i of [1, 2]) await localFile(b, `t${i}`, pcmMd5(60 + i));
		server.mode = 'offline';
		const lookups = server.calls.lookup;
		(b.queue as unknown as { concurrency: number }).concurrency = 1;
		await runBackground(b, ['t1', 't2']);
		expect(server.calls.lookup).toBe(lookups + 1);
		expect(b.analyzer.calls).toHaveLength(2);
	});

	it('disabled, signed out, or a server without the feature: no catalogue call at all', async () => {
		const a = device('a');
		await seedAnalysed(a, [1, 2, 3].map((i) => ({ trackId: `s${i}`, md5: pcmMd5(70 + i) })), { upload: true });
		const b = device('b');
		// Auto-analyze on before the files exist, so its fingerprint sweep
		// does not race the jobs below.
		b.queue.setAutoEnabled(true);
		await b.layer.syncNow();
		for (const i of [1, 2, 3]) await localFile(b, `t${i}`, pcmMd5(70 + i));
		const before = { ...server.calls, lookupHashes: undefined };

		b.layer.setSettings({ enabled: false });
		await runBackground(b, ['t1']);
		b.layer.setSettings({ enabled: true });

		b.features.list = ['pull_skip_own'];
		await runBackground(b, ['t2']);
		await b.layer.syncNow();
		await b.layer.uploadNow();
		b.features.list = ['pull_skip_own', 'catalogue'];

		b.device.session = null;
		await runBackground(b, ['t3']);
		await b.layer.syncNow();
		await b.layer.uploadNow();

		expect(server.calls.lookup).toBe(before.lookup);
		expect(server.calls.inventory).toBe(before.inventory);
		expect(server.calls.put).toBe(before.put);
		// Every job ran exactly as without a catalogue.
		expect(b.analyzer.calls.map((c) => c.options)).toEqual([AUTO, AUTO, AUTO]);
	});
});
