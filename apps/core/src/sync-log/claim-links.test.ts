// Claim-derived provider links (claim-links.ts), unit by unit: what a row
// gets from its recording's claims (own and remote rows, the pick among
// several claims), how they stay in step (an own link replaces one, a merge
// moves them, a drop is remembered), the one-time sweep, and the exclusions
// that make them display data only — no remote row turned own, no op, no
// claim restated by the initial push or the claims backfill, no identity
// own-row, no membership tier, and the matchers that treat them as matched
// without a crawl. Cross-device behaviour is in two-desktops-links.test.ts.
// Generated temp DBs only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { opSchemaVersion, type TrackMeta } from '@curator/protocol';
import type { TidalApiClient, TidalTrackV2 } from '@curator/tidal';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { MembershipClassifier } from '../library/membership.js';
import { SpotifySync } from '../sync/spotify.js';
import { TidalHybrid } from '../sync/tidal-hybrid.js';
import { applyOps, INITIAL_PUSH_KEY } from './apply.js';
import {
	CLAIM_LINKS_SWEEP_KEY, claimLinkPendingCount, claimLinksOf, claimLinksSwept, deriveClaimLinks, dismissClaimLink, drainClaimLinksAsync, sweepClaimLinksAsync,
} from './claim-links.js';
import { planIdentityMerges } from './identity.js';
import { claimsBackfillAsync, CLAIMS_BACKFILL_KEY, initialPush } from './initial-push.js';
import { readOutbox } from './outbox.js';
import { recordingIdForTrack } from './recording-id.js';
import { remoteTrackId } from './stable-ids.js';

const R = recordingIdForTrack;

let dir: string;
const handles: Database.Database[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'curator-claim-links-')); });
afterEach(() => {
	for (const h of handles.splice(0)) h.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

function freshDb(name = 'lib'): { raw: Database.Database; db: Db } {
	const path = join(dir, `${name}.db`);
	migrate(path);
	const { db, sqlite } = createDb(path);
	handles.push(sqlite);
	return { raw: sqlite, db };
}

function insertTrack(raw: Database.Database, id: string, opts: { isrc?: string; title?: string } = {}): void {
	raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, isrc, created_at) VALUES (?, ?, ?, ?, 'unsorted', 300, ?, 1650000000000)`)
		.run(id, R(id), opts.title ?? `Title ${id}`, JSON.stringify([{ name: 'Artist' }]), opts.isrc ?? null);
}
function link(raw: Database.Database, trackId: string, source: string, value: string): void {
	raw.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, fetched_at) VALUES (?, ?, ?, ?, 1660000000000)`).run(randomUUID(), trackId, source, value);
}

let clockTs = 1_760_000_000_000;
function op(device: string, entity: string, entityId: string, kind: string, payload: unknown, ts = clockTs++): Record<string, unknown> {
	return { op_id: randomUUID(), device_id: device, client_ts: ts, schema_version: opSchemaVersion({ entity, kind, entity_id: entityId }), entity, entity_id: entityId, kind, payload };
}
const meta = (title: string): TrackMeta => ({ source: 'spotify', title, artists: [{ name: 'A' }], album_title: null, duration_sec: 240, isrc: null, release_date: null, label: null, genre: null, cover_url: null });
const created = (device: string, rec: string): Record<string, unknown> => op(device, 'library_track', rec, 'create', { added_at: 1_755_000_000_000 });
const claim = (device: string, rec: string, kind: string, value: string, confidence = 1, ts?: number): Record<string, unknown> =>
	op(device, 'recording_claim', rec, 'add', { kind, value, confidence }, ts);
const remoteRec = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

const linksOf = (raw: Database.Database, trackId: string): Record<string, string> =>
	Object.fromEntries((claimLinksOf(raw, [trackId]).get(trackId) ?? []).map((l) => [l.source, l.sourceTrackId]));

// ── what a row gets ─────────────────────────────────────────────────────────

describe('claim links: derivation', () => {
	it('remote and own rows get the claims of the providers they have no own link for', () => {
		const { raw } = freshDb();
		insertTrack(raw, 'mine');
		link(raw, 'mine', 'spotify', 'sp-own');
		const rec = remoteRec(1);
		applyOps(raw, [
			created('dev-x', rec), op('dev-x', 'library_track', rec, 'set-meta', meta('Remote')),
			claim('dev-x', rec, 'spotify', 'sp1'), claim('dev-x', rec, 'tidal', 'td1'), claim('dev-x', rec, 'beatport', '123', 0.7),
			claim('dev-x', rec, 'isrc', 'GBAAA2600001', 0.9), claim('dev-x', rec, 'audio_hash', 'pcm-md5:x'),
			// Another device's ids for the recording this device holds.
			claim('dev-x', R('mine'), 'spotify', 'sp-theirs'), claim('dev-x', R('mine'), 'tidal', 'td-theirs'),
		]);
		expect(linksOf(raw, remoteTrackId(rec))).toEqual({ spotify: 'sp1', tidal: 'td1', beatport: '123' });
		// The own Spotify link wins; Tidal comes from the account.
		expect(linksOf(raw, 'mine')).toEqual({ tidal: 'td-theirs' });
		expect(claimLinkPendingCount(raw)).toBe(0);
	});

	it('picks the highest confidence, then the latest claim, the same on every device', () => {
		const { raw } = freshDb();
		insertTrack(raw, 't');
		applyOps(raw, [
			claim('dev-x', R('t'), 'tidal', 'td-fuzzy-new', 0.7, 1_770_000_000_000),
			claim('dev-y', R('t'), 'tidal', 'td-exact-old', 1, 1_760_000_000_001),
		]);
		expect(linksOf(raw, 't').tidal).toBe('td-exact-old');
		// A user's correction on another device: a newer exact claim.
		applyOps(raw, [claim('dev-y', R('t'), 'tidal', 'td-corrected', 1, 1_771_000_000_000)]);
		expect(linksOf(raw, 't').tidal).toBe('td-corrected');
	});

	it('a derived WAV copy gets none', () => {
		const { raw } = freshDb();
		insertTrack(raw, 'orig');
		raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration, derived_from_track_id) VALUES ('copy', ?, 'x', '[]', 'unsorted', 300, 'orig')`).run(R('orig'));
		applyOps(raw, [claim('dev-x', R('orig'), 'spotify', 'sp1')]);
		expect(linksOf(raw, 'orig')).toEqual({ spotify: 'sp1' });
		expect(linksOf(raw, 'copy')).toEqual({});
	});
});

// ── kept in step ────────────────────────────────────────────────────────────

describe('claim links: kept in step', () => {
	it('an own link replaces the derived one in the same statement; a streaming one adopts the remote row, an enrichment one does not', () => {
		const { raw } = freshDb();
		const rec = remoteRec(2);
		applyOps(raw, [created('dev-x', rec), op('dev-x', 'library_track', rec, 'set-meta', meta('R')), claim('dev-x', rec, 'beatport', '9', 0.7), claim('dev-x', rec, 'tidal', 'td2')]);
		const id = remoteTrackId(rec);
		link(raw, id, 'beatport', '9');
		expect(linksOf(raw, id)).toEqual({ tidal: 'td2' });
		expect(raw.prepare(`SELECT remote_only FROM track WHERE id = ?`).pluck().get(id)).toBe(1);
		link(raw, id, 'tidal', 'td2');
		expect(linksOf(raw, id)).toEqual({});
		expect(raw.prepare(`SELECT remote_only FROM track WHERE id = ?`).pluck().get(id)).toBe(0);
	});

	it('a merge moves them: the loser\'s remote row goes, the winner\'s own row takes its claims', () => {
		const { raw } = freshDb();
		insertTrack(raw, 'mine');
		const rec = remoteRec(3);
		applyOps(raw, [created('dev-x', rec), op('dev-x', 'library_track', rec, 'set-meta', meta('Dup')), claim('dev-x', rec, 'tidal', 'td3')]);
		expect(linksOf(raw, remoteTrackId(rec))).toEqual({ tidal: 'td3' });
		applyOps(raw, [op('dev-x', 'recording', rec, 'merge', { winner: R('mine') })]);
		expect(raw.prepare(`SELECT count(*) FROM track WHERE id = ?`).pluck().get(remoteTrackId(rec))).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM claim_link WHERE recording_id = ?`).pluck().get(rec)).toBe(0);
		expect(linksOf(raw, 'mine')).toEqual({ tidal: 'td3' });
	});

	it('a merge that re-points this device\'s row: it re-derives from the winner', () => {
		const { raw } = freshDb();
		insertTrack(raw, 'mine');
		const winner = remoteRec(4);
		applyOps(raw, [claim('dev-x', R('mine'), 'spotify', 'sp-loser'), claim('dev-x', winner, 'tidal', 'td-winner')]);
		expect(linksOf(raw, 'mine')).toEqual({ spotify: 'sp-loser' });
		applyOps(raw, [op('dev-x', 'recording', R('mine'), 'merge', { winner })]);
		expect(raw.prepare(`SELECT recording_id FROM track WHERE id = 'mine'`).pluck().get()).toBe(winner);
		// The loser's claims moved onto the winner: both providers now.
		expect(linksOf(raw, 'mine')).toEqual({ spotify: 'sp-loser', tidal: 'td-winner' });
		expect(raw.prepare(`SELECT DISTINCT recording_id FROM claim_link WHERE track_id = 'mine'`).pluck().all()).toEqual([winner]);
	});

	it('an own link dropped on purpose is not derived back; another claim of that provider may stand in', () => {
		const { raw } = freshDb();
		insertTrack(raw, 't');
		link(raw, 't', 'spotify', 'sp-wrong');
		applyOps(raw, [claim('dev-x', R('t'), 'spotify', 'sp-wrong'), claim('dev-y', R('t'), 'spotify', 'sp-other', 0.9)]);
		expect(linksOf(raw, 't')).toEqual({});
		raw.prepare(`DELETE FROM source_link WHERE track_id = 't'`).run();
		deriveClaimLinks(raw, raw.prepare(`SELECT recording_id FROM claim_link_pending`).pluck().all() as string[]);
		expect(linksOf(raw, 't')).toEqual({ spotify: 'sp-other' });
		// The user hides the stand-in too (Edit screen ×): nothing left.
		expect(dismissClaimLink(raw, 't', 'spotify')).toBe(true);
		expect(linksOf(raw, 't')).toEqual({});
		// A later claim batch for the recording keeps both dismissed.
		applyOps(raw, [claim('dev-x', R('t'), 'beatport', '77', 0.7)]);
		expect(linksOf(raw, 't')).toEqual({ beatport: '77' });
		// Re-linking the id by hand lifts its veto.
		link(raw, 't', 'spotify', 'sp-wrong');
		raw.prepare(`DELETE FROM source_link WHERE track_id = 't' AND source = 'spotify'`).run();
		expect(raw.prepare(`SELECT source_track_id FROM claim_link_veto WHERE track_id = 't' ORDER BY 1`).pluck().all()).toEqual(['sp-other', 'sp-wrong']);
	});

	it('a hard-deleted row takes its links and vetoes with it', () => {
		const { raw } = freshDb();
		insertTrack(raw, 't');
		link(raw, 't', 'tidal', 'td-own');
		applyOps(raw, [claim('dev-x', R('t'), 'spotify', 'sp1')]);
		raw.prepare(`DELETE FROM track WHERE id = 't'`).run();
		expect(raw.prepare(`SELECT count(*) FROM claim_link`).pluck().get()).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM claim_link_veto`).pluck().get()).toBe(0);
	});
});

// ── the sweep ───────────────────────────────────────────────────────────────

describe('claim links: the one-time sweep and the drain', () => {
	it('derives every row of a library that had claims before, in slices, once; emits nothing', async () => {
		const { raw } = freshDb();
		const n = 1_200;
		const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, '[]', 'unsorted', 300)`);
		raw.transaction(() => { for (let i = 0; i < n; i++) ins.run(`t${i}`, R(`t${i}`), `T${i}`); })();
		const ops = [];
		for (let i = 0; i < n; i++) ops.push(claim('dev-x', R(`t${i}`), 'tidal', `td${i}`), claim('dev-x', R(`t${i}`), 'spotify', `sp${i}`));
		applyOps(raw, ops);
		// Above the inline budget: queued for the client's drain.
		expect(claimLinkPendingCount(raw)).toBe(n);
		// A library from before this build: nothing queued, nothing derived.
		raw.prepare(`DELETE FROM claim_link_pending`).run();
		raw.prepare(`DELETE FROM claim_link`).run();
		const outbox = readOutbox(raw).length;
		expect(claimLinksSwept(raw)).toBe(false);
		const r = await sweepClaimLinksAsync(raw, { page: 400 });
		expect(r).toMatchObject({ recordings: n, chunks: 3 });
		expect(r.tracks.length).toBe(n);
		expect(claimLinksSwept(raw)).toBe(true);
		expect(raw.prepare(`SELECT count(*) FROM claim_link`).pluck().get()).toBe(2 * n);
		expect(linksOf(raw, 't7')).toEqual({ spotify: 'sp7', tidal: 'td7' });
		// Idempotent: a re-run writes nothing.
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(CLAIM_LINKS_SWEEP_KEY);
		expect((await sweepClaimLinksAsync(raw)).tracks).toEqual([]);
		// The drain path for a queue.
		raw.prepare(`DELETE FROM claim_link`).run();
		raw.prepare(`INSERT INTO claim_link_pending (recording_id) SELECT recording_id FROM track`).run();
		const d = await drainClaimLinksAsync(raw, { chunk: 500 });
		expect(d).toMatchObject({ recordings: n, chunks: 3 });
		expect(claimLinkPendingCount(raw)).toBe(0);
		expect(raw.prepare(`SELECT count(*) FROM claim_link`).pluck().get()).toBe(2 * n);
		expect(readOutbox(raw).length).toBe(outbox);
	});
});

// ── display data only ───────────────────────────────────────────────────────

describe('claim links: never this device\'s own', () => {
	// A remote row and an own row (a local file) that know Spotify, Tidal and
	// Beatport ids only from the account.
	function rig(): { raw: Database.Database; db: Db; remote: string; rec: string } {
		const { raw, db } = freshDb();
		insertTrack(raw, 'mine', { isrc: 'GBAAA2600005' });
		link(raw, 'mine', 'local', 'c:/music/mine.flac');
		const rec = remoteRec(5);
		applyOps(raw, [
			created('dev-x', rec), op('dev-x', 'library_track', rec, 'set-meta', meta('Remote')),
			claim('dev-x', rec, 'spotify', 'sp5'), claim('dev-x', rec, 'tidal', 'td5'),
			claim('dev-x', R('mine'), 'spotify', 'sp-mine'), claim('dev-x', R('mine'), 'tidal', 'td-mine'), claim('dev-x', R('mine'), 'beatport', '55', 0.7),
		]);
		return { raw, db, remote: remoteTrackId(rec), rec };
	}

	it('turns no remote row into an own row, emits no op and marks no meta dirty', () => {
		const { raw, remote } = rig();
		expect(linksOf(raw, remote)).toEqual({ spotify: 'sp5', tidal: 'td5' });
		expect(raw.prepare(`SELECT remote_only FROM track WHERE id = ?`).pluck().get(remote)).toBe(1);
		expect(readOutbox(raw)).toEqual([]);
		expect(raw.prepare(`SELECT count(*) FROM track_meta_dirty WHERE track_id = ?`).pluck().get(remote)).toBe(0);
	});

	it('the initial push and the claims backfill restate none of them; identity counts no own row for them', async () => {
		const { raw } = rig();
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(INITIAL_PUSH_KEY);
		initialPush(raw);
		const claimsOut = (): string[] => readOutbox(raw).filter((o) => o.entity === 'recording_claim').map((o) => `${(o.payload as { kind: string }).kind}:${(o.payload as { value: string }).value}`);
		// 'mine' states only what it holds: its ISRC (no audio hash on this link).
		expect(claimsOut()).toEqual(['isrc:GBAAA2600005']);
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(CLAIMS_BACKFILL_KEY);
		await claimsBackfillAsync(raw);
		expect(claimsOut()).toEqual(['isrc:GBAAA2600005']);
		// The streaming tier's groups count own rows only — none here.
		expect(planIdentityMerges(raw).merges).toEqual([]);
	});

	it('no membership tier, no `sources`, no hold for the read-sync', () => {
		const { raw, remote } = rig();
		new MembershipClassifier(raw, () => 'me').recomputeAll();
		expect(raw.prepare(`SELECT membership FROM track WHERE id = ?`).pluck().get(remote)).toBeNull();
		expect(raw.prepare(`SELECT membership FROM track WHERE id = 'mine'`).pluck().get()).toBe('local');
		// What the read-sync and every upstream writer resolve through.
		expect(raw.prepare(`SELECT count(*) FROM source_link WHERE source != 'local'`).pluck().get()).toBe(0);
	});

	it('the Tidal hybrid matcher takes a derived link as matched — no crawl, no own link, no remote row adopted', async () => {
		const { raw, db, remote } = rig();
		const auth = { getTidalAccessToken: async () => { throw new Error('no Tidal call expected'); }, getTidalCountryCode: () => 'US' };
		const hybrid = new TidalHybrid(db, auth as never);
		const noClient = new Proxy({}, { get: () => () => { throw new Error('no Tidal call expected'); } }) as unknown as TidalApiClient;
		expect(await hybrid.matchOne('mine', noClient)).toEqual({ tidalId: 'td-mine' });
		expect(await hybrid.matchOne(remote, noClient)).toEqual({ tidalId: 'td5' });
		// A playlist of both: nothing left to match.
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name, sync_status) VALUES ('pl', 'spotify', 'spPL', 'Mix', 'synced')`).run();
		raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES ('m1', 'pl', 'mine', 'a0', 0, 1, 'mine'), ('m2', 'pl', ?, 'a1', 1, 1, ?)`).run(remote, remote);
		expect(await hybrid.setPlaylistHybrid('pl', true)).toEqual({ matched: 0, scanned: 0, enabled: true });
		expect(raw.prepare(`SELECT count(*) FROM source_link WHERE source = 'tidal'`).pluck().get()).toBe(0);
		expect(raw.prepare(`SELECT remote_only FROM track WHERE id = ?`).pluck().get(remote)).toBe(1);
		expect(readOutbox(raw).filter((o) => o.entity === 'recording_claim')).toEqual([]);
	});

	it('a real hybrid match states the account\'s claim (so other devices derive it)', async () => {
		const { raw, db } = freshDb();
		insertTrack(raw, 'sp-only', { isrc: 'GBAAA2600006' });
		link(raw, 'sp-only', 'spotify', 'sp6');
		const hit: TidalTrackV2 = { id: 'td6', title: 'Title sp-only', version: null, duration: 300, isrc: 'GBAAA2600006', bpm: null, key: null, keyScale: null, explicit: false, artists: [], album: null, url: 'https://tidal.com/browse/track/td6' };
		const client = { getTracksByIsrc: async () => [hit], searchTracks: async () => [] } as unknown as TidalApiClient;
		expect(await new TidalHybrid(db, {} as never).matchOne('sp-only', client)).toEqual({ tidalId: 'td6' });
		expect(readOutbox(raw).filter((o) => o.entity === 'recording_claim').map((o) => o.payload)).toEqual([{ kind: 'tidal', value: 'td6', confidence: 0.9 }]);
	});

	it('the bulk Beatport pass skips a track the account already matched there', async () => {
		const { raw, db } = rig();
		raw.prepare(`INSERT INTO playlist (id, source, source_id, name, sync_status) VALUES ('pl', 'spotify', 'spPL', 'Mix', 'synced')`).run();
		raw.prepare(`INSERT INTO playlist_track (id, playlist_id, track_id, order_key, position, added_at, source_track_id) VALUES ('m1', 'pl', 'mine', 'a0', 0, 1, 'mine')`).run();
		const fetchImpl = async (): Promise<never> => { throw new Error('no Beatport call expected'); };
		const sync = new SpotifySync(db, {} as never, { beatportFetch: fetchImpl as never });
		expect(await sync.enrichBeatportPlaylist('pl')).toEqual({ enriched: 0, scanned: 0 });
	});
});
