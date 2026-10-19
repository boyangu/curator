//! Phase-preserving beat-jump math. Pure functions over a beatgrid
//! (ascending beat times in seconds, source-track timeline) — no engine
//! state, no atomics, so the whole module is unit-testable in isolation.
//!
//! The core idea (Mixxx `Beats::findNBeatsFromPosition`, rekordbox/CDJ
//! "Beat Jump"): a jump moves the playhead by EXACTLY `delta` musical
//! beats measured on the grid, carrying the sub-beat phase (how far into
//! the current beat the playhead sits) over to the destination. Mid-beat
//! stays mid-beat, so a jump while playing never knocks the track out of
//! its own pocket.
//!
//! We work in continuous beat-index space: `sec_to_index` maps a time to
//! a fractional beat index (piecewise-linear between grid entries),
//! `index_to_sec` maps back. A jump is then just `index + delta` — the
//! fractional part IS the phase, preserved for free, and variable-tempo
//! grids fall out of the piecewise mapping. Outside the grid the mapping
//! extrapolates with the edge interval: analyzer grids often start after
//! the intro or stop before the outro, and jumping from those regions is
//! a primary use case (the old renderer-side walk clamped to the grid
//! ends, which could turn "jump back 4" from an intro into a FORWARD
//! move to beat 0).

/// Validate a renderer-pushed grid: usable only when it has >= 2 entries
/// (we need at least one interval to define a beat length), every entry
/// is finite, and entries strictly increase. Returns an empty vec for
/// anything malformed — callers treat empty as "no grid, don't jump"
/// rather than half-applying a bogus grid.
pub fn sanitize_grid(beats: Vec<f64>) -> Vec<f64> {
    if beats.len() < 2 {
        return Vec::new();
    }
    let ok = beats.iter().all(|b| b.is_finite())
        && beats.windows(2).all(|w| w[1] > w[0]);
    if ok { beats } else { Vec::new() }
}

/// Continuous (fractional, possibly negative) beat index of `pos_sec`.
/// Piecewise-linear inside the grid; extrapolates past both ends using
/// the first/last interval as the local beat length.
///
/// Precondition: grid passed `sanitize_grid` (len >= 2, strictly
/// ascending, finite).
fn sec_to_index(grid: &[f64], pos_sec: f64) -> f64 {
    let n = grid.len();
    if pos_sec <= grid[0] {
        let beat_len = grid[1] - grid[0];
        return (pos_sec - grid[0]) / beat_len;
    }
    if pos_sec >= grid[n - 1] {
        let beat_len = grid[n - 1] - grid[n - 2];
        return (n - 1) as f64 + (pos_sec - grid[n - 1]) / beat_len;
    }
    // Binary search: largest i with grid[i] <= pos_sec. The two range
    // checks above guarantee 0 <= i < n-1.
    let mut lo = 0usize;
    let mut hi = n - 1;
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if grid[mid] <= pos_sec { lo = mid; } else { hi = mid - 1; }
    }
    lo as f64 + (pos_sec - grid[lo]) / (grid[lo + 1] - grid[lo])
}

/// Inverse of `sec_to_index` — same piecewise-linear mapping, same edge
/// extrapolation.
fn index_to_sec(grid: &[f64], idx: f64) -> f64 {
    let n = grid.len();
    if idx <= 0.0 {
        let beat_len = grid[1] - grid[0];
        return grid[0] + idx * beat_len;
    }
    if idx >= (n - 1) as f64 {
        let beat_len = grid[n - 1] - grid[n - 2];
        return grid[n - 1] + (idx - (n - 1) as f64) * beat_len;
    }
    let i = idx.floor() as usize;
    let frac = idx - i as f64;
    grid[i] + frac * (grid[i + 1] - grid[i])
}

/// Translate `pos_sec` by exactly `delta_beats` grid-beats, unclamped.
/// May return a time before 0 or past the track end — callers that need
/// to detect out-of-range results (loop-move rejection) use this form.
pub fn beat_walk_unclamped(grid: &[f64], pos_sec: f64, delta_beats: f64) -> f64 {
    index_to_sec(grid, sec_to_index(grid, pos_sec) + delta_beats)
}

/// Translate `pos_sec` by exactly `delta_beats` grid-beats, clamped to
/// `[0, total_sec]`. A clamped landing loses grid phase — every DJ app
/// accepts that at the track edges.
pub fn beat_walk(grid: &[f64], pos_sec: f64, delta_beats: f64, total_sec: f64) -> f64 {
    beat_walk_unclamped(grid, pos_sec, delta_beats).clamp(0.0, total_sec)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    /// Uniform 120 BPM grid (0.5 s/beat) starting 1 s into the track.
    fn uniform_grid() -> Vec<f64> {
        (0..64).map(|i| 1.0 + i as f64 * 0.5).collect()
    }

    /// Ramping grid: beat length grows 10 ms per beat (variable tempo).
    fn ramp_grid() -> Vec<f64> {
        let mut t = 0.0;
        let mut out = Vec::new();
        for i in 0..32 {
            out.push(t);
            t += 0.40 + i as f64 * 0.01;
        }
        out
    }

    #[test]
    fn phase_preserved_on_uniform_grid() {
        let g = uniform_grid();
        // 0.2 beats into beat 8 (t = 5.0 + 0.1).
        let pos = 5.1;
        let fwd = beat_walk(&g, pos, 4.0, 600.0);
        assert!((fwd - 7.1).abs() < EPS, "got {fwd}");
        let back = beat_walk(&g, pos, -4.0, 600.0);
        assert!((back - 3.1).abs() < EPS, "got {back}");
    }

    #[test]
    fn round_trip_is_identity() {
        let g = ramp_grid();
        for &pos in &[0.05, 1.234, 7.7, 11.9] {
            let there = beat_walk_unclamped(&g, pos, 16.0);
            let back = beat_walk_unclamped(&g, there, -16.0);
            assert!((back - pos).abs() < EPS, "pos {pos} → {there} → {back}");
        }
    }

    #[test]
    fn variable_tempo_carries_phase_fraction() {
        let g = ramp_grid();
        // Halfway through beat 3 (interval 0.43): t = g[3] + 0.215.
        let pos = g[3] + 0.43 / 2.0;
        let target = beat_walk_unclamped(&g, pos, 5.0);
        // Landing should be halfway through beat 8 (interval 0.48).
        let expect = g[8] + 0.48 / 2.0;
        assert!((target - expect).abs() < EPS, "got {target}, want {expect}");
    }

    #[test]
    fn extrapolates_before_first_beat() {
        let g = uniform_grid(); // starts at 1.0, 0.5 s/beat
        // From 0.35 s (= beat index -1.3), jump back 2 beats: index -3.3
        // → 1.0 - 3.3*0.5 = -0.65 → clamped to 0. Crucially it must NOT
        // land forward of 0.35 (the old clamp-to-grid bug).
        let back = beat_walk(&g, 0.35, -2.0, 600.0);
        assert!(back <= 0.35 + EPS, "back-jump moved forward: {back}");
        assert!((back - 0.0).abs() < EPS);
        // Jump forward 2 from 0.35: index -1.3 + 2 = 0.7 → 1.35.
        let fwd = beat_walk(&g, 0.35, 2.0, 600.0);
        assert!((fwd - 1.35).abs() < EPS, "got {fwd}");
    }

    #[test]
    fn extrapolates_past_last_beat() {
        let g = uniform_grid(); // last beat at 32.5, 0.5 s/beat
        // From 33.6 (index 65.2), +4 beats → index 69.2 → 35.6.
        let fwd = beat_walk(&g, 33.6, 4.0, 600.0);
        assert!((fwd - 35.6).abs() < EPS, "got {fwd}");
        // Clamp at track end.
        let clamped = beat_walk(&g, 33.6, 4.0, 34.0);
        assert!((clamped - 34.0).abs() < EPS);
    }

    #[test]
    fn clamps_at_track_start() {
        let g = uniform_grid();
        let t = beat_walk(&g, 2.1, -32.0, 600.0);
        assert!((t - 0.0).abs() < EPS);
    }

    #[test]
    fn composition_matches_single_jump() {
        let g = ramp_grid();
        let pos = g[10] + 0.11;
        let two_steps = beat_walk_unclamped(&g, beat_walk_unclamped(&g, pos, 4.0), 4.0);
        let one_step = beat_walk_unclamped(&g, pos, 8.0);
        assert!((two_steps - one_step).abs() < EPS);
    }

    #[test]
    fn fractional_deltas_supported() {
        let g = uniform_grid();
        let pos = 5.0; // exactly beat 8
        let half = beat_walk_unclamped(&g, pos, 0.5);
        assert!((half - 5.25).abs() < EPS);
    }

    #[test]
    fn sanitize_rejects_malformed() {
        assert!(sanitize_grid(vec![]).is_empty());
        assert!(sanitize_grid(vec![1.0]).is_empty());
        assert!(sanitize_grid(vec![1.0, 1.0]).is_empty());        // not strictly increasing
        assert!(sanitize_grid(vec![2.0, 1.0]).is_empty());        // descending
        assert!(sanitize_grid(vec![0.0, f64::NAN]).is_empty());   // non-finite
        assert!(sanitize_grid(vec![0.0, f64::INFINITY]).is_empty());
        assert_eq!(sanitize_grid(vec![0.0, 0.5, 1.0]).len(), 3);  // valid passes through
    }
}
