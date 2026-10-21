// One-time repair of play history projected without its track (the
// 2026-10-21 zero-loss audit, item 1). Projection step 4 read play sessions
// and events from the in-memory map without loading them first, so every
// projection over refs it had not joined itself — a remote row's adoption
// after the bootstrap, a bound streaming import — skipped them: a fresh
// second device kept its plays with track_id NULL (30,185 of 30,185 on the
// real second profile), because bootstrap projects events before the remote
// rows they belong to exist. The projection now loads them (project.ts);
// this re-projects what the old one left behind, once per device.
//
// What it touches: a session record with no row here, and an event record
// whose row is missing or has no track while its recording has a row on
// this device. A linked event is never re-pointed — this device's own plays
// on its own rows are correct already, and the heal must leave them alone
// (verified on a copy of the main library: nothing to do there). Each page
// goes through the ordinary projection in its own transaction, a yield
// between; the gate is set only by a run that finished.

import type Database from 'better-sqlite3';
import type { EntityRef } from '@curator/protocol';
import { log } from '../log.js';
import { project } from './project.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

const hlog = log.for('play-heal');

export const PLAY_HEAL_KEY = 'sync.heal.play_links_at';

export type PlayHealResult = { sessions: number; events: number; relinked: number; chunks: number; maxSliceMs: number };

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function playHealPending(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(PLAY_HEAL_KEY) === undefined;
}

export async function healPlayHistoryAsync(raw: Raw, opts: { page?: number } = {}): Promise<PlayHealResult> {
	// 250 records a slice: an event's projection is a handful of indexed
	// statements, but 500 measured up to 191 ms on a copy of the second
	// profile (2026-10-21; commits included).
	const page = Math.max(1, opts.page ?? 250);
	const out: PlayHealResult = { sessions: 0, events: 0, relinked: 0, chunks: 0, maxSliceMs: 0 };
	const alias = new Map((raw.prepare(`SELECT loser, winner FROM recording_alias`).all() as Array<{ loser: string; winner: string }>).map((r) => [r.loser, r.winner]));
	const hasRow = raw.prepare(`SELECT 1 FROM track WHERE recording_id = ? LIMIT 1`).pluck();
	const resolve = (r: string): string => {
		let cur = r;
		for (let i = 0; i < 16; i++) { const next = alias.get(cur); if (!next || next === cur) break; cur = next; }
		return cur;
	};
	const run = (refs: EntityRef[]): void => {
		if (refs.length === 0) return;
		const t0 = performance.now();
		raw.transaction(() => {
			project(raw, new SyncStateStore(raw), refs, { removed: [], removedTombstones: [], aliasChanged: false });
		})();
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.chunks++;
	};

	const sessions = raw.prepare(`SELECT s.key, p.id IS NULL AS missing FROM sync_state s LEFT JOIN play_session p ON p.id = s.key
		WHERE s.map = 'playSessions' AND s.key > ? ORDER BY s.key LIMIT ?`);
	for (let after = ''; ;) {
		const rows = sessions.all(after, page) as Array<{ key: string; missing: number }>;
		if (rows.length === 0) break;
		after = rows[rows.length - 1]!.key;
		const refs = rows.filter((r) => r.missing).map((r) => ({ entity: 'play_session' as const, id: r.key }));
		out.sessions += refs.length;
		run(refs);
		await yieldToLoop();
	}

	const events = raw.prepare(`SELECT s.key, s.recording_id AS rec, pe.id IS NULL AS missing, pe.track_id AS track FROM sync_state s
		LEFT JOIN play_event pe ON pe.id = s.key
		WHERE s.map = 'playEvents' AND s.key > ? ORDER BY s.key LIMIT ?`);
	const linked = raw.prepare(`SELECT count(*) FROM play_event WHERE id IN (SELECT value FROM json_each(?)) AND track_id IS NOT NULL`).pluck();
	for (let after = ''; ;) {
		const rows = events.all(after, page) as Array<{ key: string; rec: string | null; missing: number; track: string | null }>;
		if (rows.length === 0) break;
		after = rows[rows.length - 1]!.key;
		const want = rows.filter((r) => (r.missing || r.track === null) && r.rec !== null && hasRow.get(resolve(r.rec)) !== undefined);
		if (want.length > 0) {
			const ids = JSON.stringify(want.map((r) => r.key));
			const before = linked.get(ids) as number;
			run(want.map((r) => ({ entity: 'play_event' as const, id: r.key })));
			out.relinked += (linked.get(ids) as number) - before;
			out.events += want.length;
		}
		await yieldToLoop();
	}

	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(PLAY_HEAL_KEY, JSON.stringify(Date.now()), Date.now());
	if (out.sessions > 0 || out.events > 0) hlog.info('play history re-linked to its tracks', { ...out, maxSliceMs: Math.round(out.maxSliceMs) });
	return out;
}
