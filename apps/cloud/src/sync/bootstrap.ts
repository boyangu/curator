// sync.bootstrap: the latest snapshot plus the seq it covers; the client
// loads it, then pulls after `snapshotSeq`. Inline base64 because v1 keeps
// snapshots in Postgres; the shape is the protocol's `BootstrapResult`.
// Behind the same revoke gate as a pull (account/device-gate.ts).
//
// 'snapshot_chunks': a client that asks `chunked: true` gets the size, not
// the body, and reads the body in pieces through sync.snapshotChunk. Still
// from Postgres, under the user's RLS like every read here: the API holds no
// Storage service key, so a bucket would have to be written as the user,
// and the snapshot job runs on a timer with no user session to write with.
// A bytea gzip body is stored uncompressed out of line (pglz finds nothing
// to gain on gzip), so `substring(body from … for …)` reads just the slice's
// TOAST chunks, not the whole value per piece.

import {
	createLibraryState,
	SNAPSHOT_ENCODING,
	type BootstrapInput,
	type BootstrapResult,
	type SnapshotChunkInput,
	type SnapshotChunkResult,
} from '@curator/protocol';
import { assertSessionNotRevoked, gateDevice, type Caller } from '../account/device-gate.js';
import { num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import { encodeSnapshot } from '../snapshot/codec.js';
import { BODY_BASE64 } from '../snapshot/job.js';

let emptyBody: Promise<string> | null = null;

// An account with no snapshot yet bootstraps from the empty state at seq 0,
// which is exactly "pull everything": one client code path either way.
function emptySnapshot(): Promise<string> {
	emptyBody ??= encodeSnapshot(createLibraryState()).then((b) => b.toString('base64'));
	return emptyBody;
}

export async function bootstrap(db: Db, userId: string, caller: Caller, input: BootstrapInput = {}): Promise<BootstrapResult> {
	const latest = await withUserTx(db, userId, async (tx) => {
		if (input.deviceId !== undefined) await gateDevice(tx, caller, input.deviceId);
		else await assertSessionNotRevoked(tx, caller);
		if (input.chunked) {
			const [row] = await tx.query<{ seq: unknown; bytes: unknown }>(
				`select snapshot_seq::float8 as seq, octet_length(body)::float8 as bytes from curator.library_snapshot
				where user_id = (select auth.uid())
				order by snapshot_seq desc
				limit 1`,
			);
			return row ? { snapshot: '', snapshotSeq: num(row.seq), chunked: { totalBytes: num(row.bytes) } } : null;
		}
		const [row] = await tx.query<{ seq: unknown; body: string }>(
			`select snapshot_seq::float8 as seq, ${BODY_BASE64} as body from curator.library_snapshot
			where user_id = (select auth.uid())
			order by snapshot_seq desc
			limit 1`,
		);
		return row ? { snapshot: row.body, snapshotSeq: num(row.seq) } : null;
	});
	if (latest) return { ...latest, encoding: SNAPSHOT_ENCODING };
	// The empty state is a few hundred bytes: inline even when chunked.
	return { snapshot: await emptySnapshot(), snapshotSeq: 0, encoding: SNAPSHOT_ENCODING };
}

// One piece of the snapshot at `snapshotSeq` (bytes from `offset`, 0-based).
export async function snapshotChunk(db: Db, userId: string, caller: Caller, input: SnapshotChunkInput): Promise<SnapshotChunkResult> {
	return withUserTx(db, userId, async (tx) => {
		if (input.deviceId !== undefined) await gateDevice(tx, caller, input.deviceId);
		else await assertSessionNotRevoked(tx, caller);
		const [row] = await tx.query<{ data: string; bytes: unknown }>(
			`select translate(encode(substring(body from $2::int + 1 for $3::int), 'base64'), chr(10), '') as data, octet_length(body)::float8 as bytes
			from curator.library_snapshot
			where user_id = (select auth.uid()) and snapshot_seq = $1::bigint`,
			[String(input.snapshotSeq), String(input.offset), String(input.length)],
		);
		if (!row) throw new CloudError('NOT_FOUND', 'snapshot_gone');
		return { snapshotSeq: input.snapshotSeq, offset: input.offset, data: row.data, totalBytes: num(row.bytes) };
	});
}
