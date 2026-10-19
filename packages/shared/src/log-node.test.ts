import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSink } from './log-node.js';
import type { LogRecord } from './log.js';

function rec(msg: string, pad = 0): LogRecord {
	return { ts: 1, level: 'info', proc: 'main', area: 'test', msg: msg + 'x'.repeat(pad) };
}

describe('fileSink', () => {
	it('writes JSONL lines and rotates at maxBytes keeping N files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'curator-log-'));
		try {
			const sink = fileSink({ dir, name: 'curator', maxBytes: 1024, keep: 3 });
			// Each record ~200 bytes; write enough to force several rotations.
			for (let i = 0; i < 60; i++) {
				sink.write(rec(`m${i}`, 100));
				sink.flush!();
			}
			const files = readdirSync(dir).sort();
			expect(files).toContain('curator.jsonl');
			expect(files).toContain('curator.1.jsonl');
			expect(files).toContain('curator.2.jsonl');
			expect(files).toContain('curator.3.jsonl');
			// keep=3 → no fourth rotation slot, ever.
			expect(existsSync(join(dir, 'curator.4.jsonl'))).toBe(false);
			// Every line parses back to a LogRecord.
			for (const f of files) {
				const lines = readFileSync(join(dir, f), 'utf8').trim().split('\n');
				for (const line of lines) {
					const parsed = JSON.parse(line) as LogRecord;
					expect(parsed.area).toBe('test');
					expect(parsed.proc).toBe('main');
				}
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('truncates a record that serializes past the per-record cap', () => {
		const dir = mkdtempSync(join(tmpdir(), 'curator-log-'));
		try {
			const sink = fileSink({ dir, name: 'big', maxBytes: 1024 * 1024, keep: 1 });
			sink.write({ ...rec('huge'), data: { blob: 'y'.repeat(20_000) } });
			sink.flush!();
			const line = readFileSync(join(dir, 'big.jsonl'), 'utf8').trim();
			expect(line.length).toBeLessThan(9000);
			const parsed = JSON.parse(line) as LogRecord;
			expect(parsed.data).toMatchObject({ truncated: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('disables itself on fs errors without throwing', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// A dir path that cannot be created (invalid on win32, and the
			// mkdir throw path is the same on posix via embedded NUL).
			const sink = fileSink({ dir: join('\0invalid', 'nope'), name: 'x' });
			expect(() => { sink.write(rec('m')); sink.flush?.(); }).not.toThrow();
			expect(warn).toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});
});
