// Persisted analyzer queue. Mirrors apps/core/src/sync/download-queue.ts
// shape (with much less ceremony — analysis has no resumable state).
//
// State machine per track_id:
//
//   <none>  ──enqueue──▶  queued ──dispatch──▶  running ──result──▶  done
//                            │                      │
//                            │                      └─error──▶  error
//                            ▲                                      │
//                            └────────re-enqueue (explicit)─────────┘
//
// Cancellation removes a `queued` row outright and asks the sidecar to skip
// a `running` row (sidecar gives best-effort mid-run cancel).
//
// Priority: integer, higher = sooner. Dispatch order = (priority DESC,
// enqueuedAt ASC). Used by the renderer to bump "the track the user just
// opened" past the eager-on-scan backlog.
//
// Concurrency: the sidecar has its own worker pool (4 by default); the
// queue keeps dispatching jobs while in-flight < poolSize. We don't
// orchestrate beyond that — Python's multiprocessing.Pool handles the
// actual parallelism.

import { and, asc, desc, eq, gte, inArray, isNull } from 'drizzle-orm';
import { EventEmitter } from 'node:events';
import { promises as fsp, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import {
	analysisJob,
	track,
	trackAnalysis,
	sourceLink,
	type AnalysisJob,
	type NewAnalysisJob,
	type NewTrackAnalysis,
	type TrackArtist,
} from '@curator/shared/schema';
import type { Db } from '../db/client.js';
import { log } from '../log.js';
import { addClaims } from '../library/mutators.js';
import { AnalyzerSidecar, type AnalyzeOptions, type AnalyzeResult, type ProgressEvent, type SidecarError } from './sidecar.js';

const qlog = log.for('analyzer-queue');

// Cheap "does this path exist + is readable" probe. Used to decide whether a
// track already has peaks on disk so a re-analyze can skip regenerating them.
async function fileExists(p: string): Promise<boolean> {
	try { await fsp.access(p, fsConstants.R_OK); return true; }
	catch { return false; }
}

// The analyzer version this Node code is paired with — what a fresh result is
// stamped with. Bump in lockstep with
// `apps/analyzer/src/curator_analyzer/__init__.py`.
export const EXPECTED_ANALYZER_VERSION = '2.4.0';

// Rows stamped below this version are re-queued for a FULL re-analysis on
// boot (Path A backfill in design.md). Deliberately decoupled from
// EXPECTED_ANALYZER_VERSION: not every bump changes the grid/key/scalars.
// 2.4.0 only added the fingerprint stage, and re-running the whole pipeline
// over the ~5k rows already at 2.3.0 would burn hours producing identical
// output — missing prints are picked up by the decode-only pass in
// backfillMissingFingerprints instead. Raise this floor only when a bump
// actually changes what the existing stages produce.
export const MIN_FULL_REANALYSIS_VERSION = '2.3.0';

// Dotted-numeric version parse. A marker that isn't one ('rekordbox', or a
// hand-edited row) comes back null.
function parseVersion(v: string): number[] | null {
	const parts = v.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
	return parts.length > 0 && parts.every((n) => Number.isInteger(n)) ? parts : null;
}

// Whether a track_analysis row at `analyzerVersion` is stale enough for the
// boot-time full re-analysis. Numeric compare per component — '2.10.0' is
// newer than '2.9.0', which a string compare gets wrong. An unparsable
// marker counts as stale (the old `!= expected` behaviour) except
// 'rekordbox': that marker tags rows whose grid came from the rb importer;
// running the analyzer over them would preserve the grid anyway
// (persistResult writes only what the pass produced) and just restamp the
// marker, so the cycle would repeat on every boot until the user intervened.
export function needsFullReanalysis(analyzerVersion: string): boolean {
	if (analyzerVersion === 'rekordbox') return false;
	const have = parseVersion(analyzerVersion);
	if (!have) return true;
	const min = parseVersion(MIN_FULL_REANALYSIS_VERSION)!;
	for (let i = 0; i < Math.max(have.length, min.length); i++) {
		const a = have[i] ?? 0;
		const b = min[i] ?? 0;
		if (a !== b) return a < b;
	}
	return false;
}

// The fingerprint-only pass: decode + Chromaprint and nothing else (~1 s per
// track). Every other stage is skipped explicitly rather than left to the
// worker's defaults so the pass stays cheap even for a track that has no
// prior grid/key to inject. `features: []` keeps MusicExtractor off.
export const FINGERPRINT_ONLY_OPTIONS: AnalyzeOptions = {
	skipBeatgrid: true,
	skipKey: true,
	skipSegments: true,
	skipPeaks: true,
	features: [],
};

// Priority of the fingerprint backfill — below scanner ingest and the
// stale-version backfill (0), so a newly ingested track never waits behind a
// multi-thousand-track print sweep. It is the floor the dispatcher honours
// while auto-analyze is on (see dispatchFloor).
export const FINGERPRINT_BACKFILL_PRIORITY = -1;

export interface AnalysisQueueOptions {
	// Root for .cpk files. The queue derives two subdirectories:
	//   <peaksDir>/lo/<uuid>.cpk  → 20 Hz strip (small, always-loaded)
	//   <peaksDir>/hi/<uuid>.cpk  → 100 Hz detail (loaded for deck view)
	// Splitting by directory keeps a 10k-track library at ≤10k files per
	// directory instead of 20k mixed — easier on file-managers + on NTFS,
	// and lets the user wipe one tier independently.
	peaksDir: string;
	// Max in-flight dispatches at once. Defaults to the sidecar pool size
	// (4) but you can lower it if the analyzer is starving other workloads.
	concurrency?: number;
}

// Display name "Artist, Artist — Title" for a track, used by the analyzer
// status surfaces (the `started` event + getAnalysisStatus) so the renderer's
// chip can list running tracks by name even for rows not in the loaded page
// (e.g. the boot-time backfill). Falls back to the title alone when no artists.
export function formatAnalyzerTrackName(title: string, artists: TrackArtist[] | null | undefined): string {
	const a = (artists ?? []).map((x) => x.name).filter(Boolean).join(', ');
	return a ? `${a} — ${title}` : title;
}

export type AnalysisJobEvent =
	| { kind: 'enqueued';   trackId: string }
	| { kind: 'started';    trackId: string; name: string }
	| { kind: 'progress';   trackId: string; stage: ProgressEvent['stage']; pct: number | null }
	| { kind: 'partial';    trackId: string; fields: Record<string, unknown> }
	| { kind: 'completed';  trackId: string }
	| { kind: 'failed';     trackId: string; errorKind: string; message: string }
	| { kind: 'cancelled';  trackId: string };

const DEFAULT_CONCURRENCY = 4;

// Priority floor that gates background (auto) work when the user has
// "Automatically analyze new tracks" turned off. Jobs at priority >= this
// always dispatch (user-initiated paths); jobs below it wait. The Analyze
// modal + any future explicit re-analyze button enqueue at 100, which is
// well above the 0 used by scanner ingest + stale-version backfill and the
// -1 of the fingerprint backfill.
const AUTO_PRIORITY_GATE = 100;

export class AnalysisQueue extends EventEmitter {
	private readonly concurrency: number;
	private inflight = new Set<string>();

	// True while any analysis is running — other heavy background lanes (the
	// AI engine's backfill) back off so the two never fight for the machine.
	get busy(): boolean { return this.inflight.size > 0; }
	// Track ids the caller asked to cancel after dispatch — we ignore the
	// (eventual) result and let it land in `error` state with kind='cancelled'.
	private cancelled = new Set<string>();
	private draining = false;
	// Per-track analyzer overrides supplied by `enqueue({ analyzeOptions })`.
	// Read by dispatchOne and forwarded into the sidecar.analyze() call,
	// then cleared on completion. Memory-only — if the app restarts between
	// enqueue and dispatch, the override is lost and the basic-default
	// pipeline runs (acceptable; the user can re-trigger from the Analyze
	// window).
	private pendingOptions = new Map<string, AnalyzeOptions>();
	// Auto-enable gate. When false, the queue does NOT dispatch jobs at
	// priority < AUTO_PRIORITY_GATE (background work from scanner ingest +
	// stale-version backfill). User-initiated jobs (Analyze modal, etc.)
	// enqueue at priority 100 and continue to dispatch regardless.
	// Renderer pushes the value via service.setAutoAnalyzeNewTracks; the
	// default-false state means a fresh app start does no analyzer work
	// until the user explicitly opts in. `setAutoEnabled(true)` also
	// triggers the stale-version backfill — that's the only place backfill
	// runs now (formerly fired unconditionally in the constructor).
	private autoEnabled = false;

	constructor(
		private readonly db: Db,
		private readonly sidecar: AnalyzerSidecar,
		private readonly opts: AnalysisQueueOptions,
	) {
		super();
		this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
		this.hydrate();
		this.wireSidecarEvents();
	}

	// Reset `running` rows back to `queued` on construction. A crash mid-
	// analysis would otherwise leave them stuck in `running` forever.
	// Does NOT call backfillStaleVersionTracks anymore — that's gated
	// behind the auto-enable flag and triggered from setAutoEnabled(true)
	// once the renderer has pushed the user's preference.
	private hydrate(): void {
		this.db
			.update(analysisJob)
			.set({ state: 'queued', startedAt: null })
			.where(eq(analysisJob.state, 'running'))
			.run();
	}

	// Toggle the auto-enable gate. When enabling, also trigger the two
	// backfills (cheap idempotent ops) and kick the drain loop so any queued
	// background jobs start moving. When disabling, the in-flight jobs
	// continue (no abrupt cancellation) but no new background jobs dispatch
	// until re-enabled.
	//
	// Order matters: the stale-version backfill runs first (synchronously)
	// so its full re-analysis jobs — which fingerprint as part of the default
	// pipeline — are already `queued` when the fingerprint backfill looks,
	// and get skipped by it rather than downgraded.
	setAutoEnabled(enabled: boolean): void {
		const wasEnabled = this.autoEnabled;
		this.autoEnabled = enabled;
		if (enabled && !wasEnabled) {
			this.backfillStaleVersionTracks();
			this.backfillMissingFingerprints().catch((err) => {
				qlog.error('fingerprint backfill failed', err);
			});
			this.drain();
		}
	}

	// Path A backfill — find every track_analysis row whose analyzer_version
	// is below MIN_FULL_REANALYSIS_VERSION (see needsFullReanalysis for the
	// rekordbox exclusion) and ensure an analysis_job row exists in `queued`
	// state. Priority 0 so explicit user-driven re-analyses (priority 100)
	// still preempt. Done in one pass when auto-analyze is enabled; the
	// regular drain loop picks up from there.
	private backfillStaleVersionTracks(): void {
		// The set of distinct versions is tiny (a handful of releases plus the
		// 'rekordbox' marker), so classify those in JS and let SQL do the
		// row filtering with an IN list — a string compare in SQL would get
		// '2.10.0' vs '2.9.0' wrong, and pulling every row's version out to
		// compare in JS would move ~5k rows for a common no-op boot.
		const staleVersions = this.db
			.selectDistinct({ version: trackAnalysis.analyzerVersion })
			.from(trackAnalysis)
			.all()
			.map((r) => r.version)
			.filter((v) => needsFullReanalysis(v));
		if (staleVersions.length === 0) return;
		// Only re-enqueue tracks that still have a LOCAL file to analyze. The
		// analyzer reads local audio; pickBatch inner-joins source_link
		// (source='local') and silently skips anything without one. A track
		// analyzed long ago (e.g. v2.1.0) that's since become streaming-only
		// (no local source_link) would otherwise be enqueued here, never get
		// picked up, and sit in `queued` forever — the chip counts it as
		// pending work that can't run, and every boot re-creates it after
		// clearPending() wiped it on the prior close. Mirroring pickBatch's
		// local-link constraint keeps the backfill to jobs that can actually
		// dispatch; the streaming-only track keeps its existing (slightly
		// stale) analysis, which is the right call when there's no file to
		// recompute from. selectDistinct because a track with two local links
		// would otherwise appear twice.
		const stale = this.db
			.selectDistinct({ trackId: trackAnalysis.trackId })
			.from(trackAnalysis)
			.innerJoin(sourceLink, and(
				eq(sourceLink.trackId, trackAnalysis.trackId),
				eq(sourceLink.source, 'local'),
				// Live links only, as pickBatch — a missing_at link has no file.
				isNull(sourceLink.missingAt),
			))
			.where(inArray(trackAnalysis.analyzerVersion, staleVersions))
			.all();
		if (stale.length === 0) return;

		const now = Date.now();
		const existing = this.db
			.select({ trackId: analysisJob.trackId, state: analysisJob.state })
			.from(analysisJob)
			.where(inArray(analysisJob.trackId, stale.map((r) => r.trackId)))
			.all();
		const existingMap = new Map(existing.map((r) => [r.trackId, r.state] as const));

		let enqueued = 0;
		for (const { trackId } of stale) {
			const cur = existingMap.get(trackId);
			if (cur === 'queued' || cur === 'running') continue;
			if (!cur) {
				const row: NewAnalysisJob = {
					trackId,
					state: 'queued',
					priority: 0,
					error: null,
					errorKind: null,
					enqueuedAt: new Date(now),
					startedAt: null,
					finishedAt: null,
				};
				this.db.insert(analysisJob).values(row).run();
			} else {
				// 'done' | 'error' | 'skipped' — flip to queued at priority 0.
				this.db.update(analysisJob)
					.set({
						state: 'queued',
						priority: 0,
						error: null,
						errorKind: null,
						enqueuedAt: new Date(now),
						startedAt: null,
						finishedAt: null,
					})
					.where(eq(analysisJob.trackId, trackId))
					.run();
			}
			enqueued++;
			this.emitEvent({ kind: 'enqueued', trackId });
		}
		if (enqueued > 0) {
			qlog.info('Path A backfill: enqueued stale track(s)', { enqueued, staleVersions, minVersion: MIN_FULL_REANALYSIS_VERSION });
		}
		this.drain();
	}

	// Fingerprint backfill — every local file whose source_link has no
	// Chromaprint yet gets a decode-only pass (FINGERPRINT_ONLY_OPTIONS) at
	// the lowest priority. Covers the library analysed before 2.4.0 and any
	// track whose print failed or was skipped. Runs once per auto-enable;
	// clearPending() wipes unfinished jobs on close, so an interrupted sweep
	// simply rebuilds from `fingerprint IS NULL` on the next boot.
	//
	// Candidates exclude:
	//   • links the watcher has already flagged missing (missing_at) and,
	//     for the rest, paths that fail a stat — otherwise dispatchOne would
	//     drop the link and raise a 'missing_file' failure for each one;
	//   • tracks already queued/running (a fuller pass is on its way and
	//     fingerprints anyway);
	//   • tracks whose last job ended in `error` — those errors are sticky
	//     by design (a corrupt file fails decode every time) and wait for an
	//     explicit re-analysis rather than a retry on every boot.
	// The stat pass is async so a 5k-file sweep doesn't block the main loop
	// at boot; the enqueue itself is one synchronous batch at the end.
	private async backfillMissingFingerprints(): Promise<void> {
		const rows = this.db
			.select({ trackId: sourceLink.trackId, path: sourceLink.filePath, jobState: analysisJob.state })
			.from(sourceLink)
			.leftJoin(analysisJob, eq(analysisJob.trackId, sourceLink.trackId))
			.where(and(
				eq(sourceLink.source, 'local'),
				isNull(sourceLink.fingerprint),
				isNull(sourceLink.missingAt),
			))
			.all();
		const candidates = rows.filter((r): r is typeof r & { path: string } =>
			!!r.path && r.jobState !== 'queued' && r.jobState !== 'running' && r.jobState !== 'error');
		if (candidates.length === 0) return;

		const ids = new Set<string>();
		const CHUNK = 64;
		for (let i = 0; i < candidates.length; i += CHUNK) {
			const chunk = candidates.slice(i, i + CHUNK);
			const present = await Promise.all(chunk.map((c) => fileExists(c.path)));
			chunk.forEach((c, j) => { if (present[j]) ids.add(c.trackId); });
		}
		if (ids.size === 0) return;
		// force: most of these jobs are `done` from the full analysis that
		// predates the fingerprint stage. enqueue() refuses to downgrade the
		// options of a track that got queued at a higher priority while the
		// stat pass was running, so the race with scanner ingest is benign.
		this.enqueue([...ids], {
			priority: FINGERPRINT_BACKFILL_PRIORITY,
			force: true,
			analyzeOptions: FINGERPRINT_ONLY_OPTIONS,
		});
		qlog.info('fingerprint backfill: enqueued track(s)', { enqueued: ids.size, candidates: candidates.length });
	}

	private wireSidecarEvents(): void {
		this.sidecar.on('progress', (e: ProgressEvent) => {
			this.emitEvent({ kind: 'progress', trackId: e.trackId, stage: e.stage, pct: e.pct });
		});
		this.sidecar.on('partial', (e) => {
			this.emitEvent({ kind: 'partial', trackId: e.trackId, fields: e.fields });
		});
		// On sidecar respawn the queue isn't notified directly — drain() is
		// resilient (every dispatch checks sidecar availability via the
		// returned promise). When the sidecar comes back, the next external
		// enqueue or a manual kick will resume draining; in practice the
		// renderer's "Reanalyze" click is the kick.
	}

	// Enqueue one or more tracks. Existing `done` rows are skipped unless
	// `force` is set (explicit re-analysis path). Existing `queued`/`running`
	// rows are kept as-is but get their priority bumped if the incoming
	// priority is higher — this makes "user opened a track that was already
	// in the eager backlog" do the right thing.
	//
	// `analyzeOptions` — per-call analyzer tuning forwarded to the sidecar
	// at dispatch time. Used by the Analyze window to opt-in to advanced
	// feature computation (MusicExtractor is skipped by default; setting
	// `options.features = [...]` re-enables it).
	enqueue(
		trackIds: string[],
		opts: { priority?: number; force?: boolean; analyzeOptions?: AnalyzeOptions } = {},
	): void {
		const priority = opts.priority ?? 0;
		if (trackIds.length === 0) return;
		const now = Date.now();
		const existing = trackIds.length > 0
			? this.db
				.select({ trackId: analysisJob.trackId, state: analysisJob.state, priority: analysisJob.priority })
				.from(analysisJob)
				.where(inArray(analysisJob.trackId, trackIds))
				.all()
			: [];
		const existingMap = new Map(existing.map((r) => [r.trackId, r] as const));

		for (const id of trackIds) {
			const cur = existingMap.get(id);
			if (cur && cur.state === 'done' && !opts.force) continue;

			// Per-track options travel with the (re)queue below. An already-
			// queued row keeps the options it has when the incoming priority
			// is lower: the fingerprint backfill (-1) must not downgrade a
			// pending auto/manual pass (0/100) to the decode-only pipeline.
			// Equal-or-higher wins (the Analyze modal re-submitted with new
			// flags). Running rows are past the point where options matter —
			// dispatchOne clears their entry on completion.
			let adoptOptions = false;
			if (!cur) {
				const row: NewAnalysisJob = {
					trackId: id,
					state: 'queued',
					priority,
					error: null,
					errorKind: null,
					enqueuedAt: new Date(now),
					startedAt: null,
					finishedAt: null,
				};
				this.db.insert(analysisJob).values(row).run();
				adoptOptions = true;
			} else if (cur.state === 'queued') {
				if (cur.priority < priority) {
					this.db.update(analysisJob)
						.set({ priority })
						.where(eq(analysisJob.trackId, id))
						.run();
				}
				adoptOptions = cur.priority <= priority;
			} else if ((cur.state === 'done' || cur.state === 'error' || cur.state === 'skipped') && opts.force) {
				// Re-queue a terminal job. We deliberately do NOT delete the
				// track_analysis row: the analyzer owns only the Curator slot
				// (the rb_* slot is the importer's), and persistResult preserves
				// any field this pass doesn't recompute, so a re-analyze never
				// drops a beatgrid/key/segments. (The old `done && force` branch
				// wiped the whole row — that destroyed rb-imported grids and
				// defeated the preserve guards; see the dual-source plan.)
				this.db.update(analysisJob)
					.set({
						state: 'queued',
						priority,
						error: null,
						errorKind: null,
						enqueuedAt: new Date(now),
						startedAt: null,
						finishedAt: null,
					})
					.where(eq(analysisJob.trackId, id))
					.run();
				adoptOptions = true;
			}
			if (adoptOptions && opts.analyzeOptions) this.pendingOptions.set(id, opts.analyzeOptions);

			this.emitEvent({ kind: 'enqueued', trackId: id });
		}
		this.drain();
	}

	// Discard the pending queue. Deletes every job that hasn't reached a
	// terminal state (queued + running) so nothing resumes on next boot —
	// called from CoreService.close(). The user's intent is "I'm done for
	// now, don't grind through the backlog next launch"; terminal rows
	// (done / error / skipped) are history and stay, so enqueue()'s skip-
	// done guard and the stale-version backfill still behave on reboot.
	//
	// Running rows are deleted too: the analyzer sidecar is being torn down
	// in the same close() pass, so any in-flight result would have nowhere
	// to land. We don't bother clearing `inflight` / `cancelled` — the
	// process is exiting.
	clearPending(): void {
		this.db
			.delete(analysisJob)
			.where(inArray(analysisJob.state, ['queued', 'running']))
			.run();
	}

	cancel(trackId: string): void {
		const row = this.db
			.select({ state: analysisJob.state })
			.from(analysisJob)
			.where(eq(analysisJob.trackId, trackId))
			.get();
		if (!row) return;
		if (row.state === 'queued') {
			this.db.delete(analysisJob).where(eq(analysisJob.trackId, trackId)).run();
			this.emitEvent({ kind: 'cancelled', trackId });
			return;
		}
		if (row.state === 'running') {
			this.cancelled.add(trackId);
			this.sidecar.cancel(trackId);
		}
	}

	// Reads — used by the IPC surface.
	getJob(trackId: string): AnalysisJob | null {
		return this.db.select().from(analysisJob).where(eq(analysisJob.trackId, trackId)).get() ?? null;
	}

	// Priority floor the dispatcher currently honors (pickBatch reads it).
	// Jobs queued below it are *parked* — they won't dispatch until
	// auto-analyze is enabled. Exposed so the status surface counts only
	// dispatchable queued jobs: parked background work (scanner ingest /
	// stale-version backfill at 0, fingerprint backfill at -1) shouldn't read
	// as active analysis on the chip. With auto on, the floor is the lowest
	// priority any producer uses, so everything dispatches.
	dispatchFloor(): number {
		return this.autoEnabled ? FINGERPRINT_BACKFILL_PRIORITY : AUTO_PRIORITY_GATE;
	}

	// Dispatch loop. Idempotent + reentrant-safe (early-return when
	// already draining). Called from enqueue() and after each completion.
	// Fills every free worker slot from ONE pickBatch query per pass —
	// the previous one-query-per-dispatch shape meant priming a 4-worker
	// pool from a 10k-job backfill issued 4 separate ordered scans, and
	// every job completion paid another.
	private drain(): void {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.inflight.size < this.concurrency) {
				const batch = this.pickBatch(this.concurrency - this.inflight.size);
				if (batch.length === 0) break;
				for (const next of batch) {
					// dispatchOne adds to `inflight` synchronously before its
					// first await, so the while-condition above stays accurate
					// across the batch.
					this.dispatchOne(next).catch((err) => {
						// dispatchOne is supposed to swallow its own errors — if
						// one slips through, log and keep draining so the queue
						// doesn't stall.
						qlog.error('dispatch threw', err);
					});
				}
			}
		} finally {
			this.draining = false;
		}
	}

	private pickBatch(count: number): Array<{ trackId: string; path: string }> {
		// One query: join analysis_job → source_link (source='local') so we
		// only dispatch tracks that actually have a local file to analyze.
		// Skip rows already in flight (claimed by an earlier loop iteration).
		// Over-fetch by the in-flight count so the skip pass still leaves
		// `count` dispatchable rows. Hits analysis_job_dispatch_idx
		// (state, priority, enqueued_at).
		//
		// Auto-enable gate: when the user has automatic analysis turned
		// off, only dispatch jobs at priority >= AUTO_PRIORITY_GATE
		// (user-initiated work like the Analyze modal, which enqueues at
		// 100). Background work (scanner ingest + stale-version backfill at
		// priority 0, fingerprint backfill at -1) waits in 'queued' state
		// until the user turns the toggle back on, at which point
		// setAutoEnabled(true) kicks drain() and they all start flowing.
		const priorityFloor = this.dispatchFloor();
		const rows = this.db
			.select({
				trackId: analysisJob.trackId,
				path: sourceLink.filePath,
			})
			.from(analysisJob)
			.innerJoin(sourceLink, and(
				eq(sourceLink.trackId, analysisJob.trackId),
				eq(sourceLink.source, 'local'),
				// A link the watcher flagged missing_at is a vanished file kept
				// as a re-bind hint (scanner.ts), not audio to read — dispatching
				// it would only trip the stale-link guard in dispatchOne.
				isNull(sourceLink.missingAt),
			))
			.where(and(
				eq(analysisJob.state, 'queued'),
				gte(analysisJob.priority, priorityFloor),
			))
			.orderBy(desc(analysisJob.priority), asc(analysisJob.enqueuedAt))
			.limit(this.inflight.size + count)
			.all();
		const out: Array<{ trackId: string; path: string }> = [];
		const claimed = new Set<string>();
		for (const r of rows) {
			if (!r.path) continue;
			// A track with two local source_links appears twice in the join —
			// claim it once per batch.
			if (this.inflight.has(r.trackId) || claimed.has(r.trackId)) continue;
			claimed.add(r.trackId);
			out.push({ trackId: r.trackId, path: r.path });
			if (out.length >= count) break;
		}
		return out;
	}

	private async dispatchOne(target: { trackId: string; path: string }): Promise<void> {
		const { trackId, path } = target;
		this.inflight.add(trackId);
		this.db.update(analysisJob)
			.set({ state: 'running', startedAt: new Date() })
			.where(eq(analysisJob.trackId, trackId))
			.run();
		// Resolve the display name so the chip can list this track even when it
		// isn't in the renderer's loaded page. One cheap indexed read.
		const meta = this.db
			.select({ title: track.title, artists: track.artists })
			.from(track)
			.where(eq(track.id, trackId))
			.get();
		this.emitEvent({ kind: 'started', trackId, name: meta ? formatAnalyzerTrackName(meta.title, meta.artists) : trackId });

		// Stale-source-link guard: the source_link points at a file path, but
		// the file may have been moved/renamed/deleted since the row was
		// written. If we send a missing path to the sidecar it returns a
		// noisy decode error ("Could not open file ...") that surfaces in
		// the toast / console for every queued job until the user notices.
		// Catch it cheaply here: stat the path; if it doesn't exist, flag the
		// local source_link missing_at (NOT delete it: the scanner keeps a
		// vanished file's link as a re-bind hint so a moved file re-attaches
		// by audio hash, and a boot-time backfill can dispatch before the
		// watcher's add pass has re-pointed it), mark the job 'skipped' with
		// errorKind='missing_file', and move on.
		try {
			await fsp.access(path, fsConstants.R_OK);
		} catch {
			qlog.warn('missing file — flagging source_link missing', { trackId, path });
			this.db.update(sourceLink)
				.set({ missingAt: new Date() })
				.where(and(
					eq(sourceLink.trackId, trackId),
					eq(sourceLink.source, 'local'),
					eq(sourceLink.filePath, path),
					isNull(sourceLink.missingAt),
				))
				.run();
			this.db.update(analysisJob)
				.set({ state: 'skipped', error: `file not found: ${path}`, errorKind: 'missing_file', finishedAt: new Date() })
				.where(eq(analysisJob.trackId, trackId))
				.run();
			this.emitEvent({ kind: 'failed', trackId, errorKind: 'missing_file', message: `file not found: ${path}` });
			this.inflight.delete(trackId);
			this.drain();
			return;
		}

		const outPeaksLoPath = join(this.opts.peaksDir, 'lo', `${trackId}.cpk`);
		const outPeaksHiPath = join(this.opts.peaksDir, 'hi', `${trackId}.cpk`);
		const analyzeOptions = this.pendingOptions.get(trackId);
		// Prior-grid injection: when the track already has a beatgrid +
		// bpm in track_analysis and the user hasn't ticked
		// overrideBeatgrid, pass them to the worker so it can skip
		// RhythmExtractor2013 (the slowest stage in the basic pipeline,
		// ~2-3s/track). Downstream stages (segment detection, novelty
		// smoothing) anchor on the authoritative grid instead of a
		// freshly-detected-then-discarded one.
		const effectiveOptions = this.buildEffectiveOptions(trackId, analyzeOptions);
		// Waveform skip: don't regenerate peaks that already exist on disk
		// unless the user ticked the Waveform override in the Analyze modal.
		// A brand-new track (no .cpk yet) always gets peaks — unless the pass
		// itself opted out (the fingerprint backfill sets skipPeaks up front;
		// re-setting it here is a no-op). Clone the effective options so we
		// never mutate the stored / pending ones.
		let dispatchOptions = effectiveOptions;
		if (!analyzeOptions?.overridePeaks && await fileExists(outPeaksHiPath)) {
			dispatchOptions = { ...(effectiveOptions ?? {}), skipPeaks: true };
		}
		try {
			const result = await this.sidecar.analyze({ trackId, path, outPeaksLoPath, outPeaksHiPath, options: dispatchOptions });
			if (this.cancelled.delete(trackId)) {
				// Treat post-hoc cancel as success-but-discard — the file is
				// already written. Marking it `done` would mislead the UI.
				this.db.update(analysisJob)
					.set({ state: 'skipped', finishedAt: new Date() })
					.where(eq(analysisJob.trackId, trackId))
					.run();
				this.emitEvent({ kind: 'cancelled', trackId });
				return;
			}
			this.persistResult(result, path);
			this.db.update(analysisJob)
				.set({ state: 'done', finishedAt: new Date() })
				.where(eq(analysisJob.trackId, trackId))
				.run();
			this.emitEvent({ kind: 'completed', trackId });
		} catch (err) {
			const e = err as SidecarError;
			const kind = e.kind ?? 'internal';
			const message = e.message ?? String(err);
			// `sidecar_unavailable` is transient — leave the row queued so we
			// retry when the sidecar comes back. All other kinds are sticky:
			// mark `error`, surface in UI, wait for explicit re-analysis.
			if (kind === 'sidecar_unavailable') {
				this.db.update(analysisJob)
					.set({ state: 'queued', startedAt: null })
					.where(eq(analysisJob.trackId, trackId))
					.run();
			} else if (kind === 'cancelled' || this.cancelled.delete(trackId)) {
				this.db.update(analysisJob)
					.set({ state: 'skipped', finishedAt: new Date() })
					.where(eq(analysisJob.trackId, trackId))
					.run();
				this.emitEvent({ kind: 'cancelled', trackId });
			} else {
				this.db.update(analysisJob)
					.set({
						state: 'error',
						error: message,
						errorKind: kind,
						finishedAt: new Date(),
					})
					.where(eq(analysisJob.trackId, trackId))
					.run();
				this.emitEvent({ kind: 'failed', trackId, errorKind: kind, message });
			}
		} finally {
			this.inflight.delete(trackId);
			// Drop any per-track override now that the dispatch is finished.
			// If the dispatch failed-transient (sidecar_unavailable, row left
			// 'queued') the next enqueue() with options would re-store them;
			// dropping here keeps the map from accumulating ghost entries.
			this.pendingOptions.delete(trackId);
			// Keep draining — there may be more queued tracks now that this
			// slot is free.
			this.drain();
		}
	}

	// Build the analyze() options for a dispatch by layering prior-value
	// injection on top of any user-supplied options. For each of the four
	// "respected" fields (beatgrid, bpm, key, segments) we inject the
	// existing values when:
	//   • the row already has them, AND
	//   • the user has NOT requested the corresponding override flag
	//     (which means "yes, actually compute a fresh value this time")
	// The worker then skips the matching detection stage, saving CPU and
	// keeping the row's values stable. The TS-side preserve guards in
	// persistResult are still load-bearing for the override path.
	private buildEffectiveOptions(
		trackId: string,
		opts: AnalyzeOptions | undefined,
	): AnalyzeOptions | undefined {
		const prior = this.db
			.select({
				beatgrid: trackAnalysis.beatgrid,
				downbeats: trackAnalysis.downbeats,
				bpm: trackAnalysis.bpm,
				keyCamelot: trackAnalysis.keyCamelot,
				keyStrength: trackAnalysis.keyStrength,
				segmentsJson: trackAnalysis.segmentsJson,
			})
			.from(trackAnalysis)
			.where(eq(trackAnalysis.trackId, trackId))
			.get();
		if (!prior) return opts;

		const unpack = (buf: Buffer): number[] => {
			const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
			return Array.from(view);
		};

		const injected: AnalyzeOptions = { ...(opts ?? {}) };
		let anyInjection = false;

		if (!opts?.overrideBeatgrid && prior.beatgrid && prior.bpm != null) {
			injected.priorBeatgrid = unpack(prior.beatgrid);
			if (prior.downbeats) injected.priorDownbeats = unpack(prior.downbeats);
			injected.priorBpm = prior.bpm;
			anyInjection = true;
		}
		if (!opts?.overrideKey && prior.keyCamelot != null) {
			injected.priorKey = prior.keyCamelot;
			if (prior.keyStrength != null) injected.priorKeyStrength = prior.keyStrength;
			anyInjection = true;
		}
		if (!opts?.overrideSegments && prior.segmentsJson != null) {
			injected.skipSegments = true;
			anyInjection = true;
		}

		return anyInjection ? injected : opts;
	}

	// `filePath` is the local source_link path this result was computed from
	// (the one pickBatch dispatched) — the fingerprint is a property of that
	// file, not of the track, so it lands on that link row.
	private persistResult(result: AnalyzeResult, filePath: string): void {
		// Beatgrid + downbeats land as packed Float32LE BLOBs. Easier for the
		// renderer to parse than a JSON array of doubles (less GC pressure,
		// half the storage). Build them up-front and pass as Buffer.
		const toFloat32Buffer = (vals: number[]): Buffer => {
			const arr = new Float32Array(vals);
			return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
		};

		// Write-when-produced guards. The analyzer owns ONLY the Curator slot
		// (the existing columns); the Rekordbox slot (rb_*) is the importer's
		// and is never touched here, so there's no rb grid to protect anymore.
		// What we still must not do is clobber a good Curator value with an
		// empty one when a stage was skipped this pass: a skipped beatgrid
		// returns [] (skip_beatgrid, or auto-analyze with beatgrid off), a
		// skipped key returns null, a skipped structure stage returns []. So
		// each field is written only when THIS pass produced it; otherwise the
		// prior Curator value stays. The override flags don't gate persist —
		// they drive prior-injection in buildEffectiveOptions (reuse vs
		// re-detect); whatever the worker returns is what we store.
		const hasResultBeatgrid = result.beatgrid.length > 0;
		const hasResultBpm = result.bpm != null;
		const hasResultKey = result.key_camelot != null;
		const row: NewTrackAnalysis = {
			trackId: result.track_id,
			bpm: result.bpm,
			beatgrid: toFloat32Buffer(result.beatgrid),
			downbeats: toFloat32Buffer(result.downbeats),
			keyCamelot: result.key_camelot,
			keyStrength: result.key_strength,
			brightness: result.brightness,
			power: result.power,
			dynamicComplexity: result.dynamic_complexity,
			loudnessRangeLu: result.loudness_range_lu,
			dissonance: result.dissonance,
			density: result.density,
			// Phase 2A — segments + derived scalars. Always populated on the
			// INSERT path (used for a brand-new row). The UPDATE path treats
			// these as an atomic group (see segmentSet below) so a failed
			// structure stage doesn't wipe a previously-good labelling.
			// AnalyzerSegment from sidecar.ts has the same camelCase shape as
			// SegmentRecord (startSec / endSec / label / confidence / energy),
			// so the array passes through Drizzle's JSON column unchanged.
			segmentsJson: result.segments,
			introLengthSec: result.intro_length_sec,
			outroLengthSec: result.outro_length_sec,
			firstDropSec: result.first_drop_sec,
			dropCount: result.drop_count,
			breakdownCount: result.breakdown_count,
			featuresJson: result.features,
			duration: result.duration,
			analyzerVersion: result.analyzer_version,
			analyzedAt: new Date(),
		};

		// Basic analyses (MusicExtractor skipped — the new default) return
		// null for every advanced scalar and {} for featuresJson. If we
		// always-overwrote, a scanner-driven re-run would wipe advanced
		// values the user previously computed via the Analyze window. So
		// the UPDATE-on-conflict shape splits into:
		//   • always-overwrite columns — bpm/key/beatgrid/duration/peaks/etc.
		//     (the basic-pipeline outputs; every analyze pass refreshes them)
		//   • conditional columns — the six ME-derived scalars + features
		//     JSON; written only when non-null/non-empty, preserving the
		//     prior value when this pass didn't compute them.
		// INSERT path is untouched: a brand-new row gets null for whatever
		// wasn't computed, which is the right starting state.
		const featuresHasData = result.features && Object.keys(result.features).length > 0;
		const advancedSet: Partial<NewTrackAnalysis> = {};
		if (row.brightness !== null) advancedSet.brightness = row.brightness;
		if (row.power !== null) advancedSet.power = row.power;
		if (row.dynamicComplexity !== null) advancedSet.dynamicComplexity = row.dynamicComplexity;
		if (row.loudnessRangeLu !== null) advancedSet.loudnessRangeLu = row.loudnessRangeLu;
		if (row.dissonance !== null) advancedSet.dissonance = row.dissonance;
		if (row.density !== null) advancedSet.density = row.density;
		if (featuresHasData) advancedSet.featuresJson = row.featuresJson;

		const trackAdvancedSet: Record<string, number | null> = {};
		if (result.brightness !== null) trackAdvancedSet.brightness = result.brightness;
		if (result.power !== null) trackAdvancedSet.power = result.power;
		if (result.dynamic_complexity !== null) trackAdvancedSet.dynamicComplexity = result.dynamic_complexity;
		if (result.loudness_range_lu !== null) trackAdvancedSet.loudnessRangeLu = result.loudness_range_lu;
		if (result.dissonance !== null) trackAdvancedSet.dissonance = result.dissonance;
		if (result.density !== null) trackAdvancedSet.density = result.density;

		// Segment stage outputs are treated as an atomic group: either it ran
		// (segments array OR scalar counts are non-null) and we overwrite the
		// six fields together, or it failed (everything null/empty) and we
		// preserve the previous labelling. Mixed updates would let a failed
		// stage clear segments_json while leaving stale scalars in place —
		// no thanks. The same rule is mirrored to the `track` row.
		//
		// Layered on top of the atomic-group rule: the preserveSegments
		// guard (existing segments + no override flag) skips the write
		// entirely so a re-run doesn't replace user-trusted segments with
		// a fresh analyzer pass's labelling.
		const segmentStageRan = result.segments.length > 0 || result.drop_count !== null;
		const segmentSet: Partial<NewTrackAnalysis> = {};
		const trackSegmentSet: Record<string, number | null> = {};
		if (segmentStageRan) {
			segmentSet.segmentsJson = result.segments as never;
			segmentSet.introLengthSec = result.intro_length_sec;
			segmentSet.outroLengthSec = result.outro_length_sec;
			segmentSet.firstDropSec = result.first_drop_sec;
			segmentSet.dropCount = result.drop_count;
			segmentSet.breakdownCount = result.breakdown_count;
			trackSegmentSet.introLengthSec = result.intro_length_sec;
			trackSegmentSet.outroLengthSec = result.outro_length_sec;
			trackSegmentSet.firstDropSec = result.first_drop_sec;
			trackSegmentSet.dropCount = result.drop_count;
			trackSegmentSet.breakdownCount = result.breakdown_count;
		}

		// Build the analysis-row UPDATE set, gated by the preserve flags.
		// Each protected field is only written when no prior value exists
		// or the user opted into overwrite via the Analyze modal. The
		// always-overwrite columns (duration / analyzerVersion / analyzedAt)
		// are housekeeping and never gated.
		const analysisUpdateSet: Partial<NewTrackAnalysis> = {
			duration: row.duration,
			analyzerVersion: row.analyzerVersion,
			analyzedAt: row.analyzedAt,
			...advancedSet,
			...segmentSet,
		};
		if (hasResultBpm) analysisUpdateSet.bpm = row.bpm;
		if (hasResultBeatgrid) {
			analysisUpdateSet.beatgrid = row.beatgrid;
			analysisUpdateSet.downbeats = row.downbeats;
		}
		if (hasResultKey) {
			analysisUpdateSet.keyCamelot = row.keyCamelot;
			analysisUpdateSet.keyStrength = row.keyStrength;
		}

		// A fingerprint-only pass (backfillMissingFingerprints) over a track
		// that was never analysed produces nothing for track_analysis. Don't
		// mint a hollow row for it: one stamped with the current version but
		// empty of grid/key/scalars would read as "analysed" everywhere the
		// row's presence is the signal, and hide the track from a real pass.
		// An existing row still gets its housekeeping columns refreshed.
		const analysisStageRan = hasResultBpm || hasResultBeatgrid || hasResultKey
			|| segmentStageRan || Object.keys(advancedSet).length > 0;

		// All writes in one transaction so the track scalars never lag the
		// track_analysis row (or vice versa) under crash mid-write. UPDATE on
		// a missing track is a silent no-op — safe if the track was deleted
		// between dispatch and result landing.
		this.db.transaction((tx) => {
			if (analysisStageRan) {
				tx.insert(trackAnalysis)
					.values(row)
					.onConflictDoUpdate({
						target: trackAnalysis.trackId,
						set: analysisUpdateSet,
					})
					.run();
			} else {
				tx.update(trackAnalysis)
					.set(analysisUpdateSet)
					.where(eq(trackAnalysis.trackId, result.track_id))
					.run();
			}
			// Write-when-produced, like every other column: a skipped or
			// failed fingerprint stage returns null and leaves whatever the
			// link already carries. Matched on the dispatched path (not the
			// track) because a track with two local files has two prints.
			if (result.fingerprint) {
				tx.update(sourceLink)
					.set({ fingerprint: result.fingerprint, fingerprintDurationSec: result.fingerprint_duration_sec })
					.where(and(eq(sourceLink.source, 'local'), eq(sourceLink.filePath, filePath)))
					.run();
				// The print is a catalogue claim on the recording (design:
				// recording_claim); the analysis itself never rides the op log.
				addClaims(this.db, result.track_id, [{
					kind: 'fingerprint',
					value: result.fingerprint,
					...(result.fingerprint_duration_sec != null ? { durationSec: result.fingerprint_duration_sec } : {}),
				}]);
			}
			// Skip the track-mirror UPDATE entirely when this pass produced
			// no advanced scalars AND no segment-stage outputs — there's
			// nothing to write and an empty .set({}) throws at the Drizzle layer.
			const combinedTrackSet = { ...trackAdvancedSet, ...trackSegmentSet };
			if (Object.keys(combinedTrackSet).length > 0) {
				tx.update(track)
					.set(combinedTrackSet)
					.where(eq(track.id, result.track_id))
					.run();
			}
		});
	}

	private emitEvent(evt: AnalysisJobEvent): void {
		this.emit('event', evt);
	}
}
