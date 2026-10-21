// The op: one immutable row per library change (design: "The op", the
// entity × kinds × merge-rule table, "Schema versioning"). Every payload here
// is the zod definition desktop, cloud and phone validate against; the server
// rejects what fails it before any write.
//
// Payload keys are snake_case on the wire like the envelope. Ops never carry
// device-local track ids (tracks are addressed by `recording_id`), tokens,
// file paths or audio.

import { z } from 'zod';
import { isValidOrderKey } from './order-key.js';
import { isRbGridValue } from './rb-grid.js';

// Version 2 (2026-10-18) is additive: `library_track.set-state` and the
// `artist_alias` entity. Nothing in v1 changed shape, so the minimum stays 1
// and every v1 kind is still stamped 1 (`opSchemaVersion`): a v1 client keeps
// applying everything it can read and holds (design: `sync_inbox_held`) only
// at the first op of a kind it does not know, instead of at every op a v2
// device writes.
//
// Version 3 (2026-10-20) is additive too: `library_track.set-meta` (a
// device's base metadata for a recording, so a device without the track can
// show it) and the account setting `library.master_device` (whose meta wins).
// A v2 client holds both aside instead of stopping at them; a v2 server
// refuses them, so a desktop emits either only when the server advertises
// 'track_meta' (cloud-service.ts SYNC_FEATURES).
export const SCHEMA_VERSION = 3;
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

export const MAX_OP_PAYLOAD_BYTES = 16 * 1024;
export const MAX_PUSH_OPS = 500;
export const MAX_PUSH_BYTES = 1024 * 1024;
export const MAX_PULL_OPS = 1000;

export const ENTITIES = [
	'tag',
	'track_tag',
	'playlist',
	'playlist_folder',
	'playlist_track',
	'library_track',
	'cue',
	'play_session',
	'play_event',
	'pinned_search',
	'setting',
	'recording_claim',
	'recording',
	'upstream',
	'artist_alias',
] as const;
export type Entity = (typeof ENTITIES)[number];

// ── shared value shapes ─────────────────────────────────────────────────────

// Entity ids are UUIDs for most entities, but the system tags ('interested',
// 'basket') and setting keys are not, so the envelope demands only a
// non-empty string; composite ids are checked per entity below.
const ZId = z.string().min(1);
const ZUuid = z.string().uuid();
const ZMs = z.number().int().nonnegative();
const ZOrderKey = z.string().refine(isValidOrderKey, { message: 'invalid order key' });

// Wire-safe JSON: no `undefined`, no functions, no cycles.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const ZJsonValue: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(ZJsonValue), z.record(ZJsonValue)]),
);

export const TAG_KINDS = ['system', 'user'] as const;
export const PLAYLIST_SOURCES = ['spotify', 'tidal', 'rekordbox', 'local'] as const;
export const CUE_KINDS = ['hot', 'memory'] as const;
export type CueKind = (typeof CUE_KINDS)[number];
export const RB_ANALYSIS_UNITS = ['grid', 'key', 'segments'] as const;
export const CLAIM_KINDS = ['isrc', 'audio_hash', 'fingerprint', 'spotify', 'tidal', 'beatport'] as const;
export const UPSTREAM_PROVIDERS = ['spotify', 'tidal', 'rekordbox'] as const;
export const UPSTREAM_STATUSES = ['pushed', 'failed', 'skipped'] as const;
export const PLAY_SESSION_ORIGINS = ['curator', 'rekordbox'] as const;
export const PLAY_SESSION_KINDS = ['set', 'prep', 'unknown'] as const;
export const PLAY_SOURCES = ['local', 'spotify', 'rekordbox'] as const;
export const PLAY_ENDED_REASONS = ['ended', 'replaced', 'stopped', 'queue_end', 'interrupted'] as const;
// The curation stage (`track.state`). Mirrors TRACK_STATES in
// @curator/shared/enums, which this package may not import; the desktop's
// rows.ts pins the two lists equal at compile time.
export const TRACK_STATES = ['unsorted', 'feed', 'backlog', 'progress', 'purchased'] as const;
export type TrackStateValue = (typeof TRACK_STATES)[number];

// Which `playlist` / `playlist_folder` row this is on the provider side.
export const ZSourceLink = z
	.object({
		source: z.enum(PLAYLIST_SOURCES),
		source_id: z.string().min(1),
		url: z.string().nullable().optional(),
	})
	.strict();
export type SourceLink = z.infer<typeof ZSourceLink>;

export const ZTrackArtist = z
	.object({
		name: z.string().min(1),
		role: z.enum(['main', 'featured', 'remixer']).optional(),
	})
	.strict();

// Account-level settings only (design: "Which settings sync"). Per-device
// keys — the per-origin write-sync toggles (`sourceSync.*`, the 2026-09
// incident), `wav.output_dir`, `library.id`, `device.id`, backup run stamps,
// migration gates — must never ride an op, so the key is validated here and
// the list is the allow-list, not a deny-list.
export const ACCOUNT_SETTING_KEYS = ['credit_format', 'mir.settings', 'backup.settings', 'artist_merge_dismissed', 'library.master_device'] as const;
export function isAccountSettingKey(key: string): boolean {
	return (ACCOUNT_SETTING_KEYS as readonly string[]).includes(key);
}

// The device whose `set-meta` wins wherever it holds the recording (decided
// 2026-10-20: the master seeds every other device). Its value is a device id;
// the first device to link the library states it, Settings → Account
// changes it. Since v3 (SETTING_KEY_SINCE below).
export const MASTER_DEVICE_SETTING = 'library.master_device';

// ── composite entity ids ────────────────────────────────────────────────────
// `track_tag` is keyed by recording + tag and `cue` by recording + slot + kind;
// their `entity_id` is the parts joined with ':'. Recording ids are UUIDs so
// the first ':' always ends the recording part.

export function trackTagEntityId(recordingId: string, tagId: string): string {
	return `${recordingId}:${tagId}`;
}

export function parseTrackTagEntityId(id: string): { recordingId: string; tagId: string } | null {
	const i = id.indexOf(':');
	if (i <= 0 || i === id.length - 1) return null;
	return { recordingId: id.slice(0, i), tagId: id.slice(i + 1) };
}

export function cueEntityId(recordingId: string, slot: number, kind: CueKind): string {
	return `${recordingId}:${slot}:${kind}`;
}

export function parseCueEntityId(id: string): { recordingId: string; slot: number; kind: CueKind } | null {
	const parts = id.split(':');
	if (parts.length !== 3) return null;
	const [recordingId, slotRaw, kind] = parts as [string, string, string];
	const slot = Number(slotRaw);
	if (!recordingId || !/^\d+$/.test(slotRaw) || !Number.isInteger(slot)) return null;
	if (!(CUE_KINDS as readonly string[]).includes(kind)) return null;
	return { recordingId, slot, kind: kind as CueKind };
}

// ── envelope ────────────────────────────────────────────────────────────────

const ZEnvelope = z.object({
	op_id: ZUuid,
	device_id: z.string().min(1),
	client_ts: ZMs,
	schema_version: z.number().int().positive(),
	entity_id: ZId,
});

function defineOp<E extends Entity, K extends string, P extends z.ZodTypeAny>(entity: E, kind: K, payload: P) {
	return ZEnvelope.extend({ entity: z.literal(entity), kind: z.literal(kind), payload }).strict();
}

const empty = () => z.object({}).strict();

// ── tag ─────────────────────────────────────────────────────────────────────

export const ZTagCreate = defineOp(
	'tag',
	'create',
	z
		.object({
			name: z.string().min(1),
			kind: z.enum(TAG_KINDS),
			color: z.string().nullable().optional(),
		})
		.strict(),
);
export const ZTagRename = defineOp('tag', 'rename', z.object({ name: z.string().min(1) }).strict());
export const ZTagSetColour = defineOp('tag', 'set-colour', z.object({ color: z.string().nullable() }).strict());
export const ZTagDelete = defineOp('tag', 'delete', empty());

// ── track_tag ───────────────────────────────────────────────────────────────

const trackTagId = { message: 'entity_id must be `${recordingId}:${tagId}`' };
export const ZTrackTagAdd = defineOp('track_tag', 'add', empty()).refine((o) => parseTrackTagEntityId(o.entity_id) !== null, trackTagId);
export const ZTrackTagRemove = defineOp('track_tag', 'remove', empty()).refine((o) => parseTrackTagEntityId(o.entity_id) !== null, trackTagId);

// ── playlist ────────────────────────────────────────────────────────────────

export const ZPlaylistCreate = defineOp(
	'playlist',
	'create',
	z
		.object({
			name: z.string().min(1),
			folder_id: z.string().nullable().optional(),
			source_link: ZSourceLink.nullable().optional(),
		})
		.strict(),
);
export const ZPlaylistRename = defineOp('playlist', 'rename', z.object({ name: z.string().min(1) }).strict());
export const ZPlaylistMoveToFolder = defineOp('playlist', 'move-to-folder', z.object({ folder_id: z.string().nullable() }).strict());
export const ZPlaylistSetSourceLink = defineOp('playlist', 'set-source-link', z.object({ source_link: ZSourceLink.nullable() }).strict());
// Not in the design's table; the plan's B4 mutator list has
// `setPlaylistFavorite` and `is_favorite` lives on `playlist` today.
export const ZPlaylistSetFavourite = defineOp('playlist', 'set-favourite', z.object({ favourite: z.boolean() }).strict());
export const ZPlaylistDelete = defineOp('playlist', 'delete', empty());

// ── playlist_folder ─────────────────────────────────────────────────────────

export const ZPlaylistFolderCreate = defineOp(
	'playlist_folder',
	'create',
	z
		.object({
			name: z.string().min(1),
			parent_folder_id: z.string().nullable().optional(),
			source_link: ZSourceLink.nullable().optional(),
		})
		.strict(),
);
export const ZPlaylistFolderRename = defineOp('playlist_folder', 'rename', z.object({ name: z.string().min(1) }).strict());
export const ZPlaylistFolderMoveToFolder = defineOp('playlist_folder', 'move-to-folder', z.object({ parent_folder_id: z.string().nullable() }).strict());
export const ZPlaylistFolderSetSourceLink = defineOp('playlist_folder', 'set-source-link', z.object({ source_link: ZSourceLink.nullable() }).strict());
export const ZPlaylistFolderDelete = defineOp('playlist_folder', 'delete', empty());

// ── playlist_track ──────────────────────────────────────────────────────────
// `entity_id` is the membership row id. The add's `client_ts` doubles as the
// row's `added_at`, so the payload carries none.

export const ZPlaylistTrackAdd = defineOp(
	'playlist_track',
	'add',
	z
		.object({
			playlist_id: ZId,
			recording_id: ZId,
			order_key: ZOrderKey,
		})
		.strict(),
);
export const ZPlaylistTrackMove = defineOp('playlist_track', 'move', z.object({ order_key: ZOrderKey }).strict());
export const ZPlaylistTrackRemove = defineOp('playlist_track', 'remove', empty());
// The one playlist_track op addressed to the playlist, not a row: it carries
// fresh keys for rows of that playlist (`rebalance`). Partial maps are legal
// so a large playlist can be rekeyed in several ops under the payload cap;
// each row's key is LWW on its own.
export const ZPlaylistTrackRekey = defineOp(
	'playlist_track',
	'rekey',
	z
		.object({
			keys: z.record(ZId, ZOrderKey).refine((m) => Object.keys(m).length > 0, { message: 'keys must not be empty' }),
		})
		.strict(),
);

// ── library_track ───────────────────────────────────────────────────────────
// `entity_id` is the recording id.

// Not in the design's table; the plan's B4 has the scanner and the streaming
// upserts emit "`library_track` create plus claims" for a new recording. The
// row's existence is the payload; metadata comes from the catalogue.
export const ZLibraryTrackCreate = defineOp('library_track', 'create', z.object({ added_at: ZMs.optional() }).strict());
export const ZLibraryTrackSetRating = defineOp('library_track', 'set-rating', z.object({ rating: z.number().int().min(0).max(5).nullable() }).strict());
export const ZLibraryTrackSetFavourite = defineOp('library_track', 'set-favourite', z.object({ favourite: z.boolean() }).strict());
// Since v2. Per-field LWW like the rating. A row's creation carries no
// state: no `state` cell means the schema default ('unsorted'), which every
// device already gives a new row, so only a change away from it is an op.
export const ZLibraryTrackSetState = defineOp('library_track', 'set-state', z.object({ state: z.enum(TRACK_STATES) }).strict());

// Since v3. The base metadata ONE device holds for the recording — its own
// row's catalogue columns as its source spelled them, before any override
// (overrides stay their own fields and win on read everywhere) and before
// any artist alias rule (`artists` are the source credits, so every device
// maps them through the converged rules itself). What lets a device that
// holds no row of the recording show it (the desktop's remote rows, the
// phone).
//
// The reducer files it under `meta.<device_id>`: the envelope already names
// the device and the server refuses an op whose device is not the pusher's
// (`not_owner`), so the cell key cannot be spoofed and the payload does not
// repeat it. Each device's cell is LWW on its own; which device's cell the
// view shows is `resolveTrackMeta` (state.ts): the master's when it has one,
// else the best source among the rest. `source` is where this device's row
// came from (its local file, else its streaming link), kept for that
// tie-break and for provenance.
export const TRACK_META_SOURCES = ['local', 'spotify', 'tidal', 'other'] as const;
export type TrackMetaSource = (typeof TRACK_META_SOURCES)[number];
const ZCount = z.number().int().nonnegative();
export const ZTrackMeta = z
	.object({
		source: z.enum(TRACK_META_SOURCES),
		title: z.string(),
		artists: z.array(ZTrackArtist),
		album_title: z.string().nullable(),
		duration_sec: ZCount.nullable(),
		isrc: z.string().nullable(),
		release_date: z.string().nullable(),
		label: z.string().nullable(),
		genre: z.string().nullable(),
		// A remote image only: a local path or data: URL means nothing on
		// another device.
		cover_url: z.string().max(2048).regex(/^https?:\/\//i, { message: 'cover_url must be http(s)' }).nullable(),
		track_number: ZCount.nullable().optional(),
		disc_number: ZCount.nullable().optional(),
	})
	.strict();
export type TrackMeta = z.infer<typeof ZTrackMeta>;
export const ZLibraryTrackSetMeta = defineOp('library_track', 'set-meta', ZTrackMeta);

// One override field per op so each is its own LWW field. `null` clears it.
export const ZOverrideField = z.discriminatedUnion('field', [
	z.object({ field: z.literal('title'), value: z.string().nullable() }).strict(),
	z.object({ field: z.literal('artists'), value: z.array(ZTrackArtist).nullable() }).strict(),
	z.object({ field: z.literal('album_title'), value: z.string().nullable() }).strict(),
	z.object({ field: z.literal('label'), value: z.string().nullable() }).strict(),
	z.object({ field: z.literal('genre'), value: z.string().nullable() }).strict(),
	z.object({ field: z.literal('bpm'), value: z.number().nullable() }).strict(),
	z.object({ field: z.literal('key_camelot'), value: z.string().nullable() }).strict(),
	z.object({ field: z.literal('release_date'), value: z.string().nullable() }).strict(),
]);
export const OVERRIDE_FIELDS = ['title', 'artists', 'album_title', 'label', 'genre', 'bpm', 'key_camelot', 'release_date'] as const;
export const ZLibraryTrackSetOverride = defineOp('library_track', 'set-override', ZOverrideField);

// Each rekordbox unit is one LWW field. `null` clears it. The grid is the
// compact integer form in rb-grid.ts (beats AND downbeats, whole ms,
// second-differenced) — fixed 2026-10-20 before anything emitted the unit,
// so the array-of-numbers shape is unchanged and only its reading is new;
// the refine rejects anything else. Segments pass through as the importer's
// `SegmentRecord` rows; the key is rekordbox's Camelot key. A unit whose op
// would exceed MAX_OP_PAYLOAD_BYTES (a recorded mix's grid) is not emitted
// and stays device-local.
export const ZRbAnalysisUnit = z.discriminatedUnion('unit', [
	z.object({ unit: z.literal('grid'), value: z.array(z.number()).refine(isRbGridValue, { message: 'not an rb grid (rb-grid.ts)' }).nullable() }).strict(),
	z.object({ unit: z.literal('key'), value: z.string().nullable() }).strict(),
	z.object({ unit: z.literal('segments'), value: z.array(z.record(ZJsonValue)).nullable() }).strict(),
]);
export const ZLibraryTrackSetRbAnalysis = defineOp('library_track', 'set-rb-analysis', ZRbAnalysisUnit);
export const ZLibraryTrackDelete = defineOp('library_track', 'delete', empty());
export const ZLibraryTrackUndelete = defineOp('library_track', 'undelete', empty());

// ── cue ─────────────────────────────────────────────────────────────────────
// `entity_id` is `${recordingId}:${slot}:${kind}`; the upsert repeats slot and
// kind so the payload is self-describing, and the two must agree.

export const ZCueBody = z
	.object({
		slot: z.number().int().nonnegative(),
		kind: z.enum(CUE_KINDS),
		position_sec: z.number().nonnegative(),
		length_sec: z.number().nonnegative().nullable(),
		color: z.string().nullable(),
		name: z.string().nullable(),
	})
	.strict();
const cueId = { message: 'entity_id must be `${recordingId}:${slot}:${kind}`' };
export const ZCueUpsert = defineOp('cue', 'upsert', ZCueBody).refine((o) => {
	const id = parseCueEntityId(o.entity_id);
	return id !== null && id.slot === o.payload.slot && id.kind === o.payload.kind;
}, cueId);
export const ZCueDelete = defineOp('cue', 'delete', empty()).refine((o) => parseCueEntityId(o.entity_id) !== null, cueId);

// ── play_session / play_event ───────────────────────────────────────────────

export const ZPlaySessionAppend = defineOp(
	'play_session',
	'append',
	z
		.object({
			origin: z.enum(PLAY_SESSION_ORIGINS),
			kind: z.enum(PLAY_SESSION_KINDS),
			kind_source: z.enum(['auto', 'user']),
			name: z.string().nullable(),
			started_at: ZMs,
			ended_at: ZMs.nullable(),
			// djmdHistory.ID of an imported rekordbox session; lets a second
			// desktop importing the same USB history dedupe by it.
			rb_history_id: z.string().nullable(),
		})
		.strict(),
);
// Not in the design's table; the plan's B4 has `setSessionKind` (the user
// reclassifying a session as set/prep), which is a per-field LWW write.
export const ZPlaySessionSetKind = defineOp('play_session', 'set-kind', z.object({ kind: z.enum(['set', 'prep']) }).strict());

export const ZPlayEventAppend = defineOp(
	'play_event',
	'append',
	z
		.object({
			session_id: ZId,
			// Null for plays with no library identity (feed previews).
			recording_id: ZId.nullable(),
			source: z.enum(PLAY_SOURCES),
			played_at: ZMs.nullable(),
			played_ms: z.number().int().nonnegative().nullable(),
			duration_ms: z.number().int().nonnegative().nullable(),
			max_position_ms: z.number().int().nonnegative().nullable(),
			played75: z.boolean().nullable(),
			ended_reason: z.enum(PLAY_ENDED_REASONS).nullable(),
			context_type: z.string().nullable(),
			context_id: z.string().nullable(),
			track_no: z.number().int().nullable(),
			rb_song_history_id: z.string().nullable(),
		})
		.strict(),
);

// ── pinned_search ───────────────────────────────────────────────────────────

const ZSortDir = z.enum(['asc', 'desc']);
export const ZPinnedSearchCreate = defineOp(
	'pinned_search',
	'create',
	z
		.object({
			name: z.string().min(1),
			query: z.string(),
			sort_column: z.string().nullable().optional(),
			sort_dir: ZSortDir.nullable().optional(),
		})
		.strict(),
);
export const ZPinnedSearchRename = defineOp('pinned_search', 'rename', z.object({ name: z.string().min(1) }).strict());
export const ZPinnedSearchSetQuery = defineOp(
	'pinned_search',
	'set-query',
	z
		.object({
			query: z.string(),
			sort_column: z.string().nullable().optional(),
			sort_dir: ZSortDir.nullable().optional(),
		})
		.strict(),
);
export const ZPinnedSearchDelete = defineOp('pinned_search', 'delete', empty());

// ── setting ─────────────────────────────────────────────────────────────────
// `entity_id` is the key.

export const ZSettingSet = defineOp('setting', 'set', z.object({ value: ZJsonValue }).strict()).refine((o) => isAccountSettingKey(o.entity_id), {
	message: 'setting key is not account-level',
});

// ── recording_claim ─────────────────────────────────────────────────────────
// `entity_id` is the recording id. Append-only; the catalogue resolver reads
// them. Fingerprints carry the window length they were computed over.

export const ZRecordingClaimAdd = defineOp(
	'recording_claim',
	'add',
	z
		.object({
			kind: z.enum(CLAIM_KINDS),
			value: z.string().min(1),
			confidence: z.number().min(0).max(1),
			duration_sec: z.number().int().nonnegative().optional(),
		})
		.strict(),
);

// ── recording ───────────────────────────────────────────────────────────────
// `entity_id` is the loser. `split` is P2 and manual: it withdraws the alias
// (LWW against the merge per loser); the rows the user moves back travel as
// ordinary ops addressed to the restored recording.

const notSelf = { message: 'winner must differ from the loser (entity_id)' };
export const ZRecordingMerge = defineOp('recording', 'merge', z.object({ winner: ZId }).strict()).refine((o) => o.payload.winner !== o.entity_id, notSelf);
export const ZRecordingSplit = defineOp('recording', 'split', z.object({ winner: ZId }).strict()).refine((o) => o.payload.winner !== o.entity_id, notSelf);

// ── upstream ────────────────────────────────────────────────────────────────
// `entity_id` is the `op_id` of the op that implied the external write (F23).

export const ZUpstreamAck = defineOp(
	'upstream',
	'ack',
	z
		.object({
			provider: z.enum(UPSTREAM_PROVIDERS),
			status: z.enum(UPSTREAM_STATUSES),
			error: z.string().nullable().optional(),
		})
		.strict(),
);

// ── artist_alias ────────────────────────────────────────────────────────────
// Since v2. An artist-level spelling rule (design open question "Artists",
// decided 2026-10-18: artist-level, not per-track): every credit whose
// artist key is `entity_id` is written `to`. `entity_id` is the FROM name's
// artist key (@curator/shared `artistKey`: searchFold minus spaces and
// punctuation), so two devices renaming the same artist address one record.
// `to_key` is the key of `to`, computed by the writer like `entity_id`: it
// lets the reducer resolve chains (A→B, B→C) without a fold function of its
// own, so convergence never depends on which client version folds. A rule
// whose `to_key` equals its `entity_id` is a spelling rule (a rename that
// keeps the key, "Ben Bohmer" → "Ben Böhmer"); it ends a chain.
//
// Per-key LWW: the later of set/remove wins. A client's credits are a
// function of the resolved rules and the credits as their source spelled
// them, never of the order rules arrived in: when a key's resolution changes
// (a later rule winning it, a cycle dropping one, a remove) the credits it
// mapped are re-derived. So a removed rule stops applying to existing
// credits as well as new ones; a device that saw the rule and its remove in
// one pull never rewrote anything, and every device must end where it does.
//
// Keys are only as stable as the fold rules: a FOLD_VERSION bump that moves
// a name to a new key leaves rules keyed the old way unmatched for it.

export const ZArtistAliasSet = defineOp(
	'artist_alias',
	'set',
	z
		.object({
			from: z.string().min(1),
			to: z.string().min(1),
			to_key: z.string().min(1),
		})
		.strict(),
);
export const ZArtistAliasRemove = defineOp('artist_alias', 'remove', empty());

// ── the union ───────────────────────────────────────────────────────────────

export const OP_SCHEMAS = [
	ZTagCreate,
	ZTagRename,
	ZTagSetColour,
	ZTagDelete,
	ZTrackTagAdd,
	ZTrackTagRemove,
	ZPlaylistCreate,
	ZPlaylistRename,
	ZPlaylistMoveToFolder,
	ZPlaylistSetSourceLink,
	ZPlaylistSetFavourite,
	ZPlaylistDelete,
	ZPlaylistFolderCreate,
	ZPlaylistFolderRename,
	ZPlaylistFolderMoveToFolder,
	ZPlaylistFolderSetSourceLink,
	ZPlaylistFolderDelete,
	ZPlaylistTrackAdd,
	ZPlaylistTrackMove,
	ZPlaylistTrackRemove,
	ZPlaylistTrackRekey,
	ZLibraryTrackCreate,
	ZLibraryTrackSetRating,
	ZLibraryTrackSetFavourite,
	ZLibraryTrackSetState,
	ZLibraryTrackSetMeta,
	ZLibraryTrackSetOverride,
	ZLibraryTrackSetRbAnalysis,
	ZLibraryTrackDelete,
	ZLibraryTrackUndelete,
	ZCueUpsert,
	ZCueDelete,
	ZPlaySessionAppend,
	ZPlaySessionSetKind,
	ZPlayEventAppend,
	ZPinnedSearchCreate,
	ZPinnedSearchRename,
	ZPinnedSearchSetQuery,
	ZPinnedSearchDelete,
	ZSettingSet,
	ZRecordingClaimAdd,
	ZRecordingMerge,
	ZRecordingSplit,
	ZUpstreamAck,
	ZArtistAliasSet,
	ZArtistAliasRemove,
] as const;

// zod 3 cannot nest a discriminated union on `kind` inside one on `entity`
// (options must be plain objects), so the union is flat; `parseOp` below
// looks the schema up by (entity, kind) instead of trying every one, which is
// also what gives it a precise error.
export const ZOp = z.union(OP_SCHEMAS);
export type Op = z.infer<typeof ZOp>;

export type OpOf<E extends Entity, K extends string = string> = Extract<Op, { entity: E; kind: K }>;
export type KindOf<E extends Entity> = OpOf<E>['kind'];
// `K extends string`, not `KindOf<E>`: a generic caller (`K extends KindOf<E>`)
// cannot be proven to satisfy the narrower constraint, and a wrong kind still
// resolves to `never` here.
export type PayloadOf<E extends Entity, K extends string> = OpOf<E, K>['payload'];

// An op before the envelope is stamped: what a mutator hands to `emitOps`.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type NewOp = DistributiveOmit<Op, 'op_id' | 'device_id' | 'client_ts' | 'schema_version'>;

export type OpEnvelope = z.infer<typeof ZEnvelope> & { entity: Entity; kind: string; payload: unknown };

// ── parsing ─────────────────────────────────────────────────────────────────

// Why a push (or a parse) refused an op. Only the first six come out of
// `parseOp`; the rest are the server's.
export type RejectReason =
	| 'malformed'
	| 'unknown_entity'
	| 'unknown_kind'
	| 'invalid_payload'
	| 'payload_too_large'
	| 'update_required'
	| 'not_owner'
	| 'device_revoked';

export class OpValidationError extends Error {
	override readonly name = 'OpValidationError';
	constructor(
		readonly reason: RejectReason,
		readonly entity: string | null,
		readonly kind: string | null,
		readonly issues: z.ZodIssue[] = [],
		readonly opId: string | null = null,
	) {
		super(
			`${reason}: ${entity ?? '?'}.${kind ?? '?'}${opId ? ` (${opId})` : ''}` +
				(issues.length ? ` — ${issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ')}` : ''),
		);
	}
}

const SCHEMA_BY_KEY: ReadonlyMap<string, z.ZodTypeAny> = new Map(
	OP_SCHEMAS.map((s) => {
		// `.refine()` wraps the object in a ZodEffects; the literals sit on the
		// inner shape either way.
		const inner = s instanceof z.ZodEffects ? (s.innerType() as z.AnyZodObject) : (s as z.AnyZodObject);
		const entity = (inner.shape.entity as z.ZodLiteral<string>).value;
		const kind = (inner.shape.kind as z.ZodLiteral<string>).value;
		return [`${entity}/${kind}`, s];
	}),
);

export function kindsOf(entity: Entity): string[] {
	const out: string[] = [];
	for (const key of SCHEMA_BY_KEY.keys()) {
		const [e, k] = key.split('/') as [string, string];
		if (e === entity) out.push(k);
	}
	return out;
}

// The protocol version that introduced each kind added after v1; every other
// kind is v1. Writers stamp an op with its kind's version (not
// SCHEMA_VERSION), see the note on SCHEMA_VERSION.
const KIND_SINCE: ReadonlyMap<string, number> = new Map([
	['library_track/set-state', 2],
	['artist_alias/set', 2],
	['artist_alias/remove', 2],
	['library_track/set-meta', 3],
]);

// Account setting keys added after v1. A `setting.set` is a v1 kind, but an
// older client validates the key against its own allow-list and would stop
// at one it does not know (invalid_payload) instead of holding it aside, so
// the op carries the version that introduced its key.
const SETTING_KEY_SINCE: ReadonlyMap<string, number> = new Map([[MASTER_DEVICE_SETTING, 3]]);

export function opSchemaVersion(op: { entity: string; kind: string; entity_id?: string }): number {
	const kind = KIND_SINCE.get(`${op.entity}/${op.kind}`) ?? 1;
	if (op.entity === 'setting' && op.entity_id !== undefined) return Math.max(kind, SETTING_KEY_SINCE.get(op.entity_id) ?? 1);
	return kind;
}

const ZHead = z.object({ entity: z.string(), kind: z.string(), op_id: z.unknown() }).passthrough();

// UTF-8 length without TextEncoder, which the phone runtime may lack.
export function utf8ByteLength(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

export function opPayloadBytes(op: { payload: unknown }): number {
	return utf8ByteLength(JSON.stringify(op.payload));
}

// Validates one op end to end: envelope, (entity, kind), payload schema, and
// the payload size cap. Throws `OpValidationError` naming the entity and kind
// so a rejection reads as "cue.upsert: payload.slot: Expected integer".
export function parseOp(input: unknown): Op {
	const head = ZHead.safeParse(input);
	if (!head.success) throw new OpValidationError('malformed', null, null, head.error.issues);
	const { entity, kind } = head.data;
	const opId = typeof head.data.op_id === 'string' ? head.data.op_id : null;
	if (!(ENTITIES as readonly string[]).includes(entity)) throw new OpValidationError('unknown_entity', entity, kind, [], opId);
	const schema = SCHEMA_BY_KEY.get(`${entity}/${kind}`);
	if (!schema) throw new OpValidationError('unknown_kind', entity, kind, [], opId);
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new OpValidationError('invalid_payload', entity, kind, parsed.error.issues, opId);
	const op = parsed.data as Op;
	// A kind stamped with a version older than the one that introduced it
	// would reach a client that claims to read that version and cannot.
	if (op.schema_version < opSchemaVersion(op)) {
		throw new OpValidationError('invalid_payload', entity, kind, [{ code: 'custom', path: ['schema_version'], message: `${entity}.${kind} needs schema_version ≥ ${opSchemaVersion(op)}` }], op.op_id);
	}
	if (opPayloadBytes(op) > MAX_OP_PAYLOAD_BYTES) throw new OpValidationError('payload_too_large', entity, kind, [], op.op_id);
	return op;
}

export function safeParseOp(input: unknown): { ok: true; op: Op } | { ok: false; error: OpValidationError } {
	try {
		return { ok: true, op: parseOp(input) };
	} catch (e) {
		if (e instanceof OpValidationError) return { ok: false, error: e };
		throw e;
	}
}

// 'ok' applies; 'update_required' is what the server answers a push below the
// minimum; 'ahead' is an op a client must hold (design: `sync_inbox_held`)
// until it updates, stopping apply at that seq to keep order.
export function schemaVersionStatus(version: number, current = SCHEMA_VERSION, min = MIN_SUPPORTED_SCHEMA_VERSION): 'ok' | 'update_required' | 'ahead' {
	if (version < min) return 'update_required';
	if (version > current) return 'ahead';
	return 'ok';
}
