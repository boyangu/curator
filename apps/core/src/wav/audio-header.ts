// Cheap container-header reads (no decode) for the two formats Convert to WAV
// cares about: the FLAC it reads and the WAV it writes. Used for the preview's
// size estimate and to describe a WAV to rekordbox (SampleRate/BitDepth/
// BitRate on the created DjmdContent row) without asking the converter again.

import { open } from 'node:fs/promises';

export interface AudioFormat {
	container: 'flac' | 'wav';
	sampleRate: number;
	bitDepth: number;
	channels: number;
	// Sample frames per channel; null when the header doesn't say (FLAC
	// streams may leave STREAMINFO's total at 0).
	frames: number | null;
}

async function readAt(path: string, position: number, length: number): Promise<Buffer> {
	const fh = await open(path, 'r');
	try {
		const buf = Buffer.alloc(length);
		const { bytesRead } = await fh.read(buf, 0, length, position);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

export async function readFlacFormat(path: string): Promise<AudioFormat | null> {
	let head = await readAt(path, 0, 64);
	let base = 0;
	// A leading ID3v2 tag (some taggers prepend one to FLAC) — skip it.
	if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
		const size = ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f);
		base = 10 + size + ((head[5]! & 0x10) ? 10 : 0);
		head = await readAt(path, base, 64);
	}
	if (head.length < 42 || head.toString('latin1', 0, 4) !== 'fLaC') return null;
	// First metadata block must be STREAMINFO (type 0, 34 bytes).
	if ((head[4]! & 0x7f) !== 0) return null;
	const si = head.subarray(8, 8 + 34);
	const sampleRate = (si[10]! << 12) | (si[11]! << 4) | (si[12]! >> 4);
	const channels = ((si[12]! >> 1) & 0x07) + 1;
	const bitDepth = (((si[12]! & 0x01) << 4) | (si[13]! >> 4)) + 1;
	const frames = (si[13]! & 0x0f) * 2 ** 32 + si.readUInt32BE(14);
	if (!sampleRate) return null;
	return { container: 'flac', sampleRate, bitDepth, channels, frames: frames > 0 ? frames : null };
}

export async function readWavFormat(path: string): Promise<AudioFormat | null> {
	const fh = await open(path, 'r');
	try {
		const hdr = Buffer.alloc(12);
		if ((await fh.read(hdr, 0, 12, 0)).bytesRead < 12) return null;
		if (hdr.toString('latin1', 0, 4) !== 'RIFF' || hdr.toString('latin1', 8, 12) !== 'WAVE') return null;
		let pos = 12;
		let fmt: { channels: number; sampleRate: number; bitDepth: number; blockAlign: number } | null = null;
		const ch = Buffer.alloc(24);
		// Walk chunk headers only — never read the PCM payload.
		for (let i = 0; i < 64; i++) {
			const { bytesRead } = await fh.read(ch, 0, 24, pos);
			if (bytesRead < 8) break;
			const id = ch.toString('latin1', 0, 4);
			const size = ch.readUInt32LE(4);
			if (id === 'fmt ' && bytesRead >= 24) {
				fmt = { channels: ch.readUInt16LE(10), sampleRate: ch.readUInt32LE(12), blockAlign: ch.readUInt16LE(20), bitDepth: ch.readUInt16LE(22) };
			} else if (id === 'data' && fmt) {
				return { container: 'wav', sampleRate: fmt.sampleRate, bitDepth: fmt.bitDepth, channels: fmt.channels, frames: fmt.blockAlign ? Math.floor(size / fmt.blockAlign) : null };
			}
			pos += 8 + size + (size & 1);
		}
		return null;
	} finally {
		await fh.close();
	}
}

export async function readAudioFormat(path: string): Promise<AudioFormat | null> {
	try {
		const lower = path.toLowerCase();
		if (lower.endsWith('.flac')) return await readFlacFormat(path);
		if (lower.endsWith('.wav')) return await readWavFormat(path);
		return null;
	} catch {
		return null;
	}
}

// Output format for a source: bit-exact at the source rate/depth up to the
// cap older Pioneer decks support (48 kHz / 24-bit). Above it, resample to
// the same-family rate (88.2/176.4 → 44.1; 96/192 → 48) — the time axis is
// preserved, so the original's cues and beatgrid stay valid.
export const WAV_MAX_SAMPLE_RATE = 48000;

export function planWavOutput(src: { sampleRate: number; bitDepth: number }, maxRate = WAV_MAX_SAMPLE_RATE): { sampleRate: number; bitDepth: number; resampled: boolean } {
	const bitDepth = src.bitDepth <= 16 ? 16 : 24;
	if (src.sampleRate <= maxRate) return { sampleRate: src.sampleRate, bitDepth, resampled: false };
	const sampleRate = Math.min(maxRate, src.sampleRate % 44100 === 0 ? 44100 : 48000);
	return { sampleRate, bitDepth, resampled: true };
}

export function estimateWavBytes(src: AudioFormat, durationSec: number | null): number {
	const out = planWavOutput(src);
	const srcFrames = src.frames ?? (durationSec != null ? durationSec * src.sampleRate : 0);
	const frames = srcFrames * (out.sampleRate / src.sampleRate);
	return Math.round(frames * src.channels * (out.bitDepth / 8)) + 4096;
}
