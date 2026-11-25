// Supabase Storage for a host without supabase-js (the phone): one object's
// bytes, as the signed-in user (apps/cloud/sql/storage.sql judges the path).
// Every path is content-addressed and checked by its reader, so this only has
// to say whether the bytes came, and why not.

import { CloudTransportError } from './client.js';

export type StorageDeps = {
	supabaseUrl: string;
	publishableKey: string;
	// As fetch-transport's, with the answer's bytes.
	get(url: string, headers: Record<string, string>): Promise<{ status: number; bytes: Uint8Array }>;
	accessToken(opts?: { refresh?: boolean }): Promise<string | null>;
	utf8(bytes: Uint8Array): string;
};

// The object is not there (any more): a newer snapshot replaced the one being
// read, whose reader starts over from the newer one.
export class StorageGoneError extends Error {
	override readonly name = 'StorageGoneError';
}

// Storage answers a missing object as 404, or as 400 with the 404 in its body.
function statusOf(status: number, body: string): number {
	if (status !== 400) return status;
	try {
		const b = JSON.parse(body) as { statusCode?: unknown; error?: unknown; code?: unknown } | null;
		if (b?.error === 'not_found' || b?.code === 'NoSuchKey') return 404;
		const n = Number(b?.statusCode);
		return Number.isInteger(n) && n >= 400 ? n : status;
	} catch {
		return status;
	}
}

// `path` is one of ours (snapshotPartPath, catalogueBlobPath): no escaping.
export function createStorageDownload(deps: StorageDeps): (bucket: string, path: string) => Promise<Uint8Array> {
	const fetchOnce = async (url: string, token: string | null) => {
		try {
			return await deps.get(url, { apikey: deps.publishableKey, ...(token ? { authorization: `Bearer ${token}` } : {}) });
		} catch (err) {
			if (err instanceof CloudTransportError) throw err;
			throw new CloudTransportError('network', err instanceof Error ? err.message : String(err));
		}
	};
	return async (bucket, path) => {
		const url = `${deps.supabaseUrl}/storage/v1/object/authenticated/${bucket}/${path}`;
		let res = await fetchOnce(url, await deps.accessToken());
		let status = res.status === 200 ? 200 : statusOf(res.status, deps.utf8(res.bytes));
		// A token the clock or the server retired early: once more with a fresh one.
		if (status === 401 || status === 403) {
			res = await fetchOnce(url, await deps.accessToken({ refresh: true }));
			status = res.status === 200 ? 200 : statusOf(res.status, deps.utf8(res.bytes));
		}
		if (status === 200) return res.bytes;
		if (status === 404) throw new StorageGoneError(`${bucket}: no such object`);
		if (status === 401 || status === 403) throw new CloudTransportError('auth', `storage HTTP ${status}`);
		throw new CloudTransportError(status === 429 || status >= 500 ? 'network' : 'server', `storage HTTP ${status}`);
	};
}
