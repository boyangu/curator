//! How much of a file has to arrive before it can be heard — what decides
//! the time to first sound when the file is fetched over a network by byte
//! range instead of read from disk.
//!
//! The file is opened the way the engine opens it (decode.rs `probe`: the
//! same probe and decoder set-up), through a reader that notes every read
//! and seek the decoder makes. Reported: the bytes that had been asked for
//! when the format was known, when the first audio came out, and after one
//! and ten seconds of audio; and whether the decoder had to go to the far
//! end of the file first.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use serde_json::json;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Default)]
struct Trace {
    /// Byte ranges read, merged, in the order first touched.
    ranges: Vec<(u64, u64)>,
    reads: u64,
}

impl Trace {
    fn note(&mut self, from: u64, to: u64) {
        self.reads += 1;
        if let Some(r) = self.ranges.iter_mut().find(|r| from <= r.1 && to >= r.0) {
            r.0 = r.0.min(from);
            r.1 = r.1.max(to);
        } else {
            self.ranges.push((from, to));
        }
    }

    fn snapshot(&self, size: u64) -> serde_json::Value {
        let total: u64 = self.ranges.iter().map(|r| r.1 - r.0).sum();
        // The run from the start of the file, and whatever else was touched.
        let head = self.ranges.iter().find(|r| r.0 == 0).map(|r| r.1).unwrap_or(0);
        let elsewhere: Vec<_> = self.ranges.iter().filter(|r| r.0 != 0).map(|r| json!({ "from": r.0, "bytes": r.1 - r.0, "fromEnd": size - r.0 })).collect();
        json!({ "bytes": total, "fromStart": head, "elsewhere": elsewhere, "reads": self.reads })
    }
}

struct Counting {
    file: File,
    pos: u64,
    size: u64,
    trace: Arc<Mutex<Trace>>,
}

impl Read for Counting {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        self.trace.lock().unwrap().note(self.pos, self.pos + n as u64);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for Counting {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        self.pos = self.file.seek(to)?;
        Ok(self.pos)
    }
}

impl MediaSource for Counting {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.size)
    }
}

pub fn first_audio(path: &Path) -> Result<serde_json::Value> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let size = file.metadata()?.len();
    let trace = Arc::new(Mutex::new(Trace::default()));
    let mss = MediaSourceStream::new(Box::new(Counting { file, pos: 0, size, trace: trace.clone() }), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe().format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default()).context("probe format")?;
    let mut format = probed.format;
    let track = format.default_track().ok_or_else(|| anyhow!("no default track"))?;
    let params = track.codec_params.clone();
    let track_id = track.id;
    let rate = params.sample_rate.ok_or_else(|| anyhow!("no sample rate"))? as u64;
    let seconds = params.n_frames.map(|n| n as f64 / rate as f64);
    let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).context("decoder")?;
    let known = trace.lock().unwrap().snapshot(size);

    let mut frames = 0u64;
    let mut marks = Vec::new();
    let mut targets = vec![("firstAudio", 1u64), ("oneSecond", rate), ("tenSeconds", rate * 10)];
    while !targets.is_empty() {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        if let Ok(buf) = decoder.decode(&packet) {
            frames += buf.frames() as u64;
        }
        while targets.first().map(|t| frames >= t.1).unwrap_or(false) {
            let (name, _) = targets.remove(0);
            marks.push((name, trace.lock().unwrap().snapshot(size)));
        }
    }
    let mut out = json!({
        "command": "first-audio",
        "file": { "extension": path.extension().and_then(|s| s.to_str()), "bytes": size, "seconds": seconds, "sampleRate": rate, "bytesPerSecondOfAudio": seconds.map(|s| (size as f64 / s).round()) },
        "formatKnown": known,
    });
    for (name, snap) in marks {
        out[name] = snap;
    }
    Ok(out)
}
