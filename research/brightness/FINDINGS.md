# Perceptual Brightness & Power from a DJ's Hand-Tagged Library — Research Findings

*A supervised study reverse-engineering one curator's subjective "brightness" and "power"
ratings of electronic-music tracks from audio features, to replace a naive
spectral-centroid metric with something that matches the curator's ear.*

---

## Executive summary

- The production "brightness" metric is a single Essentia number — the mean **spectral
  centroid**. Against the curator's own tags it is essentially uninformative
  out-of-sample (**Spearman ρ ≈ 0.24**).
- A modest, interpretable model over standard timbral/harmonic features reaches
  **ρ ≈ 0.66** (leave-artist-out) — **~2.7× the baseline**. A linear model ties
  gradient-boosted trees, so the signal is largely additive and shippable as a formula.
- **The curator's "brightness" is not treble.** Raw spectral centroid carries a
  *negative* weight: more high-frequency energy mildly predicts *darker*. Brightness =
  **tonal clarity + consonant/simple harmony + warm, clean timbre**; darkness = harsh,
  noisy, dense, dissonant. The curator independently described this as **"warm = bright,
  cold = dark,"** which the data confirms.
- A second axis, **POWER** (the curator's p0–p5 energy tags), is *more* predictable from
  audio (**ρ ≈ 0.77**), driven by tempo + spectral density + loudness. BPM alone gets
  ρ ≈ 0.52 — real but far from sufficient.
- Brightness and power are **strongly anti-correlated (ρ = −0.69)**: the curator's sets
  travel from bright/low-power (daytime) to dark/high-power (late-night) together.
- The curator's **power *tag* improves brightness prediction (ρ 0.66 → 0.75)**, but
  power *predicted from audio* does not — the lift is human/contextual information audio
  doesn't carry.
- **Rejected after testing:** a spectrogram-CNN approach, HTDemucs source separation,
  and a low-end-contamination fix — none justified for this problem (see §8).

---

## 1. Problem & objective

A DJ/curator hand-labels tracks on a 4-point brightness scale **b1 > b0 > d1 > d2**
(brightest → darkest) and a 6-point power scale **p0 … p5**. The shipped analyzer derives
"brightness" as `lowlevel.spectral_centroid.mean`, which the curator finds unreliable.
Objective: determine whether an interpretable audio-feature model reproduces the
curator's judgments better, identify *what* drives those judgments, and recommend a
shippable approach. Interpretability ("the underlying math") was an explicit goal.

## 2. Data

| | Brightness | Power |
|---|---|---|
| Tagged local-file tracks | 2,975 | 3,512 |
| Scale | b1=3 … d2=0 | p0=0 … p5=5 |
| Extraction errors | 0 | 0 |

**Half-steps.** Adjacent double-tags (e.g. `b1+b0`) are the curator's deliberate
"between" markers (confirmed), with **no** non-adjacent contradictions. We therefore
model each axis as a **continuous ordinal target** (brightness 0–3, power 0–5) with
half-steps, rather than flat multiclass — which respects ordering and the curator's own
resolution. Distributions are bright-heavy / mid-power-heavy; the extremes (d2 n=62,
p5 n=81) are rare, which matters in §4.4.

## 3. Method

- **Features (187/track):** one Essentia `MusicExtractor` pass (`lowlevelStats=mean,stdev`,
  `tonalStats=mean`; 2048/1024 frame/hop) per track — full spectral/timbral band
  descriptors (centroid, rolloff, flux, flatness, complexity, HFC, energy bands, ZCR,
  crest/spread/kurtosis), **13 MFCC + GFCC**, **36-bin HPCP/chroma**, spectral-contrast
  coefficients, EBU-128 loudness, dynamic complexity, dissonance, rhythm/BPM/onset/
  danceability. Plus engineered features (tonic-relative chroma & a music-theory modal-
  brightness index, treble/bass share, V/U shape).
- **Why Essentia, not librosa:** the production analyzer already runs Essentia; any
  shippable formula must be reproducible there. Training on a different library risks a
  train/serve mismatch.
- **Evaluation: leave-artist-out GroupKFold throughout.** Tracks by the same artist never
  straddle train/test, so scores reflect generalization to *new* tracks, not memorized
  artists — a trap a plain random 80/20 split would hide.
- **Metrics:** Spearman ρ (rank agreement with the curator — the primary metric, since
  the scale is ordinal), MAE on the raw scale, and within-±0.5 / ±1.0 hit-rates.
- **Models:** Ridge (interpretable, the "formula"), RandomForest, GradientBoosting, SVR,
  XGBoost. A single-feature baseline (centroid for brightness, BPM for power) is the bar.

## 4. Brightness results

### 4.1 Model comparison (out-of-fold, leave-artist-out, n=2,975)

| model | ρ | MAE (0–3) | within ±0.5 | within ±1.0 |
|---|---|---|---|---|
| **centroid only (current metric)** | **0.244** | 0.59 | 0.47 | 0.81 |
| Ridge (all features) | **0.666** | 0.46 | 0.61 | 0.91 |
| XGBoost | 0.665 | 0.45 | 0.62 | 0.91 |
| GradientBoosting | 0.656 | 0.46 | 0.61 | 0.89 |
| RandomForest / SVR | ~0.64 | ~0.47 | ~0.60 | ~0.90 |

### 4.2 What "brightness" means to this curator

Top features by |Spearman| with the label (consistent across correlation, Ridge weights,
and RF importance):

| feature | ρ | reading |
|---|---|---|
| spectral_contrast (band 1–2) | **+0.44** | tonal clarity (peaks above noise floor) — the single strongest signal |
| hpcp_entropy | −0.38 | harmonic density/uncertainty → darker |
| pitch_salience (stdev) | −0.36 | unstable/noisy pitch → darker |
| dissonance | −0.35 | harshness → darker |
| ♭2 / Phrygian energy | −0.35 | dark scale color (the one textbook-mode signal that holds) |
| MFCC 4–7 | −0.30…−0.33 | timbral envelope |
| **spectral_centroid** | **−0.24** | **more treble → *darker*** (sign-flipped vs textbook) |

**Lens review** — each conceptual hypothesis as a standalone feature block:

| lens | standalone ρ |
|---|---|
| Harmony (key/chord/chroma/consonance) | 0.500 |
| Clarity (spectral contrast) | 0.475 |
| Texture (crest/flux/pitch-instability) | 0.463 |
| Timbre (MFCC/GFCC envelope) | 0.426 |
| Warmth (spectral tilt) | 0.365 |
| Shape (V/U scoop: extremes vs mids) | 0.325 |
| all six combined | 0.573 |
| full 187-feature model | 0.664 |

Every lens beats the centroid baseline. But a redundancy matrix (correlation between the
lenses' predictions) shows they collapse to **~two factors**: **tonal structure**
(Clarity ↔ Harmony, r=0.74) and **spectral/timbral character** (Timbre ↔ Warmth, r=0.73).
That is why the six combined (0.573) fall short of the full model (0.664) — they are
overlapping views, and finer-grained features add the remainder.

### 4.3 The warm/cold reframe

The curator hypothesized "warm = my bright, cold = my dark." Tested directly: every warm
proxy is correctly signed (low-mid body +0.28, MFCC1 +0.22; treble −0.25, high-band
−0.20, dissonance −0.35). **Caveat:** warmth is *not* a simple EQ tilt — a naive
low-mid/high energy ratio was a dud (ρ +0.007), because absolute tilt is genre/master
dependent. Warmth lives in **timbre** (MFCC/contrast), not a two-band slider. Warmth+timbre
(0.43) and clarity (0.48) are complementary (prediction overlap 0.59) and stack to 0.52.

### 4.4 The dark extreme — a regression artifact, not lost signal

The continuous-regression model systematically *under-darkens* the rare dark end (mean
residual +1.26 at d2). This survived class-balanced weighting (up to 18×) **and** isotonic
calibration. The cause is **MSE regression compressing rare extremes toward the dense
middle**, not missing signal: a dark-vs-bright **classifier scores AUC 0.875** (centroid-
only 0.66) and, framed as classification, **recovers 76% of pure-d2 tracks**. *Design
implication: model the extremes with a classification/ordinal framing (or ensemble the
regressor with a P(dark) term) and bucket by percentile — do not ship a raw MSE value.*

### 4.5 Label quality

Out-of-fold residuals flag ~6% of tracks as >1 level off. The per-bin "bias" is monotonic
— the signature of regression-to-the-mean, **not** systematic mislabeling. Individual
large residuals in well-sampled bins are worth a listen, but the aggregate is a model
artifact, not a tagging problem.

## 5. Power results (p0–p5, continuous 0–5, n=3,512)

| model | ρ | MAE (0–5) |
|---|---|---|
| **BPM only (baseline)** | **0.521** | 0.71 |
| Ridge (all features) | 0.758 | 0.53 |
| **XGBoost (all features)** | **0.773** | 0.50 |

BPM is a genuine driver (ρ 0.52) but **far from sufficient**; the full feature set adds
+0.25. Top drivers: tempo (bpm +0.52, bpm-histogram +0.51), **spectral density/complexity**
(stdev +0.52, dissonance +0.50, entropy +0.41), **loudness** (EBU-128 +0.41…+0.43),
reduced tonal clarity (contrast −0.48), spectral spread (+0.43). Notably
**spectral_centroid is +0.39 for power but −0.24 for brightness** — the same feature points
in opposite directions, confirming the two axes are distinct.

## 6. Brightness × Power interaction

Direct **corr(brightness, power) = −0.69**, monotonic and matching the curator's stated
priors (b1 never reaches P5; d2 only ever P4–P5):

| brightness tag | mean power | power range |
|---|---|---|
| b1 (brightest) | 2.42 | 0–4 |
| b0 | 3.19 | 0–5 |
| d1 | 4.03 | 2–5 |
| d2 (darkest) | 4.70 | 4–5 |

Does power help predict brightness? (n=2,931 tagged on both)

| brightness model | ρ |
|---|---|
| audio only | 0.661 |
| **+ TRUE power tag** | **0.752** (Δ +0.091) |
| + power *predicted from audio* | 0.655 (Δ −0.006) |

**Dissociation:** the human power *tag* adds substantial brightness information (+0.09),
but audio-*derived* power adds nothing (it is already in the features). The lift is the
human/contextual component of power perception — the same factor that caps pure-audio
brightness. **Implication:** a brightness score can be sharpened to ρ≈0.75 *if it consumes
the curator's power tag as an input* (a viable human-in-the-loop workflow, since power is
tagged anyway); pure audio cannot extract it.

## 7. Hypotheses tested — summary

| hypothesis | verdict | evidence |
|---|---|---|
| brightness = spectral centroid / treble | **rejected** | centroid ρ −0.24 (wrong sign) |
| warm = bright, cold = dark | **confirmed** (timbral, not EQ tilt) | warm proxies correctly signed; naive tilt ratio ρ +0.007 |
| harmonic clarity/consonance drives it | **confirmed (strongest)** | harmony lens ρ 0.50; contrast +0.44 |
| modal brightness (Lydian bright → Phrygian dark) | **partial** | ♭2/Phrygian dark holds; ♯4/nat-7 do not |
| V/U spectral shape (scooped = dark) | **confirmed (weak)** | extremes_share ρ −0.24; lens 0.33 |
| "hammering" percussion = dark | **refined** | harsh/noisy texture = dark (ρ −0.26…−0.36); but *clean* percussion (HPSS perc-ratio) = **brighter** (+0.25) |
| power = BPM | **confirmed-but-insufficient** | BPM ρ 0.52 vs full 0.77 |
| power sharpens brightness | **yes, only as human tag** | +0.09 from true power; 0 from predicted |

## 8. Approaches evaluated and rejected (with evidence)

1. **Spectrogram CNN + transfer learning (MobileNet/ResNet).** Rejected as primary
   method: black-box (defeats the interpretability goal); its premise (mel-spectrogram
   captures HF-energy brightness) contradicts the centroid sign-flip; mel blurs the
   pitch/harmony that proved predictive; 4-class softmax ignores the ordinal half-steps;
   heavy to deploy (PyTorch + model blob) vs a formula over features already extracted.
   Worth keeping only as a *later* ceiling experiment — and then with CQT/chroma input
   (not mel) and an ordinal loss.
2. **HTDemucs source separation** (isolate the "Other" stem for cleaner harmony).
   Rejected: expensive (PyTorch + minutes/track in the analyzer path) to fix an *unproven*
   bottleneck, and it would alter the **full-mix spectral contrast that is the single
   strongest feature**.
3. **Low-end contamination fix** (the cheap proxy for #2): recompute chroma with the
   low-frequency cutoff raised to 200 Hz to exclude kick/sub. **Tested** (528-track A/B):
   harmonic-feature ρ moved **+0.014 — negligible**. Hypothesis rejected; #2 not worth
   pursuing.
4. **Warmth as a low-mid/high energy ratio:** ρ +0.007 — warmth is timbral, not an EQ
   ratio (§4.3).

## 9. Ceiling & limitations

- **Ceiling ≈ 0.66 (brightness) / 0.77 (power).** The unexplained remainder is largely
  **set-context** — how a track *functions* in a set — which the audio does not carry.
  The §6 dissociation (human power tag helps, predicted power doesn't) is direct evidence
  of this shared contextual component.
- **Class imbalance** at the extremes (rare d2 / p5) makes extreme-end point estimates
  noisier; the dark end needs the classification framing of §4.4.
- **Full-mix features**; no source separation (shown unnecessary, §8).
- One curator, one (electronic/progressive) catalogue — the *weights* are personal; the
  *method* generalizes.

## 10. Recommendations

1. **Replace the centroid metric** with a feature model. A regularized **linear model is
   sufficient** (ties the trees) and ships as an inspectable formula.
2. **Two-part brightness score:** linear weights over z-scored features for the
   bright/middle ordering **+** a dark-classifier P(dark) term for the floor; map to the
   user scale via the existing percentile bucketing. (Avoids the MSE-compression problem.)
3. **Power model:** full-feature regressor (ρ≈0.77), same pipeline.
4. **Optional human-in-the-loop:** if a power tag exists, feed it to the brightness model
   (ρ≈0.75). Pure-audio otherwise.
5. **Zero new infrastructure:** every feature comes from the `MusicExtractor` pass the
   analyzer already runs — no new dependency, no CNN, no source separation. Ship the
   formula, bump the analyzer version, let the percentile cutoffs recompute.

## 11. Reproducibility

Scripts in `research/brightness/` (separate research venv; never bundled with the app):

| script | role |
|---|---|
| `export_dataset.py` / `export_power_dataset.py` | read-only SQL → labeled CSVs (brightness / power) |
| `extract_features.py` | Essentia MusicExtractor → 187-feature JSONL (parallel, resumable) |
| `analyze.py` | brightness model, correlations, Ridge weights, RF importance |
| `review_all.py` | the six-lens standalone-ρ + redundancy matrix |
| `test_spectral_shape.py` / `test_warmth.py` | H1/H2 and warm/cold hypothesis tests |
| `dark_signal_check.py` / `weighted_model.py` / `calibrate_check.py` | the dark-extreme investigation |
| `extract_hpcp_ab.py` / `analyze_hpcp_ab.py` | low-end-contamination A/B |
| `extract_hpss.py` / `analyze_hpss.py` | HPSS percussive-ratio (texture) |
| `analyze_power.py` | power model |
| `analyze_bright_x_power.py` | brightness × power interaction |

All evaluation is leave-artist-out GroupKFold. Labels read read-only from `curator.db`
(`tag` / `track_tag`); audio resolved via `source_link` (local). Features extracted under
WSL (Essentia); modeling under a Windows venv (scikit-learn / XGBoost).

---

# Part II — Production deployment & follow-on experiments

## 12. Shipped (analyzer 2.3.0)

The spike's verdict was taken to production. See `BRIGHTNESS_CALCULATION.md` for the spec.

- **Formula:** harmonic features **included** (user chose fidelity over a leaner port).
  Final shared 204-feature linear models, leave-artist-out **brightness ρ 0.667**,
  **power ρ 0.759**. Exported as `{brightness,power}_model.json` (features / impute_median
  / mean / std / coef / intercept).
- **Analyzer:** new `curator_analyzer/scoring.py` reproduces the research feature builder
  (flatten + engineered + harmonic) **verified to match** (harm Δ=0 exactly, end-to-end
  score Δ<0.003). `worker.py` computes brightness (replacing centroid) + power from one
  MusicExtractor pass; models bundled via `--add-data`; `ANALYZER_VERSION`→2.3.0.
- **Storage:** `power` column added to `track` + `track_analysis` (+ migration, index);
  `METRIC_NAMES`/`cutoffStore`/`getTracks` decoration; persisted in `queue.ts`.
- **UI:** `recommendTags` now leads the tag-picker "Recommended" row with the model's
  brightness/power tag (level→vocabulary map). Tracklist gained a sortable/filterable
  **Power** column; the **Brightness** column reformatted (it's a 0–3 score now, not kHz).
- **Backfill:** the 1,014 Curator-analyzed local tracks were re-scored in place (direct
  compute+write, `backfill_scores.py`). Sanity check held: re-scored brightness ranks the
  user's own tags **b1 2.52 > b0 2.08 > d1 1.65 > d2 1.20**. Rekordbox-slot rows left
  untouched (dual-source). Remaining tracks score on demand via advanced analysis.

## 13. Embedding experiment — Discogs-EffNet (the v2 gate)

Tested whether a pretrained music embedding (Essentia Discogs-EffNet, 1280-d, in a
separate `.venv-wsl-tf`) beats/augments the feature models and powers a similarity engine.
Sample of 528 tracks. Scripts: `extract_embeddings.py`, `analyze_embeddings.py`.

- **Lift test (leave-artist-out): negative.** Embedding *alone* is weaker than the feature
  model and concatenation overfits:
  - brightness: features **0.679**, embedding 0.617, features+embedding 0.644
  - power: features **0.713**, embedding 0.640, features+embedding 0.675
  → **Keep the feature-based brightness/power; do NOT add the TF dependency for them.**
  Embeddings encode broad genre/timbre neighbourhood — fuzzier than the specific
  warm/clarity axis the targeted features capture.
- **Similarity / reco: promising.** Cosine neighbours form coherent sub-genre clusters
  (melodic/progressive/organic house) and brightness tags loosely track the seed's; the
  dark extreme is the least coherent (rare-class). Quality is an ears call, but the
  structure is sound — embeddings earn their keep **for recommendation, not for the axes**.

## 14. Compound recommendation engine (design — parked)

Direction for a multi-signal "best tracks from the library" engine. Key design principle:
the requested signals are **three different relationships**, not one score —
  • **similarity** ("sounds like": embedding, brightness/power, genre/tags),
  • **compatibility / mixability** ("plays next to": key, BPM, power-transition — directional),
  • **affinity / co-occurrence** ("you group these": tags, playlists, user-pairs, sets).
Mashing them into one cosine gives muddy recs; expose intent (or context-weight them).

Architecture: a **typed weighted track-graph** + per-intent weighted blend; **random-walk-
with-restart** for multi-level descent (neighbours-of-neighbours); **learn the weights**
from user-pairs + real sets (learning-to-rank). Data status: #1 metadata + brightness/
power **have**; #2 tag/playlist co-occurrence **have** (extends `recommendTags`); #3 user
"similar" pairs **net-new** (small `track_pair` table + UI); #4 sets/play-history **not
logged** (`playCount`/`lastPlayedAt` are aggregate-only) — best source is **importing
Rekordbox history playlists** (ordered real sets) and/or in-app play logging; #5 descent =
the RWR layer. Suggested build order: content blend (no new deps) → user-pairs → embedding
signal → affinity graph+RWR → Rekordbox-history sequencing → learned weights. **Held.**

> **Update 2026-10-13:** the embedding leg of this design is now built — the AI audio engine
> (`apps/mir`, vectors in `mir.db`, similarity via `similar:` / Find Similar). Model bake-off and
> evaluation against tags, playlists and DJ sets: `research/mir/FINDINGS.md`.

## 15. Reproducibility (additions)

| script | role |
|---|---|
| `fit_production.py` | fit + export the shipped 204-feature brightness/power models |
| `verify_scoring.py` | confirm `scoring.py` reproduces research features/scores (WSL) |
| `backfill_scores.py` | re-score the 1,014 analyzed tracks in place (direct DB write) |
| `extract_embeddings.py` / `analyze_embeddings.py` | Discogs-EffNet embed + reco/lift test |

Production artifacts live under `apps/analyzer/src/curator_analyzer/`: `scoring.py` and the
bundled `data/{brightness,power}_model.json`.
