// Library-wide percentile cutoffs for the six analyzer scalars. The read
// path uses these to assign each track a 1–5 bucket per metric without
// recomputing percentiles per query.
//
// Storage shape (one row per metric in `metric_cutoffs`):
//   metric        TEXT PRIMARY KEY
//   cutoff_20     REAL  — 20th percentile value
//   cutoff_40     REAL  — 40th percentile value
//   cutoff_60     REAL  — 60th percentile value
//   cutoff_80     REAL  — 80th percentile value
//   sample_count  INT   — # rows the cutoffs were computed over
//   computed_at   INT   — unix-ms timestamp
//
// Bucket assignment from a raw value `v`:
//   v < cutoff_20 → 1
//   v < cutoff_40 → 2
//   v < cutoff_60 → 3
//   v < cutoff_80 → 4
//   else          → 5
// Null raw → null level (track not analyzed).
//
// The cutoffs are loaded into a CutoffStore at service init and refreshed on:
//   - boot: if the current analyzed-track count differs from sample_count by >5%
//   - in-session: debounced 30s after every batch of N completed analyses
// The store exposes a cheap synchronous `levelFor(metric, value)` used by
// getTracksImpl during result decoration.

import { eq, sql } from 'drizzle-orm';
import {
	metricCutoffs,
	type MetricCutoffs,
	type MetricName,
	type MetricLevel,
	METRIC_NAMES,
} from '@curator/shared/schema';
import type { Db } from '../db/client.js';

// Map product-name metric → the matching column name on `track`. The columns
// hold the canonical analyzer values (mirrored from track_analysis by
// persist.ts persistAnalysisResult); we percentile-rank over the `track` table so the
// cutoffs include any rows that were analyzed but lost their track_analysis
// row through cascade-delete edge cases.
const METRIC_TO_COLUMN: Record<MetricName, string> = {
	brightness:         'brightness',
	power:              'power',
	dissonance:         'dissonance',
	density:            'density',
	loudness_range_lu:  'loudness_range_lu',
	dynamic_complexity: 'dynamic_complexity',
	intro_length_sec:   'intro_length_sec',
	outro_length_sec:   'outro_length_sec',
	first_drop_sec:     'first_drop_sec',
};

// Below this many analyzed rows we don't bother bucketing — the percentile
// estimates would be noisy and the UI's "needs analysis" empty state is more
// truthful than a 1–5 chip computed from 8 tracks.
const MIN_SAMPLES_FOR_BUCKETING = 25;

// Boot-time staleness threshold: if abs(current - sample_count) / sample_count
// exceeds this, recompute. Caught at app start; in-session drift is handled
// separately by the debounced trigger from the analyzer queue.
const BOOT_STALENESS_RATIO = 0.05;

// Debounce window before in-session recomputes — long enough for a batch of
// analyses to land in one shot, short enough that the UI doesn't render with
// hour-stale levels during a backfill run.
export const IN_SESSION_DEBOUNCE_MS = 30_000;

// One row of computed boundaries used in-memory. Subset of MetricCutoffs.
interface Boundaries {
	c20: number;
	c40: number;
	c60: number;
	c80: number;
	sampleCount: number;
}

export class CutoffStore {
	// Per-metric in-memory cutoff snapshot. Missing entry → the metric has
	// fewer than MIN_SAMPLES_FOR_BUCKETING rows (returns null from levelFor).
	private cache = new Map<MetricName, Boundaries>();
	private debounceTimer: NodeJS.Timeout | null = null;

	constructor(private readonly db: Db) {}

	// Load persisted cutoffs from the DB into memory. Call at boot, then
	// after every recompute() so the cache stays in sync with persisted state.
	load(): void {
		const rows = this.db.select().from(metricCutoffs).all();
		this.cache.clear();
		for (const r of rows) this.cache.set(r.metric, rowToBoundaries(r));
	}

	// Apply the bucket lookup. Null raw → null level; metric with insufficient
	// samples → null (caller treats the same as "not analyzed").
	levelFor(metric: MetricName, value: number | null | undefined): MetricLevel | null {
		if (value == null || !Number.isFinite(value)) return null;
		const b = this.cache.get(metric);
		if (!b) return null;
		if (value < b.c20) return 1;
		if (value < b.c40) return 2;
		if (value < b.c60) return 3;
		if (value < b.c80) return 4;
		return 5;
	}

	// Recompute boundaries from scratch using SQLite's NTILE window. Idempotent;
	// upserts one row per metric in metric_cutoffs and refreshes the in-memory cache.
	recompute(): void {
		const now = Date.now();
		for (const metric of METRIC_NAMES) {
			const col = METRIC_TO_COLUMN[metric];
			const boundaries = computeBoundaries(this.db, col);
			if (!boundaries) {
				// Below the minimum-sample threshold — drop any stale cached row
				// so levelFor returns null until enough analyses exist.
				this.db.delete(metricCutoffs).where(eq(metricCutoffs.metric, metric)).run();
				this.cache.delete(metric);
				continue;
			}
			const row: MetricCutoffs = {
				metric,
				cutoff20: boundaries.c20,
				cutoff40: boundaries.c40,
				cutoff60: boundaries.c60,
				cutoff80: boundaries.c80,
				sampleCount: boundaries.sampleCount,
				computedAt: new Date(now),
			};
			this.db.insert(metricCutoffs)
				.values(row)
				.onConflictDoUpdate({
					target: metricCutoffs.metric,
					set: {
						cutoff20: row.cutoff20,
						cutoff40: row.cutoff40,
						cutoff60: row.cutoff60,
						cutoff80: row.cutoff80,
						sampleCount: row.sampleCount,
						computedAt: row.computedAt,
					},
				})
				.run();
			this.cache.set(metric, boundaries);
		}
	}

	// Boot trigger. Compares the current analyzed count for each metric against
	// the persisted sample_count and recomputes if drift exceeds BOOT_STALENESS_RATIO
	// for any metric. The first run (empty metric_cutoffs) always recomputes.
	recomputeIfStaleAtBoot(): void {
		this.load();
		if (this.cache.size === 0) {
			// Empty table — first-ever run, or a fresh install. Recompute regardless.
			this.recompute();
			return;
		}
		for (const metric of METRIC_NAMES) {
			const b = this.cache.get(metric);
			if (!b) {
				// Below threshold last time we computed; recheck in case more analyses landed.
				this.recompute();
				return;
			}
			const col = METRIC_TO_COLUMN[metric];
			const current = currentAnalyzedCount(this.db, col);
			const baseline = Math.max(b.sampleCount, 1);
			const drift = Math.abs(current - b.sampleCount) / baseline;
			if (drift > BOOT_STALENESS_RATIO) {
				this.recompute();
				return;
			}
		}
	}

	// In-session trigger. Called by the analyzer queue when a batch completes.
	// Debounces so a long backfill of N tracks recomputes once at the tail,
	// not N times. Caller is responsible for invoking this only when at least
	// one new analysis actually landed.
	scheduleRecompute(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			this.recompute();
		}, IN_SESSION_DEBOUNCE_MS);
	}

	// Cancel any pending recompute — used by tests and on shutdown.
	cancelPendingRecompute(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}

function rowToBoundaries(r: MetricCutoffs): Boundaries {
	return { c20: r.cutoff20, c40: r.cutoff40, c60: r.cutoff60, c80: r.cutoff80, sampleCount: r.sampleCount };
}

// Pull the 20/40/60/80th percentile values for one column via NTILE. We pick
// the min value of buckets 2/3/4/5 — that's the inclusive lower boundary of
// each bucket and the exclusive upper boundary of the previous one, which is
// exactly what `levelFor`'s `value < cutoff_X` comparisons want.
function computeBoundaries(db: Db, col: string): Boundaries | null {
	// Using `sql.raw(col)` is safe — `col` comes from the METRIC_TO_COLUMN
	// constant, never user input. The single-pass NTILE over the `track`
	// table sorts then assigns buckets; we group on bucket and take min().
	const stmt = sql`
		WITH ntiled AS (
			SELECT ${sql.raw(col)} AS v, NTILE(5) OVER (ORDER BY ${sql.raw(col)}) AS bucket
			FROM track
			WHERE ${sql.raw(col)} IS NOT NULL AND deleted_at IS NULL
		)
		SELECT bucket, MIN(v) AS min_v, (SELECT COUNT(*) FROM ntiled) AS total
		FROM ntiled
		GROUP BY bucket
		ORDER BY bucket
	`;
	const rows = db.all(stmt) as { bucket: number; min_v: number; total: number }[];
	if (rows.length === 0) return null;
	const total = rows[0]!.total;
	if (total < MIN_SAMPLES_FOR_BUCKETING) return null;

	// Bucket 1 contains the global minimum — we don't need its boundary because
	// any value < cutoff_20 lands there by definition. We want the *lower edges*
	// of buckets 2..5, which become cutoff_20..cutoff_80.
	const byBucket = new Map(rows.map((r) => [r.bucket, r.min_v]));
	const c20 = byBucket.get(2);
	const c40 = byBucket.get(3);
	const c60 = byBucket.get(4);
	const c80 = byBucket.get(5);
	if (c20 == null || c40 == null || c60 == null || c80 == null) {
		// Degenerate case (fewer than 5 distinct values). With MIN_SAMPLES_FOR_BUCKETING
		// at 25 this is essentially unreachable, but bail rather than emit a bogus row.
		return null;
	}
	return { c20, c40, c60, c80, sampleCount: total };
}

function currentAnalyzedCount(db: Db, col: string): number {
	const row = db.all(sql`SELECT COUNT(*) AS n FROM track WHERE ${sql.raw(col)} IS NOT NULL AND deleted_at IS NULL`) as { n: number }[];
	return row[0]?.n ?? 0;
}
