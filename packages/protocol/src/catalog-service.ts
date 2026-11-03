// The Global Catalog ('global_catalog'): Curator's own, provider-independent
// model of the music world, shared by every account (2026-10-26 decision).
//
// Everything enters through one pipeline: a producer (a tracker, a library or
// playlist import, a manual registration) hands the cloud CLAIMS — "provider
// P says object K/id is called N, carries these identifiers and facts, and is
// related to these other objects" — and ingestion resolves each claim against
// the catalogue's own objects, creating only what is missing. Providers never
// own an id here; a Spotify or Deezer id is one representation of a Curator
// object among several.
//
// Two lifetimes:
//   - static objects (recording, release) are created once and enriched
//     once; a provider disagreeing later changes nothing;
//   - live objects (artist, label, playlist, genre, chart) keep producing,
//     and only they are tracked: a tracker reads a watched live object's
//     collection, and a new child becomes a static object and, when it is
//     recent, a catalog EVENT.
// Existence is not tracking: an object a library import created is never
// polled until someone watches it, and imports never raise events.
//
// Devices read events (`feed.events`) and run them through their own feed
// pipeline; the user's decisions stay on the op log. This file is the wire
// contract for that: claim and event shapes, the procedure inputs, results.

import { z } from 'zod';
import { ZDeviceId } from './sync-input.js';

export const CATALOG_KINDS = ['artist', 'label', 'release', 'recording', 'playlist', 'genre', 'chart'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

// Tracked for their collections; the rest are created once.
export const CATALOG_LIVE_KINDS = ['artist', 'label', 'playlist', 'genre', 'chart'] as const satisfies readonly CatalogKind[];
export type CatalogLiveKind = (typeof CATALOG_LIVE_KINDS)[number];
export const isLiveKind = (k: CatalogKind): k is CatalogLiveKind => (CATALOG_LIVE_KINDS as readonly string[]).includes(k);

// Who a representation or fact came from. 'curator' is the catalogue's own
// analysis (desktop analyzers' uploads, phase 2); 'user' a contribution.
export const CATALOG_PROVIDERS = [
	'spotify',
	'deezer',
	'youtube',
	'musicbrainz',
	'discogs',
	'beatport',
	'beatsource',
	'tidal',
	'apple',
	'soundcloud',
	'traxsource',
	'bandcamp',
	// A label's pages the profiler finds (links only; nothing is read there).
	'instagram',
	'website',
	'curator',
	'user',
] as const;
export type CatalogProvider = (typeof CATALOG_PROVIDERS)[number];

// Global identifiers, kept apart from provider representations: an ISRC names
// a recording and a UPC a release whoever reported it.
export const CATALOG_ID_NAMESPACES = ['isrc', 'upc', 'mbid_artist', 'mbid_label', 'mbid_release', 'mbid_recording', 'discogs_artist', 'discogs_label'] as const;
export type CatalogIdNamespace = (typeof CATALOG_ID_NAMESPACES)[number];

// Why a batch of claims arrived. Only trackers raise events; the reasons a
// device may send are the three below, the rest are the server's own.
export const CATALOG_INGEST_REASONS = ['library_import', 'playlist_import', 'manual_registration', 'tracker', 'enrichment', 'migration'] as const;
export type CatalogIngestReason = (typeof CATALOG_INGEST_REASONS)[number];
export const CATALOG_CLIENT_REASONS = ['library_import', 'playlist_import', 'manual_registration'] as const satisfies readonly CatalogIngestReason[];
export type CatalogClientReason = (typeof CATALOG_CLIENT_REASONS)[number];

// Facts a claim may carry. Raw provider values: the catalogue keeps each
// source's value and folds them into the object's current attributes.
export type CatalogFacts = {
	title?: string;
	// ISO date, as precise as the source has it: 2026, 2026-10, 2026-10-23.
	releaseDate?: string;
	// album | single | ep | compilation, as the provider words it.
	releaseType?: string;
	// The label as a bare string (a provider that has no label entity).
	labelText?: string;
	durationSec?: number;
	coverUrl?: string;
	// recording: the release it was found on (a playlist entry names one).
	albumTitle?: string;
	trackCount?: number;
	trackNumber?: number;
	discNumber?: number;
	explicit?: boolean;
	bpm?: number;
	key?: string;
	catalogNumber?: string;
	country?: string;
	// release / recording: the credit as the reader saw it, before any split
	// ("Saints & Sinners"): what the reasoner reads when the pieces look cut.
	creditText?: string;
};

export type CatalogIdentifier = { namespace: CatalogIdNamespace; value: string };

// One provider's statement about one object. Relationships are typed by what
// the claim is: a release names its artists, tracklist and label; a recording
// its artists. Nested claims are resolved like top-level ones.
export type CatalogClaim = {
	provider: CatalogProvider;
	kind: CatalogKind;
	providerId: string;
	url?: string | null;
	name: string;
	identifiers?: CatalogIdentifier[];
	facts?: CatalogFacts;
	// release / recording: the credited artists, main first; label: its
	// roster (the artists signed to it), as the provider lists them.
	artists?: CatalogClaim[];
	// release: the tracklist in order.
	recordings?: CatalogClaim[];
	// release: the label, only when the provider knows it as an entity (with
	// its own id); a bare label string goes in facts.labelText.
	label?: CatalogClaim | null;
	// Raw genre names in the provider's own taxonomy.
	genres?: string[];
	// When the provider published it (a channel upload can precede the
	// release date), epoch ms.
	publishedAt?: number | null;
};

export const CATALOG_MAX_CLAIMS = 200;
export const CATALOG_MAX_NESTED = 100;

const ZProvider = z.enum(CATALOG_PROVIDERS);
const ZKind = z.enum(CATALOG_KINDS);
const ZName = z.string().trim().min(1).max(500);
const ZFacts: z.ZodType<CatalogFacts> = z
	.object({
		title: z.string().max(500).optional(),
		releaseDate: z
			.string()
			.regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
			.optional(),
		releaseType: z.string().max(40).optional(),
		labelText: z.string().max(300).optional(),
		durationSec: z.number().nonnegative().max(24 * 3600).optional(),
		coverUrl: z.string().url().max(1000).optional(),
		albumTitle: z.string().max(500).optional(),
		trackCount: z.number().int().nonnegative().max(10_000).optional(),
		trackNumber: z.number().int().nonnegative().max(10_000).optional(),
		discNumber: z.number().int().nonnegative().max(1000).optional(),
		explicit: z.boolean().optional(),
		bpm: z.number().positive().max(400).optional(),
		key: z.string().max(20).optional(),
		catalogNumber: z.string().max(100).optional(),
		country: z.string().max(10).optional(),
		creditText: z.string().max(500).optional(),
	})
	.strict();

export const ZCatalogClaim: z.ZodType<CatalogClaim> = z.lazy(() =>
	z
		.object({
			provider: ZProvider,
			kind: ZKind,
			providerId: z.string().trim().min(1).max(200),
			url: z.string().url().max(1000).nullable().optional(),
			name: ZName,
			identifiers: z
				.array(z.object({ namespace: z.enum(CATALOG_ID_NAMESPACES), value: z.string().trim().min(1).max(100) }).strict())
				.max(20)
				.optional(),
			facts: ZFacts.optional(),
			artists: z.array(ZCatalogClaim).max(CATALOG_MAX_NESTED).optional(),
			recordings: z.array(ZCatalogClaim).max(CATALOG_MAX_NESTED).optional(),
			label: ZCatalogClaim.nullable().optional(),
			genres: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
			publishedAt: z.number().int().nonnegative().nullable().optional(),
		})
		.strict(),
);

export type CatalogRef = { provider: CatalogProvider; kind: CatalogKind; providerId: string };
export const ZCatalogRef: z.ZodType<CatalogRef> = z.object({ provider: ZProvider, kind: ZKind, providerId: z.string().trim().min(1).max(200) }).strict();

// ── events ──────────────────────────────────────────────────────────────────

// chart_entry: a recording's first appearance on a watched genre's chart.
export const CATALOG_EVENT_KINDS = ['new_release', 'reissue', 'playlist_add', 'chart_entry'] as const;
export type CatalogEventKind = (typeof CATALOG_EVENT_KINDS)[number];

export type CatalogHandle = { provider: CatalogProvider; id: string; url: string | null };

// The card frozen into an event when it is raised: a device renders it as is,
// with no call back to the catalogue. Versioned: a device that meets a newer
// version than it knows shows a generic card instead of misreading it.
export const CATALOG_EVENT_CARD_VERSION = 1;
export type CatalogEventCardV1 = {
	version: 1;
	// A release card; absent on cards raised before track cards existed.
	kind?: 'release';
	title: string;
	artists: { id: string; name: string; handles: CatalogHandle[] }[];
	label: { id: string | null; name: string } | null;
	coverUrl: string | null;
	releaseType: string | null;
	releaseDate: string | null;
	tracks: {
		id: string;
		title: string;
		artists: string[];
		isrc: string | null;
		durationSec: number | null;
		handles: CatalogHandle[];
	}[];
	handles: CatalogHandle[];
	genres: string[];
};
// One track and where it turned up: the playlist it was added to
// (`playlist_add`) or the genre chart it entered (`chart_entry`, with its
// rank). `kind` tells it from a release card of the same version.
export type CatalogEventTrackContainerV1 = { kind: 'playlist' | 'chart'; id: string; name: string; handles: CatalogHandle[] };
export type CatalogEventTrackCardV1 = {
	version: 1;
	kind: 'track';
	title: string;
	artists: { id: string; name: string; handles: CatalogHandle[] }[];
	isrc: string | null;
	durationSec: number | null;
	albumTitle: string | null;
	coverUrl: string | null;
	releaseDate: string | null;
	handles: CatalogHandle[];
	container: CatalogEventTrackContainerV1;
	// Chart position (1 = top); null for a playlist addition.
	rank: number | null;
	addedAt: number | null;
};
export type CatalogEventCard = CatalogEventCardV1 | CatalogEventTrackCardV1 | { version: number; kind?: string; title?: string };

export type CatalogEvent = {
	seq: number;
	kind: CatalogEventKind;
	// The static object the event is about (a release, or a recording for
	// playlist_add).
	subjectId: string;
	// The live objects it concerns that a user can watch (artists, label,
	// playlist): the device files the item under the one it watches.
	subjects: { objectId: string; kind: CatalogKind; name: string }[];
	releaseAt: number | null;
	sourcePublishedAt: number | null;
	firstSeenAt: number;
	// Recordings on the release the catalogue had never seen; 0 marks a
	// reissue or compilation of known tracks.
	recordingsNew: number;
	// How many independent providers reported it, folded to 0..1.
	confidence: number;
	card: CatalogEventCard;
};

// ── watches ─────────────────────────────────────────────────────────────────

export const CATALOG_WATCH_SOURCES = ['manual', 'suggested', 'imported'] as const;
export type CatalogWatchSource = (typeof CATALOG_WATCH_SOURCES)[number];
// A DJ library follows thousands of artists and labels (Guy, 2026-10-27: 2,000
// was filled by one "follow from my library" pass). Tracking cost is per
// distinct object, shared by every watcher, and the provider budgets pace it.
export const CATALOG_MAX_WATCHES = 20_000;

export type CatalogObjectSummary = {
	id: string;
	kind: CatalogKind;
	name: string;
	handles: CatalogHandle[];
	coverUrl: string | null;
	watchCount: number;
};

export type CatalogWatch = {
	object: CatalogObjectSummary;
	source: CatalogWatchSource;
	muted: boolean;
	createdAt: number;
	// One per active tracker on the object.
	tracking: { provider: CatalogProvider; lastRunAt: number | null; nextDueAt: number | null; failing: boolean }[];
};

// ── procedure inputs and results ────────────────────────────────────────────

export type CatalogIngestInput = { deviceId: string; reason: CatalogClientReason; idempotencyKey: string; claims: unknown[] };
export type CatalogIngestResult = {
	// Per claim, in order: the catalogue object it resolved to, or the reason
	// it was refused.
	results: ({ objectId: string; created: boolean } | { rejected: string })[];
	created: number;
	attached: number;
	// A repeat of an idempotency key already ingested: nothing was redone.
	duplicate: boolean;
};

export type CatalogResolveInput = { deviceId: string; refs: CatalogRef[] };
export type CatalogResolveResult = { objects: (CatalogObjectSummary | null)[] };

export type CatalogSearchInput = { deviceId: string; q: string; kind?: CatalogKind; limit?: number };
export type CatalogSearchResult = { objects: CatalogObjectSummary[] };

// catalog.browse: an object with what hangs off it — a label's or an
// artist's releases, a release's tracks — each row with its store handles,
// so a device can show and play them without a call per row.
export type CatalogBrowseInput = { deviceId: string; id: string };
export type CatalogBrowseRef = { id: string; name: string };
export type CatalogBrowseRelease = {
	id: string;
	title: string;
	date: string | null;
	type: string | null;
	labelText: string | null;
	artists: CatalogBrowseRef[];
	labels: CatalogBrowseRef[];
	trackCount: number;
	handles: CatalogHandle[];
};
export type CatalogBrowseTrack = {
	id: string;
	title: string;
	position: number | null;
	durationSec: number | null;
	isrc: string | null;
	artists: CatalogBrowseRef[];
	handles: CatalogHandle[];
};
export type CatalogBrowseResult = {
	object: CatalogObjectSummary;
	// Set when the id asked for was merged away: the result is the winner's.
	redirectedFrom: string | null;
	// label / artist / recording: newest first (at most CATALOG_BROWSE_MAX).
	releases?: CatalogBrowseRelease[];
	releaseCount?: number;
	// release: by position.
	tracks?: CatalogBrowseTrack[];
	release?: { date: string | null; type: string | null; labelText: string | null };
	// label: who releases on it, by count; release / recording: its credits.
	artists?: (CatalogBrowseRef & { releases?: number; role?: string | null })[];
	// artist: the labels it releases on, by count; release: its labels.
	labels?: (CatalogBrowseRef & { releases: number })[];
	// label: the roster its own page lists.
	roster?: CatalogBrowseRef[];
};
export const CATALOG_BROWSE_MAX = 500;

export type CatalogGetInput = { deviceId: string; id: string };
export type CatalogObjectDetail = CatalogObjectSummary & {
	attrs: Record<string, unknown>;
	identifiers: CatalogIdentifier[];
	discoveredAt: number;
	mergedInto: string | null;
};

// `objectId` for an object the device found through search; `claim` for one
// it found at a provider (a pasted URL): the claim is ingested first.
export type CatalogWatchInput = { deviceId: string; objectId?: string; claim?: unknown; source: CatalogWatchSource };
export type CatalogWatchResult = { watch: CatalogWatch; recent: CatalogEvent[] };
export type CatalogUnwatchInput = { deviceId: string; objectId: string };
export type CatalogMuteInput = { deviceId: string; objectId: string; muted: boolean };
export type CatalogListWatchesInput = { deviceId: string };
export type CatalogImportInput = { deviceId: string; idempotencyKey: string; source: CatalogWatchSource; claims: unknown[] };
export type CatalogImportResult = { created: number; existing: number; watched: number; rejected: number; duplicate: boolean };
export type CatalogRefreshInput = { deviceId: string; objectId: string };
export type CatalogRefreshResult = { dueAt: number | null };
// catalog.enrich: ask the catalogue to profile these labels (their pages
// elsewhere) and read their releases once, with no watch and no events —
// a device filling the shared catalogue with the labels its library holds.
export type CatalogEnrichInput = { deviceId: string; objectIds: string[] };
export type CatalogEnrichResult = { queued: number };

export type FeedEventsInput = { deviceId: string; afterSeq: number; limit?: number };
export type FeedEventsResult = { events: CatalogEvent[]; nextSeq: number };
// "Load more": the caller's watched objects' events of the last `days`,
// whatever their seq (a device's cursor is past them). Newest first.
export type FeedRecentInput = { deviceId: string; days: number };
export type FeedRecentResult = { events: CatalogEvent[] };
export const FEED_RECENT_MAX_DAYS = 60;
export const FEED_EVENTS_MAX = 200;
export const CATALOG_RECENT_DAYS = 30;

const ZIdempotencyKey = z.string().trim().min(8).max(128);
const ZObjectId = z.string().uuid();
const ZSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ZCatalogIngestInput = z
	.object({ deviceId: ZDeviceId, reason: z.enum(CATALOG_CLIENT_REASONS), idempotencyKey: ZIdempotencyKey, claims: z.array(z.unknown()) })
	.strict();
export const ZCatalogResolveInput = z.object({ deviceId: ZDeviceId, refs: z.array(ZCatalogRef).min(1).max(50) }).strict();
export const ZCatalogSearchInput = z
	.object({ deviceId: ZDeviceId, q: z.string().trim().min(1).max(200), kind: ZKind.optional(), limit: z.number().int().min(1).max(25).optional() })
	.strict();
export const ZCatalogGetInput = z.object({ deviceId: ZDeviceId, id: ZObjectId }).strict();
export const ZCatalogBrowseInput = z.object({ deviceId: ZDeviceId, id: ZObjectId }).strict();
export const ZCatalogWatchInput = z
	.object({ deviceId: ZDeviceId, objectId: ZObjectId.optional(), claim: z.unknown().optional(), source: z.enum(CATALOG_WATCH_SOURCES) })
	.strict()
	.refine((v) => (v.objectId === undefined) !== (v.claim === undefined), { message: 'exactly one of objectId and claim' });
export const ZCatalogUnwatchInput = z.object({ deviceId: ZDeviceId, objectId: ZObjectId }).strict();
export const ZCatalogMuteInput = z.object({ deviceId: ZDeviceId, objectId: ZObjectId, muted: z.boolean() }).strict();
export const ZCatalogListWatchesInput = z.object({ deviceId: ZDeviceId }).strict();
export const ZCatalogImportInput = z
	.object({ deviceId: ZDeviceId, idempotencyKey: ZIdempotencyKey, source: z.enum(CATALOG_WATCH_SOURCES), claims: z.array(z.unknown()) })
	.strict();
export const ZCatalogRefreshInput = z.object({ deviceId: ZDeviceId, objectId: ZObjectId }).strict();
export const ZCatalogEnrichInput = z.object({ deviceId: ZDeviceId, objectIds: z.array(ZObjectId).min(1).max(200) }).strict();
export const ZFeedEventsInput = z.object({ deviceId: ZDeviceId, afterSeq: ZSeq, limit: z.number().int().min(1).optional() }).strict();
export const ZFeedRecentInput = z.object({ deviceId: ZDeviceId, days: z.number().int().min(1).max(FEED_RECENT_MAX_DAYS) }).strict();

// The schemas and the types above must say the same thing.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _claim: Same<z.infer<typeof ZCatalogClaim>, CatalogClaim> = true;
const _ingest: Same<z.infer<typeof ZCatalogIngestInput>, CatalogIngestInput> = true;
const _resolve: Same<z.infer<typeof ZCatalogResolveInput>, CatalogResolveInput> = true;
const _search: Same<z.infer<typeof ZCatalogSearchInput>, CatalogSearchInput> = true;
const _watch: Same<z.infer<typeof ZCatalogWatchInput>, CatalogWatchInput> = true;
const _import: Same<z.infer<typeof ZCatalogImportInput>, CatalogImportInput> = true;
const _events: Same<z.infer<typeof ZFeedEventsInput>, FeedEventsInput> = true;
const _recent: Same<z.infer<typeof ZFeedRecentInput>, FeedRecentInput> = true;
const _browse: Same<z.infer<typeof ZCatalogBrowseInput>, CatalogBrowseInput> = true;
void [_claim, _ingest, _resolve, _search, _watch, _import, _events, _recent, _browse];
