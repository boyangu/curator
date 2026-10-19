//! Wire format for the JSON-RPC channel with the Node host.
//!
//! One JSON object per line, both directions. Same shape as the Python
//! sidecars (apps/analyzer, apps/rekordbox) so the Node host code in
//! apps/core/src/analyzer/sidecar.ts can be cloned with minimal changes.
//!
//!   Node → sidecar:
//!     {"id": 42, "method": "load",         "params": {"path": "..."}}
//!     {"id": 43, "method": "play"}
//!     {"id": 44, "method": "pause"}
//!     {"id": 45, "method": "seek",         "params": {"seconds": 12.5}}
//!     {"id": 46, "method": "set_volume",   "params": {"volume": 0.7}}
//!     {"id": 47, "method": "position"}
//!     {"id": 48, "method": "stop"}
//!     {"id": 49, "method": "shutdown"}
//!     {"id": 50, "method": "scrub_begin",  "params": {"seconds": 12.5}}  // params optional; omit to keep cursor
//!     {"id": 51, "method": "scrub_to",     "params": {"seconds": 87.2}}
//!     {"id": 52, "method": "scrub_end",    "params": {"final_seconds": 87.2, "resume_playing": true}}
//!     {"id": 53, "method": "controller_set_mapping",        "params": {"device": "flx10", "mapping_json": {...}}}
//!     {"id": 54, "method": "controller_set_cues",           "params": {"cues": [{"slot": 0, "position_sec": 32.0, "length_sec": null, "color": null}, ...]}}
//!     {"id": 55, "method": "controller_set_track_loaded",   "params": {"loaded": true}}
//!     {"id": 56, "method": "controller_status"}
//!     {"id": 57, "method": "arm_trigger",  "params": {"trigger_at_sec": 12.5, "seek_to_sec": 32.0}}  // both null = clear
//!     {"id": 58, "method": "seek_with_xfade", "params": {"seconds": 32.0}}  // crossfaded seek (no hard-cut click)
//!     {"id": 59, "method": "set_beatgrid", "params": {"beats": [0.42, 0.92, ...]}}  // seconds, ascending; [] = clear
//!     {"id": 60, "method": "jump_beats",   "params": {"delta_beats": -4}}  // phase-preserving beat jump
//!
//!   sidecar → Node:
//!     {"id": 42, "result": {"duration": 331.7, "sample_rate": 44100, "channels": 2}}
//!     {"id": 42, "error":  {"kind": "decode", "message": "..."}}
//!     {"event": "state_changed", "position": 12.5, "playing": true, "peak_l": 0.43, "peak_r": 0.51}
//!     {"event": "ended"}
//!     {"event": "trigger_fired", "position": 32.0}
//!     {"event": "sidecar_ready"}
//!     {"event": "controller_connected",    "model": "DDJ-FLX10", "firmware": "1.04"}
//!     {"event": "controller_disconnected", "model": "DDJ-FLX10"}
//!     {"event": "controller_event", "action": {"kind": "browse", "delta": 1}}
//!     {"event": "controller_event", "action": {"kind": "back"}}
//!     {"event": "controller_event", "action": {"kind": "cue_trigger", "slot": 3}}
//!     {"event": "controller_event", "action": {"kind": "beat_jump", "delta": -4}}
//!     {"event": "controller_event", "action": {"kind": "shift", "held": true}}
//!     {"event": "controller_event", "action": {"kind": "unmapped", "raw": [144, 18, 127]}}
//!
//! `id` correlates request ↔ response. Events have no `id`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Result {
        id: u64,
        result: serde_json::Value,
    },
    Error {
        id: u64,
        error: RpcError,
    },
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    /// One of: "decode", "load", "play", "seek", "internal", "io".
    /// Mirrors the Python sidecar error taxonomy so the Node host can map
    /// it into typed Errors uniformly.
    pub kind: String,
    pub message: String,
}

/// Notification (no `id` — fire-and-forget event from sidecar to Node).
///
/// Controller variants are scaffolded for v1 — emit sites land once the
/// MIDI/HID threads wire up. The `dead_code` allow keeps "variant never
/// constructed" warnings quiet during scaffolding.
#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(tag = "event")]
#[serde(rename_all = "snake_case")]
pub enum Event {
    /// Periodic position update + transport flag. Emitted at ~20Hz while
    /// playing; matches the renderer's 50ms scheduler tick so the deck's
    /// quantize/loop logic stays responsive.
    ///
    /// `peak_l` / `peak_r` are the post-volume, post-envelope max-abs
    /// sample values observed by the audio callback over the interval
    /// since the last tick (reporter atomically swaps them back to 0 on
    /// each read). Range [0, 1+] — clipping is possible if a track's
    /// own peak combined with user volume pushes the mix above 1. The
    /// renderer's VU meter consumes these to drive bar fill + peak-hold.
    /// Synchronous emissions (play/pause/seek edge events) report 0.0
    /// for both, since they don't measure a real audio interval; the
    /// next reporter tick refreshes from the live atomic.
    StateChanged { position: f64, playing: bool, peak_l: f32, peak_r: f32 },
    /// Playback reached the end of the decoded buffer. Node host advances
    /// the queue. Fires exactly once per natural end.
    Ended,
    /// A previously-armed cue trigger has fired. The audio callback has
    /// already jumped the cursor to `position` sample-accurately and
    /// applied a 10ms linear crossfade across the seam — this event is
    /// purely a heads-up so the renderer can clear UI flash state
    /// without waiting for the next StateChanged tick. Emitted by the
    /// reporter thread on the tick AFTER the callback flipped the
    /// `trigger_just_fired` flag (worst case ~50ms latency vs. the
    /// audible fire; the audio itself is already perfect).
    TriggerFired { position: f64 },
    /// Emitted once at sidecar boot (and on every crash respawn) AFTER
    /// the engine + controller threads are fully initialised and ready
    /// to accept RPCs. The renderer subscribes and re-pushes the
    /// current track / cue list / play state / loop region so a crash
    /// recovery preserves both audio state AND controller LED state.
    /// See planning/tech/controllers-pioneer.md "Sidecar respawn LED
    /// resync" for rationale.
    SidecarReady,
    /// A supported controller was just enumerated on USB. `model` is the
    /// canonical Curator name (e.g. "DDJ-FLX10"); `firmware` is the
    /// version string if the controller answered a universal-identity
    /// request, else None. Renderer surfaces this in Settings → Player
    /// → Controllers.
    ControllerConnected { model: String, firmware: Option<String> },
    /// Controller disappeared from USB enumeration. Sidecar has already
    /// dropped the MIDI/HID handles by the time this fires.
    ControllerDisconnected { model: String },
    /// A controller-originated action the renderer needs to handle.
    /// v1 ships ALL actions (audio-affecting too) through this channel
    /// so the renderer's existing DeckController + player methods can
    /// dispatch them — see planning/tech/controllers-pioneer.md
    /// "MIDI thread" for why we picked this over sidecar-direct.
    ControllerEvent { action: ControllerAction },
}

/// Typed controller action — discriminated by `kind`, with payload
/// fields flat for ergonomic wire format. Matches the TS `ControllerAction`
/// in packages/shared/src/controller-mapping.ts.
#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ControllerAction {
    // ─── Renderer-bound ────────────────────────────────────────────────
    /// Browse rotary turn — signed delta (positive = clockwise = step
    /// selection down per PRD navigation table; renderer may flip sign
    /// per Open item §3).
    Browse { delta: i32 },
    /// Browse rotary press / centre click.
    BrowsePress,
    /// BACK button.
    Back,
    /// VIEW button.
    View,
    /// SHIFT button state change. `held = true` on press, `false` on release.
    Shift { held: bool },
    /// MIDI surface we have no mapping for. `raw` carries the bytes for
    /// the dev-time mapping overlay.
    Unmapped { raw: Vec<u8> },

    // ─── Audio-affecting (renderer dispatches via DeckController) ───────
    /// Fire stored cue at slot. v1: trigger-only (set/delete deferred to
    /// player-cues).
    CueTrigger { slot: u8 },
    /// Phase-preserving beat-jump.
    BeatJump { delta: i32 },
    /// Mark loop in.
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
}

// ─── Request param types (deserialized per-method on dispatch) ────────────

#[derive(Debug, Deserialize)]
pub struct LoadParams {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct SeekParams {
    pub seconds: f64,
}

#[derive(Debug, Deserialize)]
pub struct VolumeParams {
    pub volume: f32,
}

/// Set or clear the active loop region. Both fields null = clear the loop.
/// Both fields set + out_sec > in_sec = activate the loop. The engine
/// wraps `cursor` back to `in_sec` sample-accurately inside the audio
/// callback the moment cursor crosses `out_sec` — no IPC roundtrip,
/// no inter-callback play-through, no seam click from late wrap.
#[derive(Debug, Deserialize)]
pub struct LoopParams {
    pub in_sec: Option<f64>,
    pub out_sec: Option<f64>,
}

/// Arm a sample-accurate quantized cue trigger. Both fields null = clear.
/// Both set + trigger_at_sec strictly greater than current cursor position
/// = audio callback jumps cursor from `trigger_at_sec` to `seek_to_sec`
/// the instant it would step past `trigger_at_sec`, with a 10ms linear
/// crossfade across the seam (same crossfade as the loop wrap). Half-
/// open semantics: the source frame AT `trigger_at_sec` becomes the
/// FIRST frame of the cue, mirroring `[in, out)` on loops. Anything
/// malformed (negative, only one bound set, trigger already past
/// cursor) clears the trigger.
#[derive(Debug, Deserialize)]
pub struct TriggerParams {
    pub trigger_at_sec: Option<f64>,
    pub seek_to_sec: Option<f64>,
}

/// Replace the loaded track's beatgrid — ascending beat times in seconds
/// on the source-track timeline. Empty array clears. The renderer pushes
/// this after every `load` (grids are per-track) and again whenever the
/// current track's analysis arrives or flips source (curator ↔ rekordbox
/// grid). The engine sanitizes on receipt; a malformed grid degrades to
/// "no grid" rather than erroring.
#[derive(Debug, Deserialize)]
pub struct SetBeatgridParams {
    pub beats: Vec<f64>,
}

/// Phase-preserving beat jump by `delta_beats` grid-beats (negative =
/// backward, fractional allowed). The engine computes the landing from
/// its own authoritative cursor + beatgrid and de-clicks with the same
/// 10 ms crossfade the cue path uses; if the playhead is inside an
/// active native loop, the loop region is translated with it.
#[derive(Debug, Deserialize)]
pub struct JumpBeatsParams {
    pub delta_beats: f64,
}

/// Optional snap-to-target on scrub entry. When `seconds` is provided
/// the engine jumps the cursor (and the scrub target) to that position
/// before flipping `scrub_mode` on — used by the mini-wavemap, where
/// clicking anywhere on the full-track view "puts the playhead here"
/// without producing a slewed scratch from the old position. When
/// omitted, the cursor stays where it was (big-waveform behaviour:
/// grab-and-drag from current playhead).
#[derive(Debug, Default, Deserialize)]
pub struct ScrubBeginParams {
    #[serde(default)]
    pub seconds: Option<f64>,
}

/// Push a new scrub target source position. Engine enters `Scrubbing`
/// state on first arrival after `scrub_begin`; subsequent `scrub_to`
/// updates the target and lets the audio callback slew toward it.
/// High-frequency (one per renderer pointermove + one per rAF tick).
#[derive(Debug, Deserialize)]
pub struct ScrubToParams {
    pub seconds: f64,
}

/// Exit scrub mode. Cursor jumps to `final_seconds`; engine restores
/// the pre-scrub loop region. `resume_playing = true` re-enters Normal
/// play state; `false` leaves the engine paused at `final_seconds`.
#[derive(Debug, Deserialize)]
pub struct ScrubEndParams {
    pub final_seconds: f64,
    pub resume_playing: bool,
}

// ─── Controller-layer params (PRD: controllers-pioneer) ───────────────────
//
// Param structs cross the JSON-RPC boundary into the ControllerManager
// where they're consumed by the FLX10 driver thread + LED renderer.
// ControllerCueEntry is also re-exported (sidecar internals reach into
// its public fields for cue-table iteration).

/// Push a mapping table to the sidecar. Replaces any previously loaded
/// mapping for the named device. `mapping_json` is the TS-defined
/// `MappingTable` (packages/shared/src/controller-mapping.ts) serialised
/// as a JSON object — the sidecar deserialises into the Rust `Mapping`
/// struct lazily on receipt.
///
/// Idempotent: replacing mid-session is allowed (used by the dev-time
/// mapping overlay so the user doesn't restart the sidecar to retune a
/// binding).
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ControllerSetMappingParams {
    pub device: String,
    pub mapping_json: serde_json::Value,
}

/// Push the current track's hot-cue list to the sidecar. The sidecar
/// holds this table so pad presses resolve to engine `seek` calls
/// locally (no renderer round-trip) and so the LED renderer can derive
/// "this pad has a cue" colors.
///
/// `length_sec` null/0 = point cue; > 0 = loop cue. `slot` is 0-indexed
/// to match the FLX10's pad numbering (pads 1-8 = slots 0-7).
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ControllerSetCuesParams {
    pub cues: Vec<ControllerCueEntry>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ControllerCueEntry {
    pub slot: u8,
    pub position_sec: f64,
    pub length_sec: Option<f64>,
    pub color: Option<String>,
}

/// Notify the sidecar whether a track is currently loaded into the deck.
/// `false` clears the cue LEDs + dims the play LED without dropping the
/// stored cue table (so a subsequent re-load doesn't need to re-push).
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ControllerSetTrackLoadedParams {
    pub loaded: bool,
}

// ─── Result types (serialized into Response::Result.result) ───────────────

#[derive(Debug, Serialize)]
pub struct LoadResult {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Serialize)]
pub struct PositionResult {
    pub position: f64,
    pub playing: bool,
}

#[derive(Debug, Serialize)]
pub struct OkResult {
    pub ok: bool,
}

/// Result of `arm_trigger`. `armed: true` means the audio callback will
/// fire sample-accurately at the requested beat; `armed: false` means
/// the sidecar rejected the arm (cursor was already past trigger_at by
/// the time the RPC arrived — common when the renderer's view of
/// position is stale by a poll tick + RPC roundtrip). The renderer
/// falls back to an immediate seek on `armed: false` so the cue still
/// lands and the UI flash doesn't strand.
#[derive(Debug, Serialize)]
pub struct ArmTriggerResult {
    pub armed: bool,
}

/// Result of `jump_beats`. `jumped: false` means the engine had nothing
/// sensible to do (no track, no/invalid beatgrid, mid-scrub, or a
/// loop-move that would cross a track edge) — the renderer decides
/// whether to fall back to its own seek path. On success `target_sec`
/// is the landing position; the loop fields are set only when an active
/// loop was translated along with the playhead.
#[derive(Debug, Serialize)]
pub struct JumpBeatsResult {
    pub jumped: bool,
    pub target_sec: f64,
    pub loop_in_sec: Option<f64>,
    pub loop_out_sec: Option<f64>,
}

/// Snapshot of currently connected controllers. Returned by the
/// `controller_status` RPC; consumed by Settings → Player → Controllers
/// in the renderer.
#[derive(Debug, Serialize)]
pub struct ControllerStatusResult {
    pub connected: Vec<ControllerInfo>,
}

#[derive(Debug, Serialize)]
pub struct ControllerInfo {
    pub model: String,
    pub firmware_version: Option<String>,
    pub mapping_version: Option<String>,
    pub midi_port: Option<String>,
    pub hid_path: Option<String>,
}
