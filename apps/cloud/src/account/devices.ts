// account.registerDevice / devices / revokeDevice (design: "Devices"). A
// device registers on first sync and is listed with its last push; revoking
// one makes every later call from it come back `device_revoked`: pushes,
// pulls, bootstraps, catalogue calls and these account calls, whether it
// names itself or not, since its Supabase session is bound to it
// (device-gate.ts). Revoking that session's refresh token is the other half
// and needs the admin API, which this server deliberately has no key for:
// the desktop's account panel does it with the user's own session ("Sign
// out all other sessions", Supabase signOut scope 'others').

import type { DeviceInfo, DevicePlatform, RegisterDeviceInput } from '@curator/protocol';
import { numOrNull, num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import { assertSessionNotRevoked, bindSession, DeviceRevokedError, type Caller } from './device-gate.js';

export const DEVICE_PLATFORMS = ['win32', 'darwin', 'linux', 'ios', 'android'] as const satisfies readonly DevicePlatform[];

// `created` (false for a re-register) is for the audit event only; the wire
// answer stays `{ ok: true }` (router.ts).
export async function registerDevice(db: Db, userId: string, input: RegisterDeviceInput, caller: Caller): Promise<{ ok: true; created: boolean }> {
	return withUserTx(db, userId, async (tx) => {
		// A session that acted as a revoked device cannot mint itself a fresh
		// identity: coming back takes a new sign-in.
		await assertSessionNotRevoked(tx, caller);
		// Re-registering refreshes the name and platform (a renamed machine, an
		// OS reinstall) but never clears `revoked_at`: revocation is final for
		// that device id, the install mints a new one to come back.
		// `xmax = 0` is Postgres' tell for "this row was inserted, not updated".
		const [row] = await tx.query<{ revoked: boolean; created: boolean }>(
			`insert into curator.device (device_id, name, platform, last_seen_at)
			values ($1, $2, $3, now())
			on conflict (user_id, device_id) do update
				set name = excluded.name, platform = excluded.platform, last_seen_at = now()
			returning revoked_at is not null as revoked, (xmax = 0) as created`,
			[input.deviceId, input.name, input.platform],
		);
		if (row?.revoked) throw new DeviceRevokedError('device');
		await bindSession(tx, caller, input.deviceId);
		return { ok: true as const, created: row?.created === true };
	});
}

export async function listDevices(db: Db, userId: string, caller: Caller): Promise<DeviceInfo[]> {
	return withUserTx(db, userId, async (tx) => {
		await assertSessionNotRevoked(tx, caller);
		const rows = await tx.query<{
			device_id: string;
			name: string;
			platform: DevicePlatform;
			created_at: unknown;
			last_seen_at: unknown;
			revoked_at: unknown;
		}>(
			`select device_id, name, platform,
				floor(extract(epoch from created_at) * 1000)::float8 as created_at,
				floor(extract(epoch from last_seen_at) * 1000)::float8 as last_seen_at,
				floor(extract(epoch from revoked_at) * 1000)::float8 as revoked_at
			from curator.device
			where user_id = (select auth.uid())
			order by created_at, device_id`,
		);
		return rows.map((r) => ({
			deviceId: r.device_id,
			name: r.name,
			platform: r.platform,
			registeredAt: num(r.created_at),
			lastSeenAt: numOrNull(r.last_seen_at),
			revokedAt: numOrNull(r.revoked_at),
		}));
	});
}

// A device may revoke itself (the desktop's "Unlink" does, so the account's
// list stops showing it as live); its session is refused from then on. A
// revoked session may revoke nothing: a stolen laptop must not be able to
// lock its owner's other devices out.
export async function revokeDevice(db: Db, userId: string, deviceId: string, caller: Caller): Promise<{ ok: true }> {
	return withUserTx(db, userId, async (tx) => {
		await assertSessionNotRevoked(tx, caller);
		// Idempotent: revoking an already-revoked device keeps the first stamp.
		const rows = await tx.query(
			`update curator.device set revoked_at = coalesce(revoked_at, now())
			where user_id = (select auth.uid()) and device_id = $1
			returning device_id`,
			[deviceId],
		);
		if (rows.length === 0) throw new CloudError('NOT_FOUND', 'device_not_found');
		return { ok: true as const };
	});
}
