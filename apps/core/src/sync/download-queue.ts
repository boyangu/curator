// In-memory queue that wraps TidalDownloader.downloadTrack with state,
// concurrency, and a per-job event stream. Lives in the service for the
// lifetime of the process (downloads aren't durable across restarts —
// crash-recovery would need a `download_job` table; out of scope for now).
//
// State diagram per job:
//   pending → downloading → done
//   pending → downloading → error  (retryable)
//   error   → downloading            (via retry)

import type { TidalDownloader, DownloadProgress } from './download-orchestrator.js';
import { downloadConfig } from '../config.download.js';
import { eq } from 'drizzle-orm';
import { downloadJob } from '@curator/shared/schema';
import type { Db } from '../db/client.js';
import { log } from '../log.js';

const vlog = log.for('verify');

export type DownloadErrorKind =
	| 'not_available'        // no Tidal link, no playbackinfo, region blocked
	| 'auth_required'        // sniff session expired
	| 'download_failed'      // segment fetch or HTTP error
	| 'verification_failed'  // FLAC magic / STREAMINFO check failed
	| 'unsupported_format'   // Tidal returned AAC and M4A processor isn't ported
	| 'download_duplicate'   // two jobs resolved to the same outputPath — overwrote each other
	| 'other';

export class DownloadError extends Error {
	constructor(public readonly kind: DownloadErrorKind, message: string) {
		super(message);
		this.name = 'DownloadError';
	}
}

export interface DownloadJob {
	trackId: string;
	trackTitle: string;
	artistName: string;
	// 'skipped' = file already on disk; we short-circuit before fetching. Used
	// so the row reads "SKIPPED (exists)" instead of misleadingly "DONE".
	state: 'pending' | 'downloading' | 'done' | 'error' | 'skipped';
	pct: number;                // 0-100; meaningful during downloading + final on done
	bytes?: number;             // present once done OR on skip (size from existing file)
	outputPath?: string;        // present once done / skipped
	error?: string;             // user-readable error message
	errorKind?: DownloadErrorKind;
	enqueuedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export interface QueueSummary {
	total: number;
	pending: number;
	downloading: number;
	done: number;
	skipped: number;
	error: number;
	overallPct: number;         // 0-100 across all jobs (done/skipped = 100, downloading = pct, others = 0)
}

export type QueueEvent =
	| { type: 'job'; job: DownloadJob }
	| { type: 'summary'; summary: QueueSummary };

export type QueueListener = (evt: QueueEvent) => void;

export class DownloadQueue {
	private jobs = new Map<string, DownloadJob>();
	private active = new Set<string>();
	private listeners: QueueListener[] = [];

	constructor(
		private readonly downloader: TidalDownloader,
		private readonly db: Db
	) {
		// Hydrate the in-memory map from the DB. Anything left in
		// 'downloading' state at boot was interrupted by an exit / crash —
		// reset to 'pending' so the next drain picks it up. 'pending'
		// rows also naturally resume because they were never started.
		const rows = this.db.select().from(downloadJob).all();
		for (const r of rows) {
			const restored: DownloadJob = {
				trackId: r.trackId,
				trackTitle: r.trackTitle,
				artistName: r.artistName,
				state: r.state === 'downloading' ? 'pending' : r.state,
				pct: r.state === 'downloading' ? 0 : r.pct,
				bytes: r.bytes ?? undefined,
				outputPath: r.outputPath ?? undefined,
				error: r.error ?? undefined,
				errorKind: (r.errorKind as DownloadErrorKind | null) ?? undefined,
				enqueuedAt: r.enqueuedAt instanceof Date ? r.enqueuedAt.getTime() : Number(r.enqueuedAt),
				startedAt: r.startedAt instanceof Date ? r.startedAt.getTime() : (r.startedAt ?? undefined) as number | undefined,
				finishedAt: r.finishedAt instanceof Date ? r.finishedAt.getTime() : (r.finishedAt ?? undefined) as number | undefined,
			};
			this.jobs.set(restored.trackId, restored);
			if (r.state === 'downloading') this.persist(restored); // write back the reset
		}
		// Re-drive the loop. Async kick — won't block the constructor.
		if (this.jobs.size > 0) void this.drain();
	}

	private persist(job: DownloadJob): void {
		// upsert by trackId — INSERT OR REPLACE keeps the row aligned with
		// in-memory state without a separate exists-check.
		const enqueuedAt = new Date(job.enqueuedAt);
		const startedAt = job.startedAt != null ? new Date(job.startedAt) : null;
		const finishedAt = job.finishedAt != null ? new Date(job.finishedAt) : null;
		this.db
			.insert(downloadJob)
			.values({
				trackId: job.trackId,
				trackTitle: job.trackTitle,
				artistName: job.artistName,
				state: job.state,
				pct: job.pct,
				bytes: job.bytes ?? null,
				outputPath: job.outputPath ?? null,
				error: job.error ?? null,
				errorKind: job.errorKind ?? null,
				enqueuedAt,
				startedAt,
				finishedAt,
			})
			.onConflictDoUpdate({
				target: downloadJob.trackId,
				set: {
					trackTitle: job.trackTitle,
					artistName: job.artistName,
					state: job.state,
					pct: job.pct,
					bytes: job.bytes ?? null,
					outputPath: job.outputPath ?? null,
					error: job.error ?? null,
					errorKind: job.errorKind ?? null,
					startedAt,
					finishedAt,
				},
			})
			.run();
	}

	private removeFromDb(trackId: string): void {
		this.db.delete(downloadJob).where(eq(downloadJob.trackId, trackId)).run();
	}

	onUpdate(cb: QueueListener): () => void {
		this.listeners.push(cb);
		return () => { this.listeners = this.listeners.filter((l) => l !== cb); };
	}

	getJobs(): DownloadJob[] {
		return [...this.jobs.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
	}

	// A download in flight — cheaper than getSummary() for the backup
	// scheduler's busy gate.
	hasActive(): boolean {
		return this.active.size > 0;
	}

	getSummary(): QueueSummary {
		const jobs = this.getJobs();
		const pending = jobs.filter((j) => j.state === 'pending').length;
		const downloading = jobs.filter((j) => j.state === 'downloading').length;
		const done = jobs.filter((j) => j.state === 'done').length;
		const skipped = jobs.filter((j) => j.state === 'skipped').length;
		const error = jobs.filter((j) => j.state === 'error').length;
		const total = jobs.length;
		// Skipped counts as 100% (the file exists, work is done) — keeps the
		// overall % from sitting at 0 when you re-queue a fully-cached set.
		const sumPct = jobs.reduce((s, j) =>
			s + (j.state === 'done' || j.state === 'skipped' ? 100 : j.state === 'error' ? 0 : j.pct), 0);
		const overallPct = total > 0 ? Math.floor(sumPct / total) : 0;
		return { total, pending, downloading, done, skipped, error, overallPct };
	}

	// Add tracks to the queue. Already-present ids are left untouched (a job
	// in `done` state isn't re-queued — explicit retry is required).
	enqueue(items: { trackId: string; trackTitle: string; artistName: string }[]): void {
		for (const it of items) {
			if (this.jobs.has(it.trackId)) continue;
			const j: DownloadJob = {
				trackId: it.trackId,
				trackTitle: it.trackTitle,
				artistName: it.artistName,
				state: 'pending',
				pct: 0,
				enqueuedAt: Date.now(),
			};
			this.jobs.set(it.trackId, j);
			this.persist(j);
			this.emitJob(j);
		}
		this.emitSummary();
		void this.drain();
	}

	// Resets an errored job to pending and kicks the drain. Anything not in
	// `error` state is a no-op so a UI mis-click can't corrupt running jobs.
	retry(trackId: string): void {
		const job = this.jobs.get(trackId);
		if (!job || job.state !== 'error') return;
		job.state = 'pending';
		job.pct = 0;
		job.error = undefined;
		job.errorKind = undefined;
		job.startedAt = undefined;
		job.finishedAt = undefined;
		this.persist(job);
		this.emitJob(job);
		this.emitSummary();
		void this.drain();
	}

	clearCompleted(): void {
		// 'skipped' is also "completed" from the user's POV — the file already
		// existed on disk so no work needed doing. Clearing both keeps the list
		// focused on what still needs attention (pending / downloading / error).
		for (const [id, j] of this.jobs) if (j.state === 'done' || j.state === 'skipped') {
			this.jobs.delete(id);
			this.removeFromDb(id);
		}
		this.emitSummary();
	}

	// Nukes every job that isn't currently mid-download. We leave 'downloading'
	// rows alone because they have an in-flight fetch on the orchestrator side
	// — deleting them would orphan partial files and break the runJob() exit
	// path that calls persist() once the stream finishes.
	clearAll(): void {
		for (const [id, j] of this.jobs) if (j.state !== 'downloading') {
			this.jobs.delete(id);
			this.removeFromDb(id);
		}
		this.emitSummary();
	}

	// Force-redownload: blow away the current job entry (delete cached file
	// first, best-effort), re-enqueue as pending. Use case: a `done` row
	// failed verification, or the user wants a fresh copy with the latest
	// metadata overrides.
	async redownload(trackId: string, opts: { deleteFile?: boolean } = {}): Promise<void> {
		const job = this.jobs.get(trackId);
		if (!job) return;
		if (opts.deleteFile && job.outputPath) {
			try { await (await import('node:fs')).promises.unlink(job.outputPath); }
			catch { /* file may not exist; ignore */ }
		}
		this.jobs.delete(trackId);
		this.removeFromDb(trackId);
		this.enqueue([{ trackId: job.trackId, trackTitle: job.trackTitle, artistName: job.artistName }]);
	}

	// Walks EVERY job in the queue and verifies the on-disk file (when one
	// is expected). Buckets:
	//   - ok            : done/skipped with file present, valid magic, size match
	//   - missing       : done/skipped with file gone from disk → flipped to error
	//   - corrupt       : present but FLAC magic missing → flipped to error
	//   - sizeMismatch  : size diverges from recorded bytes → flipped to error
	//   - neverDownloaded: track is in queue but never produced a file (state
	//                     was 'error' before verify ran — e.g. 'not_available')
	//   - inProgress    : pending or currently downloading — skipped
	// `problems` is a human-readable list ('Artist - Title — reason') so the
	// renderer's dialog can spell out which tracks need attention.
	async verify(): Promise<{
		total: number;
		ok: number;
		missing: number;
		corrupt: number;
		sizeMismatch: number;
		neverDownloaded: number;
		inProgress: number;
		problems: string[];
	}> {
		const fsp = (await import('node:fs')).promises;
		const fsSync = await import('node:fs');
		const path = await import('node:path');
		const allJobs = [...this.jobs.values()];
		let ok = 0, missing = 0, corrupt = 0, sizeMismatch = 0, neverDownloaded = 0, inProgress = 0;
		const problems: string[] = [];
		// Track outputPath claims across jobs. Filename templates like
		// "{artist} - {title}" can collide between two different tracks that
		// share artist+title (different remixes, multiple releases). The
		// second writer overwrote the first; on verify both jobs see the
		// same file and both would pass without this check. We mark the
		// later claimants as duplicates so the missing file is named.
		const pathClaims = new Map<string, string>(); // normalised path → first claimant name
		const norm = (p: string) => path.resolve(p).toLowerCase(); // Windows is case-insensitive; macOS often-case-insensitive too
		vlog.info('walking jobs', { jobs: allJobs.length });
		for (const job of allJobs) {
			const name = job.artistName ? `${job.artistName} - ${job.trackTitle}` : job.trackTitle;

			if (job.state === 'pending' || job.state === 'downloading') {
				inProgress++;
				continue;
			}

			if (job.state === 'error') {
				// Pre-existing error from the download attempt — record but
				// don't touch state. The errorKind already tells us why.
				neverDownloaded++;
				problems.push(`${name} — ${labelForErrorKind(job.errorKind ?? 'other')}${job.errorKind === 'not_available' ? ' (not available for download)' : ''}`);
				continue;
			}

			// done / skipped → file must exist on disk
			if (!job.outputPath) {
				job.state = 'error';
				job.error = 'No output path recorded';
				job.errorKind = 'verification_failed';
				this.persist(job);
				this.emitJob(job);
				missing++;
				problems.push(`${name} — no output path recorded (lost across restart?)`);
				vlog.warn('no outputPath for job', { name, state: job.state });
				continue;
			}

			const normalised = norm(job.outputPath);
			const prior = pathClaims.get(normalised);
			if (prior) {
				// Two jobs landed on the same path — filename template
				// collision. The file on disk belongs to whoever wrote last;
				// the OTHER jobs effectively have no file. Mark as error so
				// the user can fix (rename one, or change the template).
				job.state = 'error';
				job.error = `Filename collides with "${prior}" — neither file is identifiable`;
				job.errorKind = 'download_duplicate';
				this.persist(job);
				this.emitJob(job);
				missing++;
				problems.push(`${name} — filename collision with "${prior}" (both resolve to ${path.basename(job.outputPath)})`);
				vlog.warn('path collision', { name, prior, path: normalised });
				continue;
			}
			pathClaims.set(normalised, name);

			if (!fsSync.existsSync(job.outputPath)) {
				job.state = 'error';
				job.error = `File missing on disk: ${job.outputPath}`;
				job.errorKind = 'verification_failed';
				this.persist(job);
				this.emitJob(job);
				missing++;
				problems.push(`${name} — file missing on disk`);
				vlog.warn('file missing on disk', { name, path: job.outputPath });
				continue;
			}
			try {
				const stat = await fsp.stat(job.outputPath);
				if (typeof job.bytes === 'number' && stat.size !== job.bytes) {
					job.state = 'error';
					job.error = `Size mismatch: ${stat.size} on disk, expected ${job.bytes}`;
					job.errorKind = 'verification_failed';
					this.persist(job);
					this.emitJob(job);
					sizeMismatch++;
					problems.push(`${name} — size mismatch`);
					continue;
				}
				const fh = await fsp.open(job.outputPath, 'r');
				try {
					const head = Buffer.alloc(4);
					await fh.read(head, 0, 4, 0);
					if (head[0] !== 0x66 || head[1] !== 0x4C || head[2] !== 0x61 || head[3] !== 0x43) {
						job.state = 'error';
						job.error = 'FLAC magic missing — file corrupt';
						job.errorKind = 'verification_failed';
						this.persist(job);
						this.emitJob(job);
						corrupt++;
						problems.push(`${name} — corrupt (bad FLAC magic)`);
						continue;
					}
				} finally {
					await fh.close();
				}
				ok++;
			} catch (err) {
				job.state = 'error';
				job.error = `Verify failed: ${err instanceof Error ? err.message : String(err)}`;
				job.errorKind = 'verification_failed';
				this.persist(job);
				this.emitJob(job);
				corrupt++;
				problems.push(`${name} — verify error: ${err instanceof Error ? err.message : err}`);
			}
		}
		this.emitSummary();
		return { total: allJobs.length, ok, missing, corrupt, sizeMismatch, neverDownloaded, inProgress, problems };
	}

	// Drain loop — runs as many jobs in parallel as parallelTracks allows.
	// Re-entrant: every state change calls drain() and it picks up any
	// pending jobs up to the concurrency limit.
	private async drain(): Promise<void> {
		const limit = Math.max(1, downloadConfig.parallelTracks);
		while (this.active.size < limit) {
			const next = [...this.jobs.values()].find((j) => j.state === 'pending');
			if (!next) return;
			this.active.add(next.trackId);
			this.runJob(next).finally(() => {
				this.active.delete(next.trackId);
				void this.drain();
			});
		}
	}

	private async runJob(job: DownloadJob): Promise<void> {
		job.state = 'downloading';
		job.startedAt = Date.now();
		this.persist(job);
		this.emitJob(job);
		this.emitSummary();
		// Throttle DB writes during streaming — pct ticks ~100x per track and
		// each upsert is a synchronous SQLite write. Save every ~5%; the
		// in-memory state still updates per event, so the renderer sees
		// smooth progress via the event stream.
		let lastPersistedPct = 0;
		try {
			const onProgress = (p: DownloadProgress) => {
				if (p.stage === 'streaming') {
					if (typeof p.pct === 'number') job.pct = p.pct;
					if (typeof p.bytes === 'number') job.bytes = p.bytes;
					if (job.pct - lastPersistedPct >= 5) {
						this.persist(job);
						lastPersistedPct = job.pct;
					}
					this.emitJob(job);
					this.emitSummary();
				}
			};
			const result = await this.downloader.downloadTrack(job.trackId, onProgress);
			job.state = result.skipped ? 'skipped' : 'done';
			job.pct = 100;
			job.bytes = result.bytes;
			job.outputPath = result.outputPath;
			job.finishedAt = Date.now();
		} catch (err) {
			job.state = 'error';
			const msg = err instanceof Error ? err.message : String(err);
			job.error = msg;
			// When the orchestrator already knows the failure category it throws a
			// DownloadError with an explicit kind — trust it. Only fall back to
			// message-string heuristics for plain Errors (network, FLAC checks).
			job.errorKind = err instanceof DownloadError ? err.kind : classifyError(msg);
			job.finishedAt = Date.now();
		}
		this.persist(job);
		this.emitJob(job);
		this.emitSummary();
	}

	private emitJob(job: DownloadJob): void {
		const snapshot = { ...job };
		for (const l of this.listeners) l({ type: 'job', job: snapshot });
	}
	private emitSummary(): void {
		const s = this.getSummary();
		for (const l of this.listeners) l({ type: 'summary', summary: s });
	}
}

// Map a raw error message to a category the UI can render with a friendly
// label. Heuristics are intentional — the orchestrator throws a mix of
// plain Errors (network, FLAC checks) and our own DownloadError instances.
function classifyError(msg: string): DownloadErrorKind {
	const m = msg.toLowerCase();
	if (m.includes('no tidal source-link') || m.includes('not found in catalog')) return 'not_available';
	if (m.includes('not connected') || m.includes('session') || m.includes('sniff')) return 'auth_required';
	if (m.includes('streaminfo') || m.includes('flac magic') || m.includes('truncated')) return 'verification_failed';
	if (m.includes('aac') || m.includes('unexpected manifest mime') || m.includes('only handles')) return 'unsupported_format';
	if (m.includes('http') || m.includes('fetch') || m.includes('network') || m.includes('econnreset')) return 'download_failed';
	return 'other';
}

export function labelForErrorKind(kind: DownloadErrorKind): string {
	switch (kind) {
		case 'not_available':       return 'Not available';
		case 'auth_required':       return 'Reconnect Tidal';
		case 'download_failed':     return 'Download failed';
		case 'verification_failed': return 'Verification failed';
		case 'unsupported_format':  return 'Format unsupported';
		case 'download_duplicate':  return 'Download duplicate';
		default:                     return 'Error';
	}
}
