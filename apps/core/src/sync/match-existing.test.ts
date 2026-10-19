// Coverage for the streaming-upsert third-pass dedup (match-existing.ts).
// These are the exact shapes that minted the duplicate rows which jammed
// Rekordbox playlist removals (2026-08-29): a recording already held under a
// NULL ISRC (rekordbox/scanner canonical) that a later Spotify/Tidal sync
// re-encountered under a different provider id.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { findExistingByContent } from './match-existing.js';
import type Database from 'better-sqlite3';

let dir: string;
let db: Db;
let sqlite: Database.Database;

function insertTrack(
	id: string,
	title: string,
	artistsJson: string,
	duration: number,
	isrc: string | null = null,
	deleted = false,
): void {
	sqlite
		.prepare(
			`INSERT INTO track (id, title, artists, duration, isrc, state, deleted_at)
			 VALUES (?, ?, ?, ?, ?, 'unsorted', ?)`,
		)
		.run(id, title, artistsJson, duration, isrc, deleted ? Date.now() : null);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-match-'));
	migrate(join(dir, 'curator.db'));
	({ db, sqlite } = createDb(join(dir, 'curator.db')));
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('findExistingByContent', () => {
	it('matches a NULL-ISRC canonical by title+artist+duration (the incident case)', () => {
		// rekordbox-imported canonical: comma-joined artists, no ISRC.
		insertTrack('canon', 'You Know I Dont - Andre Kronert Remix', '[{"name":"Stephan Zovsky, JOYCE, Andre Kronert"}]', 380);
		const m = findExistingByContent(db, {
			title: 'You Know I Dont - Andre Kronert Remix',
			artists: ['Stephan Zovsky', 'JOYCE', 'Andre Kronert'],
			duration: 381,
			isrc: 'GB1234500001',
		});
		expect(m?.trackId).toBe('canon');
		// canonical had no ISRC but the incoming one does — signal a seed.
		expect(m?.seedIsrc).toBe('GB1234500001');
	});

	it('does NOT seed when the canonical already carries an ISRC', () => {
		insertTrack('canon', 'What U Said', '[{"name":"Enamour"}]', 300, 'US1112233344');
		const m = findExistingByContent(db, {
			title: 'What U Said',
			artists: ['Enamour'],
			duration: 300,
			isrc: 'US1112233344',
		});
		expect(m?.trackId).toBe('canon');
		expect(m?.seedIsrc).toBeNull();
	});

	it('keeps a longer Extended mix separate (duration guard > 5s)', () => {
		insertTrack('canon', 'What U Said', '[{"name":"Enamour"}]', 300);
		const m = findExistingByContent(db, {
			title: 'What U Said - Extended',
			artists: ['Enamour'],
			duration: 420, // +120s — a different recording
			isrc: null,
		});
		expect(m).toBeNull();
	});

	it('returns null for a genuinely new recording', () => {
		insertTrack('canon', 'Something Else', '[{"name":"Someone"}]', 300);
		const m = findExistingByContent(db, {
			title: 'Storm from Below',
			artists: ['Mees Dierdorp'],
			duration: 360,
			isrc: null,
		});
		expect(m).toBeNull();
	});

	it('ignores soft-deleted canonicals (never resurrect a merged-away dupe)', () => {
		insertTrack('gone', 'Ghost Track', '[{"name":"Phantom"}]', 300, null, true);
		const m = findExistingByContent(db, {
			title: 'Ghost Track',
			artists: ['Phantom'],
			duration: 300,
			isrc: null,
		});
		expect(m).toBeNull();
	});

	it('matches via ISRC candidate lookup even when titles differ slightly', () => {
		insertTrack('canon', 'Track Name (Original Mix)', '[{"name":"Artist"}]', 300, 'NL9998887766');
		const m = findExistingByContent(db, {
			title: 'Track Name',
			artists: ['Artist'],
			duration: 302,
			isrc: 'NL9998887766',
		});
		expect(m?.trackId).toBe('canon');
	});

	it('keeps a same-length remix separate from an unversioned title (2026-10-12 incident)', () => {
		insertTrack(
			'klang',
			'More - Klangkarussell Extended Remix',
			'[{"name":"Jan Blomqvist"},{"name":"Elena Pitoulis"},{"name":"Klangkarussell","role":"remixer"}]',
			555,
			'NLF712604559',
		);
		const m = findExistingByContent(db, {
			title: 'More',
			artists: ['Fink', 'Jan Blomqvist'],
			duration: 557,
			isrc: 'NLF712605939',
		});
		expect(m).toBeNull();
	});

	it('picks the same-version candidate over a different remix of the same length', () => {
		insertTrack('remix', 'More - Klangkarussell Extended Remix', '[{"name":"Jan Blomqvist"}]', 555);
		insertTrack('orig', 'More', '[{"name":"Jan Blomqvist"}]', 556);
		const m = findExistingByContent(db, { title: 'More', artists: ['Jan Blomqvist'], duration: 557, isrc: null });
		expect(m?.trackId).toBe('orig');
	});

	it('matches the same version across dash and bracket spellings', () => {
		insertTrack('canon', 'Hold On (Extended Mix)', '[{"name":"Artist"}]', 400);
		const m = findExistingByContent(db, { title: 'Hold On - Extended Mix', artists: ['Artist'], duration: 401, isrc: null });
		expect(m?.trackId).toBe('canon');
	});

	it('treats a featured-artist parenthetical as no version', () => {
		insertTrack('canon', 'Hold On', '[{"name":"Artist"}]', 300);
		const m = findExistingByContent(db, { title: 'Hold On (feat. Singer)', artists: ['Artist', 'Singer'], duration: 300, isrc: null });
		expect(m?.trackId).toBe('canon');
	});

	it('an ISRC match still wins over a version mismatch', () => {
		insertTrack('canon', 'Hold On - Radio Edit', '[{"name":"Artist"}]', 200, 'GB0001112223');
		const m = findExistingByContent(db, { title: 'Hold On', artists: ['Artist'], duration: 200, isrc: 'GB0001112223' });
		expect(m?.trackId).toBe('canon');
	});
});
