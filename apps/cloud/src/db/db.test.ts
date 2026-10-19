// Guards the one place the two drivers disagree on parameters (db.ts): the
// PGlite suite cannot see postgres.js re-encoding a jsonb parameter, which is
// how cloud-v0.1.0 shipped with every access-log flush failing in production.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		// src/test is the PGlite harness, not production SQL.
		if (statSync(p).isDirectory()) return name === 'test' ? [] : sourceFiles(p);
		return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
	});
}

describe('jsonb parameters', () => {
	it('are always typed as text first in the server SQL', () => {
		const bare: string[] = [];
		for (const file of sourceFiles(SRC)) {
			readFileSync(file, 'utf8')
				.split('\n')
				.forEach((line, i) => {
					// `$1::jsonb` (or ::json) without a preceding ::text.
					if (/\$\d+::jsonb?\b/.test(line)) bare.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
				});
		}
		expect(bare).toEqual([]);
	});

	it('would be double-encoded by postgres.js, which is why the text cast exists', () => {
		// No connection is made: postgres.js connects lazily.
		const sql = postgres('postgres://nobody@127.0.0.1:1/none', { prepare: false });
		const serializers = (sql.options as unknown as { serializers: Record<number, ((x: unknown) => string) | undefined> }).serializers;
		const JSONB = 3802;
		const TEXT = 25;
		// A pre-encoded array becomes a JSON string scalar if typed as jsonb...
		expect(serializers[JSONB]?.('[{"a":1}]')).toBe('"[{\\"a\\":1}]"');
		// ...and passes through untouched when typed as text.
		const asText = serializers[TEXT] ?? ((x: unknown) => String(x));
		expect(asText('[{"a":1}]')).toBe('[{"a":1}]');
		void sql.end({ timeout: 0 });
	});
});
