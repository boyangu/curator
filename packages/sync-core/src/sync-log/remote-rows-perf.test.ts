// Main-loop guard for the protocol v3 drains (cloud plan: streaming identity
// §3, risk 6): the one-time meta backfill of a device's own rows and a fresh
// device materialising another device's whole library both run in yielding
// slices; no slice may hold the loop for long. A generated 10,000-track
// library (rows, source links, one large playlist and tags on the meta side)
// keeps the suite's time sane; the slice sizes are per-row bounded, so the
// result carries to 40k.
//
// Reference numbers, 2026-10-20, dev laptop, alone: meta drain (100 rows a
// slice) max 41-51 ms; a 1,000-op set-meta pull page (25 rows made inline,
// the rest queued) 87-91 ms; pending drain (20 rows a slice, each projected
// with its tags and its row in a 2,000-row playlist) median 24, p95 73, max
// 101 ms. Under the parallel suite a slice has been seen at ~400 ms (GC and
// the other suites' load), so this file runs on its own after it (the perf
// projects, vitest.workspace.ts) and the bound scales with the machine's
// measured slowdown (test-support/timing.ts): it fails a regression in kind
// — a slice that scales with the library — not a few ms. A max is where a
// scheduler stall lands: run beside another full suite, a 47-101 ms drain
// read 457 ms at ×1.7 load.

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opSchemaVersion, rebalance } from '@curator/protocol';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { applyOps } from './apply.js';
import { readOutbox } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';
import { drainTrackDerivationsAsync, remotePendingCount, remoteRowCount } from './remote-rows.js';
import { drainRemotePendingAsync } from './remote-sweep.js';
import { drainTrackMetaAsync, queueTrackMetaBackfillAsync } from './track-meta.js';
import { budgetMs } from '../test-support/timing.js';

const N = 10_000;
const SLICE_BOUND_MS = 600;

describe('protocol v3 drains on a generated 10,000-track library', () => {
	it('states the meta, materialises it elsewhere, and never holds the loop for long', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'curator-remote-perf-'));
		try {
			// Device A: the library, its meta stated by the backfill.
			const pa = join(dir, 'a.db');
			migrate(pa);
			const { sqlite: a } = createDb(pa);
			const ins = a.prepare(`INSERT INTO track (id, recording_id, title, artists, album_title, duration, state, created_at) VALUES (?, ?, ?, ?, ?, 300, 'unsorted', ?)`);
			const link = a.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, 'spotify', ?, 1)`);
			a.transaction(() => {
				for (let i = 0; i < N; i++) {
					ins.run(`t${i}`, recordingIdForTrack(`t${i}`), `Song ${i}`, JSON.stringify([{ name: `Artist ${i % 700}` }]), `Album ${i % 1500}`, 1_700_000_000_000 + i);
					link.run(`sl${i}`, `t${i}`, `sp${i}`);
				}
			})();
			await queueTrackMetaBackfillAsync(a);
			const meta = await drainTrackMetaAsync(a, { role: { speaks: 'all' } });
			expect(meta.emitted).toBe(N);
			const metaOps = readOutbox(a).filter((o) => o.kind === 'set-meta');
			a.close();

			// Device B: nothing of its own; a playlist and tags over the account.
			const pb = join(dir, 'b.db');
			migrate(pb);
			const { sqlite: b } = createDb(pb);
			let ts = 1_760_000_000_000;
			const op = (entity: string, id: string, kind: string, payload: unknown): Record<string, unknown> =>
				({ op_id: randomUUID(), device_id: 'dev-a', client_ts: ts++, schema_version: opSchemaVersion({ entity, kind, entity_id: id }), entity, entity_id: id, kind, payload });
			const keys = rebalance(2_000);
			const curation = [
				op('tag', 'tg', 'create', { name: 'Peak', kind: 'user', color: null }),
				op('playlist', 'pl', 'create', { name: 'Big', folder_id: null, source_link: null }),
				...Array.from({ length: 2_000 }, (_, i) => op('playlist_track', `row${i}`, 'add', { playlist_id: 'pl', recording_id: recordingIdForTrack(`t${i * 5}`), order_key: keys[i] })),
				...Array.from({ length: 3_000 }, (_, i) => op('track_tag', `${recordingIdForTrack(`t${i * 3}`)}:tg`, 'add', {})),
			];
			for (let i = 0; i < curation.length; i += 1_000) applyOps(b, curation.slice(i, i + 1_000));
			let worstPage = 0;
			for (let i = 0; i < metaOps.length; i += 1_000) {
				const t = performance.now();
				applyOps(b, metaOps.slice(i, i + 1_000));
				worstPage = Math.max(worstPage, performance.now() - t);
			}
			expect(remotePendingCount(b)).toBeGreaterThan(N / 2);
			const pending = await drainRemotePendingAsync(b);
			const derive = await drainTrackDerivationsAsync(b);
			expect(remoteRowCount(b)).toBe(N);
			expect(b.prepare(`SELECT count(*) FROM playlist_track WHERE playlist_id = 'pl'`).pluck().get()).toBe(2_000);
			expect(b.prepare(`SELECT count(*) FROM track_tag WHERE tag_id = 'tg'`).pluck().get()).toBe(3_000);
			b.close();

			console.log(JSON.stringify({ metaDrainMaxSliceMs: Math.round(meta.maxSliceMs), metaChunks: meta.chunks, pullPageMaxMs: Math.round(worstPage), pendingMaxSliceMs: Math.round(pending.maxSliceMs), pendingChunks: pending.chunks, deriveMaxSliceMs: Math.round(derive.maxSliceMs) }));
			expect(meta.maxSliceMs).toBeLessThan(budgetMs(SLICE_BOUND_MS, 'meta drain slice'));
			expect(worstPage).toBeLessThan(budgetMs(SLICE_BOUND_MS, 'pull page'));
			expect(pending.maxSliceMs).toBeLessThan(budgetMs(SLICE_BOUND_MS, 'pending drain slice'));
			expect(derive.maxSliceMs).toBeLessThan(budgetMs(SLICE_BOUND_MS, 'derive slice'));
		} finally {
			try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
		}
	}, 180_000);
});
