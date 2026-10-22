// Who may still use the API after a revoke (sql/0006_device_session.sql).
//
// Two facts decide it, read in one statement inside the request's user
// transaction:
//   - the device the call names, when it names one: unknown is
//     `device_not_registered` (register, then retry), revoked is
//     `device_revoked`;
//   - the device the caller's Supabase session last acted as: revoked is
//     `device_revoked` too, whichever device the call names and whether it
//     names one at all. This is the half that does not take the client's
//     word: a revoked laptop running a client that leaves the device id out
//     (an older desktop, or a modified one) is still refused, as long as its
//     session acted as that device once since 0006 shipped.
// A call that passes binds its session to the device it named, so the next
// call from that session is judged by it even if it names nothing.
//
// The session id is the token's `session_id` claim, verified with the token
// (auth/jwt.ts). A token without one is judged by the device id alone.

import type { Queryable } from '../db/db.js';
import { CloudError } from '../errors.js';

// Which fact refused the call; it rides on the audit event only. The wire
// answer is the same `device_revoked` either way.
export type RevokedVia = 'device' | 'session';

export class DeviceRevokedError extends CloudError {
	constructor(readonly via: RevokedVia) {
		super('FORBIDDEN', 'device_revoked');
	}
}

export type Caller = { sessionId: string | null };

type GateRow = { session_revoked: boolean | null; device_revoked: boolean | null };

async function readGate(tx: Queryable, caller: Caller, deviceId: string | null): Promise<GateRow> {
	const [row] = await tx.query<GateRow>(
		`select
			(select d.revoked_at is not null
				from curator.device_session s
				join curator.device d on d.user_id = s.user_id and d.device_id = s.device_id
				where s.user_id = (select auth.uid()) and s.session_id = $1) as session_revoked,
			(select d.revoked_at is not null
				from curator.device d
				where d.user_id = (select auth.uid()) and d.device_id = $2) as device_revoked`,
		[caller.sessionId, deviceId],
	);
	return row!;
}

// The session alone, for calls that name no device (account.devices /
// revokeDevice, a pull or bootstrap from a client before 'device_reads').
export async function assertSessionNotRevoked(tx: Queryable, caller: Caller): Promise<void> {
	if (caller.sessionId === null) return;
	const g = await readGate(tx, caller, null);
	if (g.session_revoked) throw new DeviceRevokedError('session');
}

// Binds the session to `deviceId`. The device must exist (FK) and must not
// be revoked; callers check both first. A no-op write when the binding is
// unchanged, which is every call but the first of a session: the `where`
// keeps ON CONFLICT from writing a new row version per pull.
export async function bindSession(tx: Queryable, caller: Caller, deviceId: string): Promise<void> {
	if (caller.sessionId === null) return;
	await tx.query(
		`insert into curator.device_session (session_id, device_id) values ($1, $2)
		on conflict (user_id, session_id) do update set device_id = excluded.device_id, bound_at = now()
		where curator.device_session.device_id <> excluded.device_id`,
		[caller.sessionId, deviceId],
	);
}

// How stale `last_seen_at` may get before a write moves it. The device list
// shows it as "last seen 3 min ago"; minutes are all it needs, and writing
// it on every push and batch call was a new row version of curator.device
// each time (with ~240 batchPush calls in one backlog).
const LAST_SEEN_EVERY = `interval '5 minutes'`;

// A push or batch call's device: whether it is registered (undefined if
// not) and revoked, from the same statement that touches its `last_seen_at`
// when that is stale. The read is a plain one, as every read gate's is; the
// touch, when it runs, waits on a concurrent revoke like any update.
export async function touchDevice(tx: Queryable, deviceId: string): Promise<{ revoked: boolean } | undefined> {
	// A data-modifying CTE runs whether or not the outer select reads it.
	const [row] = await tx.query<{ revoked: boolean }>(
		`with d as (
			select revoked_at is not null as revoked from curator.device
			where user_id = (select auth.uid()) and device_id = $1
		), touched as (
			update curator.device set last_seen_at = now()
			where user_id = (select auth.uid()) and device_id = $1
				and (last_seen_at is null or last_seen_at < now() - ${LAST_SEEN_EVERY})
			returning 1
		)
		select revoked from d`,
		[deviceId],
	);
	return row;
}

// A read or a catalogue call that names its device: the session first (so
// a revoked session cannot probe which device ids exist), then the device,
// then the binding.
export async function gateDevice(tx: Queryable, caller: Caller, deviceId: string): Promise<void> {
	const g = await readGate(tx, caller, deviceId);
	if (g.session_revoked) throw new DeviceRevokedError('session');
	if (g.device_revoked === null) throw new CloudError('PRECONDITION_FAILED', 'device_not_registered');
	if (g.device_revoked) throw new DeviceRevokedError('device');
	await bindSession(tx, caller, deviceId);
}
