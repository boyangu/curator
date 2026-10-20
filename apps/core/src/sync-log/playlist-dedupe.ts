// Fold the doubled rows two devices left in one streaming playlist (cloud
// plan: streaming identity §4). Before stable member ids (stable-ids.ts),
// each desktop that imported a Spotify or Tidal playlist added every entry
// under a random row id; once the identity resolver merges the two
// devices' recordings for one provider track, the playlist holds that
// track's rows twice — once per importing device. Nothing upstream
// changed, so nothing would ever remove them.
//
// THE RULE, per streaming playlist and per recording with two or more live
// rows, computed from the synced records only so every device that looks
// reaches the same answer:
//   - group the rows by the device whose add bound them (the add clock's
//     device): one device's rows are one import of the provider list;
//   - when two or more devices hold rows, keep one device's set — the one
//     with the most rows (an import made after the provider list gained a
//     duplicate holds it twice; the other import's single row is the stale
//     one), then the earliest add (the original import), then device id —
//     and remove the other devices' rows;
//   - never remove a row whose add the user made (it carries an upstream
//     ack, F23: a deliberate add, maybe of a second copy), nor a row under a
//     provider-derived id (stable-ids.ts: every device converges on it, so
//     it is the provider's own row, not a double). They still count toward
//     their device's set.
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
import { isStreamingMemberId } from './stable-ids.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

// The one-time sweep over every streaming playlist (client.ts).
export const STREAMING_DEDUPE_KEY = 'sync.heal.streaming_dedupe_at';

const STREAMING = new Set(['spotify', 'tidal']);
const CHUNK = 400;

export type DedupeRemove = { playlistId: string; rowId: string; recordingId: string; device: string; addedTs: number };

export type DedupePlan = {
	playlists: number;
	// (playlist, recording) pairs held by two or more devices.
	groups: number;
	removes: DedupeRemove[];
	// Per playlist: rows to remove (the report's "excess rows").
	byPlaylist: Map<string, number>;
};

export type DedupeScope = {
	// Only these playlists (default: every streaming playlist).
	playlists?: Iterable<string>;
	// Only rows of these recordings (resolved); the playlists holding them
	// are found through the record index.
	recordings?: Iterable<string>;
	// Extra loser → winner pairs on top of recording_alias: the read-only
	// report plans the dedupe as it would stand after the planned merges.
	alias?: ReadonlyMap<string, string>;
};

type Row = { id: string; rec: PlaylistTrackRecord; tomb: number | null };

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

export function planStreamingDedupe(raw: Raw, scope: DedupeScope = {}): DedupePlan {
	const plan: DedupePlan = { playlists: 0, groups: 0, removes: [], byPlaylist: new Map() };
	const R = aliasResolver(raw, scope.alias);
	const wanted = scope.recordings ? new Set([...scope.recordings].map(R)) : null;

	// The live rows in scope, by playlist then recording. Scoped by
	// recordings (a merge chunk, a pull), only their rows are read, through
	// the record index: a 5,000-row playlist is not re-read per chunk. An
	// applied merge's fold re-points every row record (and its index column)
	// to the winner; the report's planned merges have not folded, so their
	// losers' rows are read under the loser too.
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
		const members = new Set(wanted);
		if (scope.alias) for (const [loser] of scope.alias) if (wanted.has(R(loser))) members.add(loser);
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
	// `+map` as above: without it the planner takes (map, parent_id) and
	// walks every claim of the account per group (measured 2026-10-20: ~110
	// ms of a 50-merge chunk's ~130 at 10k claims; ~1 ms with it).
	const claimsOf = raw.prepare(`SELECT key FROM sync_state WHERE +map = 'claims' AND recording_id = ?`).pluck();

	for (const [playlistId, source] of playlists) {
		plan.playlists++;
		const byRecording = new Map<string, Row[]>();
		for (const row of rowsByPlaylist.get(playlistId) ?? []) {
			const rec = row.rec;
			// Alive as playlistTrackAlive: an add with an order key that no
			// later remove cancelled (add wins a same-ms tie).
			if (!rec.added || !rec.orderKey || !rec.recordingId || rec.playlistId !== playlistId) continue;
			if (row.tomb !== null && row.tomb > rec.added.ts) continue;
			const recording = R(rec.recordingId);
			if (wanted && !wanted.has(recording)) continue;
			let list = byRecording.get(recording);
			if (!list) byRecording.set(recording, (list = []));
			list.push(row);
		}
		for (const [recording, rows] of byRecording) {
			if (rows.length < 2) continue;
			const byDevice = new Map<string, Row[]>();
			for (const row of rows) {
				const d = row.rec.added!.device;
				let list = byDevice.get(d);
				if (!list) byDevice.set(d, (list = []));
				list.push(row);
			}
			if (byDevice.size < 2) continue;
			plan.groups++;
			const earliest = (list: Row[]): Clock => list.map((r) => r.rec.added!).reduce((a, b) => (compareClock(a, b) <= 0 ? a : b));
			const keeper = [...byDevice.entries()].sort(([da, la], [db, lb]) =>
				lb.length - la.length || compareClock(earliest(la), earliest(lb)) || (da < db ? -1 : da > db ? 1 : 0))[0]![0];
			// The provider ids this recording's rows could have been minted
			// under: its own claims and those of every recording the rows
			// were added under.
			const providerIds = new Set<string>();
			for (const rec of new Set([recording, ...rows.map((r) => r.rec.recordingId!)])) {
				for (const key of claimsOf.all(rec) as string[]) {
					const prefix = `${rec}:${source}:`;
					if (key.startsWith(prefix)) providerIds.add(key.slice(prefix.length));
				}
			}
			for (const [device, list] of byDevice) {
				if (device === keeper) continue;
				for (const row of list) {
					if (acked.has(row.rec.added!.op)) continue;
					if (providerIds.size > 0 && isStreamingMemberId(row.id, playlistId, [...providerIds], rows.length + 8)) continue;
					plan.removes.push({ playlistId, rowId: row.id, recordingId: recording, device, addedTs: row.rec.added!.ts });
					plan.byPlaylist.set(playlistId, (plan.byPlaylist.get(playlistId) ?? 0) + 1);
				}
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
// adds under either side of it (a pre-fix import still in its outbox): the
// rows of those recordings are folded in the same commit, so the doubles
// never show. Null when the page touched no such recording.
export function healAfterApply(raw: Raw, ops: ReadonlyArray<{ entity: string; kind: string; payload: unknown }>): DedupeResult | null {
	const winners = new Set<string>();
	let alias: Map<string, string> | null = null;
	let merged: Set<string> | null = null;
	for (const o of ops) {
		if (o.entity === 'recording' && o.kind === 'merge') winners.add((o.payload as { winner: string }).winner);
		else if (o.entity === 'playlist_track' && o.kind === 'add') {
			if (!alias) {
				alias = new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
				merged = new Set(alias.values());
			}
			const rec = (o.payload as { recording_id: string }).recording_id;
			const r = alias.get(rec) ?? rec;
			if (alias.has(rec) || merged!.has(r)) winners.add(r);
		}
	}
	return winners.size > 0 ? healStreamingDuplicates(raw, { recordings: winners }) : null;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The one-time sweep: every streaming playlist, a few per transaction with
// a yield between, then the gate key so it never runs again.
export async function sweepStreamingDuplicatesAsync(raw: Raw, opts: { chunk?: number } = {}): Promise<DedupeResult & { playlists: number; maxSliceMs: number }> {
	const chunk = Math.max(1, opts.chunk ?? 25);
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
