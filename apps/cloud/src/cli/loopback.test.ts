// The loopback servers' gate (loopback.ts): this machine's pages only, and
// — for the desktop app's Cloud Admin tab — only requests carrying its token.

import { describe, expect, it } from 'vitest';
import { carriesAdminToken, fromThisMachinesPages } from './loopback.js';

describe('the loopback gate', () => {
	it("answers this machine's pages, by the name they used, and JSON writes only", () => {
		expect(fromThisMachinesPages({ method: 'GET', host: '127.0.0.1:8790', contentType: null }, 8790)).toBe(true);
		expect(fromThisMachinesPages({ method: 'POST', host: 'localhost:8790', contentType: 'application/json' }, 8790)).toBe(true);
		// A rebound name, another port, a form post: no.
		expect(fromThisMachinesPages({ method: 'GET', host: 'evil.test:8790', contentType: null }, 8790)).toBe(false);
		expect(fromThisMachinesPages({ method: 'GET', host: '127.0.0.1:9999', contentType: null }, 8790)).toBe(false);
		expect(fromThisMachinesPages({ method: 'POST', host: '127.0.0.1:8790', contentType: 'text/plain' }, 8790)).toBe(false);
	});

	it("takes, with a token set, only a request that carries it exactly — reads too", () => {
		const token = 'a'.repeat(64);
		expect(carriesAdminToken(token, token)).toBe(true);
		expect(carriesAdminToken([token], token)).toBe(true);
		expect(carriesAdminToken(undefined, token)).toBe(false);
		expect(carriesAdminToken('', token)).toBe(false);
		expect(carriesAdminToken('a'.repeat(63), token)).toBe(false);
		expect(carriesAdminToken(`${'a'.repeat(63)}b`, token)).toBe(false);
	});

	it('is open as before when no token is set (run by hand in a browser)', () => {
		expect(carriesAdminToken(undefined, undefined)).toBe(true);
		expect(carriesAdminToken('anything', undefined)).toBe(true);
	});
});
