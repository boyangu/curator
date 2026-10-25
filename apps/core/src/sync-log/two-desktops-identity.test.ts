// Workstream E: one audio file on several desktops is one recording. Each
// desktop's scanner (or a library from before the op log, through its
// initial push or the recordings backfill) claims its own recording by the
// file's audio hash; the identity resolver (identity.ts) on the desktop that
// holds the larger id merges it into the smaller, and every replica folds
// both copies' tags, ratings, cues and playlist rows onto one recording.
// A library that JOINS an account (the 2026-10-22 sync review) never gets
// that far: the bind sweep (join-bind.ts) puts its rows on the account's
// recordings before it states anything, so no second recording, no claim
// and no merge exist for a file the account already holds.
//
// Same rig and rails as the other two-desktop suites: generated DBs and
// files only, no remoteWritePolicy, streaming adapters that record and
// throw (`upstreamCalls()` stays empty), no rekordbox sidecar.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import * as mut from '../library/mutators.js';
import { normalizePath } from '../local/scanner.js';
import { writeFlac } from '../test-support/catalogue-fakes.js';
import { INITIAL_PUSH_KEY } from './apply.js';
import { planIdentityMerges } from './identity.js';
import { CLAIMS_BACKFILL_KEY } from './initial-push.js';
import { recordingIdForTrack } from './recording-id.js';
import {
	flacParse,
	markPreOpLog,
	playlistOrder,
	replicaDiff,
	scanWaiter,
	tick,
	TRACKS,
	TwoDesktopRig,
	type Desktop,
} from '../test-support/two-desktops.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-2desk-identity-'); });
afterEach(async () => {
	const upstream = rig.upstreamCalls();
	await rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
const ORDERS = [['A syncs first', 'ab'], ['B syncs first', 'ba']] as const;
const HASH = `pcm-md5:${'5eed'.repeat(8)}`;

// Track ids whose recordings sort in a known order, so a test can say which
// desktop holds the survivor. Recording ids are UUIDv5 of the track id.
function idsInOrder(prefixes: readonly string[]): string[] {
	const picked: string[] = [];
	for (const p of prefixes) {
		for (let i = 0; ; i++) {
			const id = `${p}-${i}`;
			if (picked.length === 0 || R(id) > R(picked[picked.length - 1]!)) { picked.push(id); break; }
		}
	}
	return picked;
}

// A row holding a local file with `hash` (the link a scan left; no file is
// needed: nothing walks the folder), written straight into the tables. A
// scan would have claimed it as it created the row; rows written in by hand
// are claimed by the recordings backfill on the first sync instead (the
// library is marked as owing it).
function holdFile(raw: Database.Database, trackId: string, hash = HASH, file = `${trackId}.flac`): void {
	raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES (?, ?, 'local', ?, ?, ?)`)
		.run(`sl-${trackId}-${file}`, trackId, `c:/music/${file}`, `c:/music/${file}`, hash);
	raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(CLAIMS_BACKFILL_KEY);
}

const recOf = (d: Desktop, trackId: string): string => d.one(`SELECT recording_id FROM track WHERE id = ?`, trackId);
const mergeOps = (): Array<{ loser: string; winner: string; device: string }> =>
	rig.cloud.log.filter((o) => o.entity === 'recording' && o.kind === 'merge').map((o) => ({ loser: o.entity_id, winner: (o.payload as { winner: string }).winner, device: o.device_id }));
const tagsOn = (d: Desktop, trackId: string): string[] =>
	d.raw.prepare(`SELECT tag_id FROM track_tag WHERE track_id = ? ORDER BY tag_id`).pluck().all(trackId) as string[];

// ── the scanner on both, before they ever synced ───────────────────────────

describe('the same FLAC scanned on both desktops before syncing', () => {
	it.each(ORDERS)('%s: one recording, both copies\' curation on both', async (_label, order) => {
		const PCM = 'ab12cd34'.repeat(4);
		const a = await rig.desktop('a', { parseAudio: flacParse });
		const b = await rig.desktop('b', { parseAudio: flacParse });
		for (const d of [a, b]) {
			writeFlac(join(d.musicDir, 'Artist - Same Song.flac'), PCM, 'TITLE=Same Song\nARTIST=Artist\n');
			const w = scanWaiter(d, normalizePath(d.musicDir));
			await d.svc.addLibraryFolder(d.musicDir);
			expect((await w.done(1)).created, d.name).toBe(1);
		}
		const idOn = (d: Desktop): string => d.one(`SELECT track_id FROM source_link WHERE source = 'local' AND audio_hash = ?`, `pcm-md5:${PCM}`);
		const [ta, tb] = [idOn(a), idOn(b)];
		const minted = [recOf(a, ta), recOf(b, tb)];

		// Each curates its own copy, offline from the other. B's rating is
		// the later write, so it is the one that stands.
		const warm = await a.svc.createTag('Warm');
		await a.svc.addTrackTag(ta, warm.id);
		await a.svc.setRating([ta], 5);
		const set = await a.svc.createLocalPlaylistFromTracks('A set', [ta, 'trk-1']);
		await tick();
		await b.svc.addTrackTag(tb, 'interested');
		await b.svc.upsertCue({ trackId: tb, slot: 0, kind: 'hot', positionSec: 32, lengthSec: null, color: null, name: 'Drop' });
		await b.svc.setTrackOverrides(tb, { bpm: 124 });
		await b.svc.setRating([tb], 3);

		await rig.settle(order === 'ab' ? [a, b] : [b, a]);

		const survivor = [...minted].sort()[0]!;
		const loser = [...minted].sort()[1]!;
		// One merge, emitted by the desktop whose row moved.
		expect(mergeOps().map((m) => [m.loser, m.winner])).toEqual([[loser, survivor]]);
		expect(mergeOps()[0]!.device).toBe(await (loser === minted[0] ? a : b).deviceId());
		for (const [d, t] of [[a, ta], [b, tb]] as const) {
			expect(recOf(d, t), d.name).toBe(survivor);
			// Re-pointed, not merged away: the row and its file stay put.
			expect(d.one(`SELECT deleted_at FROM track WHERE id = ?`, t), d.name).toBeNull();
			expect(d.one(`SELECT count(*) FROM track WHERE deleted_at IS NOT NULL`), d.name).toBe(0);
			expect(tagsOn(d, t), d.name).toEqual([warm.id, 'interested'].sort());
			expect(d.one(`SELECT rating FROM track WHERE id = ?`, t), d.name).toBe(3);
			expect(JSON.parse(d.one<string>(`SELECT overrides FROM track WHERE id = ?`, t)), d.name).toMatchObject({ bpm: 124 });
			expect(d.one(`SELECT name FROM cue WHERE track_id = ? AND slot = 0 AND kind = 'hot'`, t), d.name).toBe('Drop');
			expect(playlistOrder(d, set.id), d.name).toEqual([survivor, R('trk-1')]);
		}
		expect(replicaDiff(a, b)).toEqual([]);
		// Settled: nothing left to resolve on either side.
		for (const d of [a, b]) expect(planIdentityMerges(d.raw), d.name).toMatchObject({ groups: 0, merges: [], held: [] });
	});
});

// ── libraries from before the op log ───────────────────────────────────────

describe('a library from before the op log joins with a copy of the same file', () => {
	// Whichever side holds the smaller id: A founded the account, so B's row
	// binds to A's recording on join (join-bind.ts) — no claim, no merge.
	it.each([['A holds the smaller id', true], ['B holds the smaller id', false]] as const)('%s: B binds its copy to A\'s recording; nothing merges', async (_label, aSmaller) => {
		const [lo, hi] = idsInOrder(['old-a', 'old-b']);
		const [ida, idb] = aSmaller ? [lo!, hi!] : [hi!, lo!];
		const a = await rig.desktop('a', {
			catalogue: [...TRACKS, ida],
			seed: (raw) => {
				holdFile(raw, ida);
				raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES ('a-old', 'Old A', 'user', 1600000000000)`).run();
				raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, 'a-old', 1600000000000)`).run(ida);
				raw.prepare(`UPDATE track SET rating = 4, isrc = 'GBAAA2000001' WHERE id = ?`).run(ida);
				markPreOpLog(raw);
			},
		});
		await a.sync();
		const b = await rig.desktop('b', {
			catalogue: [...TRACKS, idb],
			seed: (raw) => {
				holdFile(raw, idb);
				raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES ('b-old', 'Old B', 'user', 1600000000000)`).run();
				raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, 'b-old', 1600000000000)`).run(idb);
				markPreOpLog(raw);
			},
		});
		await rig.settle();

		// A's claims are in the base it founded, not on the log; B stated no
		// recording, no claim and no merge: its row took A's recording, and
		// only its tag went up, against that recording.
		expect(rig.cloud.log.filter((o) => o.entity === 'recording_claim' || (o.entity === 'library_track' && o.kind === 'create') || o.entity === 'recording')).toEqual([]);
		expect(mergeOps()).toEqual([]);
		const bId = await b.deviceId();
		expect(rig.cloud.log.filter((o) => o.device_id === bId && o.entity === 'track_tag').map((o) => o.entity_id)).toEqual([`${R(ida)}:b-old`]);
		for (const [d, id] of [[a, ida], [b, idb]] as const) {
			expect(recOf(d, id), d.name).toBe(R(ida));
			expect(tagsOn(d, id), d.name).toEqual(['a-old', 'b-old']);
			expect(d.one(`SELECT rating FROM track WHERE id = ?`, id), d.name).toBe(4);
		}
		expect(replicaDiff(a, b, { sharedOnly: true })).toEqual([]);
		for (const d of [a, b]) expect(planIdentityMerges(d.raw), d.name).toMatchObject({ groups: 0, merges: [], held: [] });
	});

	// A row whose file was linked after the join, under a build that did not
	// claim it: the one-time backfill states the claim, and then the resolver
	// can match — this is the only way a joined library's copy still reaches
	// a merge.
	it('a row claimed only by the backfill, after the join, merges through the resolver', async () => {
		const [lo, hi] = idsInOrder(['scan-a', 'early-b']);
		const a = await rig.desktop('a', { catalogue: [...TRACKS, lo!], seed: (raw) => holdFile(raw, lo!) });
		const b = await rig.desktop('b', { catalogue: [...TRACKS, hi!], seed: (raw) => { raw.prepare(`UPDATE track SET rating = 2 WHERE id = ?`).run(hi!); } });
		await a.svc.addTrackTag(lo!, 'interested');
		await rig.settle();
		// B joined with its row unclaimed (no file): its own recording.
		expect(recOf(b, hi!)).toBe(R(hi!));
		// The file appears under a build that did not claim it; the library is
		// marked as owing the claims backfill (holdFile).
		holdFile(b.raw, hi!);
		expect(b.one(`SELECT count(*) FROM app_setting WHERE key = ?`, CLAIMS_BACKFILL_KEY)).toBe(0);
		await rig.settle();

		expect(b.one(`SELECT count(*) FROM app_setting WHERE key = ?`, CLAIMS_BACKFILL_KEY)).toBe(1);
		const bId = await b.deviceId();
		expect(rig.cloud.log.some((o) => o.entity === 'recording_claim' && o.device_id === bId && o.entity_id === R(hi!) && (o.payload as { value: string }).value === HASH)).toBe(true);
		expect(mergeOps().map((m) => [m.loser, m.winner, m.device])).toEqual([[R(hi!), R(lo!), bId]]);
		expect(recOf(b, hi!)).toBe(R(lo!));
		expect(tagsOn(b, hi!)).toEqual(['interested']);
		// The backfill does not run again: a restart and a sync emit nothing.
		const before = rig.cloud.log.length;
		await b.restart();
		await rig.settle();
		expect(rig.cloud.log.length).toBe(before);
	});
});

// ── three devices ──────────────────────────────────────────────────────────

describe('three devices hold the same file', () => {
	it('every joiner binds its copy to the founder\'s recording; a fourth folds what arrives; no merge anywhere', async () => {
		const [lo, hi] = idsInOrder(['first', 'second']);
		const a = await rig.desktop('a', { catalogue: [...TRACKS, lo!], seed: (raw) => holdFile(raw, lo!) });
		// B and C hold one recording (same catalogue id) with the same file.
		const b = await rig.desktop('b', { catalogue: [...TRACKS, hi!], seed: (raw) => holdFile(raw, hi!) });
		const c = await rig.desktop('c', { catalogue: [...TRACKS, hi!], seed: (raw) => holdFile(raw, hi!) });
		// A fourth desktop with neither copy only folds what arrives.
		const d = await rig.desktop('d');
		await a.svc.setRating([lo!], 5);
		await b.svc.addTrackTag(hi!, 'interested');
		await c.svc.upsertCue({ trackId: hi!, slot: 1, kind: 'hot', positionSec: 64, lengthSec: null, color: null, name: 'C' });
		for (const x of [a, b, c, d]) await x.sync();
		for (const x of [a, b, c, d]) await x.sync();
		await rig.settle();

		expect(mergeOps()).toEqual([]);
		expect(rig.cloud.log.filter((o) => o.entity === 'recording_claim' || (o.entity === 'library_track' && o.kind === 'create'))).toEqual([]);
		for (const [x, id] of [[a, lo!], [b, hi!], [c, hi!]] as const) {
			expect(recOf(x, id), x.name).toBe(R(lo!));
			expect(x.one(`SELECT rating FROM track WHERE id = ?`, id), x.name).toBe(5);
			expect(tagsOn(x, id), x.name).toEqual(['interested']);
			expect(x.one(`SELECT name FROM cue WHERE track_id = ? AND slot = 1`, id), x.name).toBe('C');
		}
		expect(replicaDiff(a, b)).toEqual([]);
		expect(replicaDiff(a, c)).toEqual([]);
		expect(replicaDiff(a, d, { sharedOnly: true })).toEqual([]);
		for (const x of [a, b, c, d]) expect(x.one(`SELECT count(*) FROM recording_alias`), x.name).toBe(0);
	});
});

// ── refused: a desktop's own duplicate files ───────────────────────────────

describe('a desktop that holds two copies of the file as separate rows', () => {
	// A keeps two byte-identical files as two rows on purpose (scanner.ts: a
	// track holds one rekordbox content; the user resolves the pair from the
	// duplicate groups), and here both are rekordbox entries, which
	// merge-tracks refuses outright. B joins with a third copy: it binds to
	// the smaller of A's two (the resolver's survivor, claim-bind.ts step 2),
	// whichever id its own row carried, and A's pair stays held.
	it.each([['B holds the smallest id', 'b-first'], ['one of A\'s rows holds the smallest id', 'a-first']] as const)('%s: A\'s rows are never merged; the hold is reported; B binds to the survivor', async (_label, shape) => {
		const ids = idsInOrder(['dup-x', 'dup-y', 'dup-z']);
		const bId = shape === 'b-first' ? ids[0]! : ids[2]!;
		const [d1, d2] = shape === 'b-first' ? [ids[1]!, ids[2]!] : [ids[0]!, ids[1]!];
		const a = await rig.desktop('a', {
			catalogue: [...TRACKS, d1, d2],
			seed: (raw) => {
				holdFile(raw, d1, HASH, 'copy-1.flac');
				holdFile(raw, d2, HASH, 'copy-2.flac');
				const rb = raw.prepare(`INSERT INTO rekordbox_link (track_id, rb_content_id, rb_local_usn, imported_at, last_synced_at) VALUES (?, ?, 1, 1, 1)`);
				rb.run(d1, '1001');
				rb.run(d2, '1002');
			},
		});
		const b = await rig.desktop('b', { catalogue: [...TRACKS, bId], seed: (raw) => holdFile(raw, bId) });
		await a.svc.addTrackTag(d1, 'interested');
		await rig.settle();

		// A's two rows: still two live recordings.
		expect(recOf(a, d1)).toBe(R(d1));
		expect(recOf(a, d2)).toBe(R(d2));
		expect(a.one(`SELECT count(*) FROM track WHERE id IN (?, ?) AND deleted_at IS NULL`, d1, d2)).toBe(2);
		const plan = planIdentityMerges(a.raw);
		expect(plan.merges).toEqual([]);
		expect(plan.held).toHaveLength(1);
		expect(plan.held[0]).toMatchObject({ reason: 'local-duplicate', trackIds: expect.arrayContaining([d1, d2]) });
		expect(plan.held[0]!.blockers.join(' ')).toMatch(/rekordbox/);
		// B's copy took the smaller of A's recordings on join; nobody emits.
		expect(mergeOps()).toEqual([]);
		expect(recOf(b, bId)).toBe(R(d1));
		expect(tagsOn(b, bId)).toEqual(['interested']);
		expect(planIdentityMerges(b.raw)).toMatchObject({ merges: [] });
		expect(replicaDiff(a, b, { sharedOnly: true })).toEqual([]);
	});
});

// ── deleted recordings ─────────────────────────────────────────────────────

describe('a deleted copy does not take part', () => {
	// A deleted its copy before B's arrived. B's live copy must not merge
	// into the deleted recording (that would delete it) nor the deleted one
	// into it (that would bring it back). An undelete brings the pair back.
	it.each([['the deleted copy holds the smaller id', true], ['the live copy holds the smaller id', false]] as const)('%s', async (_label, deletedSmaller) => {
		const [lo, hi] = idsInOrder(['gone', 'kept']);
		const [ida, idb] = deletedSmaller ? [lo!, hi!] : [hi!, lo!];
		const a = await rig.desktop('a', { catalogue: [...TRACKS, ida], seed: (raw) => holdFile(raw, ida) });
		const b = await rig.desktop('b', { catalogue: [...TRACKS, idb], seed: (raw) => holdFile(raw, idb) });
		await a.svc.addTrackTag(ida, 'interested');
		mut.softDeleteTracks(a.db, [ida]);
		await b.svc.setRating([idb], 2);
		await rig.settle();

		expect(mergeOps()).toEqual([]);
		expect(recOf(a, ida)).toBe(R(ida));
		expect(recOf(b, idb)).toBe(R(idb));
		expect(a.one(`SELECT deleted_at FROM track WHERE id = ?`, ida)).not.toBeNull();
		expect(b.one(`SELECT deleted_at FROM track WHERE id = ?`, idb)).toBeNull();
		expect(tagsOn(b, idb)).toEqual([]);
		for (const d of [a, b]) expect(planIdentityMerges(d.raw), d.name).toMatchObject({ groups: 0, merges: [] });

		await a.svc.undeleteTracks([ida]);
		await rig.settle();
		expect(mergeOps().map((m) => [m.loser, m.winner])).toEqual([[R(hi!), R(lo!)]]);
		for (const [d, id] of [[a, ida], [b, idb]] as const) {
			expect(recOf(d, id), d.name).toBe(R(lo!));
			expect(d.one(`SELECT deleted_at FROM track WHERE id = ?`, id), d.name).toBeNull();
			expect(tagsOn(d, id), d.name).toEqual(['interested']);
			expect(d.one(`SELECT rating FROM track WHERE id = ?`, id), d.name).toBe(2);
		}
		expect(replicaDiff(a, b, { sharedOnly: true })).toEqual([]);
	});
});
