// The difference classes (classify.ts) on hand-made libraries: a migrated
// temp Curator DB as the master and the joiner, a literal rekordbox dump as
// the untouched copy. No sidecar, no real data.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '@curator/core';
import { afterLinkClassifier, cueForm, rekordboxClassifier } from './classify.js';
import type { RbDump } from './compare-rb.js';
import { takeSample } from './compare.js';

let dir: string;
let master: Database.Database;
let joiner: Database.Database;

const PUSHED_AT = Date.parse('2026-10-18T12:00:00Z');
const BEFORE = PUSHED_AT - 86_400_000;
const AFTER = PUSHED_AT + 86_400_000;

function open(name: string): Database.Database {
	const p = join(dir, `${name}.db`);
	migrate(p);
	return new Database(p);
}

function track(raw: Database.Database, f: { id: string; recording: string; cid: string; title?: string; artists?: unknown[]; rating?: number | null; updatedAt?: number; rbSeen?: number }): void {
	raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, rating, updated_at) VALUES (?, ?, ?, ?, 'unsorted', ?, ?)`)
		.run(f.id, f.recording, f.title ?? 'One', JSON.stringify(f.artists ?? [{ name: 'A' }]), f.rating ?? null, f.updatedAt ?? BEFORE);
	raw.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, rb_updated_at_seen, pushed_at) VALUES (?, ?, 1, 0, ?, ?)`)
		.run(f.id, f.cid, f.rbSeen ?? BEFORE, PUSHED_AT);
}

const content = (over: Partial<RbDump['contents'][string]> = {}): RbDump['contents'][string] => ({
	title: 'One', artist: 'A', album: null, label: null, genre: null, rating: 0, comment: null, colorId: '0', deleted: 0, path: null, keyCamelot: null, updatedAtMs: BEFORE, ...over,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-e2e-classify-'));
	master = open('master');
	joiner = open('joiner');
});

afterEach(() => {
	master.close();
	joiner.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('rekordbox.compare classes', () => {
	it('expected when the push is what the master would send, failure when it is not', () => {
		track(master, { id: 'm1', recording: 'r1', cid: 'C1', title: 'New Title', updatedAt: AFTER });
		track(joiner, { id: 'j1', recording: 'r1', cid: 'C1' });
		const classify = rekordboxClassifier(master, joiner, { contents: { C1: content() }, cues: {}, myTags: {}, playlists: [] });
		expect(classify({ kind: 'content', contentId: 'C1', field: 'title', pushed: 'New Title', reference: 'One' }))
			.toMatchObject({ class: 'expected', note: expect.stringContaining('rekordbox behind Curator') });
		expect(classify({ kind: 'content', contentId: 'C1', field: 'title', pushed: 'Something else', reference: 'One' }).class).toBe('failure');
		// Rating 0 is never pushed: a rating on the pushed row is not the master's.
		expect(classify({ kind: 'content', contentId: 'C1', field: 'rating', pushed: 5, reference: 0 }).class).toBe('failure');
	});

	it('artefact when the joiner\'s row for the file is another recording', () => {
		track(master, { id: 'm1', recording: 'r1', cid: 'C1' });
		track(joiner, { id: 'j1', recording: 'r2', cid: 'C1' });
		const classify = rekordboxClassifier(master, joiner, { contents: { C1: content() }, cues: {}, myTags: {}, playlists: [] });
		expect(classify({ kind: 'content', contentId: 'C1', field: 'rating', pushed: 5, reference: 4 }).class).toBe('artefact');
	});

	it('a kept account cue set older than rekordbox\'s edit is a failure of the first link', () => {
		track(master, { id: 'm1', recording: 'r1', cid: 'C1' });
		track(joiner, { id: 'j1', recording: 'r1', cid: 'C1' });
		master.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind, origin, created_at) VALUES ('c0', 'm1', 2, 160, 'hot', 'rekordbox', ?)`).run(BEFORE);
		const form = cueForm({ slot: 2, kind: 'hot', positionSec: 160, lengthSec: null, color: null, name: null })!;
		expect(form).toBe('3|160000|-1|0|');
		const newer = rekordboxClassifier(master, joiner, { contents: { C1: content({ updatedAtMs: AFTER }) }, cues: {}, myTags: {}, playlists: [] });
		expect(newer({ kind: 'content', contentId: 'C1', field: 'cues', pushed: [form], reference: [form, '2|64762|72381|22|'] }).class).toBe('failure');
	});
});

describe('cloud.afterLink classes', () => {
	it('a key rekordbox holds is expected; one it does not hold fails', () => {
		track(joiner, { id: 'j1', recording: 'r1', cid: 'C1' });
		const classify = afterLinkClassifier(master, joiner, { contents: { C1: content({ keyCamelot: '6A' }) }, cues: {}, myTags: {}, playlists: [] });
		const row = (key: string) => ({ recordingId: 'r1', grid: null, key, segments: null });
		expect(classify('rbAnalysis', row('6B'), row('6A')).class).toBe('expected');
		expect(classify('rbAnalysis', row('6B'), row('7A')).class).toBe('failure');
		expect(classify('credits', { recordingId: 'r1', artists: '[]' }, { recordingId: 'r1', artists: '[{"name":"B"}]' }).class).toBe('failure');
	});

	it('credits rekordbox supplied where the account had none are expected', () => {
		track(master, { id: 'm1', recording: 'r1', cid: 'C1', artists: [] });
		track(joiner, { id: 'j1', recording: 'r1', cid: 'C1', artists: [] });
		const classify = afterLinkClassifier(master, joiner, { contents: { C1: content({ artist: 'Kova Lune' }) }, cues: {}, myTags: {}, playlists: [] });
		expect(classify('credits', { recordingId: 'r1', artists: '[]' }, { recordingId: 'r1', artists: '[{"name":"Kova Lune"}]' }).class).toBe('expected');
		expect(classify('trackArtists', null, { recordingId: 'r1', position: 0, artist: 'kovalune', role: null }).class).toBe('expected');
		// Credits the account held, rebuilt from rekordbox's line: a failure.
		expect(classify('credits', { recordingId: 'r1', artists: '[{"name":"Ilo Marsh"}]' }, { recordingId: 'r1', artists: '[{"name":"Kova Lune"}]' }).class).toBe('failure');
	});

	it('a move is rekordbox\'s order only for a member rekordbox\'s playlist holds; a Curator-only member\'s move fails', () => {
		track(joiner, { id: 'j1', recording: 'r1', cid: 'C1' });
		track(joiner, { id: 'j2', recording: 'r2', cid: 'C2' });
		const classify = afterLinkClassifier(master, joiner, { contents: {}, cues: {}, myTags: {}, playlists: [{ id: 'P', name: 'P', attribute: 0, parentId: null, deleted: 0, smart: false, members: ['C1'] }] });
		const moved = (recordingId: string) => classify('playlistTracks', { playlistId: 'rb_P', recordingId, orderKey: 'a1' }, { playlistId: 'rb_P', recordingId, orderKey: 'a5' });
		expect(moved('r1').class).toBe('expected');
		expect(moved('r2').class).toBe('failure');
		expect(moved('r9').note).toContain('Curator-only');
	});

	it('a change on a recording the joiner bound to another file than the master is an artefact', () => {
		track(master, { id: 'm1', recording: 'r1', cid: 'C1' });
		track(joiner, { id: 'j1', recording: 'r2', cid: 'C1' });
		const classify = afterLinkClassifier(master, joiner, { contents: { C1: content() }, cues: {}, myTags: {}, playlists: [] });
		expect(classify('credits', { recordingId: 'r2', artists: '[{"name":"A"}]' }, { recordingId: 'r2', artists: '[{"name":"A"},{"name":"B"}]' }).class).toBe('artefact');
	});
});

describe('rekordbox.compare playlist order', () => {
	it('the master\'s own order, never pushed, is expected; any other order fails', () => {
		for (const [i, cid] of ['C1', 'C2', 'C3'].entries()) {
			track(master, { id: `m${i}`, recording: `r${i}`, cid });
			track(joiner, { id: `j${i}`, recording: `r${i}`, cid });
		}
		master.prepare(`INSERT INTO playlist (id, source, source_id, name, is_smart) VALUES ('rb_P', 'rekordbox', 'P', 'P', 0)`).run();
		// The master reordered to C3, C1, C2 in Curator.
		for (const [pos, t] of ['m2', 'm0', 'm1'].entries()) {
			master.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, 'rb_P', ?, ?, ?)`).run(`pt-${t}`, `a${pos}`, t, pos, t);
		}
		const classify = rekordboxClassifier(master, joiner, { contents: {}, cues: {}, myTags: {}, playlists: [] });
		const order = (pushed: string[]) => classify({ kind: 'playlist', playlistId: 'P', field: 'playlist.order', pushed, reference: ['C1', 'C2', 'C3'] });
		expect(order(['C3', 'C1', 'C2']).class).toBe('expected');
		expect(order(['C2', 'C3', 'C1']).class).toBe('failure');
	});
});

describe('samples', () => {
	it('put failures first', () => {
		const rows = [
			{ table: 't', key: '1', left: 1, right: 2, class: 'expected' as const },
			{ table: 't', key: '2', left: 1, right: 2, class: 'failure' as const },
		];
		expect(takeSample(rows, 1).map((r) => r.key)).toEqual(['2']);
	});
});
