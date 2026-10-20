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
import { applyOps } from '../sync-log/apply.js';
import { readOutbox } from '../sync-log/outbox.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import {
	finalizeInterruptedPlays,
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

// A play the tracker never finalised (quit, crash, renderer reload) used to
// stay open and off every other device for good. It becomes final as
// 'interrupted' once provably abandoned — at launch, or when the tracker
// starts its next play — and syncs then.
describe('unfinalised plays', () => {
	const events = (): Array<{ entity: string; entity_id: string; payload: Record<string, unknown> }> =>
		(sqlite.prepare(`SELECT entity, entity_id, payload FROM sync_outbox WHERE entity = 'play_event' ORDER BY seq_local`).all() as Array<{ entity: string; entity_id: string; payload: string }>)
			.map((o) => ({ ...o, payload: JSON.parse(o.payload) as Record<string, unknown> }));
	const row = (id: string) => sqlite.prepare(`SELECT ended_reason, played75, played_ms FROM play_event WHERE id = ?`).get(id) as { ended_reason: string | null; played75: number | null; played_ms: number };

	it('the launch sweep finalises plays last heard before this instance started, once, and leaves the rest', () => {
		seedTrack('t1');
		const t0 = Date.now() - 3_600_000;
		upsert({ id: 'done', startedAt: t0 - 600_000, playedMs: 30_000, final: true, endedReason: 'ended' });
		upsert({ id: 'crashed', trackId: 't1', startedAt: t0, playedMs: 160_000, source: 'local' });
		// A rekordbox play has no ended_reason by nature and is not a tracker play.
		sqlite.prepare(`INSERT INTO play_session (id, origin, kind, started_at) VALUES ('rb', 'rekordbox', 'set', ?)`).run(t0);
		sqlite.prepare(`INSERT INTO play_event (id, session_id, source, played_at, track_no) VALUES ('rbplay', 'rb', 'rekordbox', ?, 1)`).run(t0);
		// Still playing in this instance (heard after it started); written
		// directly so its insert does not finalise 'crashed' first.
		const sid = (sqlite.prepare(`SELECT session_id FROM play_event WHERE id = 'crashed'`).get() as { session_id: string }).session_id;
		sqlite.prepare(`INSERT INTO play_event (id, session_id, source, played_at, played_ms, duration_ms) VALUES ('live', ?, 'spotify', ?, 10000, 200000)`).run(sid, Date.now() - 5_000);
		expect(events().map((e) => e.entity_id)).toEqual(['done']);
		const before = sqlite.prepare(`SELECT count(*) AS n FROM sync_outbox`).get() as { n: number };

		expect(finalizeInterruptedPlays(db, { before: Date.now() - 60_000 })).toBe(1);
		expect(row('crashed')).toMatchObject({ ended_reason: 'interrupted', played75: 1 }); // 160 of 200 s
		expect(row('live').ended_reason).toBeNull();
		expect((sqlite.prepare(`SELECT ended_reason FROM play_event WHERE id = 'rbplay'`).get() as { ended_reason: null }).ended_reason).toBeNull();
		const tail = (sqlite.prepare(`SELECT entity, entity_id, payload FROM sync_outbox`).all() as Array<{ entity: string; entity_id: string; payload: string }>).slice(before.n);
		expect(tail.map((o) => `${o.entity}:${o.entity_id === 'crashed' ? 'crashed' : 'session'}`).sort()).toEqual(['play_event:crashed', 'play_session:session']);
		expect(JSON.parse(tail.find((o) => o.entity === 'play_event')!.payload)).toMatchObject({ ended_reason: 'interrupted', played75: true, played_ms: 160_000, recording_id: recordingIdForTrack('t1') });

		// Idempotent: a second launch has nothing to do.
		const n = (sqlite.prepare(`SELECT count(*) AS n FROM sync_outbox`).get() as { n: number }).n;
		expect(finalizeInterruptedPlays(db, { before: Date.now() - 60_000 })).toBe(0);
		expect((sqlite.prepare(`SELECT count(*) AS n FROM sync_outbox`).get() as { n: number }).n).toBe(n);
	});

	it('the next play finalises one a renderer reload abandoned', () => {
		const t0 = Date.now() - 600_000;
		upsert({ id: 'orphan', startedAt: t0, playedMs: 20_000 });
		expect(events()).toEqual([]);
		upsert({ id: 'next', startedAt: t0 + 120_000, playedMs: 6_000 });
		expect(row('orphan').ended_reason).toBe('interrupted');
		expect(row('next').ended_reason).toBeNull();
		expect(events().map((e) => [e.entity_id, e.payload['ended_reason']])).toEqual([['orphan', 'interrupted']]);
	});

	it('a play finalised as interrupted that turns out alive re-opens, and its real finalise wins on another device', () => {
		seedTrack('t1');
		const t0 = Date.now() - 600_000;
		upsert({ id: 'p', trackId: 't1', startedAt: t0, playedMs: 20_000, source: 'local' });
		finalizeInterruptedPlays(db, { before: Date.now() });
		expect(row('p').ended_reason).toBe('interrupted');

		// Device B pulls what A has so far.
		const bPath = join(dir, 'b.db');
		migrate(bPath);
		const b = new Database(bPath);
		try {
			b.prepare(`INSERT INTO track (id, recording_id, title, artists, state) VALUES ('bt1', ?, 't1', '[]', 'unsorted')`).run(recordingIdForTrack('t1'));
			applyOps(b, readOutbox(sqlite));
			expect(b.prepare(`SELECT track_id, ended_reason, played_ms FROM play_event WHERE id = 'p'`).get()).toEqual({ track_id: 'bt1', ended_reason: 'interrupted', played_ms: 20_000 });

			// The tracker was still going: a progress upsert re-opens the row…
			upsert({ id: 'p', trackId: 't1', startedAt: t0, playedMs: 60_000, source: 'local' });
			expect(row('p').ended_reason).toBeNull();
			// …and its real finalise is the latest append.
			upsert({ id: 'p', trackId: 't1', startedAt: t0, playedMs: 190_000, final: true, endedReason: 'ended', source: 'local' });
			const ops = readOutbox(sqlite);
			applyOps(b, ops);
			const cols = `SELECT ended_reason, played_ms, played75, duration_ms, source FROM play_event WHERE id = 'p'`;
			expect(b.prepare(cols).get()).toEqual(sqlite.prepare(cols).get());
			expect(b.prepare(cols).get()).toMatchObject({ ended_reason: 'ended', played_ms: 190_000 });
			const sess = `SELECT origin, kind, started_at, ended_at FROM play_session`;
			expect(b.prepare(sess).all()).toEqual(sqlite.prepare(sess).all());
			// Replaying the whole log again, in reverse, lands on the same row.
			applyOps(b, [...ops].reverse());
			expect(b.prepare(cols).get()).toEqual(sqlite.prepare(cols).get());
		} finally {
			b.close();
		}
	});
});
