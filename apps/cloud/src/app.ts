// The whole API as one fetch handler, `(Request) => Response`. Production
// serves it through node:http (src/http.ts); tests call it directly with a
// tRPC client whose `fetch` is this function, so every test goes through
// the real HTTP adapter, serialisation and error mapping without a socket.
//
// It is also the access log's choke point: every request that reaches it,
// whatever happens (404, 401, 429, a 500 thrown anywhere), leaves exactly one
// request_log row and answers with an `x-request-id` header; the one
// exception is a health check that succeeds (below). The node bridge
// logs the few that never get here (413, a body that failed to arrive).

import { performance } from 'node:perf_hooks';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { clientFrom, clientIpFrom, REQUEST_ID_HEADER, requestIdFrom, type RequestRow } from './audit.js';
import { CallState } from './call.js';
import { CloudError } from './errors.js';
import { appRouter } from './router.js';
import type { AppDeps } from './trpc.js';

export const TRPC_ENDPOINT = '/trpc';

// Set by the node bridge, which sees the request before the body is read:
// the request id it already answered with on an early error, and the clock
// start so the duration includes the upload.
export type RequestMeta = { requestId?: string; startedAt?: number };

export type FetchHandler = (req: Request, meta?: RequestMeta) => Promise<Response>;

// The request_log row for one request. Shared with the node bridge, which
// writes rows for requests that never reach the handler.
export function requestRow(
	headers: Headers,
	call: Pick<CallState, 'requestId' | 'procedure' | 'userId' | 'deviceId' | 'sessionId' | 'reason' | 'opsIn' | 'opsOut'>,
	r: { status: number; startedAt: number; bytesIn: number | null; bytesOut: number | null },
): RequestRow {
	return {
		at: new Date(Date.now() - (performance.now() - r.startedAt)).toISOString(),
		request_id: call.requestId,
		user_id: call.userId,
		device_id: call.deviceId,
		session_id: call.sessionId,
		procedure: call.procedure ?? `http:${r.status}`,
		http_status: r.status,
		reason: call.reason,
		duration_ms: Math.max(0, Math.round(performance.now() - r.startedAt)),
		ops_in: call.opsIn,
		ops_out: call.opsOut,
		bytes_in: r.bytesIn,
		bytes_out: r.bytesOut,
		client_ip: clientIpFrom(headers),
		client: clientFrom(headers),
	};
}

// The stdout `request` line: the same row in camelCase, minus nothing (the
// row holds no secret by construction), plus `opsSkippedOwn` when a pull
// skipped the caller's own ops (stdout only: no schema change for a count
// that is diagnostic, not audit).
export function logRequest(deps: Pick<AppDeps, 'log' | 'audit'>, row: RequestRow, extra: { opsSkippedOwn?: number | null } = {}): void {
	deps.log.info('request', {
		requestId: row.request_id,
		procedure: row.procedure,
		status: row.http_status,
		reason: row.reason,
		ms: row.duration_ms,
		userId: row.user_id,
		deviceId: row.device_id,
		opsIn: row.ops_in,
		opsOut: row.ops_out,
		...(extra.opsSkippedOwn != null ? { opsSkippedOwn: extra.opsSkippedOwn } : {}),
		bytesIn: row.bytes_in,
		bytesOut: row.bytes_out,
		ip: row.client_ip,
		client: row.client,
	});
	deps.audit.request(row);
}

const utf8 = new TextEncoder();

export function createFetchHandler(deps: AppDeps): FetchHandler {
	const route = async (req: Request, call: CallState, sizes: { bytesIn: number }): Promise<Response> => {
		const url = new URL(req.url);
		if (!url.pathname.startsWith(`${TRPC_ENDPOINT}/`)) {
			call.reason = 'not_found';
			return new Response('not found', { status: 404 });
		}
		// A query carries its input in the query string, a mutation in the body;
		// either way that is the request's payload size. The string itself is
		// never logged.
		const method = req.method;
		const body = method === 'GET' || method === 'HEAD' ? undefined : new Uint8Array(await req.arrayBuffer());
		sizes.bytesIn = utf8.encode(url.search).byteLength + (body?.byteLength ?? 0);
		// The tRPC path (comma-joined for a batch), from here on: tRPC runs.
		// Capped: it is client text until tRPC has matched it.
		call.procedure = url.pathname.slice(TRPC_ENDPOINT.length + 1).slice(0, 200);
		return fetchRequestHandler({
			endpoint: TRPC_ENDPOINT,
			req: body ? new Request(req.url, { method, headers: req.headers, body }) : req,
			router: appRouter,
			createContext: ({ req }) => ({ deps, authorization: req.headers.get('authorization'), call }),
			// The design's `retry_after`, as the standard header too, so a
			// generic HTTP client or proxy honours it without reading the body.
			responseMeta({ errors }) {
				const retry = Math.max(0, ...errors.map((e) => (e.cause instanceof CloudError ? (e.cause.retryAfterSec ?? 0) : 0)));
				return retry > 0 ? { headers: new Headers({ 'retry-after': String(retry) }) } : {};
			},
			onError({ error, path }) {
				call.reason = error.cause instanceof CloudError ? error.cause.reason : error.code.toLowerCase();
				if (error.code === 'INTERNAL_SERVER_ERROR') deps.log.error('procedure_failed', { requestId: call.requestId, path, error: error.cause ?? error });
			},
		});
	};

	return async (req, meta = {}) => {
		const startedAt = meta.startedAt ?? performance.now();
		const call = new CallState(meta.requestId ?? requestIdFrom(req.headers), deps.audit);
		const sizes = { bytesIn: 0 };
		let status = 500;
		let headers = new Headers();
		let out: Uint8Array | null = null;
		try {
			const res = await route(req, call, sizes);
			// Buffered (the bridge buffers it anyway) to count the bytes sent.
			out = new Uint8Array(await res.arrayBuffer());
			status = res.status;
			headers = new Headers(res.headers);
		} catch (e) {
			// Outside tRPC (a body that would not read, a bug in this file): a
			// bare 500, never the error text.
			deps.log.error('handler_failed', { requestId: call.requestId, error: e });
			call.reason = 'internal';
			status = 500;
			headers = new Headers();
			out = null;
		}
		headers.set(REQUEST_ID_HEADER, call.requestId);
		// Fly's health check (fly.toml, every 30 s per machine) would be 2,880
		// rows a day per machine that say nothing. A failing one is logged
		// like any request, so it still shows in Fly's logs and the table.
		if (call.procedure !== 'health' || status >= 400) {
			try {
				logRequest(deps, requestRow(req.headers, call, { status, startedAt, bytesIn: sizes.bytesIn, bytesOut: out?.byteLength ?? 0 }), { opsSkippedOwn: call.opsSkippedOwn });
			} catch (e) {
				// The log must never cost the caller their response.
				deps.log.error('request_log_failed', { requestId: call.requestId, error: e });
			}
		}
		return new Response(out && out.byteLength > 0 ? out : null, { status, headers });
	};
}
