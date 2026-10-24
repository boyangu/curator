// A generated library for the e2e's own tests: a curator.db (migrate() +
// rows, as core's two-desktop rig seeds them) whose local files exist under
// a temp music folder, and a blank encrypted rekordbox master.db holding the
// same files (py/rb_fixture.py). The master is then linked to it the way the
// real one was: a full rekordbox import through the real sidecar, which
// leaves the two consistent — every field the push writes already equal on
// both sides. Nothing here touches a real library.

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCoreService, createDb, DEFAULT_REKORDBOX_FLAGS, migrate, normalizePath } from '@curator/core';
import { syncTrackArtistsByIdRaw } from '@curator/core/e2e';
import { createLogger } from '@curator/shared/log';
import { rekordboxSidecarSpec, runPythonScript } from './rekordbox.js';

export type Fixture = { dir: string; curatorDb: string; rbDb: string; musicDir: string; userId: string; contentOf: Record<string, string> };

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

export async function buildFixture(dir: string): Promise<Fixture> {
	const musicDir = join(dir, 'music');
	const curatorDir = join(dir, 'Curator');
	const rbDir = join(dir, 'rekordbox');
	const tmp = join(dir, 'tmp');
	for (const d of [musicDir, curatorDir, rbDir, tmp]) mkdirSync(d, { recursive: true });
	const curatorDb = join(curatorDir, 'curator.db');
	const rbDb = join(rbDir, 'master.db');
	const userId = randomUUID();

	// Six tracks with files; five of them are in rekordbox.
	const tracks = Array.from({ length: 6 }, (_, i) => {
		const file = join(musicDir, `Artist ${i % 3} - Title ${i}.flac`);
		writeFileSync(file, Buffer.from(`fixture audio ${i}`.repeat(64)));
		return { id: `trk-${i}`, recordingId: randomUUID(), title: `Title ${i}`, artist: `Artist ${i % 3}`, path: normalizePath(file), size: statSync(file).size, hash: `pcm-md5:${md5(`audio ${i}`)}` };
	});
	migrate(curatorDb);
	{
		const { sqlite } = createDb(curatorDb);
		try {
			const insTrack = sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, added_at) VALUES (?, ?, ?, ?, 'unsorted', 300, ?)`);
			const insLink = sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_format, file_size, file_mtime, audio_hash)
				VALUES (?, ?, 'local', ?, ?, 'flac', ?, ?, ?)`);
			sqlite.transaction(() => {
				tracks.forEach((t, i) => {
					insTrack.run(t.id, t.recordingId, t.title, JSON.stringify([{ name: t.artist }]), Date.now() - 86_400_000 + i);
					insLink.run(randomUUID(), t.id, t.path, t.path, t.size, Date.now(), t.hash);
				});
				// Curator-only curation on the track rekordbox does not hold.
				sqlite.prepare(`UPDATE track SET rating = 4 WHERE id = 'trk-5'`).run();
				// The library is bound to an account, as the live one is.
				sqlite.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES ('sync.client', ?, ?)`).run(JSON.stringify({ userId, registeredFor: userId }), Date.now());
			})();
			syncTrackArtistsByIdRaw(sqlite, tracks.map((t) => t.id));
			// A remote row (another device's track, shown here): the founder
			// reset must drop it, or the base would lack what the master shows.
			sqlite.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, remote_only, rating) VALUES ('remote-1', ?, 'Elsewhere', '[]', 'unsorted', 300, 1, 3)`).run(randomUUID());
		} finally {
			sqlite.close();
		}
	}

	const contentOf: Record<string, string> = {};
	const contents = tracks.slice(0, 5).map((t, i) => {
		const id = String(1000 + i);
		contentOf[t.id] = id;
		const myTags = i % 2 === 0 ? ['mt-deep'] : ['mt-warm', 'mt-deep'];
		const names = myTags.map((m) => (m === 'mt-deep' ? 'deep' : 'warm'));
		return {
			id, uuid: randomUUID(), path: t.path, title: t.title, artist: t.artist, album: `Album ${i}`, label: 'Label', genre: i < 3 ? 'House' : 'Techno',
			rating: i, comment: `note ${i} /* ${names.join(' / ')} */`, colorId: String(i + 1),
			cues: [{ kind: 0, inMsec: 1000 + i, outMsec: -1 }, { kind: 1, inMsec: 32_000, outMsec: -1, colorTableIndex: 3, comment: 'drop' }],
			myTags,
		};
	});
	const spec = {
		db: rbDb,
		contents,
		myTags: [{ id: 'mt-deep', name: 'deep' }, { id: 'mt-warm', name: 'warm' }],
		playlists: [{ id: '501', name: 'Set A', members: ['1000', '1001', '1002'] }, { id: '502', name: 'Set B', members: ['1003', '1001'] }],
	};
	const specPath = join(tmp, 'rb-spec.json');
	writeFileSync(specPath, JSON.stringify(spec), 'utf8');
	await runPythonScript('rb_fixture.py', ['create', specPath], { tmpDir: tmp });

	// The master's own link to its rekordbox.
	const svc = createCoreService(curatorDb, { logger: createLogger({ proc: 'core', sinks: [] }), peaksDir: join(curatorDir, 'peaks'), rekordbox: rekordboxSidecarSpec(rbDir, tmp) });
	try {
		await svc.runRekordboxImport({ mode: 'full', flags: DEFAULT_REKORDBOX_FLAGS, dbPathOverride: rbDb });
	} finally {
		svc.close();
		await new Promise((r) => setTimeout(r, 300));
	}
	return { dir, curatorDb, rbDb, musicDir, userId, contentOf };
}

// Changes one content row of a fixture master.db in place.
export async function editRekordbox(db: string, contentId: string, fields: Record<string, unknown>, tmpDir: string): Promise<void> {
	const specPath = join(tmpDir, `rb-edit-${randomUUID()}.json`);
	writeFileSync(specPath, JSON.stringify({ db, contentId, fields }), 'utf8');
	await runPythonScript('rb_fixture.py', ['edit', specPath], { tmpDir });
}
