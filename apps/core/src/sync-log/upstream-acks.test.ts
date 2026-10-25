// Pending upstream writes (F23) across two desktops: a membership change on a
// Spotify playlist is acked `upstream` pending in the same transaction, and
// a streaming read-sync — on the desktop that made it or on one that pulled
// it — merges around it instead of reverting it, until an ack says the
// service has it. Then the service's list is authoritative again.
//
// Remote writes stay default-deny (CLAUDE.md): the services get a recording
// fake adapter and NO remoteWritePolicy, so every push is refused by the
// gate before the adapter is reached — which these tests assert. A
// successful push is stood in for by acking 'pushed' directly. Generated
// temp DBs only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getSourceCapabilities } from '@curator/shared';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import { createCoreService, type CoreService } from '../service.js';
import { removeDir } from '../test-support/tmp.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import * as mut from '../library/mutators.js';
import { applyOps } from './apply.js';
import { observeServerTs, readOutbox } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';

let dir: string;
const handles: Database.Database[] = [];
const services: CoreService[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-upstream-')); });
afterEach(async () => {
	for (const s of services.splice(0).reverse()) await s.close();
	for (const h of handles.splice(0)) h.close();
	await removeDir(dir);
});

const TRACKS = Array.from({ length: 8 }, (_, i) => `trk-${i}`);
const PL = 'pl-spotify';

type Device = { db: Db; raw: Database.Database; svc: CoreService; adapterCalls: string[]; shipped: number };

function recordingAdapter(calls: string[]): StreamingSourceAdapter {
	const record = (op: string) => async (): Promise<never> => { calls.push(op); throw new Error(`adapter ${op} reached in a test`); };
	return {
		source: 'spotify', displayName: 'Fake Spotify', capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [], fetchPlaylistTracks: async () => [],
		createPlaylist: record('createPlaylist'), deletePlaylist: record('deletePlaylist'), renamePlaylist: record('renamePlaylist'),
		addTracks: record('addTracks'), removeTracks: record('removeTracks'), replaceTracks: record('replaceTracks'),
		reorderTracks: record('reorderTracks'),
	};
}

function device(name: string): Device {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const { db, sqlite: raw } = createDb(p);
	handles.push(raw);
	const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, '[{"name":"A"}]', 'unsorted', 300)`);
	const link = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id) VALUES (?, ?, 'spotify', ?)`);
	for (const id of TRACKS) { ins.run(id, recordingIdForTrack(id), `Title ${id}`); link.run(`sl-${id}`, id, `sp-${id}`); }
	const adapterCalls: string[] = [];
	const svc = createCoreService(p, { peaksDir: join(dir, `${name}-peaks`), sourceAdapters: { spotify: recordingAdapter(adapterCalls) } });
	services.push(svc);
	return { db, raw, svc, adapterCalls, shipped: 0 };
}

// Everything `from` emitted since its last exchange, applied on `to`. The
// receiver's clock is floored at what it received, as a pull floors it at
// the server's receive stamps — without it two edits in one millisecond
// would be ordered by device id instead of by time.
function exchange(from: Device, to: Device): void {
	const ops = readOutbox(from.raw).slice(from.shipped);
	applyOps(to.raw, ops);
	from.shipped += ops.length;
	if (ops.length > 0) observeServerTs(to.raw, Math.max(...ops.map((o) => o.client_ts)));
}

// What the Spotify API returns for the playlist, as the read-sync hands it on.
const upstream = (ids: readonly string[]): mut.DesiredMember[] =>
	ids.map((id) => ({ trackId: id, sourceTrackId: `sp-${id}`, addedAt: new Date(1_700_000_000_000), addedBy: 'me' }));
const readSync = (d: Device, ids: readonly string[]) => mut.reconcileMembership(d.db, PL, upstream(ids), 'spotify');
const order = (d: Device): string[] => d.raw.prepare(`SELECT track_id FROM playlist_track WHERE playlist_id = ? ORDER BY position`).pluck().all(PL) as string[];
const acks = (d: Device): Array<{ op: string; status: string; error: string | null }> =>
	(d.raw.prepare(`SELECT key, value FROM sync_state WHERE map = 'upstreamAcks' ORDER BY key`).all() as Array<{ key: string; value: string }>)
		.map((r) => { const v = JSON.parse(r.value) as { value: { status: string; error?: string | null } }; return { op: r.key, status: v.value.status, error: v.value.error ?? null }; });

// Desktop A imported the playlist from Spotify (a read-sync: no acks), and
// desktop B pulled it.
function twoDesktops(): { a: Device; b: Device } {
	const a = device('a');
	const b = device('b');
	mut.createPlaylist(a.db, { id: PL, name: 'Peak', source: 'spotify', sourceId: 'sp-pl', ownerId: null });
	readSync(a, TRACKS.slice(0, 5));
	exchange(a, b);
	expect(order(b)).toEqual(TRACKS.slice(0, 5));
	return { a, b };
}

describe('pending upstream writes (F23)', () => {
	it('a pending add survives read-syncs on both desktops until the push is acked', async () => {
		const { a, b } = twoDesktops();
		// B adds a track; write-sync is off by default, so nothing is pushed.
		const res = await b.svc.addTracksToPlaylist(PL, ['trk-5']);
		expect(res).toMatchObject({ added: 1, upstream: 'write-sync-off' });
		expect(acks(b)).toEqual([expect.objectContaining({ status: 'skipped', error: mut.UPSTREAM_AWAITING })]);

		// B's own read-sync: Spotify does not show it yet.
		expect(readSync(b, TRACKS.slice(0, 5))).toEqual({ added: 0, removed: 0, moved: 0 });
		expect(order(b)).toEqual([...TRACKS.slice(0, 5), 'trk-5']);

		// A pulls the add and its pending ack, then runs its own read-sync.
		exchange(b, a);
		expect(order(a)).toEqual([...TRACKS.slice(0, 5), 'trk-5']);
		const sent = readOutbox(a.raw).length;
		readSync(a, TRACKS.slice(0, 5));
		expect(order(a)).toEqual([...TRACKS.slice(0, 5), 'trk-5']);
		expect(readOutbox(a.raw).length).toBe(sent); // no remove op went out
		// Upstream news still applies around it.
		readSync(a, [...TRACKS.slice(0, 5), 'trk-6']);
		expect(order(a)).toEqual([...TRACKS.slice(0, 5), 'trk-5', 'trk-6']);

		// The push lands (stood in for: remote writes are denied in tests),
		// the ack travels, and Spotify's list is authoritative again.
		mut.ackUpstream(b.db, acks(b).map((x) => x.op), 'spotify', 'pushed');
		exchange(b, a);
		readSync(a, [...TRACKS.slice(0, 5), 'trk-6']);
		expect(order(a)).not.toContain('trk-5');
		expect(a.adapterCalls).toEqual([]);
		expect(b.adapterCalls).toEqual([]);
	});

	it('a pending remove is not re-added and a pending reorder is not reverted', async () => {
		const { a, b } = twoDesktops();
		await b.svc.removeTracksFromPlaylist(PL, ['trk-1']);
		// [0,2,3,4] → [4,0,2,3] in position space.
		await b.svc.reorderPlaylistTracks(PL, [3, 0, 1, 2]);
		const local = ['trk-4', 'trk-0', 'trk-2', 'trk-3'];
		expect(order(b)).toEqual(local);
		expect(acks(b).every((x) => x.status === 'skipped')).toBe(true);
		exchange(b, a);
		expect(order(a)).toEqual(local);

		// Spotify still has the old list, plus a track added there directly.
		for (const d of [a, b]) {
			readSync(d, [...TRACKS.slice(0, 5), 'trk-7']);
			expect(order(d)).toEqual(['trk-4', 'trk-7', 'trk-0', 'trk-2', 'trk-3']);
		}
		exchange(a, b);
		exchange(b, a);
		expect(order(a)).toEqual(order(b));
	});

	it('rows with no ack follow the service: a read-sync removal is not held', () => {
		const { a, b } = twoDesktops();
		readSync(b, TRACKS.slice(0, 4));
		expect(order(b)).toEqual(TRACKS.slice(0, 4));
		exchange(b, a);
		expect(order(a)).toEqual(TRACKS.slice(0, 4));
		expect(acks(a)).toEqual([]);
	});

	it('with write-sync on, the default-deny gate refuses the push before the adapter: the ack says failed and the row stays pending', async () => {
		const { b } = twoDesktops();
		await b.svc.setSourceSyncSettings('spotify', { readSyncAuto: false, readIntervalMin: 5, writeSyncAuto: true });
		const res = await b.svc.addTracksToPlaylist(PL, ['trk-6']);
		expect(res.upstream).toBe('failed');
		expect(b.adapterCalls).toEqual([]);
		const [ack] = acks(b);
		expect(ack).toMatchObject({ status: 'failed' });
		expect(ack!.error).toMatch(/remote write/i);
		readSync(b, TRACKS.slice(0, 5));
		expect(order(b)).toContain('trk-6');
	});
});
