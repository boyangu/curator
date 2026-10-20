// Artist alias rules on the desktop (library/artist-alias.ts): the shared
// credit transform, the artist-table projection for remove and cycles, and
// the chunked rewrite of a large rename on the pulling device.
//
// Generated DBs only (CLAUDE.md): mkdtempSync + migrate(); no remote-write
// policy, and a throwing Spotify adapter on the one service built here.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { parseOp, opSchemaVersion, type Op } from '@curator/protocol';
import { artistKey, getSourceCapabilities } from '@curator/shared';
import { migrate } from '../db/migrate.js';
import { createCoreService, type CoreService } from '../service.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import { applyOps, INLINE_ARTIST_REWRITE_ROWS } from '../sync-log/apply.js';
import { initialPush } from '../sync-log/initial-push.js';
import { readOutbox } from '../sync-log/outbox.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { artistCreditRewritePending, drainArtistCreditRewrites, drainArtistCreditRewritesAsync, loadArtistAliasMap, mapCredits } from './artist-alias.js';
import { normalizeIncomingArtistsRaw, syncTrackArtistsByIdRaw } from './artists.js';

let dir: string;
const handles: Database.Database[] = [];
const services: CoreService[] = [];

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-artist-alias-')); });
afterEach(() => {
	for (const s of services.splice(0)) s.close();
	for (const h of handles.splice(0)) { try { h.close(); } catch { /* */ } }
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function freshDb(name: string): Database.Database {
	const p = join(dir, `${name}.db`);
	migrate(p);
	const raw = new Database(p);
	raw.pragma('foreign_keys = ON');
	handles.push(raw);
	return raw;
}

function seed(raw: Database.Database, rows: ReadonlyArray<readonly [string, ReadonlyArray<{ name: string }>]>): void {
	raw.transaction(() => {
		const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, ?, 'unsorted', 300)`);
		for (const [id, artists] of rows) ins.run(id, recordingIdForTrack(id), `Title ${id}`, JSON.stringify(artists));
		syncTrackArtistsByIdRaw(raw, rows.map(([id]) => id));
	})();
}

let n = 0;
function rule(from: string, to: string, ts: number): Op {
	return parseOp({
		op_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, device_id: 'other', client_ts: ts,
		schema_version: opSchemaVersion({ entity: 'artist_alias', kind: 'set' }),
		entity: 'artist_alias', entity_id: artistKey(from), kind: 'set', payload: { from, to, to_key: artistKey(to) },
	});
}
function remove(from: string, ts: number): Op {
	return parseOp({
		op_id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, device_id: 'other', client_ts: ts,
		schema_version: opSchemaVersion({ entity: 'artist_alias', kind: 'remove' }),
		entity: 'artist_alias', entity_id: artistKey(from), kind: 'remove', payload: {},
	});
}

const credits = (raw: Database.Database, id: string) => JSON.parse(raw.prepare(`SELECT artists FROM track WHERE id = ?`).pluck().get(id) as string) as unknown;
const liveName = (raw: Database.Database, name: string): string | null => {
	let row = raw.prepare(`SELECT id, name, merged_into FROM artist WHERE name_ascii = ?`).get(artistKey(name)) as { id: string; name: string; merged_into: string | null } | undefined;
	for (let i = 0; row?.merged_into && i < 8; i++) row = raw.prepare(`SELECT id, name, merged_into FROM artist WHERE id = ?`).get(row.merged_into) as typeof row;
	return row?.name ?? null;
};

describe('mapCredits', () => {
	const to = (m: Record<string, string>) => (k: string) => m[k];
	it('maps by artist key, keeps roles, dedupes what collapses', () => {
		expect(mapCredits([{ name: 'Old  Name' }, { name: 'New Name', role: 'featured' }], to({ oldname: 'New Name' }))).toEqual({ list: [{ name: 'New Name' }], changed: true });
		expect(mapCredits([{ name: 'A' }, { name: 'B', role: 'remixer' }], to({ b: 'Bee' }))).toEqual({ list: [{ name: 'A' }, { name: 'Bee', role: 'remixer' }], changed: true });
	});
	it('leaves a list with no mapped key untouched, even one holding a duplicate', () => {
		const dup = [{ name: 'X' }, { name: 'x' }];
		expect(mapCredits(dup, to({ y: 'Y' }))).toEqual({ list: dup, changed: false });
		expect(mapCredits(null, to({ y: 'Y' }))).toEqual({ list: [], changed: false });
	});
	it('a spelling rule onto the same name is no change', () => {
		expect(mapCredits([{ name: 'Same' }], to({ same: 'Same' }))).toEqual({ list: [{ name: 'Same' }], changed: false });
	});
});

describe('pulled rules on the artist table', () => {
	// Credits derive from the source spelling and the converged rules, so a
	// device that saw the rule before its remove ends where one that pulled
	// both in a batch (and never rewrote anything) does.
	it('remove stops mapping new credits and withdraws the rewrite of existing ones', () => {
		const r = freshDb('remove');
		seed(r, [['t0', [{ name: 'Old' }]]]);
		applyOps(r, [rule('Old', 'New', 1000)]);
		expect(credits(r, 't0')).toEqual([{ name: 'New' }]);
		expect(normalizeIncomingArtistsRaw(r, [{ name: 'Old' }])).toEqual([{ name: 'New' }]);
		applyOps(r, [remove('Old', 2000)]);
		expect(credits(r, 't0')).toEqual([{ name: 'Old' }]);
		expect(r.prepare(`SELECT artists_base FROM track WHERE id = 't0'`).pluck().get()).toBeNull();
		const batch = freshDb('remove-batch');
		seed(batch, [['t0', [{ name: 'Old' }]]]);
		applyOps(batch, [rule('Old', 'New', 1000), remove('Old', 2000)]);
		expect(credits(batch, 't0')).toEqual([{ name: 'Old' }]);
		expect(normalizeIncomingArtistsRaw(r, [{ name: 'Old' }])).toEqual([{ name: 'Old' }]);
		expect(loadArtistAliasMap(r).size).toBe(0);
		// A stale set (earlier than the remove) changes nothing.
		applyOps(r, [rule('Old', 'Newer', 1500)]);
		expect(normalizeIncomingArtistsRaw(r, [{ name: 'Old' }])).toEqual([{ name: 'Old' }]);
	});

	it('a cycle A→B then B→A ends with B renamed back to A, in either arrival order', () => {
		const ab = rule('Aa', 'Bb', 1000);
		const ba = rule('Bb', 'Aa', 2000);
		for (const order of [[ab, ba], [ba, ab]]) {
			const r = freshDb(`cycle-${order[0]!.client_ts}`);
			seed(r, [['t0', [{ name: 'Aa' }]], ['t1', [{ name: 'Bb' }]]]);
			for (const o of order) applyOps(r, [o]);
			expect(credits(r, 't0')).toEqual([{ name: 'Aa' }]);
			expect(credits(r, 't1')).toEqual([{ name: 'Aa' }]);
			expect(liveName(r, 'Bb')).toBe('Aa');
			expect(liveName(r, 'Aa')).toBe('Aa');
			expect(normalizeIncomingArtistsRaw(r, [{ name: 'bb' }])).toEqual([{ name: 'Aa' }]);
		}
	});

	it('a chain A→B, B→C lands every credit on C whichever rule arrives first', () => {
		const ab = rule('Aa', 'Bb', 1000);
		const bc = rule('Bb', 'Cc', 900);
		for (const order of [[ab, bc], [bc, ab]]) {
			const r = freshDb(`chain-${order[0]!.client_ts}`);
			seed(r, [['t0', [{ name: 'Aa' }]], ['t1', [{ name: 'Bb' }, { name: 'Aa' }]]]);
			for (const o of order) applyOps(r, [o]);
			expect(credits(r, 't0')).toEqual([{ name: 'Cc' }]);
			expect(credits(r, 't1')).toEqual([{ name: 'Cc' }]);
			expect(normalizeIncomingArtistsRaw(r, [{ name: 'Aa' }])).toEqual([{ name: 'Cc' }]);
		}
	});

	it('a rule for an artist this device has never seen still maps its later ingests', () => {
		const r = freshDb('unseen');
		seed(r, [['t0', [{ name: 'Someone' }]]]);
		applyOps(r, [rule('Ghost', 'Spirit', 1000)]);
		expect(normalizeIncomingArtistsRaw(r, [{ name: 'Ghost' }])).toEqual([{ name: 'Spirit' }]);
		expect(credits(r, 't0')).toEqual([{ name: 'Someone' }]);
	});
});

function throwingAdapter(): StreamingSourceAdapter {
	const boom = async (): Promise<never> => { throw new Error('upstream write attempted in an artist alias test'); };
	return {
		source: 'spotify', displayName: 'Fake Spotify', capabilities: getSourceCapabilities('spotify'),
		listRemotePlaylists: async () => [], fetchPlaylistTracks: async () => [],
		createPlaylist: boom, deletePlaylist: boom, renamePlaylist: boom, addTracks: boom, removeTracks: boom, replaceTracks: boom,
	};
}

describe('a 5,000-track rename on the pulling device', () => {
	it('stays off the main loop: apply only queues, the rewrite runs in yielding chunks', async () => {
		const LIBRARY = 20_000;
		const RENAMED = 5_000;
		const rows = Array.from({ length: LIBRARY }, (_, i) => {
			const id = `t-${String(i).padStart(5, '0')}-${randomUUID().slice(0, 4)}`;
			return [id, i % (LIBRARY / RENAMED) === 0 ? [{ name: 'Big Artist' }, { name: `Guest ${i % 50}` }] : [{ name: `Other ${i % 2000}` }]] as const;
		});
		const p = join(dir, 'source.db');
		migrate(p);
		const source = new Database(p);
		handles.push(source);
		seed(source, rows);
		initialPush(source);
		const replicaPath = join(dir, 'replica.db');
		source.exec(`VACUUM INTO '${replicaPath.replace(/'/g, "''")}'`);
		const replica = new Database(replicaPath);
		handles.push(replica);
		const before = new Set((readOutbox(source)).map((o) => o.op_id));

		const svc = createCoreService(p, { peaksDir: join(dir, 'peaks'), sourceAdapters: { spotify: throwingAdapter() } });
		services.push(svc);
		const id = source.prepare(`SELECT id FROM artist WHERE name = 'Big Artist'`).pluck().get() as string;
		const t0 = performance.now();
		const res = await svc.renameArtist(id, 'Huge Artist');
		const localMs = performance.now() - t0;
		expect(res.tracksRewritten).toBe(RENAMED);
		const ops = readOutbox(source).filter((o) => !before.has(o.op_id));
		expect(ops.map((o) => `${o.entity}.${o.kind}`).sort()).toEqual(['artist_alias.set', 'artist_alias.set']);

		const a0 = performance.now();
		applyOps(replica, ops);
		const applyMs = performance.now() - a0;
		expect(artistCreditRewritePending(replica)).toBe(true);
		// Ingest is right from the apply commit on, before the drain.
		expect(normalizeIncomingArtistsRaw(replica, [{ name: 'Big Artist' }])).toEqual([{ name: 'Huge Artist' }]);

		let timerGap = 0;
		let last = performance.now();
		const ticker = setInterval(() => { const now = performance.now(); timerGap = Math.max(timerGap, now - last); last = now; }, 1);
		const d0 = performance.now();
		const drain = await drainArtistCreditRewritesAsync(replica, { chunk: 1_000 });
		const drainMs = performance.now() - d0;
		clearInterval(ticker);
		console.log(`[artist-alias stall] library=${LIBRARY} renamed=${RENAMED} localRename=${localMs.toFixed(0)}ms apply=${applyMs.toFixed(0)}ms (inline rewrite only up to ${INLINE_ARTIST_REWRITE_ROWS} tracks) drain=${drainMs.toFixed(0)}ms chunks=${drain.chunks} maxSlice=${drain.maxSliceMs.toFixed(1)}ms worstTimerGap=${timerGap.toFixed(1)}ms`);

		expect(drain.done).toBe(true);
		expect(artistCreditRewritePending(replica)).toBe(false);
		const renamedOn = (h: Database.Database) => h.prepare(`SELECT count(*) FROM track WHERE artists LIKE '%Huge Artist%'`).pluck().get();
		expect(renamedOn(replica)).toBe(RENAMED);
		expect(renamedOn(source)).toBe(RENAMED);
		const credit = (h: Database.Database) => h.prepare(`SELECT id, artists FROM track ORDER BY id`).all();
		expect(credit(replica)).toEqual(credit(source));
		// Each slice is bounded by its chunk, not by the size of the rename.
		expect(drain.chunks).toBeGreaterThanOrEqual(LIBRARY / 1_000);
		expect(drain.maxSliceMs).toBeLessThan(500);
	}, 180_000);

	// The size the derivation was sized against: a 5k library where one
	// rename touches 1k tracks, then another device's later rename of the
	// same artist winning on the device that renamed first (every one of
	// those 1k rows re-derived from its recorded source credits).
	it('5k library, 1k renamed: local rename, pulled apply, and a losing rename re-derived', async () => {
		const LIBRARY = 5_000;
		const RENAMED = 1_000;
		const rows = Array.from({ length: LIBRARY }, (_, i) => {
			const id = `t-${String(i).padStart(5, '0')}`;
			return [id, i % (LIBRARY / RENAMED) === 0 ? [{ name: 'Big Artist' }, { name: `Guest ${i % 50}` }] : [{ name: `Other ${i % 2000}` }]] as const;
		});
		const p = join(dir, 'source5k.db');
		migrate(p);
		const source = new Database(p);
		handles.push(source);
		seed(source, rows);
		initialPush(source);
		const replicaPath = join(dir, 'replica5k.db');
		source.exec(`VACUUM INTO '${replicaPath.replace(/'/g, "''")}'`);
		const replica = new Database(replicaPath);
		handles.push(replica);
		const before = new Set(readOutbox(source).map((o) => o.op_id));

		const svc = createCoreService(p, { peaksDir: join(dir, 'peaks5k'), sourceAdapters: { spotify: throwingAdapter() } });
		services.push(svc);
		const t0 = performance.now();
		const res = await svc.renameArtist(source.prepare(`SELECT id FROM artist WHERE name = 'Big Artist'`).pluck().get() as string, 'Huge Artist');
		const localMs = performance.now() - t0;
		expect(res.tracksRewritten).toBe(RENAMED);
		const ops = readOutbox(source).filter((o) => !before.has(o.op_id));
		// Local projection only: the rename's rules, no op per track.
		expect(ops.map((o) => `${o.entity}.${o.kind}`)).toEqual(['artist_alias.set', 'artist_alias.set']);

		const a0 = performance.now();
		applyOps(replica, ops);
		const applyMs = performance.now() - a0;
		const drain = await drainArtistCreditRewritesAsync(replica, { chunk: 1_000 });
		expect(drain.tracksRewritten).toBe(RENAMED);

		// Another device renamed "Big Artist" too, later: its rule wins the key.
		const c0 = performance.now();
		applyOps(source, [rule('Big Artist', 'Giant Artist', Date.now() + 60_000)]);
		const contestApplyMs = performance.now() - c0;
		const contest = await drainArtistCreditRewritesAsync(source, { chunk: 1_000 });
		expect(contest.tracksRewritten).toBe(RENAMED);
		expect(source.prepare(`SELECT count(*) FROM track WHERE artists LIKE '%Giant Artist%'`).pluck().get()).toBe(RENAMED);
		expect(source.prepare(`SELECT count(*) FROM track WHERE artists LIKE '%Huge Artist%'`).pluck().get()).toBe(0);
		console.log(`[artist-alias 5k] renamed=${RENAMED} localRename=${localMs.toFixed(0)}ms pulledApply=${applyMs.toFixed(0)}ms pulledDrain=${drain.chunks} chunks maxSlice=${drain.maxSliceMs.toFixed(1)}ms`
			+ ` contestedApply=${contestApplyMs.toFixed(0)}ms contestedDrain=${contest.chunks} chunks maxSlice=${contest.maxSliceMs.toFixed(1)}ms`);
		expect(drain.maxSliceMs).toBeLessThan(500);
		expect(contest.maxSliceMs).toBeLessThan(500);
	}, 120_000);

	it('an interrupted drain resumes from its cursor', () => {
		const r = freshDb('resume');
		seed(r, Array.from({ length: 30 }, (_, i) => [`t-${String(i).padStart(2, '0')}`, [{ name: 'Old' }]] as const));
		// The rule's inline drain covers 30 rows, so reset the credits and
		// queue the job by hand to exercise the cursor.
		applyOps(r, [rule('Old', 'New', 1000)]);
		r.prepare(`UPDATE track SET artists = '[{"name":"Old"}]'`).run();
		r.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES ('sync.artist_rewrite', ?, 0)`).run(JSON.stringify([{ keys: ['old'], after: '' }]));
		expect(drainArtistCreditRewrites(r, { maxRows: 10 })).toMatchObject({ rowsScanned: 10, tracksRewritten: 10, done: false });
		expect(drainArtistCreditRewrites(r, { maxRows: 10 })).toMatchObject({ rowsScanned: 10, tracksRewritten: 10, done: false });
		expect(drainArtistCreditRewrites(r)).toMatchObject({ rowsScanned: 10, tracksRewritten: 10, done: true });
		expect(r.prepare(`SELECT count(*) FROM track WHERE artists LIKE '%New%'`).pluck().get()).toBe(30);
	});
});
