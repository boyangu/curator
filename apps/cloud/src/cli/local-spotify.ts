// The local catalogue's own Spotify login, so it reads followed playlists
// with nothing else running (cli/local.ts). Dev only, loopback only.
//
// Spotify serves a playlist's tracks to a person's login, not to an app. The
// real cloud keeps one such login for the account (spotify/gateway.ts), and
// Spotify rotates refresh tokens, so a copy of it here would leave two holders
// of one token and strand one of them. This is a separate login instead: the
// operator signs in from the back office (PKCE, the desktop's client id, no
// secret), and the grant is kept the way the cloud keeps one — sealed in the
// local database's curator.spotify_grant under a key in this data folder
// (or CURATOR_TOKEN_KEY). It is only used to read.
//
// Spotify needs the callback registered in the app's dashboard, exactly:
// http://127.0.0.1:<port>/local/spotify/callback.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpotifyProfile } from '@curator/protocol';
import type { Db } from '../db/db.js';
import type { Logger } from '../log.js';
import { TokenCrypto, parseTokenKey, type TokenKey } from '../spotify/crypto.js';
import { connectLocal, SPOTIFY_TIMEOUT_MS, tokenForUser, type GatewayDeps } from '../spotify/gateway.js';

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
// Reading followed playlists, their private and collaborative ones included.
const SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];
const STATE_TTL_MS = 10 * 60_000;

export type LocalSpotifyStatus = {
	configured: boolean;
	connected: boolean;
	needsReconnect: boolean;
	name: string | null;
	redirectUri: string;
	error: string | null;
};

const b64url = (b: Buffer) => b.toString('base64url');

// The sealing key: CURATOR_TOKEN_KEY when set (as the cloud's), else one made
// once for this data folder. Deleting the folder deletes the login with it.
function loadKey(dir: string): TokenKey {
	const env = process.env.CURATOR_TOKEN_KEY?.trim();
	if (env) return parseTokenKey('CURATOR_TOKEN_KEY', env);
	const path = join(dir, 'spotify-token.key');
	if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 });
	return parseTokenKey(path, readFileSync(path, 'utf8'));
}

export function createLocalSpotifyLogin(opts: { db: Db; log: Logger; dir: string; port: number; clientId: string | null }) {
	const redirectUri = `http://127.0.0.1:${opts.port}/local/spotify/callback`;
	const deps: GatewayDeps | null = opts.clientId
		? {
				db: opts.db,
				log: opts.log,
				audit: (kind) => opts.log.info('local_spotify', { kind }),
				gateway: { clientId: opts.clientId, crypto: new TokenCrypto({ current: loadKey(opts.dir), previous: null }), fetch: (url, init) => fetch(url, init), timeoutMs: SPOTIFY_TIMEOUT_MS },
			}
		: null;
	const pending = new Map<string, { verifier: string; at: number }>();
	let lastError: string | null = null;
	// Whether a usable grant is kept: read at start, after a connect or a
	// disconnect, and when a token call says the grant is gone.
	let connected = false;

	// The account the catalogue serves: the one following the most here.
	const owner = async (): Promise<string | null> => {
		const [row] = await opts.db.query<{ user_id: string }>(`select user_id from curator.catalog_watch group by user_id order by count(*) desc limit 1`);
		return row?.user_id ?? null;
	};
	const grant = async (): Promise<{ needs_reconnect: boolean; profile: string } | null> => {
		const [row] = await opts.db.query<{ needs_reconnect: boolean; profile: string }>(`select needs_reconnect, profile::text as profile from curator.spotify_grant order by connected_at desc limit 1`);
		return row ?? null;
	};
	const reload = async (): Promise<void> => {
		const g = await grant().catch(() => null);
		connected = !!g && !g.needs_reconnect;
	};

	const page = (title: string, body: string, status = 200) =>
		new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:40px;max-width:640px"><h2>${title}</h2>${body}<p><a href="/backoffice#/tracking">Back to the back office</a></p>`, {
			status,
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

	return {
		redirectUri,
		reload,
		connected: () => connected,

		// A token for a watcher; throws when this catalogue keeps no login for them.
		async token(userId: string): Promise<string> {
			if (!deps) throw new Error('no Spotify client id');
			try {
				return (await tokenForUser(deps, userId)).accessToken;
			} catch (e) {
				void reload();
				throw e;
			}
		},

		async status(): Promise<LocalSpotifyStatus> {
			const g = await grant().catch(() => null);
			const profile = g ? (JSON.parse(g.profile) as SpotifyProfile) : null;
			return { configured: !!deps, connected: !!g && !g.needs_reconnect, needsReconnect: !!g?.needs_reconnect, name: profile?.displayName ?? profile?.id ?? null, redirectUri, error: lastError };
		},

		// Answers /local/spotify/*; null for anything else.
		async handle(req: Request): Promise<Response | null> {
			const url = new URL(req.url);
			if (!url.pathname.startsWith('/local/spotify/')) return null;
			const path = url.pathname.slice('/local/spotify/'.length);
			if (path === 'status' && req.method === 'GET') return Response.json(await this.status());
			if (!deps) return page('Spotify is not configured', '<p>Set CURATOR_SPOTIFY_CLIENT_ID in the repo .env and restart the local catalogue.</p>', 400);

			if (path === 'connect' && req.method === 'GET') {
				const verifier = b64url(randomBytes(48));
				const state = b64url(randomBytes(16));
				for (const [k, v] of pending) if (Date.now() - v.at > STATE_TTL_MS) pending.delete(k);
				pending.set(state, { verifier, at: Date.now() });
				const q = new URLSearchParams({
					client_id: deps.gateway.clientId,
					response_type: 'code',
					redirect_uri: redirectUri,
					code_challenge_method: 'S256',
					code_challenge: b64url(createHash('sha256').update(verifier).digest()),
					scope: SCOPES.join(' '),
					state,
				});
				return Response.redirect(`${AUTHORIZE_URL}?${q}`, 302);
			}

			if (path === 'callback' && req.method === 'GET') {
				// The state ties the answer to a connect this server started.
				const state = url.searchParams.get('state') ?? '';
				const started = pending.get(state);
				pending.delete(state);
				if (!started || Date.now() - started.at > STATE_TTL_MS) return page('Sign-in expired', '<p>Start it again from the back office.</p>', 400);
				const denied = url.searchParams.get('error');
				if (denied) {
					lastError = denied;
					return page('Spotify did not sign in', `<p>${esc(denied)}</p>`, 400);
				}
				const userId = await owner();
				if (!userId) return page('Nobody to connect for', '<p>Follow something from the desktop first: the login belongs to the account that follows.</p>', 400);
				try {
					const s = await connectLocal(deps, userId, { code: url.searchParams.get('code') ?? '', codeVerifier: started.verifier, redirectUri });
					lastError = null;
					connected = true;
					opts.log.info('local_spotify_connected', { scopes: s.scopes.length });
					return Response.redirect(new URL('/backoffice#/tracking', url).toString(), 302);
				} catch (e) {
					lastError = e instanceof Error ? e.message : String(e);
					return page('Spotify sign-in failed', `<p>${esc(lastError)}</p>`, 500);
				}
			}

			if (path === 'disconnect' && req.method === 'POST') {
				// JSON only: a cross-site form cannot send it without a preflight.
				if (!req.headers.get('content-type')?.startsWith('application/json')) return new Response('json only', { status: 415 });
				await opts.db.query(`delete from curator.spotify_grant`);
				connected = false;
				opts.log.info('local_spotify_disconnected', {});
				return Response.json({ ok: true });
			}
			return new Response('not found', { status: 404 });
		},
	};
}
