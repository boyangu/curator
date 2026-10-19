// Drive REST v3 client — just the handful of calls the backup target needs:
// folder lookup/creation, paginated listing, multipart upload for small
// files, resumable upload for everything else, ranged download, delete.
// DB-free and Electron-free; the only I/O besides fetch is reading the file
// being uploaded and writing the one being downloaded.

import { randomUUID } from 'node:crypto';
import { open, rename, stat, unlink, type FileHandle } from 'node:fs/promises';
import { DriveApiError } from './errors.js';
import {
	MAX_ATTEMPTS,
	abortError,
	backoffOrThrow,
	defaultSleep,
	describeError,
	driveRequest,
	isAbortError,
	isRetryableStatus,
	noopLog,
	parseRetryAfter,
	readError,
	type DriveLog,
	type RequestDeps,
} from './request.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Google's ceiling for uploadType=multipart; anything larger goes resumable.
export const SMALL_UPLOAD_MAX = 5 * 1024 * 1024;
// Resumable chunks must be a multiple of 256 KiB (Google rejects others).
const CHUNK_ALIGN = 256 * 1024;
const DEFAULT_CHUNK = 8 * 1024 * 1024;
const DEFAULT_LIST_FIELDS = 'id,name,size,createdTime,modifiedTime,md5Checksum,appProperties';

export interface DriveClientDeps {
	accessToken(): Promise<string>;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	random?: () => number;
	log?: DriveLog;
	// Overridable for tests only.
	baseUrls?: { api?: string; upload?: string };
}

export interface DriveFile {
	id: string;
	name: string;
	size: number | null;
	createdTime: string;
	modifiedTime: string;
	md5Checksum?: string;
	appProperties?: Record<string, string>;
	// Only present when the caller asked for it in `fields`.
	mimeType?: string;
}

export interface UploadSmallOptions {
	mimeType?: string;
	appProperties?: Record<string, string>;
	// Overwrite this existing file's content in place (PATCH) instead of
	// creating a new one — manifests, pins and library.json are rewritten.
	replaceId?: string;
}

export interface UploadResumableOptions {
	appProperties?: Record<string, string>;
	signal: AbortSignal;
	onProgress(sent: number): void;
	// Fires with the session URI before any content byte is sent, so the
	// caller can journal it for a later resume.
	onSession?(sessionUri: string): void;
	resume?: { sessionUri?: string; bytesSent: number };
	chunkBytes?: number;
}

export interface DownloadOptions {
	signal: AbortSignal;
	expectedSize: number;
	onProgress(got: number): void;
}

export interface ListOptions {
	// Per-file field list (the inner part of `files(...)`).
	fields?: string;
	pageSize?: number;
	signal?: AbortSignal;
}

interface RawFile {
	id: string;
	name: string;
	size?: string;
	createdTime?: string;
	modifiedTime?: string;
	md5Checksum?: string;
	appProperties?: Record<string, string>;
	mimeType?: string;
}

type SessionState = { kind: 'incomplete'; offset: number } | { kind: 'done'; id: string } | { kind: 'expired' };

// Drive query strings are single-quoted; only backslash and quote need escaping.
function escapeQ(s: string): string {
	return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// 308 responses report what the server holds as `Range: bytes=0-N`; the
// next byte to send is N+1. No header at all means nothing has landed yet.
function nextOffsetFromRange(range: string | null): number {
	const m = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;
	return m ? Number(m[2]) + 1 : 0;
}

function toDriveFile(f: RawFile): DriveFile {
	return {
		id: f.id,
		name: f.name,
		size: f.size === undefined ? null : Number(f.size),
		createdTime: f.createdTime ?? '',
		modifiedTime: f.modifiedTime ?? '',
		...(f.md5Checksum ? { md5Checksum: f.md5Checksum } : {}),
		...(f.appProperties ? { appProperties: f.appProperties } : {}),
		...(f.mimeType ? { mimeType: f.mimeType } : {}),
	};
}

async function readAt(fh: FileHandle, offset: number, len: number): Promise<Buffer> {
	const buf = Buffer.alloc(len);
	let got = 0;
	while (got < len) {
		const { bytesRead } = await fh.read(buf, got, len - got, offset + got);
		if (bytesRead === 0) throw new Error(`short read at ${offset + got} (wanted ${len}) — file shrank during upload?`);
		got += bytesRead;
	}
	return buf;
}

async function fileSize(path: string): Promise<number | null> {
	try {
		return (await stat(path)).size;
	} catch {
		return null;
	}
}

export class DriveClient {
	private readonly deps: RequestDeps;
	private readonly api: string;
	private readonly upload: string;

	constructor(deps: DriveClientDeps) {
		this.deps = {
			accessToken: deps.accessToken,
			fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
			sleep: deps.sleep ?? defaultSleep,
			now: deps.now ?? (() => Date.now()),
			random: deps.random ?? Math.random,
			log: deps.log ?? noopLog,
		};
		this.api = (deps.baseUrls?.api ?? 'https://www.googleapis.com/drive/v3').replace(/\/$/, '');
		this.upload = (deps.baseUrls?.upload ?? 'https://www.googleapis.com/upload/drive/v3').replace(/\/$/, '');
	}

	async about(): Promise<{ email: string | null; quotaBytes: number | null; usedBytes: number | null }> {
		const res = await driveRequest(this.deps, `${this.api}/about?fields=storageQuota,user(emailAddress)`);
		const json = (await res.json()) as { storageQuota?: { limit?: string; usage?: string }; user?: { emailAddress?: string } };
		// `limit` is absent on unlimited (Workspace) accounts.
		const limit = json.storageQuota?.limit;
		const usage = json.storageQuota?.usage;
		return {
			email: json.user?.emailAddress ?? null,
			quotaBytes: limit === undefined ? null : Number(limit),
			usedBytes: usage === undefined ? null : Number(usage),
		};
	}

	async findChild(parentId: string, name: string, opts?: { folder?: boolean; signal?: AbortSignal }): Promise<{ id: string } | null> {
		let q = `name = '${escapeQ(name)}' and '${escapeQ(parentId)}' in parents and trashed = false`;
		if (opts?.folder) q += ` and mimeType = '${FOLDER_MIME}'`;
		// Drive allows duplicate names in a folder; createdTime order makes
		// the oldest one the stable answer across calls.
		const params = new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '2', spaces: 'drive', orderBy: 'createdTime' });
		const res = await driveRequest(this.deps, `${this.api}/files?${params}`, { signal: opts?.signal });
		const json = (await res.json()) as { files?: RawFile[] };
		const files = json.files ?? [];
		const first = files[0];
		if (!first) return null;
		if (files.length > 1) this.deps.log.warn('duplicate names in Drive folder — using the oldest', { parentId, name });
		return { id: first.id };
	}

	async createFolder(parentId: string, name: string): Promise<{ id: string }> {
		const res = await driveRequest(this.deps, `${this.api}/files?fields=id`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json; charset=UTF-8' },
			body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
		});
		const json = (await res.json()) as { id: string };
		return { id: json.id };
	}

	async ensureFolder(parentId: string, name: string): Promise<{ id: string }> {
		return (await this.findChild(parentId, name, { folder: true })) ?? this.createFolder(parentId, name);
	}

	async *list(parentId: string, opts?: ListOptions): AsyncIterable<DriveFile> {
		const fields = opts?.fields ?? DEFAULT_LIST_FIELDS;
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				q: `'${escapeQ(parentId)}' in parents and trashed = false`,
				fields: `nextPageToken,files(${fields})`,
				pageSize: String(opts?.pageSize ?? 1000),
				spaces: 'drive',
			});
			if (pageToken) params.set('pageToken', pageToken);
			const res = await driveRequest(this.deps, `${this.api}/files?${params}`, { signal: opts?.signal });
			const json = (await res.json()) as { nextPageToken?: string; files?: RawFile[] };
			for (const f of json.files ?? []) yield toDriveFile(f);
			pageToken = json.nextPageToken;
		} while (pageToken);
	}

	async uploadSmall(parentId: string, name: string, bytes: Buffer, opts: UploadSmallOptions = {}): Promise<{ id: string }> {
		if (bytes.length > SMALL_UPLOAD_MAX) {
			throw new Error(`uploadSmall: ${bytes.length} bytes exceeds the ${SMALL_UPLOAD_MAX}-byte multipart limit — use uploadResumable`);
		}
		const boundary = `curator-${randomUUID()}`;
		// PATCH may not carry `parents` (moves go through addParents); the
		// file stays where it is.
		const meta = opts.replaceId
			? { name, ...(opts.appProperties ? { appProperties: opts.appProperties } : {}) }
			: { name, parents: [parentId], ...(opts.appProperties ? { appProperties: opts.appProperties } : {}) };
		const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${opts.mimeType ?? 'application/octet-stream'}\r\n\r\n`;
		const body = Buffer.concat([Buffer.from(head, 'utf8'), bytes, Buffer.from(`\r\n--${boundary}--`, 'utf8')]);
		const url = opts.replaceId
			? `${this.upload}/files/${encodeURIComponent(opts.replaceId)}?uploadType=multipart&fields=id`
			: `${this.upload}/files?uploadType=multipart&fields=id`;
		const res = await driveRequest(this.deps, url, {
			method: opts.replaceId ? 'PATCH' : 'POST',
			headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
			body,
		});
		const json = (await res.json()) as { id: string };
		return { id: json.id };
	}

	async uploadResumable(parentId: string, name: string, src: { path: string; size: number }, opts: UploadResumableOptions): Promise<{ id: string }> {
		const chunkBytes = opts.chunkBytes ?? DEFAULT_CHUNK;
		if (chunkBytes <= 0 || chunkBytes % CHUNK_ALIGN !== 0) throw new Error(`chunkBytes must be a positive multiple of ${CHUNK_ALIGN}`);
		if (src.size <= 0) throw new Error('uploadResumable: empty file — use uploadSmall');
		const { signal } = opts;
		const total = src.size;
		let sessionUri: string | null = null;
		let offset = 0;

		// Ask a resumed session where it stands before sending a byte; a
		// dead session (Drive keeps them about a week) just starts over.
		if (opts.resume?.sessionUri) {
			const st = await this.probeSession(opts.resume.sessionUri, total, signal);
			if (st.kind === 'done') {
				opts.onProgress(total);
				return { id: st.id };
			}
			if (st.kind === 'incomplete') {
				sessionUri = opts.resume.sessionUri;
				offset = st.offset;
			} else {
				this.deps.log.info('resumable session expired — restarting upload', { name });
			}
		}
		if (sessionUri === null) {
			sessionUri = await this.startSession(parentId, name, total, opts.appProperties, signal);
			opts.onSession?.(sessionUri);
		}
		opts.onProgress(offset);

		const fh = await open(src.path, 'r');
		let failures = 0;
		let reauthed = false;
		try {
			for (;;) {
				if (signal.aborted) throw abortError();
				const len = Math.min(chunkBytes, total - offset);
				const chunk = await readAt(fh, offset, len);
				const token = await this.deps.accessToken();
				let res: Response;
				try {
					res = await this.deps.fetch(sessionUri, {
						method: 'PUT',
						headers: { Authorization: `Bearer ${token}`, 'Content-Range': `bytes ${offset}-${offset + len - 1}/${total}` },
						body: chunk as RequestInit['body'],
						signal,
					});
				} catch (err) {
					if (isAbortError(err) || signal.aborted) throw abortError();
					failures++;
					await backoffOrThrow(this.deps, failures, null, signal, { what: `resumable PUT ${name}`, status: 0, reason: null, message: `network error: ${describeError(err)}` });
					// The server may have kept part of the chunk; resume from
					// what it reports rather than resending the whole range.
					const st = await this.probeSession(sessionUri, total, signal);
					if (st.kind === 'done') {
						opts.onProgress(total);
						return { id: st.id };
					}
					if (st.kind === 'expired') {
						sessionUri = await this.startSession(parentId, name, total, opts.appProperties, signal);
						opts.onSession?.(sessionUri);
						offset = 0;
					} else {
						offset = st.offset;
					}
					opts.onProgress(offset);
					continue;
				}
				if (res.status === 308) {
					failures = 0;
					offset = nextOffsetFromRange(res.headers.get('range'));
					opts.onProgress(offset);
					continue;
				}
				if (res.ok) {
					const json = (await res.json()) as { id: string };
					opts.onProgress(total);
					return { id: json.id };
				}
				const { reason, message } = await readError(res);
				if (res.status === 404 || res.status === 410) {
					this.deps.log.info('resumable session expired mid-upload — restarting', { name, status: res.status });
					sessionUri = await this.startSession(parentId, name, total, opts.appProperties, signal);
					opts.onSession?.(sessionUri);
					offset = 0;
					opts.onProgress(0);
					continue;
				}
				if (res.status === 401 && !reauthed) {
					reauthed = true;
					continue;
				}
				if (!isRetryableStatus(res.status, reason)) {
					throw new DriveApiError(`resumable PUT ${name}: ${message}`, { status: res.status, reason, retryable: false });
				}
				failures++;
				await backoffOrThrow(this.deps, failures, parseRetryAfter(res.headers.get('retry-after'), this.deps.now()), signal, { what: `resumable PUT ${name}`, status: res.status, reason, message });
				const st = await this.probeSession(sessionUri, total, signal);
				if (st.kind === 'done') {
					opts.onProgress(total);
					return { id: st.id };
				}
				if (st.kind === 'expired') {
					sessionUri = await this.startSession(parentId, name, total, opts.appProperties, signal);
					opts.onSession?.(sessionUri);
					offset = 0;
				} else {
					offset = st.offset;
				}
				opts.onProgress(offset);
			}
		} finally {
			await fh.close();
		}
	}

	async download(fileId: string, destPath: string, opts: DownloadOptions): Promise<void> {
		const part = `${destPath}.part`;
		const url = `${this.api}/files/${encodeURIComponent(fileId)}?alt=media`;
		const { signal, expectedSize } = opts;
		let failures = 0;
		for (;;) {
			if (signal.aborted) throw abortError();
			let have = (await fileSize(part)) ?? 0;
			// A .part at or past the expected size is a leftover we can't
			// trust (crash between write and rename, or a different object).
			if (have >= expectedSize) have = 0;
			const res = await driveRequest(this.deps, url, {
				headers: have > 0 ? { Range: `bytes=${have}-` } : {},
				signal,
				accept: [416],
			});
			if (res.status === 416) {
				// Range not satisfiable: our .part doesn't match this file.
				await unlink(part).catch(() => {});
				failures++;
				if (failures >= MAX_ATTEMPTS) throw new DriveApiError(`download ${fileId}: server rejected the resume range repeatedly`, { status: 416, reason: null, retryable: false });
				continue;
			}
			if (!res.body) throw new DriveApiError(`download ${fileId}: empty response body`, { status: res.status, reason: null, retryable: true });
			// 206 appends to what we have; a 200 means the server ignored the
			// range (or there was none) and is sending the whole object.
			const append = res.status === 206 && have > 0;
			if (!append) have = 0;
			const fh = await open(part, append ? 'a' : 'w');
			let got = have;
			let streamErr: unknown = null;
			try {
				const reader = res.body.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					await fh.write(value);
					got += value.byteLength;
					opts.onProgress(got);
				}
			} catch (err) {
				streamErr = err;
			} finally {
				await fh.close();
			}
			if (streamErr !== null) {
				if (isAbortError(streamErr) || signal.aborted) throw abortError();
				failures++;
				// The .part keeps what landed; the next pass resumes from it.
				await backoffOrThrow(this.deps, failures, null, signal, { what: `download ${fileId}`, status: 0, reason: null, message: `stream error: ${describeError(streamErr)}` });
				continue;
			}
			if (got > expectedSize) {
				await unlink(part).catch(() => {});
				throw new DriveApiError(`download ${fileId}: got ${got} bytes, expected ${expectedSize}`, { status: 0, reason: null, retryable: false });
			}
			if (got < expectedSize) {
				// Clean EOF short of the size: resumable from the .part next time.
				throw new DriveApiError(`download ${fileId}: stream ended at ${got} of ${expectedSize} bytes`, { status: 0, reason: null, retryable: true });
			}
			await rename(part, destPath);
			return;
		}
	}

	// Whole-file fetch for the small JSON/zstd metadata files (manifests,
	// pins, library.json).
	async downloadBuffer(fileId: string, opts?: { signal?: AbortSignal }): Promise<Buffer> {
		const res = await driveRequest(this.deps, `${this.api}/files/${encodeURIComponent(fileId)}?alt=media`, { signal: opts?.signal });
		return Buffer.from(await res.arrayBuffer());
	}

	async delete(fileId: string): Promise<void> {
		await driveRequest(this.deps, `${this.api}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', accept: [404] });
	}

	// ─── resumable protocol pieces ──────────────────────────────────────────

	private async startSession(parentId: string, name: string, size: number, appProperties: Record<string, string> | undefined, signal: AbortSignal): Promise<string> {
		const res = await driveRequest(this.deps, `${this.upload}/files?uploadType=resumable&fields=id`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json; charset=UTF-8',
				'X-Upload-Content-Type': 'application/octet-stream',
				'X-Upload-Content-Length': String(size),
			},
			body: JSON.stringify({ name, parents: [parentId], ...(appProperties ? { appProperties } : {}) }),
			signal,
		});
		const location = res.headers.get('location');
		if (!location) throw new DriveApiError(`resumable session for ${name}: no Location header`, { status: res.status, reason: null, retryable: true });
		return location;
	}

	// Status probe: PUT with no body and `Content-Range: bytes */total`.
	// 308 carries the server's Range (undici returns it as-is — no Location,
	// so nothing is followed); 2xx means an earlier run finished the upload.
	private async probeSession(sessionUri: string, total: number, signal: AbortSignal): Promise<SessionState> {
		const res = await driveRequest(this.deps, sessionUri, {
			method: 'PUT',
			headers: { 'Content-Range': `bytes */${total}` },
			signal,
			accept: [404, 410],
		});
		if (res.status === 308) return { kind: 'incomplete', offset: nextOffsetFromRange(res.headers.get('range')) };
		if (res.ok) {
			const json = (await res.json()) as { id: string };
			return { kind: 'done', id: json.id };
		}
		return { kind: 'expired' };
	}
}
