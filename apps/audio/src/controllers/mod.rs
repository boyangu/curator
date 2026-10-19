//! Controller layer — USB-MIDI device I/O.
//!
//! Per [planning/tech/controllers-pioneer.md], v1 routes all controller
//! actions through `controller_event` to the renderer; the renderer's
//! existing DeckController dispatches them. LED state lives here (PRD
//! mandate) so pad-press lights without a JS round-trip; only the
//! audio action takes the renderer path.
//!
//! Module structure (v1 — MIDI only; HID jog input deferred to per-device
//! [P2] roadmap, see PRD §1):
//!
//!   controllers/
//!     mod.rs         — this file. Manager: holds current mapping + cue
//!                      table + connected devices; spawns the FLX10
//!                      driver thread.
//!     mapping.rs     — Mapping table struct + Action enum, JSON loader.
//!     flx10/
//!       mod.rs       — DDJ-FLX10 device driver entry point + constants.
//!       midi.rs      — MIDI parser (notes/CC → Action) + LED writer.
//!       leds.rs      — Derives LED vector from engine state.
//!       hid.rs       — [P2] HID jog input parser. Not created in v1.

pub mod mapping;
pub mod flx10;

use parking_lot::RwLock;
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread;

use crate::engine::EngineStateHandle;
use crate::protocol::{ControllerCueEntry, Event};
use mapping::Mapping;

/// Shared controller state. Cheap to clone (Arc internally) — handed to
/// the FLX10 driver thread, the RPC dispatch in main.rs, and the LED
/// renderer.
#[derive(Clone)]
pub struct ControllerManager {
    inner: Arc<Inner>,
}

struct Inner {
    /// Active mapping per device name. v1: `"DDJ-FLX10"` only.
    /// Populated by the `controller_set_mapping` RPC at boot.
    mappings: RwLock<Vec<Mapping>>,
    /// Loaded track's hot-cue table (deck 1 only in v1).
    /// Populated by `controller_set_cues` at track-load time.
    cues: RwLock<Vec<ControllerCueEntry>>,
    /// "Is a track currently loaded" — toggled by
    /// `controller_set_track_loaded`. When false, the LED renderer
    /// darkens cue pads + play LED but keeps the cue table cached.
    track_loaded: RwLock<bool>,
    /// Lock-free read-only engine handle for the LED renderer's live
    /// playing / loop-active queries.
    engine: EngineStateHandle,
    /// Event sender to the writer thread. The driver thread emits
    /// controller_connected / controller_disconnected / controller_event
    /// through this.
    event_tx: Sender<Event>,
}

impl ControllerManager {
    pub fn new(engine: EngineStateHandle, event_tx: Sender<Event>) -> Self {
        Self {
            inner: Arc::new(Inner {
                mappings: RwLock::new(Vec::new()),
                cues: RwLock::new(Vec::new()),
                track_loaded: RwLock::new(false),
                engine,
                event_tx,
            }),
        }
    }

    /// Snapshot of the cue table for the LED renderer.
    pub fn cues_snapshot(&self) -> Vec<ControllerCueEntry> {
        // ControllerCueEntry isn't Clone (it lives on the param side of
        // the protocol). Rebuild by hand.
        self.inner
            .cues
            .read()
            .iter()
            .map(|c| ControllerCueEntry {
                slot: c.slot,
                position_sec: c.position_sec,
                length_sec: c.length_sec,
                color: c.color.clone(),
            })
            .collect()
    }

    /// Current track-loaded flag — true between `controller_set_track_loaded(true)`
    /// and the matching `false`.
    pub fn track_loaded(&self) -> bool {
        *self.inner.track_loaded.read()
    }

    /// Lock-free read of engine.playing() via the shared state handle.
    pub fn engine_playing(&self) -> bool {
        self.inner.engine.playing()
    }

    /// Lock-free read of "loop region active" — drives the 4-BEAT LOOP
    /// LED indicator.
    pub fn engine_loop_active(&self) -> bool {
        self.inner.engine.loop_active()
    }

    /// Stash a mapping. Replaces any previously stored mapping with the
    /// same `device` name. Idempotent; the dev-time overlay calls this
    /// to retune without restart.
    pub fn set_mapping(&self, mapping: Mapping) {
        let mut mappings = self.inner.mappings.write();
        mappings.retain(|m| m.device != mapping.device);
        tracing::info!(
            device = %mapping.device,
            version = ?mapping.version,
            rows = mapping.rows.len(),
            "controller mapping loaded"
        );
        mappings.push(mapping);
    }

    /// Replace the cue table. The LED renderer's next tick (~50 ms)
    /// picks it up and writes any changed pad colors.
    pub fn set_cues(&self, cues: Vec<ControllerCueEntry>) {
        // Log the cues so we can verify renderer → sidecar plumbing is
        // shipping colors. Only the first 8 (hot-cue pads) matter for
        // LED display, but log all of them so memory cues aren't a
        // silent surprise.
        for c in &cues {
            tracing::info!(
                slot = c.slot,
                position_sec = c.position_sec,
                color = ?c.color,
                "controller cue entry",
            );
        }
        let mut entries = self.inner.cues.write();
        tracing::info!(count = cues.len(), "controller cue table updated");
        *entries = cues;
    }

    /// Set loaded / unloaded state. False clears the play LED + dims
    /// cue pads but keeps the cue table cached so a subsequent re-load
    /// of the same track doesn't need to re-push cues.
    pub fn set_track_loaded(&self, loaded: bool) {
        let mut flag = self.inner.track_loaded.write();
        *flag = loaded;
        // TODO controllers-pioneer LED: refresh LEDs.
    }

    /// Look up a mapping by device name. Returns a clone — call sites
    /// usually do one lookup then iterate locally.
    pub fn mapping_for(&self, device: &str) -> Option<Mapping> {
        self.inner.mappings.read().iter().find(|m| m.device == device).cloned()
    }

    /// Spawn the FLX10 driver thread. Returns immediately; the thread
    /// owns its own MIDI port + LED state and emits Events as MIDI
    /// arrives. Polls midir's port list at ~1 Hz to detect connect /
    /// disconnect (midir has no native hot-plug callback).
    pub fn spawn_flx10_driver(&self) {
        let mgr = self.clone();
        thread::Builder::new()
            .name("controller-flx10".into())
            .spawn(move || flx10::run(mgr))
            .expect("spawning controller-flx10 thread should not fail");
    }

    /// Returns the event sender so the driver thread can push Events
    /// onto the writer pipeline.
    pub fn event_tx(&self) -> Sender<Event> {
        self.inner.event_tx.clone()
    }
}
