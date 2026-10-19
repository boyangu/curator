// First-link lifecycle for a Curator-first track: downloaded + rated + tagged
// in Curator, THEN its file imported into rekordbox, then a two-way sync.
// The 2026-09-15 incident: the bootstrap pull (no rekordbox_link yet → rb
// wins by default) let rb's rating 0 overwrite Curator's stars, and the
// "Sync updates" scope — track.updatedAt > rbUpdatedAtSeen — would not
// even have pushed the track, because the pull seeds `seen` with rb's
// import time, which is newer than any curation that preceded the download.
// Both halves are pinned here against the REAL importer/exporter on a
// migrated temp DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxExporter } from './exporter.js';
import { RekordboxImporter } from './importer.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

const FILE = 'c:/music/a.flac';

function seedLocalTrack(id: string, fields: { rating: number | null; updatedAt: number; comment?: string | null }): void {
	sqlite.prepare(
		`INSERT INTO track (id, title, artists, state, rating, comment, updated_at) VALUES (?, ?, '[]', 'unsorted', ?, ?, ?)`,
	).run(id, id, fields.rating, fields.comment ?? null, fields.updatedAt);
	sqlite.prepare(
		`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`,
	).run(`sl-${id}`, id, FILE, FILE);
}

function rbDelta(over: Partial<{ rating: number | null; comment: string | null; rb_updated_at_ms: number }> = {}) {
	return {
		rb_content_id: 'C1',
		rb_local_usn: 10,
		rb_local_deleted: false,
		rb_updated_at_ms: 5_000,
		rb_added_at_ms: null,
		file_path: FILE,
		title: 'a',
		artist: null,
		album: null,
		genre: null,
		label: null,
		bpm: null,
		key_camelot: null,
		key_musical: null,
		color_label: null,
		rating: 0,
		comment: null,
		play_count: null,
		last_played_at_ms: null,
		duration_sec: null,
		...over,
	};
}

function pull(row: ReturnType<typeof rbDelta>): void {
	const importer = new RekordboxImporter(db, {} as never);
	const totals = new Proxy({}, { get: () => 0, set: () => true });
	(importer as unknown as { applyTrackDelta: (r: unknown, f: unknown, m: Map<string, string>, t: unknown) => void })
		.applyTrackDelta(row, {}, new Map(), totals);
}

function updatesScope(): string[] {
	const exporter = new RekordboxExporter(db, {} as never);
	const opts = {
		targetKind: 'updates' as const,
		targetIds: [],
		flags: { syncMetadata: true, syncCues: false, syncTags: false, syncPlaylist: false },
		dbPath,
	};
	const targets = (exporter as unknown as { resolveTargets: (o: typeof opts) => { linked: Array<{ curatorTrackId: string }> } }).resolveTargets(opts);
	return targets.linked.map((l) => l.curatorTrackId);
}

function trackRow(id: string): { rating: number | null; comment: string | null } {
	return sqlite.prepare(`SELECT rating, comment FROM track WHERE id = ?`).get(id) as { rating: number | null; comment: string | null };
}

function linkRow(id: string): { fields_seen: string; pushed_at: number | null; rb_updated_at_seen: number | null } | undefined {
	return sqlite.prepare(`SELECT fields_seen, pushed_at, rb_updated_at_seen FROM rekordbox_link WHERE track_id = ?`).get(id) as
		| { fields_seen: string; pushed_at: number | null; rb_updated_at_seen: number | null }
		| undefined;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-bootstrap-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('bootstrap pull (no rekordbox_link yet)', () => {
	it('keeps Curator stars when rb reports the unrated sentinel 0, but seeds the baseline honestly', () => {
		seedLocalTrack('t1', { rating: 5, updatedAt: 1_000, comment: 'curated' });
		pull(rbDelta({ rating: 0, comment: null }));
		expect(trackRow('t1')).toEqual({ rating: 5, comment: 'curated' });
		const link = linkRow('t1')!;
		expect(link).toBeTruthy();
		// The snapshot records what rb actually holds (0) so the next pull's
		// three-way diff sees "ours changed vs base" and the push writes 5.
		expect(JSON.parse(link.fields_seen).rating).toBe(0);
		expect(link.pushed_at).toBeNull();
		expect(link.rb_updated_at_seen).toBe(5_000);
	});

	it('still adopts a real rb rating on first link (rb-seeded libraries)', () => {
		seedLocalTrack('t1', { rating: null, updatedAt: 1_000 });
		pull(rbDelta({ rating: 4 }));
		expect(trackRow('t1').rating).toBe(4);
	});

	it('does not touch pushed_at on a re-pull of an existing link', () => {
		seedLocalTrack('t1', { rating: 5, updatedAt: 1_000 });
		pull(rbDelta());
		sqlite.prepare(`UPDATE rekordbox_link SET pushed_at = 7000 WHERE track_id = 't1'`).run();
		pull(rbDelta({ rb_updated_at_ms: 9_000 }));
		expect(linkRow('t1')!.pushed_at).toBe(7_000);
	});
});

describe('"Sync updates" scope for never-pushed links', () => {
	it('includes a fresh link even though Curator edits predate rb import time', () => {
		seedLocalTrack('t1', { rating: 5, updatedAt: 1_000 }); // curated before the rb import (5_000)
		pull(rbDelta());
		expect(updatesScope()).toEqual(['t1']);
	});

	it('drops out once the exporter has pushed it (pushed_at set) and nothing changed since', () => {
		seedLocalTrack('t1', { rating: 5, updatedAt: 1_000 });
		pull(rbDelta());
		sqlite.prepare(`UPDATE rekordbox_link SET pushed_at = 6000 WHERE track_id = 't1'`).run();
		expect(updatesScope()).toEqual([]);
		// …and comes back when Curator edits after the seen baseline.
		sqlite.prepare(`UPDATE track SET updated_at = 9000 WHERE id = 't1'`).run();
		expect(updatesScope()).toEqual(['t1']);
	});
});

describe('migration', () => {
	it('grandfathers existing links as pushed (pushed_at = last_synced_at)', () => {
		// Simulate a pre-upgrade row: drop the column, insert, re-run migrate.
		sqlite.exec(`ALTER TABLE rekordbox_link DROP COLUMN pushed_at`);
		sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('t1', 't1', '[]', 'unsorted')`).run();
		sqlite.prepare(
			`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES ('t1', 'C1', 0, 0, 4242)`,
		).run();
		sqlite.close();
		migrate(dbPath);
		({ db, sqlite } = createDb(dbPath));
		expect(linkRow('t1')!.pushed_at).toBe(4242);
	});
});
