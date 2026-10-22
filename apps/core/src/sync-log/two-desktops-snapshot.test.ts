// The master-published snapshot ('snapshot_storage'; protocol
// cloud-service.ts, client.ts publish stage, snapshot-build.ts) across
// desktops on the rig: the master's records serialise to the server's own
// fold byte for byte, a new device bootstraps from the master's Storage
// snapshot and converges, only the master publishes, the preconditions hold
// a publish back, the server fold still serves an account whose master
// never published, superseded parts are deleted, and a master change moves
// the publishing with it.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate() through the rig;
// the fake cloud's Storage is an in-memory map; no remoteWritePolicy.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { serializeLibraryState } from '@curator/protocol';
import { CloudTransportError, readCursor } from './client.js';
import { buildSnapshotParts, type SnapshotBuildOk } from './snapshot-build.js';
import { recordingIdForTrack } from './recording-id.js';
import { replicaDiff, tick, TRACKS, TwoDesktopRig, USER, type Desktop, type DesktopOpts } from '../test-support/two-desktops.js';

let rig: TwoDesktopRig;
let scratch: string;
beforeEach(() => {
	rig = new TwoDesktopRig('curator-snap-');
	scratch = mkdtempSync(join(tmpdir(), 'curator-snap-build-'));
});
afterEach(() => {
	const upstream = rig.upstreamCalls();
	rig.close();
	rmSync(scratch, { recursive: true, force: true });
	expect(upstream).toEqual([]);
});

const R = recordingIdForTrack;
// Due after every op: each test decides when the master publishes.
const EVERY: DesktopOpts = { snapshot: { everyOps: 1, retryMs: 0 } };

// The JSON a build wrote (its parts joined and inflated).
const jsonOf = (b: SnapshotBuildOk): string => gunzipSync(Buffer.concat(b.files.map((f) => readFileSync(f)))).toString('utf8');

async function build(d: Desktop): Promise<SnapshotBuildOk> {
	const r = await buildSnapshotParts({ dbPath: d.path, outDir: mkdtempSync(join(scratch, 'b-')), userId: USER });
	if (!r.ok) throw new Error(`build skipped: ${r.skipped}`);
	return r;
}

async function syncAndPublish(...ds: Desktop[]): Promise<void> {
	for (const d of ds) { await d.sync(); await d.publishIdle(); }
}

// Two devices editing everything the snapshot carries: tags with unicode
// names, assignments and a removal, playlists (rows added, one removed, a
// rename), cues (one deleted), ratings, overrides, a recording merge, artist
// alias rules (a rename on each), a provider link (claims), a pin, plays.
// Catalogue credits (each device seeds its own rows; the same for all).
const artists = (id: string) => (id === 'trk-1' ? [{ name: 'Old Name' }, { name: 'Friend' }] : id === 'trk-2' ? [{ name: 'Ärtist 😀' }] : [{ name: 'Artist' }]);

async function busyLibrary(): Promise<{ a: Desktop; b: Desktop }> {
	const a = await rig.desktop('a', { ...EVERY, artists });
	const b = await rig.desktop('b', { ...EVERY, artists });
	await rig.settle();
	const warm = await a.svc.createTag('Wärm 😀');
	const cool = await b.svc.createTag(' private-use');
	await a.svc.addTrackTag('trk-0', warm.id);
	await a.svc.addTrackTag('trk-1', warm.id);
	await b.svc.addTrackTag('trk-2', cool.id);
	const set = await a.svc.createLocalPlaylistFromTracks('Set 𝄞', ['trk-3', 'trk-4', 'trk-6']);
	await a.svc.upsertCue({ trackId: 'trk-0', slot: 0, kind: 'hot', positionSec: 10, lengthSec: null, color: null, name: 'Intro' });
	await a.svc.upsertCue({ trackId: 'trk-0', slot: 1, kind: 'memory', positionSec: 20, lengthSec: 4, color: '#ff0000', name: 'Build' });
	await a.svc.setRating(['trk-0', 'trk-1'], 4);
	await b.svc.setTrackOverrides('trk-2', { title: 'B títle' });
	await a.svc.setTrackSourceLinks('trk-3', { tidal: 'https://tidal.com/browse/track/3003' });
	await a.svc.createPinnedSearch({ name: 'Warm ones', query: 'tag:warm', sort: { column: 'bpm', dir: 'desc' } });
	await rig.settle();
	await tick();
	await a.svc.mergeTracks('trk-4', 'trk-5');
	await a.svc.renameArtist(a.one(`SELECT id FROM artist WHERE name = 'Old Name' AND merged_into IS NULL`), 'New Name');
	await b.svc.renameArtist(b.one(`SELECT id FROM artist WHERE name = 'Friend' AND merged_into IS NULL`), 'FRIEND');
	await b.svc.removeTrackTag('trk-1', warm.id);
	await b.svc.removeTracksFromPlaylist(set.id, ['trk-6']);
	await b.svc.renamePlaylist(set.id, 'Set renamed');
	await b.svc.deleteCue(b.one(`SELECT id FROM cue WHERE track_id = 'trk-0' AND slot = 1 AND kind = 'memory'`));
	await b.svc.setRating(['trk-5'], 2);
	await rig.settle();
	return { a, b };
}

describe('the master publishes the snapshot from its records', () => {
	it('byte for byte the server fold at the same seq, and only once due', async () => {
		const { a, b } = await busyLibrary();
		const aId = await a.deviceId();
		await syncAndPublish(a);
		// The records as they stand, built directly: the JSON is exactly the
		// fake server's fold of its log through the master's cursor.
		const direct = await build(a);
		expect(direct.snapshotSeq).toBe(readCursor(a.raw).lastSeq);
		expect(direct.snapshotSeq).toBe(rig.cloud.maxSeq);
		const json = jsonOf(direct);
		expect(json).toBe(serializeLibraryState(rig.cloud.foldAt(direct.snapshotSeq)));
		// What the snapshot holds is not trivial.
		const maps = (JSON.parse(json) as { maps: Record<string, unknown[]> }).maps;
		for (const m of ['tags', 'trackTags', 'playlists', 'playlistTracks', 'libraryTracks', 'cues', 'claims', 'merges', 'recordingAlias', 'artistAliases', 'artistAlias', 'tombstones', 'pinnedSearches', 'settings']) {
			expect(maps[m]!.length, m).toBeGreaterThan(0);
		}
		// Every publish so far came from the master and matched the fold.
		expect(rig.cloud.publishes.length).toBeGreaterThan(0);
		expect(rig.cloud.publishes.every((p) => p.deviceId === aId && p.stateMatches)).toBe(true);
		const last = rig.cloud.publishes.at(-1)!;
		expect(last).toMatchObject({ seq: direct.snapshotSeq, status: 'stored' });
		expect(rig.cloud.published.at(-1)!.manifest.stateSha256).toBe(direct.manifest.stateSha256);
		expect((await a.svc.getCloudSyncStatus()).snapshot).toMatchObject({ publishing: false, lastSeq: direct.snapshotSeq });
		// Nothing new: a cycle publishes nothing.
		const n = rig.cloud.calls.publish;
		await syncAndPublish(a, b);
		expect(rig.cloud.calls.publish).toBe(n);
	});

	it('with the default cadence: the first publish at once, the next only 10,000 ops on', async () => {
		const a = await rig.desktop('a');
		await rig.settle();
		await a.publishIdle();
		expect(rig.cloud.publishes.map((p) => p.status)).toEqual(['stored']);
		await a.svc.setRating(['trk-0'], 5);
		await syncAndPublish(a);
		expect(rig.cloud.publishes).toHaveLength(1);
	});
});

describe('a new device bootstraps from the master\'s Storage snapshot', () => {
	it('downloads, checks and loads it, then pulls the rest and converges', async () => {
		const { a, b } = await busyLibrary();
		// The server's own snapshot (Postgres) is older: the pull hint names
		// it, the bootstrap with `storage: true` lands at the newer one.
		rig.cloud.hintBelow = rig.cloud.takeSnapshot();
		await a.svc.setRating(['trk-7'], 3);
		await b.svc.addTracksToPlaylist(rig.cloud.log.find((o) => o.entity === 'playlist' && o.kind === 'create')!.entity_id, ['trk-8']);
		await rig.settle([a, b]);
		await syncAndPublish(a);
		const pub = rig.cloud.published.at(-1)!;
		expect(pub.seq).toBeGreaterThan(rig.cloud.hintBelow);
		// One more op after the publish: the newcomer pulls it after loading.
		await b.svc.setRating(['trk-9'], 1);
		await b.sync();

		const c = await rig.desktop('c', { artists });
		await rig.settle();
		expect(rig.cloud.calls.storageBootstraps).toBe(1);
		expect(readCursor(c.raw)).toMatchObject({ snapshotSeq: pub.seq, lastSeq: rig.cloud.maxSeq });
		expect(replicaDiff(a, c)).toEqual([]);
		expect(replicaDiff(b, c)).toEqual([]);
		expect(c.one(`SELECT rating FROM track WHERE id = 'trk-9'`)).toBe(1);
		expect(c.one(`SELECT count(*) FROM recording_alias WHERE loser = ? AND winner = ?`, R('trk-5'), R('trk-4'))).toBe(1);
	});

	it('a part that does not match its manifest fails the bootstrap; nothing loads', async () => {
		const a = await rig.desktop('a', EVERY);
		await a.svc.setRating(['trk-0'], 4);
		await rig.settle();
		await a.publishIdle();
		rig.cloud.hintBelow = rig.cloud.takeSnapshot();
		const part = rig.cloud.published.at(-1)!.manifest.parts[0]!;
		const bytes = rig.cloud.storage.get(part.path)!;
		bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
		const c = await rig.desktop('c');
		await c.sync();
		expect((await c.svc.getCloudSyncStatus()).lastError).toMatch(/server had a problem/);
		expect(readCursor(c.raw).lastSeq).toBe(0);
		expect(c.one(`SELECT rating FROM track WHERE id = 'trk-0'`)).toBeNull();
	});
});

describe('who publishes, and when not', () => {
	it('a secondary never publishes, even when one would be due', async () => {
		const a = await rig.desktop('a', EVERY);
		const b = await rig.desktop('b', EVERY);
		await rig.settle();
		const aId = await a.deviceId();
		for (let i = 0; i < 3; i++) {
			await b.svc.setRating(['trk-1'], (i % 5) + 1);
			await syncAndPublish(b, a);
		}
		expect(rig.cloud.publishes.length).toBeGreaterThan(0);
		expect(new Set(rig.cloud.publishes.map((p) => p.deviceId))).toEqual(new Set([aId]));
		expect((await b.svc.getCloudSyncStatus()).snapshot.lastSeq).toBeNull();
	});

	it('pending, rejected and held ops hold the build back', async () => {
		const a = await rig.desktop('a', EVERY);
		await rig.settle();
		await a.publishIdle();
		// Pending: an edit not pushed yet.
		await a.svc.setRating(['trk-0'], 2);
		const outDir = mkdtempSync(join(scratch, 'p-'));
		expect(await buildSnapshotParts({ dbPath: a.path, outDir, userId: USER })).toMatchObject({ ok: false, skipped: 'pending_ops', count: 1 });
		await syncAndPublish(a);
		const n = rig.cloud.calls.publish;
		// Held: an op from a newer protocol set aside (stands in for a pull).
		a.raw.prepare(`INSERT INTO sync_inbox_held (seq, op_id, schema_version, op, held_at) VALUES (999999, 'held-op', 99, '{}', 0)`).run();
		await a.svc.setRating(['trk-1'], 3);
		await syncAndPublish(a);
		expect(rig.cloud.calls.publish).toBe(n);
		expect(await buildSnapshotParts({ dbPath: a.path, outDir, userId: USER })).toMatchObject({ ok: false, skipped: 'held_ops' });
		a.raw.prepare(`DELETE FROM sync_inbox_held`).run();
		// Rejected: the server refused an op for good.
		await a.svc.setRating(['trk-2'], 4);
		const op = a.one<string>(`SELECT op_id FROM sync_outbox WHERE state = 'pending' ORDER BY seq_local DESC LIMIT 1`);
		rig.cloud.rejectIds.set(op, 'invalid_payload');
		await syncAndPublish(a);
		expect(a.one(`SELECT state FROM sync_outbox WHERE op_id = ?`, op)).toBe('rejected');
		expect(rig.cloud.calls.publish).toBe(n);
		expect(await buildSnapshotParts({ dbPath: a.path, outDir, userId: USER })).toMatchObject({ ok: false, skipped: 'rejected_ops', count: 1 });
	});

	it('a master that never publishes: others still bootstrap from the server fold', async () => {
		const crashing = { snapshot: { everyOps: 1, retryMs: 0, builder: async () => { throw new Error('builder process crashed'); } } };
		const a = await rig.desktop('a', crashing);
		await a.svc.setRating(['trk-0'], 4);
		await rig.settle();
		await a.publishIdle();
		expect(rig.cloud.calls.publish).toBe(0);
		rig.cloud.hintBelow = rig.cloud.takeSnapshot();
		const c = await rig.desktop('c');
		await rig.settle();
		expect([rig.cloud.calls.bootstrap, rig.cloud.calls.storageBootstraps]).toEqual([1, 0]);
		expect(replicaDiff(a, c)).toEqual([]);
	});

	it('after a master change, only the new master publishes', async () => {
		const a = await rig.desktop('a', EVERY);
		const b = await rig.desktop('b', EVERY);
		await rig.settle();
		await a.publishIdle();
		const [aId, bId] = [await a.deviceId(), await b.deviceId()];
		expect(rig.cloud.publishes.map((p) => p.deviceId)).toEqual([aId]);
		await b.svc.setMasterDevice(bId);
		await rig.settle();
		await Promise.all([a.publishIdle(), b.publishIdle()]);
		for (let i = 0; i < 2; i++) {
			await a.svc.setRating(['trk-0'], i + 1);
			await syncAndPublish(a, b);
		}
		const after = rig.cloud.publishes.slice(1);
		expect(after.length).toBeGreaterThan(0);
		expect(after.every((p) => p.deviceId === bId && p.stateMatches)).toBe(true);
	});
});

describe('the publish against the server\'s answers', () => {
	it('deletes superseded parts: Storage holds exactly the kept snapshots', async () => {
		const a = await rig.desktop('a', EVERY);
		await rig.settle();
		await a.publishIdle();
		for (let i = 0; i < 4; i++) {
			await a.svc.setRating(['trk-0'], i + 1);
			await syncAndPublish(a);
		}
		expect(rig.cloud.publishes.filter((p) => p.status === 'stored')).toHaveLength(5);
		expect(rig.cloud.published).toHaveLength(3);
		expect(rig.cloud.removed.length).toBeGreaterThan(0);
		const kept = new Set(rig.cloud.published.flatMap((s) => s.manifest.parts.map((p) => p.path)));
		expect(new Set(rig.cloud.storage.keys())).toEqual(kept);
	});

	it('not_master: stops until the master cell changes, then publishes again', async () => {
		const a = await rig.desktop('a', EVERY);
		const b = await rig.desktop('b', EVERY);
		await rig.settle();
		await a.publishIdle();
		const n = rig.cloud.calls.publish;
		rig.cloud.fail.publish.push(new CloudTransportError('not_master', 'not_master'));
		await a.svc.setRating(['trk-0'], 1);
		await syncAndPublish(a);
		expect(rig.cloud.calls.publish).toBe(n + 1);
		await a.svc.setRating(['trk-0'], 2);
		await syncAndPublish(a);
		expect(rig.cloud.calls.publish).toBe(n + 1);
		// The master changes (to B and back to A: restating the same master
		// would emit nothing): A publishes again.
		const aId = await a.deviceId();
		await b.svc.setMasterDevice(await b.deviceId());
		await rig.settle();
		await Promise.all([a.publishIdle(), b.publishIdle()]);
		await b.svc.setMasterDevice(aId);
		await rig.settle();
		await Promise.all([a.publishIdle(), b.publishIdle()]);
		expect(rig.cloud.publishes.at(-1)).toMatchObject({ deviceId: aId, status: 'stored', stateMatches: true });
		expect(rig.cloud.publishes.at(-1)!.seq).toBe(rig.cloud.maxSeq);
	});

	it('a part missing on the server or a failed upload: retried on a later cycle', async () => {
		const a = await rig.desktop('a', EVERY);
		rig.cloud.fail.upload.push(new Error('Storage 503'));
		// One cycle at a time: settle() would run the retry itself.
		await syncAndPublish(a);
		expect([rig.cloud.calls.upload, rig.cloud.calls.publish]).toEqual([1, 0]);
		rig.cloud.fail.publish.push(new CloudTransportError('snapshot_part_missing', 'snapshot_part_missing'));
		await syncAndPublish(a);
		expect(rig.cloud.calls.publish).toBe(1);
		expect(rig.cloud.published).toHaveLength(0);
		await syncAndPublish(a);
		expect(rig.cloud.published).toHaveLength(1);
		expect(rig.cloud.publishes.at(-1)).toMatchObject({ status: 'stored', stateMatches: true });
	});
});
