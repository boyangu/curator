//! Progressive audio engine. Owns the cpal output stream + an atomically-
//! swappable progressive buffer + a decoder worker thread per loaded track.
//!
//! Phase 1.5 — progressive playback:
//!
//!   - `load()` probes the file (~5-10ms), pre-allocates the full output
//!     buffer, swaps it into shared state, and spawns a decoder worker
//!     thread. It RETURNS IMMEDIATELY without waiting for decode. So
//!     `load()` resolves in ~10-30ms regardless of track length.
//!
//!   - The decoder thread fills the buffer chunk-by-chunk, releasing each
//!     chunk via the `decoded_frames` atomic. Decoder runs ~50-100×
//!     realtime in release builds.
//!
//!   - The audio callback gates on `cursor < decoded_frames`. While the
//!     decoder is ahead of playback (the common case), audio plays
//!     normally. If the cursor ever catches up (rare — seek far ahead,
//!     or unusually slow disk), the callback emits silence until the
//!     decoder catches up. The cursor does NOT advance during silence
//!     waits, so position reporting stays honest.
//!
//! Concurrency:
//!
//!   - `current_buffer` is an `ArcSwap<ProgressiveBuffer>`. The control
//!     thread `store`s a fresh buffer on load(); both audio and decoder
//!     threads read the current snapshot.
//!
//!   - Inside ProgressiveBuffer, `samples` is `Box<[UnsafeCell<f32>]>`
//!     — fixed-size, individually-mutable slots. The decoder writes
//!     positions `[old_decoded..new_decoded)`; the audio callback reads
//!     positions `[..decoded_frames]`. The two ranges never overlap
//!     because decoded_frames is the synchronisation point (Release on
//!     write, Acquire on read).
//!
//!   - The OLD ProgressiveBuffer keeps its own `cancelled` AtomicBool.
//!     When a new load() supersedes it, we set the old buffer's
//!     cancelled flag; the old decoder thread sees it on its next
//!     packet iteration and exits, dropping its Arc. Memory is freed
//!     when both audio and decoder threads release their Arcs.

use anyhow::{anyhow, Context, Result};
use arc_swap::ArcSwap;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SampleRate, StreamConfig};
use parking_lot::Mutex;
use std::cell::UnsafeCell;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::beatjump::{beat_walk, beat_walk_unclamped, sanitize_grid};
use crate::decode::{decode_packet_into_cells, probe};
use crate::protocol::Event;

/// Safety margin (in frames) beyond `n_frames` so a slight decoder/
/// container mismatch (some MP3s decode a few extra/fewer frames than
/// metadata claims) can't overflow the buffer.
const FRAME_SAFETY_MARGIN: u64 = 8_192;

/// Master envelope ramp duration in milliseconds. Applied per-frame at
/// play→pause and pause→play transitions to eliminate the DC tick that
/// otherwise occurs at the audio→silence boundary. 5 ms is long enough
/// to be inaudible-as-a-fade and short enough that pause/play still
/// feels instant.
const ENVELOPE_RAMP_MS: f32 = 5.0;

/// Post-jump linear ramp duration in milliseconds. When a cursor jump
/// (cue trigger fire) lands outside the crossfade window — because the
/// cpal callback was large enough to skip past it — the callback
/// linearly blends `last_output` with the new sample over this many
/// frames. 3 ms is enough to make the seam inaudible while staying
/// short enough that the cue still feels sample-accurate.
const POST_JUMP_RAMP_MS: f32 = 3.0;

/// Linear crossfade window across the loop seam, in milliseconds. Mixxx
/// uses a variable window equal to the distance from the callback start
/// to the loop trigger — typically 5–25 ms with stock audio buffers. We
/// pick a fixed 10 ms because:
///   - Below ~5 ms the seam is still audible on FLAC; lossy formats
///     (MP3/AAC) sound clean at 3 ms because their psychoacoustic
///     encoding has already smoothed the highest-frequency transients
///     that show up as a click.
///   - Above ~20 ms the "flanging" from blending the loop tail with
///     the lead-in audio starts to be audible on tracks with strong
///     stereo imaging.
/// Time-domain (not sample-domain) so the perceptual length stays
/// constant across 44.1 kHz / 48 kHz / 96 kHz source tracks.
const LOOP_CROSSFADE_MS: f64 = 10.0;

/// Per-track progressive buffer. Owns a pre-allocated stereo-interleaved
/// f32 slice with concurrent-access slots. Two threads use it:
///
///   - Decoder thread writes positions `[decoded_frames * 2 .. new * 2)`,
///     then `Release`-stores the new value into `decoded_frames`.
///
///   - Audio callback `Acquire`-loads `decoded_frames`, then reads
///     positions `[..decoded_frames * 2)`. Acquire/Release establishes
///     happens-before from the decoder's writes to the reader's reads.
struct ProgressiveBuffer {
    /// Stereo-interleaved samples. Length = (total_frames + safety) * 2.
    /// Pre-filled with zeros so an audio callback that races ahead of
    /// the decoder reads silence rather than uninitialised memory.
    samples: Box<[UnsafeCell<f32>]>,
    /// High-water mark: number of FULLY DECODED frames available for
    /// the audio thread to read. Strictly monotonically increasing per
    /// buffer instance.
    decoded_frames: AtomicU64,
    /// Total frame count from container metadata. Audio callback uses
    /// this to detect end-of-track (cursor >= total_frames → emit
    /// silence + reporter fires Ended). May differ slightly from the
    /// final value of `decoded_frames`; we use whichever is larger as
    /// the end marker.
    total_frames: u64,
    /// Set to true when this buffer is superseded by a new load().
    /// The decoder thread polls this between packets and exits cleanly.
    cancelled: AtomicBool,
}

// SAFETY: the only mutable access to `samples` slots is through unsafe
// raw-pointer-via-UnsafeCell::get, coordinated by the decoded_frames
// atomic. The decoder thread is the sole writer; the audio callback is
// the sole reader. They never touch overlapping ranges concurrently.
unsafe impl Send for ProgressiveBuffer {}
unsafe impl Sync for ProgressiveBuffer {}

impl ProgressiveBuffer {
    fn empty() -> Self {
        Self {
            samples: Box::new([]),
            decoded_frames: AtomicU64::new(0),
            total_frames: 0,
            cancelled: AtomicBool::new(true), // "done" by virtue of being empty
        }
    }

    fn new(total_frames: u64) -> Self {
        let n = ((total_frames + FRAME_SAFETY_MARGIN) * 2) as usize;
        let samples: Box<[UnsafeCell<f32>]> = (0..n).map(|_| UnsafeCell::new(0.0)).collect();
        Self {
            samples,
            decoded_frames: AtomicU64::new(0),
            total_frames,
            cancelled: AtomicBool::new(false),
        }
    }
}

/// Sample-accurate loop region in source frames. None = no active loop.
/// Swapped atomically via ArcSwap so the audio callback's per-frame check
/// is wait-free.
#[derive(Clone, Copy, Debug)]
struct LoopFrames {
    in_frames: u64,
    out_frames: u64,
}

/// Sample-accurate pending cue trigger in source frames. The audio
/// callback snapshots this per-callback (ArcSwap, wait-free) and on
/// the per-frame check fires a jump from `trigger_at_frames` to
/// `seek_to_frames` the instant `source_pos` would step past the
/// trigger. Same half-open semantics as LoopFrames: the source frame
/// at `trigger_at_frames` is the FIRST frame of the cue, not the last
/// frame of the current beat. Disarms itself in the callback (atomic
/// store of None) after firing — the reporter thread observes the
/// `trigger_just_fired` flag and emits TriggerFired so the renderer
/// can clear its UI flash state.
#[derive(Clone, Copy, Debug)]
struct PendingTrigger {
    trigger_at_frames: u64,
    seek_to_frames: u64,
    /// Some for beat-jump triggers: the accumulated grid-beat delta this
    /// trigger represents. A second jump arming before this one fires
    /// composes its delta with this value (2 quick presses = 2N beats)
    /// instead of dropping a press. None for cue/xfade-seek triggers —
    /// a jump arriving over one of those replaces it (manual transport
    /// gesture, same invalidation semantics as `seek()`).
    jump_delta_beats: Option<f64>,
    /// Some when the fire must also translate the active loop region
    /// (beat jump with the playhead inside a native loop). Applied in
    /// the SAME consume step as the cursor jump so the per-frame wrap
    /// check can never observe moved-loop + unmoved-cursor or vice
    /// versa — a two-RPC sequence (set_loop then seek) would leave a
    /// window where the wrap yanks the cursor back.
    move_loop_to: Option<LoopFrames>,
}

/// Fraction of the cursor→target gap that closes per callback. At α=0.5
/// each callback covers half the remaining distance — settles in ~10
/// callbacks (~100 ms at 10 ms callback intervals). Position-based slew
/// instead of velocity-LP: velocity is derived from the gap each
/// callback, so when the renderer stops pushing targets the cursor
/// reaches the final target geometrically with no residual velocity.
/// Avoids the "wave keeps scratching after the mouse stops" inertia
/// that a velocity-based LP produces (initial implementation).
const SCRUB_SLEW_ALPHA: f32 = 0.5;

/// Silence-gate threshold: when |effective scrub rate| is below this
/// fraction of normal play rate, fade output toward 0. Linear ramp,
/// not hysteresis — see PRD/tech-doc option 3.
const SCRUB_SILENCE_THRESHOLD: f32 = 0.05;

/// Send+Sync handle to a subset of engine state. Exposed via
/// `Engine::state_handle()` so the controller layer (running on its own
/// thread) can read playing/loop status lock-free.
pub struct EngineStateHandle {
    state: Arc<TransportState>,
}

impl EngineStateHandle {
    pub fn playing(&self) -> bool {
        self.state.playing.load(Ordering::Acquire)
    }
    pub fn loop_active(&self) -> bool {
        self.state.loop_region.load().is_some()
    }
}

/// Shared transport state read by the audio thread on every callback and
/// written by the control thread on transport commands.
struct TransportState {
    cursor: AtomicU64,
    volume_bits: AtomicU32,
    /// Source sample rate — the rate the track was decoded at and the rate
    /// `cursor` is measured in. Position reporting, seek, and beat-aligned
    /// math all live in this unit.
    sample_rate: AtomicU32,
    /// Output sample rate the cpal stream is actually running at. Usually
    /// the device's preferred rate (48 kHz on most Windows boxes via WASAPI
    /// shared mode). Differs from `sample_rate` when the device can't host
    /// the track's native rate — the callback resamples on the fly. Set
    /// once at first stream build and held constant for the engine's life.
    stream_sample_rate: AtomicU32,
    playing: AtomicBool,
    /// Set by the audio callback (or by the reporter's own check) when
    /// the cursor first passes the end of the loaded track. Reset by
    /// `load()` and by backwards `seek()`.
    ended: AtomicBool,
    /// Atomic pointer to the active ProgressiveBuffer. Audio callback +
    /// reporter thread snapshot via `.load()` on each invocation.
    current_buffer: ArcSwap<ProgressiveBuffer>,
    /// Active loop region in source-frame coords. Audio callback snapshots
    /// this per-callback and wraps `source_pos` back to `in_frames` as
    /// soon as it would step past `out_frames` — wrap happens between
    /// frames, no late-by-an-RPC-roundtrip glitch. Cleared on load() and
    /// stop(); preserved across seek() (renderer decides whether a manual
    /// seek should clear the loop).
    loop_region: ArcSwap<Option<LoopFrames>>,
    /// Pending quantized cue trigger in source-frame coords. Mirrors the
    /// loop_region machinery: audio callback snapshots per-callback,
    /// fires the cursor jump (with 10ms linear crossfade) the instant
    /// source_pos crosses trigger_at_frames, and atomically stores None
    /// to disarm. Cleared on load(), stop(), seek() (manual seek
    /// invalidates the planned fire), scrub_begin(), and end-of-track —
    /// triggers are transient gestures, no snapshot/restore semantics
    /// like the scrub loop machinery.
    pending_trigger: ArcSwap<Option<PendingTrigger>>,
    /// Set true by the audio callback when it consumes a pending_trigger
    /// (the cursor has already jumped). The reporter thread `swap(false)`s
    /// on its next 50ms tick and emits Event::TriggerFired with the
    /// current cursor position. Keeps the audio callback allocation-free
    /// at the event boundary — channel sends are not real-time safe.
    trigger_just_fired: AtomicBool,
    /// Vinyl-style scrub state. `scrub_mode` flips the audio callback
    /// into the variable-rate branch — instead of advancing the cursor
    /// at `ratio` per output frame, it slews `source_pos` toward
    /// `scrub_target_frames` at a smoothed velocity, with the silence
    /// gate applied near zero rate. The renderer drives by pushing
    /// `scrub_to` (target position) and ends with `scrub_end` (final
    /// position + resume flag).
    scrub_mode: AtomicBool,
    scrub_target_frames: AtomicU64,
    /// Loop region snapshot taken at `scrub_begin`. Restored at
    /// `scrub_end`. While scrubbing the live `loop_region` is `None`
    /// so the cursor walks freely past loop bounds.
    pre_scrub_loop: ArcSwap<Option<LoopFrames>>,
    /// Smoothed master envelope gain in [0, 1], stored as f32 bits.
    /// Per-frame slew toward the target value (1.0 when playing OR
    /// scrubbing, 0.0 otherwise) over `ENVELOPE_RAMP_MS`. Eliminates
    /// the DC click at play→pause and pause→play transitions —
    /// without this, the audio callback would instantly switch
    /// between the last non-zero sample and 0.0, which the speaker
    /// translates into an audible tick. Initialised to 0.0 so the
    /// very first play() also fades in cleanly.
    envelope_gain_bits: AtomicU32,
    /// Post-jump linear ramp counter in source frames. When non-zero
    /// the callback blends the previous output sample with the new
    /// one across these many frames. Used as a safety net for cursor
    /// jumps where the per-frame crossfade window was overshot
    /// because the cpal buffer happened to span the entire window
    /// (rare on Windows shared mode WASAPI, but possible on
    /// high-latency drivers / under load). The blend is independent
    /// of the trigger crossfade so even an "instant" cursor jump
    /// (no pending_trigger pre-fade) doesn't tick.
    post_jump_ramp_frames: AtomicU32,
    /// Last output L/R samples emitted by the callback, f32 bits.
    /// Read at start of each callback so the post-jump ramp can
    /// blend from yesterday's last sample even across callback
    /// boundaries.
    last_output_l_bits: AtomicU32,
    last_output_r_bits: AtomicU32,
    /// Per-channel max-abs output sample since the reporter's last
    /// read, stored as f32 bits. Audio callback fetch_max's the bits
    /// at the end of each callback (cheap — single CAS, all values
    /// are non-negative so u32 ordering matches f32 ordering).
    /// Reporter thread swap(0)s on each 50ms tick and includes the
    /// observed peak in the next StateChanged event. Cleared on
    /// load() / stop() so a paused-then-loaded track's meter doesn't
    /// briefly flash the previous track's tail level.
    peak_l_bits: AtomicU32,
    peak_r_bits: AtomicU32,
}

pub struct Engine {
    stream: Option<cpal::Stream>,
    stream_sample_rate: u32,
    state: Arc<TransportState>,
    event_tx: Sender<Event>,
    /// Beatgrid for the loaded track — ascending beat times in seconds,
    /// pushed by the renderer (set_beatgrid) whenever the current
    /// track's analysis is available. Control-thread only: jump targets
    /// are resolved here at arm time (the trigger's fire frame is
    /// deterministic, so arm-time math is exact — see jump_beats), so
    /// the audio callback never needs grid access. Empty = no grid =
    /// jump_beats reports not-jumped and the renderer falls back.
    beatgrid: Vec<f64>,
    /// Handle to the active decoder worker thread, if any. On a new
    /// load() we don't wait for it — we set the old buffer's `cancelled`
    /// flag and let the worker exit on its own. Held here so a future
    /// shutdown() could wait if needed.
    decoder_handle: Option<thread::JoinHandle<()>>,
}

impl Engine {
    pub fn new(event_tx: Sender<Event>) -> Self {
        let state = Arc::new(TransportState {
            cursor: AtomicU64::new(0),
            volume_bits: AtomicU32::new(1.0f32.to_bits()),
            sample_rate: AtomicU32::new(0),
            stream_sample_rate: AtomicU32::new(0),
            playing: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            current_buffer: ArcSwap::new(Arc::new(ProgressiveBuffer::empty())),
            loop_region: ArcSwap::new(Arc::new(None)),
            pending_trigger: ArcSwap::new(Arc::new(None)),
            trigger_just_fired: AtomicBool::new(false),
            scrub_mode: AtomicBool::new(false),
            scrub_target_frames: AtomicU64::new(0),
            pre_scrub_loop: ArcSwap::new(Arc::new(None)),
            envelope_gain_bits: AtomicU32::new(0.0f32.to_bits()),
            post_jump_ramp_frames: AtomicU32::new(0),
            last_output_l_bits: AtomicU32::new(0.0f32.to_bits()),
            last_output_r_bits: AtomicU32::new(0.0f32.to_bits()),
            peak_l_bits: AtomicU32::new(0),
            peak_r_bits: AtomicU32::new(0),
        });
        Self::spawn_reporter(state.clone(), event_tx.clone());
        Self {
            stream: None,
            stream_sample_rate: 0,
            state,
            event_tx,
            beatgrid: Vec::new(),
            decoder_handle: None,
        }
    }

    pub fn load(&mut self, path: &Path) -> Result<LoadInfo> {
        let t0 = Instant::now();
        let probe_res = probe(path).with_context(|| format!("probe {}", path.display()))?;
        let probe_ms = t0.elapsed().as_secs_f64() * 1000.0;
        tracing::info!(
            probe_ms = probe_ms,
            n_frames = probe_res.n_frames,
            sample_rate = probe_res.sample_rate,
            channels = probe_res.channel_count,
            "probed file"
        );

        // Cancel any prior decoder before swapping the buffer. The old
        // worker sees `cancelled = true` on its next iteration and exits.
        // We do NOT join here — joining blocks load() until the old
        // worker finishes its current packet (potentially ~10ms), which
        // would forfeit some of the progressive-playback win. Memory is
        // freed when the worker drops its Arc<ProgressiveBuffer>.
        let prev_buf = self.state.current_buffer.load_full();
        prev_buf.cancelled.store(true, Ordering::Release);

        // Reset transport state. Order: pause → cursor reset → buffer
        // swap → sample rate + ended. Audio callback gates output on
        // `playing` so it can never observe a half-swapped state.
        self.state.playing.store(false, Ordering::Release);
        self.state.cursor.store(0, Ordering::Release);
        let new_buf = Arc::new(ProgressiveBuffer::new(probe_res.n_frames));
        self.state.current_buffer.store(new_buf.clone());
        self.state.sample_rate.store(probe_res.sample_rate, Ordering::Release);
        self.state.ended.store(false, Ordering::Release);
        // Clear any loop carried over from the previous track — its
        // in/out frame indices are nonsense for the new buffer.
        self.state.loop_region.store(Arc::new(None));
        // Same for a pending trigger — frame indices are buffer-relative.
        self.state.pending_trigger.store(Arc::new(None));
        self.state.trigger_just_fired.store(false, Ordering::Release);
        // The beatgrid belongs to the previous track; the renderer
        // re-pushes the new track's grid after load resolves.
        self.beatgrid.clear();
        // Reset envelope + post-jump state so the next play() fades in
        // cleanly from silence. Without this, switching tracks while
        // already playing keeps envelope at 1.0 and the first audible
        // sample of the new track pops.
        self.state.envelope_gain_bits.store(0.0f32.to_bits(), Ordering::Release);
        self.state.post_jump_ramp_frames.store(0, Ordering::Release);
        self.state.last_output_l_bits.store(0.0f32.to_bits(), Ordering::Release);
        self.state.last_output_r_bits.store(0.0f32.to_bits(), Ordering::Release);
        // VU meter peaks reset to 0 so the new track's meter starts
        // from silence, not from a stale tail-of-previous-track value.
        self.state.peak_l_bits.store(0, Ordering::Release);
        self.state.peak_r_bits.store(0, Ordering::Release);
        // Exit any in-flight scrub cleanly so the new track starts in
        // Normal state. The renderer is responsible for not initiating
        // another scrub against the new track until it observes the
        // load result, but if a stale scrub_to arrives we want to ignore
        // it rather than apply it to the new buffer.
        self.state.scrub_mode.store(false, Ordering::Release);
        self.state.scrub_target_frames.store(0, Ordering::Release);
        self.state.pre_scrub_loop.store(Arc::new(None));

        // Stream lifecycle: build once, keep across loads. The output
        // device's rate doesn't change per-track; the callback resamples
        // from the current track's `sample_rate` to the device's rate
        // when they differ. Previously we tore down + rebuilt the stream
        // on every sample-rate change, which both took ~10ms and (on
        // Windows shared-mode WASAPI) outright failed at non-device
        // rates with "no f32 output config for 44100Hz" — the device is
        // locked to whatever Windows is set to (typically 48 kHz).
        let need_rebuild = self.stream.is_none();
        tracing::info!(
            need_rebuild,
            stream_is_some = self.stream.is_some(),
            cur_stream_sr = self.stream_sample_rate,
            track_sr = probe_res.sample_rate,
            "load: rebuild decision"
        );
        if need_rebuild {
            let build_t0 = Instant::now();
            let stream = build_output_stream(probe_res.sample_rate, self.state.clone())?;
            stream.play().context("start stream after build")?;
            self.stream = Some(stream);
            self.stream_sample_rate = self.state.stream_sample_rate.load(Ordering::Acquire);
            tracing::info!(
                build_ms = build_t0.elapsed().as_secs_f64() * 1000.0,
                stream_sample_rate = self.stream_sample_rate,
                track_sample_rate = probe_res.sample_rate,
                "built cpal stream"
            );
        }

        // Spawn the decoder worker. It owns the FormatReader + Decoder
        // (both Send) and the Arc<ProgressiveBuffer>. Runs until either
        // the file is exhausted or the buffer's cancelled flag flips.
        let buf_for_worker = new_buf.clone();
        let event_tx_for_worker = self.event_tx.clone();
        let total_frames = probe_res.n_frames;
        let channel_count = probe_res.channel_count;
        let track_id = probe_res.track_id;
        let mut format = probe_res.format;
        let mut decoder = probe_res.decoder;
        let handle = thread::spawn(move || {
            let t0 = Instant::now();
            let mut frame_offset: usize = 0;
            loop {
                if buf_for_worker.cancelled.load(Ordering::Acquire) {
                    tracing::debug!("decoder thread cancelled");
                    return;
                }
                let packet = match format.next_packet() {
                    Ok(p) => p,
                    Err(symphonia::core::errors::Error::IoError(e))
                        if e.kind() == std::io::ErrorKind::UnexpectedEof =>
                    {
                        break;
                    }
                    Err(e) => {
                        tracing::error!(error = ?e, "decoder packet read failed");
                        return;
                    }
                };
                if packet.track_id() != track_id {
                    continue;
                }
                let written = match decode_packet_into_cells(
                    decoder.as_mut(),
                    &packet,
                    channel_count,
                    &buf_for_worker.samples,
                    frame_offset,
                ) {
                    Ok(n) => n,
                    Err(e) => {
                        tracing::error!(error = ?e, "decode_packet_into_cells failed");
                        return;
                    }
                };
                if written == 0 {
                    continue;
                }
                frame_offset += written;
                // Release-store advances the high-water mark. After this
                // line the audio callback can read frames < frame_offset.
                buf_for_worker
                    .decoded_frames
                    .store(frame_offset as u64, Ordering::Release);
            }
            // Final store: mark all of `total_frames` available even if
            // the actual decoded count is slightly less (the tail beyond
            // is zero-filled, audio callback reads silence — correct
            // behavior for the brief tail discrepancy).
            let final_count = (frame_offset as u64).max(total_frames);
            buf_for_worker.decoded_frames.store(final_count, Ordering::Release);
            let decode_ms = t0.elapsed().as_secs_f64() * 1000.0;
            tracing::info!(
                decode_ms = decode_ms,
                frames = frame_offset,
                metadata_frames = total_frames,
                "decoder thread done"
            );
            // Could send a "decode_complete" event here if the renderer
            // needs to know — for Phase 1 spike, the audio thread alone
            // observing decoded_frames == total_frames is enough; the
            // end-of-track Ended event fires when cursor catches up.
            let _ = event_tx_for_worker;
        });
        self.decoder_handle = Some(handle);

        let load_ms = t0.elapsed().as_secs_f64() * 1000.0;
        tracing::info!(load_ms, "load() returning");

        Ok(LoadInfo {
            duration: probe_res.n_frames as f64 / probe_res.sample_rate as f64,
            sample_rate: probe_res.sample_rate,
            channels: 2,
        })
    }

    pub fn play(&mut self) -> Result<()> {
        if self.stream.is_none() {
            return Err(anyhow!("no track loaded"));
        }
        self.state.playing.store(true, Ordering::Release);
        let pos = self.position_secs();
        let _ = self.event_tx.send(Event::StateChanged { position: pos, playing: true, peak_l: 0.0, peak_r: 0.0 });
        Ok(())
    }

    pub fn pause(&mut self) -> Result<()> {
        self.state.playing.store(false, Ordering::Release);
        let pos = self.position_secs();
        let _ = self.event_tx.send(Event::StateChanged { position: pos, playing: false, peak_l: 0.0, peak_r: 0.0 });
        Ok(())
    }

    pub fn seek(&mut self, seconds: f64) -> Result<()> {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            return Err(anyhow!("no track loaded"));
        }
        let total = self.state.current_buffer.load().total_frames;
        let target = (seconds.max(0.0) * sr as f64).round() as u64;
        let clamped = target.min(total);
        self.state.cursor.store(clamped, Ordering::Release);
        // A manual seek invalidates any planned quantized trigger — the
        // user's gesture moved the playhead, the next-beat fire would
        // arrive at a position the user didn't consciously schedule.
        self.state.pending_trigger.store(Arc::new(None));
        if clamped < total {
            self.state.ended.store(false, Ordering::Release);
        }
        let pos = clamped as f64 / sr as f64;
        let is_playing = self.state.playing.load(Ordering::Acquire);
        let _ = self.event_tx.send(Event::StateChanged { position: pos, playing: is_playing, peak_l: 0.0, peak_r: 0.0 });
        Ok(())
    }

    pub fn set_volume(&mut self, v: f32) {
        let clamped = v.clamp(0.0, 1.0);
        self.state.volume_bits.store(clamped.to_bits(), Ordering::Release);
    }

    pub fn position_secs(&self) -> f64 {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            return 0.0;
        }
        let frame = self.state.cursor.load(Ordering::Acquire);
        frame as f64 / sr as f64
    }

    pub fn playing(&self) -> bool {
        self.state.playing.load(Ordering::Acquire)
    }

    /// Send+Sync read-only handle to a subset of engine state. The
    /// controller layer holds one of these on a background thread
    /// (engine itself is `!Send` because of cpal's Stream); the handle
    /// touches only atomics + ArcSwaps so cross-thread reads are
    /// lock-free and contention-free with the audio callback.
    pub fn state_handle(&self) -> EngineStateHandle {
        EngineStateHandle { state: Arc::clone(&self.state) }
    }

    /// Re-create the cpal output stream against whatever device the OS
    /// currently has set as default. Called from the device-watcher
    /// when the user changes their default output (plug/unplug, Sound
    /// settings flip). The progressive buffer + cursor + decoder thread
    /// are untouched — playback resumes from the same source position
    /// on the new device. There's a brief silence (~10–20 ms) while
    /// the old stream tears down and the new one starts; this matches
    /// what every OS-level audio router does on a device switch.
    ///
    /// No-op when no track has been loaded yet (nothing to play to).
    pub fn rebuild_output_device(&mut self) -> Result<()> {
        let source_rate = self.state.sample_rate.load(Ordering::Acquire);
        if source_rate == 0 {
            // No track loaded — there's no stream to swap. The next
            // load() will pick up the now-current default device.
            tracing::info!("rebuild_output_device: no track loaded, skipping");
            return Ok(());
        }
        // Drop the old stream BEFORE building the new one — releases the
        // old device handle so a new stream on the same device (e.g.
        // unplug+replug of the same USB output) doesn't race the old
        // handle for exclusive resources.
        self.stream = None;
        let t0 = Instant::now();
        let stream = build_output_stream(source_rate, self.state.clone())?;
        stream.play().context("start stream after device rebuild")?;
        self.stream = Some(stream);
        self.stream_sample_rate = self.state.stream_sample_rate.load(Ordering::Acquire);
        tracing::info!(
            rebuild_ms = t0.elapsed().as_secs_f64() * 1000.0,
            stream_sample_rate = self.stream_sample_rate,
            source_sample_rate = source_rate,
            "rebuilt stream for new default device"
        );
        Ok(())
    }

    pub fn stop(&mut self) {
        self.state.playing.store(false, Ordering::Release);
        self.state.cursor.store(0, Ordering::Release);
        let prev = self.state.current_buffer.load_full();
        prev.cancelled.store(true, Ordering::Release);
        self.state.current_buffer.store(Arc::new(ProgressiveBuffer::empty()));
        self.state.ended.store(false, Ordering::Release);
        self.state.loop_region.store(Arc::new(None));
        self.state.pending_trigger.store(Arc::new(None));
        self.state.trigger_just_fired.store(false, Ordering::Release);
        self.beatgrid.clear();
        self.state.scrub_mode.store(false, Ordering::Release);
        self.state.pre_scrub_loop.store(Arc::new(None));
        // Reset envelope. Without this the audio callback's
        // buffer-empty early-return cuts the last output sample
        // sharply to 0 instead of fading; clicks on stop().
        self.state.envelope_gain_bits.store(0.0f32.to_bits(), Ordering::Release);
        self.state.post_jump_ramp_frames.store(0, Ordering::Release);
        self.state.last_output_l_bits.store(0.0f32.to_bits(), Ordering::Release);
        self.state.last_output_r_bits.store(0.0f32.to_bits(), Ordering::Release);
        self.state.peak_l_bits.store(0, Ordering::Release);
        self.state.peak_r_bits.store(0, Ordering::Release);
    }

    /// Set or clear the active loop region. Both seconds null = clear.
    /// Both set with `out_sec > in_sec` activates the region; the audio
    /// callback then wraps the source cursor back to `in_sec` the
    /// instant it would step past `out_sec`. Anything malformed (out
    /// <= in, negative, or only one bound set) clears the region — we
    /// don't have a graceful UI fallback for a bogus loop config and
    /// silently dropping it is safer than half-applying it.
    pub fn set_loop(&mut self, in_sec: Option<f64>, out_sec: Option<f64>) -> Result<()> {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            // No track loaded — nothing to loop. Stored value stays as
            // None; renderer should re-call set_loop after load if it
            // wants a loop in effect from t=0.
            return Ok(());
        }
        let region = match (in_sec, out_sec) {
            (Some(i), Some(o)) if o > i && i >= 0.0 => {
                let in_frames = (i * sr as f64).round() as u64;
                let out_frames = (o * sr as f64).round() as u64;
                if out_frames > in_frames {
                    Some(LoopFrames {
                        in_frames,
                        out_frames,
                    })
                } else {
                    None
                }
            }
            _ => None,
        };
        tracing::info!(?region, "set_loop");
        self.state.loop_region.store(Arc::new(region));
        Ok(())
    }

    /// Arm (or clear) a quantized cue trigger. Same shape as set_loop —
    /// both None = clear; both Some + trigger_at_sec strictly past the
    /// current cursor = arm. Anything malformed (negative, already-past
    /// trigger, only one bound set) leaves the slot None; we don't have
    /// a graceful fallback for a bogus arm and silently dropping is
    /// safer than half-applying.
    ///
    /// Returns whether the trigger was actually armed so the renderer
    /// can fall back to an immediate seek when the cursor caught up
    /// before the RPC arrived. A "clear" call (both None) reports
    /// armed=false too — there's nothing to fire.
    ///
    /// Already-past triggers (`trigger_at_frames <= cursor`) are rejected
    /// because the audio callback's fire condition is `source_pos >=
    /// trigger_at_frames`; arming such a trigger would fire on the very
    /// next frame at a position the renderer didn't consciously
    /// schedule. Common cause: renderer's view of cursor is stale by
    /// one reporter tick (~50 ms) plus the arm_trigger RPC roundtrip,
    /// so a cue arming for nextBeat that's close to the current
    /// position can land already-past on the sidecar side.
    pub fn arm_trigger(&mut self, trigger_at_sec: Option<f64>, seek_to_sec: Option<f64>) -> Result<bool> {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            // No track loaded — nothing to trigger against. Stored value
            // stays None; report not-armed.
            return Ok(false);
        }
        let total = self.state.current_buffer.load().total_frames;
        let pending = match (trigger_at_sec, seek_to_sec) {
            (Some(t), Some(s)) if t >= 0.0 && s >= 0.0 => {
                let trigger_at = ((t * sr as f64).round() as u64).min(total);
                let seek_to = ((s * sr as f64).round() as u64).min(total);
                let cursor = self.state.cursor.load(Ordering::Acquire);
                if trigger_at > cursor {
                    Some(PendingTrigger {
                        trigger_at_frames: trigger_at,
                        seek_to_frames: seek_to,
                        jump_delta_beats: None,
                        move_loop_to: None,
                    })
                } else {
                    None
                }
            }
            _ => None,
        };
        let armed = pending.is_some();
        tracing::info!(?pending, armed, "arm_trigger");
        self.state.pending_trigger.store(Arc::new(pending));
        Ok(armed)
    }

    /// Crossfaded seek. For the renderer's "fire immediately" cue path —
    /// non-quantized cues, or quantized cues whose nextBeat is within the
    /// renderer's safety margin so there's no time to defer. A hard seek
    /// here (engine.seek) is a sample-level DC discontinuity and clicks
    /// in the same way pause→play does (audio→silence transition).
    ///
    /// Implementation mirrors arm_trigger but the sidecar computes
    /// `trigger_at_frames` itself, off the live cursor + a callback-
    /// safety pad + the crossfade window. That sidesteps the renderer-
    /// view-vs-actual-cursor race entirely: by definition trigger_at
    /// is strictly future, and the audio callback that picks up the
    /// armed trigger has at least one full crossfade window before
    /// `source_pos` reaches it. Total latency from RPC arrival to
    /// audible seek: ~30 ms (10 ms callback pad + 10 ms xfade + a few
    /// ms of comfort margin). Imperceptible compared to the click that
    /// the hard seek produces.
    pub fn seek_with_xfade(&mut self, seek_to_sec: f64) -> Result<()> {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            return Err(anyhow!("no track loaded"));
        }
        let total = self.state.current_buffer.load().total_frames;
        let cursor = self.state.cursor.load(Ordering::Acquire);
        let xfade_frames = (sr as f64 * LOOP_CROSSFADE_MS / 1000.0) as u64;
        // Callback-safety pad: max plausible cpal callback period on the
        // platforms we ship. WASAPI shared ≈ 10 ms typical, but Windows
        // can push this past 30 ms under load or on certain drivers /
        // power profiles. 40 ms covers the long tail; if the callback
        // is even longer than that the post-jump ramp (engine.rs:
        // post_jump_ramp_frames) catches the seam.
        let pad_frames = (sr as f64 * 0.04) as u64;
        let trigger_at = cursor.saturating_add(pad_frames).saturating_add(xfade_frames).min(total);
        let seek_to = ((seek_to_sec.max(0.0) * sr as f64).round() as u64).min(total);
        // Track is shorter than one pad+xfade window — can't crossfade
        // safely. Fall back to a hard cursor jump; click will be small
        // because the buffer is tiny anyway.
        if trigger_at <= cursor || seek_to >= total {
            self.state.cursor.store(seek_to, Ordering::Release);
            self.state.pending_trigger.store(Arc::new(None));
            if seek_to < total {
                self.state.ended.store(false, Ordering::Release);
            }
            let pos = seek_to as f64 / sr as f64;
            let is_playing = self.state.playing.load(Ordering::Acquire);
            let _ = self.event_tx.send(Event::StateChanged { position: pos, playing: is_playing, peak_l: 0.0, peak_r: 0.0 });
            return Ok(());
        }
        let pending = PendingTrigger {
            trigger_at_frames: trigger_at,
            seek_to_frames: seek_to,
            jump_delta_beats: None,
            move_loop_to: None,
        };
        tracing::info!(?pending, "seek_with_xfade");
        self.state.pending_trigger.store(Arc::new(Some(pending)));
        Ok(())
    }

    /// Replace the loaded track's beatgrid (ascending beat times in
    /// seconds). Empty vec — or anything malformed — clears it, which
    /// downgrades jump_beats to not-jumped (renderer falls back to its
    /// own walk). Seconds, not frames: the grid can arrive around a
    /// load() with a different sample rate, and jump_beats converts at
    /// use time against the live rate, so ordering never corrupts it.
    pub fn set_beatgrid(&mut self, beats: Vec<f64>) {
        self.beatgrid = sanitize_grid(beats);
        tracing::info!(beats = self.beatgrid.len(), "set_beatgrid");
    }

    /// Phase-preserving beat jump (Pioneer CDJ "Beat Jump" semantics):
    /// translate the playhead by EXACTLY `delta_beats` grid-beats,
    /// carrying the sub-beat phase, de-clicked with the same 10 ms
    /// crossfade the cue path uses.
    ///
    /// The correctness trick: `seek_with_xfade`'s trigger machinery
    /// fires at a deterministic future frame (`trigger_at`) and the
    /// callback preserves overshoot (`source_pos = seek_to + δ`). A
    /// phase-preserving jump target is a pure function of the cut
    /// position, so computing `seek_to = beat_walk(trigger_at, delta)`
    /// HERE at arm time is exactly as accurate as computing it inside
    /// the audio callback at consume time — the cut lands at
    /// trigger_at (+δ, carried across), so the musical displacement is
    /// always exactly `delta_beats` no matter how stale the renderer's
    /// position view was or how long the RPC took. That's what keeps
    /// repeated jumps "in the pocket" — and it keeps the beatgrid out
    /// of the real-time callback entirely.
    ///
    /// Loop interaction (rekordbox/CDJ/Mixxx consensus): when a native
    /// loop is active AND the cursor is inside it, the jump translates
    /// the loop region by the same delta — carried on the trigger
    /// (`move_loop_to`) so region + cursor move in one consume step.
    /// A move that would push the loop past either track edge rejects
    /// the whole jump (Mixxx `slotBeatJump`).
    ///
    /// Returns `jumped: false` (never an error) when there's nothing
    /// sensible to do — no track, no/invalid grid, mid-scrub, zero
    /// delta — so the renderer can fall back without special-casing.
    pub fn jump_beats(&mut self, delta_beats: f64) -> Result<JumpOutcome> {
        let not_jumped = JumpOutcome { jumped: false, target_sec: 0.0, loop_in_sec: None, loop_out_sec: None };
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0
            || self.state.scrub_mode.load(Ordering::Acquire)
            || !delta_beats.is_finite()
            || delta_beats == 0.0
            || self.beatgrid.len() < 2
        {
            return Ok(not_jumped);
        }
        let sr_f = sr as f64;
        let total = self.state.current_buffer.load().total_frames;
        let total_sec = total as f64 / sr_f;
        let xfade_frames = (sr_f * LOOP_CROSSFADE_MS / 1000.0) as u64;
        // Same callback-safety pad rationale as seek_with_xfade. Jumps
        // could run a tighter pad (overshoot preservation keeps a late
        // fire musically exact), but ship with the proven value first.
        let pad_frames = (sr_f * 0.04) as u64;

        // Two attempts: the compose step below reads the pending
        // trigger, and the audio callback may consume it between our
        // load and the store — a plain store would then re-apply the
        // already-fired delta. CAS against the loaded guard detects
        // that; the retry re-reads (now None → no compose) and its CAS
        // cannot fail again because the callback only ever writes the
        // slot to consume a Some.
        for _attempt in 0..2 {
            let guard = self.state.pending_trigger.load();
            let prev_pending: Option<PendingTrigger> = **guard;
            // Compose with a still-pending jump so key-repeat presses
            // accumulate (2 × +4 = +8 from the eventual fire point). A
            // pending CUE trigger (jump_delta_beats: None) is replaced
            // instead — a jump is a manual transport gesture, same
            // invalidation `seek()` applies.
            let effective_delta = match prev_pending.and_then(|pt| pt.jump_delta_beats) {
                Some(d) => d + delta_beats,
                None => delta_beats,
            };

            let cursor = self.state.cursor.load(Ordering::Acquire);
            let is_playing = self.state.playing.load(Ordering::Acquire);
            let mut trigger_at = cursor.saturating_add(pad_frames).saturating_add(xfade_frames).min(total);

            // Loop-move: only when the cursor is actually INSIDE the
            // active region (Mixxx condition) — a loop parked elsewhere
            // in the track stays put.
            let loop_snapshot: Option<LoopFrames> = **self.state.loop_region.load();
            let inside_loop = loop_snapshot
                .map(|lr| cursor >= lr.in_frames && cursor < lr.out_frames)
                .unwrap_or(false);
            let moved_loop = if inside_loop {
                let lr = loop_snapshot.unwrap();
                // Keep the trigger reachable: the wrap at out_frames
                // pulls the cursor back before it could ever cross a
                // trigger_at past the loop end (trigger check runs
                // before the wrap check each frame, so out - 1 fires).
                trigger_at = trigger_at.min(lr.out_frames.saturating_sub(1));
                let new_in = beat_walk_unclamped(&self.beatgrid, lr.in_frames as f64 / sr_f, effective_delta);
                let new_out = beat_walk_unclamped(&self.beatgrid, lr.out_frames as f64 / sr_f, effective_delta);
                if new_in < 0.0 || new_out > total_sec {
                    return Ok(not_jumped);
                }
                Some(LoopFrames {
                    in_frames: (new_in * sr_f).round() as u64,
                    out_frames: (new_out * sr_f).round() as u64,
                })
            } else {
                None
            };

            // The walk origin must be the frame where the cut actually
            // happens: trigger_at for the armed path (the callback fires
            // there), the LIVE CURSOR for the immediate path (the store
            // happens now). Walking the immediate path from trigger_at
            // leaks the pad+xfade (~50 ms) into the landing phase — a
            // paused +4/−4 round trip came back 100 ms off before this
            // split.
            let walk_from = |origin_frames: u64| -> u64 {
                let t = beat_walk(&self.beatgrid, origin_frames as f64 / sr_f, effective_delta, total_sec);
                ((t * sr_f).round() as u64).min(total)
            };
            let seek_to = walk_from(trigger_at);

            // Immediate path — no trigger machinery available: paused
            // (the steady-paused callback early-returns and would never
            // consume the trigger; it's also silent, so a hard store
            // can't click), or the pad window doesn't fit before the
            // track/loop end. Mirrors seek_with_xfade's fallback; the
            // post-jump ramp softens the seam if audio is still flowing.
            if !is_playing || trigger_at <= cursor || seek_to >= total {
                let seek_to = walk_from(cursor);
                let outcome = JumpOutcome {
                    jumped: true,
                    target_sec: seek_to as f64 / sr_f,
                    loop_in_sec: moved_loop.map(|lr| lr.in_frames as f64 / sr_f),
                    loop_out_sec: moved_loop.map(|lr| lr.out_frames as f64 / sr_f),
                };
                self.state.cursor.store(seek_to, Ordering::Release);
                if let Some(lr) = moved_loop {
                    self.state.loop_region.store(Arc::new(Some(lr)));
                }
                self.state.pending_trigger.store(Arc::new(None));
                if seek_to < total {
                    self.state.ended.store(false, Ordering::Release);
                }
                let ramp_total = (sr_f * POST_JUMP_RAMP_MS as f64 / 1000.0) as u32;
                self.state.post_jump_ramp_frames.store(ramp_total, Ordering::Release);
                tracing::info!(delta_beats, effective_delta, seek_to, immediate = true, "jump_beats");
                let _ = self.event_tx.send(Event::StateChanged {
                    position: outcome.target_sec,
                    playing: is_playing,
                    peak_l: 0.0,
                    peak_r: 0.0,
                });
                return Ok(outcome);
            }

            let pending = PendingTrigger {
                trigger_at_frames: trigger_at,
                seek_to_frames: seek_to,
                jump_delta_beats: Some(effective_delta),
                move_loop_to: moved_loop,
            };
            let prev = self.state.pending_trigger.compare_and_swap(&guard, Arc::new(Some(pending)));
            if Arc::as_ptr(&*prev) == Arc::as_ptr(&*guard) {
                tracing::info!(delta_beats, effective_delta, ?pending, "jump_beats");
                return Ok(JumpOutcome {
                    jumped: true,
                    target_sec: seek_to as f64 / sr_f,
                    loop_in_sec: moved_loop.map(|lr| lr.in_frames as f64 / sr_f),
                    loop_out_sec: moved_loop.map(|lr| lr.out_frames as f64 / sr_f),
                });
            }
            tracing::debug!("jump_beats: pending trigger consumed mid-arm, recomputing");
        }
        // Unreachable in practice (see retry comment) — treat as a
        // clean miss rather than erroring the RPC.
        Ok(not_jumped)
    }

    /// Enter scrub mode. Snapshots the loop region (restored at
    /// scrub_end) and flips `playing` off so the reporter stops emitting
    /// `playing=true` events that would race the renderer's optimistic
    /// state.playing=false update.
    ///
    /// When `target_seconds` is `Some`, the engine first snaps the
    /// cursor (and scrub_target) to that position — used by the
    /// mini-wavemap for "click anywhere, playhead jumps here, then
    /// drag from there". When `None`, the cursor stays put (big-
    /// waveform's grab-and-drag entry).
    pub fn scrub_begin(&mut self, target_seconds: Option<f64>) -> Result<()> {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            return Err(anyhow!("no track loaded"));
        }
        let total = self.state.current_buffer.load().total_frames;
        let target_frames = match target_seconds {
            Some(secs) => {
                let t = (secs.max(0.0) * sr as f64).round() as u64;
                t.min(total)
            }
            None => self.state.cursor.load(Ordering::Acquire),
        };
        let prior_loop = self.state.loop_region.load_full();
        self.state.pre_scrub_loop.store(prior_loop);
        // Drop the live loop region so the callback's wrap logic doesn't
        // pull the cursor back inside while the user is scrubbing past
        // the loop's bounds.
        self.state.loop_region.store(Arc::new(None));
        // Triggers are transient gestures — scrubbing means the user
        // took manual control of the playhead, so any previously-armed
        // trigger from before the scrub is no longer their intent. No
        // snapshot/restore (unlike loops).
        self.state.pending_trigger.store(Arc::new(None));
        // Snap the cursor + the initial target to `target_frames`. With
        // gap=0 the audio callback's first iteration produces silence —
        // the user hears the click as a clean pause, not a slewed
        // scratch from wherever the engine was.
        self.state.cursor.store(target_frames, Ordering::Release);
        self.state.scrub_target_frames.store(target_frames, Ordering::Release);
        // Pause normal-rate playback. The audio callback runs the scrub
        // branch instead — it ignores `playing` while `scrub_mode` is set.
        self.state.playing.store(false, Ordering::Release);
        self.state.scrub_mode.store(true, Ordering::Release);
        // Emit a StateChanged so the renderer sees the pause + jump
        // immediately.
        let pos = target_frames as f64 / sr as f64;
        let _ = self.event_tx.send(Event::StateChanged { position: pos, playing: false, peak_l: 0.0, peak_r: 0.0 });
        tracing::debug!(target_frames, "scrub_begin");
        Ok(())
    }

    /// Update the scrub target. High-frequency — renderer emits on every
    /// pointermove + every rAF tick. The audio callback picks up the
    /// new target in its next iteration.
    pub fn scrub_to(&mut self, seconds: f64) -> Result<()> {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            return Err(anyhow!("no track loaded"));
        }
        if !self.state.scrub_mode.load(Ordering::Acquire) {
            // Stale scrub_to arriving after scrub_end (or before begin)
            // — silently ignore. Renderer can recover by issuing
            // scrub_begin if it really wanted to be scrubbing.
            return Ok(());
        }
        let total = self.state.current_buffer.load().total_frames;
        let target = (seconds.max(0.0) * sr as f64).round() as u64;
        let clamped = target.min(total);
        self.state.scrub_target_frames.store(clamped, Ordering::Release);
        Ok(())
    }

    /// Exit scrub mode. Cursor jumps to `final_seconds`, the pre-scrub
    /// loop region is restored, and playing state is set per the
    /// caller's `resume_playing` flag.
    pub fn scrub_end(&mut self, final_seconds: f64, resume_playing: bool) -> Result<()> {
        let sr = self.state.sample_rate.load(Ordering::Acquire);
        if sr == 0 {
            return Err(anyhow!("no track loaded"));
        }
        let total = self.state.current_buffer.load().total_frames;
        let target = (final_seconds.max(0.0) * sr as f64).round() as u64;
        let clamped = target.min(total);
        // Restore the loop region BEFORE flipping out of scrub mode so
        // the very next callback (already in Normal branch) sees the
        // correct wrap target.
        let prior = self.state.pre_scrub_loop.load_full();
        self.state.loop_region.store(prior);
        self.state.pre_scrub_loop.store(Arc::new(None));
        self.state.cursor.store(clamped, Ordering::Release);
        if clamped < total {
            self.state.ended.store(false, Ordering::Release);
        }
        self.state.scrub_mode.store(false, Ordering::Release);
        self.state.playing.store(resume_playing, Ordering::Release);
        let pos = clamped as f64 / sr as f64;
        let _ = self.event_tx.send(Event::StateChanged { position: pos, playing: resume_playing, peak_l: 0.0, peak_r: 0.0 });
        tracing::debug!(final_frames = clamped, resume_playing, "scrub_end");
        Ok(())
    }

    fn spawn_reporter(state: Arc<TransportState>, tx: Sender<Event>) {
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(50));
                let buf = state.current_buffer.load();
                let total = buf.total_frames;
                if total == 0 {
                    continue;
                }
                let cursor = state.cursor.load(Ordering::Acquire);
                let sr = state.sample_rate.load(Ordering::Acquire);
                let is_playing = state.playing.load(Ordering::Acquire);

                if cursor >= total && !state.ended.swap(true, Ordering::AcqRel) {
                    let _ = tx.send(Event::Ended);
                }

                // Trigger-fired bridge: audio callback flipped this when
                // it consumed a pending_trigger. Emit BEFORE the periodic
                // state_changed so the renderer's listener sees the
                // fire event prior to (or with) the next position
                // update — keeps the UI flash clear in the right order.
                if sr > 0 && state.trigger_just_fired.swap(false, Ordering::AcqRel) {
                    let pos = cursor as f64 / sr as f64;
                    let _ = tx.send(Event::TriggerFired { position: pos });
                }

                if is_playing && sr > 0 {
                    let pos = cursor as f64 / sr as f64;
                    // Atomically read + clear the per-channel peak observed
                    // by the audio callback since the last tick. swap(0)
                    // gives us "max over this interval"; we lose any peaks
                    // produced between the swap and the send, but those
                    // get rolled into the next tick.
                    let peak_l = f32::from_bits(state.peak_l_bits.swap(0, Ordering::AcqRel));
                    let peak_r = f32::from_bits(state.peak_r_bits.swap(0, Ordering::AcqRel));
                    let _ = tx.send(Event::StateChanged { position: pos, playing: true, peak_l, peak_r });
                }
            }
        });
    }
}

pub struct LoadInfo {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

/// What `jump_beats` did. `jumped: false` = clean miss (no track/grid,
/// mid-scrub, or a loop-move that would cross a track edge) — the
/// renderer decides whether to fall back to its own seek. The loop
/// fields are Some only when the jump also translated an active loop,
/// so the renderer can update its loop signal without recomputing.
pub struct JumpOutcome {
    pub jumped: bool,
    pub target_sec: f64,
    pub loop_in_sec: Option<f64>,
    pub loop_out_sec: Option<f64>,
}

/// Build the cpal output stream. Picks an f32 output config at the track's
/// rate when the device supports it (zero-cost path, no resampling); falls
/// back to the device's default config and resamples in the callback. The
/// stream is built once per engine instance and reused across loads —
/// `state.sample_rate` (track rate) is decoupled from the stream rate, so
/// switching tracks at different rates only updates atomics, not the
/// stream.
///
/// `preferred_source_rate` is just a hint for the exact-match fast path
/// on the first call; subsequent track rates are handled by callback-side
/// resampling.
fn build_output_stream(
    preferred_source_rate: u32,
    state: Arc<TransportState>,
) -> Result<cpal::Stream> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| anyhow!("no default output device"))?;
    tracing::info!(device = ?device.name(), "selected output device");

    // Fast path: try for an f32 config at the preferred source rate.
    // If we get one, no resampling cost in the callback. Common on pro
    // audio interfaces and ASIO hosts; rare on Windows + WASAPI shared.
    let exact = device
        .supported_output_configs()
        .ok()
        .and_then(|configs| {
            configs
                .filter_map(|c| {
                    let min = c.min_sample_rate().0;
                    let max = c.max_sample_rate().0;
                    if preferred_source_rate >= min
                        && preferred_source_rate <= max
                        && c.sample_format() == SampleFormat::F32
                    {
                        Some(c.with_sample_rate(SampleRate(preferred_source_rate)))
                    } else {
                        None
                    }
                })
                .next()
        });

    let supported = if let Some(s) = exact {
        tracing::info!(rate = preferred_source_rate, "found exact-rate f32 config");
        s
    } else {
        // Fallback: ask cpal for the device's default config (whatever
        // rate the OS exposes — 48 kHz on most Windows boxes). The
        // callback will linear-interpolate from source frames to this
        // rate. Linear interp is the cheapest resampler that doesn't
        // alias; for DJ-grade quality at rate-mismatch we'll swap it
        // for a windowed-sinc/rubato implementation later, but that
        // costs more CPU than is justified before we hear an artefact.
        let cfg = device
            .default_output_config()
            .context("query default output config")?;
        if cfg.sample_format() != SampleFormat::F32 {
            return Err(anyhow!(
                "default output config is {:?}, only f32 is wired up",
                cfg.sample_format()
            ));
        }
        tracing::info!(
            stream_rate = cfg.sample_rate().0,
            source_rate = preferred_source_rate,
            "no exact match; using device default + callback resample"
        );
        cfg
    };
    let config: StreamConfig = supported.into();
    state
        .stream_sample_rate
        .store(config.sample_rate.0, Ordering::Release);

    let channel_count = config.channels as usize;
    let state_clone = state.clone();

    let stream = device.build_output_stream(
        &config,
        move |out: &mut [f32], _info: &cpal::OutputCallbackInfo| {
            let is_playing = state_clone.playing.load(Ordering::Acquire);
            let is_scrubbing = state_clone.scrub_mode.load(Ordering::Acquire);
            let volume = f32::from_bits(state_clone.volume_bits.load(Ordering::Acquire));
            let frames_requested = out.len() / channel_count;

            // Master envelope gain. Slewed per-frame toward
            // target_gain (1.0 when playing or scrubbing, 0.0
            // otherwise) so play→pause and pause→play don't click.
            // Initial value is 0.0 — the very first play() fades in
            // cleanly. The post-jump ramp + last_output_l/r persist
            // across callbacks so the safety-net blend survives a
            // cursor jump that spans the callback boundary.
            let mut envelope_gain = f32::from_bits(state_clone.envelope_gain_bits.load(Ordering::Acquire));
            let target_gain: f32 = if is_playing || is_scrubbing { 1.0 } else { 0.0 };

            // Steady paused — output silence, no need to touch buffer
            // or per-frame state. Gate on envelope so an in-progress
            // fade-out still gets to ramp through.
            if !is_playing && !is_scrubbing && envelope_gain < 0.0001 {
                for s in out.iter_mut() {
                    *s = 0.0;
                }
                return;
            }

            // Per-callback peak accumulators. Single-threaded inside the
            // callback (cheap branch-free updates per frame); merged into
            // the shared peak_*_bits atomics once at the end via fetch_max.
            // Tracks max-abs of post-volume, post-envelope output (the
            // signal that actually leaves the speaker) so the meter
            // reflects what the user hears, not the source amplitude.
            let mut peak_l_local: f32 = 0.0;
            let mut peak_r_local: f32 = 0.0;

            // Snapshot the active buffer + its decoded high-water mark.
            // ArcSwap.load() is wait-free; the Acquire load on
            // decoded_frames establishes happens-before with the decoder
            // thread's last Release-store.
            let buf = state_clone.current_buffer.load();
            let decoded = buf.decoded_frames.load(Ordering::Acquire);
            let total_frames = buf.total_frames;
            let samples = &buf.samples;

            let source_sr = state_clone.sample_rate.load(Ordering::Acquire);
            let stream_sr = state_clone.stream_sample_rate.load(Ordering::Acquire);
            if source_sr == 0 || stream_sr == 0 || samples.is_empty() {
                for s in out.iter_mut() {
                    *s = 0.0;
                }
                return;
            }

            // Per-frame envelope slew step. Constant across the
            // callback so we don't need to re-divide each iter.
            let envelope_step: f32 = 1.0 / (source_sr as f32 * ENVELOPE_RAMP_MS / 1000.0).max(1.0);

            // Post-jump ramp state. Counter is decremented per frame
            // while blending last_output → primary; last_l/r persist
            // across callbacks so a jump that lands on the first iter
            // of a new callback still gets blended from the previous
            // callback's last output.
            let mut post_jump_ramp_remaining = state_clone.post_jump_ramp_frames.load(Ordering::Acquire);
            let post_jump_ramp_total: u32 = (source_sr as f32 * POST_JUMP_RAMP_MS / 1000.0) as u32;
            let mut last_l = f32::from_bits(state_clone.last_output_l_bits.load(Ordering::Acquire));
            let mut last_r = f32::from_bits(state_clone.last_output_r_bits.load(Ordering::Acquire));
            // Source frames consumed per output frame. 1.0 on the
            // exact-match path; e.g. 44100/48000 ≈ 0.91875 when running
            // a 44.1 kHz track through a 48 kHz device.
            let ratio = source_sr as f64 / stream_sr as f64;

            let cursor_start = state_clone.cursor.load(Ordering::Acquire);

            // ── Scrub branch ──────────────────────────────────────────
            // Position-based exponential slew. Each callback closes
            // SCRUB_SLEW_ALPHA of the cursor→target gap. When the
            // renderer stops pushing new targets (mouse held still),
            // the cursor converges on the last target and velocity
            // falls to zero geometrically — no inertia tail.
            //
            // Bypasses the playing flag (`scrub_begin` already paused
            // it; the renderer treats scrub as a paused-but-audible
            // state). Bypasses the loop wrap (`pre_scrub_loop` holds
            // the snapshot until `scrub_end`). Reverse falls out for
            // free when target < cursor: v_step goes negative and the
            // linear interpolator handles the sub-sample reads in the
            // same direction.
            if is_scrubbing {
                let target = state_clone
                    .scrub_target_frames
                    .load(Ordering::Acquire);
                // Total source-frame advance over this callback.
                let total_advance =
                    (target as f64 - cursor_start as f64) * SCRUB_SLEW_ALPHA as f64;
                // Per-output-frame step in source frames.
                let v_step = if frames_requested > 0 {
                    (total_advance / frames_requested as f64) as f32
                } else {
                    0.0
                };
                // Linear silence gate — gain ramps from 0 at v=0 to 1
                // at |v| = threshold. Cursor stops moving when target
                // is reached, so this gate naturally closes the audio
                // to silence on a held-still mouse.
                let abs_v = v_step.abs();
                let gate_gain = (abs_v / SCRUB_SILENCE_THRESHOLD).min(1.0);

                let mut source_pos = cursor_start as f64;
                let total_f64 = total_frames as f64;
                let v_step_f64 = v_step as f64;
                for f in 0..frames_requested {
                    let dst_off = f * channel_count;
                    // Bounds-check signed because reverse can push
                    // source_pos negative for one sample before clamp.
                    let src_floor_signed = source_pos.floor() as i64;
                    let in_bounds = src_floor_signed >= 0
                        && (src_floor_signed as u64) < total_frames
                        && (src_floor_signed as u64) + 1 < decoded;
                    let (mut l, mut r) = if in_bounds {
                        let src_floor = src_floor_signed as u64;
                        let frac = (source_pos - src_floor as f64) as f32;
                        let i0 = (src_floor as usize) * 2;
                        let i1 = i0 + 2;
                        let l0 = unsafe { *samples[i0].get() };
                        let r0 = unsafe { *samples[i0 + 1].get() };
                        let l1 = unsafe { *samples[i1].get() };
                        let r1 = unsafe { *samples[i1 + 1].get() };
                        let l = (l0 + (l1 - l0) * frac) * volume * gate_gain;
                        let r = (r0 + (r1 - r0) * frac) * volume * gate_gain;
                        (l, r)
                    } else {
                        (0.0, 0.0)
                    };
                    // Apply master envelope. target_gain == 1.0 during
                    // scrub (is_scrubbing branch is gated by the entry
                    // check), so this is a no-op in steady state but
                    // catches the scrub-end → pause → resume transition
                    // smoothly.
                    l *= envelope_gain;
                    r *= envelope_gain;
                    if channel_count == 1 {
                        out[dst_off] = (l + r) * 0.5;
                    } else {
                        out[dst_off] = l;
                        out[dst_off + 1] = r;
                        for c in 2..channel_count {
                            out[dst_off + c] = 0.0;
                        }
                    }
                    let abs_l = l.abs();
                    let abs_r = r.abs();
                    if abs_l > peak_l_local { peak_l_local = abs_l; }
                    if abs_r > peak_r_local { peak_r_local = abs_r; }
                    last_l = l;
                    last_r = r;
                    // Ramp envelope toward target so a scrub_end with
                    // resume_playing=false fades out instead of cutting.
                    if envelope_gain < target_gain {
                        envelope_gain = (envelope_gain + envelope_step).min(target_gain);
                    } else if envelope_gain > target_gain {
                        envelope_gain = (envelope_gain - envelope_step).max(target_gain);
                    }
                    source_pos += v_step_f64;
                    // Clamp to track bounds defensively.
                    if source_pos < 0.0 {
                        source_pos = 0.0;
                    } else if source_pos > total_f64 {
                        source_pos = total_f64;
                    }
                }
                state_clone
                    .cursor
                    .store(source_pos.round() as u64, Ordering::Release);
                state_clone.envelope_gain_bits.store(envelope_gain.to_bits(), Ordering::Release);
                state_clone.last_output_l_bits.store(last_l.to_bits(), Ordering::Release);
                state_clone.last_output_r_bits.store(last_r.to_bits(), Ordering::Release);
                state_clone.post_jump_ramp_frames.store(post_jump_ramp_remaining, Ordering::Release);
                // Merge per-callback peaks into the shared atomic via
                // fetch_max. Safe to compare f32 bits as u32 because both
                // values are non-negative (abs()) — IEEE 754 ordering
                // preserves bit ordering for same-sign floats.
                state_clone.peak_l_bits.fetch_max(peak_l_local.to_bits(), Ordering::AcqRel);
                state_clone.peak_r_bits.fetch_max(peak_r_local.to_bits(), Ordering::AcqRel);
                return;
            }

            // Fractional source position in source frames. Starts at the
            // integer cursor; each output frame steps it by `ratio`.
            let mut source_pos = cursor_start as f64;

            // Snapshot the active loop region once per callback. ArcSwap
            // makes this wait-free; reading `**guard` copies the Option
            // out so subsequent per-frame checks don't deref the Arc.
            // `mut` because a beat-jump trigger fire can carry a moved
            // loop region that replaces this snapshot mid-callback.
            let loop_guard = state_clone.loop_region.load();
            let mut loop_region: Option<LoopFrames> = **loop_guard;

            // Same snapshot for the pending cue trigger. Both are `mut`
            // because the trigger fire branch updates them after a
            // successful fire (per-frame disarm), and we need both
            // subsequent loop iterations to see the disarmed state.
            let trigger_guard = state_clone.pending_trigger.load();
            let mut pending_trigger: Option<PendingTrigger> = **trigger_guard;

            // Crossfade window in source frames. We linearly blend the
            // loop tail with the audio that NATURALLY leads into the
            // loop's in-point (the samples just before in_frames in the
            // file), so by the time source_pos reaches out_frames the
            // mix is 100% lead-in. The next frame after wrap reads
            // sample[in_frames] — consecutive with sample[in_frames-1]
            // in the file, hence no audible seam. Mixxx uses the same
            // pattern (see ReadAheadManager + linearCrossfadeBuffersOut),
            // we just fuse the dual read into the existing per-frame
            // interpolation loop instead of staging a second buffer
            // since the whole decoded track is already in memory.
            //
            // Disabled when in_frames is too close to track start to
            // hold a full window of lead-in audio — fall through to the
            // raw wrap; the click is small enough on track-start loops
            // that it's not worth a special case.
            let xfade_frames: u64 =
                ((source_sr as f64) * LOOP_CROSSFADE_MS / 1000.0) as u64;
            let mut xfade_active = loop_region
                .map(|lr| lr.in_frames >= xfade_frames + 1)
                .unwrap_or(false);
            // Same gate for the trigger seam — disable when seek_to is
            // too close to track start to hold a full lead-in window.
            let mut trigger_xfade_active = pending_trigger
                .map(|pt| pt.seek_to_frames >= xfade_frames + 1)
                .unwrap_or(false);

            for f in 0..frames_requested {
                // Sample-accurate cue trigger fire. Evaluated BEFORE the
                // loop-wrap check so that when both are armed (cue+loop
                // combo: renderer set loop_region first, then
                // pending_trigger with seek_to_frames == loop.in_frames),
                // the trigger fires and snaps source_pos to seek_to_frames
                // — which equals loop.in_frames — so the next frame's
                // loop-wrap check sees source_pos < out_frames and the
                // loop holds. If a trigger ever races an already-active
                // loop whose out_frames < trigger_at_frames, the loop
                // wraps first and the trigger's trigger_at is unreachable
                // (correct: once inside a loop you stay).
                //
                // Same overshoot-preservation as the loop wrap: when
                // `ratio` lands source_pos at trigger_at_frames + δ, the
                // post-jump position is seek_to_frames + δ rather than
                // seek_to_frames exactly, so no source-frame of audio
                // time is dropped.
                //
                // Disarm in-callback via ArcSwap.store(Arc::new(None)) —
                // one heap alloc per fire (not per frame), inside an
                // audio callback. Acceptable trade for the
                // architectural simplicity; if measurements show xrun
                // pressure on tight WASAPI exclusive buffers, switch
                // to a pre-allocated `none_sentinel` held on state.
                if let Some(pt) = pending_trigger {
                    if source_pos >= pt.trigger_at_frames as f64 {
                        let overshoot = source_pos - pt.trigger_at_frames as f64;
                        source_pos = pt.seek_to_frames as f64 + overshoot;
                        // Beat-jump inside a loop: translate the loop
                        // region in the same consume step so the wrap
                        // check below never sees moved-loop + unmoved-
                        // cursor (or vice versa). source_pos already
                        // landed inside the moved region (both were
                        // walked by the same beat delta), so the wrap
                        // check on this very frame is a no-op. Same
                        // one-alloc-per-fire tradeoff as the disarm
                        // store just below.
                        if let Some(lr) = pt.move_loop_to {
                            state_clone.loop_region.store(Arc::new(Some(lr)));
                            loop_region = Some(lr);
                            xfade_active = lr.in_frames >= xfade_frames + 1;
                        }
                        state_clone.pending_trigger.store(Arc::new(None));
                        state_clone.trigger_just_fired.store(true, Ordering::Release);
                        pending_trigger = None;
                        trigger_xfade_active = false;
                        // Arm the post-jump safety ramp. When the
                        // crossfade window fired in full this is a
                        // near-no-op (blending two already-matched
                        // samples). When the cpal callback was large
                        // enough to skip past the crossfade window
                        // entirely, this catches the discontinuity:
                        // 3 ms linear blend from last_output → primary.
                        post_jump_ramp_remaining = post_jump_ramp_total;
                    }
                }

                // Sample-accurate loop wrap. Done per-frame so a long
                // callback buffer doesn't overshoot the loop end. Wrap
                // happens BEFORE the read so the frame at out_frames
                // itself never plays — matches the half-open [in, out)
                // convention used everywhere else (renderer overlay,
                // DeckController wrap, rekordbox import).
                //
                // Fractional overshoot is preserved: when `source_pos`
                // lands at `out_frames + δ` (because `ratio` doesn't
                // divide the loop length evenly), the wrapped position
                // is `in_frames + δ` — NOT `in_frames` exactly. Without
                // this, every wrap drops δ source-frames of audio time
                // and the playback pace stutters for one output frame.
                // Equivalent to Mixxx's `m_currentPosition += overshoot`
                // in ReadAheadManager (PR #11704). When source_pos was
                // scrubbed far past out_frames with the loop still
                // active, the same formula clamps the offset modulo
                // the loop length so we don't land past out_frames
                // again on the very next iteration.
                if let Some(lr) = loop_region {
                    if source_pos >= lr.out_frames as f64 {
                        let loop_len = (lr.out_frames - lr.in_frames) as f64;
                        let overshoot = source_pos - lr.out_frames as f64;
                        let overshoot_mod = if loop_len > 0.0 {
                            overshoot - (overshoot / loop_len).floor() * loop_len
                        } else {
                            0.0
                        };
                        source_pos = lr.in_frames as f64 + overshoot_mod;
                    }
                }

                let src_floor = source_pos.floor() as u64;
                let frac = (source_pos - src_floor as f64) as f32;

                // We always read floor AND floor+1 for interpolation,
                // even on the exact-rate path where frac is 0 — the +1
                // slot exists because ProgressiveBuffer pre-allocates
                // FRAME_SAFETY_MARGIN extra frames (zero-filled). Gate
                // on `src_floor + 1 < decoded` to avoid reading a slot
                // the decoder hasn't reached yet; the tiny extra
                // latency vs. `src_floor < decoded` (one source-frame ≈
                // 22 μs at 44.1 kHz) is well below audibility.
                let in_bounds = src_floor < total_frames && src_floor + 1 < decoded;
                let dst_off = f * channel_count;
                if in_bounds {
                    let i0 = (src_floor as usize) * 2;
                    let i1 = i0 + 2;
                    // SAFETY: both i0 and i1 are below decoded_frames*2,
                    // which was Acquire-loaded above. The decoder
                    // Release-stored decoded_frames after writing both
                    // slots, so they're fully initialised.
                    let l0 = unsafe { *samples[i0].get() };
                    let r0 = unsafe { *samples[i0 + 1].get() };
                    let l1 = unsafe { *samples[i1].get() };
                    let r1 = unsafe { *samples[i1 + 1].get() };
                    let mut l = l0 + (l1 - l0) * frac;
                    let mut r = r0 + (r1 - r0) * frac;

                    // Loop-seam crossfade: when source_pos is in
                    // [out_frames − xfade_frames, out_frames), mix the
                    // primary read with a "ghost" read from the
                    // corresponding offset before in_frames. α = 1 at
                    // window start (pure loop tail), α = 0 at window
                    // end (pure lead-in). Drops the click that comes
                    // from the sample[out − 1] → sample[in] step.
                    if xfade_active {
                        let lr = loop_region.unwrap();
                        let dist = lr.out_frames as f64 - source_pos;
                        if dist > 0.0 && dist < xfade_frames as f64 {
                            let ghost_pos =
                                source_pos - lr.out_frames as f64 + lr.in_frames as f64;
                            let g_floor = ghost_pos.floor() as u64;
                            let g_frac = (ghost_pos - g_floor as f64) as f32;
                            // Ghost is below in_frames (verified by the
                            // xfade_active gate); decoder has long
                            // since passed it in normal playback. Skip
                            // the mix when it hasn't (right after a
                            // forward seek into the crossfade zone) —
                            // one missed crossfade per seek is fine.
                            if g_floor + 1 < decoded {
                                let gi0 = (g_floor as usize) * 2;
                                let gi1 = gi0 + 2;
                                let gl0 = unsafe { *samples[gi0].get() };
                                let gr0 = unsafe { *samples[gi0 + 1].get() };
                                let gl1 = unsafe { *samples[gi1].get() };
                                let gr1 = unsafe { *samples[gi1 + 1].get() };
                                let gl = gl0 + (gl1 - gl0) * g_frac;
                                let gr = gr0 + (gr1 - gr0) * g_frac;
                                let alpha = (dist / xfade_frames as f64) as f32;
                                l = alpha * l + (1.0 - alpha) * gl;
                                r = alpha * r + (1.0 - alpha) * gr;
                            }
                        }
                    }

                    // Cue-trigger seam crossfade. Same math as the loop
                    // crossfade above with (trigger_at, seek_to)
                    // substituted for (out, in). Window is
                    // [trigger_at − xfade_frames, trigger_at); ghost
                    // read comes from samples just before seek_to,
                    // i.e. the audio that NATURALLY leads into the cue.
                    // At α = 1 we play pure current-beat tail, at α = 0
                    // pure cue lead-in, so the post-fire frame at
                    // seek_to is consecutive with the ghost's last
                    // sample — no audible click on the jump.
                    if trigger_xfade_active {
                        let pt = pending_trigger.unwrap();
                        let dist = pt.trigger_at_frames as f64 - source_pos;
                        if dist > 0.0 && dist < xfade_frames as f64 {
                            let ghost_pos =
                                source_pos - pt.trigger_at_frames as f64 + pt.seek_to_frames as f64;
                            let g_floor = ghost_pos.floor() as u64;
                            let g_frac = (ghost_pos - g_floor as f64) as f32;
                            if g_floor + 1 < decoded {
                                let gi0 = (g_floor as usize) * 2;
                                let gi1 = gi0 + 2;
                                let gl0 = unsafe { *samples[gi0].get() };
                                let gr0 = unsafe { *samples[gi0 + 1].get() };
                                let gl1 = unsafe { *samples[gi1].get() };
                                let gr1 = unsafe { *samples[gi1 + 1].get() };
                                let gl = gl0 + (gl1 - gl0) * g_frac;
                                let gr = gr0 + (gr1 - gr0) * g_frac;
                                let alpha = (dist / xfade_frames as f64) as f32;
                                l = alpha * l + (1.0 - alpha) * gl;
                                r = alpha * r + (1.0 - alpha) * gr;
                            }
                        }
                    }

                    l *= volume;
                    r *= volume;
                    // Post-jump linear blend safety net. When the
                    // trigger crossfade window was overshot by a large
                    // cpal callback (rare, but happens on Windows under
                    // load), this blend from last_output → current
                    // sample hides the DC step. Runs only for
                    // post_jump_ramp_total frames after fire, then is a
                    // no-op until the next jump.
                    if post_jump_ramp_remaining > 0 && post_jump_ramp_total > 0 {
                        let alpha = (post_jump_ramp_total - post_jump_ramp_remaining) as f32
                            / post_jump_ramp_total as f32;
                        l = last_l * (1.0 - alpha) + l * alpha;
                        r = last_r * (1.0 - alpha) + r * alpha;
                        post_jump_ramp_remaining -= 1;
                    }
                    // Master envelope. Same per-frame slew used in the
                    // scrub branch; eliminates the play↔pause click.
                    l *= envelope_gain;
                    r *= envelope_gain;
                    if envelope_gain < target_gain {
                        envelope_gain = (envelope_gain + envelope_step).min(target_gain);
                    } else if envelope_gain > target_gain {
                        envelope_gain = (envelope_gain - envelope_step).max(target_gain);
                    }
                    if channel_count == 1 {
                        out[dst_off] = (l + r) * 0.5;
                    } else {
                        out[dst_off] = l;
                        out[dst_off + 1] = r;
                        for c in 2..channel_count {
                            out[dst_off + c] = 0.0;
                        }
                    }
                    let abs_l = l.abs();
                    let abs_r = r.abs();
                    if abs_l > peak_l_local { peak_l_local = abs_l; }
                    if abs_r > peak_r_local { peak_r_local = abs_r; }
                    last_l = l;
                    last_r = r;
                    source_pos += ratio;
                } else {
                    // Silence — either decoder underrun OR past-end.
                    for c in 0..channel_count {
                        out[dst_off + c] = 0.0;
                    }
                    last_l = 0.0;
                    last_r = 0.0;
                    // End-of-track advance. Two cases land here:
                    //   • src_floor >= total_frames — already past the end.
                    //   • decoded >= total_frames — decode is COMPLETE, but the
                    //     final real frame (total_frames − 1) can never satisfy
                    //     the `src_floor + 1 < decoded` interpolation gate above
                    //     (it needs decoded > total_frames), so it falls through
                    //     to silence here. Without advancing, the cursor sticks
                    //     at total_frames − 1 forever: the reporter never sees
                    //     cursor >= total, Ended never fires, and the UI hangs
                    //     "playing" at end-of-track. The single dropped frame
                    //     (~22 µs) is inaudible. A genuine live underrun
                    //     (decoded < total_frames) still waits rather than
                    //     advancing.
                    if src_floor >= total_frames || decoded >= total_frames {
                        // Past end: advance anyway so the reporter
                        // observes cursor >= total and fires Ended.
                        source_pos += ratio;
                        // Disarm any stale trigger so a future seek
                        // back inside the track + play doesn't fire a
                        // jump the user never asked for.
                        if pending_trigger.is_some() {
                            state_clone.pending_trigger.store(Arc::new(None));
                            pending_trigger = None;
                            trigger_xfade_active = false;
                        }
                    }
                    // Underrun case: don't advance; playback resumes
                    // from the same source position on the next call.
                }
            }

            // Cursor stays in source-frame units (integer rounded).
            // Sub-frame drift across callbacks is bounded by 1 source
            // frame, well below audible.
            state_clone
                .cursor
                .store(source_pos.round() as u64, Ordering::Release);
            state_clone.envelope_gain_bits.store(envelope_gain.to_bits(), Ordering::Release);
            state_clone.last_output_l_bits.store(last_l.to_bits(), Ordering::Release);
            state_clone.last_output_r_bits.store(last_r.to_bits(), Ordering::Release);
            state_clone.post_jump_ramp_frames.store(post_jump_ramp_remaining, Ordering::Release);
            // VU meter: merge per-callback peaks into the shared atomic
            // via fetch_max. Reporter swap(0)s on its next 50ms tick.
            state_clone.peak_l_bits.fetch_max(peak_l_local.to_bits(), Ordering::AcqRel);
            state_clone.peak_r_bits.fetch_max(peak_r_local.to_bits(), Ordering::AcqRel);
        },
        |err| {
            tracing::error!(?err, "audio stream error");
        },
        None,
    )?;
    Ok(stream)
}

// Suppress dead-code warning for Mutex import (reserved for a future
// multi-deck path that needs to lock the engine map).
#[allow(dead_code)]
type _MutexHint = Mutex<()>;
