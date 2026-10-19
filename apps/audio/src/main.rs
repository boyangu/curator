//! curator-audio — native local-audio sidecar for the Curator desktop app.
//!
//! JSON-RPC over stdio. Reads line-delimited requests on stdin, writes
//! line-delimited responses + events on stdout. Logging goes to stderr
//! (stdout is the protocol channel).
//!
//! Phase 1: single-deck — load + play + pause + seek + set_volume + position
//! + stop. Multi-deck mixing, loops (native), open streams, partner SDKs
//! all land in later phases. See plans/glistening-gliding-honey.md +
//! memory [[curator-audio-engine]].

mod beatjump;
mod controllers;
mod convert;
mod decode;
mod engine;
mod protocol;
mod wav_writer;

use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait};
use parking_lot::Mutex;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::controllers::ControllerManager;
use crate::controllers::mapping::Mapping;
use crate::engine::{Engine, LoadInfo};
use crate::protocol::{
    ArmTriggerResult, ControllerInfo, ControllerSetCuesParams, ControllerSetMappingParams,
    ControllerSetTrackLoadedParams, ControllerStatusResult, Event, JumpBeatsParams,
    JumpBeatsResult, LoadParams, LoadResult, LoopParams, OkResult, PositionResult, Request,
    Response, RpcError, ScrubBeginParams, ScrubEndParams, ScrubToParams, SeekParams,
    SetBeatgridParams, TriggerParams, VolumeParams,
};

/// Anything the main control thread needs to react to. Stream creation +
/// teardown lives on this thread because cpal::Stream is `!Send` on
/// Windows (WASAPI thread affinity) — both stdin RPCs and device-change
/// notifications must funnel here.
enum Inbound {
    Rpc(Request),
    /// The OS default output device changed (user plugged in headphones,
    /// switched outputs in Sound settings, etc.). Triggers a stream
    /// rebuild on the next loop tick.
    DeviceChanged,
}

fn main() -> Result<()> {
    // tracing → stderr. The default subscriber writes there; RUST_LOG
    // controls verbosity from the host (e.g. RUST_LOG=curator_audio=debug).
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("curator_audio=info,info")),
        )
        .init();

    // `curator-audio convert`: one-shot FLAC→WAV job, one process per track.
    // Must branch before any cpal / MIDI / device-watcher setup — a
    // converter has no business opening audio devices, and the playback
    // sidecar's RPC loop is serial so conversions can't live there.
    if std::env::args().nth(1).as_deref() == Some("convert") {
        std::process::exit(convert::run_cli());
    }

    // Version banner — bumped on protocol/engine changes so we can confirm
    // the running binary matches the source we expect.
    tracing::info!("curator-audio sidecar starting (build=progressive-r3)");

    // Outbound event channel. The reporter thread inside the engine and
    // command handlers push Events; a dedicated writer thread serialises
    // them to stdout so we don't interleave bytes across writers.
    let (event_tx, event_rx) = channel::<Event>();
    // Same channel is used for command responses too — wrap both in an
    // enum so the writer thread has a single source of truth.
    let (out_tx, out_rx) = channel::<OutMsg>();

    // Bridge: forward Events from event_rx into the OutMsg channel. Keeps
    // the engine's Sender API simple (no need to know about responses).
    {
        let out_tx = out_tx.clone();
        thread::spawn(move || {
            while let Ok(ev) = event_rx.recv() {
                if out_tx.send(OutMsg::Event(ev)).is_err() {
                    break;
                }
            }
        });
    }

    let engine = Arc::new(Mutex::new(Engine::new(event_tx.clone())));

    // Controller layer — owns USB-MIDI device I/O for any connected
    // Pioneer DDJ/FLX/XDJ controller. v1: FLX10 driver only. The
    // manager spawns its own thread for device discovery + MIDI input;
    // event_tx is shared so controller_connected / controller_event /
    // controller_disconnected frames land on the same writer pipeline
    // as audio's state_changed / ended events.
    let controllers = ControllerManager::new(engine.lock().state_handle(), event_tx);
    controllers.spawn_flx10_driver();

    // Writer thread — owns stdout. JSON serialise + flush per message.
    thread::spawn(move || writer_loop(out_rx));

    // Unified inbound channel — stdin RPCs and device-change notifications
    // both land here so the main thread can react to either without
    // moving the cpal::Stream off-thread.
    let (in_tx, in_rx) = channel::<Inbound>();

    // Stdin reader thread — converts stdin lines into Inbound::Rpc. Has
    // to be its own thread because BufRead::lines() is blocking and
    // would otherwise starve the device watcher.
    {
        let in_tx = in_tx.clone();
        thread::spawn(move || stdin_reader_loop(in_tx));
    }

    // Device watcher — polls the OS default output device every second,
    // pushes Inbound::DeviceChanged when the device's identity flips
    // (user plugged in headphones, changed default in Sound settings,
    // unplugged the active device, etc.). cpal doesn't expose a portable
    // device-change event, so polling at 1 Hz is the trade-off: a 1 s
    // worst-case delay before audio rerouted to the new device, in
    // exchange for not depending on the WASAPI IMMNotificationClient.
    {
        let in_tx = in_tx.clone();
        thread::spawn(move || device_watcher_loop(in_tx));
    }

    // Boot complete — announce readiness so the renderer can re-push
    // any state (loaded track, cue list, play flag) that didn't survive
    // a sidecar restart. See planning/tech/controllers-pioneer.md
    // "Sidecar respawn LED resync" for rationale.
    if out_tx.send(OutMsg::Event(Event::SidecarReady)).is_err() {
        tracing::warn!("writer thread gone before sidecar_ready could be sent");
    }

    // Main loop — process events from the unified channel. The normal exit
    // is the `shutdown` RPC (returns Ok below). Parent-death (stdin EOF) is
    // handled by the stdin reader thread, which process::exit()s directly —
    // it can't rely on the channel closing because the device-watcher thread
    // and this function both still hold `Inbound` senders.
    while let Ok(msg) = in_rx.recv() {
        match msg {
            Inbound::Rpc(request) => {
                let is_shutdown = request.method == "shutdown";
                let response = dispatch(&engine, &controllers, &request);
                if out_tx.send(OutMsg::Response(response)).is_err() {
                    break;
                }
                if is_shutdown {
                    // Give the writer a moment to flush.
                    thread::sleep(Duration::from_millis(50));
                    return Ok(());
                }
            }
            Inbound::DeviceChanged => {
                // Rebuild the output stream against the new default
                // device. The track buffer + cursor survive across this
                // — only the cpal::Stream is torn down + re-created.
                if let Err(e) = engine.lock().rebuild_output_device() {
                    tracing::error!(error = %format!("{:#}", e), "rebuild_output_device failed");
                }
            }
        }
    }
    tracing::info!("curator-audio sidecar exiting");
    Ok(())
}

fn stdin_reader_loop(tx: Sender<Inbound>) {
    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                tracing::error!(error = ?e, "stdin read error — exiting reader");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                tracing::error!(error = %e, line = %line, "invalid request JSON");
                continue;
            }
        };
        if tx.send(Inbound::Rpc(request)).is_err() {
            break;
        }
    }
    // EOF (or a fatal read error) on stdin means our parent closed the pipe —
    // the desktop app (or the core sidecar that spawned us) is gone. The main
    // loop can't observe this: the device-watcher thread and main both still
    // hold `Inbound` senders, so in_rx.recv() would block forever and leave us
    // orphaned (the leftover-sidecar problem). Exit directly so we die with our
    // parent. The graceful `shutdown` RPC stays the normal path; this is the
    // backstop for crashes / hard-kills that never send it.
    tracing::info!("stdin closed (parent gone) — exiting curator-audio sidecar");
    std::process::exit(0);
}

fn device_watcher_loop(tx: Sender<Inbound>) {
    // Seed with the device name at boot so the first poll doesn't fire
    // a (no-op) DeviceChanged just because we hadn't seen any name yet.
    let mut last_name = current_default_output_name();
    tracing::info!(initial_device = ?last_name, "device watcher started");
    loop {
        thread::sleep(Duration::from_millis(1000));
        let current = current_default_output_name();
        if current != last_name {
            tracing::info!(
                old = ?last_name,
                new = ?current,
                "default output device changed — requesting stream rebuild"
            );
            // last_name updates BEFORE the send so a slow main thread
            // doesn't replay multiple DeviceChanged for the same flip.
            last_name = current;
            if tx.send(Inbound::DeviceChanged).is_err() {
                return;
            }
        }
    }
}

fn current_default_output_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.name().ok())
}

/// Anything the writer thread serialises to stdout.
enum OutMsg {
    Response(Response),
    Event(Event),
}

fn writer_loop(rx: Receiver<OutMsg>) {
    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    while let Ok(msg) = rx.recv() {
        let json = match &msg {
            OutMsg::Response(r) => serde_json::to_string(r),
            OutMsg::Event(e) => serde_json::to_string(e),
        };
        let json = match json {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(error = ?e, "json serialise failed");
                continue;
            }
        };
        if writeln!(handle, "{}", json).is_err() {
            break;
        }
        if handle.flush().is_err() {
            break;
        }
    }
}

fn dispatch(engine: &Arc<Mutex<Engine>>, controllers: &ControllerManager, req: &Request) -> Response {
    let id = req.id;
    match req.method.as_str() {
        "load" => match serde_json::from_value::<LoadParams>(req.params.clone()) {
            Ok(p) => {
                let path = PathBuf::from(&p.path);
                match engine.lock().load(&path) {
                    Ok(LoadInfo { duration, sample_rate, channels }) => ok(
                        id,
                        &LoadResult { duration, sample_rate, channels },
                    ),
                    Err(e) => err(id, "load", &format!("{:#}", e)),
                }
            }
            Err(e) => err(id, "internal", &format!("invalid load params: {}", e)),
        },
        "play" => match engine.lock().play() {
            Ok(_) => ok(id, &OkResult { ok: true }),
            Err(e) => err(id, "play", &format!("{:#}", e)),
        },
        "pause" => match engine.lock().pause() {
            Ok(_) => ok(id, &OkResult { ok: true }),
            Err(e) => err(id, "play", &format!("{:#}", e)),
        },
        "seek" => match serde_json::from_value::<SeekParams>(req.params.clone()) {
            Ok(p) => match engine.lock().seek(p.seconds) {
                Ok(_) => ok(id, &OkResult { ok: true }),
                Err(e) => err(id, "seek", &format!("{:#}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid seek params: {}", e)),
        },
        "set_volume" => match serde_json::from_value::<VolumeParams>(req.params.clone()) {
            Ok(p) => {
                engine.lock().set_volume(p.volume);
                ok(id, &OkResult { ok: true })
            }
            Err(e) => err(id, "internal", &format!("invalid volume params: {}", e)),
        },
        "set_loop" => match serde_json::from_value::<LoopParams>(req.params.clone()) {
            Ok(p) => match engine.lock().set_loop(p.in_sec, p.out_sec) {
                Ok(_) => ok(id, &OkResult { ok: true }),
                Err(e) => err(id, "internal", &format!("{:#}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid set_loop params: {}", e)),
        },
        "arm_trigger" => match serde_json::from_value::<TriggerParams>(req.params.clone()) {
            Ok(p) => match engine.lock().arm_trigger(p.trigger_at_sec, p.seek_to_sec) {
                Ok(armed) => ok(id, &ArmTriggerResult { armed }),
                Err(e) => err(id, "internal", &format!("{:#}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid arm_trigger params: {}", e)),
        },
        "seek_with_xfade" => match serde_json::from_value::<SeekParams>(req.params.clone()) {
            Ok(p) => match engine.lock().seek_with_xfade(p.seconds) {
                Ok(_) => ok(id, &OkResult { ok: true }),
                Err(e) => err(id, "seek", &format!("{:#}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid seek_with_xfade params: {}", e)),
        },
        "set_beatgrid" => match serde_json::from_value::<SetBeatgridParams>(req.params.clone()) {
            Ok(p) => {
                engine.lock().set_beatgrid(p.beats);
                ok(id, &OkResult { ok: true })
            }
            Err(e) => err(id, "internal", &format!("invalid set_beatgrid params: {}", e)),
        },
        "jump_beats" => match serde_json::from_value::<JumpBeatsParams>(req.params.clone()) {
            Ok(p) => match engine.lock().jump_beats(p.delta_beats) {
                Ok(o) => ok(id, &JumpBeatsResult {
                    jumped: o.jumped,
                    target_sec: o.target_sec,
                    loop_in_sec: o.loop_in_sec,
                    loop_out_sec: o.loop_out_sec,
                }),
                Err(e) => err(id, "seek", &format!("{:#}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid jump_beats params: {}", e)),
        },
        "position" => {
            let eng = engine.lock();
            ok(id, &PositionResult {
                position: eng.position_secs(),
                playing: eng.playing(),
            })
        }
        "stop" => {
            engine.lock().stop();
            ok(id, &OkResult { ok: true })
        }
        "scrub_begin" => {
            // params are optional — missing or `{}` body is fine (big-wave
            // grab-and-drag entry). serde_json::Value::Null parses cleanly
            // into ScrubBeginParams { seconds: None } via #[serde(default)].
            let parsed: Result<ScrubBeginParams, _> = if req.params.is_null() {
                Ok(ScrubBeginParams::default())
            } else {
                serde_json::from_value::<ScrubBeginParams>(req.params.clone())
            };
            match parsed {
                Ok(p) => match engine.lock().scrub_begin(p.seconds) {
                    Ok(_) => ok(id, &OkResult { ok: true }),
                    Err(e) => err(id, "internal", &format!("{:#}", e)),
                },
                Err(e) => err(id, "internal", &format!("invalid scrub_begin params: {}", e)),
            }
        },
        "scrub_to" => match serde_json::from_value::<ScrubToParams>(req.params.clone()) {
            Ok(p) => match engine.lock().scrub_to(p.seconds) {
                Ok(_) => ok(id, &OkResult { ok: true }),
                Err(e) => err(id, "internal", &format!("{:#}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid scrub_to params: {}", e)),
        },
        "scrub_end" => match serde_json::from_value::<ScrubEndParams>(req.params.clone()) {
            Ok(p) => match engine.lock().scrub_end(p.final_seconds, p.resume_playing) {
                Ok(_) => ok(id, &OkResult { ok: true }),
                Err(e) => err(id, "internal", &format!("{:#}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid scrub_end params: {}", e)),
        },
        // ─── Controller layer (PRD: controllers-pioneer) ──────────────────
        // RPCs stash state on the ControllerManager. The FLX10 driver
        // thread reads the current mapping + cue table as it runs.
        "controller_set_mapping" => match serde_json::from_value::<ControllerSetMappingParams>(req.params.clone()) {
            Ok(p) => match serde_json::from_value::<Mapping>(p.mapping_json) {
                Ok(mapping) => {
                    controllers.set_mapping(mapping);
                    ok(id, &OkResult { ok: true })
                }
                Err(e) => err(id, "internal", &format!("invalid mapping JSON: {}", e)),
            },
            Err(e) => err(id, "internal", &format!("invalid controller_set_mapping params: {}", e)),
        },
        "controller_set_cues" => match serde_json::from_value::<ControllerSetCuesParams>(req.params.clone()) {
            Ok(p) => {
                controllers.set_cues(p.cues);
                ok(id, &OkResult { ok: true })
            }
            Err(e) => err(id, "internal", &format!("invalid controller_set_cues params: {}", e)),
        },
        "controller_set_track_loaded" => match serde_json::from_value::<ControllerSetTrackLoadedParams>(req.params.clone()) {
            Ok(p) => {
                controllers.set_track_loaded(p.loaded);
                ok(id, &OkResult { ok: true })
            }
            Err(e) => err(id, "internal", &format!("invalid controller_set_track_loaded params: {}", e)),
        },
        "controller_status" => {
            // v1: synthesise from the manager's view. Full device-list
            // accounting (HID paths, firmware) lands when the driver
            // surfaces it back through the manager — a TBD shaped like
            // `controllers.status()` returning a snapshot. For now, if
            // any mapping is loaded we surface FLX10 with no firmware.
            // The renderer can already render "connected (firmware
            // unknown)" off this.
            let connected = controllers
                .mapping_for(crate::controllers::flx10::MODEL_NAME)
                .map(|m| vec![ControllerInfo {
                    model: crate::controllers::flx10::MODEL_NAME.into(),
                    firmware_version: None,
                    mapping_version: m.version,
                    midi_port: None,
                    hid_path: None,
                }])
                .unwrap_or_default();
            ok(id, &ControllerStatusResult { connected })
        }
        "shutdown" => ok(id, &OkResult { ok: true }),
        other => err(id, "internal", &format!("unknown method: {}", other)),
    }
}

fn ok<T: serde::Serialize>(id: u64, value: &T) -> Response {
    Response::Result {
        id,
        result: serde_json::to_value(value).unwrap_or(serde_json::Value::Null),
    }
}

fn err(id: u64, kind: &str, message: &str) -> Response {
    Response::Error {
        id,
        error: RpcError { kind: kind.into(), message: message.into() },
    }
}

