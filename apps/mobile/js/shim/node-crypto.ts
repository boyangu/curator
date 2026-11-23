// node:crypto as the sync client uses it: SHA-1 (row fingerprints, version-5
// ids), SHA-256 (the snapshot parts' check) and random ids. All the host's.

import { host } from './host.js';
import { Buffer } from './globals.js';

type Hash = { update(data: string | Uint8Array, enc?: string): Hash; digest(enc?: string): string | Uint8Array };

const BITS: Record<string, number> = { sha1: 160, sha256: 256 };

// Fed as it goes: a replica's whole file passes through one of these a part
// at a time (sync-log/replica.ts), and must never be held whole.
export function createHash(algorithm: string): Hash {
	const bits = BITS[algorithm];
	if (!bits) throw new Error(`the phone host hashes sha1 and sha256, not ${algorithm}`);
	const running = host.hashOpen(bits);
	const hash: Hash = {
		update(data, enc) {
			if (typeof data === 'string' && enc !== undefined && enc !== 'utf8' && enc !== 'utf-8') throw new Error(`hash.update(string, ${enc}) is not in the phone's crypto`);
			host.hashUpdate(running, data);
			return hash;
		},
		digest(enc) {
			if (enc === 'hex') return host.hashDigest(running, true);
			if (enc !== undefined) throw new Error(`hash.digest(${enc}) is not in the phone's crypto`);
			return Buffer.from(host.hashDigest(running, false));
		},
	};
	return hash;
}

export function randomUUID(): string {
	return host.randomUUID();
}
