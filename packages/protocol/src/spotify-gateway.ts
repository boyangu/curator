// The Spotify gateway ('spotify_gateway'): the account's Spotify grant lives in
// the cloud, not on any device (2026-10-25 decision). Every device signs in to
// Spotify once through it and asks it for short-lived access tokens; the
// refresh token never leaves the server, which is encrypted at rest with a
// key held outside the database. One owner also ends the refresh race: Spotify
// may rotate the refresh token on every refresh, so two holders refreshing
// independently strand one of them.
//
// Stage 1 (this file): connect, adopt an existing device grant, vend, status,
// disconnect. Writes through the gateway (playlist edits, follows) are a later
// stage behind signed device intents; nothing here writes to Spotify.

import { z } from 'zod';
import { ZDeviceId } from './sync-input.js';

// The scopes the gateway asks for: the desktop's current set, so an adopted
// grant covers everything the apps already do.
export const SPOTIFY_GATEWAY_SCOPES = [
	'playlist-read-private',
	'playlist-read-collaborative',
	'playlist-modify-private',
	'playlist-modify-public',
	'user-library-read',
	'user-follow-read',
	'user-follow-modify',
	'user-read-email',
	'user-read-private',
	'streaming',
	'user-modify-playback-state',
	'user-read-playback-state',
] as const;

export type SpotifyProfile = { id: string; displayName: string | null; avatarUrl: string | null };

// spotify.connect: the device ran the PKCE authorization in its own window and
// hands the cloud the code with its verifier and the redirect URI it used; the
// cloud exchanges them (client id only, no secret) and keeps the grant.
export type SpotifyConnectInput = { deviceId: string; code: string; codeVerifier: string; redirectUri: string };

// spotify.adopt: a device that already holds a grant (a desktop from before the
// gateway) moves it to the cloud once. The cloud proves it with a refresh and
// stores the result; the device then deletes its own copy and vends from now on.
export type SpotifyAdoptInput = { deviceId: string; refreshToken: string };

export type SpotifyGrantStatus = {
	connected: boolean;
	profile: SpotifyProfile | null;
	scopes: string[];
	connectedAt: number | null;
	// The last refresh failure Spotify answered (revoked grant, scope change),
	// so every device can show "reconnect Spotify" instead of failing quietly.
	needsReconnect: boolean;
};

// spotify.token: a current access token (the cloud refreshes under a per-account
// lock and shares one token between devices until shortly before it expires).
export type SpotifyTokenInput = { deviceId: string };
export type SpotifyTokenResult = { accessToken: string; expiresAt: number; scopes: string[]; profile: SpotifyProfile };

export type SpotifyDisconnectInput = { deviceId: string };

export const ZSpotifyConnectInput = z
	.object({
		deviceId: ZDeviceId,
		code: z.string().min(1).max(2048),
		codeVerifier: z.string().min(43).max(128),
		redirectUri: z.string().url().max(512),
	})
	.strict();
export const ZSpotifyAdoptInput = z.object({ deviceId: ZDeviceId, refreshToken: z.string().min(1).max(4096) }).strict();
export const ZSpotifyTokenInput = z.object({ deviceId: ZDeviceId }).strict();
export const ZSpotifyDisconnectInput = z.object({ deviceId: ZDeviceId }).strict();
