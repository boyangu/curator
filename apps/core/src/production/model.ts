// The learned probe: a Bradley-Terry model over feature differences.
//
// Each judgment says "A sounds more professionally produced than B". With
// x_a, x_b the standardised feature rows, P(A > B) = σ(w · (x_a - x_b)):
// logistic regression on the difference with no bias (the pair is
// symmetric), L2-regularised because a few hundred pairs against ~25
// features would otherwise fit noise. Ties train toward 0.5. The score of a
// track is w · x, so it lives on the same scale as the judgments and the
// profile reports its percentile within the scored library.
//
// Pure functions over plain arrays — no DB — so the fit is testable and the
// weights can be inspected ("why does this track score high?").

export interface JudgmentRow {
	a: number;        // row index into `rows`
	b: number;
	y: number;        // 1 = a wins, 0 = b wins, 0.5 = tie
}

export interface FitResult {
	mean: number[];
	std: number[];
	weights: number[];
	trainAccuracy: number | null;
	cvAccuracy: number | null;
	scores: Float64Array; // one per input row
}

export const MIN_PAIRS_TO_FIT = 30;
const L2 = 1.0;
const LR = 0.2;
const ITERATIONS = 2500;
const CV_FOLDS = 5;
const MIN_DECIDED_FOR_CV = 20;

const sigmoid = (t: number): number => 1 / (1 + Math.exp(-t));

function median(xs: number[]): number {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// Impute nulls with the column median, then z-score with mean/std over the
// imputed column. Columns with no spread get std 1 (weight ends up ~0).
export function standardise(rows: (number | null)[][], dim: number): { mean: number[]; std: number[]; z: Float64Array[] } {
	const med: number[] = [];
	for (let j = 0; j < dim; j++) med.push(median(rows.map((r) => r[j]).filter((v): v is number => v != null)));
	const filled = rows.map((r) => r.map((v, j) => (v == null ? med[j]! : v)));
	const mean: number[] = [], std: number[] = [];
	for (let j = 0; j < dim; j++) {
		const col = filled.map((r) => r[j]!);
		const m = col.reduce((s, v) => s + v, 0) / Math.max(1, col.length);
		const sd = Math.sqrt(col.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, col.length));
		mean.push(m);
		std.push(sd > 1e-9 ? sd : 1);
	}
	const z = filled.map((r) => Float64Array.from(r, (v, j) => (v - mean[j]!) / std[j]!));
	return { mean, std, z };
}

function train(z: Float64Array[], pairs: JudgmentRow[], dim: number): number[] {
	const w = new Array<number>(dim).fill(0);
	if (pairs.length === 0) return w;
	const diffs = pairs.map((p) => {
		const d = new Float64Array(dim);
		const a = z[p.a]!, b = z[p.b]!;
		for (let j = 0; j < dim; j++) d[j] = a[j]! - b[j]!;
		return d;
	});
	const grad = new Float64Array(dim);
	for (let it = 0; it < ITERATIONS; it++) {
		grad.fill(0);
		for (let i = 0; i < pairs.length; i++) {
			const d = diffs[i]!;
			let t = 0;
			for (let j = 0; j < dim; j++) t += w[j]! * d[j]!;
			const err = sigmoid(t) - pairs[i]!.y;
			for (let j = 0; j < dim; j++) grad[j]! += err * d[j]!;
		}
		for (let j = 0; j < dim; j++) w[j] = w[j]! - LR * (grad[j]! / pairs.length + (L2 / pairs.length) * w[j]!);
	}
	return w;
}

function accuracy(z: Float64Array[], w: number[], pairs: JudgmentRow[]): number | null {
	const decided = pairs.filter((p) => p.y !== 0.5);
	if (decided.length === 0) return null;
	let ok = 0;
	for (const p of decided) {
		let t = 0;
		for (let j = 0; j < w.length; j++) t += w[j]! * (z[p.a]![j]! - z[p.b]![j]!);
		if ((t > 0) === (p.y === 1)) ok++;
	}
	return ok / decided.length;
}

export function fitProbe(rows: (number | null)[][], pairs: JudgmentRow[], dim: number): FitResult {
	const { mean, std, z } = standardise(rows, dim);
	const weights = train(z, pairs, dim);
	const trainAccuracy = accuracy(z, weights, pairs);
	let cvAccuracy: number | null = null;
	const decided = pairs.filter((p) => p.y !== 0.5);
	if (decided.length >= MIN_DECIDED_FOR_CV) {
		// Deterministic folds over the judgment order: the order is the order
		// of answering, so folds are time slices, which is the honest split.
		let ok = 0, total = 0;
		for (let f = 0; f < CV_FOLDS; f++) {
			const test = pairs.filter((_, i) => i % CV_FOLDS === f);
			const trainSet = pairs.filter((_, i) => i % CV_FOLDS !== f);
			const w = train(z, trainSet, dim);
			const testDecided = test.filter((p) => p.y !== 0.5);
			for (const p of testDecided) {
				let t = 0;
				for (let j = 0; j < dim; j++) t += w[j]! * (z[p.a]![j]! - z[p.b]![j]!);
				if ((t > 0) === (p.y === 1)) ok++;
				total++;
			}
		}
		cvAccuracy = total > 0 ? ok / total : null;
	}
	const scores = new Float64Array(rows.length);
	for (let i = 0; i < rows.length; i++) {
		let s = 0;
		for (let j = 0; j < dim; j++) s += weights[j]! * z[i]![j]!;
		scores[i] = s;
	}
	return { mean, std, weights, trainAccuracy, cvAccuracy, scores };
}

// Score one row with a stored model (new tracks after a fit).
export function scoreRow(row: (number | null)[], mean: number[], std: number[], weights: number[]): number {
	let s = 0;
	for (let j = 0; j < weights.length; j++) {
		const v = row[j];
		if (v == null) continue; // imputed value = mean → contributes 0
		s += weights[j]! * ((v - mean[j]!) / std[j]!);
	}
	return s;
}
