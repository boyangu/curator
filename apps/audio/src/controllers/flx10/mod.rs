//! DDJ-FLX10 device driver.
//!
//! Protocol spec: [planning/tech/controllers-pioneer-flx10-protocol.md].
//!
//! Entry: [`run`] is invoked from a dedicated thread (spawned by the
//! controller manager) and owns the FLX10's MIDI ports for the lifetime
//! of the connection. The thread loops:
//!
//!   1. Poll midir's port list at ~1 Hz looking for a port whose name
//!      matches `MIDI_PORT_HINT` (case-insensitive substring match —
//!      Windows / macOS / Linux name the port slightly differently,
//!      but all include "DDJ-FLX10").
//!   2. On match: open input + output, emit `controller_connected`,
//!      schedule the 1200 ms LED re-push (TODO once leds.rs lands).
//!   3. While connected: midir's callback fires for each MIDI message;
//!      we parse against the active mapping and emit `controller_event`
//!      Events up the wire.
//!   4. On port disappearance (poll iteration sees no match): drop
//!      handles, emit `controller_disconnected`, return to step 1.

#![allow(dead_code)]

mod leds;
mod midi;

use std::thread;
use std::time::{Duration, Instant};

use midir::{MidiInput, MidiInputPort, MidiOutput};

use crate::protocol::Event;
use super::ControllerManager;
use leds::LedRenderer;

/// USB vendor ID — AlphaTheta / Pioneer DJ.
pub const USB_VID: u16 = 0x2B73;
/// USB product ID — DDJ-FLX10.
pub const USB_PID: u16 = 0x0041;
/// Canonical model name used in Curator's controller_status / events.
pub const MODEL_NAME: &str = "DDJ-FLX10";
/// midir port-name substring match (case-insensitive). Matches every OS:
///   Windows:  "DDJ-FLX10"           (via WinMM port enum)
///   macOS:    "DDJ-FLX10 MIDI 1"    (CoreMIDI endpoint name)
///   Linux:    "DDJ-FLX10:DDJ-FLX10 MIDI 1" (ALSA)
const MIDI_PORT_HINT: &str = "ddj-flx10";
/// LED post-init re-push delay. The FLX10 silently drops Note On
/// messages received before its USB endpoint is fully attached after
/// host enumeration. Re-blast the LED state vector 1200 ms after
/// connect to recover toggle LEDs that got eaten by the initial burst.
pub const LED_REFRESH_DELAY_MS: u64 = 1200;
/// Hot-plug detection poll cadence — matches the existing audio-device
/// watcher in main.rs. 1 s worst-case delay before
/// controller_connected / controller_disconnected fires.
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
/// LED tick cadence. 50 ms (20 Hz) — same rate as the engine's
/// state_changed reporter; faster than human perception of LED state
/// changes and well below MIDI's ~3 kHz throughput ceiling.
const LED_TICK: Duration = Duration::from_millis(50);

/// Thread entry point. Loops the connect / parse / disconnect lifecycle
/// forever. Owns no shared state of its own — every interaction with
/// the rest of the sidecar flows through the supplied `ControllerManager`.
pub fn run(mgr: ControllerManager) {
    tracing::info!(model = MODEL_NAME, "FLX10 driver thread started");
    loop {
        match find_port() {
            Some(port_name) => {
                tracing::info!(port = %port_name, "FLX10 detected — opening MIDI input");
                handle_connection(&mgr, &port_name);
                tracing::info!("FLX10 disconnected");
                let _ = mgr.event_tx().send(Event::ControllerDisconnected {
                    model: MODEL_NAME.into(),
                });
            }
            None => {
                // No FLX10 visible — sleep and retry.
                thread::sleep(POLL_INTERVAL);
            }
        }
    }
}

/// Look for a midir input port whose name contains the FLX10 hint.
/// Returns the port's display name (not the index — indices shift when
/// other USB-MIDI devices come and go between polls).
fn find_port() -> Option<String> {
    let midi_in = MidiInput::new("curator-audio-discovery").ok()?;
    for port in midi_in.ports() {
        if let Ok(name) = midi_in.port_name(&port) {
            if name.to_lowercase().contains(MIDI_PORT_HINT) {
                return Some(name);
            }
        }
    }
    None
}

/// Look up a midir port by name. Returns None if the device disappeared
/// between the discovery call and the open call (rare but possible).
fn port_by_name(midi_in: &MidiInput, name: &str) -> Option<MidiInputPort> {
    midi_in.ports().into_iter().find(|p| {
        midi_in.port_name(p).ok().as_deref() == Some(name)
    })
}

/// Manage one connection: open MIDI in + out, parse incoming messages,
/// run the LED tick loop, watch for the port disappearing. Returns when
/// the FLX10 is no longer visible in midir's port list.
fn handle_connection(mgr: &ControllerManager, port_name: &str) {
    let midi_in = match MidiInput::new("curator-audio-flx10") {
        Ok(m) => m,
        Err(e) => {
            tracing::error!(error = ?e, "MidiInput init failed");
            return;
        }
    };
    let in_port = match port_by_name(&midi_in, port_name) {
        Some(p) => p,
        None => {
            tracing::warn!(port = %port_name, "input port vanished before open");
            return;
        }
    };

    let mgr_for_cb = mgr.clone();
    let _conn_in = match midi_in.connect(
        &in_port,
        "curator-flx10-in",
        move |_timestamp_us, bytes, _| {
            midi::on_message(&mgr_for_cb, bytes);
        },
        (),
    ) {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(error = ?e, "MIDI input connect failed");
            return;
        }
    };

    // Open MIDI output port (LED writes). Same name match — midir
    // exposes input + output ports separately on Windows/macOS even
    // though they share the underlying USB endpoint.
    let leds = match open_output(port_name) {
        Some(l) => l,
        None => {
            tracing::warn!(port = %port_name, "MIDI output unavailable — LEDs will not light, input still works");
            // Continue without LEDs — controller events still flow.
            run_no_leds(mgr, port_name);
            return;
        }
    };
    let mut led_renderer = LedRenderer::new(leds);

    // Announce up the wire.
    let _ = mgr.event_tx().send(Event::ControllerConnected {
        model: MODEL_NAME.into(),
        firmware: None, // TODO: SysEx universal-identity request to populate
    });

    // 1200 ms post-init re-push timer. FLX10 silently drops Note On
    // received before its USB endpoint is fully attached after host
    // enumeration; we force a full re-write at this deadline to recover
    // any toggle LEDs that got eaten by the initial burst.
    let connect_at = Instant::now();
    let refresh_deadline = connect_at + Duration::from_millis(LED_REFRESH_DELAY_MS);
    let mut refreshed = false;

    let watcher = MidiInput::new("curator-audio-flx10-watch")
        .expect("MidiInput should always be creatable");
    loop {
        // Check for disconnect.
        if port_by_name(&watcher, port_name).is_none() {
            break;
        }
        // Drive LEDs.
        led_renderer.tick(mgr, mgr.engine_playing(), mgr.engine_loop_active());

        // Post-init full refresh.
        if !refreshed && Instant::now() >= refresh_deadline {
            led_renderer.mark_full_refresh();
            refreshed = true;
        }

        thread::sleep(LED_TICK);
    }

    // Clear LEDs on disconnect so a fast reconnect doesn't see stale state.
    led_renderer.shutdown();
}

/// Open the FLX10's MIDI output port. Returns None if it's not visible —
/// some OS / driver combos expose only the input side, or the output
/// has a slightly different name. We still allow operation in that
/// case; LEDs just won't light.
fn open_output(port_name: &str) -> Option<midir::MidiOutputConnection> {
    let midi_out = MidiOutput::new("curator-audio-flx10-out").ok()?;
    let port = midi_out.ports().into_iter().find(|p| {
        midi_out
            .port_name(p)
            .ok()
            .as_deref()
            .map(|n| n == port_name || n.to_lowercase().contains(MIDI_PORT_HINT))
            .unwrap_or(false)
    })?;
    midi_out.connect(&port, "curator-flx10-out").ok()
}

/// Fallback when MIDI output couldn't be opened — input still works,
/// LEDs stay dark. Keeps the connect/disconnect lifecycle the same so
/// the renderer's Settings panel reflects the device's presence.
fn run_no_leds(mgr: &ControllerManager, port_name: &str) {
    let _ = mgr.event_tx().send(Event::ControllerConnected {
        model: MODEL_NAME.into(),
        firmware: None,
    });
    let watcher = MidiInput::new("curator-audio-flx10-watch")
        .expect("MidiInput should always be creatable");
    while port_by_name(&watcher, port_name).is_some() {
        thread::sleep(POLL_INTERVAL);
    }
}
