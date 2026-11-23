// node:zlib as the core uses it on the phone: inflate one gzip body (a
// snapshot or replica part arrives gzipped). A phone never publishes, so it
// never deflates; the snapshot's streamed load gets the host's inflater from
// the entry (js/entry.ts) instead of a Node stream.

import { host } from './host.js';
import { Buffer } from './globals.js';

export function gunzipSync(body: Uint8Array): Uint8Array {
	return Buffer.from(host.gunzip(body));
}

export function createGunzip(): never {
	throw new Error('createGunzip is not in the phone host: the entry inflates snapshots with the host');
}

export function gzipSync(): never {
	throw new Error('gzipSync is not in the phone host: a phone reads snapshots, it does not publish them');
}
