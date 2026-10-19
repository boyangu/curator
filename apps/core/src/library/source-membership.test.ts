// `hasSource` / `lacksSource` — the one membership vocabulary over a track's
// sources, where 'rekordbox' resolves to rekordbox_link (rekordbox tracks
// carry no source='rekordbox' source_link) and everything else to source_link.
// The Rekordbox tab root, the grammar's `source:` terms and the SRC-pip
// filters all compile through it. A local link flagged missing_at (the
// watcher saw the file vanish; the row waits as a re-bind hint) is not a
// local source anywhere — not in hasSource, not as a pip, not for the
// file resolvers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';

let dir: string;
let sqlite: Database.Database;
let svc: CoreService;

function seedTrack(id: string, extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id, title: `Title ${id}`, artists: '[]', state: 'unsorted', duration: 300, ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO track (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
}
function link(trackId: string, source: string): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES (?, ?, ?, ?)`).run(`${source}-${trackId}`, trackId, source, `${source}:${trackId}`);
}
function fileLink(trackId: string, filePath: string, missingAt: number | null = null): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, missing_at) VALUES (?, ?, 'local', ?, ?, ?)`)
		.run(`local-${trackId}`, trackId, filePath, filePath, missingAt);
}
function rbLink(trackId: string): void {
	sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES (?, ?, 1, 1, 1)`).run(trackId, `rb-${trackId}`);
}
const idsOf = async (filter: Parameters<CoreService['getTracks']>[0]): Promise<string[]> =>
	(await svc.getTracks(filter, { column: 'title', dir: 'asc' })).map((t) => t.id);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-source-membership-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	sqlite = new Database(dbPath);
	svc = createCoreService(dbPath, { peaksDir: join(dir, 'peaks') });
	// a: Spotify only.  b: in rekordbox with its file.  c: a file rekordbox
	// doesn't have yet.  d: in rekordbox, file pointer pruned (rb only).
	// e: a deleted local file — hidden from every scope.  f: a file the
	// watcher saw vanish — its link is kept flagged missing_at as a re-bind
	// hint, so it is in the library but has no local source.
	seedTrack('a'); link('a', 'spotify');
	seedTrack('b'); link('b', 'local'); rbLink('b');
	seedTrack('c'); fileLink('c', 'c:/music/c.flac');
	seedTrack('d'); link('d', 'spotify'); rbLink('d');
	seedTrack('e', { deleted_at: 1 }); link('e', 'local');
	seedTrack('f'); fileLink('f', 'c:/music/f.flac', Date.now());
});
afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sibling DB handles on Windows */ }
});

describe('hasSource / lacksSource', () => {
	it('resolves rekordbox to rekordbox_link and other sources to source_link', async () => {
		expect(await idsOf({ hasSource: 'rekordbox' })).toEqual(['b', 'd']);
		expect(await idsOf({ hasSource: 'spotify' })).toEqual(['a', 'd']);
		expect(await idsOf({ hasSource: 'local' })).toEqual(['b', 'c']);
		expect(await idsOf({ lacksSource: 'rekordbox' })).toEqual(['a', 'c', 'f']);
		expect(await idsOf({ lacksSource: 'spotify' })).toEqual(['b', 'c', 'f']);
	});

	it('an array is any-of — the Rekordbox tab root is the collection plus local files', async () => {
		expect(await idsOf({ hasSource: ['rekordbox', 'local'] })).toEqual(['b', 'c', 'd']);
		expect(await idsOf({ hasSource: ['spotify', 'local'] })).toEqual(['a', 'b', 'c', 'd']);
		// Empty list means no restriction rather than an impossible one.
		expect(await idsOf({ hasSource: [] })).toEqual(['a', 'b', 'c', 'd', 'f']);
	});

	it('composes: a file rekordbox does not have yet', async () => {
		expect(await idsOf({ hasSource: 'local', lacksSource: 'rekordbox' })).toEqual(['c']);
		expect(await idsOf({ hasSource: ['rekordbox', 'local'], lacksSource: 'rekordbox' })).toEqual(['c']);
		// Same predicate on the id-only read (play-all / select-all).
		expect(await svc.getTrackIds({ hasSource: 'local', lacksSource: 'rekordbox' })).toEqual(['c']);
	});

	it('decorates rekordbox membership into the row sources the renderer pips read', async () => {
		const byId = new Map((await svc.getTracks({ hasSource: ['rekordbox', 'local'] })).map((t) => [t.id, [...(t.sources ?? [])].sort()]));
		expect(byId.get('b')).toEqual(['local', 'rekordbox']);
		expect(byId.get('c')).toEqual(['local']);
		expect(byId.get('d')).toEqual(['rekordbox', 'spotify']);
	});
});

describe('a local link flagged missing_at', () => {
	it('is not a local source: hasSource skips it, lacksSource keeps it, no pip', async () => {
		expect(await idsOf({ hasSource: 'local' })).toEqual(['b', 'c']);
		expect(await idsOf({ lacksSource: 'local' })).toEqual(['a', 'd', 'f']);
		expect(await svc.getTrackIds({ hasSource: 'local' })).toEqual(['b', 'c']);
		const byId = new Map((await svc.getTracks({ ids: ['c', 'f'] })).map((t) => [t.id, t.sources ?? []]));
		expect(byId.get('c')).toEqual(['local']);
		expect(byId.get('f')).toEqual([]);
	});

	it('resolves to no file, by path and by track', async () => {
		expect(await svc.resolveLocalFile('c:/music/c.flac')).toMatchObject({ path: 'c:/music/c.flac' });
		expect(await svc.getLocalFileForTrack('c')).toMatchObject({ path: 'c:/music/c.flac' });
		expect(await svc.resolveLocalFile('c:/music/f.flac')).toBeNull();
		expect(await svc.getLocalFileForTrack('f')).toBeNull();
	});

	it('is a local source again once the watcher clears missing_at (re-bind)', async () => {
		sqlite.prepare(`UPDATE source_link SET missing_at = NULL WHERE track_id = 'f'`).run();
		expect(await idsOf({ hasSource: 'local' })).toEqual(['b', 'c', 'f']);
		expect(await svc.getLocalFileForTrack('f')).toMatchObject({ path: 'c:/music/f.flac' });
	});
});
