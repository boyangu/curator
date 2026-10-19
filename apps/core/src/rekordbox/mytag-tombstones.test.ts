// Tombstoned rekordbox MyTags reaching the importer (rb_local_deleted=1 —
// the reader emits them on every pass). Per dead tag: merge into a live
// same-name rb tag, prune when Curator has no memberships, keep when still
// curated (the push revives it). Real importer + migrated temp DB, stub
// sidecar replaying 'mytag' frames — same harness shape as history-import.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { RekordboxImporter, type RunImportOptions } from './importer.js';
import type { RekordboxSidecar } from './sidecar.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

interface MyTagFrame { rb_tag_id: string; rb_local_usn: number; rb_local_deleted: boolean; name: string; color: string | null; tracks: string[] }

function stubSidecar(frames: MyTagFrame[]): RekordboxSidecar {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		open: async () => ({ ok: true }),
		scan: async () => {
			for (const f of frames) emitter.emit('event', { event: 'mytag', frame: { row: f } });
			return { watermarks: {}, cancelled: false };
		},
		cancel: async () => { /* */ },
	}) as unknown as RekordboxSidecar;
}

async function runImport(frames: MyTagFrame[]): Promise<{ myTagsUpserted: number; myTagsMerged: number; myTagsPruned: number }> {
	const importer = new RekordboxImporter(db, stubSidecar(frames));
	const opts: RunImportOptions = {
		mode: 'full',
		flags: { syncTracks: false, syncPlaylists: false, syncMyTags: true, syncCuesGridsPhrases: false, syncWaveformPeaks: false, syncHistory: false },
		dbPath: join(dir, 'master.db'),
		peaksDir: join(dir, 'peaks'),
	};
	return importer.runImport(opts);
}

function seedTrack(id: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, updated_at) VALUES (?, ?, '[]', 'unsorted', 1000)`).run(id, id);
}
function seedTag(id: string, name: string): void {
	sqlite.prepare(`INSERT INTO tag (id, name, kind) VALUES (?, ?, 'user')`).run(id, name);
}
function tagTrack(trackId: string, tagId: string): void {
	sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id) VALUES (?, ?)`).run(trackId, tagId);
}
const tagIds = (): string[] => (sqlite.prepare(`SELECT id FROM tag WHERE id LIKE 'rb_%' ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
const membersOf = (tagId: string): string[] => (sqlite.prepare(`SELECT track_id FROM track_tag WHERE tag_id = ? ORDER BY track_id`).all(tagId) as Array<{ track_id: string }>).map((r) => r.track_id);
const updatedAt = (trackId: string): number => (sqlite.prepare(`SELECT updated_at FROM track WHERE id = ?`).get(trackId) as { updated_at: number }).updated_at;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-mytag-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
});

const dead = (id: string, name: string): MyTagFrame => ({ rb_tag_id: id, rb_local_usn: 1, rb_local_deleted: true, name, color: null, tracks: [] });
const live = (id: string, name: string): MyTagFrame => ({ rb_tag_id: id, rb_local_usn: 1, rb_local_deleted: false, name, color: null, tracks: [] });

describe('importer: tombstoned MyTags', () => {
	it('merges a dead tag into the live same-name tag, dirtying the moved tracks', async () => {
		seedTrack('t1'); seedTrack('t2'); seedTrack('t3');
		seedTag('rb_old', 'vocal'); seedTag('rb_new', 'vocal');
		tagTrack('t1', 'rb_old'); tagTrack('t2', 'rb_old'); tagTrack('t2', 'rb_new'); tagTrack('t3', 'rb_new');
		const totals = await runImport([live('new', 'vocal'), dead('old', 'vocal')]);
		expect(totals.myTagsMerged).toBe(1);
		expect(tagIds()).toEqual(['rb_new']);
		expect(membersOf('rb_new')).toEqual(['t1', 't2', 't3']);
		expect(updatedAt('t1')).toBeGreaterThan(1000);
		expect(updatedAt('t3')).toBe(1000); // untouched track stays clean
	});

	it('matches names case-insensitively (stock "Vocal" vs the user\'s "vocal")', async () => {
		seedTrack('t1');
		seedTag('rb_stock', 'Vocal'); seedTag('rb_user', 'vocal');
		tagTrack('t1', 'rb_stock');
		const totals = await runImport([live('user', 'vocal'), dead('stock', 'Vocal')]);
		expect(totals.myTagsMerged).toBe(1);
		expect(tagIds()).toEqual(['rb_user']);
		expect(membersOf('rb_user')).toEqual(['t1']);
	});

	it('prunes a dead tag with no memberships', async () => {
		seedTag('rb_trap', 'Trap');
		const totals = await runImport([dead('trap', 'Trap')]);
		expect(totals.myTagsPruned).toBe(1);
		expect(tagIds()).toEqual([]);
	});

	it('keeps a dead tag the user still curates with (revived on push)', async () => {
		seedTrack('t1'); seedTag('rb_ctl', 'controlling'); tagTrack('t1', 'rb_ctl');
		const totals = await runImport([dead('ctl', 'controlling')]);
		expect(totals.myTagsMerged).toBe(0);
		expect(totals.myTagsPruned).toBe(0);
		expect(tagIds()).toEqual(['rb_ctl']);
		expect(membersOf('rb_ctl')).toEqual(['t1']);
		expect(updatedAt('t1')).toBe(1000);
	});

	it('never merges a dead tag into another dead tag, and ignores tags Curator never had', async () => {
		seedTrack('t1'); seedTag('rb_a', 'lounge'); tagTrack('t1', 'rb_a');
		const totals = await runImport([dead('a', 'lounge'), dead('b', 'Lounge'), dead('zzz', 'Never Imported')]);
		expect(totals.myTagsMerged).toBe(0);
		expect(tagIds()).toEqual(['rb_a']);
	});

	it('a dead tag delta carries no membership and never re-seeds Curator', async () => {
		seedTrack('t1'); seedTag('rb_x', 'x');
		const totals = await runImport([{ ...dead('x', 'x'), tracks: ['C1'] }]);
		expect(totals.myTagsUpserted).toBe(0);
		expect(membersOf('rb_x')).toEqual([]);
		expect(tagIds()).toEqual([]); // pruned: no memberships
	});
});
