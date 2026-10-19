// Files only the main process can produce for the "Curator core" backup
// set, written into userData just before a run so the engine treats them
// like any other file:
//
//   renderer-settings.json — every localStorage key under `curator.` (UI
//     settings, rekordbox flags, auto-analyze…) read out of the renderer.
//     Restored by the renderer at the next boot before it reads settings.
//   tokens.enc — the `token` table (Spotify/Tidal sessions) encrypted with
//     safeStorage, i.e. bound to this OS user. The DB copy in the backup has
//     its token rows stripped; this sidecar is what keeps a same-machine
//     restore signed in. On another machine it does not decrypt, and the
//     user reconnects — by design (CLAUDE.md's token-rows lesson).

import { app, safeStorage, type BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CoreService, ExportedTokenRow } from '@curator/core';
import { mainLog } from '../log.js';

const alog = mainLog.for('backup-artifacts');

export const RENDERER_SETTINGS_FILE = 'renderer-settings.json';
export const TOKENS_FILE = 'tokens.enc';

export async function writeHostArtifacts(win: BrowserWindow | null, core: CoreService): Promise<void> {
	const dir = app.getPath('userData');
	// Renderer settings: skipped (previous file kept) when no window is up.
	if (win && !win.isDestroyed()) {
		try {
			const dump = await win.webContents.executeJavaScript(
				`(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('curator.')) o[k] = localStorage.getItem(k); } return JSON.stringify(o); })()`,
				true,
			) as string;
			await writeFile(join(dir, RENDERER_SETTINGS_FILE), dump, 'utf8');
		} catch (err) {
			alog.warn('could not export renderer settings', undefined, err);
		}
	}
	// Token sidecar.
	try {
		const rows = core.auth.exportTokenRows();
		if (rows.length === 0 || !safeStorage.isEncryptionAvailable()) {
			await rm(join(dir, TOKENS_FILE), { force: true });
			return;
		}
		const enc = safeStorage.encryptString(JSON.stringify(rows));
		await writeFile(join(dir, TOKENS_FILE), enc);
	} catch (err) {
		alog.warn('could not write the token sidecar', undefined, err);
	}
}

// After a restore applied at boot: decrypt the restored sidecar and put the
// rows back. Undecryptable (another OS user / machine) ⇒ skip; the user
// reconnects Spotify/Tidal. The file is deleted either way.
export async function importRestoredTokens(path: string, core: CoreService): Promise<'imported' | 'skipped'> {
	try {
		if (!existsSync(path)) return 'skipped';
		if (!safeStorage.isEncryptionAvailable()) return 'skipped';
		const rows = JSON.parse(safeStorage.decryptString(await readFile(path))) as ExportedTokenRow[];
		core.auth.importTokenRows(rows);
		alog.info('restored token rows imported', { rows: rows.length });
		return 'imported';
	} catch (err) {
		alog.warn('restored token sidecar could not be decrypted on this machine — reconnect Spotify/Tidal', undefined, err);
		return 'skipped';
	} finally {
		await rm(path, { force: true });
	}
}
