// Discover feed decisions on the op log (protocol v4 `feed_item` /
// `feed_suppression`; the 2026-10-21 zero-loss audit, item 9).
//
// Decided 2026-10-21 (Guy): for now the account's MASTER device collects the
// feed (runs the producers) and its decisions — archived, dismissed,
// promoted, seen/expanded, played, listened tracks, muted artists /
// playlists / labels, tracks marked unavailable — sync to every other
// device; later the feed moves to the cloud and devices are fed from it,
// decisions cloud-first. So the decisions are account-level records keyed by
// what every device and a future cloud feed derive alike: the item's dedupe
// key (`isrc:…`, `spotify:track:…`, `spotify:album:…`) and the suppression
// key (`artist:<spotify id>`, …), never feed.db's per-device row id. A
// promotion names the library RECORDING, not this device's track id.
//
// Who collects (feedRole): the master, or any device when the account has no
// master stated (or the device never signed in). A follower runs no producer
// — its Refresh / Load More are refused and the Discover view says why —
// but it still applies the account's decisions to whatever items it holds,
// and the decisions it makes there sync back (they are the account's, not
// the collector's). Signals beyond those decisions (impressions, the dismiss
// / promote log) stay in feed.db: tuning data, not state any view reads.
//
// feed.db is another database (the feed store's own connection), so neither
// direction can share a transaction with curator.db:
//   - out: a decision is written to feed.db first (the feed service), then
//     stated here in a curator.db transaction of its own. A crash between the
//     two loses the op, not the decision; the one-time backfill below states
//     everything feed.db holds when the server first reads v4.
//   - in: the projection queues the keys in feed_sync_pending inside the
//     apply transaction (project.ts 5b); applyPending moves them into
//     feed.db and dequeues, idempotently (a re-apply writes only what
//     differs). New items a producer inserts take their recorded decision in
//     the insert's own transaction (store.setDecisionSource).

import type Database from 'better-sqlite3';
import { FEED_LISTEN_PREFIX, type LwwRecord } from '@curator/protocol';
import { log } from '../log.js';
import { getDeviceId } from '../sync-log/device.js';
import { emitV4 } from '../sync-log/features.js';
import { emitOps, type EmitOp } from '../sync-log/outbox.js';
import { masterDevice } from '../sync-log/track-meta.js';
import type { FeedStore } from './store.js';
import type { FeedDecisionPort, FeedItemState, FeedRole, FeedSuppressionScope, SyncedFeedItem, SyncedFeedSuppression } from './types.js';

type Raw = Database.Database;

const slog = log.for('feed-sync');

export const FEED_BACKFILL_KEY = 'sync.backfill.feed_decisions_v4_at';

const STATES: ReadonlySet<string> = new Set(['fresh', 'seen', 'expanded', 'promoted', 'dismissed', 'archived']);
const SCOPES: ReadonlySet<string> = new Set(['artist', 'label', 'playlist', 'source', 'track']);
const validKey = (k: string): boolean => k.length > 0 && k.length <= 256;

export function feedRole(raw: Raw): FeedRole {
	const master = masterDevice(raw);
	if (master === null) return { role: 'collector', masterDeviceId: null };
	return { role: master === getDeviceId(raw) ? 'collector' : 'follower', masterDeviceId: master };
}

// ── out: this device's decisions as ops ─────────────────────────────────────

function recordingOfTrack(raw: Raw, trackId: string | null | undefined): string | null {
	if (!trackId) return null;
	return (raw.prepare(`SELECT recording_id FROM track WHERE id = ?`).pluck().get(trackId) as string | undefined) ?? null;
}

function stateOp(dedupeKey: string, state: FeedItemState, promotedRecording: string | null): EmitOp | null {
	if (!validKey(dedupeKey) || !STATES.has(state)) return null;
	return { entity: 'feed_item', entity_id: dedupeKey, kind: 'set-state', payload: state === 'promoted' ? { state, promoted_recording_id: promotedRecording } : { state, promoted_recording_id: null } };
}

function suppressionOp(key: string, scope: FeedSuppressionScope | 'track', active: boolean): EmitOp | null {
	if (!validKey(key) || !SCOPES.has(scope)) return null;
	return { entity: 'feed_suppression', entity_id: key, kind: 'set', payload: { scope, active } };
}

// The port the feed service writes through. Every call is a no-op until the
// server reads v4 (features.ts); the backfill covers what came before.
export function createFeedDecisionPort(raw: Raw): FeedDecisionPort {
	const emit = (ops: Array<EmitOp | null>): void => {
		const list = ops.filter((o): o is EmitOp => o !== null);
		if (list.length === 0 || !emitV4(raw)) return;
		try {
			raw.transaction(() => { emitOps(raw, list); })();
		} catch (err) {
			// The decision is in feed.db already; losing its op must not fail
			// the user's click (repeating the decision states it again).
			slog.warn('feed decision not stated to the account', undefined, err);
		}
	};
	return {
		itemState(dedupeKey, state, promotedTrackId) {
			emit([stateOp(dedupeKey, state, state === 'promoted' ? recordingOfTrack(raw, promotedTrackId) : null)]);
		},
		played(dedupeKey, at, sourceTrackId) {
			if (!validKey(dedupeKey)) return;
			emit([
				{ entity: 'feed_item', entity_id: dedupeKey, kind: 'mark-played', payload: { at: Math.max(0, Math.round(at)) } },
				sourceTrackId && sourceTrackId.length <= 64 ? { entity: 'feed_item', entity_id: dedupeKey, kind: 'mark-listened', payload: { source_track_id: sourceTrackId } } : null,
			]);
		},
		suppression(key, scope, active) {
			emit([suppressionOp(key, scope, active)]);
		},
		role: () => feedRole(raw),
	};
}

export function feedBackfillPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(FEED_BACKFILL_KEY) === undefined;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// Everything feed.db holds, once, each op stamped with when it was decided —
// so any decision made later, on any device, still wins. What the account's
// records already hold is skipped (a decision that came from another device
// and was applied here): a historical stamp bypasses emitOps' restatement
// check, so an echo would otherwise go out.
// `local`: the founder fold's form (sync-log/outbox.ts EmitOptions.local).
export async function backfillFeedDecisionsAsync(raw: Raw, store: Pick<FeedStore, 'decisionsDump'>, opts: { local?: boolean } = {}): Promise<{ emitted: number }> {
	const dump = store.decisionsDump();
	const ops: EmitOp[] = [];
	const at = (op: EmitOp | null, ts: number): void => { if (op && !held(op)) ops.push({ ...op, client_ts: Math.max(0, Math.round(ts)) }); };
	const items = readRecords(raw, 'feedItems', [...new Set([...dump.items.map((i) => i.dedupeKey), ...dump.listens.map((l) => l.dedupeKey)])]);
	const sups = readRecords(raw, 'feedSuppressions', [...dump.suppressions.map((s) => s.key), ...dump.unavailable.map((u) => `track:${u.sourceTrackId}`)]);
	const held = (op: EmitOp): boolean => {
		const p = op.payload as Record<string, unknown>;
		if (op.entity === 'feed_suppression') return sups.get(op.entity_id)?.fields['active']?.value === p['active'];
		const rec = items.get(op.entity_id);
		if (!rec) return false;
		switch (op.kind) {
			case 'set-state': return rec.fields['state']?.value === p['state'] && (rec.fields['promoted_recording_id']?.value ?? null) === (p['promoted_recording_id'] ?? null);
			case 'mark-played': return rec.fields['played_at'] !== undefined;
			case 'mark-listened': return rec.fields[`${FEED_LISTEN_PREFIX}${String(p['source_track_id'])}`] !== undefined;
			default: return false;
		}
	};
	for (const i of dump.items) {
		if (i.state !== 'fresh') at(stateOp(i.dedupeKey, i.state, i.state === 'promoted' ? recordingOfTrack(raw, i.promotedTrackId) : null), i.at);
		if (i.playedAt != null && validKey(i.dedupeKey)) at({ entity: 'feed_item', entity_id: i.dedupeKey, kind: 'mark-played', payload: { at: Math.max(0, Math.round(i.playedAt)) } }, i.playedAt);
	}
	for (const l of dump.listens) {
		if (validKey(l.dedupeKey) && l.sourceTrackId.length > 0 && l.sourceTrackId.length <= 64) at({ entity: 'feed_item', entity_id: l.dedupeKey, kind: 'mark-listened', payload: { source_track_id: l.sourceTrackId } }, l.at);
	}
	for (const s of dump.suppressions) at(suppressionOp(s.key, s.scope, true), s.at);
	for (const u of dump.unavailable) at(suppressionOp(`track:${u.sourceTrackId}`, 'track', true), u.at);
	let emitted = 0;
	for (let i = 0; i < ops.length; i += 500) {
		const chunk = ops.slice(i, i + 500);
		// A one-time backlog: uploaded as a server batch ('batches', outbox.ts).
		raw.transaction(() => { emitted += emitOps(raw, chunk, { batchLabel: 'backfill', local: opts.local }).length; })();
		await yieldToLoop();
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(FEED_BACKFILL_KEY, JSON.stringify(Date.now()), Date.now());
	return { emitted };
}

// ── in: the account's decisions onto feed.db ────────────────────────────────

function readRecords(raw: Raw, map: 'feedItems' | 'feedSuppressions', keys: readonly string[]): Map<string, LwwRecord> {
	const out = new Map<string, LwwRecord>();
	for (let i = 0; i < keys.length; i += 400) {
		const chunk = keys.slice(i, i + 400);
		for (const r of raw.prepare(`SELECT key, value FROM sync_state WHERE map = ? AND key IN (${chunk.map(() => '?').join(',')})`).all(map, ...chunk) as Array<{ key: string; value: string }>) {
			try { out.set(r.key, JSON.parse(r.value) as LwwRecord); } catch { /* a malformed record applies nothing */ }
		}
	}
	return out;
}

// The local track a promoted recording has here (own row first, then a
// remote one), through the merge aliases.
function trackOfRecording(raw: Raw, recordingId: string | null): string | null {
	if (!recordingId) return null;
	const alias = raw.prepare(`SELECT winner FROM recording_alias WHERE loser = ?`).pluck().get(recordingId) as string | undefined;
	return (raw.prepare(`SELECT id FROM track WHERE recording_id = ? ORDER BY remote_only, deleted_at IS NOT NULL, created_at, id LIMIT 1`).pluck().get(alias ?? recordingId) as string | undefined) ?? null;
}

function syncedItem(raw: Raw, key: string, rec: LwwRecord): SyncedFeedItem {
	const state = rec.fields['state']?.value;
	const promoted = rec.fields['promoted_recording_id']?.value;
	const played = rec.fields['played_at']?.value;
	return {
		dedupeKey: key,
		state: typeof state === 'string' && STATES.has(state) ? (state as FeedItemState) : null,
		stateAt: rec.fields['state']?.clock.ts ?? null,
		promotedTrackId: typeof promoted === 'string' ? trackOfRecording(raw, promoted) : null,
		playedAt: typeof played === 'number' ? played : null,
		listened: Object.keys(rec.fields).filter((n) => n.startsWith(FEED_LISTEN_PREFIX)).map((n) => n.slice(FEED_LISTEN_PREFIX.length)),
	};
}

// What the account decided about these items, for the store's insert hook.
export function syncedItemsFor(raw: Raw, dedupeKeys: readonly string[]): SyncedFeedItem[] {
	const recs = readRecords(raw, 'feedItems', dedupeKeys);
	return [...recs].map(([k, r]) => syncedItem(raw, k, r));
}

export function feedPendingCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM feed_sync_pending`).pluck().get() as number;
}

// The queued keys into feed.db, in slices. Returns the feed items changed.
export async function applyPendingFeedDecisionsAsync(raw: Raw, store: Pick<FeedStore, 'applySyncedDecisions'>, opts: { chunk?: number } = {}): Promise<{ keys: number; changed: number }> {
	const chunk = Math.max(1, opts.chunk ?? 300);
	const out = { keys: 0, changed: 0 };
	const next = raw.prepare(`SELECT map, key FROM feed_sync_pending LIMIT ?`);
	const del = raw.prepare(`DELETE FROM feed_sync_pending WHERE map = ? AND key = ?`);
	for (;;) {
		const rows = next.all(chunk) as Array<{ map: 'feedItems' | 'feedSuppressions'; key: string }>;
		if (rows.length === 0) break;
		const itemKeys = rows.filter((r) => r.map === 'feedItems').map((r) => r.key);
		const supKeys = rows.filter((r) => r.map === 'feedSuppressions').map((r) => r.key);
		const items = [...readRecords(raw, 'feedItems', itemKeys)].map(([k, r]) => syncedItem(raw, k, r));
		const suppressions: SyncedFeedSuppression[] = [];
		for (const [k, r] of readRecords(raw, 'feedSuppressions', supKeys)) {
			const scope = r.fields['scope']?.value;
			if (typeof scope !== 'string' || !SCOPES.has(scope)) continue;
			suppressions.push({ key: k, scope: scope as SyncedFeedSuppression['scope'], active: r.fields['active']?.value === true, at: r.fields['active']?.clock.ts ?? Date.now() });
		}
		// feed.db first: a crash before the dequeue re-applies (idempotent).
		out.changed += store.applySyncedDecisions(items, suppressions);
		raw.transaction(() => { for (const r of rows) del.run(r.map, r.key); })();
		out.keys += rows.length;
		await yieldToLoop();
	}
	return out;
}
