// track_analysis.audio_hash: the gated backfill (one live local link → its
// hash; anything ambiguous stays NULL), the scanner clearing it when a known
// path's audio changes, and the re-analysis that restamps it. Generated temp
// DB and files only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { LibraryScanner, normalizePath, type IngestEvent } from '../local/scanner.js';
import type { ParseResult } from '../ingest/types.js';
import { AnalysisQueue } from '../analyzer/queue.js';
import type { AnalyzerSidecar } from '../analyzer/sidecar.js';
import { FakeAnalyzer, waitFor } from '../test-support/catalogue-fakes.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

const H = (c: string) => `pcm-md5:${c.repeat(32)}`;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-hash-stamp-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});
afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const stamp = (id: string) => (sqlite.prepare(`SELECT audio_hash AS h FROM track_analysis WHERE track_id = ?`).get(id) as { h: string | null }).h;

function track(id: string, links: Array<{ hash: string | null; missing?: boolean }>, analysed = true): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[]', 'unsorted')`).run(id, id);
	links.forEach((l, i) => {
		const p = `/m/${id}-${i}.flac`;
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash, missing_at) VALUES (?, ?, 'local', ?, ?, ?, ?)`)
			.run(`sl-${id}-${i}`, id, p, p, l.hash, l.missing ? 1 : null);
	});
	if (analysed) sqlite.prepare(`INSERT INTO track_analysis (track_id, bpm, analyzer_version, analyzed_at) VALUES (?, 120, '2.4.0', 1)`).run(id);
}

describe('audio_hash backfill (catalogue_hash_version)', () => {
	it('stamps rows whose track has exactly one live local link, once', () => {
		track('one', [{ hash: H('1') }]);
		track('moved', [{ hash: H('2'), missing: true }, { hash: H('3') }]);
		track('two', [{ hash: H('4') }, { hash: H('5') }]);
		track('same-two', [{ hash: H('6') }, { hash: H('6') }]);
		track('unhashed', [{ hash: null }]);
		track('streaming', []);
		// Rows from before the column existed: rerun the gated pass.
		sqlite.prepare(`UPDATE track_analysis SET audio_hash = NULL`).run();
		sqlite.prepare(`DELETE FROM app_setting WHERE key = 'catalogue_hash_version'`).run();
		sqlite.close();
		migrate(dbPath);
		({ db, sqlite } = createDb(dbPath));
		expect(stamp('one')).toBe(H('1'));
		expect(stamp('moved')).toBe(H('3'));
		expect(stamp('two')).toBeNull();
		expect(stamp('same-two')).toBeNull();
		expect(stamp('unhashed')).toBeNull();
		expect(stamp('streaming')).toBeNull();
		// Gated: a stamp cleared later is not put back by the next boot.
		sqlite.prepare(`UPDATE track_analysis SET audio_hash = NULL WHERE track_id = 'one'`).run();
		sqlite.close();
		migrate(dbPath);
		({ db, sqlite } = createDb(dbPath));
		expect(stamp('one')).toBeNull();
	});
});

describe('a known path whose audio changes', () => {
	const FOLDER = { id: 'f', path: '', excludeGlobs: null, watching: true, scanState: 'idle', scanError: null, addedAt: new Date(), lastScannedAt: null, isFavorite: false };
	const parse = (audioHash: string) => async (): Promise<ParseResult> => ({
		title: 'Song', artists: ['Artist'], albumTitle: null, duration: 30, isrc: null, bpm: null, genre: null, label: null, container: 'flac', audioHash,
	});
	async function ingest(hash: string, file: string): Promise<IngestEvent[]> {
		const scanner = new LibraryScanner(db, parse(hash));
		const events: IngestEvent[] = [];
		scanner.onIngest((e) => events.push(e));
		(scanner as any).totals.set(FOLDER.id, { scanned: 0, matched: 0, created: 0, skipped: 0, failed: 0 });
		await (scanner as any).ingestPath({ ...FOLDER, path: dir }, file);
		return events;
	}

	it('clears the stamp and says so; a tag rewrite (same audio) does neither', async () => {
		const file = join(dir, 'song.flac');
		writeFileSync(file, 'v1');
		const norm = normalizePath(file);
		sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('t', 'Song', '[]', 'unsorted')`).run();
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_mtime, file_size, audio_hash) VALUES ('sl', 't', 'local', ?, ?, 1000, 1, ?)`).run(norm, norm, H('a'));
		sqlite.prepare(`INSERT INTO track_analysis (track_id, bpm, analyzer_version, analyzed_at, audio_hash) VALUES ('t', 120, '2.4.0', 1, ?)`).run(H('a'));

		const same = await ingest(H('a'), file);
		expect(same.map((e) => [e.outcome, e.audioChanged ?? false])).toEqual([['matched', false]]);
		expect(stamp('t')).toBe(H('a'));

		writeFileSync(file, 'v2 — re-encoded');
		sqlite.prepare(`UPDATE source_link SET file_mtime = 1000 WHERE id = 'sl'`).run();
		const changed = await ingest(H('b'), file);
		expect(changed.map((e) => [e.outcome, e.audioChanged ?? false])).toEqual([['matched', true]]);
		expect(stamp('t')).toBeNull();
		expect((sqlite.prepare(`SELECT audio_hash AS h FROM source_link WHERE id = 'sl'`).get() as { h: string }).h).toBe(H('b'));
	});

	it('the re-analysis recomputes everything and restamps; a partial pass over an unstamped row does not', async () => {
		const file = join(dir, 'song.flac');
		writeFileSync(file, 'audio');
		const norm = normalizePath(file);
		sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES ('t', 'Song', '[]', 'unsorted')`).run();
		sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES ('sl', 't', 'local', ?, ?, ?)`).run(norm, norm, H('b'));
		// The old audio's analysis, stamp already cleared by the scanner.
		sqlite.prepare(`INSERT INTO track_analysis (track_id, bpm, beatgrid, key_camelot, brightness, power, analyzer_version, analyzed_at, audio_hash) VALUES ('t', 99, x'0000803f', '1A', 0.1, 0.2, '2.4.0', 1, NULL)`).run();
		const analyzer = new FakeAnalyzer();
		const queue = new AnalysisQueue(db, analyzer as unknown as AnalyzerSidecar, { peaksDir: join(dir, 'peaks') });
		queue.setAutoEnabled(true);

		// A top-up pass (prior values injected) must not vouch for the row.
		queue.enqueue(['t'], { priority: 100, analyzeOptions: { skipPeaks: true } });
		await waitFor(() => analyzer.calls.length === 1 && !queue.busy, 'partial pass');
		expect(analyzer.calls[0]!.options?.priorBpm).toBe(99);
		expect(stamp('t')).toBeNull();

		queue.requeueChangedAudio('t');
		await waitFor(() => analyzer.calls.length === 2 && !queue.busy, 'fresh pass');
		const o = analyzer.calls[1]!.options!;
		expect(o.priorBeatgrid).toBeUndefined();
		expect(o.priorKey).toBeUndefined();
		expect(o.overrideSegments).toBe(true);
		// The row had advanced scores: they are recomputed too.
		expect(o.features?.length ?? 0).toBeGreaterThan(0);
		expect(stamp('t')).toBe(H('b'));
		expect((sqlite.prepare(`SELECT bpm FROM track_analysis WHERE track_id = 't'`).get() as { bpm: number }).bpm).toBe(124.5);
	});
});
