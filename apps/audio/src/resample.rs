//! Reading the decoded track at a fractional position: the rate conversion
//! the output callback does when the device does not run at the track's
//! rate (a 44.1 kHz file on a 48 kHz device — most devices).
//!
//! A windowed-sinc interpolator, read straight out of the in-memory track.
//! Not a block resampler (rubato, which `convert` uses): the callback jumps,
//! loops and cross-fades by position, so it needs "the sample at 1234.56",
//! not a stream.
//!
//! Why not the two-point line this replaced: measured 2026-11-20 on a 44.1
//! kHz tone into a 48 kHz device, linear interpolation lost 1.5 dB at 10 kHz
//! and 3.4 dB at 15 kHz, and left the tone's image 21 dB and 11.5 dB below
//! it (at 13.9 and 18.9 kHz). This kernel is flat to about 19.5 kHz and
//! keeps images more than 90 dB down.
//!
//!   - 32 source frames each side of the position (64 taps), Kaiser window.
//!   - The kernel is tabulated at 512 positions between two frames; the two
//!     nearest rows are blended, so any fraction can be asked for.
//!   - Converting down (a 96 kHz file on a 48 kHz device) the kernel is
//!     stretched by the ratio, which moves its cut-off to the device's
//!     Nyquist: more taps, same table.
//!
//! Real-time rules: the table is built once before the stream starts
//! (`kernel()` from the control thread); `frame` allocates nothing, locks
//! nothing and costs the same every call.

use std::cell::UnsafeCell;
use std::sync::OnceLock;

/// Source frames on each side of the position.
pub const HALF: usize = 32;
const TAPS: usize = HALF * 2;
/// Tabulated positions between two source frames.
const PHASES: usize = 512;
/// Kaiser β for ~100 dB of stop-band.
const BETA: f64 = 10.06;
/// A track faster than this many times the device rate is read with the
/// kernel at its widest (aliasing above that is far outside what a library
/// holds: 192 kHz into 44.1 kHz is 4.35).
const MAX_STRETCH: f64 = 8.0;

pub struct Kernel {
    /// `rows[p][t]`: the weight of source frame `floor − (HALF − 1) + t` for
    /// a position `p / PHASES` past `floor`. Each row sums to 1.
    rows: Box<[[f32; TAPS]]>,
    /// The same kernel as a curve over distance, `PHASES` points per frame,
    /// for the stretched (converting-down) read.
    line: Box<[f32]>,
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..64 {
        term *= (half / k as f64) * (half / k as f64);
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

/// sinc(x) under a Kaiser window `HALF` frames wide each side.
fn weight(x: f64) -> f64 {
    let ax = x.abs();
    if ax >= HALF as f64 {
        return 0.0;
    }
    let sinc = if ax < 1e-12 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
    let u = ax / HALF as f64;
    sinc * bessel_i0(BETA * (1.0 - u * u).sqrt()) / bessel_i0(BETA)
}

impl Kernel {
    fn build() -> Self {
        let mut rows = vec![[0.0f32; TAPS]; PHASES + 1].into_boxed_slice();
        for (p, row) in rows.iter_mut().enumerate() {
            let frac = p as f64 / PHASES as f64;
            let w: Vec<f64> = (0..TAPS).map(|t| weight(t as f64 - (HALF as f64 - 1.0) - frac)).collect();
            // Unity gain at DC for every fraction, whatever the window cost.
            let sum: f64 = w.iter().sum();
            for (t, v) in w.iter().enumerate() {
                row[t] = (v / sum) as f32;
            }
        }
        let line: Vec<f32> = (0..=HALF * PHASES + 1).map(|i| weight(i as f64 / PHASES as f64) as f32).collect();
        Kernel { rows, line: line.into_boxed_slice() }
    }
}

/// The shared table. First call builds it (under a millisecond): make that
/// call off the audio thread.
pub fn kernel() -> &'static Kernel {
    static KERNEL: OnceLock<Kernel> = OnceLock::new();
    KERNEL.get_or_init(Kernel::build)
}

/// # Safety
/// `index` is below the frames the caller may read (see `frame`).
#[inline(always)]
unsafe fn sample(samples: &[UnsafeCell<f32>], index: usize) -> f32 {
    *samples.get_unchecked(index).get()
}

/// The stereo frame at `pos` (in source frames) of an interleaved-stereo
/// buffer, for a device consuming `ratio` source frames per output frame.
///
/// `readable`: frames `[0, readable)` are written and stay unchanged (the
/// decoder's high-water mark). The caller guarantees `floor(pos) + 1 <
/// readable` and `pos >= 0`.
///
/// Where the kernel would reach before the track's first frame or past
/// `readable` — the first and last 32 frames, and the edge of a decode still
/// in progress — the frame is the two-point line instead: under a
/// millisecond, at places where nothing is band-limited anyway.
#[inline]
pub fn frame(k: &Kernel, samples: &[UnsafeCell<f32>], readable: u64, pos: f64, ratio: f64) -> (f32, f32) {
    let floor = pos.floor();
    let frac = pos - floor;
    let i = floor as usize;
    debug_assert!(pos >= 0.0 && (i as u64) + 1 < readable && (readable as usize) * 2 <= samples.len());

    // On a frame, at the track's own rate or converting up: the frame
    // itself. Same-rate playback never leaves this path, and stays the
    // file's samples bit for bit.
    if frac == 0.0 && ratio <= 1.0 {
        // SAFETY: i < readable.
        return unsafe { (sample(samples, i * 2), sample(samples, i * 2 + 1)) };
    }

    if ratio <= 1.0 {
        if i + 1 >= HALF && ((i + HALF) as u64) < readable {
            let p = frac * PHASES as f64;
            let p0 = p as usize;
            let blend = (p - p0 as f64) as f32;
            let (r0, r1) = (&k.rows[p0], &k.rows[p0 + 1]);
            let base = (i + 1 - HALF) * 2;
            let (mut l, mut r) = (0.0f32, 0.0f32);
            for t in 0..TAPS {
                let c = r0[t] + (r1[t] - r0[t]) * blend;
                // SAFETY: base/2 + t <= i + HALF < readable.
                unsafe {
                    l += c * sample(samples, base + t * 2);
                    r += c * sample(samples, base + t * 2 + 1);
                }
            }
            return (l, r);
        }
    } else {
        // Converting down: the kernel stretched by the ratio, so its
        // cut-off is the device's Nyquist rather than the track's.
        let stretch = ratio.min(MAX_STRETCH);
        let reach = HALF as f64 * stretch;
        let first = (pos - reach).ceil();
        let last = (pos + reach).floor();
        if first >= 0.0 && (last as u64) < readable {
            let (mut l, mut r, mut sum) = (0.0f32, 0.0f32, 0.0f32);
            let scale = PHASES as f64 / stretch;
            let mut n = first as usize;
            let end = last as usize;
            while n <= end {
                let x = (n as f64 - pos).abs() * scale;
                let x0 = x as usize;
                let c = k.line[x0] + (k.line[x0 + 1] - k.line[x0]) * (x - x0 as f64) as f32;
                // SAFETY: n <= last < readable.
                unsafe {
                    l += c * sample(samples, n * 2);
                    r += c * sample(samples, n * 2 + 1);
                }
                sum += c;
                n += 1;
            }
            // The taps under a stretched kernel do not sum to the same
            // value at every position: divide it out so level does not
            // ripple.
            return (l / sum, r / sum);
        }
    }

    // SAFETY: i + 1 < readable.
    unsafe {
        let f = frac as f32;
        let (l0, r0) = (sample(samples, i * 2), sample(samples, i * 2 + 1));
        let (l1, r1) = (sample(samples, i * 2 + 2), sample(samples, i * 2 + 3));
        (l0 + (l1 - l0) * f, r0 + (r1 - r0) * f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMPLITUDE: f64 = 0.5;

    fn tone(rate: f64, hz: f64, frames: usize) -> Vec<UnsafeCell<f32>> {
        let w = 2.0 * std::f64::consts::PI * hz / rate;
        (0..frames).flat_map(|n| { let s = ((w * n as f64).sin() * AMPLITUDE) as f32; [UnsafeCell::new(s), UnsafeCell::new(-s)] }).collect()
    }

    /// One second of the left channel at `out_rate`, read from a
    /// `source_rate` tone the way the callback steps through it.
    fn render(source_rate: f64, out_rate: f64, hz: f64) -> Vec<f64> {
        let frames = (source_rate * 1.5) as usize;
        let samples = tone(source_rate, hz, frames);
        let ratio = source_rate / out_rate;
        let k = kernel();
        // From a quarter second in, off any whole frame.
        let start = source_rate * 0.25 + 0.37;
        (0..out_rate as usize).map(|n| frame(k, &samples, frames as u64, start + n as f64 * ratio, ratio).0 as f64).collect()
    }

    /// Least-squares fit of a sine at `hz`: (amplitude, power of the rest).
    fn fit(x: &[f64], rate: f64, hz: f64) -> (f64, f64) {
        let w = 2.0 * std::f64::consts::PI * hz / rate;
        let (mut ss, mut cc, mut sc, mut xs, mut xc) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for (n, v) in x.iter().enumerate() {
            let (s, c) = (w * n as f64).sin_cos();
            ss += s * s; cc += c * c; sc += s * c; xs += v * s; xc += v * c;
        }
        let det = ss * cc - sc * sc;
        let (a, b) = ((xs * cc - xc * sc) / det, (xc * ss - xs * sc) / det);
        let rest = x.iter().enumerate().map(|(n, v)| { let (s, c) = (w * n as f64).sin_cos(); (v - a * s - b * c).powi(2) }).sum::<f64>() / x.len() as f64;
        ((a * a + b * b).sqrt(), rest)
    }

    fn level_db(level: f64) -> f64 {
        20.0 * (level / AMPLITUDE).log10()
    }

    fn rest_db(level: f64, rest: f64) -> f64 {
        10.0 * (rest.max(1e-30) / (level * level / 2.0)).log10()
    }

    #[test]
    fn a_44k_tone_on_a_48k_device_keeps_its_level_and_gains_nothing() {
        for hz in [100.0, 1_000.0, 5_000.0, 10_000.0, 15_000.0, 18_000.0, 19_000.0] {
            let (level, rest) = fit(&render(44_100.0, 48_000.0, hz), 48_000.0, hz);
            assert!(level_db(level).abs() < 0.02, "{hz} Hz came out at {:.3} dB", level_db(level));
            assert!(rest_db(level, rest) < -90.0, "{hz} Hz: everything else at {:.1} dB", rest_db(level, rest));
        }
    }

    #[test]
    fn a_48k_tone_on_a_44k_device_keeps_its_level_and_gains_nothing() {
        for hz in [1_000.0, 10_000.0, 15_000.0, 18_000.0] {
            let (level, rest) = fit(&render(48_000.0, 44_100.0, hz), 44_100.0, hz);
            assert!(level_db(level).abs() < 0.05, "{hz} Hz came out at {:.3} dB", level_db(level));
            assert!(rest_db(level, rest) < -85.0, "{hz} Hz: everything else at {:.1} dB", rest_db(level, rest));
        }
    }

    #[test]
    fn a_96k_track_on_a_48k_device_loses_what_the_device_cannot_carry() {
        // In band: untouched.
        let (level, rest) = fit(&render(96_000.0, 48_000.0, 10_000.0), 48_000.0, 10_000.0);
        assert!(level_db(level).abs() < 0.05 && rest_db(level, rest) < -85.0, "10 kHz: {:.3} dB, rest {:.1} dB", level_db(level), rest_db(level, rest));
        // 30 kHz cannot exist at 48 kHz; unfiltered it would land on 18 kHz at full level.
        let x = render(96_000.0, 48_000.0, 30_000.0);
        let (alias, _) = fit(&x, 48_000.0, 18_000.0);
        assert!(level_db(alias) < -85.0, "30 kHz folded to 18 kHz at {:.1} dB", level_db(alias));
    }

    #[test]
    fn on_a_frame_it_is_the_frame() {
        let samples = tone(44_100.0, 997.0, 4_096);
        let k = kernel();
        for i in [0usize, 1, 31, 32, 2_000, 4_094] {
            let (l, r) = frame(k, &samples, 4_096, i as f64, 1.0);
            assert_eq!(l.to_bits(), unsafe { *samples[i * 2].get() }.to_bits());
            assert_eq!(r.to_bits(), unsafe { *samples[i * 2 + 1].get() }.to_bits());
        }
    }

    #[test]
    fn at_the_edges_it_reads_only_what_it_may() {
        // The first and last frames of what is readable, with the rest of
        // the buffer poisoned: a kernel that reached past would show it.
        let mut samples = tone(44_100.0, 440.0, 1_000);
        let readable = 500u64;
        for s in samples.iter_mut().skip(readable as usize * 2) {
            *s = UnsafeCell::new(f32::NAN);
        }
        let k = kernel();
        for ratio in [0.91875, 1.0, 2.0] {
            let mut pos = 0.0;
            while pos + 1.0 < (readable - 1) as f64 {
                let (l, r) = frame(k, &samples, readable, pos, ratio);
                assert!(l.is_finite() && r.is_finite(), "read past the readable frames at {pos} (ratio {ratio})");
                pos += ratio * 0.731;
            }
        }
    }
}
