// Beatport's pages, read as data. Beatport's v4 API is partner-only (the
// request is drafted, unanswered), but its site is Next.js and every page
// embeds what it rendered as `__NEXT_DATA__`: react-query's dehydrated
// state, keyed by query ("releases-label_id=804&…", "genre-90-top-100-…").
// A label page lists releases with UPCs, a release page its tracks with
// ISRCs, a genre page its weekly top 100 with ISRC, BPM and key: richer than
// any API we hold.
//
// As of 2026-10-27 the pages answer a plain Node fetch with a browser User-
// Agent; the Cloudflare challenge that blocked the desktop's enricher in July
// 2026 keys on Electron's fetch path. Terms forbid mining, and the challenge
// can return any day, so: one call per page, polite pacing from the tracker
// row's budget, and a challenge (403/503 with Cloudflare's interstitial, or
// its `cf-mitigated` header) parks the whole tracker for hours rather than
// retrying into it. The adapters built on this (beatport.ts) swap to the
// partner API when granted; the page shapes stay here.

import { ProviderHttpError, type FetchLike } from './http.js';
import { TrackerRateLimitedError } from './types.js';

export const BEATPORT = 'https://www.beatport.com';
// Chrome's current stable: what the pages are served to.
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const USER_AGENT = BROWSER_USER_AGENT;
// A Cloudflare challenge is not a rate limit we can wait out in minutes.
const CHALLENGE_PARK_SEC = 6 * 3600;

export type NextQuery = { queryKey: unknown[]; state: { data?: unknown } };
export type NextData = { pageProps: Record<string, unknown>; queries: NextQuery[] };

export function isChallenge(status: number, headers: Headers, body: string): boolean {
	if (headers.get('cf-mitigated') === 'challenge') return true;
	return (status === 403 || status === 503 || status === 429) && /Just a moment|cf-chl|challenge-platform/i.test(body);
}

export async function fetchNextData(fetchFn: FetchLike, path: string, signal?: AbortSignal): Promise<NextData> {
	const res = await fetchFn(`${BEATPORT}${path}`, {
		headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en-US,en;q=0.9' },
		signal,
	});
	const body = await res.text();
	if (isChallenge(res.status, res.headers, body)) throw new TrackerRateLimitedError(CHALLENGE_PARK_SEC);
	if (res.status === 429) throw new TrackerRateLimitedError(Number(res.headers.get('retry-after') ?? '600') || 600);
	const logPath = path.replace(/\d+/g, '<id>').split('?')[0]!;
	if (!res.ok) throw new ProviderHttpError('beatport', res.status, logPath);
	const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(body);
	if (!m) throw new ProviderHttpError('beatport', 0, `${logPath} (no page data)`);
	const json = JSON.parse(m[1]!) as { props?: { pageProps?: Record<string, unknown> & { dehydratedState?: { queries?: NextQuery[] } } } };
	const pageProps = json.props?.pageProps ?? {};
	return { pageProps, queries: pageProps.dehydratedState?.queries ?? [] };
}

// The data of the first query whose key's first element matches.
export function queryData<T>(data: NextData, key: string | RegExp | ((k: string) => boolean)): T | undefined {
	const test = typeof key === 'string' ? (k: string) => k === key : key instanceof RegExp ? (k: string) => key.test(k) : key;
	const q = data.queries.find((q) => typeof q.queryKey[0] === 'string' && test(q.queryKey[0]));
	return q?.state.data as T | undefined;
}

// ── page shapes (the fields the adapters read) ──────────────────────────────

export type BpImage = { uri?: string; dynamic_uri?: string };
export type BpArtist = { id: number; name: string; slug?: string; image?: BpImage };
export type BpLabel = { id: number; name: string; slug?: string; image?: BpImage };
export type BpReleaseRef = {
	id: number;
	name: string;
	slug?: string;
	upc?: string | null;
	artists?: BpArtist[];
	remixers?: BpArtist[];
	label?: BpLabel;
	image?: BpImage;
	new_release_date?: string;
	publish_date?: string;
	track_count?: number;
	catalog_number?: string;
};
export type BpTrack = {
	id: number;
	name: string;
	mix_name?: string;
	slug?: string;
	isrc?: string | null;
	length_ms?: number;
	number?: number;
	artists?: BpArtist[];
	remixers?: BpArtist[];
	genre?: { id: number; name: string; slug?: string };
	sub_genre?: { id: number; name: string } | null;
	bpm?: number;
	key?: { name: string };
	release?: BpReleaseRef;
	new_release_date?: string;
	publish_date?: string;
	image?: BpImage;
};
export type BpPage<T> = { results: T[]; next?: string | null; count?: number; page?: unknown };

export const imageUrl = (img?: BpImage): string | undefined => img?.uri ?? img?.dynamic_uri?.replace('{w}x{h}', '500x500');
export const dateOf = (d?: string): string | undefined => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
export const publishedMs = (d?: string): number | null => {
	if (!d) return null;
	const t = Date.parse(d);
	return Number.isFinite(t) ? t : null;
};
