//! Mapping table — wire-format JSON → typed `Action` enum.
//!
//! The TS side of this contract lives at
//! `packages/shared/src/controller-mapping.ts`. Both ends share the JSON
//! schema; the renderer ships a JSON object via `controller_set_mapping`,
//! the sidecar deserialises into `Mapping` here.
//!
//! Each table row binds a *trigger* (a MIDI message pattern) to an
//! *action* (the engine call to make or the renderer event to push).

use serde::Deserialize;

/// MIDI trigger pattern. Matches either Note On (any velocity > 0) or
/// CC. The status byte uses the full 8-bit value (e.g. 0x90 for "Note On
/// channel 1"); note/cc number is 0..127.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Trigger {
    /// Inbound Note On with non-zero velocity. Note Off (or vel=0) is
    /// handled separately for buttons that need press/release semantics
    /// (jog touch, SHIFT modifier).
    NoteOn { status: u8, note: u8 },
    /// Inbound Note On *with* vel=0 OR Note Off. Used for releases that
    /// the controller emits.
    NoteOff { status: u8, note: u8 },
    /// Inbound CC message. Value is the 7-bit data byte; downstream
    /// actions decide how to interpret it (delta, position, …).
    ControlChange { status: u8, cc: u8 },
}

/// What to do when a trigger fires.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    // ─── Audio-affecting — sidecar dispatches directly to engine ──────────
    /// Trigger a cue from the loaded cue table. `slot` is 0-indexed
    /// matching the FLX10's pads 1-8.
    CueTrigger { slot: u8 },
    /// Phase-preserving beat-jump by N beats (signed).
    BeatJump { delta: i32 },
    /// Mark loop in at current playhead.
    LoopIn,
    /// Activate loop from armed loop-in to current playhead.
    LoopOut,
    /// N-beat loop from current playhead (toggles exit when already active).
    LoopNBeats { n: u8 },
    /// Halve active loop length.
    LoopHalve,
    /// Double active loop length.
    LoopDouble,
    /// Toggle play / pause.
    PlayPause,
    /// Jog motion delta — typically wired from HID inbound (high-res)
    /// in v1; the MIDI CC fallback (low-res) can target the same action.
    /// Interpretation: signed tick delta, applied to scrub target.
    ScrubMotion,
    /// Jog touch on/off — wired to engine scrub_begin / scrub_end.
    ScrubTouch,

    // ─── Renderer-bound — sidecar emits ControllerEvent ───────────────────
    /// Browse rotary turn. Value byte read as signed delta.
    BrowseRotate,
    /// Browse rotary press / centre click.
    BrowsePress,
    /// BACK button — focus pane toggle (renderer-side dispatch).
    Back,
    /// VIEW button — toggle player footer small/big.
    View,
    /// SHIFT modifier. Updates internal flag so other actions can pick
    /// up "is shift held" at trigger time.
    Shift,
}

/// One row of the mapping table — bind a trigger to an action.
#[derive(Debug, Clone, Deserialize)]
pub struct MappingRow {
    pub trigger: Trigger,
    pub action: Action,
    /// Optional human label for the dev-overlay / logs. Metadata only
    /// — preserved through the JSON round-trip so a future dev-overlay
    /// can render rows by label.
    #[serde(default)]
    #[allow(dead_code)]
    pub label: Option<String>,
    /// When set, this binding only fires while the SHIFT modifier is held.
    #[serde(default)]
    pub shift: bool,
}

/// Full per-device mapping table. The renderer ships this via
/// `controller_set_mapping`; the sidecar holds the latest one per device
/// name.
#[derive(Debug, Clone, Deserialize)]
pub struct Mapping {
    /// Curator's canonical device name (e.g. "DDJ-FLX10").
    pub device: String,
    /// Mapping data version — incremented when the TS source changes.
    /// Logged on `controller_connected` against the firmware reported by
    /// the device; mismatch is a warning, not fatal.
    #[serde(default)]
    pub version: Option<String>,
    /// FLX10 firmware version the mapping was authored against.
    /// Metadata only — preserved so a future logger can flag mismatch
    /// against the controller's identity-reply firmware string.
    #[serde(default)]
    #[allow(dead_code)]
    pub firmware_tested: Option<String>,
    /// The binding rows.
    pub rows: Vec<MappingRow>,
}
