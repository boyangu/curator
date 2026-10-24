// The work-dir copies of the live library. Both sources are opened read-only
// or not opened at all; the copies are what every later step writes to.

import { constants, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// curator.db as the backup engine snapshots it (core backup/engine.ts
// snapshotEntry): VACUUM INTO from a read-only handle (SQLITE_OPEN_READONLY,
// what `?mode=ro` asks for), so the copy is one consistent point in time
// even while the app has it open, then the OAuth tokens deleted with
// secure_delete on, so no token byte survives in the copy's free pages
// (CLAUDE.md: a copy with live tokens is not a sandbox). Unlike the backup
// engine there is no read-write fallback: a source that cannot be read
// read-only is an error here, never a reason to open it for writing.
export function copyCuratorDb(src: string, dest: string): { bytes: number; tokensRemoved: number; ms: number } {
	const t0 = Date.now();
	if (existsSync(dest)) throw new Error(`copy target already exists: ${dest}`);
	const ro = new Database(src, { readonly: true, fileMustExist: true });
	try {
		ro.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
	} finally {
		ro.close();
	}
	const copy = new Database(dest);
	let tokensRemoved = 0;
	try {
		copy.pragma('secure_delete = ON');
		const hasToken = copy.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'token'`).get() !== undefined;
		if (hasToken) tokensRemoved = copy.prepare(`DELETE FROM token`).run().changes;
		copy.pragma('journal_mode = DELETE');
	} finally {
		copy.close();
	}
	return { bytes: statSync(dest).size, tokensRemoved, ms: Date.now() - t0 };
}

// The minimal masterPlaylists6.xml pyrekordbox needs beside a master.db
// (apps/rekordbox/tests/test_content_create.py): rekordbox's real one names
// the live library's playlists and is not ours to copy around.
export const MASTER_PLAYLISTS_XML =
	'<?xml version="1.0" encoding="utf-8"?>\n'
	+ '<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">\n'
	+ '<PRODUCT Name="rekordbox" Version="7.2.19" Company="Pioneer DJ"/>\n'
	+ '<PLAYLISTS>\n</PLAYLISTS>\n</MASTER_PLAYLIST>\n';

const SIDECARS = ['-wal', '-shm', '-journal'] as const;

// master.db as the sidecar's snapshot_db_to_temp copies it (reader.py): the
// file and whichever -wal / -shm / -journal exist, together, so a WAL-mode
// database stays consistent. Plain file copies (never an open): each file is
// stat'ed before and after and copied again if it moved, as the backup
// engine does for rekordbox's trio. `share/` stays empty (the ANLZ tree is
// gigabytes and Curator never writes it on an update push).
export function copyRekordbox(srcDb: string, destDir: string): { files: string[]; bytes: number; warning: string | null } {
	if (existsSync(join(destDir, 'master.db'))) throw new Error(`copy target already exists: ${join(destDir, 'master.db')}`);
	mkdirSync(join(destDir, 'share'), { recursive: true });
	const files: string[] = [];
	let bytes = 0;
	let warning: string | null = null;
	const pairs: Array<[string, string]> = [[srcDb, join(destDir, 'master.db')]];
	for (const s of SIDECARS) if (existsSync(srcDb + s)) pairs.push([srcDb + s, join(destDir, `master.db${s}`)]);
	for (let attempt = 0; attempt < 3; attempt++) {
		const before = pairs.map(([s]) => statSync(s)).map((st) => `${st.size}:${st.mtimeMs}`).join('|');
		for (const [s, d] of pairs) copyFileSync(s, d, attempt === 0 ? constants.COPYFILE_EXCL : 0);
		const after = pairs.map(([s]) => statSync(s)).map((st) => `${st.size}:${st.mtimeMs}`).join('|');
		if (before === after) break;
		if (attempt === 2) warning = 'master.db changed while being copied (rekordbox running?); the copy may be torn';
	}
	for (const [, d] of pairs) { files.push(d); bytes += statSync(d).size; }
	writeFileSync(join(destDir, 'masterPlaylists6.xml'), MASTER_PLAYLISTS_XML, 'utf8');
	return { files, bytes, warning };
}
