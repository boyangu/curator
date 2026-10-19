// Where an artist can be looked at outside Curator. Spotify / Tidal are
// direct when the library holds the provider's artist id (gathered from
// synced track payloads); everything else is the provider's artist search
// for the name. One helper feeds both the artist scope header and the
// Artists folder context menu so the two never drift.

import type { ArtistLink } from '@curator/shared';

export interface ArtistExternalLink { id: string; label: string; url: string; direct: boolean }

const q = (name: string): string => encodeURIComponent(name);

export function artistExternalLinks(name: string, links: readonly ArtistLink[]): ArtistExternalLink[] {
	const by = new Map(links.map((l) => [l.source, l] as const));
	const sp = by.get('spotify');
	const td = by.get('tidal');
	return [
		sp?.url
			? { id: 'spotify', label: 'Spotify', url: sp.url, direct: true }
			: { id: 'spotify', label: 'Spotify', url: `https://open.spotify.com/search/${q(name)}/artists`, direct: false },
		td?.url
			? { id: 'tidal', label: 'Tidal', url: td.url, direct: true }
			: { id: 'tidal', label: 'Tidal', url: `https://listen.tidal.com/search/artists?q=${q(name)}`, direct: false },
		{ id: 'beatport', label: 'Beatport', url: `https://www.beatport.com/search/artists?q=${q(name)}`, direct: false },
		{ id: 'soundcloud', label: 'SoundCloud', url: `https://soundcloud.com/search/people?q=${q(name)}`, direct: false },
		{ id: 'discogs', label: 'Discogs', url: `https://www.discogs.com/search/?q=${q(name)}&type=artist`, direct: false },
	];
}
