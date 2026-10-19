// Play-history write path: the PlayTracker upsert lifecycle (insert →
// checkpoint → finalize), gap-based curator session assignment, and the
// manual set/prep override. Runs the plays module directly against a
// migrated temp DB — no service, no sidecars, never real data.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { createDb, type Db } from '../db/client.js';
import type { PlayRecordUpsert } from '@curator/shared/schema';
import {
	getPlaySession,
	getTopPlayed,
	getTrackPlayHistory,
	listPlaySessions,
	recordPlay,
	SESSION_GAP_MS,
	setPlaySessionKind,
} from './plays.js';

let dir: string;
let db: Db;
let sqlite: Database.Database;

function seedTrack(id: string): void {
	sqlite.prepare(`INSERT INTO track (id, title, artists, state) VALUES (?, ?, '[{"name":"A"}]', 'unsorted')`).run(id, id);
}

function upsert(partial: Partial<PlayRecordUpsert> & { id: string; startedAt: number }): void {
	recordPlay(db, {
		trackId: null,
		sourceTrackId: 'sp1',
		source: 'spotify',
		playedMs: 10_000,
		durationMs: 200_000,
		maxPositionMs: 10_000,
		endedReason: null,
		contextType: null,
		contextId: null,
		final: false,
		...partial,
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-plays-'));
	const dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});

afterEach(() => {
	sqlite.close();
	rmSync(dir, { recursive: true, force: true });
});

describe('recordPlay upsert lifecycle', () => {
	it('insert → checkpoint → finalize lands ONE row with played75 computed at finalize', () => {
		seedTrack('t1');
		const t0 = Date.now();
		upsert({ id: 'p1', trackId: 't1', startedAt: t0, playedMs: 6000 });
		upsert({ id: 'p1', trackId: 't1', startedAt: t0, playedMs: 90_000 }); // checkpoint
		upsert({ id: 'p1', trackId: 't1', startedAt: t0, playedMs: 160_000, endedReason: 'ended', final: true });

		const rows = sqlite.prepare(`SELECT * FROM play_event`).all() as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: 'p1',
			track_id: 't1',
			played_ms: 160_000,
			played75: 1, // 160s of 200s = 80%
			ended_reason: 'ended',
			source: 'spotify',
		});
		expect(rows[0]!['played_at']).toBe(t0);
	});

	it('played75 false under the threshold, null when no duration snapshot exists', () => {
		upsert({ id: 'p1', startedAt: Date.now(), playedMs: 30_000, endedReason: 'replaced', final: true, durationMs: 200_000 });
		upsert({ id: 'p2', startedAt: Date.now(), playedMs: 500_000, endedReason: 'ended', final: true, durationMs: null });
		const by = (id: string): Record<string, unknown> =>
			sqlite.prepare(`SELECT played75 FROM play_event WHERE id = ?`).get(id) as Record<string, unknown>;
		expect(by('p1')['played75']).toBe(0);
		expect(by('p2')['played75']).toBeNull();
	});

	it('a non-final row stays open (no endedReason) — the interrupted-play shape after a crash', () => {
		upsert({ id: 'p1', startedAt: Date.now(), playedMs: 42_000 });
		const row = sqlite.prepare(`SELECT ended_reason, played75 FROM play_event`).get() as Record<string, unknown>;
		expect(row['ended_reason']).toBeNull();
		expect(row['played75']).toBeNull();
	});
});

describe('curator session assignment', () => {
	it('plays within the gap share a session; past the gap a new one opens; endedAt advances', () => {
		const t0 = Date.now();
		upsert({ id: 'p1', startedAt: t0, playedMs: 60_000, endedReason: 'ended', final: true });
		// 10 min after the first play's activity end → same session.
		upsert({ id: 'p2', startedAt: t0 + 60_000 + 10 * 60_000, playedMs: 30_000, endedReason: 'ended', final: true });
		// 31 min after p2's activity end → new session.
		const p3Start = t0 + 60_000 + 10 * 60_000 + 30_000 + SESSION_GAP_MS + 60_000;
		upsert({ id: 'p3', startedAt: p3Start, playedMs: 5000, endedReason: 'ended', final: true });

		const sessions = sqlite.prepare(`SELECT id, origin, kind, ended_at FROM play_session ORDER BY started_at`).all() as Record<string, unknown>[];
		expect(sessions).toHaveLength(2);
		expect(sessions[0]).toMatchObject({ origin: 'curator', kind: 'prep' });
		const sessionOf = (id: string): unknown =>
			(sqlite.prepare(`SELECT session_id FROM play_event WHERE id = ?`).get(id) as Record<string, unknown>)['session_id'];
		expect(sessionOf('p1')).toBe(sessionOf('p2'));
		expect(sessionOf('p3')).not.toBe(sessionOf('p1'));
		// endedAt covers the last play's audible span.
		expect(sessions[0]!['ended_at']).toBe(t0 + 60_000 + 10 * 60_000 + 30_000);
	});
});

describe('setPlaySessionKind', () => {
	it('flips kind + kindSource to user; throws on unknown session', () => {
		upsert({ id: 'p1', startedAt: Date.now(), playedMs: 10_000, final: true, endedReason: 'ended' });
		const sessionId = (sqlite.prepare(`SELECT id FROM play_session`).get() as { id: string }).id;
		setPlaySessionKind(db, sessionId, 'set');
		const row = sqlite.prepare(`SELECT kind, kind_source FROM play_session WHERE id = ?`).get(sessionId) as Record<string, unknown>;
		expect(row).toMatchObject({ kind: 'set', kind_source: 'user' });
		expect(() => setPlaySessionKind(db, 'nope', 'prep')).toThrow(/not found/);
	});
});

describe('read queries', () => {
	it('getTrackPlayHistory pages newest-first with session context; getTopPlayed aggregates', () => {
		seedTrack('t1');
		seedTrack('t2');
		const t0 = Date.now() - 100_000;
		upsert({ id: 'p1', trackId: 't1', startedAt: t0, playedMs: 10_000, final: true, endedReason: 'ended' });
		upsert({ id: 'p2', trackId: 't1', startedAt: t0 + 20_000, playedMs: 10_000, final: true, endedReason: 'ended' });
		upsert({ id: 'p3', trackId: 't2', startedAt: t0 + 40_000, playedMs: 10_000, final: true, endedReason: 'ended' });

		const hist = getTrackPlayHistory(db, 't1');
		expect(hist.total).toBe(2);
		expect(hist.rows[0]!.playedAt).toBe(t0 + 20_000);
		expect(hist.rows[0]!.sessionKind).toBe('prep');

		const top = getTopPlayed(db);
		expect(top[0]).toMatchObject({ trackId: 't1', plays: 2 });
		expect(top[1]).toMatchObject({ trackId: 't2', plays: 1 });

		const sessions = listPlaySessions(db);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]!.playCount).toBe(3);

		const detail = getPlaySession(db, sessions[0]!.id);
		expect(detail?.plays.map((p) => p.trackId)).toEqual(['t1', 't1', 't2']);
	});
});
