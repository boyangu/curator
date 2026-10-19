// Re-syncing an unchanged Spotify / Tidal playlist must emit nothing to the
// op log: playlist meta (create / rename), track upserts (library_track
// create + claims) and membership (reconcileMembership) each write ops only
// for what changed. Drives the providers' own per-playlist write path with
// synthetic payloads on a migrated temp DB — no network, no real account.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SpotifyPlaylist, SpotifyPlaylistTrack } from '@curator/spotify';
import type { TidalPlaylist, TidalPlaylistItem } from '@curator/tidal';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { SpotifySync } from './spotify.js';
import { TidalSync } from './tidal.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-resync-'));
	const p = join(dir, 'c.db');
	migrate(p);
	({ db, sqlite } = createDb(p));
});
afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

const outboxCount = (): number => (sqlite.prepare(`SELECT count(*) AS n FROM sync_outbox`).get() as { n: number }).n;
const outboxSince = (n: number): string[] =>
	(sqlite.prepare(`SELECT entity, kind FROM sync_outbox ORDER BY seq_local`).all() as Array<{ entity: string; kind: string }>).slice(n).map((o) => `${o.entity}.${o.kind}`);

type Writer = {
	upsertPlaylistMeta(pl: unknown): string;
	replacePlaylistTracks(id: string, items: unknown[]): number;
};

function spotifyPlaylist(name: string): SpotifyPlaylist {
	return {
		id: 'sp-pl', name, description: null, owner: { id: 'me', display_name: 'Me' }, images: [],
		tracks: { total: 3 }, collaborative: false, public: false, snapshot_id: 's1', external_urls: { spotify: 'https://open.spotify.com/playlist/sp-pl' },
	};
}
function spotifyItems(order: number[]): SpotifyPlaylistTrack[] {
	return order.map((n) => ({
		added_at: '2026-08-01T10:00:00Z',
		added_by: { id: 'me' },
		is_local: false,
		track: {
			id: `sp${n}`, name: `Song ${n}`, duration_ms: 300_000 + n, explicit: false,
			external_ids: { isrc: `GBAAA26000${n}` },
			artists: [{ id: `ar${n}`, name: `Artist ${n}` }],
			album: { id: `al${n}`, name: `Album ${n}`, release_date: '2026-01-01', images: [] },
		},
	}));
}

function tidalPlaylist(name: string): TidalPlaylist {
	return { id: 'td-pl', name, description: null, numberOfItems: 3, playlistType: 'USER', accessType: 'PRIVATE', lastModifiedAt: '2026-08-01T10:00:00Z' };
}
function tidalItems(order: number[]): TidalPlaylistItem[] {
	return order.map((n) => ({
		addedAt: '2026-08-01T10:00:00Z',
		track: {
			id: `td${n}`, title: `Tune ${n}`, version: null, duration: 280 + n, isrc: `USBBB26000${n}`, bpm: 124, key: 'A', keyScale: 'MINOR',
			explicit: false, artists: [{ id: `ta${n}`, name: `Band ${n}`, main: true }], album: { id: `tal${n}`, title: `Record ${n}` }, url: null,
		},
	}));
}

describe('streaming re-sync emits nothing when nothing changed', () => {
	it('Spotify: playlist meta, track upserts and membership', () => {
		const sync = new SpotifySync(db, {} as never) as unknown as Writer;
		const run = (name: string, order: number[]): void => {
			const id = sync.upsertPlaylistMeta(spotifyPlaylist(name));
			sync.replacePlaylistTracks(id, spotifyItems(order));
		};
		run('Mix', [1, 2, 3]);
		const first = outboxSince(0);
		expect(first).toEqual(expect.arrayContaining(['playlist.create', 'library_track.create', 'recording_claim.add', 'playlist_track.add']));
		const n = outboxCount();
		run('Mix', [1, 2, 3]);
		expect(outboxSince(n)).toEqual([]);
		// A real change upstream still lands, and only it.
		run('Mix 2', [1, 3, 2]);
		expect(outboxSince(n)).toEqual(['playlist.rename', 'playlist_track.move']);
	});

	it('Tidal: playlist meta, track upserts and membership', () => {
		const sync = new TidalSync(db, {} as never) as unknown as Writer;
		const run = (name: string, order: number[]): void => {
			const id = sync.upsertPlaylistMeta(tidalPlaylist(name));
			sync.replacePlaylistTracks(id, tidalItems(order));
		};
		run('Crate', [1, 2, 3]);
		expect(outboxSince(0)).toEqual(expect.arrayContaining(['playlist.create', 'library_track.create', 'recording_claim.add', 'playlist_track.add']));
		const n = outboxCount();
		run('Crate', [1, 2, 3]);
		expect(outboxSince(n)).toEqual([]);
		run('Crate', [1, 2]);
		expect(outboxSince(n)).toEqual(['playlist_track.remove']);
	});
});
