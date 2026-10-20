// Local library scanner.
//
// Walks watched folders for audio files (FLAC/M4A/WAV/MP3/AIFF), gets each
// file's metadata via an injected `parseAudio` function, and matches it into
// the canonical track table — ISRC first, then title+artist+duration via the
// shared Scorer. When no acceptable match exists, a new track row is created
// and the file attached as a `source='local'` source_link.
//
// The injected `parseAudio` is normally an out-of-process pool (Electron
// utility processes — see apps/desktop/src/main/ingest/) so the actual
// metadata read never runs on the main event loop. Tests and headless CLI
// usage default to parseInline, which runs music-metadata in-process.
//
// Watching is delegated to chokidar with awaitWriteFinish to avoid ingesting
// half-written files. The first run emits `add` for every existing file in
// the tree — the same handler that processes future additions — so initial
// scan and ongoing watch share one code path.
//
// Identity across moves and rewrites is the audio hash (ingest/audio-hash.ts),
// stored on the local source_link. A removed file does NOT lose its link: the
// row is flagged `missing_at` and kept, so when the same audio shows up at a
// new path (rename, folder move — unlink and add arrive in either order) the
// link is re-pointed and the track keeps its cues, tags and rekordbox slot.
// Links missing for longer than MISSING_LINK_TTL_DAYS are swept at startup.
//
// A deleted track stays deleted. Its audio can still be on disk: the trash
// step failed, the file was moved after the delete, or another desktop
// deleted the recording (synced op) while this machine keeps its own copy.
// A scan used to mint a fresh row for such a file, and with the op log that
// row is a new recording on every device — the delete undone everywhere. So
// audio that belongs to a deleted track (its link, its analysis, or the
// recording's audio-hash claim in the op log's records) is bound to that
// deleted row and left deleted. The way back is an explicit undelete
// (CoreService.undeleteTracks), which then finds the file already attached.

import { existsSync, promises as fsp } from 'node:fs';
import { extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import chokidar, { type FSWatcher } from 'chokidar';
import { and, desc, eq, inArray, isNull, like, lt, sql } from 'drizzle-orm';
import { track, sourceLink, libraryFolder, trackAnalysis } from '@curator/shared/schema';
import type { LibraryFolder, NewTrack, NewSourceLink, TrackArtist } from '@curator/shared/schema';
import { asciify } from '@curator/shared';
import { normalizeIncomingCredits, rawOf, syncTrackArtists } from '../library/artists.js';
import { syncTrackAlbumsById } from '../library/albums.js';
import type { Db } from '../db/client.js';
import { log } from '../log.js';
import { addClaims, recordTrackCreated, type Claim } from '../library/mutators.js';
import { sharedScorer, type Candidate, type Target } from '@curator/matcher';
import type { ParseFn, ParseResult } from '../ingest/types.js';

const slog = log.for('scanner');

const AUDIO_EXTS = new Set(['.flac', '.m4a', '.mp4', '.wav', '.mp3', '.aiff', '.aif']);

// Cap on in-flight ingestPath promises. The injected `parseAudio` (utility-
// process pool) takes care of parallelising parseFile itself, but the rest
// of each ingest — three or four synchronous better-sqlite3 calls — still
// runs on the main event loop. Without this cap, 4,500 chokidar `add`
// events queue 4,500 closures all racing for main-thread DB time, and the
// UI freezes during the scan. 16 is high enough to keep a 7-worker pool
// fed and low enough that the sync DB calls stay an interleaved trickle
// instead of a burst.
const INGEST_CONCURRENCY = 16;

// Interval for coalescing 'ingesting' scan-progress events into a single
// IPC emit per folder. Without coalescing we'd fire one IPC message per
// file ingested — 4,500 back to back saturates the renderer's main thread
// even though each handler is cheap. 150ms keeps the counter feeling live.
const EMIT_INTERVAL_MS = 150;

// Substring markers we refuse to watch by default — cloud-sync roots cause
// chokidar feedback loops on Windows and trigger re-ingest storms when the
// remote service touches mtimes. Users who really want to watch inside one
// of these can do so by passing { allowCloudSync: true } when adding.
const CLOUD_SYNC_MARKERS = ['/OneDrive', '/Dropbox', '/Google Drive', '/GoogleDrive', '/iCloudDrive'];

// How long a vanished file's link waits for its audio to reappear elsewhere
// before the sweep drops it. Long enough to span a drive reorganisation done
// over a few sessions; short enough that a genuinely deleted file doesn't
// keep its track on the local tier forever.
const MISSING_LINK_TTL_DAYS = 30;

export function normalizePath(p: string): string {
	// Forward slashes everywhere; lowercase drive letter on Windows so
	// 'C:/foo' and 'c:/foo' don't both end up in the index.
	let n = p.replace(/\\/g, '/');
	if (/^[A-Za-z]:/.test(n)) n = n[0]!.toLowerCase() + n.slice(1);
	return n;
}

export function isCloudSyncPath(p: string): boolean {
	const n = normalizePath(p);
	return CLOUD_SYNC_MARKERS.some((m) => n.includes(m));
}

export interface ScanProgress {
	stage: 'starting' | 'ingesting' | 'done' | 'error';
	folderId: string;
	folderPath: string;
	current?: { path: string; index: number };
	totals: { scanned: number; matched: number; created: number; skipped: number; failed: number };
	error?: string;
}

export type ScanProgressFn = (p: ScanProgress) => void;

// Per-track ingest notification. Fired by the watcher's add/change handlers
// once a file has been resolved to a canonical track id. The service uses
// this to enqueue analysis for newly-ingested local tracks — scanner stays
// ignorant of the analyzer module.
//   matched  — a known path re-read, or a new file scored onto an existing row
//   created  — a new file minted its own row
//   rebound  — a new path carrying the audio of a link that had gone missing
//              (or whose old path is already gone): that link now points here
//   skipped  — known path, unchanged size+mtime, nothing to do
//   deleted  — a new path carrying the audio of a track the user deleted:
//              bound to that row, which stays deleted (nothing to analyse,
//              no membership to recompute)
//   orphaned — the file vanished (watcher unlink, or the missing-link sweep);
//              the canonical track survives. Carries the now-fileless trackId
//              so listeners (membership recompute) can re-evaluate it.
export type IngestOutcome = 'matched' | 'created' | 'rebound' | 'skipped' | 'deleted' | 'orphaned';

export interface IngestEvent {
	outcome: IngestOutcome;
	trackId: string;
	filePath: string;
	// 'matched' only: the known path now holds DIFFERENT audio (its audio
	// hash changed — a re-encode or a replaced file, not a tag edit, which
	// the hash ignores). The track's analysis no longer describes the file;
	// its catalogue stamp is already cleared, and the service re-queues it.
	audioChanged?: boolean;
}
export type IngestFn = (evt: IngestEvent) => void;

interface IngestResult {
	outcome: Exclude<IngestOutcome, 'orphaned'> | 'failed';
	trackId?: string;
	error?: string;
}

export class LibraryScanner {
	private watchers = new Map<string, FSWatcher>();
	// Per-folder progress accumulator. We emit on every ingest tick so the
	// renderer can show a live counter — totals are kept here instead of
	// reconstructed from the DB each time.
	private totals = new Map<string, ScanProgress['totals']>();
	// Subscribers receive every scan tick from every folder. The service
	// fans these out to renderer windows via the IPC event channel.
	private listeners = new Set<ScanProgressFn>();
	// Per-track ingest subscribers — fired once per file resolution. Service
	// uses this to feed the analyzer queue without scanner.ts depending on it.
	private ingestListeners = new Set<IngestFn>();
	// Concurrency gate on in-flight ingestPath promises. See INGEST_CONCURRENCY.
	private active = 0;
	private waitQueue: Array<() => void> = [];
	// Coalesces 'ingesting' progress emits so we don't fire one IPC message
	// per file (4,500 ticks back-to-back saturate the renderer's message
	// pump). Latest tick per folder is kept; flushed via emitTimer.
	private pendingProgress = new Map<string, ScanProgress>();
	private emitTimer: NodeJS.Timeout | null = null;

	constructor(
		private readonly db: Db,
		// Injected by the service. In Electron this is backed by the utility-
		// process pool in apps/desktop/src/main/ingest/. In tests/CLI it's the
		// in-process parseInline. The scanner itself doesn't care which.
		private readonly parseAudio: ParseFn,
	) {}

	private async limited<T>(fn: () => Promise<T>): Promise<T> {
		while (this.active >= INGEST_CONCURRENCY) {
			await new Promise<void>((r) => this.waitQueue.push(r));
		}
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			const next = this.waitQueue.shift();
			if (next) next();
		}
	}

	onProgress(cb: ScanProgressFn): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	onIngest(cb: IngestFn): () => void {
		this.ingestListeners.add(cb);
		return () => this.ingestListeners.delete(cb);
	}

	// Ingesting events get coalesced (latest-wins per folder, flushed every
	// EMIT_INTERVAL_MS). Terminal events (starting/done/error) emit
	// immediately, and flush any pending 'ingesting' tick first so the
	// renderer sees the final counter before the terminal frame.
	private emit(p: ScanProgress): void {
		if (p.stage === 'ingesting') {
			this.pendingProgress.set(p.folderId, p);
			if (!this.emitTimer) {
				this.emitTimer = setTimeout(() => this.flushPending(), EMIT_INTERVAL_MS);
			}
			return;
		}
		this.flushPending();
		this.emitNow(p);
	}

	private flushPending(): void {
		if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
		if (this.pendingProgress.size === 0) return;
		for (const p of this.pendingProgress.values()) this.emitNow(p);
		this.pendingProgress.clear();
	}

	private emitNow(p: ScanProgress): void {
		for (const l of this.listeners) {
			try { l(p); } catch (err) { slog.error('listener threw', err); }
		}
	}

	private emitIngest(evt: IngestEvent): void {
		for (const l of this.ingestListeners) {
			try { l(evt); } catch (err) { slog.error('ingest listener threw', err); }
		}
	}

	async startAll(): Promise<void> {
		// Before the watchers' initial `add` storm, so a file that reappears
		// inside the TTL still finds its flagged link to re-bind to.
		this.sweepMissingLinks();
		const rows = this.db
			.select()
			.from(libraryFolder)
			.where(eq(libraryFolder.watching, true))
			.all();
		await Promise.all(rows.map((f) => this.startWatching(f)));
	}

	// Drop local links whose file has been missing for longer than the TTL.
	// Each dropped link emits 'orphaned' so membership (and any other
	// local-presence reader) is recomputed for the track. Returns the count.
	sweepMissingLinks(olderThanDays = MISSING_LINK_TTL_DAYS): number {
		const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
		const rows = this.db
			.select({ id: sourceLink.id, trackId: sourceLink.trackId, filePath: sourceLink.filePath })
			.from(sourceLink)
			.where(and(eq(sourceLink.source, 'local'), lt(sourceLink.missingAt, cutoff)))
			.all();
		if (rows.length === 0) return 0;
		for (let i = 0; i < rows.length; i += 500) {
			this.db.delete(sourceLink).where(inArray(sourceLink.id, rows.slice(i, i + 500).map((r) => r.id))).run();
		}
		slog.info('swept missing local links', { count: rows.length, olderThanDays });
		for (const r of rows) this.emitIngest({ outcome: 'orphaned', trackId: r.trackId, filePath: r.filePath ?? '' });
		return rows.length;
	}

	async startWatching(folder: LibraryFolder): Promise<void> {
		if (this.watchers.has(folder.id)) return;
		if (!existsSync(folder.path)) {
			this.db
				.update(libraryFolder)
				.set({ scanState: 'error', scanError: 'Folder not found on disk' })
				.where(eq(libraryFolder.id, folder.id))
				.run();
			return;
		}

		this.totals.set(folder.id, { scanned: 0, matched: 0, created: 0, skipped: 0, failed: 0 });
		this.db
			.update(libraryFolder)
			.set({ scanState: 'scanning', scanError: null })
			.where(eq(libraryFolder.id, folder.id))
			.run();
		slog.info('starting watch', { path: folder.path });
		this.emit({
			stage: 'starting',
			folderId: folder.id,
			folderPath: folder.path,
			totals: this.totals.get(folder.id)!,
		});

		const watcher = chokidar.watch(folder.path, {
			persistent: true,
			ignoreInitial: false,
			ignored: (p) => {
				const ext = extname(p).toLowerCase();
				// Allow directories (they have no ext); for files, only audio types.
				if (ext === '') return false;
				return !AUDIO_EXTS.has(ext);
			},
			// Half-written downloads — wait until the file size has been
			// stable for 1s before emitting `add`. Avoids ingesting partials.
			awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
		});

		// Chokidar fires `add` synchronously for every file in the initial
		// walk. The pool handles parseFile parallelism, but every ingest also
		// does a few synchronous better-sqlite3 calls. Without a cap, those
		// sync calls all race on the main thread and the UI freezes — so we
		// gate ingest concurrency at INGEST_CONCURRENCY (see constant above).
		watcher.on('add', (p) => {
			this.limited(() => this.ingestPath(folder, p)).catch((err) =>
				slog.error('ingest failed', err, { path: p })
			);
		});
		watcher.on('change', (p) => {
			this.limited(() => this.ingestPath(folder, p)).catch((err) =>
				slog.error('re-ingest failed', err, { path: p })
			);
		});
		watcher.on('unlink', (p) => {
			this.orphanByPath(p);
		});
		watcher.on('ready', () => {
			const t = this.totals.get(folder.id)!;
			slog.info('ready', {
				path: folder.path,
				scanned: t.scanned,
				matched: t.matched,
				created: t.created,
				skipped: t.skipped,
				failed: t.failed,
			});
			this.db
				.update(libraryFolder)
				.set({ scanState: 'idle', lastScannedAt: new Date() })
				.where(eq(libraryFolder.id, folder.id))
				.run();
			this.emit({
				stage: 'done',
				folderId: folder.id,
				folderPath: folder.path,
				totals: t,
			});
		});
		watcher.on('error', (err) => {
			slog.error('watcher error', err, { path: folder.path });
			const message = err instanceof Error ? err.message : String(err);
			this.db
				.update(libraryFolder)
				.set({ scanState: 'error', scanError: message })
				.where(eq(libraryFolder.id, folder.id))
				.run();
			this.emit({
				stage: 'error',
				folderId: folder.id,
				folderPath: folder.path,
				totals: this.totals.get(folder.id) ?? { scanned: 0, matched: 0, created: 0, skipped: 0, failed: 0 },
				error: message,
			});
		});

		this.watchers.set(folder.id, watcher);
	}

	async stopWatching(folderId: string): Promise<void> {
		const w = this.watchers.get(folderId);
		if (!w) return;
		await w.close();
		this.watchers.delete(folderId);
		this.totals.delete(folderId);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.watchers.keys()].map((id) => this.stopWatching(id)));
	}

	private async ingestPath(folder: LibraryFolder, p: string): Promise<IngestResult> {
		const norm = normalizePath(p);
		const totals = this.totals.get(folder.id)!;
		totals.scanned++;

		try {
			const stat = await fsp.stat(p);
			const mtime = new Date(stat.mtimeMs);

			// Re-ingest only if mtime or size has actually changed. Cheap O(1)
			// guard that keeps `add` storms on watcher startup from re-running
			// metadata extraction on every file. A link with no audio hash yet
			// is not skippable: pre-hash rows get hashed once by the next
			// startup pass (for FLAC a header read, not a decode). Files the
			// hasher can't key (zero-MD5 FLACs, unreadable containers) pay the
			// parse every launch — rare, and off the main loop.
			const existing = this.db
				.select({
					id: sourceLink.id,
					trackId: sourceLink.trackId,
					fileMtime: sourceLink.fileMtime,
					fileSize: sourceLink.fileSize,
					audioHash: sourceLink.audioHash,
					missingAt: sourceLink.missingAt,
				})
				.from(sourceLink)
				.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.filePath, norm)))
				.get();
			if (existing && existing.fileMtime?.getTime() === mtime.getTime() && existing.fileSize === stat.size && existing.audioHash != null) {
				// The same file back at the same path (drive remounted, undo of a
				// delete): the link is whole again without a parse. Reported as
				// 'matched' so local-presence readers recompute.
				const reappeared = existing.missingAt != null;
				if (reappeared) {
					this.db.update(sourceLink).set({ missingAt: null }).where(eq(sourceLink.id, existing.id)).run();
					totals.matched++;
				} else {
					totals.skipped++;
				}
				this.emit({
					stage: 'ingesting',
					folderId: folder.id,
					folderPath: folder.path,
					current: { path: norm, index: totals.scanned },
					totals,
				});
				const outcome = reappeared ? 'matched' : 'skipped';
				this.emitIngest({ outcome, trackId: existing.trackId, filePath: norm });
				return { outcome, trackId: existing.trackId };
			}

			// Off-main parse. With the utility-process pool this returns once
			// a free worker has read the file; without it, parseInline runs
			// music-metadata on the caller's thread.
			const parsed = await this.parseAudio(p);

			// A path we already track stays bound to its track, period. Tag
			// edits rewrite the file (new mtime/size) and routinely change the
			// parsed title/artist shape — re-running match-or-create here once
			// re-pointed dozens of curated tracks' files onto fresh bare rows
			// (2026-06-25 incident; scripts/repair-scanner-dedup.py). Identity
			// of a known path is the link itself, not the tags inside it.
			if (existing) {
				// The audio itself changed under a known path. The link keeps its
				// track (above), but the analysis was computed from the old audio:
				// drop its catalogue stamp in the same breath as the new hash, so
				// the old analysis is never shared or topped up under the new key.
				const audioChanged = existing.audioHash != null && parsed.audioHash != null && existing.audioHash !== parsed.audioHash;
				this.db.transaction((tx) => {
					this.upsertLocalSourceLink(existing.trackId, norm, stat, parsed);
					if (audioChanged) {
						tx.update(trackAnalysis).set({ audioHash: null }).where(eq(trackAnalysis.trackId, existing.trackId)).run();
					}
				});
				if (audioChanged) slog.info('audio changed under a known path — analysis stamp cleared, re-analysis queued', { trackId: existing.trackId });
				// A hash first computed here (the lazy backfill of links from
				// before audio hashing) or a new one (the audio changed) is a
				// claim nothing else would make: the initial push and its
				// backfill run once, and the identity resolver can only pair
				// this file with another desktop's copy through the claim.
				if (parsed.audioHash && parsed.audioHash !== existing.audioHash) {
					addClaims(this.db, existing.trackId, [{ kind: 'audio_hash', value: parsed.audioHash }]);
				}
				this.promoteFileFields(existing.trackId, parsed);
				totals.matched++;
				this.emit({
					stage: 'ingesting',
					folderId: folder.id,
					folderPath: folder.path,
					current: { path: norm, index: totals.scanned },
					totals,
				});
				this.emitIngest({ outcome: 'matched', trackId: existing.trackId, filePath: norm, ...(audioChanged ? { audioChanged } : {}) });
				return { outcome: 'matched', trackId: existing.trackId };
			}

			// A new path. Before scoring tags, ask the audio: is this the file
			// of a link we already hold? Only the hash can answer that across a
			// rename or folder move — the tags may have changed in the same
			// edit, and the scorer is exactly what re-bound curated tracks onto
			// bare rows in 2026-06.
			const byHash = parsed.audioHash ? this.sameAudioElsewhere(parsed.audioHash, norm) : null;
			if (byHash?.kind === 'rebind') {
				// Same link id, same track: cues, tags, rating and the rekordbox
				// slot all stay attached. Only the file columns move.
				this.db
					.update(sourceLink)
					.set(localLinkValues(byHash.trackId, norm, stat, parsed))
					.where(eq(sourceLink.id, byHash.linkId))
					.run();
				this.promoteFileFields(byHash.trackId, parsed);
				totals.matched++;
				this.emit({
					stage: 'ingesting',
					folderId: folder.id,
					folderPath: folder.path,
					current: { path: norm, index: totals.scanned },
					totals,
				});
				this.emitIngest({ outcome: 'rebound', trackId: byHash.trackId, filePath: norm });
				return { outcome: 'rebound', trackId: byHash.trackId };
			}

			// Not live anywhere: is it the audio of a deleted track? Then it is
			// that track's file, not a new one (see the header).
			const deleted = !byHash && parsed.audioHash ? this.deletedOwnerOf(parsed.audioHash, norm) : null;
			if (deleted) {
				// A link of its own at this path. An older link of the deleted row
				// (the file's previous path) is left flagged for the TTL sweep.
				this.upsertLocalSourceLink(deleted, norm, stat, parsed);
				totals.skipped++;
				this.emit({
					stage: 'ingesting',
					folderId: folder.id,
					folderPath: folder.path,
					current: { path: norm, index: totals.scanned },
					totals,
				});
				this.emitIngest({ outcome: 'deleted', trackId: deleted, filePath: norm });
				return { outcome: 'deleted', trackId: deleted };
			}

			const target = toTarget(parsed, p);
			// A byte-identical copy of a file that is still present elsewhere
			// gets its own row rather than a second link on that track: a track
			// holds one rekordbox content, and the importer's both-sides-linked
			// blocker would fire on the next import. The scorer is skipped too —
			// it would land this copy on the very track the live file owns. The
			// pair is surfaced by getDuplicateAudioGroups() for the user to
			// resolve (merge or delete), not folded silently.
			const result = byHash?.kind === 'duplicate'
				? { trackId: this.createTrack(target, parsed), created: true }
				: this.matchOrCreate(target, parsed);

			this.upsertLocalSourceLink(result.trackId, norm, stat, parsed);
			// Sync: a new row is a library_track create; either way the file's
			// audio hash (and a tag ISRC on a new row) is a claim on the
			// recording for the catalogue resolver. A re-bind (above) moves a
			// file already claimed and emits nothing.
			const claims: Claim[] = parsed.audioHash ? [{ kind: 'audio_hash', value: parsed.audioHash }] : [];
			if (result.created) {
				if (target.isrc) claims.push({ kind: 'isrc', value: target.isrc, confidence: 0.8 });
				recordTrackCreated(this.db, result.trackId, claims);
			} else {
				addClaims(this.db, result.trackId, claims);
			}
			// A new row's release — after the link, so the seam can see the
			// file's folder (local compilations group by folder).
			if (result.created) syncTrackAlbumsById(this.db, [result.trackId]);

			if (result.created) totals.created++;
			else totals.matched++;

			this.emit({
				stage: 'ingesting',
				folderId: folder.id,
				folderPath: folder.path,
				current: { path: norm, index: totals.scanned },
				totals,
			});
			this.emitIngest({
				outcome: result.created ? 'created' : 'matched',
				trackId: result.trackId,
				filePath: norm,
			});
			return { outcome: result.created ? 'created' : 'matched', trackId: result.trackId };
		} catch (err) {
			totals.failed++;
			slog.error('failed to ingest', err, { path: p });
			this.emit({
				stage: 'ingesting',
				folderId: folder.id,
				folderPath: folder.path,
				current: { path: norm, index: totals.scanned },
				totals,
			});
			return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
		}
	}

	private orphanByPath(p: string): void {
		const norm = normalizePath(p);
		const link = this.db
			.select({ id: sourceLink.id, trackId: sourceLink.trackId, missingAt: sourceLink.missingAt })
			.from(sourceLink)
			.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.filePath, norm)))
			.get();
		// No link: either never ingested, or already re-pointed to the file's
		// new path by an `add` that arrived before this unlink. Already
		// flagged: a repeat unlink (chokidar re-fires on some renames).
		if (!link || link.missingAt) return;
		// Flag, don't delete: the row is what a later `add` of the same audio
		// re-binds to (see ingestPath). The canonical track is left in place
		// so streaming-provider links survive either way.
		this.db.update(sourceLink).set({ missingAt: new Date() }).where(eq(sourceLink.id, link.id)).run();
		// Losing the local file can change the track's membership tier (local →
		// streaming/followed/none). Emit so the service recomputes it.
		this.emitIngest({ outcome: 'orphaned', trackId: link.trackId, filePath: norm });
	}

	// Where else does this audio live? Live-track local links (not deleted,
	// not a WAV copy — those share their original's PCM by design) with the
	// same hash, other than `norm` itself:
	//   rebind    — one of them is flagged missing, or its file is already
	//               gone from disk (the move's unlink hasn't arrived yet).
	//               Most recently missing first, so a file moved twice
	//               follows its latest hop.
	//   duplicate — every one of them is still on disk: a real second copy.
	private sameAudioElsewhere(
		hash: string,
		norm: string,
	): { kind: 'rebind'; linkId: string; trackId: string } | { kind: 'duplicate' } | null {
		const rows = this.db
			.select({ id: sourceLink.id, trackId: sourceLink.trackId, filePath: sourceLink.filePath, missingAt: sourceLink.missingAt })
			.from(sourceLink)
			.innerJoin(track, eq(track.id, sourceLink.trackId))
			.where(and(
				eq(sourceLink.source, 'local'),
				eq(sourceLink.audioHash, hash),
				isNull(track.deletedAt),
				isNull(track.derivedFromTrackId),
			))
			.orderBy(desc(sourceLink.missingAt))
			.all()
			.filter((r) => r.filePath !== norm);
		if (rows.length === 0) return null;
		const gone = rows.find((r) => r.missingAt != null) ?? rows.find((r) => !r.filePath || !existsSync(r.filePath));
		return gone ? { kind: 'rebind', linkId: gone.id, trackId: gone.trackId } : { kind: 'duplicate' };
	}

	// The deleted track (soft-deleted, not a WAV copy, not a merge loser —
	// a loser's recording lives on in its winner) this audio belongs to, if
	// no live track holds it. Checked in order of how directly the row owns
	// the audio:
	//   1. a local link of its own with this hash (the file moved after the
	//      delete, or is a second copy of the deleted file);
	//   2. its analysis, stamped with this hash;
	//   3. its recording's audio-hash claim in the op-log records — how a
	//      delete made on another device, or one that dropped the link here,
	//      still knows the file.
	// A live track that holds the hash through its analysis wins over all
	// of these: the audio is in the library, and the normal match finds it.
	private deletedOwnerOf(hash: string, norm: string): string | null {
		const raw = rawOf(this.db);
		const live = raw.prepare(`SELECT 1 FROM track_analysis a JOIN track t ON t.id = a.track_id
			WHERE a.audio_hash = ? AND t.deleted_at IS NULL AND t.derived_from_track_id IS NULL LIMIT 1`).get(hash);
		if (live) return null;
		const linked = raw.prepare(`SELECT t.id FROM source_link l JOIN track t ON t.id = l.track_id
			WHERE l.source = 'local' AND l.audio_hash = ? AND t.deleted_at IS NOT NULL AND t.derived_from_track_id IS NULL
				AND (l.file_path IS NULL OR l.file_path != ?)
			ORDER BY t.deleted_at DESC LIMIT 1`).pluck().get(hash, norm) as string | undefined;
		if (linked) return linked;
		const analysed = raw.prepare(`SELECT t.id FROM track_analysis a JOIN track t ON t.id = a.track_id
			WHERE a.audio_hash = ? AND t.deleted_at IS NOT NULL AND t.derived_from_track_id IS NULL
				AND NOT EXISTS (SELECT 1 FROM recording_alias ra WHERE ra.loser = t.recording_id)
			ORDER BY t.deleted_at DESC LIMIT 1`).pluck().get(hash) as string | undefined;
		if (analysed) return analysed;
		return this.deletedClaims().get(hash) ?? null;
	}

	// audio hash → deleted track, from the claims of every deleted row's
	// recording. Claims have no index by value (their key leads with the
	// recording), so the map is built once and rebuilt only when the
	// deleted set or the records change: a first scan asks for every file,
	// and probing each deleted row's claim per file would cost
	// files × deleted lookups. The cache key is three cheap reads (an
	// index-only count over the deleted rows, two index maxima).
	private deletedClaimsCache: { key: string; map: Map<string, string> } | null = null;
	private deletedClaims(): Map<string, string> {
		const raw = rawOf(this.db);
		const k = raw.prepare(`SELECT (SELECT count(*) FROM track WHERE deleted_at IS NOT NULL) AS n,
			(SELECT max(deleted_at) FROM track) AS at, (SELECT max(rowid) FROM sync_state) AS rs`).get() as { n: number; at: number | null; rs: number | null };
		const key = `${k.n}:${k.at ?? 0}:${k.rs ?? 0}`;
		if (this.deletedClaimsCache?.key === key) return this.deletedClaimsCache.map;
		const map = new Map<string, string>();
		const rows = raw.prepare(`SELECT t.id, t.recording_id AS rec FROM track t
			WHERE t.deleted_at IS NOT NULL AND t.derived_from_track_id IS NULL AND t.recording_id IS NOT NULL
				AND NOT EXISTS (SELECT 1 FROM recording_alias ra WHERE ra.loser = t.recording_id)
			ORDER BY t.deleted_at`).all() as Array<{ id: string; rec: string }>;
		const byRec = new Map(rows.map((r) => [r.rec, r.id]));
		const recs = [...byRec.keys()];
		const marker = ':audio_hash:';
		for (let i = 0; i < recs.length; i += 400) {
			const chunk = recs.slice(i, i + 400);
			const claims = raw.prepare(`SELECT key, recording_id AS rec FROM sync_state
				WHERE map = 'claims' AND recording_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ key: string; rec: string }>;
			for (const c of claims) {
				const at = c.key.indexOf(marker);
				if (at < 0) continue;
				// Rows come oldest delete first, so the latest delete wins.
				map.set(c.key.slice(at + marker.length), byRec.get(c.rec)!);
			}
		}
		this.deletedClaimsCache = { key, map };
		return map;
	}

	// Promote the file-derived fields the canonical row should own:
	//  - duration: the local file is the copy you actually play, so its
	//    length wins outright — but only when the decoder produced one
	//    (don't blank a good streaming duration with a null parse).
	//  - genre/label: fill a gap only. COALESCE keeps any existing
	//    (cleaner) streaming/Beatport value and never clobbers it with a
	//    messier file tag.
	// Title/artists/album/isrc/bpm are deliberately left alone — the
	// streaming naming is the canonical display, isrc is the identity
	// key, and the analyzer's beatgrid supersedes the file's BPM tag.
	//
	// updatedAt moves only when a value actually changes. It means "Curator
	// changed this row" and drives the rekordbox "Sync updates" selection; a
	// re-parse of an unchanged file (the lazy audio-hash backfill re-parses
	// every known path once) used to stamp the whole local library as edited
	// and re-sent ~4.4k tracks to rekordbox on every sync after 2026-10-17.
	private promoteFileFields(trackId: string, parsed: ParseResult): void {
		const cur = this.db
			.select({ duration: track.duration, genre: track.genre, label: track.label })
			.from(track)
			.where(eq(track.id, trackId))
			.get();
		if (!cur) return;
		const set: Record<string, unknown> = {};
		if (parsed.duration != null && parsed.duration !== cur.duration) set.duration = parsed.duration;
		// Gap-fill only (the old COALESCE): an existing value — even '' —
		// is never replaced by the file tag.
		if (parsed.genre && cur.genre == null) set.genre = parsed.genre;
		if (parsed.label && cur.label == null) set.label = parsed.label;
		if (Object.keys(set).length === 0) return;
		set.updatedAt = new Date();
		this.db.update(track).set(set).where(eq(track.id, trackId)).run();
	}

	private matchOrCreate(target: Target, parsed: ParseResult): { trackId: string; created: boolean } {
		const candidates = this.findCandidates(target);
		const best = sharedScorer.pick(candidates, target);
		if (best) {
			const id = String(best.id);
			this.promoteFileFields(id, parsed);
			return { trackId: id, created: false };
		}
		return { trackId: this.createTrack(target, parsed), created: true };
	}

	// Mint a canonical row from file metadata. Returns the new id.
	private createTrack(target: Target, parsed: ParseResult): string {
		const id = randomUUID();
		// Tag readers hand back one element per ARTIST frame; a single packed
		// "A, B" frame is split here, "A & B" stays a duo.
		const { artists, artistsBase } = normalizeIncomingCredits(this.db, target.artists.map((name) => ({ name })), { title: target.title });
		const newRow: NewTrack = {
			id,
			recordingId: recordingIdForTrack(id),
			title: target.title || 'Unknown',
			artists,
			artistsBase,
			isrc: target.isrc ?? null,
			albumTitle: parsed.albumTitle,
			duration: target.duration ?? null,
			bpm: parsed.bpm,
			keyCamelot: null,
			genre: parsed.genre,
			label: parsed.label,
			explicit: null,
			state: 'unsorted',
		};
		this.db.insert(track).values(asciify(newRow)).run();
		syncTrackArtists(this.db, [{ id, artists, overrides: null }]);
		return id;
	}

	private findCandidates(target: Target): Candidate[] {
		// Two cheap lookups, unioned in JS:
		//   1. exact ISRC (indexed)
		//   2. raw LIKE on title against the first word — loose enough to catch
		//      accent/case variation, narrow enough not to scan the whole table
		// The scorer's strict acceptance rule is what actually decides.
		const ids = new Set<string>();
		const out: Candidate[] = [];

		if (target.isrc) {
			const rows = this.db
				.select()
				.from(track)
				.where(and(eq(track.isrc, target.isrc.toUpperCase()), isNull(track.derivedFromTrackId)))
				.all();
			for (const r of rows) {
				ids.add(r.id);
				out.push(rowToCandidate(r));
			}
		}

		// Derived copies (Convert to WAV) are never match candidates: the copy
		// shares title/artists/duration with its original, and its "[WAV]"
		// title suffix folds to a substring match in the scorer. The copy's own
		// file is pre-bound by a source_link before it appears on disk, so it
		// never reaches matchOrCreate; this guard keeps an unrelated file (or
		// the copy after a lost link) from landing on the copy.
		const firstWord = (target.title.match(/[A-Za-z0-9]{3,}/)?.[0] ?? '').toLowerCase();
		if (firstWord) {
			const rows = this.db
				.select()
				.from(track)
				.where(and(like(track.title, `%${firstWord}%`), isNull(track.derivedFromTrackId)))
				.limit(200)
				.all();
			for (const r of rows) {
				if (!ids.has(r.id)) {
					ids.add(r.id);
					out.push(rowToCandidate(r));
				}
			}
		}

		return out;
	}

	private upsertLocalSourceLink(trackId: string, norm: string, stat: { size: number; mtimeMs: number }, parsed: ParseResult): void {
		upsertLocalSourceLink(this.db, trackId, norm, stat, parsed);
	}
}

// Bind a local file path to a track (insert or re-point the one local
// source_link for that path). Shared by the scanner and by writers that mint
// a file themselves (Convert to WAV) and must bind it BEFORE the file becomes
// visible to the watcher — see wav/materialize.ts.
export type LocalLinkInput = Pick<ParseResult, 'isrc' | 'title' | 'artists' | 'albumTitle' | 'duration' | 'bpm' | 'container' | 'audioHash'>;

export function upsertLocalSourceLink(
	db: Db,
	trackId: string,
	norm: string,
	stat: { size: number; mtimeMs: number },
	parsed: LocalLinkInput,
): void {
	const existing = db
		.select({ id: sourceLink.id })
		.from(sourceLink)
		.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.filePath, norm)))
		.get();
	const values = localLinkValues(trackId, norm, stat, parsed);
	if (existing) {
		db.update(sourceLink).set(values).where(eq(sourceLink.id, existing.id)).run();
	} else {
		db.insert(sourceLink).values({ id: randomUUID(), source: 'local', ...values }).run();
	}
}

// Every column a local link carries for a file at `norm` — one definition
// for insert, path-keyed update and the hash re-bind, so the three can't
// drift. Any write clears `missingAt`: a file we just read is not missing.
function localLinkValues(
	trackId: string,
	norm: string,
	stat: { size: number; mtimeMs: number },
	parsed: LocalLinkInput,
): Omit<NewSourceLink, 'id' | 'source'> {
	return {
		trackId,
		// For local rows sourceTrackId = filePath so the (source, sourceTrackId)
		// unique constraint still works.
		sourceTrackId: norm,
		url: null,
		isrcLocal: parsed.isrc,
		titleLocal: parsed.title,
		artistsLocal: parsed.artists.map((name) => ({ name })),
		albumLocal: parsed.albumTitle,
		durationLocal: parsed.duration,
		bpmLocal: parsed.bpm,
		keyLocal: null,
		payload: null,
		filePath: norm,
		fileFormat: parsed.container ?? extname(norm).slice(1).toLowerCase(),
		fileSize: stat.size,
		fileMtime: new Date(stat.mtimeMs),
		audioHash: parsed.audioHash,
		missingAt: null,
		fetchedAt: new Date(),
	};
}

function toTarget(parsed: ParseResult, fallbackPath: string): Target {
	const title = parsed.title?.trim() || basename(fallbackPath, extname(fallbackPath));
	return {
		title,
		artists: parsed.artists,
		duration: parsed.duration,
		isrc: parsed.isrc,
	};
}

function rowToCandidate(r: { id: string; title: string; artists: TrackArtist[]; duration: number | null; isrc: string | null }): Candidate {
	return {
		id: r.id,
		title: r.title,
		artists: (r.artists ?? []).map((a) => a.name),
		duration: r.duration ?? null,
		isrc: r.isrc ?? null,
	};
}
