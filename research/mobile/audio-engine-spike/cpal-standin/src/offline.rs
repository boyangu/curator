//! No sound device: the stream's callback is kept, and `render` calls it for
//! as many frames as asked. What the engine would have sent to a device
//! running at `CPAL_STANDIN_RATE` (48000 unless set) comes back as samples —
//! which is how its resampling is measured, on any machine.

use std::sync::Mutex;
use std::time::Instant;

use crate::{DataCallback, Error, ErrorCallback, StreamConfig};

pub const NAME: &str = "offline renderer";

struct Slot {
    channels: usize,
    data: DataCallback,
}

static SLOT: Mutex<Option<Slot>> = Mutex::new(None);

pub fn native_rate() -> Result<u32, Error> {
    Ok(std::env::var("CPAL_STANDIN_RATE").ok().and_then(|v| v.parse().ok()).unwrap_or(48_000))
}

pub fn now_ns() -> i64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as i64
}

pub struct Stream;

impl Stream {
    pub fn open(config: &StreamConfig, data: DataCallback, _error: ErrorCallback) -> Result<Self, Error> {
        *SLOT.lock().unwrap() = Some(Slot { channels: config.channels as usize, data });
        Ok(Stream)
    }

    pub fn play(&self) -> Result<(), Error> {
        Ok(())
    }

    pub fn pause(&self) -> Result<(), Error> {
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        *SLOT.lock().unwrap() = None;
    }
}

/// `frames` frames from the engine's callback, interleaved, in bursts of
/// `burst` frames as a device would ask for them.
pub fn render(frames: usize, burst: usize) -> Vec<f32> {
    let mut guard = SLOT.lock().unwrap();
    let Some(slot) = guard.as_mut() else { return Vec::new() };
    let mut out = vec![0.0f32; frames * slot.channels];
    for chunk in out.chunks_mut(burst.max(1) * slot.channels) {
        crate::run_callback(chunk, slot.channels, &mut slot.data);
    }
    out
}

pub fn stream_info() -> Option<crate::probe::StreamInfo> {
    None
}

pub fn presentation_ns(_frame: i64) -> Option<i64> {
    None
}

pub fn xruns() -> i32 {
    0
}
