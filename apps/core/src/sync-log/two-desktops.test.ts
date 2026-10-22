// Workstream E's exit test, part 1 (cloud plan, "the sixteen scenarios as
// integration tests across two desktops"): two REAL CoreService instances on
// their own generated databases, each with its own device id, signed in as
// one user to one in-memory cloud (test-support/fake-cloud.ts, the real
// server's push/pull/skip-own/snapshot rules). Each scenario edits through
// the public service methods (a mutator only where no service method
// exists), syncs both until the cloud is quiet, and asserts the normalised
// replica diff (dump.ts) is empty.
//
// This file: joining (1, 2), tag sets (3), playlist order and containers
// (4, 5), concurrent renames (6). Track-level scenarios are in
// two-desktops-tracks.test.ts; history, rekordbox units, offline and a
// third device in two-desktops-history.test.ts.
//
// Generated DBs and files only (CLAUDE.md). No remoteWritePolicy anywhere,
// every streaming adapter records and throws: `upstreamCalls()` stays empty.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { rebalance } from '@curator/protocol';
import { normalizePath } from '../local/scanner.js';
import { writeFlac } from '../test-support/catalogue-fakes.js';
import * as mut from '../library/mutators.js';
import { readCursor } from './client.js';
import { dumpLibrary } from './dump.js';
import { recordingIdForTrack } from './recording-id.js';
import {
	flacParse,
	markPreOpLog,
	playlistOrder,
	positionsContiguous,
	replicaDiff,
	scanWaiter,
	tick,
	TwoDesktopRig,
	type Desktop,
} from '../test-support/two-desktops.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig(); });
afterEach(() => {
	// The receiving side never reached a streaming provider or rekordbox.
	const upstream = rig.upstreamCalls();
	rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;

// Two desktops on the same catalogue, both signed in and synced once.
async function pair(): Promise<[Desktop, Desktop]> {
	const a = await rig.desktop('a');
	const b = await rig.desktop('b');
	await rig.settle();
	return [a, b];
}

const tagged = (d: Desktop, tagId: string): string[] =>
	d.raw.prepare(`SELECT t.recording_id FROM track_tag tt JOIN track t ON t.id = tt.track_id WHERE tt.tag_id = ? ORDER BY t.recording_id`).pluck().all(tagId) as string[];

// A library from before the op log: rows written straight into the tables
// (as every pre-sync install has them), with original timestamps.
function legacyLibrary(raw: Database.Database, p: { tag: string; tagged: string[]; playlist: string; members: string[]; ratings: Array<[string, number]> }): void {
	raw.transaction(() => {
		raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES (?, ?, 'user', ?)`).run(p.tag, `Legacy ${p.tag}`, 1_600_000_000_000);
		const tt = raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, ?)`);
		p.tagged.forEach((t, i) => tt.run(t, p.tag, 1_600_000_000_000 + i));
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name) VALUES (?, 'local', ?, ?)`).run(p.playlist, p.playlist, `Set ${p.playlist}`);
		const keys = rebalance(p.members.length);
		const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, ?, ?)`);
		p.members.forEach((t, i) => row.run(`${p.playlist}-row-${i}`, p.playlist, t, keys[i], i, 1_600_000_000_000, t));
		const rate = raw.prepare(`UPDATE track SET rating = ? WHERE id = ?`);
		for (const [t, r] of p.ratings) rate.run(r, t);
	})();
	markPreOpLog(raw);
}

// ── 1 ───────────────────────────────────────────────────────────────────────

describe('scenario 1 — A founds the account with its library, B joins empty and converges', () => {
	const seedA = (raw: Database.Database) => legacyLibrary(raw, {
		tag: 'leg-warm', tagged: ['trk-0', 'trk-1', 'trk-2'], playlist: 'leg-set', members: ['trk-3', 'trk-1', 'trk-4'], ratings: [['trk-0', 5], ['trk-5', 2]],
	});

	// The pre-op-log rows plus edits made through the service before the
	// first sign-in: a cue, an override, a pinned search.
	async function editBeforeSignIn(a: Desktop): Promise<void> {
		await a.svc.upsertCue({ trackId: 'trk-2', slot: 0, kind: 'hot', positionSec: 32, lengthSec: null, color: '#00ff00', name: 'Drop' });
		await a.svc.setTrackOverrides('trk-6', { title: 'A title' });
		await a.svc.createPinnedSearch({ name: 'Warm', query: 'tag:warm' });
	}

	it('the library goes up as the base snapshot, not as ops; B bootstraps from it and pulls every later op', async () => {
		const a = await rig.desktop('a', { seed: seedA });
		await editBeforeSignIn(a);
		await a.sync();
		expect(await a.svc.getCloudSyncStatus()).toMatchObject({ initialPushDone: true, pending: 0, rejected: 0, lastError: null, phase: null });
		// The founder fold: nothing of the legacy rows reached the log (only
		// the master setting and the edits made before sign-in, which the
		// mutators had already recorded as ops), and the base was published.
		const aId = await a.deviceId();
		expect(rig.cloud.log.some((o) => o.entity === 'track_tag' || o.entity === 'playlist_track' || o.kind === 'set-rating')).toBe(false);
		expect(rig.cloud.log.some((o) => o.entity === 'setting' && o.entity_id === 'library.master_device' && (o.payload as { value: string }).value === aId)).toBe(true);
		expect(rig.cloud.published).toHaveLength(1);
		expect(rig.cloud.published[0]!.seq).toBe(rig.cloud.maxSeq);
		// Every outbox row of A's is on the log: the fold wrote none.
		expect(a.one(`SELECT count(*) FROM sync_outbox`)).toBe(rig.cloud.log.filter((o) => o.device_id === aId).length);

		const b = await rig.desktop('b');
		await rig.settle();
		// Two asks: A's (the founder's, answered empty) and B's, which loaded.
		expect([rig.cloud.calls.bootstrap, rig.cloud.calls.storageBootstraps]).toEqual([2, 1]);
		expect(replicaDiff(a, b)).toEqual([]);
		// Non-trivial on every table the scenario touched.
		const dump = dumpLibrary(b.raw);
		expect(dump.trackTags).toHaveLength(3);
		expect(dump.playlistTracks).toHaveLength(3);
		expect(dump.cues).toHaveLength(1);
		expect(dump.pinnedSearches).toHaveLength(1);
		expect(playlistOrder(b, 'leg-set')).toEqual([R('trk-3'), R('trk-1'), R('trk-4')]);
		expect(b.one(`SELECT rating FROM track WHERE id = 'trk-0'`)).toBe(5);
		// B joined with nothing of its own: no op of B's on the log but the
		// ones the scenario did not make (none).
		const bId = await b.deviceId();
		expect(rig.cloud.log.filter((o) => o.device_id === bId)).toEqual([]);
	});

	it('via a later snapshot: B bootstraps from it, then pulls the ops after it', async () => {
		const a = await rig.desktop('a', { seed: seedA });
		await editBeforeSignIn(a);
		await a.sync();
		const snapSeq = rig.cloud.takeSnapshot();
		rig.cloud.hintBelow = snapSeq;
		// After the snapshot: ops only the stream carries.
		await a.svc.setRating(['trk-0'], 3);
		await a.svc.addTracksToPlaylist('leg-set', ['trk-7']);
		await a.svc.removeTrackTag('trk-1', 'leg-warm');
		await a.sync();

		const b = await rig.desktop('b');
		await rig.settle();
		expect(rig.cloud.calls.storageBootstraps).toBe(1);
		expect(readCursor(b.raw)).toMatchObject({ snapshotSeq: snapSeq, lastSeq: rig.cloud.maxSeq });
		expect(replicaDiff(a, b)).toEqual([]);
		expect(b.one(`SELECT rating FROM track WHERE id = 'trk-0'`)).toBe(3);
		expect(playlistOrder(b, 'leg-set')).toEqual([R('trk-3'), R('trk-1'), R('trk-4'), R('trk-7')]);
		expect(tagged(b, 'leg-warm')).toEqual([R('trk-0'), R('trk-2')].sort());
	});
});

// ── 2 ───────────────────────────────────────────────────────────────────────

describe('scenario 2 — B joins with its own existing library', () => {
	it('A founds, B binds and pushes only its own; the shared catalogue merges into one library on both', async () => {
		const a = await rig.desktop('a', {
			seed: (raw) => legacyLibrary(raw, { tag: 'a-tag', tagged: ['trk-0', 'trk-1'], playlist: 'a-set', members: ['trk-0', 'trk-2'], ratings: [['trk-3', 4]] }),
		});
		const b = await rig.desktop('b', {
			catalogue: [...['trk-0', 'trk-1', 'trk-2', 'trk-3', 'trk-4'], 'b-only'],
			seed: (raw) => legacyLibrary(raw, { tag: 'b-tag', tagged: ['trk-1', 'trk-4', 'b-only'], playlist: 'b-set', members: ['b-only', 'trk-4', 'trk-1'], ratings: [['trk-3', 1], ['trk-4', 5]] }),
		});
		// A signs in first and pushes; B signs in later with its own library.
		await a.sync();
		await b.sync();
		await rig.settle();

		for (const d of [a, b]) expect(await d.svc.getCloudSyncStatus(), d.name).toMatchObject({ initialPushDone: true, pending: 0, rejected: 0, lastError: null });
		// Equal everywhere: B's own catalogue row reaches A as a remote row
		// (remote-rows.ts), made from B's base metadata, with its tag and
		// playlist row.
		expect(replicaDiff(a, b)).toEqual([]);
		// B's join push carried its own rows only: its tag, its playlist, its
		// memberships and ratings, the one recording only it holds — nothing
		// of A's base (no create for a shared catalogue row).
		const bId = await b.deviceId();
		const bOps = rig.cloud.log.filter((o) => o.device_id === bId);
		expect(bOps.filter((o) => o.entity === 'library_track' && o.kind === 'create').map((o) => o.entity_id)).toEqual([R('b-only')]);
		expect(bOps.filter((o) => o.entity === 'tag' && o.kind === 'create').map((o) => o.entity_id)).toEqual(['b-tag']);
		expect(bOps.filter((o) => o.entity === 'playlist' && o.kind === 'create').map((o) => o.entity_id)).toEqual(['b-set']);
		expect(a.one(`SELECT remote_only FROM track WHERE recording_id = ?`, R('b-only'))).toBe(1);
		expect(b.one(`SELECT remote_only FROM track WHERE id = 'b-only'`)).toBe(0);
		// Both libraries' containers on both sides.
		for (const d of [a, b]) {
			expect(d.all(`SELECT id FROM tag WHERE kind = 'user' ORDER BY id`).map((r) => (r as { id: string }).id)).toEqual(['a-tag', 'b-tag']);
			expect(d.all(`SELECT id FROM playlist ORDER BY id`).map((r) => (r as { id: string }).id)).toEqual(['a-set', 'b-set']);
		}
		expect(tagged(a, 'b-tag')).toEqual([R('trk-1'), R('trk-4'), R('b-only')].sort());
		expect(playlistOrder(a, 'b-set')).toEqual([R('b-only'), R('trk-4'), R('trk-1')]);
		expect(playlistOrder(b, 'b-set')).toEqual([R('b-only'), R('trk-4'), R('trk-1')]);
		// The same recording rated on both before they met: one answer.
		expect(a.one(`SELECT rating FROM track WHERE id = 'trk-3'`)).toBe(b.one(`SELECT rating FROM track WHERE id = 'trk-3'`));
	});

	// The same song scanned on each desktop before they ever synced: each
	// scanner mints its own row (its own recording id) and pushes a create
	// with the file's audio-hash claim. The identity resolver (identity.ts)
	// on the desktop holding the larger id merges it into the smaller, so
	// both rows end on one recording and A's tag reaches B's copy.
	it('the same file scanned on both desktops becomes one recording (audio-hash claims resolve)', async () => {
		const PCM = 'ab12cd34'.repeat(4);
		const a = await rig.desktop('a', { parseAudio: flacParse });
		const b = await rig.desktop('b', { parseAudio: flacParse });
		for (const d of [a, b]) {
			writeFlac(join(d.musicDir, 'Artist - Same Song.flac'), PCM, 'TITLE=Same Song\nARTIST=Artist\n');
			const w = scanWaiter(d, normalizePath(d.musicDir));
			await d.svc.addLibraryFolder(d.musicDir);
			expect((await w.done(1)).created, d.name).toBe(1);
		}
		await rig.settle();
		const idOn = (d: Desktop): string => d.one(`SELECT track_id FROM source_link WHERE source = 'local' AND audio_hash = ?`, `pcm-md5:${PCM}`);
		const recOn = (d: Desktop): string => d.one(`SELECT recording_id FROM track WHERE id = ?`, idOn(d));
		// Both pushed a create and the claim for their own recording; one
		// merge op folded the larger id into the smaller, and both rows now
		// carry the survivor.
		const claims = rig.cloud.log.filter((o) => o.entity === 'recording_claim' && (o.payload as { value?: string }).value === `pcm-md5:${PCM}`);
		const minted = [...new Set(claims.map((o) => o.entity_id))].sort();
		expect(minted).toHaveLength(2);
		expect(rig.cloud.log.filter((o) => o.entity === 'recording').map((o) => [o.entity_id, (o.payload as { winner: string }).winner])).toEqual([[minted[1], minted[0]]]);
		expect(recOn(a)).toBe(minted[0]);
		expect(recOn(b)).toBe(minted[0]);
		await a.svc.addTrackTag(idOn(a), 'interested');
		await rig.settle();
		expect(recOn(a)).toBe(recOn(b));
		expect(b.one(`SELECT count(*) FROM track_tag WHERE track_id = ? AND tag_id = 'interested'`, idOn(b))).toBe(1);
	});
});

// ── 3 ───────────────────────────────────────────────────────────────────────

describe('scenario 3 — concurrent tag add on A, remove on B (a remove cancels only earlier adds)', () => {
	it.each([['A reconnects first', 'ab'], ['B reconnects first', 'ba']] as const)('%s', async (_label, order) => {
		const [a, b] = await pair();
		const t = await a.svc.createTag('Warm');
		for (const id of ['trk-1', 'trk-2']) await a.svc.addTrackTag(id, t.id);
		await rig.settle();

		// Offline on both. trk-1: B removes, THEN A re-adds (a later add the
		// remove never saw: survives). trk-2: A re-adds, THEN B removes (the
		// later remove cancels the add). trk-5 / trk-6: fresh adds, one side each.
		await b.svc.removeTrackTag('trk-1', t.id);
		await tick();
		await a.svc.removeTrackTag('trk-1', t.id);
		await a.svc.addTrackTag('trk-1', t.id);
		await a.svc.removeTrackTag('trk-2', t.id);
		await a.svc.addTrackTag('trk-2', t.id);
		await tick();
		await b.svc.removeTrackTag('trk-2', t.id);
		await a.svc.addTrackTag('trk-5', t.id);
		await b.svc.addTrackTag('trk-6', t.id);

		await rig.settle(order === 'ab' ? [a, b] : [b, a]);
		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) expect(tagged(d, t.id), d.name).toEqual([R('trk-1'), R('trk-5'), R('trk-6')].sort());
	});
});

// ── 4 ───────────────────────────────────────────────────────────────────────

describe('scenario 4 — concurrent reorders plus add/remove on both converge to one order', () => {
	it.each([['A reconnects first', 'ab'], ['B reconnects first', 'ba']] as const)('%s', async (_label, order) => {
		const [a, b] = await pair();
		const set = await a.svc.createLocalPlaylistFromTracks('Set', ['trk-0', 'trk-1', 'trk-2', 'trk-3', 'trk-4', 'trk-5']);
		await rig.settle();
		expect(playlistOrder(b, set.id)).toEqual(['trk-0', 'trk-1', 'trk-2', 'trk-3', 'trk-4', 'trk-5'].map(R));

		// A: drag trk-5 to the top, drop trk-2, append trk-7.
		await a.svc.reorderPlaylistTracks(set.id, [5, 0, 1, 2, 3, 4]);
		await a.svc.removeTracksFromPlaylist(set.id, ['trk-2']);
		await a.svc.addTracksToPlaylist(set.id, ['trk-7']);
		// B, concurrently: reverse the whole list, add trk-6, then move it
		// to the second slot; remove trk-4.
		await tick();
		await b.svc.reorderPlaylistTracks(set.id, [5, 4, 3, 2, 1, 0]);
		await b.svc.addTracksToPlaylist(set.id, ['trk-6']);
		await b.svc.reorderPlaylistTracks(set.id, [0, 6, 1, 2, 3, 4, 5]);
		await b.svc.removeTracksFromPlaylist(set.id, ['trk-4']);

		await rig.settle(order === 'ab' ? [a, b] : [b, a]);
		expect(replicaDiff(a, b)).toEqual([]);
		const oa = playlistOrder(a, set.id);
		expect(oa).toEqual(playlistOrder(b, set.id));
		expect(new Set(oa)).toEqual(new Set(['trk-0', 'trk-1', 'trk-3', 'trk-5', 'trk-6', 'trk-7'].map(R)));
		expect(oa).toHaveLength(6);
		for (const d of [a, b]) {
			expect(positionsContiguous(d, set.id), d.name).toBe(true);
			expect(d.one(`SELECT track_count FROM playlist WHERE id = ?`, set.id), d.name).toBe(6);
		}
	});
});

// ── 5 ───────────────────────────────────────────────────────────────────────

describe('scenario 5 — playlist delete on A vs a track add to it on B', () => {
	it.each([['B adds before A deletes', 'add-first'], ['B adds after A deletes (still unseen)', 'delete-first']] as const)('%s: the delete wins on both', async (_label, when) => {
		const [a, b] = await pair();
		const set = await a.svc.createLocalPlaylistFromTracks('Doomed', ['trk-0', 'trk-1']);
		await rig.settle();

		if (when === 'add-first') {
			await b.svc.addTracksToPlaylist(set.id, ['trk-2', 'trk-3']);
			await tick();
			mut.deletePlaylist(a.db, set.id);
		} else {
			mut.deletePlaylist(a.db, set.id);
			await tick();
			await b.svc.addTracksToPlaylist(set.id, ['trk-2', 'trk-3']);
		}
		await rig.settle([b, a]);
		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(d.one(`SELECT count(*) FROM playlist WHERE id = ?`, set.id), d.name).toBe(0);
			expect(d.one(`SELECT count(*) FROM playlist_track WHERE playlist_id = ?`, set.id), d.name).toBe(0);
		}
	});
});

// ── 6 ───────────────────────────────────────────────────────────────────────

describe('scenario 6 — the same tag and playlist renamed on both: last writer wins, both agree', () => {
	it.each([['A reconnects first', 'ab'], ['B reconnects first', 'ba']] as const)('%s', async (_label, order) => {
		const [a, b] = await pair();
		const t = await a.svc.createTag('Warm');
		const set = await a.svc.createLocalPlaylistFromTracks('Set', ['trk-0']);
		// A provider playlist A's read-sync knows (the mutator its sync uses);
		// B only ever receives it.
		mut.createPlaylist(a.db, { id: 'sp-pl-1', source: 'spotify', sourceId: 'sp-remote-1', name: 'Spotify set', syncStatus: 'synced' });
		await rig.settle();
		expect(b.one(`SELECT name FROM playlist WHERE id = 'sp-pl-1'`)).toBe('Spotify set');

		// Tag: A first, B later (B wins). Playlist: B first, A later (A wins).
		mut.renameTag(a.db, t.id, 'Warm (A)');
		await b.svc.renamePlaylist(set.id, 'Set (B)');
		await tick();
		mut.renameTag(b.db, t.id, 'Warm (B)');
		await a.svc.renamePlaylist(set.id, 'Set (A)');
		// Spotify renamed it upstream; A's read-sync records the new name.
		mut.renamePlaylist(a.db, 'sp-pl-1', 'Spotify set (renamed upstream)');

		await rig.settle(order === 'ab' ? [a, b] : [b, a]);
		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(d.one(`SELECT name FROM tag WHERE id = ?`, t.id), d.name).toBe('Warm (B)');
			expect(d.one(`SELECT name FROM playlist WHERE id = ?`, set.id), d.name).toBe('Set (A)');
			expect(d.one(`SELECT name FROM playlist WHERE id = 'sp-pl-1'`), d.name).toBe('Spotify set (renamed upstream)');
		}
	});
});

// The catalogue seed is the rig's; this guards the assumption every
// scenario makes (same track id ⇒ same recording on every device).
it('seeded catalogue rows share recording ids across devices', async () => {
	const [a, b] = await pair();
	for (const id of ['trk-0', 'trk-9']) expect(a.one(`SELECT recording_id FROM track WHERE id = ?`, id)).toBe(b.one(`SELECT recording_id FROM track WHERE id = ?`, id));
});
