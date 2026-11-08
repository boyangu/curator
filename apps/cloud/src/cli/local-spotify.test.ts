// The local catalogue's own Spotify login: its routes up to the hand-off to
// Spotify, and the key it seals with. The exchange itself is gateway.ts's
// (playlists.test.ts reads with a grant connectLocal kept).

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { createLocalSpotifyLogin } from './local-spotify.js';

const quiet = createLogger(() => {});
const CLIENT = '0123456789abcdef0123456789abcdef';
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function login(clientId: string | null = CLIENT) {
	const app = await createTestApp();
	const dir = mkdtempSync(join(tmpdir(), 'curator-local-spotify-'));
	dirs.push(dir);
	const l = createLocalSpotifyLogin({ db: app.db, log: quiet, dir, port: 8787, clientId });
	const call = async (path: string, init?: RequestInit) => (await l.handle(new Request(`http://127.0.0.1:8787${path}`, init)))!;
	return { app, dir, l, call };
}

describe('local Spotify login', () => {
	it('says it is not connected yet, and where Spotify must send the user back', async () => {
		const { call, l } = await login();
		expect(await (await call('/local/spotify/status')).json()).toEqual({
			configured: true,
			connected: false,
			needsReconnect: false,
			name: null,
			redirectUri: 'http://127.0.0.1:8787/local/spotify/callback',
			error: null,
		});
		expect(l.connected()).toBe(false);
		expect(await l.handle(new Request('http://127.0.0.1:8787/admin'))).toBeNull();
	});

	it('sends the browser to Spotify with PKCE, the read scopes and a state', async () => {
		const { call } = await login();
		const res = await call('/local/spotify/connect');
		expect(res.status).toBe(302);
		const to = new URL(res.headers.get('location')!);
		expect(to.origin + to.pathname).toBe('https://accounts.spotify.com/authorize');
		expect(Object.fromEntries(to.searchParams)).toMatchObject({
			client_id: CLIENT,
			response_type: 'code',
			redirect_uri: 'http://127.0.0.1:8787/local/spotify/callback',
			code_challenge_method: 'S256',
			scope: 'playlist-read-private playlist-read-collaborative',
		});
		expect(to.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(to.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});

	it('refuses a callback it did not start, and one Spotify answered with a refusal', async () => {
		const { call } = await login();
		expect((await call('/local/spotify/callback?code=x&state=forged')).status).toBe(400);
		const state = new URL((await call('/local/spotify/connect')).headers.get('location')!).searchParams.get('state')!;
		const denied = await call(`/local/spotify/callback?error=access_denied&state=${state}`);
		expect(denied.status).toBe(400);
		expect(((await (await call('/local/spotify/status')).json()) as { error: string }).error).toBe('access_denied');
		// A state works once.
		expect((await call(`/local/spotify/callback?code=x&state=${state}`)).status).toBe(400);
	});

	it('disconnects only on a JSON post', async () => {
		const { call } = await login();
		expect((await call('/local/spotify/disconnect', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
		expect((await call('/local/spotify/disconnect', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(200);
	});

	it('makes its sealing key once, in the data folder', async () => {
		const { dir } = await login();
		const key = readFileSync(join(dir, 'spotify-token.key'), 'utf8');
		expect(Buffer.from(key, 'base64')).toHaveLength(32);
		createLocalSpotifyLogin({ db: (await createTestApp()).db, log: quiet, dir, port: 8787, clientId: CLIENT });
		expect(readFileSync(join(dir, 'spotify-token.key'), 'utf8')).toBe(key);
	});

	it('without a client id, says so instead of starting a sign-in', async () => {
		const { call } = await login(null);
		expect(((await (await call('/local/spotify/status')).json()) as { configured: boolean }).configured).toBe(false);
		expect((await call('/local/spotify/connect')).status).toBe(400);
	});
});
