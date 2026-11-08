// The Global Catalog's event stream as a feed producer ('global_catalog').
//
// The cloud tracks the artists, labels, playlists and genres the account
// watches and raises one event per new release, playlist addition or chart
// entry (apps/cloud src/catalog); every device reads the stream with its own
// cursor and runs it through the same pipeline and store as the local
// producers, so dedupe, mutes, the library filter, the track↔album collapse
// and the ranking all apply unchanged. Decisions about the items stay on the
// op log as before.
//
// Identity is the catalogue's (2026-11-04): an item is keyed
// `catalog:release:<id>` / `catalog:recording:<id>`, and the Spotify / ISRC
// keys the local producers use ride along as aliases (store.ts
// feed_item_alias), so a release both found is one row and an event
// re-announced with a new provider lands on the row it already made.
//
// Presence is not playability: every release a watched subject brings is
// shown, whatever providers carry it. One the Spotify player can play is
// source 'spotify' with its Spotify id, exactly as the local producer would
// file it; one it cannot is source 'catalog' (sourceId = the catalogue id)
// and links out to its stores (payload.handles) until a Spotify id arrives,
// when the re-announced card upgrades the row in place. Artists without a
// Spotify id are keyed `catalog:<objectId>` wherever a Spotify id would go.
//
// An event's card is frozen at the cloud, complete (tracklist, ISRCs and, from
// card v2, BPM / key / genres), so no stage calls a provider for it.

import { nameFold } from '@curator/library-logic';
import type {
	CatalogCheckReport,
	CatalogEvent,
	CatalogEventCardV1,
	CatalogEventCardV2,
	CatalogEventTrackCardV1,
	CatalogEventTrackCardV2,
	CatalogHandle,
	FeedEventsResult,
	FeedRecentResult,
} from '@curator/protocol';
import { keyToCamelot } from '../enrich/keys.js';
import { log } from '../log.js';
import type { FeedItemDraft, FeedOrigin, FeedProducer, FeedProducerContext, FeedProducerResult, FeedRefreshKind, FeedTrackRef } from './types.js';

const flog = log.for('feed');

export const CLOUD_FEED_PRODUCER_ID = 'cloud-catalog';
// The port only knows "available or not" (CatalogFeedPort.available).
const UNAVAILABLE = 'Curator Cloud is signed out or its catalogue is not reachable';
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
	// A Refresh's "check now" (FeedRefreshScope): the user's follows of the
	// kind — every checked kind without one — become due on their checked
	// sources and this desktop's worker starts reading them (catalog-worker
	// /service.ts tickNow). Resolves with the master's report in seconds;
	// the reads go on in the background and their events reach the feed on
	// a later poll. Null when the worker cannot ask.
	checkNow?(kind?: FeedRefreshKind): Promise<CatalogCheckReport | null>;
}

const KIND_WORDS: Record<FeedRefreshKind, string> = { artist: 'artists', label: 'labels', playlist: 'playlists', genre: 'genres' };

// The check's report in one line: "Checked your artists on Spotify, Deezer:
// 1,802 queued, 44 read within the hour". Null parts are left out.
export function checkNote(r: CatalogCheckReport | null, kind?: FeedRefreshKind): string {
	const what = kind ? `your ${KIND_WORDS[kind]}` : 'your follows';
	if (!r) return `Could not ask the catalogue to check ${what} now`;
	const sources = r.byProvider.map((p) => p.provider).join(', ');
	const sum = (k: 'queued' | 'alreadyDue' | 'recent' | 'reading' | 'paused') => r.byProvider.reduce((n, p) => n + p[k], 0);
	const parts = [
		`${r.queued.toLocaleString()} queued`,
		sum('alreadyDue') ? `${sum('alreadyDue').toLocaleString()} due already` : null,
		sum('recent') ? `${sum('recent').toLocaleString()} read within the hour` : null,
		sum('reading') ? `${sum('reading').toLocaleString()} being read` : null,
		sum('paused') ? `${sum('paused').toLocaleString()} on a source that asked us to wait` : null,
	].filter((p): p is string => p !== null);
	if (!r.byProvider.length) return `Nothing to check for ${what}: no source is on for them`;
	return `Checked ${what} on ${sources}: ${parts.join(', ')}`;
}

type Cursor = { afterSeq: number };

const spotifyId = (hs: readonly CatalogHandle[]): string | null => hs.find((h) => h.provider === 'spotify')?.id ?? null;
const spotifyUrl = (hs: readonly CatalogHandle[]): string | null => hs.find((h) => h.provider === 'spotify')?.url ?? null;
const firstUrl = (hs: readonly CatalogHandle[]): string | null => hs.find((h) => h.url)?.url ?? null;

// Where a Spotify artist id goes: the id, or the catalogue object's.
const artistKeyOf = (a: { id: string; handles: readonly CatalogHandle[] }): string => spotifyId(a.handles) ?? `catalog:${a.id}`;

// Cards the device can read, as v2: a stored v1 card reads with its facts
// empty. Anything newer is not guessed at.
type ReleaseCard = CatalogEventCardV2;
type TrackCard = CatalogEventTrackCardV2;

function normalizeCard(e: CatalogEvent): { kind: 'release'; card: ReleaseCard } | { kind: 'track'; card: TrackCard } | null {
	const c = e.card;
	if (c.version !== 1 && c.version !== 2) {
		flog.info('catalog event with a newer card skipped', { seq: e.seq, version: c.version });
		return null;
	}
	if (e.kind === 'playlist_add' || e.kind === 'chart_entry' || c.kind === 'track') {
		const t = c as CatalogEventTrackCardV1 | CatalogEventTrackCardV2;
		return {
			kind: 'track',
			card: { ...t, version: 2, bpm: 'bpm' in t ? t.bpm : null, key: 'key' in t ? t.key : null, genres: 'genres' in t ? t.genres : [], label: 'label' in t ? t.label : null },
		};
	}
	const r = c as CatalogEventCardV1 | CatalogEventCardV2;
	return {
		kind: 'release',
		card: {
			...r,
			version: 2,
			catalogNumber: 'catalogNumber' in r ? r.catalogNumber : null,
			upc: 'upc' in r ? r.upc : null,
			tracks: r.tracks.map((t) => ({ ...t, bpm: 'bpm' in t ? t.bpm : null, key: 'key' in t ? t.key : null, genres: 'genres' in t ? t.genres : [] })),
		},
	};
}

// A track added to a watched playlist, or a genre's chart entry. With a
// Spotify id it is the same item the local playlist producer makes (its
// keys are the aliases, its origin the Spotify playlist), so one seen by
// both is one row and its decisions carry over.
function trackDraft(e: CatalogEvent, card: TrackCard): FeedItemDraft {
	const trackId = spotifyId(card.handles);
	const artistIds = card.artists.map(artistKeyOf);
	let origin: FeedOrigin;
	const keys: string[] = [];
	if (card.container.kind === 'playlist') {
		const playlistId = spotifyId(card.container.handles) ?? `catalog:${card.container.id}`;
		origin = { kind: 'playlist', id: playlistId, name: card.container.name, catalogId: card.container.id };
		keys.push(`playlist:${playlistId}`);
	} else {
		origin = { kind: 'genre', id: card.container.id, name: card.container.name, catalogId: card.container.id, rank: card.rank };
		keys.push(`genre:${card.container.id}`);
	}
	return {
		type: 'track',
		source: trackId ? 'spotify' : 'catalog',
		sourceId: trackId ?? e.subjectId,
		dedupeKey: `catalog:recording:${e.subjectId}`,
		aliasKeys: [...(card.isrc ? [`isrc:${card.isrc}`] : []), ...(trackId ? [`spotify:track:${trackId}`] : [])],
		payload: {
			title: card.title,
			isrc: card.isrc,
			artists: card.artists.map((a) => a.name),
			artistIds,
			coverUrl: card.coverUrl,
			albumTitle: card.albumTitle,
			releaseDate: card.releaseDate,
			durationSec: card.durationSec === null ? 0 : Math.round(card.durationSec),
			url: spotifyUrl(card.handles) ?? (trackId ? `https://open.spotify.com/track/${trackId}` : firstUrl(card.handles)),
			catalogId: e.subjectId,
			handles: card.handles,
			bpm: card.bpm,
			keyCamelot: keyToCamelot(card.key),
			genre: card.genres[0] ?? null,
			label: card.label?.name ?? null,
		},
		origin,
		publishedAt: card.addedAt ?? e.sourcePublishedAt ?? e.firstSeenAt,
		suppressKeys: [...(trackId ? ['source:spotify'] : []), ...keys, ...artistIds.map((id) => `artist:${id}`)],
	};
}

// `watched`: the catalogue ids the user follows; the origin is the first of
// the event's subjects among them — an artist before a label before anything
// else.
function releaseDraft(e: CatalogEvent, card: ReleaseCard, watched: ReadonlySet<string>): FeedItemDraft {
	const albumId = spotifyId(card.handles);
	const idByName = new Map(card.artists.map((a) => [nameFold(a.name), artistKeyOf(a)] as const));
	const tracks: FeedTrackRef[] = card.tracks.map((t, i) => {
		const sid = spotifyId(t.handles);
		return {
			// The Spotify id when the player can play it, else the catalogue id
			// (feed/handles.ts tells them apart by catalogId).
			sourceTrackId: sid ?? t.id,
			catalogId: t.id,
			handles: t.handles,
			title: t.title,
			artists: t.artists,
			artistIds: t.artists.map((n) => idByName.get(nameFold(n)) ?? ''),
			durationSec: t.durationSec,
			trackNumber: i + 1,
			isrc: t.isrc,
			bpm: t.bpm,
			keyCamelot: keyToCamelot(t.key),
			genre: t.genres[0] ?? card.genres[0] ?? null,
			label: card.label?.name ?? null,
			releaseDate: card.releaseDate,
		};
	});

	const rank = (kind: string) => (kind === 'artist' ? 0 : kind === 'label' ? 1 : 2);
	const ranked = [...e.subjects].sort((a, b) => rank(a.kind) - rank(b.kind));
	const subject = ranked.find((s) => watched.has(s.objectId)) ?? ranked[0] ?? null;
	let origin: FeedOrigin | null = null;
	if (subject?.kind === 'artist') {
		const artist = card.artists.find((a) => a.id === subject.objectId);
		origin = { kind: 'artist', id: artist ? artistKeyOf(artist) : `catalog:${subject.objectId}`, name: subject.name, catalogId: subject.objectId };
	} else if (subject?.kind === 'label') {
		origin = { kind: 'label', id: subject.objectId, name: subject.name, catalogId: subject.objectId };
	} else if (subject) {
		origin = { kind: 'browse', id: `catalog:${subject.objectId}`, name: subject.name, catalogId: subject.objectId };
	}
	const artistIds = card.artists.map(artistKeyOf);
	const labelKeys = new Set([card.label?.id, origin?.kind === 'label' ? origin.id : null].filter((x): x is string => !!x).map((id) => `label:${id}`));
	return {
		type: 'album',
		source: albumId ? 'spotify' : 'catalog',
		sourceId: albumId ?? e.subjectId,
		dedupeKey: `catalog:release:${e.subjectId}`,
		aliasKeys: albumId ? [`spotify:album:${albumId}`] : [],
		payload: {
			title: card.title,
			artists: card.artists.map((a) => a.name),
			artistIds,
			label: card.label?.name ?? null,
			coverUrl: card.coverUrl,
			releaseDate: card.releaseDate,
			albumType: card.releaseType,
			trackCount: tracks.length || null,
			url: spotifyUrl(card.handles) ?? (albumId ? `https://open.spotify.com/album/${albumId}` : firstUrl(card.handles)),
			tracks,
			// The card carries every ISRC the catalogue knows: nothing to fill.
			isrcResolved: true,
			genre: card.genres[0] ?? null,
			catalogId: e.subjectId,
			handles: card.handles,
			catalogNumber: card.catalogNumber,
			upc: card.upc,
		},
		origin,
		publishedAt: e.releaseAt ?? e.sourcePublishedAt ?? e.firstSeenAt,
		suppressKeys: [...artistIds.map((id) => `artist:${id}`), ...labelKeys, ...(albumId ? ['source:spotify'] : [])],
	};
}

export function eventToDraft(e: CatalogEvent, watched: ReadonlySet<string> = new Set()): FeedItemDraft | null {
	const n = normalizeCard(e);
	if (!n) return null;
	return n.kind === 'track' ? trackDraft(e, n.card) : releaseDraft(e, n.card, watched);
}

export class CloudFeedProducer implements FeedProducer {
	readonly id = CLOUD_FEED_PRODUCER_ID;
	// Informational: the scheduler does not branch on it. Items carry their
	// own source ('spotify', or 'catalog' when no player can play them yet).
	readonly source = 'spotify' as const;
	// The step's name in the refresh status: what the Following panel lists
	// (artists, labels, playlists and genres).
	readonly displayName = 'Following';
	readonly kinds = ['artist', 'label', 'playlist', 'genre'] as const satisfies readonly FeedRefreshKind[];

	constructor(private readonly port: CatalogFeedPort) {}

	private async drafts(events: CatalogEvent[]): Promise<FeedItemDraft[]> {
		if (!events.length) return [];
		const watched = await this.port.watchedIds().catch(() => new Set<string>());
		const out: FeedItemDraft[] = [];
		for (const e of events) {
			// A reissue (a compilation of tracks the catalogue already knew) is
			// not discovery (Guy, 2026-11-04: keep dropping them).
			if (e.kind === 'reissue') continue;
			const d = eventToDraft(e, watched);
			if (d) out.push(d);
		}
		return out;
	}

	async poll(cursor: unknown, ctx?: FeedProducerContext): Promise<FeedProducerResult> {
		if (!this.port.available()) return { drafts: [], nextCursor: cursor, skipped: UNAVAILABLE };
		if (this.port.prepare) {
			ctx?.report('Sending your Spotify follows to the catalogue');
			await this.port.prepare().catch((e: unknown) => flog.warn('catalog follows sync failed', undefined, e));
		}
		// A Refresh's check: asked and answered in seconds, read in the
		// background. Never on a timer's pass.
		let note: string | undefined;
		if (ctx?.manual && ctx.scope?.check && this.port.checkNow) {
			const kind = ctx.scope.kind;
			ctx.report(`Asking the catalogue to check ${kind ? KIND_WORDS[kind] : 'your follows'} now`);
			const r = await this.port.checkNow(kind).catch((e: unknown) => {
				flog.warn('catalog check now failed', undefined, e);
				return null;
			});
			note = checkNote(r, kind);
			ctx.report(note);
		}
		let afterSeq = (cursor as Cursor | null)?.afterSeq ?? 0;
		const events: CatalogEvent[] = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			ctx?.report(page === 0 ? 'Asking the catalogue for new releases' : `Reading new releases (${events.length} so far)`);
			const r = await this.port.events(afterSeq);
			events.push(...r.events);
			const advanced = r.nextSeq > afterSeq;
			afterSeq = Math.max(afterSeq, r.nextSeq);
			if (!advanced || r.events.length === 0) break;
		}
		return { drafts: await this.drafts(events), nextCursor: { afterSeq } satisfies Cursor, ...(note ? { note } : {}) };
	}

	// "Load more": the window's events again; the store's dedupe makes the
	// ones already held free. The stream cursor is untouched.
	async backfill(cursor: unknown, days: number, ctx?: FeedProducerContext): Promise<FeedProducerResult> {
		if (!this.port.available()) return { drafts: [], nextCursor: cursor, skipped: UNAVAILABLE };
		ctx?.report(`Asking the catalogue for the last ${days} days`);
		const r = await this.port.recent(days);
		return { drafts: await this.drafts(r.events), nextCursor: cursor };
	}
}
