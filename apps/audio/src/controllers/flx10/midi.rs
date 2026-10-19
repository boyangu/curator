//! MIDI message parser — match inbound bytes against the active mapping,
//! emit a `controller_event` Event upstream.
//!
//! Called from midir's input callback (one thread per FLX10 connection).
//! Keep the work here minimal — every microsecond inside the callback
//! delays the next incoming MIDI message. We scan the mapping rows for
//! a trigger match, build the typed Action, and ship it.

use crate::controllers::mapping::{Action, MappingRow, Trigger};
use crate::controllers::ControllerManager;
use crate::protocol::{ControllerAction, Event};

use super::MODEL_NAME;

use std::sync::atomic::{AtomicBool, Ordering};

/// Live SHIFT modifier state. Read at action dispatch; written by the
/// `Action::Shift` handler when the SHIFT button presses / releases.
/// Static — there's only one FLX10 at a time, and "deck-shift across
/// physical decks" doesn't apply at v1 (deck 1 only per PRD §3).
static SHIFT_HELD: AtomicBool = AtomicBool::new(false);

/// midir callback entry. `bytes` is one MIDI message (length 1-3 for
/// standard messages; longer for SysEx — we don't process SysEx in v1).
pub fn on_message(mgr: &ControllerManager, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let mapping = match mgr.mapping_for(MODEL_NAME) {
        Some(m) => m,
        None => {
            // No mapping loaded yet — surface as Unmapped so the dev
            // overlay can show "I saw this before mapping arrived".
            emit_unmapped(mgr, bytes);
            return;
        }
    };

    let status = bytes[0];
    let kind = status & 0xF0;
    let data1 = bytes.get(1).copied().unwrap_or(0);
    let data2 = bytes.get(2).copied().unwrap_or(0);

    match kind {
        0x80 => {
            try_dispatch(mgr, &mapping.rows, data2, |t| match t {
                Trigger::NoteOff { status: s, note } => *s == status && *note == data1,
                _ => false,
            });
        }
        0x90 => {
            if data2 == 0 {
                // Velocity-0 Note On → Note Off for release semantics.
                try_dispatch(mgr, &mapping.rows, 0, |t| match t {
                    Trigger::NoteOff { status: s, note } => *s == status && *note == data1,
                    _ => false,
                });
            } else {
                try_dispatch(mgr, &mapping.rows, data2, |t| match t {
                    Trigger::NoteOn { status: s, note } => *s == status && *note == data1,
                    _ => false,
                });
            }
        }
        0xB0 => {
            try_dispatch(mgr, &mapping.rows, data2, |t| match t {
                Trigger::ControlChange { status: s, cc } => *s == status && *cc == data1,
                _ => false,
            });
        }
        _ => {
            // Unrecognised status (SysEx, channel pressure, etc.) — ignore.
        }
    }
}

/// Find a mapping row whose trigger matches and dispatch its action.
/// Honours the `shift` flag on each row — SHIFT-layered bindings only
/// fire while SHIFT is held; plain bindings only fire when SHIFT is
/// NOT held (so SHIFT-pad doesn't double-fire the no-shift binding).
/// `data2` is the raw MIDI data byte (velocity for Note, value for CC) —
/// threaded into the action where it matters (browse rotate signed delta,
/// SHIFT press vs release).
fn try_dispatch<F>(mgr: &ControllerManager, rows: &[MappingRow], data2: u8, matcher: F)
where
    F: Fn(&Trigger) -> bool,
{
    let shift = SHIFT_HELD.load(Ordering::Relaxed);
    let mut matched = false;
    for row in rows {
        if !matcher(&row.trigger) {
            continue;
        }
        let is_shift_action = matches!(row.action, Action::Shift);
        if !is_shift_action {
            if row.shift && !shift {
                continue;
            }
            if !row.shift && shift {
                continue;
            }
        }
        dispatch(mgr, &row.action, &row.trigger, data2);
        matched = true;
    }
    if !matched {
        tracing::trace!("no mapping row matched");
    }
}

fn dispatch(mgr: &ControllerManager, action: &Action, trigger: &Trigger, data2: u8) {
    let tx = mgr.event_tx();
    let send = |a: ControllerAction| {
        let _ = tx.send(Event::ControllerEvent { action: a });
    };
    match action {
        Action::BrowseRotate => {
            // FLX10 BROWSE rotary encodes direction as the value byte:
            //   clockwise:        0x01..0x1E (positive, value IS magnitude)
            //   counterclockwise: 0x7F..0x62 (negative, decreasing from 0x7F)
            // Convert both to a signed int8: anything > 0x40 is read as
            // (value - 0x80) so 0x7F = -1, 0x7E = -2 … 0x62 = -30.
            let delta = if data2 > 0x40 {
                (data2 as i32) - 0x80
            } else {
                data2 as i32
            };
            send(ControllerAction::Browse { delta });
        }
        Action::BrowsePress => send(ControllerAction::BrowsePress),
        Action::Back => send(ControllerAction::Back),
        Action::View => send(ControllerAction::View),

        Action::Shift => {
            // Press = Note On; Release = Note Off (or velocity-0 Note On).
            // Flip the held flag accordingly and emit the new state.
            let held_now = matches!(trigger, Trigger::NoteOn { .. });
            SHIFT_HELD.store(held_now, Ordering::Relaxed);
            tracing::debug!(shift_now = held_now, "SHIFT modifier");
            send(ControllerAction::Shift { held: held_now });
        }

        Action::CueTrigger { slot } => send(ControllerAction::CueTrigger { slot: *slot }),
        Action::BeatJump { delta } => send(ControllerAction::BeatJump { delta: *delta }),
        Action::LoopIn => send(ControllerAction::LoopIn),
        Action::LoopOut => send(ControllerAction::LoopOut),
        Action::LoopNBeats { n } => send(ControllerAction::LoopNBeats { n: *n }),
        Action::LoopHalve => send(ControllerAction::LoopHalve),
        Action::LoopDouble => send(ControllerAction::LoopDouble),
        Action::PlayPause => send(ControllerAction::PlayPause),

        Action::ScrubMotion => {
            // 7-bit MIDI jog wheel motion — TODO route to engine
            // scrub_to via signed delta. Per PRD §1, v1 scratch quality
            // is capped at 7-bit; HID jog uplift is [P2] per-device.
            tracing::trace!(data2, "scrub_motion (engine dispatch TBD)");
        }
        Action::ScrubTouch => {
            let held = matches!(trigger, Trigger::NoteOn { .. });
            tracing::trace!(held, "scrub_touch (engine dispatch TBD)");
        }
    }
}

fn emit_unmapped(mgr: &ControllerManager, bytes: &[u8]) {
    let _ = mgr.event_tx().send(Event::ControllerEvent {
        action: ControllerAction::Unmapped { raw: bytes.to_vec() },
    });
}
