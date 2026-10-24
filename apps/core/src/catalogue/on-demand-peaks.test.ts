// Protocol v5 narrows the catalogue to waveforms, on demand. With the server
// listing 'analysis_v5', a device without the file gets the analysis from
// the log (sync-log/track-analysis.ts) — no catalogue call at all — and its
// waveform only when the player asks (layer.fetchPeaks): the account's hi
// tier, else lo; the core then serves a hi request from lo
// (service.resolveTrackPeaksPath). Asserted on device B against device A's
// real upload. Generated temp dirs, fake server and Storage, fake analyzer.

import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MASTER_DEVICE_SETTING, opSchemaVersion, type TrackAnalysis, type TrackMeta } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { createCoreService } from '../service.js';
import { applyOps } from '../sync-log/apply.js';
import { remoteTrackId } from '../sync-log/stable-ids.js';
import { FakeCatalogueServer, POLICY_D_A, POLICY_D_B, fixedCpk, makeTestDevice, pcmMd5, seedAnalysed, sha256, waitFor, type TestDevice } from '../test-support/catalogue-fakes.js';

const USER = '3c1d5e7f-2a4b-4c6d-8e0f-1a3b5c7d9e2f';
const V5 = ['pull_skip_own', 'catalogue', 'zero_loss_v4', 'analysis_v5'];

let root: string;
const devices: TestDevice[] = [];
afterEach(() => {
	for (const d of devices.splice(0)) d.close();
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

let ts = 1_760_000_000_000;
const op = (device: string, entity: string, entityId: string, kind: string, payload: unknown): Record<string, unknown> =>
	({ op_id: randomUUID(), device_id: device, client_ts: ts++, schema_version: opSchemaVersion({ entity, kind, entity_id: entityId }), entity, entity_id: entityId, kind, payload });
const meta = (title: string): TrackMeta => ({ source: 'local', title, artists: [{ name: 'A' }], album_title: null, duration_sec: 30, isrc: null, release_date: null, label: null, genre: null, cover_url: null });
const rec = (i: number): string => `00000000-0000-4000-8000-${(0xa00 + i).toString(16).padStart(12, '0')}`;
const analysis = (hash: string): TrackAnalysis => ({
	audio_hash: hash, analyzer_version: '2.4.0', analyzed_at: 1_760_000_000_000, duration: 30.25, bpm: 124.5, key_camelot: '8A', key_strength: 0.71,
	brightness: 0.42, power: 0.66, dynamic_complexity: 3.1, loudness_range_lu: 6.5, dissonance: 0.31, density: 12.5,
	intro_length_sec: 8, outro_length_sec: 8.25, first_drop_sec: 8, drop_count: 1, breakdown_count: 0, grid: [1, 2, 1, 120, 482, 0], segments: [[0, 8, 0, 0.9, 0.3]],
});

// B holds the master's recordings as remote rows: create, meta, the audio
// claim — and, on a v5 log, the analysis.
function joinB(b: TestDevice, hashes: ReadonlyArray<[number, string]>, withAnalysis: boolean): void {
	applyOps(b.sqlite, [
		op('dev-a', 'setting', MASTER_DEVICE_SETTING, 'set', { value: 'dev-a' }),
		...hashes.flatMap(([i, h]) => [
			op('dev-a', 'library_track', rec(i), 'create', { added_at: 1 }),
			op('dev-a', 'library_track', rec(i), 'set-meta', meta(`T${i}`)),
			op('dev-a', 'recording_claim', rec(i), 'add', { kind: 'audio_hash', value: h, confidence: 1 }),
			...(withAnalysis ? [op('dev-a', 'library_track', rec(i), 'set-analysis', { analysis: analysis(h) })] : []),
		]),
	]);
}

describe('v5: the catalogue moves waveforms only, when the player asks', () => {
	it('no background hydrate; the analysis comes from the log; fetchPeaks takes lo when the account has no hi, hi when it does', async () => {
		root = mkdtempSync(join(tmpdir(), 'curator-peaks-on-demand-'));
		const server = new FakeCatalogueServer();
		server.policy = POLICY_D_A;
		const a = makeTestDevice(join(root, 'a'), server, USER);
		devices.push(a);
		const hashes = await seedAnalysed(a, [{ trackId: 'one', md5: pcmMd5(0) }, { trackId: 'two', md5: pcmMd5(1) }], { upload: true });

		const b = makeTestDevice(join(root, 'b'), server, USER);
		devices.push(b);
		b.features.list = V5;
		joinB(b, [[1, hashes.get('one')!], [2, hashes.get('two')!]], true);
		const r1 = remoteTrackId(rec(1));
		// The analysis is there before any catalogue pass.
		expect(b.sqlite.prepare(`SELECT bpm, brightness, power, audio_hash FROM track_analysis WHERE track_id = ?`).get(r1))
			.toEqual({ bpm: 124.5, brightness: 0.42, power: 0.66, audio_hash: hashes.get('one') });

		// A catalogue pass: the inventory, but no lookup, no download.
		const before = { lookup: server.calls.lookup, downloads: b.blobs.downloads };
		await b.layer.syncNow();
		expect(server.calls.inventory).toBeGreaterThan(0);
		expect([server.calls.lookup, b.blobs.downloads]).toEqual([before.lookup, before.downloads]);
		expect(existsSync(join(b.peaksDir, 'lo', `${r1}.cpk`))).toBe(false);

		// The player asks: one lookup, one download, the lo tier (D-a).
		expect(await b.layer.fetchPeaks(r1)).toBe('lo');
		expect(server.calls.lookup).toBe(before.lookup + 1);
		expect(sha256(readFileSync(join(b.peaksDir, 'lo', `${r1}.cpk`)))).toBe(sha256(readFileSync(join(a.peaksDir, 'lo', 'one.cpk'))));
		// Joined while running, and the slot the projection wrote is not
		// disturbed by the plan's commit (peaks only).
		expect(b.sqlite.prepare(`SELECT bpm FROM track_analysis WHERE track_id = ?`).pluck().get(r1)).toBe(124.5);

		// D-b: the account holds hi too; the next track gets hi, once.
		server.policy = POLICY_D_B;
		a.layer.setBackfill('start');
		await a.layer.syncNow();
		await a.layer.uploadNow();
		await b.layer.syncNow();
		const r2 = remoteTrackId(rec(2));
		const [p1, p2] = await Promise.all([b.layer.fetchPeaks(r2), b.layer.fetchPeaks(r2)]);
		expect([p1, p2]).toEqual(['hi', 'hi']);
		expect(existsSync(join(b.peaksDir, 'hi', `${r2}.cpk`))).toBe(true);
		expect(existsSync(join(b.peaksDir, 'lo', `${r2}.cpk`))).toBe(false);
		const lookups = server.calls.lookup;
		expect(await b.layer.fetchPeaks(r2)).toBe('hi');
		expect(server.calls.lookup).toBe(lookups);
	});

	it('a track the account has nothing for is asked once; a v4 server keeps the background hydrate', async () => {
		root = mkdtempSync(join(tmpdir(), 'curator-peaks-on-demand-'));
		const server = new FakeCatalogueServer();
		server.policy = POLICY_D_A;
		const a = makeTestDevice(join(root, 'a'), server, USER);
		devices.push(a);
		const hashes = await seedAnalysed(a, [{ trackId: 'one', md5: pcmMd5(0) }], { upload: true });
		const b = makeTestDevice(join(root, 'b'), server, USER);
		devices.push(b);
		b.features.list = V5;
		joinB(b, [[1, hashes.get('one')!], [3, 'pcm-md5:' + 'ee'.repeat(16)]], true);
		const r3 = remoteTrackId(rec(3));
		expect(await b.layer.fetchPeaks(r3)).toBeNull();
		const lookups = server.calls.lookup;
		expect(await b.layer.fetchPeaks(r3)).toBeNull();
		expect(server.calls.lookup).toBe(lookups);

		// The same device on a v4 server: the hydrator runs as before.
		b.features.list = ['pull_skip_own', 'catalogue', 'zero_loss_v4'];
		await b.layer.syncNow();
		expect(existsSync(join(b.peaksDir, 'lo', `${remoteTrackId(rec(1))}.cpk`))).toBe(true);
	});

	it('a regained network asks again for a track the account seemed to lack; a lo the device holds is not downloaded again', async () => {
		root = mkdtempSync(join(tmpdir(), 'curator-peaks-on-demand-'));
		const server = new FakeCatalogueServer();
		server.policy = POLICY_D_A;
		const a = makeTestDevice(join(root, 'a'), server, USER);
		devices.push(a);
		const hashes = await seedAnalysed(a, [{ trackId: 'one', md5: pcmMd5(0) }], { upload: true });
		const b = makeTestDevice(join(root, 'b'), server, USER);
		devices.push(b);
		b.features.list = V5;
		joinB(b, [[1, hashes.get('one')!], [3, 'pcm-md5:' + 'ee'.repeat(16)]], true);
		await b.layer.syncNow();
		const r3 = remoteTrackId(rec(3));
		expect(await b.layer.fetchPeaks(r3)).toBeNull();
		const lookups = server.calls.lookup;
		expect(await b.layer.fetchPeaks(r3)).toBeNull();
		expect(server.calls.lookup).toBe(lookups);
		// Back online: the miss window is gone, the next ask goes out.
		b.layer.wake('network');
		expect(await b.layer.fetchPeaks(r3)).toBeNull();
		expect(server.calls.lookup).toBe(lookups + 1);

		const r1 = remoteTrackId(rec(1));
		expect(await b.layer.fetchPeaks(r1)).toBe('lo');
		const downloads = b.blobs.downloads;
		// A reconnect's re-ask of a track shown at lo, the account still
		// holding only lo: one lookup, no download.
		expect(await b.layer.fetchPeaks(r1)).toBe('lo');
		expect(b.blobs.downloads).toBe(downloads);
	});

	it('a fetch that failed is retried once on its own, past the breaker; the waveform goes out as hydrated', async () => {
		root = mkdtempSync(join(tmpdir(), 'curator-peaks-on-demand-'));
		const server = new FakeCatalogueServer();
		server.policy = POLICY_D_A;
		const a = makeTestDevice(join(root, 'a'), server, USER);
		devices.push(a);
		const hashes = await seedAnalysed(a, [{ trackId: 'one', md5: pcmMd5(0) }, { trackId: 'two', md5: pcmMd5(1) }], { upload: true });
		const b = makeTestDevice(join(root, 'b'), server, USER, { layer: { peaksRetryMs: 40 } });
		devices.push(b);
		b.features.list = V5;
		joinB(b, [[1, hashes.get('one')!], [2, hashes.get('two')!]], true);
		await b.layer.syncNow();
		b.layer.start();
		const hydrated: string[][] = [];
		b.layer.subscribe((e) => { if (e.kind === 'hydrated') hydrated.push(e.trackIds); });
		const r1 = remoteTrackId(rec(1));
		server.mode = 'offline';
		expect(await b.layer.fetchPeaks(r1)).toBeNull();
		server.mode = 'ok';
		await waitFor(() => hydrated.some((ids) => ids.includes(r1)), 'the retry');
		expect(existsSync(join(b.peaksDir, 'lo', `${r1}.cpk`))).toBe(true);

		// Once: a retry that fails as well is left to the next ask (or the
		// next reconnect).
		const r2 = remoteTrackId(rec(2));
		server.mode = 'offline';
		const before = server.calls.lookup;
		expect(await b.layer.fetchPeaks(r2)).toBeNull();
		await waitFor(() => server.calls.lookup >= before + 2, 'the retry');
		await new Promise((r) => setTimeout(r, 200));
		expect(server.calls.lookup).toBe(before + 2);
		expect(hydrated.some((ids) => ids.includes(r2))).toBe(false);
	});
});

describe('resolveTrackPeaksPath', () => {
	it('serves a hi request from the lo tier when only lo is on disk', async () => {
		root = mkdtempSync(join(tmpdir(), 'curator-peaks-fallback-'));
		const dbPath = join(root, 'curator.db');
		migrate(dbPath);
		const peaksDir = join(root, 'peaks');
		mkdirSync(join(peaksDir, 'lo'), { recursive: true });
		writeFileSync(join(peaksDir, 'lo', 't1.cpk'), fixedCpk('lo'));
		const svc = createCoreService(dbPath, { peaksDir });
		try {
			expect(await svc.resolveTrackPeaksPath('t1', 'hi')).toBe(join(peaksDir, 'lo', 't1.cpk'));
			expect(await svc.resolveTrackPeaksPath('t1', 'lo')).toBe(join(peaksDir, 'lo', 't1.cpk'));
			mkdirSync(join(peaksDir, 'hi'), { recursive: true });
			writeFileSync(join(peaksDir, 'hi', 't1.cpk'), fixedCpk('hi'));
			expect(await svc.resolveTrackPeaksPath('t1', 'hi')).toBe(join(peaksDir, 'hi', 't1.cpk'));
			expect(await svc.resolveTrackPeaksPath('t2', 'hi')).toBeNull();
			// No catalogue in this service: nothing to fetch.
			expect(await svc.fetchTrackPeaks('t2')).toBeNull();
		} finally {
			svc.close();
		}
	});
});
