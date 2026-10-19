// Merge-two-tracks contract (library/merge-tracks.ts + the CoreService
// surface around it). Runs the REAL service against a generated DB —
// never the live library (CLAUDE.md). A throwing fake Spotify adapter is
// injected so any accidental upstream write fails the test loudly.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getSourceCapabilities } from '@curator/shared';
import { migrate } from '../db/migrate.js';
import { memberOrder } from '../test-support/playlist-track.js';
import { createDb } from '../db/client.js';
import { createCoreService, TrackMergeBlockedError, type CoreService } from '../service.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import { planTrackMerge } from './merge-tracks.js';

let dir: string;
let dbPath: string;
let peaksDir: string;
let sqlite: Database.Database;
let svc: CoreService;

function throwingAdapter(): StreamingSourceAdapter {
	const boom = async (): Promise<never> => { throw new Error('upstream write attempted during merge'); };
	return {
		source: 'spotify',
		displayName: 'Fake Spotify',
		capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [],
		fetchPlaylistTracks: async () => [],
		createPlaylist: boom,
		deletePlaylist: boom,
		renamePlaylist: boom,
		addTracks: boom,
		removeTracks: boom,
		replaceTracks: boom,
	};
}

function seedTrack(id: string, extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id, title: `Title ${id}`, artists: '[{"name":"Artist"}]', state: 'unsorted', duration: 300, ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO track (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
}
function seedLink(trackId: string, source: string, sourceTrackId: string, extra: Record<string, unknown> = {}): void {
	const cols: Record<string, unknown> = { id: `sl-${trackId}-${source}`, track_id: trackId, source, source_track_id: sourceTrackId, ...extra };
	const keys = Object.keys(cols);
	sqlite.prepare(`INSERT INTO source_link (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
}
function seedTag(id: string): void {
	sqlite.prepare(`INSERT INTO tag (id, name, kind) VALUES (?, ?, 'user')`).run(id, `Tag ${id}`);
}
function tagTrack(trackId: string, tagId: string): void {
	sqlite.prepare(`INSERT INTO track_tag (track_id, tag_id) VALUES (?, ?)`).run(trackId, tagId);
}
function seedPlaylist(id: string, source = 'local'): void {
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES (?, ?, ?, ?)`).run(id, source, `remote-${id}`, `Playlist ${id}`);
}
function seedMembership(playlistId: string, trackId: string, position: number): void {
	sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`).run(...memberOrder(position), playlistId, trackId, position, `src-${trackId}`);
}
function seedRbLink(trackId: string, contentId: string): void {
	sqlite.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES (?, ?, 1, 1, 1)`).run(trackId, contentId);
}
function seedCue(trackId: string, slot: number): void {
	sqlite.prepare(`INSERT INTO cue (id, track_id, slot, position_sec, kind) VALUES (?, ?, ?, ?, 'hot')`).run(`cue-${trackId}-${slot}`, trackId, slot, slot * 10);
}
function seedAnalysis(trackId: string, opts: { beatgrid?: boolean; rb?: boolean } = {}): void {
	sqlite.prepare(`INSERT INTO track_analysis (track_id, beatgrid, rb_beatgrid, brightness, analyzer_version, analyzed_at) VALUES (?, ?, ?, ?, 'test', 1)`)
		.run(trackId, opts.beatgrid ? Buffer.from([1, 2, 3, 4]) : null, opts.rb ? Buffer.from([9, 9, 9, 9]) : null, opts.beatgrid ? 0.7 : null);
	if (opts.beatgrid) sqlite.prepare(`UPDATE track SET brightness = 0.7 WHERE id = ?`).run(trackId);
}
function seedPlay(id: string, trackId: string): void {
	sqlite.prepare(`INSERT INTO play_session (id, kind, origin, started_at) VALUES (?, 'prep', 'curator', 1)`).run(`s-${id}`);
	sqlite.prepare(`INSERT INTO play_event (id, session_id, track_id, source) VALUES (?, ?, ?, 'local')`).run(id, `s-${id}`, trackId);
}

const row = <T = Record<string, unknown>>(sqlText: string, ...args: unknown[]): T | undefined => sqlite.prepare(sqlText).get(...args) as T | undefined;
const all = <T = Record<string, unknown>>(sqlText: string, ...args: unknown[]): T[] => sqlite.prepare(sqlText).all(...args) as T[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-merge-'));
	dbPath = join(dir, 'curator.db');
	peaksDir = join(dir, 'peaks');
	migrate(dbPath);
	sqlite = new Database(dbPath);
	svc = createCoreService(dbPath, { peaksDir, sourceAdapters: { spotify: throwingAdapter() } });
});

afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sibling DB handles on Windows */ }
});

describe('setTrackSourceLinks identity guard', () => {
	it('reports the owning track when the provider id is already bound elsewhere', async () => {
		seedTrack('a'); seedTrack('b');
		seedLink('b', 'spotify', '4uLU6hMCjMI75M1A2tKUQC');
		const res = await svc.setTrackSourceLinks('a', { spotify: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' });
		expect(res.updated).toEqual([]);
		expect(res.errors).toHaveLength(1);
		expect(res.errors[0]).toMatchObject({ source: 'spotify', code: 'already-linked', conflictTrackId: 'b' });
		// Nothing written for a.
		expect(all(`SELECT * FROM source_link WHERE track_id = 'a'`)).toHaveLength(0);
	});
});

describe('previewTrackMerge', () => {
	it('suggests the more-curated side and returns a plan per direction', async () => {
		seedTrack('a'); seedTrack('b', { rating: 4 });
		seedTag('t1'); tagTrack('b', 't1');
		seedLink('b', 'spotify', 'sp1');
		const p = await svc.previewTrackMerge('a', 'b');
		expect(p.a.track.id).toBe('a');
		expect(p.b.weight).toBeGreaterThan(p.a.weight);
		expect(p.suggestedKeepId).toBe('b');
		expect(p.plans['a']!.tagsAdded).toBe(1);
		expect(p.plans['b']!.tagsAdded).toBe(0);
		expect(p.plans['a']!.blockers).toEqual([]);
	});

	it('ties go to the first (edited) track', async () => {
		seedTrack('a'); seedTrack('b');
		const p = await svc.previewTrackMerge('a', 'b');
		expect(p.suggestedKeepId).toBe('a');
	});

	it('warns on a duration mismatch beyond the tolerance', async () => {
		seedTrack('a', { duration: 300 }); seedTrack('b', { duration: 420 });
		const p = await svc.previewTrackMerge('a', 'b');
		expect(p.plans['a']!.warnings.some((w) => /Durations differ/.test(w))).toBe(true);
		// Pure planner over a Db handle — same answer, no service.
		const { db } = createDb(dbPath);
		expect(planTrackMerge(db, 'b', 'a').warnings).toEqual(p.plans['b']!.warnings);
	});
});

describe('mergeTracks', () => {
	it('unions tags, playlists and links; soft-deletes the loser; never hard-deletes', async () => {
		seedTrack('keep', { genre: null, label: 'Keep Label', rating: null });
		seedTrack('drop', { genre: 'House', label: 'Drop Label', rating: 3, comment: 'nice' });
		seedTag('shared'); seedTag('only-drop');
		tagTrack('keep', 'shared'); tagTrack('drop', 'shared'); tagTrack('drop', 'only-drop');
		seedPlaylist('p-both'); seedPlaylist('p-drop');
		seedTrack('x');
		seedMembership('p-both', 'keep', 0); seedMembership('p-both', 'drop', 1); seedMembership('p-both', 'x', 2);
		seedMembership('p-drop', 'drop', 0);
		seedLink('keep', 'spotify', 'sp-keep');
		seedLink('drop', 'spotify', 'sp-drop');
		seedLink('drop', 'tidal', 'td-drop');
		seedLink('drop', 'local', '/music/drop.flac', { file_path: '/music/drop.flac' });

		const res = await svc.mergeTracks('keep', 'drop');

		expect(res.survivor.id).toBe('keep');
		expect(res.tagsAdded).toBe(1);
		expect(res.tagsDuplicate).toBe(1);
		expect(res.membershipsMoved).toBe(1);
		expect(res.membershipsDuplicate).toBe(1);
		expect(res.linksMoved).toBe(2);   // tidal + local
		expect(res.linksDropped).toBe(1); // spotify: keep's wins
		expect(res.errors).toEqual([]);

		expect(all(`SELECT tag_id FROM track_tag WHERE track_id = 'keep' ORDER BY tag_id`).map((r) => r.tag_id)).toEqual(['only-drop', 'shared']);
		expect(all(`SELECT * FROM track_tag WHERE track_id = 'drop'`)).toHaveLength(0);
		// p-both: drop's duplicate row removed and positions re-compacted from base 0.
		expect(all<{ track_id: string; position: number }>(`SELECT track_id, position FROM playlist_track WHERE playlist_id = 'p-both' ORDER BY position`))
			.toEqual([{ track_id: 'keep', position: 0 }, { track_id: 'x', position: 1 }]);
		expect(row(`SELECT track_count FROM playlist WHERE id = 'p-both'`)?.track_count).toBe(2);
		expect(all(`SELECT track_id FROM playlist_track WHERE playlist_id = 'p-drop'`).map((r) => r.track_id)).toEqual(['keep']);
		expect(all<{ source: string; source_track_id: string }>(`SELECT source, source_track_id FROM source_link WHERE track_id = 'keep' ORDER BY source`))
			.toEqual([{ source: 'local', source_track_id: '/music/drop.flac' }, { source: 'spotify', source_track_id: 'sp-keep' }, { source: 'tidal', source_track_id: 'td-drop' }]);
		expect(all(`SELECT * FROM source_link WHERE track_id = 'drop'`)).toHaveLength(0);

		// Scalars: keep-first fill.
		const k = row(`SELECT genre, label, rating, comment, genre_ascii FROM track WHERE id = 'keep'`)!;
		expect(k.genre).toBe('House');
		expect(k.genre_ascii).toBe('house');
		expect(k.label).toBe('Keep Label');
		expect(k.rating).toBe(3);
		expect(k.comment).toBe('nice');

		// Loser soft-deleted, row still present, no rekordbox tombstone.
		const d = row(`SELECT deleted_at, membership FROM track WHERE id = 'drop'`)!;
		expect(d.deleted_at).not.toBeNull();
		expect(d.membership).toBeNull();
		expect(all(`SELECT * FROM rekordbox_deleted_content`)).toHaveLength(0);
		expect(res.playlistsTouched.sort()).toEqual(['p-both', 'p-drop']);
		// The survivor no longer surfaces the loser in default reads.
		const live = await svc.getTracks({ ids: ['keep', 'drop'] });
		expect(live.map((t) => t.id)).toEqual(['keep']);
		expect(live[0]!.sources?.sort()).toEqual(['local', 'spotify', 'tidal']);
	});

	it('takes the loser\'s cues only when the survivor has none', async () => {
		seedTrack('a'); seedTrack('b');
		seedCue('b', 1); seedCue('b', 2);
		await svc.mergeTracks('a', 'b');
		expect(all(`SELECT slot FROM cue WHERE track_id = 'a' ORDER BY slot`).map((r) => r.slot)).toEqual([1, 2]);

		seedTrack('c'); seedTrack('d');
		seedCue('c', 1); seedCue('d', 1); seedCue('d', 5);
		await svc.mergeTracks('c', 'd');
		expect(all(`SELECT slot FROM cue WHERE track_id = 'c'`).map((r) => r.slot)).toEqual([1]);
		expect(all(`SELECT * FROM cue WHERE track_id = 'd'`)).toHaveLength(0);
	});

	it('keeps the analysis row with a Curator beatgrid, moves its scalars and peaks, and grafts the rb slot', async () => {
		seedTrack('a'); seedTrack('b');
		seedAnalysis('a', { rb: true });            // rb slot only
		seedAnalysis('b', { beatgrid: true });      // curator beatgrid, no rb slot
		for (const tier of ['lo', 'hi']) {
			mkdirSync(join(peaksDir, tier), { recursive: true });
			writeFileSync(join(peaksDir, tier, 'b.cpk'), 'peaks');
		}
		const res = await svc.mergeTracks('a', 'b');
		expect(res.analysis).toBe('take-drop');
		expect(res.analysisTakenFromDrop).toBe(true);
		expect(res.peaksMoved).toBe(2);
		const an = row(`SELECT beatgrid, rb_beatgrid FROM track_analysis WHERE track_id = 'a'`)!;
		expect(an.beatgrid).not.toBeNull();
		expect(an.rb_beatgrid).not.toBeNull(); // keep's rb slot survived onto the moved row
		expect(all(`SELECT * FROM track_analysis WHERE track_id = 'b'`)).toHaveLength(0);
		expect(row(`SELECT brightness FROM track WHERE id = 'a'`)?.brightness).toBe(0.7);
		expect(existsSync(join(peaksDir, 'lo', 'a.cpk'))).toBe(true);
		expect(existsSync(join(peaksDir, 'lo', 'b.cpk'))).toBe(false);
	});

	it('re-points play history and the rekordbox link, deletes transient rows', async () => {
		seedTrack('a'); seedTrack('b');
		seedPlay('e1', 'b');
		seedRbLink('b', 'rb-42');
		sqlite.prepare(`INSERT INTO analysis_job (track_id, state, enqueued_at) VALUES ('b', 'queued', 1)`).run();
		sqlite.prepare(`INSERT INTO download_job (track_id, track_title, state, enqueued_at) VALUES ('b', 'x', 'pending', 1)`).run();
		const res = await svc.mergeTracks('a', 'b');
		expect(res.rekordboxLinkMoved).toBe(true);
		expect(res.playsMoved).toBe(1);
		expect(row(`SELECT track_id FROM play_event WHERE id = 'e1'`)?.track_id).toBe('a');
		expect(row(`SELECT track_id FROM rekordbox_link WHERE rb_content_id = 'rb-42'`)?.track_id).toBe('a');
		expect(all(`SELECT * FROM analysis_job WHERE track_id = 'b'`)).toHaveLength(0);
		expect(all(`SELECT * FROM download_job WHERE track_id = 'b'`)).toHaveLength(0);
	});

	it('unions overrides with the survivor\'s keys winning and takes a sorted state over unsorted', async () => {
		seedTrack('a', { overrides: JSON.stringify({ genre: 'Keep Genre' }) });
		seedTrack('b', { overrides: JSON.stringify({ genre: 'Drop Genre', label: 'Drop Label' }), state: 'keep' });
		const res = await svc.mergeTracks('a', 'b');
		const k = row<{ overrides: string; state: string }>(`SELECT overrides, state FROM track WHERE id = 'a'`)!;
		expect(JSON.parse(k.overrides)).toEqual({ genre: 'Keep Genre', label: 'Drop Label' });
		expect(k.state).toBe('keep');
		expect(res.survivor.label).toBe('Drop Label'); // override applied on the returned row
	});

	it('refuses when both sides are separate rekordbox entries and leaves the DB untouched', async () => {
		seedTrack('a'); seedTrack('b');
		seedRbLink('a', 'rb-1'); seedRbLink('b', 'rb-2');
		seedTag('t'); tagTrack('b', 't');
		const preview = await svc.previewTrackMerge('a', 'b');
		expect(preview.plans['a']!.blockers[0]).toMatch(/rekordbox/);
		await expect(svc.mergeTracks('a', 'b')).rejects.toBeInstanceOf(TrackMergeBlockedError);
		expect(row(`SELECT deleted_at FROM track WHERE id = 'b'`)?.deleted_at).toBeNull();
		expect(all(`SELECT * FROM track_tag WHERE track_id = 'b'`)).toHaveLength(1);
	});

	it('refuses a self-merge and a merge with a deleted row', async () => {
		seedTrack('a'); seedTrack('gone', { deleted_at: 1 });
		await expect(svc.mergeTracks('a', 'a')).rejects.toBeInstanceOf(TrackMergeBlockedError);
		await expect(svc.mergeTracks('a', 'gone')).rejects.toBeInstanceOf(TrackMergeBlockedError);
	});

	it('moves a streaming-playlist membership locally without touching the provider', async () => {
		seedTrack('a'); seedTrack('b');
		seedPlaylist('sp', 'spotify');
		sqlite.prepare(`UPDATE playlist SET owner_id = 'me', is_collaborative = 1 WHERE id = 'sp'`).run();
		seedMembership('sp', 'b', 0);
		// The fake adapter throws on any write — the merge must never reach it.
		const res = await svc.mergeTracks('a', 'b');
		expect(res.membershipsMoved).toBe(1);
		expect(all(`SELECT track_id FROM playlist_track WHERE playlist_id = 'sp'`).map((r) => r.track_id)).toEqual(['a']);
	});
});

// The merge leaves the ISRC on BOTH rows (keep inherits it, the tombstoned
// loser keeps its own). migrate() runs on every launch and its ISRC dedup
// used to count the tombstone — the older loser became the "survivor", the
// kept row was hard-deleted with its rekordbox link, and the user saw their
// track flagged deleted (2026-09-23).
describe('merge survives a relaunch', () => {
	it('ISRC dedup in migrate() ignores the soft-deleted loser', async () => {
		seedTrack('stream', { isrc: 'GBTDG1301823', created_at: 1000 });
		seedLink('stream', 'spotify', 'sp1');
		seedTrack('file', { created_at: 2000 });
		seedLink('file', 'local', 'c:/m/a.flac', { file_path: 'c:/m/a.flac' });
		seedRbLink('file', '151417820');
		seedPlaylist('rb', 'rekordbox'); seedMembership('rb', 'file', 0);
		await svc.mergeTracks('file', 'stream');
		expect(row(`SELECT isrc FROM track WHERE id = 'file'`)).toEqual({ isrc: 'GBTDG1301823' });

		migrate(dbPath);

		expect(row(`SELECT deleted_at FROM track WHERE id = 'file'`)).toEqual({ deleted_at: null });
		expect(row(`SELECT deleted_at FROM track WHERE id = 'stream'`)?.deleted_at).not.toBeNull();
		expect(all(`SELECT source FROM source_link WHERE track_id = 'file' ORDER BY source`).map((r) => r.source)).toEqual(['local', 'spotify']);
		expect(row(`SELECT rb_content_id FROM rekordbox_link WHERE track_id = 'file'`)).toEqual({ rb_content_id: '151417820' });
		expect(all(`SELECT track_id FROM playlist_track WHERE playlist_id = 'rb'`).map((r) => r.track_id)).toEqual(['file']);
	});

	it('still merges live ISRC duplicates onto the oldest live row', () => {
		seedTrack('old', { isrc: 'X1', created_at: 1000, deleted_at: 500 });
		seedTrack('mid', { isrc: 'X1', created_at: 2000 });
		seedTrack('new', { isrc: 'X1', created_at: 3000 });
		seedLink('new', 'tidal', 't1');
		migrate(dbPath);
		expect(all(`SELECT id FROM track WHERE isrc = 'X1' ORDER BY id`).map((r) => r.id)).toEqual(['mid', 'old']);
		expect(row(`SELECT track_id FROM source_link WHERE id = 'sl-new-tidal'`)).toEqual({ track_id: 'mid' });
	});
});
