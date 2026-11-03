"""Production-quality measurements (analyzer stage 7).

Objective mastering/mix facts about the file as delivered — nothing here is a
judgement, every number is something a mastering engineer could read off a
meter. The product reads them two ways (apps/core/src/production/):

  * integrity flags — transcode cliff, clipping, true-peak overs, stereo sub.
    Hard facts about the file, kept out of any blended score on purpose.
  * one-sided deviations from the track's genre/era cohort — "low-mids 3 dB
    above comparable tech house", which is what the DJ can act on.

Runs on the STEREO decode (the peaks stage shares it): correlation, width and
true peak are meaningless on the mono mix every other stage uses. A mono file
is analysed with left == right, so the stereo numbers read as perfectly
correlated / zero width rather than as missing.

Section rows reuse the structure stage's segments so a drop can be compared
with other drops: a whole-track average hides a crushed drop behind a quiet
intro. Only the cheap features are repeated per section.

Design notes: the transcode detector looks for a *cliff* (a >= 15 dB step
within a twelfth of an octave that the spectrum never climbs back from), not
for "little energy above 16 kHz" — plenty of good lossless masters are dark
up there, but only a lossy encoder's lowpass leaves a wall. The kick measures
are onset-gated on the beatgrid rather than stem-separated: "does the sub sit
under the kick" is answered well enough by comparing the sub band right after
each beat with the rest of the beat period.
"""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
from scipy import signal

PRODUCTION_VERSION = 1

# Fixed band plan (Hz). dB relative to the whole-spectrum energy, so a track's
# band profile is loudness-independent and comparable across masters.
BANDS: dict[str, tuple[float, float]] = {
	"sub": (20.0, 60.0),
	"bass": (60.0, 150.0),
	"lowmid": (150.0, 400.0),
	"mid": (400.0, 2000.0),
	"himid": (2000.0, 6000.0),
	"high": (6000.0, 16000.0),
}
WIDTH_BANDS: dict[str, tuple[float, float]] = {
	"low": (20.0, 150.0),
	"mid": (150.0, 2000.0),
	"high": (2000.0, 16000.0),
}
SUB_MONO_HZ = 120.0          # below this, side energy is a mastering defect, not width
CLIP_LEVEL = 0.999           # |x| at or above this for CLIP_RUN samples counts as a clip
CLIP_RUN = 3
TRUE_PEAK_OVERSAMPLE = 4     # ITU-R BS.1770-4 true-peak meter
CLIFF_MIN_HZ = 14000.0       # lossy lowpasses live in 14-21 kHz
CLIFF_STEP_DB = 15.0         # drop over one twelfth-octave that marks a lowpass wall
SHORT_BLOCK_SEC = 3.0        # short-term crest blocks
NOISE_BLOCK_SEC = 0.4
MAX_SECTIONS = 24
MAX_BEATS = 1500             # onset-gated kick measures sample at most this many beats
MIN_SECTION_SEC = 4.0


def _db(x: float, floor: float = 1e-12) -> float:
	return 10.0 * math.log10(max(float(x), floor))


def _amp_db(x: float, floor: float = 1e-9) -> float:
	return 20.0 * math.log10(max(float(x), floor))


def _rms(x: np.ndarray) -> float:
	if x.size == 0:
		return 0.0
	return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def _sos(kind: str, hz: float | tuple[float, float], sr: int, order: int = 4):
	nyq = sr / 2.0
	if isinstance(hz, tuple):
		lo, hi = max(hz[0], 1.0) / nyq, min(hz[1], nyq * 0.999) / nyq
		return signal.butter(order, [lo, hi], btype="bandpass", output="sos")
	return signal.butter(order, min(hz, nyq * 0.999) / nyq, btype=kind, output="sos")


def _corr(a: np.ndarray, b: np.ndarray) -> float:
	if a.size < 2:
		return 1.0
	a64 = a.astype(np.float64)
	b64 = b.astype(np.float64)
	den = math.sqrt(float(np.dot(a64, a64)) * float(np.dot(b64, b64)))
	if den <= 1e-18:
		return 1.0
	return float(np.clip(np.dot(a64, b64) / den, -1.0, 1.0))


# ── Spectrum ────────────────────────────────────────────────────────────────

def _welch(mono: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
	nper = 4096 if mono.size >= 4096 else int(2 ** math.floor(math.log2(max(mono.size, 16))))
	f, p = signal.welch(mono, fs=sr, window="hann", nperseg=nper, noverlap=nper // 2, average="mean")
	return f, p


def _band_levels(f: np.ndarray, p: np.ndarray, bands: dict[str, tuple[float, float]]) -> dict[str, float]:
	total = float(p.sum())
	out: dict[str, float] = {}
	for name, (lo, hi) in bands.items():
		m = (f >= lo) & (f < hi)
		out[name] = round(_db(float(p[m].sum()) / max(total, 1e-24)), 2)
	return out


def _centroid(f: np.ndarray, p: np.ndarray) -> float:
	return float((f * p).sum() / max(float(p.sum()), 1e-24))


def _log_bins(f: np.ndarray, p: np.ndarray, lo: float, hi: float, per_octave: int) -> tuple[np.ndarray, np.ndarray]:
	"""Power spectrum averaged into 1/per_octave-octave bins (centre Hz, dB)."""
	n = int(math.ceil(math.log2(hi / lo) * per_octave))
	edges = lo * 2.0 ** (np.arange(n + 1) / per_octave)
	centres, levels = [], []
	for a, b in zip(edges[:-1], edges[1:]):
		m = (f >= a) & (f < b)
		if not m.any():
			continue
		centres.append(math.sqrt(a * b))
		levels.append(_db(float(p[m].mean())))
	return np.asarray(centres), np.asarray(levels)


def _tilt(f: np.ndarray, p: np.ndarray, sr: int) -> float:
	"""Spectral slope in dB per octave, fitted over third-octave bins 50 Hz-16 kHz
	(equal weight per octave, so the many high-frequency FFT bins don't own the fit)."""
	c, lv = _log_bins(f, p, 50.0, min(16000.0, sr / 2.0), per_octave=3)
	if c.size < 4:
		return 0.0
	x = np.log2(c)
	slope = np.polyfit(x, lv, 1)[0]
	return float(slope)


def _cliff(f: np.ndarray, p: np.ndarray, sr: int) -> tuple[float, float]:
	"""Lossy-encoder lowpass detector. Returns (cutoff_hz, depth_db); cutoff is
	the Nyquist frequency when the spectrum has no wall (full-band audio)."""
	nyq = sr / 2.0
	c, lv = _log_bins(f, p, 2000.0, nyq, per_octave=12)
	if c.size < 6:
		return float(nyq), 0.0
	for i in range(c.size - 1):
		if c[i] < CLIFF_MIN_HZ:
			continue
		step = lv[i] - lv[i + 1]
		if step < CLIFF_STEP_DB:
			continue
		# A wall, not a notch: nothing above the step climbs back within 10 dB
		# of the level just below it.
		if np.all(lv[i + 1:] <= lv[i] - 10.0):
			above = lv[i + 1:]
			depth = float(lv[i] - np.median(above[: max(1, min(6, above.size))]))
			return float(c[i]), round(depth, 1)
	return float(nyq), 0.0


# ── Level / dynamics ────────────────────────────────────────────────────────

def _true_peak(x: np.ndarray, sr: int) -> float:
	"""Max inter-sample peak via 4x polyphase oversampling, chunked (a 6-minute
	track at 4x in float64 would be half a gigabyte). Overlap trims the
	filter's edge transient out of every chunk."""
	chunk = sr * 10
	pad = 256
	peak = 0.0
	n = x.size
	for s in range(0, n, chunk):
		a, b = max(0, s - pad), min(n, s + chunk + pad)
		up = signal.resample_poly(x[a:b].astype(np.float32), TRUE_PEAK_OVERSAMPLE, 1)
		lo = (s - a) * TRUE_PEAK_OVERSAMPLE
		hi = lo + (min(n, s + chunk) - s) * TRUE_PEAK_OVERSAMPLE
		seg = up[lo:hi]
		if seg.size:
			peak = max(peak, float(np.max(np.abs(seg))))
	return _amp_db(peak)


def _clip_pct(x: np.ndarray) -> float:
	"""Share of samples sitting in flat runs at full scale — the signature of a
	clipped (not merely limited) master."""
	hot = np.abs(x) >= CLIP_LEVEL
	if not hot.any():
		return 0.0
	edges = np.diff(np.concatenate(([0], hot.astype(np.int8), [0])))
	starts = np.flatnonzero(edges == 1)
	ends = np.flatnonzero(edges == -1)
	runs = ends - starts
	clipped = int(runs[runs >= CLIP_RUN].sum())
	return round(100.0 * clipped / x.size, 4)


def _block_rms_db(x: np.ndarray, sr: int, block_sec: float) -> np.ndarray:
	n = int(sr * block_sec)
	if n <= 0 or x.size < n:
		return np.asarray([_amp_db(_rms(x))])
	k = x.size // n
	blocks = x[: k * n].reshape(k, n).astype(np.float64)
	return 20.0 * np.log10(np.maximum(np.sqrt(np.mean(blocks * blocks, axis=1)), 1e-9))


def _block_crest_db(x: np.ndarray, sr: int, block_sec: float) -> np.ndarray:
	n = int(sr * block_sec)
	if n <= 0 or x.size < n:
		return np.asarray([_amp_db(float(np.max(np.abs(x))) if x.size else 0.0) - _amp_db(_rms(x))])
	k = x.size // n
	blocks = x[: k * n].reshape(k, n).astype(np.float64)
	rms = np.maximum(np.sqrt(np.mean(blocks * blocks, axis=1)), 1e-9)
	pk = np.maximum(np.max(np.abs(blocks), axis=1), 1e-9)
	return 20.0 * np.log10(pk / rms)


def _ebu(left: np.ndarray, right: np.ndarray, sr: int) -> tuple[float, float, np.ndarray, float]:
	"""EBU R128 via Essentia: (integrated LUFS, loudness range LU, short-term
	LUFS at 10 Hz, momentary max)."""
	from essentia.standard import LoudnessEBUR128

	stereo = np.ascontiguousarray(np.column_stack([left, right]).astype(np.float32))
	momentary, short_term, integrated, lra = LoudnessEBUR128(sampleRate=sr, hopSize=0.1)(stereo)
	mom = np.asarray(momentary, dtype=np.float64)
	st = np.asarray(short_term, dtype=np.float64)
	mom_max = float(mom.max()) if mom.size else float(integrated)
	return float(integrated), float(lra), st, mom_max


def _power_mean_db(values_db: np.ndarray) -> float:
	v = values_db[np.isfinite(values_db)]
	if v.size == 0:
		return -70.0
	return _db(float(np.mean(10.0 ** (v / 10.0))))


# ── Onset-gated kick measures ───────────────────────────────────────────────

def _kick_measures(mono: np.ndarray, sr: int, beats: list[float]) -> tuple[Optional[float], Optional[float]]:
	if len(beats) < 8:
		return None, None
	b = np.asarray(beats, dtype=np.float64)
	period = float(np.median(np.diff(b)))
	if not (0.2 <= period <= 1.5):
		return None, None
	if b.size > MAX_BEATS:
		b = b[np.linspace(0, b.size - 1, MAX_BEATS).astype(int)]
	lo = signal.sosfiltfilt(_sos("bandpass", (30.0, 150.0), sr), mono).astype(np.float32)
	sub = signal.sosfiltfilt(_sos("bandpass", (20.0, 60.0), sr), mono).astype(np.float32)
	n = mono.size
	punch: list[float] = []
	under: list[float] = []
	pre, post = int(0.03 * sr), int(0.08 * sr)
	kick_win = int(0.1 * sr)
	per = int(period * sr)
	for t in b:
		i = int(t * sr)
		if i - pre < 0 or i + per >= n:
			continue
		pk = float(np.max(np.abs(lo[i - pre: i + post])))
		body = _rms(lo[i: i + per])
		if body > 1e-6 and pk > 1e-6:
			punch.append(_amp_db(pk) - _amp_db(body))
		on = _rms(sub[i: i + kick_win])
		off = _rms(sub[i + kick_win: i + per])
		if on > 1e-6 and off > 1e-6:
			under.append(_amp_db(on) - _amp_db(off))
	return (
		round(float(np.median(punch)), 2) if punch else None,
		round(float(np.median(under)), 2) if under else None,
	)


# ── Stereo ──────────────────────────────────────────────────────────────────

def _width(left: np.ndarray, right: np.ndarray, sr: int) -> dict[str, float]:
	mid = (left + right) * 0.5
	side = (left - right) * 0.5
	out: dict[str, float] = {}
	for name, band in WIDTH_BANDS.items():
		sos = _sos("bandpass", band, sr)
		m = _rms(signal.sosfilt(sos, mid))
		s = _rms(signal.sosfilt(sos, side))
		out[name] = round(_amp_db(s) - _amp_db(m), 2) if m > 1e-9 else -60.0
	return out


def _sub_corr(left: np.ndarray, right: np.ndarray, sr: int) -> float:
	sos = _sos("lowpass", SUB_MONO_HZ, sr)
	return round(_corr(signal.sosfilt(sos, left), signal.sosfilt(sos, right)), 4)


# ── Entry point ─────────────────────────────────────────────────────────────

def _section_features(left: np.ndarray, right: np.ndarray, sr: int, st_db: np.ndarray,
					  a: float, b: float) -> dict[str, Any]:
	i, j = int(a * sr), min(int(b * sr), left.size)
	l_, r_ = left[i:j], right[i:j]
	mono = (l_ + r_) * 0.5
	f, p = _welch(mono, sr)
	si, sj = int(a * 10), max(int(a * 10) + 1, int(b * 10))
	return {
		"lufs": round(_power_mean_db(st_db[si:sj]), 2) if st_db.size else None,
		"crest_db": round(float(np.median(_block_crest_db(mono, sr, SHORT_BLOCK_SEC))), 2),
		"sub_corr": _sub_corr(l_, r_, sr),
		"bands_db": _band_levels(f, p, BANDS),
		"width_db": _width(l_, r_, sr),
		"tilt_db_oct": round(_tilt(f, p, sr), 3),
	}


def compute_production(left: np.ndarray, right: np.ndarray, sr: int,
					   beats: Optional[list[float]] = None,
					   segments: Optional[list[dict[str, Any]]] = None,
					   stereo_source: bool = True) -> dict[str, Any]:
	left = np.asarray(left, dtype=np.float32)
	right = np.asarray(right, dtype=np.float32)
	n = min(left.size, right.size)
	left, right = left[:n], right[:n]
	if n < sr:
		raise ValueError("production stage needs at least one second of audio")
	mono = (left + right) * 0.5

	integrated, lra, st_db, mom_max = _ebu(left, right, sr)
	tp = max(_true_peak(left, sr), _true_peak(right, sr))
	f, p = _welch(mono, sr)
	cutoff_hz, cutoff_depth = _cliff(f, p, sr)
	rms_db = _amp_db(_rms(mono))
	peak_db = _amp_db(float(np.max(np.abs(mono))))
	noise_blocks = _block_rms_db(mono, sr, NOISE_BLOCK_SEC)
	audible = noise_blocks[noise_blocks > -90.0]
	kick_punch, sub_under = _kick_measures(mono, sr, list(beats or []))

	out: dict[str, Any] = {
		"version": PRODUCTION_VERSION,
		"stereo_source": bool(stereo_source),
		"duration_sec": round(n / sr, 2),
		# Loudness / headroom
		"lufs_i": round(integrated, 2),
		"lra": round(lra, 2),
		"lufs_m_max": round(mom_max, 2),
		"true_peak_dbtp": round(tp, 2),
		"plr": round(tp - integrated, 2),
		"clip_pct": max(_clip_pct(left), _clip_pct(right)),
		"dc_offset": round(float(np.mean(mono, dtype=np.float64)), 5),
		# Dynamics
		"crest_db": round(peak_db - rms_db, 2),
		"crest_st_p50": round(float(np.median(_block_crest_db(mono, sr, SHORT_BLOCK_SEC))), 2),
		"noise_floor_db": round(float(np.percentile(audible, 1)) if audible.size else -90.0, 2),
		# Tonal balance
		"bands_db": _band_levels(f, p, BANDS),
		"centroid_hz": round(_centroid(f, p), 1),
		"tilt_db_oct": round(_tilt(f, p, sr), 3),
		# Bandwidth / transcode
		"cutoff_hz": round(cutoff_hz, 0),
		"cutoff_depth_db": cutoff_depth,
		# Stereo
		"phase_corr": round(_corr(left, right), 4),
		"sub_corr": _sub_corr(left, right, sr),
		"width_db": _width(left, right, sr),
		# Low end vs the beatgrid
		"kick_punch_db": kick_punch,
		"sub_under_kick_db": sub_under,
		"sections": [],
	}

	secs = []
	for seg in (segments or [])[:MAX_SECTIONS]:
		try:
			a, b = float(seg["startSec"]), float(seg["endSec"])
		except (KeyError, TypeError, ValueError):
			continue
		a, b = max(0.0, a), min(b, n / sr)
		if b - a < MIN_SECTION_SEC:
			continue
		row = _section_features(left, right, sr, st_db, a, b)
		row.update({"label": seg.get("label"), "startSec": round(a, 2), "endSec": round(b, 2)})
		secs.append(row)
	out["sections"] = secs
	return out
