// Data-set collectors: what each toggle in "which data to backup" covers,
// as a flat list of files with the root they are relative to. Also the
// inverse — where a manifest entry lands on restore — and the per-type
// compression rule.
//
// Paths in manifests are normalized the way the scanner stores them
// (forward slashes, lowercase drive letter) so a remap on restore is a plain
// prefix replace. Node's fs accepts forward slashes on Windows, so the same
// strings are used for I/O.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { normalizePath } from '../local/scanner.js';
import type { BackupEncoding, BackupEngineConfig, BackupManifest, BackupManifestEntry, BackupSetId } from './types.js';

export interface FileEntry {
	set: BackupSetId;
	rel?: string;
	abs?: string;
	root?: string;
	// Where the bytes are read from. For DB snapshots this is rewritten to
	// the staged copy once the snapshot phase has run.
	srcPath: string;
	size: number;
	mtimeMs: number;
	// Consistent-copy requirement: 'vacuum' = SQLite VACUUM INTO (our own
	// WAL DBs); 'copy' = plain copy with a torn-write check (rekordbox's
	// SQLCipher trio, which we can't open).
	snapshot?: { kind: 'vacuum'; stripTokens: boolean } | { kind: 'copy' };
}

export interface CollectResult {
	entries: FileEntry[];
	roots: BackupManifest['roots'];
	warnings: string[];
}

// The four Curator DBs that live beside curator.db. mir.db is its own set.
export const CORE_DB_FILES = ['curator.db', 'feed.db', 'knowledge.db', 'agent.db'] as const;
const CORE_EXTRA_FILES = ['renderer-settings.json', 'write-audit.jsonl', 'agent-config.json', 'tokens.enc'] as const;

// Rekordbox's own files beside master.db that are part of the library (not
// its backup rotations, not Curator's pre-push copies, not caches).
const RB_DB_DIR_FILES = ['master.db', 'master.db-wal', 'master.db-shm', 'masterPlaylists6.xml', 'automixPlaylist6.xml', 'smartlist.xml', 'datafile.edb', 'ExtData.edb', 'playlists3.sync'] as const;
// rekordbox6/: preferences + the My Settings / mappings that make rekordbox
// open identically. Licenses, auth tokens, logs, model weights and the
// Beatport/EBWebView caches are deliberately not here.
const RB_SETTINGS_EXACT = new Set(['browseSetting.xml', 'EditSettings.xml', 'MYSETTING.DAT', 'MYSETTING2.DAT', 'DEVSETTING.DAT', 'DJMMYSETTING.DAT', 'djprofile.nxs', 'rekordbox_export_settings.json', 'cue_personal_trend.json']);
const RB_SETTINGS_PATTERNS = [/\.settings$/i, /Settings\d*\.xml$/];
const RB_SETTINGS_DIRS = ['KeyMappings', 'MidiMappings'];

// Already-compressed or encrypted: zstd would only burn CPU.
const RAW_EXTS = new Set(['.flac', '.wav', '.aif', '.aiff', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.zst', '.gz', '.zip']);

export function encodingFor(path: string): BackupEncoding {
	const base = basename(path).toLowerCase();
	if (base.startsWith('master.db')) return 'raw'; // SQLCipher — incompressible
	return RAW_EXTS.has(extname(base)) ? 'raw' : 'zstd';
}

function rekordboxDir(cfg: BackupEngineConfig): string | null {
	return cfg.rekordboxDbPath ? dirname(cfg.rekordboxDbPath) : null;
}

// Where an entry's bytes live on THIS machine (backup source and restore
// destination alike).
export function resolveEntryPath(cfg: BackupEngineConfig, e: Pick<BackupManifestEntry, 'set' | 'rel' | 'abs'>): string | null {
	switch (e.set) {
		case 'core':
			if (!e.rel) return null;
			return (CORE_DB_FILES as readonly string[]).includes(e.rel) ? join(cfg.dbDir, e.rel) : join(cfg.userDataDir, e.rel);
		case 'embeddings': return e.rel ? join(cfg.dbDir, e.rel) : null;
		case 'peaks': return e.rel ? join(cfg.peaksDir, e.rel) : null;
		case 'covers': return e.rel ? join(cfg.coversDir, e.rel) : null;
		case 'rekordboxDb': {
			if (!e.rel) return null;
			if (e.rel.startsWith('settings/')) return cfg.rekordboxSettingsDir ? join(cfg.rekordboxSettingsDir, e.rel.slice('settings/'.length)) : null;
			const dir = rekordboxDir(cfg);
			return dir ? join(dir, e.rel) : null;
		}
		case 'rekordboxAnalysis': {
			const dir = rekordboxDir(cfg);
			return dir && e.rel ? join(dir, e.rel) : null;
		}
		case 'tracks': return e.abs ?? null;
	}
}

async function fileEntry(set: BackupSetId, srcPath: string, rel: string | undefined, extra?: Partial<FileEntry>): Promise<FileEntry | null> {
	try {
		const s = await stat(srcPath);
		if (!s.isFile()) return null;
		return { set, rel, srcPath, size: s.size, mtimeMs: Math.floor(s.mtimeMs), ...extra };
	} catch {
		return null;
	}
}

async function walkFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const dirents = await readdir(root, { recursive: true, withFileTypes: true });
	const out: string[] = [];
	for (const d of dirents) {
		if (!d.isFile()) continue;
		// Node 22 puts the containing directory in `parentPath`.
		out.push(join(d.parentPath ?? (d as unknown as { path: string }).path, d.name));
	}
	return out;
}

function relTo(root: string, abs: string): string {
	const r = normalizePath(root).replace(/\/+$/, '');
	const a = normalizePath(abs);
	return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a;
}

// Local files the library references, straight from curator.db (read-only
// connection — the worker never writes to the live DB). A link flagged
// missing_at is a vanished file kept as a re-bind hint (scanner.ts), not a
// file to back up.
export function listLocalTracks(curatorDbPath: string): { files: Array<{ path: string; size: number | null; mtime: number | null }>; roots: string[] } {
	const db = new Database(curatorDbPath, { readonly: true, fileMustExist: true });
	try {
		const files = db.prepare(`
			SELECT sl.file_path AS path, sl.file_size AS size, sl.file_mtime AS mtime
			FROM source_link sl JOIN track t ON t.id = sl.track_id
			WHERE sl.source = 'local' AND sl.file_path IS NOT NULL AND sl.missing_at IS NULL AND t.deleted_at IS NULL
		`).all() as Array<{ path: string; size: number | null; mtime: number | null }>;
		const roots = (db.prepare(`SELECT path FROM library_folder`).all() as Array<{ path: string }>).map((r) => normalizePath(r.path).replace(/\/+$/, ''));
		return { files, roots };
	} finally {
		db.close();
	}
}

export async function collectSets(cfg: BackupEngineConfig, sets: readonly BackupSetId[]): Promise<CollectResult> {
	const entries: FileEntry[] = [];
	const warnings: string[] = [];
	const want = new Set(sets);
	const rbDir = rekordboxDir(cfg);
	const roots: BackupManifest['roots'] = {
		userData: normalizePath(cfg.userDataDir),
		rekordboxDir: rbDir ? normalizePath(rbDir) : null,
		rekordboxSettingsDir: cfg.rekordboxSettingsDir ? normalizePath(cfg.rekordboxSettingsDir) : null,
		libraryFolders: [],
	};

	if (want.has('core')) {
		for (const name of CORE_DB_FILES) {
			const e = await fileEntry('core', join(cfg.dbDir, name), name, { snapshot: { kind: 'vacuum', stripTokens: name === 'curator.db' } });
			if (e) entries.push(e);
			else if (name === 'curator.db') throw new Error(`curator.db not found at ${cfg.dbDir}`);
		}
		for (const name of CORE_EXTRA_FILES) {
			const e = await fileEntry('core', join(cfg.userDataDir, name), name);
			if (e) entries.push(e);
		}
	}
	if (want.has('embeddings')) {
		const e = await fileEntry('embeddings', join(cfg.dbDir, 'mir.db'), 'mir.db', { snapshot: { kind: 'vacuum', stripTokens: false } });
		if (e) entries.push(e);
	}
	if (want.has('peaks')) {
		for (const tier of ['lo', 'hi']) {
			const dir = join(cfg.peaksDir, tier);
			let names: string[] = [];
			try { names = await readdir(dir); } catch { /* no peaks yet */ }
			for (const name of names) {
				if (!name.endsWith('.cpk')) continue;
				const e = await fileEntry('peaks', join(dir, name), `${tier}/${name}`);
				if (e) entries.push(e);
			}
		}
	}
	if (want.has('covers')) {
		let names: string[] = [];
		try { names = await readdir(cfg.coversDir); } catch { /* none */ }
		for (const name of names) {
			const e = await fileEntry('covers', join(cfg.coversDir, name), name);
			if (e) entries.push(e);
		}
	}
	if (want.has('rekordboxDb')) {
		if (!rbDir) warnings.push('rekordbox database not found — rekordbox DB set skipped');
		else {
			for (const name of RB_DB_DIR_FILES) {
				const e = await fileEntry('rekordboxDb', join(rbDir, name), name, name.startsWith('master.db') ? { snapshot: { kind: 'copy' } } : {});
				if (e) entries.push(e);
			}
			if (cfg.rekordboxSettingsDir && existsSync(cfg.rekordboxSettingsDir)) {
				const names = await readdir(cfg.rekordboxSettingsDir, { withFileTypes: true });
				for (const d of names) {
					if (d.isFile() && (RB_SETTINGS_EXACT.has(d.name) || RB_SETTINGS_PATTERNS.some((p) => p.test(d.name)))) {
						const e = await fileEntry('rekordboxDb', join(cfg.rekordboxSettingsDir, d.name), `settings/${d.name}`);
						if (e) entries.push(e);
					}
				}
				for (const sub of RB_SETTINGS_DIRS) {
					for (const f of await walkFiles(join(cfg.rekordboxSettingsDir, sub))) {
						const e = await fileEntry('rekordboxDb', f, `settings/${relTo(cfg.rekordboxSettingsDir, f)}`);
						if (e) entries.push(e);
					}
				}
			}
		}
	}
	if (want.has('rekordboxAnalysis')) {
		if (!rbDir) warnings.push('rekordbox database not found — rekordbox analysis set skipped');
		else {
			for (const sub of ['share/PIONEER/USBANLZ', 'share/PIONEER/Artwork']) {
				for (const f of await walkFiles(join(rbDir, sub))) {
					const e = await fileEntry('rekordboxAnalysis', f, relTo(rbDir, f));
					if (e) entries.push(e);
				}
			}
		}
	}
	if (want.has('tracks')) {
		const { files, roots: libRoots } = listLocalTracks(join(cfg.dbDir, 'curator.db'));
		roots.libraryFolders = libRoots;
		let missing = 0;
		for (const f of files) {
			const abs = normalizePath(f.path);
			const e = await fileEntry('tracks', abs, undefined, { abs, root: libRoots.find((r) => abs.startsWith(`${r}/`)) ?? dirname(abs) });
			if (e) entries.push(e);
			else missing++;
		}
		if (missing) warnings.push(`${missing} library file(s) are missing on disk and were not backed up`);
	}
	return { entries, roots, warnings };
}
