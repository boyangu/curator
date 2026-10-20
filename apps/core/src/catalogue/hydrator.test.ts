// The catalogue hydrator (layer.ts syncNow): inventory into the mirror, then
// look up and fill in what live local files lack — inline units through the
// analyzer's persist path, lo/hi .cpk via temp file + rename — under the
// server's policy, a ±1 s duration guard and the never-overwrite rule.
// Generated temp libraries, fake server and Storage only.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FINGERPRINT_ONLY_OPTIONS } from '../analyzer/queue.js';
import {
	FakeCatalogueServer,
	POLICY_D_A,
	POLICY_D_B,
	addLocalTrack,
	jobState,
	makeTestDevice,
	pcmMd5,
	seedAnalysed,
	sha256,
	writeFlac,
	type TestDevice,
} from '../test-support/catalogue-fakes.js';

const USER = '0b6e1f3a-2c4d-4e5f-8a9b-1c2d3e4f5a6b';
const OTHER = 'c3d4e5f6-0718-4293-a4b5-c6d7e8f9a0b1';

let root: string;
let server: FakeCatalogueServer;
const open: TestDevice[] = [];
const device = (name: string, user = USER): TestDevice => {
	const d = makeTestDevice(join(root, name), server, user);
	open.push(d);
	return d;
};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'curator-hydrator-'));
	server = new FakeCatalogueServer();
});
afterEach(() => {
	for (const d of open.splice(0)) d.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const row = (d: TestDevice, trackId: string) =>
	d.sqlite.prepare(`SELECT bpm, key_camelot, audio_hash, analyzer_version, brightness FROM track_analysis WHERE track_id = ?`).get(trackId) as
		{ bpm: number | null; key_camelot: string | null; audio_hash: string | null; analyzer_version: string; brightness: number | null } | undefined;
const entryStates = (d: TestDevice) =>
	Object.fromEntries((d.sqlite.prepare(`SELECT unit || ':' || variant AS k, local_state FROM catalogue_entry`).all() as Array<{ k: string; local_state: string }>).map((r) => [r.k, r.local_state]));

async function localFile(d: TestDevice, trackId: string, md5: string, durationSec = 30): Promise<string> {
	const file = join(d.dir, 'lib', `${trackId}.flac`);
	writeFlac(file, md5, `TITLE=${trackId} on ${d.dir}`);
	return addLocalTrack(d, trackId, file, durationSec);
}

describe('hydrator', () => {
	it('fills every live track holding the audio, only what each lacks, and stamps the hash', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(1) }], { upload: true });
		const b = device('b');
		const hash = await localFile(b, 'fresh', pcmMd5(1));
		// A second track with the same audio (a duplicate copy minted its own
		// row) that already has a key of its own.
		await localFile(b, 'dup', pcmMd5(1));
		b.sqlite.prepare(`INSERT INTO track_analysis (track_id, key_camelot, key_strength, analyzer_version, analyzed_at, audio_hash, duration) VALUES ('dup', '3B', 0.5, '2.4.0', 1, ?, 30)`).run(hash);
		const hydrated: string[][] = [];
		b.layer.subscribe((e) => { if (e.kind === 'hydrated') hydrated.push(e.trackIds); });

		await b.layer.syncNow();

		expect(row(b, 'fresh')).toMatchObject({ bpm: 124.5, key_camelot: '8A', audio_hash: hash, analyzer_version: '2.4.0', brightness: 0.42 });
		// Never overwrite local: the duplicate keeps its own key, gets the rest.
		expect(row(b, 'dup')).toMatchObject({ bpm: 124.5, key_camelot: '3B', audio_hash: hash });
		for (const t of ['fresh', 'dup']) expect(existsSync(join(b.peaksDir, 'lo', `${t}.cpk`))).toBe(true);
		expect(hydrated.flat().sort()).toEqual(['dup', 'fresh']);
		expect(Object.values(entryStates(b)).every((s) => s === 'hydrated')).toBe(true);
		// One lo blob, downloaded once, copied to both tracks.
		expect(b.blobs.downloads).toBe(1);
		expect(b.analyzer.calls).toHaveLength(0);
		// A second pass has nothing left to do.
		const lookups = server.calls.lookup;
		await b.layer.syncNow();
		expect(server.calls.lookup).toBe(lookups);
	});

	it('refuses an item whose duration differs from the file by more than a second', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(2) }], { upload: true });
		const b = device('b');
		// Same hash, a different length: a truncated or mislabelled file.
		await localFile(b, 'short', pcmMd5(2), 27);
		await b.layer.syncNow();
		expect(row(b, 'short')).toBeUndefined();
		expect(existsSync(join(b.peaksDir, 'lo', 'short.cpk'))).toBe(false);
		expect(Object.values(entryStates(b)).every((s) => s === 'skipped')).toBe(true);
	});

	it('drops a blob that fails its sha256 check, still applying the inline units', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(3) }], { upload: true });
		for (const [path, bytes] of server.objects) { const bad = new Uint8Array(bytes); bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff; server.objects.set(path, bad); }
		const b = device('b');
		await localFile(b, 't', pcmMd5(3));
		await b.layer.syncNow();
		expect(row(b, 't')?.bpm).toBe(124.5);
		expect(existsSync(join(b.peaksDir, 'lo', 't.cpk'))).toBe(false);
		expect(entryStates(b)['peaks:lo']).toBe('skipped');
	});

	it('leaves a row that describes other audio alone', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(4) }], { upload: true });
		const b = device('b');
		await localFile(b, 't', pcmMd5(4));
		// The scanner cleared the stamp after the file's audio changed; the
		// old grid is still in the row.
		b.sqlite.prepare(`INSERT INTO track_analysis (track_id, bpm, beatgrid, analyzer_version, analyzed_at, audio_hash, duration) VALUES ('t', 99, x'0000803f', '2.4.0', 1, NULL, 30)`).run();
		await b.layer.syncNow();
		expect(row(b, 't')).toMatchObject({ bpm: 99, key_camelot: null, audio_hash: null });
		expect(existsSync(join(b.peaksDir, 'lo', 't.cpk'))).toBe(false);
	});

	it('follows the server policy for the hi tier: D-a never downloads it, D-b does', async () => {
		server.policy = POLICY_D_B;
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(5) }], { upload: true });
		expect(server.items(USER).some((i) => i.unit === 'peaks' && i.variant === 'hi')).toBe(true);

		server.policy = POLICY_D_A;
		const b = device('b');
		await localFile(b, 't', pcmMd5(5));
		await b.layer.syncNow();
		expect(existsSync(join(b.peaksDir, 'lo', 't.cpk'))).toBe(true);
		expect(existsSync(join(b.peaksDir, 'hi', 't.cpk'))).toBe(false);
		expect(b.blobs.downloads).toBe(1);
		expect(server.calls.lookupHashes.length).toBeGreaterThan(0);

		server.policy = POLICY_D_B;
		const c = device('c');
		await localFile(c, 't', pcmMd5(5));
		await c.layer.syncNow();
		expect(sha256(readFileSync(join(c.peaksDir, 'hi', 't.cpk')))).toBe(sha256(readFileSync(join(a.peaksDir, 'hi', 'src.cpk'))));
	});

	it('finishes a queued background job whose work all arrived, without the analyzer', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(6) }], { upload: true });
		const b = device('b');
		await localFile(b, 'fp', pcmMd5(6));
		await localFile(b, 'full', pcmMd5(6));
		// Parked background jobs (auto-analyze off): a fingerprint-only pass
		// and a default pass, which also wants the hi waveform D-a never ships.
		b.queue.enqueue(['fp'], { priority: -1, analyzeOptions: FINGERPRINT_ONLY_OPTIONS });
		b.queue.enqueue(['full'], { priority: 0 });
		await b.layer.syncNow();
		expect(jobState(b, 'fp')).toBe('done');
		expect(b.events.some((e) => e.kind === 'completed' && e.trackId === 'fp')).toBe(true);
		expect(jobState(b, 'full')).toBe('queued');
		expect(b.analyzer.calls).toHaveLength(0);
	});

	it('works through many hashes 50 at a time without holding the loop', async () => {
		const a = device('a');
		const n = 120;
		await seedAnalysed(a, Array.from({ length: n }, (_, i) => ({ trackId: `s${i}`, md5: pcmMd5(100 + i) })), { upload: true });
		const b = device('b');
		// The layer's own work is what is bounded here. The app's connection
		// runs synchronous=FULL, so every commit also waits for the disk's
		// fsync — under this suite's parallel disk load that alone measured
		// 200+ ms once, for any writer. NORMAL (WAL) takes the fsync out of
		// the commit so the measurement is about the hydrator.
		b.sqlite.pragma('synchronous = NORMAL');
		for (let i = 0; i < n; i++) await localFile(b, `t${i}`, pcmMd5(100 + i));
		const before = server.calls.lookupHashes.length;
		await b.layer.syncNow();
		const batches = server.calls.lookupHashes.slice(before);
		expect(batches.length).toBe(Math.ceil(n / 50));
		expect(Math.max(...batches.map((h) => h.length))).toBeLessThanOrEqual(50);
		expect((b.sqlite.prepare(`SELECT count(*) AS n FROM track_analysis WHERE bpm IS NOT NULL`).get() as { n: number }).n).toBe(n);
		console.info(`[hydrator] ${n} hashes maxSliceMs=${b.layer.stats().maxSliceMs.toFixed(2)} (${b.layer.stats().maxSliceAt})`);
		expect(b.layer.stats().maxSliceMs).toBeLessThan(50);
	}, 60_000);

	it('empties the mirror when another account signs in', async () => {
		const a = device('a');
		await seedAnalysed(a, [{ trackId: 'src', md5: pcmMd5(7) }], { upload: true });
		const b = device('b');
		await b.layer.syncNow();
		expect(Object.keys(entryStates(b)).length).toBeGreaterThan(0);
		b.layer.setBackfill('start');
		b.device.session = { userId: OTHER, email: null };
		await b.layer.syncNow();
		expect(Object.keys(entryStates(b))).toHaveLength(0);
		expect(b.layer.status().settings.backfill).toBe('off');
		expect(JSON.parse((b.sqlite.prepare(`SELECT value FROM app_setting WHERE key = 'catalogue.account'`).get() as { value: string }).value)).toEqual({ userId: OTHER });
		expect(JSON.parse((b.sqlite.prepare(`SELECT value FROM app_setting WHERE key = 'catalogue.inventory_rev'`).get() as { value: string }).value)).toBe(0);
	});
});
