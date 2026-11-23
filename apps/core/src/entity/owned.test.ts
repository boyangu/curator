// The Owned side of an entity page through the real service (a temp library,
// no cloud): Owned is local files only, a label is every spelling that folds
// alike, and the header's filter is what `getTracks` lists.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '@curator/sync-core/db/migrate';
import { createCoreService, type CoreService } from '../service.js';
import { tmpDir, type TmpDir } from '@curator/sync-core/test-support/tmp';

let tmp: TmpDir;
let sqlite: Database.Database;
let svc: CoreService;

function seedTrack(id: string, label: string, source: 'local' | 'spotify'): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, duration, label, label_ascii, genre) VALUES (?, ?, '[]', 'unsorted', 300, ?, ?, 'Melodic House')`)
		.run(id, `Title ${id}`, label, label.toLowerCase().trim());
	if (source === 'local') {
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`).run(`l-${id}`, id, `c:/m/${id}.flac`, `c:/m/${id}.flac`);
	} else {
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES (?, ?, 'spotify', ?)`).run(`s-${id}`, id, `sp:${id}`);
	}
}

beforeEach(() => {
	tmp = tmpDir('curator-entity-owned-');
	const dbPath = join(tmp.path, 'curator.db');
	migrate(dbPath);
	sqlite = tmp.track(new Database(dbPath));
	svc = tmp.track(createCoreService(dbPath, { peaksDir: join(tmp.path, 'peaks') }));
	seedTrack('a', 'Anjunadeep', 'local');
	seedTrack('b', 'ANJUNADEEP', 'local');
	seedTrack('c', 'Anjunadeep', 'spotify');
	seedTrack('d', 'Anjunadeep Explorations', 'local');
});
afterEach(async () => {
	await tmp.cleanup();
});

describe('entity page, Owned side', () => {
	it("counts and lists a label's local files only, across the spellings that fold alike", async () => {
		const h = await svc.getEntityPage({ kind: 'label', name: 'Anjunadeep' });
		// No cloud: the library's side is the whole page.
		expect(h.world).toMatchObject({ available: false, reason: 'signed_out' });
		expect(h.owned).toEqual({ count: 2, filter: { labelFolds: ['anjunadeep'], hasSource: ['rekordbox', 'local'] } });
		const rows = await svc.getTracks(h.owned.filter!, { column: 'title', dir: 'asc' });
		// c is in the library on Spotify only; d is another label.
		expect(rows.map((t) => t.id)).toEqual(['a', 'b']);
		// What the label is (genres, artists) is the catalogue's to say: none here.
		expect(h).toMatchObject({ genres: [], artists: [] });
	});

	it('keeps the primary streaming service the user chose; unset, it follows the connected account', async () => {
		expect(await svc.getPrimaryStreaming()).toEqual({ service: null, stored: false });
		await svc.setPrimaryStreaming('tidal');
		expect(await svc.getPrimaryStreaming()).toEqual({ service: 'tidal', stored: true });
	});
});
