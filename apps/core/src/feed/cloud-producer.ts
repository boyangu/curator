// The Global Catalog's event stream as a feed producer ('global_catalog').
//
// The cloud tracks the artists and labels the account watches and raises one
// event per new release (apps/cloud src/catalog); every device reads the
// stream with its own cursor and runs it through the same pipeline and store
// as the local producers, so dedupe, mutes, the library filter, the
// track↔album collapse and the ranking all apply unchanged. Decisions about
// the items stay on the op log as before.
//
// Spotify only, for now (Guy, 2026-10-26): Discover plays through the Spotify
// player, so a release reaches the feed only with a Spotify id, and only its
// tracks with Spotify ids. Its ids then match the local Spotify producer's:
// the item key is `spotify:album:<id>`, the origin is the watched artist's
// Spotify id (the catalogue object rides beside it as `catalogId`), and the
// artist ids that mutes key on are Spotify's. An album both producers found is
// one row with one origin.
//
// An event's card is frozen at the cloud, complete (tracklist, ISRCs), so no
// stage calls a provider for it.

import { nameFold } from '@curator/library-logic';
import type { CatalogEvent, CatalogEventCardV1, CatalogEventTrackCardV1, CatalogHandle, FeedEventsResult, FeedRecentResult } from '@curator/protocol';
import { log } from '../log.js';
import type { FeedItemDraft, FeedOrigin, FeedProducer, FeedTrackRef } from './types.js';

const flog = log.for('feed');

export const CLOUD_FEED_PRODUCER_ID = 'cloud-catalog';
// Pages read per poll: a device that was offline for a month catches up over
// a few polls rather than in one long pass.
const MAX_PAGES = 5;

export interface CatalogFeedPort {
	// The server offers the Global Catalog and this device is signed in.
	available(): boolean;
	events(afterSeq: number): Promise<FeedEventsResult>;
	// "Load more": the watches' events of the last `days`, any seq.
	recent(days: number): Promise<FeedRecentResult>;
	// The catalogue objects this account watches: an event's origin is the one
	// it concerns that the user follows.
	watchedIds(): Promise<Set<string>>;
	// Run before each poll (the behind-the-scenes Spotify follows sync,
	// catalog-client/follows-sync.ts). Failures are logged, never fatal.
	prepare?(): Promise<void>;
}

type Cursor = { afterSeq: number };

const spotifyId = (hs: readonly CatalogHandle[]): string | null => hs.find((h) => h.provider === 'spotify')?.id ?? null;

// A track added to a watched Spotify playlist: the same item the local
// playlist producer makes for it (key, payload, origin, suppress keys), so
// one seen by both is one row and its decisions carry over. A chart entry
// (a watched genre's top list) is the same track item filed under the genre,
// a browse origin like a label's.
function trackDraft(e: CatalogEvent, card: CatalogEventTrackCardV1): FeedItemDraft | null {
	const trackId = spotifyId(card.handles);
	if (!trackId) return null;
	const artistIds = card.artists.map((a) => spotifyId(a.handles) ?? '');
	let origin: FeedOrigin;
	let originKey: string | null = null;
	if (card.container.kind === 'playlist') {
		const playlistId = spotifyId(card.container.handles);
		if (!playlistId) return null;
		origin = { kind: 'playlist', id: playlistId, name: card.container.name, catalogId: card.container.id };
		originKey = `playlist:${playlistId}`;
	} else {
		origin = { kind: 'browse', id: `catalog:${card.container.id}`, name: card.container.name, catalogId: card.container.id };
	}
	return {
		type: 'track',
		source: 'spotify',
		sourceId: trackId,
		dedupeKey: card.isrc ? `isrc:${card.isrc}` : `spotify:track:${trackId}`,
		payload: {
			title: card.title,
			isrc: card.isrc,
			artists: card.artists.map((a) => a.name),
			artistIds,
			coverUrl: card.coverUrl,
			albumTitle: card.albumTitle,
			releaseDate: card.releaseDate,
			durationSec: card.durationSec === null ? 0 : Math.round(card.durationSec),
			url: `https://open.spotify.com/track/${trackId}`,
		},
		origin,
		publishedAt: card.addedAt ?? e.sourcePublishedAt ?? e.firstSeenAt,
		suppressKeys: ['source:spotify', ...(originKey ? [originKey] : []), ...artistIds.filter(Boolean).map((id) => `artist:${id}`)],
	};
}

// `watched`: the catalogue ids the user follows; the origin is the first of
// the event's subjects among them (an artist before a label).
export function eventToDraft(e: CatalogEvent, watched: ReadonlySet<string> = new Set()): FeedItemDraft | null {
	if (e.card.version !== 1) {
		flog.info('catalog event with a newer card skipped', { seq: e.seq, version: e.card.version });
		return null;
	}
	if (e.kind === 'playlist_add' || e.kind === 'chart_entry' || e.card.kind === 'track') return trackDraft(e, e.card as CatalogEventTrackCardV1);
	const card = e.card as CatalogEventCardV1;
	const albumId = spotifyId(card.handles);
	if (!albumId) return null;
	const tracks: FeedTrackRef[] = [];
	const idByName = new Map(card.artists.map((a) => [nameFold(a.name), spotifyId(a.handles) ?? ''] as const));
	card.tracks.forEach((t, i) => {
		const id = spotifyId(t.handles);
		if (!id) return;
		tracks.push({
			sourceTrackId: id,
			title: t.title,
			artists: t.artists,
			artistIds: t.artists.map((n) => idByName.get(nameFold(n)) ?? ''),
			durationSec: t.durationSec,
			trackNumber: i + 1,
			isrc: t.isrc,
		});
	});
	// A release none of whose tracks the Spotify player can play is not shown.
	if (!tracks.length) return null;

	const ranked = [...e.subjects].sort((a, b) => Number(b.kind === 'artist') - Number(a.kind === 'artist'));
	const subject = ranked.find((s) => watched.has(s.objectId)) ?? ranked[0] ?? null;
	let origin: FeedOrigin | null = null;
	if (subject?.kind === 'artist') {
		const artist = card.artists.find((a) => a.id === subject.objectId);
		const sid = artist ? spotifyId(artist.handles) : null;
		// Keyed by Spotify, like the local producer; without a Spotify id the
		// follow has no key the feed's mute and unfollow understand.
		if (!sid) return null;
		origin = { kind: 'artist', id: sid, name: subject.name, catalogId: subject.objectId };
	} else if (subject) {
		origin = { kind: 'browse', id: `catalog:${subject.objectId}`, name: subject.name, catalogId: subject.objectId };
	}
	const artistIds = card.artists.map((a) => spotifyId(a.handles) ?? '');
	return {
		type: 'album',
		source: 'spotify',
		sourceId: albumId,
		dedupeKey: `spotify:album:${albumId}`,
		payload: {
			title: card.title,
			artists: card.artists.map((a) => a.name),
			artistIds,
			label: card.label?.name ?? null,
			coverUrl: card.coverUrl,
			releaseDate: card.releaseDate,
			albumType: card.releaseType,
			trackCount: card.tracks.length || null,
			url: card.handles.find((h) => h.provider === 'spotify')?.url ?? `https://open.spotify.com/album/${albumId}`,
			tracks,
			// The card carries every ISRC the catalogue knows: nothing to fill.
			isrcResolved: true,
			...(card.genres.length ? { genre: card.genres[0] } : {}),
		},
		origin,
		publishedAt: e.releaseAt ?? e.sourcePublishedAt ?? e.firstSeenAt,
		suppressKeys: [...artistIds.filter(Boolean).map((id) => `artist:${id}`), 'source:spotify'],
	};
}

export class CloudFeedProducer implements FeedProducer {
	readonly id = CLOUD_FEED_PRODUCER_ID;
	readonly source = 'spotify' as const;
	readonly displayName = 'Followed artists and labels';

	constructor(private readonly port: CatalogFeedPort) {}

	private async drafts(events: CatalogEvent[]): Promise<FeedItemDraft[]> {
		if (!events.length) return [];
		const watched = await this.port.watchedIds().catch(() => new Set<string>());
		const out: FeedItemDraft[] = [];
		for (const e of events) {
			// A reissue (a compilation of tracks the catalogue already knew) is
			// not discovery.
			if (e.kind === 'reissue') continue;
			const d = eventToDraft(e, watched);
			if (d) out.push(d);
		}
		return out;
	}

	async poll(cursor: unknown): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }> {
		if (!this.port.available()) return { drafts: [], nextCursor: cursor };
		await this.port.prepare?.().catch((e: unknown) => flog.warn('catalog follows sync failed', undefined, e));
		let afterSeq = (cursor as Cursor | null)?.afterSeq ?? 0;
		const events: CatalogEvent[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const r = await this.port.events(afterSeq);
			events.push(...r.events);
			const advanced = r.nextSeq > afterSeq;
			afterSeq = Math.max(afterSeq, r.nextSeq);
			if (!advanced || r.events.length === 0) break;
		}
		return { drafts: await this.drafts(events), nextCursor: { afterSeq } satisfies Cursor };
	}

	// "Load more": the window's events again; the store's dedupe makes the
	// ones already held free. The stream cursor is untouched.
	async backfill(cursor: unknown, days: number): Promise<{ drafts: FeedItemDraft[]; nextCursor: unknown }> {
		if (!this.port.available()) return { drafts: [], nextCursor: cursor };
		const r = await this.port.recent(days);
		return { drafts: await this.drafts(r.events), nextCursor: cursor };
	}
}
