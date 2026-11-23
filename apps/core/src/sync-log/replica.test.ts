// Ready-made libraries ('replica_storage', replica.ts): the master builds one
// from its first snapshot by joining it with the real client against an
// account of its own, and then at most weekly; a new device installs it
// instead of joining, takes an identity of its own, and ends equal to the
// master without pulling the base or pushing anything; a replica that does
// not check out installs nothing.
//
// Generated DBs only (CLAUDE.md): the two-desktop rig (mkdtempSync +
// migrate()), the in-memory fake cloud, no remoteWritePolicy.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markPreOpLog, replicaDiff, TwoDesktopRig, type Desktop } from '../test-support/two-desktops.js';
import { readCursor } from '@curator/sync-core/sync-log/client';
import { inlineReplicaBuilder, installReplica, joinFromReplica, REPLICA_SCHEMA } from '@curator/sync-core/sync-log/replica';
import { recordingIdForTrack } from '@curator/sync-core/sync-log/recording-id';

let rig: TwoDesktopRig;
beforeEach(() => { rig = new TwoDesktopRig('curator-replica-'); });
afterEach(async () => {
	const upstream = rig.upstreamCalls();
	await rig.close();
	expect(upstream).toEqual([]);
});

const hash = (n: number): string => `pcm-md5:${String(n).repeat(32).slice(0, 32)}`;

// The master: three recordings (two files, one Spotify track), one tagged
// and one rated, publishing snapshots and replicas.
const master = (replicaEveryMs?: number): Promise<Desktop> => rig.desktop('a', {
	catalogue: ['a-1', 'a-2', 'a-3'],
	seed: (raw) => {
		for (const [id, n] of [['a-1', 1], ['a-2', 2]] as const) {
			raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash) VALUES (?, ?, 'local', ?, ?, ?)`).run(`sl-${id}`, id, `c:/music/${id}.flac`, `c:/music/${id}.flac`, hash(n));
		}
		raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES ('sp-a-3', 'a-3', 'spotify', 'sp3', 1700000000000)`).run();
		raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES ('warm', 'Warm', 'user', 1600000000000)`).run();
		raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES ('a-1', 'warm', 1600000000000)`).run();
		raw.prepare(`UPDATE track SET rating = 4 WHERE id = 'a-2'`).run();
		markPreOpLog(raw);
	},
	snapshot: { replica: inlineReplicaBuilder(join(rig.dir, 'replica-tmp')), ...(replicaEveryMs !== undefined ? { replicaEveryMs, everyOps: 1, everyMs: 0 } : {}) },
});

describe('the master', () => {
	it('builds a replica of its first snapshot, uploads it and publishes it, without an op of its own', async () => {
		const a = await master();
		await a.sync();
		expect(rig.cloud.published.map((p) => p.seq)).toEqual([1]);
		expect(rig.cloud.replicas.map((r) => r.seq)).toEqual([1]);
		const m = rig.cloud.replicas[0]!.manifest;
		expect(m.schema).toBe(REPLICA_SCHEMA);
		for (const p of m.parts) expect(rig.cloud.storage.get(p.path)?.byteLength).toBe(p.bytes);
		// The join it ran was the builder's own: the account's log holds only
		// the master setting, and the master's outbox nothing new.
		expect(rig.cloud.log.map((o) => o.entity)).toEqual(['setting']);
		expect(a.one(`SELECT count(*) FROM sync_outbox WHERE entity != 'setting'`)).toBe(0);
	});

	it('publishes the next replica only once the last is a week old (here: due at once), freeing the old one', async () => {
		const a = await master(0);
		await a.sync();
		const first = rig.cloud.replicas[0]!;
		await a.svc.setRating(['a-1'], 5);
		await a.sync();
		await a.sync();
		expect(rig.cloud.replicas.map((r) => r.seq)).toEqual([rig.cloud.published.at(-1)!.seq]);
		for (const p of first.manifest.parts) expect(rig.cloud.removed).toContain(p.path);
	});

	it('does not publish a second replica within the week', async () => {
		const a = await master();
		await a.sync();
		await a.svc.setRating(['a-1'], 5);
		await a.sync();
		expect(rig.cloud.replicas.map((r) => r.seq)).toEqual([1]);
	});
});

describe('a new device', () => {
	it('installs the replica instead of joining, with an identity of its own, and ends equal to the master', async () => {
		const a = await master();
		await a.sync();
		let installed: Awaited<ReturnType<typeof joinFromReplica>> = null;
		const b = await rig.desktop('b', { install: async (path, transport) => { installed = await joinFromReplica(transport, path); } });
		expect(installed).toMatchObject({ snapshotSeq: 1 });
		await rig.settle();
		// No base downloaded: the replica was it.
		expect(rig.cloud.calls.storageBootstraps).toBe(0);
		expect(readCursor(b.raw)).toMatchObject({ lastSeq: rig.cloud.maxSeq });
		expect(await b.deviceId()).not.toBe(await a.deviceId());
		expect(replicaDiff(a, b)).toEqual([]);
		expect(b.one(`SELECT rating FROM track WHERE recording_id = ?`, recordingIdForTrack('a-2'))).toBe(4);
		expect(rig.cloud.log.filter((o) => o.device_id === installed!.deviceId)).toEqual([]);
		// And it keeps up from there: the master's next edit reaches it.
		await a.svc.setRating(['a-1'], 2);
		await rig.settle();
		expect(b.one(`SELECT rating FROM track WHERE recording_id = ?`, recordingIdForTrack('a-1'))).toBe(2);
	});

	it('installs nothing when a part does not check out, or where a library already is', async () => {
		const a = await master();
		await a.sync();
		const offer = { snapshotSeq: 1, manifest: rig.cloud.replicas[0]!.manifest };
		const target = join(rig.dir, 'fresh.db');
		const tampered = (path: string): Promise<Uint8Array> => {
			const bytes = Uint8Array.from(rig.cloud.storage.get(path)!);
			bytes[bytes.length - 1]! ^= 0xff;
			return Promise.resolve(bytes);
		};
		await expect(installReplica({ offer, dbPath: target, download: tampered })).rejects.toThrow(/does not match/);
		expect(existsSync(target)).toBe(false);
		expect(existsSync(`${target}.replica`)).toBe(false);
		writeFileSync(target, 'not a library');
		await expect(installReplica({ offer, dbPath: target, download: async (p) => rig.cloud.storage.get(p)! })).rejects.toThrow(/already exists/);
	});
});
