// In-memory library state for the reducer (design: "Client apply", "Tombstones,
// merges and undelete"). The same shape serves the server's materialisation,
// the desktop's apply and the replay test; the desktop's SQLite tables are a
// projection of it.
//
// Every record keeps the clock of the write that set it, because the merge
// rules are functions of those clocks: a later op arriving earlier must still
// lose. Raw records are therefore order-independent by construction — the
// same set of ops yields the same maps whatever the arrival order — and what
// the user sees is derived from them by `materialize`, which applies the
// visibility rules (tombstones, container deletes, add-wins).

import { MASTER_DEVICE_SETTING, type CueKind, type Entity, type Op, type PayloadOf, type SourceLink, type TrackAttrs, type TrackMeta } from './ops.js';
import { compareKeys } from './order-key.js';

// ── clocks ──────────────────────────────────────────────────────────────────

// LWW order: (client_ts, device_id, op_id). The op id is the final tie-break
// so two ops are never "equal" unless they are the same op — which is what
// makes re-applying one a no-op without an applied-op set.
export type Clock = { ts: number; device: string; op: string };

export function clockOf(op: Pick<Op, 'client_ts' | 'device_id' | 'op_id'>): Clock {
	return { ts: op.client_ts, device: op.device_id, op: op.op_id };
}

export function compareClock(a: Clock, b: Clock): number {
	if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
	if (a.device !== b.device) return a.device < b.device ? -1 : 1;
	if (a.op !== b.op) return a.op < b.op ? -1 : 1;
	return 0;
}

export function laterClock(a: Clock | null | undefined, b: Clock): Clock {
	return a && compareClock(a, b) >= 0 ? a : b;
}

// ── records ─────────────────────────────────────────────────────────────────

export type Cell<T = unknown> = { value: T; clock: Clock };

// Per-field LWW entity: tag, playlist, playlist_folder, pinned_search,
// library_track, play_session. `created` is the latest create seen; a record
// with fields but no create is a shadow (an edit that arrived before its
// create) and stays invisible until the create lands.
export type LwwRecord = {
	id: string;
	created: Clock | null;
	fields: Record<string, Cell>;
};

export type TrackTagRecord = {
	recordingId: string;
	tagId: string;
	added: Clock;
};

export type PlaylistTrackRecord = {
	id: string;
	// Null on a shadow row (a move or rekey that arrived before the add).
	playlistId: string | null;
	recordingId: string | null;
	added: Clock | null;
	orderKey: Cell<string> | null;
};

// `origin` only from a v4 `upsert2`; absent means unknown.
export type CueBody = Omit<PayloadOf<'cue', 'upsert'>, 'slot' | 'kind'> & { origin?: PayloadOf<'cue', 'upsert2'>['origin'] };

// A play as the latest append stated it; the references only from a v4
// `append2`.
export type PlayEventBody = PayloadOf<'play_event', 'append'> & { rb_content_id?: string | null; source_track_id?: string | null };

export type CueRecord = {
	recordingId: string;
	slot: number;
	kind: CueKind;
	cell: Cell<CueBody>;
};

export type ClaimRecord = {
	recordingId: string;
	kind: PayloadOf<'recording_claim', 'add'>['kind'];
	value: string;
	cell: Cell<{ confidence: number; duration_sec: number | null }>;
};

// The latest merge/split per loser. `winner: null` is a withdrawn alias
// (split). The flattened alias map is derived from these.
export type MergeRecord = { winner: string | null; clock: Clock };

export type EntityRef = { entity: Entity; id: string };

// An artist_alias record: the latest set or remove for one FROM key, the
// rule itself or null once removed.
export type ArtistAliasRule = PayloadOf<'artist_alias', 'set'>;
export type ArtistAliasRecord = Cell<ArtistAliasRule | null>;
// Where a FROM key's credits resolve after chains: the final spelling and
// its key.
export type ArtistAliasTarget = { name: string; key: string };

export type LibraryState = {
	tags: Map<string, LwwRecord>;
	trackTags: Map<string, TrackTagRecord>; // `${recordingId}:${tagId}`
	playlists: Map<string, LwwRecord>;
	playlistFolders: Map<string, LwwRecord>;
	playlistTracks: Map<string, PlaylistTrackRecord>; // row id
	libraryTracks: Map<string, LwwRecord>; // recording id
	cues: Map<string, CueRecord>; // `${recordingId}:${slot}:${kind}`
	pinnedSearches: Map<string, LwwRecord>;
	settings: Map<string, Cell>; // key
	playSessions: Map<string, LwwRecord>;
	playEvents: Map<string, Cell<PlayEventBody>>;
	claims: Map<string, ClaimRecord>; // `${recordingId}:${kind}:${value}`
	upstreamAcks: Map<string, Cell<PayloadOf<'upstream', 'ack'>>>; // acked op id
	merges: Map<string, MergeRecord>; // loser
	// Derived from `merges`, flattened so a lookup is one hop (design:
	// "Aliases"). Rebuilt by the reducer whenever `merges` changes.
	recordingAlias: Map<string, string>;
	artistAliases: Map<string, ArtistAliasRecord>; // from key
	// Derived from `artistAliases` (chains followed, cycles broken by clock),
	// rebuilt by the reducer whenever a rule changes; see
	// `rebuildArtistAlias` in reduce.ts.
	artistAlias: Map<string, ArtistAliasTarget>;
	// Since v4 (snapshot.ts ADDED_MAPS): the Discover feed's decisions, keyed
	// by item dedupe key / suppression key, and the provider's releases keyed
	// `${source}:${albumId}`. Per-field LWW records with no create.
	feedItems: Map<string, LwwRecord>;
	feedSuppressions: Map<string, LwwRecord>;
	albums: Map<string, LwwRecord>;
	// `${entity}:${entityId}` → the latest delete/remove seen. For containers
	// (tag, playlist, playlist_folder, pinned_search) presence alone wins; for
	// sets (track_tag, playlist_track) the ts decides against adds; for cues
	// the whole clock decides against the upsert.
	tombstones: Map<string, Clock>;
};

export function createLibraryState(): LibraryState {
	return {
		tags: new Map(),
		trackTags: new Map(),
		playlists: new Map(),
		playlistFolders: new Map(),
		playlistTracks: new Map(),
		libraryTracks: new Map(),
		cues: new Map(),
		pinnedSearches: new Map(),
		settings: new Map(),
		playSessions: new Map(),
		playEvents: new Map(),
		claims: new Map(),
		upstreamAcks: new Map(),
		merges: new Map(),
		recordingAlias: new Map(),
		artistAliases: new Map(),
		artistAlias: new Map(),
		feedItems: new Map(),
		feedSuppressions: new Map(),
		albums: new Map(),
		tombstones: new Map(),
	};
}

// Records are plain JSON-shaped data plus clocks, so a structural copy is
// enough; `structuredClone` is avoided because the phone runtime may lack it.
function deepCopy<T>(v: T): T {
	if (Array.isArray(v)) return v.map(deepCopy) as T;
	if (v !== null && typeof v === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepCopy(x);
		return out as T;
	}
	return v;
}

function copyMap<V>(m: Map<string, V>): Map<string, V> {
	const out = new Map<string, V>();
	for (const [k, v] of m) out.set(k, deepCopy(v));
	return out;
}

export function cloneLibraryState(s: LibraryState): LibraryState {
	return {
		tags: copyMap(s.tags),
		trackTags: copyMap(s.trackTags),
		playlists: copyMap(s.playlists),
		playlistFolders: copyMap(s.playlistFolders),
		playlistTracks: copyMap(s.playlistTracks),
		libraryTracks: copyMap(s.libraryTracks),
		cues: copyMap(s.cues),
		pinnedSearches: copyMap(s.pinnedSearches),
		settings: copyMap(s.settings),
		playSessions: copyMap(s.playSessions),
		playEvents: copyMap(s.playEvents),
		claims: copyMap(s.claims),
		upstreamAcks: copyMap(s.upstreamAcks),
		merges: copyMap(s.merges),
		recordingAlias: new Map(s.recordingAlias),
		artistAliases: copyMap(s.artistAliases),
		artistAlias: copyMap(s.artistAlias),
		feedItems: copyMap(s.feedItems),
		feedSuppressions: copyMap(s.feedSuppressions),
		albums: copyMap(s.albums),
		tombstones: copyMap(s.tombstones),
	};
}

export function tombstoneKey(entity: Entity, id: string): string {
	return `${entity}:${id}`;
}

export function resolveRecording(state: LibraryState, recordingId: string): string {
	return state.recordingAlias.get(recordingId) ?? recordingId;
}

// ── base metadata (library_track.set-meta, since v3) ────────────────────────
// Each device's meta for a recording is its own LWW cell; the view shows one
// of them. THE RULE (decided 2026-10-20, "master device wins"): the master
// device's cell whenever it has one — the master seeds every other device —
// else, among the devices that do, the best source (a file's own tags over a
// provider's listing: local > spotify > tidal > other), then the later
// write. A function of the cells and the setting only, so every device and
// the server pick the same cell in any arrival order, and a master change
// re-picks everywhere at once.

export const META_CELL_PREFIX = 'meta.';

export function metaCellName(deviceId: string): string {
	return `${META_CELL_PREFIX}${deviceId}`;
}

const META_SOURCE_RANK: Record<string, number> = { local: 0, spotify: 1, tidal: 2, other: 3 };

export type ResolvedTrackMeta = { device: string; meta: TrackMeta; clock: Clock };

// The rule over any family of per-device cells `<prefix><device>` whose
// values carry a `source`: set-meta's and set-attrs' (v4), which must pick
// the same device for a recording or a remote row would show one device's
// title beside another's tempo.
function resolveDeviceCell<T extends { source: string }>(rec: Pick<LwwRecord, 'fields'> | undefined, prefix: string, master: string | null): { device: string; value: T; clock: Clock } | null {
	if (!rec) return null;
	let best: { device: string; value: T; clock: Clock } | null = null;
	for (const [name, cell] of Object.entries(rec.fields)) {
		if (!name.startsWith(prefix) || cell.value === null || typeof cell.value !== 'object') continue;
		const cand = { device: name.slice(prefix.length), value: cell.value as T, clock: cell.clock };
		if (master !== null && cand.device === master) return cand;
		if (!best) { best = cand; continue; }
		const rb = META_SOURCE_RANK[best.value.source] ?? 9;
		const rc = META_SOURCE_RANK[cand.value.source] ?? 9;
		if (rc < rb || (rc === rb && compareClock(cand.clock, best.clock) > 0)) best = cand;
	}
	return best;
}

export function resolveTrackMeta(rec: Pick<LwwRecord, 'fields'> | undefined, master: string | null): ResolvedTrackMeta | null {
	const r = resolveDeviceCell<TrackMeta>(rec, META_CELL_PREFIX, master);
	return r ? { device: r.device, meta: r.value, clock: r.clock } : null;
}

// ── track attributes (library_track.set-attrs, since v4) ────────────────────
// Same cells-per-device shape and the same precedence as the meta above —
// the master's cell, then the best source, then the later write — applied
// PER FIELD: each field shows the first cell in that order that states a
// value. A device states only its own values (a value it adopted from the
// account rides as null), so a field the master has no value for shows
// another device's own value instead of nothing: the master wins wherever it
// knows, and nothing another device knows is lost. The key's source travels
// with the key; the provider refs are the first non-empty list; the artist
// spellings are the master's only (a spelling is a display choice, and two
// non-master devices would flip it).

export const ATTRS_CELL_PREFIX = 'attrs.';

export function attrsCellName(deviceId: string): string {
	return `${ATTRS_CELL_PREFIX}${deviceId}`;
}

// `device`: the cell that leads the precedence (the master's when it has
// one); `attrs` merges every cell by it.
export type ResolvedTrackAttrs = { device: string; attrs: TrackAttrs; clock: Clock };

const ATTR_SCALARS = ['bpm', 'explicit', 'mbid', 'copyright', 'play_count'] as const;

export function resolveTrackAttrs(rec: Pick<LwwRecord, 'fields'> | undefined, master: string | null): ResolvedTrackAttrs | null {
	if (!rec) return null;
	const cells: Array<{ device: string; value: TrackAttrs; clock: Clock }> = [];
	for (const [name, cell] of Object.entries(rec.fields)) {
		if (!name.startsWith(ATTRS_CELL_PREFIX) || cell.value === null || typeof cell.value !== 'object') continue;
		cells.push({ device: name.slice(ATTRS_CELL_PREFIX.length), value: cell.value as TrackAttrs, clock: cell.clock });
	}
	if (cells.length === 0) return null;
	const rank = (c: { device: string; value: TrackAttrs }): number => (master !== null && c.device === master ? -1 : META_SOURCE_RANK[c.value.source] ?? 9);
	cells.sort((a, b) => rank(a) - rank(b) || -compareClock(a.clock, b.clock));
	const lead = cells[0]!;
	const out: TrackAttrs = { ...lead.value };
	for (const f of ATTR_SCALARS) {
		const hit = cells.find((c) => c.value[f] !== null && c.value[f] !== undefined);
		(out as Record<string, unknown>)[f] = hit ? hit.value[f] : null;
	}
	const key = cells.find((c) => c.value.key_camelot !== null && c.value.key_camelot !== undefined);
	out.key_camelot = key?.value.key_camelot ?? null;
	out.key_source = key?.value.key_source ?? null;
	out.provider_refs = cells.find((c) => (c.value.provider_refs?.length ?? 0) > 0)?.value.provider_refs ?? [];
	out.artist_names = master !== null && lead.device !== master ? [] : lead.value.artist_names ?? [];
	return { device: lead.device, attrs: out, clock: lead.clock };
}

// The account's cue-edit stamp (set-cues-edited), or null.
export const CUES_EDITED_CELL = 'cues_edited_at';

// The track's curation (set-curation, v4): one plain LWW cell per field.
export const CURATION_CELL_PREFIX = 'curation.';

// The master device id the settings hold, or null (no master stated yet:
// the rest of the rule decides alone).
export function masterDeviceOf(settings: ReadonlyMap<string, Cell>): string | null {
	const v = settings.get(MASTER_DEVICE_SETTING)?.value;
	return typeof v === 'string' && v.length > 0 ? v : null;
}

// ── visibility ──────────────────────────────────────────────────────────────

function containerAlive(state: LibraryState, entity: Entity, rec: LwwRecord | undefined): rec is LwwRecord {
	return rec !== undefined && rec.created !== null && !state.tombstones.has(tombstoneKey(entity, rec.id));
}

export function tagAlive(state: LibraryState, id: string): boolean {
	return containerAlive(state, 'tag', state.tags.get(id));
}
export function playlistAlive(state: LibraryState, id: string): boolean {
	return containerAlive(state, 'playlist', state.playlists.get(id));
}
export function playlistFolderAlive(state: LibraryState, id: string): boolean {
	return containerAlive(state, 'playlist_folder', state.playlistFolders.get(id));
}
export function pinnedSearchAlive(state: LibraryState, id: string): boolean {
	return containerAlive(state, 'pinned_search', state.pinnedSearches.get(id));
}

// Add-wins with observed remove: a remove cancels only adds with an earlier
// `client_ts`; an add at the same ms as the remove survives (design: the
// track_tag rule), so this compares timestamps, not full clocks.
export function addWins(added: Clock, removed: Clock | undefined): boolean {
	return removed === undefined || added.ts >= removed.ts;
}

export function trackTagAlive(state: LibraryState, key: string): boolean {
	const row = state.trackTags.get(key);
	if (!row) return false;
	return tagAlive(state, row.tagId) && addWins(row.added, state.tombstones.get(tombstoneKey('track_tag', key)));
}

export function playlistTrackAlive(state: LibraryState, id: string): boolean {
	const row = state.playlistTracks.get(id);
	if (!row || row.added === null || row.playlistId === null || row.orderKey === null) return false;
	return playlistAlive(state, row.playlistId) && addWins(row.added, state.tombstones.get(tombstoneKey('playlist_track', id)));
}

// Whole-cue LWW: the delete is one more "version" of the cue, so the full
// clock decides (unlike the set rule above).
export function cueAlive(state: LibraryState, key: string): boolean {
	const rec = state.cues.get(key);
	if (!rec) return false;
	const tomb = state.tombstones.get(tombstoneKey('cue', key));
	return tomb === undefined || compareClock(rec.cell.clock, tomb) > 0;
}

// ── materialised view ───────────────────────────────────────────────────────
// What a device's tables (and the server's materialised tables) hold: plain
// rows, visibility applied, sorted so two views compare structurally.

export type TagView = { id: string; name: string | null; kind: string | null; color: string | null };
// `attrs`: the v4 set-attrs fields the records hold (only those).
export type PlaylistView = { id: string; name: string | null; folderId: string | null; sourceLink: SourceLink | null; favourite: boolean; attrs: Record<string, unknown> };
export type PlaylistFolderView = { id: string; name: string | null; parentFolderId: string | null; sourceLink: SourceLink | null; attrs: Record<string, unknown> };
export type PlaylistTrackView = { id: string; playlistId: string; recordingId: string; orderKey: string; position: number; addedAt: number };
export type LibraryTrackView = {
	recordingId: string;
	addedAt: number | null;
	rating: number | null;
	// Null: never set on any device, i.e. the schema default ('unsorted').
	state: string | null;
	favourite: boolean;
	deletedAt: number | null;
	overrides: Record<string, unknown>;
	rb: Record<string, unknown>;
	// The winning base metadata (resolveTrackMeta) and the device it came
	// from; null when no device has stated any.
	meta: (TrackMeta & { device: string }) | null;
	// Since v4: the winning attributes (resolveTrackAttrs) and the account's
	// cue-edit stamp.
	attrs: (TrackAttrs & { device: string }) | null;
	cuesEditedAt: number | null;
	// The curation fields stated (set-curation), a null one as null.
	curation: Record<string, unknown>;
};
export type FeedItemView = { key: string; state: string | null; promotedRecordingId: string | null; playedAt: number | null; listened: string[] };
export type FeedSuppressionView = { key: string; scope: string | null; active: boolean };
export type AlbumView = { key: string } & Record<string, unknown>;
export type CueView = { recordingId: string; slot: number; kind: CueKind } & CueBody;
export type PinnedSearchView = { id: string; name: string | null; query: string | null; sortColumn: string | null; sortDir: string | null };
export type PlaySessionView = { id: string } & Record<string, unknown>;
export type PlayEventView = { id: string } & PayloadOf<'play_event', 'append'>;
export type ClaimView = { recordingId: string; kind: ClaimRecord['kind']; value: string; confidence: number; durationSec: number | null };
export type UpstreamAckView = { opId: string } & PayloadOf<'upstream', 'ack'>;

export type LibraryView = {
	tags: TagView[];
	trackTags: { recordingId: string; tagId: string }[];
	playlists: PlaylistView[];
	playlistFolders: PlaylistFolderView[];
	playlistTracks: PlaylistTrackView[];
	libraryTracks: LibraryTrackView[];
	cues: CueView[];
	pinnedSearches: PinnedSearchView[];
	settings: Record<string, unknown>;
	playSessions: PlaySessionView[];
	playEvents: PlayEventView[];
	claims: ClaimView[];
	upstreamAcks: UpstreamAckView[];
	recordingAlias: Record<string, string>;
	artistAlias: Record<string, ArtistAliasTarget>;
	feedItems: FeedItemView[];
	feedSuppressions: FeedSuppressionView[];
	albums: AlbumView[];
};

// The set-attrs field names a playlist / folder record may hold (ops.ts
// PLAYLIST_ATTR_FIELDS), for the view and the desktop's projection.
const PLAYLIST_ATTR_NAMES = ['hybrid_tidal', 'position', 'mark', 'description', 'owner_name', 'owner_id', 'cover_url', 'is_public', 'is_collaborative', 'is_hidden', 'followers'];
function attrsOf(rec: LwwRecord, names: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const n of names) if (rec.fields[n] !== undefined) out[n] = rec.fields[n]!.value;
	return out;
}

// A feed item record's listened set (`listen.<source track id>` fields).
export const FEED_LISTEN_PREFIX = 'listen.';

function field<T>(rec: LwwRecord, name: string, fallback: T): T {
	const c = rec.fields[name];
	return c === undefined ? fallback : (c.value as T);
}

function byId<T extends { id: string }>(a: T, b: T): number {
	return compareKeys(a.id, b.id);
}

function sortedKeys<V>(m: Map<string, V>): string[] {
	return [...m.keys()].sort(compareKeys);
}

export function materialize(state: LibraryState): LibraryView {
	const tags: TagView[] = [];
	for (const id of sortedKeys(state.tags)) {
		if (!tagAlive(state, id)) continue;
		const r = state.tags.get(id)!;
		tags.push({ id, name: field(r, 'name', null), kind: field(r, 'kind', null), color: field(r, 'color', null) });
	}

	const trackTags: LibraryView['trackTags'] = [];
	for (const key of sortedKeys(state.trackTags)) {
		if (!trackTagAlive(state, key)) continue;
		const r = state.trackTags.get(key)!;
		trackTags.push({ recordingId: r.recordingId, tagId: r.tagId });
	}

	const playlists: PlaylistView[] = [];
	for (const id of sortedKeys(state.playlists)) {
		if (!playlistAlive(state, id)) continue;
		const r = state.playlists.get(id)!;
		playlists.push({
			id,
			name: field(r, 'name', null),
			folderId: field(r, 'folder_id', null),
			sourceLink: field(r, 'source_link', null),
			favourite: field(r, 'favourite', false),
			attrs: attrsOf(r, PLAYLIST_ATTR_NAMES),
		});
	}

	const playlistFolders: PlaylistFolderView[] = [];
	for (const id of sortedKeys(state.playlistFolders)) {
		if (!playlistFolderAlive(state, id)) continue;
		const r = state.playlistFolders.get(id)!;
		playlistFolders.push({
			id,
			name: field(r, 'name', null),
			parentFolderId: field(r, 'parent_folder_id', null),
			sourceLink: field(r, 'source_link', null),
			attrs: attrsOf(r, ['position']),
		});
	}

	// Order by (order_key, id) within a playlist; `position` is the derived
	// integer the desktop's consumers keep reading.
	const rows: Omit<PlaylistTrackView, 'position'>[] = [];
	for (const [id, r] of state.playlistTracks) {
		if (!playlistTrackAlive(state, id)) continue;
		rows.push({ id, playlistId: r.playlistId!, recordingId: r.recordingId!, orderKey: r.orderKey!.value, addedAt: r.added!.ts });
	}
	rows.sort((a, b) => compareKeys(a.playlistId, b.playlistId) || compareKeys(a.orderKey, b.orderKey) || compareKeys(a.id, b.id));
	const playlistTracks: PlaylistTrackView[] = [];
	let pos = 0;
	let lastPlaylist: string | null = null;
	for (const r of rows) {
		if (r.playlistId !== lastPlaylist) {
			pos = 0;
			lastPlaylist = r.playlistId;
		}
		playlistTracks.push({ ...r, position: pos++ });
	}

	const libraryTracks: LibraryTrackView[] = [];
	const master = masterDeviceOf(state.settings);
	for (const id of sortedKeys(state.libraryTracks)) {
		const r = state.libraryTracks.get(id)!;
		const overrides: Record<string, unknown> = {};
		const rb: Record<string, unknown> = {};
		const curation: Record<string, unknown> = {};
		for (const [name, cell] of Object.entries(r.fields)) {
			if (name.startsWith('override.') && cell.value !== null) overrides[name.slice('override.'.length)] = cell.value;
			else if (name.startsWith('rb.') && cell.value !== null) rb[name.slice('rb.'.length)] = cell.value;
			else if (name.startsWith(CURATION_CELL_PREFIX)) curation[name.slice(CURATION_CELL_PREFIX.length)] = cell.value;
		}
		libraryTracks.push({
			recordingId: id,
			addedAt: field(r, 'added_at', null),
			rating: field(r, 'rating', null),
			state: field(r, 'state', null),
			favourite: field(r, 'favourite', false),
			deletedAt: field(r, 'deleted_at', null),
			overrides,
			rb,
			meta: (() => {
				const m = resolveTrackMeta(r, master);
				return m ? { ...m.meta, device: m.device } : null;
			})(),
			attrs: (() => {
				const a = resolveTrackAttrs(r, master);
				return a ? { ...a.attrs, device: a.device } : null;
			})(),
			cuesEditedAt: field(r, CUES_EDITED_CELL, null),
			curation,
		});
	}

	const cues: CueView[] = [];
	for (const key of sortedKeys(state.cues)) {
		if (!cueAlive(state, key)) continue;
		const r = state.cues.get(key)!;
		cues.push({ recordingId: r.recordingId, slot: r.slot, kind: r.kind, ...r.cell.value });
	}

	const pinnedSearches: PinnedSearchView[] = [];
	for (const id of sortedKeys(state.pinnedSearches)) {
		if (!pinnedSearchAlive(state, id)) continue;
		const r = state.pinnedSearches.get(id)!;
		pinnedSearches.push({
			id,
			name: field(r, 'name', null),
			query: field(r, 'query', null),
			sortColumn: field(r, 'sort_column', null),
			sortDir: field(r, 'sort_dir', null),
		});
	}

	const settings: Record<string, unknown> = {};
	for (const key of sortedKeys(state.settings)) settings[key] = state.settings.get(key)!.value;

	const playSessions: PlaySessionView[] = [];
	for (const id of sortedKeys(state.playSessions)) {
		const r = state.playSessions.get(id)!;
		if (r.created === null) continue;
		const row: PlaySessionView = { id };
		for (const [name, cell] of Object.entries(r.fields)) row[name] = cell.value;
		playSessions.push(row);
	}

	const playEvents: PlayEventView[] = [];
	for (const id of sortedKeys(state.playEvents)) playEvents.push({ id, ...state.playEvents.get(id)!.value });

	const claims: ClaimView[] = [];
	for (const key of sortedKeys(state.claims)) {
		const r = state.claims.get(key)!;
		claims.push({ recordingId: r.recordingId, kind: r.kind, value: r.value, confidence: r.cell.value.confidence, durationSec: r.cell.value.duration_sec });
	}

	const upstreamAcks: UpstreamAckView[] = [];
	for (const opId of sortedKeys(state.upstreamAcks)) upstreamAcks.push({ opId, ...state.upstreamAcks.get(opId)!.value });

	const recordingAlias: Record<string, string> = {};
	for (const loser of sortedKeys(state.recordingAlias)) recordingAlias[loser] = state.recordingAlias.get(loser)!;

	const artistAlias: Record<string, ArtistAliasTarget> = {};
	for (const key of sortedKeys(state.artistAlias)) artistAlias[key] = { ...state.artistAlias.get(key)! };

	const feedItems: FeedItemView[] = [];
	for (const key of sortedKeys(state.feedItems)) {
		const r = state.feedItems.get(key)!;
		const promoted = field<string | null>(r, 'promoted_recording_id', null);
		feedItems.push({
			key,
			state: field(r, 'state', null),
			promotedRecordingId: promoted === null ? null : resolveRecording(state, promoted),
			playedAt: field(r, 'played_at', null),
			listened: Object.keys(r.fields).filter((n) => n.startsWith(FEED_LISTEN_PREFIX)).map((n) => n.slice(FEED_LISTEN_PREFIX.length)).sort(compareKeys),
		});
	}
	const feedSuppressions: FeedSuppressionView[] = [];
	for (const key of sortedKeys(state.feedSuppressions)) {
		const r = state.feedSuppressions.get(key)!;
		feedSuppressions.push({ key, scope: field(r, 'scope', null), active: field(r, 'active', false) });
	}
	const albums: AlbumView[] = [];
	for (const key of sortedKeys(state.albums)) {
		const r = state.albums.get(key)!;
		const row: AlbumView = { key };
		for (const name of Object.keys(r.fields).sort()) row[name] = r.fields[name]!.value;
		albums.push(row);
	}

	return {
		tags: tags.sort(byId),
		trackTags,
		playlists,
		playlistFolders,
		playlistTracks,
		libraryTracks,
		cues,
		pinnedSearches,
		settings,
		playSessions,
		playEvents,
		claims,
		upstreamAcks,
		recordingAlias,
		artistAlias,
		feedItems,
		feedSuppressions,
		albums,
	};
}
