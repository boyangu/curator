// The B5 exit test (cloud plan "B5 Replay test and exit"): drive the REAL
// service on a generated library through every kind of library write, read
// its outbox, and replay it onto fresh databases that hold only the same
// catalogue rows (tracks are scanner/catalogue-side, so they are seeded, not
// replayed). The replica must equal the source table by table — in emission
// order and in an arbitrary shuffle split into several batches (the
// convergence property) — and must equal what the protocol's in-memory
// reducer materialises from the same ops (one implementation of the rules).
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(); a throwing fake
// Spotify adapter guards against any upstream write.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyOps as reduceOps, createLibraryState, materialize, type Op } from '@curator/protocol';
import { getSourceCapabilities } from '@curator/shared';
import { migrate } from '../db/migrate.js';
import { createDb } from '../db/client.js';
import { createCoreService, type CoreService } from '../service.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import * as mut from '../library/mutators.js';
import { normalizeIncomingArtistsRaw, syncTrackArtistsByIdRaw } from '../library/artists.js';
import { artistCreditRewritePending } from '../library/artist-alias.js';
import { applyOps } from './apply.js';
import { compareDumps, dumpLibrary, dumpView, type LibraryDump } from './dump.js';
import { initialPush } from './initial-push.js';
import { readOutbox } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';

const TRACKS = Array.from({ length: 12 }, (_, i) => `trk-${String(i).padStart(2, '0')}`);

let dir: string;
let source: Database.Database;
let svc: CoreService;
let ops: Op[];
let want: LibraryDump;
let wantArtists: unknown;
const handles: Database.Database[] = [];

function throwingAdapter(): StreamingSourceAdapter {
	const boom = async (): Promise<never> => { throw new Error('upstream write attempted during replay test'); };
	return {
		source: 'spotify', displayName: 'Fake Spotify', capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [], fetchPlaylistTracks: async () => [],
		createPlaylist: boom, deletePlaylist: boom, renamePlaylist: boom, addTracks: boom, removeTracks: boom, replaceTracks: boom,
	};
}

// Catalogue credits the artist renames below act on: "Old Name" (renamed),
// "Merge Me" (merged into "Artist") alongside "Partner" (re-spelled).
const SEED_ARTISTS = [
	[{ name: 'Old Name' }],
	[{ name: 'Merge Me' }, { name: 'Partner', role: 'featured' }],
	[{ name: 'Artist' }],
];

function seedTracks(raw: Database.Database): void {
	const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, ?, 'unsorted', 300)`);
	TRACKS.forEach((id, i) => ins.run(id, recordingIdForTrack(id), `Title ${id}`, JSON.stringify(SEED_ARTISTS[i % SEED_ARTISTS.length])));
	syncTrackArtistsByIdRaw(raw, TRACKS);
}

// What the op log does not carry but artist rules must leave identical:
// canonical credits and the junction (by live artist name; ids are local).
function artistDump(raw: Database.Database): unknown {
	return {
		artists: raw.prepare(`SELECT recording_id, artists FROM track ORDER BY recording_id, id`).all(),
		junction: raw.prepare(`SELECT t.recording_id, a.name, ta.role, ta.position FROM track_artist ta JOIN track t ON t.id = ta.track_id
			JOIN artist a ON a.id = ta.artist_id ORDER BY t.recording_id, ta.position`).all(),
	};
}

function replica(name: string): Database.Database {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const raw = new Database(p);
	raw.pragma('foreign_keys = ON');
	handles.push(raw);
	seedTracks(raw);
	return raw;
}

const diffs = (a: LibraryDump, b: LibraryDump) => compareDumps(a, b).filter((r) => !r.equal);

// Deterministic shuffle so a failure reproduces.
function shuffled<T>(xs: readonly T[], seed: number): T[] {
	const out = [...xs];
	let s = seed;
	const rnd = (): number => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'curator-replay-'));
	const p = join(dir, 'source.db');
	migrate(p);
	source = new Database(p);
	handles.push(source);
	seedTracks(source);
	// First sign-in: the existing rows (here only the system tags) get their
	// creates, exactly as D10's initial push does on a real library.
	initialPush(source);
	svc = createCoreService(p, { peaksDir: join(dir, 'peaks'), sourceAdapters: { spotify: throwingAdapter() } });
	const { db } = createDb(p);

	const [t0, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11] = TRACKS as [string, string, string, string, string, string, string, string, string, string, string, string];

	// Tags: create, assign, unassign, the system "interested" tag.
	const warm = await svc.createTag('Warm');
	const peak = await svc.createTag('Peak time', '#ff0000');
	await svc.addTrackTag(t0, warm.id);
	await svc.addTrackTag(t1, warm.id);
	await svc.addTrackTag(t2, peak.id);
	await svc.removeTrackTag(t1, warm.id);
	await svc.addTrackTagSkippingLocal([t3, t4], 'interested');
	mut.renameTag(db, peak.id, 'Peak');

	// Playlists: create with members, append, a duplicate via a provider-style
	// reconcile, a drag, a reverse sort, removals, a favourite, a rename.
	const set = await svc.createLocalPlaylistFromTracks('Set A', [t0, t1, t2, t3]);
	await svc.addTracksToPlaylist(set.id, [t4, t5, t0]); // t0 skipped: already in
	const pos = (pid: string): number[] => (source.prepare(`SELECT position FROM playlist_track WHERE playlist_id = ? ORDER BY position`).pluck().all(pid) as number[]);
	const n = pos(set.id).length;
	await svc.reorderPlaylistTracks(set.id, [1, 0, ...Array.from({ length: n - 2 }, (_, i) => i + 2)]); // one drag
	await svc.reorderPlaylistTracks(set.id, [...pos(set.id)].reverse()); // reverse sort
	await svc.removeTracksFromPlaylist(set.id, [t2]);
	await svc.setPlaylistFavorite(set.id, true);
	await svc.renamePlaylist(set.id, 'Set A (final)');

	// A rekordbox-shaped playlist reconciled twice, duplicates included.
	mut.createPlaylist(db, { id: 'rb_9001', source: 'rekordbox', sourceId: '9001', name: 'RB crate', mark: 'R', syncStatus: 'synced' });
	const member = (trackId: string) => ({ trackId, sourceTrackId: `cid-${trackId}`, addedAt: new Date(1_700_000_000_000), addedBy: 'rekordbox' });
	mut.reconcileMembership(db, 'rb_9001', [member(t6), member(t7), member(t6), member(t8)], 'rekordbox');
	mut.reconcileMembership(db, 'rb_9001', [member(t8), member(t6), member(t9), member(t6)], 'rekordbox');

	// Cues: upsert, update, re-upsert one slot, delete one.
	const c1 = await svc.upsertCue({ trackId: t0, slot: 0, kind: 'hot', positionSec: 12.5, lengthSec: null, color: '#00ff00', name: 'Drop' });
	await svc.upsertCue({ trackId: t0, slot: 1, kind: 'hot', positionSec: 30, lengthSec: 4, color: null, name: null });
	const c3 = await svc.upsertCue({ trackId: t1, slot: 2, kind: 'memory', positionSec: 60, lengthSec: null, color: null, name: 'Mem' });
	await svc.updateCue(c1.id, { name: 'Big drop', positionSec: 13 });
	await svc.upsertCue({ trackId: t0, slot: 1, kind: 'hot', positionSec: 31, lengthSec: null, color: '#0000ff', name: 'Loop out' });
	await svc.deleteCue(c3.id);

	// Ratings and overrides, set then partly cleared.
	await svc.setRating([t0, t1, t5], 4);
	await svc.setRating([t1], null);
	await svc.setTrackOverrides(t0, { title: 'Custom title', genre: 'Deep House', bpm: 122 });
	await svc.setTrackOverrides(t0, { genre: null });
	await svc.setTrackOverrides(t5, { artists: [{ name: 'Someone Else' }], label: 'Label X' });
	await svc.clearTrackFields(t5, ['label']);

	// A recording merge: t11 (rated, tagged, cue, in a playlist) into t10.
	await svc.setRating([t11], 2);
	await svc.addTrackTag(t11, warm.id);
	await svc.upsertCue({ trackId: t11, slot: 3, kind: 'hot', positionSec: 5, lengthSec: null, color: null, name: 'Loser cue' });
	await svc.addTracksToPlaylist(set.id, [t11, t10]);
	await svc.setTrackOverrides(t10, { title: 'Keeper' });
	// The loser is in backlog, the keeper unsorted: the local merge carries
	// the stage over and its re-assert states it at the merge's clock.
	mut.recordTrackStateChanges(db, [t11], (raw) => { raw.prepare(`UPDATE track SET state = 'backlog' WHERE id = ?`).run(t11); });
	await svc.mergeTracks(t10, t11);

	// Soft delete + undelete, and a delete that stays.
	await svc.deleteTracks([t7]);
	mut.undeleteTracks(db, [t7]);
	await svc.deleteTracks([t9]);

	// Curation state: a writer's flip (feedPromote's shape, through the same
	// diff seam); t11's backlog was carried onto t10 by the merge above.
	mut.recordTrackStateChanges(db, [t2, t3], (raw) => { raw.prepare(`UPDATE track SET state = 'progress' WHERE id IN (?, ?)`).run(t2, t3); });
	mut.recordTrackStateChanges(db, [t3], (raw) => { raw.prepare(`UPDATE track SET state = 'purchased' WHERE id = ?`).run(t3); });

	// Artists: an override naming the artist about to be renamed, a canonical
	// credit hidden under an unrelated override, then a rename, a merge and
	// a same-key re-spelling.
	await svc.setTrackOverrides(t3, { artists: [{ name: 'Old Name' }, { name: 'Guest' }] });
	await svc.setTrackOverrides(t6, { artists: [{ name: 'Hidden Cover' }] });
	const artistId = (name: string) => source.prepare(`SELECT id FROM artist WHERE name = ? AND merged_into IS NULL`).pluck().get(name) as string;
	await svc.renameArtist(artistId('Old Name'), 'New Name');
	await svc.mergeArtists(artistId('Artist'), artistId('Merge Me'));
	await svc.renameArtist(artistId('Partner'), 'PARTNER');

	// Pinned searches: create, rename, delete.
	const ps = await svc.createPinnedSearch({ name: 'Bright 124', query: 'bpm:124 bright', sort: { column: 'bpm', dir: 'asc' } });
	await svc.createPinnedSearch({ name: 'Doomed', query: 'x' });
	await svc.renamePinnedSearch(ps.id, 'Bright 124+');
	const doomed = (await svc.getPinnedSearches()).find((p) => p.name === 'Doomed')!;
	await svc.deletePinnedSearch(doomed.id);

	// An account setting.
	await svc.setCreditFormat({ separator: '/', remixStyle: 'dash' });

	ops = readOutbox(source);
	want = dumpLibrary(source);
	wantArtists = artistDump(source);
}, 120_000);

afterAll(() => {
	for (const h of handles.splice(0)) { try { h.close(); } catch { /* */ } }
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

describe('outbox replay', () => {
	it('covered every kind of write the test meant to exercise', () => {
		const kinds = new Set(ops.map((o) => `${o.entity}.${o.kind}`));
		for (const k of [
			'tag.create', 'tag.rename', 'track_tag.add', 'track_tag.remove',
			'playlist.create', 'playlist.rename', 'playlist.set-favourite',
			'playlist_track.add', 'playlist_track.move', 'playlist_track.remove',
			'cue.upsert', 'cue.delete', 'library_track.set-rating', 'library_track.set-override',
			'library_track.delete', 'library_track.undelete', 'recording.merge',
			'pinned_search.create', 'pinned_search.rename', 'pinned_search.delete', 'setting.set',
			'library_track.set-state', 'artist_alias.set',
		]) expect(kinds, k).toContain(k);
		// The library is non-trivial on every table the dump compares.
		for (const t of ['trackTags', 'playlists', 'playlistTracks', 'cues', 'pinnedSearches', 'tracks'] as const) expect(want[t].length, t).toBeGreaterThan(0);
	});

	it('a drag is one move and a reverse sort is a move per displaced row', () => {
		const moves = ops.filter((o) => o.entity === 'playlist_track' && o.kind === 'move');
		// 1 (drag) + n-1 (reverse of 6 rows keeps one) + rekordbox reconcile moves.
		expect(moves.length).toBeGreaterThanOrEqual(1 + 5);
	});

	it('replaying the outbox in order reproduces the library', () => {
		const r = replica('in-order');
		applyOps(r, ops);
		expect(diffs(want, dumpLibrary(r))).toEqual([]);
		expect(artistDump(r)).toEqual(wantArtists);
		// Derived positions match too (0..n-1 in key order, restamped on apply).
		const positions = (h: Database.Database) => h.prepare(`SELECT playlist_id, id, position FROM playlist_track ORDER BY playlist_id, position`).all();
		expect(positions(r)).toEqual(positions(source));
	});

	it('converges in any order, across several batches', () => {
		for (const seed of [1, 7, 42, 1234, 5, 9, 13, 21]) {
			const r = replica(`shuffle-${seed}`);
			const mixed = shuffled(ops, seed);
			// Uneven batches: a create can land in a later transaction than the
			// edits that depend on it, the merge after the loser's rows.
			const cuts = [0, Math.floor(mixed.length / 5), Math.floor(mixed.length / 2), mixed.length - 3, mixed.length];
			for (let i = 0; i < cuts.length - 1; i++) applyOps(r, mixed.slice(cuts[i], cuts[i + 1]));
			expect(diffs(want, dumpLibrary(r)), `seed ${seed}`).toEqual([]);
			expect(artistDump(r), `seed ${seed} artists`).toEqual(wantArtists);
			// Idempotent: a re-delivered batch changes nothing.
			applyOps(r, mixed.slice(0, 20));
			expect(diffs(want, dumpLibrary(r)), `seed ${seed} replayed`).toEqual([]);
		}
	});

	it('equals the protocol reducer\'s materialised view of the same ops', () => {
		const view = dumpView(materialize(reduceOps(createLibraryState(), ops).state));
		expect(diffs(want, view)).toEqual([]);
		// And for a shuffled order the reducer agrees with itself and SQLite.
		const view2 = dumpView(materialize(reduceOps(createLibraryState(), shuffled(ops, 99)).state));
		expect(diffs(view, view2)).toEqual([]);
	});

	it('artist renames reach credits, overrides, state and the junction on the replica', () => {
		const r = replica('artists');
		applyOps(r, ops);
		const credits = (h: Database.Database, id: string) => JSON.parse(h.prepare(`SELECT artists FROM track WHERE id = ?`).pluck().get(id) as string);
		expect(credits(source, 'trk-00')).toEqual([{ name: 'New Name' }]);
		expect(credits(source, 'trk-01')).toEqual([{ name: 'Artist' }, { name: 'PARTNER', role: 'featured' }]);
		// The canonical credit under t6's override moved with the rename.
		expect(credits(r, 'trk-06')).toEqual([{ name: 'New Name' }]);
		const ov = (h: Database.Database, id: string) => JSON.parse(h.prepare(`SELECT overrides FROM track WHERE id = ?`).pluck().get(id) as string);
		expect(ov(r, 'trk-03').artists).toEqual([{ name: 'New Name' }, { name: 'Guest' }]);
		const state = (h: Database.Database, id: string) => h.prepare(`SELECT state FROM track WHERE id = ?`).pluck().get(id);
		expect([state(source, 'trk-02'), state(source, 'trk-03'), state(source, 'trk-10')]).toEqual(['progress', 'purchased', 'backlog']);
		expect([state(r, 'trk-02'), state(r, 'trk-03'), state(r, 'trk-10')]).toEqual(['progress', 'purchased', 'backlog']);
		expect(artistCreditRewritePending(r)).toBe(false);
	});

	it('a credit ingested after the rules arrived is mapped through them', () => {
		const r = replica('ingest-after');
		applyOps(r, ops);
		expect(normalizeIncomingArtistsRaw(r, [{ name: 'Old Name' }, { name: 'merge me' }, { name: 'Partner' }])).toEqual([
			{ name: 'New Name' }, { name: 'Artist' }, { name: 'PARTNER' },
		]);
		// The source device maps identically (its own renames).
		expect(normalizeIncomingArtistsRaw(source, [{ name: 'Old Name' }, { name: 'merge me' }, { name: 'Partner' }])).toEqual(
			normalizeIncomingArtistsRaw(r, [{ name: 'Old Name' }, { name: 'merge me' }, { name: 'Partner' }]),
		);
	});

	it('every op the service emitted round-trips the protocol schema', () => {
		// readOutbox re-parses each row with parseOp; reaching here means all did.
		expect(ops.length).toBeGreaterThan(50);
		expect(new Set(ops.map((o) => o.op_id)).size).toBe(ops.length);
	});
});
