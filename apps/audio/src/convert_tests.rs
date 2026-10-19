//! Convert-mode tests. Every fixture is synthesised and FLAC-encoded at test
//! time into a temp dir (flacenc) — nothing touches real library files.

use super::*;
use flacenc::component::{BitRepr, MetadataBlockData};
use flacenc::error::Verify;
use std::f64::consts::PI;

// ─── Fixtures ───────────────────────────────────────────────────────────────

/// Interleaved PCM: a per-channel sine + deterministic LCG noise, with
/// full-scale extremes planted early so clamping/sign handling is exercised.
fn signal(frames: usize, channels: usize, bits: u32, rate: u32) -> Vec<i32> {
    let max = (1i64 << (bits - 1)) - 1;
    let min = -(1i64 << (bits - 1));
    let mut rng: u64 = 0x1234_5678_9abc_def0;
    let mut out = Vec::with_capacity(frames * channels);
    for i in 0..frames {
        for c in 0..channels {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let noise = ((rng >> 33) as f64 / (1u64 << 31) as f64 - 0.5) * 0.2;
            let s = 0.6 * (2.0 * PI * 440.0 * (c + 1) as f64 * i as f64 / rate as f64).sin() + noise;
            out.push(((s * max as f64).round() as i64).clamp(min, max) as i32);
        }
    }
    for (k, v) in [max, min, max, min, 0, -1, 1].iter().enumerate() {
        for c in 0..channels {
            out[(100 + k) * channels + c] = *v as i32;
        }
    }
    out
}

/// Minimal FLAC PICTURE block body (type 3 = front cover).
fn picture_block(mime: &str, data: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&3u32.to_be_bytes());
    b.extend_from_slice(&(mime.len() as u32).to_be_bytes());
    b.extend_from_slice(mime.as_bytes());
    b.extend_from_slice(&0u32.to_be_bytes()); // description length
    for v in [1u32, 1, 24, 0] {
        b.extend_from_slice(&v.to_be_bytes()); // width, height, depth, colours
    }
    b.extend_from_slice(&(data.len() as u32).to_be_bytes());
    b.extend_from_slice(data);
    b
}

fn write_flac(path: &Path, samples: &[i32], channels: usize, bits: usize, rate: usize, picture: Option<&[u8]>) {
    let cfg = match flacenc::config::Encoder::default().into_verified() {
        Ok(c) => c,
        Err(_) => panic!("flacenc config"),
    };
    let src = flacenc::source::MemSource::from_samples(samples, channels, bits, rate);
    let mut stream = flacenc::encode_with_fixed_block_size(&cfg, src, 4096).expect("flac encode");
    // flacenc records the (shorter) final block as min_block_size, unlike
    // libFLAC which writes min == max for fixed-blocksize streams. Symphonia
    // treats min != max as a variable-blocksize stream and then rejects every
    // frame-numbered header, so normalise to what real-world files carry.
    stream.stream_info_mut().set_block_sizes(4096, 4096).expect("block sizes");
    if let Some(data) = picture {
        let block = MetadataBlockData::new_unknown(6, &picture_block("image/png", data)).expect("picture block");
        stream.add_metadata_block(block);
    }
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream.write(&mut sink).expect("flac serialise");
    fs::write(path, sink.as_slice()).expect("write flac");
}

struct Run {
    code: i32,
    events: Vec<Value>,
}

impl Run {
    fn last(&self) -> &Value {
        self.events.last().expect("no events")
    }
    fn kind(&self, kind: &str) -> Vec<&Value> {
        self.events.iter().filter(|e| e["kind"] == kind).collect()
    }
}

fn run(job: Value) -> Run {
    let mut out = Vec::new();
    let code = run_job_line(&job.to_string(), &mut out);
    let text = String::from_utf8(out).expect("stdout is utf-8");
    let events = text
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("non-JSON stdout line {l:?}: {e}")))
        .collect();
    Run { code, events }
}

fn read_wav(path: &Path) -> (hound::WavSpec, Vec<i32>) {
    let mut r = hound::WavReader::open(path).expect("hound open");
    let spec = r.spec();
    let samples = r.samples::<i32>().map(|s| s.unwrap()).collect();
    (spec, samples)
}

/// Converts a synthetic FLAC without resampling and asserts the WAV PCM is
/// identical to the source PCM.
fn assert_bit_exact(channels: usize, bits: u32, rate: u32) {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    let frames = rate as usize * 2 + 1234;
    let pcm = signal(frames, channels, bits, rate);
    write_flac(&input, &pcm, channels, bits as usize, rate as usize, None);

    let r = run(json!({ "input": input, "output": output }));
    assert_eq!(r.code, 0, "events: {:?}", r.events);
    let done = r.last();
    assert_eq!(done["kind"], "done");
    assert_eq!(done["resampled"], false);
    assert_eq!(done["sampleRate"], rate);
    assert_eq!(done["bitDepth"], bits);
    assert_eq!(done["channels"], channels);
    assert_eq!(done["frames"], frames);
    assert_eq!(done["sourceBitDepth"], bits);
    assert_eq!(done["bytes"], fs::metadata(&output).unwrap().len());

    let h = wav_writer::read_header(&output).unwrap();
    assert_eq!(h.format_tag, 1, "must be plain PCM, never EXTENSIBLE");
    assert_eq!(h.bits_per_sample as u32, bits);
    assert_eq!(h.block_align as usize, channels * bits as usize / 8);
    assert_eq!(&h.chunk_ids[0], b"fmt ");
    assert_eq!(&h.chunk_ids[1], b"data");

    let (spec, samples) = read_wav(&output);
    assert_eq!(spec.sample_rate, rate);
    assert_eq!(spec.channels as usize, channels);
    assert_eq!(samples.len(), pcm.len());
    if let Some(i) = samples.iter().zip(&pcm).position(|(a, b)| a != b) {
        panic!("sample {i} differs: wav {} vs source {}", samples[i], pcm[i]);
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

/// Pins down the symphonia behaviour the integer path relies on: FLAC
/// decodes to S32 buffers left-justified by (32 − bits_per_sample).
#[test]
fn symphonia_flac_s32_is_left_justified() {
    for bits in [16u32, 24] {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.flac");
        let pcm = signal(5000, 2, bits, 44_100);
        write_flac(&input, &pcm, 2, bits as usize, 44_100, None);

        let mss = MediaSourceStream::new(Box::new(File::open(&input).unwrap()), Default::default());
        let mut probed = symphonia::default::get_probe()
            .format(&Hint::new(), mss, &FormatOptions::default(), &MetadataOptions::default())
            .unwrap();
        let params = probed.format.default_track().unwrap().codec_params.clone();
        assert_eq!(params.bits_per_sample, Some(bits));
        let mut dec = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).unwrap();
        let packet = probed.format.next_packet().unwrap();
        match dec.decode(&packet).unwrap() {
            AudioBufferRef::S32(b) => {
                for i in 0..b.frames() {
                    assert_eq!(b.chan(0)[i], pcm[i * 2] << (32 - bits), "bits={bits} frame={i}");
                    assert_eq!(b.chan(1)[i], pcm[i * 2 + 1] << (32 - bits), "bits={bits} frame={i}");
                }
            }
            other => panic!("expected S32 buffer, got {:?}", other.spec()),
        }
    }
}

#[test]
fn flac_16bit_44k_stereo_is_bit_exact() {
    assert_bit_exact(2, 16, 44_100);
}

#[test]
fn flac_24bit_48k_stereo_is_bit_exact() {
    assert_bit_exact(2, 24, 48_000);
}

#[test]
fn flac_16bit_mono_is_bit_exact() {
    assert_bit_exact(1, 16, 44_100);
}

#[test]
fn flac_24bit_mono_odd_frames_pads_data_chunk() {
    // 24-bit mono with an odd frame count → odd data size → pad byte.
    assert_bit_exact(1, 24, 48_000);
}

#[test]
fn hires_96k_resamples_to_48k_time_aligned() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    let (src, dst) = (96_000u32, 48_000u32);
    let frames = 3 * src as usize + 7;
    let full = (1i32 << 23) - 1;

    // Ch0: impulses at 1.0 s and 2.5 s. Ch1: 1 kHz sine for the
    // amplitude/phase check against an analytic reference.
    let impulses = [96_000usize, 240_000];
    let mut pcm = vec![0i32; frames * 2];
    for &i in &impulses {
        pcm[i * 2] = full / 2;
    }
    for i in 0..frames {
        let s = 0.5 * (2.0 * PI * 1000.0 * i as f64 / src as f64).sin();
        pcm[i * 2 + 1] = (s * full as f64).round() as i32;
    }
    write_flac(&input, &pcm, 2, 24, src as usize, None);

    let r = run(json!({ "input": input, "output": output, "maxSampleRate": 48000 }));
    assert_eq!(r.code, 0, "events: {:?}", r.events);
    let started = r.kind("started")[0];
    assert_eq!(started["sourceSampleRate"], src);
    assert_eq!(started["sampleRate"], dst);
    assert_eq!(started["totalFrames"], frames);
    let done = r.last();
    assert_eq!(done["resampled"], true);
    assert_eq!(done["sampleRate"], dst);
    assert_eq!(done["bitDepth"], 24);
    let expected = (frames as f64 * dst as f64 / src as f64).round() as i64;
    let got = done["frames"].as_i64().unwrap();
    assert!((got - expected).abs() <= 1, "frames {got} vs expected {expected}");

    let (spec, samples) = read_wav(&output);
    assert_eq!(spec.sample_rate, dst);
    assert_eq!(spec.bits_per_sample, 24);
    assert_eq!(samples.len() as i64, got * 2);
    assert_eq!(wav_writer::read_header(&output).unwrap().format_tag, 1);

    // Each impulse should peak where it was, in output time.
    for &i in &impulses {
        let want = i / 2;
        let peak = (want - 200..want + 200).max_by_key(|&k| samples[k * 2].abs()).unwrap();
        assert!(
            (peak as i64 - want as i64).abs() <= 1,
            "impulse at input {i} peaked at output {peak}, expected {want}"
        );
    }

    // Sine vs analytic reference, away from the edges.
    let scale = full as f64;
    let mut max_err = 0f64;
    for k in 4800..(got as usize - 4800) {
        let want = 0.5 * (2.0 * PI * 1000.0 * k as f64 / dst as f64).sin();
        let err = (samples[k * 2 + 1] as f64 / scale - want).abs();
        max_err = max_err.max(err);
    }
    // ~1 LSB at 24-bit; a one-sample misalignment would be ~0.07.
    assert!(max_err < 1e-6, "resampled sine deviates by {max_err}");
}

#[test]
fn hires_88k_resamples_to_44k() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    let frames = 88_200 + 3;
    let pcm = signal(frames, 2, 24, 88_200);
    write_flac(&input, &pcm, 2, 24, 88_200, None);

    let r = run(json!({ "input": input, "output": output }));
    assert_eq!(r.code, 0, "events: {:?}", r.events);
    let done = r.last();
    assert_eq!(done["sampleRate"], 44_100);
    assert_eq!(done["sourceSampleRate"], 88_200);
    assert_eq!(done["resampled"], true);
    let got = done["frames"].as_i64().unwrap();
    let expected = (frames as f64 / 2.0).round() as i64;
    assert!((got - expected).abs() <= 1, "frames {got} vs expected {expected}");
    let (spec, _) = read_wav(&output);
    assert_eq!(spec.sample_rate, 44_100);
}

#[test]
fn tags_write_info_and_id3_with_cover() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    let png: Vec<u8> = b"\x89PNG\r\n\x1a\nfake-image-bytes".to_vec();
    let pcm = signal(10_001, 2, 16, 44_100);
    write_flac(&input, &pcm, 2, 16, 44_100, Some(&png));

    let r = run(json!({
        "input": input, "output": output, "maxSampleRate": 48000,
        "tags": {
            "title": "Song [WAV]", "artist": "A, B", "album": null, "genre": "House",
            "label": "Lbl", "bpm": 123.6, "key": "8A", "year": 2021, "comment": "hi",
            "trackNo": 3
        },
        "cover": true
    }));
    assert_eq!(r.code, 0, "events: {:?}", r.events);

    let h = wav_writer::read_header(&output).unwrap();
    let ids: Vec<&[u8]> = h.chunk_ids.iter().map(|c| &c[..]).collect();
    assert_eq!(ids, vec![&b"fmt "[..], b"data", b"LIST", b"id3 "]);

    let list = wav_writer::read_chunk(&output, b"LIST").unwrap().unwrap();
    assert_eq!(&list[0..4], b"INFO");
    let find = |needle: &[u8]| list.windows(needle.len()).any(|w| w == needle);
    assert!(find(b"INAM"));
    assert!(find(b"Song [WAV]\0"));
    assert!(find(b"ICRD"));
    assert!(!find(b"IPRD"), "null album must be omitted");

    let id3_bytes = wav_writer::read_chunk(&output, b"id3 ").unwrap().unwrap();
    let tag = id3::Tag::read_from2(std::io::Cursor::new(id3_bytes)).expect("id3 parses");
    use id3::TagLike;
    assert_eq!(tag.version(), id3::Version::Id3v23);
    assert_eq!(tag.title(), Some("Song [WAV]"));
    assert_eq!(tag.artist(), Some("A, B"));
    assert_eq!(tag.get("TBPM").and_then(|f| f.content().text()), Some("124"));
    assert_eq!(tag.get("TKEY").and_then(|f| f.content().text()), Some("8A"));
    assert_eq!(tag.get("TPUB").and_then(|f| f.content().text()), Some("Lbl"));
    assert_eq!(tag.get("TYER").and_then(|f| f.content().text()), Some("2021"));
    assert_eq!(tag.get("TRCK").and_then(|f| f.content().text()), Some("3"));
    assert!(tag.get("TALB").is_none());
    assert!(tag.get("TSRC").is_none(), "ISRC must never be written");
    let pic = tag.pictures().next().expect("APIC present");
    assert_eq!(pic.data, png);
    assert_eq!(pic.mime_type, "image/png");
    assert_eq!(tag.comments().next().map(|c| c.text.as_str()), Some("hi"));

    // Metadata after data must not disturb the audio.
    let (_, samples) = read_wav(&output);
    assert_eq!(samples, pcm);
}

#[test]
fn cover_false_omits_picture_and_no_tags_omits_chunks() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let pcm = signal(5_000, 2, 16, 44_100);
    write_flac(&input, &pcm, 2, 16, 44_100, Some(b"\x89PNGxx"));

    let out1 = dir.path().join("a.wav.part");
    let r = run(json!({ "input": input, "output": out1, "tags": { "title": "T" }, "cover": false }));
    assert_eq!(r.code, 0);
    let id3_bytes = wav_writer::read_chunk(&out1, b"id3 ").unwrap().unwrap();
    let tag = id3::Tag::read_from2(std::io::Cursor::new(id3_bytes)).unwrap();
    assert_eq!(tag.pictures().count(), 0);

    let out2 = dir.path().join("b.wav.part");
    let r = run(json!({ "input": input, "output": out2, "cover": false }));
    assert_eq!(r.code, 0);
    let h = wav_writer::read_header(&out2).unwrap();
    assert_eq!(h.chunk_ids.len(), 2, "no tags + no cover → just fmt + data");
}

#[test]
fn progress_is_throttled_and_monotonic() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    let frames = 44_100 * 20;
    write_flac(&input, &signal(frames, 2, 16, 44_100), 2, 16, 44_100, None);
    let r = run(json!({ "input": input, "output": output }));
    assert_eq!(r.code, 0);
    assert_eq!(r.events[0]["kind"], "started");
    let progress = r.kind("progress");
    assert!(!progress.is_empty() && progress.len() <= 51, "{} progress events", progress.len());
    let mut last = 0;
    for p in &progress {
        let f = p["frames"].as_u64().unwrap();
        assert!(f > last && f <= frames as u64);
        assert_eq!(p["totalFrames"], frames);
        last = f;
    }
}

#[test]
fn missing_input_reports_error_and_leaves_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("out.wav.part");
    let r = run(json!({ "input": dir.path().join("nope.flac"), "output": output }));
    assert_eq!(r.code, 1);
    assert_eq!(r.events.len(), 1);
    assert_eq!(r.last()["kind"], "error");
    assert!(r.last()["message"].as_str().unwrap().contains("nope.flac"));
    assert!(!output.exists());
}

#[test]
fn unreadable_input_deletes_nothing_it_did_not_create() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("garbage.flac");
    fs::write(&input, b"not audio at all").unwrap();
    let output = dir.path().join("out.wav.part");
    let r = run(json!({ "input": input, "output": output }));
    assert_eq!(r.code, 1);
    assert_eq!(r.last()["kind"], "error");
    assert!(!output.exists());
    assert!(input.exists());
}

#[test]
fn output_equal_to_input_is_refused_and_input_survives() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    write_flac(&input, &signal(3_000, 2, 16, 44_100), 2, 16, 44_100, None);
    let before = fs::read(&input).unwrap();
    let r = run(json!({ "input": input, "output": input }));
    assert_eq!(r.code, 1);
    assert_eq!(fs::read(&input).unwrap(), before);
}

#[test]
fn truncated_flac_errors_and_removes_partial_output() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    write_flac(&input, &signal(44_100 * 3, 2, 16, 44_100), 2, 16, 44_100, None);
    let bytes = fs::read(&input).unwrap();
    fs::write(&input, &bytes[..bytes.len() * 2 / 3]).unwrap();
    let r = run(json!({ "input": input, "output": output }));
    assert_eq!(r.code, 1, "events: {:?}", r.events);
    assert_eq!(r.last()["kind"], "error");
    assert!(r.last()["message"].as_str().unwrap().contains("truncated"), "events: {:?}", r.events);
    assert!(!output.exists(), "partial output must be deleted");
}

#[test]
fn corrupted_flac_errors_instead_of_skipping_audio() {
    let dir = tempfile::tempdir().unwrap();
    let input = dir.path().join("in.flac");
    let output = dir.path().join("out.wav.part");
    write_flac(&input, &signal(44_100 * 3, 2, 16, 44_100), 2, 16, 44_100, None);
    let mut bytes = fs::read(&input).unwrap();
    let mid = bytes.len() / 2;
    for b in &mut bytes[mid..mid + 64] {
        *b ^= 0x5a;
    }
    fs::write(&input, &bytes).unwrap();
    let r = run(json!({ "input": input, "output": output }));
    assert_eq!(r.code, 1, "events: {:?}", r.events);
    assert_eq!(r.last()["kind"], "error");
    assert!(!output.exists());
}

#[test]
fn invalid_job_json_is_an_error() {
    let mut out = Vec::new();
    assert_eq!(run_job_line("{not json", &mut out), 1);
    let v: Value = serde_json::from_slice(out.trim_ascii_end()).unwrap();
    assert_eq!(v["kind"], "error");
}

#[test]
fn target_rate_rules() {
    assert_eq!(target_sample_rate(44_100, 48_000), 44_100);
    assert_eq!(target_sample_rate(48_000, 48_000), 48_000);
    assert_eq!(target_sample_rate(88_200, 48_000), 44_100);
    assert_eq!(target_sample_rate(176_400, 48_000), 44_100);
    assert_eq!(target_sample_rate(96_000, 48_000), 48_000);
    assert_eq!(target_sample_rate(192_000, 48_000), 48_000);
    assert_eq!(target_sample_rate(96_000, 44_100), 44_100);
    assert_eq!(target_sample_rate(64_000, 48_000), 48_000);
}

#[test]
fn quantise_rounds_and_clamps() {
    // Exact for narrower sources.
    assert_eq!(quantise_lj(-32768 << 16, 16), -32768);
    assert_eq!(quantise_lj(32767 << 16, 16), 32767);
    assert_eq!(quantise_lj(8_388_607 << 8, 24), 8_388_607);
    // 32-bit → 24-bit rounds half up and clamps at +full scale.
    assert_eq!(quantise_lj(0x7f, 24), 0);
    assert_eq!(quantise_lj(0x80, 24), 1);
    assert_eq!(quantise_lj(-0x81, 24), -1);
    assert_eq!(quantise_lj(i32::MAX, 24), 8_388_607);
    assert_eq!(quantise_lj(i32::MIN, 24), -8_388_608);
    assert_eq!(quantise_f64(1.5, 16), 32767);
    assert_eq!(quantise_f64(-1.5, 16), -32768);
}
