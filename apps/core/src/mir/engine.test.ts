// End to end across the process boundary: the real apps/mir sidecar (its
// weight-free stub model), driven by MirSidecar + the scheduler + the store.
// Skipped when the engine env isn't installed (disabled is a supported state).

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMirLayer, type MirLayer } from './layer.js';
import type { MirLibraryPort } from './library-port.js';
import type { MirEvent, MirSettings } from './types.js';

const MIR_DIR = resolve(__dirname, '../../../mir');
const PY = join(MIR_DIR, '.venv', 'Scripts', 'python.exe');

function tone(path: string, freq: number, secs = 4, sr = 16000): void {
	const n = secs * sr;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
	buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
	buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * freq * i) / sr)), 44 + i * 2);
	writeFileSync(path, buf);
}

let layer: MirLayer | null = null;
let dir = '';
afterEach(async () => {
	await layer?.close();
	layer = null;
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
});

describe.skipIf(!existsSync(PY))('real engine (stub model)', () => {
	it('analyzes on demand, stores vectors + segments, and ranks', async () => {
		dir = mkdtempSync(join(tmpdir(), 'curator-mir-e2e-'));
		const files: Record<string, string> = { low: join(dir, 'low.wav'), low2: join(dir, 'low2.wav'), high: join(dir, 'high.wav') };
		tone(files.low!, 220); tone(files.low2!, 230); tone(files.high!, 3000);
		const library: MirLibraryPort = {
			playableTrackIds: () => Object.keys(files),
			trackFile: (id) => files[id] ?? null,
			trackSegments: () => [{ startSec: 0, endSec: 2, label: 'intro' }, { startSec: 2, endSec: 4, label: 'drop' }],
			isLive: (id) => id in files,
		};
		let settings: MirSettings = { enabled: false, executor: 'local', models: ['stub'] };
		layer = createMirLayer({
			mirDbPath: join(dir, 'mir.db'),
			sidecar: { executable: PY, args: ['-m', 'curator_mir.main'], cwd: MIR_DIR,
				env: { CURATOR_MIR_STUB: '1', CURATOR_MIR_DEVICE: 'cpu', CURATOR_MIR_THREADS: '1' } },
			library, loadSettings: () => settings, saveSettings: (s) => { settings = s; },
		});
		const done = new Set<string>();
		layer.subscribe((e: MirEvent) => { if (e.kind === 'analyzed') done.add(e.trackId); });
		for (let i = 0; i < 300 && layer.status().state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 100));
		expect(layer.status().state).toBe('ready');
		// capabilities land just after hello; wait for the stub to be known
		for (let i = 0; i < 100 && !layer.status().models.some((m) => m.key === 'stub'); i++) await new Promise((r) => setTimeout(r, 100));
		expect(layer.analyzeNow(['low', 'low2', 'high'])).toEqual({ queued: 3 });
		for (let i = 0; i < 300 && done.size < 3; i++) await new Promise((r) => setTimeout(r, 100));
		expect([...done].sort()).toEqual(['high', 'low', 'low2']);
		expect(layer.status().coverage.perModel['stub@1']).toEqual({ done: 3, failed: 0 });
		const r = await layer.rank({ seeds: ['low'], k: 2 });
		expect(r.model).toBe('stub@1');
		expect(r.items[0]!.trackId).toBe('low2'); // the nearby tone, not the 3 kHz one
		expect(layer.trackVector('low', 'stub')).toHaveLength(8);
	}, 60_000);
});
