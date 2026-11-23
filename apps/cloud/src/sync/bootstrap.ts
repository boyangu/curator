// sync.bootstrap: the newest snapshot's manifest plus the seq it covers and
// the account's base; the client downloads the parts from Storage with its
// own session, loads the state, then pulls after `snapshotSeq`. The shape is
// the protocol's `BootstrapResult`. Behind the same revoke gate as a pull
// (account/device-gate.ts).
//
// Every snapshot is one the account's master published to Storage
// ('snapshot_storage', src/sync/publish-snapshot.ts; sql/0009 dropped the
// server-folded kind), and this server cannot read one: it holds no Storage
// key. A client that does not say it can (`storage: true`) is therefore
// answered `update_required` (after the gate: who is asking is judged
// before what they can read, so a revoked device is still refused and
// audited as one): there is nothing else to give it, and the empty state
// would be a library missing everything the snapshot holds.
//
// The newest snapshot is offered as it is, a committing batch's fence or
// not: none is ever stored above a fence (visibility.ts; publishSnapshot
// refuses a seq above the visible head).
//
// With `replicaSchema` ('replica_storage') the answer also names the newest
// ready-made library of that format or older (publish-replica.ts), as long
// as the log can still be pulled from its seq: its snapshot is kept for that
// (publish-snapshot.ts retention), and the seq check below is the guard.

import type { BootstrapInput, BootstrapResult, ReplicaManifest, ReplicaOffer, SnapshotManifest } from '@curator/protocol';
import { assertSessionNotRevoked, gateDevice, type Caller } from '../account/device-gate.js';
import { num, type Db, type Queryable } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import { BaseInvariantError, newestSnapshot, readBase } from './base.js';

async function newestReplica(tx: Queryable, schema: number, base: number): Promise<ReplicaOffer | undefined> {
	const [row] = await tx.query<{ seq: unknown; storage: string }>(
		`select snapshot_seq::float8 as seq, storage::text as storage from curator.library_replica
		where user_id = (select auth.uid()) and schema_version <= $1::int and snapshot_seq >= $2::bigint
		order by snapshot_seq desc
		limit 1`,
		[String(schema), String(base)],
	);
	return row ? { snapshotSeq: num(row.seq), manifest: JSON.parse(row.storage) as ReplicaManifest } : undefined;
}

export async function bootstrap(db: Db, userId: string, caller: Caller, input: BootstrapInput = {}): Promise<BootstrapResult> {
	return withUserTx(db, userId, async (tx) => {
		if (input.deviceId !== undefined) await gateDevice(tx, caller, input.deviceId);
		else await assertSessionNotRevoked(tx, caller);
		if (!input.storage) throw new CloudError('PRECONDITION_FAILED', 'update_required');
		const base = await readBase(tx);
		const newest = await newestSnapshot(tx);
		if (!newest) {
			// An account that holds no snapshot yet bootstraps from the empty
			// state at seq 0, which is exactly "pull everything": only right
			// while nothing below a base is missing from the log.
			if (base > 0) throw new BaseInvariantError(userId, base);
			return { snapshotSeq: 0, baseSeq: 0 };
		}
		const replica = input.replicaSchema !== undefined ? await newestReplica(tx, input.replicaSchema, base) : undefined;
		return { storage: JSON.parse(newest.storage) as SnapshotManifest, snapshotSeq: newest.seq, baseSeq: base, ...(replica ? { replica } : {}) };
	});
}
