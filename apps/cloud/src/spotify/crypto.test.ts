import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../config.js';
import { parseTokenKey, TokenCrypto, TokenKeyError, TokenOpenError } from './crypto.js';

const key = () => parseTokenKey('K', randomBytes(32).toString('base64'));
const USER = '7a1c1b9e-1111-4aaa-8bbb-000000000001';
const OTHER = '7a1c1b9e-1111-4aaa-8bbb-000000000002';

describe('token sealing', () => {
	it('round-trips, with a fresh IV each time', () => {
		const k = key();
		const c = new TokenCrypto({ current: k, previous: null });
		const a = c.seal(USER, 'refresh', 'rt-secret');
		const b = c.seal(USER, 'refresh', 'rt-secret');
		expect(a.equals(b)).toBe(false);
		expect(a.includes(Buffer.from('rt-secret'))).toBe(false);
		expect(c.open(USER, 'refresh', k.id, a)).toBe('rt-secret');
	});

	it('binds a value to its user and its field', () => {
		const k = key();
		const c = new TokenCrypto({ current: k, previous: null });
		const sealed = c.seal(USER, 'refresh', 'rt-secret');
		expect(() => c.open(OTHER, 'refresh', k.id, sealed)).toThrow(TokenOpenError);
		expect(() => c.open(USER, 'access', k.id, sealed)).toThrow(TokenOpenError);
		const flipped = Buffer.from(sealed);
		flipped[20]! ^= 1;
		expect(() => c.open(USER, 'refresh', k.id, flipped)).toThrow(TokenOpenError);
	});

	it('opens with the previous key, seals with the current, and refuses an unknown key id', () => {
		const old = key();
		const cur = key();
		const sealed = new TokenCrypto({ current: old, previous: null }).seal(USER, 'access', 'at');
		const rotated = new TokenCrypto({ current: cur, previous: old });
		expect(rotated.keyId).toBe(cur.id);
		expect(rotated.open(USER, 'access', old.id, sealed)).toBe('at');
		expect(rotated.open(USER, 'access', cur.id, rotated.seal(USER, 'access', 'at2'))).toBe('at2');
		expect(() => new TokenCrypto({ current: cur, previous: null }).open(USER, 'access', old.id, sealed)).toThrow(TokenOpenError);
	});

	it('takes 32 bytes of base64 and never echoes the value', () => {
		const short = randomBytes(16).toString('base64');
		expect(() => parseTokenKey('CURATOR_TOKEN_KEY', short)).toThrow(TokenKeyError);
		try {
			parseTokenKey('CURATOR_TOKEN_KEY', short);
		} catch (e) {
			expect((e as Error).message).toContain('CURATOR_TOKEN_KEY');
			expect((e as Error).message).not.toContain(short);
		}
		expect(() => parseTokenKey('K', 'not base64 at all!')).toThrow(TokenKeyError);
		const raw = randomBytes(32);
		expect(parseTokenKey('K', raw.toString('base64url')).key.equals(raw)).toBe(true);
		// The id is a fingerprint: the same key, the same id.
		expect(parseTokenKey('K', raw.toString('base64')).id).toBe(parseTokenKey('K', raw.toString('base64url')).id);
	});
});

describe('gateway config', () => {
	const base = { DATABASE_URL: 'postgres://curator_api:pw@localhost:5432/postgres', SUPABASE_URL: 'https://x.supabase.co' };
	const clientId = '0123456789abcdef0123456789abcdef';
	const k = randomBytes(32).toString('base64');

	it('is off, naming what is missing, without both values', () => {
		expect(loadConfig(base)).toMatchObject({ spotify: null, spotifyMissing: ['CURATOR_SPOTIFY_CLIENT_ID', 'CURATOR_TOKEN_KEY'] });
		expect(loadConfig({ ...base, CURATOR_SPOTIFY_CLIENT_ID: clientId })).toMatchObject({ spotify: null, spotifyMissing: ['CURATOR_TOKEN_KEY'] });
		expect(loadConfig({ ...base, CURATOR_TOKEN_KEY: k })).toMatchObject({ spotify: null, spotifyMissing: ['CURATOR_SPOTIFY_CLIENT_ID'] });
	});

	it('is on with both, and carries a distinct previous key', () => {
		const prev = randomBytes(32).toString('base64');
		const c = loadConfig({ ...base, CURATOR_SPOTIFY_CLIENT_ID: clientId, CURATOR_TOKEN_KEY: k, CURATOR_TOKEN_KEY_PREV: prev });
		expect(c.spotify?.clientId).toBe(clientId);
		expect(c.spotify?.keys.current.id).toBe(parseTokenKey('K', k).id);
		expect(c.spotify?.keys.previous?.id).toBe(parseTokenKey('K', prev).id);
		expect(loadConfig({ ...base, CURATOR_SPOTIFY_CLIENT_ID: clientId, CURATOR_TOKEN_KEY: k, CURATOR_TOKEN_KEY_PREV: k }).spotify?.keys.previous).toBeNull();
	});

	it('fails the boot on a malformed value rather than switching off', () => {
		const bad = 'c2hvcnQ=';
		expect(() => loadConfig({ ...base, CURATOR_SPOTIFY_CLIENT_ID: clientId, CURATOR_TOKEN_KEY: bad })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, CURATOR_SPOTIFY_CLIENT_ID: 'nope', CURATOR_TOKEN_KEY: k })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, CURATOR_SPOTIFY_CLIENT_ID: clientId, CURATOR_TOKEN_KEY_PREV: k })).toThrow(/without CURATOR_TOKEN_KEY/);
	});
});
