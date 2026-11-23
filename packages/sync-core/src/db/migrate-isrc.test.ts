// The one-shot ISRC canonicalisation: lowercase / hyphenated / mixed values
// become uppercase-no-separator, junk is nulled (track) or parked in
// payload.isrcRaw (source_link), the gate makes a second migrate() a no-op,
// a backup lands beside the DB, and the startup dedup — which runs right
// after — now folds a lowercase + uppercase pair of the same ISRC.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-isrc-normalise-'));
	path = join(dir, 'curator.db');
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type TrackSeed = { id: string; isrc: string | null; duration?: number; createdAt?: number };
type LinkSeed = { id: string; trackId: string; source: string; isrcLocal: string | null; payload?: string | null };

// First migrate() creates the schema and, finding nothing to rewrite, marks
// the pass done; roll the gate back so the seeded rows go through it.
function seed(tracks: TrackSeed[], links: LinkSeed[] = []): void {
	migrate(path);
	const db = new Database(path);
	const insTrack = db.prepare(`INSERT INTO track (id, title, artists, isrc, duration, created_at, state) VALUES (?, ?, '[{"name":"A"}]', ?, ?, ?, 'unsorted')`);
	for (const t of tracks) insTrack.run(t.id, `Title ${t.id}`, t.isrc, t.duration ?? 300, t.createdAt ?? 1000);
	const insLink = db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, isrc_local, payload) VALUES (?, ?, ?, ?, ?, ?)`);
	for (const l of links) insLink.run(l.id, l.trackId, l.source, `src-${l.id}`, l.isrcLocal, l.payload ?? null);
	db.prepare(`DELETE FROM app_setting WHERE key = 'isrc_normalize_version'`).run();
	db.close();
}

const isrcOf = (db: Database.Database, id: string): string | null =>
	(db.prepare(`SELECT isrc FROM track WHERE id = ?`).get(id) as { isrc: string | null }).isrc;
const linkOf = (db: Database.Database, id: string): { isrc_local: string | null; payload: string | null } =>
	db.prepare(`SELECT isrc_local, payload FROM source_link WHERE id = ?`).get(id) as { isrc_local: string | null; payload: string | null };
const backupCount = (): number => readdirSync(dir).filter((f) => f.includes('.pre-isrc-normalise-') && f.endsWith('.bak')).length;

describe('ISRC normalisation', () => {
	it('rewrites track.isrc and source_link.isrc_local to canonical form, parks junk, writes the gate and a backup', () => {
		seed(
			[
				{ id: 'lower', isrc: 'gbsmu1676261' },
				{ id: 'hyph', isrc: 'GB-SMU-16-76262' },
				{ id: 'mixed', isrc: 'gBsMu1676263' },
				{ id: 'spaced', isrc: ' GB SMU 16 76264 ' },
				{ id: 'ok', isrc: 'GBSMU1676265' },
				{ id: 'junk', isrc: 'not-an-isrc' },
				{ id: 'blank', isrc: '' },
				{ id: 'none', isrc: null },
			],
			[
				{ id: 'l-lower', trackId: 'lower', source: 'local', isrcLocal: 'gbsmu1676261', payload: JSON.stringify({ container: 'flac' }) },
				{ id: 'l-hyph', trackId: 'hyph', source: 'spotify', isrcLocal: 'GB-SMU-16-76262', payload: null },
				{ id: 'l-ok', trackId: 'ok', source: 'tidal', isrcLocal: 'GBSMU1676265', payload: JSON.stringify({ id: 1 }) },
				{ id: 'l-junk-obj', trackId: 'junk', source: 'local', isrcLocal: 'not-an-isrc', payload: JSON.stringify({ container: 'mp3' }) },
				{ id: 'l-junk-null', trackId: 'junk', source: 'beatport', isrcLocal: 'XX', payload: null },
				{ id: 'l-junk-bad', trackId: 'junk', source: 'tidal', isrcLocal: 'YY', payload: '{not json' },
			],
		);
		migrate(path);
		const db = new Database(path);

		expect(isrcOf(db, 'lower')).toBe('GBSMU1676261');
		expect(isrcOf(db, 'hyph')).toBe('GBSMU1676262');
		expect(isrcOf(db, 'mixed')).toBe('GBSMU1676263');
		expect(isrcOf(db, 'spaced')).toBe('GBSMU1676264');
		expect(isrcOf(db, 'ok')).toBe('GBSMU1676265');
		expect(isrcOf(db, 'junk')).toBeNull();
		expect(isrcOf(db, 'blank')).toBeNull();
		expect(isrcOf(db, 'none')).toBeNull();

		// Valid-after-normalisation links: the column is rewritten and the
		// payload untouched.
		expect(linkOf(db, 'l-lower')).toEqual({ isrc_local: 'GBSMU1676261', payload: JSON.stringify({ container: 'flac' }) });
		expect(linkOf(db, 'l-hyph')).toEqual({ isrc_local: 'GBSMU1676262', payload: null });
		expect(linkOf(db, 'l-ok')).toEqual({ isrc_local: 'GBSMU1676265', payload: JSON.stringify({ id: 1 }) });
		// Junk moves into payload.isrcRaw: merged into an existing object,
		// minted when the payload was null or unparseable.
		const junkObj = linkOf(db, 'l-junk-obj');
		expect(junkObj.isrc_local).toBeNull();
		expect(JSON.parse(junkObj.payload!)).toEqual({ container: 'mp3', isrcRaw: 'not-an-isrc' });
		const junkNull = linkOf(db, 'l-junk-null');
		expect(junkNull.isrc_local).toBeNull();
		expect(JSON.parse(junkNull.payload!)).toEqual({ isrcRaw: 'XX' });
		const junkBad = linkOf(db, 'l-junk-bad');
		expect(junkBad.isrc_local).toBeNull();
		expect(JSON.parse(junkBad.payload!)).toEqual({ isrcRaw: 'YY' });

		expect((db.prepare(`SELECT value FROM app_setting WHERE key = 'isrc_normalize_version'`).get() as { value: string }).value).toBe('1');
		db.close();
		expect(backupCount()).toBe(1);
	});

	it('is a no-op on the second run: the gate holds and no further backup is written', () => {
		seed([{ id: 'lower', isrc: 'gbsmu1676261' }]);
		migrate(path);
		expect(backupCount()).toBe(1);

		// A row written past normalizeIsrc after the pass ran stays as written:
		// the gate, not a re-scan, is what decides.
		let db = new Database(path);
		db.prepare(`INSERT INTO track (id, title, artists, isrc, state) VALUES ('late', 'L', '[]', 'gbsmu1999999', 'unsorted')`).run();
		db.close();
		migrate(path);
		db = new Database(path);
		expect(isrcOf(db, 'lower')).toBe('GBSMU1676261');
		expect(isrcOf(db, 'late')).toBe('gbsmu1999999');
		db.close();
		expect(backupCount()).toBe(1);
	});

	it('writes the gate without a backup when there is nothing to rewrite', () => {
		migrate(path);
		const db = new Database(path);
		expect((db.prepare(`SELECT value FROM app_setting WHERE key = 'isrc_normalize_version'`).get() as { value: string }).value).toBe('1');
		db.close();
		expect(backupCount()).toBe(0);
	});

	it('lets the startup dedup fold a lowercase + uppercase pair of the same ISRC, within the duration guard', () => {
		seed(
			[
				// Same recording, two spellings, 2 s apart: the older row survives.
				{ id: 'dupA', isrc: 'gbsmu1676270', duration: 300, createdAt: 1000 },
				{ id: 'dupB', isrc: 'GBSMU1676270', duration: 302, createdAt: 2000 },
				// Same ISRC spelt two ways but 100 s apart: a provider-side
				// collision between mixes — the 5 s guard keeps both.
				{ id: 'farA', isrc: 'gb-smu-16-76271', duration: 300, createdAt: 1000 },
				{ id: 'farB', isrc: 'GBSMU1676271', duration: 400, createdAt: 2000 },
			],
			[
				{ id: 'l-dupB', trackId: 'dupB', source: 'spotify', isrcLocal: 'GBSMU1676270' },
			],
		);
		migrate(path);
		const db = new Database(path);

		const folded = db.prepare(`SELECT id FROM track WHERE isrc = 'GBSMU1676270' ORDER BY id`).all() as { id: string }[];
		expect(folded).toEqual([{ id: 'dupA' }]);
		expect(db.prepare(`SELECT 1 FROM track WHERE id = 'dupB'`).get()).toBeUndefined();
		// The loser's link moved onto the survivor instead of cascading away.
		expect((db.prepare(`SELECT track_id FROM source_link WHERE id = 'l-dupB'`).get() as { track_id: string }).track_id).toBe('dupA');

		const kept = db.prepare(`SELECT id FROM track WHERE isrc = 'GBSMU1676271' ORDER BY id`).all() as { id: string }[];
		expect(kept).toEqual([{ id: 'farA' }, { id: 'farB' }]);
		db.close();
	});
});
