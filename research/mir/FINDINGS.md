# AI audio engine — Phase 0 model bake-off

*Which 2026 music foundation model should power "sounds like" in Curator, judged against
labels the curator made themselves? Productized as `apps/mir` (engine) + `apps/core/src/mir`
(store, scheduler, similarity).*

## Executive summary

- **MERT-v2-FullSong and MuQ-MuLan both beat June's Discogs-EffNet** on the curator's own tags
  (lift 2.99 / 3.03 vs 2.77) and on DJ-set adjacency (next-track MRR 0.034 / 0.031 vs 0.027).
- **Blending the two is the best configuration**: tag lift **3.22**, set MRR **0.041**, median rank
  of the track actually played next **252 of 1,198** (random 615). This is the shipped default.
- **Text search works without training** (MuQ-MuLan): "piano melody" retrieves the curator's
  `piano+` tag at 6.8× base rate, "prominent vocals" hits `vocal` at 80% precision@50.
- **Mean-centring the vectors is a free win** for track-to-track similarity (tag lift +10–25%).
- **The Intel Arc iGPU (torch XPU) runs the models 20–30× faster than the CPU**, so the whole
  local library embeds locally in hours; the cloud executor is optional.
- **`laion/larger_clap_music` is broken under transformers** (its text and audio towers don't
  align); the engine uses `laion/larger_clap_general` instead.

## 1. Setup

| | |
|---|---|
| Sample | 1,200 local tracks: all 617 played in rekordbox DJ sets + a seeded fill of tagged / rb-playlisted tracks (1,199 embedded by every model; one file vanished overnight) |
| Labels | 54 user tags with ≥20 members; 88 rekordbox playlists (5–300 members); 1,230 consecutive DJ-set plays; 8,673 consecutive prep plays; Beatport genre/label; main artists |
| Models | MERT-v2-FullSong (1024-d, whole-song masked mean, ≤360 s windows), MuQ-MuLan-large (512-d, mean of 10 s clip latents), LAION CLAP (512-d, mean of 10 s windows), Discogs-EffNet 1280-d (June baseline) |
| Baselines | random; metadata one-hot (genre + label + artists); scalars (bpm, brightness, power) |
| Code | `export_dataset.py` → `extract.py` (the production engine, so research = product vectors) / `extract_effnet.py` → `evaluate.py`, `textprobe.py`, `listen.py`; outputs in `c:/tmp/mir` |

Metrics (every track is a seed; the other 1,198 are candidates):
**tag lift** = per-tag precision@10 ÷ base rate, macro over tags (brightness/power bucket tags
excluded); **playlist mAP** over rekordbox co-members; **set MRR / median rank** of the track the
curator actually played next in a DJ set.

## 2. Results

| run | tag lift | playlist mAP | set MRR | set R@50 | set median rank | genre P@10 |
|---|---|---|---|---|---|---|
| random | 0.96 | 0.044 | 0.006 | 0.03 | 615 | 0.23 |
| metadata | 1.80 | 0.058 | 0.033 | 0.12 | 485 | 0.90* |
| scalars (bpm, brightness, power) | 1.77 | 0.065 | 0.015 | 0.10 | 360 | 0.28 |
| EffNet (centred) | 2.77 | 0.063 | 0.024 | 0.14 | 315 | 0.34 |
| MERT-v2 (centred) | 2.99 | 0.059 | 0.032 | 0.17 | 272 | 0.33 |
| MuQ-MuLan (centred) | 3.03 | 0.067 | 0.031 | 0.14 | 274 | 0.36 |
| **MERT-v2 + MuQ-MuLan** | **3.22** | 0.066 | **0.041** | **0.17** | **252** | 0.35 |
| CLAP general (centred) | 2.89 | 0.060 | 0.027 | 0.13 | 335 | 0.34 |
| MERT-v2 + MuQ-MuLan + CLAP | 3.27 | 0.066 | 0.038 | 0.16 | 268 | 0.36 |

\* metadata uses the genre field directly, so its genre score is circular.

Per tag (lift, centred): MERT-v2 is the strongest on **vocal** (2.29 vs EffNet 1.33); MuQ-MuLan on
**d1** (dark, 2.95), **p4** (power, 1.99), **dreamy**, **warm** and **freedom**. The blend keeps both.

**Rekordbox playlists are organised more by energy than by sound**: the scalar baseline
(bpm/brightness/power) ties the best embedding on playlist mAP. Similarity and "fits this crate"
are different questions; the engine answers the first.

## 3. Naming by text (research question 3)

Zero-shot prompts embedded by MuQ-MuLan's text tower, ranked against the sample (`textprobe.py`):

| user tag | prompt | precision@50 | lift |
|---|---|---|---|
| vocal | "electronic music with prominent vocals and singing" | 0.80 | 3.0 |
| piano+ | "piano melody, piano chords" | 0.42 | 6.8 |
| uplift | "uplifting euphoric anthem" | 0.54 | 4.3 |
| funky | "funky groove with bass guitar" | 0.30 | 3.8 |
| dreamy | "dreamy ethereal ambient pads" | 0.54 | 1.9 |
| minimal | "minimal techno" | 0.10 | 1.3 |
| broken synth | "broken beat, glitchy synth" | 0.08 | 1.4 |

Concrete sound concepts (instruments, vocals, mood) name well; the curator's private vocabulary
("minimal", "broken synth") does not — those need learning from their tags, not prompts.

The same probe with CLAP's text tower averages lift 1.98 (MuQ-MuLan 2.52): weaker on vocals
(1.7) and piano (2.6), but the best of the three on "minimal techno" (2.4). A first CLAP run used
`laion/larger_clap_music`, which scored at chance: under transformers its text and audio towers
don't align (synthetic sine / noise / bass clips all scored ~0.01 against their own descriptions,
while `larger_clap_general` and `clap-htsat-unfused` matched them cleanly).

## 4. Engineering findings

- **Speed** (one 6:22 track): CPU 70 s MERT-v2 / 53 s MuQ-MuLan / 8 s CLAP; Arc 140V XPU 2.4 / 2.9 / 2.4 s.
  MuQ-MuLan must run **bf16** on XPU (fp16 overflows to NaN); XPU vectors match CPU at cosine ≥ 0.99995.
- **Laptop sleep degrades XPU** throughput ~300× until the process restarts; the backfill is
  resumable (derived pending set), so a restart is the fix.
- **Windows stdin deadlock** in multi-threaded Python sidecars (DLL CRT init blocks on the stdin
  pipe) — fixed in the engine's `_private_stdin`.
- **Data quirks**: main artists carry `track_artist.role = NULL`; ~4.5% of sampled tracks still hold
  legacy pre-2.3 `brightness` (raw spectral centroid, up to ~1281) instead of the 0–3 learned score.

## 5. Decisions

1. Default models: **MERT-v2-FullSong + MuQ-MuLan, blended** (mean of centred cosines) for
   track-to-track similarity; MuQ-MuLan for `sounds:"…"` text search.
2. Mean-centre for track-to-track queries; keep the raw space for text (as trained).
3. CLAP (`larger_clap_general`) stays available — Apache-2.0, cheapest on CPU, second-best text search — but
   not in the default blend: adding it raised tag lift only 3.22 → 3.27 and lowered set MRR 0.041 → 0.038.
4. Local XPU executor by default; Modal cloud executor kept for machines without a GPU and for v2
   stems/structure.

## 6. Next (v2)

Stems (BS-RoFormer/HTDemucs) × sections (SongFormer/allin1) as extra vector scopes, then named
facets — Discogs styles / instruments from trained heads, plus a producer lexicon scored by text
towers (works for concrete concepts per §3), and personal classifiers learned from the curator's own
tags for the private vocabulary.
