// What the server reads, as the emit side needs to know it (protocol v4, the
// 2026-10-21 zero-loss release). A v3 server answers a v4 op with
// `server_outdated` for the WHOLE push, so nothing v4 may reach the outbox
// before the server says it reads it ('zero_loss_v4' in SYNC_FEATURES).
//
// The sync client learns the features from every push and pull answer; the
// writers that emit inline (a cue edit, a play, a feed decision, the album
// fill) run outside it, in mutators that only hold the database. So the
// client keeps the verdict in a device-local app_setting row and the writers
// read that: a v4 shape when the server reads it, the v3 shape (or nothing,
// for a kind with no v3 form) otherwise. What a writer could not state yet
// is stated once by the v4 backfills (sync-log/v4-backfill.ts) when the
// feature first shows up, so the gap closes either way.
//
// The push loop is the second guard (client.ts): an op stamped above what the
// server reads stays pending instead of failing the batch.

import type Database from 'better-sqlite3';
import type { SyncFeature } from '@curator/protocol';

type Raw = Database.Database;

export const ZERO_LOSS_FEATURE: SyncFeature = 'zero_loss_v4';

// Device-local (never an account key): '1' while the last answer named the
// feature. Cleared when an answer stops naming it (a rolled-back server).
export const SERVER_READS_V4_KEY = 'sync.server_reads_v4';

export function featuresReadV4(features: readonly SyncFeature[] | null | undefined): boolean {
	return !!features?.includes(ZERO_LOSS_FEATURE);
}

// The highest op version the push loop may send: v4 only once the server
// said it reads it. v3 ops were always sent ungated (their emitters wait for
// 'track_meta' themselves), so below v4 nothing changes.
export function pushableSchemaVersion(features: readonly SyncFeature[] | null | undefined): number {
	return featuresReadV4(features) ? 4 : 3;
}

const STMTS = new WeakMap<Raw, { get: Database.Statement<[string], { value: string }> }>();

// Whether a writer may emit a v4 op now. One primary-key read; writers call
// it once per transaction, not per row.
export function emitV4(raw: Raw): boolean {
	let s = STMTS.get(raw);
	if (!s) {
		s = { get: raw.prepare(`SELECT value FROM app_setting WHERE key = ?`) };
		STMTS.set(raw, s);
	}
	return s.get.get(SERVER_READS_V4_KEY)?.value === '1';
}

// The client's record of the server's answer. Writes only on a change.
export function recordServerV4(raw: Raw, reads: boolean): boolean {
	if (emitV4(raw) === reads) return false;
	if (reads) {
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', ?) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at`).run(SERVER_READS_V4_KEY, Date.now());
	} else {
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(SERVER_READS_V4_KEY);
	}
	return true;
}
