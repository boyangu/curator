// An artist's monthly listeners, off Spotify's public artist page. The Web
// API never had the number (and Development Mode apps lost followers and
// popularity in March 2026), so the page is the only place it is said.
//
// Against Spotify's terms, and Guy's call (2026-11-19): the Reach score
// (apps/cloud catalog/audience.ts) reads it as one source among several and
// stands without it. No login and no app credentials: the API quota is
// never touched.
//
// The page a browser gets is the web player's empty shell. A link preview
// crawler gets the server-rendered meta tags, and `og:description` says
// "Artist · 27.8M monthly listeners." (also 990, 3.7K, 103.9K — rounded to
// about three figures). A page with a title but no such phrase is an artist
// nobody streams; one without even a title is a shape this parser does not
// know, and the reader stops (SpotifyPageShapeError) rather than read zeros.

import { ProviderHttpError, type FetchLike } from './http.js';
import { TrackerRateLimitedError } from './types.js';

export const LINK_PREVIEW_USER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

export class SpotifyPageShapeError extends Error {
	override readonly name = 'SpotifyPageShapeError';
}

const UNIT: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };

const meta = (html: string, property: string): string | null => {
	const m = html.match(new RegExp(`<meta[^>]+property="${property}"[^>]+content="([^"]*)"`, 'i'));
	return m ? m[1]! : null;
};

// The listener count a page states; null when it states none. Throws when
// the page is not an artist page this parser knows.
export function parseMonthlyListeners(html: string): number | null {
	if (!meta(html, 'og:title')) throw new SpotifyPageShapeError('spotify artist page without og:title');
	const m = (meta(html, 'og:description') ?? '').match(/([\d.,]+)\s*([KMB])?\s+monthly listeners/i);
	if (!m) return null;
	const n = Number(m[1]!.replace(/,/g, '')) * (m[2] ? UNIT[m[2].toUpperCase()]! : 1);
	return Number.isFinite(n) ? Math.round(n) : null;
}

export async function readMonthlyListeners(fetchFn: FetchLike, artistId: string, signal: AbortSignal): Promise<number | null> {
	const res = await fetchFn(`https://open.spotify.com/artist/${encodeURIComponent(artistId)}`, { headers: { 'user-agent': LINK_PREVIEW_USER_AGENT, 'accept-language': 'en' }, signal });
	if (res.status === 429) throw new TrackerRateLimitedError(Number(res.headers.get('retry-after') ?? '3600') || 3600);
	if (res.status === 404) return null;
	if (!res.ok) throw new ProviderHttpError('spotify-page', res.status, '/artist/<id>');
	return parseMonthlyListeners(await res.text());
}
