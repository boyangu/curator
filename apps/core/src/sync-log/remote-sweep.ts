// The sweep over every recording's record that makes, refreshes or absorbs
// remote rows (remote-rows.ts) outside a batch: once after the upgrade that
// introduced them (records pulled, or a snapshot loaded, by a build that
// never materialised: the v2-snapshot case), and again after every master
// change (requestRematerialize), which re-picks the meta of every remote
// row. Pages of records in key order, one transaction each with its
// projection, a yield between; the gate key is set only by a run that
// finished, so an interrupted one resumes from the start (each page is
// idempotent).

import type Database from 'better-sqlite3';
import { log } from '../log.js';
import { project } from './project.js';
import { MATERIALIZE_KEY } from './remote-rows.js';
import { SyncStateStore } from './store.js';

type Raw = Database.Database;

const rlog = log.for('remote-rows');

export type SweepResult = { records: number; created: number; tracksTouched: string[]; playlistsTouched: string[]; chunks: number; maxSliceMs: number };

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function sweepRemoteRowsAsync(raw: Raw, opts: { page?: number } = {}): Promise<SweepResult> {
	// 200 records per slice: 400 took up to ~150 ms on the real library
	// (measured 2026-10-20; the projection's per-recording reads).
	const page = Math.max(1, opts.page ?? 200);
	const out: SweepResult = { records: 0, created: 0, tracksTouched: [], playlistsTouched: [], chunks: 0, maxSliceMs: 0 };
	const tracks = new Set<string>();
	const playlists = new Set<string>();
	const keys = raw.prepare(`SELECT key FROM sync_state WHERE map = 'libraryTracks' AND key > ? ORDER BY key LIMIT ?`).pluck();
	const remoteBefore = raw.prepare(`SELECT count(*) FROM track WHERE remote_only = 1`).pluck();
	for (let after = ''; ;) {
		const batch = keys.all(after, page) as string[];
		if (batch.length === 0) break;
		after = batch[batch.length - 1]!;
		const t0 = performance.now();
		raw.transaction(() => {
			const n0 = remoteBefore.get() as number;
			// Through the projection like any batch: step 1c materialises each
			// library_track ref and projects what it adopts.
			const s = project(raw, new SyncStateStore(raw), batch.map((id) => ({ entity: 'library_track' as const, id })), { removed: [], removedTombstones: [], aliasChanged: false });
			out.created += Math.max(0, (remoteBefore.get() as number) - n0);
			for (const t of s.tracksTouched) tracks.add(t);
			for (const p of s.playlistsTouched) playlists.add(p);
		})();
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.records += batch.length;
		out.chunks++;
		await yieldToLoop();
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(MATERIALIZE_KEY, JSON.stringify(Date.now()), Date.now());
	out.tracksTouched = [...tracks];
	out.playlistsTouched = [...playlists];
	if (out.created > 0) rlog.info('remote rows: sweep done', { records: out.records, created: out.created, chunks: out.chunks, maxSliceMs: Math.round(out.maxSliceMs) });
	return out;
}

// The queued creations (remote-rows.ts INLINE_CREATE_ROWS): `chunk`
// recordings per transaction — each made row projected with its tags,
// cues and playlist rows in the same commit — a yield between. 20 keeps a
// slice near 60-80 ms on the real library (a row with its projection is
// ~2-3 ms there, plus the commit; measured 2026-10-20).
export async function drainRemotePendingAsync(raw: Raw, opts: { chunk?: number } = {}): Promise<SweepResult> {
	const chunk = Math.max(1, opts.chunk ?? 20);
	const out: SweepResult = { records: 0, created: 0, tracksTouched: [], playlistsTouched: [], chunks: 0, maxSliceMs: 0 };
	const tracks = new Set<string>();
	const playlists = new Set<string>();
	const next = raw.prepare(`SELECT recording_id FROM track_remote_pending LIMIT ?`).pluck();
	const remoteNow = raw.prepare(`SELECT count(*) FROM track WHERE remote_only = 1`).pluck();
	for (;;) {
		const t0 = performance.now();
		const batch = next.all(chunk) as string[];
		if (batch.length === 0) break;
		raw.transaction(() => {
			const n0 = remoteNow.get() as number;
			const s = project(raw, new SyncStateStore(raw), batch.map((id) => ({ entity: 'library_track' as const, id })), { removed: [], removedTombstones: [], aliasChanged: false }, { remoteCreateBudget: chunk });
			out.created += Math.max(0, (remoteNow.get() as number) - n0);
			for (const t of s.tracksTouched) tracks.add(t);
			for (const p of s.playlistsTouched) playlists.add(p);
			// What made no row (merged away since, no meta yet) leaves the
			// queue too: a later batch for it re-queues it if it must.
			raw.prepare(`DELETE FROM track_remote_pending WHERE recording_id IN (${batch.map(() => '?').join(',')})`).run(...batch);
		})();
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.records += batch.length;
		out.chunks++;
		await yieldToLoop();
	}
	out.tracksTouched = [...tracks];
	out.playlistsTouched = [...playlists];
	if (out.created > 0) rlog.info('remote rows: queued rows made', { recordings: out.records, created: out.created, chunks: out.chunks, maxSliceMs: Math.round(out.maxSliceMs) });
	return out;
}
