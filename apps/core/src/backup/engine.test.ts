// Backup engine against a FolderTarget in mkdtemp: snapshot / unchanged /
// change-gating / retention + GC / resume / cancel / restore paths. Every
// path here is generated — nothing touches real data (CLAUDE.md).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../db/migrate.js';
import { normalizePath } from '../local/scanner.js';
import { BackupEngine } from './engine.js';
import { applyPendingRestore, remapLocalPathsAt } from './apply.js';
import { createFolderTarget } from './targets/folder.js';
import { targetIdFor } from './targets/index.js';
import { zstdDecompressBuffer } from './util.js';
import type { BackupEngineConfig, BackupManifest, BackupSetId, BackupTargetConfig } from './types.js';

let root: string;
let userData: string;
let targetDir: string;
let music: string;
let cfg: BackupEngineConfig;
let targetCfg: BackupTargetConfig;
let engine: BackupEngine;

const ALL_SETS: BackupSetId[] = ['core', 'peaks', 'embeddings', 'covers', 'rekordboxDb', 'rekordboxAnalysis', 'tracks'];

function write(path: string, content: Buffer | string): void {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, content);
}

function bytes(n: number, seed: number): Buffer {
	const b = Buffer.alloc(n);
	for (let i = 0; i < n; i++) b[i] = (i * 31 + seed * 17) & 0xff;
	return b;
}

function tokenCount(dbPath: string): number {
	const db = new Database(dbPath, { readonly: true });
	try { return (db.prepare(`SELECT COUNT(*) n FROM token`).get() as { n: number }).n; }
	finally { db.close(); }
}

async function manifestOf(id: string): Promise<BackupManifest> {
	const t = createFolderTarget(targetIdFor(targetCfg), targetDir);
	await t.init(cfg.libraryId);
	const raw = await t.getFile(`snapshots/${id}.json.zst`);
	return JSON.parse((await zstdDecompressBuffer(raw!)).toString('utf8')) as BackupManifest;
}

function listObjects(): string[] {
	const dir = join(targetDir, 'curator-backup', cfg.libraryId, 'objects');
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((shard) => readdirSync(join(dir, shard)));
}

function listSnapshotFiles(): string[] {
	return readdirSync(join(targetDir, 'curator-backup', cfg.libraryId, 'snapshots')).filter((f) => f.endsWith('.json.zst'));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'curator-backup-'));
	userData = join(root, 'userData');
	targetDir = join(root, 'target');
	music = normalizePath(join(root, 'music'));
	mkdirSync(userData, { recursive: true });
	// Library DB with a token row (must be stripped), a local track + folder.
	migrate(join(userData, 'curator.db'));
	const db = new Database(join(userData, 'curator.db'));
	db.prepare(`INSERT INTO token (source, kind, scope, value, fetched_at) VALUES ('spotify', 'access', 'user', 'SECRET-TOKEN', ?)`).run(Date.now());
	db.prepare(`INSERT INTO track (id, title, artists, duration, state) VALUES ('t1', 'Track One', '[]', 300, 'unsorted')`).run();
	const flac = `${music}/sub/one.flac`;
	write(flac, bytes(200_000, 1));
	db.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, file_mtime, file_size) VALUES ('sl1', 't1', 'local', ?, ?, 1000, 200000)`).run(flac, flac);
	db.prepare(`INSERT INTO library_folder (id, path, watching, scan_state, added_at) VALUES ('f1', ?, 1, 'idle', ?)`).run(music, Date.now());
	db.close();
	// Sibling DBs.
	for (const name of ['feed.db', 'knowledge.db', 'agent.db', 'mir.db']) {
		const d = new Database(join(userData, name));
		d.pragma('journal_mode = WAL');
		d.exec(`CREATE TABLE t (x TEXT)`);
		d.prepare(`INSERT INTO t VALUES (?)`).run(name);
		d.close();
	}
	// Peaks, covers, misc userData files.
	write(join(userData, 'peaks', 'lo', 't1.cpk'), bytes(5_000, 2));
	write(join(userData, 'peaks', 'hi', 't1.cpk'), bytes(50_000, 3));
	write(join(userData, 'covers', 'abc.jpg'), bytes(3_000, 4));
	write(join(userData, 'write-audit.jsonl'), '{"a":1}\n');
	write(join(userData, 'logs', 'curator.jsonl'), 'should not be backed up\n');
	// Fake rekordbox tree.
	const rb = join(root, 'rekordbox');
	write(join(rb, 'master.db'), bytes(40_000, 5));
	write(join(rb, 'masterPlaylists6.xml'), '<playlists/>');
	write(join(rb, 'master_2026-01-01T00-00-00.db'), bytes(1_000, 6)); // Curator's own pre-push copy — excluded
	write(join(rb, 'share', 'PIONEER', 'USBANLZ', 'abc', 'def-ghi', 'ANLZ0000.DAT'), bytes(2_000, 7));
	write(join(rb, 'share', 'PIONEER', 'USBANLZ', 'abc', 'def-ghi', 'ANLZ0000.EXT'), bytes(20_000, 8));
	write(join(rb, 'share', 'PIONEER', 'Artwork', 'abc', 'def-ghi', 'artwork.jpg'), bytes(1_500, 9));
	const rb6 = join(root, 'rekordbox6');
	write(join(rb6, 'rekordbox3.settings'), 'settings');
	write(join(rb6, 'MYSETTING.DAT'), bytes(148, 10));
	write(join(rb6, 'KeyMappings', 'ddj.xml'), '<map/>');
	write(join(rb6, 'lservrc'), 'LICENSE — must not be backed up');
	write(join(rb6, 'Tidal.log'), 'log — must not be backed up');

	cfg = {
		userDataDir: userData, dbDir: userData, peaksDir: join(userData, 'peaks'), coversDir: join(userData, 'covers'),
		libraryId: 'lib-test', hostname: 'test-host', platform: process.platform, appVersion: '0.0.0-test',
		rekordboxDbPath: join(rb, 'master.db'), rekordboxSettingsDir: rb6,
	};
	targetCfg = { kind: 'folder', path: normalizePath(targetDir) };
	engine = new BackupEngine(cfg);
});

afterEach(() => {
	engine.close();
	rmSync(root, { recursive: true, force: true });
});

async function run(sets: BackupSetId[] = ALL_SETS, keep = 7) {
	return engine.run({ runId: `run-${Date.now()}-${Math.random()}`, target: targetCfg, sets, keep });
}

describe('backup run', () => {
	it('writes a snapshot with every set, strips tokens, stores audio raw and excludes junk', async () => {
		const r = await run();
		expect(r.snapshotId).toBeTruthy();
		expect(r.unchanged).toBe(false);
		expect(r.newObjects).toBeGreaterThan(0);
		const m = await manifestOf(r.snapshotId!);
		expect(m.libraryId).toBe('lib-test');
		const rels = m.files.map((f) => `${f.set}:${f.rel ?? f.abs}`);
		expect(rels).toContain('core:curator.db');
		expect(rels).toContain('core:feed.db');
		expect(rels).toContain('core:write-audit.jsonl');
		expect(rels).toContain('embeddings:mir.db');
		expect(rels).toContain('peaks:lo/t1.cpk');
		expect(rels).toContain('peaks:hi/t1.cpk');
		expect(rels).toContain('covers:abc.jpg');
		expect(rels).toContain('rekordboxDb:master.db');
		expect(rels).toContain('rekordboxDb:masterPlaylists6.xml');
		expect(rels).toContain('rekordboxDb:settings/rekordbox3.settings');
		expect(rels).toContain('rekordboxDb:settings/MYSETTING.DAT');
		expect(rels).toContain('rekordboxDb:settings/KeyMappings/ddj.xml');
		expect(rels).toContain('rekordboxAnalysis:share/PIONEER/USBANLZ/abc/def-ghi/ANLZ0000.EXT');
		expect(rels).toContain('rekordboxAnalysis:share/PIONEER/Artwork/abc/def-ghi/artwork.jpg');
		expect(rels).toContain(`tracks:${music}/sub/one.flac`);
		expect(rels.some((x) => x.includes('master_2026'))).toBe(false);
		expect(rels.some((x) => x.includes('lservrc') || x.includes('Tidal.log') || x.includes('logs/'))).toBe(false);
		expect(rels.some((x) => x.includes('backup.db'))).toBe(false);
		// Compression by type.
		const flac = m.files.find((f) => f.set === 'tracks')!;
		expect(flac.enc).toBe('raw');
		expect(flac.root).toBe(music);
		expect(m.files.find((f) => f.rel === 'master.db')!.enc).toBe('raw');
		expect(m.files.find((f) => f.rel === 'curator.db')!.enc).toBe('zstd');
		// The raw object is byte-identical to the source; the DB copy has no tokens.
		const objDir = join(targetDir, 'curator-backup', 'lib-test', 'objects');
		expect(readFileSync(join(objDir, flac.sha256.slice(0, 2), flac.sha256)).equals(bytes(200_000, 1))).toBe(true);
		const cur = m.files.find((f) => f.rel === 'curator.db')!;
		const copy = join(root, 'curator-copy.db');
		writeFileSync(copy, await zstdDecompressBuffer(readFileSync(join(objDir, cur.sha256.slice(0, 2), cur.sha256))));
		expect(tokenCount(copy)).toBe(0);
		expect(tokenCount(join(userData, 'curator.db'))).toBe(1); // the live DB is untouched
		// library.json + one manifest on the target; staging is clean.
		expect(existsSync(join(targetDir, 'curator-backup', 'lib-test', 'library.json'))).toBe(true);
		expect(listSnapshotFiles()).toHaveLength(1);
		expect(readdirSync(join(userData, 'backup-staging'))).toHaveLength(0);
	});

	it('reports unchanged and writes no manifest when nothing changed', async () => {
		const a = await run();
		const b = await run();
		expect(b.unchanged).toBe(true);
		expect(b.snapshotId).toBeNull();
		expect(b.newObjects).toBe(0);
		expect(listSnapshotFiles()).toEqual([`${a.snapshotId}.json.zst`]);
	});

	it('uploads exactly the changed object on a changed file', async () => {
		await run();
		const before = listObjects().length;
		writeFileSync(join(userData, 'peaks', 'hi', 't1.cpk'), bytes(50_000, 99));
		const r = await run();
		expect(r.unchanged).toBe(false);
		expect(r.newObjects).toBe(1);
		expect(listObjects().length).toBe(before + 1);
		expect(listSnapshotFiles()).toHaveLength(2);
	});

	it('keeps the newest N plus pinned snapshots and GCs objects after the grace period', async () => {
		const s1 = await run(['core'], 7);
		await engine.pin(targetCfg, s1.snapshotId!, 'before the thing');
		writeFileSync(join(userData, 'write-audit.jsonl'), 'v2\n');
		const s2 = await run(['core'], 7);
		writeFileSync(join(userData, 'write-audit.jsonl'), 'v3\n');
		const s3 = await run(['core'], 7);
		writeFileSync(join(userData, 'write-audit.jsonl'), 'v4\n');
		const s4 = await run(['core'], 2);
		const left = listSnapshotFiles().map((f) => f.replace('.json.zst', '')).sort();
		expect(left).toEqual([s1.snapshotId, s3.snapshotId, s4.snapshotId].sort());
		expect(left).not.toContain(s2.snapshotId);
		const list = await engine.listSnapshots(targetCfg, { refresh: true });
		expect(list.find((s) => s.id === s1.snapshotId)?.pinned).toBe(true);
		expect(list.find((s) => s.id === s1.snapshotId)?.label).toBe('before the thing');
		// s2's unique object (write-audit v2) is unreferenced but within the
		// 48 h grace — still there.
		const m2sha = (await manifestOf(s3.snapshotId!)).files.find((f) => f.rel === 'write-audit.jsonl')!.sha256; // sanity: s3 object present
		expect(listObjects()).toContain(m2sha);
		const objCountBefore = listObjects().length;
		// Age every object past the grace period, run again: this run rotates
		// s3 out too (keep=2 → s5 + s4, plus pinned s1), so the v2 AND v3
		// orphans go while v5 arrives.
		const objDir = join(targetDir, 'curator-backup', 'lib-test', 'objects');
		const old = new Date(Date.now() - 3 * 24 * 3600_000);
		for (const shard of readdirSync(objDir)) for (const f of readdirSync(join(objDir, shard))) utimesSync(join(objDir, shard, f), old, old);
		writeFileSync(join(userData, 'write-audit.jsonl'), 'v5\n');
		const s5 = await run(['core'], 2);
		expect(listSnapshotFiles().map((f) => f.replace('.json.zst', '')).sort()).toEqual([s1.snapshotId, s4.snapshotId, s5.snapshotId].sort());
		expect(listObjects().length).toBe(objCountBefore - 1);
	});

	it('resumes after an interrupted upload without re-uploading finished objects', async () => {
		const target = createFolderTarget(targetIdFor(targetCfg), targetDir);
		let calls = 0;
		const origPut = target.putObject.bind(target);
		target.putObject = async (sha, src, o) => {
			if (++calls === 3) throw new Error('simulated network drop');
			return origPut(sha, src, o);
		};
		// Hand the engine the flaky target by overriding the factory seam.
		const flaky = new BackupEngine(cfg);
		(flaky as unknown as { openTarget: unknown }).openTarget = async () => {
			await target.init(cfg.libraryId);
			return { target, targetId: target.id, indexBuilt: false };
		};
		await expect(flaky.run({ runId: 'r1', target: targetCfg, sets: ['core', 'peaks'], keep: 7 })).rejects.toThrow('simulated network drop');
		const uploadedAfterCrash = listObjects().length;
		expect(uploadedAfterCrash).toBeGreaterThan(0);
		flaky.close();
		const r = await run(['core', 'peaks']);
		expect(r.unchanged).toBe(false);
		// Everything the crashed run finished was reused.
		expect(r.newObjects).toBe(listObjects().length - uploadedAfterCrash);
	});

	it('cancels cleanly and the next run completes', async () => {
		const target = createFolderTarget(targetIdFor(targetCfg), targetDir);
		const origPut = target.putObject.bind(target);
		const e2 = new BackupEngine(cfg);
		target.putObject = async (sha, src, o) => {
			e2.cancel('r-cancel');
			return origPut(sha, src, o);
		};
		(e2 as unknown as { openTarget: unknown }).openTarget = async () => {
			await target.init(cfg.libraryId);
			return { target, targetId: target.id, indexBuilt: false };
		};
		const r = await e2.run({ runId: 'r-cancel', target: targetCfg, sets: ['core', 'peaks'], keep: 7 });
		expect(r.cancelled).toBe(true);
		expect(listSnapshotFiles()).toHaveLength(0);
		e2.close();
		const r2 = await run(['core', 'peaks']);
		expect(r2.cancelled).toBe(false);
		expect(r2.snapshotId).toBeTruthy();
	});

	it('lists, pins and deletes snapshots', async () => {
		const a = await run(['core']);
		writeFileSync(join(userData, 'write-audit.jsonl'), 'v2\n');
		const b = await run(['core']);
		let list = await engine.listSnapshots(targetCfg);
		expect(list.map((s) => s.id)).toEqual([b.snapshotId, a.snapshotId]);
		expect(list[0]!.sets).toEqual(['core']);
		expect(list[0]!.hostname).toBe('test-host');
		await engine.pin(targetCfg, a.snapshotId!, 'keep');
		expect(existsSync(join(targetDir, 'curator-backup', 'lib-test', 'pins', `${a.snapshotId}.json`))).toBe(true);
		list = await engine.listSnapshots(targetCfg);
		expect(list.find((s) => s.id === a.snapshotId)!.pinned).toBe(true);
		list = await engine.listSnapshots(targetCfg, { refresh: true });
		expect(list.find((s) => s.id === a.snapshotId)!.pinned).toBe(true);
		expect(list.find((s) => s.id === a.snapshotId)!.label).toBe('keep');
		await engine.pin(targetCfg, a.snapshotId!, null);
		list = await engine.listSnapshots(targetCfg, { refresh: true });
		expect(list.find((s) => s.id === a.snapshotId)!.pinned).toBe(false);
		await engine.deleteSnapshot(targetCfg, b.snapshotId!);
		list = await engine.listSnapshots(targetCfg, { refresh: true });
		expect(list.map((s) => s.id)).toEqual([a.snapshotId]);
	});
});

describe('restore', () => {
	it('stages Curator data and the boot-time apply swaps it in, parking the old files', async () => {
		const r = await run(['core', 'peaks', 'embeddings']);
		// Drift the live state after the snapshot.
		writeFileSync(join(userData, 'peaks', 'hi', 't1.cpk'), bytes(50_000, 42));
		writeFileSync(join(userData, 'peaks', 'hi', 'extra.cpk'), bytes(10, 43));
		const live = new Database(join(userData, 'curator.db'));
		live.prepare(`INSERT INTO track (id, title, artists, duration, state) VALUES ('t2', 'Later', '[]', 1, 'unsorted')`).run();
		live.close();

		const preview = await engine.restorePreview(targetCfg, r.snapshotId!);
		expect(preview.sets.core.present).toBe(true);
		expect(preview.sets.tracks.present).toBe(false);
		const st = await engine.restoreStage('rs1', targetCfg, { snapshotId: r.snapshotId!, sets: ['core', 'peaks', 'embeddings'] });
		expect(st.relaunchRequired).toBe(true);
		const marker = JSON.parse(readFileSync(join(userData, 'pending-restore.json'), 'utf8'));
		expect(marker.snapshotId).toBe(r.snapshotId);
		expect(marker.moves.some((m: { to: string }) => m.to.endsWith('curator.db'))).toBe(true);
		expect(marker.moves.some((m: { kind: string }) => m.kind === 'dir')).toBe(true);
		// Nothing live changed yet.
		expect(readFileSync(join(userData, 'peaks', 'hi', 't1.cpk')).equals(bytes(50_000, 42))).toBe(true);

		const applied = await applyPendingRestore(userData);
		expect(applied?.error).toBeNull();
		expect(existsSync(join(userData, 'pending-restore.json'))).toBe(false);
		expect(existsSync(join(userData, 'restore-applied.json'))).toBe(true);
		// Restored content: snapshot-time peaks, no "extra", DB without t2 and without tokens.
		expect(readFileSync(join(userData, 'peaks', 'hi', 't1.cpk')).equals(bytes(50_000, 3))).toBe(true);
		expect(existsSync(join(userData, 'peaks', 'hi', 'extra.cpk'))).toBe(false);
		const restored = new Database(join(userData, 'curator.db'), { readonly: true });
		expect((restored.prepare(`SELECT COUNT(*) n FROM track WHERE id = 't2'`).get() as { n: number }).n).toBe(0);
		expect((restored.prepare(`SELECT COUNT(*) n FROM token`).get() as { n: number }).n).toBe(0);
		restored.close();
		// The old files are parked, not deleted.
		const park = readdirSync(userData).find((f) => f.startsWith('pre-restore-'))!;
		expect(park).toBeTruthy();
		expect(readFileSync(join(userData, park, 'peaks', 'hi', 'extra.cpk')).length).toBe(10);
		const parked = new Database(join(userData, park, 'curator.db'), { readonly: true });
		expect((parked.prepare(`SELECT COUNT(*) n FROM track WHERE id = 't2'`).get() as { n: number }).n).toBe(1);
		parked.close();
	});

	it('refuses to apply a corrupted staged file and leaves the live files alone', async () => {
		const r = await run(['core']);
		await engine.restoreStage('rs2', targetCfg, { snapshotId: r.snapshotId!, sets: ['core'] });
		const marker = JSON.parse(readFileSync(join(userData, 'pending-restore.json'), 'utf8'));
		const curMove = marker.moves.find((m: { to: string }) => m.to.endsWith('curator.db'));
		rmSync(curMove.from); // staged copy vanished
		const liveBefore = statSync(join(userData, 'curator.db')).size;
		const applied = await applyPendingRestore(userData);
		expect(applied?.error).toMatch(/staged file missing/);
		expect(statSync(join(userData, 'curator.db')).size).toBe(liveBefore);
	});

	it('restores tracks under a new root with mtimes and remaps the library paths', async () => {
		const r = await run(['core', 'tracks']);
		const newRoot = normalizePath(join(root, 'music2'));
		const res = await engine.restoreTracks('rt1', targetCfg, { snapshotId: r.snapshotId!, sets: ['tracks'], tracks: { mode: 'root', root: newRoot } });
		expect(res.written).toBe(1);
		const dest = join(newRoot, 'sub', 'one.flac');
		expect(readFileSync(dest).equals(bytes(200_000, 1))).toBe(true);
		const srcMtime = Math.floor(statSync(`${music}/sub/one.flac`).mtimeMs);
		expect(Math.abs(Math.floor(statSync(dest).mtimeMs) - srcMtime)).toBeLessThan(1000);
		// Second pass skips the identical file.
		const again = await engine.restoreTracks('rt2', targetCfg, { snapshotId: r.snapshotId!, sets: ['tracks'], tracks: { mode: 'root', root: newRoot } });
		expect(again.skipped).toBe(1);
		const remapped = remapLocalPathsAt(join(userData, 'curator.db'), music, newRoot);
		expect(remapped).toEqual({ links: 1, folders: 1 });
		const db = new Database(join(userData, 'curator.db'), { readonly: true });
		expect((db.prepare(`SELECT file_path FROM source_link WHERE id = 'sl1'`).get() as { file_path: string }).file_path).toBe(`${newRoot}/sub/one.flac`);
		expect((db.prepare(`SELECT path FROM library_folder WHERE id = 'f1'`).get() as { path: string }).path).toBe(newRoot);
		db.close();
	});

	it('restores rekordbox files in place', async () => {
		const r = await run(['core', 'rekordboxDb', 'rekordboxAnalysis']);
		const rb = join(root, 'rekordbox');
		writeFileSync(join(rb, 'master.db'), bytes(40_000, 77));
		writeFileSync(join(rb, 'master.db-wal'), bytes(100, 78)); // stale sidecar must go
		writeFileSync(join(rb, 'share', 'PIONEER', 'USBANLZ', 'abc', 'def-ghi', 'ANLZ0000.EXT'), bytes(20_000, 79));
		writeFileSync(join(root, 'rekordbox6', 'MYSETTING.DAT'), bytes(148, 80));
		const res = await engine.restoreRekordbox('rr1', targetCfg, { snapshotId: r.snapshotId!, sets: ['rekordboxDb', 'rekordboxAnalysis'] });
		expect(res.files).toBeGreaterThan(0);
		expect(readFileSync(join(rb, 'master.db')).equals(bytes(40_000, 5))).toBe(true);
		expect(existsSync(join(rb, 'master.db-wal'))).toBe(false);
		expect(readFileSync(join(rb, 'share', 'PIONEER', 'USBANLZ', 'abc', 'def-ghi', 'ANLZ0000.EXT')).equals(bytes(20_000, 8))).toBe(true);
		expect(readFileSync(join(root, 'rekordbox6', 'MYSETTING.DAT')).equals(bytes(148, 10))).toBe(true);
	});
});
