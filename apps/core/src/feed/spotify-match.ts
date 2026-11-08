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

import { nameFold } from '@curator/library-logic';
import type { SpotifyAlbum, SpotifySimplifiedTrack, SpotifyTrack } from '@curator/spotify';
import { log } from '../log.js';
import type { FeedStore } from './store.js';
import type { FeedHandle, FeedItem, FeedItemActivity, FeedItemDraft, FeedTrackRef, MatchStatus } from './types.js';
import { isSpotifyQuotaBackoff } from '@curator/spotify';

const flog = log.for('feed');

export const MATCH_RETRY_MS: Record<Exclude<MatchStatus, 'ok'>, number> = { none: 3 * 86400_000, err: 3600_000 };
// Tracklist confirmation: title and length agree for at least this share.
const CONFIRM_SHARE = 0.5;
const DURATION_TOLERANCE_SEC = 5;
const ISRC_DURATION_TOLERANCE_SEC = 10;

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

// Whether a view of this item should try a match now.
export function needsMatch(item: Pick<FeedItem, 'source' | 'matchStatus' | 'matchedAt'>, now = Date.now()): boolean {
	if (item.source !== 'catalog') return false;
	if (item.matchStatus === null || item.matchStatus === 'ok') return item.matchStatus === null;
	return (item.matchedAt ?? 0) + MATCH_RETRY_MS[item.matchStatus] <= now;
}

// Titles across stores differ by their mix tags ("Original Mix", "[LABEL]"):
// folded without them, with the fold the catalogue uses.
export function titleKey(title: string): string {
	return nameFold(
		title
			.replace(/\s*[[(]\s*original\s+mix\s*[\])]/gi, '')
			.replace(/\s+-\s+original\s+mix\s*$/i, '')
			.replace(/\s*\[[^\]]*\]\s*$/g, ''),
	);
}

const closeSec = (a: number | null | undefined, b: number | null | undefined, tol: number): boolean => a == null || b == null || a <= 0 || b <= 0 || Math.abs(a - b) <= tol;

const artistsOverlap = (ours: readonly string[], theirs: readonly { name: string }[]): boolean => {
	const folds = new Set(ours.map(nameFold).filter(Boolean));
	if (!folds.size || folds.has(nameFold('Various Artists'))) return true;
	return theirs.some((a) => folds.has(nameFold(a.name)));
};

// Our refs paired with the album's tracks: by title and length, else by
// position when the counts agree. Null when the tracklist does not confirm.
export function pairTracks(ours: readonly FeedTrackRef[], theirs: readonly SpotifySimplifiedTrack[]): Map<FeedTrackRef, SpotifySimplifiedTrack> | null {
	if (!ours.length || !theirs.length) return null;
	const pairs = new Map<FeedTrackRef, SpotifySimplifiedTrack>();
	const taken = new Set<string>();
	for (const r of ours) {
		const key = titleKey(r.title);
		const hit = theirs.find((t) => !taken.has(t.id) && titleKey(t.name) === key && closeSec(r.durationSec, t.duration_ms / 1000, DURATION_TOLERANCE_SEC));
		if (hit) {
			pairs.set(r, hit);
			taken.add(hit.id);
		}
	}
	if (pairs.size < Math.max(1, Math.ceil(ours.length * CONFIRM_SHARE))) return null;
	// The rest by position, when the lists are the same length.
	if (ours.length === theirs.length) {
		for (const [i, r] of ours.entries()) {
			const t = theirs[i]!;
			if (!pairs.has(r) && !taken.has(t.id) && closeSec(r.durationSec, t.duration_ms / 1000, DURATION_TOLERANCE_SEC)) {
				pairs.set(r, t);
				taken.add(t.id);
			}
		}
	}
	return pairs;
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

async function findAlbum(client: SpotifyMatchClient, item: FeedItem): Promise<{ album: { id: string; external_urls?: { spotify?: string } }; pairs: Map<FeedTrackRef, SpotifySimplifiedTrack> } | null> {
	const ours = item.payload.tracks ?? [];
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
	if (item.payload.upc) {
		for (const a of await client.searchAlbums(`upc:${item.payload.upc}`, 5)) {
			if (seen.has(a.id)) continue;
			seen.add(a.id);
			const hit = await confirm(a, a.total_tracks);
			if (hit) return hit;
		}
	}
	// By names, confirmed by the tracklist.
	const artist = item.payload.artists.find((a) => a.trim());
	const q = artist && nameFold(artist) !== nameFold('Various Artists') ? `album:"${item.payload.title}" artist:"${artist}"` : `album:"${item.payload.title}"`;
	const key = titleKey(item.payload.title);
	for (const a of await client.searchAlbums(q, 10)) {
		if (seen.has(a.id) || titleKey(a.name) !== key || !artistsOverlap(item.payload.artists, a.artists)) continue;
		seen.add(a.id);
		const hit = await confirm(a, a.total_tracks);
		if (hit) return hit;
	}
	return null;
}

async function findTrack(client: SpotifyMatchClient, item: FeedItem): Promise<SpotifyTrack | null> {
	const p = item.payload;
	if (p.isrc) {
		const hit = (await client.searchTracks(`isrc:${p.isrc}`, 5)).find(
			(t) => (!t.external_ids?.isrc || t.external_ids.isrc.toUpperCase() === p.isrc!.toUpperCase()) && closeSec(p.durationSec, t.duration_ms / 1000, ISRC_DURATION_TOLERANCE_SEC),
		);
		if (hit) return hit;
	}
	const artist = p.artists.find((a) => a.trim());
	const key = titleKey(p.title);
	const q = artist ? `track:"${p.title}" artist:"${artist}"` : `track:"${p.title}"`;
	return (await client.searchTracks(q, 10)).find((t) => titleKey(t.name) === key && artistsOverlap(p.artists, t.artists) && closeSec(p.durationSec, t.duration_ms / 1000, DURATION_TOLERANCE_SEC)) ?? null;
}

// Try once, record the outcome, return the item as it now stands (upgraded
// on a hit). The caller decides whether a try is due (needsMatch).
export async function matchSpotify(deps: SpotifyMatchDeps, item: FeedItem): Promise<FeedItem> {
	const client = await deps.client().catch(() => null);
	if (!client) return item;
	deps.onActivity?.({ itemId: item.id, activity: 'spotify' });
	try {
		const draft = item.type === 'album'
			? await findAlbum(client, item).then((hit) => (hit ? albumDraft(item, hit.album, hit.pairs) : null))
			: await findTrack(client, item).then((hit) => (hit ? trackDraft(item, hit) : null));
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
