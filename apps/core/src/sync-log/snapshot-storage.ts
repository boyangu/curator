// Reading a master-published snapshot out of Storage ('snapshot_storage';
// protocol cloud-service.ts). A bootstrap answered with a manifest names the
// parts; the device downloads them straight from the `snapshots` bucket with
// its own session and joins them into the gzip body. Every byte is checked
// before anything is inflated: each part's size and sha256, then the joined
// body's size and sha256 — a part swapped, short or corrupt in transit fails
// here, not as a half-loaded library.
//
// Shared by the desktop's HTTP transport and the test cloud, so the rig
// exercises the same checks the app runs.

import { createHash } from 'node:crypto';
import { MAX_SNAPSHOT_PARTS, SNAPSHOT_STORAGE_ENCODING, type SnapshotManifest } from '@curator/protocol';
import { CloudTransportError } from './client.js';

// The account's `snapshots` bucket, as the signed-in user. Objects are
// content-addressed and immutable: `upload` of a path that already exists is
// success. Errors are the transport's own (the desktop's map Storage's HTTP
// status like the catalogue's blobs do).
export interface SnapshotBlobStore {
	upload(path: string, bytes: Uint8Array): Promise<void>;
	download(path: string): Promise<Uint8Array>;
	remove(paths: string[]): Promise<void>;
}

// Parts in flight at once: a 37 MB body is five 8 MB parts.
const DOWNLOAD_CONCURRENCY = 4;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export async function readStorageSnapshotBody(
	manifest: SnapshotManifest,
	download: (path: string) => Promise<Uint8Array>,
	opts: { maxBytes: number; concurrency?: number },
): Promise<Buffer> {
	if (manifest.encoding !== SNAPSHOT_STORAGE_ENCODING) throw new CloudTransportError('bad_request', `unknown snapshot encoding ${String(manifest.encoding)}`);
	const parts = manifest.parts;
	if (parts.length === 0 || parts.length > MAX_SNAPSHOT_PARTS) throw new CloudTransportError('server', `snapshot manifest names ${parts.length} parts`);
	const stated = parts.reduce((n, p) => n + p.bytes, 0);
	if (stated !== manifest.totalBytes) throw new CloudTransportError('server', `snapshot parts add up to ${stated} bytes, not ${manifest.totalBytes}`);
	if (manifest.totalBytes > opts.maxBytes) throw new CloudTransportError('bad_request', `snapshot body of ${manifest.totalBytes} bytes is past the cap`);
	const out: Uint8Array[] = new Array(parts.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (let i = next++; i < parts.length; i = next++) {
			const p = parts[i]!;
			const bytes = await download(p.path);
			if (bytes.byteLength !== p.bytes || sha256(bytes) !== p.sha256) throw new CloudTransportError('server', `snapshot part ${i} does not match its manifest`);
			out[i] = bytes;
		}
	};
	await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? DOWNLOAD_CONCURRENCY, parts.length) }, worker));
	const body = Buffer.concat(out);
	if (body.length !== manifest.totalBytes || sha256(body) !== manifest.sha256) throw new CloudTransportError('server', 'snapshot body does not match its manifest');
	return body;
}
