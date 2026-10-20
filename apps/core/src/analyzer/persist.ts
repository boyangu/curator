// The one write path for an analysis result: the analyzer queue's sidecar
// results and the catalogue's pulled units (apps/core/src/catalogue/) both
// land here, so a unit pulled from another device obeys exactly the rules a
// locally computed one does — the Curator slot only, write-when-produced,
// the segment stage as an atomic group, advanced scalars never cleared by a
// pass that skipped them, the fingerprint on the analysed file's link. It
// needs no analyzer sidecar: a pulled unit is just a partial AnalyzeResult.

import { and, eq } from 'drizzle-orm';
import { sourceLink, track, trackAnalysis, type NewTrackAnalysis } from '@curator/shared/schema';
import type { Db } from '../db/client.js';
import { addClaims } from '../library/mutators.js';
import type { AnalyzeResult } from './sidecar.js';

export type PersistOptions = {
	// `track_analysis.audio_hash` after this write: the hash of the audio the
	// Curator slot now describes, null to clear it (the slot now holds
	// something the catalogue must not share), or undefined to leave it
	// alone. The caller decides — it is the one that knows whether the row
	// was already about this audio (see analyzer/queue.ts stampFor).
	audioHash?: string | null;
};

// `filePath` is the local source_link path this result was computed from
// (the one pickBatch dispatched) — the fingerprint is a property of that
// file, not of the track, so it lands on that link row.
export function persistAnalysisResult(db: Db, result: AnalyzeResult, filePath: string, opts: PersistOptions = {}): void {
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
	// Provenance of the slot (see PersistOptions): only when the caller
	// vouches for it, so an absent option leaves the stamp as it was.
	if (opts.audioHash !== undefined) {
		row.audioHash = opts.audioHash;
		analysisUpdateSet.audioHash = opts.audioHash;
	}
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
	db.transaction((tx) => {
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
			addClaims(db, result.track_id, [{
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
