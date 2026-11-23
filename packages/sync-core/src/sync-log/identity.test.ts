// Recordings and their claims on the op log (initial push and the one-time
// backfill), the claim index, and the identity resolver's cost on a
// generated library. Cross-device behaviour is in two-desktops-identity.test.ts.
// Generated temp DBs only (CLAUDE.md).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { applyOps, INITIAL_PUSH_KEY } from './apply.js';
import { planIdentityMerges, resolveRecordingIdentitiesAsync } from './identity.js';
import { CLAIMS_BACKFILL_KEY, claimsBackfillAsync, claimsBackfillPending, initialPush } from './initial-push.js';
import { readOutbox } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';
import { budgetMs } from '../test-support/timing.js';

const R = recordingIdForTrack;

let dir: string;
const handles: Database.Database[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-identity-')); });
afterEach(() => {
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function freshDb(name = 'lib'): { path: string; raw: Database.Database } {
	const path = join(dir, `${name}.db`);
	migrate(path);
	const { sqlite } = createDb(path);
	handles.push(sqlite);
	return { path, raw: sqlite };
}

type Row = { id: string; isrc?: string; deleted?: boolean; derivedFrom?: string; recording?: string };
function insertTrack(raw: Database.Database, r: Row): void {
	raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, isrc, deleted_at, derived_from_track_id, added_at, created_at)
		VALUES (?, ?, ?, '[{"name":"Artist"}]', 'unsorted', 300, ?, ?, ?, ?, ?)`)
		.run(r.id, r.recording ?? R(r.id), `Title ${r.id}`, r.isrc ?? null, r.deleted ? 1_700_000_000_000 : null, r.derivedFrom ?? null, 1_650_000_000_000, 1_650_000_000_000);
}
function link(raw: Database.Database, trackId: string, source: string, sourceTrackId: string, extra: { hash?: string; print?: string; printSec?: number } = {}): void {
	raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path, audio_hash, fingerprint, fingerprint_duration_sec, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(`${source}-${trackId}-${sourceTrackId}`, trackId, source, sourceTrackId, source === 'local' ? sourceTrackId : null, extra.hash ?? null, extra.print ?? null, extra.printSec ?? null, 1_660_000_000_000);
}

const claimsIn = (raw: Database.Database): Array<[string, string, string, number]> =>
	readOutbox(raw).filter((o) => o.entity === 'recording_claim')
		.map((o) => { const p = o.payload as { kind: string; value: string; confidence: number }; return [o.entity_id, p.kind, p.value, p.confidence] as [string, string, string, number]; })
		.sort((a, b) => (a.join() < b.join() ? -1 : 1));
const createsIn = (raw: Database.Database): string[] =>
	readOutbox(raw).filter((o) => o.entity === 'library_track' && o.kind === 'create').map((o) => o.entity_id).sort();

// A library from before the op log, with every kind of identifying column.
function legacyLibrary(raw: Database.Database): void {
	insertTrack(raw, { id: 'loc', isrc: 'GBAAA2000001' });
	link(raw, 'loc', 'local', 'c:/m/loc.flac', { hash: 'pcm-md5:aa', print: 'AQAAprint', printSec: 120 });
	insertTrack(raw, { id: 'stream', isrc: 'USBBB2100002' });
	link(raw, 'stream', 'spotify', 'sp1');
	link(raw, 'stream', 'tidal', 'td1');
	link(raw, 'stream', 'beatport', 'bp1');
	link(raw, 'stream', 'traxsource', 'tx1'); // no claim kind
	insertTrack(raw, { id: 'gone', deleted: true });
	link(raw, 'gone', 'local', 'c:/m/gone.flac', { hash: 'pcm-md5:bb' });
	// A WAV copy is device-local: no create, no claim.
	insertTrack(raw, { id: 'wav', derivedFrom: 'loc' });
	link(raw, 'wav', 'local', 'c:/m/loc.wav', { hash: 'pcm-md5:aa' });
	// A merge loser's recording lives on in its winner.
	insertTrack(raw, { id: 'lost', deleted: true });
	raw.prepare(`INSERT INTO recording_alias (loser, winner) VALUES (?, ?)`).run(R('lost'), R('loc'));
	raw.prepare(`DELETE FROM app_setting WHERE key IN (?, ?)`).run(INITIAL_PUSH_KEY, CLAIMS_BACKFILL_KEY);
}

const EXPECTED_CLAIMS: Array<[string, string, string, number]> = ([
	[R('gone'), 'audio_hash', 'pcm-md5:bb', 1],
	[R('loc'), 'audio_hash', 'pcm-md5:aa', 1],
	[R('loc'), 'isrc', 'GBAAA2000001', 0.8],
	[R('stream'), 'beatport', 'bp1', 1],
	[R('stream'), 'isrc', 'USBBB2100002', 0.9],
	[R('stream'), 'spotify', 'sp1', 1],
	[R('stream'), 'tidal', 'td1', 1],
] as Array<[string, string, string, number]>).sort((a, b) => (a.join() < b.join() ? -1 : 1));

describe('recordings on the op log', () => {
	it('the initial push states every row as a recording with the claims its columns hold', () => {
		const { raw } = freshDb();
		legacyLibrary(raw);
		initialPush(raw);
		expect(createsIn(raw)).toEqual([R('gone'), R('loc'), R('stream')].sort());
		expect(claimsIn(raw)).toEqual(EXPECTED_CLAIMS);
		// The row holds a fingerprint, but the initial push does not replay
		// prints (initial-push.ts: nothing resolves on them yet, and they are
		// the heavy claims); new analyses still emit theirs.
		expect(readOutbox(raw).some((o) => o.entity === 'recording_claim' && (o.payload as { kind: string }).kind === 'fingerprint')).toBe(false);
		// Stamped with the row's history, not now.
		expect(readOutbox(raw).find((o) => o.entity === 'library_track' && o.kind === 'create')!.client_ts).toBe(1_650_000_000_000);
		expect(claimsBackfillPending(raw)).toBe(false);
		// Resumable: a second run finds everything recorded.
		const before = readOutbox(raw).length;
		initialPush(raw);
		expect(readOutbox(raw).length).toBe(before);
	});

	it('a library pushed before claims existed states them once through the backfill', async () => {
		const { raw } = freshDb();
		legacyLibrary(raw);
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1)`).run(INITIAL_PUSH_KEY);
		expect(claimsBackfillPending(raw)).toBe(true);
		const r = await claimsBackfillAsync(raw, { chunk: 3 });
		expect(r.chunks).toBeGreaterThan(1);
		expect(createsIn(raw)).toEqual([R('gone'), R('loc'), R('stream')].sort());
		expect(claimsIn(raw)).toEqual(EXPECTED_CLAIMS);
		expect(claimsBackfillPending(raw)).toBe(false);
		expect((await claimsBackfillAsync(raw)).ops).toBe(0);
	});

	it('an empty library is born owing no backfill', () => {
		const { raw } = freshDb();
		expect(claimsBackfillPending(raw)).toBe(false);
	});

	it('claim records are indexed by value, including ones written before the index (migrate)', () => {
		const { path, raw } = freshDb();
		legacyLibrary(raw);
		initialPush(raw);
		const indexed = (): Array<[string | null, string]> => raw.prepare(`SELECT parent_id, key FROM sync_state WHERE map = 'claims' ORDER BY key`).raw().all() as Array<[string | null, string]>;
		expect(indexed().find(([, k]) => k.endsWith(':audio_hash:pcm-md5:aa'))![0]).toBe('audio_hash:pcm-md5:aa');
		raw.prepare(`UPDATE sync_state SET parent_id = NULL WHERE map = 'claims'`).run();
		raw.prepare(`DELETE FROM app_setting WHERE key = 'sync.claim_index_version'`).run();
		migrate(path);
		expect(indexed().filter(([p]) => p !== null)).toHaveLength(EXPECTED_CLAIMS.length);
	});
});

// ── a generated library ─────────────────────────────────────────────────────

// N local files, each with an audio hash, a ~2 KB Chromaprint, an ISRC and a
// Spotify link: the shape of a DJ library's local tier.
function bigLibrary(raw: Database.Database, n: number): string[] {
	const ids = Array.from({ length: n }, (_, i) => `big-${i}`);
	raw.transaction(() => {
		const print = randomBytes(1_536).toString('base64');
		for (const [i, id] of ids.entries()) {
			insertTrack(raw, { id, isrc: `GBXXX${String(2_000_000 + i).padStart(7, '0')}` });
			link(raw, id, 'local', `c:/m/${id}.flac`, { hash: `pcm-md5:${i.toString(16).padStart(32, '0')}`, print: `${print}${i}`, printSec: 120 });
			link(raw, id, 'spotify', `sp-${i}`);
		}
	})();
	return ids;
}

describe('cost on a generated 5,000-track library', () => {
	it('the recordings backfill runs in short slices', async () => {
		const { raw } = freshDb('big');
		bigLibrary(raw, 5_000);
		raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, '1', 1) ON CONFLICT(key) DO NOTHING`).run(INITIAL_PUSH_KEY);
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(CLAIMS_BACKFILL_KEY);
		let worstGap = 0;
		let last = performance.now();
		const timer = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 1);
		const r = await claimsBackfillAsync(raw, { chunk: 500 });
		clearInterval(timer);
		console.log(`[claims backfill] tracks=5000 ops=${r.ops} chunks=${r.chunks} total=${r.ms}ms maxSlice=${r.maxSliceMs.toFixed(1)}ms worstTimerGap=${worstGap.toFixed(1)}ms`);
		// A create plus three claims per row (the generated row's fingerprint
		// is not replayed; initial-push.ts).
		expect(r.ops).toBe(5_000 * 4);
		// ~170 ms a slice alone, up to 559 ms under the parallel suite (×1.6
		// load); scaled with the load (test-support/timing.ts).
		expect(r.maxSliceMs).toBeLessThan(budgetMs(2_000, 'claims backfill slice'));
	}, 120_000);

	it('the resolver merges 5,000 rows another desktop already holds, in short slices', async () => {
		const { raw } = freshDb('big');
		const ids = bigLibrary(raw, 5_000);
		initialPush(raw);
		// Another desktop scanned the same 5,000 files first, under recording
		// ids that sort below every local one: this device holds each loser.
		const remote = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
		const ops: unknown[] = [];
		let ts = Date.now();
		for (let i = 0; i < ids.length; i++) {
			for (const [kind, payload] of [['create', { added_at: ts }], ['add', { kind: 'audio_hash', value: `pcm-md5:${i.toString(16).padStart(32, '0')}`, confidence: 1 }]] as const) {
				ops.push({ op_id: randomUUID(), device_id: 'remote-device', client_ts: ts++, schema_version: 1, entity: kind === 'create' ? 'library_track' : 'recording_claim', entity_id: remote(i), kind, payload });
			}
		}
		for (let i = 0; i < ops.length; i += 1_000) applyOps(raw, ops.slice(i, i + 1_000));
		const planStart = performance.now();
		const plan = planIdentityMerges(raw);
		const planMs = performance.now() - planStart;
		expect(plan.merges).toHaveLength(5_000);

		let worstGap = 0;
		let last = performance.now();
		const timer = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 1);
		const r = await resolveRecordingIdentitiesAsync(raw);
		clearInterval(timer);
		console.log(`[identity resolver] merges=${r.merged} chunks=${r.chunks} plan=${planMs.toFixed(1)}ms total=${r.ms}ms maxSlice=${r.maxSliceMs.toFixed(1)}ms worstTimerGap=${worstGap.toFixed(1)}ms`);
		expect(r.merged).toBe(5_000);
		expect(raw.prepare(`SELECT count(*) FROM track WHERE id LIKE 'big-%' AND recording_id LIKE '00000000-%'`).pluck().get()).toBe(5_000);
		expect(readOutbox(raw).filter((o) => o.entity === 'recording')).toHaveLength(5_000);
		// ~90-100 ms a slice alone, up to 633 ms under the parallel suite.
		expect(r.maxSliceMs).toBeLessThan(budgetMs(2_000, 'resolver slice'));
		// Nothing left: the next run is a plan over an empty index range.
		const again = performance.now();
		expect(planIdentityMerges(raw)).toMatchObject({ groups: 0, merges: [] });
		console.log(`[identity resolver] idle re-plan=${(performance.now() - again).toFixed(1)}ms`);
	}, 120_000);
});
