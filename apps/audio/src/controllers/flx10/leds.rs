//! FLX10 LED renderer.
//!
//! Derives the controller's LED vector from sidecar state (cue table +
//! engine playing flag + loaded flag) and ships diffs over the MIDI
//! output port. Owned by the FLX10 driver thread — one MidiOutputConnection
//! per device lifetime.
//!
//! State model — see planning/tech/controllers-pioneer-flx10-protocol.md
//! "LED output protocol":
//!   - PLAY LED  : Note On `0x90 0x0B vel`, vel 0x7F = on, 0x00 = off.
//!   - CUE LED   : `0x90 0x0C vel`. Lit when track loaded but stopped.
//!   - 4-BEAT LED: `0x90 0x14 vel`. Lit while a loop is active.
//!   - Hot-cue pads (slot 0..7): `0x97 (slot) color`. Color is a single
//!     velocity byte on the FLX10's hue wheel; v1 uses a fixed
//!     per-slot palette.
//!
//! The +1200 ms post-init re-push is also driven from here: on
//! `mark_full_refresh` the next tick sends the full vector regardless
//! of diff state — the FLX10 silently drops the initial write burst
//! immediately after enumeration.

use midir::MidiOutputConnection;

use crate::controllers::ControllerManager;

/// FLX10 hue-wheel velocities by family.
///
/// The FLX10 pad LED encodes color in the upper bits of the velocity
/// byte and brightness (0..3) in the lower 2 bits — Mixxx's observed
/// values are at brightness=1 (dim), which visually reads as muted /
/// "wrong" against a brightly-lit deck. We pin brightness to 3 (max)
/// so cue pads pop against the controller's ambient lighting.
mod hue {
    // Each constant = (Mixxx-observed-base | 0x02) keeping the same
    // color family but at brightness 3 (top bit of brightness on the
    // FLX10 lights at velocity bit 1).
    pub const BLUE: u8    = 0x0B;
    pub const CYAN: u8    = 0x13; // also "aqua"
    pub const GREEN: u8   = 0x17;
    pub const YELLOW: u8  = 0x1F;
    pub const ORANGE: u8  = 0x27;
    pub const RED: u8     = 0x2B;
    // PINK = color 12 brightness 3 (vel 0x33 / 51 dec). Dead centre of
    // Mixxx's observed "v=49..53 pink" range. Earlier 0x37 = color 13
    // brightness 3, which sits between pink and magenta on the wheel
    // and reads visually as a wrong-shade pink.
    pub const PINK: u8    = 0x33;
    pub const MAGENTA: u8 = 0x3B;
    pub const PURPLE: u8  = 0x3F;
}

/// Map a Curator cue.color string to an FLX10 hue-wheel velocity.
/// Returns `hue::ORANGE` for missing or unrecognised colors — matches
/// the renderer's `CUE_DEFAULT_COLOR` (`#ff9028`) in
/// apps/desktop/src/renderer/main.ts so the FLX10 pad colour stays
/// visually consistent with what the user sees on screen.
///
/// Curator stores cue colors in two shapes (see
/// apps/rekordbox/.../reader.py::_resolve_cue_color):
///   - The 8 legacy rekordbox names: pink/red/orange/yellow/green/aqua/blue/purple
///   - The newer `cti:N` form where N is rekordbox's 64-entry rainbow palette index
fn color_to_flx10_velocity(color: Option<&str>) -> u8 {
    let Some(c) = color else { return hue::ORANGE; };
    match c {
        "pink"   => hue::PINK,
        "red"    => hue::RED,
        "orange" => hue::ORANGE,
        "yellow" => hue::YELLOW,
        "green"  => hue::GREEN,
        "aqua"   => hue::CYAN,
        "blue"   => hue::BLUE,
        "purple" => hue::PURPLE,
        _ => {
            // cti:N — rekordbox's 64-entry "extended" palette. Pioneer
            // doesn't publish the RGB table, so the renderer hashes the
            // index to a distinct HSL hue using the golden angle (see
            // apps/desktop/src/renderer/main.ts cueColor). We compute
            // the SAME hash here, then bucket the resulting hue (0-360°)
            // into the FLX10's discrete hue wheel so the pad color
            // family matches what the user sees in Curator's UI.
            let Some(n) = c.strip_prefix("cti:").and_then(|s| s.parse::<u8>().ok()) else {
                return hue::ORANGE;
            };
            let hue = (n as f64 * 137.508) % 360.0;
            let h = hue as u32;
            // Boundaries tuned against the actual HSL(h, 75%, 58%)
            // colors the renderer produces — tightened where families
            // visually blur into each other so the FLX10 hue matches
            // what the user sees on screen:
            //   - GREEN/CYAN edge moved 159→149 so 158° (cyan-mint)
            //     reads as CYAN, not GREEN.
            //   - YELLOW/GREEN edge moved 74→84 so 80° (lime) reads as
            //     YELLOW, not GREEN.
            //   - Other edges aligned to the standard HSL midpoints
            //     between adjacent pure-color hues.
            match h {
                0..=14    | 345..=359 => hue::RED,
                15..=44               => hue::ORANGE,
                45..=84               => hue::YELLOW,
                85..=149              => hue::GREEN,
                150..=194             => hue::CYAN,
                195..=249             => hue::BLUE,
                250..=284             => hue::PURPLE,
                285..=319             => hue::MAGENTA,
                320..=344             => hue::PINK,
                _                     => hue::ORANGE,
            }
        }
    }
}

/// Snapshot of every LED state the v1 controller layer drives. We diff
/// successive snapshots and ship only the bytes that changed — at 20 Hz
/// tick rate plus zero contention, MIDI traffic stays tiny.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LedSnapshot {
    play: bool,
    cue: bool,
    loop_active: bool,
    pads: [u8; 8],
}

impl LedSnapshot {
    /// All-off — what the controller sees before we send anything, and
    /// what we send on disconnect.
    const fn dark() -> Self {
        Self {
            play: false,
            cue: false,
            loop_active: false,
            pads: [0u8; 8],
        }
    }
}

/// LED renderer instance — owns the MIDI output connection and the
/// last-sent snapshot so successive ticks diff cleanly.
pub struct LedRenderer {
    out: MidiOutputConnection,
    last: LedSnapshot,
    /// When true, the next tick sends the full vector (used for the
    /// post-init re-push + initial connect blast).
    force_full: bool,
}

impl LedRenderer {
    pub fn new(out: MidiOutputConnection) -> Self {
        Self {
            out,
            // Seeded with "dark" so the first tick after connect shows
            // the user's actual state vs all-off; we set `force_full`
            // so even unchanged-from-dark bytes go out.
            last: LedSnapshot::dark(),
            force_full: true,
        }
    }

    /// Schedule a full re-write on the next tick. Called after the
    /// 1200 ms post-init delay to recover toggle LEDs that the FLX10
    /// dropped during USB endpoint warmup.
    pub fn mark_full_refresh(&mut self) {
        self.force_full = true;
    }

    /// Compute the next LED snapshot from current sidecar state and ship
    /// the deltas (or full vector if `force_full`). Called from the
    /// FLX10 driver thread on each LED tick (~50 ms cadence) and after
    /// any state change that should reflect immediately.
    pub fn tick(&mut self, mgr: &ControllerManager, engine_playing: bool, loop_active: bool) {
        let next = compute(mgr, engine_playing, loop_active);

        if self.force_full {
            self.send_full(&next);
            self.force_full = false;
        } else {
            // Copy out the previous snapshot so the borrow checker
            // releases its read on `self.last` before send_diff borrows
            // self mutably for the MIDI write.
            let prev = self.last;
            self.send_diff(&prev, &next);
        }
        self.last = next;
    }

    /// Black out every LED. Called when the FLX10 disconnects — useful
    /// if a reconnect happens fast enough that stale LED state would
    /// leak across the gap.
    pub fn shutdown(mut self) {
        let dark = LedSnapshot::dark();
        self.send_full(&dark);
    }

    fn send_full(&mut self, s: &LedSnapshot) {
        tracing::info!(
            play = s.play,
            cue = s.cue,
            loop_active = s.loop_active,
            pads = ?s.pads,
            "FLX10 LED full refresh",
        );
        send(&mut self.out, &[0x90, 0x0B, if s.play { 0x7F } else { 0x00 }]);
        send(&mut self.out, &[0x90, 0x0C, if s.cue { 0x7F } else { 0x00 }]);
        send(&mut self.out, &[0x90, 0x14, if s.loop_active { 0x7F } else { 0x00 }]);
        for (i, &color) in s.pads.iter().enumerate() {
            send(&mut self.out, &[0x97, i as u8, color]);
        }
    }

    fn send_diff(&mut self, prev: &LedSnapshot, next: &LedSnapshot) {
        if prev.play != next.play {
            send(&mut self.out, &[0x90, 0x0B, if next.play { 0x7F } else { 0x00 }]);
        }
        if prev.cue != next.cue {
            send(&mut self.out, &[0x90, 0x0C, if next.cue { 0x7F } else { 0x00 }]);
        }
        if prev.loop_active != next.loop_active {
            send(&mut self.out, &[0x90, 0x14, if next.loop_active { 0x7F } else { 0x00 }]);
        }
        for (i, (&p, &n)) in prev.pads.iter().zip(next.pads.iter()).enumerate() {
            if p != n {
                send(&mut self.out, &[0x97, i as u8, n]);
            }
        }
    }
}

fn compute(mgr: &ControllerManager, engine_playing: bool, loop_active: bool) -> LedSnapshot {
    let track_loaded = mgr.track_loaded();
    let cues = mgr.cues_snapshot();

    let mut pads = [0u8; 8];
    if track_loaded {
        for cue in &cues {
            let slot = cue.slot as usize;
            if slot >= pads.len() {
                continue;
            }
            // Look up the cue's stored color. Null / unrecognized
            // colors land on orange — same convention the renderer
            // uses (CUE_DEFAULT_COLOR = `#ff9028`) so a slot looks
            // visually consistent across the deck UI and the FLX10 pad.
            pads[slot] = color_to_flx10_velocity(cue.color.as_deref());
        }
    }

    LedSnapshot {
        play: track_loaded && engine_playing,
        // CUE LED: lit when track loaded but not playing (CDJ convention
        // — the CUE button "remembers" the cue position while stopped).
        cue: track_loaded && !engine_playing,
        loop_active: track_loaded && loop_active,
        pads,
    }
}

fn send(out: &mut MidiOutputConnection, bytes: &[u8]) {
    if let Err(e) = out.send(bytes) {
        // MIDI send failures shouldn't kill the driver loop — log
        // and move on. A persistent failure would indicate the port
        // closed, which the driver's disconnect watcher catches anyway.
        tracing::warn!(error = ?e, "FLX10 LED send failed");
    }
}
