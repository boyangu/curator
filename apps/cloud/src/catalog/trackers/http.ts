// The one HTTP call shape the tracker adapters share: injected fetch (tests
// pass a fake), a timeout, JSON in, typed failures out. Bodies and URLs with
// keys are never logged.

import { TrackerRateLimitedError } from './types.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ProviderHttpError extends Error {
	override readonly name = 'ProviderHttpError';
	constructor(
		readonly provider: string,
		readonly status: number,
		readonly path: string,
	) {
		super(`${provider} ${status} ${path}`);
	}
}

export async function getJson<T>(
	fetchFn: FetchLike,
	provider: string,
	url: string,
	opts: { headers?: Record<string, string>; signal?: AbortSignal; logPath: string },
): Promise<T> {
	const res = await fetchFn(url, { headers: { accept: 'application/json', ...opts.headers }, signal: opts.signal });
	if (res.status === 429) throw new TrackerRateLimitedError(Number(res.headers.get('retry-after') ?? '60') || 60);
	if (!res.ok) throw new ProviderHttpError(provider, res.status, opts.logPath);
	return (await res.json()) as T;
}

// A stable digest of a listing, for "nothing changed since last poll".
export function listingHash(ids: readonly string[]): string {
	let h = 2166136261;
	for (const ch of ids.join('\n')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	return `${ids.length}:${h.toString(16)}`;
}

// The ids a cursor remembers having expanded, newest first, bounded.
export function rememberSeen(prev: unknown, added: string[], max = 300): string[] {
	const old = Array.isArray(prev) ? (prev as unknown[]).filter((x): x is string => typeof x === 'string') : [];
	return [...new Set([...added, ...old])].slice(0, max);
}
