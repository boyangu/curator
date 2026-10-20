// HTTP CloudTransport: the core sync client's port onto the Curator cloud
// API (apps/cloud, tRPC v11 over HTTP at <base>/trpc). Typed from the
// protocol's CloudService, NOT from the server's AppRouter: the desktop must
// not import apps/cloud, so this uses tRPC's untyped client and names each
// procedure (and whether it is a query or a mutation) once, below.
//
// Auth: the Supabase access token as a Bearer header, fetched per request
// (Supabase refreshes it when due). Errors are mapped onto the client's
// CloudTransportError kinds from the server's stable `data.reason` /
// HTTP status, never from message text.
//
// Every call mints a UUID sent as `x-request-id`; the server logs it in
// curator.request_log and echoes it, so one line here (area `cloud-api`)
// matches one row there. The line holds the procedure, request id, duration,
// outcome, op counts and byte sizes, never the token, a payload or an email.
//
// Level: failures at warn; a success at info when it moved something (a
// push, ops pulled, a bootstrap, a device call), at debug for an empty pull.
// The idle 60 s poll is ~1,440 empty pulls a day: at info that would be
// most of the 5 MB x 3 rotating log file, pushing out the lines a support
// read actually needs, and it says nothing an absent error line does not.

import { randomUUID } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { app, net } from 'electron';
import { createTRPCUntypedClient, httpLink, TRPCClientError } from '@trpc/client';
import { CloudTransportError, decodeLibraryStateSnapshot, type CloudTransport } from '@curator/core';
import {
	CALL_ERROR_REASONS,
	SNAPSHOT_ENCODING,
	type BootstrapResult,
	type CallErrorReason,
	type CatalogueInventoryInput,
	type CatalogueInventoryResult,
	type CatalogueLookupInput,
	type CatalogueLookupResult,
	type CataloguePutInput,
	type CataloguePutResult,
	type DeviceInfo,
	type PullInput,
	type PullResult,
	type PushInput,
	type PushResult,
	type RegisterDeviceInput,
} from '@curator/protocol';
import { mainLog } from '../log.js';
import type { CloudAccount } from './account.js';

const gunzipAsync = promisify(gunzip);
const clog = mainLog.for('cloud-api');

// Procedure paths and kinds as apps/cloud's router mounts them (the
// protocol pins the names, not the query/mutation split, which an untyped
// client must state).
const PROCS = {
	push: { path: 'sync.push', type: 'mutation' },
	pull: { path: 'sync.pull', type: 'query' },
	bootstrap: { path: 'sync.bootstrap', type: 'query' },
	registerDevice: { path: 'account.registerDevice', type: 'mutation' },
	devices: { path: 'account.devices', type: 'query' },
	revokeDevice: { path: 'account.revokeDevice', type: 'mutation' },
	// The shared analysis catalogue (apps/cloud src/catalogue). Lookup is a
	// mutation only so 50 hashes and a want list ride in the body; it writes
	// nothing. Inventory is a plain query (a rev and a device id).
	catalogueLookup: { path: 'catalogue.lookup', type: 'mutation' },
	cataloguePut: { path: 'catalogue.put', type: 'mutation' },
	catalogueInventory: { path: 'catalogue.inventory', type: 'query' },
} as const;

// A snapshot of a 40k-track library inflates to tens of MB; cap what a
// corrupt body can grow to.
const MAX_INFLATED_BYTES = 1024 * 1024 * 1024;

type ErrorData = { httpStatus?: number; reason?: string | null; retryAfterSec?: number | null };

function asReason(v: unknown): CallErrorReason | 'update_required' | null {
	if (typeof v !== 'string') return null;
	if (v === 'update_required') return v;
	return (CALL_ERROR_REASONS as readonly string[]).includes(v) ? (v as CallErrorReason) : null;
}

// The HTTP status and the server's stable reason, for the call's log line.
// Never the message: a network error's text can carry the request URL, and
// a query's input travels in its query string.
function errorFacts(err: unknown): { status: number | null; reason: string | null } {
	if (!(err instanceof TRPCClientError)) return { status: null, reason: null };
	const data = (err.data ?? {}) as ErrorData;
	const meta = err.meta as { response?: { status?: number } } | undefined;
	const status = data.httpStatus ?? meta?.response?.status ?? null;
	const reason = typeof data.reason === 'string' && /^[a-z_]{1,64}$/.test(data.reason) ? data.reason : null;
	return { status: status || null, reason };
}

// Chromium's net error codes (net::ERR_INTERNET_DISCONNECTED) are safe to
// log and say what went wrong; any other network message is dropped.
function netErrorCode(err: unknown): string | null {
	let e: unknown = err;
	for (let i = 0; i < 3 && e instanceof Error; i++) {
		const m = /\bnet::ERR_[A-Z_]+\b/.exec(e.message);
		if (m) return m[0];
		e = e.cause;
	}
	return null;
}

function mapError(err: unknown): CloudTransportError {
	if (err instanceof CloudTransportError) return err;
	if (err instanceof TRPCClientError) {
		const data = (err.data ?? {}) as ErrorData;
		const meta = err.meta as { response?: { status?: number } } | undefined;
		const status = data.httpStatus ?? meta?.response?.status ?? 0;
		// `data.reason` is the contract; the message carries the same string
		// (the server's TRPCError message is the reason) as a fallback.
		const reason: CallErrorReason | 'update_required' | null = asReason(data.reason) ?? asReason(err.message);
		const retryMs = data.retryAfterSec != null ? data.retryAfterSec * 1000 : undefined;
		if (reason === 'update_required') return new CloudTransportError('update_required', reason);
		if (reason === 'device_revoked') return new CloudTransportError('device_revoked', reason);
		if (reason === 'device_not_registered') return new CloudTransportError('device_not_registered', reason);
		if (reason === 'rate_limited' || status === 429) return new CloudTransportError('rate_limited', reason ?? 'rate limited', retryMs);
		// The server is older than this client's ops (a deploy-order slip):
		// retry later, the ops stay pending.
		if (reason === 'server_outdated') return new CloudTransportError('server', reason, retryMs);
		if (status === 401 || reason === 'missing_token' || reason === 'token_expired' || reason === 'invalid_token') return new CloudTransportError('auth', reason ?? 'unauthorized');
		if (status >= 500) return new CloudTransportError('server', `HTTP ${status}`);
		if (status >= 400) return new CloudTransportError('bad_request', reason ?? `HTTP ${status}`);
		// No HTTP status at all: the request never got an answer.
		return new CloudTransportError('network', err.message);
	}
	return new CloudTransportError('network', err instanceof Error ? err.message : String(err));
}

type Proc = (typeof PROCS)[keyof typeof PROCS];

// Sizes of one HTTP exchange, filled by the fetch wrapper, keyed by the
// request id the headers callback put on it.
type Wire = { bytesSent: number; bytesReceived: number | null; status: number | null };

function headerValue(headers: RequestInit['headers'], name: string): string | null {
	if (!headers) return null;
	if (headers instanceof Headers) return headers.get(name);
	if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name)?.[1] ?? null;
	return (headers as Record<string, string>)[name] ?? null;
}

function bodyBytes(body: RequestInit['body']): number {
	if (body == null) return 0;
	if (typeof body === 'string') return Buffer.byteLength(body);
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (ArrayBuffer.isView(body)) return body.byteLength;
	return 0;
}

export function createHttpCloudTransport(baseUrl: string, account: CloudAccount): CloudTransport {
	// `desktop/<version> <platform>`: lets the server's log tell a release
	// that misbehaves from one that does not.
	const clientHeader = `desktop/${app.getVersion()} ${process.platform}`;
	const wire = new Map<string, Wire>();

	const client = createTRPCUntypedClient({
		links: [
			httpLink({
				url: `${baseUrl}/trpc`,
				headers: async ({ op }) => {
					const token = await account.accessToken();
					const requestId = (op.context as { requestId?: string }).requestId;
					return {
						...(token ? { authorization: `Bearer ${token}` } : {}),
						...(requestId ? { 'x-request-id': requestId } : {}),
						'x-curator-client': clientHeader,
					};
				},
				// Chromium's stack: system proxy + certificate store. The body is
				// read here once (tRPC parses it from the copy) to count its bytes.
				fetch: async (url, init) => {
					const href = String(url);
					const requestId = headerValue(init?.headers as RequestInit['headers'], 'x-request-id');
					const w = requestId ? wire.get(requestId) : undefined;
					if (w) w.bytesSent = bodyBytes(init?.body as RequestInit['body']) + Buffer.byteLength(new URL(href).search);
					const res = await net.fetch(href, init as RequestInit);
					const buf = await res.arrayBuffer();
					if (w) {
						w.status = res.status;
						w.bytesReceived = buf.byteLength;
					}
					return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
				},
			}),
		],
	});

	// What each procedure moved, for its log line: counts only, never content.
	// The catalogue reuses the op columns as item counts, as the server's
	// request_log does: hashes asked / items returned, items put / accepted,
	// inventory entries.
	const opsSent = (proc: Proc, input: unknown): number | null => {
		if (proc === PROCS.push) return (input as PushInput).ops?.length ?? 0;
		if (proc === PROCS.catalogueLookup) return (input as CatalogueLookupInput).audioHashes?.length ?? 0;
		if (proc === PROCS.cataloguePut) return (input as CataloguePutInput).items?.length ?? 0;
		return null;
	};
	const opsReceived = (proc: Proc, out: unknown): number | null => {
		if (proc === PROCS.pull) return (out as PullResult).ops?.length ?? 0;
		if (proc === PROCS.catalogueLookup) return (out as CatalogueLookupResult).items?.length ?? 0;
		if (proc === PROCS.cataloguePut) return (out as CataloguePutResult).accepted?.length ?? 0;
		if (proc === PROCS.catalogueInventory) return (out as CatalogueInventoryResult).entries?.length ?? 0;
		return null;
	};

	const call = async <T>(proc: Proc, input?: unknown): Promise<T> => {
		// No session: fail fast as auth instead of a guaranteed 401 round trip.
		if (!account.cloudSession()) throw new CloudTransportError('auth', 'signed out');
		const requestId = randomUUID();
		const w: Wire = { bytesSent: 0, bytesReceived: null, status: null };
		wire.set(requestId, w);
		const started = performance.now();
		const base = () => ({
			procedure: proc.path,
			requestId,
			ms: Math.round(performance.now() - started),
			opsSent: opsSent(proc, input),
			bytesSent: w.bytesSent,
			bytesReceived: w.bytesReceived,
		});
		try {
			const opts = { context: { requestId } };
			const out = (proc.type === 'query' ? await client.query(proc.path, input, opts) : await client.mutation(proc.path, input, opts)) as T;
			const received = opsReceived(proc, out);
			const fields = { ...base(), outcome: 'ok', status: w.status, opsReceived: received };
			// Empty pulls and inventories are the idle poll; a catalogue lookup
			// runs per analysed track. At info they would crowd out the lines a
			// support read needs (the catalogue logs its own batch summaries).
			const quiet = (proc === PROCS.pull && received === 0) || (proc === PROCS.catalogueInventory && received === 0) || proc === PROCS.catalogueLookup;
			if (quiet) clog.debug('call', fields);
			else clog.info('call', fields);
			return out;
		} catch (err) {
			const mapped = mapError(err);
			const facts = errorFacts(err);
			clog.warn('call failed', {
				...base(),
				outcome: mapped.kind,
				status: facts.status ?? w.status,
				reason: facts.reason,
				...(mapped.kind === 'network' ? { net: netErrorCode(err) } : {}),
				...(mapped.retryAfterMs !== undefined ? { retryAfterMs: mapped.retryAfterMs } : {}),
			});
			throw mapped;
		} finally {
			wire.delete(requestId);
		}
	};

	return {
		session: () => account.cloudSession(),
		sync: {
			push: (input: PushInput) => call<PushResult>(PROCS.push, input),
			pull: (input: PullInput) => call<PullResult>(PROCS.pull, input),
		},
		// The snapshot arrives inline (base64 gzip of the serialised state).
		// gunzip runs on libuv's pool; the JSON parse and flatten are the one
		// synchronous step (~100–300 ms for a 40k-track library, once).
		async bootstrap() {
			const res = await call<BootstrapResult>(PROCS.bootstrap);
			if (res.encoding !== SNAPSHOT_ENCODING) throw new CloudTransportError('bad_request', `unknown snapshot encoding ${String(res.encoding)}`);
			const json = await gunzipAsync(Buffer.from(res.snapshot, 'base64'), { maxOutputLength: MAX_INFLATED_BYTES });
			return { snapshotSeq: res.snapshotSeq, records: decodeLibraryStateSnapshot(json.toString('utf8')) };
		},
		account: {
			registerDevice: (input: RegisterDeviceInput) => call<{ ok: true }>(PROCS.registerDevice, input),
			devices: () => call<DeviceInfo[]>(PROCS.devices),
			revokeDevice: (input: { deviceId: string }) => call<{ ok: true }>(PROCS.revokeDevice, input),
		},
		catalogue: {
			lookup: (input: CatalogueLookupInput) => call<CatalogueLookupResult>(PROCS.catalogueLookup, input),
			put: (input: CataloguePutInput) => call<CataloguePutResult>(PROCS.cataloguePut, input),
			inventory: (input: CatalogueInventoryInput) => call<CatalogueInventoryResult>(PROCS.catalogueInventory, input),
		},
	};
}
