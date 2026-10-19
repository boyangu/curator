// Wire types this server answers with beyond `@curator/protocol`'s
// `CloudService`: only the health probe, which is the server's own concern.

import type { BootstrapResult, DeviceInfo, PullResult, PushResult } from '@curator/protocol';

export type HealthResult = {
	ok: true;
	schemaVersion: number;
	minSupportedSchemaVersion: number;
	// The git commit the running image was built from, or 'unknown' for a
	// build outside the deploy workflow (local `docker build`, `pnpm dev`).
	commit: string;
};

export type { BootstrapResult, DeviceInfo, PullResult, PushResult };
