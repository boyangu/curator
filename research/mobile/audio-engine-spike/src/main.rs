//! The desktop's audio engine — apps/audio/src/engine.rs and the modules it
//! uses, included as they are — driven by this small program instead of the
//! JSON-RPC host, with `cpal` replaced by the spike's stand-in
//! (cpal-standin/).
//!
//!   engine-probe quality [dir]
//!       Any machine. Tones at 44.1 kHz and 48 kHz are played into a device
//!       that runs at 48 kHz and nothing else (most phones); what the engine
//!       would have sent it is captured and compared with the tone that went
//!       in. Measures the engine's own rate conversion.
//!
//!   engine-probe latency <audio file> [--trials 40] [--play 20] [--volume 0.05]
//!       Android (AAudio). Loads the file, then times `play` from the call to
//!       the callback that wrote the first audible frame, and to the moment
//!       the device reports that frame at the output. Then plays for a while
//!       and counts glitches.
//!
//!   engine-probe first-audio <audio file>
//!       Any machine. How many bytes of the file the decoder asks for before
//!       it knows the format, before the first audio, and after one and ten
//!       seconds of it (first_audio.rs).
//!
//! Prints one JSON object.

#![allow(dead_code)]

#[path = "../../../../apps/audio/src/beatjump.rs"]
mod beatjump;
#[path = "../../../../apps/audio/src/decode.rs"]
mod decode;
#[path = "../../../../apps/audio/src/engine.rs"]
mod engine;
#[path = "../../../../apps/audio/src/mmcss.rs"]
mod mmcss;
#[path = "../../../../apps/audio/src/protocol.rs"]
mod protocol;
#[path = "../../../../apps/audio/src/resample.rs"]
mod resample;

mod first_audio;

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde_json::json;

use engine::Engine;

fn new_engine() -> Engine {
    let (tx, rx) = mpsc::channel();
    // The engine reports position at 20 Hz; nobody is listening here.
    thread::spawn(move || for _ in rx {});
    Engine::new(tx)
}

fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).and_then(|l| l.split_whitespace().nth(1)?.parse().ok()))
        .unwrap_or(0)
}

/// User + system CPU time of this process, in clock ticks (10 ms).
fn cpu_ticks() -> u64 {
    std::fs::read_to_string("/proc/self/stat")
        .ok()
        .and_then(|s| {
            // The fields after the parenthesised program name.
            let rest = s.rsplit_once(')')?.1.split_whitespace().collect::<Vec<_>>();
            Some(rest.get(11)?.parse::<u64>().ok()? + rest.get(12)?.parse::<u64>().ok()?)
        })
        .unwrap_or(0)
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

// ── quality ─────────────────────────────────────────────────────────────────

/// A stereo 32-bit float WAV of one sine: no quantisation of its own, so
/// whatever differs at the output is the engine's.
fn write_tone(path: &Path, rate: u32, seconds: u32, hz: f64, amplitude: f64) -> Result<()> {
    let frames = (rate * seconds) as usize;
    let data_bytes = (frames * 2 * 4) as u32;
    let mut b = Vec::with_capacity(44 + data_bytes as usize);
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&rate.to_le_bytes());
    b.extend_from_slice(&(rate * 8).to_le_bytes());
    b.extend_from_slice(&8u16.to_le_bytes());
    b.extend_from_slice(&32u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data_bytes.to_le_bytes());
    let w = 2.0 * std::f64::consts::PI * hz / rate as f64;
    for n in 0..frames {
        let s = ((w * n as f64).sin() * amplitude) as f32;
        b.extend_from_slice(&s.to_le_bytes());
        b.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, b)?;
    Ok(())
}

/// Least-squares fit of one sine at `hz` to `x`: its amplitude, and the
/// power of everything the fit leaves over.
fn fit_tone(x: &[f64], rate: f64, hz: f64) -> (f64, f64) {
    let w = 2.0 * std::f64::consts::PI * hz / rate;
    let (mut ss, mut cc, mut sc, mut xs, mut xc) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (n, v) in x.iter().enumerate() {
        let (s, c) = (w * n as f64).sin_cos();
        ss += s * s;
        cc += c * c;
        sc += s * c;
        xs += v * s;
        xc += v * c;
    }
    let det = ss * cc - sc * sc;
    let a = (xs * cc - xc * sc) / det;
    let b = (xc * ss - xs * sc) / det;
    let residual = x.iter().enumerate().map(|(n, v)| { let (s, c) = (w * n as f64).sin_cos(); (v - a * s - b * c).powi(2) }).sum::<f64>() / x.len() as f64;
    ((a * a + b * b).sqrt(), residual)
}

fn db(ratio: f64) -> f64 {
    20.0 * ratio.max(1e-12).log10()
}

#[cfg(not(target_os = "android"))]
fn quality(dir: &Path) -> Result<serde_json::Value> {
    const OUT_RATE: u32 = 48_000;
    const AMPLITUDE: f64 = 0.5;
    std::env::set_var("CPAL_STANDIN_RATE", OUT_RATE.to_string());
    std::fs::create_dir_all(dir)?;
    let round = |v: f64, places: f64| (v * places).round() / places;
    let mut rows = Vec::new();
    // How many frames the device asks for at a time: 480 is the desktop
    // (WASAPI's 10 ms period); 192 and 96 are what phones ask for.
    for burst in [480usize, 192, 96] {
        for source_rate in [44_100u32, 48_000] {
            for hz in [1_000.0f64, 5_000.0, 10_000.0, 15_000.0] {
                let path = dir.join(format!("tone-{source_rate}-{hz}.wav"));
                write_tone(&path, source_rate, 4, hz, AMPLITUDE)?;
                let mut engine = new_engine();
                engine.load(&path)?;
                // Four seconds of WAV decode in a few milliseconds.
                thread::sleep(Duration::from_millis(400));
                engine.play()?;
                let out = cpal::offline::render(OUT_RATE as usize * 2, burst);
                drop(engine);
                let _ = std::fs::remove_file(&path);
                // The second second: past the fade-in.
                let x: Vec<f64> = out.chunks(2).skip(OUT_RATE as usize).take(OUT_RATE as usize).map(|f| f[0] as f64).collect();
                if x.len() != OUT_RATE as usize {
                    bail!("the engine rendered {} frames, not {OUT_RATE}", x.len());
                }
                // The pitch that came out: the frequency near the tone's that fits best.
                let mut best = (hz, f64::MAX, 0.0);
                let mut step = hz * 0.004;
                let mut centre = hz;
                for _ in 0..6 {
                    for k in -10..=10 {
                        let f = centre + step * k as f64 / 10.0;
                        let (level, residual) = fit_tone(&x, OUT_RATE as f64, f);
                        if residual < best.1 {
                            best = (f, residual, level);
                        }
                    }
                    centre = best.0;
                    step /= 8.0;
                }
                let (out_hz, residual, level) = best;
                let speed = out_hz / hz;
                // The strongest single thing a conversion from 44.1 kHz adds: the
                // tone's first image (44100 − f) folded back by the 48 kHz output.
                let image_hz = OUT_RATE as f64 - (source_rate as f64 - hz) * speed;
                let image = (source_rate != OUT_RATE).then(|| (image_hz, db(fit_tone(&x, OUT_RATE as f64, image_hz).0 / level)));
                rows.push(json!({
                    "burstFrames": burst,
                    "sourceRate": source_rate,
                    "toneHz": hz,
                    "speedErrorPercent": round((speed - 1.0) * 100.0, 1000.0),
                    "pitchErrorCents": round(1200.0 * speed.log2(), 10.0),
                    "levelDb": round(db(level / AMPLITUDE), 100.0),
                    // Everything that is not the tone, against the tone.
                    "everythingElseDb": round(10.0 * (residual.max(1e-24) / (level * level / 2.0)).log10(), 10.0),
                    "imageHz": image.map(|i| i.0.round()),
                    "imageDb": image.map(|i| round(i.1, 10.0)),
                }));
            }
        }
    }
    Ok(json!({ "command": "quality", "outputRate": OUT_RATE, "rows": rows }))
}

#[cfg(target_os = "android")]
fn quality(_dir: &Path) -> Result<serde_json::Value> {
    bail!("quality runs without a sound device: build for this machine, not Android")
}

// ── latency ─────────────────────────────────────────────────────────────────

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn summary(values: &[f64]) -> serde_json::Value {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let r = |x: f64| (x * 100.0).round() / 100.0;
    json!({ "n": v.len(), "min": r(percentile(&v, 0.0)), "median": r(percentile(&v, 0.5)), "p95": r(percentile(&v, 0.95)), "max": r(percentile(&v, 1.0)) })
}

fn latency(path: &Path, trials: usize, play_seconds: u64, volume: f32) -> Result<serde_json::Value> {
    let rss_before = rss_kb();
    let mut engine = new_engine();
    let t = Instant::now();
    let info = engine.load(path)?;
    let load_ms = t.elapsed().as_secs_f64() * 1000.0;

    // The decoder thread runs flat out until the whole track is in memory:
    // it is done when the process stops using a core. (The audio callback,
    // paused, costs far less than a tick in this window.)
    let mut last = cpu_ticks();
    let mut busy_at = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(50));
        let now = cpu_ticks();
        if now >= last + 2 {
            busy_at = Instant::now();
        } else if busy_at.elapsed() > Duration::from_millis(400) || t.elapsed() > Duration::from_secs(180) {
            break;
        }
        last = now;
    }
    let decode_ms = busy_at.duration_since(t).as_secs_f64() * 1000.0;
    let rss_loaded = rss_kb();
    engine.set_volume(volume);
    let stream = cpal::probe::stream_info().ok_or_else(|| anyhow!("no stream after load"))?;
    let burst_ms = stream.frames_per_burst as f64 * 1000.0 / stream.sample_rate as f64;

    // play, from the call to the first audible frame.
    let mut to_callback = Vec::new();
    let mut to_output = Vec::new();
    let mut missed = 0;
    for i in 0..trials {
        engine.seek(5.0 + (i % 60) as f64 * 3.0)?;
        thread::sleep(Duration::from_millis(250));
        cpal::probe::arm();
        engine.play()?;
        let waited = Instant::now();
        let hit = loop {
            if let Some(h) = cpal::probe::take_hit() {
                break Some(h);
            }
            if waited.elapsed() > Duration::from_millis(1_000) {
                break None;
            }
            thread::sleep(Duration::from_micros(500));
        };
        // Long enough for the device to have a timestamp past that frame.
        thread::sleep(Duration::from_millis(200));
        match hit {
            Some(h) => {
                to_callback.push((h.callback_ns - h.arm_ns) as f64 / 1e6);
                if let Some(at) = cpal::probe::presentation_ns(h.frame) {
                    to_output.push((at - h.arm_ns) as f64 / 1e6);
                }
            }
            None => missed += 1,
        }
        engine.pause()?;
        thread::sleep(Duration::from_millis(150));
    }

    // Then steady playback.
    engine.seek(10.0)?;
    cpal::probe::reset_stats();
    let xruns_before = cpal::probe::stats().xruns;
    engine.play()?;
    thread::sleep(Duration::from_secs(play_seconds));
    let stats = cpal::probe::stats();
    engine.pause()?;
    thread::sleep(Duration::from_millis(100));

    Ok(json!({
        "command": "latency",
        "file": path.file_name().map(|n| n.to_string_lossy().into_owned()),
        "track": { "seconds": info.duration, "sampleRate": info.sample_rate, "channels": info.channels },
        "load": {
            "loadReturnedMs": load_ms.round(),
            "fullyDecodedMs": decode_ms.round(),
            "decodeSpeedTimesRealtime": (info.duration * 1000.0 / decode_ms.max(1.0)).round(),
            "memoryForTrackMb": ((rss_loaded.saturating_sub(rss_before)) as f64 / 1024.0).round(),
        },
        "stream": {
            "sampleRate": stream.sample_rate,
            "framesPerBurst": stream.frames_per_burst,
            "burstMs": (burst_ms * 100.0).round() / 100.0,
            "bufferFrames": stream.buffer_size_frames,
            "bufferMs": (stream.buffer_size_frames as f64 * 100_000.0 / stream.sample_rate as f64).round() / 100.0,
            "bufferCapacityFrames": stream.buffer_capacity_frames,
            "performanceMode": stream.performance_mode,
            "sharingMode": stream.sharing_mode,
            "engineResamples": info.sample_rate != stream.sample_rate,
        },
        "play": {
            "trials": trials,
            "missed": missed,
            "callToCallbackMs": summary(&to_callback),
            "callToOutputMs": summary(&to_output),
        },
        "steady": {
            "seconds": play_seconds,
            "callbacks": stats.callbacks,
            "callbackMeanUs": stats.callback_ns_mean / 1_000,
            "callbackMaxUs": stats.callback_ns_max / 1_000,
            "framesPerCallbackMax": stats.frames_per_callback_max,
            "glitches": stats.xruns - xruns_before,
        },
    }))
}

fn main() -> Result<()> {
    tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into())).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = match args.first().map(String::as_str) {
        Some("quality") => quality(&args.get(1).map(PathBuf::from).unwrap_or_else(|| std::env::temp_dir().join("curator-engine-probe")))?,
        Some("latency") => {
            let path = args.get(1).ok_or_else(|| anyhow!("latency <audio file>"))?;
            latency(
                Path::new(path),
                arg(&args, "--trials").and_then(|v| v.parse().ok()).unwrap_or(40),
                arg(&args, "--play").and_then(|v| v.parse().ok()).unwrap_or(20),
                arg(&args, "--volume").and_then(|v| v.parse().ok()).unwrap_or(0.05),
            )?
        }
        Some("first-audio") => first_audio::first_audio(Path::new(args.get(1).ok_or_else(|| anyhow!("first-audio <audio file>"))?))?,
        _ => bail!("usage: engine-probe quality [dir] | latency <audio file> [--trials 40] [--play 20] [--volume 0.05] | first-audio <audio file>"),
    };
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}
