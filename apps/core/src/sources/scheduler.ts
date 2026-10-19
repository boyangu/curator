// SourceSyncScheduler — per-source poll timer that drives auto read-sync.
// One scheduler instance per service lifetime, holding one timer per
// registered StreamingSource.
//
// Design notes:
//   • The renderer is the canonical store for SourceSyncSettings; it
//     pushes the current values via IPC on boot and on every user change.
//     applySettings() takes the new settings, cancels the existing timer
//     for that source, and sets a fresh one if readSyncAuto is true.
//   • We do NOT fire on the first call to applySettings — the renderer's
//     own bootstrap path (refreshAll → renderTracks) already pulls the
//     current state from the DB, and the existing manual "Sync now" flow
//     can be triggered if the user wants an immediate refresh. The auto-
//     poll exists to *catch up* the DB to remote drift, not to do the
//     initial load.
//   • Concurrency: we use a per-source `inFlight` flag so an overlapping
//     manual sync or a slow tick can't double-fire. Subsequent ticks
//     while one is in flight are skipped (not queued) — the next tick
//     will pick up whatever changed.
//   • Errors are logged but not surfaced as toasts (the user didn't
//     trigger this). The next tick retries naturally; if there's a real
//     auth problem the next manual sync will surface it.

import type { StreamingSource, SourceSyncSettings } from '@curator/shared';
import { log } from '../log.js';

const sslog = log.for('sync-scheduler');

type SyncRunner = () => Promise<unknown>;

interface SourceState {
	settings: SourceSyncSettings;
	timer: ReturnType<typeof setInterval> | null;
	inFlight: boolean;
}

export class SourceSyncScheduler {
	private readonly state = new Map<StreamingSource, SourceState>();
	private readonly runners = new Map<StreamingSource, SyncRunner>();

	// Register the function that performs one full sync pass for a source.
	// Called by the core service at construction — the runner is the
	// existing svc.runSpotifySync (which already short-circuits unchanged
	// playlists via snapshot_id, so calling it every N minutes is cheap).
	registerRunner(source: StreamingSource, runner: SyncRunner): void {
		this.runners.set(source, runner);
	}

	// Push new settings for a source. Cancels the current timer and
	// installs a fresh one when readSyncAuto is on. No-op when settings
	// haven't materially changed (avoids resetting the timer on every
	// keystroke if the renderer pushes too aggressively).
	applySettings(source: StreamingSource, settings: SourceSyncSettings): void {
		const cur = this.state.get(source);
		if (cur && cur.settings.readSyncAuto === settings.readSyncAuto && cur.settings.readIntervalMin === settings.readIntervalMin) {
			cur.settings = settings;
			return;
		}
		if (cur?.timer) {
			clearInterval(cur.timer);
			cur.timer = null;
		}
		const next: SourceState = {
			settings,
			timer: null,
			inFlight: cur?.inFlight ?? false,
		};
		if (settings.readSyncAuto) {
			const ms = Math.max(1, settings.readIntervalMin) * 60 * 1000;
			next.timer = setInterval(() => { void this.tick(source); }, ms);
		}
		this.state.set(source, next);
	}

	// Tear down every timer. Called by the service on shutdown.
	stopAll(): void {
		for (const [, s] of this.state) {
			if (s.timer) clearInterval(s.timer);
			s.timer = null;
		}
	}

	// Any source mid-sync (auto tick or manual run) — the backup scheduler
	// waits for the library to settle before snapshotting it.
	anyInFlight(): boolean {
		for (const [, s] of this.state) if (s.inFlight) return true;
		return false;
	}

	// Test/maintenance hook — fire the runner once if not already running.
	// Returns false when skipped due to in-flight overlap or missing runner.
	async runOnce(source: StreamingSource): Promise<boolean> {
		return this.tick(source);
	}

	// Wrap an externally-triggered sync (e.g. user clicked "Sync now") so it
	// participates in the scheduler's mutex + timer-reset logic. Caller passes
	// the actual sync function (any return type — we don't constrain it the
	// way registerRunner does). Effects:
	//   • Sets `inFlight` so an auto-tick can't fire alongside the manual run.
	//   • On completion, resets the auto-timer so the next tick is N minutes
	//     from NOW, not N minutes from the last scheduled boundary. Stops a
	//     user hitting "Sync now" at 4:59 from triggering another sync at
	//     5:00 just because the timer was already a few seconds from firing.
	// Throws when a sync is already in progress — caller (UI) can show an
	// "already syncing" toast.
	async aroundExternalRun<T>(source: StreamingSource, fn: () => Promise<T>): Promise<T> {
		const s = this.state.get(source);
		if (s?.inFlight) {
			throw new Error(`${source} sync already in progress`);
		}
		if (s) s.inFlight = true;
		try {
			return await fn();
		} finally {
			if (s) {
				s.inFlight = false;
				// Reset the interval timer so the next auto-tick is a full
				// interval away from this manual run. If auto-read is off
				// there's no timer to reset.
				if (s.settings.readSyncAuto) {
					if (s.timer) clearInterval(s.timer);
					const ms = Math.max(1, s.settings.readIntervalMin) * 60 * 1000;
					s.timer = setInterval(() => { void this.tick(source); }, ms);
				}
			}
		}
	}

	private async tick(source: StreamingSource): Promise<boolean> {
		const s = this.state.get(source);
		if (!s) return false;
		const runner = this.runners.get(source);
		if (!runner) return false;
		if (s.inFlight) {
			sslog.info('tick skipped — previous run still in flight', { source });
			return false;
		}
		s.inFlight = true;
		try {
			await runner();
			return true;
		} catch (err) {
			// Don't surface — auto-poll errors stay in the log. The user
			// didn't trigger this, so a toast would be noise. A real auth
			// problem will surface when the next manual sync runs.
			sslog.warn('tick failed', { source }, err);
			return false;
		} finally {
			s.inFlight = false;
		}
	}
}
