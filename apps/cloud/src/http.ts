// node:http → fetch-handler bridge. The body is buffered with a hard cap
// before tRPC sees it: a push is at most 1 MB of ops (MAX_PUSH_BYTES), so
// anything much larger is refused with 413 without being held in memory.
//
// The request id is settled here, before the body is read, so the 413s and
// failed uploads this bridge answers itself carry one and get their own
// request_log row (the handler logs everything else, see app.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { MAX_PUSH_BYTES } from '@curator/protocol';
import { logRequest, requestRow, type FetchHandler } from './app.js';
import { REQUEST_ID_HEADER, requestIdFrom } from './audit.js';
import type { AppDeps } from './trpc.js';

// The op cap plus room for the envelope and a batched call or two.
export const MAX_BODY_BYTES = MAX_PUSH_BYTES + 512 * 1024;

export class BodyTooLargeError extends Error {
	override readonly name = 'BodyTooLargeError';
}

export async function readBody(req: AsyncIterable<Buffer | string>, limit: number = MAX_BODY_BYTES): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
		size += b.length;
		if (size > limit) throw new BodyTooLargeError(`body over ${limit} bytes`);
		chunks.push(b);
	}
	return Buffer.concat(chunks);
}

function toHeaders(req: Pick<IncomingMessage, 'headers'>): Headers {
	const h = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue;
		h.set(k, Array.isArray(v) ? v.join(', ') : v);
	}
	return h;
}

// Only what the bridge touches, so tests can drive it with plain objects.
export type BridgeRequest = Pick<IncomingMessage, 'headers' | 'method' | 'url'> & AsyncIterable<Buffer | string>;
export type BridgeResponse = Pick<ServerResponse, 'writeHead' | 'end' | 'headersSent'>;

export function toNodeListener(handler: FetchHandler, deps: Pick<AppDeps, 'log' | 'audit'>): (req: BridgeRequest, res: BridgeResponse) => void {
	return (req, res) => {
		void (async () => {
			const startedAt = performance.now();
			let headers: Headers;
			try {
				headers = toHeaders(req);
			} catch {
				// A header undici refuses: still answered and logged, without them.
				headers = new Headers();
			}
			const requestId = requestIdFrom(headers);
			// A request the handler never saw: answer, then log it here.
			const early = (status: number, reason: string, bytesIn: number | null, extra: Record<string, string> = {}) => {
				if (!res.headersSent) res.writeHead(status, { [REQUEST_ID_HEADER]: requestId, ...extra });
				res.end();
				const call = { requestId, procedure: null, userId: null, deviceId: null, sessionId: null, reason, opsIn: null, opsOut: null };
				try {
					logRequest(deps, requestRow(headers, call, { status, startedAt, bytesIn, bytesOut: 0 }));
				} catch (e) {
					deps.log.error('request_log_failed', { requestId, error: e });
				}
			};
			const method = req.method ?? 'GET';
			let body: Buffer | undefined;
			try {
				const declared = Number(req.headers['content-length'] ?? 0);
				if (declared > MAX_BODY_BYTES) {
					early(413, 'body_too_large', null, { connection: 'close' });
					return;
				}
				body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
			} catch (e) {
				if (e instanceof BodyTooLargeError) early(413, 'body_too_large', MAX_BODY_BYTES, { connection: 'close' });
				// The upload broke off (client gone, socket reset): nobody is
				// listening for the answer, but the attempt is still logged.
				else early(400, 'body_read_failed', null);
				return;
			}
			let handed = false;
			try {
				// Host is only used to build an absolute URL for the Request; the
				// handler routes on the path alone.
				const request = new Request(new URL(req.url ?? '/', 'http://curator-api.internal'), { method, headers, body });
				handed = true;
				const response = await handler(request, { requestId, startedAt });
				const out = Buffer.from(await response.arrayBuffer());
				res.writeHead(response.status, Object.fromEntries(response.headers));
				res.end(out);
			} catch (e) {
				// The handler never throws (it answers 500 itself and logs the row),
				// so this is the bridge failing to build the Request (no row yet) or
				// to write the answer (row already written: exactly one per request).
				deps.log.error('http_failed', { requestId, error: e });
				if (!handed) {
					early(500, 'internal', null);
					return;
				}
				if (!res.headersSent) res.writeHead(500, { [REQUEST_ID_HEADER]: requestId });
				res.end();
			}
		})();
	};
}
