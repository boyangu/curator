// Analyzer-queue status store — live view of the analyzer pipeline for
// the TopFrame chip (running track ids / queued / session completed / last
// error). Event ingestion stays in main.ts's wireAnalysisEvents (it also drives
// analysisStore invalidation + row patches); this module owns the chip-facing
// state.
//
// "Session" counting: the chip's tooltip shows completed/total for the CURRENT
// batch. `completedSession` counts terminal events; it resets to 0 whenever the
// pipeline transitions from fully idle (nothing running or queued) back to
// active — so a new Analyze run starts its count fresh instead of inheriting
// the prior batch's tally. `reconcile()` (called from a fresh `analysis:status`
// query at boot and right after the user enqueues work) replaces the running
// set + queued count from DB truth, correcting any drift from the `enqueued`
// events that main deliberately filters out of the broadcast.
//
// `health` is the analyzer process itself (analysis:status + the
// analysis:health event). Running/queued alone can't tell work from a hang: a
// job is "running" from the moment it is handed over, whether or not anything
// is there to run it.

import { createStore, produce } from 'solid-js/store';
import type { AnalyzerHealth } from '@curator/core';

export interface AnalyzerStatusSnapshot {
	// Track ids currently mid-analysis (capped by the sidecar worker pool).
	running: string[];
	// Display names ("artist — title") for the running ids, same order. Resolved
	// by the backend (analysis:status + the started event) so names show even
	// for rows not in the renderer's loaded page.
	runningTracks: string[];
	runningCount: number;
	queuedCount: number;
	completedSession: number;
	lastError: { trackId: string; message: string } | null;
	health: AnalyzerHealth;
	// Epoch ms of the last analysis that finished (spans launches); null =
	// none on record.
	lastCompletedAt: number | null;
}

const [store, setStore] = createStore<{
	// trackId → display name.
	running: Record<string, string>;
	queuedCount: number;
	completedSession: number;
	lastError: { trackId: string; message: string } | null;
	// Wrapped: the variants differ in shape, and a store merges object fields
	// in place — a stale `reason` would survive a move to 'ready'.
	health: { value: AnalyzerHealth };
	lastCompletedAt: number | null;
}>({ running: {}, queuedCount: 0, completedSession: 0, lastError: null, health: { value: { state: 'off' } }, lastCompletedAt: null });

export const analysisStatus = {
	// Reactive snapshot for the TopFrame chip accessor.
	snapshot(): AnalyzerStatusSnapshot {
		const running = Object.keys(store.running);
		return {
			running,
			runningTracks: running.map((id) => store.running[id]!),
			runningCount: running.length,
			queuedCount: store.queuedCount,
			completedSession: store.completedSession,
			lastError: store.lastError,
			health: store.health.value,
			lastCompletedAt: store.lastCompletedAt,
		};
	},
	health(): AnalyzerHealth {
		return store.health.value;
	},
	setHealth(health: AnalyzerHealth): void {
		setStore('health', { value: health });
	},
	// From the analysis:status snapshot; never moves backwards (a completion
	// seen live may be newer than the snapshot that lands after it).
	seedLastCompleted(at: number | null): void {
		if (at !== null && at > (store.lastCompletedAt ?? 0)) setStore('lastCompletedAt', at);
	},
	isRunning(trackId: string): boolean {
		return store.running[trackId] !== undefined;
	},

	// Reset the session counters IF the pipeline is currently idle — i.e. a new
	// batch is starting. Called synchronously when the user enqueues (before the
	// enqueue IPC, so it reads the pre-batch state and can't race the `started`
	// events that follow). A no-op when work is already in flight, so adding to
	// a running batch keeps the running tally.
	beginBatch(): void {
		setStore(produce((s) => {
			if (Object.keys(s.running).length === 0 && s.queuedCount === 0) {
				s.completedSession = 0;
				s.lastError = null;
			}
		}));
	},
	// Replace running set + queued count from a fresh DB snapshot. Corrects the
	// drift from the filtered-out `enqueued` events; called at boot and right
	// after the user enqueues work. Tolerates both the current shape
	// ({trackId,name}) and a bare id string (older backend that predates the
	// name field), so a not-yet-restarted main process still populates running.
	reconcile(running: ({ trackId: string; name: string } | string)[], queued: number): void {
		setStore(produce((s) => {
			s.running = {};
			for (const r of running) {
				if (typeof r === 'string') s.running[r] = r;
				else s.running[r.trackId] = r.name || r.trackId;
			}
			s.queuedCount = queued;
		}));
	},
	started(trackId: string, name: string): void {
		setStore(produce((s) => {
			// Fall back to the id so a missing/empty name never collapses the
			// running entry (a Solid store treats an undefined value as no key,
			// which would drop the track from the running count + list).
			s.running[trackId] = name || trackId;
			s.queuedCount = Math.max(0, s.queuedCount - 1);
		}));
	},
	// The sidecar went away mid-job; the job is back in the queue.
	requeued(trackId: string): void {
		setStore(produce((s) => {
			delete s.running[trackId];
			s.queuedCount++;
		}));
	},
	completed(trackId: string): void {
		setStore(produce((s) => {
			delete s.running[trackId];
			s.completedSession++;
			s.lastError = null;
			s.lastCompletedAt = Date.now();
		}));
	},
	failed(trackId: string, message: string): void {
		setStore(produce((s) => {
			delete s.running[trackId];
			s.completedSession++;
			s.lastError = { trackId, message };
		}));
	},
	cancelled(trackId: string): void {
		setStore(produce((s) => {
			delete s.running[trackId];
			s.completedSession++;
		}));
	},
};
