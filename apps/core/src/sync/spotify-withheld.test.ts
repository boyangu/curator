// A followed playlist whose items Spotify starts withholding (the 2026
// Development Mode rule: only owners and collaborators see them) must keep its
// rows. Read as "emptied", a sync would remove every one of them locally — and
// from rekordbox on the next push. Fake Spotify over fetch, migrated temp DB.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { SpotifySync } from './spotify.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
	process.env['SPOTIFY_LOG'] = 'off';
	dir = mkdtempSync(join(tmpdir(), 'curator-withheld-'));
	const p = join(dir, 'c.db');
	migrate(p);
	({ db, sqlite } = createDb(p));
});
afterEach(() => {
	vi.unstubAllGlobals();
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

const entry = (n: number) => ({
	added_at: '2026-10-01T10:00:00Z', added_by: { id: 'curator-x' }, is_local: false,
	track: {
		id: `sp${n}`, name: `Song ${n}`, duration_ms: 300_000 + n, explicit: false, external_ids: { isrc: `GBAAA26000${n}` },
		artists: [{ id: `ar${n}`, name: `Artist ${n}` }], album: { id: `al${n}`, name: `Album ${n}`, release_date: '2026-01-01', images: [] },
	},
});

function serve(mode: 'older' | 'withheld'): void {
	vi.stubGlobal('fetch', async (input: string) => {
		const u = new URL(input);
		const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
		const pl = {
			id: 'followed', name: 'Followed', description: null, owner: { id: 'curator-x', display_name: 'X' }, images: [],
			collaborative: false, public: true, external_urls: { spotify: 'https://open.spotify.com/playlist/followed' },
			...(mode === 'older' ? { snapshot_id: 's1', tracks: { total: 2 } } : { snapshot_id: 's2' }),
		};
		if (u.pathname === '/v1/me/playlists') return json(200, { items: [pl], next: null, total: 1 });
		if (u.pathname === '/v1/me/tracks') return json(200, { items: [], next: null, total: 0 });
		if (mode === 'older' && u.pathname === '/v1/playlists/followed/tracks') return json(200, { items: [entry(1), entry(2)], next: null, total: 2 });
		if (mode === 'withheld' && u.pathname === '/v1/playlists/followed/items') return json(403, { error: { status: 403 } });
		return json(404, { error: { status: 404 } });
	});
}

describe('Spotify sync with withheld playlist items', () => {
	it('keeps the rows, flags the playlist and finishes the run', async () => {
		const auth = { getSpotifyAccessToken: async () => 'tok' } as never;
		serve('older');
		await new SpotifySync(db, auth).run();
		const rows = () => (sqlite.prepare(
			`SELECT count(*) AS n FROM playlist_track pt JOIN playlist p ON p.id = pt.playlist_id WHERE p.source_id = 'followed'`,
		).get() as { n: number }).n;
		expect(rows()).toBe(2);

		serve('withheld');
		const res = await new SpotifySync(db, auth).run();
		expect(res.playlists).toBe(2);
		expect(rows()).toBe(2);
		const pl = sqlite.prepare(`SELECT sync_status, sync_error, track_count, sync_cursor FROM playlist WHERE source_id = 'followed'`).get() as {
			sync_status: string; sync_error: string; track_count: number; sync_cursor: string;
		};
		expect(pl.sync_status).toBe('error');
		expect(pl.sync_error).toMatch(/no longer shares/);
		expect(pl.track_count).toBe(2);
		// The cursor stays on the snapshot whose rows we hold, so a later run retries.
		expect(pl.sync_cursor).toBe('s1');
	});
});
