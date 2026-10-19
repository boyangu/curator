import { MIN_SUPPORTED_SCHEMA_VERSION, SCHEMA_VERSION } from '@curator/protocol';
import { SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKeys, createTestApp, errorReason, ISSUER, SUPABASE_URL, type TestApp } from '../test/harness.js';
import { AuthError, createTokenVerifier, jwksUrl } from './jwt.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

const rejectedWith = async (token: string | undefined) => (await errorReason(app.client(token).account.devices.query())).reason;

describe('token verification', () => {
	it('accepts a valid token and takes the user from `sub`', async () => {
		const userId = await app.createUser();
		const token = await app.sign(userId, { sessionId: 's1' });
		const verifier = createTokenVerifier({ supabaseUrl: SUPABASE_URL, keys: app.keys });
		await expect(verifier.verify(`Bearer ${token}`)).resolves.toEqual({ id: userId, sessionId: 's1' });
		await expect(app.client(token).account.devices.query()).resolves.toEqual([]);
	});

	it('rejects a missing or malformed Authorization header', async () => {
		expect(await rejectedWith(undefined)).toBe('missing_token');
		const verifier = createTokenVerifier({ supabaseUrl: SUPABASE_URL, keys: app.keys });
		await expect(verifier.verify('Basic abc')).rejects.toEqual(new AuthError('missing_token'));
		await expect(verifier.verify('Bearer')).rejects.toEqual(new AuthError('missing_token'));
	});

	it('rejects an expired token as token_expired so the client refreshes', async () => {
		const token = await app.sign(await app.createUser(), { exp: Math.floor(Date.now() / 1000) - 3600 });
		expect(await errorReason(app.client(token).account.devices.query())).toMatchObject({ code: 'UNAUTHORIZED', reason: 'token_expired' });
	});

	it('rejects the wrong audience (e.g. an anon key)', async () => {
		expect(await rejectedWith(await app.sign(await app.createUser(), { aud: 'anon' }))).toBe('invalid_token');
	});

	it('rejects the wrong issuer (another Supabase project)', async () => {
		expect(await rejectedWith(await app.sign(await app.createUser(), { iss: 'https://other.supabase.co/auth/v1' }))).toBe('invalid_token');
	});

	it('rejects a token signed by a key that is not in the JWKS', async () => {
		const stranger = await createKeys('test-key');
		expect(await rejectedWith(await stranger.sign(await app.createUser()))).toBe('invalid_token');
	});

	it('rejects unsigned and HMAC tokens outright', async () => {
		const sub = await app.createUser();
		const none = new UnsecuredJWT({ role: 'authenticated' }).setSubject(sub).setIssuer(ISSUER).setAudience('authenticated').setExpirationTime('1h').encode();
		expect(await rejectedWith(none)).toBe('invalid_token');
		const hs = await new SignJWT({ role: 'authenticated' })
			.setProtectedHeader({ alg: 'HS256', kid: 'test-key' })
			.setSubject(sub)
			.setIssuer(ISSUER)
			.setAudience('authenticated')
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode('a guessed shared secret of enough length'));
		expect(await rejectedWith(hs)).toBe('invalid_token');
	});

	it('rejects a token without a uuid `sub`', async () => {
		expect(await rejectedWith(await app.sign('ignored', { sub: null }))).toBe('invalid_token');
		expect(await rejectedWith(await app.sign('ignored', { sub: 'service' }))).toBe('invalid_token');
	});

	it('leaves health open and every other procedure closed', async () => {
		await expect(app.client().health.query()).resolves.toMatchObject({
			ok: true,
			schemaVersion: SCHEMA_VERSION,
			minSupportedSchemaVersion: MIN_SUPPORTED_SCHEMA_VERSION,
			commit: expect.any(String),
		});
		const anon = app.client();
		for (const call of [
			anon.sync.push.mutate({ deviceId: 'd', ops: [] }),
			anon.sync.pull.query({ afterSeq: 0 }),
			anon.sync.bootstrap.query(),
			anon.account.registerDevice.mutate({ deviceId: 'd', name: 'n', platform: 'linux' }),
			anon.account.revokeDevice.mutate({ deviceId: 'd' }),
		]) {
			expect(await errorReason(call)).toMatchObject({ code: 'UNAUTHORIZED', reason: 'missing_token' });
		}
	});

	it('derives the JWKS URL from the project URL', () => {
		expect(jwksUrl(SUPABASE_URL).href).toBe(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
	});
});
