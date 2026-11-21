//! AAudio (NDK, API 26+), bound by hand: one float output stream in
//! low-latency mode with a data callback. No Java, so it runs in a program
//! started from `adb shell`.

use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicPtr, AtomicU32, Ordering};
use std::sync::OnceLock;

use crate::{BufferSize, DataCallback, Error, ErrorCallback, StreamConfig};

pub const NAME: &str = "AAudio default output";

#[repr(C)]
pub struct AAudioStream {
    _private: [u8; 0],
}
#[repr(C)]
struct AAudioStreamBuilder {
    _private: [u8; 0],
}

const AAUDIO_OK: i32 = 0;
const AAUDIO_DIRECTION_OUTPUT: i32 = 0;
const AAUDIO_FORMAT_PCM_FLOAT: i32 = 2;
const AAUDIO_SHARING_MODE_EXCLUSIVE: i32 = 0;
const AAUDIO_SHARING_MODE_SHARED: i32 = 1;
const AAUDIO_PERFORMANCE_MODE_NONE: i32 = 10;
const AAUDIO_PERFORMANCE_MODE_POWER_SAVING: i32 = 11;
const AAUDIO_PERFORMANCE_MODE_LOW_LATENCY: i32 = 12;
const AAUDIO_CALLBACK_RESULT_CONTINUE: i32 = 0;
const CLOCK_MONOTONIC: i32 = 1;

type DataFn = extern "C" fn(stream: *mut AAudioStream, user: *mut c_void, audio: *mut c_void, frames: i32) -> i32;
type ErrorFn = extern "C" fn(stream: *mut AAudioStream, user: *mut c_void, error: i32);

#[repr(C)]
struct Timespec {
    tv_sec: i64,
    tv_nsec: i64,
}

#[link(name = "aaudio")]
extern "C" {
    fn AAudio_createStreamBuilder(builder: *mut *mut AAudioStreamBuilder) -> i32;
    fn AAudio_convertResultToText(result: i32) -> *const c_char;
    fn AAudioStreamBuilder_setDirection(builder: *mut AAudioStreamBuilder, direction: i32);
    fn AAudioStreamBuilder_setFormat(builder: *mut AAudioStreamBuilder, format: i32);
    fn AAudioStreamBuilder_setChannelCount(builder: *mut AAudioStreamBuilder, channels: i32);
    fn AAudioStreamBuilder_setSampleRate(builder: *mut AAudioStreamBuilder, rate: i32);
    fn AAudioStreamBuilder_setPerformanceMode(builder: *mut AAudioStreamBuilder, mode: i32);
    fn AAudioStreamBuilder_setSharingMode(builder: *mut AAudioStreamBuilder, mode: i32);
    fn AAudioStreamBuilder_setDataCallback(builder: *mut AAudioStreamBuilder, callback: DataFn, user: *mut c_void);
    fn AAudioStreamBuilder_setErrorCallback(builder: *mut AAudioStreamBuilder, callback: ErrorFn, user: *mut c_void);
    fn AAudioStreamBuilder_openStream(builder: *mut AAudioStreamBuilder, stream: *mut *mut AAudioStream) -> i32;
    fn AAudioStreamBuilder_delete(builder: *mut AAudioStreamBuilder) -> i32;
    fn AAudioStream_requestStart(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_requestPause(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_requestStop(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_close(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getSampleRate(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getChannelCount(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getFramesPerBurst(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getBufferSizeInFrames(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_setBufferSizeInFrames(stream: *mut AAudioStream, frames: i32) -> i32;
    fn AAudioStream_getBufferCapacityInFrames(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getPerformanceMode(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getSharingMode(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getXRunCount(stream: *mut AAudioStream) -> i32;
    fn AAudioStream_getTimestamp(stream: *mut AAudioStream, clock: i32, frame: *mut i64, time_ns: *mut i64) -> i32;
}

extern "C" {
    fn clock_gettime(clock: i32, ts: *mut Timespec) -> i32;
}

pub fn now_ns() -> i64 {
    let mut ts = Timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { clock_gettime(CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec * 1_000_000_000 + ts.tv_nsec
}

fn check(what: &str, result: i32) -> Result<(), Error> {
    if result >= AAUDIO_OK {
        return Ok(());
    }
    let text = unsafe { CStr::from_ptr(AAudio_convertResultToText(result)) }.to_string_lossy().into_owned();
    Err(Error(format!("{what}: {text} ({result})")))
}

// The open stream, for the probe's questions (info, timestamps, xruns).
static CURRENT: AtomicPtr<AAudioStream> = AtomicPtr::new(std::ptr::null_mut());
static CURRENT_RATE: AtomicU32 = AtomicU32::new(0);

struct Context {
    channels: usize,
    data: DataCallback,
    error: ErrorCallback,
}

extern "C" fn on_data(_stream: *mut AAudioStream, user: *mut c_void, audio: *mut c_void, frames: i32) -> i32 {
    let ctx = unsafe { &mut *(user as *mut Context) };
    let out = unsafe { std::slice::from_raw_parts_mut(audio as *mut f32, frames.max(0) as usize * ctx.channels) };
    crate::run_callback(out, ctx.channels, &mut ctx.data);
    AAUDIO_CALLBACK_RESULT_CONTINUE
}

extern "C" fn on_error(_stream: *mut AAudioStream, user: *mut c_void, error: i32) {
    let ctx = unsafe { &mut *(user as *mut Context) };
    let text = unsafe { CStr::from_ptr(AAudio_convertResultToText(error)) }.to_string_lossy().into_owned();
    (ctx.error)(Error(format!("AAudio stream error: {text} ({error})")));
}

unsafe fn builder(rate: Option<u32>, channels: i32) -> Result<*mut AAudioStreamBuilder, Error> {
    let mut b: *mut AAudioStreamBuilder = std::ptr::null_mut();
    check("AAudio_createStreamBuilder", AAudio_createStreamBuilder(&mut b))?;
    AAudioStreamBuilder_setDirection(b, AAUDIO_DIRECTION_OUTPUT);
    AAudioStreamBuilder_setFormat(b, AAUDIO_FORMAT_PCM_FLOAT);
    AAudioStreamBuilder_setChannelCount(b, channels);
    AAudioStreamBuilder_setPerformanceMode(b, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    // CPAL_STANDIN_EXCLUSIVE=1 asks for the device to ourselves (the lowest
    // latency a phone gives; refused where another app holds it).
    let exclusive = std::env::var("CPAL_STANDIN_EXCLUSIVE").map(|v| v == "1").unwrap_or(false);
    AAudioStreamBuilder_setSharingMode(b, if exclusive { AAUDIO_SHARING_MODE_EXCLUSIVE } else { AAUDIO_SHARING_MODE_SHARED });
    if let Some(r) = rate {
        AAudioStreamBuilder_setSampleRate(b, r as i32);
    }
    Ok(b)
}

/// The rate the device gives a low-latency stream that asks for none.
pub fn native_rate() -> Result<u32, Error> {
    static RATE: OnceLock<Result<u32, String>> = OnceLock::new();
    RATE.get_or_init(|| unsafe {
        let b = builder(None, 2).map_err(|e| e.0)?;
        let mut s: *mut AAudioStream = std::ptr::null_mut();
        let opened = check("AAudioStreamBuilder_openStream", AAudioStreamBuilder_openStream(b, &mut s));
        AAudioStreamBuilder_delete(b);
        opened.map_err(|e| e.0)?;
        let rate = AAudioStream_getSampleRate(s) as u32;
        AAudioStream_close(s);
        Ok(rate)
    })
    .clone()
    .map_err(Error)
}

pub struct Stream {
    stream: *mut AAudioStream,
    ctx: *mut Context,
}

impl Stream {
    pub fn open(config: &StreamConfig, data: DataCallback, error: ErrorCallback) -> Result<Self, Error> {
        unsafe {
            let ctx = Box::into_raw(Box::new(Context { channels: config.channels as usize, data, error }));
            let b = match builder(Some(config.sample_rate.0), config.channels as i32) {
                Ok(b) => b,
                Err(e) => {
                    drop(Box::from_raw(ctx));
                    return Err(e);
                }
            };
            AAudioStreamBuilder_setDataCallback(b, on_data, ctx as *mut c_void);
            AAudioStreamBuilder_setErrorCallback(b, on_error, ctx as *mut c_void);
            let mut s: *mut AAudioStream = std::ptr::null_mut();
            let opened = check("AAudioStreamBuilder_openStream", AAudioStreamBuilder_openStream(b, &mut s));
            AAudioStreamBuilder_delete(b);
            if let Err(e) = opened {
                drop(Box::from_raw(ctx));
                return Err(e);
            }
            if AAudioStream_getChannelCount(s) != config.channels as i32 {
                AAudioStream_close(s);
                drop(Box::from_raw(ctx));
                return Err(Error("AAudio opened another channel count than asked".into()));
            }
            // The engine's request, or two bursts: the usual low-latency size
            // (one to play, one in hand).
            let burst = AAudioStream_getFramesPerBurst(s);
            let want = match config.buffer_size {
                BufferSize::Fixed(frames) => frames as i32,
                BufferSize::Default => burst * 2,
            };
            AAudioStream_setBufferSizeInFrames(s, want);
            CURRENT_RATE.store(AAudioStream_getSampleRate(s) as u32, Ordering::Release);
            CURRENT.store(s, Ordering::Release);
            Ok(Stream { stream: s, ctx })
        }
    }

    pub fn play(&self) -> Result<(), Error> {
        check("AAudioStream_requestStart", unsafe { AAudioStream_requestStart(self.stream) })
    }

    pub fn pause(&self) -> Result<(), Error> {
        check("AAudioStream_requestPause", unsafe { AAudioStream_requestPause(self.stream) })
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            let _ = CURRENT.compare_exchange(self.stream, std::ptr::null_mut(), Ordering::AcqRel, Ordering::Acquire);
            AAudioStream_requestStop(self.stream);
            // close() returns once no callback is running.
            AAudioStream_close(self.stream);
            drop(Box::from_raw(self.ctx));
        }
    }
}

fn mode_name(mode: i32) -> String {
    match mode {
        AAUDIO_PERFORMANCE_MODE_NONE => "none".into(),
        AAUDIO_PERFORMANCE_MODE_POWER_SAVING => "power saving".into(),
        AAUDIO_PERFORMANCE_MODE_LOW_LATENCY => "low latency".into(),
        other => format!("{other}"),
    }
}

pub fn stream_info() -> Option<crate::probe::StreamInfo> {
    let s = CURRENT.load(Ordering::Acquire);
    if s.is_null() {
        return None;
    }
    unsafe {
        Some(crate::probe::StreamInfo {
            backend: "aaudio",
            sample_rate: AAudioStream_getSampleRate(s) as u32,
            channels: AAudioStream_getChannelCount(s) as u32,
            frames_per_burst: AAudioStream_getFramesPerBurst(s),
            buffer_size_frames: AAudioStream_getBufferSizeInFrames(s),
            buffer_capacity_frames: AAudioStream_getBufferCapacityInFrames(s),
            performance_mode: mode_name(AAudioStream_getPerformanceMode(s)),
            sharing_mode: if AAudioStream_getSharingMode(s) == AAUDIO_SHARING_MODE_EXCLUSIVE { "exclusive".into() } else { "shared".into() },
        })
    }
}

pub fn presentation_ns(frame: i64) -> Option<i64> {
    let s = CURRENT.load(Ordering::Acquire);
    let rate = CURRENT_RATE.load(Ordering::Acquire) as i64;
    if s.is_null() || rate == 0 {
        return None;
    }
    let (mut at_frame, mut at_ns) = (0i64, 0i64);
    if unsafe { AAudioStream_getTimestamp(s, CLOCK_MONOTONIC, &mut at_frame, &mut at_ns) } != AAUDIO_OK {
        return None;
    }
    Some(at_ns + (frame - at_frame) * 1_000_000_000 / rate)
}

pub fn xruns() -> i32 {
    let s = CURRENT.load(Ordering::Acquire);
    if s.is_null() { 0 } else { unsafe { AAudioStream_getXRunCount(s) } }
}
