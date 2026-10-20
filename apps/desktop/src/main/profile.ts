// Profile mode: a second Curator instance on the same PC that behaves like
// another desktop (multi-device sync / shared-catalogue testing). Launched with
// CURATOR_PROFILE=<name> (normally via `pnpm desktop:profile <name>`).
//
// Everything here is pure — no Electron import — so the decisions that keep a
// test instance away from the user's live library are unit-tested without
// launching the app (profile.test.ts). index.ts applies them.
//
// The isolation is the userData swap: every per-library file (curator.db and
// its sibling feed/knowledge/agent/mir DBs, peaks, covers, logs, session
// storage, cloud-auth.json, agent-config.json, mcp-bridge.json, write-audit,
// the Widevine CDM) derives from app.getPath('userData'). The rails cover what
// does NOT live under userData: the rekordbox master.db, the user's live
// Spotify/Tidal accounts, the Google Drive backup target, the shared download
// folder in ~/Music, and the default WAV folder.

import { isAbsolute, join, relative, resolve } from 'node:path';

// Lower-case on purpose: the name becomes part of a directory name, and
// Windows paths are case-insensitive — "Second" and "second" must not be two
// profiles that silently share one folder.
export const PROFILE_NAME_RE = /^[a-z0-9-]{1,32}$/;

// The one escape hatch. Named verbatim in the window title and startup log
// whenever it loosens a rail, so a screenshot shows the instance isn't sealed.
export const ALLOW_REKORDBOX_ENV = 'CURATOR_PROFILE_ALLOW_REKORDBOX';

export type ProfileParse =
	| { kind: 'default' }
	| { kind: 'profile'; name: string }
	| { kind: 'invalid'; raw: string };

// Unset or empty ⇒ the normal app. An invalid name is NOT treated as unset:
// falling back to the default profile would open the live library, the exact
// thing the caller asked to stay away from — index.ts refuses to start.
export function parseProfileEnv(raw: string | undefined): ProfileParse {
	if (raw === undefined || raw === '') return { kind: 'default' };
	return PROFILE_NAME_RE.test(raw) ? { kind: 'profile', name: raw } : { kind: 'invalid', raw };
}

// %APPDATA%\Curator → %APPDATA%\Curator-second. A sibling rather than a
// subfolder, so the two libraries share no directory at all — nothing that
// walks or snapshots the real userData can pick up the profile's files.
export function profileUserDataDir(defaultUserData: string, name: string): string {
	return `${defaultUserData.replace(/[\\/]+$/, '')}-${name}`;
}

// Where `pnpm desktop:profile` points core's download folders. Core reads
// CURATOR_DOWNLOAD_DIR / CURATOR_REDOWNLOAD_DIR once, when its bundle chunk
// loads — before main's body runs — so setting them from index.ts would be
// too late; the launcher sets them in the env instead
// (apps/desktop/scripts/run-profile.mjs mirrors this shape).
export function profileDownloadDirs(profileUserData: string): { CURATOR_DOWNLOAD_DIR: string; CURATOR_REDOWNLOAD_DIR: string } {
	return {
		CURATOR_DOWNLOAD_DIR: join(profileUserData, 'downloads'),
		CURATOR_REDOWNLOAD_DIR: join(profileUserData, 'redownloads'),
	};
}

export interface ProfileRails {
	// null ⇒ the normal app; every field below then matches today's behaviour.
	profile: string | null;
	// Spawn the rekordbox sidecar (all master.db reads/writes go through it).
	rekordbox: boolean;
	// Inject remoteWritePolicy into createCoreService (Spotify/Tidal CRUD).
	// No override in profile mode: a test instance must never mutate the
	// user's live streaming accounts.
	remoteWrites: boolean;
	// Backup engine, scheduler and the Google Drive connect flow.
	backup: boolean;
	// Honour CURATOR_DB_URL. In a profile it could point back at the live DB.
	dbUrlOverride: boolean;
	// Non-null ⇒ Tidal download channels reject with this message.
	downloadsBlocked: string | null;
	// Env flags that loosened a rail — shown in the window title + log line.
	overrides: string[];
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export function decideRails(
	profile: string | null,
	env: Record<string, string | undefined>,
	profileUserData: string | null,
): ProfileRails {
	if (profile === null || profileUserData === null) {
		return { profile: null, rekordbox: true, remoteWrites: true, backup: true, dbUrlOverride: true, downloadsBlocked: null, overrides: [] };
	}
	const overrides: string[] = [];
	const rekordbox = env[ALLOW_REKORDBOX_ENV] === '1';
	if (rekordbox) overrides.push(`${ALLOW_REKORDBOX_ENV}=1`);

	// Downloads default to ~/Music/Curator — the real library folder the main
	// instance's scanner may be watching. Allowed only when both folders were
	// redirected into this profile's userData (the launcher does that).
	const dl = env['CURATOR_DOWNLOAD_DIR'];
	const redl = env['CURATOR_REDOWNLOAD_DIR'];
	const downloadsOk = !!dl && !!redl && isInside(dl, profileUserData) && isInside(redl, profileUserData);
	const downloadsBlocked = downloadsOk
		? null
		: `Downloads are off in profile "${profile}": CURATOR_DOWNLOAD_DIR and CURATOR_REDOWNLOAD_DIR must both point inside ${profileUserData} (pnpm desktop:profile sets them).`;

	return { profile, rekordbox, remoteWrites: false, backup: false, dbUrlOverride: false, downloadsBlocked, overrides };
}

// Appended to the window title (taskbar / Alt-Tab — the window is frameless).
export function profileTitleSuffix(rails: ProfileRails): string {
	if (!rails.profile) return '';
	const loosened = rails.overrides.length ? ` [${rails.overrides.join(', ')}]` : '';
	return ` — profile: ${rails.profile}${loosened}`;
}

// The single startup log line's payload. Strings rather than booleans so the
// JSONL reads unambiguously without the code at hand.
export function profileRailsSummary(rails: ProfileRails, userData: string): Record<string, string> {
	return {
		profile: rails.profile ?? '(default)',
		userData,
		rekordbox: rails.rekordbox ? (rails.profile ? `ON via ${ALLOW_REKORDBOX_ENV}=1` : 'on') : 'off (no sidecar, no master.db access)',
		remoteWrites: rails.remoteWrites ? 'on' : 'off (no remoteWritePolicy — default-deny)',
		backup: rails.backup ? 'on' : 'off (no engine, no scheduler, Google Drive connect refused)',
		dbUrlOverride: rails.dbUrlOverride ? 'honoured' : 'ignored',
		downloads: rails.downloadsBlocked ? 'blocked (download dirs not redirected into profile)' : 'on',
		loopback: 'MCP bridge + Spotify sidecar on ephemeral ports',
		scanner: rails.profile ? 'no folders until added in this profile' : 'as configured',
	};
}

// Windows groups taskbar buttons by AppUserModelID; a distinct id keeps the
// two instances apart in the taskbar instead of stacking under one icon.
export function profileAppUserModelId(base: string, profile: string | null): string {
	return profile ? `${base}.profile.${profile}` : base;
}

// Device name registered with cloud sync — both instances share a hostname,
// and the Account → Devices list should tell them apart.
export function profileDeviceName(host: string, profile: string | null): string {
	return profile ? `${host} (profile: ${profile})` : host;
}
