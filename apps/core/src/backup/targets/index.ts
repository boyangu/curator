// Target factory. The target id is derived from the config so the local
// index (backup.db) keys objects per target: pointing the app at a different
// folder, or a different Drive folder name, is a different target with its
// own (rebuilt-from-remote) index.

import { createHash } from 'node:crypto';
import type { BackupTargetConfig } from '../types.js';
import type { BackupTarget } from './types.js';
import { createFolderTarget } from './folder.js';
import { createGoogleDriveTarget } from './googledrive.js';

export interface TargetDeps {
	// Short-lived Drive access token (main refreshes; the worker only ever
	// sees access tokens, never the refresh token).
	googleAccessToken?: () => Promise<string>;
	fetch?: typeof fetch;
}

export function targetIdFor(cfg: BackupTargetConfig): string {
	const key = cfg.kind === 'folder' ? cfg.path.replace(/\/+$/, '').toLowerCase() : cfg.folderName;
	return `${cfg.kind}:${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

export function targetLabel(cfg: BackupTargetConfig): string {
	return cfg.kind === 'folder' ? cfg.path : `Google Drive / ${cfg.folderName}`;
}

export function createTarget(cfg: BackupTargetConfig, deps: TargetDeps): BackupTarget {
	const id = targetIdFor(cfg);
	if (cfg.kind === 'folder') return createFolderTarget(id, cfg.path);
	if (!deps.googleAccessToken) throw new Error('Google Drive is not connected');
	return createGoogleDriveTarget(id, { folderName: cfg.folderName }, { accessToken: deps.googleAccessToken, fetch: deps.fetch });
}
