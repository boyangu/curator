// Wire types this server answers with beyond `@curator/protocol`'s
// `CloudService`: only the health probe, which is the server's own concern.

import type { BootstrapResult, CataloguePolicy, DeviceInfo, PullResult, PushResult, SyncFeature } from '@curator/protocol';

export type HealthResult = {
	ok: true;
	schemaVersion: number;
	minSupportedSchemaVersion: number;
	// The optional sync behaviours this server offers (protocol
	// `SYNC_FEATURES`); the same list rides on every push and pull result.
	features: SyncFeature[];
	// Present with 'catalogue' in `features`: which units and blob variants
	// the server accepts (the D-a / D-b stage). The same policy rides on
	// every catalogue.inventory page, which is where the desktop reads it.
	catalogue?: { policy: CataloguePolicy };
	// The git commit the running image was built from, or 'unknown' for a
	// build outside the deploy workflow (local `docker build`, `pnpm dev`).
	commit: string;
};

export type { BootstrapResult, DeviceInfo, PullResult, PushResult };
