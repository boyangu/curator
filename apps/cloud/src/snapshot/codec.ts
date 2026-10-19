// Snapshot transport encoding on the server: the protocol's canonical JSON
// (`serializeLibraryState`, packages/protocol/src/snapshot.ts) gzipped, and
// base64 on the wire (`SNAPSHOT_ENCODING`). The JSON half lives in the
// protocol so the desktop and the phone decode with the same code; only the
// node:zlib part is here.

import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { deserializeLibraryState, serializeLibraryState, type LibraryState } from '@curator/protocol';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export async function encodeSnapshot(state: LibraryState): Promise<Buffer> {
	return gzipAsync(Buffer.from(serializeLibraryState(state), 'utf8'), { level: 9 });
}

// The cap bounds what a corrupt or hostile body can inflate to; a 40k-track
// library is tens of MB of JSON, two orders of magnitude below it.
const MAX_INFLATED_BYTES = 1024 * 1024 * 1024;

export async function decodeSnapshot(body: Uint8Array): Promise<LibraryState> {
	const json = await gunzipAsync(body, { maxOutputLength: MAX_INFLATED_BYTES });
	return deserializeLibraryState(json.toString('utf8'));
}

export async function decodeSnapshotBase64(b64: string): Promise<LibraryState> {
	return decodeSnapshot(Buffer.from(b64, 'base64'));
}
