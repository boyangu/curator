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
// device may send are the four below, the rest are the server's own. A
// device's 'enrichment' is facts-up (what its Beatport/Traxsource lookups
// found for a card): fill-only, attached to recordings the catalogue already
// has, never an object or an event.
export const CATALOG_INGEST_REASONS = ['library_import', 'playlist_import', 'manual_registration', 'tracker', 'enrichment', 'migration'] as const;
export type CatalogIngestReason = (typeof CATALOG_INGEST_REASONS)[number];
export const CATALOG_CLIENT_REASONS = ['library_import', 'playlist_import', 'manual_registration', 'enrichment'] as const satisfies readonly CatalogIngestReason[];
export type CatalogClientReason = (typeof CATALOG_CLIENT_REASONS)[number];

// What each live kind can be read on (the catalogue's trackers, kind ×
// provider), and which of those only the cloud reads (their keys are the
// cloud's). The user's Refresh menu offers exactly these; a device's worker
// offers its checked ones; the master leases by them. `cloudOnly` sources
// are still the user's to switch off: unchecked means nobody reads it.
// The kinds with trackers of their own (a chart is read through its genre).
export const CATALOG_TRACKING_KINDS = ['artist', 'label', 'playlist', 'genre'] as const satisfies readonly CatalogLiveKind[];
export type CatalogTrackingKind = (typeof CATALOG_TRACKING_KINDS)[number];
export type CatalogTracker = `${CatalogTrackingKind}/${CatalogProvider}`;
export const CATALOG_TRACKERS: readonly { kind: CatalogTrackingKind; provider: CatalogProvider; cloudOnly: boolean }[] = [
	{ kind: 'artist', provider: 'spotify', cloudOnly: false },
	{ kind: 'artist', provider: 'deezer', cloudOnly: false },
	{ kind: 'label', provider: 'spotify', cloudOnly: false },
	{ kind: 'label', provider: 'deezer', cloudOnly: false },
	{ kind: 'label', provider: 'beatport', cloudOnly: false },
	{ kind: 'label', provider: 'bandcamp', cloudOnly: false },
	{ kind: 'label', provider: 'soundcloud', cloudOnly: true },
	{ kind: 'label', provider: 'youtube', cloudOnly: true },
	{ kind: 'playlist', provider: 'spotify', cloudOnly: false },
	{ kind: 'genre', provider: 'beatport', cloudOnly: false },
];
export const trackerKey = (kind: CatalogTrackingKind, provider: CatalogProvider): CatalogTracker => `${kind}/${provider}`;

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
// version than it knows shows nothing for it instead of misreading it. v2
// (2026-11-05) is a strict superset of v1 — the facts a DJ card shows (BPM,
// key, per-track genres, catalogue number, UPC; the label on a track card) —
// so a v2 reader takes stored v1 cards with those facts empty. Events keep
// the card they were raised with; a re-announce rebuilds it at the current
// version.
export const CATALOG_EVENT_CARD_VERSION = 2;
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
// v2 additions. `key` is the catalogue's folded value in the provider's own
// notation ("A Minor", "F♯ min"); a device converts it. `genres` are the
// recording's canonical genre names (Beatport's genre and sub-genre).
export type CatalogEventTrackFactsV2 = { bpm: number | null; key: string | null; genres: string[] };
export type CatalogEventCardV2 = Omit<CatalogEventCardV1, 'version' | 'tracks'> & {
	version: 2;
	catalogNumber: string | null;
	upc: string | null;
	tracks: (CatalogEventCardV1['tracks'][number] & CatalogEventTrackFactsV2)[];
};
export type CatalogEventTrackCardV2 = Omit<CatalogEventTrackCardV1, 'version'> &
	CatalogEventTrackFactsV2 & {
		version: 2;
		// The label of the release the recording sits on, when the catalogue
		// knows one (an entity, or a bare string with id null).
		label: { id: string | null; name: string } | null;
	};
export type CatalogEventCard =
	| CatalogEventCardV1
	| CatalogEventCardV2
	| CatalogEventTrackCardV1
	| CatalogEventTrackCardV2
	| { version: number; kind?: string; title?: string };

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

// ── workers ('catalog_workers') ─────────────────────────────────────────────
//
// A desktop reads the catalogue's providers for the objects its user follows
// and reports each poll; the cloud keeps the cursors, budgets, ingest and
// events, and applies a reported poll exactly as it applies its own. One
// worker per user per week: the first device to ask holds it, a second idles
// (`active: false`), a holder silent for hours or past the week is replaced.
//
// `CatalogTrackerTarget` / `CatalogTrackerPoll` are the reader contract
// (@curator/catalog-readers aliases them): what one poll of one live object
// takes, and what it found.

export type CatalogTrackerTarget = {
	object: { id: string; kind: CatalogKind; name: string };
	// The object's id on this provider; null for a tracker that works by name.
	representation: { providerId: string; url: string | null } | null;
	// What the reader returned as `cursor` last time ({} at first).
	cursor: Record<string, unknown>;
	// Other objects the poll reads through, loaded by the sweep: a label's
	// catalogue playlists for the Spotify label tracker.
	related?: { providerId: string; url: string | null }[];
};

export type CatalogTrackerPoll = {
	// The children found (releases, mostly), as claims.
	children: CatalogClaim[];
	// A digest of the listing: unchanged since the last poll means nothing to
	// ingest, so a quiet artist costs one call and one cursor update.
	listingHash: string;
	cursor: Record<string, unknown>;
	// Provider calls this poll made, against the day's budget.
	calls: number;
	// The tracked object's own current representation (name, image), applied
	// in place: a live object's details are not history.
	self?: CatalogClaim;
	// A chart poll (a genre's top list): per entry, the child (by index into
	// `children`, a release carrying the charted track) and the track's rank.
	chart?: { index: number; rank: number; recording: CatalogRef }[];
	// Uploads (a label's channel or profile): a claim here is attached to the
	// recording it names when the catalogue already knows one, and is
	// otherwise not an object at all but an announcement signal on the
	// tracked object. A premiere video is not a release until a release is.
	tentative?: CatalogClaim[];
	// The children are releases of the tracked label even though no label
	// entity rides on them (a label's catalogue playlist): the sweep ties each
	// to it with a release-label edge.
	labelOf?: boolean;
	// The id the provider's API knows the object by, when the stored
	// representation still carried a slug the poll had to resolve: the sweep
	// re-points the representation before ingesting.
	resolvedId?: string;
};

export type CatalogProviderPause = { provider: CatalogProvider; until: number };

// Every minute while the app runs: the providers this device can read now
// (Spotify only while its login vends), the trackers its user has checked
// (CATALOG_TRACKERS; cloud-only ones included, so the master knows they are
// wanted), the providers it has parked after a rate limit of its own, so the
// master hands it nothing of those, and — on a Refresh — a check: the user's
// follows of that kind (every checked kind without one) on the checked
// sources become due now, read within the hour left alone, and are leased
// by this same call.
export type CatalogWorkerDueInput = {
	deviceId: string;
	providers: CatalogProvider[];
	trackers: CatalogTracker[];
	paused?: CatalogProviderPause[];
	check?: { kind?: CatalogTrackingKind };
};
// Per provider, what became of the cursors a check named: due now (queued),
// due anyway, read within the hour, being read, or on a provider that asked
// the master to wait (`pauses` says until when).
export type CatalogCheckProvider = { provider: CatalogProvider; queued: number; alreadyDue: number; recent: number; reading: number; paused: number };
export type CatalogCheckReport = { queued: number; byProvider: CatalogCheckProvider[]; pauses: CatalogProviderPause[] };
export type CatalogWorkerTask = {
	objectId: string;
	provider: CatalogProvider;
	kind: CatalogKind;
	target: CatalogTrackerTarget;
	// The tracker's pacing between polls of one provider, and the poll's timeout.
	minGapMs: number;
	timeoutMs: number;
};
export type CatalogWorkerDueResult = {
	// False while another device of the account is the week's worker.
	active: boolean;
	weekEndsAt: number;
	// Leased to this device for ten minutes: report them, or they lapse back.
	tasks: CatalogWorkerTask[];
	// Providers paused on the master's side of this device's reads.
	pauses: CatalogProviderPause[];
	// What the call's `check` did, when it carried one.
	check?: CatalogCheckReport;
};
export type CatalogWorkerOutcome = { poll: CatalogTrackerPoll } | { error: { message: string; rateLimitedSec: number | null } };
export type CatalogWorkerReportInput = { deviceId: string; results: { objectId: string; provider: CatalogProvider; outcome: CatalogWorkerOutcome }[] };
// `stale`: results whose lease this device no longer held (lapsed, or a
// resend after a timeout); nothing of theirs was applied.
export type CatalogWorkerReportResult = { applied: number; stale: number; events: number };

export const CATALOG_WORKER_MAX_RESULTS = 100;
// A chart carries 100 entries; a first read of a long listing a few hundred.
const CATALOG_POLL_MAX_CHILDREN = 500;
// The cursor is stored as given (`rememberSeen` keeps 300 ids).
const CATALOG_POLL_MAX_CURSOR_BYTES = 64 * 1024;

const ZRepresentation = z.object({ providerId: z.string().trim().min(1).max(200), url: z.string().max(1000).nullable() }).strict();
const ZCursor = z.record(z.unknown()).refine((c) => JSON.stringify(c).length <= CATALOG_POLL_MAX_CURSOR_BYTES, { message: 'cursor too large' });
export const ZCatalogTrackerTarget: z.ZodType<CatalogTrackerTarget> = z
	.object({
		object: z.object({ id: ZObjectId, kind: ZKind, name: z.string().max(500) }).strict(),
		representation: ZRepresentation.nullable(),
		cursor: ZCursor,
		related: z.array(ZRepresentation).max(100).optional(),
	})
	.strict();
export const ZCatalogTrackerPoll: z.ZodType<CatalogTrackerPoll> = z
	.object({
		children: z.array(ZCatalogClaim).max(CATALOG_POLL_MAX_CHILDREN),
		listingHash: z.string().max(200),
		cursor: ZCursor,
		calls: z.number().int().nonnegative().max(10_000),
		self: ZCatalogClaim.optional(),
		chart: z.array(z.object({ index: z.number().int().nonnegative(), rank: z.number().int().positive(), recording: ZCatalogRef }).strict()).max(CATALOG_POLL_MAX_CHILDREN).optional(),
		tentative: z.array(ZCatalogClaim).max(CATALOG_POLL_MAX_CHILDREN).optional(),
		labelOf: z.boolean().optional(),
		resolvedId: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
const ZPause = z.object({ provider: ZProvider, until: z.number().int().nonnegative() }).strict();
const ZTracker = z.custom<CatalogTracker>((v) => typeof v === 'string' && CATALOG_TRACKERS.some((t) => trackerKey(t.kind, t.provider) === v), { message: 'not a tracker' });
export const ZCatalogWorkerDueInput = z
	.object({
		deviceId: ZDeviceId,
		providers: z.array(ZProvider).max(CATALOG_PROVIDERS.length),
		trackers: z.array(ZTracker).max(CATALOG_TRACKERS.length),
		paused: z.array(ZPause).max(CATALOG_PROVIDERS.length).optional(),
		check: z.object({ kind: z.enum(CATALOG_TRACKING_KINDS).optional() }).strict().optional(),
	})
	.strict();
const ZOutcome: z.ZodType<CatalogWorkerOutcome> = z.union([
	z.object({ poll: ZCatalogTrackerPoll }).strict(),
	z.object({ error: z.object({ message: z.string().max(1000), rateLimitedSec: z.number().int().positive().nullable() }).strict() }).strict(),
]);
export const ZCatalogWorkerReportInput = z
	.object({
		deviceId: ZDeviceId,
		results: z.array(z.object({ objectId: ZObjectId, provider: ZProvider, outcome: ZOutcome }).strict()).max(CATALOG_WORKER_MAX_RESULTS),
	})
	.strict();

// The schemas and the types above must say the same thing.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _claim: Same<z.infer<typeof ZCatalogClaim>, CatalogClaim> = true;
const _ingest: Same<z.infer<typeof ZCatalogIngestInput>, CatalogIngestInput> = true;
const _resolve: Same<z.infer<typeof ZCatalogResolveInput>, CatalogResolveInput> = true;
const _search: Same<z.infer<typeof ZCatalogSearchInput>, CatalogSearchInput> = true;
const _watch: Same<z.infer<typeof ZCatalogWatchInput>, CatalogWatchInput> = true;
const _import: Same<z.infer<typeof ZCatalogImportInput>, CatalogImportInput> = true;
const _events: Same<z.infer<typeof ZFeedEventsInput>, FeedEventsInput> = true;
const _workerDue: Same<z.infer<typeof ZCatalogWorkerDueInput>, CatalogWorkerDueInput> = true;
const _workerReport: Same<z.infer<typeof ZCatalogWorkerReportInput>, CatalogWorkerReportInput> = true;
const _recent: Same<z.infer<typeof ZFeedRecentInput>, FeedRecentInput> = true;
const _browse: Same<z.infer<typeof ZCatalogBrowseInput>, CatalogBrowseInput> = true;
void [_claim, _ingest, _resolve, _search, _watch, _import, _events, _recent, _browse];
