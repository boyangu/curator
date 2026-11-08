// Apple Music through the iTunes lookup API: key-less, by identifier only
// (a UPC gives the album with its songs in one call; an ISRC one song), for
// the store linker (../store-links.ts). What it gives: the music.apple.com
// links, lengths, track numbers, a release date, the cover, and Apple's own
// coarse genre ("Dance", "Electronic", "House"), which genre_alias places or
// leaves orthogonal (sql/0018). No BPM, no key.
//
// Results are per storefront: a release absent from the US store may be in
// the German one, so a miss is tried again there. The service has no
// published quota but refuses bursts (about twenty a minute), hence the
// linker's pace.

import type { CatalogClaim } from '@curator/protocol';
import { getJson, type FetchLike } from '@curator/catalog-readers';

const API = 'https://itunes.apple.com/lookup';

type Result = {
	wrapperType?: 'collection' | 'track' | string;
	kind?: string;
	collectionId?: number;
	trackId?: number;
	artistId?: number;
	artistName?: string;
	collectionName?: string;
	trackName?: string;
	collectionViewUrl?: string;
	trackViewUrl?: string;
	artistViewUrl?: string;
	primaryGenreName?: string;
	releaseDate?: string;
	trackCount?: number;
	trackNumber?: number;
	discNumber?: number;
	trackTimeMillis?: number;
	artworkUrl100?: string;
	collectionType?: string;
};

// The share link without Apple's campaign parameter; the 100px artwork at 600.
const clean = (u?: string): string | undefined => {
	if (!u) return undefined;
	try {
		const url = new URL(u);
		url.searchParams.delete('uo');
		return url.toString();
	} catch {
		return u;
	}
};
const cover = (u?: string): string | undefined => u?.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1');

export class AppleLookup {
	constructor(
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly countries: readonly string[] = ['us', 'de'],
	) {}

	private async lookup(params: Record<string, string>, country: string, signal?: AbortSignal): Promise<Result[]> {
		const qs = new URLSearchParams({ ...params, country }).toString();
		const r = await getJson<{ results?: Result[] }>(this.fetchFn, 'apple', `${API}?${qs}`, { signal, logPath: '/lookup' });
		return r.results ?? [];
	}

	// The album with that barcode and its songs; null when no storefront has it.
	// `calls` says how many lookups it took (one per storefront tried).
	async albumByUpc(upc: string, signal?: AbortSignal): Promise<{ claim: CatalogClaim | null; calls: number }> {
		let calls = 0;
		for (const country of this.countries) {
			const results = await this.lookup({ upc, entity: 'song' }, country, signal);
			calls++;
			const album = results.find((r) => r.wrapperType === 'collection');
			if (!album?.collectionId) continue;
			const songs = results.filter((r) => r.wrapperType === 'track' && r.kind === 'song' && r.collectionId === album.collectionId);
			return { claim: albumClaim(album, songs, upc), calls };
		}
		return { claim: null, calls };
	}

	async trackByIsrc(isrc: string, signal?: AbortSignal): Promise<{ claim: CatalogClaim | null; calls: number }> {
		let calls = 0;
		for (const country of this.countries) {
			const results = await this.lookup({ isrc }, country, signal);
			calls++;
			const song = results.find((r) => r.wrapperType === 'track' && r.kind === 'song' && r.trackId);
			if (song) return { claim: songClaim(song, isrc), calls };
		}
		return { claim: null, calls };
	}
}

const date = (d?: string): string | undefined => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : undefined);

function artistClaims(r: Result): CatalogClaim[] {
	// Apple files compilations under an "artist" of that name: not an act.
	if (!r.artistId || !r.artistName || /^various artists$/i.test(r.artistName)) return [];
	return [{ provider: 'apple', kind: 'artist', providerId: String(r.artistId), name: r.artistName, url: clean(r.artistViewUrl) ?? null }];
}

function albumClaim(album: Result, songs: Result[], upc: string): CatalogClaim {
	return {
		provider: 'apple',
		kind: 'release',
		providerId: String(album.collectionId),
		name: album.collectionName ?? '',
		url: clean(album.collectionViewUrl) ?? null,
		identifiers: [{ namespace: 'upc', value: upc }],
		facts: {
			...(date(album.releaseDate) ? { releaseDate: date(album.releaseDate) } : {}),
			...(cover(album.artworkUrl100) ? { coverUrl: cover(album.artworkUrl100) } : {}),
			...(album.trackCount !== undefined ? { trackCount: album.trackCount } : {}),
		},
		artists: artistClaims(album),
		recordings: songs.map((s, i) => songClaim(s, undefined, i + 1)),
		...(album.primaryGenreName ? { genres: [album.primaryGenreName] } : {}),
	};
}

function songClaim(s: Result, isrc?: string, fallbackPos?: number): CatalogClaim {
	return {
		provider: 'apple',
		kind: 'recording',
		providerId: String(s.trackId),
		name: s.trackName ?? '',
		url: clean(s.trackViewUrl) ?? null,
		identifiers: isrc ? [{ namespace: 'isrc', value: isrc }] : [],
		facts: {
			...(s.trackTimeMillis ? { durationSec: Math.round(s.trackTimeMillis / 100) / 10 } : {}),
			...(s.trackNumber ?? fallbackPos ? { trackNumber: s.trackNumber ?? fallbackPos } : {}),
			...(s.discNumber ? { discNumber: s.discNumber } : {}),
		},
		artists: artistClaims(s),
		...(s.primaryGenreName ? { genres: [s.primaryGenreName] } : {}),
	};
}
