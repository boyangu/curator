// Bootstrap from a server snapshot (design: "Bootstrap, snapshots and
// history retention"). A snapshot is the user's state as the reducer's RAW
// records — clocks included — not the visible rows: an op pulled after
// `snapshotSeq` (or one still in this device's outbox) must still lose to a
// later write the snapshot already holds, and that comparison needs the
// clock of every cell.
//
// Wire format: @curator/protocol snapshot.ts (`serializeLibraryState` JSON,
// gzipped, base64, inline in `sync.bootstrap`). The transport does base64 +
// gunzip; `decodeLibraryStateSnapshot` parses with the protocol's decoder
// and flattens the state into records.
//
// Loading is a state join (store.ts joinRecord), then the same projection
// applyOps uses, for every record that changed. Merges replay first, as
// ops, so local records under a loser recording fold through the reducer.
// It runs in chunks, each its own transaction, yielding to the event loop
// between them — a 40k-track library is ~150k records. Each chunk is
// idempotent (a join is a max over clocks), so an interrupted bootstrap is
// simply run again; the cursor moves only when the last chunk is in.

import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { applyOp, deserializeLibraryState, opSchemaVersion, type ArtistAliasRecord, type Clock, type Entity, type EntityRef, type LibraryState, type MergeRecord, type Op } from '@curator/protocol';
import * as schema from '@curator/shared/schema';
import { drainArtistCreditRewritesAsync } from '../library/artist-alias.js';
import { applyTrackMerge } from '../library/merge-tracks.js';
import { markRecordsComplete } from './apply.js';
import { project } from './project.js';
import { STATE_MAPS, SyncStateStore, type StateMap } from './store.js';

type Raw = Database.Database;

export type SnapshotRecord =
	| { map: StateMap; key: string; value: unknown }
	| { map: 'tombstones'; key: string; value: Clock };

// The protocol's snapshot (`deserializeLibraryState` of the inflated JSON)
// as records for the loader. `recordingAlias` and `artistAlias` are derived
// from `merges` / `artistAliases` and rebuilt by the reducer, so they are not
// loaded.
export function recordsFromState(state: LibraryState): SnapshotRecord[] {
	const out: SnapshotRecord[] = [];
	for (const map of STATE_MAPS) {
		for (const [key, value] of state[map] as Map<string, unknown>) out.push({ map, key, value });
	}
	for (const [key, value] of state.tombstones) out.push({ map: 'tombstones', key, value });
	return out;
}

// Inflated snapshot JSON → records. Throws the protocol's
// SnapshotFormatError on a format/version this build cannot read.
export function decodeLibraryStateSnapshot(json: string): SnapshotRecord[] {
	return recordsFromState(deserializeLibraryState(json));
}

// Projection order: containers before the rows they gate, so a child's
// visibility check finds its container's row already written.
const LOAD_ORDER: Array<StateMap | 'tombstones'> = [
	'tombstones',
	'tags', 'playlistFolders', 'playlists', 'pinnedSearches', 'settings', 'playSessions',
	'libraryTracks', 'trackTags', 'playlistTracks', 'cues', 'playEvents', 'claims', 'upstreamAcks',
];

const ENTITY_OF: Record<Exclude<StateMap, 'merges' | 'artistAliases'>, Entity> = {
	tags: 'tag',
	trackTags: 'track_tag',
	playlists: 'playlist',
	playlistFolders: 'playlist_folder',
	playlistTracks: 'playlist_track',
	libraryTracks: 'library_track',
	cues: 'cue',
	pinnedSearches: 'pinned_search',
	settings: 'setting',
	playSessions: 'play_session',
	playEvents: 'play_event',
	claims: 'recording_claim',
	upstreamAcks: 'upstream',
};

// The ref projection reads for a joined record. Recording-keyed maps may
// have been re-keyed through the local alias map by the join.
function refOf(map: Exclude<StateMap, 'merges' | 'artistAliases'>, key: string, value: unknown, store: SyncStateStore): EntityRef {
	const R = (id: string): string => store.state.recordingAlias.get(id) ?? id;
	const v = value as Record<string, unknown>;
	switch (map) {
		case 'libraryTracks': return { entity: 'library_track', id: R(key) };
		case 'trackTags': return { entity: 'track_tag', id: `${R(v['recordingId'] as string)}:${v['tagId'] as string}` };
		case 'cues': return { entity: 'cue', id: `${R(v['recordingId'] as string)}:${v['slot'] as number}:${v['kind'] as string}` };
		case 'claims': return { entity: 'recording_claim', id: R(v['recordingId'] as string) };
		default: return { entity: ENTITY_OF[map], id: key };
	}
}

// A merge record as the op that produced it. A split keeps only the alias
// withdrawal, which is all the reducer does with one.
function mergeOp(loser: string, m: MergeRecord): Op {
	return {
		op_id: m.clock.op,
		device_id: m.clock.device,
		client_ts: m.clock.ts,
		schema_version: opSchemaVersion({ entity: 'recording', kind: 'merge' }),
		entity: 'recording',
		entity_id: loser,
		kind: m.winner === null ? 'split' : 'merge',
		payload: { winner: m.winner ?? '' },
	} as Op;
}

// An artist alias record as its op: replayed like merges, so the reducer
// rebuilds the resolved map and projection sees the change.
function artistAliasOp(key: string, r: ArtistAliasRecord): Op {
	const base = { op_id: r.clock.op, device_id: r.clock.device, client_ts: r.clock.ts, entity: 'artist_alias' as const, entity_id: key };
	return r.value === null
		? { ...base, schema_version: opSchemaVersion({ entity: 'artist_alias', kind: 'remove' }), kind: 'remove', payload: {} }
		: { ...base, schema_version: opSchemaVersion({ entity: 'artist_alias', kind: 'set' }), kind: 'set', payload: { ...r.value } };
}

export type SnapshotLoadResult = {
	records: number;
	changed: number;
	chunks: number;
	maxSliceMs: number;
	tracksTouched: string[];
	playlistsTouched: string[];
	changedRefs: EntityRef[];
};

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function loadSnapshot(
	raw: Raw,
	records: readonly SnapshotRecord[],
	opts: { chunk?: number; onProgress?: (p: { done: number; total: number }) => void } = {},
): Promise<SnapshotLoadResult> {
	const chunk = Math.max(1, opts.chunk ?? 2_000);
	const db = drizzle(raw, { schema });
	const mergeRows = (loser: string, winner: string): void => { applyTrackMerge(db, raw, winner, loser, { emit: false }); };
	const tracks = new Set<string>();
	const playlists = new Set<string>();
	const changedRefs: EntityRef[] = [];
	let changed = 0;
	let chunks = 0;
	let maxSliceMs = 0;
	let done = 0;

	// 1. Merges and artist alias rules, as ops through the reducer (alias
	// rebuilds + fold of local loser records), in one transaction: there are
	// few of them. The rules' credit rewrite is queued and drained after.
	const merges = records.filter((r) => r.map === 'merges' || r.map === 'artistAliases');
	if (merges.length > 0) {
		const t0 = performance.now();
		raw.transaction(() => {
			const store = new SyncStateStore(raw);
			const refs: EntityRef[] = [];
			const ops = [
				...merges.filter((r) => r.map === 'merges').map((r) => mergeOp(r.key, r.value as MergeRecord)),
				...merges.filter((r) => r.map === 'artistAliases').map((r) => artistAliasOp(r.key, r.value as ArtistAliasRecord)),
			];
			store.prefetch(ops);
			for (const op of ops) {
				store.touch(op);
				refs.push(...applyOp(store.state, op).changed);
			}
			const flushed = store.flush();
			const s = project(raw, store, refs, flushed, { mergeRows });
			for (const t of s.tracksTouched) tracks.add(t);
			for (const p of s.playlistsTouched) playlists.add(p);
			changedRefs.push(...refs);
			changed += refs.length;
		})();
		chunks++;
		done += merges.length;
		maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
		opts.onProgress?.({ done, total: records.length });
		await yieldToLoop();
	}

	// 2. Everything else, in projection order.
	const rank = new Map(LOAD_ORDER.map((m, i) => [m, i]));
	const rest = records.filter((r) => r.map !== 'merges' && r.map !== 'artistAliases').sort((a, b) => (rank.get(a.map) ?? 99) - (rank.get(b.map) ?? 99));
	for (let i = 0; i < rest.length; i += chunk) {
		const slice = rest.slice(i, i + chunk);
		const t0 = performance.now();
		raw.transaction(() => {
			const store = new SyncStateStore(raw);
			const refs: EntityRef[] = [];
			for (const r of slice) {
				if (r.map === 'tombstones') {
					const k = store.joinTombstone(r.key, r.value);
					if (k) {
						const at = k.indexOf(':');
						refs.push({ entity: k.slice(0, at) as Entity, id: k.slice(at + 1) });
					}
				} else if (r.map !== 'merges' && r.map !== 'artistAliases' && store.joinRecord(r.map, r.key, r.value)) {
					refs.push(refOf(r.map, r.key, r.value, store));
				}
			}
			const flushed = store.flush();
			const s = project(raw, store, refs, flushed, { mergeRows });
			for (const t of s.tracksTouched) tracks.add(t);
			for (const p of s.playlistsTouched) playlists.add(p);
			changedRefs.push(...refs);
			changed += refs.length;
		})();
		chunks++;
		done += slice.length;
		maxSliceMs = Math.max(maxSliceMs, performance.now() - t0);
		opts.onProgress?.({ done, total: records.length });
		if (i + chunk < rest.length) await yieldToLoop();
	}

	// Every visible row now came through the op log's records.
	markRecordsComplete(raw);
	// Credits the snapshot's alias rules rename, in yielding chunks.
	await drainArtistCreditRewritesAsync(raw);
	return { records: records.length, changed, chunks, maxSliceMs, tracksTouched: [...tracks], playlistsTouched: [...playlists], changedRefs };
}
