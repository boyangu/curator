# Drag Waveform

## What it does

Vinyl-style scrubbing on the big waveform. Grabbing the wave with the mouse pauses playback and lets you pull the track under the playhead by hand — audio plays at the speed and direction of your drag, exactly the way touching a record reveals what's there. Lift the mouse and playback resumes from the new position (if it was playing when you grabbed it). For local-file tracks the audio scrubs at the drag velocity, including in reverse. For Spotify and Tidal tracks the drag is visual only — the streaming SDKs don't expose sample-rate control — and the track jumps to the final position on release.

## How to use it

1. **Drag to hunt a position.** Press and hold the mouse on the big waveform, then drag. The point under the cursor at the moment you pressed stays under the cursor as you drag — the wave follows your hand 1:1. Audio scrubs in real time at the drag speed.
2. **Drag forward to advance.** Mouse moves left, time advances. Mouse moves right, time goes backward (reverse audio for local tracks).
3. **Hold still to silence.** Stop moving the mouse without releasing — audio fades out within ~100 ms. Move again to resume scrubbing.
4. **Release to commit.** Lifting the mouse seeks to the final position. If the track was playing when you grabbed it, playback resumes from there; if it was paused, it stays paused.
5. **Click to seek (no drag).** A press-and-release without moving more than 3 pixels is treated as a click — it seeks to that point and resumes play if applicable. Clicking inside the phrase lane at the bottom of the wave seeks to the bracketing phrase's start.
6. **Drag past the edges.** The cursor can leave the waveform's bounds; the drag keeps tracking until you release. Track position clamps at 0:00 and the track end — you can't scrub past either edge.

## Troubleshooting

- **"Streaming track went silent during the drag."** Expected — Spotify and Tidal SDKs don't expose variable-rate playback, so the drag is visual only for streaming sources. The track seeks once when you release.
- **"An active loop disappeared after I dragged."** The loop is temporarily disabled during a drag so you can scrub past its bounds, then restored on release. If the final drop position falls outside the loop bounds, the loop stays cleared (matches the existing "manual seek outside loop bounds" behavior).
