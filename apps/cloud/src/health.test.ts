import { MIN_SUPPORTED_SCHEMA_VERSION, SCHEMA_VERSION } from '@curator/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
