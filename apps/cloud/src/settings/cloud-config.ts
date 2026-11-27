// The client half of the operator's settings (registry.ts `client` keys), as
// the desktops are told them (protocol cloud-config.ts): one small read by
// key, on every catalog.workerDue. Its version is when any of them last
// changed: a reset writes the default rather than deleting the row, so the
// version only ever moves forward and every desktop hears of it.

import { CATALOG_TRACKING_KINDS, CLOUD_CONFIG_DEFAULTS, type CatalogReadCadence, type CloudConfig, type CloudConfigEnvelope } from '@curator/protocol';
import { num, type Queryable } from '../db/db.js';
import { checkSetting, SETTINGS } from './registry.js';

const CLIENT_KEYS = SETTINGS.filter((s) => s.client).map((s) => s.key);

export async function loadCloudConfig(q: Queryable): Promise<CloudConfigEnvelope> {
	const rows = await q.query<{ key: string; value: string; at: unknown }>(
		`select key, value::text as value, extract(epoch from updated_at) * 1000 as at from curator.catalog_setting where scope = '*' and key = any($1::text[])`,
		[`{${CLIENT_KEYS.join(',')}}`],
	);
	const values: CloudConfig = { ...CLOUD_CONFIG_DEFAULTS, readCadence: { ...CLOUD_CONFIG_DEFAULTS.readCadence } };
	let version = 0;
	for (const r of rows) {
		version = Math.max(version, Math.floor(num(r.at)));
		const entry = SETTINGS.find((s) => s.key === r.key)!;
		// A row the registry would refuse (written by hand, or under older
		// bounds) is not the cloud's word: the default stands.
		const checked = checkSetting(entry, JSON.parse(r.value) as unknown);
		if (!checked.ok) continue;
		if (r.key === 'worker.tick_sec') values.workerTickSec = checked.value as number;
		for (const kind of CATALOG_TRACKING_KINDS) if (r.key === `read.cadence.${kind}`) values.readCadence[kind] = checked.value as CatalogReadCadence;
	}
	return { version, values };
}
