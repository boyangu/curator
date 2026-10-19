//! Hand-rolled RIFF/WAVE writer for `convert` mode, plus a small header
//! parser used to verify what we wrote.
//!
//! Hand-rolled rather than a WAV crate because the target hardware is
//! picky in ways crates don't promise to respect: older Pioneer CDJs
//! (2000/900/NXS, XDJ-1000/700/RX) reject 24-bit files written with a
//! WAVE_FORMAT_EXTENSIBLE (0xFFFE) header, which is exactly what most
//! writers (hound included) emit for >16-bit. We always write a plain
//! 16-byte PCM `fmt ` (format tag 1), put `data` straight after it, and
//! append metadata chunks (`LIST`/`INFO`, `id3 `) *after* the audio —
//! older firmware parses fmt→data linearly and is safest that way.
//!
//! Layout: RIFF hdr (12) · `fmt ` (8+16) · `data` (8+N[+pad]) · trailer.
//! `data` is streamed with placeholder sizes that get patched on finish.

use anyhow::{anyhow, bail, Context, Result};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

const WAVE_FORMAT_PCM: u16 = 1;
/// Offset of the `data` chunk's size field: RIFF(12) + fmt chunk(24) + "data"(4).
const DATA_SIZE_OFFSET: u64 = 40;
/// Bytes before the first sample: RIFF(12) + fmt chunk(24) + data header(8).
pub const HEADER_LEN: u64 = 44;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavFormat {
    pub channels: u16,
    pub sample_rate: u32,
    /// 16 or 24 — the only depths convert mode produces.
    pub bits_per_sample: u16,
}

impl WavFormat {
    pub fn bytes_per_sample(&self) -> u16 {
        self.bits_per_sample / 8
    }

    pub fn block_align(&self) -> u16 {
        self.channels * self.bytes_per_sample()
    }
}

/// Total file size for `data_bytes` of audio followed by `trailer_len` bytes
/// of (already padded) metadata chunks. u64 so callers can compare against
/// the RIFF u32 ceiling without overflowing first.
pub fn file_size_for(data_bytes: u64, trailer_len: u64) -> u64 {
    HEADER_LEN + data_bytes + (data_bytes & 1) + trailer_len
}

/// RIFF sizes are u32 and count everything after the 8-byte RIFF header,
/// so the whole file is capped at u32::MAX + 8 bytes.
pub fn fits_riff(data_bytes: u64, trailer_len: u64) -> bool {
    data_bytes <= u32::MAX as u64 && file_size_for(data_bytes, trailer_len) - 8 <= u32::MAX as u64
}

pub struct WavWriter {
    out: BufWriter<File>,
    format: WavFormat,
    data_bytes: u64,
    trailer_len: u64,
    scratch: Vec<u8>,
}

impl WavWriter {
    /// Creates (truncating) `path` and writes the header with placeholder
    /// sizes. `trailer_len` is the size of the metadata that `finish` will
    /// append — it's needed up front so `write_samples` can refuse to grow
    /// the file past the RIFF limit instead of discovering it at the end.
    pub fn create(path: &Path, format: WavFormat, trailer_len: u64) -> Result<Self> {
        if !matches!(format.bits_per_sample, 16 | 24) {
            bail!("unsupported output bit depth {}", format.bits_per_sample);
        }
        let file = File::create(path).with_context(|| format!("create {}", path.display()))?;
        let mut out = BufWriter::with_capacity(1 << 20, file);
        let block_align = format.block_align();
        let byte_rate = format.sample_rate * block_align as u32;

        out.write_all(b"RIFF")?;
        out.write_all(&0u32.to_le_bytes())?;
        out.write_all(b"WAVE")?;
        out.write_all(b"fmt ")?;
        out.write_all(&16u32.to_le_bytes())?;
        out.write_all(&WAVE_FORMAT_PCM.to_le_bytes())?;
        out.write_all(&format.channels.to_le_bytes())?;
        out.write_all(&format.sample_rate.to_le_bytes())?;
        out.write_all(&byte_rate.to_le_bytes())?;
        out.write_all(&block_align.to_le_bytes())?;
        out.write_all(&format.bits_per_sample.to_le_bytes())?;
        out.write_all(b"data")?;
        out.write_all(&0u32.to_le_bytes())?;

        Ok(Self { out, format, data_bytes: 0, trailer_len, scratch: Vec::new() })
    }

    /// Appends interleaved samples already quantised to the output depth
    /// (i.e. in the signed 16- or 24-bit range).
    pub fn write_samples(&mut self, samples: &[i32]) -> Result<()> {
        let bps = self.format.bytes_per_sample() as usize;
        if samples.len() % self.format.channels as usize != 0 {
            bail!("sample count {} is not a whole number of frames", samples.len());
        }
        let new_total = self.data_bytes + (samples.len() * bps) as u64;
        if !fits_riff(new_total, self.trailer_len) {
            bail!("output would exceed the 4 GiB WAV size limit");
        }
        self.scratch.clear();
        self.scratch.reserve(samples.len() * bps);
        if bps == 2 {
            for &s in samples {
                self.scratch.extend_from_slice(&(s as i16).to_le_bytes());
            }
        } else {
            for &s in samples {
                self.scratch.extend_from_slice(&s.to_le_bytes()[..3]);
            }
        }
        self.out.write_all(&self.scratch).context("write audio data")?;
        self.data_bytes = new_total;
        Ok(())
    }

    pub fn frames_written(&self) -> u64 {
        self.data_bytes / self.format.block_align() as u64
    }

    /// Pads `data`, appends the metadata trailer (whole chunks, already
    /// padded), patches the size fields, and fsyncs. Returns the final file
    /// size. The RIFF size is patched last so a crash mid-finish leaves a
    /// header that still reads as "incomplete" (size 0).
    pub fn finish(mut self, trailer: &[u8]) -> Result<u64> {
        if trailer.len() as u64 != self.trailer_len {
            bail!("metadata trailer is {} bytes, expected {}", trailer.len(), self.trailer_len);
        }
        if self.data_bytes & 1 == 1 {
            self.out.write_all(&[0])?;
        }
        self.out.write_all(trailer).context("write metadata chunks")?;
        let total = file_size_for(self.data_bytes, self.trailer_len);

        let mut file = self.out.into_inner().map_err(|e| anyhow!("flush output: {}", e.error()))?;
        file.seek(SeekFrom::Start(DATA_SIZE_OFFSET))?;
        file.write_all(&(self.data_bytes as u32).to_le_bytes())?;
        file.seek(SeekFrom::Start(4))?;
        file.write_all(&((total - 8) as u32).to_le_bytes())?;
        file.sync_all().context("fsync output")?;
        Ok(total)
    }
}

/// One RIFF chunk: id + LE size + body + pad byte when the body is odd.
pub fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + body.len() + 1);
    out.extend_from_slice(id);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(body);
    if body.len() & 1 == 1 {
        out.push(0);
    }
    out
}

/// Builds a complete `LIST` chunk of type `INFO` from (id, value) pairs,
/// skipping empty values. Returns an empty Vec when nothing is left, so
/// callers can concatenate unconditionally.
///
/// Values are written as UTF-8. INFO has no declared encoding; UTF-8 is what
/// ffmpeg and most modern taggers write, and the `id3 ` chunk (UTF-16) is
/// what rekordbox/CDJs actually prefer for display anyway.
pub fn info_list(entries: &[(&[u8; 4], &str)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, value) in entries {
        // Interior NULs would truncate the field for every reader.
        let clean: String = value.chars().filter(|c| *c != '\0').collect();
        let clean = clean.trim();
        if clean.is_empty() {
            continue;
        }
        let mut text = clean.as_bytes().to_vec();
        text.push(0);
        body.extend_from_slice(&chunk(id, &text));
    }
    if body.is_empty() {
        return Vec::new();
    }
    let mut list = b"INFO".to_vec();
    list.extend_from_slice(&body);
    chunk(b"LIST", &list)
}

#[derive(Debug, Clone)]
pub struct WavHeaderInfo {
    pub format_tag: u16,
    pub channels: u16,
    pub sample_rate: u32,
    pub bits_per_sample: u16,
    pub block_align: u16,
    pub data_size: u32,
    pub file_size: u64,
    /// Chunk ids in file order, e.g. ["fmt ", "data", "LIST", "id3 "].
    pub chunk_ids: Vec<[u8; 4]>,
}

/// Walks every chunk of a WAV file and returns the decoded `fmt ` plus the
/// chunk layout. Errors if the structure is inconsistent (sizes overrunning
/// the file, missing fmt/data, RIFF size not matching the file length) —
/// this is the post-write self-check, so it's strict on purpose.
pub fn read_header(path: &Path) -> Result<WavHeaderInfo> {
    let mut f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let file_size = f.metadata()?.len();
    let mut hdr = [0u8; 12];
    f.read_exact(&mut hdr).context("read RIFF header")?;
    if &hdr[0..4] != b"RIFF" || &hdr[8..12] != b"WAVE" {
        bail!("not a RIFF/WAVE file");
    }
    let riff_size = u32::from_le_bytes(hdr[4..8].try_into().unwrap());
    if riff_size as u64 + 8 != file_size {
        bail!("RIFF size {} does not match file length {}", riff_size, file_size);
    }

    let mut fmt: Option<[u8; 16]> = None;
    let mut data_size: Option<u32> = None;
    let mut chunk_ids = Vec::new();
    let mut pos = 12u64;
    while pos < file_size {
        if pos + 8 > file_size {
            bail!("truncated chunk header at offset {}", pos);
        }
        let mut ch = [0u8; 8];
        f.seek(SeekFrom::Start(pos))?;
        f.read_exact(&mut ch)?;
        let id: [u8; 4] = ch[0..4].try_into().unwrap();
        let size = u32::from_le_bytes(ch[4..8].try_into().unwrap());
        let padded = size as u64 + (size as u64 & 1);
        if pos + 8 + padded > file_size {
            bail!("chunk {:?} overruns the file", String::from_utf8_lossy(&id));
        }
        match &id {
            b"fmt " => {
                if size < 16 {
                    bail!("fmt chunk too short ({} bytes)", size);
                }
                let mut body = [0u8; 16];
                f.read_exact(&mut body)?;
                fmt = Some(body);
            }
            b"data" => data_size = Some(size),
            _ => {}
        }
        chunk_ids.push(id);
        pos += 8 + padded;
    }

    let fmt = fmt.ok_or_else(|| anyhow!("missing fmt chunk"))?;
    let data_size = data_size.ok_or_else(|| anyhow!("missing data chunk"))?;
    let u16_at = |i: usize| u16::from_le_bytes([fmt[i], fmt[i + 1]]);
    Ok(WavHeaderInfo {
        format_tag: u16_at(0),
        channels: u16_at(2),
        sample_rate: u32::from_le_bytes(fmt[4..8].try_into().unwrap()),
        block_align: u16_at(12),
        bits_per_sample: u16_at(14),
        data_size,
        file_size,
        chunk_ids,
    })
}

/// Returns the body of the first chunk with `id`, if any. Test/verification
/// helper — reads the whole chunk into memory.
#[cfg(test)]
pub fn read_chunk(path: &Path, id: &[u8; 4]) -> Result<Option<Vec<u8>>> {
    let bytes = std::fs::read(path)?;
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        if &bytes[pos..pos + 4] == id {
            return Ok(Some(bytes[pos + 8..pos + 8 + size].to_vec()));
        }
        pos += 8 + size + (size & 1);
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_list_pads_odd_values_and_skips_empty() {
        let list = info_list(&[(b"INAM", "ab"), (b"IART", ""), (b"IPRD", "abcd")]);
        // "ab\0" is 3 bytes → padded to 4; "abcd\0" is 5 → padded to 6.
        assert_eq!(&list[0..4], b"LIST");
        let size = u32::from_le_bytes(list[4..8].try_into().unwrap()) as usize;
        assert_eq!(size, 4 + (8 + 4) + (8 + 6));
        assert_eq!(list.len(), 8 + size);
        assert!(info_list(&[(b"INAM", "  ")]).is_empty());
    }

    #[test]
    fn riff_limit() {
        assert!(fits_riff(1000, 100));
        assert!(!fits_riff(u32::MAX as u64, 0));
        assert!(fits_riff(u32::MAX as u64 - 64, 0));
    }
}
