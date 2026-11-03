// A label's YouTube channel, through the Data API (CURATOR_YOUTUBE_API_KEY;
// 10,000 units a day, a list is one unit). Its uploads are the channel's
// own playlist ("UU" + the channel id's tail, no call to find it). A page's
// id can be the channel id, a handle (@name) or a legacy custom or user name
// (profile/links.ts); a handle costs one lookup, remembered in the cursor.
//
// An upload is a premiere or a promo, not a release: it is handed back as
// tentative — attached to the recording it names when the catalogue knows
// one (so the track gains a YouTube handle), otherwise an announcement
// signal on the label. Nothing is minted off a video title.

import type { CatalogClaim, CatalogKind } from '@curator/protocol';
import { nameFold } from '@curator/library-logic';
import { BROWSER_USER_AGENT } from './beatport-pages.js';
import { getJson, listingHash, rememberSeen, type FetchLike } from './http.js';
import { TrackerRateLimitedError, type TrackerAdapter, type TrackerPoll, type TrackerTarget } from './types.js';
import { parseUploadTitle } from './upload-title.js';

const API = 'https://www.googleapis.com/youtube/v3';
// Uploads older than this when first seen are not announcements.
const ANNOUNCE_WITHIN_DAYS = 60;
// A quota runs out for the day (resets at midnight Pacific).
const QUOTA_PARK_SEC = 6 * 3600;

type YtChannel = { id: string; snippet?: { title?: string } };
type YtItem = { snippet?: { title?: string; publishedAt?: string; channelTitle?: string; resourceId?: { videoId?: string }; thumbnails?: { high?: { url: string }; default?: { url: string } } } };

export class YouTubeTracker implements TrackerAdapter {
	readonly provider = 'youtube' as const;
	readonly kinds: readonly CatalogKind[] = ['label'];
	readonly callsPerPoll = 2;

	constructor(
		private readonly apiKey: string,
		private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
		private readonly now: () => number = Date.now,
	) {}

	private async get<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<T> {
		const q = new URLSearchParams({ ...params, key: this.apiKey }).toString();
		try {
			return await getJson<T>(this.fetchFn, 'youtube', `${API}${path}?${q}`, { signal, logPath: path });
		} catch (e) {
			// 403 is also how the API says the day's quota is spent.
			if (e instanceof Error && /youtube 403/.test(e.message)) throw new TrackerRateLimitedError(QUOTA_PARK_SEC);
			throw e;
		}
	}

	private async channelId(pageId: string, signal: AbortSignal): Promise<{ id: string; calls: number }> {
		if (/^UC[\w-]{20,}$/.test(pageId)) return { id: pageId, calls: 0 };
		const params: Record<string, string> = pageId.startsWith('user/') ? { forUsername: pageId.slice(5) } : { forHandle: pageId.replace(/^c\//, '').replace(/^@?/, '@') };
		const r = await this.get<{ items?: YtChannel[] }>('/channels', { part: 'id', ...params }, signal);
		const id = r.items?.[0]?.id ?? (await this.channelIdFromPage(pageId, signal));
		if (!id) throw new Error(`youtube channel not found for ${pageId}`);
		return { id, calls: 1 };
	}

	// A legacy custom URL (/c/name) is not a handle and the API cannot look it
	// up ("c/steyoyoketv" is @STEYOYOKE): the channel's own page names its id.
	private async channelIdFromPage(pageId: string, signal: AbortSignal): Promise<string | null> {
		try {
			const res = await this.fetchFn(`https://www.youtube.com/${pageId}`, { headers: { 'user-agent': BROWSER_USER_AGENT, 'accept-language': 'en' }, signal });
			if (!res.ok) return null;
			return /"externalId":"(UC[\w-]{20,})"/.exec(await res.text())?.[1] ?? null;
		} catch {
			return null;
		}
	}

	async poll(target: TrackerTarget, signal: AbortSignal): Promise<TrackerPoll> {
		if (!target.representation) throw new Error('youtube label tracker needs a channel');
		let calls = 0;
		let channel = typeof target.cursor.channelId === 'string' ? target.cursor.channelId : null;
		if (!channel) {
			const r = await this.channelId(target.representation.providerId, signal);
			channel = r.id;
			calls += r.calls;
		}
		const page = await this.get<{ items?: YtItem[] }>('/playlistItems', { part: 'snippet', playlistId: `UU${channel.slice(2)}`, maxResults: '50' }, signal);
		calls++;
		const items = (page.items ?? []).filter((i) => i.snippet?.resourceId?.videoId);
		const seen = new Set(Array.isArray(target.cursor.seen) ? (target.cursor.seen as string[]) : []);
		const cutoff = this.now() - ANNOUNCE_WITHIN_DAYS * 86400_000;
		const tentative: CatalogClaim[] = [];
		for (const i of items) {
			const s = i.snippet!;
			const id = s.resourceId!.videoId!;
			if (seen.has(id)) continue;
			const at = s.publishedAt ? Date.parse(s.publishedAt) : NaN;
			if (!Number.isFinite(at) || at < cutoff) continue;
			const credit = parseUploadTitle(s.title ?? '');
			if (!credit.title) continue;
			tentative.push({
				provider: 'youtube',
				kind: 'recording',
				providerId: id,
				name: credit.title,
				url: `https://www.youtube.com/watch?v=${id}`,
				artists: credit.artists.map((name) => ({ provider: 'user', kind: 'artist', providerId: `name:${nameFold(name)}`, name })),
				facts: s.thumbnails?.high?.url ? { coverUrl: s.thumbnails.high.url } : {},
				publishedAt: at,
			});
		}
		const ids = items.map((i) => i.snippet!.resourceId!.videoId!);
		return {
			children: [],
			tentative,
			listingHash: listingHash(ids),
			cursor: { channelId: channel, seen: rememberSeen(target.cursor.seen, ids) },
			calls,
		};
	}
}
