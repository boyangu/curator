# Brightness & Power — production calculation spec

How Curator computes the curator-aligned **brightness** and **power** scores that replace
the old `spectral_centroid.mean` metric. Both use the same shape: a linear formula over
standard Essentia features, fit to the curator's own b1/b0/d1/d2 and p0–p5 tags. See
`FINDINGS.md` for the research behind it.

## 1. Inputs — one MusicExtractor pass (already run)

The analyzer already runs Essentia `MusicExtractor` (lowlevel `mean`+`stdev`, tonal `mean`,
2048/1024 frame/hop) on the advanced-features path. We reuse that pass — **no new decode,
no new dependency**. The feature vector is the flattened pool:

- all numeric lowlevel/tonal/rhythm scalars (centroid, rolloff, flux, flatness,
  complexity, hfc, energy bands, ZCR, crest/spread/kurtosis/skewness, dissonance,
  EBU-128 loudness, dynamic complexity, BPM/onset/danceability, …),
- the MFCC, GFCC, HPCP(36) and spectral-contrast-coeff **mean vectors** (flattened),
- engineered: `treble_share = E_high/E_total`, `bass_share`, `rolloff−centroid`.

Plus **harmonic-engineered** features (21): tonic-relative chroma (Krumhansl key estimate
→ rotate to tonic → scale-degree energies), modal-brightness index, major-third ratio,
Phrygian-♭2 / Lydian-♯4 energy, key clarity. **204 features total**, all reproduced in the
analyzer by `scoring.py` (ported verbatim from the research extraction and verified to match).

## 2. The formula

A standardized linear model (exported as a JSON artifact, see §4):

```
for each feature i:   x_i  ← raw value, or impute_median[i] if missing
                      z_i  = (x_i − mean[i]) / std[i]
score = intercept + Σ_i coef[i] · z_i
```

That's it — a median-impute, a z-score, and a dot product. Fully inspectable; runs in
microseconds. The score is on the **training label scale** (brightness 0–3, power 0–5),
but its *absolute* value isn't what we surface — its **rank** is (see §3).

**Quality (leave-artist-out cross-validation, the honest generalization number):**

| | features | ρ vs curator | baseline |
|---|---|---|---|
| brightness | 204 | **0.667** | centroid 0.244 |
| power | 204 | **0.759** | BPM 0.521 |

## 3. From score to a 1–5 level / recommended tag

The raw score compresses at the rare extremes (MSE regression), so we **never bucket by
absolute value** — we bucket by **library percentile**, exactly as the existing
`cutoffStore` already does for the other metrics:

```
score < p20 → 1   p20..p40 → 2   p40..p60 → 3   p60..p80 → 4   ≥ p80 → 5
```

For **tag recommendation** the 1–5 level (or finer percentile) maps to the curator's
vocabulary — brightness: 5→b1, 4→b0, 2→d1, 1→d2 (3→neutral/none); power: percentile →
p0..p5. (Exact thresholds calibrated to the curator's tag distribution at integration.)

## 4. The model artifact

`brightness_model.json` / `power_model.json`:

```json
{ "target":"brightness", "n":2975, "cv_rho_leave_artist_out":0.626,
  "features":[...183...], "impute_median":[...], "mean":[...], "std":[...],
  "coef":[...], "intercept": ... }
```

Bundled with the analyzer; loaded once at startup. Versioned with the analyzer:
changing the formula bumps `analyzer_version`, which triggers the Path-A backfill to
re-score the library, after which `cutoffStore` recomputes the percentile buckets.

## 5. What the scores mean (interpretation)

- **Brightness ≠ treble.** Centroid carries a *negative* weight — more high-frequency
  energy reads *darker*. Brightness = **tonal clarity + consonant/simple harmony + warm,
  clean timbre** (top drivers: hpcp_entropy −, pitch_salience −, flatness/spread −,
  dissonance −, ZCR +). I.e. "warm = bright, cold = dark."
- **Power = energy/density** — tempo + spectral complexity/density + loudness + reduced
  tonal clarity. The two axes are anti-correlated (ρ = −0.69).

## 6. Known limits & options

- **Ceiling ≈ 0.63–0.75.** The remainder is non-audio set-context; audio can't recover it.
- **Harmonic features:** ported into the analyzer (`scoring.harmonic`) and verified to
  reproduce the research extraction (+~0.04 ρ over the pool-only model).
- **Dark extreme:** percentile bucketing mitigates the regression compression; a v2 could
  add a dark-vs-bright classifier P(dark) term (AUC 0.875) to firm up the d2 floor.
- **Human-in-the-loop:** the curator's *power tag*, when present, lifts brightness ρ to
  ~0.75 (the power axis carries context audio doesn't). Optional input to the recommender.
