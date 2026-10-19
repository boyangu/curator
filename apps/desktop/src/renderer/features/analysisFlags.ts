// Renderer-side store for the unified analysis flags. Two persisted
// selections share one shape (AnalysisFlags, defined canonically in
// @curator/core):
//   • manual  — the Analyze modal's last selection (curator.analyze-flags.v1)
//   • auto    — the scanner-driven auto-analyze settings, master toggle +
//     flags (curator.auto-analyze-settings.v2)
//
// Both live in localStorage: the renderer is the source of truth across
// restarts. The auto settings are additionally pushed to core on boot and on
// every change (core keeps an in-memory mirror for the onIngest path). The
// manual selection is renderer-only — it's converted to AnalyzeOptions on the
// core side when the Analyze modal enqueues with `analyzeFlags`.
//
// The default constants are duplicated from core's flags.ts (small literals)
// because importing core's runtime would drag its better-sqlite3 / node:fs
// surface into the browser bundle — only the *type* is imported. Persisted
// JSON is merged onto the defaults so adding a flag later doesn't break a
// stored selection.

import type { AnalysisFlags, AutoAnalyzeSettings } from '@curator/core';
import { analysisApi } from '../data/api.js';
import { analysisStatus } from '../data/analysisStatus.js';
import { log } from '../data/log.js';

const slog = log.for('auto-analyze');

// Auto-analyze of new files: basics on, advanced off.
export const DEFAULT_AUTO_FLAGS: AnalysisFlags = {
	beatgrid: true,
	key: true,
	segments: true,
	peaks: true,
	fingerprint: true,
	advanced: false,
};

// Manual Analyze modal: basics OFF (leave existing Curator grid/key/segments
// alone — tick one to force a recompute), advanced ON (the common case is
// "add the expensive scalars"). The selection persists across sessions.
export const DEFAULT_MANUAL_FLAGS: AnalysisFlags = {
	beatgrid: false,
	key: false,
	segments: false,
	peaks: false,
	fingerprint: true,
	advanced: true,
};

// Auto key stays v2 to preserve the user's `enabled` opt-in across the shape
// change; merge-onto-defaults drops any stale per-feature keys. Manual bumps to
// v2 so the new basics-off/advanced-on defaults apply cleanly (round-1's
// everything-on selection was never a deliberate choice).
const AUTO_SETTINGS_KEY = 'curator.auto-analyze-settings.v2';
const MANUAL_FLAGS_KEY = 'curator.analyze-flags.v2';

function mergeFlags(base: AnalysisFlags, partial?: Partial<AnalysisFlags>): AnalysisFlags {
	return { ...base, ...(partial ?? {}) };
}

// ─── Auto-analyze settings (master toggle + flags) ───────────────────────────

export function loadAutoAnalyzeSettings(): AutoAnalyzeSettings {
	try {
		const raw = localStorage.getItem(AUTO_SETTINGS_KEY);
		if (!raw) return { enabled: false, flags: { ...DEFAULT_AUTO_FLAGS } };
		const parsed = JSON.parse(raw) as Partial<AutoAnalyzeSettings>;
		return { enabled: parsed.enabled ?? false, flags: mergeFlags(DEFAULT_AUTO_FLAGS, parsed.flags) };
	} catch {
		return { enabled: false, flags: { ...DEFAULT_AUTO_FLAGS } };
	}
}

export function saveAutoAnalyzeSettings(s: AutoAnalyzeSettings): void {
	try { localStorage.setItem(AUTO_SETTINGS_KEY, JSON.stringify(s)); }
	catch (err) { slog.warn('persist failed', undefined, err); }
}

// Push the current settings to core. Fire-and-forget; if core isn't ready
// yet (early boot) the IPC call still queues.
export async function pushAutoAnalyzeToCore(settings: AutoAnalyzeSettings): Promise<void> {
	try {
		await analysisApi.setAutoEnqueue(settings);
		// Toggling auto-analyze flips the queue's dispatch gate, so the set of
		// *dispatchable* queued jobs changes (priority-0 background work parks
		// when off, unparks when on). Re-pull the authoritative snapshot so the
		// chip's count follows: enabling repopulates it as jobs become eligible,
		// disabling drops it to 0 instead of leaving a stale "N queued" behind.
		const snap = await analysisApi.status();
		analysisStatus.reconcile(snap.running, snap.queued);
	} catch (err) { slog.warn('push to core failed', undefined, err); }
}

// ─── Manual Analyze modal flags ──────────────────────────────────────────────

export function loadManualFlags(): AnalysisFlags {
	try {
		const raw = localStorage.getItem(MANUAL_FLAGS_KEY);
		if (!raw) return { ...DEFAULT_MANUAL_FLAGS };
		return mergeFlags(DEFAULT_MANUAL_FLAGS, JSON.parse(raw) as Partial<AnalysisFlags>);
	} catch {
		return { ...DEFAULT_MANUAL_FLAGS };
	}
}

export function saveManualFlags(f: AnalysisFlags): void {
	try { localStorage.setItem(MANUAL_FLAGS_KEY, JSON.stringify(f)); }
	catch (err) { log.for('analyze-flags').warn('persist failed', undefined, err); }
}
