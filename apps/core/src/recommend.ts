// Organize recommender — the pure scoring core, split out of service.ts so the
// weighting + reason + source-balance logic is unit-testable without a DB.
//
// The model is a market-basket / affinity table: one row per candidate (a tag
// or a write-eligible playlist), with a raw count per signal column of how many
// of the candidate's member tracks look like the current selection —
//
//   cooccur : also carry one of the selection's current tags/playlists (collaborative)
//   artist  : by an artist in the selection
//   genre   : same genre as the selection
//   label   : same record label
//   model   : the analyzer's brightness/power bucket matched this tag (a modest,
//             non-pinned nudge — folded in, not led with)
//
// score = Σ weight·count. Reason = the weighted column that dominated. Candidates
// already on the selection are excluded upstream (they're not "recommendations").

export interface RecommendColumnCounts {
	cooccur: number;
	artist: number;
	genre: number;
	label: number;
	model: number;
}

export interface RecommendWeights {
	cooccur: number;
	artist: number;
	label: number;
	genre: number;
	model: number;
}

// Defaults are tunable. Artist/label are specific signals; genre is broad (so
// it's weighted lower to blunt its size advantage). cooccur is the collaborative
// base. model is a "worth a couple of label matches" bonus — present, not pinned.
export const DEFAULT_RECOMMEND_WEIGHTS: RecommendWeights = {
	cooccur: 2,
	artist: 2,
	label: 2,
	genre: 1,
	model: 4,
};

export type RecommendKind = 'tag' | 'playlist';

export interface CandidateCounts {
	id: string;
	kind: RecommendKind;
	columns: RecommendColumnCounts;
}

export interface ScoredRecommendation {
	kind: RecommendKind;
	id: string;
	score: number;
	reason: string;
}

// Reason phrases, in tie-break priority order (most specific first) — when two
// weighted columns are equal, the more informative reason wins.
const REASON_ORDER: readonly [keyof RecommendColumnCounts, string][] = [
	['label', 'same label'],
	['artist', 'same artist'],
	['cooccur', 'often together'],
	['model', 'matches the sound'],
	['genre', 'same genre'],
];

function reasonFor(contrib: RecommendColumnCounts): string {
	let bestPhrase = 'same genre';
	let bestVal = -1;
	for (const [key, phrase] of REASON_ORDER) {
		if (contrib[key] > bestVal) { bestVal = contrib[key]; bestPhrase = phrase; }
	}
	return bestPhrase;
}

export interface ScoreOpts {
	weights?: RecommendWeights;
	// Candidate ids already on the selection — excluded (a target you already
	// have isn't a recommendation; the picker shows it in the main list).
	excludeIds?: ReadonlySet<string>;
	// Max per kind returned, so both tags and playlists survive despite
	// playlists' raw-count size advantage. The renderer does final display cap.
	perKind?: number;
}

// Score every candidate, drop the excluded/zero-score ones, and return up to
// `perKind` of EACH kind (source-balanced) merged and sorted by score desc.
export function scoreCandidates(candidates: readonly CandidateCounts[], opts: ScoreOpts = {}): ScoredRecommendation[] {
	const w = opts.weights ?? DEFAULT_RECOMMEND_WEIGHTS;
	const exclude = opts.excludeIds ?? new Set<string>();
	const perKind = opts.perKind ?? 10;

	const scored: ScoredRecommendation[] = [];
	for (const c of candidates) {
		if (exclude.has(c.id)) continue;
		const contrib: RecommendColumnCounts = {
			cooccur: w.cooccur * c.columns.cooccur,
			artist: w.artist * c.columns.artist,
			label: w.label * c.columns.label,
			genre: w.genre * c.columns.genre,
			model: w.model * c.columns.model,
		};
		const score = contrib.cooccur + contrib.artist + contrib.label + contrib.genre + contrib.model;
		if (score <= 0) continue;
		scored.push({ kind: c.kind, id: c.id, score, reason: reasonFor(contrib) });
	}
	const topOf = (kind: RecommendKind): ScoredRecommendation[] =>
		scored.filter((s) => s.kind === kind).sort((a, b) => b.score - a.score).slice(0, perKind);
	return [...topOf('tag'), ...topOf('playlist')].sort((a, b) => b.score - a.score);
}
