// Small primitives shared by the engine and the restore paths: streaming
// sha256, zstd to/from files, atomic file copies, free-space lookups.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { constants as zc, createZstdCompress, createZstdDecompress } from 'node:zlib';
import type { BackupEncoding } from './types.js';

// Measured on the real library (planning/tech/backup.md): level 3 is within
// a couple of points of level 9 and 3-4x faster.
const ZSTD_LEVEL = 3;

export async function sha256File(path: string, signal?: AbortSignal, onBytes?: (n: number) => void): Promise<string> {
	const h = createHash('sha256');
	const rs = createReadStream(path, { signal, highWaterMark: 1 << 20 });
	for await (const chunk of rs) {
		h.update(chunk as Buffer);
		onBytes?.((chunk as Buffer).length);
	}
	return h.digest('hex');
}

export function sha256Buffer(buf: Buffer): string {
	return createHash('sha256').update(buf).digest('hex');
}

// Compress `src` to `dest` (atomic via .part + rename). Returns the stored size.
export async function zstdCompressFile(src: string, dest: string, signal?: AbortSignal): Promise<number> {
	await mkdir(dirname(dest), { recursive: true });
	const part = `${dest}.part`;
	await pipeline(
		createReadStream(src, { signal, highWaterMark: 1 << 20 }),
		createZstdCompress({ params: { [zc.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }),
		createWriteStream(part),
	);
	await rename(part, dest);
	return (await stat(dest)).size;
}

export function zstdCompressBuffer(buf: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const z = createZstdCompress({ params: { [zc.ZSTD_c_compressionLevel]: ZSTD_LEVEL } });
		z.on('data', (c: Buffer) => chunks.push(c));
		z.on('end', () => resolve(Buffer.concat(chunks)));
		z.on('error', reject);
		z.end(buf);
	});
}

export function zstdDecompressBuffer(buf: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		const z = createZstdDecompress();
		z.on('data', (c: Buffer) => chunks.push(c));
		z.on('end', () => resolve(Buffer.concat(chunks)));
		z.on('error', reject);
		z.end(buf);
	});
}

// Decode a downloaded object into its final file while hashing the decoded
// bytes — one pass verifies integrity and produces the file.
export async function decodeObjectToFile(src: string, dest: string, enc: BackupEncoding, signal?: AbortSignal): Promise<{ sha256: string; size: number }> {
	await mkdir(dirname(dest), { recursive: true });
	const part = `${dest}.part`;
	const h = createHash('sha256');
	let size = 0;
	const tap = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
		for await (const chunk of source) { h.update(chunk); size += chunk.length; yield chunk; }
	};
	const rs = createReadStream(src, { signal, highWaterMark: 1 << 20 });
	if (enc === 'zstd') await pipeline(rs, createZstdDecompress(), tap, createWriteStream(part));
	else await pipeline(rs, tap, createWriteStream(part));
	await rename(part, dest);
	return { sha256: h.digest('hex'), size };
}

export async function copyFileAtomic(src: string, dest: string): Promise<void> {
	await mkdir(dirname(dest), { recursive: true });
	const part = `${dest}.part`;
	await rm(part, { force: true });
	await copyFile(src, part);
	await rename(part, dest);
}

// statfs needs an existing path — walk up to the nearest existing ancestor.
export async function freeBytesAt(dir: string): Promise<number | null> {
	let p = dir;
	for (let i = 0; i < 32; i++) {
		if (existsSync(p)) {
			try {
				const s = await statfs(p);
				return Number(s.bavail) * Number(s.bsize);
			} catch {
				return null;
			}
		}
		const up = dirname(p);
		if (up === p) break;
		p = up;
	}
	return null;
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || (err as NodeJS.ErrnoException).code === 'ABORT_ERR');
}

// Bounded parallel map: at most `limit` tasks in flight, stops scheduling
// new work once the signal aborts (in-flight tasks see the signal themselves).
export async function parallel<T>(items: T[], limit: number, signal: AbortSignal | undefined, fn: (item: T, index: number) => Promise<void>): Promise<void> {
	let next = 0;
	let firstError: unknown = null;
	const worker = async (): Promise<void> => {
		while (next < items.length && !signal?.aborted && firstError == null) {
			const i = next++;
			try { await fn(items[i]!, i); }
			catch (err) { if (firstError == null) firstError = err; }
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	if (firstError != null) throw firstError;
}
