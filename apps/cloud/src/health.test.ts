import { MIN_SUPPORTED_SCHEMA_VERSION, SCHEMA_VERSION, SYNC_FEATURES } from '@curator/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CATALOGUE_POLICY_D_A, CATALOGUE_POLICY_D_B, parseCataloguePolicy } from './catalogue/policy.js';
import { createTestApp, type TestApp } from './test/harness.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());
afterEach(() => {
	vi.unstubAllEnvs();
});

describe('health', () => {
	it('reports the commit the image was built from', async () => {
		// What the deploy workflow polls for (Dockerfile ARG GIT_SHA).
		vi.stubEnv('GIT_SHA', '0123456789abcdef0123456789abcdef01234567');
		await expect(app.client().health.query()).resolves.toEqual({
			ok: true,
			schemaVersion: SCHEMA_VERSION,
			minSupportedSchemaVersion: MIN_SUPPORTED_SCHEMA_VERSION,
			features: [...SYNC_FEATURES],
			// The harness runs stage D-a, as production does.
			catalogue: { policy: parseCataloguePolicy(CATALOGUE_POLICY_D_A) },
			commit: '0123456789abcdef0123456789abcdef01234567',
		});
	});

	// The exact path and JSON shape the deploy workflow's poll reads with
	// `jq .result.data.commit`; a change here has to change the workflow.
	it('answers a plain GET /trpc/health with the commit at result.data.commit', async () => {
		vi.stubEnv('GIT_SHA', 'feedface');
		const res = await app.handler(new Request('http://cloud.test/trpc/health'));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ result: { data: { ok: true, commit: 'feedface' } } });
	});

	it('says unknown when the image was built without one', async () => {
		vi.stubEnv('GIT_SHA', undefined);
		expect((await app.client().health.query()).commit).toBe('unknown');
		// `docker build` without --build-arg leaves the ENV empty, not unset.
		vi.stubEnv('GIT_SHA', '');
		expect((await app.client().health.query()).commit).toBe('unknown');
	});
});

describe('health with the catalogue switched', () => {
	it('advertises the D-a policy: inline units and lo peaks only', async () => {
		const { catalogue, features } = await app.client().health.query();
		expect(features).toContain('catalogue');
		expect(catalogue).toEqual({
			policy: {
				allow: [
					{ unit: 'rhythm', variants: null },
					{ unit: 'key', variants: null },
					{ unit: 'structure', variants: null },
					{ unit: 'advanced', variants: null },
					{ unit: 'fingerprint', variants: null },
					{ unit: 'peaks', variants: ['lo'] },
				],
			},
		});
	});

	it('advertises D-b after a config change alone', async () => {
		const b = await createTestApp({ catalogue: parseCataloguePolicy(CATALOGUE_POLICY_D_B) });
		try {
			const { catalogue } = await b.client().health.query();
			expect(catalogue?.policy.allow).toEqual(
				expect.arrayContaining([
					{ unit: 'peaks', variants: ['hi', 'lo'] },
					{ unit: 'vectors', variants: null },
				]),
			);
		} finally {
			await b.db.close();
		}
	});

	it('leaves the catalogue out everywhere when it is off', async () => {
		const off = await createTestApp({ catalogue: null });
		try {
			const h = await off.client().health.query();
			expect(h.features).toEqual(SYNC_FEATURES.filter((f) => f !== 'catalogue'));
			expect(h.catalogue).toBeUndefined();
			// Push and pull answer with the same list, so a client never sees
			// the probe and a sync result disagree.
			const { api, deviceId } = await off.signIn();
			expect((await api.sync.push.mutate({ deviceId, ops: [] })).features).toEqual(['pull_skip_own', 'device_reads', 'track_meta', 'zero_loss_v4', 'batches', 'snapshot_storage']);
			expect((await api.sync.pull.query({ afterSeq: 0 })).features).toEqual(['pull_skip_own', 'device_reads', 'track_meta', 'zero_loss_v4', 'batches', 'snapshot_storage']);
		} finally {
			await off.db.close();
		}
	});
});
