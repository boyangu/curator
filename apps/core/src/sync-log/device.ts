// This install's device id (cloud design: "Identifiers"): the provenance on
// every op and the last-write-wins tie-break. One UUID per install, minted on
// first use and never rotated — a new id would make this device's past ops
// look like another device's.
//
// Takes the raw better-sqlite3 handle, not the drizzle Db: emitOps runs inside
// migrate() (the startup ISRC dedup emits recording merges) before any Db
// exists, and inside callers' raw transactions everywhere else.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export const DEVICE_ID_KEY = 'device.id';

type Raw = Database.Database;

export function getDeviceId(raw: Raw): string {
	const read = (): string | null => {
		const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(DEVICE_ID_KEY) as { value: string } | undefined;
		if (!row) return null;
		try {
			const v = JSON.parse(row.value) as unknown;
			return typeof v === 'string' && v ? v : null;
		} catch {
			return null;
		}
	};
	const existing = read();
	if (existing) return existing;
	// DO NOTHING, then re-read: two processes on one DB (desktop main and a
	// sidecar host) racing the first call must end with one id, not two.
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
		.run(DEVICE_ID_KEY, JSON.stringify(randomUUID()), Date.now());
	return read()!;
}
