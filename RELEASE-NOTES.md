# Release Notes

## 2026-06-23 — Traxsource enrichment
Beatport is no longer the only metadata source. When Beatport can't find a track — or returns it with fields missing — Curator now falls back to Traxsource to fill the gaps (label, genre, BPM, key). Beatport still wins wherever both have data; Traxsource only fills what's missing. Track durations from your local files are also promoted to canonical, which sharpens match accuracy.

## 2026-06-22 — Autoplay & soft-delete
Two things. **Autoplay:** when a track ends, Curator can roll straight into the next one, with independent toggles for streaming and local playback (Settings › Player). **Soft-delete:** remove a track from your library without erasing it everywhere — it's hidden from the main views, tagged with a "deleted" chip, and still visible inside an individual playlist. Tracks you own or collaborate on are pulled from those playlists too.

## 2026-06-19 — Camelot / musical key display
Key now renders consistently everywhere — tracklist, omnibar, player, and Discover — in either Camelot (`8A`) or musical (`Am`) notation, switchable in Settings, and color-coded to the standard wheel.

## 2026-06-15 — Learned brightness & power scores
The analyzer now predicts perceptual **brightness** and **power** for every track using models trained on ~3,000 of your own tracks, instead of a hand-tuned EQ heuristic. The result tracks how songs actually sound far more closely (correlation ≈0.67 / 0.77 vs ≈0.24 / 0.52 for the old metric). Ships in analyzer 2.3.0 — method and findings under `research/brightness/`.

## 2026-06-13 — Discover feed v1 [discover-core]
A personalized feed of new tracks, in front of your library. Spotify producers (playlist deltas + new releases from artists you follow) surface candidates, Beatport enrichment fills in BPM / key / label / genre, and ISRC dedup keeps the same track from appearing twice. Play cards inline with auto-advance, dismiss what you don't want, and promote keepers into the library — the enriched metadata comes with them.

## 2026-06-10 — Cue editor [player-cues]
Create, rename, recolor, and delete hot cues and memory cues from a 16-color palette, directly on the waveform. Edits sync back to Rekordbox (dual-row hot cues, CTI colors) without clobbering your beatgrid.

## 2026-06-04 — Rekordbox two-way sync [build-rb-sync]
Push your Curator library back into Rekordbox — metadata, beatgrid, cues, and waveform, each independently toggleable — with a timestamped backup before every write, post-write integrity verification, and one-click restore. Reads your collection (master.db + ANLZ data) in; writes safely back out.

## 2026-06-03 — Pioneer FLX10 control [controllers-pioneer]
Drive playback from a Pioneer DDJ-FLX10 over USB-MIDI: cue pads (with matching LED cue colors), beat jumps, loops, play, and browse/load navigation. Plus keyboard beat-jumps (±1 / 4 / 16 beats) for deck-free control.

## 2026-06-02 — Phrase & segment lane [player-phrases]
The big waveform now carries a phrase lane: structural segments (intro / build / drop / breakdown / outro) detected by the analyzer, colored by energy, with boundary markers and labels. Click the lane to seek to a segment's start.

## 2026-06-02 — Drag Waveform [player-drag-waveform]
Grab the big waveform with the mouse and pull it around like a vinyl record. Audio scrubs at the speed and direction of your hand — drag forward to advance, drag backward for reverse playback, hold still and the sound stops. Pressing the mouse pauses the track immediately so you can hear silence the instant you grab the wave; releasing it commits the new position and resumes playback if it was playing before. Track edges clamp at 0:00 and the track end. Streaming-source tracks (Spotify, Tidal) scrub visually but stay silent during the drag — the SDKs don't expose rate control — and seek once on release.
Guide: [guides/player-drag-waveform.md](guides/player-drag-waveform.md)

## 2026-05-27 — Offline audio analysis
Local tracks are analyzed offline with Essentia: BPM, key, EBUR128 loudness, true-peak, dissonance, and density — surfaced as sortable tracklist columns and 1–5 buckets. Structural segment detection and derived energy scalars followed in the days after.

## 2026-05-26 — Native audio engine
Local file playback moved off Chromium's Web Audio onto a native Rust sidecar (Symphonia decode + cpal output). Cold-start playback dropped from ~1.7–2.3s to a few hundred milliseconds, with sample-accurate cue and loop triggering.

## Foundations (before 2026-05-26)
The base everything sits on: Spotify and Tidal OAuth + playlist sync; ISRC-based deduplication so one track across many sources is a single record; Beatport enrichment; Tidal track-id resolution against Spotify (hybrid playlists); Spotify in-app playback (Web Playback SDK + Widevine); and a virtualized tracks list with per-playlist anchor + search persistence.
