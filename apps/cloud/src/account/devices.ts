// account.registerDevice / devices / revokeDevice (design: "Devices"). A
// device registers on first sync and is listed with its last push; revoking
// one makes every later push from it come back `device_revoked`. Revoking
// its Supabase refresh token is the other half and needs the admin API,
// which this server deliberately has no key for: the desktop's account
// panel does it with the user's own session (workstream C desktop).

import type { DeviceInfo, DevicePlatform, RegisterDeviceInput } from '@curator/protocol';
import { numOrNull, num, type Db } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';

export const DEVICE_PLATFORMS = ['win32', 'darwin', 'linux', 'ios', 'android'] as const satisfies readonly DevicePlatform[];

// `created` (false for a re-register) is for the audit event only; the wire
// answer stays `{ ok: true }` (router.ts).
export async function registerDevice(db: Db, userId: string, input: RegisterDeviceInput): Promise<{ ok: true; created: boolean }> {
	return withUserTx(db, userId, async (tx) => {
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
		if (row?.revoked) throw new CloudError('FORBIDDEN', 'device_revoked');
		return { ok: true as const, created: row?.created === true };
	});
}

export async function listDevices(db: Db, userId: string): Promise<DeviceInfo[]> {
	return withUserTx(db, userId, async (tx) => {
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

export async function revokeDevice(db: Db, userId: string, deviceId: string): Promise<{ ok: true }> {
	return withUserTx(db, userId, async (tx) => {
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
