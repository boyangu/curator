// The token store's seal at rest (store.ts), on a migrated temp DB with a
// stand-in sealer: what reaches the `value` column, who can read it back, and
// the one-time sealing of rows stored before it existed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '@curator/sync-core/db/client';
import { migrate } from '@curator/sync-core/db/migrate';
import { tmpDir, type TmpDir } from '@curator/sync-core/test-support/tmp';
import { createCoreService } from '../service.js';
import { AuthService } from './service.js';
import { TokenStore, type TokenSealer } from './store.js';

// Reversible and keyed, like the real one: another key's seal does not open.
function sealer(key: string): TokenSealer {
	return {
		seal: (plain) => Buffer.from(`${key}|${plain}`).toString('base64'),
		open: (sealed) => {
			const [k, ...rest] = Buffer.from(sealed, 'base64').toString().split('|');
			if (k !== key) throw new Error('not sealed with this key');
			return rest.join('|');
		},
	};
}

const opened: TmpDir[] = [];
afterEach(async () => { for (const t of opened.splice(0)) await t.cleanup(); });

function setup() {
	const tmp = tmpDir('curator-token-');
	opened.push(tmp);
	const path = join(tmp.path, 'curator.db');
	migrate(path);
	const { db, sqlite } = createDb(path);
	tmp.track(sqlite);
	const column = (): string[] => sqlite.prepare('SELECT value FROM token ORDER BY source, kind').pluck().all() as string[];
	return { tmp, path, db, sqlite, column };
}

describe('TokenStore', () => {
	it('without a sealer stores and reads plaintext, as headless runs always did', () => {
		const { db, column } = setup();
		const store = new TokenStore(db);
		store.put('spotify', 'refresh', 'user', 'rt-1');
		expect(column()).toEqual(['rt-1']);
		expect(store.get('spotify', 'refresh', 'user')?.value).toBe('rt-1');
		expect(store.sealPlaintext()).toBe(0);
	});

	it('with a sealer keeps the token out of the column and reads it back', () => {
		const { db, column } = setup();
		const store = new TokenStore(db, sealer('k1'));
		const expiresAt = new Date(Date.now() + 60_000);
		store.put('spotify', 'access', 'user', 'at-1', { expiresAt, meta: { id: 'me' } });
		store.put('spotify', 'access', 'user', 'at-2', { expiresAt, meta: { id: 'me' } });
		expect(column()).toHaveLength(1);
		expect(column()[0]).toMatch(/^sealed:v1:/);
		expect(column()[0]).not.toContain('at-2');
		expect(store.get('spotify', 'access', 'user')).toMatchObject({ value: 'at-2', expiresAt, meta: { id: 'me' } });
		expect(store.hasUserAuth('spotify')).toBe(true);
	});

	it('reads a sealed row as absent without the sealer, or with another key', () => {
		const { db } = setup();
		new TokenStore(db, sealer('k1')).put('tidal', 'session', 'user', 'tidal-session');
		for (const other of [new TokenStore(db), new TokenStore(db, sealer('k2'))]) {
			expect(other.get('tidal', 'session', 'user')).toBeNull();
			expect(other.hasUserAuth('tidal')).toBe(false);
			expect(other.all()).toEqual([]);
		}
		// Reconnecting writes over the row nobody here could open.
		const again = new TokenStore(db, sealer('k2'));
		again.put('tidal', 'session', 'user', 'new-session');
		expect(again.get('tidal', 'session', 'user')?.value).toBe('new-session');
	});

	it('seals the rows stored in plaintext, once', () => {
		const { db, column } = setup();
		const before = new TokenStore(db);
		before.put('spotify', 'access', 'user', 'at-old', { meta: { id: 'me' } });
		before.put('spotify', 'refresh', 'user', 'rt-old');
		const store = new TokenStore(db, sealer('k1'));
		store.put('tidal', 'refresh', 'user', 'tidal-rt');
		const sealedAlready = column()[2];
		// A plaintext row reads as it is until then.
		expect(store.get('spotify', 'refresh', 'user')?.value).toBe('rt-old');

		expect(store.sealPlaintext()).toBe(2);
		expect(column().every((v) => v.startsWith('sealed:v1:'))).toBe(true);
		expect(column()[2]).toBe(sealedAlready);
		expect(store.get('spotify', 'access', 'user')).toMatchObject({ value: 'at-old', meta: { id: 'me' } });
		expect(store.get('spotify', 'refresh', 'user')?.value).toBe('rt-old');
		expect(store.sealPlaintext()).toBe(0);
	});
});

describe('the backup token sidecar through a sealing store', () => {
	it('exports plaintext for main to encrypt, and seals what a restore puts back', () => {
		const from = setup();
		const auth = new AuthService(from.db, { tokenSealer: sealer('k1') });
		new TokenStore(from.db, sealer('k1')).put('tidal', 'refresh', 'user', 'tidal-rt');
		const rows = auth.exportTokenRows();
		expect(rows.map((r) => r.value)).toEqual(['tidal-rt']);

		const to = setup();
		const restored = new AuthService(to.db, { tokenSealer: sealer('k1') });
		restored.importTokenRows(rows);
		expect(to.column()[0]).toMatch(/^sealed:v1:/);
		expect(new TokenStore(to.db, sealer('k1')).get('tidal', 'refresh', 'user')?.value).toBe('tidal-rt');
	});
});

describe('the first launch with a sealer', () => {
	it('seals what an earlier build stored and leaves no plaintext in the files', async () => {
		const { tmp, path, db, sqlite, column } = setup();
		// Long enough to be found by a byte search, and to move within its page.
		const refresh = `rt-${'r'.repeat(120)}`;
		const access = `at-${'a'.repeat(300)}`;
		const before = new TokenStore(db);
		before.put('spotify', 'access', 'user', access, { meta: { id: 'me', displayName: 'Test DJ' } });
		before.put('spotify', 'refresh', 'user', refresh);
		before.put('spotify', 'refresh', 'user', refresh);

		const svc = tmp.track(createCoreService(path, { tokenSealer: sealer('k1') }));
		expect(column().every((v) => v.startsWith('sealed:v1:'))).toBe(true);
		expect(svc.auth.getStatus().spotify).toMatchObject({ connected: true, displayName: 'Test DJ' });
		expect(svc.auth.exportTokenRows().map((r) => r.value).sort()).toEqual([access, refresh].sort());
		await svc.close();
		sqlite.close();

		for (const file of [path, `${path}-wal`]) {
			if (!existsSync(file)) continue;
			const bytes = readFileSync(file).toString('latin1');
			expect(bytes.includes(refresh)).toBe(false);
			expect(bytes.includes(access)).toBe(false);
		}

		// The same database opened without the sealer: not connected.
		const headless = tmp.track(createCoreService(path));
		expect(headless.auth.getStatus().spotify.connected).toBe(false);
	});
});
