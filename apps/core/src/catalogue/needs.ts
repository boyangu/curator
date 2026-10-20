// What an analysis job would compute, and which of it the catalogue already
// covers. Shared by pull-before-compute (queue dispatch), by settling queued
// jobs after a hydrate, and by tests; no I/O beyond the per-track peaks stat.

import { compareVersions, parseVersionString } from '@curator/protocol';
import type { AnalyzeOptions } from '../analyzer/sidecar.js';
import { hasPeaks, keyId, unitFloor, type InlineKeyUnit, type LocalTrack, type UnitKey } from './local.js';
import type { MirrorEntry } from './mirror.js';

export type JobNeeds = {
	inline: Set<InlineKeyUnit>;
	// The peaks stage (both tiers, one pass).
	peaks: boolean;
};

// Mirrors the analyzer's own decisions: a stage runs unless skipped, and a
// value already in the row is injected rather than recomputed unless the
// job overrides it (queue.ts buildEffectiveOptions); peaks are skipped when
// the hi tier exists unless overridden (dispatchOne).
export function jobNeeds(o: AnalyzeOptions | undefined, t: LocalTrack, peaksDir: string | null): JobNeeds {
	const opts = o ?? {};
	const inline = new Set<InlineKeyUnit>();
	if (!opts.skipBeatgrid && (opts.overrideBeatgrid || !t.has.rhythm)) inline.add('rhythm');
	if (!opts.skipKey && (opts.overrideKey || !t.has.key)) inline.add('key');
	if (!opts.skipSegments && !opts.skipBeatgrid && (opts.overrideSegments || !t.has.structure)) inline.add('structure');
	if ((opts.features?.length ?? 0) > 0) inline.add('advanced');
	if (!opts.skipFingerprint) inline.add('fingerprint');
	const peaks = !!peaksDir && !opts.skipPeaks && (!!opts.overridePeaks || !hasPeaks(peaksDir, 'hi', t.trackId));
	return { inline, peaks };
}

export type Coverage = {
	inline: Set<InlineKeyUnit>;
	lo: boolean;
	hi: boolean;
};

// A needed unit is covered when this device holds it AND it is the account's
// (pulled just now, or the mirror names the same key at an acceptable
// version). Local values the account has never seen stay with the analyzer's
// usual rules: a background pass that overrides them recomputes them.
export function coverage(
	t: LocalTrack,
	entries: ReadonlyMap<string, MirrorEntry> | undefined,
	pulledNow: ReadonlySet<string>,
	peaksDir: string | null,
): Coverage {
	const backed = (k: UnitKey): boolean => {
		if (pulledNow.has(keyId(k))) return true;
		const e = entries?.get(keyId(k));
		return !!e && (e.state === 'remote' || e.state === 'hydrated' || e.state === 'uploaded') && compareVersions(e.version, unitFloor(k.unit)) >= 0;
	};
	// The row's own values must be at least as new as what the catalogue
	// accepts: a stale row (below the floor) that merely shares its hash with
	// an account item is still stale, and its job still recomputes. The print
	// is a pure function of the file, so it has no row version to check.
	const rowVersion = t.row ? parseVersionString(t.row.version) : null;
	const fresh = (u: InlineKeyUnit): boolean => u === 'fingerprint' || (!!rowVersion && compareVersions(rowVersion, unitFloor(u)) >= 0);
	const inline = new Set<InlineKeyUnit>();
	for (const u of ['rhythm', 'key', 'structure', 'advanced', 'fingerprint'] as const) {
		if (t.has[u] && fresh(u) && backed({ unit: u, variant: 'default' })) inline.add(u);
	}
	return {
		inline,
		lo: hasPeaks(peaksDir, 'lo', t.trackId) && backed({ unit: 'peaks', variant: 'lo' }),
		hi: hasPeaks(peaksDir, 'hi', t.trackId) && backed({ unit: 'peaks', variant: 'hi' }),
	};
}

export type Remaining = { inline: InlineKeyUnit[]; peaks: boolean; count: number };

export function remainingWork(needs: JobNeeds, cov: Coverage): Remaining {
	const inline = [...needs.inline].filter((u) => !cov.inline.has(u));
	const peaks = needs.peaks && !(cov.lo && cov.hi);
	return { inline, peaks, count: inline.length + (peaks ? 1 : 0) };
}

// The job's options with every covered stage turned into a skip. Overrides
// on a covered stage are dropped so prior-injection hands the analyzer the
// pulled value where a later stage needs it (segments anchor on the grid).
export function skipCovered(o: AnalyzeOptions | undefined, needs: JobNeeds, cov: Coverage): { options: AnalyzeOptions | undefined; changed: boolean; keepLo: boolean } {
	const out: AnalyzeOptions = { ...(o ?? {}) };
	let changed = false;
	const covered = (u: InlineKeyUnit): boolean => needs.inline.has(u) && cov.inline.has(u);
	if (covered('rhythm')) {
		delete out.overrideBeatgrid;
		delete out.overrideBpm;
		// skipBeatgrid also skips segments in the worker; only when those
		// are not still to be computed from the (injected) grid.
		if (!needs.inline.has('structure') || cov.inline.has('structure')) out.skipBeatgrid = true;
		changed = true;
	}
	if (covered('key')) {
		delete out.overrideKey;
		out.skipKey = true;
		changed = true;
	}
	if (covered('structure')) {
		delete out.overrideSegments;
		out.skipSegments = true;
		changed = true;
	}
	if (covered('advanced')) {
		out.features = [];
		changed = true;
	}
	if (covered('fingerprint')) {
		out.skipFingerprint = true;
		changed = true;
	}
	if (needs.peaks && cov.lo && cov.hi) {
		delete out.overridePeaks;
		out.skipPeaks = true;
		changed = true;
	}
	// The peaks stage still runs (for the hi tier) over a lo tier that is the
	// account's: it must come out of the pass untouched.
	const keepLo = needs.peaks && cov.lo && !cov.hi;
	return { options: changed ? out : o, changed: changed || keepLo, keepLo };
}
