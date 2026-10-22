// The verifier for master-published snapshots ('snapshot_storage'): does
// the state the master serialised at `snapshotSeq` equal what the log folds
// to? The server cannot read the parts (no Storage key), but the manifest
// carries `stateSha256`, the sha256 of the serialised JSON, and the JSON is
// canonical (protocol snapshot.ts), so a server fold to the same seq must
// hash the same. A mismatch means the master's records drifted from the log
// (an op it applied but never pushed, a reducer difference between builds):
// exactly what a new device bootstrapping from it would inherit.
//
// Run by hand only (`snapshot verify --user <uuid>`, src/cli/snapshot.ts),
// never by the server's timer: it holds the whole state in memory, the cost
// publishing exists to keep out of the API process.

import { createHash } from 'node:crypto';
import { createLibraryState, serializeLibraryState } from '@curator/protocol';
import { bytes, num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { decodeSnapshot } from './codec.js';
import { DEFAULT_SNAPSHOT_OPTIONS, foldRange } from './job.js';

export type SnapshotVerification =
	| { userId: string; status: 'no_published_snapshot' }
	| {
			userId: string;
			status: 'match' | 'mismatch';
			snapshotSeq: number;
			publishedBy: string;
			// The bodied snapshot the fold started from (0: the empty state).
			baseSeq: number;
			opsFolded: number;
			stateSha256: string;
			foldSha256: string;
	  };

export async function verifyPublishedSnapshot(db: Db, userId: string, pageSize = DEFAULT_SNAPSHOT_OPTIONS.pageSize): Promise<SnapshotVerification> {
	const start = await withUserTx(db, userId, async (tx) => {
		const [published] = await tx.query<{ seq: unknown; state_sha256: string; published_by: string }>(
			`select snapshot_seq::float8 as seq, state_sha256, published_by from curator.library_snapshot
			where user_id = (select auth.uid()) and storage is not null
			order by snapshot_seq desc
			limit 1`,
		);
		if (!published) return null;
		const [base] = await tx.query<{ seq: unknown; body: unknown }>(
			`select snapshot_seq::float8 as seq, body from curator.library_snapshot
			where user_id = (select auth.uid()) and body is not null and snapshot_seq <= $1::bigint
			order by snapshot_seq desc
			limit 1`,
			[String(num(published.seq))],
		);
		return {
			snapshotSeq: num(published.seq),
			stateSha256: published.state_sha256,
			publishedBy: published.published_by,
			baseSeq: base ? num(base.seq) : 0,
			body: base ? bytes(base.body) : null,
		};
	});
	if (!start) return { userId, status: 'no_published_snapshot' };
	const state = start.body ? await decodeSnapshot(start.body) : createLibraryState();
	const opsFolded = await foldRange(db, userId, state, start.baseSeq, start.snapshotSeq, pageSize);
	const foldSha256 = createHash('sha256').update(serializeLibraryState(state), 'utf8').digest('hex');
	return {
		userId,
		status: foldSha256 === start.stateSha256 ? 'match' : 'mismatch',
		snapshotSeq: start.snapshotSeq,
		publishedBy: start.publishedBy,
		baseSeq: start.baseSeq,
		opsFolded,
		stateSha256: start.stateSha256,
		foldSha256,
	};
}
