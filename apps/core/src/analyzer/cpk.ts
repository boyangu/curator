// `.cpk` (Curator PeaKs) — sidecar binary blob holding per-band waveform peaks
// for one track. Written by the Python analyzer (apps/analyzer), read by the
// Node main process or the renderer (when the waveform widget lands).
//
// Two on-disk versions coexist. Both are readable; the difference is whether
// the file carries one channel (mono) or two (stereo L/R). We keep v1 readable
// because the user's library already has v1 files on disk and the rekordbox
// import path produces inherently-mono waveforms — re-analysing everything to
// upgrade the format would be wasteful and pointless for mono sources.
//
// v1 layout (all little-endian, no padding) — mono, 20-byte header:
//
//   offset   size   field
//   ──────   ────   ─────────────────────────────────────────
//   0        8      magic "CURPEAKS"
//   8        1      version              (1)
//   9        1      num_bands            (3 → low/mid/high)
//   10       2      samples_per_sec u16  (e.g. 100)
//   12       4      detail_count    u32  (samples in detail block)
//   16       4      overview_count  u32  (samples in overview block; 0 if absent)
//   20       D×B    detail bytes: [low0,mid0,high0, low1,mid1,high1, ...]
//   …        O×B    overview bytes: same layout, downsampled for strip view
//
// v2 layout — mono OR stereo, 21-byte header (inserts num_channels at byte 10):
//
//   0        8      magic "CURPEAKS"
//   8        1      version              (2)
//   9        1      num_bands            (3)
//   10       1      num_channels         (1 = mono, 2 = stereo L/R)
//   11       2      samples_per_sec u16
//   13       4      detail_count    u32
//   17       4      overview_count  u32
//   21       D×B×C  detail bytes, CHANNEL-MAJOR per sample:
//                     mono:   [low,mid,high, …]
//                     stereo: [L_low,L_mid,L_high, R_low,R_mid,R_high, …]
//   …        O×B×C  overview bytes: same layout
//
// v3 layout — adds a second METRIC per band: peak (the outline) AND rms (the
// loudness "body" the Ableton/DAW skin fills inside the outline). The header
// is byte-identical to v2 (version=3); the metric count is implied by the
// version (v1/v2 → 1, v3 → 2). Body is channel-major, METRIC-major within
// channel, band-minor:
//
//   mono:   [pk_lo,pk_mid,pk_hi, rms_lo,rms_mid,rms_hi, …]
//   stereo: L[pk_lo,pk_mid,pk_hi, rms_lo,rms_mid,rms_hi] R[pk…, rms…] …
//
// Where D = detail_count, O = overview_count, B = num_bands, C = num_channels,
// M = num_metrics. Each sample byte is uint8 (0..255). 100 samples/sec ×
// 12 bytes (stereo, peak+rms) × 300s = 360 KB for a 5-min track — still small.
//
// The format is intentionally trivial. No compression (peaks are already
// 8-bit; gzip saves ~10% and costs decode time on every track-open). No
// endian flag (LE is the only target). Versioned so future revisions can
// extend without breaking older readers.

import { promises as fsp } from 'node:fs';

export const CPK_MAGIC = Buffer.from('CURPEAKS', 'ascii');
// Current writer version. v3 carries num_channels + peak/rms; the decoder
// still reads v1 (mono peak) and v2 (mono/stereo peak).
export const CPK_VERSION = 3;
export const CPK_NUM_BANDS = 3;
// v1 header is 20 bytes; v2/v3 insert num_channels (1 byte) at offset 10.
export const CPK_HEADER_SIZE_V1 = 20;
export const CPK_HEADER_SIZE_V2 = 21;

export interface PeaksHeader {
	version: number;
	numBands: number;
	numChannels: number;
	// 1 for v1/v2 (peak only), 2 for v3 (peak + rms).
	numMetrics: number;
	samplesPerSec: number;
	detailCount: number;
	overviewCount: number;
}

// One channel's three bands. Length matches the block's sample count.
export interface PeaksBands { low: Uint8Array; mid: Uint8Array; high: Uint8Array; }

export interface Peaks {
	header: PeaksHeader;
	// Channel 0 PEAK — left channel for stereo, the mono signal otherwise. Kept
	// at the top level so mono/peak-only readers don't need to know about
	// channel count or the rms metric. We split bands out for ergonomic
	// rendering — the on-disk layout is interleaved per sample, but consumers
	// virtually always iterate one band.
	detail: PeaksBands;
	overview: PeaksBands | null;
	// Channel 1 PEAK — present only when header.numChannels === 2.
	detailRight: PeaksBands | null;
	overviewRight: PeaksBands | null;
	// RMS metric — present only when header.numMetrics === 2 (v3). Same channel
	// layout as the peak fields above.
	detailRms: PeaksBands | null;
	overviewRms: PeaksBands | null;
	detailRightRms: PeaksBands | null;
	overviewRightRms: PeaksBands | null;
}

export class CpkParseError extends Error {
	constructor(message: string) { super(message); this.name = 'CpkParseError'; }
}

// Parse a .cpk file's bytes into split-band arrays. Handles v1 (mono peak,
// 20-byte header), v2 (mono/stereo peak, 21-byte header), and v3 (mono/stereo
// peak+rms, 21-byte header) transparently. The input buffer is referenced (not
// copied) — the resulting Uint8Arrays are fresh allocations, so the source
// buffer may be released after this call.
export function decodePeaks(buf: Buffer | Uint8Array): Peaks {
	if (buf.byteLength < CPK_HEADER_SIZE_V1) {
		throw new CpkParseError(`file too short (${buf.byteLength} bytes)`);
	}
	for (let i = 0; i < CPK_MAGIC.length; i++) {
		if (buf[i] !== CPK_MAGIC[i]) throw new CpkParseError('magic mismatch — not a .cpk file');
	}
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const version = view.getUint8(8);
	if (version !== 1 && version !== 2 && version !== 3) {
		throw new CpkParseError(`unsupported version ${version} (expected 1, 2, or 3)`);
	}
	const numBands = view.getUint8(9);
	if (numBands !== CPK_NUM_BANDS) {
		throw new CpkParseError(`unexpected num_bands ${numBands} (expected ${CPK_NUM_BANDS})`);
	}
	// v1 has no num_channels field — it's mono by definition. v2/v3 insert the
	// byte at offset 10, shifting the rest of the header down by one. The
	// metric count (peak only vs peak+rms) is implied by the version.
	let numChannels: number;
	let headerSize: number;
	if (version === 1) {
		numChannels = 1;
		headerSize = CPK_HEADER_SIZE_V1;
	} else {
		numChannels = view.getUint8(10);
		headerSize = CPK_HEADER_SIZE_V2;
		if (numChannels !== 1 && numChannels !== 2) {
			throw new CpkParseError(`unexpected num_channels ${numChannels} (expected 1 or 2)`);
		}
	}
	const numMetrics = version === 3 ? 2 : 1;
	const spsOff = version === 1 ? 10 : 11;
	const samplesPerSec = view.getUint16(spsOff, true);
	const detailCount = view.getUint32(spsOff + 2, true);
	const overviewCount = view.getUint32(spsOff + 6, true);

	const stride = numBands * numMetrics * numChannels;
	const detailBytes = detailCount * stride;
	const overviewBytes = overviewCount * stride;
	const expected = headerSize + detailBytes + overviewBytes;
	if (buf.byteLength < expected) {
		throw new CpkParseError(`truncated: have ${buf.byteLength}, expected ${expected}`);
	}

	// Within a sample the groups run (ch0 peak)(ch0 rms)(ch1 peak)(ch1 rms);
	// group index = channel × numMetrics + metric, byte offset = group × bands.
	const grp = (channel: number, metric: number): number => (channel * numMetrics + metric) * numBands;
	const split = (blockOff: number, count: number, channel: number, metric: number): PeaksBands =>
		splitInterleaved(buf, blockOff, count, stride, grp(channel, metric));
	const overviewOff = headerSize + detailBytes;
	const hasOverview = overviewCount > 0;
	const stereo = numChannels === 2;
	const hasRms = numMetrics === 2;

	return {
		header: { version, numBands, numChannels, numMetrics, samplesPerSec, detailCount, overviewCount },
		detail: split(headerSize, detailCount, 0, 0),
		overview: hasOverview ? split(overviewOff, overviewCount, 0, 0) : null,
		detailRight: stereo ? split(headerSize, detailCount, 1, 0) : null,
		overviewRight: stereo && hasOverview ? split(overviewOff, overviewCount, 1, 0) : null,
		detailRms: hasRms ? split(headerSize, detailCount, 0, 1) : null,
		overviewRms: hasRms && hasOverview ? split(overviewOff, overviewCount, 0, 1) : null,
		detailRightRms: hasRms && stereo ? split(headerSize, detailCount, 1, 1) : null,
		overviewRightRms: hasRms && stereo && hasOverview ? split(overviewOff, overviewCount, 1, 1) : null,
	};
}

// De-interleave one (channel, metric) band group out of an interleaved run.
// Each sample occupies `stride` bytes; `groupOffset` is the byte index of this
// group's low band within a sample (= group × num_bands). Backed by a fresh
// allocation — most consumers want O(1) random access per band, which is
// impossible from a strided view.
function splitInterleaved(
	buf: Buffer | Uint8Array,
	offset: number,
	count: number,
	stride: number,
	groupOffset: number
): PeaksBands {
	const low = new Uint8Array(count);
	const mid = new Uint8Array(count);
	const high = new Uint8Array(count);
	for (let i = 0; i < count; i++) {
		const base = offset + i * stride + groupOffset;
		low[i] = buf[base]!;
		mid[i] = buf[base + 1]!;
		high[i] = buf[base + 2]!;
	}
	return { low, mid, high };
}

export async function readPeaksFile(path: string): Promise<Peaks> {
	const buf = await fsp.readFile(path);
	return decodePeaks(buf);
}

// Encoder — intended for tests + (rare) Node-side writes. The Python sidecar
// has its own encoder in apps/analyzer/peaks.py; this is the round-trip ref.
// Channel/metric shape is derived from what's supplied: pass `detailRight` for
// stereo, pass `detailRms` for peak+rms (v3). Peak-only stays v2; the version
// byte and the implied metric count stay coupled. Body is channel-major,
// metric-major within channel.
export interface EncodePeaksExtra {
	detailRight?: PeaksBands | null;
	overviewRight?: PeaksBands | null;
	detailRms?: PeaksBands | null;
	overviewRms?: PeaksBands | null;
	detailRightRms?: PeaksBands | null;
	overviewRightRms?: PeaksBands | null;
}
export function encodePeaks(
	samplesPerSec: number,
	detail: PeaksBands,
	overview: PeaksBands | null,
	extra: EncodePeaksExtra = {}
): Buffer {
	const detailCount = detail.low.length;
	const overviewCount = overview ? overview.low.length : 0;
	const stereo = extra.detailRight != null;
	const hasRms = extra.detailRms != null;
	const numChannels = stereo ? 2 : 1;
	const numMetrics = hasRms ? 2 : 1;
	const version = hasRms ? 3 : 2;
	const stride = CPK_NUM_BANDS * numMetrics * numChannels;

	const size = CPK_HEADER_SIZE_V2 + (detailCount + overviewCount) * stride;
	const out = Buffer.alloc(size);
	CPK_MAGIC.copy(out, 0);
	out.writeUInt8(version, 8);
	out.writeUInt8(CPK_NUM_BANDS, 9);
	out.writeUInt8(numChannels, 10);
	out.writeUInt16LE(samplesPerSec, 11);
	out.writeUInt32LE(detailCount, 13);
	out.writeUInt32LE(overviewCount, 17);

	let p = CPK_HEADER_SIZE_V2;
	// Groups in on-disk sample order: ch0 peak, ch0 rms, ch1 peak, ch1 rms —
	// only the ones present for this shape. The natural array order already
	// matches; filtering preserves it.
	const writeBlock = (count: number, groups: (PeaksBands | null | undefined)[]): void => {
		const present = groups.filter((g): g is PeaksBands => g != null);
		for (let i = 0; i < count; i++) {
			for (const g of present) {
				out[p++] = g.low[i]!;
				out[p++] = g.mid[i]!;
				out[p++] = g.high[i]!;
			}
		}
	};
	writeBlock(detailCount, [detail, extra.detailRms, extra.detailRight, extra.detailRightRms]);
	if (overview) writeBlock(overviewCount, [overview, extra.overviewRms, extra.overviewRight, extra.overviewRightRms]);
	return out;
}
