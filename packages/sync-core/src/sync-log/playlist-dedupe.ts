// Fold the doubled rows two devices left in one streaming playlist (cloud
// plan: streaming identity §4). Before stable member ids (stable-ids.ts),
// each desktop that imported a Spotify or Tidal playlist added every entry
// under a random row id; once the identity resolver merges the two
// devices' recordings for one provider track, the playlist holds that
// track's rows twice — once per importing device. Nothing upstream
// changed, so nothing would ever remove them.
//
// THE RULE, per streaming playlist and per GROUP OF UPSTREAM ITEMS, computed
// from the synced records only so every device that looks reaches the same
// answer:
//   - a group is the rows whose recordings share a provider track id
//     (their own claims of the playlist's provider, joined transitively):
//     the upstream items a row can stand for. Usually one recording; but an
//     old ISRC bind on one device folded two releases of a song (two
//     provider ids, one ISRC) into one recording, while another device kept
//     a recording per release — the 2026-10-20 dry run's "Astral Traveling"
//     playlist, whose two "Back Stabbers" items came out three rows when
//     grouped per recording. Grouped by the items they can stand for, each
//     device's rows count the same thing;
//   - group the rows by the device whose add bound them (the add clock's
//     device): one device's rows are one import of the provider list;
//   - rows under a provider-derived id (stable-ids.ts) name their item
//     exactly — every device converges on them — so they always stay, and
//     cover that many of the group's items;
//   - the group holds N items: the largest device set (an import made after
//     the provider list gained a duplicate holds it twice; the other
//     import's single row is the stale one), and at least the derived rows.
//     Keep one device's random-id rows — the device with the most rows, then
//     the earliest add (the original import), then device id — up to the
//     items the derived rows leave uncovered (preferring rows whose
//     recording names an item no derived row names), and remove every other
//     random-id row;
//   - never remove a row whose add the user made (it carries an upstream
//     ack, F23: a deliberate add, maybe of a second copy). It still counts
//     toward its device's set.
// Local, rekordbox and smart playlists are never touched: their rows are
// the user's, and a duplicate there is the user's choice.
//
// Runs where merges make doubles visible: inside each identity merge
// chunk's transaction (identity.ts), after a pull whose merges moved
// recordings (client.ts), and once over every streaming playlist
// (STREAMING_DEDUPE_KEY). Several devices emitting the same removes is
// idempotent.

import type Database from 'better-sqlite3';
import { compareClock, type Clock, type EntityRef, type PlaylistTrackRecord } from '@curator/protocol';
import { emitOps, observeServerTs } from './outbox.js';
import { project } from './project.js';
import { streamingMemberId } from './stable-ids.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

// The one-time sweep over every streaming playlist (client.ts).
export const STREAMING_DEDUPE_KEY = 'sync.heal.streaming_dedupe_at';

const STREAMING = new Set(['spotify', 'tidal']);
const CHUNK = 400;

export type DedupeRemove = { playlistId: string; rowId: string; recordingId: string; device: string; addedTs: number };

export type DedupePlan = {
	playlists: number;
	// Item groups that held rows to fold.
	groups: number;
	removes: DedupeRemove[];
	// Per playlist: rows to remove (the report's "excess rows").
	byPlaylist: Map<string, number>;
};

export type DedupeScope = {
	// Only these playlists (default: every streaming playlist).
	playlists?: Iterable<string>;
	// Only groups holding rows of these recordings (resolved); the playlists
	// holding them are found through the record index, and so are the other
	// recordings that share a provider id with them.
	recordings?: Iterable<string>;
	// Extra loser → winner pairs on top of recording_alias: the read-only
	// report plans the dedupe as it would stand after the planned merges.
	alias?: ReadonlyMap<string, string>;
};

type Row = { id: string; rec: PlaylistTrackRecord; tomb: number | null };
type LiveRow = Row & { recording: string };

function aliasResolver(raw: Raw, extra?: ReadonlyMap<string, string>): (id: string) => string {
	const alias = new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
	return (id) => {
		let cur = id;
		for (let hops = 0; hops < 16; hops++) {
			const next = extra?.get(cur) ?? alias.get(cur);
			if (!next || next === cur) return cur;
			cur = next;
		}
		return cur;
	};
}

// Live streaming playlists by the records: created, not tombstoned, source
// link spotify or tidal. Keyed by id → source.
function streamingPlaylists(raw: Raw, only?: readonly string[]): Map<string, string> {
	const out = new Map<string, string>();
	const pick = (rows: Array<{ key: string; src: string | null; created: number | null; tomb: number | null }>): void => {
		for (const r of rows) if (r.src && STREAMING.has(r.src) && r.created !== null && r.tomb === null) out.set(r.key, r.src);
	};
	const sql = (where: string): string => `SELECT s.key, json_extract(s.value, '$.fields.source_link.value.source') AS src,
		json_extract(s.value, '$.created.ts') AS created, t.client_ts AS tomb
		FROM sync_state s LEFT JOIN tombstone t ON t.entity = 'playlist' AND t.entity_id = s.key
		WHERE s.map = 'playlists' ${where}`;
	if (!only) {
		pick(raw.prepare(sql('')).all() as never);
		return out;
	}
	for (let i = 0; i < only.length; i += CHUNK) {
		const chunk = only.slice(i, i + CHUNK);
		pick(raw.prepare(sql(`AND s.key IN (${chunk.map(() => '?').join(',')})`)).all(...chunk) as never);
	}
	return out;
}

// Provider ids (of `source`) a recording claims, read once per recording
// per plan. `+map`: without it the planner takes (map, parent_id) and walks
// every claim of the account per lookup (measured 2026-10-20: ~110 ms of a
// 50-merge chunk's ~130 at 10k claims; ~1 ms with it).
// `prefetch` reads a whole sweep chunk's recordings in a few IN (...)
// queries instead of one each (a chunk of playlists holds thousands).
function claimReader(raw: Raw): { prefetch(recordings: Iterable<string>): void; of(recording: string, source: string): string[] } {
	const claimsOf = raw.prepare(`SELECT key FROM sync_state WHERE +map = 'claims' AND recording_id = ?`).pluck();
	const keys = new Map<string, string[]>();
	const keysOf = (recording: string): string[] => {
		let v = keys.get(recording);
		if (!v) keys.set(recording, (v = claimsOf.all(recording) as string[]));
		return v;
	};
	return {
		prefetch(recordings) {
			const want = [...new Set(recordings)].filter((r) => !keys.has(r));
			for (let i = 0; i < want.length; i += CHUNK) {
				const chunk = want.slice(i, i + CHUNK);
				for (const r of chunk) keys.set(r, []);
				for (const row of raw.prepare(`SELECT recording_id AS rec, key FROM sync_state WHERE +map = 'claims' AND recording_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{ rec: string; key: string }>) {
					keys.get(row.rec)?.push(row.key);
				}
			}
		},
		of(recording, source) {
			const prefix = `${recording}:${source}:`;
			return keysOf(recording).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
		},
	};
}

// The recordings that share a streaming provider id with `seed`, two hops
// out through the claim index: the rest of a scoped run's item groups.
function siblingRecordings(raw: Raw, seed: ReadonlySet<string>, R: (id: string) => string): Set<string> {
	const out = new Set(seed);
	const claims = raw.prepare(`SELECT key FROM sync_state WHERE +map = 'claims' AND recording_id = ?`).pluck();
	const claimants = raw.prepare(`SELECT recording_id FROM sync_state WHERE map = 'claims' AND parent_id = ?`).pluck();
	let frontier = [...seed];
	for (let hop = 0; hop < 2 && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const rec of frontier) {
			for (const key of claims.all(rec) as string[]) {
				// key: `${recording}:${kind}:${value}`, parent_id: `${kind}:${value}`.
				const parentId = key.slice(rec.length + 1);
				if (!STREAMING.has(parentId.slice(0, parentId.indexOf(':')))) continue;
				for (const other of claimants.all(parentId) as Array<string | null>) {
					if (!other) continue;
					const o = R(other);
					if (!out.has(o)) { out.add(o); next.push(o); }
				}
			}
		}
		frontier = next;
	}
	return out;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// The provider item a derived row id names (`${providerId}#${occurrence}`),
// or null for a random id.
function derivedItem(rowId: string, playlistId: string, providerIds: readonly string[], occurrences: number): string | null {
	for (const p of providerIds) {
		for (let k = 0; k < occurrences; k++) {
			for (let bump = 0; bump < 3; bump++) if (streamingMemberId(playlistId, p, k, bump) === rowId) return `${p}#${k}`;
		}
	}
	return null;
}

export function planStreamingDedupe(raw: Raw, scope: DedupeScope = {}): DedupePlan {
	const plan: DedupePlan = { playlists: 0, groups: 0, removes: [], byPlaylist: new Map() };
	const R = aliasResolver(raw, scope.alias);
	const wanted = scope.recordings ? new Set([...scope.recordings].map(R)) : null;

	// The live rows in scope, by playlist. Scoped by recordings (a merge
	// chunk, a pull), only the rows of those recordings and of the ones
	// sharing a provider id with them are read, through the record index: a
	// 5,000-row playlist is not re-read per chunk. An applied merge's fold
	// re-points every row record (and its index column) to the winner; the
	// report's planned merges have not folded, so their losers' rows are read
	// under the loser too.
	type Stored = { key: string; value: string; tomb: number | null };
	const rowsByPlaylist = new Map<string, Row[]>();
	const take = (rows: Stored[]): void => {
		for (const r of rows) {
			const rec = JSON.parse(r.value) as PlaylistTrackRecord;
			if (!rec.playlistId) continue;
			let list = rowsByPlaylist.get(rec.playlistId);
			if (!list) rowsByPlaylist.set(rec.playlistId, (list = []));
			list.push({ id: r.key, rec, tomb: r.tomb });
		}
	};
	// `+s.map`: keeps the planner on the recording_id index for the scoped
	// read instead of (map, parent_id), which would walk every membership
	// record of the account.
	const ROWS = `SELECT s.key, s.value, t.client_ts AS tomb FROM sync_state s
		LEFT JOIN tombstone t ON t.entity = 'playlist_track' AND t.entity_id = s.key
		WHERE +s.map = 'playlistTracks'`;
	if (wanted && !scope.playlists) {
		if (wanted.size === 0) return plan;
		const members = siblingRecordings(raw, wanted, R);
		if (scope.alias) for (const [loser] of scope.alias) if (members.has(R(loser))) members.add(loser);
		const ids = [...members];
		for (let i = 0; i < ids.length; i += CHUNK) {
			const chunk = ids.slice(i, i + CHUNK);
			take(raw.prepare(`${ROWS} AND s.recording_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Stored[]);
		}
	}
	const playlists = streamingPlaylists(raw, scope.playlists ? [...new Set(scope.playlists)] : wanted ? [...rowsByPlaylist.keys()] : undefined);
	if (playlists.size === 0) return plan;
	if (!wanted || scope.playlists) {
		const byParent = raw.prepare(`SELECT s.key, s.value, t.client_ts AS tomb FROM sync_state s
			LEFT JOIN tombstone t ON t.entity = 'playlist_track' AND t.entity_id = s.key
			WHERE s.map = 'playlistTracks' AND s.parent_id = ?`);
		for (const pid of playlists.keys()) take(byParent.all(pid) as Stored[]);
	}

	const acked = new Set(raw.prepare(`SELECT key FROM sync_state WHERE map = 'upstreamAcks'`).pluck().all() as string[]);
	const claims = claimReader(raw);
	const providerIdsOf = (recording: string, source: string): string[] => claims.of(recording, source);
	claims.prefetch([...rowsByPlaylist.values()].flatMap((rows) => rows.flatMap((r) => (r.rec.recordingId ? [R(r.rec.recordingId), r.rec.recordingId] : []))));

	for (const [playlistId, source] of playlists) {
		plan.playlists++;
		// Alive as playlistTrackAlive: an add with an order key that no later
		// remove cancelled (add wins a same-ms tie).
		const live: LiveRow[] = [];
		for (const row of rowsByPlaylist.get(playlistId) ?? []) {
			const rec = row.rec;
			if (!rec.added || !rec.orderKey || !rec.recordingId || rec.playlistId !== playlistId) continue;
			if (row.tomb !== null && row.tomb > rec.added.ts) continue;
			live.push({ ...row, recording: R(rec.recordingId) });
		}
		if (live.length < 2) continue;
		// Each recording's provider ids: its own claims and those of every
		// recording its rows were added under (a merged-away loser).
		const ids = new Map<string, Set<string>>();
		for (const row of live) {
			let set = ids.get(row.recording);
			if (!set) ids.set(row.recording, (set = new Set(providerIdsOf(row.recording, source))));
			if (row.rec.recordingId !== row.recording) for (const p of providerIdsOf(row.rec.recordingId!, source)) set.add(p);
		}
		// Item groups: recordings joined by a shared provider id (union-find,
		// the smaller id as root so every device builds the same groups).
		const parent = new Map<string, string>();
		const find = (x: string): string => {
			let r = x;
			while (parent.get(r) !== r) r = parent.get(r)!;
			for (let c = x; c !== r;) { const n = parent.get(c)!; parent.set(c, r); c = n; }
			return r;
		};
		const byProvider = new Map<string, string>();
		for (const [rec, set] of ids) {
			if (!parent.has(rec)) parent.set(rec, rec);
			for (const p of set) {
				const other = byProvider.get(p);
				if (other === undefined) { byProvider.set(p, rec); continue; }
				const a = find(rec);
				const b = find(other);
				if (a !== b) parent.set(byCodeUnit(a, b) <= 0 ? b : a, byCodeUnit(a, b) <= 0 ? a : b);
			}
		}
		const groups = new Map<string, LiveRow[]>();
		for (const row of live) {
			const g = find(row.recording);
			let list = groups.get(g);
			if (!list) groups.set(g, (list = []));
			list.push(row);
		}
		for (const rows of groups.values()) {
			if (rows.length < 2) continue;
			if (wanted && !rows.some((r) => wanted.has(r.recording))) continue;
			const byDevice = new Map<string, LiveRow[]>();
			for (const row of rows) {
				const d = row.rec.added!.device;
				let list = byDevice.get(d);
				if (!list) byDevice.set(d, (list = []));
				list.push(row);
			}
			// One import's rows, all of them its items (a duplicate upstream).
			if (byDevice.size < 2) continue;
			const providerIds = [...new Set(rows.flatMap((r) => [...ids.get(r.recording)!]))].sort(byCodeUnit);
			const derived = new Map<string, string>();
			if (providerIds.length > 0) {
				for (const row of rows) {
					const item = derivedItem(row.id, playlistId, providerIds, rows.length + 8);
					if (item !== null) derived.set(row.id, item);
				}
			}
			const random = rows.filter((r) => !derived.has(r.id));
			if (random.length === 0) continue;
			plan.groups++;
			const earliest = (list: Row[]): Clock => list.map((r) => r.rec.added!).reduce((a, b) => (compareClock(a, b) <= 0 ? a : b));
			const order = [...byDevice.entries()].sort(([da, la], [db, lb]) =>
				lb.length - la.length || compareClock(earliest(la), earliest(lb)) || byCodeUnit(da, db));
			const keeper = order[0]![0];
			const items = Math.max(order[0]![1].length, derived.size);
			const covered = new Set([...derived.values()].map((item) => item.slice(0, item.lastIndexOf('#'))));
			const namesUncovered = (r: LiveRow): number => ([...ids.get(r.recording)!].some((p) => !covered.has(p)) ? 0 : 1);
			// Rows that stay whatever the count says — derived ones and the
			// user's acked adds — fill the items first; the keeper's other
			// random rows fill what is left, ones naming an item no derived
			// row covers first, then the earliest add.
			const isAcked = (r: LiveRow): boolean => acked.has(r.rec.added!.op);
			const stay = derived.size + random.filter(isAcked).length;
			const keeperRandom = byDevice.get(keeper)!.filter((r) => !derived.has(r.id) && !isAcked(r))
				.sort((a, b) => namesUncovered(a) - namesUncovered(b) || compareClock(a.rec.added!, b.rec.added!) || byCodeUnit(a.id, b.id));
			const keep = new Set(keeperRandom.slice(0, Math.max(0, items - stay)).map((r) => r.id));
			for (const row of random) {
				if (keep.has(row.id) || isAcked(row)) continue;
				plan.removes.push({ playlistId, rowId: row.id, recordingId: row.recording, device: row.rec.added!.device, addedTs: row.rec.added!.ts });
				plan.byPlaylist.set(playlistId, (plan.byPlaylist.get(playlistId) ?? 0) + 1);
			}
		}
	}
	return plan;
}

// Plan and emit the removes, inside the caller's transaction. The visible
// rows are left to the caller's projection (the returned refs): a merge
// chunk projects them with its own refs in one pass.
export function emitStreamingDedupe(raw: Raw, scope: DedupeScope = {}): { removed: string[]; playlists: string[]; refs: EntityRef[] } {
	const plan = planStreamingDedupe(raw, scope);
	if (plan.removes.length === 0) return { removed: [], playlists: [], refs: [] };
	// A remove cancels only adds with an earlier ts (add wins a tie), and
	// another device's burst can run its clock a few ms past this one's:
	// stamp the removes after every add they cancel.
	observeServerTs(raw, Math.max(...plan.removes.map((r) => r.addedTs)));
	emitOps(raw, plan.removes.map((r) => ({ entity: 'playlist_track' as const, entity_id: r.rowId, kind: 'remove' as const, payload: {} })));
	return {
		removed: plan.removes.map((r) => r.rowId),
		playlists: [...plan.byPlaylist.keys()],
		refs: plan.removes.map((r) => ({ entity: 'playlist_track' as const, id: r.rowId })),
	};
}

export type DedupeResult = { removed: number; tracksTouched: string[]; playlistsTouched: string[] };

// One transaction: the removes and the projection that takes the rows off
// this device's tables.
export function healStreamingDuplicates(raw: Raw, scope: DedupeScope = {}): DedupeResult {
	return raw.transaction((): DedupeResult => {
		const r = emitStreamingDedupe(raw, scope);
		if (r.refs.length === 0) return { removed: 0, tracksTouched: [], playlistsTouched: [] };
		const summary = project(raw, new SyncStateStore(raw), r.refs, { removed: [], removedTombstones: [], aliasChanged: false });
		return { removed: r.removed.length, tracksTouched: summary.tracksTouched, playlistsTouched: summary.playlistsTouched };
	})();
}

// After applying ops from elsewhere (a pull page), inside its transaction.
// Merges can bring two devices' imports of one streaming playlist onto one
// recording, and so can rows a device that has not heard of a merge yet
// adds under either side of it (a pre-fix import still in its outbox); and
// since every device shows the account's whole library (remote-rows.ts),
// another device's rows in a streaming playlist show here even when no merge
// joins them — the "Astral Traveling" case, where the other device's one
// recording claims two releases this device holds apart, and the merge that
// would join them is held. So the recordings of every pulled add to a
// streaming playlist, and of every pulled streaming claim (a provider id
// that joins two item groups), are folded in the same commit, and the
// doubles never show. Null when the page touched no such recording.
export function healAfterApply(raw: Raw, ops: ReadonlyArray<{ entity: string; kind: string; entity_id?: string; payload: unknown }>): DedupeResult | null {
	const scope = new Set<string>();
	let alias: Map<string, string> | null = null;
	const R = (id: string): string => {
		alias ??= new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
		return alias.get(id) ?? id;
	};
	const sourceOf = raw.prepare(`SELECT source FROM playlist WHERE id = ?`).pluck();
	const streaming = new Map<string, boolean>();
	const isStreaming = (playlistId: string): boolean => {
		let v = streaming.get(playlistId);
		if (v === undefined) streaming.set(playlistId, (v = STREAMING.has((sourceOf.get(playlistId) as string | undefined) ?? '')));
		return v;
	};
	for (const o of ops) {
		if (o.entity === 'recording' && o.kind === 'merge') scope.add((o.payload as { winner: string }).winner);
		else if (o.entity === 'playlist_track' && o.kind === 'add') {
			const p = o.payload as { playlist_id: string; recording_id: string };
			if (isStreaming(p.playlist_id)) scope.add(R(p.recording_id));
		} else if (o.entity === 'recording_claim' && o.kind === 'add' && o.entity_id !== undefined && STREAMING.has((o.payload as { kind: string }).kind)) {
			scope.add(R(o.entity_id));
		}
	}
	return scope.size > 0 ? healStreamingDuplicates(raw, { recordings: scope }) : null;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The one-time sweep: every streaming playlist, a few per transaction with
// a yield between, then the gate key so it never runs again.
// 8 playlists per slice: the item grouping reads every row's claims (one
// batched read per chunk); 25 of the real library's playlists took up to
// ~560 ms (measured 2026-10-20).
export async function sweepStreamingDuplicatesAsync(raw: Raw, opts: { chunk?: number } = {}): Promise<DedupeResult & { playlists: number; maxSliceMs: number }> {
	const chunk = Math.max(1, opts.chunk ?? 8);
	const ids = [...streamingPlaylists(raw).keys()].sort();
	const out = { removed: 0, tracksTouched: new Set<string>(), playlistsTouched: new Set<string>(), maxSliceMs: 0 };
	for (let i = 0; i < ids.length; i += chunk) {
		await yieldToLoop();
		const t0 = performance.now();
		const r = healStreamingDuplicates(raw, { playlists: ids.slice(i, i + chunk) });
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.removed += r.removed;
		for (const t of r.tracksTouched) out.tracksTouched.add(t);
		for (const p of r.playlistsTouched) out.playlistsTouched.add(p);
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
		.run(STREAMING_DEDUPE_KEY, JSON.stringify(Date.now()), Date.now());
	return { removed: out.removed, tracksTouched: [...out.tracksTouched], playlistsTouched: [...out.playlistsTouched], playlists: ids.length, maxSliceMs: out.maxSliceMs };
}

export function streamingDedupeSwept(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(STREAMING_DEDUPE_KEY) !== undefined;
}
