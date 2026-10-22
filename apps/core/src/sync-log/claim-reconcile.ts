// Launch-time reconcile of provider-link claims (the 2026-10-21 zero-loss
// audit, item 6b). A device states the provider ids its rows hold as
// `recording_claim` ops — the streaming upserts, the hybrid matcher,
// enrichment and the Edit screen emit theirs, and the one-time claims
// backfill (initial-push.ts CLAIMS_BACKFILL_KEY) stated every link that
// existed at one instant. A link written after that instant by a path that
// did not claim yet stayed unclaimed for good: 12 Tidal links on the main
// library, fetched four minutes after its backfill, never reached another
// device. This walks every own link once a session and states the ones no
// claim carries; idempotent, so a caught-up library emits nothing.
//
// Same rules as the backfill: this device's own catalogue rows only (never
// a remote row or a derived WAV copy — a claim from either would vouch for a
// track this device does not hold), deleted rows included (their claims are
// how a delete keeps another device from minting the track again), a row of
// a merged-away recording skipped (its claims live on the winner). The
// Traxsource kind is protocol v4: stated only once the server reads v4
// (`v4`; a v3 server would refuse the whole push), and the client runs the
// reconcile again the first session it learns that.
// Each claim carries the link's fetch time, as the backfill's do, so it
// takes no precedence it did not have.
//
// Pages of tracks by rowid, one transaction each (its reads and the claims it
// emits), a yield between.

import type Database from 'better-sqlite3';
import { emitOps, type EmitOp } from './outbox.js';
import { claimOp } from './rows.js';

type Raw = Database.Database;

export const RECONCILED_CLAIM_SOURCES = ['spotify', 'tidal', 'beatport'] as const;
export const RECONCILED_CLAIM_SOURCES_V4 = [...RECONCILED_CLAIM_SOURCES, 'traxsource'] as const;

export type ClaimReconcileResult = { tracks: number; emitted: number; bySource: Record<string, number>; chunks: number; maxSliceMs: number };

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function reconcileProviderClaimsAsync(raw: Raw, opts: { page?: number; v4?: boolean } = {}): Promise<ClaimReconcileResult> {
	const page = Math.max(1, opts.page ?? 400);
	const out: ClaimReconcileResult = { tracks: 0, emitted: 0, bySource: {}, chunks: 0, maxSliceMs: 0 };
	const tracks = raw.prepare(`SELECT rowid, id, recording_id FROM track
		WHERE rowid > ? AND remote_only = 0 AND derived_from_track_id IS NULL AND recording_id IS NOT NULL ORDER BY rowid LIMIT ?`);
	const aliased = raw.prepare(`SELECT 1 FROM recording_alias WHERE loser = ?`).pluck();
	const claimed = raw.prepare(`SELECT 1 FROM sync_state WHERE map = 'claims' AND key = ?`).pluck();
	const sourceList = (opts.v4 ? RECONCILED_CLAIM_SOURCES_V4 : RECONCILED_CLAIM_SOURCES).map((s) => `'${s}'`).join(', ');
	for (let after = 0; ;) {
		const t0 = performance.now();
		const rows = tracks.all(after, page) as Array<{ rowid: number; id: string; recording_id: string }>;
		if (rows.length === 0) break;
		after = rows[rows.length - 1]!.rowid;
		raw.transaction(() => {
			const byTrack = new Map(rows.map((r) => [r.id, r.recording_id]));
			const links = raw.prepare(`SELECT track_id, source, source_track_id, fetched_at FROM source_link
				WHERE track_id IN (${rows.map(() => '?').join(',')}) AND source IN (${sourceList}) ORDER BY track_id, source, id`)
				.all(...rows.map((r) => r.id)) as Array<{ track_id: string; source: 'spotify' | 'tidal' | 'beatport' | 'traxsource'; source_track_id: string; fetched_at: number | null }>;
			const ops: EmitOp[] = [];
			const seen = new Set<string>();
			for (const l of links) {
				const rec = byTrack.get(l.track_id);
				if (!rec || !l.source_track_id || aliased.get(rec) !== undefined) continue;
				const key = `${rec}:${l.source}:${l.source_track_id}`;
				if (seen.has(key) || claimed.get(key) !== undefined) continue;
				seen.add(key);
				const op = claimOp(rec, { kind: l.source, value: l.source_track_id });
				if (!op) continue;
				ops.push(l.fetched_at != null ? { ...op, client_ts: Math.max(0, Math.round(l.fetched_at)) } : op);
				out.bySource[l.source] = (out.bySource[l.source] ?? 0) + 1;
			}
			// Labelled like the backfill it completes; a handful (the usual
			// launch) is below the client's batch threshold and goes plainly.
			if (ops.length > 0) emitOps(raw, ops, { batchLabel: 'backfill' });
			out.emitted += ops.length;
		})();
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.tracks += rows.length;
		out.chunks++;
		await yieldToLoop();
	}
	return out;
}
