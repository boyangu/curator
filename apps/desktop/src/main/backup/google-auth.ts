// Google refresh-token custody for the Drive backup target. Same shape as
// agent-config.ts: the refresh token is safeStorage-encrypted (bound to the
// OS user) in userData/backup-google-auth.json — never in curator.db, which
// gets backed up and restored and must not carry a usable credential. The
// decrypted token lives only in main-process memory; the backup worker
// asks main for short-lived access tokens over the host-call channel.

import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, type GoogleAuthStatus } from '@curator/core';
import { DriveClient, GoogleAuthError, refreshGoogleToken } from '@curator/google-drive';
import { GOOGLE_NOT_CONFIGURED, runGoogleOAuthFlow } from '../auth/google.js';
import { mainLog } from '../log.js';

const glog = mainLog.for('google-auth');

// Refresh this far ahead of expiry so a token handed to the worker is still
// valid for the request it is about to make.
const REFRESH_MARGIN_MS = 60_000;

interface StoredGoogleAuth {
	// base64 of safeStorage.encryptString(refreshToken).
	refreshTokenEnc: string;
	email: string | null;
	connectedAt: number;
}

let cached: { accessToken: string; expiresAt: number } | null = null;
let refreshing: Promise<string> | null = null;
let needsReconnect = false;

function authPath(): string {
	return join(app.getPath('userData'), 'backup-google-auth.json');
}

function readStored(): StoredGoogleAuth | null {
	const path = authPath();
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredGoogleAuth>;
		if (typeof parsed.refreshTokenEnc !== 'string') return null;
		return { refreshTokenEnc: parsed.refreshTokenEnc, email: parsed.email ?? null, connectedAt: parsed.connectedAt ?? 0 };
	} catch (err) {
		glog.warn('unreadable backup-google-auth.json — treating as disconnected', undefined, err);
		return null;
	}
}

function decryptRefreshToken(stored: StoredGoogleAuth): string | null {
	try {
		return safeStorage.decryptString(Buffer.from(stored.refreshTokenEnc, 'base64'));
	} catch (err) {
		// Different OS account / restored onto another machine: the file is
		// inert there by design — the user reconnects.
		glog.warn('stored Google refresh token failed to decrypt — reconnect required', undefined, err);
		return null;
	}
}

export function getGoogleAuthStatus(): GoogleAuthStatus {
	const configured = config.google.configured;
	const stored = readStored();
	if (!stored) return { configured, connected: false, email: null };
	return { configured, connected: decryptRefreshToken(stored) !== null, email: stored.email };
}

export function googleNeedsReconnect(): boolean {
	return needsReconnect;
}

async function refresh(): Promise<string> {
	const stored = readStored();
	const refreshToken = stored ? decryptRefreshToken(stored) : null;
	if (!refreshToken) {
		// Not connected (or undecryptable on this machine) — the status
		// already reports connected=false; needsReconnect is reserved for a
		// token Google itself rejected.
		throw new GoogleAuthError('not_connected', 'Google Drive is not connected');
	}
	// A stored token can outlive the credentials (restored userData, an
	// unconfigured build): the token endpoint would 400 on an empty client id.
	if (!config.google.configured) throw new GoogleAuthError('not_configured', GOOGLE_NOT_CONFIGURED);
	try {
		const t = await refreshGoogleToken(config.google, refreshToken);
		cached = { accessToken: t.accessToken, expiresAt: t.expiresAt };
		needsReconnect = false;
		if (t.refreshToken && t.refreshToken !== refreshToken) persist(t.refreshToken, stored?.email ?? null, stored?.connectedAt ?? Date.now());
		return t.accessToken;
	} catch (err) {
		if (err instanceof GoogleAuthError && err.code === 'invalid_grant') {
			// Expired Testing-mode token or the user revoked access: nothing
			// short of a new consent fixes it, so flag the UI.
			needsReconnect = true;
			cached = null;
			glog.warn('Google refresh token rejected (invalid_grant) — reconnect required');
		}
		throw err;
	}
}

export async function getGoogleAccessToken(): Promise<string> {
	if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.accessToken;
	// Coalesce: the worker runs several uploads in flight and they all ask
	// at once when the token rolls over.
	if (!refreshing) {
		refreshing = refresh().finally(() => {
			refreshing = null;
		});
	}
	return refreshing;
}

function persist(refreshToken: string, email: string | null, connectedAt: number): void {
	if (!safeStorage.isEncryptionAvailable()) {
		throw new Error('OS credential encryption is unavailable — cannot store the Google refresh token');
	}
	const stored: StoredGoogleAuth = {
		refreshTokenEnc: safeStorage.encryptString(refreshToken).toString('base64'),
		email,
		connectedAt,
	};
	writeFileSync(authPath(), JSON.stringify(stored, null, '\t'), 'utf8');
}

export async function runGoogleConnectFlow(): Promise<{ email: string | null }> {
	const tokens = await runGoogleOAuthFlow();
	cached = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
	let email: string | null = null;
	try {
		email = (await new DriveClient({ accessToken: async () => tokens.accessToken }).about()).email;
	} catch (err) {
		glog.warn('connected, but reading the account email failed', undefined, err);
	}
	persist(tokens.refreshToken, email, Date.now());
	needsReconnect = false;
	glog.info('Google Drive connected', { email });
	return { email };
}

export function disconnectGoogle(): void {
	cached = null;
	needsReconnect = false;
	const path = authPath();
	if (existsSync(path)) unlinkSync(path);
	glog.info('Google Drive disconnected');
}
