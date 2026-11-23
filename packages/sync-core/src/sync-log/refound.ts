// Turns a COPY of a library that already syncs into one that has never
// synced, so it founds a fresh account through the real first-sign-in path
// (client.ts establishBase → initial-push.ts foldLibraryAsync → the master
// setting op → the publish) instead of resuming the live account's cursor.
// Used by the rekordbox end-to-end run (e2e/) on its work-dir copy of the
// live curator.db; nothing in the product calls it, and it must never run
// against the live database: it drops the op log's whole local history.
//
// What goes, and why:
//   - The outbox, the pull cursor, held ops: the old account's delivery.
//   - The reducer's records (sync_state) and tombstones: the fold rebuilds
//     the base from the visible tables, stamped with the rows' own clocks,
//     exactly as for a library that never signed in. Records left behind
//     would make the fold's "already recorded?" probes skip those rows.
//   - The drains' baselines and queues (*_seen / *_dirty, the remote and
//     derive queues, claim links): a stale baseline reads as "already
//     stated" and the fold's drains would put nothing into the base.
//   - Remote rows: projections of the old account's other devices. A first
//     device has none, and the fold never states them (remote-rows.ts).
//   - The device-local sync.* marks (stated, records complete, first pull,
//     every one-time backfill and sweep, the publish record) and the
//     account settings' master mirror: with the master still in app_setting
//     the fold would put it in the records without an op, the server's log
//     would never name a master, and every publish would be refused.
//
// What stays:
//   - The device id: the founder is the same install, and its rekordbox
//     links and analysis are its own.
//   - recording_alias and the records of the `merges` map it is derived
//     from (store.ts). They encode every past recording merge; the fold
//     skips merge losers ("their claims live on the winner"), and dropping
//     the alias would bring each soft-deleted loser back as a recording of
//     its own, deleted, with the winner's audio hash claimed twice — a
//     split no real founder of this library would make.
//   - The account binding (sync.client userId), so signing in as the same
//     user is the same library; everything else in the client state resets.
//   - sync.clock, the poll cadence and the claim-index migration marker:
//     device facts, not account history.

import type Database from 'better-sqlite3';
import { MASTER_DEVICE_SETTING } from '@curator/protocol';
import { getDeviceId } from './device.js';
import { dropRemoteRow } from './remote-rows.js';

type Raw = Database.Database;

const CLIENT_STATE_KEY = 'sync.client';
const KEEP_SYNC_KEYS = new Set(['sync.clock', 'sync.poll', 'sync.claim_index_version']);

// Cleared when present (an older or newer schema may lack one).
const DERIVED_TABLES = [
	'sync_outbox', 'sync_cursor', 'sync_inbox_held', 'tombstone',
	'track_meta_dirty', 'track_meta_seen', 'track_attrs_dirty', 'track_attrs_seen',
	'track_analysis_dirty', 'track_analysis_seen', 'playlist_attrs_dirty', 'playlist_attrs_seen',
	'track_curation_seen', 'track_remote_pending', 'track_derive_pending',
	'claim_link', 'claim_link_pending', 'feed_sync_pending',
] as const;

export type RefoundResult = {
	userId: string | null;
	deviceId: string;
	remoteRowsDropped: number;
	recordsDropped: number;
	recordsKept: number;
	rowsCleared: Record<string, number>;
	keysDropped: string[];
};

export function resetSyncForFounding(raw: Raw): RefoundResult {
	const deviceId = getDeviceId(raw);
	let userId: string | null = null;
	const state = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(CLIENT_STATE_KEY) as string | undefined;
	if (state) {
		try { userId = (JSON.parse(state) as { userId?: string | null }).userId ?? null; } catch { /* unreadable: unbound */ }
	}
	const exists = (t: string): boolean => raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t) !== undefined;
	return raw.transaction((): RefoundResult => {
		const remote = raw.prepare(`SELECT id FROM track WHERE remote_only = 1`).pluck().all() as string[];
		for (const id of remote) dropRemoteRow(raw, id);
		const rowsCleared: Record<string, number> = {};
		for (const t of DERIVED_TABLES) if (exists(t)) rowsCleared[t] = raw.prepare(`DELETE FROM ${t}`).run().changes;
		const recordsDropped = raw.prepare(`DELETE FROM sync_state WHERE map != 'merges'`).run().changes;
		const recordsKept = raw.prepare(`SELECT count(*) FROM sync_state`).pluck().get() as number;
		const keys = (raw.prepare(`SELECT key FROM app_setting WHERE key LIKE 'sync.%' OR key IN (?, 'catalogue.account', 'catalogue.inventory_rev')`).pluck().all(MASTER_DEVICE_SETTING) as string[])
			.filter((k) => !KEEP_SYNC_KEYS.has(k));
		const del = raw.prepare(`DELETE FROM app_setting WHERE key = ?`);
		for (const k of keys) del.run(k);
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)`)
			.run(CLIENT_STATE_KEY, JSON.stringify({ userId, registeredFor: null, lastPushAt: null, lastPullAt: null, needsRepair: false, ownThroughSeq: 0 }), Date.now());
		return { userId, deviceId, remoteRowsDropped: remote.length, recordsDropped, recordsKept, rowsCleared, keysDropped: keys };
	})();
}
