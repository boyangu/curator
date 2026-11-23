// sync.publishReplica ('replica_storage', sql/0034_library_replica.sql;
// protocol cloud-service.ts). After publishing a snapshot, the account's
// master ran the same join a fresh device runs, into an empty library, and
// uploaded the database as gzip parts to the `snapshots` bucket with its own
// session; it names them here. As for a snapshot the server never sees the
// bytes and checks what it can without them:
//   - the manifest: every part at snapshotPartPath(caller, sha256), no path
//     twice, the sizes adding up (`snapshot_part_invalid`);
//   - the device gate and the master (`not_master`), as publishSnapshot;
//   - the snapshot it stands on is stored (`replica_without_snapshot`): the
//     replica is that snapshot joined, and keeping that snapshot keeps the
//     log replayable from its seq (snapshot retention pins it,
//     publish-snapshot.ts);
//   - every part exists in the caller's prefix with the stated size.
// That the parts inflate to `rawSha256` is the installing device's check.
//
// Retention: the newest replica only. Storing one unpins the snapshot the
// previous one stood on, so snapshot retention runs again here, and the
// parts both free reach the publisher as `superseded`.

import { SYNC_FEATURES, type PublishReplicaInput, type PublishReplicaResult } from '@curator/protocol';
import { gateDevice, type Caller } from '../account/device-gate.js';
import type { AuditEmit } from '../audit.js';
import { num, type Db, type Queryable } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import { readMaster } from './master.js';
import { assertManifest, assertPartsUploaded, partPaths, pruneSnapshots, SNAPSHOT_KEEP, SNAPSHOT_LOCK, unreferenced } from './publish-snapshot.js';

export const REPLICA_KEEP = 1;

async function pruneReplicas(tx: Queryable, keep: number): Promise<{ pruned: number; freed: string[] }> {
	const dropped = await tx.query<{ storage: string }>(
		`with ranked as (
			select snapshot_seq, row_number() over (order by snapshot_seq desc) as rn
			from curator.library_replica
			where user_id = (select auth.uid())
		)
		delete from curator.library_replica p
		using ranked r
		where p.user_id = (select auth.uid()) and p.snapshot_seq = r.snapshot_seq and r.rn > $1::int
		returning p.storage::text as storage`,
		[String(keep)],
	);
	return { pruned: dropped.length, freed: dropped.flatMap((r) => partPaths(r.storage)) };
}

export async function publishReplica(db: Db, audit: AuditEmit, userId: string, caller: Caller, input: PublishReplicaInput, keep = REPLICA_KEEP): Promise<PublishReplicaResult> {
	const m = input.manifest;
	assertManifest(userId, m);
	const result = await withUserTx(db, userId, async (tx) => {
		await gateDevice(tx, caller, input.deviceId);
		if ((await readMaster(tx)) !== input.deviceId) throw new CloudError('FORBIDDEN', 'not_master');
		await assertPartsUploaded(tx, m.parts);

		await tx.query(SNAPSHOT_LOCK);
		const [snapshot] = await tx.query<{ one: number }>(
			`select 1 as one from curator.library_snapshot where user_id = (select auth.uid()) and snapshot_seq = $1::bigint`,
			[String(input.snapshotSeq)],
		);
		if (!snapshot) throw new CloudError('PRECONDITION_FAILED', 'replica_without_snapshot');
		const paths = m.parts.map((p) => p.path);
		const [latest] = await tx.query<{ seq: unknown; same: boolean }>(
			`select max(snapshot_seq)::float8 as seq, bool_or(snapshot_seq = $1::bigint) as same
			from curator.library_replica where user_id = (select auth.uid())`,
			[String(input.snapshotSeq)],
		);
		const latestSeq = latest!.seq === null ? 0 : num(latest!.seq);
		// Nothing written; the caller's own parts are named unless a stored
		// manifest lists them (as publishSnapshot does).
		const refused = latest!.same ? ('exists' as const) : latestSeq > input.snapshotSeq ? ('stale' as const) : null;
		if (refused) return { status: refused, latestSeq, superseded: await unreferenced(tx, paths), pruned: 0 };
		await tx.query(
			`insert into curator.library_replica (snapshot_seq, schema_version, storage, published_by)
			values ($1::bigint, $2::int, $3::text::jsonb, $4)`,
			[String(input.snapshotSeq), String(m.schema), JSON.stringify(m), input.deviceId],
		);
		const replicas = await pruneReplicas(tx, keep);
		const snapshots = await pruneSnapshots(tx, SNAPSHOT_KEEP);
		const superseded = await unreferenced(tx, [...replicas.freed, ...snapshots.superseded]);
		return { status: 'stored' as const, latestSeq: input.snapshotSeq, superseded, pruned: replicas.pruned + snapshots.pruned };
	});
	if (result.status === 'stored') {
		audit('replica_published', { snapshotSeq: input.snapshotSeq, schema: m.schema, bytes: m.totalBytes, rawBytes: m.rawBytes, parts: m.parts.length, pruned: result.pruned, superseded: result.superseded.length });
	}
	return { status: result.status, latestSeq: result.latestSeq, superseded: result.superseded, features: [...SYNC_FEATURES] };
}
