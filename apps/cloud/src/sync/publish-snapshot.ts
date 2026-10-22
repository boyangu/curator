// sync.publishSnapshot ('snapshot_storage', sql/0008_snapshot_storage.sql;
// protocol cloud-service.ts). The account's master device has folded the log
// up to `snapshotSeq` in its own records, uploaded the gzip as parts to the
// `snapshots` bucket with its own session (sql/storage.sql), and names them
// here. The server never sees the bytes: it holds no Storage key, and
// downloading 37 MB to re-hash it would bring back the memory cost this
// exists to remove. It checks what it can without them, then indexes the
// manifest:
//   - the manifest: every part at snapshotPartPath(caller, sha256), no path
//     twice, the sizes adding up to totalBytes (`snapshot_part_invalid`,
//     before a connection is taken);
//   - the device gate, as for every write (account/device-gate.ts);
//   - the caller is the account's master (`not_master`; master.ts), so no
//     other device, and no stale install of the account, can replace what
//     new devices load;
//   - the seq is at or below the visible head (`snapshot_ahead`): a snapshot
//     above a batch's fence would let a bootstrapping device skip ops it
//     cannot see yet (visibility.ts);
//   - every part exists in the caller's prefix with the stated size, read
//     from storage.objects under the caller's RLS as catalogue.put reads its
//     blobs (`snapshot_part_missing`).
// That the parts' bytes hash to their names is the reader's check (it
// verifies sha256 and totalBytes before it inflates); that the state is the
// one the log folds to is the other devices' (`PullResult.published` hands
// them the master's `stateSha256` to compare with their own digest at that
// seq). The server never folds anything.
//
// Retention: the newest KEEP snapshots. The snapshot is the account's base
// (sql/0009, base.ts): the oldest kept one bounds how far compaction may
// delete the log, so keeping three means the base trails the head by two
// publishes. Rows are pruned only here, so the parts they free reach the
// one device that can delete them: `superseded`, never a path a kept row
// lists.

import { snapshotPartPath, SYNC_FEATURES, type PublishSnapshotInput, type PublishSnapshotResult, type SnapshotManifest } from '@curator/protocol';
import { gateDevice, type Caller } from '../account/device-gate.js';
import type { AuditEmit } from '../audit.js';
import { num, type Db, type Queryable } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import { headSeq, readBase } from './base.js';
import { readMaster } from './master.js';

export const SNAPSHOT_KEEP = 3;

// Serialises a user's publishes, so the retention below reads a set no other
// publish is changing.
export const SNAPSHOT_LOCK = `select pg_advisory_xact_lock(hashtextextended('library_snapshot:' || (select auth.uid())::text, 0))`;

// Pure: the manifest's own consistency against the caller.
export function assertManifest(userId: string, m: SnapshotManifest): void {
	const paths = new Set<string>();
	let total = 0;
	for (const p of m.parts) {
		if (p.path !== snapshotPartPath(userId, p.sha256) || paths.has(p.path)) throw new CloudError('PRECONDITION_FAILED', 'snapshot_part_invalid');
		paths.add(p.path);
		total += p.bytes;
	}
	if (total !== m.totalBytes) throw new CloudError('PRECONDITION_FAILED', 'snapshot_part_invalid');
}

const partPaths = (storage: string | null): string[] => (storage ? (JSON.parse(storage) as SnapshotManifest).parts.map((p) => p.path) : []);

// `candidates` minus every part a stored manifest still lists: content
// addressing lets two snapshots share a part (an unchanged leading stretch
// of the JSON gzips to the same bytes), and that part must stay.
async function unreferenced(tx: Queryable, candidates: Iterable<string>): Promise<string[]> {
	const freed = new Set(candidates);
	if (freed.size === 0) return [];
	const kept = await tx.query<{ storage: string }>(
		`select storage::text as storage from curator.library_snapshot where user_id = (select auth.uid()) and storage is not null`,
	);
	for (const r of kept) for (const p of partPaths(r.storage)) freed.delete(p);
	return [...freed].sort();
}

// Deletes what retention drops (every row but the newest `keep`); answers
// how many rows went and the parts they freed. Only older rows go, so the
// account's oldest kept seq only ever rises and the base stays at or below
// it (base.ts).
async function prune(tx: Queryable, keep: number): Promise<{ pruned: number; superseded: string[] }> {
	const dropped = await tx.query<{ storage: string | null }>(
		`with ranked as (
			select snapshot_seq, row_number() over (order by snapshot_seq desc) as rn
			from curator.library_snapshot
			where user_id = (select auth.uid())
		)
		delete from curator.library_snapshot s
		using ranked r
		where s.user_id = (select auth.uid()) and s.snapshot_seq = r.snapshot_seq and r.rn > $1::int
		returning s.storage::text as storage`,
		[String(keep)],
	);
	return { pruned: dropped.length, superseded: await unreferenced(tx, dropped.flatMap((r) => partPaths(r.storage))) };
}

export async function publishSnapshot(db: Db, audit: AuditEmit, userId: string, caller: Caller, input: PublishSnapshotInput, keep = SNAPSHOT_KEEP): Promise<PublishSnapshotResult> {
	const m = input.manifest;
	assertManifest(userId, m);
	const result = await withUserTx(db, userId, async (tx) => {
		await gateDevice(tx, caller, input.deviceId);
		if ((await readMaster(tx)) !== input.deviceId) throw new CloudError('FORBIDDEN', 'not_master');

		if (input.snapshotSeq > (await headSeq(tx, 'visible'))) throw new CloudError('PRECONDITION_FAILED', 'snapshot_ahead');

		const paths = m.parts.map((p) => p.path);
		const objects = await tx.query<{ name: string; size: unknown }>(
			`select o.name, (o.metadata ->> 'size')::float8 as size from storage.objects o
			where o.bucket_id = 'snapshots' and o.name in (select jsonb_array_elements_text($1::text::jsonb))`,
			[JSON.stringify(paths)],
		);
		const sizes = new Map(objects.map((o) => [o.name, o.size === null ? null : num(o.size)]));
		if (m.parts.some((p) => sizes.get(p.path) !== p.bytes)) throw new CloudError('PRECONDITION_FAILED', 'snapshot_part_missing');

		await tx.query(SNAPSHOT_LOCK);
		const [latest] = await tx.query<{ seq: unknown; same: boolean }>(
			`select max(snapshot_seq)::float8 as seq, bool_or(snapshot_seq = $1::bigint) as same
			from curator.library_snapshot where user_id = (select auth.uid())`,
			[String(input.snapshotSeq)],
		);
		const latestSeq = latest!.seq === null ? 0 : num(latest!.seq);
		// Nothing is written. The caller's own parts are named unless a stored
		// manifest lists them (a retried publish of the stored snapshot), so a
		// publish that lost the race does not leave its upload behind. A seq at
		// or below the base is stale whatever the snapshot table holds: the
		// log below it is gone, so nothing could ever be rebased onto it.
		const refused = latest!.same ? ('exists' as const) : latestSeq > input.snapshotSeq || input.snapshotSeq <= (await readBase(tx)) ? ('stale' as const) : null;
		if (refused) return { status: refused, latestSeq, superseded: await unreferenced(tx, paths), pruned: 0 };
		await tx.query(
			`insert into curator.library_snapshot (snapshot_seq, storage, state_sha256, published_by)
			values ($1::bigint, $2::text::jsonb, $3, $4)`,
			[String(input.snapshotSeq), JSON.stringify(m), m.stateSha256, input.deviceId],
		);
		const { pruned, superseded } = await prune(tx, keep);
		return { status: 'stored' as const, latestSeq: input.snapshotSeq, superseded, pruned };
	});
	if (result.status === 'stored') {
		audit('snapshot_published', { snapshotSeq: input.snapshotSeq, bytes: m.totalBytes, parts: m.parts.length, pruned: result.pruned, superseded: result.superseded.length });
	}
	return { status: result.status, latestSeq: result.latestSeq, superseded: result.superseded, features: [...SYNC_FEATURES] };
}
