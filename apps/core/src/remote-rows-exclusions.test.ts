// Remote rows stay out of every device-local writer (cloud plan: streaming
// identity §3, risk #1). A remote row (track.remote_only = 1) is the op log's
// projection of a track another device holds: no file, no link, no
// rekordbox entry here. Each describe below pins one writer that used to see
// it as an ordinary row — the boot ISRC dedupe (which HARD-deletes), the
// scanner's match-or-create, the streaming content match, rekordbox create,
// the analysis queue, enrichment, WAV convert, the AI engine, the catalogue,
// the merge planner, delete/trash and playback — plus the two places that
// keep seeing it on purpose (membership tier, the ISRC bind / exact-claim
// bind, which adopt it as this device's own through the migrate.ts trigger).
// Generated temp DBs only (CLAUDE.md); remote rows are seeded directly, or
// materialised from another device's ops where the claim index matters.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { opSchemaVersion, type TrackMeta } from '@curator/protocol';
import { DEFAULT_ARTIST_CREDIT_FORMAT } from '@curator/shared';
import type { AuthService } from './auth/service.js';
import { migrate } from './db/migrate.js';
import { createDb, type Db } from './db/client.js';
import { LibraryScanner, normalizePath } from './local/scanner.js';
import type { ParseResult } from './ingest/types.js';
import { audioHash } from './ingest/audio-hash.js';
import { writeFlac } from './test-support/catalogue-fakes.js';
import { memberOrder } from './test-support/playlist-track.js';
import { applyOps } from './sync-log/apply.js';
import { remoteTrackId } from './sync-log/stable-ids.js';
import { findExistingByContent } from './sync/match-existing.js';
import { SpotifySync } from './sync/spotify.js';
import { TidalDownloader } from './sync/download-orchestrator.js';
import { LibrarySink } from './enrich/sinks/library-sink.js';
import { planCreateForTracks } from './rekordbox/create-phase.js';
import { AnalysisQueue, splitRemoteRows } from './analyzer/queue.js';
import type { AnalyzerSidecar } from './analyzer/sidecar.js';
import { planPlaylistConversion, type WavConvertDeps } from './wav/convert-run.js';
import { sqliteLibraryPort } from './mir/library-port.js';
import { readLocalTrack, trusted } from './catalogue/local.js';
import { MembershipClassifier } from './library/membership.js';
import { planTrackMerge } from './library/merge-tracks.js';
import { createCoreService } from './service.js';

let dir: string;
let dbPath: string;
let db: Db;
let sqlite: Database.Database;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'curator-remote-excl-'));
	dbPath = join(dir, 'curator.db');
	migrate(dbPath);
	({ db, sqlite } = createDb(dbPath));
});
afterEach(() => {
	sqlite.close();
	try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
});

type Seed = { title?: string; artist?: string; duration?: number; isrc?: string | null; createdAt?: number; remote?: boolean };
function seedTrack(id: string, s: Seed = {}): void {
	sqlite.prepare(`INSERT INTO track (id, recording_id, remote_only, remote_source, title, artists, duration, isrc, state, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unsorted', ?)`)
		.run(id, `rec-${id}`, s.remote ? 1 : 0, s.remote ? 'local' : null, s.title ?? `Title ${id}`,
			JSON.stringify([{ name: s.artist ?? 'Artist' }]), s.duration ?? 300, s.isrc ?? null, s.createdAt ?? 1_700_000_000_000);
}
const seedRemote = (id: string, s: Seed = {}): void => seedTrack(id, { ...s, remote: true });
function seedLocalLink(trackId: string, path: string): void {
	sqlite.prepare(`INSERT INTO source_link (id, track_id, source, source_track_id, file_path) VALUES (?, ?, 'local', ?, ?)`)
		.run(`sl-${trackId}`, trackId, normalizePath(path), normalizePath(path));
}
function seedPlaylist(id: string, source: string, ownerId: string | null = null): void {
	sqlite.prepare(`INSERT INTO playlist (id, source, source_id, name, owner_id) VALUES (?, ?, ?, ?, ?)`).run(id, source, `src-${id}`, `Playlist ${id}`, ownerId);
}
function seedMember(playlistId: string, trackId: string, position: number): void {
	sqlite.prepare(`INSERT INTO playlist_track (id, order_key, playlist_id, track_id, position, source_track_id) VALUES (?, ?, ?, ?, ?, ?)`)
		.run(...memberOrder(position).map((v, i) => (i === 0 ? `${playlistId}-${v}` : v)), playlistId, trackId, position, `src-${trackId}`);
}
const remoteOnly = (id: string): number | undefined => sqlite.prepare(`SELECT remote_only FROM track WHERE id = ?`).pluck().get(id) as number | undefined;
const linksOf = (id: string): number => sqlite.prepare(`SELECT count(*) FROM source_link WHERE track_id = ?`).pluck().get(id) as number;
const deletedAt = (id: string): number | null => sqlite.prepare(`SELECT deleted_at FROM track WHERE id = ?`).pluck().get(id) as number | null;

// ── boot: dedupeTracksByIsrc (migrate.ts) ───────────────────────────────────

describe('boot ISRC dedupe (migrate.ts dedupeTracksByIsrc)', () => {
	it('never groups, merges or deletes a remote row sharing an own row\'s ISRC and duration', () => {
		// Remote row OLDER than the own one: if grouped, it would be the survivor
		// and the own row (with its file link) would be hard-deleted.
		seedRemote('remote-old', { isrc: 'GBAAA2600001', createdAt: 1_600_000_000_000, title: 'Remote Title' });
		seedTrack('own-new', { isrc: 'GBAAA2600001', createdAt: 1_700_000_000_000 });
		seedLocalLink('own-new', join(dir, 'own-new.flac'));
		// And the other way round.
		seedTrack('own-old', { isrc: 'GBAAA2600002', createdAt: 1_600_000_000_000 });
		seedRemote('remote-new', { isrc: 'GBAAA2600002', createdAt: 1_700_000_000_000 });
		// Control: two own rows of one ISRC still merge, so the pass did run.
		seedTrack('dup-a', { isrc: 'GBAAA2600003', createdAt: 1_600_000_000_000 });
		seedTrack('dup-b', { isrc: 'GBAAA2600003', createdAt: 1_700_000_000_000 });
		const before = sqlite.prepare(`SELECT id, recording_id, remote_only, remote_source, title, artists, duration, isrc, created_at, deleted_at FROM track WHERE remote_only = 1 ORDER BY id`).all();
		sqlite.close();

		migrate(dbPath);
		({ db, sqlite } = createDb(dbPath));

		expect(sqlite.prepare(`SELECT id, recording_id, remote_only, remote_source, title, artists, duration, isrc, created_at, deleted_at FROM track WHERE remote_only = 1 ORDER BY id`).all()).toEqual(before);
		expect(remoteOnly('own-new')).toBe(0);
		expect(remoteOnly('own-old')).toBe(0);
		expect(linksOf('own-new')).toBe(1);
		expect(linksOf('remote-old')).toBe(0);
		expect(deletedAt('own-new')).toBeNull();
		expect(deletedAt('own-old')).toBeNull();
		expect(remoteOnly('dup-a')).toBe(0);
		expect(remoteOnly('dup-b')).toBeUndefined();
	});

	it('the rekordbox membership-baseline seed skips remote members', () => {
		seedPlaylist('rb_42', 'rekordbox');
		seedTrack('own');
		seedRemote('remote');
		seedMember('rb_42', 'own', 0);
		seedMember('rb_42', 'remote', 1);
		sqlite.close();
		migrate(dbPath);
		({ db, sqlite } = createDb(dbPath));
		expect(sqlite.prepare(`SELECT member_kind, member_id FROM rekordbox_membership_baseline WHERE rb_playlist_id = '42'`).all())
			.toEqual([{ member_kind: 'curator', member_id: 'own' }]);
	});
});

// ── scanner match-or-create (local/scanner.ts) ──────────────────────────────

describe('scanner: match-or-create skips remote rows', () => {
	const FOLDER = { id: 'folder-1', path: '', excludeGlobs: null, watching: true, scanState: 'idle', scanError: null, addedAt: new Date(), lastScannedAt: null, isFavorite: false };
	async function ingest(scanner: LibraryScanner, filePath: string): Promise<{ outcome: string; trackId?: string }> {
		(scanner as any).totals.set(FOLDER.id, { scanned: 0, matched: 0, created: 0, skipped: 0, failed: 0 });
		return (scanner as any).ingestPath({ ...FOLDER, path: dir }, filePath);
	}
	const tags = (over: Partial<ParseResult> = {}) => async (): Promise<ParseResult> => ({
		title: 'Remote Song', artists: ['Remote Artist'], albumTitle: null, duration: 300,
		isrc: 'GBAAA2600010', bpm: null, genre: null, label: null, container: 'flac', audioHash: null, ...over,
	});

	it('a file whose tags (ISRC, title, artist, duration) match only a remote row mints its own row', async () => {
		seedRemote('remote', { title: 'Remote Song', artist: 'Remote Artist', isrc: 'GBAAA2600010' });
		const file = join(dir, 'Remote Song.flac');
		writeFileSync(file, 'x');
		const r = await ingest(new LibraryScanner(db, tags()), file);
		expect(r.outcome).toBe('created');
		expect(r.trackId).not.toBe('remote');
		expect(remoteOnly('remote')).toBe(1);
		expect(linksOf('remote')).toBe(0);
	});

	it('control: the same tags against an own row match it', async () => {
		seedTrack('own', { title: 'Remote Song', artist: 'Remote Artist', isrc: 'GBAAA2600010' });
		const file = join(dir, 'Remote Song.flac');
		writeFileSync(file, 'x');
		expect(await ingest(new LibraryScanner(db, tags()), file)).toEqual({ outcome: 'matched', trackId: 'own' });
	});

	it('the exact audio-hash claim still binds the file to the remote row, which becomes this device\'s own', async () => {
		const file = join(dir, 'music', 'Claimed.flac');
		writeFlac(file, 'c0ffee00'.repeat(4), 'TITLE=Claimed');
		const hash = await audioHash(file);
		const rec = '00000000-0000-4000-8000-000000000101';
		const meta: TrackMeta = { source: 'local', title: 'Claimed', artists: [{ name: 'Someone' }], album_title: null, duration_sec: 300, isrc: null, release_date: null, label: null, genre: null, cover_url: null };
		let ts = 1_760_000_000_000;
		const op = (entity: string, entityId: string, kind: string, payload: unknown) =>
			({ op_id: randomUUID(), device_id: 'dev-x', client_ts: ts++, schema_version: opSchemaVersion({ entity, kind, entity_id: entityId } as never), entity, entity_id: entityId, kind, payload });
		applyOps(sqlite, [
			op('library_track', rec, 'create', { added_at: 1_755_000_000_000 }),
			op('library_track', rec, 'set-meta', meta),
			op('recording_claim', rec, 'add', { kind: 'audio_hash', value: hash, confidence: 1 }),
		] as never);
		const remote = remoteTrackId(rec);
		expect(remoteOnly(remote)).toBe(1);

		const r = await ingest(new LibraryScanner(db, tags({ title: 'Something Else', artists: ['Nobody'], isrc: null, audioHash: hash })), file);
		expect(r).toEqual({ outcome: 'matched', trackId: remote });
		expect(remoteOnly(remote)).toBe(0);
		expect(linksOf(remote)).toBe(1);
		expect(sqlite.prepare(`SELECT count(*) FROM track WHERE recording_id = ?`).pluck().get(rec)).toBe(1);
	});
});

// ── streaming import (sync/match-existing.ts, spotify.ts upsertTrack) ───────

describe('streaming import: content match is own rows only; ISRC prefers own, may adopt a remote row', () => {
	const target = { title: 'Lilac', artists: ['Ben Böhmer'], duration: 300, isrc: null };

	it('findExistingByContent never returns a remote row', () => {
		seedRemote('remote', { title: 'Lilac', artist: 'Ben Böhmer' });
		expect(findExistingByContent(db, target)).toBeNull();
		seedTrack('own', { title: 'Lilac', artist: 'Ben Böhmer' });
		expect(findExistingByContent(db, target)?.trackId).toBe('own');
	});

	it('findExistingByContent ignores a remote row even on an ISRC hit', () => {
		seedRemote('remote', { title: 'Lilac', artist: 'Ben Böhmer', isrc: 'GBAAA2600020' });
		expect(findExistingByContent(db, { ...target, isrc: 'GBAAA2600020' })).toBeNull();
	});

	const spotifyTrack = (id: string, isrc: string | null, name = 'Lilac') => ({
		id, name, duration_ms: 300_000, artists: [{ id: 'a1', name: 'Ben Böhmer' }],
		album: { id: 'al1', name: 'Breathing', images: [], release_date: '2019' }, external_ids: isrc ? { isrc } : {},
	}) as never;

	it('an ISRC bind lands on the own row before a remote row of the same ISRC', () => {
		seedRemote('remote', { isrc: 'GBAAA2600021', createdAt: 1_600_000_000_000 });
		seedTrack('own', { isrc: 'GBAAA2600021', createdAt: 1_700_000_000_000 });
		const sync = new SpotifySync(db, {} as AuthService);
		expect(sync.ingestExternalTrack(spotifyTrack('sp-1', 'GBAAA2600021'))).toBe('own');
		expect(remoteOnly('remote')).toBe(1);
		expect(linksOf('remote')).toBe(0);
	});

	it('an ISRC bind to a lone remote row adopts it (no second row of a track the user already sees)', () => {
		seedRemote('remote', { isrc: 'GBAAA2600022' });
		const sync = new SpotifySync(db, {} as AuthService);
		expect(sync.ingestExternalTrack(spotifyTrack('sp-2', 'GBAAA2600022'))).toBe('remote');
		expect(remoteOnly('remote')).toBe(0);
	});

	it('a title/artist/duration-only match against a remote row mints a new row', () => {
		seedRemote('remote', { title: 'Lilac', artist: 'Ben Böhmer' });
		const sync = new SpotifySync(db, {} as AuthService);
		const id = sync.ingestExternalTrack(spotifyTrack('sp-3', null));
		expect(id).not.toBe('remote');
		expect(remoteOnly('remote')).toBe(1);
		expect(linksOf('remote')).toBe(0);
	});
});

// ── enrichment (enrich/sinks/library-sink.ts, spotify.ts enrichBeatport*) ───

describe('enrichment never writes a remote row', () => {
	it('LibrarySink.persist leaves a remote row and adds no catalogue link (which would adopt it)', async () => {
		seedRemote('remote', { title: 'Remote' });
		const res = await new LibrarySink(db).persist('remote', {
			patch: { bpm: 124, keyCamelot: '8A', genre: 'House', label: 'L', releaseDate: '2020' },
			sourceLinks: [{ source: 'beatport', sourceTrackId: 'bp-1', url: 'https://www.beatport.com/track/x/1', payload: {} }],
		} as never);
		expect(res).toBeNull();
		expect(remoteOnly('remote')).toBe(1);
		expect(linksOf('remote')).toBe(0);
		expect(sqlite.prepare(`SELECT bpm, genre FROM track WHERE id = 'remote'`).get()).toEqual({ bpm: null, genre: null });
	});

	it('Beatport enrichment selects no remote rows (no lookups spent on them)', async () => {
		seedRemote('remote');
		seedPlaylist('pl', 'spotify');
		seedMember('pl', 'remote', 0);
		const sync = new SpotifySync(db, {} as AuthService);
		expect(await sync.enrichBeatportTracks(['remote'])).toEqual({ enriched: 0, scanned: 0 });
		expect(await sync.enrichBeatportTrack('remote')).toEqual({ enriched: 0, scanned: 0 });
		expect(await sync.enrichBeatportPlaylist('pl')).toEqual({ enriched: 0, scanned: 0 });
	});
});

// ── rekordbox (create-phase.ts) ─────────────────────────────────────────────

describe('rekordbox: no content is created for a remote row', () => {
	it('planCreateForTracks counts a remote row unplayable and plans only the own row', async () => {
		seedRemote('remote');
		seedTrack('own');
		const file = join(dir, 'own.mp3');
		writeFileSync(file, 'x');
		seedLocalLink('own', file);
		const plan = await planCreateForTracks(db, ['remote', 'own'], DEFAULT_ARTIST_CREDIT_FORMAT);
		expect(plan?.contentOps.map((o) => o.curator_track_id)).toEqual(['own']);
		expect(plan?.unplayable).toBe(1);
		expect(await planCreateForTracks(db, ['remote'], DEFAULT_ARTIST_CREDIT_FORMAT)).toBeNull();
	});
});

// ── analysis (analyzer/queue.ts, service.ts enqueueAnalysis) ────────────────

describe('analysis: a remote row is never queued', () => {
	it('splitRemoteRows partitions in input order', () => {
		seedRemote('r1');
		seedTrack('o1');
		seedTrack('o2');
		expect(splitRemoteRows(db, ['o2', 'r1', 'o1', 'missing'])).toEqual({ own: ['o2', 'o1', 'missing'], remote: ['r1'] });
		expect(splitRemoteRows(db, [])).toEqual({ own: [], remote: [] });
	});

	it('enqueue drops remote ids: no job row that could never dispatch', () => {
		seedRemote('remote');
		seedTrack('own');
		const sidecar = { analyze: () => new Promise(() => {}), cancel: () => {}, on: () => {}, off: () => {} } as unknown as AnalyzerSidecar;
		const queue = new AnalysisQueue(db, sidecar, { peaksDir: join(dir, 'peaks') });
		queue.setAutoEnabled(false);
		queue.enqueue(['remote', 'own'], { priority: 0 });
		queue.enqueue(['remote'], { priority: 100, force: true });
		expect(sqlite.prepare(`SELECT track_id FROM analysis_job ORDER BY track_id`).pluck().all()).toEqual(['own']);
	});
});

// ── WAV convert (wav/convert-run.ts) ────────────────────────────────────────

describe('WAV convert: a remote member is skipped', () => {
	it('plans nothing for a remote row in the playlist', async () => {
		seedPlaylist('pl', 'local');
		seedRemote('remote');
		seedMember('pl', 'remote', 0);
		const deps = {
			db, sqlite, spec: null, outputDir: () => join(dir, 'wav'), ensureWatched: async () => {},
			recomputeMembership: () => {}, requestPeaks: async () => {}, creditFormat: () => DEFAULT_ARTIST_CREDIT_FORMAT,
		} satisfies WavConvertDeps;
		const plan = await planPlaylistConversion(deps, 'pl');
		expect(plan.items.get('remote')).toMatchObject({ plan: 'skipped' });
	});
});

// ── AI engine (mir/library-port.ts) and catalogue (catalogue/local.ts) ──────

describe('AI engine and catalogue see no remote rows', () => {
	it('the engine\'s playable set excludes a remote row', () => {
		seedRemote('remote');
		seedTrack('own');
		const file = join(dir, 'own.flac');
		writeFileSync(file, 'x');
		seedLocalLink('own', file);
		const port = sqliteLibraryPort(sqlite);
		expect(port.playableTrackIds()).toEqual(['own']);
		expect(port.trackFile('remote')).toBeNull();
	});

	it('a remote row has no hash to share or hydrate under', () => {
		seedRemote('remote');
		const t = readLocalTrack(sqlite, 'remote')!;
		expect(t.hash).toBeNull();
		expect(trusted(t)).toBe(false);
	});
});

// ── membership tier (library/membership.ts) — kept on purpose ───────────────

describe('membership tier classifies a remote row by recording, never as local', () => {
	it('a remote row in my own streaming playlist is streaming; elsewhere none', () => {
		seedPlaylist('mine', 'spotify', 'me');
		seedRemote('in-mine');
		seedRemote('loose');
		seedMember('mine', 'in-mine', 0);
		new MembershipClassifier(sqlite, () => 'me').recomputeAll();
		expect(sqlite.prepare(`SELECT id, membership FROM track ORDER BY id`).all()).toEqual([
			{ id: 'in-mine', membership: 'streaming' },
			{ id: 'loose', membership: null },
		]);
	});
});

// ── merge (library/merge-tracks.ts) ─────────────────────────────────────────

describe('track merge refuses a remote row', () => {
	it('blocks either direction with a clear reason', () => {
		seedRemote('remote');
		seedTrack('own');
		for (const [keep, drop] of [['own', 'remote'], ['remote', 'own']] as const) {
			expect(planTrackMerge(db, keep, drop).blockers).toEqual(['One of the tracks is not on this device — merge it on the device that holds it']);
		}
	});
});

// ── delete / trash, playback and download (service.ts, download-orchestrator)

describe('delete, playback and download find nothing on disk for a remote row', () => {
	it('deleting a remote row trashes no file; playback resolves no file', async () => {
		seedRemote('remote');
		const trashed: string[] = [];
		const svc = createCoreService(dbPath, { peaksDir: join(dir, 'peaks'), trashFile: async (p) => { trashed.push(p); } });
		try {
			expect(await svc.getLocalFileForTrack('remote')).toBeNull();
			const res = await svc.deleteTracks(['remote']);
			expect(res).toMatchObject({ deletedTracks: 1, filesTrashed: 0 });
		} finally {
			svc.close();
		}
		expect(trashed).toEqual([]);
		expect(deletedAt('remote')).not.toBeNull();
	});

	it('a Tidal download of a remote row is refused as not available', async () => {
		seedRemote('remote');
		await expect(new TidalDownloader(db, {} as AuthService).downloadTrack('remote')).rejects.toMatchObject({ kind: 'not_available' });
	});
});
