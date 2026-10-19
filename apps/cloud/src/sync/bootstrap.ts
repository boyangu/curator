// sync.bootstrap: the latest snapshot inline plus the seq it covers; the
// client loads it, then pulls after `snapshotSeq`. Inline base64 because v1
// keeps snapshots in Postgres; the shape is the protocol's `BootstrapResult`.

import { createLibraryState, SNAPSHOT_ENCODING, type BootstrapResult } from '@curator/protocol';
import { num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { encodeSnapshot } from '../snapshot/codec.js';
import { BODY_BASE64 } from '../snapshot/job.js';

let emptyBody: Promise<string> | null = null;

// An account with no snapshot yet bootstraps from the empty state at seq 0,
// which is exactly "pull everything": one client code path either way.
function emptySnapshot(): Promise<string> {
	emptyBody ??= encodeSnapshot(createLibraryState()).then((b) => b.toString('base64'));
	return emptyBody;
}

export async function bootstrap(db: Db, userId: string): Promise<BootstrapResult> {
	const latest = await withUserTx(db, userId, async (tx) => {
		const [row] = await tx.query<{ seq: unknown; body: string }>(
			`select snapshot_seq::float8 as seq, ${BODY_BASE64} as body from curator.library_snapshot
			where user_id = (select auth.uid())
			order by snapshot_seq desc
			limit 1`,
		);
		return row ? { snapshot: row.body, snapshotSeq: num(row.seq) } : null;
	});
	if (latest) return { ...latest, encoding: SNAPSHOT_ENCODING };
	return { snapshot: await emptySnapshot(), snapshotSeq: 0, encoding: SNAPSHOT_ENCODING };
}
