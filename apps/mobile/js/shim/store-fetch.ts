// HTTP to the stores, for the catalogue's readers on the phone
// (@curator/catalog-work). The core's own http() (entry.ts) answers a status
// and bytes and nothing else, which is all the sync needs; a store reader
// also needs the response's headers (Retry-After, Cloudflare's challenge
// mark), a call it can give up on, and — for Beatport, which turns a plain
// HTTP client away — a page loaded in a browser. So the readers' fetch is its
// own seam: the core emits `fetch` and Kotlin (core/StoreFetch.kt) answers
// `fetchDone`, by plain HTTP or through its hidden WebView (`via`).
//
// What comes back is as much of a Response as the readers read: status, ok,
// headers.get, text(), json().

import { WorkDeviceNotReadyError, type WorkEngineDeps } from '@curator/catalog-work';

type FetchLike = WorkEngineDeps['fetch'];

// 'http': Kotlin's own client. 'beatport': the hidden WebView; the answer's
// body is the page's data wrapped as the readers find it in the page.
export type StoreVia = 'http' | 'beatport';

// Kotlin's answer. `error`: why there is none — prefixed 'device:' when the
// phone itself could not ask (no window for the WebView, the app in the
// background), which is nothing about the store.
export type StoreAnswer = { id: number; status: number; headers: Record<string, string>; body: string | null; error: string | null };

export type StoreFetch = {
	via(via: StoreVia): FetchLike;
	done(answer: StoreAnswer): void;
};

const aborted = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

function headersOf(init: RequestInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const h = init?.headers;
	if (h && typeof h === 'object' && !Array.isArray(h)) for (const [k, v] of Object.entries(h as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
	return out;
}

function responseOf(url: string, a: StoreAnswer): Response {
	const headers = new Map(Object.entries(a.headers).map(([k, v]) => [k.toLowerCase(), v]));
	const body = a.body ?? '';
	return {
		ok: a.status >= 200 && a.status < 300,
		status: a.status,
		url,
		redirected: false,
		headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
		text: async () => body,
		json: async () => JSON.parse(body) as unknown,
	} as unknown as Response;
}

export function createStoreFetch(emit: (event: Record<string, unknown>) => void): StoreFetch {
	const inflight = new Map<number, { resolve: (a: StoreAnswer) => void; reject: (e: Error) => void }>();
	let next = 1;
	return {
		via: (via) => (url, init) =>
			new Promise<Response>((resolve, reject) => {
				const signal = init?.signal ?? undefined;
				if (signal?.aborted) {
					reject(aborted());
					return;
				}
				const id = next++;
				// Given up on (the page was left, the call timed out): Kotlin is
				// told, and a late answer finds nobody.
				const onAbort = (): void => {
					if (!inflight.delete(id)) return;
					emit({ type: 'fetchAbort', id });
					reject(aborted());
				};
				signal?.addEventListener?.('abort', onAbort, { once: true });
				const settle = (): void => signal?.removeEventListener?.('abort', onAbort);
				inflight.set(id, {
					resolve: (a) => {
						settle();
						resolve(responseOf(url, a));
					},
					reject: (e) => {
						settle();
						reject(e);
					},
				});
				emit({ type: 'fetch', id, via, method: init?.method ?? 'GET', url, headers: headersOf(init), body: typeof init?.body === 'string' ? init.body : null });
			}),

		done(a) {
			const p = inflight.get(a.id);
			if (!p) return;
			inflight.delete(a.id);
			if (a.error === null) p.resolve(a);
			// The phone's own trouble is not the store's (catalog-work lanes.ts):
			// no network reads as fetch's own failure does.
			else if (a.error.startsWith('device:')) p.reject(new WorkDeviceNotReadyError(a.error.slice('device:'.length).trim()));
			else p.reject(new TypeError(`fetch failed: ${a.error}`));
		},
	};
}

// Hermes has no AbortController; the readers and the engine's call timeout
// want one (catalog-work lanes.ts). As much of it as they use.
class Signal {
	aborted = false;
	readonly listeners = new Set<() => void>();
	addEventListener(_type: string, fn: () => void): void {
		this.listeners.add(fn);
	}
	removeEventListener(_type: string, fn: () => void): void {
		this.listeners.delete(fn);
	}
}

export class CoreAbortController {
	readonly signal = new Signal();
	abort(): void {
		if (this.signal.aborted) return;
		this.signal.aborted = true;
		for (const fn of [...this.signal.listeners]) fn();
		this.signal.listeners.clear();
	}
}

const g = globalThis as Record<string, unknown>;
g['AbortController'] ??= CoreAbortController;
