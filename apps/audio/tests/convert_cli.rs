//! End-to-end check of `curator-audio convert` as the host runs it: spawn
//! the built binary, write one job line to stdin, read JSON lines from
//! stdout. Mainly guards that stdout carries nothing but protocol frames
//! (tracing must stay on stderr) and that exit codes match the outcome.

use flacenc::component::BitRepr;
use flacenc::error::Verify;
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn write_flac(path: &Path, frames: usize) {
    let samples: Vec<i32> = (0..frames * 2)
        .map(|i| (((i / 2) as f64 * 0.05).sin() * 20_000.0) as i32)
        .collect();
    let cfg = match flacenc::config::Encoder::default().into_verified() {
        Ok(c) => c,
        Err(_) => panic!("flacenc config"),
    };
    let src = flacenc::source::MemSource::from_samples(&samples, 2, 16, 44_100);
    let mut stream = flacenc::encode_with_fixed_block_size(&cfg, src, 4096).unwrap();
    // See convert_tests.rs: symphonia needs min == max for fixed-blocksize streams.
    stream.stream_info_mut().set_block_sizes(4096, 4096).unwrap();
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).unwrap();
    std::fs::write(path, sink.as_slice()).unwrap();
}

fn spawn(job: &Value) -> (i32, Vec<Value>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_curator-audio"))
        .arg("convert")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn curator-audio");
    writeln!(child.stdin.take().unwrap(), "{job}").unwrap();
    let out = child.wait_with_output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    let events = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("non-JSON stdout line {l:?}: {e}")))
        .collect();
    (out.status.code().unwrap_or(-1), events)
}

#[test]
fn convert_mode_success_and_failure() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    write_flac(&input, 44_100);

    let (code, events) = spawn(&json!({ "input": input, "output": output, "tags": { "title": "x" } }));
    assert_eq!(code, 0, "events: {events:?}");
    assert_eq!(events.first().unwrap()["kind"], "started");
    let done = events.last().unwrap();
    assert_eq!(done["kind"], "done");
    assert_eq!(done["frames"], 44_100);
    assert_eq!(done["bytes"], std::fs::metadata(&output).unwrap().len());

    let missing = dir.path().join("missing.flac");
    let out2 = dir.path().join("out2.wav.part");
    let (code, events) = spawn(&json!({ "input": missing, "output": out2 }));
    assert_eq!(code, 1);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "error");
    assert!(!out2.exists());
}
