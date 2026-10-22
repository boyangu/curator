// sync.bootstrap: the latest snapshot plus the seq it covers; the client
// loads it, then pulls after `snapshotSeq`. The shape is the protocol's
// `BootstrapResult`. Behind the same revoke gate as a pull
// (account/device-gate.ts).
//
// Two kinds of snapshot (sql/0008_snapshot_storage.sql): bodied ones the
// server's fold wrote into Postgres, and Storage ones the account's master
// published ('snapshot_storage', src/sync/publish-snapshot.ts), which this
// server cannot read: it holds no Storage key. A client that asks
// `storage: true` gets the newest of either; when that is a Storage one, the
// answer is its manifest and the client downloads the parts itself with its
// own session. Any other client gets the newest bodied snapshot (an older
// seq is fine: it pulls the rest), or the empty state at 0.
//
// 'snapshot_chunks': a client that asks `chunked: true` gets a bodied
// snapshot's size, not its body, and reads the body in pieces through
// sync.snapshotChunk, under the user's RLS like every read here. A bytea
// gzip body is stored uncompressed out of line (pglz finds nothing to gain
// on gzip), so `substring(body from … for …)` reads just the slice's TOAST
// chunks, not the whole value per piece. Bodies leave Postgres as bytea and
// are base64'd here, never by SQL's encode() (db.ts).
//
// The newest snapshot is offered as it is, a committing batch's fence or
// not: none is ever stored above a fence (visibility.ts; publishSnapshot
// refuses a seq above the visible head).

import {
	createLibraryState,
	SNAPSHOT_ENCODING,
	type BootstrapInput,
	type BootstrapResult,
	type SnapshotChunkInput,
	type SnapshotChunkResult,
	type SnapshotManifest,
} from '@curator/protocol';
import { assertSessionNotRevoked, gateDevice, type Caller } from '../account/device-gate.js';
import { bytes, num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import { encodeSnapshot } from '../snapshot/codec.js';

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
		// A client that cannot read Storage gets the newest bodied snapshot,
		// however much newer a published one is: it pulls the difference.
		// The body is read only for an inline answer; `body is null` is the
		// null bitmap, not a detoast.
		const [row] = await tx.query<{ seq: unknown; bytes: unknown; storage: string | null; body?: unknown }>(
			`select snapshot_seq::float8 as seq, octet_length(body)::float8 as bytes, storage::text as storage${input.chunked ? '' : ', body'}
			from curator.library_snapshot
			where user_id = (select auth.uid())${input.storage ? '' : ' and body is not null'}
			order by snapshot_seq desc
			limit 1`,
		);
		if (!row) return null;
		const snapshotSeq = num(row.seq);
		if (row.storage !== null) return { snapshot: '', snapshotSeq, storage: JSON.parse(row.storage) as SnapshotManifest };
		if (input.chunked) return { snapshot: '', snapshotSeq, chunked: { totalBytes: num(row.bytes) } };
		return { snapshot: bytes(row.body).toString('base64'), snapshotSeq };
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
		const [row] = await tx.query<{ data: unknown; bytes: unknown }>(
			`select substring(body from $2::int + 1 for $3::int) as data, octet_length(body)::float8 as bytes
			from curator.library_snapshot
			where user_id = (select auth.uid()) and snapshot_seq = $1::bigint and body is not null`,
			[String(input.snapshotSeq), String(input.offset), String(input.length)],
		);
		if (!row) throw new CloudError('NOT_FOUND', 'snapshot_gone');
		return { snapshotSeq: input.snapshotSeq, offset: input.offset, data: bytes(row.data).toString('base64'), totalBytes: num(row.bytes) };
	});
}
