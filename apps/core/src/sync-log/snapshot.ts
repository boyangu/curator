// Bootstrap from a server snapshot (design: "Bootstrap, snapshots and
// history retention"). A snapshot is the user's state as the reducer's RAW
// records — clocks included — not the visible rows: an op pulled after
// `snapshotSeq` (or one still in this device's outbox) must still lose to a
// later write the snapshot already holds, and that comparison needs the
// clock of every cell.
//
// Wire format: @curator/protocol snapshot.ts (`serializeLibraryState` JSON,
// gzipped, in parts in Storage, published by the account's master;
// `sync.bootstrap` names the manifest). The transport downloads, checks and
// inflates (snapshot-storage.ts) and hands the JSON over as text in pieces.
//
// The document is never held whole (`loadSnapshotText`). The main library's
// is ~250 MB of JSON, ~310k records: parsed in one go and loaded from memory,
// a join peaked at 3 GB on the desktop and could not run on a phone at all
// (measured 2026-11-20). Instead the text is cut into its entries as it
// arrives (the protocol's SnapshotEntryScanner) and each entry is put, still
// as text, into a scratch database SQLite keeps in a temporary file; the
// loader then reads it back map by map, a couple of thousand records at a
// time. The scratch is needed because the document's map order is not the
// load order below, and that order is not negotiable.
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
import { applyOp, deserializeLibraryState, opSchemaVersion, SnapshotEntryScanner, type ArtistAliasRecord, type Clock, type Entity, type EntityRef, type LibraryState, type MergeRecord, type Op, type SnapshotEntry } from '@curator/protocol';
import * as schema from '@curator/shared/schema';
import { drainArtistCreditRewritesAsync } from '../library/artist-alias.js';
import { applyTrackMerge } from '../library/merge-tracks.js';
import { markRecordsComplete } from './apply.js';
import { project } from './project.js';
import { settlePlaylistsAsync } from './remote-rows.js';
import { sliceMs } from './slice-budget.js';
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

// Inflated snapshot JSON → records, all at once: for tests and tools over
// small states. The sync client loads a snapshot with `loadSnapshotText`.
// Throws the protocol's SnapshotFormatError on a format/version this build
// cannot read.
export function decodeLibraryStateSnapshot(json: string): SnapshotRecord[] {
	return recordsFromState(deserializeLibraryState(json));
}

// The inflated snapshot JSON in pieces of any size, in order: what a
// transport's bootstrap hands the client.
export type SnapshotText = AsyncIterable<string> | Iterable<string>;

// Projection order: containers before the rows they gate, so a child's
// visibility check finds its container's row already written.
const LOAD_ORDER: Array<StateMap | 'tombstones'> = [
	'tombstones',
	'tags', 'playlistFolders', 'playlists', 'pinnedSearches', 'settings', 'playSessions',
	'libraryTracks', 'trackTags', 'playlistTracks', 'cues', 'playEvents', 'claims', 'upstreamAcks',
	'feedItems', 'feedSuppressions', 'albums',
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
	feedItems: 'feed_item',
	feedSuppressions: 'feed_suppression',
	albums: 'album',
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

// Where the loader takes its records from: everything in memory (tests,
// tools), or the scratch a snapshot's text was put into.
type RecordSource = {
	total: number;
	// The merges and artist alias rules, whole: a few thousand, replayed first.
	rules(): SnapshotRecord[];
	// Everything else in LOAD_ORDER, a piece at a time; a piece holds one map's records.
	pieces(): Iterable<SnapshotRecord[]>;
};

function recordsSource(records: readonly SnapshotRecord[]): RecordSource {
	const rank = new Map(LOAD_ORDER.map((m, i) => [m, i]));
	return {
		total: records.length,
		rules: () => records.filter((r) => r.map === 'merges' || r.map === 'artistAliases'),
		pieces: () => [records.filter((r) => r.map !== 'merges' && r.map !== 'artistAliases').sort((a, b) => (rank.get(a.map) ?? 99) - (rank.get(b.map) ?? 99))],
	};
}

// ── the scratch ─────────────────────────────────────────────────────────────
// `ATTACH DATABASE ''` is a private database in a temporary file that SQLite
// deletes when it is detached or the connection closes: nothing to clean up
// after a crash, and no file API for a phone to supply. Entries keep the
// order the document had within their map (`n`).

const SCRATCH = 'snapshot_scratch';

function entryRecord(map: StateMap | 'tombstones', json: string): SnapshotRecord {
	const [key, value] = JSON.parse(json) as [string, unknown];
	return { map, key, value } as SnapshotRecord;
}

function scratchSource(raw: Raw, counts: ReadonlyMap<string, number>, piece: number): RecordSource {
	const all = raw.prepare(`SELECT json FROM ${SCRATCH}.entry WHERE map = ? ORDER BY n`).pluck();
	const page = raw.prepare(`SELECT json FROM ${SCRATCH}.entry WHERE map = ? AND n > ? ORDER BY n LIMIT ?`).pluck();
	return {
		total: [...counts.values()].reduce((a, b) => a + b, 0),
		rules: () => (['merges', 'artistAliases'] as const).flatMap((map) => (all.all(map) as string[]).map((json) => entryRecord(map, json))),
		*pieces() {
			for (const map of LOAD_ORDER) {
				const n = counts.get(map) ?? 0;
				for (let at = 0; at < n; at += piece) yield (page.all(map, at, piece) as string[]).map((json) => entryRecord(map, json));
			}
		},
	};
}

// The text, entry by entry, into the scratch. Returns how many entries each
// loaded map holds. One transaction per piece of text, a yield after each:
// a transport that hands over about a megabyte at a time keeps each under
// the slice budget.
async function spillText(raw: Raw, text: SnapshotText, onEntries: (n: number) => void): Promise<Map<string, number>> {
	raw.exec(`CREATE TABLE ${SCRATCH}.entry (map TEXT NOT NULL, n INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (map, n)) WITHOUT ROWID`);
	const put = raw.prepare(`INSERT INTO ${SCRATCH}.entry (map, n, json) VALUES (?, ?, ?)`);
	// `recordingAlias` and `artistAlias` are derived (recordsFromState), and
	// a map a newer writer added is not this build's to load.
	const loaded = new Set<string>([...STATE_MAPS, 'tombstones']);
	const counts = new Map<string, number>();
	let total = 0;
	const store = raw.transaction((entries: SnapshotEntry[]): void => {
		for (const e of entries) {
			if (!loaded.has(e.map)) continue;
			const n = (counts.get(e.map) ?? 0) + 1;
			counts.set(e.map, n);
			put.run(e.map, n, e.json);
			total++;
		}
	});
	const scanner = new SnapshotEntryScanner();
	for await (const piece of text) {
		const entries = scanner.push(piece);
		if (entries.length > 0) {
			store(entries);
			onEntries(total);
		}
		await yieldToLoop();
	}
	scanner.end();
	return counts;
}

// Loads the account's snapshot from its inflated JSON text without ever
// holding the document or its records whole (see the header). Same result
// and the same slices as `loadSnapshot` over the same records.
export async function loadSnapshotText(
	raw: Raw,
	text: SnapshotText,
	opts: { chunk?: number; onProgress?: (p: { done: number; total: number }) => void; onSlice?: (s: SnapshotSlice) => void } = {},
): Promise<SnapshotLoadResult> {
	raw.exec(`ATTACH DATABASE '' AS ${SCRATCH}`);
	try {
		// While the text is still arriving the total is what has arrived.
		const counts = await spillText(raw, text, (n) => opts.onProgress?.({ done: 0, total: n }));
		return await loadFrom(raw, scratchSource(raw, counts, Math.max(1, opts.chunk ?? 2_000)), opts);
	} finally {
		raw.exec(`DETACH DATABASE ${SCRATCH}`);
	}
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

// Each transaction aims at this long on the main loop, well under the 100 ms
// a slice may take: a record's cost varies within a map too (a commit that
// checkpoints the WAL). Fixed chunks of 2,000 records measured 3.0-3.7 s for
// one slice on the real library (2026-10-21 audit): the cost per record
// differs a hundredfold between maps. The desktop's budget: a host with a
// sync thread of its own scales it (slice-budget.ts).
const SNAPSHOT_SLICE_MS = 40;
const FIRST_CHUNK = 100;
const MIN_CHUNK = 10;

export type SnapshotSlice = { phase: 'merges' | 'records'; map: string; records: number; ms: number };

// The same load from records already in memory (tests, tools, small states).
export async function loadSnapshot(
	raw: Raw,
	records: readonly SnapshotRecord[],
	opts: { chunk?: number; onProgress?: (p: { done: number; total: number }) => void; onSlice?: (s: SnapshotSlice) => void } = {},
): Promise<SnapshotLoadResult> {
	return loadFrom(raw, recordsSource(records), opts);
}

async function loadFrom(
	raw: Raw,
	source: RecordSource,
	opts: { chunk?: number; onProgress?: (p: { done: number; total: number }) => void; onSlice?: (s: SnapshotSlice) => void },
): Promise<SnapshotLoadResult> {
	// `chunk`: the most records one transaction takes (tests pin it small).
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

	// Playlist positions and counts are restamped once per playlist after the
	// last slice (remote-rows.ts settlePlaylistsAsync), not in every slice
	// that adds one of their rows. The artists and albums of the remote rows
	// made here are likewise left whole to the client's drain, which runs
	// once every record is in (project.ts deferDerivations).
	const deferred = new Set<string>();

	// Slices sized by time: the next one's size aims at SNAPSHOT_SLICE_MS
	// from the last one's cost, never spans two maps (a tombstone join is a
	// clock compare, a playlist row a projection), and each map starts small.
	// The size carries over from one call to the next while the map stays
	// the same: a map arrives in several pieces from the scratch.
	let size = FIRST_CHUNK;
	let sizedFor: string | null = null;
	const sliced = async <T>(items: readonly T[], mapOf: (t: T) => string, phase: SnapshotSlice['phase'], run: (slice: readonly T[]) => void): Promise<void> => {
		if (items.length > 0 && mapOf(items[0]!) !== sizedFor) size = FIRST_CHUNK;
		for (let i = 0; i < items.length;) {
			const map = mapOf(items[i]!);
			sizedFor = map;
			let end = i + 1;
			while (end < items.length && end - i < size && mapOf(items[end]!) === map) end++;
			const slice = items.slice(i, end);
			const t0 = performance.now();
			run(slice);
			const ms = performance.now() - t0;
			chunks++;
			done += slice.length;
			maxSliceMs = Math.max(maxSliceMs, ms);
			opts.onSlice?.({ phase, map, records: slice.length, ms });
			opts.onProgress?.({ done, total: source.total });
			i = end;
			size = i < items.length && mapOf(items[i]!) !== map
				? FIRST_CHUNK
				: Math.max(MIN_CHUNK, Math.min(chunk, Math.ceil(size * 1.5), Math.round(slice.length * sliceMs(SNAPSHOT_SLICE_MS) / Math.max(ms, 1))));
			await yieldToLoop();
		}
	};

	// 1. Merges and artist alias rules, as ops through the reducer (alias
	// rebuilds + fold of local loser records), in order, each slice its own
	// transaction (3,521 merges on the real library: one transaction for
	// all of them held the loop for seconds). The rules' credit rewrite is
	// queued and drained after.
	const rules = source.rules();
	const ops = [
		...rules.filter((r) => r.map === 'merges').map((r) => mergeOp(r.key, r.value as MergeRecord)),
		...rules.filter((r) => r.map === 'artistAliases').map((r) => artistAliasOp(r.key, r.value as ArtistAliasRecord)),
	];
	await sliced(ops, (o) => o.entity, 'merges', (slice) => {
		raw.transaction(() => {
			const store = new SyncStateStore(raw);
			const refs: EntityRef[] = [];
			store.prefetch(slice);
			for (const op of slice) {
				store.touch(op);
				refs.push(...applyOp(store.state, op).changed);
			}
			const flushed = store.flush();
			const s = project(raw, store, refs, flushed, { mergeRows, deferPositions: deferred, deferDerivations: true });
			for (const t of s.tracksTouched) tracks.add(t);
			for (const p of s.playlistsTouched) playlists.add(p);
			changedRefs.push(...refs);
			changed += refs.length;
		})();
	});

	// 2. Everything else, in projection order.
	for (const rest of source.pieces()) await sliced(rest, (r) => r.map, 'records', (slice) => {
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
			const s = project(raw, store, refs, flushed, { mergeRows, deferPositions: deferred, deferDerivations: true });
			for (const t of s.tracksTouched) tracks.add(t);
			for (const p of s.playlistsTouched) playlists.add(p);
			changedRefs.push(...refs);
			changed += refs.length;
		})();
	});

	maxSliceMs = Math.max(maxSliceMs, await settlePlaylistsAsync(raw, deferred));
	// Every visible row now came through the op log's records.
	markRecordsComplete(raw);
	// Credits the snapshot's alias rules rename, in yielding chunks.
	await drainArtistCreditRewritesAsync(raw);
	return { records: source.total, changed, chunks, maxSliceMs, tracksTouched: [...tracks], playlistsTouched: [...playlists], changedRefs };
}
