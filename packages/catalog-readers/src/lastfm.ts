// Last.fm's listener count for an artist (artist.getInfo: everyone who ever
// scrobbled them). Read by name: Last.fm keeps one page per name, and an
// MBID lookup lands on that same page, so a namesake's listeners come with
// it. The Reach score never takes it alone and drops it when the artist's
// other sources disagree (apps/cloud catalog/reach.ts).

import { getJson, type FetchLike } from './http.js';
import { TrackerRateLimitedError } from './types.js';

const API = 'https://ws.audioscrobbler.com/2.0/';
// Last.fm's error codes: 6 no such artist, 29 rate limit exceeded.
const NOT_FOUND = 6;
const RATE_LIMITED = 29;

type LfArtistInfo = { error?: number; artist?: { name?: string; stats?: { listeners?: string; playcount?: string } } };

export class LastfmReader {
	constructor(
		private readonly apiKey: string,
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
	) {}

	async artistListeners(name: string, signal: AbortSignal): Promise<number | null> {
		const q = new URLSearchParams({ method: 'artist.getinfo', artist: name, autocorrect: '0', api_key: this.apiKey, format: 'json' }).toString();
		const r = await getJson<LfArtistInfo>(this.fetchFn, 'lastfm', `${API}?${q}`, { signal, logPath: 'artist.getinfo' }).catch((e: unknown) => {
			// Last.fm answers its own errors with a status too, and the body says which.
			if (e instanceof Error && /lastfm (400|404)/.test(e.message)) return { error: NOT_FOUND } as LfArtistInfo;
			throw e;
		});
		if (r.error === RATE_LIMITED) throw new TrackerRateLimitedError(300);
		if (r.error) return null;
		const n = Number(r.artist?.stats?.listeners);
		return Number.isFinite(n) ? n : null;
	}
}
