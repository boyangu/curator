import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultRateLimits, TokenBucketLimiter } from './rate-limit.js';
import { createTestApp, errorReason, type TestApp } from './test/harness.js';

describe('TokenBucketLimiter', () => {
	it('allows a burst up to capacity, then refills at the configured rate', () => {
		let now = 0;
		const l = new TokenBucketLimiter(10, 10, () => now);
		for (let i = 0; i < 10; i++) expect(l.take('d')).toEqual({ ok: true });
		expect(l.take('d')).toEqual({ ok: false, retryAfterSec: 1 });
		now += 100; // one token back
		expect(l.take('d')).toEqual({ ok: true });
		expect(l.take('d').ok).toBe(false);
		now += 10_000; // refills to capacity, not past it
		for (let i = 0; i < 10; i++) expect(l.take('d').ok).toBe(true);
		expect(l.take('d').ok).toBe(false);
	});

	it('keeps one bucket per key', () => {
		const l = new TokenBucketLimiter(1, 1, () => 0);
		expect(l.take('a').ok).toBe(true);
		expect(l.take('a').ok).toBe(false);
		expect(l.take('b').ok).toBe(true);
	});

	it('tells a pull-limited client how long to wait', () => {
		let now = 0;
		const { pull } = defaultRateLimits(() => now);
		for (let i = 0; i < 100; i++) expect(pull.take('d').ok).toBe(true);
		// 100/min refills one token every 0.6 s.
		expect(pull.take('d')).toEqual({ ok: false, retryAfterSec: 1 });
		now += 600;
		expect(pull.take('d').ok).toBe(true);
	});

	it('evicts idle buckets instead of growing without bound', () => {
		let now = 0;
		const l = new TokenBucketLimiter(2, 1, () => now, 3);
		for (const k of ['a', 'b', 'c']) l.take(k);
		now += 5000; // all full again
		l.take('d');
		expect(l.size).toBe(1);
	});
});

describe('rate limits over the API', () => {
	let app: TestApp;
	let now = Date.now();
	beforeAll(async () => {
		app = await createTestApp({ limits: defaultRateLimits(() => now) });
	});
	afterAll(() => app.db.close());

	it('answers the 11th push in a second with TOO_MANY_REQUESTS and a retry-after, per device', async () => {
		const { userId, deviceId, api } = await app.signIn();
		for (let i = 0; i < 10; i++) await api.sync.push.mutate({ deviceId, ops: [] });
		expect(await errorReason(api.sync.push.mutate({ deviceId, ops: [] }))).toEqual({ code: 'TOO_MANY_REQUESTS', reason: 'rate_limited', retryAfterSec: 1 });

		// The standard header too, for anything that is not our client.
		const res = await app.handler(
			new Request('http://cloud.test/trpc/sync.push', {
				method: 'POST',
				headers: { authorization: `Bearer ${await app.sign(userId)}`, 'content-type': 'application/json' },
				body: JSON.stringify({ deviceId, ops: [] }),
			}),
		);
		expect(res.status).toBe(429);
		expect(res.headers.get('retry-after')).toBe('1');

		// A second device of the same user has its own bucket.
		await api.account.registerDevice.mutate({ deviceId: 'laptop', name: 'Laptop', platform: 'darwin' });
		await expect(api.sync.push.mutate({ deviceId: 'laptop', ops: [] })).resolves.toMatchObject({ accepted: 0 });

		now += 1000;
		await expect(api.sync.push.mutate({ deviceId, ops: [] })).resolves.toMatchObject({ accepted: 0 });
	});

	it('answers the 101st pull in a minute with TOO_MANY_REQUESTS', async () => {
		const { api } = await app.signIn();
		for (let i = 0; i < 100; i++) await api.sync.pull.query({ afterSeq: 0 });
		expect(await errorReason(api.sync.pull.query({ afterSeq: 0 }))).toMatchObject({ code: 'TOO_MANY_REQUESTS', reason: 'rate_limited' });
		now += 60_000;
		await expect(api.sync.pull.query({ afterSeq: 0 })).resolves.toMatchObject({ ops: [] });
	});
});
