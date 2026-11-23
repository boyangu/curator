// A restored backup gets a new device identity (cloud plan, Workstream E:
// "restore must re-mint device.id and sync.clock").
//
// A backup carries `app_setting`, so restoring one hands this install the
// device id of the machine the backup came from. Two installs pushing under
// one id would be one device to the server: its own-op skip would hide each
// one's ops from the other, and the LWW tie-break would no longer tell them
// apart. Even a same-machine rollback is safer under a new id: the old id
// already pushed ops after the backup was taken, and this database cannot
// tell which.
//
// What changes, in one transaction, after migrate() and before anything
// emits or syncs:
//   - `device.id`: a fresh UUID. The old id stays registered on the account
//     (it simply stops pushing); the new one registers on the next sync.
//   - Pending outbox ops: re-stamped with the new id, records and
//     tombstones included (the server refuses an op whose device_id is not
//     the pusher's). Op ids are kept: if the old id already pushed one of
//     them after the backup, the server takes the re-push as a no-op (op id
//     is the idempotency key within an account), and its echo is skipped
//     here by op id like any own op.
//   - `sync.clock`: pinned to the restored outbox (outbox.ts pinClock) with
//     the server floor forgotten — seq_local and the issued stamp continue
//     after the restored rows, and the floor is learnt again on the next
//     pull.
//   - Client state: `registeredFor` cleared (register the new id) and
//     `ownThroughSeq` back to 0. The new id has nothing on the server yet,
//     and the old id's ops past the backup must come back on the pull as
//     anyone else's would — the same rule the restore-safe bound encodes.
//
// What stays: the account binding, the initial-push marker (the library is
// already in the log), and the pull cursor. The cursor was copied in the
// same VACUUM INTO as the rows it describes, so the restored tables hold
// exactly the ops up to it; pulling from there brings everything since,
// including what the old id pushed after the backup. Rewinding it would
// re-pull (or re-bootstrap) the whole log for no change in the result.
//
// Idempotent per restore: the restore id is recorded with the re-mint, and a
// boot that finds it already applied does nothing. The desktop calls this on
// every boot while the restore's record (restore-applied.json) exists, so a
// crash between the file swap and this step is caught on the next launch.
//
// The same swap, without the restore record, is how the sync client detaches
// this install from its account (client.ts `unlink`, after a revoke or on
// "Unlink"): a revoked device id is refused for good, so coming back needs a
// new one, and everything above holds for it unchanged.

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { parseOp, type Op } from '@curator/protocol';
import { DEVICE_ID_KEY } from './device.js';
import { CLOCK_KEY, pinClock } from './outbox.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

// The client's persisted state (client.ts ClientState); patched here as
// JSON so this module stays independent of the client.
const CLIENT_STATE_KEY = 'sync.client';
export const RESTORE_REMINT_KEY = 'device.restore';

export type RemintResult = {
	reminted: boolean;
	oldDeviceId: string | null;
	newDeviceId: string;
	// Pending outbox ops moved to the new id.
	restamped: number;
};

// Ops per store load. A restored outbox can hold tens of thousands of
// pending ops (a library restored before its initial push drained).
const CHUNK = 2_000;

function readSetting(raw: Raw, key: string): unknown {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(key) as { value: string } | undefined;
	if (!row) return undefined;
	try { return JSON.parse(row.value) as unknown; } catch { return undefined; }
}

function writeSetting(raw: Raw, key: string, value: unknown): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(key, JSON.stringify(value), Date.now());
}

type OutboxRow = { op_id: string; device_id: string; client_ts: number; schema_version: number; entity: string; entity_id: string; kind: string; payload: string };

// The swap itself: a fresh device id, the pending outbox re-stamped to it,
// the clock re-derived, registration and the own-op bound reset (header).
// Call inside a transaction.
function swapIdentity(raw: Raw, oldDeviceId: string | null): RemintResult {
	const newDeviceId = randomUUID();
	writeSetting(raw, DEVICE_ID_KEY, newDeviceId);

	let restamped = 0;
	const rows = raw.prepare(`SELECT op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload
		FROM sync_outbox WHERE state = 'pending' AND device_id != ? ORDER BY seq_local`).all(newDeviceId) as OutboxRow[];
	const setDevice = raw.prepare(`UPDATE sync_outbox SET device_id = ? WHERE op_id = ?`);
	for (let i = 0; i < rows.length; i += CHUNK) {
		const slice = rows.slice(i, i + CHUNK);
		const ops: Op[] = slice.map((r) => parseOp({
			op_id: r.op_id, device_id: r.device_id, client_ts: r.client_ts, schema_version: r.schema_version,
			entity: r.entity, entity_id: r.entity_id, kind: r.kind, payload: JSON.parse(r.payload),
		}));
		const store = new SyncStateStore(raw);
		store.prefetch(ops);
		for (const op of ops) store.touch(op);
		store.reassignDevice(new Set(ops.map((o) => o.op_id)), newDeviceId);
		store.flush();
		for (const r of slice) setDevice.run(newDeviceId, r.op_id);
		restamped += slice.length;
	}

	// The clock keeps its issued stamp and seq_local, raised to whatever the
	// restored outbox holds, and forgets the server floor (learnt again on the
	// next pull). Not dropped: readClock's fallback derives both from the
	// outbox's maxima, and acked rows are pruned after a week (outbox.ts), so
	// those maxima can sit below stamps already in the log.
	pinClock(raw);
	const clock = readSetting(raw, CLOCK_KEY) as Record<string, unknown> | undefined;
	if (clock) writeSetting(raw, CLOCK_KEY, { ...clock, lastServerTs: 0 });

	// Server batches ('batches') are per device: the old id's open ones expire
	// on the server, and their ops, now stamped with the new id, are staged
	// again under it.
	raw.prepare(`UPDATE sync_outbox SET batch_id = NULL WHERE state = 'pending' AND batch_id IS NOT NULL`).run();

	const client = readSetting(raw, CLIENT_STATE_KEY);
	if (client && typeof client === 'object') {
		writeSetting(raw, CLIENT_STATE_KEY, { ...(client as Record<string, unknown>), registeredFor: null, ownThroughSeq: 0, batches: {} });
	}
	return { reminted: true, oldDeviceId, newDeviceId, restamped };
}

function currentDeviceId(raw: Raw): string | null {
	const current = readSetting(raw, DEVICE_ID_KEY);
	return typeof current === 'string' && current ? current : null;
}

// `restoreId` names the restore (snapshot id + apply time), so the same
// restore never re-mints twice and a later restore always does.
export function remintDeviceIdentity(raw: Raw, restoreId: string): RemintResult {
	return raw.transaction((): RemintResult => {
		const oldDeviceId = currentDeviceId(raw);
		const mark = readSetting(raw, RESTORE_REMINT_KEY) as { restoreId?: unknown } | undefined;
		if (mark?.restoreId === restoreId && oldDeviceId) {
			return { reminted: false, oldDeviceId, newDeviceId: oldDeviceId, restamped: 0 };
		}
		const r = swapIdentity(raw, oldDeviceId);
		writeSetting(raw, RESTORE_REMINT_KEY, { restoreId, oldDeviceId, newDeviceId: r.newDeviceId, at: Date.now() });
		return r;
	})();
}

// Unconditionally, for the sync client's detach (header).
export function remintDeviceForDetach(raw: Raw): RemintResult {
	return raw.transaction((): RemintResult => swapIdentity(raw, currentDeviceId(raw)))();
}

// For the desktop main, which holds a path, not a handle, at boot.
export function remintDeviceIdentityAt(dbPath: string, restoreId: string): RemintResult {
	const raw = new Database(dbPath);
	try { return remintDeviceIdentity(raw, restoreId); }
	finally { raw.close(); }
}
