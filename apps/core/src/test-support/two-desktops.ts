// A rig for the two-desktop scenario suites (cloud plan, workstream E exit
// test): several REAL CoreService instances on their own generated temp
// databases, each with its own device id, signed in as the same user to one
// in-memory cloud (fake-cloud.ts). Scenarios drive the public CoreService
// methods (mutators only where no service method exists), sync every device
// until the cloud is quiet, and compare normalised replicas (sync-log/dump.ts)
// plus what the dump does not cover: play history, and the display names of
// the artists credits link to (the dump compares artist identity).
//
// Safety rails (CLAUDE.md): every database is mkdtempSync + migrate(), every
// audio file is generated under the rig's temp dir; no service gets a
// remoteWritePolicy, and every streaming adapter is a recorder that throws —
// `upstreamCalls()` must stay empty, as must the write-audit sink (which logs
// denied remote writes and rekordbox write batches too). No rekordbox spec is
// passed, so the rekordbox sidecar is off on every device.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import { it } from 'vitest';
import { getSourceCapabilities, type StreamingSource } from '@curator/shared';
import { createDb, type Db } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { audioHash } from '../ingest/audio-hash.js';
import type { ParseFn, ParseResult } from '../ingest/types.js';
import { syncTrackArtistsByIdRaw } from '../library/artists.js';
import type { ScanProgress } from '../local/scanner.js';
import { createCoreService, type CoreService } from '../service.js';
import type { StreamingSourceAdapter } from '../sources/adapter.js';
import { INITIAL_PUSH_KEY } from '../sync-log/apply.js';
import { readCursor } from '../sync-log/client.js';
import { canonicalOverrides, compareDumps, dumpLibrary, type LibraryDump, type TableReport } from '../sync-log/dump.js';
import { recordingIdForTrack } from '../sync-log/recording-id.js';
import { FakeCloud, type FakeTransport } from './fake-cloud.js';

type Raw = Database.Database;

export const USER = 'user-e2e';
export const TRACKS = Array.from({ length: 10 }, (_, i) => `trk-${i}`);

// A scenario that fails today because of a known gap: kept as a test that
// must fail (it.fails), so the suite goes red the day the gap closes and the
// marker comes off. CURATOR_E2E_STRICT=1 runs them as plain tests, to see
// the actual divergence.
export const knownGap: typeof it.fails = process.env['CURATOR_E2E_STRICT'] ? it : it.fails;

// Separates writes whose order a scenario relies on. Both devices stamp
// max(wall, last issued + 1, last server ts seen + 1) (protocol clock.ts),
// so a burst of N ops runs a device's clock up to N ms ahead of the wall:
// the gap must outlast the largest burst a scenario makes (a merge's
// re-asserts, a playlist create), not just a millisecond.
export const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── streaming adapters that record and refuse ──────────────────────────────

export function recordingAdapter(source: StreamingSource, calls: string[]): StreamingSourceAdapter {
	const hit = (m: string) => async (): Promise<never> => {
		calls.push(`${source}.${m}`);
		throw new Error(`streaming adapter ${source}.${m} called from a two-desktop test`);
	};
	return {
		source,
		displayName: `Fake ${source}`,
		capabilities: getSourceCapabilities(source),
		listRemotePlaylists: hit('listRemotePlaylists'),
		fetchPlaylistTracks: hit('fetchPlaylistTracks'),
		createPlaylist: hit('createPlaylist'),
		deletePlaylist: hit('deletePlaylist'),
		renamePlaylist: hit('renamePlaylist'),
		addTracks: hit('addTracks'),
		removeTracks: hit('removeTracks'),
		replaceTracks: hit('replaceTracks'),
		reorderTracks: hit('reorderTracks'),
	};
}

// ── catalogue rows ──────────────────────────────────────────────────────────

// Tracks are catalogue/scanner rows the op log does not carry (project.ts),
// so every device that holds a recording has its own row for it. Same track
// id ⇒ same recording id (recordingIdForTrack), as a shared catalogue gives.
export function seedCatalogue(raw: Raw, ids: readonly string[], artists: (id: string, i: number) => Array<{ name: string }> = () => [{ name: 'Artist' }]): void {
	const ins = raw.prepare(`INSERT INTO track (id, recording_id, title, artists, state, duration) VALUES (?, ?, ?, ?, 'unsorted', 300)`);
	ids.forEach((id, i) => ins.run(id, recordingIdForTrack(id), `Title ${id}`, JSON.stringify(artists(id, i))));
	syncTrackArtistsByIdRaw(raw, [...ids]);
}

// A library from before the op log (its rows were never emitted): the next
// sign-in runs the initial push for them.
export function markPreOpLog(raw: Raw): void {
	raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(INITIAL_PUSH_KEY);
}

// ── generated audio ─────────────────────────────────────────────────────────

// The scanner's parser for generated FLACs (catalogue-fakes `writeFlac`): the
// real audio hash off the file's STREAMINFO, tags read off the tag block's
// `KEY=value` lines. Injected through CoreServiceOptions.parseAudio, the seam
// the desktop uses for its utility-process parser.
export const flacParse: ParseFn = async (path: string): Promise<ParseResult> => {
	const text = readFileSync(path).toString('latin1');
	const tag = (k: string): string | null => new RegExp(`${k}=([^\\n\\x00]*)`).exec(text)?.[1] ?? null;
	return {
		title: tag('TITLE') ?? basename(path).replace(/\.[^.]+$/, ''),
		artists: tag('ARTIST') ? [tag('ARTIST')!] : [],
		albumTitle: null,
		duration: 300,
		isrc: null,
		bpm: null,
		genre: null,
		label: null,
		container: 'flac',
		audioHash: await audioHash(path),
	};
};

// ── one desktop ─────────────────────────────────────────────────────────────

export type DesktopOpts = {
	// Catalogue rows seeded before the service starts (default TRACKS).
	catalogue?: readonly string[];
	artists?: (id: string, i: number) => Array<{ name: string }>;
	// Rows written straight into the tables before the service opens (a
	// library from before the op log; markPreOpLog makes it push them).
	seed?: (raw: Raw, d: { dir: string; musicDir: string }) => void | Promise<void>;
	parseAudio?: ParseFn;
};

export class Desktop {
	svc!: CoreService;
	readonly raw: Raw;
	readonly db: Db;
	readonly upstream: string[] = [];
	readonly audit: Array<Record<string, unknown>> = [];
	readonly trashed: string[] = [];
	private svcs: CoreService[] = [];

	constructor(
		readonly rig: TwoDesktopRig,
		readonly name: string,
		readonly path: string,
		readonly dir: string,
		readonly musicDir: string,
		readonly transport: FakeTransport,
		private readonly parseAudio: ParseFn | undefined,
	) {
		const { db, sqlite } = createDb(path);
		this.db = db;
		this.raw = sqlite;
		this.open();
	}

	// A fresh service on the same database: an app restart.
	open(): CoreService {
		this.svc = createCoreService(this.path, {
			peaksDir: join(this.dir, 'peaks'),
			sourceAdapters: { spotify: recordingAdapter('spotify', this.upstream), tidal: recordingAdapter('tidal', this.upstream) },
			writeAudit: (e) => { this.audit.push(e); },
			// Never the OS trash: record the path (always under the rig dir).
			trashFile: async (p) => { this.trashed.push(p); },
			cloud: { transport: this.transport, device: { name: this.name, platform: 'win32' } },
			...(this.parseAudio ? { parseAudio: this.parseAudio } : {}),
		});
		this.svcs.push(this.svc);
		return this.svc;
	}

	async restart(): Promise<CoreService> {
		this.svc.close();
		// The scanner's watchers stop asynchronously on close.
		await tick(50);
		return this.open();
	}

	async sync(): Promise<void> { await this.svc.cloudSyncNow(); }

	async deviceId(): Promise<string> { return (await this.svc.getCloudSyncStatus()).deviceId!; }

	trackId(recordingId: string): string | undefined {
		return this.raw.prepare(`SELECT id FROM track WHERE recording_id = ? ORDER BY deleted_at IS NOT NULL, created_at, id LIMIT 1`).pluck().get(recordingId) as string | undefined;
	}

	one<T = unknown>(sql: string, ...params: unknown[]): T { return this.raw.prepare(sql).pluck().get(...params) as T; }
	all<T = unknown>(sql: string, ...params: unknown[]): T[] { return this.raw.prepare(sql).all(...params) as T[]; }

	close(): void {
		for (const s of this.svcs.splice(0)) { try { s.close(); } catch { /* already closed */ } }
		try { this.raw.close(); } catch { /* */ }
	}
}

// ── the rig ─────────────────────────────────────────────────────────────────

export class TwoDesktopRig {
	readonly dir: string;
	readonly cloud = new FakeCloud();
	readonly desktops: Desktop[] = [];

	constructor(prefix = 'curator-2desk-') {
		this.dir = mkdtempSync(join(tmpdir(), prefix));
	}

	async desktop(name: string, opts: DesktopOpts = {}): Promise<Desktop> {
		const dir = join(this.dir, name);
		const musicDir = join(dir, 'music');
		mkdirSync(musicDir, { recursive: true });
		const path = join(dir, 'curator.db');
		migrate(path);
		const { sqlite } = createDb(path);
		try {
			seedCatalogue(sqlite, opts.catalogue ?? TRACKS, opts.artists);
			await opts.seed?.(sqlite, { dir, musicDir });
		} finally {
			sqlite.close();
		}
		const d = new Desktop(this, name, path, dir, musicDir, this.cloud.transport(USER), opts.parseAudio);
		this.desktops.push(d);
		return d;
	}

	// Sync every device (in the given order) round after round until a round
	// moves nothing: no new op reached the cloud and every device's cursor is
	// at the head with nothing pending. Revoked or offline devices are
	// synced but not waited on. Returns the rounds it took.
	async settle(devices: readonly Desktop[] = this.desktops, maxRounds = 8): Promise<number> {
		for (let round = 1; round <= maxRounds; round++) {
			const before = this.cloud.log.length;
			for (const d of devices) await d.sync();
			let quiet = this.cloud.log.length === before;
			for (const d of devices) {
				if (!d.transport.online) continue;
				const id = await d.deviceId();
				if (this.cloud.isRevoked(id)) continue;
				const s = await d.svc.getCloudSyncStatus();
				if (s.pending > 0 || s.lastError !== null || readCursor(d.raw).lastSeq < this.cloud.maxSeq) quiet = false;
			}
			if (quiet) return round;
		}
		const states = await Promise.all(devices.map(async (d) => ({ name: d.name, status: await d.svc.getCloudSyncStatus(), cursor: readCursor(d.raw) })));
		throw new Error(`devices did not settle in ${maxRounds} rounds: ${JSON.stringify(states)} head=${this.cloud.maxSeq}`);
	}

	// Every streaming adapter call and write-audit entry on any device.
	upstreamCalls(): string[] {
		return this.desktops.flatMap((d) => [...d.upstream.map((c) => `${d.name}: ${c}`), ...d.audit.map((e) => `${d.name}: audit ${JSON.stringify(e)}`)]);
	}

	close(): void {
		for (const d of this.desktops.splice(0)) d.close();
		try { rmSync(this.dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows handles */ }
	}
}

// ── comparison ──────────────────────────────────────────────────────────────

// Recordings a device holds a live catalogue row for.
function heldRecordings(raw: Raw): Set<string> {
	return new Set(raw.prepare(`SELECT recording_id FROM track WHERE derived_from_track_id IS NULL`).pluck().all() as string[]);
}

// Recording-scoped rows limited to recordings both devices hold rows for:
// a device cannot project state for a recording it has no row for (by
// design, project.ts), so a recording only one side holds is not a
// divergence.
function restrict(d: LibraryDump, keep: Set<string>): LibraryDump {
	const ok = (r: { recordingId: string }) => keep.has(r.recordingId);
	return {
		...d,
		trackTags: d.trackTags.filter(ok), playlistTracks: d.playlistTracks.filter(ok), cues: d.cues.filter(ok), tracks: d.tracks.filter(ok), rbAnalysis: d.rbAnalysis.filter(ok),
		credits: d.credits?.filter(ok) ?? null, trackArtists: d.trackArtists?.filter(ok) ?? null,
	};
}

// The normalised replica diff: tables that differ, with sample rows.
export function replicaDiff(a: Desktop, b: Desktop, opts: { sharedOnly?: boolean } = {}): TableReport[] {
	let da = dumpLibrary(a.raw);
	let db = dumpLibrary(b.raw);
	if (opts.sharedOnly) {
		const ha = heldRecordings(a.raw);
		const shared = new Set([...heldRecordings(b.raw)].filter((r) => ha.has(r)));
		da = restrict(da, shared);
		db = restrict(db, shared);
	}
	return compareDumps(da, db).filter((r) => !r.equal);
}

// Play history as it syncs: finalised plays (an open curator play is local
// bookkeeping until it ends) by id, the track named by recording; sessions
// that hold at least one of them.
export function historyDump(d: Desktop): { sessions: unknown[]; events: unknown[] } {
	const events = d.all(`SELECT e.id, e.session_id AS sessionId, t.recording_id AS recordingId, e.source, e.played_at AS playedAt, e.played_ms AS playedMs,
			e.duration_ms AS durationMs, e.max_position_ms AS maxPositionMs, e.played75, e.ended_reason AS endedReason,
			e.context_type AS contextType, e.context_id AS contextId
		FROM play_event e LEFT JOIN track t ON t.id = e.track_id
		WHERE e.ended_reason IS NOT NULL ORDER BY e.id`);
	const sessions = d.all(`SELECT s.id, s.origin, s.kind, s.kind_source AS kindSource, s.name, s.started_at AS startedAt, s.ended_at AS endedAt
		FROM play_session s WHERE EXISTS (SELECT 1 FROM play_event e WHERE e.session_id = s.id AND e.ended_reason IS NOT NULL) ORDER BY s.id`);
	return { sessions, events };
}

// Canonical credits and the artist junction, by display name, for the given
// catalogue rows (catalogue data no op carries; artist alias rules must
// leave it equal).
// Overrides are compared canonically: the JSON key order is each device's
// own write history, not state.
export function creditDump(d: Desktop, ids: readonly string[]): unknown {
	const marks = ids.map(() => '?').join(', ');
	return {
		credits: d.all<{ recordingId: string; artists: string; overrides: string | null }>(`SELECT recording_id AS recordingId, artists, overrides FROM track WHERE id IN (${marks}) ORDER BY recording_id`, ...ids)
			.map((r) => ({ ...r, overrides: canonicalOverrides(r.overrides) })),
		junction: d.all(`SELECT t.recording_id AS recordingId, a.name, ta.position FROM track_artist ta JOIN track t ON t.id = ta.track_id
			JOIN artist a ON a.id = ta.artist_id WHERE t.id IN (${marks}) ORDER BY t.recording_id, ta.position`, ...ids),
	};
}

// Members of a playlist in display order, as recording ids.
export function playlistOrder(d: Desktop, playlistId: string): string[] {
	return d.raw.prepare(`SELECT t.recording_id FROM playlist_track pt JOIN track t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`).pluck().all(playlistId) as string[];
}

// Positions are 0..n-1 with no gaps or duplicates.
export function positionsContiguous(d: Desktop, playlistId: string): boolean {
	const ps = d.raw.prepare(`SELECT position FROM playlist_track WHERE playlist_id = ? ORDER BY position`).pluck().all(playlistId) as number[];
	return ps.every((p, i) => p === i);
}

// ── the library scanner, waited on ──────────────────────────────────────────

// Resolves once the scanner has finished `n` files (skipped, matched,
// re-bound, created or failed) in `folderPath` in the current watch session
// (a session starts at startWatching: an app start or a new folder). Call it
// BEFORE starting the session: the "starting" frame fires synchronously.
export function scanWaiter(d: Desktop, folderPath: string): { done(n: number, ms?: number): Promise<ScanProgress['totals']> } {
	let latest: ScanProgress['totals'] | null = null;
	const resolved = (t: ScanProgress['totals'] | null): number => (t ? t.skipped + t.matched + t.created + t.failed : 0);
	const fold = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
	const norm = fold(folderPath);
	const unsub = d.svc.subscribeLibraryScan((p) => {
		if (fold(p.folderPath) === norm) latest = p.totals;
	});
	return {
		async done(n, ms = 10_000) {
			const end = Date.now() + ms;
			try {
				while (resolved(latest) < n) {
					if (Date.now() > end) throw new Error(`scanner did not finish ${n} file(s) in ${folderPath} (totals ${JSON.stringify(latest)})`);
					await tick(20);
				}
				return latest!;
			} finally {
				unsub();
			}
		},
	};
}
