import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AnalyzerSidecar, type AnalyzeParams, type SidecarError } from './sidecar.js';

// Scripted fake analyzer (plain Node via -e): says hello, answers every
// analyze with a minimal result echoing the track id + peaks paths.
const FAKE_ANALYZER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
send({ event: 'hello', name: 'curator-analyzer', version: '0.0.0-test', protocol: 1 });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const f = JSON.parse(line);
	if (f.method === 'analyze') {
		send({ id: f.id, result: {
			track_id: f.params.trackId, duration: 1, bpm: 120, beatgrid: [], downbeats: [],
			key_camelot: null, key_strength: null, brightness: null, power: null,
			dynamic_complexity: null, loudness_range_lu: null, dissonance: null, density: null,
			segments: [], intro_length_sec: null, outro_length_sec: null, first_drop_sec: null,
			drop_count: null, breakdown_count: null, fingerprint: null, fingerprint_duration_sec: null,
			features: {}, peaks_lo_path: f.params.outPeaksLoPath, peaks_hi_path: f.params.outPeaksHiPath,
			analyzer_version: 'test',
		} });
	}
	if (f.method === 'shutdown') process.exit(0);
});
`;

const params = (trackId: string): AnalyzeParams => ({
	trackId,
	path: `c:/music/${trackId}.flac`,
	outPeaksLoPath: `c:/peaks/lo/${trackId}.cpk`,
	outPeaksHiPath: `c:/peaks/hi/${trackId}.cpk`,
});

// Resolves to 'pending' when the promise has not settled within a few ticks
// of the event loop — enough for an immediate rejection to have landed.
async function settledState(p: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
	let state: 'pending' | 'resolved' | 'rejected' = 'pending';
	p.then(() => { state = 'resolved'; }, () => { state = 'rejected'; });
	await new Promise((r) => setTimeout(r, 20));
	return state;
}

let live: AnalyzerSidecar[] = [];
function makeSidecar(opts: { executable?: string; script?: string } = {}): AnalyzerSidecar {
	const s = new AnalyzerSidecar({ executable: opts.executable ?? process.execPath, args: ['-e', opts.script ?? FAKE_ANALYZER] });
	live.push(s);
	return s;
}

afterEach(async () => {
	await Promise.all(live.map((s) => s.shutdown()));
	live = [];
});

describe('AnalyzerSidecar deferred start', () => {
	it('does not spawn on construction, and parks requests until start()', async () => {
		const sidecar = makeSidecar();
		let readyEvents = 0;
		sidecar.on('ready', () => { readyEvents++; });

		const pending = sidecar.analyze(params('t1'));
		expect(await settledState(pending)).toBe('pending');
		expect(sidecar.hasStarted).toBe(false);
		expect(readyEvents).toBe(0);

		sidecar.start();
		expect(sidecar.hasStarted).toBe(true);
		const result = await pending;
		// 'ready' follows the OS spawn, not the start() call.
		expect(readyEvents).toBe(1);
		expect(result.track_id).toBe('t1');
		expect(result.peaks_hi_path).toBe('c:/peaks/hi/t1.cpk');

		// After start, requests go straight through.
		const second = await sidecar.analyze(params('t2'));
		expect(second.track_id).toBe('t2');
	});

	it('rejects a parked request as cancelled when its track is cancelled before start', async () => {
		const sidecar = makeSidecar();
		const a = sidecar.analyze(params('a'));
		const b = sidecar.analyze(params('b'));
		sidecar.cancel('a');
		await expect(a).rejects.toMatchObject({ kind: 'cancelled' } satisfies Partial<SidecarError>);
		sidecar.start();
		expect((await b).track_id).toBe('b');
	});

	it('rejects parked requests as unavailable when shut down before start', async () => {
		const sidecar = makeSidecar();
		const p = sidecar.analyze(params('x'));
		await sidecar.shutdown();
		await expect(p).rejects.toMatchObject({ kind: 'sidecar_unavailable' } satisfies Partial<SidecarError>);
		// And nothing parks after shutdown: a late request fails fast.
		await expect(sidecar.analyze(params('y'))).rejects.toMatchObject({ kind: 'sidecar_unavailable' } satisfies Partial<SidecarError>);
	});

	it('still rejects an unrepresentable path immediately, before start', async () => {
		const sidecar = makeSidecar();
		const bad = { ...params('s'), path: 'c:/music/\uD800.flac' };
		await expect(sidecar.analyze(bad)).rejects.toMatchObject({ kind: 'internal' } satisfies Partial<SidecarError>);
	});
});

describe('AnalyzerSidecar failure handling', () => {
	it('turns a spawn failure (executable missing) into rejections + disabled, never a hang', async () => {
		const sidecar = makeSidecar({ executable: 'curator-no-such-analyzer-exe' });
		let ready = 0;
		let disabled = 0;
		sidecar.on('ready', () => { ready++; });
		sidecar.on('disabled', () => { disabled++; });

		const parked = sidecar.analyze(params('p'));
		sidecar.start();
		// Node emits 'error' and no 'exit' for this — the request used to hang.
		await expect(parked).rejects.toMatchObject({ kind: 'sidecar_unavailable', message: expect.stringContaining('failed to start') });
		expect(ready).toBe(0);
		expect(disabled).toBe(1);
		expect(sidecar.disabled).toContain('not found');

		// A request after the failure fails fast with the reason.
		await expect(sidecar.analyze(params('q'))).rejects.toMatchObject({ kind: 'sidecar_unavailable', message: expect.stringContaining('not found') });
	});

	it('rejects in-flight work when the process dies, then respawns and says ready again', async () => {
		// Dies on its first analyze; the respawned copy (marker file present)
		// answers normally.
		const marker = join(mkdtempSync(join(tmpdir(), 'curator-analyzer-sidecar-')), 'died');
		const script = `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
send({ event: 'hello', name: 'curator-analyzer', version: '0.0.0-test', protocol: 1 });
rl.on('line', (line) => {
	const f = JSON.parse(line);
	if (f.method === 'shutdown') process.exit(0);
	if (f.method !== 'analyze') return;
	if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(3); }
	send({ id: f.id, error: { kind: 'decode', message: 'second life' } });
});
`;
		const sidecar = makeSidecar({ script });
		let ready = 0;
		sidecar.on('ready', () => { ready++; });
		sidecar.start();
		await expect(sidecar.analyze(params('a'))).rejects.toMatchObject({ kind: 'sidecar_unavailable', message: expect.stringContaining('code=3') });
		// First respawn backoff is 500 ms.
		await new Promise<void>((resolve) => { const t = setInterval(() => { if (ready >= 2) { clearInterval(t); resolve(); } }, 20); });
		expect(sidecar.disabled).toBeNull();
		await expect(sidecar.analyze(params('b'))).rejects.toMatchObject({ kind: 'decode', message: 'second life' });
		rmSync(dirname(marker), { recursive: true, force: true });
	});
});
