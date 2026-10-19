// Rekordbox CREATE phase — runs inside RekordboxExporter.runExport before the
// normal update push, and only for a playlist that "Convert to WAV" built
// (playlist.derived_from_playlist_id set; v1 scope).
//
// Everything else in the exporter is update-only: it pushes to rb rows Curator
// already links by file path. A WAV copy has no rb row yet, so this phase
//   1. creates a DjmdContent row per unlinked member that has a local file —
//      for a WAV copy, the writer copies the FLAC original's ANLZ analysis
//      (beatgrid, waveforms, phrases) + BPM/key/artwork onto it, so rekordbox
//      shows the track fully analysed without re-analysing;
//   2. creates the DjmdPlaylist when the Curator playlist is still local;
//   3. commits + verifies (its own write session: the new ids must exist,
//      with final updated_at baselines, before the update push builds ops);
//   4. on the Curator side, links each created row (rekordbox_link with
//      pushed_at/fields_seen/cues_seen NULL — "never pushed") and re-keys the
//      playlist to the importer's shape (`rb_<ID>`, source='rekordbox').
// The update push that follows then writes metadata, cues (the copy's are
// stamped cuesEditedAt), MyTags and membership (empty baseline → all adds in
// Curator order) exactly as for any linked playlist, and advances baselines.
//
// Ordering note (2026-09-15 first-link incident): this runs after the
// service's pre-push pull and conflict pause, and the rows it creates carry
// Curator's own values — so the next pull sees rb == Curator, never "rb
// rating 0 / no cues" overwriting a curated copy.

import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
	playlist as playlistTable,
	playlistTrack,
	rekordboxLink,
	sourceLink,
	track,
	type NewPlaylist,
} from '@curator/shared/schema';
import type { ArtistCreditFormat } from '@curator/shared';
import { existsSync } from 'node:fs';
import type { Db } from '../db/client.js';
import { normalizePath } from '../local/scanner.js';
import { effectiveAlbum, effectiveArtistName, effectiveGenre, effectiveLabel, effectiveTitle } from '../sync/curator-view.js';
import { readAudioFormat } from '../wav/audio-header.js';
import { log } from '../log.js';
import type {
	CreateOp,
	CreatedVerifyOp,
	RekordboxSidecar,
	VerifyFailure,
	WriteFailure,
	WriteOpResult,
} from './sidecar.js';
import { rawOf } from '../library/artists.js';
import { emitOps } from '../sync-log/outbox.js';
import { isDeviceLocalPlaylist, memberAddOp, playlistCreateOps, recordingResolver } from '../sync-log/rows.js';

const clog = log.for('rb-create');

export interface CreatePhaseSummary {
	tracksCreated: number;       // new DjmdContent rows
	tracksLinked: number;        // rows (new or found by path) now linked
	playlistCreated: boolean;
	anlzCopied: number;          // created with the original's analysis
	anlzMissing: number;         // created without — rekordbox analyses on load
	// The Curator playlist's id after re-keying to `rb_<ID>` (null when the
	// playlist was already rb-sourced or wasn't created this run).
	rekeyedPlaylistId: string | null;
	backupPath: string;
	verifyOk: boolean;
	verifyPragmaError: string | null;
	verifyFailures: VerifyFailure[];
	writeFailures: WriteFailure[];
}

export interface CreatePlan {
	// Null for a plain track selection (no playlist to create or re-key).
	playlistId: string | null;
	playlistName: string | null;
	contentOps: Array<Extract<CreateOp, { kind: 'content_create' }>>;
	playlistOp: Extract<CreateOp, { kind: 'playlist_create' }> | null;
	// For the sync modal: members that can't be created (no local file).
	unplayable: number;
}

function releaseYear(date: string | null | undefined): number | null {
	const y = date ? Number.parseInt(date.slice(0, 4), 10) : NaN;
	return Number.isFinite(y) && y > 0 ? y : null;
}

// Null when the playlist isn't a Convert-to-WAV playlist or there's nothing
// to create. `withPlaylist` = the user kept "playlist" in the push scope.
export async function planCreatePhase(db: Db, playlistId: string, withPlaylist: boolean, fmt: ArtistCreditFormat): Promise<CreatePlan | null> {
	const pl = db.select().from(playlistTable).where(eq(playlistTable.id, playlistId)).get();
	if (!pl || !pl.derivedFromPlaylistId) return null;
	const memberIds = Array.from(new Set(db
		.select({ trackId: playlistTrack.trackId })
		.from(playlistTrack)
		.where(eq(playlistTrack.playlistId, playlistId))
		.orderBy(asc(playlistTrack.position))
		.all()
		.map((r) => r.trackId)));
	const { contentOps, unplayable } = await planContentCreates(db, memberIds, fmt);
	const playlistOp = withPlaylist && pl.source === 'local'
		? { kind: 'playlist_create' as const, curator_playlist_id: pl.id, name: pl.name }
		: null;
	if (contentOps.length === 0 && !playlistOp) return null;
	return { playlistId, playlistName: pl.name, contentOps, playlistOp, unplayable };
}

// "Add to Rekordbox" on a track selection: create every selected track that
// has a local file and no rekordbox row yet. No playlist involved. A WAV
// copy still gets its original's analysis; any other track is created
// un-analysed (Analysed=0) and rekordbox analyses it on first load.
export async function planCreateForTracks(db: Db, trackIds: string[], fmt: ArtistCreditFormat): Promise<CreatePlan | null> {
	const { contentOps, unplayable } = await planContentCreates(db, Array.from(new Set(trackIds)), fmt);
	if (contentOps.length === 0) return null;
	return { playlistId: null, playlistName: null, contentOps, playlistOp: null, unplayable };
}

// content_create ops for the tracks in `ids` that rekordbox doesn't have.
// `unplayable` counts unlinked tracks that can't be created (deleted, or no
// local file on disk).
async function planContentCreates(db: Db, ids: string[], fmt: ArtistCreditFormat): Promise<{ contentOps: CreatePlan['contentOps']; unplayable: number }> {
	const linked = new Set<string>();
	for (let i = 0; i < ids.length; i += 500) {
		for (const r of db.select({ trackId: rekordboxLink.trackId }).from(rekordboxLink).where(inArray(rekordboxLink.trackId, ids.slice(i, i + 500))).all()) linked.add(r.trackId);
	}
	const unlinked = ids.filter((id) => !linked.has(id));

	const contentOps: CreatePlan['contentOps'] = [];
	let unplayable = 0;
	for (const id of unlinked) {
		const t = db.select().from(track).where(eq(track.id, id)).get();
		if (!t || t.deletedAt) { unplayable++; continue; }
		// Live links only (missing_at IS NULL): a file the watcher saw vanish
		// must not be created in rekordbox — rb would import a dead path and
		// show the track missing. existsSync covers the window before the
		// watcher has flagged it. (The importer is the opposite call: it still
		// matches missing links, since binding costs nothing and keeps identity.)
		const files = db
			.select({ filePath: sourceLink.filePath })
			.from(sourceLink)
			.where(and(eq(sourceLink.trackId, id), eq(sourceLink.source, 'local'), isNull(sourceLink.missingAt)))
			.all()
			.map((r) => r.filePath)
			.filter((p): p is string => !!p && existsSync(p));
		const path = files[0];
		if (!path) { unplayable++; continue; }
		const sourceRb = t.derivedFromTrackId
			? db.select({ rbContentId: rekordboxLink.rbContentId }).from(rekordboxLink).where(eq(rekordboxLink.trackId, t.derivedFromTrackId)).get()
			: undefined;
		const format = await readAudioFormat(path);
		contentOps.push({
			kind: 'content_create',
			curator_track_id: id,
			path,
			source_rb_content_id: sourceRb?.rbContentId ?? null,
			meta: {
				Title: effectiveTitle(t, fmt),
				ArtistName: effectiveArtistName(t, fmt),
				AlbumName: effectiveAlbum(t),
				LabelName: effectiveLabel(t),
				GenreName: effectiveGenre(t),
				// 0 is rekordbox's "unrated" — same omit rule as the update push.
				Rating: t.rating != null && t.rating > 0 ? t.rating : null,
				Comment: t.comment,
				Color: t.colorLabel,
				bpm: t.overrides?.bpm ?? t.bpm,
				length_sec: t.duration,
				sample_rate: format?.sampleRate ?? null,
				bit_depth: format?.bitDepth ?? null,
				channels: format?.channels ?? null,
				release_year: releaseYear(t.overrides?.releaseDate ?? t.releaseDate),
				key_camelot: t.overrides?.keyCamelot ?? t.keyCamelot,
			},
		});
	}
	return { contentOps, unplayable };
}

export interface CreatePhaseDeps {
	db: Db;
	sidecar: RekordboxSidecar;
	writeAudit?: (entry: Record<string, unknown>) => void;
	progress: (phase: string, done: number, total: number) => void;
}

export async function runCreatePhase(
	deps: CreatePhaseDeps,
	plan: CreatePlan,
	conn: { dbPath: string; key?: string },
	onBackup: (path: string) => void,
): Promise<CreatePhaseSummary> {
	const { db, sidecar } = deps;
	const ops: CreateOp[] = [...plan.contentOps, ...(plan.playlistOp ? [plan.playlistOp] : [])];

	// Refuse up front while rekordbox runs. The writer's per-op SAVEPOINTs can
	// persist rows as each op completes (a savepoint opened outside a
	// transaction commits on release), so commit_and_close's "rekordbox is
	// running" error arrives AFTER the rows exist — and it also leaves Curator
	// without the links, so a retry would mint a second playlist
	// (playlist_create isn't idempotent). Checking first keeps both out.
	const detected = await sidecar.detect();
	if (detected.running) {
		throw Object.assign(new Error('Close rekordbox before syncing — new tracks and playlists can only be created while it is closed.'), { kind: 'db_locked' });
	}

	deps.progress('create:backup', 0, 1);
	const backup = await sidecar.backup(conn.dbPath);
	onBackup(backup.path);
	deps.progress('create:backup', 1, 1);

	await sidecar.openForWrite({ dbPath: conn.dbPath, key: conn.key });
	try {
		deps.writeAudit?.({
			kind: 'rekordbox-create-batch',
			playlistId: plan.playlistId,
			contentCreates: plan.contentOps.length,
			withAnalysis: plan.contentOps.filter((o) => o.source_rb_content_id).length,
			playlistCreate: plan.playlistOp != null,
			backupPath: backup.path,
		});
	} catch { /* audit must never block the push */ }
	deps.progress('create:write', 0, ops.length);
	const { results } = await sidecar.applyWriteBatch(ops, (done, total) => deps.progress('create:write', done, total));
	deps.progress('create:write', ops.length, ops.length);

	const ok = (r: WriteOpResult | undefined): boolean => !!r && !r.error && !r.skipped;
	const createdIds: string[] = [];
	const verifyOps: CreatedVerifyOp[] = [];
	const writeFailures: WriteFailure[] = [];
	let tracksCreated = 0, anlzCopied = 0, anlzMissing = 0;
	let rbPlaylistId: string | null = null;
	ops.forEach((op, i) => {
		const r = results[i];
		if (!r || !ok(r)) {
			writeFailures.push({
				kind: op.kind,
				target: op.kind === 'content_create' ? op.curator_track_id : op.curator_playlist_id,
				targetLabel: op.kind === 'content_create' ? op.meta.Title : op.name,
				error: r?.error ?? 'skipped by the writer',
			});
			return;
		}
		if (op.kind === 'content_create' && r.rb_content_id) {
			createdIds.push(r.rb_content_id);
			verifyOps.push({ kind: 'content_create', rb_content_id: r.rb_content_id, path: op.path, anlz_copied: r.anlz_copied === true });
			if (r.created) tracksCreated++;
			if (r.anlz_copied) anlzCopied++;
			else if (r.created) anlzMissing++;
		} else if (op.kind === 'playlist_create' && r.rb_playlist_id) {
			rbPlaylistId = r.rb_playlist_id;
			verifyOps.push({ kind: 'playlist_create', rb_playlist_id: r.rb_playlist_id, name: op.name });
		}
	});

	const commit = await sidecar.commitAndClose(createdIds);

	deps.progress('create:verify', 0, 1);
	const verify = await sidecar.verify(conn.dbPath, conn.key, verifyOps);
	deps.progress('create:verify', 1, 1);

	// Committed rows exist in rekordbox whether or not verify liked them —
	// record them, or a retry would mint a second playlist (content_create is
	// idempotent by path; playlist_create is not).
	const linkedCount = applyCreatedOnCurator(db, plan, ops, results, commit.baselines, rbPlaylistId);
	const summary: CreatePhaseSummary = {
		tracksCreated,
		tracksLinked: linkedCount,
		playlistCreated: rbPlaylistId != null,
		anlzCopied,
		anlzMissing,
		rekeyedPlaylistId: rbPlaylistId ? `rb_${rbPlaylistId}` : null,
		backupPath: backup.path,
		verifyOk: verify.ok,
		verifyPragmaError: verify.pragma_error,
		verifyFailures: verify.failures,
		writeFailures,
	};
	clog.info('create phase done', { playlistId: plan.playlistId, ...summary, verifyFailures: verify.failures.length, writeFailures: writeFailures.length });
	return summary;
}

// Curator side of a committed create batch, in one transaction.
function applyCreatedOnCurator(
	db: Db,
	plan: CreatePlan,
	ops: CreateOp[],
	results: WriteOpResult[],
	baselines: Record<string, number | null>,
	rbPlaylistId: string | null,
): number {
	const now = new Date();
	let linked = 0;
	db.transaction((tx) => {
		ops.forEach((op, i) => {
			const r = results[i];
			if (op.kind !== 'content_create' || !r || r.error || r.skipped || !r.rb_content_id) return;
			const cid = r.rb_content_id;
			const seen = baselines[cid];
			// One rb row ↔ one track (unique rb_content_id): drop a stale link
			// another track may hold to the same row, as the importer does.
			tx.delete(rekordboxLink)
				.where(and(eq(rekordboxLink.rbContentId, cid), ne(rekordboxLink.trackId, op.curator_track_id)))
				.run();
			const values = {
				rbContentId: cid,
				// The importer refreshes the USN on its next pass; nothing gates on
				// it before then.
				rbLocalUsn: 0,
				rbFilePath: normalizePath(r.folder_path ?? op.path),
				lastSyncedAt: now,
				// Post-commit updated_at — the LMW baseline, so the next pull
				// doesn't read this row as "changed in rekordbox".
				rbUpdatedAtSeen: seen != null ? new Date(seen) : now,
				// Never pushed: the update push that follows writes everything
				// and seeds the three-way-merge baselines on verify.
				pushedAt: null,
				fieldsSeen: null,
				cuesSeen: null,
			};
			tx.insert(rekordboxLink)
				.values({ trackId: op.curator_track_id, importedAt: now, ...values })
				.onConflictDoUpdate({ target: rekordboxLink.trackId, set: values })
				.run();
			linked++;
		});

		if (rbPlaylistId && plan.playlistId) {
			// Re-key to the importer's identity (`rb_<ID>`, source='rekordbox')
			// so every rb code path — pull upserts, playlist_merge, baselines,
			// the sidebar's rekordbox tree — treats it as the rb playlist it now is.
			const old = tx.select().from(playlistTable).where(eq(playlistTable.id, plan.playlistId!)).get();
			if (old) {
				const newId = `rb_${rbPlaylistId}`;
				const { id: _oldId, ...rest } = old;
				const row: NewPlaylist = {
					...rest,
					id: newId,
					source: 'rekordbox',
					sourceId: rbPlaylistId,
					mark: 'R',
					syncStatus: 'synced',
					parentFolderId: null,
					// rekordbox now holds the name playlist_create wrote — the
					// update push's rename baseline (a rename made since the plan
					// was built still differs, so it still goes out).
					rbNameSeen: plan.playlistOp?.name ?? null,
					lastSyncedAt: now,
					updatedAt: now,
				};
				const raw = rawOf(db);
				const local = isDeviceLocalPlaylist(raw, old.id);
				tx.insert(playlistTable).values(row).run();
				tx.update(playlistTrack).set({ playlistId: newId }).where(eq(playlistTrack.playlistId, old.id)).run();
				tx.delete(playlistTable).where(eq(playlistTable.id, old.id)).run();
				// On the op log a re-key is a new playlist: its create, an add
				// re-binding each row (same row ids; the later add moves a row to
				// its new playlist under LWW), then the old id's delete. A
				// derived "[WAV]" playlist is device-local and stays silent.
				if (!local) {
					const rec = recordingResolver(raw);
					const rowIds = tx.select({ id: playlistTrack.id }).from(playlistTrack).where(eq(playlistTrack.playlistId, newId)).all().map((r) => r.id);
					emitOps(raw, [
						...playlistCreateOps(raw, newId),
						...rowIds.map((id) => memberAddOp(raw, id, rec)).filter((o): o is NonNullable<typeof o> => o !== null),
						{ entity: 'playlist', entity_id: old.id, kind: 'delete', payload: {} },
					]);
				}
			}
		}
	});
	return linked;
}
