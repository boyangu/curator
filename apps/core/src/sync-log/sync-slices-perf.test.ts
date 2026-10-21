// Main-loop slice bounds for sync work on a 40k-track library (cloud plan:
// streaming identity, stage 2 item 5; risk 6 "main-loop stalls"). The
// desktop runs core on Electron's main event loop, so every synchronous
// slice of sync work is a frame the UI cannot draw. Two shapes stalled it on
// the live library:
//   - the identity resolver's plan, run as one synchronous slice: 1,394 ms
//     cold on main's 600 MB library (2026-10-20, stage 1 LIVE log);
//   - a pull page (1,000 ops) applied with its playlist dedupe in one
//     transaction: up to 692 ms in the 2026-10-20 dry run.
// This file generates the incident's shape at the live library's scale and
// measures the synchronous slices of each, as the code reports them
// (maxSliceMs), one by one (every top-level transaction's wall time), and
// as a 1 ms interval timer sees the event loop (the worst gap between its
// ticks, which also catches work between slices).
//
// Measured 2026-10-20 (dev laptop, ~25% CPU load from unrelated processes;
// under ~95% the worst slices ran 2-3× these):
//                     before                         after
//   identity plan     one slice 540 ms               90 ms in 4 slices, longest 25 ms
//   merge chunks      50/chunk: ~200 ms, worst 535   20/chunk: p50 44, p90 79, worst 113 ms
//   pull page         one transaction per 1,000-op   time-sized sub-batches: p50 64,
//                     page: avg 148, worst 289 ms;   p90 103, worst 113 ms; worst loop
//                     the in-memory transport never  gap 119 ms
//                     yielded: one 8 s loop gap
// ("before" for merge chunks and pages is with other stage-2 changes that
// landed the same day; on stage 1 code pages ran up to 713 ms here.)
//
// The library (generated; never the live DB, CLAUDE.md): 40,000 rows —
// 12,000 local files with an audio hash, 28,000 Spotify tracks — with ISRCs
// on most, 30 tags on half the rows, a 5,000-row and a 2,000-row Spotify
// playlist and 40 local playlists of 150 rows, all through the real initial
// push. Then two other devices' ops arrive by pull, in the order a server
// would hold them:
//   - "profile" imported the same Spotify library before it pulled (the
//     2026-10-20 incident): 3,500 of the big playlist's tracks under its own
//     recording ids (half sorting below this device's, half above), each a
//     create, a confidence-1 claim, its metadata, a tag and a random-id row
//     in the big playlist;
//   - "desk-c" scanned 2,000 of the same files and, holding the loser, merged
//     its recordings onto this device's: a create, an audio-hash claim and
//     a merge each, the merges last so whole pages are merges.
// After the pull the identity resolver finds the 3,500 streaming groups and
// merges them, folding the doubled playlist rows.

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { opSchemaVersion, rebalance, trackTagEntityId, type StoredOp } from '@curator/protocol';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { FakeCloud } from '../test-support/fake-cloud.js';
import { createSyncClient } from './client.js';
import { planIdentityMerges, planIdentityMergesAsync, resolveRecordingIdentitiesAsync } from './identity.js';
import { initialPush } from './initial-push.js';
import { recordingIdForTrack } from './recording-id.js';

const N = 40_000;
const LOCAL = 12_000;
const BIG = 5_000;
const PROFILE_DUPES = 3_500;
const AUDIO_DUPES = 2_000;
const SP0 = LOCAL; // first Spotify track

// The target is ~100 ms a slice (a few dropped frames, not a frozen
// window). The bounds leave CI headroom over the numbers above, wide enough
// for a loaded machine's spikes (a worst merge chunk of 334 ms was seen
// under ~95% CPU load), so the structure is asserted too: the plan in
// several slices, a page in several transactions — a return to one
// transaction per page would pass a loose time bound on a fast machine.
const SLICE_BOUND_MS = 400;
const P90_BOUND_MS = 200;
const PLAN_SLICE_BOUND_MS = 150;

const dir = mkdtempSync(join(tmpdir(), 'curator-slices-perf-'));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ } });

const hash = (i: number): string => `pcm-md5:${i.toString(16).padStart(32, '0')}`;
// Recording ids that sort below / above every uuidv5 this device minted.
const lowRec = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const highRec = (i: number): string => `ffffffff-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

function generate(path: string): void {
	migrate(path);
	const { sqlite: raw } = createDb(path);
	const t0 = performance.now();
	raw.transaction(() => {
		const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, album_title, state, duration, bpm, key_camelot, isrc, rating, added_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
		const local = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash, fetched_at) VALUES (?, ?, 'local', ?, ?, ?, ?)`);
		const spotify = raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, 'spotify', ?, ?)`);
		const states = ['unsorted', 'backlog', 'progress', 'purchased'];
		for (let i = 0; i < N; i++) {
			const id = `t-${i}`;
			const at = 1_600_000_000_000 + i * 60_000;
			ins.run(id, recordingIdForTrack(id), `Song number ${i} (Extended Mix)`, JSON.stringify([{ name: `Artist ${i % 3_000}` }]), `Album ${i % 5_000}`,
				states[i % states.length], 240 + (i % 300), 118 + (i % 12), `${1 + (i % 12)}A`, i % 10 < 7 ? `GBXXX${String(2_000_000 + i).padStart(7, '0')}` : null,
				i % 5 === 0 ? 1 + (i % 5) : null, at, at, at);
			if (i < LOCAL) local.run(`l-${i}`, id, `c:/music/${id}.flac`, `c:/music/${id}.flac`, hash(i), at);
			else spotify.run(`s-${i}`, id, `sp-${i}`, at);
		}
		const tag = raw.prepare(`INSERT INTO tag (id, name, kind, created_at) VALUES (?, ?, 'user', 1600000000000)`);
		for (let g = 0; g < 30; g++) tag.run(`tag-${g}`, `Tag ${g}`);
		const tt = raw.prepare(`INSERT INTO track_tag (track_id, tag_id, added_at) VALUES (?, ?, 1600000000000)`);
		for (let i = 0; i < N; i += 2) tt.run(`t-${i}`, `tag-${i % 30}`);
		const pl = raw.prepare(`INSERT INTO playlist (id, source, source_id, name, created_at) VALUES (?, ?, ?, ?, 1600000000000)`);
		const row = raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES (?, ?, ?, ?, ?, 1600000000000, ?)`);
		const fill = (pid: string, from: number, n: number, sp: boolean): void => {
			const keys = rebalance(n);
			for (let k = 0; k < n; k++) row.run(`${pid}-r${k}`, pid, `t-${from + k}`, keys[k], k, sp ? `sp-${from + k}` : `t-${from + k}`);
		};
		pl.run('pl-big', 'spotify', 'spBig', 'Deep Techno');
		fill('pl-big', SP0, BIG, true);
		pl.run('pl-mid', 'spotify', 'spMid', 'Seasonal Mixtapes');
		fill('pl-mid', SP0 + 10_000, 2_000, true);
		for (let p = 0; p < 40; p++) {
			pl.run(`pl-loc-${p}`, 'local', `loc-${p}`, `Crate ${p}`);
			fill(`pl-loc-${p}`, (p * 997) % (N - 150), 150, false);
		}
	})();
	const t1 = performance.now();
	const pushed = initialPush(raw);
	process.stdout.write(`[slices] generated ${N} rows in ${Math.round(t1 - t0)} ms; initial push ${JSON.stringify(pushed.byEntity ?? {})} in ${Math.round(performance.now() - t1)} ms\n`);
	raw.close();
}

// The other devices' ops as the server holds them.
function remoteLog(cloud: FakeCloud): void {
	let seq = cloud.maxSeq;
	let ts = 1_760_000_000_000;
	const push = (device: string, entity: string, entity_id: string, kind: string, payload: unknown): void => {
		const op = { op_id: randomUUID(), device_id: device, client_ts: ts++, schema_version: opSchemaVersion({ entity, kind }), entity, entity_id, kind, payload };
		cloud.appendRaw({ ...op, seq: ++seq, user_id: 'u', received_at: ts } as unknown as StoredOp);
	};
	const keys = rebalance(BIG);
	for (let k = 0; k < PROFILE_DUPES; k++) {
		const i = SP0 + k;
		const rec = k % 2 === 0 ? lowRec(k) : highRec(k);
		push('dev-profile', 'library_track', rec, 'create', { added_at: 1_755_000_000_000 + k });
		push('dev-profile', 'recording_claim', rec, 'add', { kind: 'spotify', value: `sp-${i}`, confidence: 1 });
		push('dev-profile', 'library_track', rec, 'set-meta', {
			source: 'spotify', title: `Song number ${i} (Extended Mix)`, artists: [{ name: `Artist ${i % 3_000}` }], album_title: `Album ${i % 5_000}`,
			duration_sec: 240 + (i % 300), isrc: null, release_date: '2020-01-01', label: null, genre: null, cover_url: null,
		});
		push('dev-profile', 'track_tag', trackTagEntityId(rec, `tag-${k % 30}`), 'add', {});
		push('dev-profile', 'playlist_track', randomUUID(), 'add', { playlist_id: 'pl-big', recording_id: rec, order_key: keys[k] });
	}
	for (let i = 0; i < AUDIO_DUPES; i++) {
		push('desk-c', 'library_track', highRec(100_000 + i), 'create', { added_at: 1_756_000_000_000 + i });
		push('desk-c', 'recording_claim', highRec(100_000 + i), 'add', { kind: 'audio_hash', value: hash(i), confidence: 1 });
	}
	for (let i = 0; i < AUDIO_DUPES; i++) push('desk-c', 'recording', highRec(100_000 + i), 'merge', { winner: recordingIdForTrack(`t-${i}`) });
}

// The longest gap between ticks of a 1 ms interval while `run` is pending:
// the longest the event loop was held, whoever held it.
async function worstGap<T>(run: () => Promise<T>): Promise<{ result: T; gapMs: number }> {
	let gap = 0;
	let last = performance.now();
	const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 1);
	try {
		const result = await run();
		return { result, gapMs: Math.max(gap, performance.now() - last) };
	} finally {
		clearInterval(timer);
	}
}

// Every top-level transaction's wall time (its commit included) while
// `run` is pending: the slices, one by one.
async function txTimes<T>(raw: Database.Database, run: () => Promise<T>): Promise<{ result: T; times: number[] }> {
	const times: number[] = [];
	const own = Object.getOwnPropertyDescriptor(raw, 'transaction');
	const orig = raw.transaction.bind(raw);
	let depth = 0;
	(raw as { transaction: unknown }).transaction = (fn: (...a: unknown[]) => unknown) => {
		const tx = orig(fn);
		return (...a: unknown[]) => {
			const top = depth++ === 0;
			const t = performance.now();
			try { return tx(...a); } finally { depth--; if (top) times.push(performance.now() - t); }
		};
	};
	try {
		return { result: await run(), times };
	} finally {
		if (own) Object.defineProperty(raw, 'transaction', own);
		else delete (raw as { transaction?: unknown }).transaction;
	}
}

const spread = (xs: number[]): string => {
	const s = [...xs].sort((a, b) => a - b);
	const at = (q: number): string => (s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0).toFixed(0);
	return `n=${s.length} p50=${at(0.5)} p90=${at(0.9)} p99=${at(0.99)} max=${at(1)} (#${xs.indexOf(s[s.length - 1]!)})`;
};

const pct = (xs: number[], q: number): number => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
};

describe('sync slices on a generated 40,000-track library', () => {
	const path = join(dir, 'lib.db');

	it('a pull of two devices\' imports and merges never holds the loop for long', async () => {
		generate(path);
		const { sqlite: raw } = createDb(path);
		const cloud = new FakeCloud();
		remoteLog(cloud);
		const client = createSyncClient({ db: raw, transport: cloud.transport('u'), debounceMs: 1 });
		try {
			const { result: { result: r, gapMs }, times } = await txTimes(raw, () => worstGap(() => client.pullOnce()));
			process.stdout.write(`[slices] pull ops=${r.received} pages=${r.pages} applied=${r.applied} maxSliceMs=${r.maxSliceMs.toFixed(1)} worstLoopGapMs=${gapMs.toFixed(1)} transactions ${spread(times)}\n`);
			expect(r.received).toBe(PROFILE_DUPES * 5 + AUDIO_DUPES * 3);
			expect(r.stopped).toBeNull();
			// desk-c's merges moved this device's rows' records onto its own
			// recordings, not the other way round: the rows stay.
			expect(raw.prepare(`SELECT count(*) FROM recording_alias WHERE winner LIKE 'ffffffff-%' OR loser LIKE 'ffffffff-%'`).pluck().get()).toBe(AUDIO_DUPES);
			// Several transactions a page, none long.
			expect(times.length).toBeGreaterThan(r.pages * 3);
			expect(r.maxSliceMs).toBeLessThan(SLICE_BOUND_MS);
			expect(gapMs).toBeLessThan(SLICE_BOUND_MS);
			expect(pct(times, 0.9)).toBeLessThan(P90_BOUND_MS);
		} finally {
			client.stop();
			raw.close();
		}
	}, 600_000);

	it('the identity resolver plans and merges the incident\'s groups in short slices', async () => {
		const { sqlite: raw } = createDb(path);
		try {
			const t0 = performance.now();
			const syncPlan = planIdentityMerges(raw);
			const syncMs = performance.now() - t0;
			const { result: asyncPlan, gapMs: planGap } = await worstGap(() => planIdentityMergesAsync(raw));
			process.stdout.write(`[slices] plan groups=${syncPlan.groups} streaming=${syncPlan.streamingGroups} merges=${syncPlan.merges.length} held=${syncPlan.held.length} oneSliceMs=${syncMs.toFixed(1)} sliced: maxSliceMs=${asyncPlan.maxSliceMs.toFixed(1)} slices=${asyncPlan.slices} worstLoopGapMs=${planGap.toFixed(1)}\n`);
			// The sliced plan is the plan.
			expect(asyncPlan.plan).toEqual(syncPlan);
			expect(syncPlan.streamingGroups).toBe(PROFILE_DUPES);
			expect(syncPlan.merges).toHaveLength(PROFILE_DUPES);
			expect(asyncPlan.slices).toBeGreaterThan(1);
			expect(asyncPlan.maxSliceMs).toBeLessThan(PLAN_SLICE_BOUND_MS);
			expect(planGap).toBeLessThan(PLAN_SLICE_BOUND_MS);

			const { result: { result: r, gapMs }, times } = await txTimes(raw, () => worstGap(() => resolveRecordingIdentitiesAsync(raw)));
			process.stdout.write(`[slices] resolve merged=${r.merged} chunks=${r.chunks} total=${r.ms}ms maxSliceMs=${r.maxSliceMs.toFixed(1)} worstLoopGapMs=${gapMs.toFixed(1)} chunks ${spread(times)}\n`);
			expect(r.merged).toBe(PROFILE_DUPES);
			expect(r.maxSliceMs).toBeLessThan(SLICE_BOUND_MS);
			expect(gapMs).toBeLessThan(SLICE_BOUND_MS);
			expect(pct(times, 0.9)).toBeLessThan(P90_BOUND_MS);
			// Healed: the big playlist holds one row per entry again.
			expect(raw.prepare(`SELECT count(*) FROM playlist_track WHERE playlist_id = 'pl-big'`).pluck().get()).toBe(BIG);
			// What every later run costs (each pull and push runs it).
			const idle = await planIdentityMergesAsync(raw);
			process.stdout.write(`[slices] idle re-plan merges=${idle.plan.merges.length} maxSliceMs=${idle.maxSliceMs.toFixed(1)} slices=${idle.slices}
`);
			expect(idle.plan.merges).toEqual([]);
		} finally {
			raw.close();
		}
	}, 600_000);
});
