//! `curator-audio convert` — one-shot FLAC (or any symphonia-readable
//! source) → CDJ-compatible WAV conversion.
//!
//! Separate process mode rather than an RPC because the playback sidecar
//! serves RPCs serially on its main thread: a multi-second conversion there
//! would stall transport control. The host spawns one process per track.
//!
//! Protocol (all JSON, one object per line, camelCase):
//!   stdin  ← one job: { input, output, maxSampleRate?, tags?, cover? }
//!   stdout → {"kind":"started",...}, {"kind":"progress",...}*, then exactly
//!            one of {"kind":"done",...} (exit 0) or {"kind":"error",...}
//!            (exit 1, partial output deleted).
//!
//! The no-resample path is bit-exact: the integer PCM in the WAV equals the
//! decoder's integer output. Resampling (only when the source rate exceeds
//! `maxSampleRate`) is time-aligned with the source, because the host copies
//! cue points and beatgrids from the FLAC by time — a few ms of resampler
//! latency would visibly shift every cue on the deck.

use anyhow::{anyhow, bail, Context, Result};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler, WindowFunction};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use symphonia::core::audio::{AudioBuffer, AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_FLAC};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, StandardVisualKey, Visual};
use symphonia::core::probe::Hint;
use symphonia::core::sample::{Sample, SampleFormat};

use crate::wav_writer::{self, WavFormat, WavWriter};

const DEFAULT_MAX_SAMPLE_RATE: u32 = 48_000;
/// Progress lines per file — enough for a smooth bar, few enough that a
/// playlist of hundreds of tracks doesn't flood the host's line parser.
const PROGRESS_STEPS: u64 = 50;
/// Resampler chunk (input frames per call). With one FFT sub-chunk this is
/// also roughly the anti-aliasing filter length at the source rate, so it
/// sets quality: ~2k taps puts the BlackmanHarris2 cutoff close to the
/// output Nyquist (≈ 22.5 kHz for 96→48 k).
const RESAMPLE_CHUNK: usize = 2048;

// ─── Job (stdin) ────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub input: PathBuf,
    pub output: PathBuf,
    #[serde(default)]
    pub max_sample_rate: Option<u32>,
    #[serde(default)]
    pub tags: Option<Tags>,
    #[serde(default)]
    pub cover: Option<bool>,
}

/// Every field is optional and nullable. Year / track number / BPM are
/// accepted as either strings or numbers — the host's DB columns vary in
/// type and a strict schema here would turn a cosmetic mismatch into a
/// failed conversion.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tags {
    #[serde(deserialize_with = "de_opt_string")]
    pub title: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub artist: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub album: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub genre: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub label: Option<String>,
    #[serde(deserialize_with = "de_opt_f64")]
    pub bpm: Option<f64>,
    #[serde(deserialize_with = "de_opt_string")]
    pub key: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub year: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub comment: Option<String>,
    #[serde(deserialize_with = "de_opt_string")]
    pub track_no: Option<String>,
}

fn de_opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(Value::Number(n)) => Ok(Some(n.to_string())),
        Some(other) => Err(serde::de::Error::custom(format!("expected string, got {other}"))),
    }
}

fn de_opt_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) => s
            .trim()
            .parse::<f64>()
            .map(Some)
            .map_err(|_| serde::de::Error::custom(format!("expected number, got {s:?}"))),
        Some(other) => Err(serde::de::Error::custom(format!("expected number, got {other}"))),
    }
}

// ─── Entry points ───────────────────────────────────────────────────────────

/// Process-mode entry: read the job from stdin, write events to stdout,
/// return the exit code.
pub fn run_cli() -> i32 {
    let mut line = String::new();
    let read = io::stdin().lock().read_line(&mut line);
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if let Err(e) = read {
        let _ = emit(&mut out, &json!({ "kind": "error", "message": format!("read job from stdin: {e}") }));
        return 1;
    }
    run_job_line(&line, &mut out)
}

/// Runs one job given its JSON line, writing protocol events to `out`.
/// Split from `run_cli` so tests can drive the full protocol in-process.
pub fn run_job_line(line: &str, out: &mut dyn Write) -> i32 {
    let job: Job = match serde_json::from_str(line.trim()) {
        Ok(j) => j,
        Err(e) => {
            let _ = emit(out, &json!({ "kind": "error", "message": format!("invalid job: {e}") }));
            return 1;
        }
    };
    tracing::info!(input = %job.input.display(), output = %job.output.display(), "convert start");

    // Only ever delete a file this run created — never something that was
    // already at `output` when a pre-flight check refused the job (which
    // could, in the worst case, be the user's source file).
    let mut created_output = false;
    let result = convert(&job, out, &mut created_output).and_then(|done| emit(out, &done));
    match result {
        Ok(()) => {
            tracing::info!(output = %job.output.display(), "convert done");
            0
        }
        Err(e) => {
            if created_output {
                if let Err(rm) = fs::remove_file(&job.output) {
                    tracing::warn!(error = %rm, "could not remove partial output");
                }
            }
            let message = format!("{e:#}");
            tracing::warn!(%message, "convert failed");
            let _ = emit(out, &json!({ "kind": "error", "message": message }));
            1
        }
    }
}

fn emit(out: &mut dyn Write, v: &Value) -> Result<()> {
    serde_json::to_writer(&mut *out, v)?;
    out.write_all(b"\n")?;
    out.flush().context("write to stdout")?;
    Ok(())
}

// ─── Conversion ─────────────────────────────────────────────────────────────

/// Output rate for a source that exceeds `max_rate`: stay in the source's
/// rate family (88.2/176.4 k → 44.1 k, otherwise 48 k) so the ratio is a
/// small integer, but never above the deck's ceiling.
pub fn target_sample_rate(source_rate: u32, max_rate: u32) -> u32 {
    if source_rate <= max_rate {
        return source_rate;
    }
    let family = if source_rate % 44_100 == 0 { 44_100 } else { 48_000 };
    family.min(max_rate)
}

/// CDJs top out at 24-bit; anything ≤16 stays 16 so 16-bit sources are
/// byte-for-byte identical in PCM.
fn output_bit_depth(source_bits: u32) -> u32 {
    if source_bits <= 16 {
        16
    } else {
        24
    }
}

struct Cover {
    mime: String,
    data: Vec<u8>,
}

fn pick_cover(visuals: &[Visual]) -> Option<Cover> {
    let v = visuals
        .iter()
        .find(|v| v.usage == Some(StandardVisualKey::FrontCover))
        .or_else(|| visuals.first())?;
    if v.data.is_empty() {
        return None;
    }
    let mime = if v.media_type.trim().is_empty() {
        if v.data.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" }.to_string()
    } else {
        v.media_type.clone()
    };
    Some(Cover { mime, data: v.data.to_vec() })
}

fn convert(job: &Job, out: &mut dyn Write, created_output: &mut bool) -> Result<Value> {
    let max_rate = job.max_sample_rate.unwrap_or(DEFAULT_MAX_SAMPLE_RATE);
    if max_rate < 8_000 {
        bail!("maxSampleRate {max_rate} is too low");
    }
    if let (Ok(a), Ok(b)) = (fs::canonicalize(&job.input), fs::canonicalize(&job.output)) {
        if a == b {
            bail!("output path is the input file");
        }
    }

    // ── Open + probe ───────────────────────────────────────────────────────
    let file = File::open(&job.input).with_context(|| format!("open {}", job.input.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = job.input.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }
    let mut probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .context("unsupported or unreadable audio file")?;

    // FLAC PICTURE blocks surface as format-level metadata; ID3-in-front
    // containers surface them on the probe. Check both.
    let mut cover = None;
    if job.cover.unwrap_or(true) {
        if let Some(rev) = probed.format.metadata().current() {
            cover = pick_cover(rev.visuals());
        }
        if cover.is_none() {
            if let Some(md) = probed.metadata.get() {
                if let Some(rev) = md.current() {
                    cover = pick_cover(rev.visuals());
                }
            }
        }
    }
    let mut format = probed.format;

    let track = format.default_track().ok_or_else(|| anyhow!("no audio track in file"))?;
    let track_id = track.id;
    let params = track.codec_params.clone();
    let is_flac = params.codec == CODEC_TYPE_FLAC;
    let source_rate = params.sample_rate.ok_or_else(|| anyhow!("source sample rate unknown"))?;
    let channels = params.channels.map(|c| c.count()).ok_or_else(|| anyhow!("source channel count unknown"))?;
    if !(1..=2).contains(&channels) {
        bail!("unsupported channel count {channels}");
    }
    let source_bits = params.bits_per_sample.unwrap_or_else(|| match params.sample_format {
        Some(SampleFormat::U8 | SampleFormat::S8) => 8,
        Some(SampleFormat::U16 | SampleFormat::S16) => 16,
        Some(SampleFormat::U24 | SampleFormat::S24) => 24,
        Some(SampleFormat::U32 | SampleFormat::S32 | SampleFormat::F32) => 32,
        Some(SampleFormat::F64) => 64,
        None => 16,
    });
    let total_frames = params.n_frames;

    // verify=true makes the FLAC decoder MD5 the decoded PCM against the
    // STREAMINFO checksum — a free end-to-end proof the source decoded
    // exactly as encoded.
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions { verify: true })
        .context("no decoder for this codec")?;

    let out_bits = output_bit_depth(source_bits);
    let out_rate = target_sample_rate(source_rate, max_rate);
    let resampled = out_rate != source_rate;
    let wav_format = WavFormat {
        channels: channels as u16,
        sample_rate: out_rate,
        bits_per_sample: out_bits as u16,
    };

    // ── Metadata trailer (built first so the size check can include it) ───
    let tags = job.tags.as_ref();
    let mut trailer = match tags {
        Some(t) => info_chunk(t),
        None => Vec::new(),
    };
    let id3_bytes = build_id3(tags, cover.as_ref())?;
    if !id3_bytes.is_empty() {
        trailer.extend_from_slice(&wav_writer::chunk(b"id3 ", &id3_bytes));
    }

    if let Some(n) = total_frames {
        let out_frames = expected_output_frames(n, source_rate, out_rate);
        let data_bytes = out_frames * wav_format.block_align() as u64;
        if !wav_writer::fits_riff(data_bytes, trailer.len() as u64) {
            bail!("output would exceed the 4 GiB WAV size limit");
        }
    }

    // ── Write ───────────────────────────────────────────────────────────────
    *created_output = true;
    let mut writer = WavWriter::create(&job.output, wav_format, trailer.len() as u64)?;

    emit(
        out,
        &json!({
            "kind": "started",
            "sourceSampleRate": source_rate,
            "sourceBitDepth": source_bits,
            "channels": channels,
            "sampleRate": out_rate,
            "bitDepth": out_bits,
            "totalFrames": total_frames,
        }),
    )?;

    let mut resampler = if resampled {
        Some(StreamResampler::new(source_rate, out_rate, channels)?)
    } else {
        None
    };
    let progress_step = match total_frames {
        Some(n) => (n / PROGRESS_STEPS).max(1),
        // Unknown length: report every ~10 s of audio.
        None => source_rate as u64 * 10,
    };
    let mut next_progress = progress_step;
    let mut frames_in: u64 = 0;
    let mut lj: Vec<i32> = Vec::new();
    let mut quantised: Vec<i32> = Vec::new();
    let mut floats: Vec<f64> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(e) => return Err(anyhow!(e)).context(format!("read packet after frame {frames_in}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        // Playback skips a bad packet; a lossless converter must not —
        // silently dropping audio would shift everything after it.
        let decoded = decoder
            .decode(&packet)
            .map_err(|e| anyhow!("decode error after frame {frames_in}: {e}"))?;
        let frames = to_left_justified(&decoded, channels, &mut lj)?;
        if frames == 0 {
            continue;
        }
        frames_in += frames as u64;

        match resampler.as_mut() {
            None => {
                quantised.clear();
                quantised.extend(lj.iter().map(|&x| quantise_lj(x, out_bits)));
                writer.write_samples(&quantised)?;
            }
            Some(rs) => {
                floats.clear();
                floats.extend(lj.iter().map(|&x| x as f64 / LJ_SCALE));
                rs.push(&floats, &mut |chunk| {
                    quantised.clear();
                    quantised.extend(chunk.iter().map(|&y| quantise_f64(y, out_bits)));
                    writer.write_samples(&quantised)
                })?;
            }
        }

        if frames_in >= next_progress {
            emit(out, &json!({ "kind": "progress", "frames": frames_in, "totalFrames": total_frames }))?;
            while next_progress <= frames_in {
                next_progress += progress_step;
            }
        }
    }

    if is_flac {
        if let Some(n) = total_frames {
            if frames_in != n {
                bail!("decoded {frames_in} frames but the FLAC header declares {n} (truncated or corrupt file?)");
            }
        }
    }
    if decoder.finalize().verify_ok == Some(false) {
        bail!("FLAC checksum mismatch: decoded audio differs from what was encoded (corrupt source file?)");
    }
    if frames_in == 0 {
        bail!("source contains no audio");
    }

    if let Some(rs) = resampler.as_mut() {
        rs.finish(&mut |chunk| {
            quantised.clear();
            quantised.extend(chunk.iter().map(|&y| quantise_f64(y, out_bits)));
            writer.write_samples(&quantised)
        })?;
    }

    let frames_out = writer.frames_written();
    let bytes = writer.finish(&trailer)?;
    verify_output(&job.output, wav_format, frames_out, bytes)?;

    Ok(json!({
        "kind": "done",
        "sampleRate": out_rate,
        "bitDepth": out_bits,
        "channels": channels,
        "frames": frames_out,
        "bytes": bytes,
        "resampled": resampled,
        "sourceSampleRate": source_rate,
        "sourceBitDepth": source_bits,
    }))
}

fn expected_output_frames(input_frames: u64, source_rate: u32, out_rate: u32) -> u64 {
    if source_rate == out_rate {
        return input_frames;
    }
    let (n, s, o) = (input_frames as u128, source_rate as u128, out_rate as u128);
    ((n * o + s / 2) / s) as u64
}

fn verify_output(path: &Path, fmt: WavFormat, frames: u64, bytes: u64) -> Result<()> {
    let h = wav_writer::read_header(path).context("verify output")?;
    let ok = h.format_tag == 1
        && h.channels == fmt.channels
        && h.sample_rate == fmt.sample_rate
        && h.bits_per_sample == fmt.bits_per_sample
        && h.block_align == fmt.block_align()
        && h.data_size as u64 == frames * fmt.block_align() as u64
        && h.file_size == bytes
        && h.chunk_ids.first() == Some(b"fmt ")
        && h.chunk_ids.get(1) == Some(b"data");
    if !ok {
        bail!("verify output: header does not match what was written ({h:?})");
    }
    Ok(())
}

// ─── Sample conversion ──────────────────────────────────────────────────────
//
// Every decoded sample is first widened to a *left-justified* i32 (full
// 32-bit scale, low bits zero for narrower sources). That's the shape
// symphonia's FLAC decoder already emits (it returns S32 buffers shifted
// left by 32 − bits_per_sample; verified by
// `symphonia_flac_s32_is_left_justified`), and it lets one quantiser serve
// every source format: for sources no wider than the output, the discarded
// low bits are zero, so round-and-shift is exactly the identity.

const LJ_SCALE: f64 = 2_147_483_648.0; // 2^31

fn to_left_justified(buf: &AudioBufferRef, channels: usize, out: &mut Vec<i32>) -> Result<usize> {
    let got = buf.spec().channels.count();
    if got != channels {
        bail!("decoder produced {got} channels, expected {channels}");
    }
    out.clear();
    let frames = match buf {
        AudioBufferRef::S32(b) => interleave(b, out, |s| s),
        AudioBufferRef::S24(b) => interleave(b, out, |s| s.inner() << 8),
        AudioBufferRef::S16(b) => interleave(b, out, |s| (s as i32) << 16),
        AudioBufferRef::S8(b) => interleave(b, out, |s| (s as i32) << 24),
        // Unsigned PCM is offset-binary: flip the sign bit.
        AudioBufferRef::U32(b) => interleave(b, out, |s| (s ^ 0x8000_0000) as i32),
        AudioBufferRef::U24(b) => interleave(b, out, |s| (s.inner() as i32 - 0x80_0000) << 8),
        AudioBufferRef::U16(b) => interleave(b, out, |s| (s as i32 - 0x8000) << 16),
        AudioBufferRef::U8(b) => interleave(b, out, |s| (s as i32 - 0x80) << 24),
        AudioBufferRef::F32(b) => interleave(b, out, |s| float_to_lj(s as f64)),
        AudioBufferRef::F64(b) => interleave(b, out, float_to_lj),
    };
    Ok(frames)
}

fn interleave<S: Sample>(b: &AudioBuffer<S>, out: &mut Vec<i32>, f: impl Fn(S) -> i32) -> usize {
    let frames = b.frames();
    let ch = b.spec().channels.count();
    out.reserve(frames * ch);
    if ch == 1 {
        out.extend(b.chan(0)[..frames].iter().map(|&s| f(s)));
    } else {
        let (l, r) = (&b.chan(0)[..frames], &b.chan(1)[..frames]);
        for i in 0..frames {
            out.push(f(l[i]));
            out.push(f(r[i]));
        }
    }
    frames
}

fn float_to_lj(v: f64) -> i32 {
    (v * LJ_SCALE).round().clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

/// Left-justified i32 → signed `bits`-wide integer, round-half-up with
/// clamping (only reachable for >`bits` sources rounding up at +full scale).
fn quantise_lj(x: i32, bits: u32) -> i32 {
    let shift = 32 - bits;
    let v = ((x as i64) + (1i64 << (shift - 1))) >> shift;
    let max = (1i64 << (bits - 1)) - 1;
    v.clamp(-max - 1, max) as i32
}

/// Normalised float (±1.0 = full scale) → signed `bits`-wide integer.
/// Resampled output can overshoot full scale (Gibbs ringing on clipped
/// masters), so clamping is load-bearing here.
fn quantise_f64(y: f64, bits: u32) -> i32 {
    let scale = (1i64 << (bits - 1)) as f64;
    (y * scale).round().clamp(-scale, scale - 1.0) as i32
}

// ─── Resampling ─────────────────────────────────────────────────────────────

/// Streaming wrapper over rubato's synchronous FFT resampler that delivers
/// output time-aligned with the input: the resampler's `output_delay()`
/// frames of start-up latency are trimmed from the front, and `finish`
/// pumps silence until exactly round(input × out/in) frames have been
/// emitted (so the tail isn't lost inside the filter either). This mirrors
/// rubato's own `process_all_into_buffer`, but streams — a 10-minute
/// 96 kHz track would be ~1 GB as in-memory f64.
///
/// FFT rather than the async sinc resampler: the ratio is fixed, and
/// rubato documents `Fft` as the recommended choice for fixed-ratio file
/// conversion — same quality class as `Async::new_sinc`, much faster.
struct StreamResampler {
    inner: Fft<f64>,
    channels: usize,
    source_rate: u32,
    out_rate: u32,
    input: Vec<f64>,
    output: Vec<f64>,
    to_trim: usize,
    input_frames: u64,
    emitted: u64,
}

type Sink<'a> = dyn FnMut(&[f64]) -> Result<()> + 'a;

impl StreamResampler {
    fn new(source_rate: u32, out_rate: u32, channels: usize) -> Result<Self> {
        let inner = Fft::<f64>::new_custom(
            source_rate as usize,
            out_rate as usize,
            RESAMPLE_CHUNK,
            1,
            channels,
            WindowFunction::BlackmanHarris2,
            FixedSync::Input,
        )
        .map_err(|e| anyhow!("create resampler {source_rate}→{out_rate}: {e}"))?;
        let to_trim = inner.output_delay();
        Ok(Self {
            inner,
            channels,
            source_rate,
            out_rate,
            input: Vec::new(),
            output: Vec::new(),
            to_trim,
            input_frames: 0,
            emitted: 0,
        })
    }

    fn push(&mut self, samples: &[f64], sink: &mut Sink) -> Result<()> {
        let ch = self.channels;
        self.input_frames += (samples.len() / ch) as u64;
        let mut off = 0;
        while off < samples.len() {
            let need = self.inner.input_frames_next() * ch;
            let take = (need - self.input.len()).min(samples.len() - off);
            self.input.extend_from_slice(&samples[off..off + take]);
            off += take;
            if self.input.len() == need {
                self.process(None, u64::MAX, sink)?;
            }
        }
        Ok(())
    }

    /// Runs one resampler call over `self.input` (zero-padded to a full
    /// chunk; `partial` tells rubato how many frames are real) and sends
    /// the post-trim output, capped at `cap` total frames, to `sink`.
    fn process(&mut self, partial: Option<usize>, cap: u64, sink: &mut Sink) -> Result<()> {
        let ch = self.channels;
        let need = self.inner.input_frames_next();
        self.input.resize(need * ch, 0.0);
        let out_max = self.inner.output_frames_max();
        self.output.resize(out_max * ch, 0.0);
        let produced = {
            let inp = InterleavedSlice::new(&self.input[..], ch, need).map_err(|e| anyhow!("{e:?}"))?;
            let mut outp =
                InterleavedSlice::new_mut(&mut self.output[..], ch, out_max).map_err(|e| anyhow!("{e:?}"))?;
            let indexing = partial.map(|n| Indexing::new().partial_len(n));
            let (_, produced) = self
                .inner
                .process_into_buffer(&inp, &mut outp, indexing.as_ref())
                .map_err(|e| anyhow!("resample: {e}"))?;
            produced
        };
        self.input.clear();

        let start = self.to_trim.min(produced);
        self.to_trim -= start;
        let room = cap.saturating_sub(self.emitted);
        let end = start + ((produced - start) as u64).min(room) as usize;
        if end > start {
            sink(&self.output[start * ch..end * ch])?;
            self.emitted += (end - start) as u64;
        }
        Ok(())
    }

    fn finish(&mut self, sink: &mut Sink) -> Result<u64> {
        let expected = expected_output_frames(self.input_frames, self.source_rate, self.out_rate);
        if !self.input.is_empty() {
            let real = self.input.len() / self.channels;
            self.process(Some(real), expected, sink)?;
        }
        // Each zero-pumping call yields at least one FFT block once the
        // pipeline is primed; the bound only guards against a logic error
        // turning into a hang.
        let mut guard = 0;
        while self.emitted < expected {
            self.process(Some(0), expected, sink)?;
            guard += 1;
            if guard > 1000 {
                bail!("resampler failed to flush ({} of {} frames)", self.emitted, expected);
            }
        }
        Ok(self.emitted)
    }
}

// ─── Tags ───────────────────────────────────────────────────────────────────

fn clean(v: &Option<String>) -> Option<String> {
    let s: String = v.as_deref()?.chars().filter(|c| *c != '\0').collect();
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_string())
}

fn info_chunk(t: &Tags) -> Vec<u8> {
    let s = |v: &Option<String>| clean(v).unwrap_or_default();
    wav_writer::info_list(&[
        (b"INAM", &s(&t.title)),
        (b"IART", &s(&t.artist)),
        (b"IPRD", &s(&t.album)),
        (b"IGNR", &s(&t.genre)),
        (b"ICMT", &s(&t.comment)),
        (b"ICRD", &s(&t.year)),
        (b"ITRK", &s(&t.track_no)),
    ])
}

/// ID3v2.3 tag bytes for the `id3 ` chunk, or empty when there's nothing to
/// write. v2.3 (not 2.4) because that's what rekordbox and CDJ firmware
/// parse reliably. Deliberately never writes TSRC: Curator's scanner binds
/// files to tracks by ISRC, and an ISRC here would re-bind the WAV onto the
/// FLAC's library row.
fn build_id3(tags: Option<&Tags>, cover: Option<&Cover>) -> Result<Vec<u8>> {
    use id3::frame::{Comment, Picture, PictureType};
    use id3::{Frame, Tag, TagLike, Version};

    let mut tag = Tag::new();
    let mut text = |id: &str, v: &Option<String>| {
        if let Some(s) = clean(v) {
            tag.add_frame(Frame::text(id, s));
        }
    };
    if let Some(t) = tags {
        text("TIT2", &t.title);
        text("TPE1", &t.artist);
        text("TALB", &t.album);
        text("TCON", &t.genre);
        text("TPUB", &t.label);
        text("TKEY", &t.key);
        text("TRCK", &t.track_no);
        if let Some(bpm) = t.bpm.filter(|b| b.is_finite() && *b > 0.0) {
            text("TBPM", &Some(format!("{}", bpm.round() as i64)));
        }
        // TYER is strictly four digits in v2.3; a full date goes nowhere
        // rather than producing a frame strict parsers reject.
        if let Some(y) = clean(&t.year) {
            let y4: String = y.chars().take(4).collect();
            if y4.len() == 4 && y4.chars().all(|c| c.is_ascii_digit()) {
                text("TYER", &Some(y4));
            }
        }
        if let Some(c) = clean(&t.comment) {
            tag.add_frame(Comment { lang: "eng".into(), description: String::new(), text: c });
        }
    }
    if let Some(c) = cover {
        tag.add_frame(Picture {
            mime_type: c.mime.clone(),
            picture_type: PictureType::CoverFront,
            description: String::new(),
            data: c.data.clone(),
        });
    }
    if tag.frames().next().is_none() {
        return Ok(Vec::new());
    }
    let mut bytes = Vec::new();
    tag.write_to(&mut bytes, Version::Id3v23).context("encode ID3 tag")?;
    Ok(bytes)
}

#[cfg(test)]
#[path = "convert_tests.rs"]
mod tests;
