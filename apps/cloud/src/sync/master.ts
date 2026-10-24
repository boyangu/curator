// The account's master device: the `library.master_device` account setting
// (protocol ops.ts MASTER_DEVICE_SETTING), an ordinary `setting` op whose
// LWW winner names the device whose metadata wins everywhere and which
// alone publishes snapshots ('snapshot_storage'). The server never folds
// the log to learn it: one probe of the partial index 0008 adds
// (library_op_master_device), ordered exactly as the reducer's compareClock
// orders clocks (client_ts, device id by code unit, op id).
//
// Read from the log as it stands, a committing batch's fence or not: the
// question is who the account says its master is now, not what a reader may
// see yet, and the push's audit below must see the call's own ops.

import { compareClock, MASTER_DEVICE_SETTING, type Clock, type Op } from '@curator/protocol';
import { num, type Queryable } from '../db/db.js';

export type MasterClaim = { deviceId: string | null; clock: Clock };

// The winning setting op, or null when the account never stated one. A
// winner whose value is not a string (a cleared setting) states no master.
async function readMasterClaim(tx: Queryable): Promise<MasterClaim | null> {
	const [row] = await tx.query<{ device_id: string; client_ts: unknown; op_id: string; value: string | null }>(
		`select device_id, client_ts::float8 as client_ts, op_id::text as op_id,
			case when jsonb_typeof(payload -> 'value') = 'string' then payload ->> 'value' end as value
		from curator.library_op
		where user_id = (select auth.uid()) and entity = 'setting' and entity_id = $1
		order by client_ts desc, device_id collate "C" desc, op_id desc
		limit 1`,
		[MASTER_DEVICE_SETTING],
	);
	return row ? { deviceId: row.value, clock: { ts: num(row.client_ts), device: row.device_id, op: row.op_id } } : null;
}

// The current master's device id, or null when none is stated. `extra`: ops
// not in library_op yet that still count (a batch's staged ops), merged
// with the log's winner by the reducer's own clock order.
export async function readMaster(tx: Queryable, extra: readonly Op[] = []): Promise<string | null> {
	let best = await readMasterClaim(tx);
	for (const op of extra) {
		if (op.entity !== 'setting' || op.entity_id !== MASTER_DEVICE_SETTING) continue;
		const clock: Clock = { ts: op.client_ts, device: op.device_id, op: op.op_id.toLowerCase() };
		if (best && compareClock(best.clock, clock) >= 0) continue;
		const value = (op.payload as { value: unknown }).value;
		best = { deviceId: typeof value === 'string' ? value : null, clock };
	}
	return best?.deviceId ?? null;
}

// The kinds that carry a device's source metadata for a recording or album,
// which only the master's copy should seed (desktop: the master's set-meta /
// set-attrs / album meta win; other devices stop emitting them). Audited, not
// refused: a non-master's op is still a valid op the reducer merges, and
// refusing it would strand it in that device's outbox for good.
// playlist.set-attrs' provider fields are master-only on the client too, but
// they are fields of an op every device sends, so counting them here would
// be noise.
export const SOURCE_KINDS = ['library_track.set-meta', 'library_track.set-attrs', 'library_track.set-analysis', 'album.set-meta'] as const;
const SOURCE_KIND_SET: ReadonlySet<string> = new Set(SOURCE_KINDS);

export function countSourceKinds(ops: readonly Op[]): Record<string, number> | null {
	let out: Record<string, number> | null = null;
	for (const op of ops) {
		const k = `${op.entity}.${op.kind}`;
		if (!SOURCE_KIND_SET.has(k)) continue;
		out ??= {};
		out[k] = (out[k] ?? 0) + 1;
	}
	return out;
}

// The push's and batchPush's audit: source ops accepted from a device that
// is not the master. `null` when there is nothing to say: the call carries
// no source kind (no probe at all, so a plain push pays nothing), the
// account states no master (a first device's initial push, before its own
// setting op has landed), or the caller is the master.
export async function sourceFromNonMaster(tx: Queryable, deviceId: string, accepted: readonly Op[], extra: readonly Op[] = []): Promise<{ master: string; byKind: Record<string, number> } | null> {
	const byKind = countSourceKinds(accepted);
	if (!byKind) return null;
	const master = await readMaster(tx, extra);
	if (master === null || master === deviceId) return null;
	return { master, byKind };
}
