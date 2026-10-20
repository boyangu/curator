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

describe('connection string errors', () => {
	// A Fly secret holding only the password crashed cloud-v0.1.2 at boot and
	// postgres.js printed the whole value into the log stream. Neither path may
	// echo the value again.
	const SECRET = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';
	const bad = [SECRET, `\x16${SECRET}`, `mysql://u:${SECRET}@h/db`, `postgresql://:${SECRET}@/db`];

	it('never puts the value in the error', async () => {
		const { assertConnectionString, createPostgresDb } = await import('./db.js');
		for (const v of bad) {
			for (const fn of [() => assertConnectionString(v), () => createPostgresDb(v)]) {
				let message = '';
				try {
					fn();
				} catch (e) {
					message = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`;
				}
				expect(message).not.toBe('');
				expect(message).not.toContain(SECRET);
			}
		}
	});

	it('loadConfig reports DATABASE_URL without the value', async () => {
		const { loadConfig } = await import('../config.js');
		expect(() => loadConfig({ DATABASE_URL: SECRET, SUPABASE_URL: 'https://x.supabase.co' })).toThrow(/DATABASE_URL: .*value not shown/);
		try {
			loadConfig({ DATABASE_URL: SECRET, SUPABASE_URL: 'https://x.supabase.co' });
		} catch (e) {
			expect(String(e)).not.toContain(SECRET);
		}
	});

	it('accepts a real-shaped connection string', async () => {
		const { assertConnectionString } = await import('./db.js');
		expect(() => assertConnectionString('postgresql://curator_api.ref:pw@aws-0-x.pooler.supabase.com:6543/postgres')).not.toThrow();
	});
});
