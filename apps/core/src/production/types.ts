// Public shapes of the production-quality layer (apps/core/src/production).
// Exposed over IPC/agent tools, so part of the CoreService contract.

import type { ProductionFlag } from '@curator/library-logic';
import type { ProductionMeasurements, ProductionSection } from '@curator/shared/schema';

export type ProductionCohortKind = 'genre+era' | 'genre' | 'library';

export interface ProductionCohort {
	kind: ProductionCohortKind;
	genre: string | null;
	yearFrom: number | null;
	yearTo: number | null;
	size: number; // measured peers the percentiles were taken over (excl. the track)
}

export interface ProductionDeviation {
	key: string;
	label: string;
	unit: string;
	value: number;
	percentile: number;      // 0-100 within the cohort
	z: number;               // robust z (median / MAD)
	direction: 'high' | 'low';
	// Set only when the deviation is in the feature's defect direction and
	// large enough to say something about — the explanation line.
	note: string | null;
}

export interface ProductionAudiobox {
	ce: number;
	cu: number;
	pc: number;
	pq: number;
	pqPercentile: number | null; // within the cohort (null when peers lack scores)
}

export interface ProductionLearned {
	score: number;            // raw probe output (higher = judged better)
	percentile: number | null; // within every scored track
}

export interface ProductionProfile {
	trackId: string;
	measured: boolean;
	measurements: ProductionMeasurements | null;
	cohort: ProductionCohort | null;
	flags: ProductionFlag[];
	deviations: ProductionDeviation[]; // every feature, ordered by |z| desc
	audiobox: ProductionAudiobox | null;
	learned: ProductionLearned | null;
	sections: ProductionSection[];
}

export interface ProductionPairSide {
	trackId: string;
	title: string;
	artists: string;
	genre: string | null;
	lufs: number;
	durationSec: number | null;
	// Where to audition from: the first drop when the track has one.
	auditionStartSec: number;
}

export interface ProductionPair {
	a: ProductionPairSide;
	b: ProductionPairSide;
	cohortGenre: string | null; // null = drawn library-wide (genre too small)
	// Master-volume factors (0..1) that bring both sides to the quieter
	// one's loudness. The renderer multiplies the user's volume by these.
	gainA: number;
	gainB: number;
}

export type ProductionWinner = 'a' | 'b' | 'tie';

export interface ProductionModelInfo {
	version: number;
	fittedAt: number;         // unix ms
	pairs: number;            // judgments used (ties included)
	ties: number;
	features: string[];
	trainAccuracy: number | null; // over decided pairs
	cvAccuracy: number | null;    // 5-fold, null under 20 decided pairs
	scoredTracks: number;
	// Standardised weights, one per feature (for the profile's "why").
	weights: number[];
}

export interface ProductionStats {
	judgments: number;
	ties: number;
	measuredTracks: number;   // tracks with a production row
	playableMeasured: number; // of those, with a local file to audition
	judgedTracks: number;     // distinct tracks that appear in a judgment
	model: ProductionModelInfo | null;
	judgmentsSinceFit: number;
	minPairsToFit: number;
}
