// The lazy Spotify match: a card that arrived without a Spotify id (a
// release from Bandcamp, SoundCloud, Beatport or Deezer; a chart or playlist
// track the catalogue could not place on Spotify) is looked up on Spotify
// with this desktop's login the moment it is viewed, and upgraded in place
// when found — the row moves to source 'spotify', its tracks gain their
// Spotify ids, and the player can play it. Guy, 2026-11-06: "users can
// stream new releases using their main streaming service" is the point of
// the feed; the catalogue's own linking (by UPC / ISRC, cloud-side) stays,
// this is what fills the gap for what it has not reached.
//
// Evidence before a hit, strongest first: an ISRC of the card's tracks, the
// release's UPC, and only then the names — title and a credited artist, the
// same after folding, confirmed by the tracklist (at least half the tracks
// with the same title and a length within five seconds). A miss is asked
// again days later (a Bandcamp-first release reaches Spotify weeks after); a
// lookup that threw within the hour. One item at a time, through the
// process-wide Spotify gate the player shares.

import { artistsOverlap, closeSec, DURATION_TOLERANCE_SEC, ISRC_DURATION_TOLERANCE_SEC, nameFold, pairTracklists, titleKey, type MatchTrack } from '@curator/library-logic';
import type { SpotifyAlbum, SpotifySimplifiedTrack, SpotifyTrack } from '@curator/spotify';
import { log } from '@curator/sync-core/log';
import type { FeedStore } from '@curator/sync-core/feed/store';
import type { FeedHandle, FeedItem, FeedItemActivity, FeedItemDraft, FeedTrackRef, MatchStatus } from '@curator/sync-core/feed/types';
import { isSpotifyQuotaBackoff } from '@curator/spotify';

const flog = log.for('feed');

export const MATCH_RETRY_MS: Record<Exclude<MatchStatus, 'ok'>, number> = { none: 3 * 86400_000, err: 3600_000 };

export type SpotifyMatchClient = {
	searchTracks(query: string, limit?: number): Promise<SpotifyTrack[]>;
	searchAlbums(query: string, limit?: number): Promise<SpotifyAlbum[]>;
	getAlbumTracks(albumId: string): Promise<SpotifySimplifiedTrack[]>;
};

export type SpotifyMatchDeps = {
	store: Pick<FeedStore, 'upsertItems' | 'markMatched' | 'getItem'>;
	// This desktop's Spotify client, or null while Spotify is not connected.
	client: () => Promise<SpotifyMatchClient | null>;
	onActivity?: (a: FeedItemActivity) => void;
	now?: () => number;
};

// An album row the player cannot play: a catalogue recording with no Spotify
// id (feed/handles.ts — its sourceTrackId is its catalogue id).
const unplayable = (r: FeedTrackRef): boolean => !!r.catalogId && r.sourceTrackId === r.catalogId && !r.handles?.some((h) => h.provider === 'spotify');

// Whether a view of this item should try a match now: a card without a
// Spotify id, or a Spotify album whose rows are not all playable (the
// catalogue knew the album from one track's lookup and the other tracks are
// still queued for theirs — 2026-11-09, Rummel "Machine Language").
export function needsMatch(item: Pick<FeedItem, 'source' | 'matchStatus' | 'matchedAt'> & Partial<Pick<FeedItem, 'type' | 'payload'>>, now = Date.now()): boolean {
	if (item.source === 'spotify') {
		if (item.type !== 'album' || !(item.payload?.tracks ?? []).some(unplayable)) return false;
	} else if (item.source !== 'catalog') return false;
	if (item.matchStatus === null || item.matchStatus === 'ok') return item.matchStatus === null;
	return (item.matchedAt ?? 0) + MATCH_RETRY_MS[item.matchStatus] <= now;
}

// The tracklist comparison is the shared one (library-logic release-match.ts:
// the cloud repeats it, strictly, before it links what a device found).
export { titleKey, type MatchTrack };

// What the match reads of a release, whoever asks: a feed card's refs, or a
// catalogue release on an entity page (entity/work.ts).
export type AlbumQuery<R extends MatchTrack> = { title: string; artists: readonly string[]; upc?: string | null; tracks: readonly R[] };
export type TrackQuery = MatchTrack & { artists: readonly string[] };

// Our refs paired with the album's tracks: by title and length, else by
// position when the counts agree. Null when the tracklist does not confirm.
export function pairTracks<R extends MatchTrack>(ours: readonly R[], theirs: readonly SpotifySimplifiedTrack[]): Map<R, SpotifySimplifiedTrack> | null {
	const pairs = pairTracklists(ours, theirs.map((track) => ({ title: track.name, durationSec: track.duration_ms / 1000, track })));
	return pairs && new Map([...pairs].map(([r, t]) => [r, t.track]));
}

const spotifyHandle = (kind: 'album' | 'track', id: string, url?: string): FeedHandle => ({ provider: 'spotify', id, url: url ?? `https://open.spotify.com/${kind}/${id}` });

// The draft that upgrades the row (store.ts mergeFacts): the same identity,
// the Spotify source, every track's Spotify id beside its catalogue id.
export function albumDraft(item: FeedItem, album: { id: string; external_urls?: { spotify?: string } }, pairs: ReadonlyMap<FeedTrackRef, SpotifySimplifiedTrack>): FeedItemDraft {
	const url = album.external_urls?.spotify ?? `https://open.spotify.com/album/${album.id}`;
	const tracks: FeedTrackRef[] = (item.payload.tracks ?? []).map((r) => {
		const t = pairs.get(r);
		return t
			? { ...r, sourceTrackId: t.id, handles: [...(r.handles ?? []), spotifyHandle('track', t.id)] }
			: r;
	});
	return {
		type: 'album',
		source: 'spotify',
		sourceId: album.id,
		dedupeKey: item.dedupeKey,
		aliasKeys: [`spotify:album:${album.id}`],
		payload: { ...item.payload, url, handles: [spotifyHandle('album', album.id, url)], tracks },
		origin: item.origin,
		publishedAt: item.publishedAt,
		suppressKeys: ['source:spotify'],
	};
}

export function trackDraft(item: FeedItem, track: SpotifyTrack): FeedItemDraft {
	const url = `https://open.spotify.com/track/${track.id}`;
	const isrc = item.payload.isrc ?? track.external_ids?.isrc ?? null;
	return {
		type: 'track',
		source: 'spotify',
		sourceId: track.id,
		dedupeKey: item.dedupeKey,
		aliasKeys: [`spotify:track:${track.id}`, ...(isrc ? [`isrc:${isrc}`] : [])],
		payload: { ...item.payload, url, handles: [spotifyHandle('track', track.id, url)], ...(isrc ? { isrc } : {}) },
		origin: item.origin,
		publishedAt: item.publishedAt,
		suppressKeys: ['source:spotify'],
	};
}

export async function findSpotifyAlbum<R extends MatchTrack>(client: SpotifyMatchClient, q: AlbumQuery<R>): Promise<{ album: { id: string; external_urls?: { spotify?: string } }; pairs: Map<R, SpotifySimplifiedTrack> } | null> {
	const ours = q.tracks;
	const confirm = async (album: { id: string; external_urls?: { spotify?: string } }, total?: number) => {
		if (total !== undefined && ours.length && Math.abs(total - ours.length) > 1) return null;
		const theirs = await client.getAlbumTracks(album.id);
		const pairs = pairTracks(ours, theirs);
		return pairs ? { album, pairs } : null;
	};
	// By a track's ISRC: the album it is on.
	const seen = new Set<string>();
	for (const isrc of ours.map((r) => r.isrc).filter((x): x is string => !!x).slice(0, 2)) {
		for (const t of await client.searchTracks(`isrc:${isrc}`, 5)) {
			if (t.external_ids?.isrc && t.external_ids.isrc.toUpperCase() !== isrc.toUpperCase()) continue;
			if (seen.has(t.album.id)) continue;
			seen.add(t.album.id);
			const hit = await confirm({ id: t.album.id });
			if (hit) return hit;
		}
	}
	// By the release's UPC.
	if (q.upc) {
		for (const a of await client.searchAlbums(`upc:${q.upc}`, 5)) {
			if (seen.has(a.id)) continue;
			seen.add(a.id);
			const hit = await confirm(a, a.total_tracks);
			if (hit) return hit;
		}
	}
	// By names, confirmed by the tracklist.
	const artist = q.artists.find((a) => a.trim());
	const search = artist && nameFold(artist) !== nameFold('Various Artists') ? `album:"${q.title}" artist:"${artist}"` : `album:"${q.title}"`;
	const key = titleKey(q.title);
	for (const a of await client.searchAlbums(search, 10)) {
		if (seen.has(a.id) || titleKey(a.name) !== key || !artistsOverlap(q.artists, a.artists)) continue;
		seen.add(a.id);
		const hit = await confirm(a, a.total_tracks);
		if (hit) return hit;
	}
	return null;
}

// A Spotify album's rows that cannot play, paired with the album's own
// tracks: by title and length among the tracks no playable row holds, else
// by position when the lists are the same length. `complete` when every
// such row found its track; a miss (a remix the Spotify album lacks) is
// asked again days later.
export async function fillAlbumTracks(client: SpotifyMatchClient, item: FeedItem): Promise<{ album: { id: string }; pairs: Map<FeedTrackRef, SpotifySimplifiedTrack>; complete: boolean }> {
	const albumId = item.payload.handles?.find((h) => h.provider === 'spotify')?.id ?? item.sourceId;
	const ours = item.payload.tracks ?? [];
	const missing = ours.filter(unplayable);
	const theirs = await client.getAlbumTracks(albumId);
	const taken = new Set(ours.filter((r) => !unplayable(r)).flatMap((r) => [r.sourceTrackId, ...(r.handles ?? []).filter((h) => h.provider === 'spotify').map((h) => h.id)]));
	const pairs = new Map<FeedTrackRef, SpotifySimplifiedTrack>();
	for (const r of missing) {
		const key = titleKey(r.title);
		const hit = theirs.find((t) => !taken.has(t.id) && titleKey(t.name) === key && closeSec(r.durationSec, t.duration_ms / 1000, DURATION_TOLERANCE_SEC));
		if (hit) {
			pairs.set(r, hit);
			taken.add(hit.id);
		}
	}
	if (ours.length === theirs.length) {
		for (const [i, r] of ours.entries()) {
			const t = theirs[i]!;
			if (unplayable(r) && !pairs.has(r) && !taken.has(t.id) && closeSec(r.durationSec, t.duration_ms / 1000, DURATION_TOLERANCE_SEC)) {
				pairs.set(r, t);
				taken.add(t.id);
			}
		}
	}
	return { album: { id: albumId }, pairs, complete: pairs.size === missing.length };
}

export async function findSpotifyTrack(client: SpotifyMatchClient, p: TrackQuery): Promise<SpotifyTrack | null> {
	if (p.isrc) {
		const hit = (await client.searchTracks(`isrc:${p.isrc}`, 5)).find(
			(t) => (!t.external_ids?.isrc || t.external_ids.isrc.toUpperCase() === p.isrc!.toUpperCase()) && closeSec(p.durationSec, t.duration_ms / 1000, ISRC_DURATION_TOLERANCE_SEC),
		);
		if (hit) return hit;
	}
	const artist = p.artists.find((a) => a.trim());
	const key = titleKey(p.title);
	const search = artist ? `track:"${p.title}" artist:"${artist}"` : `track:"${p.title}"`;
	return (await client.searchTracks(search, 10)).find((t) => titleKey(t.name) === key && artistsOverlap(p.artists, t.artists) && closeSec(p.durationSec, t.duration_ms / 1000, DURATION_TOLERANCE_SEC)) ?? null;
}

// Try once, record the outcome, return the item as it now stands (upgraded
// on a hit). The caller decides whether a try is due (needsMatch).
export async function matchSpotify(deps: SpotifyMatchDeps, item: FeedItem): Promise<FeedItem> {
	const client = await deps.client().catch(() => null);
	if (!client) return item;
	deps.onActivity?.({ itemId: item.id, activity: 'spotify' });
	try {
		if (item.type === 'album' && item.source === 'spotify') {
			const fill = await fillAlbumTracks(client, item);
			if (fill.pairs.size) await deps.store.upsertItems([albumDraft(item, fill.album, fill.pairs)]);
			const status: MatchStatus = fill.complete ? 'ok' : 'none';
			await deps.store.markMatched(item.id, status);
			if (fill.pairs.size) flog.info('feed album rows matched on Spotify', { itemId: item.id, rows: fill.pairs.size, complete: fill.complete });
			const next = fill.pairs.size ? await deps.store.getItem(item.id) : null;
			return next ?? { ...item, matchStatus: status, matchedAt: deps.now?.() ?? Date.now() };
		}
		const draft = item.type === 'album'
			? await findSpotifyAlbum(client, { title: item.payload.title, artists: item.payload.artists, upc: item.payload.upc, tracks: item.payload.tracks ?? [] }).then((hit) => (hit ? albumDraft(item, hit.album, hit.pairs) : null))
			: await findSpotifyTrack(client, item.payload).then((hit) => (hit ? trackDraft(item, hit) : null));
		if (!draft) {
			await deps.store.markMatched(item.id, 'none');
			return { ...item, matchStatus: 'none', matchedAt: deps.now?.() ?? Date.now() };
		}
		await deps.store.upsertItems([draft]);
		await deps.store.markMatched(item.id, 'ok');
		flog.info('feed item matched on Spotify', { itemId: item.id, type: item.type, spotifyId: draft.sourceId });
		return (await deps.store.getItem(item.id)) ?? item;
	} catch (err) {
		// The provider refused without a call (quota ban): nothing was tried,
		// so the item stays untried and the next view after the ban matches it.
		if (isSpotifyQuotaBackoff(err)) {
			flog.debug('spotify match deferred by the quota ban', { itemId: item.id });
			return item;
		}
		flog.warn('spotify match failed', { itemId: item.id }, err);
		await deps.store.markMatched(item.id, 'err');
		return { ...item, matchStatus: 'err', matchedAt: deps.now?.() ?? Date.now() };
	} finally {
		deps.onActivity?.({ itemId: item.id, activity: null });
	}
}
