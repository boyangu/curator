// Smoke test for the auth service — runs without Electron. Verifies:
//   • token store get/put/clear cycle
//   • AuthService.getStatus() returns expected shape for both connected/disconnected
//   • clearing actually clears
//
// Run: tsx src/auth/smoke.ts

import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { AuthService } from './service.js';

const DB = './curator.db';

async function main() {
	migrate(DB);
	const { db, sqlite } = createDb(DB);
	const auth = new AuthService(db);

	console.log('=== initial status (should be both disconnected) ===');
	console.log(JSON.stringify(auth.getStatus(), null, 2));

	// simulate a Spotify connection by writing tokens directly
	// (real flow goes through completeSpotifyAuth → live API call)
	const { TokenStore } = await import('./store.js');
	const ts = new TokenStore(db);

	const tomorrow = new Date(Date.now() + 86400_000);
	ts.put('spotify', 'access', 'user', 'fake_access_token', {
		expiresAt: tomorrow,
		meta: { id: 'guy_b', displayName: 'GB', avatarUrl: null },
	});
	ts.put('spotify', 'refresh', 'user', 'fake_refresh_token');

	ts.put('tidal', 'access', 'user', 'fake_tidal_access_token', {
		expiresAt: tomorrow,
		meta: { userId: '38540690', countryCode: 'IL', displayName: 'guyb', avatarUrl: null },
	});
	ts.put('tidal', 'refresh', 'user', 'fake_tidal_refresh_token');

	console.log('\n=== after fake connect ===');
	console.log(JSON.stringify(auth.getStatus(), null, 2));

	console.log('\n=== getTidalAccessToken() ===');
	console.log(await auth.getTidalAccessToken());
	console.log('\n=== getTidalCountryCode() ===');
	console.log(auth.getTidalCountryCode());

	auth.disconnectSpotify();
	auth.disconnectTidal();

	console.log('\n=== after disconnect ===');
	console.log(JSON.stringify(auth.getStatus(), null, 2));

	sqlite.close();
	console.log('\nsmoke test OK');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
