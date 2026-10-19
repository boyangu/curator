//! Symphonia wrapper, split into two pieces:
//!
//!   1. `probe(path)` — open the file, identify the format, instantiate
//!      the decoder, read container metadata (sample rate, frame count,
//!      channel count). Fast: ~5-10ms on local SSD for FLAC. Caller
//!      gets the resources needed to drive decoding and immediately
//!      reports duration to the renderer.
//!
//!   2. `decode_packet_into_cells` — decode one packet into the shared
//!      progressive buffer slot. Called repeatedly from the engine's
//!      decoder thread. Writes stereo-interleaved f32 directly into
//!      `UnsafeCell<f32>` slots; coordination with the audio thread is
//!      via the engine's `decoded_frames` atomic (Release on write,
//!      Acquire on read).
//!
//! Symphonia decode rate for FLAC on x86_64 is ~50-150× realtime in
//! release builds. Combined with progressive playback this means
//! first-audio at ~10-30ms of decode (first packet of ~4096 frames /
//! ~100ms of audio), full buffer ready by ~1/50 of the track duration.

use anyhow::{anyhow, Context, Result};
use std::cell::UnsafeCell;
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{Decoder, DecoderOptions};
use symphonia::core::formats::{FormatOptions, FormatReader, Packet};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub struct ProbeResult {
    /// Container reader — yields `Packet`s when iterated.
    pub format: Box<dyn FormatReader>,
    /// Codec decoder for the default track.
    pub decoder: Box<dyn Decoder>,
    /// Default track id — packets from other tracks (e.g. cover art)
    /// must be skipped by the decoder loop.
    pub track_id: u32,
    /// Sample rate of the decoded audio, in Hz.
    pub sample_rate: u32,
    /// Total frame count of the track, from container metadata. May be
    /// slightly off the actual decoded count for some formats; the engine
    /// allocates a safety margin to absorb the difference.
    pub n_frames: u64,
    /// Source channel count. The engine always emits stereo to its
    /// progressive buffer — this field drives the mono/surround downmix
    /// in `decode_packet_into_cells`.
    pub channel_count: usize,
}

pub fn probe(path: &Path) -> Result<ProbeResult> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .context("probe format")?;
    let format = probed.format;

    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("no default track in container"))?;
    let codec_params = track.codec_params.clone();
    let track_id = track.id;

    let decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .context("instantiate decoder")?;

    let sample_rate = codec_params
        .sample_rate
        .ok_or_else(|| anyhow!("codec params missing sample rate"))?;
    let channel_count = codec_params
        .channels
        .map(|c| c.count())
        .unwrap_or(2)
        .max(1);
    let n_frames = codec_params
        .n_frames
        .ok_or_else(|| anyhow!("codec params missing n_frames — progressive playback requires duration metadata from the container"))?;

    Ok(ProbeResult {
        format,
        decoder,
        track_id,
        sample_rate,
        n_frames,
        channel_count,
    })
}

/// Decode one packet and write its samples into `out` (a shared
/// UnsafeCell-wrapped stereo-interleaved buffer) starting at frame
/// `write_frame_offset`. Returns the number of frames written.
///
/// Safety / synchronisation: the caller (engine's decoder thread) is the
/// only writer to `out[write_frame_offset..]` and only advances the
/// `decoded_frames` atomic AFTER this call returns. The audio callback
/// reads `out[..decoded_frames]` only when it has Acquired the atomic.
/// So the ranges never overlap concurrently.
pub fn decode_packet_into_cells(
    decoder: &mut dyn Decoder,
    packet: &Packet,
    channels: usize,
    out: &[UnsafeCell<f32>],
    write_frame_offset: usize,
) -> Result<usize> {
    let decoded = match decoder.decode(packet) {
        Ok(d) => d,
        // Per Symphonia docs, DecodeError on a single packet is recoverable —
        // skip it but keep iterating. CorruptionError would also be recoverable
        // but we don't separate the two here.
        Err(symphonia::core::errors::Error::DecodeError(_)) => return Ok(0),
        Err(e) => return Err(e).context("decode packet"),
    };
    let frames = match &decoded {
        AudioBufferRef::F32(b) => b.frames(),
        AudioBufferRef::F64(b) => b.frames(),
        AudioBufferRef::S16(b) => b.frames(),
        AudioBufferRef::S32(b) => b.frames(),
        AudioBufferRef::U8(b) => b.frames(),
        AudioBufferRef::U16(b) => b.frames(),
        AudioBufferRef::U24(b) => b.frames(),
        AudioBufferRef::S24(b) => b.frames(),
        AudioBufferRef::S8(b) => b.frames(),
        AudioBufferRef::U32(b) => b.frames(),
    };
    if frames == 0 {
        return Ok(0);
    }
    // Bounds check — caller passes a buffer with capacity for n_frames
    // + a safety margin; if we'd overrun, truncate silently.
    let max_frames = (out.len() / 2).saturating_sub(write_frame_offset);
    let to_write = frames.min(max_frames);
    if to_write == 0 {
        return Ok(0);
    }
    write_stereo_into_cells(decoded, channels, out, write_frame_offset, to_write);
    Ok(to_write)
}

fn write_stereo_into_cells(
    buf: AudioBufferRef<'_>,
    channels: usize,
    out: &[UnsafeCell<f32>],
    write_frame_offset: usize,
    to_write: usize,
) {
    // Macro generic across symphonia's per-sample-format AudioBufferRef
    // variants. For each output frame, compute (l, r) — either passing
    // mono through twice, or pulling stereo, or downmixing surround —
    // then write into the UnsafeCell slots at the correct interleaved
    // offset.
    macro_rules! emit {
        ($buf:expr, $convert:expr) => {{
            for f in 0..to_write {
                let (l, r) = match channels {
                    1 => {
                        let v = $convert($buf.chan(0)[f]);
                        (v, v)
                    }
                    2 => (
                        $convert($buf.chan(0)[f]),
                        $convert($buf.chan(1)[f]),
                    ),
                    n => {
                        let mut l = 0.0f32;
                        let mut r = 0.0f32;
                        let mut nl = 0u32;
                        let mut nr = 0u32;
                        for c in 0..n {
                            let v = $convert($buf.chan(c)[f]);
                            if c % 2 == 0 { l += v; nl += 1; }
                            else          { r += v; nr += 1; }
                        }
                        (
                            if nl > 0 { l / nl as f32 } else { 0.0 },
                            if nr > 0 { r / nr as f32 } else { 0.0 },
                        )
                    }
                };
                let idx = (write_frame_offset + f) * 2;
                // SAFETY: caller guarantees this range is not concurrently
                // read by the audio callback (decoded_frames atomic hasn't
                // been advanced past write_frame_offset yet).
                unsafe {
                    *out[idx].get() = l;
                    *out[idx + 1].get() = r;
                }
            }
        }};
    }

    match buf {
        AudioBufferRef::F32(b) => emit!(b, |s: f32| s),
        AudioBufferRef::F64(b) => emit!(b, |s: f64| s as f32),
        AudioBufferRef::S16(b) => emit!(b, |s: i16| s as f32 / i16::MAX as f32),
        AudioBufferRef::S32(b) => emit!(b, |s: i32| s as f32 / i32::MAX as f32),
        AudioBufferRef::U8(b) => emit!(b, |s: u8| (s as f32 - 128.0) / 128.0),
        AudioBufferRef::U16(b) => emit!(b, |s: u16| (s as f32 - 32768.0) / 32768.0),
        AudioBufferRef::U24(b) => emit!(b, |s: symphonia::core::sample::u24| {
            let inner: u32 = s.inner();
            (inner as f32 - 8_388_608.0) / 8_388_608.0
        }),
        AudioBufferRef::S24(b) => emit!(b, |s: symphonia::core::sample::i24| {
            let inner: i32 = s.inner();
            inner as f32 / 8_388_608.0
        }),
        AudioBufferRef::S8(b) => emit!(b, |s: i8| s as f32 / i8::MAX as f32),
        AudioBufferRef::U32(b) => emit!(b, |s: u32| (s as f32 - 2_147_483_648.0) / 2_147_483_648.0),
    }
}
