// A store page told apart by its link: which store, what it can be the page
// of, and the id the catalogue keys it by. What "Help us connect the dots"
// reads a pasted link with (catalog.connectAnswer), on the device to say
// "that is a label page" before anything is sent, and on the cloud, which
// trusts no device's parse.
//
// A SoundCloud or Bandcamp profile is an artist's or a label's alike — the
// store draws no line — so a ref names every kind it may stand for. Their ids
// here are the slug the link carries; the cloud swaps in the id the store's
// API takes when the page answers (catalog/connect.ts).

import type { CatalogProvider } from './catalog-service.js';

export const PAGE_KINDS = ['artist', 'label', 'release'] as const;
export type PageKind = (typeof PAGE_KINDS)[number];
export type PageRef = { provider: CatalogProvider; kinds: readonly PageKind[]; id: string; url: string };

const PROFILE: readonly PageKind[] = ['artist', 'label'];
const NOT_A_SOUNDCLOUD_USER = new Set(['you', 'discover', 'search', 'tags', 'charts', 'stream', 'upload', 'pages', 'terms-of-use', 'jobs', 'people', 'settings', 'messages', 'notifications']);
const SPOTIFY_KIND: Record<string, PageKind> = { artist: 'artist', album: 'release' };
const BEATPORT_KIND: Record<string, PageKind> = { artist: 'artist', label: 'label', release: 'release' };

// The (word, id) pair after any locale or "browse" prefix: /intl-de/artist/<id>.
function pair(parts: string[], words: readonly string[]): { word: string; id: string } | null {
	const at = parts.findIndex((p) => words.includes(p));
	const id = at >= 0 ? parts[at + 1] : undefined;
	return id ? { word: parts[at]!, id } : null;
}

export function pageRef(raw: string): PageRef | null {
	const s = raw.trim();
	const uri = /^spotify:(artist|album):([A-Za-z0-9]{22})$/.exec(s);
	if (uri) return { provider: 'spotify', kinds: [SPOTIFY_KIND[uri[1]!]!], id: uri[2]!, url: `https://open.spotify.com/${uri[1]}/${uri[2]}` };
	let u: URL;
	try {
		u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	const host = u.hostname.toLowerCase().replace(/^(www|m|open|listen)\./, '');
	const parts = u.pathname.split('/').filter(Boolean);
	if (host === 'spotify.com') {
		const p = pair(parts, ['artist', 'album']);
		if (p && /^[A-Za-z0-9]{22}$/.test(p.id)) return { provider: 'spotify', kinds: [SPOTIFY_KIND[p.word]!], id: p.id, url: `https://open.spotify.com/${p.word}/${p.id}` };
		return null;
	}
	if (host === 'deezer.com') {
		const p = pair(parts, ['artist', 'album']);
		if (p && /^\d+$/.test(p.id)) return { provider: 'deezer', kinds: [SPOTIFY_KIND[p.word]!], id: p.id, url: `https://www.deezer.com/${p.word}/${p.id}` };
		return null;
	}
	if (host === 'tidal.com') {
		const p = pair(parts, ['artist', 'album']);
		if (p && /^\d+$/.test(p.id)) return { provider: 'tidal', kinds: [SPOTIFY_KIND[p.word]!], id: p.id, url: `https://tidal.com/browse/${p.word}/${p.id}` };
		return null;
	}
	if (host === 'beatport.com') {
		const kind = BEATPORT_KIND[parts[0] ?? ''];
		if (kind && parts[1] && /^\d+$/.test(parts[2] ?? '')) return { provider: 'beatport', kinds: [kind], id: parts[2]!, url: `https://www.beatport.com/${parts[0]}/${parts[1]}/${parts[2]}` };
		return null;
	}
	if (host === 'soundcloud.com') {
		const user = parts[0]?.toLowerCase();
		// A profile only: a track or a set under it is not the artist's page.
		if (user && parts.length === 1 && !NOT_A_SOUNDCLOUD_USER.has(user) && /^[a-z0-9_-]+$/.test(user)) return { provider: 'soundcloud', kinds: PROFILE, id: user, url: `https://soundcloud.com/${user}` };
		return null;
	}
	if (host.endsWith('.bandcamp.com')) {
		const sub = host.slice(0, -'.bandcamp.com'.length);
		const home = parts.length === 0 || (parts.length === 1 && parts[0] === 'music');
		if (sub && sub !== 'daily' && !sub.includes('.') && home) return { provider: 'bandcamp', kinds: PROFILE, id: sub, url: `https://${sub}.bandcamp.com` };
		return null;
	}
	return null;
}
