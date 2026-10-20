// Boot-time restore apply. restoreStage() downloads + verifies a snapshot
// into userData/restore-staging and writes pending-restore.json; the desktop
// main calls applyPendingRestore() in app.whenReady BEFORE the first DB open
// (migrate()), so no handle is live while files are swapped. The replaced
// files are moved — never deleted — into userData/pre-restore-<ts>/ so a bad
// restore is itself reversible by hand.
//
// Electron-free so the same code is unit-tested against mkdtemp trees.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { log } from '../log.js';
import { remintDeviceIdentityAt, type RemintResult } from '../sync-log/remint.js';
import type { PendingRestore } from './types.js';

const alog = log.for('backup-apply');

export const PENDING_RESTORE_FILE = 'pending-restore.json';
export const RESTORE_APPLIED_FILE = 'restore-applied.json';
export const PENDING_RENDERER_SETTINGS_FILE = 'pending-renderer-settings.json';

export interface RestoreApplied {
	snapshotId: string;
	appliedAt: number;
	preRestoreDir: string;
	remap: { from: string; to: string } | null;
	// Staged tokens.enc moved here for main to decrypt + import (then delete).
	tokens: string | null;
	error: string | null;
}

export function readPendingRestore(userDataDir: string): PendingRestore | null {
	const p = join(userDataDir, PENDING_RESTORE_FILE);
	if (!existsSync(p)) return null;
	try { return JSON.parse(readFileSync(p, 'utf8')) as PendingRestore; }
	catch { return null; }
}

export async function readRestoreApplied(userDataDir: string): Promise<RestoreApplied | null> {
	const p = join(userDataDir, RESTORE_APPLIED_FILE);
	if (!existsSync(p)) return null;
	try { return JSON.parse(await readFile(p, 'utf8')) as RestoreApplied; }
	catch { return null; }
}

export async function clearRestoreApplied(userDataDir: string): Promise<void> {
	await rm(join(userDataDir, RESTORE_APPLIED_FILE), { force: true });
}

// Move `live` (plus a SQLite file's -wal/-shm sidecars) into the pre-restore
// folder, then move the staged file in. rename() within one volume is
// atomic and instant even for a 3 GB peaks directory.
async function swapIn(from: string, to: string, kind: 'file' | 'dir', preDir: string): Promise<void> {
	const park = join(preDir, basename(to));
	const sidecars = kind === 'file' && /\.db$/i.test(to) ? ['-wal', '-shm', '-journal'] : [];
	if (existsSync(to)) {
		await mkdir(dirname(park), { recursive: true });
		await rename(to, park);
	}
	for (const s of sidecars) {
		if (existsSync(`${to}${s}`)) await rename(`${to}${s}`, `${park}${s}`);
	}
	await mkdir(dirname(to), { recursive: true });
	await rename(from, to);
}

export async function applyPendingRestore(userDataDir: string): Promise<RestoreApplied | null> {
	const markerPath = join(userDataDir, PENDING_RESTORE_FILE);
	if (!existsSync(markerPath)) return null;
	let marker: PendingRestore;
	try {
		marker = JSON.parse(await readFile(markerPath, 'utf8')) as PendingRestore;
	} catch (err) {
		alog.error('unreadable pending-restore.json — ignoring it', err instanceof Error ? err : undefined);
		await rm(markerPath, { force: true });
		return null;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const preDir = join(userDataDir, `pre-restore-${stamp}`);
	await mkdir(preDir, { recursive: true });
	const applied: RestoreApplied = { snapshotId: marker.snapshotId, appliedAt: Date.now(), preRestoreDir: preDir, remap: marker.remap, tokens: null, error: null };
	alog.info('applying staged restore', { snapshotId: marker.snapshotId, moves: marker.moves.length, preDir });
	try {
		for (const mv of marker.moves) {
			if (!existsSync(mv.from)) throw new Error(`staged file missing: ${mv.from}`);
			await swapIn(mv.from, mv.to, mv.kind, preDir);
		}
		if (marker.rendererSettings && existsSync(marker.rendererSettings)) {
			await rename(marker.rendererSettings, join(userDataDir, PENDING_RENDERER_SETTINGS_FILE));
		}
		if (marker.tokens && existsSync(marker.tokens)) {
			const dest = join(userDataDir, 'restored-tokens.enc');
			await rename(marker.tokens, dest);
			applied.tokens = dest;
		}
	} catch (err) {
		// Stop where we are: whatever moved is in place, whatever did not is
		// untouched, and the parked originals are intact for a manual undo.
		applied.error = err instanceof Error ? err.message : String(err);
		alog.error('restore apply failed part-way', err instanceof Error ? err : undefined, { preDir });
	}
	await writeFile(join(userDataDir, RESTORE_APPLIED_FILE), JSON.stringify(applied, null, '\t'), 'utf8');
	// The marker goes last: a crash before this point re-runs the apply on
	// the next boot (moves of already-moved files fail loudly, nothing is
	// lost); a crash after it leaves a complete restore.
	await rm(markerPath, { force: true });
	// Staging leftovers (sets that were downloaded but not moved).
	await rm(join(userDataDir, 'restore-staging', marker.snapshotId), { force: true, recursive: true }).catch(() => { /* best effort */ });
	return applied;
}

// Prefix remap of every local file path after tracks were restored under a
// new root. Paths are stored normalized (forward slashes, lowercase drive —
// local/scanner.ts normalizePath), so a plain prefix compare is exact.
export function remapLocalPaths(sqlite: Database.Database, from: string, to: string): { links: number; folders: number } {
	const f = from.replace(/\/+$/, '');
	const t = to.replace(/\/+$/, '');
	if (!f || f === t) return { links: 0, folders: 0 };
	return sqlite.transaction(() => {
		const links = sqlite.prepare(`
			UPDATE source_link SET file_path = ? || substr(file_path, length(?) + 1)
			WHERE source = 'local' AND file_path IS NOT NULL AND substr(file_path, 1, length(?) + 1) = ? || '/'
		`).run(t, f, f, f).changes;
		const folders = sqlite.prepare(`
			UPDATE library_folder SET path = ? || substr(path, length(?) + 1)
			WHERE path = ? OR substr(path, 1, length(?) + 1) = ? || '/'
		`).run(t, f, f, f, f).changes;
		return { links, folders };
	})();
}

export function remapLocalPathsAt(dbPath: string, from: string, to: string): { links: number; folders: number } {
	const db = new Database(dbPath);
	try { return remapLocalPaths(db, from, to); }
	finally { db.close(); }
}

// A restored database must not keep the sync identity of the machine it was
// backed up on (sync-log/remint.ts). Called after migrate() on every boot
// while the restore's record exists — not only the boot that swapped the
// files — so a crash in between is caught; the re-mint itself runs once per
// restore. Also after a restore that stopped part-way: whether curator.db
// was swapped in cannot be told reliably (a fresh machine has nothing to
// park), and a needless re-mint costs only a new device id.
export function remintAfterRestoreAt(dbPath: string, applied: RestoreApplied): RemintResult {
	return remintDeviceIdentityAt(dbPath, `${applied.snapshotId}@${applied.appliedAt}`);
}
