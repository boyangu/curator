// The cloud's word on how its clients schedule themselves ('cloud_config'):
// one value for every account, set by the operator in the back office and
// carried down to the desktops on the answer they already ask for every
// tick (catalog.workerDue), only when it changed (`version`). A client keeps
// the last it was told; one that was never told, or a server too old to say,
// runs on CLOUD_CONFIG_DEFAULTS.

import { z } from 'zod';
import { CATALOG_READ_CADENCES, CATALOG_TRACKING_KINDS, type CatalogReadCadence, type CatalogTrackingKind } from './catalog-service.js';

export type CloudConfig = {
	// How often a desktop asks the cloud for its due work (catalog.workerDue).
	workerTickSec: number;
	// How often each kind of follow is read, for everyone: 'source' (as often
	// as the source allows), 'daily', or 'weekly' (the Friday window).
	readCadence: Record<CatalogTrackingKind, CatalogReadCadence>;
};

export const CLOUD_CONFIG_DEFAULTS: CloudConfig = {
	workerTickSec: 60,
	readCadence: Object.fromEntries(CATALOG_TRACKING_KINDS.map((k) => [k, 'weekly'])) as Record<CatalogTrackingKind, CatalogReadCadence>,
};

// The bounds the cloud holds a tick to, whatever the back office was given.
export const WORKER_TICK_SEC_MIN = 15;
export const WORKER_TICK_SEC_MAX = 900;

// `version`: when the values last changed (epoch ms); a client sends back
// the one it holds and is answered values only when they moved since.
export type CloudConfigEnvelope = { version: number; values: CloudConfig };

export const ZCloudConfig: z.ZodType<CloudConfig> = z
	.object({
		workerTickSec: z.number().int().min(WORKER_TICK_SEC_MIN).max(WORKER_TICK_SEC_MAX),
		// Every kind named: a copy missing one is not read as half the cloud's word.
		readCadence: z.record(z.enum(CATALOG_TRACKING_KINDS), z.enum(CATALOG_READ_CADENCES)).refine((r) => CATALOG_TRACKING_KINDS.every((k) => k in r), { message: 'a cadence for every kind' }),
	})
	.strict() as unknown as z.ZodType<CloudConfig>;

export const ZCloudConfigEnvelope = z.object({ version: z.number().nonnegative(), values: ZCloudConfig }).strict();

// What a client holds, read defensively: anything it cannot read is the
// defaults (a stored copy from an older shape, a hand-edited row).
export function cloudConfigOr(v: unknown): CloudConfigEnvelope {
	const r = ZCloudConfigEnvelope.safeParse(v);
	return r.success ? (r.data as CloudConfigEnvelope) : { version: 0, values: CLOUD_CONFIG_DEFAULTS };
}
