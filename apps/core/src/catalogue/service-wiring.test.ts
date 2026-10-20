// End-to-end wiring of the catalogue inside createCoreService: the sync
// client learns the server's features from its first push/pull, and that alone
// must start the catalogue (an inventory call), with no setting or button.
// The layer's own tests inject serverFeatures directly, so they cannot see a
// break in this hand-off; this is the test that does.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SYNC_FEATURES, type PullInput, type PushInput } from '@curator/protocol';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import type { CloudTransport } from '../sync-log/client.js';
import { FakeBlobStore, FakeCatalogueServer, FakeDevice, waitFor } from '../test-support/catalogue-fakes.js';

let dir: string;
let svc: CoreService | null = null;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-cat-wiring-')); });
afterEach(() => {
	svc?.close();
	svc = null;
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function cloud(userId: string, catServer: FakeCatalogueServer, offered = { catalogue: true }): { transport: CloudTransport; device: FakeDevice } {
	const device = new FakeDevice(catServer, userId);
	const feats = () => SYNC_FEATURES.filter((f) => f !== 'catalogue' || offered.catalogue);
	const transport: CloudTransport = {
		session: () => ({ userId, email: `${userId}@example.test` }),
		sync: {
			push: async (input: PushInput) => ({ accepted: input.ops.length, maxSeq: 0, rejected: [], features: feats() }),
			pull: async (input: PullInput) => ({ ops: [], nextSeq: input.afterSeq, features: feats() }),
		},
		bootstrap: async () => ({ snapshotSeq: 0, records: [] }),
		account: {
			registerDevice: async () => ({ ok: true as const }),
			devices: async () => [],
			revokeDevice: async () => ({ ok: true as const }),
		},
		catalogue: device.transport().catalogue,
	} as unknown as CloudTransport;
	return { transport, device };
}

describe('catalogue wiring in createCoreService', () => {
	it('starts the catalogue once the server advertises it', async () => {
		const path = join(dir, 'curator.db');
		migrate(path);
		const catServer = new FakeCatalogueServer();
		const { transport, device } = cloud('user-1', catServer);
		svc = createCoreService(path, {
			peaksDir: join(dir, 'peaks'),
			cloud: { transport, device: { name: 'test', platform: 'win32' }, blobs: new FakeBlobStore(catServer, device) },
		});
		svc.startCloudSync();
		await waitFor(() => catServer.calls.inventory > 0, 'the first catalogue inventory call', 15_000);
		expect(catServer.calls.inventory).toBeGreaterThan(0);
	}, 20_000);

	// Regression: the real app started while cloud-v0.1.2 (no catalogue) was
	// being replaced by v0.2.0. Its first pass ended before any await and left
	// the layer's single-flight marker set, so the later 'features' wake never
	// ran a pass (layer.ts syncNow).
	it('starts the catalogue when the server begins offering it mid-session', async () => {
		const path = join(dir, 'curator.db');
		migrate(path);
		const catServer = new FakeCatalogueServer();
		const offered = { catalogue: false };
		const { transport, device } = cloud('user-1', catServer, offered);
		svc = createCoreService(path, {
			peaksDir: join(dir, 'peaks'),
			cloud: { transport, device: { name: 'test', platform: 'win32' }, blobs: new FakeBlobStore(catServer, device) },
		});
		svc.startCloudSync();
		await new Promise((r) => setTimeout(r, 1500));
		expect(catServer.calls.inventory).toBe(0);
		offered.catalogue = true;
		await svc.cloudSyncNow();
		await waitFor(() => catServer.calls.inventory > 0, 'the first catalogue inventory call after the feature appears', 15_000);
	}, 25_000);
});
