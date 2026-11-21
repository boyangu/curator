import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AnalyzerSidecar, type AnalyzeParams, type AnalyzerHealth, type SidecarError, type SidecarOptions } from './sidecar.js';

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
function makeSidecar(opts: { executable?: string; script?: string } & Pick<SidecarOptions, 'preflight' | 'helloTimeoutMs' | 'pingIntervalMs'> = {}): AnalyzerSidecar {
	const { executable, script, ...liveness } = opts;
	const s = new AnalyzerSidecar({ executable: executable ?? process.execPath, args: ['-e', script ?? FAKE_ANALYZER], ...liveness });
	live.push(s);
	return s;
}

// Records every health transition; `until` resolves on the next one that matches.
function watchHealth(sidecar: AnalyzerSidecar): { seen: AnalyzerHealth[]; until: (pred: (h: AnalyzerHealth) => boolean) => Promise<AnalyzerHealth> } {
	const seen: AnalyzerHealth[] = [];
	let waiters: Array<{ pred: (h: AnalyzerHealth) => boolean; resolve: (h: AnalyzerHealth) => void }> = [];
	sidecar.on('health', (h: AnalyzerHealth) => {
		seen.push(h);
		const hit = waiters.filter((w) => w.pred(h));
		waiters = waiters.filter((w) => !w.pred(h));
		for (const w of hit) w.resolve(h);
	});
	return { seen, until: (pred) => new Promise((resolve) => { waiters.push({ pred, resolve }); }) };
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

// A process that spawns, reads stdin, and never writes a byte — what `wsl.exe`
// does when the WSL service behind it is hung. Once the marker file exists it
// behaves (hello + answers), so a test can "fix the host" and retry.
const hungUnless = (marker: string): string => `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const ok = fs.existsSync(${JSON.stringify(marker)});
if (ok) send({ event: 'hello', name: 'curator-analyzer', version: '0.0.0-test', protocol: 1 });
rl.on('line', (line) => {
	if (!ok || !line.trim()) return;
	const f = JSON.parse(line);
	if (f.method === 'ping') send({ id: f.id, event: 'pong' });
	if (f.method === 'analyze') send({ id: f.id, error: { kind: 'decode', message: 'alive' } });
	if (f.method === 'shutdown') process.exit(0);
});
`;

// Says hello, then answers each ping with the given statement (or not at all).
const helloThen = (onPing: string): string => `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
send({ event: 'hello', name: 'curator-analyzer', version: '0.0.0-test', protocol: 1 });
rl.on('line', (line) => {
	if (!line.trim()) return;
	const f = JSON.parse(line);
	if (f.method === 'ping') { ${onPing} }
	if (f.method === 'shutdown') process.exit(0);
});
`;

describe('AnalyzerSidecar liveness', () => {
	it('kills a process that never says hello, hands its work back, and stops after three strikes', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'curator-analyzer-hung-'));
		const marker = join(dir, 'fixed');
		const sidecar = makeSidecar({ script: hungUnless(marker), helloTimeoutMs: 150 });
		const health = watchHealth(sidecar);
		expect(sidecar.status).toEqual({ state: 'idle' });

		sidecar.start();
		// Written to the hung process's stdin — this used to wait forever.
		await expect(sidecar.analyze(params('a'))).rejects.toMatchObject({ kind: 'sidecar_unavailable', message: expect.stringContaining('did not start') });
		expect(sidecar.status).toMatchObject({ state: 'unresponsive' });
		expect(sidecar.disabled).toBeNull();

		const stopped = await health.until((h) => h.state === 'disabled');
		expect(stopped).toMatchObject({ state: 'disabled', reason: expect.stringContaining('did not start') });
		expect(sidecar.disabled).toContain('did not start');
		// Never 'ready', and 'unresponsive' held through the relaunches.
		expect(health.seen.map((h) => h.state)).toEqual(['starting', 'unresponsive', 'disabled']);
		await expect(sidecar.analyze(params('b'))).rejects.toMatchObject({ kind: 'sidecar_unavailable' });

		// The host is fixed; restart() is the way back.
		writeFileSync(marker, '1');
		sidecar.restart();
		expect(await health.until((h) => h.state === 'ready')).toEqual({ state: 'ready', version: '0.0.0-test' });
		expect(sidecar.disabled).toBeNull();
		await expect(sidecar.analyze(params('c'))).rejects.toMatchObject({ kind: 'decode', message: 'alive' });
		rmSync(dir, { recursive: true, force: true });
	}, 15_000);

	it('catches a sidecar that goes silent after hello', async () => {
		const sidecar = makeSidecar({ script: helloThen(''), pingIntervalMs: 40 });
		const health = watchHealth(sidecar);
		sidecar.start();
		await health.until((h) => h.state === 'ready');
		const pending = sidecar.analyze(params('a'));
		expect(await health.until((h) => h.state === 'unresponsive')).toMatchObject({ reason: expect.stringContaining('stopped responding') });
		await expect(pending).rejects.toMatchObject({ kind: 'sidecar_unavailable' });
		// Relaunched: the fresh process says hello and counts as ready again.
		await health.until((h) => h.state === 'ready');
		expect(sidecar.disabled).toBeNull();
	}, 15_000);

	it.each([
		['a pong', "send({ id: f.id, event: 'pong' });"],
		// A bundle that predates ping: any frame still proves it is alive.
		['an unknown-method error', "send({ id: f.id, error: { kind: 'internal', message: 'unknown method' } });"],
	])('stays ready while pings are answered with %s', async (_name, onPing) => {
		const sidecar = makeSidecar({ script: helloThen(onPing), pingIntervalMs: 30 });
		const health = watchHealth(sidecar);
		sidecar.start();
		await health.until((h) => h.state === 'ready');
		await new Promise((r) => setTimeout(r, 500));
		expect(health.seen.map((h) => h.state)).toEqual(['starting', 'ready']);
	});

	it('does not spawn while the launch check fails, and reports its reason', async () => {
		let problem: string | null = 'WSL is not responding.';
		let checks = 0;
		let ready = 0;
		const sidecar = makeSidecar({ preflight: async () => { checks++; return problem; } });
		sidecar.on('ready', () => { ready++; });
		const health = watchHealth(sidecar);

		sidecar.start();
		// Parked behind the check, then handed back with its reason.
		await expect(sidecar.analyze(params('a'))).rejects.toMatchObject({ kind: 'sidecar_unavailable', message: 'WSL is not responding.' });
		expect(await health.until((h) => h.state === 'disabled')).toEqual({ state: 'disabled', reason: 'WSL is not responding.' });
		expect(checks).toBe(3);
		expect(ready).toBe(0);

		problem = null;
		sidecar.restart();
		const parked = sidecar.analyze(params('b'));
		expect((await parked).track_id).toBe('b');
		expect(ready).toBe(1);
		expect(sidecar.status).toMatchObject({ state: 'ready' });
	}, 15_000);
});
