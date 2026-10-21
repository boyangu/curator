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
//
// Version 4 (2026-10-21, the zero-data-loss release) is additive the same
// way: every addition is a new kind, a new claim kind, a new rekordbox unit
// or a new entity, each stamped 4 (KIND_SINCE, CLAIM_KIND_SINCE,
// RB_UNIT_SINCE below), never a field added to a v1-v3 payload — those are
// `.strict()`, so a v3 client would reject a widened op as invalid_payload
// instead of holding it aside. A v3 server answers a v4 op `server_outdated`
// for the whole push, so a desktop emits none before the server advertises
// 'zero_loss_v4'.
export const SCHEMA_VERSION = 4;
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
	// Since v4.
	'feed_item',
	'feed_suppression',
	'album',
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
const ZCount = z.number().int().nonnegative();
// A remote image or page only: a local path or data: URL means nothing on
// another device.
const ZHttpUrl = z.string().max(2048).regex(/^https?:\/\//i, { message: 'must be an http(s) url' });

// Wire-safe JSON: no `undefined`, no functions, no cycles.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const ZJsonValue: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(ZJsonValue), z.record(ZJsonValue)]),
);

export const TAG_KINDS = ['system', 'user'] as const;
export const PLAYLIST_SOURCES = ['spotify', 'tidal', 'rekordbox', 'local'] as const;
export const CUE_KINDS = ['hot', 'memory'] as const;
export type CueKind = (typeof CUE_KINDS)[number];
// 'bpm' and 'key_strength' since v4 (RB_UNIT_SINCE).
export const RB_ANALYSIS_UNITS = ['grid', 'key', 'segments', 'bpm', 'key_strength'] as const;
// 'traxsource', 'musicbrainz' and 'discogs' since v4 (CLAIM_KIND_SINCE).
export const CLAIM_KINDS = ['isrc', 'audio_hash', 'fingerprint', 'spotify', 'tidal', 'beatport', 'traxsource', 'musicbrainz', 'discogs'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
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

// Since v4. The playlist's details beyond its name and place (the zero-loss
// audit, item 10): the user's hybrid-Tidal toggle, its sidebar position (a
// rekordbox playlist's Seq), its provider mark ('P' a streaming playlist,
// '♡' Liked Songs, 'R' rekordbox) and what its provider says about it. Each
// key is its own LWW field (the container rule), so a device states only
// the ones that changed; a phone, which runs no provider read-sync, sees
// what the desktops read. `position` is a plain integer, not an order key:
// rekordbox owns the order (its Seq) and every desktop reads it from there.
const playlistAttrs = {
	hybrid_tidal: z.boolean().optional(),
	position: z.number().int().optional(),
	mark: z.string().min(1).max(8).nullable().optional(),
	description: z.string().max(4096).nullable().optional(),
	owner_name: z.string().max(512).nullable().optional(),
	owner_id: z.string().max(256).nullable().optional(),
	cover_url: ZHttpUrl.nullable().optional(),
	is_public: z.boolean().nullable().optional(),
	is_collaborative: z.boolean().nullable().optional(),
	is_hidden: z.boolean().optional(),
	followers: ZCount.nullable().optional(),
};
export const PLAYLIST_ATTR_FIELDS = Object.keys(playlistAttrs) as Array<keyof typeof playlistAttrs>;
const notEmpty = { message: 'at least one field' };
export const ZPlaylistSetAttrs = defineOp(
	'playlist',
	'set-attrs',
	z.object(playlistAttrs).strict().refine((p) => Object.values(p).some((v) => v !== undefined), notEmpty),
);

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
// Since v4: a folder's sidebar position (rekordbox's Seq), like a playlist's.
export const PLAYLIST_FOLDER_ATTR_FIELDS = ['position'] as const;
export const ZPlaylistFolderSetAttrs = defineOp('playlist_folder', 'set-attrs', z.object({ position: z.number().int() }).strict());

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
//
// The two v4 units (RB_UNIT_SINCE): rekordbox's tempo and key confidence of
// the rb slot (track_analysis.rb_bpm / rb_key_strength), which the player
// shows when its analysis source is rekordbox.
const ZRbScalar = z.number().finite().nullable();
export const ZRbAnalysisUnit = z.discriminatedUnion('unit', [
	z.object({ unit: z.literal('grid'), value: z.array(z.number()).refine(isRbGridValue, { message: 'not an rb grid (rb-grid.ts)' }).nullable() }).strict(),
	z.object({ unit: z.literal('key'), value: z.string().nullable() }).strict(),
	z.object({ unit: z.literal('segments'), value: z.array(z.record(ZJsonValue)).nullable() }).strict(),
	z.object({ unit: z.literal('bpm'), value: ZRbScalar }).strict(),
	z.object({ unit: z.literal('key_strength'), value: ZRbScalar }).strict(),
]);
export const ZLibraryTrackSetRbAnalysis = defineOp('library_track', 'set-rb-analysis', ZRbAnalysisUnit);

// Since v4. The rest of a device's own catalogue row that set-meta leaves
// out (the 2026-10-21 zero-loss audit, items 2, 11 and 14): SOURCE data —
// tempo, key, explicit flag, MusicBrainz id, copyright, what the row's
// provider listings say about its release and artists — and one DEVICE
// value, the rekordbox play counter (that machine's own count). The user's
// curation of a track (comment, colour) is not here: it is last-write-wins
// across every device (set-curation below), not master-wins. A kind of its own rather than wider set-meta: set-meta is
// `.strict()` and v3, so a v3 client would reject a wider one instead of
// holding it.
//
// Filed like set-meta under `attrs.<device_id>` (the envelope names the
// device), and the view picks a cell by THE SAME RULE (state.ts
// resolveTrackAttrs = resolveTrackMeta's: the master's cell, else best
// source, then the later write). Overrides (bpm, key_camelot) still win on
// read. What a device states is its row's OWN values: a value it took from
// the account (adopted, see the desktop's track-attrs.ts) is stated as null,
// so a device never echoes the master's value back as its own.
//
// `key_source`: where the row's key came from, as far as the device can tell
// (no device stores a provenance column; the desktop infers it from the
// rekordbox slot and its provider links). Provenance only — no rule reads it.
// `provider_refs`: one per streaming listing the row holds (its Spotify /
// Tidal links' payloads, compacted): the release id and what the provider
// says about it, and the provider's ids for the credited artists — what lets
// a device without those links group the track under the same album and
// link its artists like the device that has them.
// `artist_names`: how this device's artist table spells each credited
// artist (its display name, first-seen unless the user renamed it): a
// device creating the same uncurated artist from another listing would
// otherwise keep whichever spelling it met first (the audit's 41 artists,
// "Ayşe Çelikoğlu" vs "Ayse Celikoglu"); the master's spelling wins there.
export const KEY_SOURCES = ['rekordbox', 'beatport', 'traxsource', 'tidal', 'tag', 'other'] as const;
export const PROVIDER_REF_SOURCES = ['spotify', 'tidal'] as const;
const ZProviderAlbum = z
	.object({
		id: z.string().min(1).max(128),
		name: z.string().max(1024).nullable(),
		artists: z.array(z.string().min(1).max(512)).max(32),
		release_date: z.string().max(32).nullable(),
		cover_url: ZHttpUrl.nullable(),
		album_type: z.string().max(32).nullable(),
		total_tracks: ZCount.nullable(),
	})
	.strict();
export const ZProviderRef = z
	.object({
		source: z.enum(PROVIDER_REF_SOURCES),
		album: ZProviderAlbum.nullable(),
		artists: z.array(z.object({ name: z.string().min(1).max(512), id: z.string().min(1).max(128) }).strict()).max(32),
		track_number: ZCount.nullable(),
		disc_number: ZCount.nullable(),
	})
	.strict();
export type ProviderRef = z.infer<typeof ZProviderRef>;
export const ZTrackAttrs = z
	.object({
		source: z.enum(TRACK_META_SOURCES),
		bpm: z.number().positive().max(1000).nullable(),
		key_camelot: z.string().min(1).max(8).nullable(),
		key_source: z.enum(KEY_SOURCES).nullable(),
		explicit: z.boolean().nullable(),
		mbid: z.string().min(1).max(64).nullable(),
		copyright: z.string().min(1).max(1024).nullable(),
		play_count: ZCount.nullable(),
		provider_refs: z.array(ZProviderRef).max(8),
		artist_names: z.array(z.string().min(1).max(512)).max(32),
	})
	.strict();
export type TrackAttrs = z.infer<typeof ZTrackAttrs>;
export const ZLibraryTrackSetAttrs = defineOp('library_track', 'set-attrs', ZTrackAttrs);

// Since v4. When the user last edited this recording's cues in Curator
// (track.cues_edited_at): the rekordbox exporter's "an empty cue list is a
// real clear" guard. Account-wide, not per device and not master-wins: a
// clear made on any device must reach every device's exporter, or that
// device's rekordbox keeps the cues and its next import brings them back.
// The reducer keeps the latest `at` (state.ts), so a device re-stating an
// older stamp never lowers it.
export const ZLibraryTrackSetCuesEdited = defineOp('library_track', 'set-cues-edited', z.object({ at: ZMs }).strict());

// Since v4. The user's curation of a track that rides the track row rather
// than an op of its own: its comment and its colour label (rekordbox's
// Comments and Colour). One field per op, each its own LWW cell
// (`curation.<field>`) like a rating or an override — the later edit wins
// on every device, whichever device made it; there is no master here. A
// device writes the winner onto its own row too, and its rekordbox exporter
// carries it into that machine's rekordbox ("a tag set on the phone reaches
// rekordbox eventually", decided 2026-10-21).
//
// The comment is the user's FREE TEXT only: rekordbox's "Add MyTag to
// Comments" block (`… /* tag / tag */`, desktop rekordbox/tag-comment.ts) is
// a per-machine derivation of the track's tags in that rekordbox's order,
// and each device keeps and rebuilds its own. Carrying it would let two
// machines that list the same tags in different orders rewrite each other's
// comment forever.
export const CURATION_FIELDS = ['comment', 'color_label'] as const;
export type CurationField = (typeof CURATION_FIELDS)[number];
export const ZCurationField = z.discriminatedUnion('field', [
	z.object({ field: z.literal('comment'), value: z.string().min(1).max(8192).nullable() }).strict(),
	z.object({ field: z.literal('color_label'), value: z.string().min(1).max(32).nullable() }).strict(),
]);
export const ZLibraryTrackSetCuration = defineOp('library_track', 'set-curation', ZCurationField);
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

// Since v4. The same whole-cue upsert plus where the cue came from
// (`cue.origin`: rekordbox's import or a Curator edit). The rekordbox
// importer replaces only rekordbox-origin cues, so a device that projected
// another desktop's rekordbox cues as 'curator' (every cue before v4) would
// keep stale copies beside its own import's. A kind of its own because
// ZCueBody is strict; the reducer files both kinds in the same cue record,
// so the later write of either wins the slot (an upsert without origin
// leaves the origin unknown, and the projection keeps the row's own).
export const CUE_ORIGINS = ['curator', 'rekordbox'] as const;
export const ZCueUpsert2 = defineOp('cue', 'upsert2', ZCueBody.extend({ origin: z.enum(CUE_ORIGINS) }).strict()).refine((o) => {
	const id = parseCueEntityId(o.entity_id);
	return id !== null && id.slot === o.payload.slot && id.kind === o.payload.kind;
}, cueId);

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

const ZPlayEventBody = z
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
	.strict();
export const ZPlayEventAppend = defineOp('play_event', 'append', ZPlayEventBody);
// Since v4. The same append plus the play's own source references: the
// rekordbox DjmdContent id an imported play names (what re-links a play to
// its track on a device whose rekordbox holds it) and the source track id a
// Curator play was made from (a Spotify id or file path). The event record
// is whole-value LWW, so a later append2 of an event restates its body with
// the references; an append without them after it leaves them unknown.
export const ZPlayEventAppend2 = defineOp(
	'play_event',
	'append2',
	ZPlayEventBody.extend({ rb_content_id: z.string().min(1).max(64).nullable(), source_track_id: z.string().min(1).max(2048).nullable() }).strict(),
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

// ── feed_item / feed_suppression ────────────────────────────────────────────
// Since v4. The Discover feed's user decisions (the zero-loss audit, item 9;
// decided 2026-10-21: the master device collects the feed for now, its
// decisions sync to every device, and a later cloud feed owns them). They
// are account-level records keyed by ids every device and the cloud derive
// alike — never a device's feed.db row id:
//   feed_item         `entity_id` = the item's dedupe key: `isrc:<ISRC>`,
//                     `spotify:track:<id>` or `spotify:album:<id>`.
//   feed_suppression  `entity_id` = the suppression key: `artist:<id>`,
//                     `playlist:<id>`, `label:<…>`, `source:<…>`, or
//                     `track:<spotify id>` (a track marked unavailable).
// Per-field LWW records (the container rule without a create: a decision
// about an item a device has not collected yet is kept and applies when the
// item shows up there).

export const FEED_ITEM_STATES = ['fresh', 'seen', 'expanded', 'promoted', 'dismissed', 'archived'] as const;
export const FEED_SUPPRESSION_SCOPES = ['artist', 'label', 'playlist', 'source', 'track'] as const;
const ZFeedKey = z.string().min(1).max(256);
const feedKey = { message: 'entity_id must be a feed key (≤ 256 chars)' };

// `promoted_recording_id`: the library recording a promote made (a recording
// id, not the device's track id), or null when a promotion was undone.
export const ZFeedItemSetState = defineOp(
	'feed_item',
	'set-state',
	z.object({ state: z.enum(FEED_ITEM_STATES), promoted_recording_id: ZId.nullable().optional() }).strict(),
).refine((o) => ZFeedKey.safeParse(o.entity_id).success, feedKey);
export const ZFeedItemMarkPlayed = defineOp('feed_item', 'mark-played', z.object({ at: ZMs }).strict()).refine((o) => ZFeedKey.safeParse(o.entity_id).success, feedKey);
// One track of the item listened to (an album's tracklist shows them): a
// set, one field per track id.
export const ZFeedItemMarkListened = defineOp('feed_item', 'mark-listened', z.object({ source_track_id: z.string().min(1).max(64) }).strict()).refine((o) => ZFeedKey.safeParse(o.entity_id).success, feedKey);
export const ZFeedSuppressionSet = defineOp(
	'feed_suppression',
	'set',
	z.object({ scope: z.enum(FEED_SUPPRESSION_SCOPES), active: z.boolean() }).strict(),
).refine((o) => ZFeedKey.safeParse(o.entity_id).success, feedKey);

// ── album ───────────────────────────────────────────────────────────────────
// Since v4. A release as its provider describes it (the Spotify album fill:
// album artists, type, size, label, UPC, cover, date), keyed by the provider
// album id (`entity_id` = `spotify:<id>` / `tidal:<id>`), so a device that
// cannot ask the provider (no token, the phone) shows the same album the one
// that asked does. Per-field LWW; `artists` are the provider's album artist
// names (`various` when it lists "Various Artists").
const albumId = { message: 'entity_id must be `${source}:${albumId}`' };
export const ZAlbumSetMeta = defineOp(
	'album',
	'set-meta',
	z
		.object({
			album_type: z.string().max(32).nullable(),
			total_tracks: ZCount.nullable(),
			release_date: z.string().max(32).nullable(),
			label: z.string().max(1024).nullable(),
			upc: z.string().max(64).nullable(),
			cover_url: ZHttpUrl.nullable(),
			artists: z.array(z.string().min(1).max(512)).max(64),
			various: z.boolean(),
		})
		.strict(),
).refine((o) => /^(spotify|tidal):[^:\s]{1,128}$/.test(o.entity_id), albumId);

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
	ZPlaylistSetAttrs,
	ZPlaylistFolderCreate,
	ZPlaylistFolderRename,
	ZPlaylistFolderMoveToFolder,
	ZPlaylistFolderSetSourceLink,
	ZPlaylistFolderDelete,
	ZPlaylistFolderSetAttrs,
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
	ZLibraryTrackSetAttrs,
	ZLibraryTrackSetCuesEdited,
	ZLibraryTrackSetCuration,
	ZLibraryTrackDelete,
	ZLibraryTrackUndelete,
	ZCueUpsert,
	ZCueUpsert2,
	ZCueDelete,
	ZPlaySessionAppend,
	ZPlaySessionSetKind,
	ZPlayEventAppend,
	ZPlayEventAppend2,
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
	ZFeedItemSetState,
	ZFeedItemMarkPlayed,
	ZFeedItemMarkListened,
	ZFeedSuppressionSet,
	ZAlbumSetMeta,
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
	['library_track/set-attrs', 4],
	['library_track/set-cues-edited', 4],
	['library_track/set-curation', 4],
	['cue/upsert2', 4],
	['play_event/append2', 4],
	['playlist/set-attrs', 4],
	['playlist_folder/set-attrs', 4],
	['feed_item/set-state', 4],
	['feed_item/mark-played', 4],
	['feed_item/mark-listened', 4],
	['feed_suppression/set', 4],
	['album/set-meta', 4],
]);

// Account setting keys added after v1. A `setting.set` is a v1 kind, but an
// older client validates the key against its own allow-list and would stop
// at one it does not know (invalid_payload) instead of holding it aside, so
// the op carries the version that introduced its key.
const SETTING_KEY_SINCE: ReadonlyMap<string, number> = new Map([[MASTER_DEVICE_SETTING, 3]]);

// Enum values added to a v1 kind's payload, by the same reasoning: a
// `recording_claim.add` of kind traxsource, or a `set-rb-analysis` of unit
// bpm, fails an older client's enum, so the op carries the version that
// introduced the value and that client holds it aside. Since v4.
export const CLAIM_KIND_SINCE: ReadonlyMap<string, number> = new Map([['traxsource', 4], ['musicbrainz', 4], ['discogs', 4]]);
export const RB_UNIT_SINCE: ReadonlyMap<string, number> = new Map([['bpm', 4], ['key_strength', 4]]);

// Reads the payload only for the two kinds whose enum grew (the stamp must
// be right for an op before it is parsed: emitOps stamps, then parses).
export function opSchemaVersion(op: { entity: string; kind: string; entity_id?: string; payload?: unknown }): number {
	const kind = KIND_SINCE.get(`${op.entity}/${op.kind}`) ?? 1;
	if (op.entity === 'setting' && op.entity_id !== undefined) return Math.max(kind, SETTING_KEY_SINCE.get(op.entity_id) ?? 1);
	const p = op.payload !== null && typeof op.payload === 'object' ? (op.payload as Record<string, unknown>) : null;
	if (op.entity === 'recording_claim' && op.kind === 'add' && typeof p?.['kind'] === 'string') return Math.max(kind, CLAIM_KIND_SINCE.get(p['kind']) ?? 1);
	if (op.entity === 'library_track' && op.kind === 'set-rb-analysis' && typeof p?.['unit'] === 'string') return Math.max(kind, RB_UNIT_SINCE.get(p['unit']) ?? 1);
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
