// Offline smoke test for the Spotify sync engine. Mocks the Spotify HTTP
// boundary so we can exercise upsert + replace-tracks + idempotency logic
// without a live token.

import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { SpotifySync } from './spotify.js';
import { AuthService } from '../auth/service.js';
import { TokenStore } from '../auth/store.js';
import { eq, sql, count } from 'drizzle-orm';
import { track, sourceLink, playlist, playlistTrack } from '@curator/shared/schema';

const DB = './curator-sync-smoke.db';

// Mock Spotify endpoints — we monkeypatch global fetch to return fixed data.
const PLAYLIST_1 = {
	id: 'pl_alpha',
	name: 'Alpha Playlist',
	description: 'A test playlist',
	owner: { id: 'user_a', display_name: 'A' },
	images: [{ url: 'https://example.com/cover.jpg' }],
	tracks: { total: 2 },
	collaborative: false,
	public: true,
	snapshot_id: 'snap1',
	external_urls: { spotify: 'https://open.spotify.com/playlist/pl_alpha' },
};

const TRACK_X = {
	id: 'track_x',
	name: 'Test Song X',
	duration_ms: 210_000,
	explicit: false,
	external_ids: { isrc: 'AB1234567890' },
	external_urls: { spotify: 'https://open.spotify.com/track/track_x' },
	artists: [{ id: 'a1', name: 'Artist X' }],
	album: {
		id: 'alb_1',
		name: 'X Album',
		release_date: '2024-01-15',
		images: [{ url: 'https://example.com/x.jpg', width: 300, height: 300 }],
	},
};

const TRACK_Y = {
	id: 'track_y',
	name: 'Test Song Y',
	duration_ms: 180_000,
	explicit: true,
	external_ids: { isrc: 'CD9876543210' },
	external_urls: { spotify: 'https://open.spotify.com/track/track_y' },
	artists: [{ id: 'a2', name: 'Artist Y' }],
	album: {
		id: 'alb_2',
		name: 'Y Album',
		release_date: '2025-06-01',
		images: [],
	},
};

const responses = new Map<string, unknown>([
	['/v1/me/playlists?limit=50&offset=0', { items: [PLAYLIST_1], next: null }],
	[
		'/v1/playlists/pl_alpha/tracks',
		{
			items: [
				{ added_at: '2026-01-01T00:00:00Z', added_by: { id: 'user_a' }, is_local: false, track: TRACK_X },
				{ added_at: '2026-01-02T00:00:00Z', added_by: { id: 'user_a' }, is_local: false, track: TRACK_Y },
			],
			next: null,
		},
	],
	['/v1/me/tracks?limit=50&offset=0', { items: [], next: null }],
]);

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
	const u = typeof input === 'string' ? input : input.toString();
	// trim query string for matching playlist tracks (we use partial keys)
	const path = u.replace('https://api.spotify.com', '');
	// liked songs: exact match
	if (path.startsWith('/v1/me/tracks')) {
		return new Response(JSON.stringify(responses.get('/v1/me/tracks?limit=50&offset=0')), { status: 200 });
	}
	// user playlists list
	if (path.startsWith('/v1/me/playlists')) {
		return new Response(JSON.stringify(responses.get('/v1/me/playlists?limit=50&offset=0')), { status: 200 });
	}
	// playlist tracks — strip fields/limit/offset
	if (path.startsWith('/v1/playlists/pl_alpha/tracks')) {
		return new Response(JSON.stringify(responses.get('/v1/playlists/pl_alpha/tracks')), { status: 200 });
	}
	console.error('unmocked fetch:', u);
	throw new Error(`unmocked fetch: ${u}`);
}) as typeof fetch;

async function main(): Promise<void> {
	// fresh DB
	const fs = await import('node:fs');
	fs.rmSync(DB, { force: true });

	migrate(DB);
	const { db, sqlite } = createDb(DB);

	// fake a Spotify auth token directly in the store (skip the live PKCE flow)
	const ts = new TokenStore(db);
	const tomorrow = new Date(Date.now() + 86400_000);
	ts.put('spotify', 'access', 'user', 'fake_access_token', {
		expiresAt: tomorrow,
		meta: { id: 'me', displayName: 'Smoke User', avatarUrl: null },
	});
	ts.put('spotify', 'refresh', 'user', 'fake_refresh_token');

	const auth = new AuthService(db);
	const sync = new SpotifySync(db, auth);

	const events1: string[] = [];
	const result1 = await sync.run((p) => events1.push(`${p.stage}${p.currentPlaylist ? ` ${p.currentPlaylist.name}` : ''}${p.totals?.playlistsSkipped != null ? ` (skipped=${p.totals.playlistsSkipped})` : ''}`));
	console.log('=== first run ===');
	console.log('result:', result1);
	console.log('events:', events1);

	const playlists = db.select().from(playlist).all();
	const tracks = db.select().from(track).all();
	const links = db.select().from(sourceLink).all();
	const pts = db.select().from(playlistTrack).all();
	console.log(`\nDB after first run: ${playlists.length} playlists, ${tracks.length} tracks, ${links.length} source_links, ${pts.length} playlist_tracks`);

	// run again — should hit the skip path because snapshot_id matches
	const events2: string[] = [];
	const result2 = await sync.run((p) => events2.push(`${p.stage}${p.currentPlaylist ? ` ${p.currentPlaylist.name}` : ''}${p.totals?.playlistsSkipped != null ? ` (skipped=${p.totals.playlistsSkipped})` : ''}`));
	console.log('\n=== second run (snapshot_id should match → skip) ===');
	console.log('result:', result2);
	console.log('events:', events2);
	const skipCount = events2.filter((e) => e.startsWith('playlist-skipped')).length;
	if (skipCount === 0) {
		console.error(`FAIL: expected at least 1 playlist to be skipped on re-run, got 0`);
		process.exit(1);
	}
	console.log(`✓ ${skipCount} playlist(s) skipped on re-run`);

	const playlists2 = db.select().from(playlist).all();
	const tracks2 = db.select().from(track).all();
	const links2 = db.select().from(sourceLink).all();
	const pts2 = db.select().from(playlistTrack).all();
	console.log(`DB after second run: ${playlists2.length} playlists, ${tracks2.length} tracks, ${links2.length} source_links, ${pts2.length} playlist_tracks`);

	if (tracks2.length !== tracks.length) {
		console.error('FAIL: track count diverged on re-run');
		process.exit(1);
	}
	if (links2.length !== links.length) {
		console.error('FAIL: source_link count diverged on re-run');
		process.exit(1);
	}

	console.log('\nsample track:', tracks2[0]);
	console.log('sample link:', { ...links2[0], payload: '...truncated...' });

	sqlite.close();
	console.log('\nsmoke test OK');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
}).finally(() => {
	globalThis.fetch = originalFetch;
});
