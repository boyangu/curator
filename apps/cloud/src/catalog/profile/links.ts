// A label's pages, told apart by URL: what a link list (MusicBrainz's url
// relations, Discogs' urls, Bandcamp's sites, a homepage's outbound links)
// turns into. A page becomes a representation of the label on that provider
// — an id the trackers can follow, or a link the panel shows (Instagram,
// the website: nothing is read there).

import type { CatalogClaim, CatalogProvider } from '@curator/protocol';

export type PageLink = { provider: CatalogProvider; kind: 'label' | 'playlist'; id: string; url: string };

const SKIP_SOUNDCLOUD = new Set(['you', 'discover', 'search', 'tags', 'charts', 'stream', 'upload', 'pages', 'terms-of-use', 'jobs']);
const SKIP_INSTAGRAM = new Set(['p', 'explore', 'accounts', 'reel', 'reels', 'stories', 'about', 'legal']);

export function classifyUrl(raw: string): PageLink | null {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	const host = u.hostname.toLowerCase().replace(/^(www|m|open)\./, '');
	const parts = u.pathname.split('/').filter(Boolean);
	const p0 = parts[0]?.toLowerCase();
	if (host === 'soundcloud.com' && p0 && !SKIP_SOUNDCLOUD.has(p0) && /^[a-z0-9_-]+$/.test(p0)) {
		return { provider: 'soundcloud', kind: 'label', id: p0, url: `https://soundcloud.com/${p0}` };
	}
	if (host === 'instagram.com' && p0 && !SKIP_INSTAGRAM.has(p0) && /^[a-z0-9_.]+$/.test(p0)) {
		return { provider: 'instagram', kind: 'label', id: p0, url: `https://www.instagram.com/${p0}/` };
	}
	if (host === 'beatport.com' && p0 === 'label' && parts[2] && /^\d+$/.test(parts[2])) {
		return { provider: 'beatport', kind: 'label', id: parts[2], url: `https://www.beatport.com/label/${parts[1]}/${parts[2]}` };
	}
	if (host === 'traxsource.com' && p0 === 'label' && parts[1] && /^\d+$/.test(parts[1])) {
		return { provider: 'traxsource', kind: 'label', id: parts[1], url: `https://www.traxsource.com/label/${parts[1]}/${parts[2] ?? 'label'}` };
	}
	if (host === 'youtube.com') {
		// A channel id is the handle the Data API takes without a lookup; a
		// handle or custom name is kept as written (resolved by the tracker).
		if (p0 === 'channel' && parts[1] && /^UC[\w-]{20,}$/.test(parts[1])) return { provider: 'youtube', kind: 'label', id: parts[1], url: `https://www.youtube.com/channel/${parts[1]}` };
		if (p0?.startsWith('@') && p0.length > 1) return { provider: 'youtube', kind: 'label', id: p0, url: `https://www.youtube.com/${p0}` };
		if ((p0 === 'c' || p0 === 'user') && parts[1]) return { provider: 'youtube', kind: 'label', id: `${p0}/${parts[1]}`, url: `https://www.youtube.com/${p0}/${parts[1]}` };
		return null;
	}
	if (host.endsWith('.bandcamp.com')) {
		const sub = host.slice(0, -'.bandcamp.com'.length);
		if (sub && sub !== 'daily' && !sub.includes('.')) return { provider: 'bandcamp', kind: 'label', id: sub, url: `https://${sub}.bandcamp.com` };
		return null;
	}
	if (host === 'spotify.com' && p0 === 'playlist' && parts[1] && /^[A-Za-z0-9]{22}$/.test(parts[1])) {
		return { provider: 'spotify', kind: 'playlist', id: parts[1], url: `https://open.spotify.com/playlist/${parts[1]}` };
	}
	return null;
}

const NOT_A_WEBSITE = /(^|\.)(facebook|twitter|x|instagram|soundcloud|youtube|youtu|bandcamp|beatport|traxsource|spotify|deezer|tidal|apple|discogs|musicbrainz|wikidata|wikipedia|qobuz|mixcloud|tiktok|twitch|linktr|resident-advisor|ra)\.(com|org|co|ee|net|be)$/i;

// A label's own site, from a link list's "official site" entry.
export function websiteLink(raw: string): PageLink | null {
	let u: URL;
	try {
		u = new URL(raw.trim());
	} catch {
		return null;
	}
	const host = u.hostname.toLowerCase().replace(/^www\./, '');
	if (!host.includes('.') || NOT_A_WEBSITE.test(host)) return null;
	return { provider: 'website', kind: 'label', id: host, url: `${u.protocol}//${u.hostname}${u.pathname === '/' ? '' : u.pathname}` };
}

// Every absolute http(s) link on a page, href and plain text alike.
export function extractLinks(html: string, base: string): string[] {
	const out = new Set<string>();
	for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
		try {
			out.add(new URL(m[1]!, base).toString());
		} catch {
			/* not a url */
		}
	}
	for (const m of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) out.add(m[0]);
	return [...out];
}

// A label registered from its page: named off the page's slug until its own
// tracker says better (a Beatport label page carries the name; Bandcamp's
// band id is read by the profiler).
export function labelClaimFromPage(page: PageLink): CatalogClaim | null {
	if (page.kind !== 'label') return null;
	const slug = page.provider === 'beatport' ? /\/label\/([^/]+)\/\d+/.exec(page.url)?.[1] ?? page.id : page.id;
	return { provider: page.provider, kind: 'label', providerId: page.id, name: titleFromSlug(slug), url: page.url };
}

// "northfold-records" → "Northfold Records": a name good enough to show until
// the label's own page says better.
export function titleFromSlug(slug: string): string {
	return slug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(' ');
}
