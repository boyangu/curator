// Workstream E's exit test, part 3 (rig and rules: two-desktops.test.ts):
// play history with interrupted plays (14), rekordbox analysis units from a
// desktop with rekordbox to one without (15), offline divergence in both
// reconnect orders and a revoked device (16), and a far-behind third device
// bootstrapping from the server's snapshot.
//
// Generated DBs only (CLAUDE.md). The rekordbox side runs the REAL importer
// against a stub sidecar that replays synthetic frames (as
// rekordbox/rb-analysis-sync.test.ts does): no master.db is ever opened.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { PlayRecordUpsert } from '@curator/shared/schema';
import { normalizePath } from '../local/scanner.js';
import { RekordboxImporter } from '../rekordbox/importer.js';
import type { RekordboxSidecar } from '../rekordbox/sidecar.js';
import { readCursor } from './client.js';
import { dumpLibrary } from './dump.js';
import { recordingIdForTrack } from './recording-id.js';
import {
	historyDump,
	replicaDiff,
	tick,
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

const rating = (d: Desktop, id: string): number | null => d.one(`SELECT rating FROM track WHERE id = ?`, id);

// ── 14 ──────────────────────────────────────────────────────────────────────

describe('scenario 14 — plays on each device, interrupted plays finalised, sessions converge', () => {
	const play = (p: Partial<PlayRecordUpsert> & Pick<PlayRecordUpsert, 'id' | 'trackId' | 'startedAt' | 'playedMs' | 'final'>): PlayRecordUpsert => ({
		sourceTrackId: null, source: 'local', durationMs: 300_000, maxPositionMs: p.playedMs, endedReason: p.final ? 'ended' : null, contextType: null, contextId: null, ...p,
	});

	it('a play on each, one cut off by the next play, one by a quit; then a session kind set on the other device', async () => {
		const [a, b] = await pair();
		const t0 = Date.now() - 3_600_000;

		// A: a whole play.
		await a.svc.recordPlay(play({ id: 'pa-1', trackId: 'trk-0', startedAt: t0, playedMs: 280_000, final: true, contextType: 'playlist', contextId: 'x' }));
		// B: a play that never finalises (progress upserts only); the tracker
		// starting the next one finalises it as 'interrupted'.
		await b.svc.recordPlay(play({ id: 'pb-1', trackId: 'trk-1', startedAt: t0 + 1_000, playedMs: 30_000, final: false }));
		await b.svc.recordPlay(play({ id: 'pb-1', trackId: 'trk-1', startedAt: t0 + 1_000, playedMs: 240_000, final: false }));
		await b.svc.recordPlay(play({ id: 'pb-2', trackId: 'trk-2', startedAt: t0 + 250_000, playedMs: 5_000, final: false }));
		await b.svc.recordPlay(play({ id: 'pb-2', trackId: 'trk-2', startedAt: t0 + 250_000, playedMs: 100_000, final: true, endedReason: 'stopped' }));
		// A: an open play when the app quits; the launch sweep finalises it.
		await a.svc.recordPlay(play({ id: 'pa-2', trackId: 'trk-3', startedAt: Date.now() - 120_000, playedMs: 60_000, final: false }));
		await a.restart();
		await a.svc.startLibraryWatching();

		await rig.settle();
		expect(a.one(`SELECT ended_reason FROM play_event WHERE id = 'pb-1'`)).toBe('interrupted');
		expect(a.one(`SELECT played75 FROM play_event WHERE id = 'pb-1'`)).toBe(1); // 240 of 300 s
		expect(b.one(`SELECT ended_reason FROM play_event WHERE id = 'pa-2'`)).toBe('interrupted');
		expect(b.one(`SELECT played75 FROM play_event WHERE id = 'pa-2'`)).toBe(0);
		const ha = historyDump(a);
		expect(ha.events).toHaveLength(4);
		expect(ha).toEqual(historyDump(b));

		// The session of B's plays, marked a set on A.
		const session = a.one<string>(`SELECT session_id FROM play_event WHERE id = 'pb-2'`);
		await a.svc.setPlaySessionKind(session, 'set');
		await rig.settle();
		expect(b.one(`SELECT kind FROM play_session WHERE id = ?`, session)).toBe('set');
		expect(historyDump(a)).toEqual(historyDump(b));
		// Each recording's plays resolve to the local row on both.
		expect(b.one(`SELECT track_id FROM play_event WHERE id = 'pa-1'`)).toBe('trk-0');
		expect(replicaDiff(a, b)).toEqual([]);
	});
});

// ── 15 ──────────────────────────────────────────────────────────────────────

describe('scenario 15 — rekordbox analysis units from A reach B, which has no rekordbox', () => {
	type Frame = { event: string; row: Record<string, unknown> };
	const RB = ['trk-0', 'trk-1', 'trk-2'];
	const T0 = Date.parse('2026-08-14T10:00:00Z');
	const fileOf = (d: Desktop, id: string): string => normalizePath(join(d.dir, 'rb', `${id}.mp3`));

	function stubSidecar(frames: Frame[]): RekordboxSidecar {
		const emitter = new EventEmitter();
		return Object.assign(emitter, {
			open: async () => ({ ok: true }),
			scan: async () => {
				for (const f of frames) emitter.emit('event', { event: f.event, frame: { row: f.row } });
				return { watermarks: {}, cancelled: false };
			},
			cancel: async () => { /* */ },
		}) as unknown as RekordboxSidecar;
	}

	// Rekordbox-shaped frames for this device's files: a grid for the first
	// two, phrases for the first, a key for all three.
	function frames(d: Desktop, keys: Record<string, string> = {}): Frame[] {
		const out: Frame[] = [];
		RB.forEach((id, n) => {
			out.push({ event: 'track', row: {
				rb_content_id: `${d.name}-C${n}`, rb_local_usn: 10 + n, rb_local_deleted: false, rb_updated_at_ms: T0, rb_added_at_ms: T0 - 86_400_000,
				file_path: fileOf(d, id), title: `Title ${id}`, artist: 'Artist', album: null, genre: null, label: null, bpm: 124,
				key_camelot: keys[id] ?? `${n + 4}A`, key_musical: null, color_label: null, rating: null, comment: null, play_count: null, last_played_at_ms: null, duration_sec: 300,
			} });
		});
		RB.slice(0, 2).forEach((id, n) => {
			const beats = Array.from({ length: 600 }, (_, k) => Math.round(87 + n * 10 + (k * 60_000) / 124) / 1000);
			out.push({ event: 'waveform', row: {
				rb_content_id: `${d.name}-C${n}`, peaks_lo_path: null, peaks_hi_path: null,
				beatgrid_sec: beats, downbeats_sec: beats.filter((_, i) => i % 4 === 0),
				segments: n === 0 ? [
					{ startSec: 0.087, endSec: 31.1, label: 'Intro 1', source: 'rekordbox', rbKind: 1 },
					{ startSec: 31.1, endSec: 280, label: 'Up 1', source: 'rekordbox', rbKind: 2 },
					{ startSec: 280, endSec: 300, label: 'Outro 1', source: 'rekordbox', rbKind: 9, fillSec: 298.5 },
				] : null,
			} });
		});
		return out;
	}

	// The rows this device's rekordbox import binds to: local links at the
	// paths rekordbox reports (no file is read).
	const withRbFiles: DesktopOpts['seed'] = (raw, { dir }) => {
		const ins = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`);
		for (const id of RB) { const p = normalizePath(join(dir, 'rb', `${id}.mp3`)); ins.run(`sl-${id}`, id, p, p); }
	};

	async function importRb(d: Desktop, keys: Record<string, string> = {}): Promise<void> {
		await new RekordboxImporter(d.db, stubSidecar(frames(d, keys))).runImport({
			mode: 'full',
			flags: { syncTracks: true, syncPlaylists: false, syncMyTags: false, syncCuesGridsPhrases: true, syncWaveformPeaks: false, syncHistory: false },
			dbPath: join(d.dir, 'master.db'), // never opened — stub sidecar
			peaksDir: join(d.dir, 'peaks'),
		});
	}

	type Slot = { rb_beatgrid: Buffer | null; rb_downbeats: Buffer | null; rb_key_camelot: string | null; rb_segments_json: string | null };
	const slot = (d: Desktop, id: string): Slot | undefined =>
		d.raw.prepare(`SELECT rb_beatgrid, rb_downbeats, rb_key_camelot, rb_segments_json FROM track_analysis WHERE track_id = ?`).get(id) as Slot | undefined;
	const rbOps = (d: Desktop): number => d.one(`SELECT count(*) FROM sync_outbox WHERE kind = 'set-rb-analysis'`);

	it('grid, key and phrases land in B\'s rekordbox slot byte for byte, with the importer\'s track mirrors', async () => {
		const a = await rig.desktop('a', { seed: withRbFiles });
		const b = await rig.desktop('b');
		await rig.settle();
		await importRb(a);
		expect(rbOps(a)).toBe(6); // grid ×2, key ×3, segments ×1
		await rig.settle();

		for (const id of RB) {
			const sa = slot(a, id)!;
			const sb = slot(b, id);
			expect(sb, id).toBeDefined();
			expect(sb!.rb_key_camelot, id).toBe(sa.rb_key_camelot);
			if (sa.rb_beatgrid) {
				expect(sb!.rb_beatgrid!.equals(sa.rb_beatgrid), `${id} grid`).toBe(true);
				expect(sb!.rb_downbeats!.equals(sa.rb_downbeats!), `${id} downbeats`).toBe(true);
			} else {
				expect(sb!.rb_beatgrid, id).toBeNull();
			}
			expect(JSON.parse(sb!.rb_segments_json ?? 'null'), id).toEqual(JSON.parse(sa.rb_segments_json ?? 'null'));
		}
		const mirrors = (d: Desktop) => d.all(`SELECT key_camelot, intro_length_sec, outro_length_sec FROM track WHERE id IN ('trk-0', 'trk-1', 'trk-2') ORDER BY id`);
		expect(mirrors(b)).toEqual(mirrors(a));
		expect(dumpLibrary(b.raw).rbAnalysis).toHaveLength(3);
		expect(replicaDiff(a, b)).toEqual([]);
		// B has no rekordbox: nothing linked, nothing pushed back.
		expect(b.one(`SELECT count(*) FROM rekordbox_link`)).toBe(0);
		expect(rbOps(b)).toBe(0);
	});

	// Both desktops have their own rekordbox, and they disagree on trk-1's
	// key. After syncing, one value wins on both; a re-import of rekordbox
	// data that did not change must then emit nothing. Before the per-device
	// rekordbox baseline (E2, rekordbox_unit_seen), each full re-import
	// compared rb's value with the slot — which by then held the OTHER
	// desktop's value — and re-emitted its own: the unit flipped back on
	// every import.
	it('two desktops whose rekordbox libraries disagree do not flip a unit back on an unchanged re-import', async () => {
		const a = await rig.desktop('a', { seed: withRbFiles });
		const b = await rig.desktop('b', { seed: withRbFiles });
		await rig.settle();
		await importRb(a, { 'trk-1': '5A' });
		await tick();
		await importRb(b, { 'trk-1': '9B' });
		await rig.settle();
		expect(slot(a, 'trk-1')!.rb_key_camelot).toBe(slot(b, 'trk-1')!.rb_key_camelot);
		const before = rig.cloud.log.length;
		await importRb(a, { 'trk-1': '5A' });
		await importRb(b, { 'trk-1': '9B' });
		await rig.settle();
		expect(rig.cloud.log.slice(before).filter((o) => o.kind === 'set-rb-analysis')).toEqual([]);
		expect(replicaDiff(a, b)).toEqual([]);
	});
});

// ── 16 ──────────────────────────────────────────────────────────────────────

describe('scenario 16 — offline divergence, and a device revoked mid-way', () => {
	it.each(ORDERS)('both edit while offline, then reconnect: %s', async (_label, order) => {
		const [a, b] = await pair();
		const t = await a.svc.createTag('Warm');
		const set = await a.svc.createLocalPlaylistFromTracks('Set', ['trk-0', 'trk-1', 'trk-2', 'trk-3']);
		await rig.settle();

		a.transport.online = false;
		b.transport.online = false;
		await a.svc.addTrackTag('trk-4', t.id);
		await a.svc.setRating(['trk-5'], 2);
		await a.svc.reorderPlaylistTracks(set.id, [3, 2, 1, 0]);
		await a.svc.renamePlaylist(set.id, 'Set (offline A)');
		await a.svc.upsertCue({ trackId: 'trk-0', slot: 0, kind: 'hot', positionSec: 1, lengthSec: null, color: null, name: 'A' });
		await b.svc.addTrackTag('trk-6', t.id);
		await b.svc.removeTracksFromPlaylist(set.id, ['trk-1']);
		const bt = await b.svc.createTag('From B offline');
		await b.svc.addTrackTag('trk-0', bt.id);
		await b.svc.setTrackOverrides('trk-7', { title: 'B offline' });
		await tick();
		await b.svc.setRating(['trk-5'], 4);
		await b.svc.upsertCue({ trackId: 'trk-0', slot: 0, kind: 'hot', positionSec: 2, lengthSec: null, color: null, name: 'B' });

		// Syncing while offline: nothing leaves, nothing is lost.
		const logBefore = rig.cloud.log.length;
		for (const d of [a, b]) {
			const s = await d.svc.cloudSyncNow();
			expect(s.lastError, d.name).toMatch(/Offline/);
			expect(s.pending, d.name).toBeGreaterThan(0);
		}
		expect(rig.cloud.log.length).toBe(logBefore);

		const [first, second] = order === 'ab' ? [a, b] : [b, a];
		first.transport.online = true;
		await first.sync();
		second.transport.online = true;
		await rig.settle([second, first]);

		expect(replicaDiff(a, b)).toEqual([]);
		for (const d of [a, b]) {
			expect(rating(d, 'trk-5'), d.name).toBe(4);
			expect(d.one(`SELECT name FROM playlist WHERE id = ?`, set.id), d.name).toBe('Set (offline A)');
			expect(d.one(`SELECT name FROM cue WHERE track_id = 'trk-0' AND slot = 0`), d.name).toBe('B');
			expect(d.one(`SELECT count(*) FROM playlist_track WHERE playlist_id = ? AND track_id = 'trk-1'`, set.id), d.name).toBe(0);
			expect(d.one(`SELECT count(*) FROM track_tag WHERE tag_id = ?`, t.id), d.name).toBe(2);
			expect(d.one(`SELECT count(*) FROM track_tag WHERE tag_id = ?`, bt.id), d.name).toBe(1);
		}
	});

	it('a device revoked mid-way stops landing ops: its edits stay pending, the other device never sees them', async () => {
		const [a, b] = await pair();
		await b.svc.setRating(['trk-0'], 5);
		await rig.settle();
		expect(rating(a, 'trk-0')).toBe(5);

		const bId = await b.deviceId();
		await a.transport.account.revokeDevice({ deviceId: bId });
		const landedBefore = rig.cloud.log.filter((o) => o.device_id === bId).length;
		const pushesBefore = rig.cloud.pushLog.filter((p) => p.deviceId === bId).length;

		await b.svc.setRating(['trk-0'], 1);
		await b.svc.addTrackTag('trk-1', 'interested');
		const s = await b.svc.cloudSyncNow();
		expect(s.lastError).toMatch(/removed from your Curator account/);
		// Held, not rejected: re-admitted, it would deliver them.
		expect(s).toMatchObject({ rejected: 0 });
		expect(s.pending).toBeGreaterThanOrEqual(2);
		expect(s.revoked).toBe(true);
		await b.svc.cloudSyncNow();
		expect(rig.cloud.log.filter((o) => o.device_id === bId)).toHaveLength(landedBefore);
		// One refused push told it; after that it does not even try.
		const after = rig.cloud.pushLog.filter((p) => p.deviceId === bId).slice(pushesBefore);
		expect(after).toHaveLength(1);
		expect(after[0]!.accepted).toBe(0);

		// A carries on and never sees B's post-revocation edits.
		await a.svc.setRating(['trk-2'], 3);
		await a.sync();
		expect(rating(a, 'trk-0')).toBe(5);
		expect(a.one(`SELECT count(*) FROM track_tag WHERE track_id = 'trk-1' AND tag_id = 'interested'`)).toBe(0);
		// B pulls nothing either: the server refuses a revoked device's reads
		// ('device_reads', apps/cloud device-gate.ts), and B's client, once
		// told, stops calling at all until it is unlinked (client.ts).
		const pulls = rig.cloud.calls.pull;
		await b.svc.cloudSyncNow();
		expect(rig.cloud.calls.pull).toBe(pulls);
		expect(rating(b, 'trk-2')).toBeNull();
		expect(readCursor(b.raw).lastSeq).toBeLessThan(rig.cloud.maxSeq);
		// Re-registering is refused: revocation is final.
		await expect(b.transport.account.registerDevice({ deviceId: bId, name: 'b', platform: 'win32' })).rejects.toMatchObject({ kind: 'device_revoked' });
	});
});

// ── a far-behind third device ───────────────────────────────────────────────

describe('a far-behind third device', () => {
	it('bootstraps from the server snapshot, pulls the rest, and matches both', async () => {
		rig.cloud.pageLimit = 7; // paging on every pull
		const [a, b] = await pair();
		const t = await a.svc.createTag('Warm');
		const set = await a.svc.createLocalPlaylistFromTracks('Set', ['trk-0', 'trk-1', 'trk-2']);
		await rig.settle();
		await b.svc.addTrackTag('trk-3', t.id);
		await b.svc.upsertCue({ trackId: 'trk-1', slot: 4, kind: 'memory', positionSec: 64, lengthSec: null, color: null, name: 'Mem' });
		await a.svc.recordPlay({ id: 'p-1', trackId: 'trk-0', sourceTrackId: null, source: 'local', startedAt: Date.now() - 900_000, playedMs: 250_000, durationMs: 300_000, maxPositionMs: 250_000, endedReason: 'ended', contextType: null, contextId: null, final: true });
		await a.svc.mergeTracks('trk-8', 'trk-9');
		await b.svc.deleteTracks(['trk-7']);
		await rig.settle();

		const snapSeq = rig.cloud.takeSnapshot();
		rig.cloud.hintBelow = snapSeq;
		// After the snapshot: ops only the stream carries.
		await b.svc.reorderPlaylistTracks(set.id, [2, 1, 0]);
		await a.svc.removeTrackTag('trk-3', t.id);
		await b.svc.setRating(['trk-8'], 4);
		await rig.settle();

		const c = await rig.desktop('c');
		await rig.settle();
		expect(rig.cloud.calls.bootstrap).toBe(1);
		expect(readCursor(c.raw)).toMatchObject({ snapshotSeq: snapSeq, lastSeq: rig.cloud.maxSeq });
		expect(replicaDiff(a, c)).toEqual([]);
		expect(replicaDiff(b, c)).toEqual([]);
		expect(historyDump(c)).toEqual(historyDump(a));
		expect(c.one(`SELECT deleted_at IS NOT NULL FROM track WHERE id = 'trk-9'`)).toBe(1);
		expect(c.one(`SELECT rating FROM track WHERE id = 'trk-8'`)).toBe(4);
		expect(c.one(`SELECT count(*) FROM recording_alias WHERE loser = ?`, R('trk-9'))).toBe(1);
	});
});
