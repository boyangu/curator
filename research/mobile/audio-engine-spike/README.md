# The audio engine on a phone

Can the desktop's audio engine be the phone's? This spike compiles the engine
(`apps/audio/src/engine.rs` and the modules it uses, included as they are) into a small
program, with `cpal` replaced by a stand-in over Android's AAudio, and measures two things:
how long `play` takes to reach the output on a phone, and what the engine does to the sound
when the track's sample rate is not the device's.

Not part of the product; nothing here ships.

## What is here

| Path | What it is |
|---|---|
| `cpal-standin/` | The part of cpal's API the engine uses. On Android: AAudio through the NDK's C API, low-latency mode (cpal's own Android backend needs a Java VM, which a program run from `adb shell` has not). Elsewhere: no device — the caller pulls frames by hand. Every callback is timed, and the first audible frame after `probe::arm()` is recorded with its position in the stream. |
| `src/main.rs` | `engine-probe quality` (any machine) and `engine-probe latency <file>` (Android). |
| `scripts/build-android.mjs` | Cross-compiles for a phone with the NDK's clang (`rustup target add aarch64-linux-android` once). |
| `scripts/run-phone.mjs` | Makes two synthetic test tracks with ffmpeg, runs the latency test on the attached phone in five set-ups, removes everything from the phone. |

```
cargo build --release && target/release/engine-probe quality
node scripts/build-android.mjs && node scripts/run-phone.mjs
```

## Results (2026-11-20)

### Latency — Sony Xperia XQ-EC72 (Snapdragon 8 Gen 3, Android 16), built-in output

30 trials each: the stream is running and silent, `engine.play()` is called, and the clock
stops at the callback that writes the first audible frame, then at the time the device
reports that frame at the output (AAudio's timestamps).

| Set-up | Buffer | play → callback | play → output (median / worst) |
|---|---|---|---|
| 48 kHz track, shared device, smallest buffer | 4 ms | 1.3 ms | 14.6 / 15.5 ms |
| 48 kHz track, device to ourselves (exclusive) | 4 ms | 1.1 ms | 8.7 / 9.2 ms |
| 48 kHz track, the desktop's 30 ms buffer | 30 ms | 1.2 ms | 38.5 / 39.1 ms |
| 44.1 kHz track, engine converts the rate | 4 ms | 1.1 ms | 14.4 / 15.2 ms |
| 44.1 kHz track, stream opened at 44.1 kHz | 6 ms | 1.4 ms | 15.6 / 17.4 ms |

In every set-up: no glitch in 15 s of playback, and the engine's callback took 13 µs on
average of each 2 ms burst. A six-minute FLAC was fully decoded 0.7 s after `load` was
called (`load` itself returned after 0.5 s, on a first load that also opens the stream),
and held 124–135 MB: the engine keeps the whole track as 32-bit float.

What this is not: an acoustic measurement (the output time is the device's own report),
the touch screen's share, Bluetooth, a mid-range phone, or an app process.

### Rate conversion — any machine

A pure tone in a 32-bit float file, played into a device that only runs at 48 kHz (what a
phone is); the output is captured and compared with the tone. "Everything else" is all
that is not the tone, against the tone.

| Track | Device asks for | Tone | Speed | Level | Everything else | Strongest image |
|---|---|---|---|---|---|---|
| 48 kHz | any | any | exact | 0 dB | −155 dB | |
| 44.1 kHz | 480 frames (desktop, 10 ms) | 1 kHz | exact | 0 dB | −62 dB | −65 dB |
| 44.1 kHz | 480 frames | 10 kHz | exact | −1.5 dB | −20 dB | −21 dB at 13.9 kHz |
| 44.1 kHz | 480 frames | 15 kHz | exact | −3.4 dB | −11 dB | −11.5 dB at 18.9 kHz |
| 44.1 kHz | 96 or 192 frames (phones) | 1 kHz | 0.227 % slow (−3.9 cents) | 0 dB | −36 to −42 dB | −63 to −66 dB |
| 44.1 kHz | 96 or 192 frames | 10 kHz | 0.227 % slow | −1.5 dB | −14 to −18 dB | −22 dB |
| 44.1 kHz | 96 or 192 frames | 15 kHz | 0.227 % slow | −3.6 dB | −8 to −10 dB | −12 dB |

Two separate things:

- **The conversion is linear interpolation** (engine.rs says so, and that a better one
  would wait until an artefact is heard). It dulls the top octave and adds an image of
  every high tone a few dB to tens of dB below it. This is the desktop today as well,
  whenever the device runs at 48 kHz and the track is 44.1 kHz.
- **The play position is rounded to a whole frame at the end of every callback.** With
  480-frame callbacks 44.1 → 48 kHz lands on a whole frame each time (441), so the desktop
  does not show it. With a phone's 96 or 192 frames it loses 0.4 of a frame per callback:
  the track plays 0.227 % slow, with a small jump in the wave every 2–4 ms.

A track at the device's own rate passes through untouched.

### After the fix (same day)

Both are fixed in `apps/audio`: the callback reads the track with a windowed-sinc
interpolator (`src/resample.rs`, 64 taps) and carries the part of a frame it ended on into
the next callback. The same measurement, whatever the device asks for (480, 192 or 96 frames):

| Track | Tone | Speed | Level | Everything else | Strongest image |
|---|---|---|---|---|---|
| 44.1 kHz | 1 kHz | exact | 0.00 dB | −119 dB | −136 dB |
| 44.1 kHz | 10 kHz | exact | 0.00 dB | −113 dB | −114 dB |
| 44.1 kHz | 15 kHz | exact | 0.00 dB | −117 dB | −120 dB |
| 48 kHz | any | exact | 0 dB | −155 dB (unchanged) | |

On the phone, converting a 44.1 kHz track now costs 90 µs of each 2 ms callback (13 µs
before, and still 13–16 µs for a 48 kHz track); no glitches in 15 s; `play` → output is
unchanged at 14.3 ms.

### Bytes before first sound — any machine

`engine-probe first-audio <file>` opens a file as the engine does, through a reader that
notes what the decoder asks for. This is what a network fetch by byte range would have to
bring before the track can be heard.

| File | Format known | First audio | Ten seconds of audio | From the end of the file |
|---|---|---|---|---|
| A FLAC from the library (25.6 MB, 5:46) | 160 KB | 160 KB | 608 KB | nothing |
| Synthetic FLAC | 15 KB | 31 KB | 640 KB | nothing |
| Synthetic MP3, 320 kbps | 3 KB | 3 KB | 416 KB | nothing |
| Synthetic M4A (AAC) | 126 KB | 126 KB | 413 KB | 125 KB first |
| The same M4A, index moved to the front | 127 KB | 127 KB | 416 KB | 64 KB first |

The engine cannot play from a network today: it opens a local file. The fetch itself
(Google Drive, or the desktop) was not measured — see the note in the main findings.
