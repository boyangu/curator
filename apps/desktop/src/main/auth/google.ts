// Google OAuth (authorization code + PKCE) for the Drive backup target.
// Unlike the Spotify flow this does NOT host the consent page in a
// BrowserWindow: Google refuses embedded webviews (`disallowed_useragent`).
// The system browser does the sign-in and redirects to a one-shot HTTP
// listener on 127.0.0.1 that exists only for the duration of the flow.
//
// That listener is an OAuth redirect receiver, not a remote-debugging port:
// it answers exactly one callback request (any other path 404s), checks the
// `state` nonce, and closes.

import { shell } from 'electron';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { generatePkce } from '@curator/shared';
import { buildGoogleAuthorizeUrl, exchangeGoogleCode } from '@curator/google-drive';
import { config } from '@curator/core';
import { mainLog } from '../log.js';

const alog = mainLog.for('google-auth');

const FLOW_TIMEOUT_MS = 3 * 60_000;

export interface GoogleOAuthResult {
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
}

function page(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#aaa}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

function listen(server: Server, host: string, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			server.off('error', reject);
			resolve((server.address() as AddressInfo).port);
		});
	});
}

export const GOOGLE_NOT_CONFIGURED = 'Google Drive backup is not configured in this build: set CURATOR_GOOGLE_CLIENT_ID and CURATOR_GOOGLE_CLIENT_SECRET';

export async function runGoogleOAuthFlow(): Promise<GoogleOAuthResult> {
	if (!config.google.configured) throw new Error(GOOGLE_NOT_CONFIGURED);
	// The configured URI supplies host + path; port 0 means "any free port".
	const template = new URL(config.google.redirectUri);
	const wantPort = Number(template.port || 0);

	const { verifier, challenge } = await generatePkce();
	const state = randomBytes(16).toString('hex');

	let settle: (r: { code: string } | { error: Error }) => void = () => {};
	const outcome = new Promise<{ code: string } | { error: Error }>((resolve) => {
		settle = resolve;
	});

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		if (url.pathname !== template.pathname) {
			res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
			return;
		}
		const returnedState = url.searchParams.get('state');
		const code = url.searchParams.get('code');
		const error = url.searchParams.get('error');
		const reply = (status: number, html: string) => {
			res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
		};
		if (returnedState !== state) {
			reply(400, page('Sign-in rejected', 'The response did not match the request Curator sent. Close this tab and try again.'));
			settle({ error: new Error('Google auth: state mismatch') });
			return;
		}
		if (error) {
			reply(400, page('Sign-in cancelled', `Google reported: ${error}. You can close this tab.`));
			settle({ error: new Error(`Google auth: ${error}`) });
			return;
		}
		if (!code) {
			reply(400, page('Sign-in failed', 'No authorization code was returned. Close this tab and try again.'));
			settle({ error: new Error('Google auth: no code in redirect') });
			return;
		}
		reply(200, page('Curator is connected to Google Drive', 'You can close this tab.'));
		settle({ code });
	});

	const port = await listen(server, '127.0.0.1', wantPort);
	const redirectUri = `http://127.0.0.1:${port}${template.pathname}`;
	const authorizeUrl = buildGoogleAuthorizeUrl({ ...config.google, redirectUri }, challenge, state);
	alog.info('opening system browser for Google consent', { port });

	const timer = setTimeout(() => settle({ error: new Error('Google auth: timed out waiting for the browser (3 minutes)') }), FLOW_TIMEOUT_MS);
	try {
		await shell.openExternal(authorizeUrl);
		const result = await outcome;
		if ('error' in result) throw result.error;
		const tokens = await exchangeGoogleCode({ ...config.google, redirectUri }, result.code, verifier);
		if (!tokens.refreshToken) {
			// Google only issues a refresh token on the first consent unless
			// prompt=consent is honored; a stale grant on the account swallows
			// it. Revoking the app's access resets that.
			throw new Error('Google did not return a refresh token. Remove Curator under myaccount.google.com/permissions, then connect again.');
		}
		return { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
	} finally {
		clearTimeout(timer);
		// Let the in-flight response flush before the socket goes away.
		server.close();
		server.closeAllConnections?.();
	}
}
