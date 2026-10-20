// Workstream E's exit test, part 2: track-level scenarios across two
// desktops (see two-desktops.test.ts for the rig and the rules): delete vs
// edit and undelete (7), a synced delete vs the other desktop's scanner (8),
// a recording merge vs edits to the merged-away track (9), cues (10),
// overrides (11), artist alias rules (12), curation state and the system
// tags (13).
//
// Generated DBs and files only (CLAUDE.md): every FLAC is written under the
// rig's temp dir; no service gets a remoteWritePolicy; `trashFile` records
// instead of trashing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renameSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { audioHash } from '../ingest/audio-hash.js';
import * as mut from '../library/mutators.js';
import { normalizeIncomingArtistsRaw } from '../library/artists.js';
import { normalizePath } from '../local/scanner.js';
import { writeFlac } from '../test-support/catalogue-fakes.js';
import { recordingIdForTrack } from './recording-id.js';
import {
	creditDump,
	flacParse,
	replicaDiff,
	scanWaiter,
	tick,
	TRACKS,
	TwoDesktopRig,
	type Desktop,
	type DesktopOpts,
} from '../test-support/two-desktops.js';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig(); });
afterEach(() => {
	const upstream = rig.upstreamCalls();
	rig.close();
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
const ORDERS = [['A reconnects first', 'ab'], ['B reconnects first', 'ba']] as const;

async function pair(opts: DesktopOpts = {}): Promise<[Desktop, Desktop]> {
	const a = await rig.desktop('a', opts);
	const b = await rig.desktop('b', opts);
	await rig.settle();
	return [a, b];
}
const both = (a: Desktop, b: Desktop, order: 'ab' | 'ba'): Desktop[] => (order === 'ab' ? [a, b] : [b, a]);

type TrackRow = { rating: number | null; state: string; overrides: string | null; deleted_at: number | null };
const row = (d: Desktop, id: string): TrackRow => d.raw.prepare(`SELECT rating, state, overrides, deleted_at FROM track WHERE id = ?`).get(id) as TrackRow;
const overrides = (d: Desktop, id: string): Record<string, unknown> => JSON.parse(row(d, id).overrides ?? '{}') as Record<string, unknown>;

// ── 7 ───────────────────────────────────────────────────────────────────────

describe('scenario 7 — track delete on A vs a rating/override edit on B, then undelete', () => {
	it.each([
		['B edits before A deletes', 'edit-first', 'ab'],
		['B edits before A deletes', 'edit-first', 'ba'],
		['B edits after A deletes (unseen)', 'delete-first', 'ab'],
		['B edits after A deletes (unseen)', 'delete-first', 'ba'],
	] as const)('%s, %s… sync order %s', async (_label, when, order) => {
		const [a, b] = await pair();
		const set = await a.svc.createLocalPlaylistFromTracks('Set', ['trk-1', 'trk-2']);
		await rig.settle();

		const editOnB = async () => {
			await b.svc.setRating(['trk-1'], 4);
			await b.svc.setTrackOverrides('trk-1', { title: 'B title', bpm: 126 });
		};
		if (when === 'edit-first') { await editOnB(); await tick(); await a.svc.deleteTracks(['trk-1']); }
		else { await a.svc.deleteTracks(['trk-1']); await tick(); await editOnB(); }
		await rig.settle(both(a, b, order));

		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			const r = row(d, 'trk-1');
			expect(r.deleted_at, `${d.name} deleted`).not.toBeNull();
			expect(r.rating, d.name).toBe(4);
			expect(overrides(d, 'trk-1'), d.name).toEqual({ title: 'B title', bpm: 126 });
			// The delete took the track out of the playlist on both.
			expect(d.one(`SELECT count(*) FROM playlist_track WHERE playlist_id = ? AND track_id = 'trk-1'`, set.id), d.name).toBe(0);
		}

		// Undelete on B (the device that did not delete it).
		mut.undeleteTracks(b.db, ['trk-1']);
		await rig.settle(both(a, b, order));
		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(row(d, 'trk-1').deleted_at, `${d.name} undeleted`).toBeNull();
			expect(row(d, 'trk-1').rating, d.name).toBe(4);
			expect(overrides(d, 'trk-1').title, d.name).toBe('B title');
		}
	});
});

// ── 8 ───────────────────────────────────────────────────────────────────────

describe('scenario 8 — a track deleted on A while B still has its file: B\'s scanner must not resurrect it', () => {
	const PCM = 'c0ffee00'.repeat(4);
	const LOC = 'loc-1';

	// Both desktops hold the recording with a local file in their own music
	// dir — the rows a scan left (link with the file's real stat and hash),
	// so an unchanged file is skipped by the next walk.
	const withFile: DesktopOpts = {
		catalogue: [...TRACKS, LOC],
		parseAudio: flacParse,
		seed: async (raw: Database.Database, { musicDir }) => {
			const file = join(musicDir, 'Someone - Song.flac');
			writeFlac(file, PCM, 'TITLE=Song\nARTIST=Someone\n');
			const st = statSync(file);
			const norm = normalizePath(file);
			raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_mtime, file_size, audio_hash) VALUES (?, ?, 'local', ?, ?, ?, ?, ?)`)
				.run(`sl-${LOC}`, LOC, norm, norm, Math.trunc(st.mtimeMs), st.size, await audioHash(file));
			raw.prepare(`UPDATE track SET title = 'Song', artists = '[{"name":"Someone"}]' WHERE id = ?`).run(LOC);
		},
	};

	const liveWithAudio = (d: Desktop): number => d.one(`SELECT count(*) FROM track t WHERE t.deleted_at IS NULL
		AND EXISTS (SELECT 1 FROM source_link sl WHERE sl.track_id = t.id AND sl.source = 'local' AND sl.audio_hash = ?)`, `pcm-md5:${PCM}`);

	// B watches its music folder; A deletes the track; B learns of it.
	async function deletedWhileBHoldsTheFile(): Promise<{ a: Desktop; b: Desktop; tracksBefore: number }> {
		const [a, b] = await pair(withFile);
		const first = scanWaiter(b, normalizePath(b.musicDir));
		await b.svc.addLibraryFolder(b.musicDir);
		expect((await first.done(1)).skipped).toBe(1);
		const tracksBefore = b.one<number>(`SELECT count(*) FROM track`);

		const del = await a.svc.deleteTracks([LOC]);
		expect(del.deletedTracks).toBe(1);
		await rig.settle();
		expect(row(b, LOC).deleted_at).not.toBeNull();
		expect(liveWithAudio(b)).toBe(0);
		// A's own file went to (a recorder of) the trash, under the rig dir.
		expect(a.trashed.every((p) => normalizePath(p).startsWith(normalizePath(rig.dir)))).toBe(true);
		return { a, b, tracksBefore };
	}

	// B restarts and its scanner walks the folder; then both sync.
	async function walkOnB(b: Desktop): Promise<void> {
		await b.restart();
		const w = scanWaiter(b, normalizePath(b.musicDir));
		await b.svc.startLibraryWatching();
		await w.done(1);
		await tick(50);
	}

	async function expectNotResurrected(a: Desktop, b: Desktop, tracksBefore: number, logFrom: number): Promise<void> {
		// No live row for that audio, no new row at all, no create pushed.
		expect(liveWithAudio(b)).toBe(0);
		expect(b.one(`SELECT count(*) FROM track`)).toBe(tracksBefore);
		await rig.settle();
		expect(rig.cloud.log.slice(logFrom).filter((o) => o.entity === 'library_track' && o.kind === 'create')).toEqual([]);
		expect(row(a, LOC).deleted_at).not.toBeNull();
		expect(row(b, LOC).deleted_at).not.toBeNull();
		expect(replicaDiff(a, b)).toEqual([]);
	}

	it('the startup walk finds the file unchanged at its path', async () => {
		const { a, b, tracksBefore } = await deletedWhileBHoldsTheFile();
		const from = rig.cloud.log.length;
		await walkOnB(b);
		await expectNotResurrected(a, b, tracksBefore, from);
	});

	it('the file was re-tagged in place (new mtime/size, same audio)', async () => {
		const { a, b, tracksBefore } = await deletedWhileBHoldsTheFile();
		const from = rig.cloud.log.length;
		writeFlac(join(b.musicDir, 'Someone - Song.flac'), PCM, 'TITLE=Song (re-tagged)\nARTIST=Someone Else\nCOMMENT=edited by a tag editor\n');
		await walkOnB(b);
		await expectNotResurrected(a, b, tracksBefore, from);
	});

	// The file moved while B was not running: the walk sees a new path whose
	// audio belongs to a deleted row, and tags the scorer cannot match. The
	// hash re-bind only looks at live rows, so before the E2 scanner change
	// ("a deleted track stays deleted", deletedOwnerOf) this minted a fresh
	// live row and pushed its create: the delete undone everywhere.
	it('the file moved to another folder inside the library', async () => {
		const { a, b, tracksBefore } = await deletedWhileBHoldsTheFile();
		const from = rig.cloud.log.length;
		mkdirSync(join(b.musicDir, 'moved'), { recursive: true });
		renameSync(join(b.musicDir, 'Someone - Song.flac'), join(b.musicDir, 'moved', 'Song.flac'));
		writeFlac(join(b.musicDir, 'moved', 'Song.flac'), PCM, 'TITLE=Untitled 07\n');
		await walkOnB(b);
		await expectNotResurrected(a, b, tracksBefore, from);
	});

	// B never had the file linked: it held the recording without a local
	// copy when the delete arrived, and the file turns up later in a newly
	// added folder. Only the recording's audio-hash claim ties the file to
	// the deleted row: A's scanner matched its copy to the recording and
	// pushed the claim.
	it('the file first appears on B after the delete (known only by the recording\'s audio-hash claim)', async () => {
		const named = (raw: Database.Database) => { raw.prepare(`UPDATE track SET title = 'Song', artists = '[{"name":"Someone"}]' WHERE id = ?`).run(LOC); };
		const a = await rig.desktop('a', { catalogue: [...TRACKS, LOC], parseAudio: flacParse, seed: named });
		const b = await rig.desktop('b', { catalogue: [...TRACKS, LOC], parseAudio: flacParse, seed: named });
		writeFlac(join(a.musicDir, 'Someone - Song.flac'), PCM, 'TITLE=Song\nARTIST=Someone\n');
		const scanA = scanWaiter(a, normalizePath(a.musicDir));
		await a.svc.addLibraryFolder(a.musicDir);
		expect((await scanA.done(1)).matched).toBe(1);
		await rig.settle();
		expect(rig.cloud.log.some((o) => o.entity === 'recording_claim' && o.entity_id === R(LOC) && (o.payload as { value?: string }).value === `pcm-md5:${PCM}`)).toBe(true);
		await a.svc.deleteTracks([LOC]);
		await rig.settle();
		expect(row(b, LOC).deleted_at).not.toBeNull();
		const tracksBefore = b.one<number>(`SELECT count(*) FROM track`);
		const from = rig.cloud.log.length;

		const later = join(b.dir, 'downloads');
		writeFlac(join(later, 'Song.flac'), PCM, 'TITLE=Song\nARTIST=Someone\n');
		const w = scanWaiter(b, normalizePath(later));
		await b.svc.addLibraryFolder(later);
		await w.done(1);
		await tick(50);
		await expectNotResurrected(a, b, tracksBefore, from);
	});
});

// ── 9 ───────────────────────────────────────────────────────────────────────

describe('scenario 9 — a recording merge on A while B edits the merged-away track', () => {
	it.each(ORDERS)('B edits after the merge (unseen): B\'s edits land on the kept recording — %s', async (_label, order) => {
		const [a, b] = await pair();
		const t = await a.svc.createTag('Warm');
		const set = await a.svc.createLocalPlaylistFromTracks('Set', ['trk-3', 'trk-4']);
		await rig.settle();

		await a.svc.mergeTracks('trk-4', 'trk-5');
		await tick();
		await b.svc.setRating(['trk-5'], 3);
		await b.svc.addTrackTag('trk-5', t.id);
		await b.svc.upsertCue({ trackId: 'trk-5', slot: 2, kind: 'hot', positionSec: 40, lengthSec: null, color: null, name: 'B cue' });
		await b.svc.setTrackOverrides('trk-5', { title: 'B edit' });
		await b.svc.addTracksToPlaylist(set.id, ['trk-5']);
		await rig.settle(both(a, b, order));

		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(row(d, 'trk-5').deleted_at, `${d.name}: loser row soft-deleted`).not.toBeNull();
			expect(row(d, 'trk-4').rating, d.name).toBe(3);
			expect(overrides(d, 'trk-4').title, d.name).toBe('B edit');
			expect(d.one(`SELECT count(*) FROM track_tag WHERE track_id = 'trk-4' AND tag_id = ?`, t.id), d.name).toBe(1);
			expect(d.one(`SELECT name FROM cue WHERE track_id = 'trk-4' AND slot = 2 AND kind = 'hot'`), d.name).toBe('B cue');
			expect(d.one(`SELECT count(*) FROM recording_alias WHERE loser = ? AND winner = ?`, R('trk-5'), R('trk-4')), d.name).toBe(1);
		}
	});

	it.each(ORDERS)('B edits before the merge: the kept side\'s values win where it had one, the loser\'s fill the rest — %s', async (_label, order) => {
		const [a, b] = await pair();
		const t = await a.svc.createTag('Warm');
		await a.svc.setRating(['trk-4'], 5);
		await rig.settle();

		await b.svc.setRating(['trk-5'], 1);
		await b.svc.addTrackTag('trk-5', t.id);
		await b.svc.upsertCue({ trackId: 'trk-5', slot: 2, kind: 'hot', positionSec: 40, lengthSec: null, color: null, name: 'B cue' });
		await tick();
		await a.svc.mergeTracks('trk-4', 'trk-5');
		await rig.settle(both(a, b, order));

		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(row(d, 'trk-4').rating, d.name).toBe(5);
			expect(d.one(`SELECT count(*) FROM track_tag WHERE track_id = 'trk-4' AND tag_id = ?`, t.id), d.name).toBe(1);
			expect(d.one(`SELECT name FROM cue WHERE track_id = 'trk-4' AND slot = 2 AND kind = 'hot'`), d.name).toBe('B cue');
		}
	});
});

// ── 10 ──────────────────────────────────────────────────────────────────────

describe('scenario 10 — cues upserted and deleted on both', () => {
	it.each(ORDERS)('%s', async (_label, order) => {
		const [a, b] = await pair();
		const cue = (d: Desktop, trackId: string, slot: number, kind: 'hot' | 'memory') =>
			d.raw.prepare(`SELECT id, position_sec AS pos, name FROM cue WHERE track_id = ? AND slot = ? AND kind = ?`).get(trackId, slot, kind) as { id: string; pos: number; name: string | null } | undefined;
		await a.svc.upsertCue({ trackId: 'trk-0', slot: 0, kind: 'hot', positionSec: 10, lengthSec: null, color: null, name: 'Intro' });
		await a.svc.upsertCue({ trackId: 'trk-0', slot: 1, kind: 'hot', positionSec: 20, lengthSec: null, color: null, name: 'Build' });
		await a.svc.upsertCue({ trackId: 'trk-0', slot: 2, kind: 'memory', positionSec: 30, lengthSec: null, color: null, name: 'Mem' });
		await rig.settle();

		// slot 0: both rename, B later (B wins).
		await a.svc.updateCue(cue(a, 'trk-0', 0, 'hot')!.id, { name: 'Intro (A)' });
		// slot 1: B deletes, then A moves it (the later edit revives it).
		await b.svc.deleteCue(cue(b, 'trk-0', 1, 'hot')!.id);
		// memory 2: B moves it, then A deletes it (the later delete wins).
		await b.svc.updateCue(cue(b, 'trk-0', 2, 'memory')!.id, { positionSec: 31 });
		// trk-1 slot 3: a new cue on each side, A later (A wins).
		await b.svc.upsertCue({ trackId: 'trk-1', slot: 3, kind: 'hot', positionSec: 5, lengthSec: null, color: '#ff0000', name: 'B new' });
		await tick();
		await b.svc.updateCue(cue(b, 'trk-0', 0, 'hot')!.id, { name: 'Intro (B)' });
		await a.svc.updateCue(cue(a, 'trk-0', 1, 'hot')!.id, { positionSec: 21 });
		await a.svc.deleteCue(cue(a, 'trk-0', 2, 'memory')!.id);
		await a.svc.upsertCue({ trackId: 'trk-1', slot: 3, kind: 'hot', positionSec: 6, lengthSec: 4, color: null, name: 'A new' });

		await rig.settle(both(a, b, order));
		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(cue(d, 'trk-0', 0, 'hot')?.name, d.name).toBe('Intro (B)');
			expect(cue(d, 'trk-0', 1, 'hot')?.pos, d.name).toBe(21);
			expect(cue(d, 'trk-0', 2, 'memory'), d.name).toBeUndefined();
			expect(cue(d, 'trk-1', 3, 'hot')?.name, d.name).toBe('A new');
		}
	});
});

// ── 11 ──────────────────────────────────────────────────────────────────────

describe('scenario 11 — overrides (title, artists, bpm, key) on both', () => {
	it.each(ORDERS)('%s', async (_label, order) => {
		const [a, b] = await pair();
		await a.svc.setTrackOverrides('trk-1', { title: 'Base title' });
		await rig.settle();

		// Different fields on one track: both survive. The same field: the
		// later write wins. A clear (B) after a set (A): cleared.
		await a.svc.setTrackOverrides('trk-0', { title: 'A title', bpm: 124 });
		await b.svc.setTrackOverrides('trk-0', { keyCamelot: '8A', artists: [{ name: 'B Artist' }] });
		await a.svc.setTrackOverrides('trk-1', { title: 'A title 1' });
		await tick();
		await a.svc.setTrackOverrides('trk-0', { artists: [{ name: 'A Artist' }] });
		await b.svc.clearTrackFields('trk-1', ['title']);

		await rig.settle(both(a, b, order));
		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(overrides(d, 'trk-0'), d.name).toEqual({ title: 'A title', bpm: 124, keyCamelot: '8A', artists: [{ name: 'A Artist' }] });
			expect(overrides(d, 'trk-1').title, d.name).toBeUndefined();
		}
		// The artist junction follows the effective (overridden) credits.
		expect(creditDump(a, TRACKS)).toEqual(creditDump(b, TRACKS));
	});
});

// ── 12 ──────────────────────────────────────────────────────────────────────

describe('scenario 12 — artist alias / rename rules on both', () => {
	const CREDITS: Record<string, Array<{ name: string }>> = {
		'trk-0': [{ name: 'Old Name' }],
		'trk-1': [{ name: 'Old Name' }, { name: 'Friend' }],
		'trk-2': [{ name: 'Merge Me' }],
		'trk-3': [{ name: 'Artist' }],
		'trk-4': [{ name: 'Partner' }, { name: 'Artist' }],
	};
	const artists = (id: string) => CREDITS[id] ?? [{ name: 'Someone' }];
	const artistId = (d: Desktop, name: string): string => d.one(`SELECT id FROM artist WHERE name = ? AND merged_into IS NULL`, name);
	// How each device maps a credit arriving from outside (scanner, Spotify…).
	const maps = (d: Desktop, names: string[]) => names.map((name) => normalizeIncomingArtistsRaw(d.raw, [{ name }])[0]!.name);

	it.each(ORDERS)('independent rules on each side (rename, merge, re-spelling) converge — %s', async (_label, order) => {
		const [a, b] = await pair({ artists });
		await a.svc.renameArtist(artistId(a, 'Old Name'), 'New Name');
		await a.svc.renameArtist(artistId(a, 'Partner'), 'PARTNER');
		await b.svc.mergeArtists(artistId(b, 'Artist'), artistId(b, 'Merge Me'));
		await rig.settle(both(a, b, order));

		expect(replicaDiff(a, b)).toEqual([]);
		expect(creditDump(a, TRACKS)).toEqual(creditDump(b, TRACKS));
		for (const d of [a, b]) {
			expect(JSON.parse(d.one(`SELECT artists FROM track WHERE id = 'trk-1'`)), d.name).toEqual([{ name: 'New Name' }, { name: 'Friend' }]);
			expect(JSON.parse(d.one(`SELECT artists FROM track WHERE id = 'trk-2'`)), d.name).toEqual([{ name: 'Artist' }]);
			expect(maps(d, ['Old Name', 'merge me', 'partner']), d.name).toEqual(['New Name', 'Artist', 'PARTNER']);
		}
	});

	it.each(ORDERS)('a chain across devices: B merges into an artist A renames concurrently — %s', async (_label, order) => {
		const [a, b] = await pair({ artists });
		await b.svc.mergeArtists(artistId(b, 'Artist'), artistId(b, 'Merge Me'));
		await tick();
		await a.svc.renameArtist(artistId(a, 'Artist'), 'Artist X');
		await rig.settle(both(a, b, order));

		expect(replicaDiff(a, b)).toEqual([]);
		expect(creditDump(a, TRACKS)).toEqual(creditDump(b, TRACKS));
		for (const d of [a, b]) {
			// merge me → Artist → Artist X, resolved as a chain.
			expect(JSON.parse(d.one(`SELECT artists FROM track WHERE id = 'trk-2'`)), d.name).toEqual([{ name: 'Artist X' }]);
			expect(JSON.parse(d.one(`SELECT artists FROM track WHERE id = 'trk-3'`)), d.name).toEqual([{ name: 'Artist X' }]);
		}
	});

	const credits = (d: Desktop, id: string): unknown => JSON.parse(d.one(`SELECT artists FROM track WHERE id = ?`, id));
	const converged = (a: Desktop, b: Desktop): void => {
		expect(replicaDiff(a, b)).toEqual([]);
		expect(creditDump(a, TRACKS)).toEqual(creditDump(b, TRACKS));
	};
	// Which device writes last (and so wins the contested rule keys).
	const LAST = [['A renames last', 'a'], ['B renames last', 'b']] as const;

	// The same artist renamed to two different names, one per device. The
	// rule keyed "old name" resolves to the later one on both (per-key LWW).
	// Each device rewrote its own credits to its own name first; credits are
	// derived from the source spelling under the converged rules, so the
	// losing rewrite does not survive on the device that made it.
	describe.each(LAST)('the same artist renamed differently on each side — %s', (_l, last) => {
		it.each(ORDERS)('ends with one name on both — %s', async (_label, order) => {
			const [a, b] = await pair({ artists });
			const [first, second] = last === 'b' ? [a, b] : [b, a];
			await first.svc.renameArtist(artistId(first, 'Old Name'), `New ${first.name.toUpperCase()}`);
			await tick();
			await second.svc.renameArtist(artistId(second, 'Old Name'), `New ${second.name.toUpperCase()}`);
			await rig.settle(both(a, b, order));

			const winner = `New ${second.name.toUpperCase()}`;
			converged(a, b);
			for (const d of [a, b]) {
				expect(credits(d, 'trk-0'), d.name).toEqual([{ name: winner }]);
				expect(credits(d, 'trk-1'), d.name).toEqual([{ name: winner }, { name: 'Friend' }]);
				expect(d.one(`SELECT count(*) FROM track_artist ta JOIN artist ar ON ar.id = ta.artist_id WHERE ar.name = ?`, `New ${first.name.toUpperCase()}`), d.name).toBe(0);
				// The losing rename's own spelling rule still stands (its key is
				// its own), so a credit spelled that way keeps it.
				expect(maps(d, ['Old Name', 'New A', 'New B']), d.name).toEqual([winner, 'New A', 'New B']);
			}
		});
	});

	// A → B on one device, then B → C on the other once it has seen the
	// first: every credit and every later ingest lands on C.
	it.each(ORDERS)('a rename chain built across devices — %s', async (_label, order) => {
		const [a, b] = await pair({ artists });
		await a.svc.renameArtist(artistId(a, 'Old Name'), 'Mid');
		await rig.settle();
		await b.svc.renameArtist(artistId(b, 'Mid'), 'Final');
		await rig.settle(both(a, b, order));

		converged(a, b);
		for (const d of [a, b]) {
			expect(credits(d, 'trk-0'), d.name).toEqual([{ name: 'Final' }]);
			expect(credits(d, 'trk-1'), d.name).toEqual([{ name: 'Final' }, { name: 'Friend' }]);
			expect(maps(d, ['Old Name', 'Mid', 'final']), d.name).toEqual(['Final', 'Final', 'Final']);
		}
	});

	// After a shared A → Mid, the chain's middle is contested: A renames it
	// back to the old name while B renames it onward. The later device's
	// rules win every key they name, cycle included (old ↔ mid).
	describe.each(LAST)('a chain whose middle is renamed concurrently (back on A, onward on B) — %s', (_l, last) => {
		it.each(ORDERS)('%s', async (_label, order) => {
			const [a, b] = await pair({ artists });
			await a.svc.renameArtist(artistId(a, 'Old Name'), 'Mid');
			await rig.settle();
			const back = async () => { await a.svc.renameArtist(artistId(a, 'Mid'), 'Old Name'); };
			const onward = async () => { await b.svc.renameArtist(artistId(b, 'Mid'), 'Other'); };
			if (last === 'b') { await back(); await tick(); await onward(); }
			else { await onward(); await tick(); await back(); }
			await rig.settle(both(a, b, order));

			const winner = last === 'b' ? 'Other' : 'Old Name';
			converged(a, b);
			for (const d of [a, b]) {
				expect(credits(d, 'trk-0'), d.name).toEqual([{ name: winner }]);
				expect(credits(d, 'trk-1'), d.name).toEqual([{ name: winner }, { name: 'Friend' }]);
				expect(maps(d, ['Old Name', 'Mid']), d.name).toEqual([winner, winner]);
			}
		});
	});

	// A renames the artist while B merges it into another one. One rule key
	// ("old name") is contested; the later write wins it, and the credits
	// follow on both, including the one B's merge had deduped away.
	describe.each(LAST)('a rename on A vs a merge of the same artist on B — %s', (_l, last) => {
		it.each(ORDERS)('%s', async (_label, order) => {
			const [a, b] = await pair({ artists });
			const rename = async () => { await a.svc.renameArtist(artistId(a, 'Old Name'), 'New A'); };
			const merge = async () => { await b.svc.mergeArtists(artistId(b, 'Friend'), artistId(b, 'Old Name')); };
			if (last === 'b') { await rename(); await tick(); await merge(); }
			else { await merge(); await tick(); await rename(); }
			await rig.settle(both(a, b, order));

			converged(a, b);
			for (const d of [a, b]) {
				if (last === 'b') {
					expect(credits(d, 'trk-0'), d.name).toEqual([{ name: 'Friend' }]);
					expect(credits(d, 'trk-1'), d.name).toEqual([{ name: 'Friend' }]);
					expect(maps(d, ['Old Name']), d.name).toEqual(['Friend']);
				} else {
					expect(credits(d, 'trk-0'), d.name).toEqual([{ name: 'New A' }]);
					expect(credits(d, 'trk-1'), d.name).toEqual([{ name: 'New A' }, { name: 'Friend' }]);
					expect(maps(d, ['Old Name']), d.name).toEqual(['New A']);
				}
			}
		});
	});

	// B is offline while both rename the artist. Meanwhile A's scanner
	// ingests a file credited to the old name, which A's rename maps on the
	// way in: its source spelling is recorded at ingest, so when B's rename
	// turns out to win, the new track follows it too.
	describe.each(LAST)('a rename made while the other device is offline — %s', (_l, last) => {
		it.each(ORDERS)('%s', async (_label, order) => {
			const [a, b] = await pair({ artists, parseAudio: flacParse });
			b.transport.online = false;
			const renameA = async () => { await a.svc.renameArtist(artistId(a, 'Old Name'), 'New A'); await a.sync(); };
			const renameB = async () => { await b.svc.renameArtist(artistId(b, 'Old Name'), 'New B'); };
			if (last === 'b') { await renameA(); await tick(); await renameB(); }
			else { await renameB(); await tick(); await renameA(); }
			// A's window: the rule it knows is its own.
			writeFlac(join(a.musicDir, 'Old Name - Fresh Cut.flac'), 'abad1dea'.repeat(4), 'TITLE=Fresh Cut\nARTIST=Old Name\n');
			const scan = scanWaiter(a, normalizePath(a.musicDir));
			await a.svc.addLibraryFolder(a.musicDir);
			await scan.done(1);
			const fresh = a.one<string>(`SELECT id FROM track WHERE title = 'Fresh Cut'`);
			expect(credits(a, fresh)).toEqual([{ name: 'New A' }]);
			await tick();
			b.transport.online = true;
			await rig.settle(both(a, b, order));

			const winner = last === 'b' ? 'New B' : 'New A';
			// The scanned recording is A's alone.
			expect(replicaDiff(a, b, { sharedOnly: true })).toEqual([]);
			expect(creditDump(a, TRACKS)).toEqual(creditDump(b, TRACKS));
			for (const d of [a, b]) {
				expect(credits(d, 'trk-0'), d.name).toEqual([{ name: winner }]);
				expect(credits(d, 'trk-1'), d.name).toEqual([{ name: winner }, { name: 'Friend' }]);
				expect(maps(d, ['Old Name']), d.name).toEqual([winner]);
			}
			expect(credits(a, fresh)).toEqual([{ name: winner }]);
		});
	});
});

// ── 13 ──────────────────────────────────────────────────────────────────────

describe('scenario 13 — track state (unsorted → backlog → purchased) and the interested / basket tags', () => {
	const setState = (d: Desktop, id: string, state: string) =>
		mut.recordTrackStateChanges(d.db, [id], (raw) => { raw.prepare(`UPDATE track SET state = ?, state_changed_at = ? WHERE id = ?`).run(state, Date.now(), id); });

	it.each(ORDERS)('%s', async (_label, order) => {
		const [a, b] = await pair();
		// A sequence across devices: A promotes to backlog, B (having seen it)
		// marks it purchased.
		setState(a, 'trk-1', 'backlog');
		await a.svc.addTrackTag('trk-1', 'interested');
		await rig.settle();
		expect(row(b, 'trk-1').state).toBe('backlog');
		setState(b, 'trk-1', 'purchased');
		await b.svc.removeTrackTag('trk-1', 'interested');
		await b.svc.addTrackTag('trk-1', 'basket');
		// Concurrent: trk-2 backlog on A, then progress on B (later wins);
		// interested on A, basket on B for trk-3.
		setState(a, 'trk-2', 'backlog');
		await a.svc.addTrackTag('trk-3', 'interested');
		await b.svc.addTrackTag('trk-3', 'basket');
		await tick();
		setState(b, 'trk-2', 'progress');

		await rig.settle(both(a, b, order));
		expect(replicaDiff(a, b)).toEqual([]);
		const tags = (d: Desktop, id: string) => d.raw.prepare(`SELECT tag_id FROM track_tag WHERE track_id = ? ORDER BY tag_id`).pluck().all(id);
		for (const d of [a, b]) {
			expect(row(d, 'trk-1').state, d.name).toBe('purchased');
			expect(row(d, 'trk-2').state, d.name).toBe('progress');
			expect(tags(d, 'trk-1'), d.name).toEqual(['basket']);
			expect(tags(d, 'trk-3'), d.name).toEqual(['basket', 'interested']);
		}
	});
});
