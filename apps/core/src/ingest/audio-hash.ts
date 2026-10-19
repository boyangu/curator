// Tag-independent identity of a file's audio stream.
//
// Every writer that touches a library file — rekordbox, ID3 editors, our own
// tag rewrites — changes the file's bytes, size and mtime but not the encoded
// audio. The scanner's path+mtime identity therefore breaks on exactly the
// edits users make most (the 2026-06 re-bind incident); this key does not.
// It is also the per-file tier of the shared catalogue's claim edges, so the
// scheme prefix is part of the value: two keys compare only within a scheme.
//
//   pcm-md5:<hex>     FLAC / WAV / AIFF — MD5 of the raw interleaved PCM as
//                     signed little-endian samples. FLAC stores exactly this
//                     in STREAMINFO (a 42-byte header read, no decode); WAV's
//                     `data` chunk IS those bytes for 16/24-bit PCM; AIFF is
//                     the same samples big-endian, swapped while hashing. So
//                     a lossless transcode keeps its key across the three.
//   mp3-sha256:<hex>  MP3 — sha256 of the frame region (ID3v2 stripped from
//                     the head; ID3v1, APEv2 and Lyrics3v2 from the tail).
//   mp4-sha256:<hex>  MP4/M4A — sha256 over every `mdat` payload in file
//                     order (`moov` may sit before or after; tag edits only
//                     touch `moov`).
//
// Anything else, or a container that does not parse, is null — the caller
// stores null and the path+mtime identity carries the file as before.

import { createHash, type Hash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { extname } from 'node:path';

// Same high-water mark as the backup engine's streaming sha256: large enough
// that a 60 MB FLAC's `data`-sized reads are a few dozen syscalls, small
// enough not to hold a whole file in memory per ingest worker.
const CHUNK = 1 << 20;

export async function audioHash(path: string): Promise<string | null> {
	let fh: FileHandle;
	try {
		fh = await open(path, 'r');
	} catch {
		return null;
	}
	try {
		const size = (await fh.stat()).size;
		const head = await readAt(fh, 0, 12);
		if (head.length < 12) return null;

		const id3End = id3v2End(head);
		const magic = id3End > 0 ? await readAt(fh, id3End, 4) : head.subarray(0, 4);
		const tag = magic.toString('latin1');

		// `return await`, not `return`: the finally below closes the handle, and
		// a bare returned promise would still be reading through it.
		if (tag === 'fLaC') return await flac(fh, id3End);
		if (tag === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') return await wav(fh, size);
		const form = head.toString('latin1', 8, 12);
		if (tag === 'FORM' && (form === 'AIFF' || form === 'AIFC')) return await aiff(fh, size);
		if (head.toString('latin1', 4, 8) === 'ftyp') return await mp4(fh, size);
		// MP3 has no container magic: accept a frame sync right after the tag,
		// or the extension when the file opens with junk/padding before it.
		const isSync = magic[0] === 0xff && (magic[1]! & 0xe0) === 0xe0;
		if (isSync || extname(path).toLowerCase() === '.mp3') return await mp3(fh, id3End, size);
		return null;
	} catch {
		return null;
	} finally {
		await fh.close().catch(() => {});
	}
}

// ─── ID3v2 ────────────────────────────────────────────────────────────────

// Byte offset just past a leading ID3v2 tag, or 0 when the file has none.
// Size is 28-bit syncsafe (bytes 6–9); flag bit 4 of byte 5 means a 10-byte
// footer follows the tag body.
function id3v2End(head: Buffer): number {
	if (head.toString('latin1', 0, 3) !== 'ID3') return 0;
	const size = ((head[6]! & 0x7f) << 21) | ((head[7]! & 0x7f) << 14) | ((head[8]! & 0x7f) << 7) | (head[9]! & 0x7f);
	return 10 + size + (head[5]! & 0x10 ? 10 : 0);
}

// ─── FLAC ─────────────────────────────────────────────────────────────────

async function flac(fh: FileHandle, at: number): Promise<string | null> {
	// Block header: bit 7 = last-block flag, bits 0–6 = type (0 = STREAMINFO,
	// mandatory first block), then a 24-bit big-endian length (34 for
	// STREAMINFO). The MD5 is the block's last 16 bytes (offset 18).
	const hdr = await readAt(fh, at + 4, 4);
	if (hdr.length < 4 || (hdr[0]! & 0x7f) !== 0) return null;
	const len = (hdr[1]! << 16) | (hdr[2]! << 8) | hdr[3]!;
	if (len !== 34) return null;
	const info = await readAt(fh, at + 8, 34);
	if (info.length < 34) return null;
	const md5 = info.subarray(18, 34);
	// Encoders may leave the signature unset (all zero); that is "unknown",
	// not a key — two such files must not collide.
	if (md5.every((b) => b === 0)) return null;
	return `pcm-md5:${md5.toString('hex')}`;
}

// ─── WAV ──────────────────────────────────────────────────────────────────

async function wav(fh: FileHandle, size: number): Promise<string | null> {
	let pos = 12;
	while (pos + 8 <= size) {
		const ch = await readAt(fh, pos, 8);
		if (ch.length < 8) return null;
		const id = ch.toString('latin1', 0, 4);
		const len = ch.readUInt32LE(4);
		const payload = pos + 8;
		if (id === 'data') {
			// Streaming writers leave the length 0 or 0xFFFFFFFF ("to end of
			// file"); clamp to the file either way so a truncated length can't
			// read past EOF. The pad byte for odd sizes is framing, not PCM.
			const avail = size - payload;
			const n = len === 0 || len === 0xffffffff ? avail : Math.min(len, avail);
			const h = createHash('md5');
			await hashRange(fh, h, payload, payload + n);
			return `pcm-md5:${h.digest('hex')}`;
		}
		pos = payload + len + (len & 1);
	}
	return null;
}

// ─── AIFF / AIFC ──────────────────────────────────────────────────────────

async function aiff(fh: FileHandle, size: number): Promise<string | null> {
	const isAifc = (await readAt(fh, 8, 4)).toString('latin1') === 'AIFC';
	let bytesPerSample: number | null = null;
	let swap = true;
	let ssnd: { start: number; end: number } | null = null;
	let pos = 12;
	// COMM normally precedes SSND but nothing mandates it — walk the whole
	// chunk list first, then hash.
	while (pos + 8 <= size) {
		const ch = await readAt(fh, pos, 8);
		if (ch.length < 8) return null;
		const id = ch.toString('latin1', 0, 4);
		const len = ch.readUInt32BE(4);
		const payload = pos + 8;
		if (id === 'COMM') {
			// numChannels(2) numSampleFrames(4) sampleSize(2) sampleRate(10)
			// [compressionType(4) on AIFC].
			const comm = await readAt(fh, payload, Math.min(len, 22));
			if (comm.length < 18) return null;
			bytesPerSample = Math.ceil(comm.readUInt16BE(6) / 8);
			if (isAifc) {
				// 'sowt' is the little-endian variant Apple writes — already in
				// FLAC's byte order. Anything other than raw PCM isn't PCM to hash.
				const comp = comm.length >= 22 ? comm.toString('latin1', 18, 22) : 'NONE';
				if (comp === 'sowt') swap = false;
				else if (comp !== 'NONE') return null;
			}
		} else if (id === 'SSND') {
			// offset(4) blockSize(4) then the sample frames, `offset` bytes in.
			const hdr = await readAt(fh, payload, 8);
			if (hdr.length < 8) return null;
			const start = payload + 8 + hdr.readUInt32BE(0);
			ssnd = { start, end: Math.min(payload + len, size) };
		}
		pos = payload + len + (len & 1);
	}
	if (!ssnd || bytesPerSample == null || ssnd.end <= ssnd.start) return null;
	const h = createHash('md5');
	await hashRange(fh, h, ssnd.start, ssnd.end, swap ? bytesPerSample : 1);
	return `pcm-md5:${h.digest('hex')}`;
}

// ─── MP3 ──────────────────────────────────────────────────────────────────

async function mp3(fh: FileHandle, start: number, size: number): Promise<string | null> {
	let end = size;
	// ID3v1 is always outermost; APEv2 and Lyrics3v2 sit before it in either
	// order, so strip those in a loop until nothing more matches.
	if (end - start >= 128 && (await readAt(fh, end - 128, 3)).toString('latin1') === 'TAG') end -= 128;
	for (let guard = 0; guard < 4; guard++) {
		let stripped = false;
		if (end - start >= 15) {
			// "<6-digit size>LYRICS200": the size counts from LYRICSBEGIN up to
			// the size field, so the whole block is size + 15.
			const tail = await readAt(fh, end - 15, 15);
			if (tail.toString('latin1', 6, 15) === 'LYRICS200') {
				const n = Number.parseInt(tail.toString('latin1', 0, 6), 10);
				if (Number.isFinite(n) && n >= 0 && end - start >= n + 15) { end -= n + 15; stripped = true; }
			}
		}
		if (end - start >= 32) {
			// Footer: "APETAGEX" version(4) size(4) items(4) flags(4) reserved(8).
			// `size` covers items + footer, not the optional header (flag bit 31).
			const foot = await readAt(fh, end - 32, 32);
			if (foot.toString('latin1', 0, 8) === 'APETAGEX') {
				const tagSize = foot.readUInt32LE(12);
				const hasHeader = (foot.readUInt32LE(20) & 0x80000000) !== 0;
				const total = tagSize + (hasHeader ? 32 : 0);
				if (end - start >= total) { end -= total; stripped = true; }
			}
		}
		if (!stripped) break;
	}
	if (end <= start) return null;
	const h = createHash('sha256');
	await hashRange(fh, h, start, end);
	return `mp3-sha256:${h.digest('hex')}`;
}

// ─── MP4 / M4A ────────────────────────────────────────────────────────────

async function mp4(fh: FileHandle, size: number): Promise<string | null> {
	const h = createHash('sha256');
	let found = false;
	let pos = 0;
	while (pos + 8 <= size) {
		const hdr = await readAt(fh, pos, 16);
		if (hdr.length < 8) return null;
		const size32 = hdr.readUInt32BE(0);
		const type = hdr.toString('latin1', 4, 8);
		let hdrLen = 8;
		let boxSize: number;
		if (size32 === 1) {
			// 64-bit largesize follows the type — the shape `mdat` takes past 4 GB.
			if (hdr.length < 16) return null;
			boxSize = Number(hdr.readBigUInt64BE(8));
			hdrLen = 16;
		} else if (size32 === 0) {
			boxSize = size - pos;
		} else {
			boxSize = size32;
		}
		if (boxSize < hdrLen || pos + boxSize > size) return null;
		if (type === 'mdat') {
			await hashRange(fh, h, pos + hdrLen, pos + boxSize);
			found = true;
		}
		pos += boxSize;
	}
	return found ? `mp4-sha256:${h.digest('hex')}` : null;
}

// ─── Byte-range helpers ───────────────────────────────────────────────────

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
	const buf = Buffer.alloc(len);
	const { bytesRead } = await fh.read(buf, 0, len, pos);
	return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

// Feed [start, end) into `h` in CHUNK-sized reads. `swapWidth` > 1 reverses
// the bytes of every `swapWidth`-byte sample first (AIFF big-endian → the
// little-endian order FLAC's MD5 is defined over); a sample split across two
// reads is carried into the next.
async function hashRange(fh: FileHandle, h: Hash, start: number, end: number, swapWidth = 1): Promise<void> {
	const buf = Buffer.allocUnsafe(CHUNK);
	let carry: Buffer | null = null;
	let pos = start;
	while (pos < end) {
		const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, end - pos), pos);
		if (bytesRead === 0) throw new Error(`short read at ${pos}`);
		pos += bytesRead;
		let chunk: Buffer = buf.subarray(0, bytesRead);
		if (swapWidth > 1) {
			if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
			const whole = chunk.length - (chunk.length % swapWidth);
			if (whole < chunk.length) carry = Buffer.from(chunk.subarray(whole));
			chunk = chunk.subarray(0, whole);
			swapSamples(chunk, swapWidth);
		}
		h.update(chunk);
	}
	// A trailing partial sample is a malformed file; hash it as-is rather than
	// drop bytes, so the key still changes if the content does.
	if (carry) h.update(carry);
}

function swapSamples(buf: Buffer, width: number): void {
	if (width === 2) { buf.swap16(); return; }
	if (width === 4) { buf.swap32(); return; }
	for (let i = 0; i + width <= buf.length; i += width) {
		for (let a = i, b = i + width - 1; a < b; a++, b--) {
			const t = buf[a]!;
			buf[a] = buf[b]!;
			buf[b] = t;
		}
	}
}
