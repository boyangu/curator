// Play-history persistence — the write path for the renderer PlayTracker's
// plays:record upserts and the read queries behind the agent/MCP play tools.
// Pure Db-taking functions (no service state), mirroring the merge engine's
// "logic lives in the module, service.ts delegates" shape.
//
// Session model: rekordbox sessions are created by the history importer
// (1:1 with djmdHistory rows); curator sessions are minted here, gap-based —
// a play starting more than SESSION_GAP_MS after the last curator-session
// activity opens a new session. Curator sessions are always kind='prep':
// real sets happen in rekordbox/CDJs, and the classifier never runs on
// curator plays.

import { and, count, desc, eq, gte, isNotNull, lte, max, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { recordPlayAppended, setSessionKind } from '../library/mutators.js';
import {
	playEvent,
	playSession,
	track,
	type PlayEvent,
	type PlayRecordUpsert,
	type PlaySession,
	type PlaySessionKind,
	type PlaySessionOrigin,
	type TrackArtist,
} from '@curator/shared/schema';

export const SESSION_GAP_MS = 30 * 60 * 1000;

// Drizzle's sync-transaction handle isn't assignable to Db; both expose the
// same query-builder surface, so accept either.
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export type PlayHistoryRow = {
	id: string;
	playedAt: number | null;
	source: string;
	sessionId: string;
	sessionName: string | null;
	sessionKind: PlaySessionKind;
	playedMs: number | null;
	played75: boolean | null;
	endedReason: string | null;
	contextType: string | null;
	contextId: string | null;
};

export type PlaySessionSummary = PlaySession & { playCount: number };

export type SessionPlayRow = {
	pos: number;
	trackId: string | null;
	rbContentId: string | null;
	title: string | null;
	artists: TrackArtist[] | null;
	playedAt: number | null;
	playedMs: number | null;
	played75: boolean | null;
	source: string;
};

export type TopPlayedRow = {
	trackId: string;
	title: string | null;
	artists: TrackArtist[] | null;
	plays: number;
	lastPlayedAt: number | null;
};

export function recordPlay(db: Db, e: PlayRecordUpsert): void {
	db.transaction((tx) => {
		const now = Date.now();
		const played75 = e.final
			? e.durationMs != null && e.durationMs > 0
				? e.playedMs >= 0.75 * e.durationMs
				: null
			: null;
		const existing = tx
			.select({ id: playEvent.id, sessionId: playEvent.sessionId })
			.from(playEvent)
			.where(eq(playEvent.id, e.id))
			.get();
		let sessionId: string;
		if (existing) {
			sessionId = existing.sessionId;
			tx.update(playEvent)
				.set({
					playedMs: e.playedMs,
					durationMs: e.durationMs,
					maxPositionMs: e.maxPositionMs,
					// trackId can resolve late (feed play promoted mid-listen);
					// upserting it is harmless for the common case (unchanged).
					trackId: e.trackId,
					...(e.final ? { endedReason: e.endedReason, played75 } : {}),
				})
				.where(eq(playEvent.id, e.id))
				.run();
		} else {
			sessionId = assignCuratorSession(tx, e.startedAt);
			tx.insert(playEvent)
				.values({
					id: e.id,
					sessionId,
					trackId: e.trackId,
					sourceTrackId: e.sourceTrackId,
					source: e.source,
					playedAt: new Date(e.startedAt),
					playedMs: e.playedMs,
					durationMs: e.durationMs,
					maxPositionMs: e.maxPositionMs,
					played75,
					endedReason: e.final ? e.endedReason : null,
					contextType: e.contextType,
					contextId: e.contextId,
				})
				.run();
		}
		// Session activity high-water mark — the gap check above reads this.
		const activityEnd = e.startedAt + e.playedMs;
		tx.update(playSession)
			.set({
				endedAt: sql`MAX(COALESCE(ended_at, 0), ${activityEnd})`,
				updatedAt: new Date(now),
			})
			.where(eq(playSession.id, sessionId))
			.run();
		// Sync: the finalised play is the op (play_event append), with its
		// session re-appended so the session's end travels too. The progress
		// upserts before `final` are local bookkeeping and emit nothing — a
		// play cut off by a crash before finalising stays on this device
		// until the initial push of a later install picks it up.
		if (e.final) recordPlayAppended(db, [e.id], [sessionId]);
	});
}

// Latest curator session wins if the new play starts within SESSION_GAP_MS of
// its last activity; otherwise mint a fresh one. Runs inside recordPlay's
// transaction (tx is a Db-compatible handle).
function assignCuratorSession(tx: DbOrTx, startedAt: number): string {
	const last = tx
		.select({ id: playSession.id, startedAt: playSession.startedAt, endedAt: playSession.endedAt })
		.from(playSession)
		.where(eq(playSession.origin, 'curator'))
		.orderBy(desc(playSession.startedAt))
		.limit(1)
		.get();
	if (last) {
		const lastActivity = Math.max(last.startedAt.getTime(), last.endedAt?.getTime() ?? 0);
		if (startedAt - lastActivity <= SESSION_GAP_MS) return last.id;
	}
	const id = randomUUID();
	tx.insert(playSession)
		.values({
			id,
			origin: 'curator',
			kind: 'prep',
			kindSource: 'auto',
			startedAt: new Date(startedAt),
			endedAt: new Date(startedAt),
		})
		.run();
	return id;
}

export function getTrackPlayHistory(
	db: Db,
	trackId: string,
	opts?: { limit?: number; offset?: number }
): { rows: PlayHistoryRow[]; total: number } {
	const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
	const offset = Math.max(opts?.offset ?? 0, 0);
	const rows = db
		.select({
			id: playEvent.id,
			playedAt: playEvent.playedAt,
			source: playEvent.source,
			sessionId: playEvent.sessionId,
			sessionName: playSession.name,
			sessionKind: playSession.kind,
			playedMs: playEvent.playedMs,
			played75: playEvent.played75,
			endedReason: playEvent.endedReason,
			contextType: playEvent.contextType,
			contextId: playEvent.contextId,
		})
		.from(playEvent)
		.innerJoin(playSession, eq(playEvent.sessionId, playSession.id))
		.where(eq(playEvent.trackId, trackId))
		// Bulk USB imports carry no playedAt — sort them by session start so
		// they still land in roughly chronological order among timed plays.
		.orderBy(sql`COALESCE(${playEvent.playedAt}, ${playSession.startedAt}) DESC`)
		.limit(limit)
		.offset(offset)
		.all();
	const total = db
		.select({ n: count() })
		.from(playEvent)
		.where(eq(playEvent.trackId, trackId))
		.get()!.n;
	return {
		rows: rows.map((r) => ({
			...r,
			playedAt: r.playedAt?.getTime() ?? null,
		})),
		total,
	};
}

export function listPlaySessions(
	db: Db,
	opts?: {
		origin?: PlaySessionOrigin;
		kind?: PlaySessionKind;
		fromMs?: number;
		toMs?: number;
		limit?: number;
		offset?: number;
	}
): PlaySessionSummary[] {
	const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
	const offset = Math.max(opts?.offset ?? 0, 0);
	const conds = [
		opts?.origin ? eq(playSession.origin, opts.origin) : undefined,
		opts?.kind ? eq(playSession.kind, opts.kind) : undefined,
		opts?.fromMs != null ? gte(playSession.startedAt, new Date(opts.fromMs)) : undefined,
		opts?.toMs != null ? lte(playSession.startedAt, new Date(opts.toMs)) : undefined,
	].filter((c): c is NonNullable<typeof c> => c != null);
	const rows = db
		.select({
			session: playSession,
			playCount: count(playEvent.id),
		})
		.from(playSession)
		.leftJoin(playEvent, eq(playEvent.sessionId, playSession.id))
		.where(conds.length ? and(...conds) : undefined)
		.groupBy(playSession.id)
		.orderBy(desc(playSession.startedAt))
		.limit(limit)
		.offset(offset)
		.all();
	return rows.map((r) => ({ ...r.session, playCount: r.playCount }));
}

export function getPlaySession(
	db: Db,
	sessionId: string
): { session: PlaySession; plays: SessionPlayRow[] } | null {
	const session = db.select().from(playSession).where(eq(playSession.id, sessionId)).get();
	if (!session) return null;
	const plays = db
		.select({
			trackNo: playEvent.trackNo,
			playedAt: playEvent.playedAt,
			trackId: playEvent.trackId,
			rbContentId: playEvent.rbContentId,
			title: track.title,
			artists: track.artists,
			playedMs: playEvent.playedMs,
			played75: playEvent.played75,
			source: playEvent.source,
		})
		.from(playEvent)
		.leftJoin(track, eq(playEvent.trackId, track.id))
		.where(eq(playEvent.sessionId, sessionId))
		// rekordbox rows order by trackNo; curator rows by play time.
		.orderBy(sql`COALESCE(${playEvent.trackNo}, 0)`, playEvent.playedAt)
		.all();
	return {
		session,
		plays: plays.map((p, i) => ({
			pos: p.trackNo ?? i + 1,
			trackId: p.trackId,
			rbContentId: p.rbContentId,
			title: p.title,
			artists: p.artists,
			playedAt: p.playedAt?.getTime() ?? null,
			playedMs: p.playedMs,
			played75: p.played75,
			source: p.source,
		})),
	};
}

export function getTopPlayed(
	db: Db,
	opts?: { fromMs?: number; toMs?: number; origin?: PlaySessionOrigin; limit?: number }
): TopPlayedRow[] {
	const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 200);
	const conds = [
		isNotNull(playEvent.trackId),
		opts?.fromMs != null ? gte(playEvent.playedAt, new Date(opts.fromMs)) : undefined,
		opts?.toMs != null ? lte(playEvent.playedAt, new Date(opts.toMs)) : undefined,
		opts?.origin ? eq(playSession.origin, opts.origin) : undefined,
	].filter((c): c is NonNullable<typeof c> => c != null);
	const rows = db
		.select({
			trackId: playEvent.trackId,
			title: track.title,
			artists: track.artists,
			plays: count(playEvent.id),
			lastPlayedAt: max(playEvent.playedAt),
		})
		.from(playEvent)
		.innerJoin(playSession, eq(playEvent.sessionId, playSession.id))
		.leftJoin(track, eq(playEvent.trackId, track.id))
		.where(and(...conds))
		.groupBy(playEvent.trackId)
		.orderBy(desc(count(playEvent.id)))
		.limit(limit)
		.all();
	return rows.map((r) => ({
		trackId: r.trackId!,
		title: r.title,
		artists: r.artists,
		plays: r.plays,
		lastPlayedAt: r.lastPlayedAt?.getTime() ?? null,
	}));
}

export function setPlaySessionKind(db: Db, sessionId: string, kind: 'set' | 'prep'): void {
	// play_session set-kind op in the same transaction (library/mutators.ts).
	if (!setSessionKind(db, sessionId, kind)) throw new Error(`play session not found: ${sessionId}`);
}
