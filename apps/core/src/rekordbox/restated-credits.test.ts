// A pull with no baseline (first link, second desktop, "Sync Everything")
// must not re-derive credits from the Title/Artist strings Curator itself
// composed for rekordbox (importer.ts withoutRestatedCredits). The e2e run of
// 2026-10-24 found the joiner's first link turning "Kade Lumi, Nessa Brook" +
// "Paper Lantern (Orin Vale & Teo Mar Remix)" into four credits, and the push then
// sent "Kade Lumi, Nessa Brook, Orin Vale, Teo Mar" and a doubled title.
// Real importer + exporter, migrated temp DB, stub sidecar — never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { artistKey } from '@curator/shared';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxImporter, type RunImportOptions } from './importer.js';
import { RekordboxExporter } from './exporter.js';
import type { RekordboxSidecar, WriteOp } from './sidecar.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

const FILE = 'c:/music/one.flac';

function stubSidecar(rows: Array<Record<string, unknown>>): RekordboxSidecar {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async () => {
			for (const row of rows) emitter.emit('event', { event: 'track', frame: { row } });
			return { watermarks: {}, cancelled: false };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
}

async function pull(row: Record<string, unknown>, overwriteCurator = false): Promise<void> {
	const opts: RunImportOptions = {
		mode: 'full',
		overwriteCurator,
		flags: { syncTracks: true, syncPlaylists: false, syncMyTags: false, syncCuesGridsPhrases: false, syncWaveformPeaks: false, syncHistory: false },
		dbPath: join(dir, 'master.db'), // never opened — stub sidecar
		peaksDir: join(dir, 'peaks'),
	};
	await new RekordboxImporter(db, stubSidecar([row])).runImport(opts);
}

function pushFields(): Extract<WriteOp, { kind: 'track' }>['fields'] | undefined {
	const exporter = new RekordboxExporter(db, {} as never);
	const opts = { targetKind: 'updates' as const, targetIds: [], flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false }, dbPath: join(dir, 'master.db') };
	const t = (exporter as unknown as { resolveTargets: (o: typeof opts) => { linked: unknown[]; playlistOrders: unknown[] } }).resolveTargets(opts);
	const ops = (exporter as unknown as { buildWriteOps: (o: typeof opts, l: unknown, p: unknown) => { ops: WriteOp[] } }).buildWriteOps(opts, t.linked, t.playlistOrders).ops;
	return ops.find((o): o is Extract<WriteOp, { kind: 'track' }> => o.kind === 'track')?.fields;
}

function seed(title: string, artists: unknown[], known: string[]): void {
	sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state, updated_at) VALUES ('t1', 'rec-1', ?, ?, 'unsorted', 0)`).run(title, JSON.stringify(artists));
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES ('sl1', 't1', 'local', ?, ?)`).run(FILE, FILE);
	// The artist table is what the remixer reader resolves names against.
	for (const n of known) sqlite.prepare(`INSERT INTO artist (id, name, name_ascii) VALUES (?, ?, ?)`).run(`a-${artistKey(n)}`, n, artistKey(n));
}

const rbRow = (title: string, artist: string) => ({
	rb_content_id: 'C1', rb_local_usn: 11, rb_local_deleted: false,
	rb_updated_at_ms: Date.parse('2026-09-01T10:00:00Z'), rb_added_at_ms: null, file_path: FILE,
	title, artist, album: null, genre: null, label: null,
	bpm: null, key_camelot: null, key_musical: null, color_label: null,
	rating: null, comment: null, play_count: null, last_played_at_ms: null, duration_sec: 300,
});

const artistsOf = (): unknown => JSON.parse(sqlite.prepare(`SELECT artists FROM track WHERE id = 't1'`).pluck().get() as string);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-restated-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('a pull without a baseline restating what Curator composed', () => {
	it('keeps the credits, and the push sends rekordbox its own strings back', async () => {
		const artists = [{ name: 'Kade Lumi' }, { name: 'Nessa Brook' }];
		seed('Paper Lantern (Orin Vale & Teo Mar Remix)', artists, ['Orin Vale', 'Teo Mar']);
		await pull(rbRow('Paper Lantern (Orin Vale & Teo Mar Remix)', 'Kade Lumi, Nessa Brook'));
		expect(artistsOf()).toEqual(artists);
		expect(pushFields()).toMatchObject({ Title: 'Paper Lantern (Orin Vale & Teo Mar Remix)', ArtistName: 'Kade Lumi, Nessa Brook' });
	});

	it('keeps a remixer credit the composed artist line lists as a plain name', async () => {
		const artists = [{ name: 'Eli & Fur' }, { name: 'Patrice', role: 'remixer' }];
		seed('Fuse (Patrice Bäumel Extended Remix)', artists, ['Patrice', 'Patrice Bäumel']);
		await pull(rbRow('Fuse (Patrice Bäumel Extended Remix)', 'Eli & Fur, Patrice'));
		expect(artistsOf()).toEqual(artists);
		expect(pushFields()).toMatchObject({ ArtistName: 'Eli & Fur, Patrice' });
	});

	it('"Sync Everything" leaves them alone too', async () => {
		const artists = [{ name: 'Eli & Fur' }, { name: 'Patrice', role: 'remixer' }];
		seed('Fuse (Patrice Bäumel Extended Remix)', artists, ['Patrice', 'Patrice Bäumel']);
		await pull(rbRow('Fuse (Patrice Bäumel Extended Remix)', 'Eli & Fur, Patrice'), true);
		expect(artistsOf()).toEqual(artists);
	});

	it('still takes an artist rekordbox actually changed', async () => {
		seed('One', [{ name: 'A' }], []);
		await pull(rbRow('One', 'A, B'));
		expect(artistsOf()).toEqual([{ name: 'A' }, { name: 'B' }]);
	});
});
