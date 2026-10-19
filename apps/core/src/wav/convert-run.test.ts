// Convert to WAV — playlist-level run against a migrated temp DB, with a stub
// converter process standing in for `curator-audio convert` (same stdin/
// stdout protocol; writes a tiny valid WAV). Pins: output naming + .part
// rename, member planning (convert / kept / skipped / duplicates), the
// derived "[WAV]" playlist in source order, peaks copy, idempotent re-runs,
// and per-track failure isolation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { DEFAULT_ARTIST_CREDIT_FORMAT } from '@curator/shared';
import { migrate } from '../db/migrate.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { createDb, type Db } from '../db/client.js';
import { normalizePath } from '../local/scanner.js';
import { WavConverter, type WavConvertDeps } from './convert-run.js';
import type { WavConvertEvent, WavConvertResult } from './types.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;
let outDir: string;
let peaksDir: string;
let stub: string;

// Stub converter: protocol-compatible, writes a 44-byte header + 4 frames.
// Fails (error line, exit 1) when the input path contains STUB_FAIL.
const STUB = `
const fs = require('node:fs');
let buf = '';
process.stdin.on('data', (c) => { buf += c; });
process.stdin.on('end', () => {
	const job = JSON.parse(buf.split(String.fromCharCode(10))[0]);
	const out = (o) => process.stdout.write(JSON.stringify(o) + String.fromCharCode(10));
	if (process.env.STUB_FAIL && job.input.includes(process.env.STUB_FAIL)) {
		out({ kind: 'error', message: 'corrupt FLAC frame' });
		process.exit(1);
	}
	const data = Buffer.alloc(16, 7);
	const h = Buffer.alloc(44);
	h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
	h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
	h.writeUInt32LE(44100, 24); h.writeUInt32LE(44100 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
	h.write('data', 36); h.writeUInt32LE(data.length, 40);
	fs.writeFileSync(job.output, Buffer.concat([h, data]));
	fs.writeFileSync(job.output + '.job.json', JSON.stringify(job));
	out({ kind: 'started', sourceSampleRate: 44100, sourceBitDepth: 16, channels: 2, sampleRate: 44100, bitDepth: 16, totalFrames: 4 });
	out({ kind: 'progress', frames: 2, totalFrames: 4 });
	out({ kind: 'done', sampleRate: 44100, bitDepth: 16, channels: 2, frames: 4, bytes: 60, resampled: false, sourceSampleRate: 44100, sourceBitDepth: 16 });
});
`;

function track(id: string, title: string, extra: Record<string, unknown> = {}): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, duration, state) VALUES (?, ?, ?, 200, 'unsorted')`).run(id, title, JSON.stringify([{ name: 'Artist' }]));
	for (const [k, v] of Object.entries(extra)) sqlite.prepare(`UPDATE track SET ${k} = ? WHERE id = ?`).run(v as never, id);
}
function localFile(trackId: string, name: string, format: string): string {
	const p = join(dir, 'music', name);
	writeFileSync(p, Buffer.from('fLaC-not-really'));
	const norm = normalizePath(p);
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_format, file_size, file_mtime) VALUES (?, ?, 'local', ?, ?, ?, 1, 1)`)
		.run(`sl-${trackId}`, trackId, norm, norm, format);
	return p;
}
function playlist(id: string, name: string, members: string[]): void {
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, sync_status) VALUES (?, 'local', ?, ?, 'synced')`).run(id, id, name);
	members.forEach((m, i) => sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`).run(...memberOrder(i), id, m, i, m));
}

function deps(over: Partial<WavConvertDeps> = {}): WavConvertDeps & { peaksRequested: string[] } {
	const peaksRequested: string[] = [];
	return {
		db, sqlite,
		spec: { command: process.execPath, args: [stub] },
		peaksDir,
		outputDir: () => outDir,
		ensureWatched: async () => {},
		recomputeMembership: () => {},
		requestPeaks: async (ids) => { peaksRequested.push(...ids); },
		creditFormat: () => DEFAULT_ARTIST_CREDIT_FORMAT,
		peaksRequested,
		...over,
	};
}

function runToEnd(conv: WavConverter, playlistId: string): Promise<{ result: WavConvertResult; events: WavConvertEvent[] }> {
	return new Promise((resolve, reject) => {
		const events: WavConvertEvent[] = [];
		const unsub = conv.subscribe((e) => {
			events.push(e);
			if (e.kind === 'completed') { unsub(); resolve({ result: e.result, events }); }
			if (e.kind === 'failed') { unsub(); reject(new Error(e.message)); }
		});
		conv.start(playlistId);
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-wavrun-'));
	migrate(join(dir, 'curator.db'));
	({ db, sqlite } = createDb(join(dir, 'curator.db')));
	mkdirSync(join(dir, 'music'));
	outDir = join(dir, 'WAV');
	peaksDir = join(dir, 'peaks');
	for (const tier of ['lo', 'hi']) mkdirSync(join(peaksDir, tier), { recursive: true });
	stub = join(dir, 'stub-convert.cjs');
	writeFileSync(stub, STUB);
	delete process.env.STUB_FAIL;

	track('f1', 'Alpha');           // FLAC → convert (has peaks)
	track('f2', 'Beta');            // FLAC → convert (no peaks)
	track('m1', 'Gamma');           // MP3 → kept as-is
	track('s1', 'Delta');           // streaming only → skipped
	localFile('f1', 'Artist - Alpha.flac', 'flac');
	localFile('f2', 'Artist - Beta.flac', 'flac');
	localFile('m1', 'Artist - Gamma.mp3', 'mpeg');
	writeFileSync(join(peaksDir, 'lo', 'f1.cpk'), 'lo-peaks');
	writeFileSync(join(peaksDir, 'hi', 'f1.cpk'), 'hi-peaks');
	// A file already sitting at the natural output name → the copy gets " (2)".
	mkdirSync(outDir);
	writeFileSync(join(outDir, 'Artist - Beta.wav'), 'someone else');
	playlist('pl', 'Warmup', ['f1', 'm1', 's1', 'f2', 'f1']);
});
afterEach(() => {
	delete process.env.STUB_FAIL;
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

const copyOf = (src: string): string => (sqlite.prepare(`SELECT id FROM track WHERE derived_from_track_id = ? AND deleted_at IS NULL`).get(src) as { id: string }).id;
const members = (pid: string): string[] => (sqlite.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`).all(pid) as Array<{ track_id: string }>).map((r) => r.track_id);

describe('WavConverter', () => {
	it('previews the plan', async () => {
		const p = await new WavConverter(deps()).preview('pl');
		expect([p.convert, p.reuse, p.kept, p.skipped]).toEqual([2, 0, 1, 1]);
		expect(p.targetPlaylistName).toBe('Warmup [WAV]');
		expect(p.targetPlaylistExists).toBe(false);
		expect(p.available).toBe(true);
		expect(p.skippedTitles).toEqual(['Delta']);
	});

	it('converts, binds, and builds "<name> [WAV]" in source order', async () => {
		const d = deps();
		const { result, events } = await runToEnd(new WavConverter(d), 'pl');
		expect(result.failures).toEqual([]);
		expect([result.converted, result.kept, result.skipped, result.failed]).toEqual([2, 1, 1, 0]);
		const c1 = copyOf('f1');
		const c2 = copyOf('f2');
		expect(members(result.playlistId)).toEqual([c1, 'm1', c2, c1]);
		const pl = sqlite.prepare(`SELECT name, source, derived_from_playlist_id FROM playlist WHERE id = ?`).get(result.playlistId);
		expect(pl).toEqual({ name: 'Warmup [WAV]', source: 'local', derived_from_playlist_id: 'pl' });

		const files = readdirSync(outDir).filter((f) => f.endsWith('.wav')).sort();
		expect(files).toEqual(['Artist - Alpha.wav', 'Artist - Beta (2).wav', 'Artist - Beta.wav']);
		expect(readdirSync(outDir).some((f) => f.endsWith('.part'))).toBe(false);
		const link = sqlite.prepare(`SELECT file_path FROM source_link WHERE track_id = ? AND source = 'local'`).get(c2) as { file_path: string };
		expect(link.file_path).toBe(normalizePath(join(outDir, 'Artist - Beta (2).wav')));

		// Tags sent to the converter are Curator's effective values, suffixed.
		const job = JSON.parse(readFileSync(join(outDir, 'Artist - Alpha.wav.part.job.json'), 'utf8'));
		expect(job.tags.title).toBe('Alpha [WAV]');
		expect(job.maxSampleRate).toBe(48000);

		expect(existsSync(join(peaksDir, 'lo', `${c1}.cpk`))).toBe(true);
		expect(d.peaksRequested).toEqual([c2]);
		expect(events[0]).toMatchObject({ kind: 'started', total: 2 });
	});

	it('re-runs reuse existing copies and leave the playlist untouched', async () => {
		const first = await runToEnd(new WavConverter(deps()), 'pl');
		const before = sqlite.prepare(`SELECT COUNT(*) n FROM track`).get();
		const updatedAt = sqlite.prepare(`SELECT updated_at FROM playlist WHERE id = ?`).get(first.result.playlistId);
		const p = await new WavConverter(deps()).preview('pl');
		expect([p.convert, p.reuse, p.targetPlaylistExists]).toEqual([0, 2, true]);
		const second = await runToEnd(new WavConverter(deps()), 'pl');
		expect(second.result.playlistId).toBe(first.result.playlistId);
		expect([second.result.converted, second.result.reused]).toEqual([0, 2]);
		expect(sqlite.prepare(`SELECT COUNT(*) n FROM track`).get()).toEqual(before);
		expect(sqlite.prepare(`SELECT updated_at FROM playlist WHERE id = ?`).get(first.result.playlistId)).toEqual(updatedAt);
	});

	it('isolates a failed track: no row, no .part, the rest still lands', async () => {
		process.env.STUB_FAIL = 'Beta';
		const { result, events } = await runToEnd(new WavConverter(deps()), 'pl');
		expect([result.converted, result.failed]).toEqual([1, 1]);
		expect(result.failures[0]).toMatchObject({ trackId: 'f2', message: 'corrupt FLAC frame' });
		expect(events.some((e) => e.kind === 'trackFailed')).toBe(true);
		expect(sqlite.prepare(`SELECT 1 FROM track WHERE derived_from_track_id = 'f2'`).get()).toBeUndefined();
		expect(readdirSync(outDir).some((f) => f.endsWith('.part'))).toBe(false);
		expect(members(result.playlistId)).toEqual([copyOf('f1'), 'm1', copyOf('f1')]);
	});

	it('refuses to start without a converter', () => {
		expect(() => new WavConverter(deps({ spec: null })).start('pl')).toThrow(/not available/);
	});
});
