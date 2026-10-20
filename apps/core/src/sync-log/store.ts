// The reducer's raw records, persisted (cloud plan B4: "you need per-field
// clocks locally to do LWW").
//
// Storage decision. The merge rules live once, in @curator/protocol's
// `applyOp`. Rather than re-implement them over a per-field clock table, the
// desktop keeps the reducer's own records — every `LibraryState` map, clocks
// included — in `sync_state` (one JSON row per record) and `tombstone` (the
// `tombstones` map, whole clock), and runs `applyOp` on a PARTIAL in-memory
// state holding just the records a batch touches. A clock table alone would
// not be enough: converging in any arrival order needs the VALUE of an edit
// that arrived before its create (a shadow record), the add clock of a
// membership row whose move came first, and the full delete clock a cue
// upsert is compared against. With the records persisted, a local SQLite
// apply is the reducer by construction, which is what the B5 equivalence
// test checks.
//
// Loading is lazy and keyed: `touch(op)` loads exactly the records the
// reducer will read or write for that op (a recording merge loads every
// record of both recordings through the recording_id index). `flush()`
// writes back what changed and deletes what the reducer removed (a merge
// fold moves loser records to winner keys).
//
// Runs on the raw better-sqlite3 handle inside the caller's transaction.

import type Database from 'better-sqlite3';
import {
	compareClock,
	createLibraryState,
	parseCueEntityId,
	parseTrackTagEntityId,
	rebuildArtistAlias,
	resolveRecording,
	tombstoneKey,
	type Cell,
	type ArtistAliasTarget,
	type ClaimRecord,
	type Clock,
	type CueRecord,
	type LibraryState,
	type LwwRecord,
	type Op,
	type PlaylistTrackRecord,
	type TrackTagRecord,
} from '@curator/protocol';

type Raw = Database.Database;

// Every persisted LibraryState map. `tombstones` lives in its own table,
// `recordingAlias` is derived from `merges` (persisted as recording_alias)
// and `artistAlias` from `artistAliases` (rebuilt in memory on load: the
// artist table is its projection, see library/artist-alias.ts).
export const STATE_MAPS = [
	'tags',
	'trackTags',
	'playlists',
	'playlistFolders',
	'playlistTracks',
	'libraryTracks',
	'cues',
	'pinnedSearches',
	'settings',
	'playSessions',
	'playEvents',
	'claims',
	'upstreamAcks',
	'merges',
	'artistAliases',
] as const;
export type StateMap = (typeof STATE_MAPS)[number];

type AnyMap = Map<string, unknown>;

// The two index columns of a record: which recording it belongs to (for the
// merge fold) and which container gates it (for visibility cascades).
function indexOf(map: StateMap, key: string, value: unknown): { recordingId: string | null; parentId: string | null } {
	const v = value as Record<string, unknown>;
	switch (map) {
		case 'trackTags':
			return { recordingId: v['recordingId'] as string, parentId: v['tagId'] as string };
		case 'playlistTracks':
			return { recordingId: (v['recordingId'] as string | null) ?? null, parentId: (v['playlistId'] as string | null) ?? null };
		case 'libraryTracks':
			return { recordingId: key, parentId: null };
		case 'cues':
		case 'claims':
			return { recordingId: v['recordingId'] as string, parentId: null };
		case 'playEvents': {
			const body = v['value'] as Record<string, unknown>;
			return { recordingId: (body['recording_id'] as string | null) ?? null, parentId: (body['session_id'] as string | null) ?? null };
		}
		default:
			return { recordingId: null, parentId: null };
	}
}

// Recording part of a track_tag / cue tombstone key, for the index column.
function tombstoneRecording(entity: string, entityId: string): string | null {
	if (entity !== 'track_tag' && entity !== 'cue') return null;
	const i = entityId.indexOf(':');
	return i > 0 ? entityId.slice(0, i) : null;
}

function splitTombstoneKey(key: string): { entity: string; entityId: string } {
	const i = key.indexOf(':');
	return { entity: key.slice(0, i), entityId: key.slice(i + 1) };
}

type Stmts = {
	get: Database.Statement<[string, string], { value: string }>;
	byRecording: Database.Statement<[string], { map: string; key: string; value: string }>;
	byParent: Database.Statement<[string, string], { key: string; value: string }>;
	allOfMap: Database.Statement<[string], { key: string; value: string }>;
	put: Database.Statement<[string, string, string | null, string | null, string]>;
	del: Database.Statement<[string, string]>;
	tombGet: Database.Statement<[string, string], { client_ts: number; device_id: string | null; op_id: string | null }>;
	tombByRecording: Database.Statement<[string], { entity: string; entity_id: string; client_ts: number; device_id: string | null; op_id: string | null }>;
	tombPut: Database.Statement<[string, string, number, string, string, string | null]>;
	tombDel: Database.Statement<[string, string]>;
	aliasAll: Database.Statement<[], { loser: string; winner: string }>;
	aliasClear: Database.Statement<[]>;
	aliasPut: Database.Statement<[string, string]>;
};

const STMTS = new WeakMap<Raw, Stmts>();

function stmts(raw: Raw): Stmts {
	let s = STMTS.get(raw);
	if (!s) {
		s = {
			get: raw.prepare(`SELECT value FROM sync_state WHERE map = ? AND key = ?`),
			byRecording: raw.prepare(`SELECT map, key, value FROM sync_state WHERE recording_id = ?`),
			byParent: raw.prepare(`SELECT key, value FROM sync_state WHERE map = ? AND parent_id = ?`),
			allOfMap: raw.prepare(`SELECT key, value FROM sync_state WHERE map = ?`),
			put: raw.prepare(`INSERT INTO sync_state (map, key, recording_id, parent_id, value) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(map, key) DO UPDATE SET recording_id = excluded.recording_id, parent_id = excluded.parent_id, value = excluded.value`),
			del: raw.prepare(`DELETE FROM sync_state WHERE map = ? AND key = ?`),
			tombGet: raw.prepare(`SELECT client_ts, device_id, op_id FROM tombstone WHERE entity = ? AND entity_id = ?`),
			tombByRecording: raw.prepare(`SELECT entity, entity_id, client_ts, device_id, op_id FROM tombstone WHERE recording_id = ?`),
			tombPut: raw.prepare(`INSERT INTO tombstone (entity, entity_id, client_ts, device_id, op_id, recording_id) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT(entity, entity_id) DO UPDATE SET client_ts = excluded.client_ts, device_id = excluded.device_id,
					op_id = excluded.op_id, recording_id = excluded.recording_id`),
			tombDel: raw.prepare(`DELETE FROM tombstone WHERE entity = ? AND entity_id = ?`),
			aliasAll: raw.prepare(`SELECT loser, winner FROM recording_alias`),
			aliasClear: raw.prepare(`DELETE FROM recording_alias`),
			aliasPut: raw.prepare(`INSERT INTO recording_alias (loser, winner) VALUES (?, ?)`),
		};
		STMTS.set(raw, s);
	}
	return s;
}

// A tombstone row from before B4 (or written by hand) carries no device/op;
// the empty strings sort it below any real clock at the same ms.
function tombClock(r: { client_ts: number; device_id: string | null; op_id: string | null }): Clock {
	return { ts: r.client_ts, device: r.device_id ?? '', op: r.op_id ?? '' };
}

// A record removed by the reducer during this batch (a merge fold moving a
// loser record to the winner's key). Projection deletes its visible row.
export type RemovedRecord = { map: StateMap; key: string; value: unknown };

export type FlushResult = { removed: RemovedRecord[]; removedTombstones: string[]; aliasChanged: boolean };

// Keys per batched IN (...) lookup — well under SQLite's bound-parameter cap.
const PREFETCH_CHUNK = 400;


// `then`: what the emit side's no-op check reads on the OTHER side of a set
// entity — an add's tombstone, a remove's record — needed only when the
// first side exists (with no record an add is a change whatever its
// tombstone says, and a remove with no tombstone is too). Loading it
// conditionally keeps a fresh 2,000-row import from probing 2,000
// tombstones that cannot change the answer.
type Then = { map: StateMap; key: string; tomb: string; first: 'record' | 'tomb' };
type Wanted = { records: Array<[StateMap, string]>; tombstones: string[]; recordings: string[]; then: Then[] };

export class SyncStateStore {
	readonly state: LibraryState = createLibraryState();
	// JSON of each record as loaded (null = known absent), per map, so flush
	// writes only what the batch changed.
	private readonly snap = new Map<StateMap, Map<string, string | null>>(STATE_MAPS.map((m) => [m, new Map()]));
	private readonly tombSnap = new Map<string, string | null>();
	private readonly recordingsLoaded = new Set<string>();
	private readonly childrenLoaded = new Set<string>();
	private aliasSnap: string;
	private readonly s: Stmts;
	// The resolved artist alias map as loaded, before this batch: projection
	// diffs against it to find the rules whose effect changed.
	readonly artistAliasBefore: ReadonlyMap<string, ArtistAliasTarget>;

	constructor(private readonly raw: Raw) {
		this.s = stmts(raw);
		// Merges are few (one per user merge or catalogue alias) and the alias
		// rebuild reads all of them, so they load whole.
		for (const r of this.s.allOfMap.all('merges')) {
			this.state.merges.set(r.key, JSON.parse(r.value));
			this.snap.get('merges')!.set(r.key, r.value);
		}
		for (const r of this.s.aliasAll.all()) this.state.recordingAlias.set(r.loser, r.winner);
		this.aliasSnap = aliasJson(this.state.recordingAlias);
		// Artist alias rules are few and chain resolution reads all of them.
		for (const r of this.s.allOfMap.all('artistAliases')) {
			this.state.artistAliases.set(r.key, JSON.parse(r.value));
			this.snap.get('artistAliases')!.set(r.key, r.value);
		}
		rebuildArtistAlias(this.state);
		this.artistAliasBefore = new Map(this.state.artistAlias);
	}

	private map(name: StateMap): AnyMap {
		return this.state[name] as unknown as AnyMap;
	}

	ensure(name: StateMap, key: string): unknown {
		const snap = this.snap.get(name)!;
		if (!snap.has(key)) {
			const row = this.s.get.get(name, key);
			snap.set(key, row?.value ?? null);
			if (row) this.map(name).set(key, JSON.parse(row.value));
		}
		return this.map(name).get(key);
	}

	// Load everything a batch of ops will touch in a few IN (...) queries
	// instead of two point lookups per op — a 2,000-row import is one op per
	// row. Purely an optimisation: touch() still loads anything missed (a key
	// that only resolves after a merge earlier in the batch).
	//
	// `forRestatement` also loads the tombstones that decide whether an add /
	// upsert / create would only repeat what is visible (the emit side's
	// no-op check, reduce.ts `isRestatement`); applyOp itself never reads them.
	prefetch(ops: readonly Op[], opts: { forRestatement?: boolean } = {}): void {
		const records: Array<[StateMap, string]> = [];
		const tombstones: string[] = [];
		const then: Then[] = [];
		const recordings = new Set<string>();
		for (const op of ops) {
			const w = this.wanted(op, opts.forRestatement ?? false);
			records.push(...w.records);
			tombstones.push(...w.tombstones);
			then.push(...w.then);
			for (const r of w.recordings) recordings.add(r);
		}
		this.load(records, tombstones);
		if (then.length > 0) {
			// Second round, only behind a first side that exists.
			const more: Array<[StateMap, string]> = [];
			const moreTombs: string[] = [];
			for (const t of then) {
				if (t.first === 'record') { if (this.map(t.map).has(t.key)) moreTombs.push(t.tomb); }
				else if (this.state.tombstones.has(t.tomb)) more.push([t.map, t.key]);
			}
			this.load(more, moreTombs);
		}
		for (const r of recordings) this.ensureRecording(r);
	}

	// Batched load of whatever of these is not loaded yet.
	private load(records: ReadonlyArray<[StateMap, string]>, tombstones: readonly string[]): void {
		const byMap = new Map<StateMap, Set<string>>();
		const byEntity = new Map<string, Set<string>>();
		for (const [m, k] of records) {
			if (this.snap.get(m)!.has(k)) continue;
			let set = byMap.get(m);
			if (!set) byMap.set(m, (set = new Set()));
			set.add(k);
		}
		for (const t of tombstones) {
			if (this.tombSnap.has(t)) continue;
			const { entity, entityId } = splitTombstoneKey(t);
			let set = byEntity.get(entity);
			if (!set) byEntity.set(entity, (set = new Set()));
			set.add(entityId);
		}
		for (const [m, keys] of byMap) {
			const snap = this.snap.get(m)!;
			const all = [...keys];
			for (let i = 0; i < all.length; i += PREFETCH_CHUNK) {
				const chunk = all.slice(i, i + PREFETCH_CHUNK);
				const rows = this.raw.prepare(`SELECT key, value FROM sync_state WHERE map = ? AND key IN (${chunk.map(() => '?').join(',')})`).all(m, ...chunk) as Array<{ key: string; value: string }>;
				for (const r of rows) {
					snap.set(r.key, r.value);
					this.map(m).set(r.key, JSON.parse(r.value));
				}
				for (const k of chunk) if (!snap.has(k)) snap.set(k, null);
			}
		}
		for (const [entity, ids] of byEntity) {
			const all = [...ids];
			for (let i = 0; i < all.length; i += PREFETCH_CHUNK) {
				const chunk = all.slice(i, i + PREFETCH_CHUNK);
				const rows = this.raw.prepare(`SELECT entity_id, client_ts, device_id, op_id FROM tombstone WHERE entity = ? AND entity_id IN (${chunk.map(() => '?').join(',')})`).all(entity, ...chunk) as Array<{ entity_id: string; client_ts: number; device_id: string | null; op_id: string | null }>;
				for (const r of rows) {
					const key = `${entity}:${r.entity_id}`;
					const clock = tombClock(r);
					this.tombSnap.set(key, JSON.stringify(clock));
					this.state.tombstones.set(key, clock);
				}
				for (const id of chunk) { const key = `${entity}:${id}`; if (!this.tombSnap.has(key)) this.tombSnap.set(key, null); }
			}
		}
	}

	ensureTombstone(key: string): Clock | undefined {
		if (!this.tombSnap.has(key)) {
			const { entity, entityId } = splitTombstoneKey(key);
			const row = this.s.tombGet.get(entity, entityId);
			const clock = row ? tombClock(row) : null;
			this.tombSnap.set(key, clock ? JSON.stringify(clock) : null);
			if (clock) this.state.tombstones.set(key, clock);
		}
		return this.state.tombstones.get(key);
	}

	// Every record and tombstone of one recording — what a merge fold reads.
	ensureRecording(recordingId: string): void {
		if (this.recordingsLoaded.has(recordingId)) return;
		this.recordingsLoaded.add(recordingId);
		for (const r of this.s.byRecording.all(recordingId)) {
			const snap = this.snap.get(r.map as StateMap)!;
			if (snap.has(r.key)) continue; // already loaded (and maybe changed) this batch
			snap.set(r.key, r.value);
			this.map(r.map as StateMap).set(r.key, JSON.parse(r.value));
		}
		for (const r of this.s.tombByRecording.all(recordingId)) {
			const key = tombstoneKey(r.entity as Parameters<typeof tombstoneKey>[0], r.entity_id);
			if (this.tombSnap.has(key)) continue;
			const clock = tombClock(r);
			this.tombSnap.set(key, JSON.stringify(clock));
			this.state.tombstones.set(key, clock);
		}
	}

	// Every record of `name` gated by container `parentId` (a tag's
	// assignments, a playlist's rows, a session's events). Returns their keys.
	ensureChildren(name: 'trackTags' | 'playlistTracks' | 'playEvents', parentId: string): string[] {
		const ck = `${name}\u0000${parentId}`;
		if (!this.childrenLoaded.has(ck)) {
			this.childrenLoaded.add(ck);
			const snap = this.snap.get(name)!;
			for (const r of this.s.byParent.all(name, parentId)) {
				if (snap.has(r.key)) continue;
				snap.set(r.key, r.value);
				this.map(name).set(r.key, JSON.parse(r.value));
			}
		}
		const out: string[] = [];
		for (const [key, v] of this.map(name)) {
			if (indexOf(name, key, v).parentId === parentId) out.push(key);
		}
		return out;
	}

	// Exactly what `applyOp(state, op)` will read or write, under the alias
	// map as it stands now. A delete/remove reads and writes only its
	// tombstone (setTombstone compares clocks, so it must be loaded); every
	// other kind touches only the record. Projection loads whatever else it
	// needs for visibility itself.
	private wanted(op: Op, forRestatement = false): Wanted {
		const R = (id: string): string => resolveRecording(this.state, id);
		const w: Wanted = { records: [], tombstones: [], recordings: [], then: [] };
		const gone = op.kind === 'delete' || op.kind === 'remove';
		const one = (map: StateMap, entity: Parameters<typeof tombstoneKey>[0], key: string): Wanted => {
			const tomb = tombstoneKey(entity, key);
			if (gone) w.tombstones.push(tomb);
			else w.records.push([map, key]);
			// The no-op check reads both sides: whether a remove already holds
			// (the add it would cancel) and whether an add is visible (the
			// tombstone it must outlive).
			if (forRestatement) w.then.push({ map, key, tomb, first: gone ? 'tomb' : 'record' });
			return w;
		};
		const container = (map: StateMap, entity: 'tag' | 'playlist' | 'playlist_folder' | 'pinned_search'): Wanted => one(map, entity, op.entity_id);
		switch (op.entity) {
			case 'tag': return container('tags', 'tag');
			case 'playlist': return container('playlists', 'playlist');
			case 'playlist_folder': return container('playlistFolders', 'playlist_folder');
			case 'pinned_search': return container('pinnedSearches', 'pinned_search');
			case 'track_tag': {
				const p = parseTrackTagEntityId(op.entity_id)!;
				return one('trackTags', 'track_tag', `${R(p.recordingId)}:${p.tagId}`);
			}
			case 'playlist_track':
				if (op.kind === 'rekey') {
					for (const rowId of Object.keys(op.payload.keys)) w.records.push(['playlistTracks', rowId]);
					return w;
				}
				return one('playlistTracks', 'playlist_track', op.entity_id);
			case 'library_track':
				// Its delete is a field write (deleted_at), not a tombstone.
				w.records.push(['libraryTracks', R(op.entity_id)]);
				return w;
			case 'cue': {
				const p = parseCueEntityId(op.entity_id)!;
				return one('cues', 'cue', `${R(p.recordingId)}:${p.slot}:${p.kind}`);
			}
			case 'play_session': w.records.push(['playSessions', op.entity_id]); return w;
			case 'play_event': w.records.push(['playEvents', op.entity_id]); return w;
			case 'setting': w.records.push(['settings', op.entity_id]); return w;
			case 'recording_claim': w.records.push(['claims', `${R(op.entity_id)}:${op.payload.kind}:${op.payload.value}`]); return w;
			case 'upstream': w.records.push(['upstreamAcks', op.entity_id]); return w;
			// Its remove is a null rule in the record, not a tombstone.
			case 'artist_alias': w.records.push(['artistAliases', op.entity_id]); return w;
			case 'recording':
				// The fold moves the loser's records onto whatever the loser
				// resolves to after the alias rebuild — the winner or the end of
				// its chain — and merges with records already there.
				w.recordings.push(...new Set([op.entity_id, op.payload.winner, R(op.entity_id), R(op.payload.winner)]));
				return w;
		}
	}

	// Load what the next applyOp needs (after prefetch, all hits).
	touch(op: Op, opts: { forRestatement?: boolean } = {}): void {
		const w = this.wanted(op, opts.forRestatement ?? false);
		for (const [m, k] of w.records) this.ensure(m, k);
		for (const t of w.tombstones) this.ensureTombstone(t);
		for (const t of w.then) {
			if (t.first === 'record') { if (this.ensure(t.map, t.key) !== undefined) this.ensureTombstone(t.tomb); }
			else if (this.ensureTombstone(t.tomb) !== undefined) this.ensure(t.map, t.key);
		}
		for (const r of w.recordings) this.ensureRecording(r);
	}

	// ── re-stamp (server-clamped own op) ────────────────────────────────
	// Every clock in the loaded records that came from op `opId` takes the
	// server's `ts`: the server clamped this device's far-future stamp, and
	// every other device holds the op under the clamped clock. Callers touch
	// the op first so its records are loaded; flush persists the change.
	restampClock(opId: string, deviceId: string, ts: number): void {
		const fix = (v: unknown): void => {
			if (Array.isArray(v)) { for (const x of v) fix(x); return; }
			if (v === null || typeof v !== 'object') return;
			const o = v as Record<string, unknown>;
			if (o['op'] === opId && o['device'] === deviceId && typeof o['ts'] === 'number') { o['ts'] = ts; return; }
			for (const x of Object.values(o)) fix(x);
		};
		for (const name of STATE_MAPS) for (const v of this.map(name).values()) fix(v);
		for (const [k, c] of this.state.tombstones) {
			if (c.op === opId && c.device === deviceId) this.state.tombstones.set(k, { ...c, ts });
		}
	}

	// ── device re-mint (restored backup) ────────────────────────────────
	// Every clock in the loaded records that came from one of `opIds` takes
	// device `to`: those ops were re-stamped in the outbox with this
	// install's new id (remint.ts), and the server stores them under it, so
	// the LWW tie-break here must compare the same (ts, device) every other
	// device will. Callers prefetch the ops first; flush persists the change.
	reassignDevice(opIds: ReadonlySet<string>, to: string): void {
		const fix = (v: unknown): void => {
			if (Array.isArray(v)) { for (const x of v) fix(x); return; }
			if (v === null || typeof v !== 'object') return;
			const o = v as Record<string, unknown>;
			if (typeof o['op'] === 'string' && opIds.has(o['op']) && typeof o['device'] === 'string' && typeof o['ts'] === 'number') { o['device'] = to; return; }
			for (const x of Object.values(o)) fix(x);
		};
		for (const name of STATE_MAPS) for (const v of this.map(name).values()) fix(v);
		for (const [k, c] of this.state.tombstones) {
			if (opIds.has(c.op) && c.device !== to) this.state.tombstones.set(k, { ...c, device: to });
		}
	}

	// ── snapshot join (bootstrap) ───────────────────────────────────────
	// A snapshot is the server's raw records, clocks included. Loading one
	// onto local records is the state-based form of the reducer: every rule
	// in reduce.ts is a max over clocks per field (per cell, per add, per
	// tombstone), so taking the later clock of the two sides per cell gives
	// the state that applying both op sets would have — which is what lets a
	// far-behind device keep its unpushed edits through a bootstrap. Merges
	// are not joined here: the caller replays them as ops first, so the
	// fold of local loser records runs through the reducer itself.
	//
	// Keys are re-resolved through the local alias map: the snapshot was
	// folded under the server's merges, but this device may know a newer
	// one (in its outbox, not yet pushed). Returns whether anything changed.

	// Merges and artist alias rules are replayed as ops instead (see the
	// caller), so the reducer rebuilds what is derived from them.
	joinRecord(name: Exclude<StateMap, 'merges' | 'artistAliases'>, key: string, incoming: unknown): boolean {
		const R = (id: string): string => resolveRecording(this.state, id);
		const later = (cur: Clock | null | undefined, inc: Clock | null | undefined): boolean => !!inc && (!cur || compareClock(cur, inc) < 0);
		switch (name) {
			case 'tags':
			case 'playlists':
			case 'playlistFolders':
			case 'pinnedSearches':
			case 'playSessions':
			case 'libraryTracks': {
				const inc = incoming as LwwRecord;
				const id = name === 'libraryTracks' ? R(key) : key;
				let cur = this.ensure(name, id) as LwwRecord | undefined;
				let changed = false;
				if (!cur) {
					cur = { id, created: null, fields: {} };
					this.map(name).set(id, cur);
					changed = true;
				}
				if (later(cur.created, inc.created)) { cur.created = inc.created; changed = true; }
				for (const [field, cell] of Object.entries(inc.fields ?? {})) {
					if (later(cur.fields[field]?.clock, cell.clock)) { cur.fields[field] = { value: cell.value, clock: cell.clock }; changed = true; }
				}
				return changed;
			}
			case 'trackTags': {
				const inc = incoming as TrackTagRecord;
				const recordingId = R(inc.recordingId);
				const k = `${recordingId}:${inc.tagId}`;
				const cur = this.ensure(name, k) as TrackTagRecord | undefined;
				if (!cur) { this.map(name).set(k, { recordingId, tagId: inc.tagId, added: inc.added }); return true; }
				if (!later(cur.added, inc.added)) return false;
				cur.added = inc.added;
				return true;
			}
			case 'playlistTracks': {
				const inc = incoming as PlaylistTrackRecord;
				let cur = this.ensure(name, key) as PlaylistTrackRecord | undefined;
				let changed = false;
				if (!cur) {
					cur = { id: key, playlistId: null, recordingId: null, added: null, orderKey: null };
					this.map(name).set(key, cur);
					changed = true;
				}
				// The latest add binds the row (reduce.ts applyPlaylistTrack).
				if (later(cur.added, inc.added)) {
					cur.added = inc.added;
					cur.playlistId = inc.playlistId;
					cur.recordingId = inc.recordingId === null ? null : R(inc.recordingId);
					changed = true;
				}
				if (inc.orderKey && later(cur.orderKey?.clock, inc.orderKey.clock)) { cur.orderKey = { ...inc.orderKey }; changed = true; }
				return changed;
			}
			case 'cues': {
				const inc = incoming as CueRecord;
				const recordingId = R(inc.recordingId);
				const k = `${recordingId}:${inc.slot}:${inc.kind}`;
				const cur = this.ensure(name, k) as CueRecord | undefined;
				if (cur && !later(cur.cell.clock, inc.cell.clock)) return false;
				this.map(name).set(k, { ...inc, recordingId });
				return true;
			}
			case 'claims': {
				const inc = incoming as ClaimRecord;
				const recordingId = R(inc.recordingId);
				const k = `${recordingId}:${inc.kind}:${inc.value}`;
				const cur = this.ensure(name, k) as ClaimRecord | undefined;
				if (cur && !later(cur.cell.clock, inc.cell.clock)) return false;
				this.map(name).set(k, { ...inc, recordingId });
				return true;
			}
			case 'playEvents': {
				const inc = incoming as Cell<Record<string, unknown>>;
				const cur = this.ensure(name, key) as Cell | undefined;
				if (cur && !later(cur.clock, inc.clock)) return false;
				const rec = inc.value['recording_id'];
				this.map(name).set(key, { value: { ...inc.value, recording_id: typeof rec === 'string' ? R(rec) : rec ?? null }, clock: inc.clock });
				return true;
			}
			case 'settings':
			case 'upstreamAcks': {
				const inc = incoming as Cell;
				const cur = this.ensure(name, key) as Cell | undefined;
				if (cur && !later(cur.clock, inc.clock)) return false;
				this.map(name).set(key, { value: inc.value, clock: inc.clock });
				return true;
			}
		}
	}

	// `key` is `${entity}:${entityId}`; a track_tag / cue key is re-resolved
	// like its record. Returns the (possibly re-resolved) key when it changed.
	joinTombstone(key: string, clock: Clock): string | null {
		let k = key;
		const { entity, entityId } = splitTombstoneKey(key);
		if (entity === 'track_tag' || entity === 'cue') {
			const i = entityId.indexOf(':');
			if (i > 0) k = `${entity}:${resolveRecording(this.state, entityId.slice(0, i))}${entityId.slice(i)}`;
		}
		const cur = this.ensureTombstone(k);
		if (cur && compareClock(cur, clock) >= 0) return null;
		this.state.tombstones.set(k, clock);
		return k;
	}

	flush(): FlushResult {
		const removed: RemovedRecord[] = [];
		for (const name of STATE_MAPS) {
			const m = this.map(name);
			const snap = this.snap.get(name)!;
			for (const [key, v] of m) {
				const json = JSON.stringify(v);
				if (snap.get(key) === json) continue;
				const idx = indexOf(name, key, v);
				this.s.put.run(name, key, idx.recordingId, idx.parentId, json);
				snap.set(key, json);
			}
			for (const [key, json] of snap) {
				if (json === null || m.has(key)) continue;
				this.s.del.run(name, key);
				removed.push({ map: name, key, value: JSON.parse(json) });
				snap.set(key, null);
			}
		}

		const removedTombstones: string[] = [];
		for (const [key, clock] of this.state.tombstones) {
			const json = JSON.stringify(clock);
			if (this.tombSnap.get(key) === json) continue;
			const { entity, entityId } = splitTombstoneKey(key);
			this.s.tombPut.run(entity, entityId, clock.ts, clock.device, clock.op, tombstoneRecording(entity, entityId));
			this.tombSnap.set(key, json);
		}
		for (const [key, json] of this.tombSnap) {
			if (json === null || this.state.tombstones.has(key)) continue;
			const { entity, entityId } = splitTombstoneKey(key);
			this.s.tombDel.run(entity, entityId);
			removedTombstones.push(key);
			this.tombSnap.set(key, null);
		}

		const alias = aliasJson(this.state.recordingAlias);
		const aliasChanged = alias !== this.aliasSnap;
		if (aliasChanged) {
			this.s.aliasClear.run();
			for (const [loser, winner] of this.state.recordingAlias) this.s.aliasPut.run(loser, winner);
			this.aliasSnap = alias;
		}
		return { removed, removedTombstones, aliasChanged };
	}
}

function aliasJson(m: Map<string, string>): string {
	return JSON.stringify([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}
