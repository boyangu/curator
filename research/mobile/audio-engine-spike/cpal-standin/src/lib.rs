//! The part of cpal the Curator audio engine uses (apps/audio/src/engine.rs:
//! default host and device, the supported / default output config, one f32
//! output stream with a data callback), so that file compiles and runs
//! unchanged where cpal itself cannot: a program started from `adb shell`
//! has no Java VM, which cpal's Android backend needs.
//!
//! Two backends:
//!   - Android: AAudio through the NDK's C API (aaudio.rs), low-latency mode;
//!   - elsewhere: nothing plays; the caller pulls frames by hand
//!     (`offline::render`), which is how the resampler is measured.
//!
//! And the spike's measurement hooks (`probe`): every callback is timed, and
//! the first audible frame after `probe::arm()` is recorded with its
//! position in the stream, so the time from a command to the speaker can be
//! read off the device's own timestamps.

use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

#[cfg(target_os = "android")]
mod aaudio;
#[cfg(target_os = "android")]
use aaudio as backend;

#[cfg(not(target_os = "android"))]
pub mod offline;
#[cfg(not(target_os = "android"))]
use offline as backend;

#[derive(Debug)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SampleRate(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SampleFormat {
    F32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BufferSize {
    Default,
    Fixed(u32),
}

#[derive(Clone, Debug)]
pub struct StreamConfig {
    pub channels: u16,
    pub sample_rate: SampleRate,
    pub buffer_size: BufferSize,
}

#[derive(Clone, Debug)]
pub struct SupportedStreamConfig {
    channels: u16,
    sample_rate: SampleRate,
}

impl SupportedStreamConfig {
    pub fn sample_format(&self) -> SampleFormat {
        SampleFormat::F32
    }
    pub fn sample_rate(&self) -> SampleRate {
        self.sample_rate
    }
    pub fn channels(&self) -> u16 {
        self.channels
    }
}

impl From<SupportedStreamConfig> for StreamConfig {
    fn from(c: SupportedStreamConfig) -> Self {
        StreamConfig { channels: c.channels, sample_rate: c.sample_rate, buffer_size: BufferSize::Default }
    }
}

#[derive(Clone, Debug)]
pub struct SupportedStreamConfigRange {
    channels: u16,
    min: SampleRate,
    max: SampleRate,
}

impl SupportedStreamConfigRange {
    pub fn min_sample_rate(&self) -> SampleRate {
        self.min
    }
    pub fn max_sample_rate(&self) -> SampleRate {
        self.max
    }
    pub fn sample_format(&self) -> SampleFormat {
        SampleFormat::F32
    }
    pub fn with_sample_rate(self, rate: SampleRate) -> SupportedStreamConfig {
        SupportedStreamConfig { channels: self.channels, sample_rate: rate }
    }
}

pub struct OutputCallbackInfo(());

pub struct Host;
pub struct Device;

pub struct Stream {
    inner: backend::Stream,
}

pub fn default_host() -> Host {
    Host
}

pub(crate) type DataCallback = Box<dyn FnMut(&mut [f32], &OutputCallbackInfo) + Send + 'static>;
pub(crate) type ErrorCallback = Box<dyn FnMut(Error) + Send + 'static>;

pub mod traits {
    use super::*;

    pub trait HostTrait {
        fn default_output_device(&self) -> Option<Device>;
    }

    pub trait DeviceTrait {
        fn name(&self) -> Result<String, Error>;
        fn supported_output_configs(&self) -> Result<std::vec::IntoIter<SupportedStreamConfigRange>, Error>;
        fn default_output_config(&self) -> Result<SupportedStreamConfig, Error>;
        fn build_output_stream<D, E>(&self, config: &StreamConfig, data: D, error: E, timeout: Option<Duration>) -> Result<Stream, Error>
        where
            D: FnMut(&mut [f32], &OutputCallbackInfo) + Send + 'static,
            E: FnMut(Error) + Send + 'static;
    }

    pub trait StreamTrait {
        fn play(&self) -> Result<(), Error>;
        fn pause(&self) -> Result<(), Error>;
    }

    impl HostTrait for Host {
        fn default_output_device(&self) -> Option<Device> {
            Some(Device)
        }
    }

    impl DeviceTrait for Device {
        fn name(&self) -> Result<String, Error> {
            Ok(backend::NAME.to_string())
        }

        // CPAL_STANDIN_RATES=any: every rate is offered, so the engine opens
        // the stream at the track's rate and the system resamples. Otherwise
        // only the device's own rate, and the engine's callback resamples.
        fn supported_output_configs(&self) -> Result<std::vec::IntoIter<SupportedStreamConfigRange>, Error> {
            let native = backend::native_rate()?;
            let any = std::env::var("CPAL_STANDIN_RATES").map(|v| v == "any").unwrap_or(false);
            let (min, max) = if any { (8_000, 192_000) } else { (native, native) };
            Ok(vec![SupportedStreamConfigRange { channels: 2, min: SampleRate(min), max: SampleRate(max) }].into_iter())
        }

        fn default_output_config(&self) -> Result<SupportedStreamConfig, Error> {
            Ok(SupportedStreamConfig { channels: 2, sample_rate: SampleRate(backend::native_rate()?) })
        }

        fn build_output_stream<D, E>(&self, config: &StreamConfig, data: D, error: E, _timeout: Option<Duration>) -> Result<Stream, Error>
        where
            D: FnMut(&mut [f32], &OutputCallbackInfo) + Send + 'static,
            E: FnMut(Error) + Send + 'static,
        {
            probe::reset();
            Ok(Stream { inner: backend::Stream::open(config, Box::new(data), Box::new(error))? })
        }
    }

    impl StreamTrait for Stream {
        fn play(&self) -> Result<(), Error> {
            self.inner.play()
        }
        fn pause(&self) -> Result<(), Error> {
            self.inner.pause()
        }
    }
}

// ── measurement ─────────────────────────────────────────────────────────────

static ARMED: AtomicBool = AtomicBool::new(false);
static ARM_NS: AtomicI64 = AtomicI64::new(0);
static HIT_READY: AtomicBool = AtomicBool::new(false);
static HIT_CALLBACK_NS: AtomicI64 = AtomicI64::new(0);
static HIT_FRAME: AtomicI64 = AtomicI64::new(0);
static FRAMES: AtomicI64 = AtomicI64::new(0);
static CALLBACKS: AtomicU64 = AtomicU64::new(0);
static CALLBACK_NS_MAX: AtomicU64 = AtomicU64::new(0);
static CALLBACK_NS_SUM: AtomicU64 = AtomicU64::new(0);
static FRAMES_MAX: AtomicU64 = AtomicU64::new(0);

/// One callback of the engine's, timed, and watched for the first audible
/// frame when armed. Atomics only: this runs on the audio thread.
pub(crate) fn run_callback(out: &mut [f32], channels: usize, cb: &mut DataCallback) {
    let t0 = probe::now_ns();
    cb(out, &OutputCallbackInfo(()));
    let t1 = probe::now_ns();
    let frames = (out.len() / channels.max(1)) as i64;
    let before = FRAMES.fetch_add(frames, Ordering::AcqRel);
    if ARMED.load(Ordering::Acquire) {
        if let Some(i) = out.iter().position(|s| s.abs() > 1e-7) {
            HIT_FRAME.store(before + (i / channels.max(1)) as i64, Ordering::Release);
            HIT_CALLBACK_NS.store(t0, Ordering::Release);
            ARMED.store(false, Ordering::Release);
            HIT_READY.store(true, Ordering::Release);
        }
    }
    let ns = (t1 - t0).max(0) as u64;
    CALLBACKS.fetch_add(1, Ordering::Relaxed);
    CALLBACK_NS_SUM.fetch_add(ns, Ordering::Relaxed);
    CALLBACK_NS_MAX.fetch_max(ns, Ordering::Relaxed);
    FRAMES_MAX.fetch_max(frames as u64, Ordering::Relaxed);
}

pub mod probe {
    use super::*;

    #[derive(Debug, Clone)]
    pub struct StreamInfo {
        pub backend: &'static str,
        pub sample_rate: u32,
        pub channels: u32,
        pub frames_per_burst: i32,
        pub buffer_size_frames: i32,
        pub buffer_capacity_frames: i32,
        pub performance_mode: String,
        pub sharing_mode: String,
    }

    #[derive(Debug, Clone, Copy)]
    pub struct Hit {
        /// When `arm()` was called.
        pub arm_ns: i64,
        /// When the callback that wrote the first audible frame began.
        pub callback_ns: i64,
        /// That frame's position in the stream.
        pub frame: i64,
    }

    #[derive(Debug, Clone, Copy)]
    pub struct Stats {
        pub callbacks: u64,
        pub frames: i64,
        pub callback_ns_max: u64,
        pub callback_ns_mean: u64,
        pub frames_per_callback_max: u64,
        pub xruns: i32,
    }

    /// CLOCK_MONOTONIC, the clock AAudio's timestamps are on.
    pub fn now_ns() -> i64 {
        backend::now_ns()
    }

    pub fn stream_info() -> Option<StreamInfo> {
        backend::stream_info()
    }

    /// The next audible frame the engine writes is recorded.
    pub fn arm() {
        HIT_READY.store(false, Ordering::Release);
        ARM_NS.store(now_ns(), Ordering::Release);
        ARMED.store(true, Ordering::Release);
    }

    pub fn take_hit() -> Option<Hit> {
        if !HIT_READY.swap(false, Ordering::AcqRel) {
            return None;
        }
        Some(Hit { arm_ns: ARM_NS.load(Ordering::Acquire), callback_ns: HIT_CALLBACK_NS.load(Ordering::Acquire), frame: HIT_FRAME.load(Ordering::Acquire) })
    }

    /// When the device says `frame` reaches (or reached) the output, from
    /// its newest timestamp. None until the stream has one.
    pub fn presentation_ns(frame: i64) -> Option<i64> {
        backend::presentation_ns(frame)
    }

    pub fn stats() -> Stats {
        let callbacks = CALLBACKS.load(Ordering::Relaxed);
        Stats {
            callbacks,
            frames: FRAMES.load(Ordering::Relaxed),
            callback_ns_max: CALLBACK_NS_MAX.load(Ordering::Relaxed),
            callback_ns_mean: if callbacks > 0 { CALLBACK_NS_SUM.load(Ordering::Relaxed) / callbacks } else { 0 },
            frames_per_callback_max: FRAMES_MAX.load(Ordering::Relaxed),
            xruns: backend::xruns(),
        }
    }

    /// Clears the callback statistics (not the frame position).
    pub fn reset_stats() {
        CALLBACKS.store(0, Ordering::Relaxed);
        CALLBACK_NS_SUM.store(0, Ordering::Relaxed);
        CALLBACK_NS_MAX.store(0, Ordering::Relaxed);
        FRAMES_MAX.store(0, Ordering::Relaxed);
    }

    pub(crate) fn reset() {
        reset_stats();
        FRAMES.store(0, Ordering::Release);
        ARMED.store(false, Ordering::Release);
        HIT_READY.store(false, Ordering::Release);
    }
}
