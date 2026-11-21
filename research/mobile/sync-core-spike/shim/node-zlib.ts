// node:zlib as the snapshot transport uses it: inflate one gzip body. (The
// fake cloud's own snapshot helper also deflates; a phone never does.)

import { host } from './host.js';
import { Buffer } from './globals.js';

export function gunzipSync(body: Uint8Array): Uint8Array {
	return Buffer.from(host.gunzip(body));
}

// The fake cloud's own bootstrap inflates with a Node stream; on this host
// the driver hands the client the host's inflater instead (src/driver.ts).
export function createGunzip(): never {
	throw new Error('createGunzip is not in the spike host: the driver inflates the snapshot with the host');
}

export function gzipSync(): never {
	throw new Error('gzipSync is not in the spike host: a phone reads snapshots, it does not publish them');
}
