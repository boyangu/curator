// Fixtures are built byte-by-byte here — no real audio, no decoder — because
// the hash reads containers, not samples. The properties pinned: the key is
// the same across the lossless trio for one PCM stream, tag blocks at either
// end of an MP3 are invisible to it, box order in MP4 is irrelevant, and
// anything we can't read is null rather than a wrong key.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioHash } from './audio-hash.js';

let dir: string;
let n = 0;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-audio-hash-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(ext: string, ...parts: Buffer[]): string {
	const p = join(dir, `f${n++}${ext}`);
	writeFileSync(p, Buffer.concat(parts));
	return p;
}

const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

// Deterministic pseudo-random bytes: no two fixtures accidentally equal.
function bytes(len: number, seed: number): Buffer {
	const b = Buffer.alloc(len);
	let x = seed >>> 0 || 1;
	for (let i = 0; i < len; i++) { x = (x * 1664525 + 1013904223) >>> 0; b[i] = x >>> 24; }
	return b;
}

// ─── Fixture builders ─────────────────────────────────────────────────────

function id3v2(bodySize: number, opts?: { footer?: boolean }): Buffer {
	const h = Buffer.alloc(10);
	h.write('ID3', 0, 'latin1');
	h[3] = 4; h[4] = 0;
	h[5] = opts?.footer ? 0x10 : 0;
	h[6] = (bodySize >>> 21) & 0x7f; h[7] = (bodySize >>> 14) & 0x7f; h[8] = (bodySize >>> 7) & 0x7f; h[9] = bodySize & 0x7f;
	const body = bytes(bodySize, 7);
	return opts?.footer ? Buffer.concat([h, body, Buffer.from('3DI'), h.subarray(3)]) : Buffer.concat([h, body]);
}

function flac(md5Hex: string, prefix: Buffer = Buffer.alloc(0)): Buffer {
	const info = Buffer.alloc(34);
	Buffer.from(md5Hex, 'hex').copy(info, 18);
	const hdr = Buffer.from([0x80, 0, 0, 34]); // last-block flag | STREAMINFO, length 34
	return Buffer.concat([prefix, Buffer.from('fLaC'), hdr, info, bytes(64, 3)]);
}

function riffChunk(id: string, payload: Buffer, declaredLen = payload.length): Buffer {
	const h = Buffer.alloc(8);
	h.write(id, 0, 'latin1');
	h.writeUInt32LE(declaredLen, 4);
	return Buffer.concat([h, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function wav(pcm: Buffer, opts?: { dataLen?: number; trailer?: boolean }): Buffer {
	const fmt = Buffer.alloc(16);
	fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(44100, 4);
	fmt.writeUInt32LE(44100 * 2, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
	const chunks = [Buffer.from('WAVE'), riffChunk('fmt ', fmt), riffChunk('data', pcm, opts?.dataLen ?? pcm.length)];
	if (opts?.trailer) chunks.push(riffChunk('LIST', bytes(33, 9)));
	const body = Buffer.concat(chunks);
	const h = Buffer.alloc(8);
	h.write('RIFF', 0, 'latin1');
	h.writeUInt32LE(body.length, 4);
	return Buffer.concat([h, body]);
}

function iffChunk(id: string, payload: Buffer): Buffer {
	const h = Buffer.alloc(8);
	h.write(id, 0, 'latin1');
	h.writeUInt32BE(payload.length, 4);
	return Buffer.concat([h, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function aiff(pcmLE: Buffer): Buffer {
	const comm = Buffer.alloc(18);
	comm.writeUInt16BE(1, 0); comm.writeUInt32BE(pcmLE.length / 2, 2); comm.writeUInt16BE(16, 6);
	const be = Buffer.from(pcmLE).swap16();
	const ssnd = Buffer.concat([Buffer.alloc(8), be]); // offset 0, blockSize 0
	const body = Buffer.concat([Buffer.from('AIFF'), iffChunk('COMM', comm), iffChunk('SSND', ssnd)]);
	const h = Buffer.alloc(8);
	h.write('FORM', 0, 'latin1');
	h.writeUInt32BE(body.length, 4);
	return Buffer.concat([h, body]);
}

function mp3Frames(len: number): Buffer {
	const f = bytes(len, 11);
	f[0] = 0xff; f[1] = 0xfb; // MPEG-1 layer III sync
	return f;
}

function id3v1(): Buffer {
	const t = Buffer.alloc(128);
	t.write('TAG', 0, 'latin1');
	t.write('Some Title', 3, 'latin1');
	return t;
}

function apev2(items: number, withHeader: boolean): Buffer {
	const body = bytes(items, 5);
	const mk = (isHeader: boolean): Buffer => {
		const b = Buffer.alloc(32);
		b.write('APETAGEX', 0, 'latin1');
		b.writeUInt32LE(2000, 8);
		b.writeUInt32LE(32 + body.length, 12); // items + footer
		b.writeUInt32LE(1, 16);
		b.writeUInt32LE(((withHeader ? 0x80000000 : 0) | (isHeader ? 0x20000000 : 0)) >>> 0, 20);
		return b;
	};
	return Buffer.concat([withHeader ? mk(true) : Buffer.alloc(0), body, mk(false)]);
}

function lyrics3v2(): Buffer {
	const body = Buffer.from('LYRICSBEGINLYR00005hello', 'latin1');
	return Buffer.concat([body, Buffer.from(String(body.length).padStart(6, '0') + 'LYRICS200', 'latin1')]);
}

function box(type: string, payload: Buffer): Buffer {
	const h = Buffer.alloc(8);
	h.writeUInt32BE(8 + payload.length, 0);
	h.write(type, 4, 'latin1');
	return Buffer.concat([h, payload]);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('audioHash — lossless PCM family', () => {
	const pcm = bytes(100_000, 42);
	const key = `pcm-md5:${md5(pcm)}`;

	it('FLAC: reads the STREAMINFO MD5, with or without a leading ID3v2 tag', async () => {
		expect(await audioHash(write('.flac', flac(md5(pcm))))).toBe(key);
		expect(await audioHash(write('.flac', flac(md5(pcm), id3v2(300))))).toBe(key);
		expect(await audioHash(write('.flac', flac(md5(pcm), id3v2(2048, { footer: true }))))).toBe(key);
	});

	it('FLAC: an all-zero MD5 is unknown, not a key', async () => {
		expect(await audioHash(write('.flac', flac('00'.repeat(16))))).toBeNull();
	});

	it('FLAC: a first block that is not STREAMINFO is a parse failure', async () => {
		const bad = flac(md5(pcm));
		bad[4] = 0x84; // type 4 = VORBIS_COMMENT
		expect(await audioHash(write('.flac', bad))).toBeNull();
	});

	it('WAV: hashes the data chunk only, so it equals the FLAC key for the same PCM', async () => {
		expect(await audioHash(write('.wav', wav(pcm)))).toBe(key);
		expect(await audioHash(write('.wav', wav(pcm, { trailer: true })))).toBe(key);
	});

	it('WAV: an odd-length data chunk excludes its pad byte', async () => {
		const odd = pcm.subarray(0, 99_999);
		expect(await audioHash(write('.wav', wav(odd, { trailer: true })))).toBe(`pcm-md5:${md5(odd)}`);
	});

	it('WAV: a 0 / 0xFFFFFFFF data length means "to end of file"', async () => {
		expect(await audioHash(write('.wav', wav(pcm, { dataLen: 0 })))).toBe(key);
		expect(await audioHash(write('.wav', wav(pcm, { dataLen: 0xffffffff })))).toBe(key);
	});

	it('AIFF: byte-swaps SSND to little-endian so it equals the FLAC/WAV key', async () => {
		expect(await audioHash(write('.aiff', aiff(pcm)))).toBe(key);
	});

	it('AIFF: sample pairs split across a read boundary swap correctly', async () => {
		// Odd number of 1 MiB-sized reads plus one leftover byte per boundary.
		const big = bytes((1 << 20) * 2 + 2, 77);
		expect(await audioHash(write('.aiff', aiff(big)))).toBe(`pcm-md5:${md5(big)}`);
	});
});

describe('audioHash — MP3', () => {
	const frames = mp3Frames(50_000);
	const key = `mp3-sha256:${sha256(frames)}`;

	it('ignores the ID3v2 tag size and the ID3v1 tail', async () => {
		expect(await audioHash(write('.mp3', frames))).toBe(key);
		expect(await audioHash(write('.mp3', id3v2(100), frames))).toBe(key);
		expect(await audioHash(write('.mp3', id3v2(4000), frames, id3v1()))).toBe(key);
		expect(await audioHash(write('.mp3', id3v2(4000, { footer: true }), frames))).toBe(key);
	});

	it('strips APEv2 (with and without header) and Lyrics3v2 before ID3v1', async () => {
		expect(await audioHash(write('.mp3', frames, apev2(200, false), id3v1()))).toBe(key);
		expect(await audioHash(write('.mp3', frames, apev2(200, true), id3v1()))).toBe(key);
		expect(await audioHash(write('.mp3', frames, lyrics3v2(), id3v1()))).toBe(key);
		expect(await audioHash(write('.mp3', frames, apev2(64, true), lyrics3v2(), id3v1()))).toBe(key);
	});

	it('different frames give a different key', async () => {
		expect(await audioHash(write('.mp3', mp3Frames(50_001)))).not.toBe(key);
	});
});

describe('audioHash — MP4 / M4A', () => {
	const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0M4A mp42isom', 'latin1'));
	const mdat = bytes(80_000, 99);
	const key = `mp4-sha256:${sha256(mdat)}`;

	it('hashes mdat payloads regardless of where moov sits', async () => {
		const moovA = box('moov', bytes(500, 1));
		const moovB = box('moov', bytes(9000, 2)); // a re-tag grew the metadata
		expect(await audioHash(write('.m4a', ftyp, moovA, box('mdat', mdat)))).toBe(key);
		expect(await audioHash(write('.m4a', ftyp, box('mdat', mdat), moovB))).toBe(key);
		expect(await audioHash(write('.m4a', ftyp, moovA, box('mdat', mdat), box('free', bytes(10, 3))))).toBe(key);
	});

	it('walks a 64-bit largesize box and concatenates multiple mdat boxes', async () => {
		const first = mdat.subarray(0, 30_000);
		const rest = mdat.subarray(30_000);
		const large = Buffer.alloc(16);
		large.writeUInt32BE(1, 0);
		large.write('mdat', 4, 'latin1');
		large.writeBigUInt64BE(BigInt(16 + first.length), 8);
		expect(await audioHash(write('.m4a', ftyp, large, first, box('mdat', rest)))).toBe(key);
	});

	it('a file with no mdat is null', async () => {
		expect(await audioHash(write('.m4a', ftyp, box('moov', bytes(100, 4))))).toBeNull();
	});
});

describe('audioHash — unknown input', () => {
	it('an unrecognised file is null', async () => {
		expect(await audioHash(write('.ogg', bytes(5000, 8)))).toBeNull();
		expect(await audioHash(write('.flac', Buffer.from('not a flac at all, just text')))).toBeNull();
	});

	it('a missing or tiny file is null', async () => {
		expect(await audioHash(join(dir, 'nope.flac'))).toBeNull();
		expect(await audioHash(write('.wav', Buffer.from('RIFF')))).toBeNull();
	});
});
