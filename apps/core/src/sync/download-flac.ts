// Node-side port of tidalext's proc.audio.js FlacProcessor.
//
// Given a base64-encoded DASH manifest (returned by /v1/tracks/{id}/playbackinfo
// for FLAC streams), this:
//   1. Parses the manifest for init segment URL + media template + segment count
//   2. Fetches the init segment, extracts STREAMINFO from the dfLa atom
//   3. Builds a FLAC header (signature + STREAMINFO + Vorbis comments + optional PICTURE)
//   4. Fetches each media segment, extracts MDAT atoms (FLAC frames)
//   5. Concatenates everything into `<outputPath>.part`, then renames to
//      outputPath once complete — the final path only ever holds a whole
//      file (rename is atomic on NTFS/same volume)
//
// Pure Node — no DOM, no Blob/URL. Concurrency is bounded by a small pool to
// avoid hammering Tidal's CDN.

import { Buffer } from 'node:buffer';
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../log.js';

const dlog = log.for('download-flac');

const MDAT = 0x6D646174; // 'mdat'
const DFLA = 0x64664C61; // 'dfLa'
const FLAC_SIG = 0x664C6143; // 'fLaC'

export interface FlacMetadata {
	TITLE?: string;
	ARTIST?: string;
	ALBUM?: string;
	ALBUMARTIST?: string;
	DATE?: string;
	TRACKNUMBER?: string;
	DISCNUMBER?: string;
	ISRC?: string;
	BPM?: string;
	// Windows Explorer's "Producers" column on FLAC files reads from the
	// PRODUCER Vorbis comment. We mirror the LABEL value into PRODUCER so
	// the label shows up in Explorer alongside Genre/BPM/Key. Standard
	// LABEL tag is still written for tools that read it directly.
	PRODUCER?: string;
	[k: string]: string | undefined;
}

export interface CoverImage {
	data: Buffer;          // image bytes
	mime: string;          // "image/jpeg" / "image/png"
}

export interface DownloadFlacOpts {
	manifestBase64: string;
	outputPath: string;
	metadata?: FlacMetadata;
	cover?: CoverImage | null;
	parallelSegments?: number;
	onProgress?: (info: { pct: number; segIdx: number; segTotal: number; bytes: number }) => void;
}

export async function downloadFlac(opts: DownloadFlacOpts): Promise<{ bytes: number }> {
	const manifestXml = Buffer.from(opts.manifestBase64, 'base64').toString('utf8');
	const m = parseDashManifest(manifestXml);

	const segConcurrency = Math.max(1, Math.min(opts.parallelSegments ?? 4, 8));
	const totalSegs = m.segmentCount + 1; // +1 for init
	const segDone = new Uint32Array(totalSegs);
	// Running byte total — every fetchBuffered increments this when its
	// segment lands. The renderer reads it via onProgress.bytes for the
	// "downloaded size" column without waiting for the final stat().
	let bytesSoFar = 0;
	const report = (segIdx: number, doneFlag: number, segBytes: number) => {
		segDone[segIdx] = doneFlag;
		bytesSoFar += segBytes;
		if (!opts.onProgress) return;
		const sum = segDone.reduce((a, b) => a + b, 0);
		const pct = Math.min(100, Math.floor((sum / totalSegs) * 100));
		opts.onProgress({ pct, segIdx, segTotal: totalSegs, bytes: bytesSoFar });
	};

	// 1) Init segment → STREAMINFO
	const initBuf = await fetchBuffered(m.initialization, 0, report);
	const streamInfo = extractStreamInfo(initBuf);
	if (!streamInfo) throw new Error('STREAMINFO not found in init segment');
	validateStreamInfo(streamInfo);

	// 2) FLAC header bytes
	const meta = opts.metadata ?? {};
	const tagKeys = Object.entries(meta).filter(([, v]) => v).map(([k]) => k);
	dlog.debug('writing tags', { tags: tagKeys, cover: opts.cover ? `${opts.cover.mime} ${opts.cover.data.length}b` : 'none' });
	const header = buildFlacHeader(streamInfo, meta, opts.cover ?? null);
	dlog.debug('FLAC header built (signature+STREAMINFO=42; rest is VORBIS_COMMENT/PICTURE)', { headerBytes: header.length, hasPicture: !!opts.cover });
	validateFlacMagic(header, 'built header');

	// 3) Download media segments (bounded concurrency, ordered writes)
	await fsp.mkdir(dirname(opts.outputPath), { recursive: true });
	// Stream into a .part sibling, not the final path. The download dir is
	// watched — by our own scanner and often by rekordbox auto-import — and a
	// watcher that reads the file mid-stream imports a truncated FLAC with
	// unreadable tags (this minted an artist-less rekordbox row on 2026-07-26).
	// The final name only appears via the atomic rename below, so watchers can
	// only ever see a complete file. `.part` also keeps the file out of
	// audio-extension globs. Truncate-on-open ('w+') self-heals a stale .part
	// left by a crashed run.
	const partPath = `${opts.outputPath}.part`;
	// 'w+' (read-write, truncate-on-open) — 'w' would block the final FLAC-
	// magic check below because read() on a write-only handle returns EBADF.
	const out = await fsp.open(partPath, 'w+');
	let bytes: number;
	try {
		try {
			await out.write(header);

			// Worker pool: launch up to segConcurrency in flight; results are
			// awaited and written in order so the FLAC frame stream stays valid.
			const next = (() => { let n = 0; return () => n++; })();
			const inflight = new Map<number, Promise<Buffer[]>>();

			const launch = (segIdx: number) => {
				const url = m.mediaTemplate.replace('$Number$', String(m.startNumber + segIdx));
				inflight.set(segIdx, (async () => {
					const buf = await fetchBuffered(url, segIdx + 1, report);
					return extractMdatPayloads(buf);
				})());
			};

			// Prime the pool
			for (let i = 0; i < Math.min(segConcurrency, m.segmentCount); i++) launch(next());

			// Drain in order
			for (let i = 0; i < m.segmentCount; i++) {
				const promise = inflight.get(i);
				if (!promise) throw new Error(`segment ${i} not in flight`);
				const chunks = await promise;
				inflight.delete(i);
				for (const c of chunks) if (c.length) await out.write(c);
				const j = next();
				if (j < m.segmentCount) launch(j);
			}

			const stat = await out.stat();
			// Final assembled-file integrity check — peek the first 4 bytes and
			// confirm the FLAC magic. Cheap (single 4-byte read) and catches the
			// case where the header write somehow landed wrong but no other
			// validation caught it.
			const head = Buffer.alloc(4);
			await out.read(head, 0, 4, 0);
			validateFlacMagic(head, 'assembled file');
			// Flush to disk before the rename publishes the file — a rename can
			// survive a crash that the buffered data didn't.
			await out.sync();
			bytes = stat.size;
		} finally {
			await out.close();
		}
	} catch (err) {
		await fsp.unlink(partPath).catch(() => {});
		throw err;
	}
	await fsp.rename(partPath, opts.outputPath);
	return { bytes };
}

// ─── DASH manifest parsing (regex — simpler than a full XML parser) ──────

interface DashManifest {
	initialization: string;
	mediaTemplate: string;
	startNumber: number;
	segmentCount: number;
}

function parseDashManifest(xml: string): DashManifest {
	const init = /\sinitialization="([^"]+)"/i.exec(xml)?.[1];
	const media = /\smedia="([^"]+)"/i.exec(xml)?.[1];
	const startStr = /\sstartNumber="(\d+)"/i.exec(xml)?.[1];
	if (!init || !media) throw new Error('DASH manifest missing initialization or media template');
	const startNumber = startStr ? parseInt(startStr, 10) : 1;
	// Sum all <S r="N"/> entries (r is repeat count; default 0 = one segment).
	let segmentCount = 0;
	const sRe = /<S\b[^/]*\/>/gi;
	let m: RegExpExecArray | null;
	while ((m = sRe.exec(xml))) {
		const r = /\sr="(\d+)"/i.exec(m[0])?.[1];
		segmentCount += 1 + (r ? parseInt(r, 10) : 0);
	}
	if (segmentCount < 1) throw new Error('DASH manifest has no segments');
	return { initialization: init, mediaTemplate: media, startNumber, segmentCount };
}

// ─── Fetch with retries + integrity check ────────────────────────────────

async function fetchBuffered(
	url: string,
	segIdx: number,
	report: (segIdx: number, doneFlag: number, segBytes: number) => void
): Promise<Buffer> {
	const maxAttempts = 3;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const res = await fetch(url);
			if (res.status >= 500 && attempt < maxAttempts) {
				lastErr = new Error(`http ${res.status}`);
			} else if (!res.ok) {
				throw new Error(`segment ${segIdx} http ${res.status}`);
			} else {
				const ab = await res.arrayBuffer();
				const cl = res.headers.get('content-length');
				if (cl != null) {
					const expected = parseInt(cl, 10);
					if (Number.isFinite(expected) && expected !== ab.byteLength) {
						const err = new Error(`segment ${segIdx} truncated: got ${ab.byteLength} bytes, expected ${expected}`);
						if (attempt < maxAttempts) { lastErr = err; }
						else throw err;
						await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
						continue;
					}
				}
				// Report both the done-flag (1) and the byte count so the
				// caller can drive both the percent and the size readout.
				report(segIdx, 1, ab.byteLength);
				return Buffer.from(ab);
			}
		} catch (err) {
			lastErr = err;
			if (attempt === maxAttempts) break;
		}
		await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
	}
	throw new Error(`segment ${segIdx} failed after ${maxAttempts} attempts: ${(lastErr as Error)?.message}`);
}

// ─── MP4/MDAT extraction ─────────────────────────────────────────────────

function extractMdatPayloads(buffer: Buffer): Buffer[] {
	const out: Buffer[] = [];
	let i = 0;
	while (i + 8 <= buffer.length) {
		let size = buffer.readUInt32BE(i);
		const type = buffer.readUInt32BE(i + 4);
		let headerSize = 8;
		if (size === 1) {
			if (i + 16 > buffer.length) break;
			// 64-bit size — read low 32 bits (anything > 2GB unrealistic for one segment)
			const hi = buffer.readUInt32BE(i + 8);
			const lo = buffer.readUInt32BE(i + 12);
			size = hi * 0x100000000 + lo;
			headerSize = 16;
		} else if (size === 0) {
			size = buffer.length - i;
		}
		if (size < headerSize || i + size > buffer.length + 1024) { i++; continue; }
		if (type === MDAT) {
			out.push(buffer.subarray(i + headerSize, Math.min(i + size, buffer.length)));
		}
		i += size;
	}
	return out;
}

// ─── STREAMINFO extraction from init segment's dfLa atom ─────────────────

function extractStreamInfo(buffer: Buffer): Buffer | null {
	for (let p = 4; p < buffer.length - 4; p++) {
		if (buffer.readUInt32BE(p) !== DFLA) continue;
		const boxStart = p - 4;
		const boxSize = buffer.readUInt32BE(boxStart);
		if (boxSize < 50 || boxStart + boxSize > buffer.length) continue;
		const blockHeader = buffer.readUInt32BE(p + 8);
		const blockType = (blockHeader >>> 24) & 0x7F;
		if (blockType !== 0) continue;
		const start = p + 12;
		return buffer.subarray(start, start + 34);
	}
	return null;
}

function validateStreamInfo(si: Buffer): void {
	if (!si || si.length !== 34) throw new Error(`STREAMINFO bad length: ${si?.length}`);
	const sampleRate = (si.readUInt32BE(10) >>> 12) & 0xFFFFF;
	if (sampleRate < 1 || sampleRate > 655350) throw new Error(`STREAMINFO bad sample rate: ${sampleRate}`);
	const channels = ((si.readUInt8(12) >>> 1) & 0x07) + 1;
	if (channels < 1 || channels > 8) throw new Error(`STREAMINFO bad channels: ${channels}`);
	const bps = (((si.readUInt8(12) & 0x01) << 4) | (si.readUInt8(13) >>> 4)) + 1;
	if (bps < 4 || bps > 32) throw new Error(`STREAMINFO bad bit depth: ${bps}`);
}

function validateFlacMagic(buf: Buffer, label: string): void {
	if (buf.length < 4 || buf[0] !== 0x66 || buf[1] !== 0x4C || buf[2] !== 0x61 || buf[3] !== 0x43)
		throw new Error(`FLAC magic missing in ${label}`);
}

// ─── FLAC header builder ─────────────────────────────────────────────────

const VENDOR = Buffer.from('Flaque', 'utf8');

function buildFlacHeader(streamInfo: Buffer, metadata: FlacMetadata, cover: CoverImage | null): Buffer {
	const vorbisBlock = buildVorbisComment(metadata);
	const pictureBlock = cover ? buildPictureBlock(cover) : null;
	let total = 4 + 4 + 34 + 4 + vorbisBlock.length;
	if (pictureBlock) total += 4 + pictureBlock.length;
	const out = Buffer.alloc(total);
	let pos = 0;
	out.writeUInt32BE(FLAC_SIG, pos); pos += 4;
	out.writeUInt32BE(0x00000022, pos); pos += 4; // STREAMINFO header: type=0, not-last, size=34
	streamInfo.copy(out, pos); pos += 34;
	// VORBIS_COMMENT block, type=4
	const isLast = !pictureBlock;
	const vorbHeader = ((isLast ? 1 : 0) << 31) | (4 << 24) | (vorbisBlock.length & 0xFFFFFF);
	out.writeUInt32BE(vorbHeader >>> 0, pos); pos += 4;
	vorbisBlock.copy(out, pos); pos += vorbisBlock.length;
	if (pictureBlock) {
		// PICTURE block, type=6, last
		const picHeader = (1 << 31) | (6 << 24) | (pictureBlock.length & 0xFFFFFF);
		out.writeUInt32BE(picHeader >>> 0, pos); pos += 4;
		pictureBlock.copy(out, pos); pos += pictureBlock.length;
	}
	return out;
}

function buildVorbisComment(metadata: FlacMetadata): Buffer {
	const entries: Buffer[] = [];
	for (const [k, v] of Object.entries(metadata)) {
		if (!v) continue;
		entries.push(Buffer.from(`${k.toUpperCase()}=${v}`, 'utf8'));
	}
	let total = 4 + VENDOR.length + 4;
	for (const e of entries) total += 4 + e.length;
	const block = Buffer.alloc(total);
	let pos = 0;
	block.writeUInt32LE(VENDOR.length, pos); pos += 4;
	VENDOR.copy(block, pos); pos += VENDOR.length;
	block.writeUInt32LE(entries.length, pos); pos += 4;
	for (const e of entries) {
		block.writeUInt32LE(e.length, pos); pos += 4;
		e.copy(block, pos); pos += e.length;
	}
	return block;
}

function buildPictureBlock(cover: CoverImage): Buffer {
	const mimeBytes = Buffer.from(cover.mime, 'utf8');
	const total = 32 + mimeBytes.length + cover.data.length;
	const block = Buffer.alloc(total);
	let pos = 0;
	block.writeUInt32BE(3, pos); pos += 4;                          // picture type 3 = Cover (front)
	block.writeUInt32BE(mimeBytes.length, pos); pos += 4;
	mimeBytes.copy(block, pos); pos += mimeBytes.length;
	block.writeUInt32BE(0, pos); pos += 4;                          // description length
	block.writeUInt32BE(0, pos); pos += 4;                          // width  (unknown)
	block.writeUInt32BE(0, pos); pos += 4;                          // height (unknown)
	block.writeUInt32BE(24, pos); pos += 4;                         // colour depth
	block.writeUInt32BE(0, pos); pos += 4;                          // indexed colours
	block.writeUInt32BE(cover.data.length, pos); pos += 4;
	cover.data.copy(block, pos);
	return block;
}
