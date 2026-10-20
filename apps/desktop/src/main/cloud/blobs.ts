// The shared analysis catalogue's blob store (core CatalogueBlobStore) over
// Supabase Storage, as the signed-in user. Waveform `.cpk` files (and, at
// stage D-b, vector packs) go straight between this device and the private
// `catalogue` bucket under `<uid>/…`: the API holds no service key and never
// sees the bytes, it only checks an object exists before it records an item.
// The bucket's policies (apps/cloud sql/storage.sql) are the guard: own
// prefix only, insert only while the account is entitled and under quota, no
// update at all — objects are content-addressed and immutable.
//
// Errors are mapped to CatalogueBlobError kinds from Storage's HTTP status
// and service code, never from message text, except the one Storage answers
// for an existing object, which the old API spelled only in its message.
//
// Logging (area `catalogue-blobs`): failures at warn with status and code,
// successes at debug with size and duration. Never a path's contents, never
// a token.

import { CATALOGUE_BUCKET } from '@curator/protocol';
import { CatalogueBlobError, type CatalogueBlobStore } from '@curator/core';
import { mainLog } from '../log.js';
import type { CloudAccount } from './account.js';

const blog = mainLog.for('catalogue-blobs');

type StorageErrorLike = { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown; name?: unknown };

function facts(err: unknown): { status: number | null; code: string | null; name: string | null } {
	const e = (err ?? {}) as StorageErrorLike;
	const status = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'string' && /^\d{3}$/.test(e.statusCode) ? Number(e.statusCode) : null;
	const code = typeof e.code === 'string' && /^[A-Za-z_]{1,64}$/.test(e.code) ? e.code : null;
	const name = typeof e.name === 'string' && /^[A-Za-z]{1,64}$/.test(e.name) ? e.name : null;
	return { status, code, name };
}

// An upload of a path that already exists: content-addressed, so the bytes
// there are these bytes — success.
function alreadyExists(err: unknown): boolean {
	const f = facts(err);
	if (f.status === 409 || f.code === 'ResourceAlreadyExists' || f.code === 'Duplicate') return true;
	const m = (err as StorageErrorLike | null)?.message;
	return typeof m === 'string' && /already exists|duplicate/i.test(m);
}

function mapError(err: unknown): CatalogueBlobError {
	const f = facts(err);
	if (f.status === 404 || f.code === 'NoSuchKey' || f.code === 'not_found') return new CatalogueBlobError('not_found', `HTTP ${f.status ?? '?'}`);
	if (f.status === 403 || f.status === 401 || f.code === 'AccessDenied' || f.code === 'InvalidJWT') return new CatalogueBlobError('denied', `HTTP ${f.status ?? '?'}${f.code ? ` ${f.code}` : ''}`);
	if (f.status === 413 || f.code === 'EntityTooLarge') return new CatalogueBlobError('too_large', 'object too large');
	// Storage answers an RLS refusal of an insert as 400 "new row violates
	// row-level security policy" — the entitlement / quota gate.
	const m = (err as StorageErrorLike | null)?.message;
	if (f.status === 400 && typeof m === 'string' && /row-level security/i.test(m)) return new CatalogueBlobError('denied', 'HTTP 400 rls');
	// No status (network), 5xx, 429: try again later.
	return new CatalogueBlobError('transient', f.status ? `HTTP ${f.status}` : (f.name ?? 'network'));
}

export function createCatalogueBlobStore(account: CloudAccount): CatalogueBlobStore {
	const bucket = () => account.storage().from(CATALOGUE_BUCKET);
	return {
		async upload(path, bytes) {
			const t0 = performance.now();
			const { error } = await bucket().upload(path, bytes, { upsert: false, contentType: 'application/octet-stream' });
			if (error && !alreadyExists(error)) {
				const mapped = mapError(error);
				blog.warn('upload failed', { kind: mapped.kind, ...facts(error), bytes: bytes.byteLength });
				throw mapped;
			}
			blog.debug('upload', { bytes: bytes.byteLength, existed: !!error, ms: Math.round(performance.now() - t0) });
		},
		async download(path) {
			const t0 = performance.now();
			const { data, error } = await bucket().download(path);
			if (error || !data) {
				const mapped = mapError(error);
				blog.warn('download failed', { kind: mapped.kind, ...facts(error) });
				throw mapped;
			}
			const out = new Uint8Array(await data.arrayBuffer());
			blog.debug('download', { bytes: out.byteLength, ms: Math.round(performance.now() - t0) });
			return out;
		},
		async remove(paths) {
			if (paths.length === 0) return;
			const { error } = await bucket().remove(paths);
			if (error) {
				const mapped = mapError(error);
				blog.warn('remove failed', { kind: mapped.kind, ...facts(error), count: paths.length });
				throw mapped;
			}
			blog.debug('removed', { count: paths.length });
		},
	};
}
