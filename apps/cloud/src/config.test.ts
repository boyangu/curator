// Which Tidal app the catalogue's upkeep reads with (config.ts).

import { describe, expect, it } from 'vitest';
import { ConfigError, tidalCredentials } from './config.js';

describe('tidalCredentials', () => {
	const desktop = { CURATOR_TIDAL_CLIENT_ID: 'desk', CURATOR_TIDAL_CLIENT_SECRET: 'desk-secret' };
	const own = { CURATOR_TIDAL_APP_CLIENT_ID: 'office', CURATOR_TIDAL_APP_CLIENT_SECRET: 'office-secret' };

	it('is off with neither pair', () => {
		expect(tidalCredentials({})).toBeNull();
	});

	it("prefers the back office's own app", () => {
		expect(tidalCredentials({ ...desktop, ...own })).toEqual({ clientId: 'office', clientSecret: 'office-secret', borrowed: false });
	});

	it("borrows the desktop's pair until then, and says so", () => {
		expect(tidalCredentials(desktop)).toEqual({ clientId: 'desk', clientSecret: 'desk-secret', borrowed: true });
	});

	it('refuses half a pair instead of falling through to the other', () => {
		expect(() => tidalCredentials({ ...desktop, CURATOR_TIDAL_APP_CLIENT_ID: 'office' })).toThrow(ConfigError);
		expect(() => tidalCredentials({ CURATOR_TIDAL_CLIENT_SECRET: 'desk-secret' })).toThrow(/CURATOR_TIDAL_CLIENT_ID/);
	});
});
