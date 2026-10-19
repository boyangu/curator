// BackupEngine — the whole backup/restore pipeline, Electron-free. Runs in
// the backup worker utilityProcess in the desktop app (host.ts seam) and
// inline in tests. One op at a time; progress rides an EventEmitter.
//
// A backup run: collect → snapshot (VACUUM INTO our DBs, copy rekordbox's)
// → fingerprint + hash → plan (new objects; identical file list ⇒
// 'unchanged', nothing written) → stage + upload (zstd for compressible
// types, journaled for resume) → manifest → retention → GC. Everything on
// the target is content-addressed, so a snapshot only costs what changed and
// an interrupted run picks up where it stopped.

import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { log } from '../log.js';
import { normalizePath } from '../local/scanner.js';
import { BackupStore, type RunItemRow, type SnapshotCacheRow } from './store.js';
import { collectSets, encodingFor, resolveEntryPath, type FileEntry } from './sets.js';
import { createTarget, targetIdFor, type TargetDeps } from './targets/index.js';
import type { BackupTarget, ResumeToken } from './targets/types.js';
import { copyFileAtomic, decodeObjectToFile, freeBytesAt, isAbortError, parallel, sha256Buffer, sha256File, zstdCompressBuffer, zstdCompressFile, zstdDecompressBuffer } from './util.js';
import type {
	BackupEngineConfig, BackupEvent, BackupManifest, BackupManifestEntry, BackupPhase, BackupRestorePreview, BackupRestoreRequest,
	BackupRunPlan, BackupRunResult, BackupSetId, BackupSnapshotSummary, BackupTargetConfig, BackupTargetStat, PendingRestore,
} from './types.js';
import { BACKUP_SET_IDS } from './types.js';

const blog = log.for('backup');

const UPLOAD_PARALLEL = 4;
const HASH_PARALLEL = 2;
const DOWNLOAD_PARALLEL = 4;
// Objects a crashed run uploaded but never referenced survive this long so
// the next run reuses them instead of re-uploading.
const GC_GRACE_MS = 48 * 3600_000;
const JOURNAL_FLUSH_BYTES = 8 << 20;
const PROGRESS_THROTTLE_MS = 250;

const CURATOR_DATA_SETS: readonly BackupSetId[] = ['core', 'peaks', 'embeddings', 'covers'];
const REKORDBOX_SETS: readonly BackupSetId[] = ['rekordboxDb', 'rekordboxAnalysis'];

interface ActiveOp {
	runId: string;
	op: 'backup' | 'restore';
	abort: AbortController;
}

class AbortedError extends Error {
	override name = 'AbortError';
	constructor() { super('backup cancelled'); }
}

// Lexically sortable AND chronological down to the millisecond — retention
// ranks by createdAt, but listings elsewhere (the target's folder) must
// show the same order.
function newSnapshotId(now = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, '');
	return `${stamp}-${randomBytes(2).toString('hex')}`;
}

function entryKey(e: Pick<BackupManifestEntry, 'set' | 'rel' | 'abs'>): string {
	return `${e.set}|${e.rel ?? e.abs ?? ''}`;
}

function quoteSqlPath(p: string): string {
	return p.replace(/'/g, "''").replace(/\\/g, '/');
}

export class BackupEngine extends EventEmitter {
	private readonly store: BackupStore;
	private readonly stagingDir: string;
	private readonly restoreStagingDir: string;
	private readonly manifestCacheDir: string;
	private active: ActiveOp | null = null;

	constructor(private readonly cfg: BackupEngineConfig, private readonly deps: TargetDeps = {}) {
		super();
		this.store = new BackupStore(join(cfg.userDataDir, 'backup.db'));
		this.stagingDir = join(cfg.userDataDir, 'backup-staging');
		this.restoreStagingDir = join(cfg.userDataDir, 'restore-staging');
		this.manifestCacheDir = join(cfg.userDataDir, 'backup-cache');
		const stale = this.store.markStaleRuns();
		if (stale.length) blog.warn('runs left unfinished by a previous session', { runs: stale });
		this.store.setMeta('library_id', cfg.libraryId);
	}

	close(): void { this.store.close(); }

	subscribe(cb: (e: BackupEvent) => void): () => void {
		const handler = (e: BackupEvent): void => { try { cb(e); } catch (err) { blog.error('subscriber threw', err); } };
		this.on('event', handler);
		return () => { this.off('event', handler); };
	}

	private emitEvent(e: BackupEvent): void { this.emit('event', e); }

	isRunning(): boolean { return this.active != null; }

	cancel(runId: string): void {
		if (this.active?.runId === runId) this.active.abort.abort();
	}

	cancelActive(): void { this.active?.abort.abort(); }

	// ─── shared plumbing ────────────────────────────────────────────────

	private begin(runId: string, op: 'backup' | 'restore'): ActiveOp {
		if (this.active) throw new Error(`a ${this.active.op} is already running`);
		const a: ActiveOp = { runId, op, abort: new AbortController() };
		this.active = a;
		return a;
	}

	private progressReporter(a: ActiveOp): (phase: BackupPhase, p: { done: number; total: number; bytesDone: number; bytesTotal: number; current?: string | null }, force?: boolean) => void {
		let last = 0;
		let lastPhase: BackupPhase | null = null;
		return (phase, p, force = false) => {
			const now = Date.now();
			if (!force && phase === lastPhase && now - last < PROGRESS_THROTTLE_MS) return;
			last = now; lastPhase = phase;
			this.emitEvent({ kind: 'progress', runId: a.runId, op: a.op, phase, done: p.done, total: p.total, bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, current: p.current ?? null });
		};
	}

	private async openTarget(cfg: BackupTargetConfig): Promise<{ target: BackupTarget; targetId: string; indexBuilt: boolean }> {
		const target = createTarget(cfg, this.deps);
		await target.init(this.cfg.libraryId);
		const { indexBuilt } = this.store.ensureTarget(target.id, cfg);
		return { target, targetId: target.id, indexBuilt };
	}

	// The object index must mirror the target before a run can trust it:
	// first run against a target, or after a restore changed the library id.
	private async rebuildObjectIndex(target: BackupTarget): Promise<void> {
		blog.info('rebuilding object index from the target', { target: target.id });
		this.store.invalidateIndex(target.id);
		const rows = [];
		for await (const o of target.listObjects()) {
			rows.push({ sha256: o.sha256, size: 0, storedSize: o.storedSize, enc: 'raw', remoteId: o.remoteId, uploadedAt: o.createdAt });
		}
		this.store.putObjects(target.id, rows);
		this.store.markIndexBuilt(target.id);
	}

	private manifestCachePath(targetId: string, snapshotId: string): string {
		return join(this.manifestCacheDir, targetId.replace(/[^a-z0-9]/gi, '_'), `${snapshotId}.json.zst`);
	}

	private async getManifest(target: BackupTarget, snapshotId: string): Promise<BackupManifest | null> {
		const cache = this.manifestCachePath(target.id, snapshotId);
		let bytes: Buffer | null = null;
		if (existsSync(cache)) bytes = await readFile(cache);
		else {
			bytes = await target.getFile(`snapshots/${snapshotId}.json.zst`);
			if (bytes) { await mkdir(dirname(cache), { recursive: true }); await writeFile(cache, bytes); }
		}
		if (!bytes) return null;
		return JSON.parse((await zstdDecompressBuffer(bytes)).toString('utf8')) as BackupManifest;
	}

	// Re-sync the snapshot cache with the target: names + pins are cheap
	// listings; manifests are fetched only for snapshots we have not seen.
	private async refreshSnapshots(target: BackupTarget): Promise<SnapshotCacheRow[]> {
		const known = new Map(this.store.snapshots(target.id).map((s) => [s.snapshotId, s]));
		const files = await target.listFiles('snapshots');
		const pins = new Map<string, { label: string | null }>();
		for (const p of await target.listFiles('pins')) {
			const id = p.name.replace(/\.json$/, '');
			try {
				const raw = await target.getFile(`pins/${p.name}`);
				const parsed = raw ? (JSON.parse(raw.toString('utf8')) as { label?: string | null }) : {};
				pins.set(id, { label: parsed.label ?? null });
			} catch { pins.set(id, { label: null }); }
		}
		const rows: SnapshotCacheRow[] = [];
		for (const f of files) {
			if (!f.name.endsWith('.json.zst')) continue;
			const id = f.name.slice(0, -'.json.zst'.length);
			const pin = pins.get(id);
			const prev = known.get(id);
			if (prev) { rows.push({ ...prev, pinned: !!pin, label: pin?.label ?? null }); continue; }
			const m = await this.getManifest(target, id);
			if (!m) continue;
			rows.push({
				snapshotId: id, createdAt: m.createdAt, bytes: m.stats.bytes, files: m.stats.files,
				sets: BACKUP_SET_IDS.filter((s) => m.sets[s]), pinned: !!pin, label: pin?.label ?? null,
				hostname: m.machine.hostname, fileSig: fileSignature(m.files),
			});
		}
		rows.sort((a, b) => b.createdAt - a.createdAt || (a.snapshotId < b.snapshotId ? 1 : -1));
		this.store.replaceSnapshots(target.id, rows);
		return rows;
	}

	private toSummary(s: SnapshotCacheRow): BackupSnapshotSummary {
		return { id: s.snapshotId, createdAt: s.createdAt, bytes: s.bytes, files: s.files, sets: s.sets, pinned: s.pinned, label: s.label, hostname: s.hostname };
	}

	// ─── snapshot management ────────────────────────────────────────────

	async listSnapshots(cfg: BackupTargetConfig, opts: { refresh?: boolean } = {}): Promise<BackupSnapshotSummary[]> {
		const { target, targetId } = await this.openTarget(cfg);
		const cached = this.store.snapshots(targetId);
		const rows = opts.refresh || cached.length === 0 ? await this.refreshSnapshots(target) : cached;
		return rows.map((s) => this.toSummary(s));
	}

	async pin(cfg: BackupTargetConfig, snapshotId: string, label: string | null): Promise<void> {
		const { target, targetId } = await this.openTarget(cfg);
		if (label === null) {
			await target.deleteFile(`pins/${snapshotId}.json`);
			this.store.setPinned(targetId, snapshotId, false, null);
		} else {
			await target.putFile(`pins/${snapshotId}.json`, Buffer.from(JSON.stringify({ label, pinnedAt: Date.now() }), 'utf8'));
			this.store.setPinned(targetId, snapshotId, true, label);
		}
	}

	async deleteSnapshot(cfg: BackupTargetConfig, snapshotId: string): Promise<void> {
		const { target, targetId } = await this.openTarget(cfg);
		await target.deleteFile(`snapshots/${snapshotId}.json.zst`);
		await target.deleteFile(`pins/${snapshotId}.json`);
		this.store.deleteSnapshot(targetId, snapshotId);
		await rm(this.manifestCachePath(targetId, snapshotId), { force: true });
		// Orphaned objects are collected by the next run's GC (grace period
		// applies) — deleting a snapshot stays a cheap metadata operation.
	}

	async targetStat(cfg: BackupTargetConfig): Promise<BackupTargetStat> {
		const { target } = await this.openTarget(cfg);
		return target.stat();
	}

	// ─── backup run ─────────────────────────────────────────────────────

	async run(plan: BackupRunPlan): Promise<BackupRunResult> {
		const a = this.begin(plan.runId, 'backup');
		const signal = a.abort.signal;
		const startedAt = Date.now();
		const report = this.progressReporter(a);
		const warnings: string[] = [];
		let targetId = '';
		let bytesTotal = 0;
		let bytesDone = 0;
		try {
			this.emitEvent({ kind: 'started', runId: plan.runId, op: 'backup', sets: plan.sets });
			const opened = await this.openTarget(plan.target);
			const { target } = opened;
			targetId = opened.targetId;
			this.store.beginRun(plan.runId, targetId, 'backup');
			if (!opened.indexBuilt) await this.rebuildObjectIndex(target);
			await this.sweepStaging();

			// 1. collect
			report('collect', { done: 0, total: 0, bytesDone: 0, bytesTotal: 0 }, true);
			const collected = await collectSets(this.cfg, plan.sets);
			warnings.push(...collected.warnings);
			const entries = collected.entries;
			this.throwIfAborted(signal);

			// 2. consistent DB copies
			const objectShas = this.store.objectShas(targetId);
			const snapshotEntries = entries.filter((e) => e.snapshot);
			let i = 0;
			for (const e of snapshotEntries) {
				report('snapshot', { done: i++, total: snapshotEntries.length, bytesDone: 0, bytesTotal: 0, current: basename(e.srcPath) }, true);
				await this.snapshotEntry(e, targetId, objectShas, warnings);
				this.throwIfAborted(signal);
			}

			// 3. fingerprint + hash
			const fps = this.store.allFingerprints();
			const newFps: Array<{ path: string; size: number; mtimeMs: number; sha256: string }> = [];
			const shaOf = new Map<FileEntry, string>();
			const toHash: FileEntry[] = [];
			for (const e of entries) {
				if ((e as HashedEntry).sha256) { shaOf.set(e, (e as HashedEntry).sha256!); continue; }
				const key = normalizePath(e.srcPath);
				const fp = e.snapshot ? undefined : fps.get(key);
				if (fp && fp.size === e.size && fp.mtimeMs === e.mtimeMs) shaOf.set(e, fp.sha256);
				else toHash.push(e);
			}
			bytesTotal = toHash.reduce((n, e) => n + e.size, 0);
			let hashed = 0;
			report('hash', { done: 0, total: toHash.length, bytesDone: 0, bytesTotal }, true);
			await parallel(toHash, HASH_PARALLEL, signal, async (e) => {
				const sha = await sha256File(e.srcPath, signal, (n) => { bytesDone += n; report('hash', { done: hashed, total: toHash.length, bytesDone, bytesTotal, current: basename(e.srcPath) }); });
				shaOf.set(e, sha);
				hashed++;
				if (e.snapshot) {
					if (e.snapshot.kind === 'vacuum') this.store.putDbSnapshotFp((e as HashedEntry).liveFp!.path, { ...(e as HashedEntry).liveFp!, sha256: sha });
				} else newFps.push({ path: normalizePath(e.srcPath), size: e.size, mtimeMs: e.mtimeMs, sha256: sha });
			});
			this.throwIfAborted(signal);
			if (newFps.length) this.store.putFingerprints(newFps);

			// 4. plan
			const manifestEntries: BackupManifestEntry[] = entries.map((e) => ({
				set: e.set, ...(e.rel !== undefined ? { rel: e.rel } : {}), ...(e.abs !== undefined ? { abs: e.abs, root: e.root } : {}),
				sha256: shaOf.get(e)!, size: e.size, mtimeMs: e.mtimeMs, enc: encodingFor(e.rel ?? e.abs ?? e.srcPath), storedSize: 0,
			}));
			const sig = fileSignature(manifestEntries);
			const snapshots = await this.refreshSnapshots(target);
			const latest = snapshots[0];
			const uploads = new Map<string, FileEntry>();
			for (const e of entries) {
				const sha = shaOf.get(e)!;
				if (!objectShas.has(sha) && !uploads.has(sha)) uploads.set(sha, e);
			}
			if (latest && latest.fileSig === sig && uploads.size === 0) {
				await this.cleanupSnapshotStaging(entries);
				const result = this.finish(plan.runId, 'unchanged', { snapshotId: null, unchanged: true, cancelled: false, files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), newObjects: 0, newBytes: 0, warnings, durationMs: Date.now() - startedAt });
				this.emitEvent({ kind: 'completed', runId: plan.runId, op: 'backup', result });
				return result;
			}

			// 5. stage + upload (adopting the previous interrupted run's journal)
			const resumable = this.store.resumableItems(targetId);
			const items: RunItemRow[] = [...uploads.keys()].map((sha) => {
				const prev = resumable.get(sha);
				return { sha256: sha, state: 'pending', stagedPath: prev?.stagedPath && existsSync(prev.stagedPath) ? prev.stagedPath : null, resume: prev?.resume ?? null };
			});
			this.store.putRunItems(plan.runId, items);
			bytesTotal = [...uploads.values()].reduce((n, e) => n + e.size, 0);
			bytesDone = 0;
			let uploaded = 0;
			let newBytes = 0;
			const storedSizeOf = new Map<string, number>();
			report('upload', { done: 0, total: uploads.size, bytesDone: 0, bytesTotal }, true);
			await parallel(items, UPLOAD_PARALLEL, signal, async (item) => {
				const e = uploads.get(item.sha256)!;
				const enc = encodingFor(e.rel ?? e.abs ?? e.srcPath);
				let srcPath = e.srcPath;
				let storedSize = e.size;
				if (enc === 'zstd') {
					const staged = item.stagedPath ?? join(this.stagingDir, `${item.sha256}.zst`);
					if (!existsSync(staged)) await zstdCompressFile(e.srcPath, staged, signal);
					storedSize = (await stat(staged)).size;
					srcPath = staged;
					if (item.stagedPath !== staged) this.store.updateRunItem(plan.runId, item.sha256, { stagedPath: staged });
				}
				this.throwIfAborted(signal);
				this.store.updateRunItem(plan.runId, item.sha256, { state: 'uploading' });
				let lastFlushed = 0;
				let sentSoFar = 0;
				const { remoteId } = await target.putObject(item.sha256, { path: srcPath, size: storedSize }, {
					signal,
					resume: item.resume ?? undefined,
					onSession: (tok: ResumeToken) => this.store.updateRunItem(plan.runId, item.sha256, { resume: tok }),
					onProgress: (sent) => {
						// Progress is in stored bytes; the bar counts logical bytes.
						bytesDone += (sent - sentSoFar) * (storedSize ? e.size / storedSize : 1);
						sentSoFar = sent;
						if (sent - lastFlushed >= JOURNAL_FLUSH_BYTES) {
							lastFlushed = sent;
							this.store.updateRunItem(plan.runId, item.sha256, { resume: { ...(item.resume ?? {}), bytesSent: sent } });
						}
						report('upload', { done: uploaded, total: uploads.size, bytesDone: Math.min(bytesDone, bytesTotal), bytesTotal, current: basename(e.rel ?? e.abs ?? e.srcPath) });
					},
				});
				this.store.putObject(targetId, { sha256: item.sha256, size: e.size, storedSize, enc, remoteId, uploadedAt: Date.now() });
				objectShas.add(item.sha256);
				this.store.updateRunItem(plan.runId, item.sha256, { state: 'done', resume: null, stagedPath: null });
				storedSizeOf.set(item.sha256, storedSize);
				if (enc === 'zstd') await rm(srcPath, { force: true });
				uploaded++;
				newBytes += e.size;
				report('upload', { done: uploaded, total: uploads.size, bytesDone: Math.min(bytesDone, bytesTotal), bytesTotal, current: null }, true);
			});
			this.throwIfAborted(signal);

			// 6. manifest
			report('manifest', { done: 0, total: 1, bytesDone: 0, bytesTotal: 0 }, true);
			for (const m of manifestEntries) m.storedSize = storedSizeOf.get(m.sha256) ?? this.store.getObject(targetId, m.sha256)?.storedSize ?? m.size;
			const snapshotId = newSnapshotId();
			const manifest: BackupManifest = {
				formatVersion: 1, snapshotId, createdAt: Date.now(), libraryId: this.cfg.libraryId,
				machine: { hostname: this.cfg.hostname, platform: this.cfg.platform, appVersion: this.cfg.appVersion },
				sets: Object.fromEntries(BACKUP_SET_IDS.map((s) => [s, plan.sets.includes(s)])) as Record<BackupSetId, boolean>,
				roots: collected.roots, warnings, files: manifestEntries,
				stats: { files: manifestEntries.length, bytes: manifestEntries.reduce((n, m) => n + m.size, 0), storedBytes: manifestEntries.reduce((n, m) => n + m.storedSize, 0), newObjects: uploads.size, newBytes },
			};
			const manifestBytes = await zstdCompressBuffer(Buffer.from(JSON.stringify(manifest), 'utf8'));
			await target.putFile(`snapshots/${snapshotId}.json.zst`, manifestBytes);
			const cache = this.manifestCachePath(targetId, snapshotId);
			await mkdir(dirname(cache), { recursive: true });
			await writeFile(cache, manifestBytes);
			if (!(await target.getFile('library.json'))) {
				await target.putFile('library.json', Buffer.from(JSON.stringify({ formatVersion: 1, libraryId: this.cfg.libraryId, createdAt: Date.now(), hostname: this.cfg.hostname, appVersion: this.cfg.appVersion }, null, '\t'), 'utf8'));
			}
			this.store.putSnapshot(targetId, { snapshotId, createdAt: manifest.createdAt, bytes: manifest.stats.bytes, files: manifest.stats.files, sets: plan.sets, pinned: false, label: null, hostname: this.cfg.hostname, fileSig: sig });
			await this.cleanupSnapshotStaging(entries);

			// 7. retention + GC — the snapshot is already committed; a failure
			// here is logged, not fatal.
			try {
				report('retention', { done: 0, total: 1, bytesDone: 0, bytesTotal: 0 }, true);
				const survivors = await this.applyRetention(target, plan.keep);
				report('gc', { done: 0, total: 1, bytesDone: 0, bytesTotal: 0 }, true);
				await this.collectGarbage(target, survivors, report);
			} catch (err) {
				if (isAbortError(err)) throw err;
				blog.warn('retention/GC failed after a committed snapshot', undefined, err);
				warnings.push(`retention/GC failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			this.store.pruneRuns(30 * 24 * 3600_000);

			const result = this.finish(plan.runId, 'done', { snapshotId, unchanged: false, cancelled: false, files: manifest.stats.files, bytes: manifest.stats.bytes, newObjects: uploads.size, newBytes, warnings, durationMs: Date.now() - startedAt });
			blog.info('backup completed', { snapshotId, files: result.files, newObjects: result.newObjects, newBytes, ms: result.durationMs });
			this.emitEvent({ kind: 'completed', runId: plan.runId, op: 'backup', result });
			return result;
		} catch (err) {
			if (isAbortError(err)) {
				const result = this.finish(plan.runId, 'cancelled', { snapshotId: null, unchanged: false, cancelled: true, files: 0, bytes: 0, newObjects: 0, newBytes: 0, warnings, durationMs: Date.now() - startedAt });
				blog.info('backup cancelled', { runId: plan.runId });
				this.emitEvent({ kind: 'completed', runId: plan.runId, op: 'backup', result });
				return result;
			}
			const message = err instanceof Error ? err.message : String(err);
			if (targetId) this.store.finishRun(plan.runId, 'failed', null, message);
			blog.error('backup failed', err instanceof Error ? err : undefined, { runId: plan.runId });
			this.emitEvent({ kind: 'failed', runId: plan.runId, op: 'backup', message });
			throw err;
		} finally {
			this.active = null;
		}
	}

	private finish(runId: string, status: 'done' | 'unchanged' | 'cancelled', result: BackupRunResult): BackupRunResult {
		this.store.finishRun(runId, status, result, null);
		return result;
	}

	private throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) throw new AbortedError();
	}

	// VACUUM INTO (our WAL DBs) or a torn-write-checked copy (rekordbox's
	// SQLCipher trio). The entry's srcPath is rewritten to the staged copy.
	private async snapshotEntry(e: FileEntry, targetId: string, objectShas: Set<string>, warnings: string[]): Promise<void> {
		await mkdir(this.stagingDir, { recursive: true });
		const he = e as HashedEntry;
		if (e.snapshot!.kind === 'vacuum') {
			const live = e.srcPath;
			const walPath = `${live}-wal`;
			const liveStat = await stat(live);
			const walStat = existsSync(walPath) ? await stat(walPath) : null;
			const fp = { path: live, dbSize: liveStat.size, dbMtimeMs: Math.floor(liveStat.mtimeMs), walSize: walStat?.size ?? 0, walMtimeMs: walStat ? Math.floor(walStat.mtimeMs) : 0 };
			const prev = this.store.getDbSnapshotFp(live);
			if (prev && prev.dbSize === fp.dbSize && prev.dbMtimeMs === fp.dbMtimeMs && prev.walSize === fp.walSize && prev.walMtimeMs === fp.walMtimeMs && objectShas.has(prev.sha256)) {
				// Byte-identical since the last snapshot and the target holds
				// it — no VACUUM, no read.
				he.sha256 = prev.sha256;
				he.size = this.store.getObject(targetId, prev.sha256)?.size ?? e.size;
				return;
			}
			const staged = join(this.stagingDir, `snap-${basename(live)}`);
			await rm(staged, { force: true });
			await rm(`${staged}-journal`, { force: true });
			vacuumInto(live, staged);
			const copy = new Database(staged);
			try {
				if (e.snapshot!.stripTokens) {
					// Freed pages are zeroed so no token bytes survive in slack.
					copy.pragma('secure_delete = ON');
					copy.exec('DELETE FROM token');
				}
				// A single self-contained file: no -wal for the hash/upload to miss.
				copy.pragma('journal_mode = DELETE');
			} finally {
				copy.close();
			}
			const s = await stat(staged);
			he.srcPath = staged; he.size = s.size; he.mtimeMs = Math.floor(s.mtimeMs); he.liveFp = fp; he.staged = staged;
			return;
		}
		// rekordbox: plain copy, re-stat to catch a write landing mid-copy.
		const staged = join(this.stagingDir, `snap-${basename(e.srcPath)}`);
		for (let attempt = 0; attempt < 3; attempt++) {
			const before = await stat(e.srcPath);
			await copyFileAtomic(e.srcPath, staged);
			const after = await stat(e.srcPath);
			if (before.size === after.size && before.mtimeMs === after.mtimeMs) break;
			if (attempt === 2) warnings.push(`${basename(e.srcPath)} changed while being copied (rekordbox running?) — the copy may be torn`);
		}
		const s = await stat(staged);
		he.srcPath = staged; he.size = s.size; he.staged = staged;
	}

	private async cleanupSnapshotStaging(entries: FileEntry[]): Promise<void> {
		for (const e of entries) {
			const staged = (e as HashedEntry).staged;
			if (staged) await rm(staged, { force: true });
		}
	}

	// Staged zstd temps nobody references any more (a run that finished, or
	// a journal that was pruned). Runs before each backup.
	private async sweepStaging(): Promise<void> {
		if (!existsSync(this.stagingDir)) return;
		const keep = this.store.referencedStagedPaths();
		for (const name of await readdir(this.stagingDir)) {
			const p = join(this.stagingDir, name);
			if (keep.has(p) || name.startsWith('snap-')) continue;
			await rm(p, { force: true, recursive: true });
		}
	}

	// Newest `keep` + every pinned snapshot survive. Returns the survivors.
	private async applyRetention(target: BackupTarget, keep: number): Promise<SnapshotCacheRow[]> {
		const rows = await this.refreshSnapshots(target);
		const survivors = new Set<string>();
		for (const s of rows) if (s.pinned) survivors.add(s.snapshotId);
		for (const s of rows.slice(0, Math.max(1, keep))) survivors.add(s.snapshotId);
		for (const s of rows) {
			if (survivors.has(s.snapshotId)) continue;
			blog.info('retention: deleting snapshot', { snapshotId: s.snapshotId });
			await target.deleteFile(`snapshots/${s.snapshotId}.json.zst`);
			this.store.deleteSnapshot(target.id, s.snapshotId);
			await rm(this.manifestCachePath(target.id, s.snapshotId), { force: true });
		}
		return rows.filter((s) => survivors.has(s.snapshotId));
	}

	private async collectGarbage(target: BackupTarget, survivors: SnapshotCacheRow[], report: ReturnType<BackupEngine['progressReporter']>): Promise<void> {
		const live = new Set<string>();
		for (const s of survivors) {
			const m = await this.getManifest(target, s.snapshotId);
			if (!m) continue;
			for (const f of m.files) live.add(f.sha256);
		}
		const cutoff = Date.now() - GC_GRACE_MS;
		const dead: Array<{ sha256: string; remoteId: string | null }> = [];
		for await (const o of target.listObjects()) {
			if (!live.has(o.sha256) && o.createdAt < cutoff) dead.push({ sha256: o.sha256, remoteId: o.remoteId });
		}
		let n = 0;
		for (const d of dead) {
			await target.deleteObject(d.sha256, d.remoteId);
			report('gc', { done: ++n, total: dead.length, bytesDone: 0, bytesTotal: 0 });
		}
		if (dead.length) {
			this.store.deleteObjects(target.id, dead.map((d) => d.sha256));
			blog.info('gc: deleted unreferenced objects', { count: dead.length });
		}
	}

	// ─── restore ────────────────────────────────────────────────────────

	async restorePreview(cfg: BackupTargetConfig, snapshotId: string): Promise<Omit<BackupRestorePreview, 'rekordboxRunning' | 'sameMachine'>> {
		const { target } = await this.openTarget(cfg);
		const m = await this.getManifest(target, snapshotId);
		if (!m) throw new Error(`snapshot ${snapshotId} not found on the target`);
		const sets = Object.fromEntries(BACKUP_SET_IDS.map((s) => [s, { present: !!m.sets[s], files: 0, bytes: 0 }])) as BackupRestorePreview['sets'];
		for (const f of m.files) { sets[f.set].files++; sets[f.set].bytes += f.size; }
		const firstTrack = m.files.find((f) => f.set === 'tracks');
		return {
			snapshotId, createdAt: m.createdAt, hostname: m.machine.hostname, sets, roots: m.roots,
			tracksRoot: firstTrack?.root ?? m.roots.libraryFolders[0] ?? null,
			freeBytes: await freeBytesAt(this.cfg.userDataDir),
		};
	}

	// Download + verify one manifest entry into `dest`, resuming if an
	// identical file is already there.
	private async materialize(target: BackupTarget, f: BackupManifestEntry, dest: string, objDir: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<'written' | 'skipped'> {
		if (existsSync(dest)) {
			const s = await stat(dest);
			if (s.size === f.size && (await sha256File(dest, signal)) === f.sha256) { onBytes(f.size); return 'skipped'; }
		}
		await mkdir(objDir, { recursive: true });
		const obj = join(objDir, f.sha256);
		let got = 0;
		await target.getObject(f.sha256, obj, { signal, expectedSize: f.storedSize, onProgress: (n) => { onBytes(n - got); got = n; } });
		const { sha256 } = await decodeObjectToFile(obj, dest, f.enc, signal);
		await rm(obj, { force: true });
		if (sha256 !== f.sha256) {
			await rm(dest, { force: true });
			throw new Error(`integrity check failed for ${f.rel ?? f.abs} (expected ${f.sha256.slice(0, 12)}…, got ${sha256.slice(0, 12)}…)`);
		}
		await utimes(dest, new Date(), new Date(f.mtimeMs));
		return 'written';
	}

	private async downloadSet(a: ActiveOp, target: BackupTarget, files: BackupManifestEntry[], destOf: (f: BackupManifestEntry) => string, objDir: string, parallelism: number): Promise<{ written: number; skipped: number }> {
		const report = this.progressReporter(a);
		const bytesTotal = files.reduce((n, f) => n + f.size, 0);
		let bytesDone = 0, done = 0, written = 0, skipped = 0;
		report('download', { done: 0, total: files.length, bytesDone: 0, bytesTotal }, true);
		await parallel(files, parallelism, a.abort.signal, async (f) => {
			const r = await this.materialize(target, f, destOf(f), objDir, a.abort.signal, (n) => {
				bytesDone += n;
				report('download', { done, total: files.length, bytesDone: Math.min(bytesDone, bytesTotal), bytesTotal, current: basename(f.rel ?? f.abs ?? '') });
			});
			if (r === 'written') written++; else skipped++;
			done++;
			report('download', { done, total: files.length, bytesDone: Math.min(bytesDone, bytesTotal), bytesTotal, current: null }, true);
		});
		return { written, skipped };
	}

	private async loadManifestFor(cfg: BackupTargetConfig, snapshotId: string): Promise<{ target: BackupTarget; manifest: BackupManifest }> {
		const { target } = await this.openTarget(cfg);
		const manifest = await this.getManifest(target, snapshotId);
		if (!manifest) throw new Error(`snapshot ${snapshotId} not found on the target`);
		return { target, manifest };
	}

	private async runRestore(runId: string, req: BackupRestoreRequest, body: (a: ActiveOp) => Promise<BackupRunResult>): Promise<BackupRunResult> {
		const a = this.begin(runId, 'restore');
		const startedAt = Date.now();
		try {
			this.emitEvent({ kind: 'started', runId, op: 'restore', sets: req.sets });
			const result = await body(a);
			result.durationMs = Date.now() - startedAt;
			this.emitEvent({ kind: 'completed', runId, op: 'restore', result });
			return result;
		} catch (err) {
			if (isAbortError(err)) {
				const result: BackupRunResult = { snapshotId: req.snapshotId, unchanged: false, cancelled: true, files: 0, bytes: 0, newObjects: 0, newBytes: 0, warnings: [], durationMs: Date.now() - startedAt };
				this.emitEvent({ kind: 'completed', runId, op: 'restore', result });
				return result;
			}
			const message = err instanceof Error ? err.message : String(err);
			blog.error('restore failed', err instanceof Error ? err : undefined, { runId, snapshotId: req.snapshotId });
			this.emitEvent({ kind: 'failed', runId, op: 'restore', message });
			throw err;
		} finally {
			this.active = null;
		}
	}

	// Curator data (core / peaks / embeddings / covers): download + verify
	// into restore-staging, then leave a marker for the next boot to swap
	// the files in before any DB opens (apply.ts). Nothing live is touched.
	async restoreStage(runId: string, cfg: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult> {
		return this.runRestore(runId, req, async (a) => {
			const { target, manifest } = await this.loadManifestFor(cfg, req.snapshotId);
			const sets = req.sets.filter((s) => CURATOR_DATA_SETS.includes(s) && manifest.sets[s]);
			if (!sets.length) throw new Error('nothing to restore: none of the requested Curator data sets are in this snapshot');
			const files = manifest.files.filter((f) => sets.includes(f.set));
			const staging = join(this.restoreStagingDir, req.snapshotId);
			const objDir = join(staging, '.obj');
			const destOf = (f: BackupManifestEntry): string => join(staging, f.set, f.rel!);
			const r = await this.downloadSet(a, target, files, destOf, objDir, DOWNLOAD_PARALLEL);
			await rm(objDir, { force: true, recursive: true });

			const moves: PendingRestore['moves'] = [];
			let rendererSettings: string | null = null;
			let tokens: string | null = null;
			for (const f of files) {
				if (f.set === 'core' && f.rel === 'renderer-settings.json') { rendererSettings = destOf(f); continue; }
				if (f.set === 'core' && f.rel === 'tokens.enc') { tokens = destOf(f); continue; }
				if (f.set === 'peaks' || f.set === 'covers') continue; // whole-dir moves below
				const to = resolveEntryPath(this.cfg, f);
				if (to) moves.push({ from: destOf(f), to, kind: 'file' });
			}
			if (sets.includes('peaks')) moves.push({ from: join(staging, 'peaks'), to: this.cfg.peaksDir, kind: 'dir' });
			if (sets.includes('covers')) moves.push({ from: join(staging, 'covers'), to: this.cfg.coversDir, kind: 'dir' });
			const tracksRoot = manifest.files.find((f) => f.set === 'tracks')?.root ?? manifest.roots.libraryFolders[0] ?? null;
			const remap = req.sets.includes('tracks') && req.tracks?.mode === 'root' && tracksRoot && normalizePath(req.tracks.root).replace(/\/+$/, '') !== tracksRoot
				? { from: tracksRoot, to: normalizePath(req.tracks.root).replace(/\/+$/, '') }
				: null;
			const marker: PendingRestore = { snapshotId: req.snapshotId, stagedAt: Date.now(), sets, moves, remap, rendererSettings, tokens };
			await writeFile(join(this.cfg.userDataDir, 'pending-restore.json'), JSON.stringify(marker, null, '\t'), 'utf8');
			blog.info('restore staged — relaunch to apply', { snapshotId: req.snapshotId, files: files.length, written: r.written, skipped: r.skipped });
			return { snapshotId: req.snapshotId, unchanged: false, cancelled: false, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), newObjects: 0, newBytes: 0, warnings: [], durationMs: 0, relaunchRequired: true, ...r };
		});
	}

	// Audio files straight to their destination (original paths, or under a
	// new root). mtimes are restored so the scanner's (mtime, size) guard
	// keeps the existing source_link identity instead of re-ingesting.
	async restoreTracks(runId: string, cfg: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult> {
		return this.runRestore(runId, req, async (a) => {
			const { target, manifest } = await this.loadManifestFor(cfg, req.snapshotId);
			if (!manifest.sets.tracks) throw new Error('this snapshot does not include audio files');
			const files = manifest.files.filter((f) => f.set === 'tracks' && f.abs);
			const mode = req.tracks ?? { mode: 'original' as const };
			const newRoot = mode.mode === 'root' ? normalizePath(mode.root).replace(/\/+$/, '') : null;
			const destOf = (f: BackupManifestEntry): string => {
				if (!newRoot) return f.abs!;
				const root = f.root ?? dirname(f.abs!);
				return f.abs!.startsWith(`${root}/`) ? join(newRoot, f.abs!.slice(root.length + 1)) : join(newRoot, basename(f.abs!));
			};
			const free = await freeBytesAt(newRoot ?? dirname(files[0]?.abs ?? this.cfg.userDataDir));
			const need = files.reduce((n, f) => n + f.size, 0);
			if (free != null && free < need * 1.05) throw new Error(`not enough free space: ${Math.round(need / 1e9)} GB needed, ${Math.round(free / 1e9)} GB free`);
			const objDir = join(this.restoreStagingDir, req.snapshotId, '.obj');
			const r = await this.downloadSet(a, target, files, destOf, objDir, 2);
			await rm(objDir, { force: true, recursive: true });
			return { snapshotId: req.snapshotId, unchanged: false, cancelled: false, files: files.length, bytes: need, newObjects: 0, newBytes: 0, warnings: [], durationMs: 0, ...r };
		});
	}

	// Rekordbox: download + verify into staging, then overwrite in place.
	// The caller has already verified rekordbox is closed and taken the
	// pre-restore copy of master.db (service.ts).
	async restoreRekordbox(runId: string, cfg: BackupTargetConfig, req: BackupRestoreRequest): Promise<BackupRunResult> {
		return this.runRestore(runId, req, async (a) => {
			const { target, manifest } = await this.loadManifestFor(cfg, req.snapshotId);
			const sets = req.sets.filter((s) => REKORDBOX_SETS.includes(s) && manifest.sets[s]);
			if (!sets.length) throw new Error('nothing to restore: none of the requested rekordbox sets are in this snapshot');
			if (!this.cfg.rekordboxDbPath) throw new Error('rekordbox database location is unknown — set it in Settings → Rekordbox');
			const files = manifest.files.filter((f) => sets.includes(f.set) && resolveEntryPath(this.cfg, f));
			const staging = join(this.restoreStagingDir, req.snapshotId, 'rb');
			const objDir = join(staging, '.obj');
			const destOf = (f: BackupManifestEntry): string => join(staging, f.set, f.rel!);
			const r = await this.downloadSet(a, target, files, destOf, objDir, DOWNLOAD_PARALLEL);
			await rm(objDir, { force: true, recursive: true });
			this.throwIfAborted(a.abort.signal);

			// Apply: master.db trio first (delete sidecars the snapshot did not
			// carry — a stale -wal against a restored main file is corruption),
			// then everything else.
			const report = this.progressReporter(a);
			const trio = ['master.db', 'master.db-wal', 'master.db-shm'];
			const haveTrio = new Set(files.filter((f) => f.set === 'rekordboxDb' && trio.includes(f.rel ?? '')).map((f) => f.rel!));
			if (haveTrio.has('master.db')) {
				for (const name of trio) {
					const live = resolveEntryPath(this.cfg, { set: 'rekordboxDb', rel: name })!;
					if (!haveTrio.has(name)) await rm(live, { force: true });
				}
			}
			let n = 0;
			for (const f of files) {
				const live = resolveEntryPath(this.cfg, f)!;
				await mkdir(dirname(live), { recursive: true });
				await rm(`${live}.part`, { force: true });
				await copyFile(destOf(f), `${live}.part`);
				await rename(`${live}.part`, live);
				await utimes(live, new Date(), new Date(f.mtimeMs));
				report('write', { done: ++n, total: files.length, bytesDone: 0, bytesTotal: 0, current: basename(live) });
			}
			await rm(staging, { force: true, recursive: true });
			blog.info('rekordbox restore applied', { snapshotId: req.snapshotId, files: files.length });
			return { snapshotId: req.snapshotId, unchanged: false, cancelled: false, files: files.length, bytes: files.reduce((s, f) => s + f.size, 0), newObjects: 0, newBytes: 0, warnings: [], durationMs: 0, ...r };
		});
	}
}

// Per-run bookkeeping stashed on the collected entry.
interface HashedEntry extends FileEntry {
	sha256?: string;
	liveFp?: { path: string; dbSize: number; dbMtimeMs: number; walSize: number; walMtimeMs: number };
	staged?: string;
}

// sha256 over the sorted (set, path, sha) list — equal ⇒ the snapshot would
// be identical to the previous one.
export function fileSignature(files: ReadonlyArray<Pick<BackupManifestEntry, 'set' | 'rel' | 'abs' | 'sha256'>>): string {
	const lines = files.map((f) => `${entryKey(f)}|${f.sha256}`).sort();
	return sha256Buffer(Buffer.from(lines.join('\n'), 'utf8'));
}

// VACUUM INTO from a read-only connection yields a consistent WAL-snapshot
// copy without ever restarting under concurrent writes (unlike the online
// backup API). SQLite accepts it on read-only handles; if a build refuses,
// fall back to a normal handle that still only reads.
export function vacuumInto(livePath: string, destPath: string): void {
	const sql = `VACUUM INTO '${quoteSqlPath(destPath)}'`;
	const ro = new Database(livePath, { readonly: true, fileMustExist: true });
	try {
		ro.exec(sql);
		return;
	} catch (err) {
		if (!/readonly|read-only/i.test(err instanceof Error ? err.message : String(err))) throw err;
	} finally {
		ro.close();
	}
	const rw = new Database(livePath, { fileMustExist: true });
	try { rw.exec(sql); } finally { rw.close(); }
}
