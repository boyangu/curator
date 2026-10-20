// persist.ts is the one write path for analysis: the queue's sidecar
// results (moved here unchanged from queue.ts) and the catalogue's pulled
// units. Pinned: a pulled copy of a row is that row (the shared catalogue's
// round trip loses nothing), the write-when-produced guards hold for a
// partial result, and the audio-hash stamp moves only when the caller says.
// Generated temp DB only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { CATALOGUE_UNIT_SCHEMA, type StoredCatalogueItem } from '@curator/protocol';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { inlineItemsFor, partialResult, readLocalTrack } from '../catalogue/local.js';
import { fullResult } from '../test-support/catalogue-fakes.js';
import { persistAnalysisResult } from './persist.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

const HASH_A = `pcm-md5:${'a'.repeat(32)}`;
const HASH_B = `pcm-md5:${'b'.repeat(32)}`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-persist-'));
	migrate(join(dir, 'curator.db'));
	({ db, sqlite } = createDb(join(dir, 'curator.db')));
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

function seed(id: string, hash: string): string {
	const path = `/music/${id}.flac`;
	sqlite.prepare(`INSERT INTO track (id, title, artists, state, duration) VALUES (?, ?, '[]', 'unsorted', 30)`).run(id, id);
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash, duration_local) VALUES (?, ?, 'local', ?, ?, ?, 30)`).run(`sl-${id}`, id, path, path, hash);
	return path;
}

const ANALYSIS_COLS = ['bpm', 'beatgrid', 'downbeats', 'key_camelot', 'key_strength', 'brightness', 'power', 'dynamic_complexity', 'loudness_range_lu',
	'dissonance', 'density', 'segments_json', 'intro_length_sec', 'outro_length_sec', 'first_drop_sec', 'drop_count', 'breakdown_count', 'features_json',
	'duration', 'analyzer_version'];
const TRACK_COLS = ['brightness', 'power', 'dynamic_complexity', 'loudness_range_lu', 'dissonance', 'density', 'intro_length_sec', 'outro_length_sec',
	'first_drop_sec', 'drop_count', 'breakdown_count'];
const pick = (r: Record<string, unknown>, cols: string[]) => Object.fromEntries(cols.map((c) => [c, r[c] instanceof Buffer ? (r[c] as Buffer).toString('hex') : r[c]]));
const analysis = (id: string) => sqlite.prepare(`SELECT * FROM track_analysis WHERE track_id = ?`).get(id) as Record<string, unknown> | undefined;
const trackRow = (id: string) => sqlite.prepare(`SELECT * FROM track WHERE id = ?`).get(id) as Record<string, unknown>;
const linkRow = (id: string) => sqlite.prepare(`SELECT fingerprint, fingerprint_duration_sec FROM source_link WHERE track_id = ?`).get(id);

describe('persistAnalysisResult', () => {
	it('a copy pulled through the catalogue writes exactly the row it came from', () => {
		const pa = seed('a', HASH_A);
		persistAnalysisResult(db, fullResult({ trackId: 'a', path: pa, outPeaksLoPath: '', outPeaksHiPath: '' }, { advanced: true }), pa, { audioHash: HASH_A });
		const items = inlineItemsFor(sqlite, readLocalTrack(sqlite, 'a')!, new Set(['rhythm', 'key', 'structure', 'advanced', 'fingerprint'] as const));
		expect(items.map((i) => i.unit).sort()).toEqual(['advanced', 'fingerprint', 'key', 'rhythm', 'structure']);
		// What the server would hand back (JSON round trip, stored fields).
		const stored = JSON.parse(JSON.stringify(items.map((i, n) => ({ ...i, rev: n + 1, deviceId: 'dev', updatedAt: 0 })))) as StoredCatalogueItem[];
		expect(stored.every((i) => i.unitSchema === CATALOGUE_UNIT_SCHEMA[i.unit])).toBe(true);

		const pb = seed('b', HASH_A);
		persistAnalysisResult(db, partialResult(readLocalTrack(sqlite, 'b')!, stored), pb, { audioHash: HASH_A });
		const [ra, rb] = [analysis('a')!, analysis('b')!];
		expect({ ...pick(rb, ANALYSIS_COLS), segments_json: JSON.parse(rb.segments_json as string), features_json: JSON.parse(rb.features_json as string) })
			.toEqual({ ...pick(ra, ANALYSIS_COLS), segments_json: JSON.parse(ra.segments_json as string), features_json: JSON.parse(ra.features_json as string) });
		expect(pick(trackRow('b'), TRACK_COLS)).toEqual(pick(trackRow('a'), TRACK_COLS));
		expect(linkRow('b')).toEqual(linkRow('a'));
		expect(rb.audio_hash).toBe(HASH_A);
	});

	it('a partial result fills only what it carries and keeps everything else', () => {
		const p = seed('t', HASH_A);
		persistAnalysisResult(db, fullResult({ trackId: 't', path: p, outPeaksLoPath: '', outPeaksHiPath: '' }, { advanced: true }), p, { audioHash: HASH_A });
		const before = analysis('t')!;
		// Only a key, as a catalogue fill of a track missing just that would.
		const keyOnly = { ...fullResult({ trackId: 't', path: p, outPeaksLoPath: '', outPeaksHiPath: '', options: { skipBeatgrid: true, skipSegments: true, skipFingerprint: true } }), key_camelot: '11B', key_strength: 0.2 };
		persistAnalysisResult(db, keyOnly, p);
		const after = analysis('t')!;
		expect(after.key_camelot).toBe('11B');
		for (const c of ['bpm', 'beatgrid', 'segments_json', 'brightness', 'features_json', 'drop_count', 'audio_hash']) expect(after[c]).toEqual(before[c]);
	});

	it('moves the audio-hash stamp only when asked: undefined keeps, a hash stamps, null clears', () => {
		const p = seed('t', HASH_A);
		const r = fullResult({ trackId: 't', path: p, outPeaksLoPath: '', outPeaksHiPath: '' });
		persistAnalysisResult(db, r, p);
		expect(analysis('t')!.audio_hash).toBeNull();
		persistAnalysisResult(db, r, p, { audioHash: HASH_B });
		expect(analysis('t')!.audio_hash).toBe(HASH_B);
		persistAnalysisResult(db, r, p);
		expect(analysis('t')!.audio_hash).toBe(HASH_B);
		persistAnalysisResult(db, r, p, { audioHash: null });
		expect(analysis('t')!.audio_hash).toBeNull();
	});
});
