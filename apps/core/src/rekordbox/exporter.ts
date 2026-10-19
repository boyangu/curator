// Rekordbox EXPORTER — peer of importer.ts.
//
// Flow:
//   1. Caller (CoreService.syncToRekordbox) hands us {targetKind,
//      targetId, flags, dbPath, key}.
//   2. We resolve the target to (curatorTrackId, rbContentId) pairs —
//      a single one for track-level, every linked member for playlist.
//      Tracks without a rekordboxLink are counted as `skipped`; we
//      never send them to the sidecar.
//   3. Build WriteOps from each scope-flag the user enabled, using the
//      effective Curator values (track row + overrides JSON).
//   4. Sidecar dance: backup → openForWrite → applyWriteBatch →
//      commitAndClose → verify.
//   5. On verify pass: advance rekordboxLink.rbUpdatedAtSeen from the
//      commit baselines so the next inbound sync doesn't see "rb-newer"
//      and undo our writes (the LMW gate in importer.ts:decideRbWins
//      reads this column), and stamp rekordboxLink.pushedAt with the time
//      this run STARTED — the "Sync updates" convergence marker (see
//      resolveTargets).
//   6. On verify fail: leave Curator's rekordboxLink baselines alone;
//      surface failures + backupPath upstream so the renderer can show
//      the restore-or-leave modal.
//
// Scopes (locked in PRD):
//   - syncMetadata     → track.fields write (Title/ArtistName/AlbumName/LabelName/GenreName/Rating/Comment/Color);
//                        name → relation-row lookups are tombstone-aware
//                        (writer.py), and "Sync updates" sweeps in tracks
//                        rb currently shows blank because of a tombstoned
//                        relation (sweepStaleRelations)
//   - syncCues         → cue rows write (wipe-and-re-add)
//   - syncTags         → DjmdSongMyTag membership write, AND the Comment
//                        pushed by syncMetadata is rebuilt so its trailing
//                        `/* tag / tag */` block mirrors the tag set — that
//                        block is what rekordbox's text search reads (see
//                        tag-comment.ts)
//   - syncPlaylist     → playlist row + DjmdSongPlaylist membership (only valid for playlist-level sync)
// `syncBeatgridPhrases` + `syncWaveform` are accepted in the flags shape
// for forward compat but ignored in v1.

import { and, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { DEFAULT_ARTIST_CREDIT_FORMAT, type ArtistCreditFormat } from '@curator/shared';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
	track,
	cue as cueTable,
	tag as tagTable,
	trackTag,
	playlist as playlistTable,
	playlistTrack,
	playlistFolder as playlistFolderTable,
	rekordboxLink,
	rekordboxDeletedContent,
	sourceLink,
	syncConflict,
	rekordboxMembershipBaseline,
	playlistConflict,
} from '@curator/shared/schema';
import type { CueUnit, FieldsSeen } from '@curator/shared';
import type { Db } from '../db/client.js';
import {
	effectiveAlbum,
	effectiveArtistName,
	effectiveGenre,
	effectiveLabel,
	effectiveTitle,
	type CuratorTrackView,
} from '../sync/curator-view.js';
import {
	RekordboxSidecar,
	type SidecarError,
	type StaleRelation,
	type StaleRelationField,
	type WriteOp,
	type WriteFailure,
	type VerifyFailure,
	type BackupResult,
} from './sidecar.js';
import { eqArr } from './order-util.js';
import { planCreateForTracks, planCreatePhase, runCreatePhase, type CreatePhaseSummary } from './create-phase.js';
import { buildTagComment, tagCommentMatches } from './tag-comment.js';
import { log } from '../log.js';
import { deletePlaylist } from '../library/mutators.js';

const xlog = log.for('rb-export');

export interface ExportFlags {
	syncMetadata: boolean;
	syncCues: boolean;
	syncTags: boolean;
	// Only honored when targetKind === 'playlist'. For track-level the
	// flag is ignored — we never push a playlist when the user
	// right-clicked a single row.
	syncPlaylist: boolean;
	// v1: visible-but-disabled in the modal. Forward-compat fields so
	// the wire shape doesn't change when v2 lands.
	syncBeatgridPhrases?: boolean;
	syncWaveform?: boolean;
	// rbPlaylistIds the user has explicitly confirmed after a prior push
	// held their removals as 'mass-removal' (see RemovalHold). Bypasses the
	// mass-removal breaker for ONLY these playlists. Deliberately does NOT
	// override 'unlinked-members': a big removal computed while members are
	// invisible is exactly the link-loss corruption the guard exists to
	// stop, so it always holds regardless of this list.
	allowMassRemovalFor?: string[];
	// 'tracks' target only: first CREATE the selected tracks rekordbox
	// doesn't have yet (local file, no rekordbox_link) — the "Add to
	// Rekordbox" track command. Off for every other entry point, which stay
	// update-only.
	createMissing?: boolean;
}

export interface RunExportOptions {
	// 'tracks' covers both single and multi-select — single-track sync from
	// the row context menu passes a length-1 array; multi-select passes the
	// whole selection. Symmetric handling means one backup + one verify pass
	// for the batch regardless of count.
	//
	// 'folder' = right-click a rb folder in the sidebar. Resolves
	// recursively to every non-smart non-hidden rb playlist under it,
	// emits one playlist WriteOp per descendant, and runs the same
	// backup → write → verify dance once for the batch.
	//
	// 'updates' = right-click the Rekordbox source tab → "Sync updates".
	// Resolves to every rb-linked track Curator changed since its last
	// verified push (pushedAt IS NULL OR track.updatedAt >= pushedAt) AND
	// every non-smart non-hidden rb playlist with a membership, order or
	// name change to send (see buildWriteOps). targetIds is ignored. The
	// user picks scope (metadata/cues/playlist) via the modal's flag
	// checkboxes as with the other kinds.
	targetKind: 'tracks' | 'playlist' | 'folder' | 'updates';
	// For 'tracks': curator track.id values. For 'playlist'/'folder':
	// a single-element array containing the curator playlist.id /
	// playlist_folder.id. For 'updates': ignored. Generalizing to an
	// array avoids a second IPC channel for multi-select.
	targetIds: string[];
	flags: ExportFlags;
	dbPath: string;
	key?: string;
}

// A playlist whose remove-set (or order push) was withheld by a safety
// guard. 'unlinked-members': the playlist has members whose curator track
// lost its rekordbox_link, so the rb-id diff cannot distinguish "user
// deleted X" from "X's link broke" — pushing the removals would replay the
// 2026-06/07 phantom-delete incident (link loss → removed from rb →
// re-added at the tail after repair). 'mass-removal': the diff wants to
// drop more than max(3, 10%) of the baseline in one push — big enough that
// it's likelier corruption than curation, so it waits for the user.
export interface RemovalHold {
	rbPlaylistId: string;
	playlistId: string;
	// Display name at hold time — the renderer's held-changes dialog names
	// the playlist without a second lookup (the row may even be renamed by
	// the same push's rename op, so resolving later could mislead).
	playlistName: string;
	heldRemovals: number;
	reason: 'unlinked-members' | 'mass-removal';
	// The members invisible to the diff — the cause of an unlinked-members
	// hold, resolved to display shape so the dialog can name them. hasFile
	// splits the two user situations: false = streaming-only add that was
	// never downloaded (nothing for rb to import yet — the hold clears once
	// the track lands in rb as a file), true = a file exists but the rb
	// link is missing (fresh download rb hasn't imported, or a lost link —
	// either way a read sync after rb sees the file repairs it).
	unlinkedTracks: Array<{ trackId: string; title: string; artist: string | null; hasFile: boolean }>;
}

export interface ExportResult {
	backupPath: string;
	tracksConsidered: number;
	tracksSkippedNotLinked: number;
	tracksWritten: number;
	cuesWritten: number;
	tagsWritten: number;
	// Number of playlist WriteOps the sidecar applied. 0 for track-level
	// syncs, 1 for a single-playlist sync, N for a folder sync.
	playlistsWritten: number;
	// Safety-guard holds (see RemovalHold). Non-empty means some playlist
	// removals/order pushes did NOT go through and the user should look.
	removalsHeld: RemovalHold[];
	// Stale-linkage cleanup counts. A track op whose rb_content_id no
	// longer exists in master.db (deleted in rb between read syncs) gets
	// its rekordboxLink row dropped on the curator side post-write so the
	// next sync doesn't re-attempt; a playlist op whose rb_playlist_id
	// is gone gets the curator playlist row dropped (cascade also clears
	// playlist_track). The DISTINCT rb-side id count lives here so the
	// toast can show "3 stale links cleaned" without surfacing every op.
	tracksUnlinked: number;
	playlistsRemoved: number;
	// Tracks removed from rekordbox's Collection this push — tombstone
	// propagation of Curator-side deletes (content_delete ops that actually
	// flipped a live rb row; already-settled tombstones don't count).
	contentDeleted: number;
	verifyOk: boolean;
	verifyPragmaError: string | null;
	verifyFailures: VerifyFailure[];
	// Ops the writer could not apply (per-op SAVEPOINT rolled back; the rest
	// of the batch landed). Distinct from verifyFailures: these never
	// executed, so they're excluded from verify AND their baselines don't
	// advance — a re-sync retries them after the user fixes the cause.
	writeFailures: WriteFailure[];
	// Convert-to-WAV playlists only: what the create phase minted in
	// rekordbox before the update push (see create-phase.ts). Null when the
	// phase didn't run.
	created: CreatePhaseSummary | null;
}

export type RekordboxExportEvent =
	| { kind: 'started';   target: 'track' | 'playlist' | 'folder' | 'updates' }
	| { kind: 'progress';  phase: string; done: number; total: number }
	| { kind: 'completed'; result: ExportResult }
	| { kind: 'failed';    errorKind: string; message: string; backupPath?: string };


// The effective-value helpers ("ours" = override ?? canonical) live in
// ../sync/curator-view.ts, shared with the importer's merge pass so push
// and pull can never disagree about Curator's current values.

// Per-playlist ordered membership as the diff sees it: linked members only.
// unlinkedTrackIds are the membership rows whose curator track has NO
// rekordbox_link — those members exist for the user but are invisible to the
// rb-id diff, which is why buildWriteOps refuses to remove or reorder while
// any are present (see RemovalHold, which also carries their resolved
// identities so the dialog can name them).
interface PlaylistOrder {
	playlistId: string;
	members: Array<{ curatorTrackId: string; rbContentId: string }>;
	unlinkedTrackIds: string[];
}

// A value worth pushing to rb: present and not the empty string. Mirrors
// writer.py's null≡'' diff rule — the writer would treat both as "clear
// this field", so neither is a value we ever want to send when the intent
// is "leave rb alone."
function nonEmpty(v: string | null | undefined): v is string {
	return v != null && v !== '';
}

// The FK-backed text fields exactly as the metadata op sends them. One source
// for buildWriteOps AND the stale-relation sweep's healability check — if they
// disagreed, the sweep would add tracks whose push can't re-point the dead FK
// and "Sync updates" would never converge.
function relationFieldValues(
	t: Pick<CuratorTrackView, 'artists' | 'albumTitle' | 'label' | 'genre' | 'overrides'>,
	fmt: ArtistCreditFormat,
): Record<StaleRelationField, string | null> {
	return {
		artist: effectiveArtistName(t, fmt),
		album: effectiveAlbum(t),
		label: effectiveLabel(t),
		genre: effectiveGenre(t),
	};
}

export class RekordboxExporter extends EventEmitter {
	private running = false;

	constructor(
		private readonly db: Db,
		private readonly sidecar: RekordboxSidecar,
		// Optional write-audit sink (see CoreServiceOptions.writeAudit) —
		// one entry per applied write batch. Must never throw into the push.
		private readonly writeAudit?: (entry: Record<string, unknown>) => void,
		// The credit display format (separator / remix style) the pushed
		// Title + Artist strings follow — core's app_setting value, read at
		// push time so a Settings change applies to the next sync.
		private readonly creditFormat: () => ArtistCreditFormat = () => DEFAULT_ARTIST_CREDIT_FORMAT,
	) { super(); }

	isRunning(): boolean { return this.running; }

	async runExport(opts: RunExportOptions): Promise<ExportResult> {
		if (this.running) throw new Error('rekordbox export already in flight');
		this.running = true;
		const emit = (e: RekordboxExportEvent): void => { this.emit('event', e); };
		emit({
			kind: 'started',
			target: opts.targetKind === 'playlist' ? 'playlist'
				: opts.targetKind === 'folder' ? 'folder'
				: opts.targetKind === 'updates' ? 'updates'
				: 'track',
		});

		// Single shared backup variable so the failed-event still
		// carries the backup path the user can restore from.
		let backupInfo: BackupResult | undefined;

		try {
			// 0. Create phase — a "Convert to WAV" playlist whose members (or
			//    the playlist itself) don't exist in rekordbox yet. Own write
			//    session + verify, so the rows exist and are linked before the
			//    update push below resolves targets. Its backup (taken before
			//    any write) stands for the whole sync.
			let created: CreatePhaseSummary | null = null;
			const wantsCreate = (opts.targetKind === 'playlist' && !!opts.targetIds[0])
				|| (opts.targetKind === 'tracks' && opts.flags.createMissing === true && opts.targetIds.length > 0);
			if (wantsCreate) {
				const plan = opts.targetKind === 'playlist'
					? await planCreatePhase(this.db, opts.targetIds[0]!, opts.flags.syncPlaylist, this.creditFormat())
					: await planCreateForTracks(this.db, opts.targetIds, this.creditFormat());
				if (plan) {
					created = await runCreatePhase(
						{
							db: this.db,
							sidecar: this.sidecar,
							writeAudit: this.writeAudit,
							progress: (phase, done, total) => emit({ kind: 'progress', phase, done, total }),
						},
						plan,
						{ dbPath: opts.dbPath, key: opts.key },
						(path) => { backupInfo = { path, sizeBytes: 0, takenAtMs: Date.now() }; },
					);
					// The playlist is now `rb_<ID>` — push against its new identity.
					if (created.rekeyedPlaylistId) opts = { ...opts, targetIds: [created.rekeyedPlaylistId] };
					if (!created.verifyOk) {
						// Don't stack the update push on rows that failed read-back;
						// surface the failures (restore-or-leave modal) instead.
						const result: ExportResult = {
							backupPath: created.backupPath,
							tracksConsidered: plan.contentOps.length,
							tracksSkippedNotLinked: plan.unplayable,
							tracksWritten: 0,
							cuesWritten: 0,
							tagsWritten: 0,
							playlistsWritten: 0,
							removalsHeld: [],
							tracksUnlinked: 0,
							playlistsRemoved: 0,
							contentDeleted: 0,
							verifyOk: false,
							verifyPragmaError: created.verifyPragmaError,
							verifyFailures: created.verifyFailures,
							writeFailures: created.writeFailures,
							created,
						};
						emit({ kind: 'completed', result });
						return result;
					}
				}
			}

			// The pushedAt stamp for this run, captured BEFORE targets are
			// resolved or ops built, on the same clock track.updatedAt uses.
			// Anything Curator changes from here on — including while the
			// write/commit/verify below is in flight — has updatedAt >= this
			// and is picked up by the next "Sync updates". (rekordbox's
			// post-commit updated_at can't serve: it lands AFTER an in-flight
			// edit and would mask it.)
			const pushStartedAt = new Date();

			// 1. Resolve target → (curatorTrackId, rbContentId) pairs.
			const targets = this.resolveTargets(opts);
			await this.sweepStaleRelations(opts, targets.linked);
			emit({ kind: 'progress', phase: 'resolve', done: targets.linked.length, total: targets.linked.length + targets.skipped });

			// 2. Build write ops.
			const { ops, holds } = this.buildWriteOps(opts, targets.linked, targets.playlistOrders ?? []);
			// Folder-name reconcile — for a folder-target sync, push the current
			// name of the target folder + every descendant folder. playlist_merge
			// carries playlist names, but the writer skips folder names there, so
			// folders need their own op. Idempotent: the writer no-ops names that
			// already match, so an unchanged folder costs one rb read per node.
			if (opts.targetKind === 'folder' && opts.flags.syncPlaylist) {
				const rootFolderId = opts.targetIds[0];
				if (rootFolderId) {
					const visited = new Set<string>([rootFolderId]);
					let frontier: string[] = [rootFolderId];
					while (frontier.length > 0) {
						const children = this.db
							.select({ id: playlistFolderTable.id })
							.from(playlistFolderTable)
							.where(and(
								eq(playlistFolderTable.source, 'rekordbox'),
								inArray(playlistFolderTable.parentFolderId, frontier),
							))
							.all();
						frontier = [];
						for (const c of children) {
							if (visited.has(c.id)) continue;
							visited.add(c.id);
							frontier.push(c.id);
						}
					}
					const folderRows = this.db
						.select({ id: playlistFolderTable.id, name: playlistFolderTable.name, sourceId: playlistFolderTable.sourceId })
						.from(playlistFolderTable)
						.where(inArray(playlistFolderTable.id, Array.from(visited)))
						.all();
					for (const f of folderRows) {
						const rbFolderId = f.id.startsWith('rb_') ? f.id.slice(3) : f.sourceId;
						ops.push({ kind: 'playlist_rename', rb_playlist_id: rbFolderId, name: f.name });
					}
				}
			}
			// Tombstone propagation — every Curator-side delete of an rb-linked
			// track queued a collection removal (rekordbox_deleted_content with
			// pushed_at NULL). Rides every push regardless of target: the user's
			// delete already carried the intent, the sync is just the transport.
			// Settled tombstones (pushed_at set) never re-emit.
			const pendingTombstones = this.db
				.select({ rbContentId: rekordboxDeletedContent.rbContentId })
				.from(rekordboxDeletedContent)
				.where(isNull(rekordboxDeletedContent.pushedAt))
				.all();
			for (const t of pendingTombstones) {
				ops.push({ kind: 'content_delete', rb_content_id: t.rbContentId });
			}

			if (ops.length === 0) {
				// Nothing to write — still produce a result so the UI can
				// toast "no changes" cleanly. No backup needed.
				const result: ExportResult = {
					backupPath: backupInfo?.path ?? '',
					tracksConsidered: targets.linked.length + targets.skipped,
					tracksSkippedNotLinked: targets.skipped,
					tracksWritten: 0,
					cuesWritten: 0,
					tagsWritten: 0,
					playlistsWritten: 0,
					removalsHeld: holds,
					tracksUnlinked: 0,
					playlistsRemoved: 0,
					contentDeleted: 0,
					verifyOk: true,
					verifyPragmaError: null,
					verifyFailures: created?.verifyFailures ?? [],
					writeFailures: created?.writeFailures ?? [],
					created,
				};
				emit({ kind: 'completed', result });
				return result;
			}

			// 3. Backup BEFORE any write (the create phase already took one).
			if (!created) {
				emit({ kind: 'progress', phase: 'backup', done: 0, total: 1 });
				backupInfo = await this.sidecar.backup(opts.dbPath);
				emit({ kind: 'progress', phase: 'backup', done: 1, total: 1 });
			}
			const backupPathForRun = backupInfo!.path;

			// 4. Open for write, apply batch, commit.
			await this.sidecar.openForWrite({ dbPath: opts.dbPath, key: opts.key });
			emit({ kind: 'progress', phase: 'write', done: 0, total: ops.length });
			// Audit BEFORE the batch lands — if the write dies mid-flight the
			// log still shows what was attempted, which is the forensic point.
			try {
				const opCounts: Record<string, number> = {};
				for (const op of ops) opCounts[op.kind] = (opCounts[op.kind] ?? 0) + 1;
				this.writeAudit?.({
					kind: 'rekordbox-write-batch',
					target: opts.targetKind,
					ops: opCounts,
					playlists: ops.filter((o) => o.kind === 'playlist_merge').map((o) => ({
						rbPlaylistId: (o as Extract<WriteOp, { kind: 'playlist_merge' }>).rb_playlist_id,
						removes: (o as Extract<WriteOp, { kind: 'playlist_merge' }>).remove.length,
						adds: (o as Extract<WriteOp, { kind: 'playlist_merge' }>).add.length,
						orderPushed: (o as Extract<WriteOp, { kind: 'playlist_merge' }>).order !== null,
					})),
					holds,
					backupPath: backupPathForRun,
				});
			} catch { /* audit must never block the push */ }
			// The sidecar streams {done,total} while it stages the batch (at
			// most every 250 ms / 200 ops) — a big batch used to sit at 0 for
			// the whole call.
			const writeResult = await this.sidecar.applyWriteBatch(ops, (done, total) => {
				emit({ kind: 'progress', phase: 'write', done, total });
			});
			emit({ kind: 'progress', phase: 'write', done: ops.length, total: ops.length });

			// Commit is one indivisible pyrekordbox call (SQLCipher flush +
			// masterPlaylists6.xml rewrite) with no progress hook — its own
			// phase so the bar says "saving" rather than freezing at 100%
			// written. The sidecar heartbeats meanwhile to keep the RPC alive.
			const writtenIds = targets.linked.map((p) => p.rbContentId);
			emit({ kind: 'progress', phase: 'commit', done: 0, total: 1 });
			const commitResult = await this.sidecar.commitAndClose(writtenIds, (done, total) => {
				emit({ kind: 'progress', phase: 'commit', done, total });
			});
			emit({ kind: 'progress', phase: 'commit', done: 1, total: 1 });

			// 4b. Collect every op the writer flagged as `missing` — the rb
			//     side row was deleted between Curator's last read sync and
			//     this write. Two consequences:
			//       a. Verify must SKIP these ops. Re-checking a row we never
			//          attempted to write only re-reports the same gap as a
			//          verification failure — load-bearing for the v1 fix
			//          (without this, "Sync updates" surfaces "row missing
			//          after write" for every deleted rb row).
			//       b. The curator-side linkage gets pruned so the next sync
			//          doesn't re-include the dead id (tracks → rekordboxLink
			//          row dropped; playlists → curator playlist row dropped,
			//          cascade clears playlist_track).
			//     We dedupe the rb ids by op kind so an entry that appeared
			//     in multiple ops (e.g. a track with both metadata + cues
			//     marked missing) counts once.
			const missingTrackRbIds = new Set<string>();
			const missingPlaylistRbIds = new Set<string>();
			// Tombstones whose rb-side work is finished — the content row was
			// already gone (missing), or its delete verified below. Stamped
			// pushed_at post-verify so the next push doesn't re-emit them.
			const settledContentDeletes = new Set<string>();
			const opsToVerify: WriteOp[] = [];
			const erroredOps: Array<{ op: WriteOp; error: string }> = [];
			for (let i = 0; i < ops.length; i++) {
				const op = ops[i]!;
				const r = writeResult.results[i];
				// An errored op never executed (its SAVEPOINT rolled back) —
				// verifying it would re-report the same gap as a verify failure,
				// and advancing its baseline would bless a write that didn't
				// land. Excluding it from opsToVerify handles both (baselines
				// advance only over opsToVerify).
				if (r?.error) {
					erroredOps.push({ op, error: r.error });
					continue;
				}
				if (r?.missing) {
					if (op.kind === 'playlist_merge') missingPlaylistRbIds.add(op.rb_playlist_id);
					// A rename op whose folder/playlist vanished in rb — leave the
					// curator row alone (folders may legitimately have no tracks;
					// we don't prune on a name push).
					else if (op.kind === 'playlist_rename') { /* no prune */ }
					// A content_delete whose rb row is already hard-gone is settled
					// (deleted harder than we asked). It's NOT a stale-linkage prune
					// target — the curator link was already dropped at delete time,
					// and it belongs to a different evidence class than a track op
					// that unexpectedly found its rb row missing.
					else if (op.kind === 'content_delete') settledContentDeletes.add(op.rb_content_id);
					else missingTrackRbIds.add(op.rb_content_id);
					continue;
				}
				// Name-only pushes are self-verifying via the writer's
				// name_changed result — keep them out of the read-back verify.
				if (op.kind === 'playlist_rename') continue;
				// Adds the writer skipped because the rb content row is gone
				// (track deleted in rekordbox): prune those links — same
				// evidence class as a missing track op — and verify the op
				// WITHOUT them, or the verifier re-reports the same gap as
				// "expected added, missing" on every sync.
				if (op.kind === 'playlist_merge' && r?.missing_adds && r.missing_adds.length > 0) {
					const dead = new Set(r.missing_adds);
					for (const id of dead) missingTrackRbIds.add(id);
					xlog.warn('playlist adds skipped — tracks deleted in rekordbox', {
						playlist: op.rb_playlist_id, contentIds: [...dead],
					});
					opsToVerify.push({ ...op, add: op.add.filter((a) => !dead.has(a.rb_content_id)) });
					continue;
				}
				opsToVerify.push(op);
			}
			const writeFailures = this.attributeWriteFailures(erroredOps);
			const { tracksUnlinked, playlistsRemoved } = this.pruneStaleLinkages(
				missingTrackRbIds,
				missingPlaylistRbIds,
			);

			// 5. Verify — filtered to ops the writer actually attempted.
			emit({ kind: 'progress', phase: 'verify', done: 0, total: 1 });
			const verifyResult = await this.sidecar.verify(opts.dbPath, opts.key, opsToVerify);
			emit({ kind: 'progress', phase: 'verify', done: 1, total: 1 });

			// 6. Advance rekordboxLink baselines ONLY on full verify pass.
			//    Partial pass with one failure: leave baselines alone, so a
			//    re-sync after the user's fix doesn't get LMW-rolled-back.
			if (verifyResult.ok) {
				const failedRbIds = new Set(erroredOps.map(({ op }) =>
					op.kind === 'playlist_merge' || op.kind === 'playlist_rename' ? op.rb_playlist_id : op.rb_content_id));
				this.advanceBaselines(targets.linked, commitResult.baselines, opsToVerify, failedRbIds, {
					at: pushStartedAt,
					// Read BEFORE advanceBaselines rewrites pushedAt — the
					// cue rule compares against the previous push.
					trackIds: this.pushStampTrackIds(opts.flags, targets.linked),
				});
				this.advancePlaylistNameBaselines(opsToVerify);
				// Membership baseline B := current Curator membership for every
				// playlist we pushed (and that still exists on the rb side). This
				// is what makes the next Curator→rb diff a no-op until the user
				// edits again — the membership analogue of the field/cue advance.
				// Playlists with a removal/order hold are excluded: advancing B
				// would erase the very diff the hold refused to push, silently
				// blessing the suspicious state. Keeping B stale re-detects the
				// hold on every push until the links are repaired or the user
				// resolves it.
				if (targets.playlistOrders && targets.playlistOrders.length > 0) {
					const heldPlaylistIds = new Set(holds.map((h) => h.playlistId));
					this.advanceMembershipBaselines(
						targets.playlistOrders.filter((o) => !heldPlaylistIds.has(o.playlistId)),
						missingPlaylistRbIds,
					);
				}
				// Verified content deletes are settled alongside the already-gone
				// ones. On a failed verify only the missing set stamps (nothing
				// was written for those) — the rest re-emit next push, where the
				// writer's already-deleted no-op keeps the retry churn-free.
				for (const op of opsToVerify) {
					if (op.kind === 'content_delete') settledContentDeletes.add(op.rb_content_id);
				}
			}
			if (settledContentDeletes.size > 0) {
				const stampedAt = new Date();
				const ids = Array.from(settledContentDeletes);
				for (let i = 0; i < ids.length; i += 500) {
					this.db.update(rekordboxDeletedContent)
						.set({ pushedAt: stampedAt })
						.where(inArray(rekordboxDeletedContent.rbContentId, ids.slice(i, i + 500)))
						.run();
				}
			}

			// 7. Roll up counts from the per-op write results.
			const counts = this.tallyWriteResults(writeResult.results);
			const result: ExportResult = {
				backupPath: backupPathForRun,
				tracksConsidered: targets.linked.length + targets.skipped,
				tracksSkippedNotLinked: targets.skipped,
				tracksWritten: counts.tracksWritten,
				cuesWritten: counts.cuesWritten,
				tagsWritten: counts.tagsWritten,
				playlistsWritten: counts.playlistsWritten,
				removalsHeld: holds,
				tracksUnlinked,
				playlistsRemoved,
				contentDeleted: counts.contentDeleted,
				verifyOk: verifyResult.ok,
				verifyPragmaError: verifyResult.pragma_error,
				verifyFailures: verifyResult.failures,
				// Create-phase ops that didn't apply (e.g. a member whose file
				// rekordbox can't stat) surface alongside the update push's.
				writeFailures: [...(created?.writeFailures ?? []), ...writeFailures],
				created,
			};
			emit({ kind: 'completed', result });
			return result;
		} catch (err) {
			const e = err as SidecarError;
			const kind = e.kind ?? 'internal';
			const message = e.message ?? String(err);
			emit({ kind: 'failed', errorKind: kind, message, backupPath: backupInfo?.path });
			throw err;
		} finally {
			this.running = false;
		}
	}

	// ──────────────────────────────────────────────────────────────────
	// Target resolution.

	// "Sync updates" self-heal for rb-side damage Curator can't see from
	// curator.db: content rows bound to a tombstoned Artist/Album/Label/Genre
	// row (rekordbox renders those blank; the writer used to create them —
	// see writer.py's lookup-or-create header), and content rows whose
	// DjmdSongMyTag membership points at a tombstoned MyTag. The sidecar
	// reports which relations are dead per rb id; a linked track joins the
	// push only when the push can HEAL one of them:
	//   - a dead FK field whose Curator value (the exact value the metadata
	//     op sends — relationFieldValues) is non-empty and not conflict-
	//     shielded, with syncMetadata on: the writer's live lookup re-points
	//     the FK by name;
	//   - a dead MyTag whose name is in the track's rb-origin Curator tags,
	//     with syncTags on: apply_tags either revives the tag (Curator still
	//     holds the dead id) or replaces the dead membership with the live
	//     same-name tag.
	// Anything else would be re-sent forever without changing rekordbox:
	// omit-if-empty never pushes an empty field, so a dead album FK on a
	// track Curator has no album for stays dead (the 2026-10 "Remembering"
	// rows: same tracks re-added + a backup + a write on every run). Those
	// are skipped silently every run — that IS the convergence point. A dead
	// MyTag Curator lacks is skipped too: pushing the rest of the tag set
	// would delete the invisible membership, i.e. drop a tag the user may
	// still want revived. Best-effort: a probe failure logs and leaves the
	// dirty set as resolved.
	private async sweepStaleRelations(
		opts: RunExportOptions,
		linked: Array<{ curatorTrackId: string; rbContentId: string }>,
	): Promise<number> {
		const { syncMetadata, syncTags } = opts.flags;
		if (opts.targetKind !== 'updates' || !(syncMetadata || syncTags)) return 0;
		let stale: StaleRelation[];
		try {
			const res = await this.sidecar.listStaleRelations(opts.dbPath, opts.key);
			// A bundled sidecar older than 0.6.1 answers with the old id-only
			// shape — fail loudly into the warn path rather than mis-sweep.
			if (!Array.isArray(res?.stale)) throw new Error('list_stale_relations returned no `stale` array — rebuild the rekordbox sidecar');
			stale = res.stale;
		} catch (err) {
			xlog.warn('stale-relation probe failed — sweep skipped', undefined, err);
			return 0;
		}
		if (stale.length === 0) return 0;

		const byRbId = new Map(stale.map((s) => [s.rbContentId, s]));
		const rbIds = Array.from(byRbId.keys());
		const chunks: string[][] = [];
		for (let i = 0; i < rbIds.length; i += 500) chunks.push(rbIds.slice(i, i + 500));
		const rows = chunks.flatMap((ids) => this.db
			.select({
				trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId,
				artists: track.artists, albumTitle: track.albumTitle, label: track.label, genre: track.genre, overrides: track.overrides,
			})
			.from(rekordboxLink)
			.innerJoin(track, eq(track.id, rekordboxLink.trackId))
			.where(and(inArray(rekordboxLink.rbContentId, ids), isNull(track.deletedAt)))
			.all());

		const trackIds = rows.map((r) => r.trackId);
		// Same shield buildWriteOps applies: a conflicted field is dropped from
		// the op, so it can't heal anything this run.
		const shielded = new Map<string, Set<string>>();
		for (let i = 0; syncMetadata && i < trackIds.length; i += 500) {
			const conflicts = this.db
				.select({ trackId: syncConflict.trackId, fieldKey: syncConflict.fieldKey })
				.from(syncConflict)
				.where(and(eq(syncConflict.provider, 'rekordbox'), eq(syncConflict.kind, 'field'), inArray(syncConflict.trackId, trackIds.slice(i, i + 500))))
				.all();
			for (const c of conflicts) {
				const set = shielded.get(c.trackId) ?? new Set<string>();
				set.add(c.fieldKey);
				shielded.set(c.trackId, set);
			}
		}
		const rbTags = syncTags ? this.loadRbTagsByTrack(trackIds) : new Map<string, Array<{ rbTagId: string; name: string }>>();
		const fmt = this.creditFormat();
		const norm = (s: string): string => s.trim().toLowerCase();

		const seen = new Set(linked.map((l) => l.rbContentId));
		let healable = 0;
		let added = 0;
		for (const r of rows) {
			const s = byRbId.get(r.rbContentId);
			if (!s) continue;
			let heals = false;
			if (syncMetadata && s.fields.length > 0) {
				const values = relationFieldValues({ ...r, artists: r.artists ?? [] }, fmt);
				const shield = shielded.get(r.trackId);
				heals = s.fields.some((f) => nonEmpty(values[f]) && !shield?.has(f));
			}
			if (!heals && syncTags && s.myTags.length > 0) {
				// Case-insensitive, like the importer's dead-tag reconcile
				// (reconcileDeadMyTags merges into a live same-name tag).
				const have = new Set((rbTags.get(r.trackId) ?? []).map((t) => norm(t.name)));
				heals = s.myTags.some((name) => have.has(norm(name)));
			}
			if (!heals) continue;
			healable++;
			if (seen.has(r.rbContentId)) continue;
			linked.push({ curatorTrackId: r.trackId, rbContentId: r.rbContentId });
			seen.add(r.rbContentId);
			added++;
		}
		xlog.info('stale-relation sweep', { rbStale: stale.length, healable, added });
		return added;
	}

	private resolveTargets(opts: RunExportOptions): {
		linked: Array<{ curatorTrackId: string; rbContentId: string }>;
		skipped: number;
		// For 'playlist' / 'folder' targets: per-playlist ordered membership
		// (linked tracks only, deterministic by playlistTrack.position).
		// buildWriteOps emits one 'playlist' WriteOp per entry. Absent for
		// 'tracks' kind — there's no playlist row to push.
		playlistOrders?: PlaylistOrder[];
	} {
		if (opts.targetKind === 'tracks') {
			if (opts.targetIds.length === 0) return { linked: [], skipped: 0 };
			const links = this.db
				.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
				.from(rekordboxLink)
				.where(inArray(rekordboxLink.trackId, opts.targetIds))
				.all();
			const rbByTrackId = new Map(links.map((l) => [l.trackId, l.rbContentId]));
			const linked: Array<{ curatorTrackId: string; rbContentId: string }> = [];
			let skipped = 0;
			// Preserve the caller's order so the user's selection order maps to
			// progress events one-by-one. inArray() returns in DB order, not
			// input order — explicit map-from-input-ids fixes that.
			for (const id of opts.targetIds) {
				const rbId = rbByTrackId.get(id);
				if (rbId) linked.push({ curatorTrackId: id, rbContentId: rbId });
				else skipped++;
			}
			return { linked, skipped };
		}

		// Folder target — recursively resolve to all non-smart non-hidden rb
		// playlists under the root, then delegate to the same per-playlist
		// member resolution used by the single-playlist branch. Unlike
		// 'playlist' kind, `targets.linked` here is the UNION of every
		// descendant's linked tracks — used by the metadata/cues/tags passes,
		// which apply per-track. Per-playlist ordering is preserved in
		// `playlistOrders` so each descendant gets its own playlist WriteOp.
		if (opts.targetKind === 'folder') {
			const rootFolderId = opts.targetIds[0];
			if (!rootFolderId) return { linked: [], skipped: 0, playlistOrders: [] };
			const playlistIds = this.resolveFolderDescendantPlaylists(rootFolderId);
			return this.resolvePlaylistMembers(playlistIds);
		}

		// Updates target — incremental sweep. Two independent resolves:
		//   1. `linked` = rb-linked tracks Curator changed since their last
		//      verified push: pushedAt IS NULL OR track.updatedAt >= pushedAt.
		//      Both sides of the comparison are Curator's own clock, and
		//      pushedAt is the START of the push that last carried the track
		//      (runExport), so:
		//        - a push converges — re-running with nothing edited selects
		//          nothing, whether or not the push changed rekordbox;
		//        - an edit made while a push is in flight post-dates its stamp
		//          and is picked up next time (`>=`: an edit in the stamp's
		//          own millisecond re-sends once rather than being lost).
		//      This used to be updatedAt > rbUpdatedAtSeen. `seen` is
		//      rekordbox's post-commit updated_at, which rekordbox does not
		//      bump when the writer's diff no-ops — so every track pushed
		//      without a real rb change stayed "newer than seen" and went out
		//      again on every run (~1k tracks/run since Sept, 4.4k after the
		//      2026-10-17 scanner re-stamp). `seen` is also deliberately NOT
		//      folded in as MAX(seen, pushedAt): it can land after an
		//      in-flight edit (masking it), and a pull advances it past a
		//      not-yet-pushed Curator edit whose field rb didn't touch — the
		//      three-way merge keeps that value for the push to send. `seen`
		//      stays exactly what the pull's LMW gate needs (decideRbWins).
		//      NULL pushedAt (never written to rb) covers the Curator-first
		//      track — curated, THEN its file imported into rekordbox.
		//   2. `playlistOrders` = every non-smart non-hidden rb playlist
		//      with its full ordered membership; buildWriteOps emits an op
		//      only for those with an add/remove/order/name change. The cost
		//      is one MEMBER SELECT batched across playlist ids in
		//      resolvePlaylistMembers.
		// `linked` does NOT include all playlist members — the metadata/
		// cues/tags passes operate only on tracks the user actually
		// touched (cue and tag edits bump track.updatedAt too, so they ride
		// the same selection), while the playlist pass iterates
		// playlistOrders directly.
		if (opts.targetKind === 'updates') {
			const changedRows = this.db
				.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
				.from(rekordboxLink)
				.innerJoin(track, eq(track.id, rekordboxLink.trackId))
				.where(or(
					isNull(rekordboxLink.pushedAt),
					gte(track.updatedAt, rekordboxLink.pushedAt),
				))
				.all();
			const linked = changedRows.map((r) => ({ curatorTrackId: r.trackId, rbContentId: r.rbContentId }));

			// Self-heal: also sweep in linked tracks whose comment block no
			// longer lists their rb tags. Tag edits made before the mirror
			// existed (and any rename, which never touches track.updatedAt)
			// left ~1.5k stale blocks; one pass rewrites them, after which
			// this matches nothing. Only when tags are in scope — without
			// syncTags the metadata pass pushes the comment verbatim.
			if (opts.flags.syncTags && opts.flags.syncMetadata) {
				const seen = new Set(linked.map((l) => l.curatorTrackId));
				const all = this.db
					.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId, comment: track.comment })
					.from(rekordboxLink)
					.innerJoin(track, eq(track.id, rekordboxLink.trackId))
					.where(isNull(track.deletedAt))
					.all();
				const tags = this.loadRbTagsByTrack(all.map((r) => r.trackId));
				for (const r of all) {
					if (seen.has(r.trackId)) continue;
					const names = (tags.get(r.trackId) ?? []).map((t) => t.name);
					if (names.length > 0 && !tagCommentMatches(r.comment, names)) {
						linked.push({ curatorTrackId: r.trackId, rbContentId: r.rbContentId });
						seen.add(r.trackId);
					}
				}
			}

			// Self-heal #2: the credit format (Settings → User Interface) changes
			// the pushed Title/Artist strings without touching track.updatedAt,
			// so the timestamp rule above never notices. Sweep in every linked
			// track whose formatted Title or Artist differs from the baseline
			// rekordbox last saw (fieldsSeen). One pass over the linked rows;
			// after one push the baselines match and this matches nothing.
			if (opts.flags.syncMetadata) {
				const seen = new Set(linked.map((l) => l.curatorTrackId));
				const fmt = this.creditFormat();
				const rows = this.db
					.select({
						trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId, fieldsSeen: rekordboxLink.fieldsSeen,
						title: track.title, artists: track.artists, overrides: track.overrides,
					})
					.from(rekordboxLink)
					.innerJoin(track, eq(track.id, rekordboxLink.trackId))
					.where(isNull(track.deletedAt))
					.all();
				for (const r of rows) {
					if (seen.has(r.trackId) || !r.fieldsSeen) continue;
					const view = { title: r.title, artists: r.artists ?? [], overrides: r.overrides };
					const title = effectiveTitle(view, fmt);
					const artist = effectiveArtistName(view, fmt);
					const seenTitle = r.fieldsSeen.title;
					const seenArtist = r.fieldsSeen.artist;
					if ((seenTitle != null && seenTitle !== '' && title !== String(seenTitle))
						|| (seenArtist != null && seenArtist !== '' && artist != null && artist !== String(seenArtist))) {
						linked.push({ curatorTrackId: r.trackId, rbContentId: r.rbContentId });
						seen.add(r.trackId);
					}
				}
			}

			const playlistRows = this.db
				.select({ id: playlistTable.id })
				.from(playlistTable)
				.where(and(
					eq(playlistTable.source, 'rekordbox'),
					eq(playlistTable.isSmart, false),
					eq(playlistTable.isHidden, false),
				))
				.orderBy(playlistTable.position, playlistTable.name)
				.all();
			const { playlistOrders } = this.resolvePlaylistMembers(playlistRows.map((p) => p.id));
			return { linked, skipped: 0, playlistOrders };
		}

		// Playlist target — exactly one playlist id in targetIds[0]. Every
		// member that has a rekordboxLink. Order is preserved by the
		// playlistTrack.position column; the read side seeded it from rb's
		// TrackNo so round-trip is stable.
		const playlistId = opts.targetIds[0];
		if (!playlistId) return { linked: [], skipped: 0, playlistOrders: [] };
		return this.resolvePlaylistMembers([playlistId]);
	}

	// BFS over `playlist_folder` to walk the rb-folder hierarchy under
	// `rootFolderId`, then return every non-smart non-hidden rb playlist
	// whose `parentFolderId` is in the visited set. Ordering: folders are
	// walked breadth-first by position-then-name; playlists within each
	// folder come back in (position, name) order — the same sort the
	// sidebar uses. This matches what the user sees when they expand the
	// folder, so the progress strip's per-playlist sequence is intuitive.
	private resolveFolderDescendantPlaylists(rootFolderId: string): string[] {
		const visited = new Set<string>([rootFolderId]);
		const frontier: string[] = [rootFolderId];
		while (frontier.length > 0) {
			const layer = frontier.splice(0, frontier.length);
			const children = this.db
				.select({ id: playlistFolderTable.id })
				.from(playlistFolderTable)
				.where(and(
					eq(playlistFolderTable.source, 'rekordbox'),
					inArray(playlistFolderTable.parentFolderId, layer),
				))
				.orderBy(playlistFolderTable.position, playlistFolderTable.name)
				.all();
			for (const c of children) {
				if (visited.has(c.id)) continue;
				visited.add(c.id);
				frontier.push(c.id);
			}
		}

		const playlists = this.db
			.select({ id: playlistTable.id })
			.from(playlistTable)
			.where(and(
				eq(playlistTable.source, 'rekordbox'),
				eq(playlistTable.isSmart, false),
				eq(playlistTable.isHidden, false),
				inArray(playlistTable.parentFolderId, Array.from(visited)),
			))
			.orderBy(playlistTable.position, playlistTable.name)
			.all();
		return playlists.map((p) => p.id);
	}

	// Shared between 'playlist' and 'folder' targets. Resolves each
	// playlist's ordered membership, then unions the linked pairs across
	// playlists for the per-track metadata/cues/tags passes. A track that
	// appears in multiple folder-descendant playlists is included once in
	// `linked` (writer ops are keyed on rb_content_id) but appears in each
	// playlist's `members` so per-playlist position stays correct.
	private resolvePlaylistMembers(playlistIds: string[]): {
		linked: Array<{ curatorTrackId: string; rbContentId: string }>;
		skipped: number;
		playlistOrders: PlaylistOrder[];
	} {
		if (playlistIds.length === 0) return { linked: [], skipped: 0, playlistOrders: [] };

		const allMembers = this.db
			.select({ playlistId: playlistTrack.playlistId, trackId: playlistTrack.trackId, position: playlistTrack.position })
			.from(playlistTrack)
			.where(inArray(playlistTrack.playlistId, playlistIds))
			.orderBy(playlistTrack.playlistId, playlistTrack.position)
			.all();

		const trackIds = Array.from(new Set(allMembers.map((m) => m.trackId)));
		const links = trackIds.length === 0 ? [] : this.db
			.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
			.from(rekordboxLink)
			.where(inArray(rekordboxLink.trackId, trackIds))
			.all();
		const rbByTrackId = new Map(links.map((l) => [l.trackId, l.rbContentId]));

		const membersByPlaylist = new Map<string, Array<{ curatorTrackId: string; rbContentId: string }>>();
		const linkedUnique = new Map<string, { curatorTrackId: string; rbContentId: string }>();
		const skippedTrackIds = new Set<string>();
		// Per-playlist members with no rekordbox_link — feeds the
		// unlinked-members removal/order hold in buildWriteOps (which also
		// resolves these ids to names for the held-changes dialog).
		const unlinkedByPlaylist = new Map<string, string[]>();
		for (const m of allMembers) {
			const rbId = rbByTrackId.get(m.trackId);
			if (!rbId) {
				skippedTrackIds.add(m.trackId);
				let unlinked = unlinkedByPlaylist.get(m.playlistId);
				if (!unlinked) { unlinked = []; unlinkedByPlaylist.set(m.playlistId, unlinked); }
				unlinked.push(m.trackId);
				continue;
			}
			const pair = { curatorTrackId: m.trackId, rbContentId: rbId };
			let list = membersByPlaylist.get(m.playlistId);
			if (!list) { list = []; membersByPlaylist.set(m.playlistId, list); }
			list.push(pair);
			if (!linkedUnique.has(m.trackId)) linkedUnique.set(m.trackId, pair);
		}

		// Preserve caller-supplied playlist order in the output so progress
		// events fire deterministically and match the sidebar's visual order.
		const playlistOrders = playlistIds.map((pid) => ({
			playlistId: pid,
			members: membersByPlaylist.get(pid) ?? [],
			unlinkedTrackIds: unlinkedByPlaylist.get(pid) ?? [],
		}));
		return { linked: Array.from(linkedUnique.values()), skipped: skippedTrackIds.size, playlistOrders };
	}

	// ──────────────────────────────────────────────────────────────────
	// Membership baseline (B) — the last-agreed rb member set/order per
	// playlist. The Curator→rb push is a diff against this; advanceMembership
	// Baselines rewrites it to the pushed state after a verified sync.

	// Ordered list of rb_content_ids the baseline last agreed on for this
	// playlist (kind='rb' only — curator-only members have no rb identity to
	// remove/add, so they don't participate in the rb-side diff).
	private loadMembershipBaseline(rbPlaylistId: string): string[] {
		return this.db
			.select({ memberId: rekordboxMembershipBaseline.memberId, position: rekordboxMembershipBaseline.position })
			.from(rekordboxMembershipBaseline)
			.where(and(
				eq(rekordboxMembershipBaseline.rbPlaylistId, rbPlaylistId),
				eq(rekordboxMembershipBaseline.memberKind, 'rb'),
			))
			.orderBy(rekordboxMembershipBaseline.position)
			.all()
			.map((r) => r.memberId);
	}

	private hasOpenOrderConflict(rbPlaylistId: string): boolean {
		return !!this.db
			.select({ id: playlistConflict.id })
			.from(playlistConflict)
			.where(and(
				eq(playlistConflict.provider, 'rekordbox'),
				eq(playlistConflict.rbPlaylistId, rbPlaylistId),
				eq(playlistConflict.kind, 'order'),
			))
			.get();
	}

	// Rewrite the membership baseline for each pushed (non-missing) playlist to
	// its current Curator membership — the new agreed ancestor. Mirrors the
	// field/cue baseline advance: only runs on a verified push so a failed
	// sync doesn't desync B from rb. Stores rb-linked members as kind='rb'
	// (their content id) and Curator-only members as kind='curator' (track id)
	// so the import-side 3-way sees a faithful ancestor.
	private advanceMembershipBaselines(
		playlistOrders: PlaylistOrder[],
		missingPlaylistRbIds: Set<string>,
	): void {
		for (const order of playlistOrders) {
			const pl = this.db
				.select({ id: playlistTable.id, source: playlistTable.source, sourceId: playlistTable.sourceId })
				.from(playlistTable)
				.where(eq(playlistTable.id, order.playlistId))
				.get();
			if (!pl || pl.source !== 'rekordbox') continue;
			const rbPlaylistId = pl.id.startsWith('rb_') ? pl.id.slice(3) : pl.sourceId;
			if (missingPlaylistRbIds.has(rbPlaylistId)) continue;

			// Full current membership (rb-linked AND curator-only), ordered.
			const members = this.db
				.select({ trackId: playlistTrack.trackId, position: playlistTrack.position })
				.from(playlistTrack)
				.where(eq(playlistTrack.playlistId, order.playlistId))
				.orderBy(playlistTrack.position)
				.all();
			const trackIds = members.map((m) => m.trackId);
			const links = trackIds.length === 0 ? [] : this.db
				.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
				.from(rekordboxLink)
				.where(inArray(rekordboxLink.trackId, trackIds))
				.all();
			const rbByTrack = new Map(links.map((l) => [l.trackId, l.rbContentId]));

			this.db.delete(rekordboxMembershipBaseline)
				.where(eq(rekordboxMembershipBaseline.rbPlaylistId, rbPlaylistId))
				.run();
			let pos = 0;
			for (const m of members) {
				const rbId = rbByTrack.get(m.trackId);
				this.db.insert(rekordboxMembershipBaseline)
					.values({
						rbPlaylistId,
						memberKind: rbId ? 'rb' : 'curator',
						memberId: rbId ?? m.trackId,
						position: pos++,
						updatedAt: new Date(),
					})
					.onConflictDoNothing()
					.run();
			}
		}
	}

	// ──────────────────────────────────────────────────────────────────
	// Op construction — produces the wire payload from Curator state.

	// rb-identity tags per track (`rb_<DjmdMyTag.ID>` ids, minted by the
	// importer — importer.ts applyMyTagDelta), in track_tag.added_at order so
	// the comment block's token order follows rekordbox's own append order.
	// Curator-only tags have no rb-side identity and are excluded here —
	// they are neither pushed as DjmdSongMyTag rows nor written into the
	// comment block (rekordbox would drop them the next time it regenerates
	// the block from its MyTag set, and the pull/push merge would ping-pong).
	private loadRbTagsByTrack(trackIds: string[]): Map<string, Array<{ rbTagId: string; name: string }>> {
		const out = new Map<string, Array<{ rbTagId: string; name: string }>>();
		for (let i = 0; i < trackIds.length; i += 500) {
			const rows = this.db
				.select({ trackId: trackTag.trackId, tagId: trackTag.tagId, name: tagTable.name, addedAt: trackTag.addedAt })
				.from(trackTag)
				.innerJoin(tagTable, eq(tagTable.id, trackTag.tagId))
				.where(inArray(trackTag.trackId, trackIds.slice(i, i + 500)))
				.orderBy(trackTag.addedAt)
				.all();
			for (const r of rows) {
				if (!r.tagId.startsWith('rb_')) continue;
				const list = out.get(r.trackId) ?? [];
				list.push({ rbTagId: r.tagId.slice(3), name: r.name });
				out.set(r.trackId, list);
			}
		}
		return out;
	}

	private buildWriteOps(
		opts: RunExportOptions,
		linked: Array<{ curatorTrackId: string; rbContentId: string }>,
		playlistOrders: PlaylistOrder[],
	): { ops: WriteOp[]; holds: RemovalHold[] } {
		const ops: WriteOp[] = [];
		const holds: RemovalHold[] = [];

		// Conflict shield: a field (or a track's cue set) with an open
		// both-sides-changed conflict must NOT be pushed — the user hasn't
		// decided yet, and pushing Curator's value would be exactly the
		// silent override this pipeline exists to prevent. Field conflicts
		// drop just that key from the op (missing key = "no opinion" in
		// writer.py); any cue conflict drops the whole cues op for the
		// track (the writer's wipe-and-re-add is all-or-nothing).
		const trackIdList = linked.map((p) => p.curatorTrackId);
		const conflictRows = trackIdList.length === 0 ? [] : this.db
			.select({ trackId: syncConflict.trackId, kind: syncConflict.kind, fieldKey: syncConflict.fieldKey })
			.from(syncConflict)
			.where(and(eq(syncConflict.provider, 'rekordbox'), inArray(syncConflict.trackId, trackIdList)))
			.all();
		const conflictedFields = new Map<string, Set<string>>();
		const cueConflictedTracks = new Set<string>();
		for (const c of conflictRows) {
			if (c.kind === 'cue') { cueConflictedTracks.add(c.trackId); continue; }
			const set = conflictedFields.get(c.trackId) ?? new Set<string>();
			set.add(c.fieldKey);
			conflictedFields.set(c.trackId, set);
		}

		// Shared by the metadata pass (comment block) and the tags pass.
		const rbTagsByTrack = (opts.flags.syncMetadata || opts.flags.syncTags) && linked.length > 0
			? this.loadRbTagsByTrack(linked.map((p) => p.curatorTrackId))
			: new Map<string, Array<{ rbTagId: string; name: string }>>();

		// Track metadata pass — per linked track.
		if (opts.flags.syncMetadata) {
			const trackRows = linked.length === 0 ? [] : this.db
				.select({
					id: track.id,
					title: track.title,
					artists: track.artists,
					albumTitle: track.albumTitle,
					label: track.label,
					genre: track.genre,
					rating: track.rating,
					comment: track.comment,
					colorLabel: track.colorLabel,
					overrides: track.overrides,
				})
				.from(track)
				.where(inArray(track.id, linked.map((p) => p.curatorTrackId)))
				.all();
			const trackById = new Map(trackRows.map((t) => [t.id, t]));
			for (const pair of linked) {
				const t = trackById.get(pair.curatorTrackId);
				if (!t) continue;
				const shield = conflictedFields.get(pair.curatorTrackId);
				// Omit-if-empty for EVERY metadata field. writer.py treats an
				// explicit null/'' as "clear this field on the rb side", and
				// ALL of these fields trickle in FROM rb — Curator has no
				// authoritative "the user deliberately blanked this" signal, so
				// an empty effective value means "we never had one" far more
				// often than "erase rb's". Pushing the empty value is exactly
				// how a sparse Curator row (streaming-first library, un-pulled
				// metadata) silently wipes rb's Title/Artist/Album/Label/Genre.
				// Previously only Comment/Color/Rating were guarded this way;
				// the five text fields trusted the merge alone and cleared rb
				// whenever Curator's side was blank. Rating 0 is rb's "unrated"
				// sentinel (reader.py imports unrated tracks as 0, not null), so
				// treat 0 as empty too — never let an unrated Curator row
				// de-rate a track that's rated in rekordbox.
				const fmt = this.creditFormat();
				const eTitle = effectiveTitle(t, fmt);
				const { artist: eArtist, album: eAlbum, label: eLabel, genre: eGenre } = relationFieldValues(t, fmt);
				// Comment: when tags are in scope, rebuild the trailing
				// `/* tag / tag */` block from the rb tag set so rekordbox's
				// text search agrees with its MyTag filter (tag-comment.ts).
				// With no rb tags the comment goes verbatim — same "not
				// managed here" rule as the tags-op skip below. The pushed
				// string is written back to track.comment in advanceBaselines.
				const eComment = opts.flags.syncTags
					? buildTagComment(t.comment, (rbTagsByTrack.get(t.id) ?? []).map((x) => x.name))
					: t.comment;
				const fields: Extract<WriteOp, { kind: 'track' }>['fields'] = {
					...(nonEmpty(eTitle) ? { Title: eTitle } : {}),
					...(nonEmpty(eArtist) ? { ArtistName: eArtist } : {}),
					...(nonEmpty(eAlbum) ? { AlbumName: eAlbum } : {}),
					...(nonEmpty(eLabel) ? { LabelName: eLabel } : {}),
					...(nonEmpty(eGenre) ? { GenreName: eGenre } : {}),
					...(eComment != null ? { Comment: eComment } : {}),
					...(t.colorLabel != null ? { Color: t.colorLabel } : {}),
					...(t.rating != null && t.rating > 0 ? { Rating: t.rating } : {}),
				};
				if (shield) {
					// fieldKey (SyncFieldKey) → wire key mapping.
					if (shield.has('title')) delete fields.Title;
					if (shield.has('artist')) delete fields.ArtistName;
					if (shield.has('album')) delete fields.AlbumName;
					if (shield.has('label')) delete fields.LabelName;
					if (shield.has('genre')) delete fields.GenreName;
					if (shield.has('rating')) delete fields.Rating;
					if (shield.has('comment')) delete fields.Comment;
					if (shield.has('colorLabel')) delete fields.Color;
				}
				ops.push({ kind: 'track', rb_content_id: pair.rbContentId, fields });
			}
		}

		// Cues pass — per linked track. Wipe-and-re-add semantics on the
		// writer side: a non-empty `cues` array replaces rb's set with
		// Curator's.
		//
		// Empty-set policy: pushing an empty `cues` array clears rb's
		// cues for that track. We only do that when the track has
		// `cuesEditedAt` set — i.e. the user has authoritatively edited
		// cues for this track in Curator at least once. Without that
		// stamp, "0 cues in Curator" still means "we just never loaded
		// them" (rb cues are imported on demand via the cues flag), and
		// pushing the empty set would blow them away on first sync. The
		// stamp is set by upsertCue/updateCue/deleteCue in service.ts.
		if (opts.flags.syncCues) {
			const trackIds = linked.map((p) => p.curatorTrackId);
			const cueRows = trackIds.length === 0 ? [] : this.db
				.select()
				.from(cueTable)
				.where(inArray(cueTable.trackId, trackIds))
				.all();
			const cuesByTrack = new Map<string, typeof cueRows>();
			for (const c of cueRows) {
				const list = cuesByTrack.get(c.trackId) ?? [];
				list.push(c);
				cuesByTrack.set(c.trackId, list);
			}
			// One query for the editor stamp — cheaper than a per-track
			// SELECT inside the loop and the result set is bounded by `linked`.
			const editedRows = trackIds.length === 0 ? [] : this.db
				.select({ id: track.id, cuesEditedAt: track.cuesEditedAt })
				.from(track)
				.where(inArray(track.id, trackIds))
				.all();
			const editedById = new Map(editedRows.map((r) => [r.id, r.cuesEditedAt]));
			for (const pair of linked) {
				// Any open cue conflict blocks the track's whole cues op —
				// wipe-and-re-add can't partially apply.
				if (cueConflictedTracks.has(pair.curatorTrackId)) continue;
				const list = cuesByTrack.get(pair.curatorTrackId) ?? [];
				const userEdited = editedById.get(pair.curatorTrackId) != null;
				// Skip when Curator has nothing AND the user hasn't claimed
				// authority over this track's cues — protects rb-side cues
				// the user has simply never touched in Curator.
				if (list.length === 0 && !userEdited) continue;
				ops.push({
					kind: 'cues',
					rb_content_id: pair.rbContentId,
					cues: list.map((c) => ({
						slot: c.slot,
						kind: c.kind as 'hot' | 'memory',
						position_sec: c.positionSec,
						length_sec: c.lengthSec,
						color: c.color,
						name: c.name,
					})),
				});
			}
		}

		// Tags pass — per linked track. Only tags with rb identity (see
		// loadRbTagsByTrack); Curator-only tags are out of v1 scope.
		if (opts.flags.syncTags) {
			for (const pair of linked) {
				const rbTagIds = (rbTagsByTrack.get(pair.curatorTrackId) ?? []).map((x) => x.rbTagId);
				// Skip empty tag pushes. apply_tags wipes-and-re-adds, so an
				// empty list deletes EVERY DjmdSongMyTag row for the track. An
				// empty Curator set is almost always "we have no rb-origin tags
				// loaded for this track" (the push only counts `rb_`-prefixed
				// tags), not "the user cleared them" — and there's no
				// tags-edited stamp to tell the two apart the way cues lean on
				// `cuesEditedAt`. Skipping protects rb-side tags Curator never
				// managed; a genuine partial removal still pushes the non-empty
				// remainder, so single-tag deletes continue to sync.
				if (rbTagIds.length === 0) continue;
				ops.push({ kind: 'tags', rb_content_id: pair.rbContentId, rb_tag_ids: rbTagIds });
			}
		}

		// Playlist pass — fires for both 'playlist' (one op) and 'folder'
		// (one op per descendant playlist) when the flag is on. The
		// playlistOrders list is already in render order and contains only
		// non-smart non-hidden rb playlists for the folder case; the
		// 'playlist' case populates it with a single entry.
		if ((opts.targetKind === 'playlist' || opts.targetKind === 'folder' || opts.targetKind === 'updates') && opts.flags.syncPlaylist && playlistOrders.length > 0) {
			const playlistIds = playlistOrders.map((p) => p.playlistId);
			const playlistRows = this.db
				.select({ id: playlistTable.id, name: playlistTable.name, rbNameSeen: playlistTable.rbNameSeen, source: playlistTable.source, sourceId: playlistTable.sourceId })
				.from(playlistTable)
				.where(inArray(playlistTable.id, playlistIds))
				.all();
			const rowById = new Map(playlistRows.map((r) => [r.id, r]));
			for (const order of playlistOrders) {
				const pl = rowById.get(order.playlistId);
				if (!pl || pl.source !== 'rekordbox') continue;
				// rb playlist IDs come from importer.ts as `rb_${rb_playlist_id}`.
				// Strip the prefix to get the raw rb side ID.
				const rbPlaylistId = pl.id.startsWith('rb_') ? pl.id.slice(3) : pl.sourceId;

				// Targeted Curator→rb diff: baseline B (last agreed rb-member
				// set) vs current Curator membership C. Removes = members B had
				// that C dropped (Curator deleted them); adds = members C has
				// that B lacked (Curator added them). Members rb has but B never
				// recorded are NOT in either set, so they're never touched —
				// that's the fix for the wholesale-wipe data loss.
				const baseOrder = this.loadMembershipBaseline(rbPlaylistId);
				const baseSet = new Set(baseOrder);
				const curOrder = order.members.map((m) => m.rbContentId);
				const curSet = new Set(curOrder);

				const removeAll = baseOrder.filter((id) => !curSet.has(id));
				const add = order.members
					.map((m, i) => ({ rbContentId: m.rbContentId, pos: i + 1 }))
					.filter((m) => !baseSet.has(m.rbContentId))
					.map((m) => ({ rb_content_id: m.rbContentId, position: m.pos }));

				// Removal guards — the 2026-06/07 phantom-delete class. Both
				// hold the removes (adds/rename still flow) and suppress the
				// order push; runExport also skips this playlist's baseline
				// advance so the situation re-detects on every push until it
				// resolves (link repaired / user confirms).
				//   1. unlinked ≠ removed: a member whose curator track lost
				//      its rekordbox_link disappears from curOrder, making it
				//      indistinguishable from a user deletion. Never trust a
				//      remove computed while any member is invisible.
				//   2. mass-removal breaker: dropping more than max(3, 10%)
				//      of the baseline in one push is likelier corruption
				//      upstream than deliberate curation — held until the user
				//      confirms it via allowMassRemovalFor (the "Push anyway"
				//      re-run). unlinked-members is NOT waivable this way.
				const massThreshold = Math.max(3, Math.ceil(baseOrder.length * 0.1));
				const massRemovalConfirmed = opts.flags.allowMassRemovalFor?.includes(rbPlaylistId) ?? false;
				let holdReason: RemovalHold['reason'] | null = null;
				if (removeAll.length > 0 && order.unlinkedTrackIds.length > 0) holdReason = 'unlinked-members';
				else if (removeAll.length > massThreshold && !massRemovalConfirmed) holdReason = 'mass-removal';
				const remove = holdReason ? [] : removeAll;

				// Order: push curOrder ONLY when Curator reordered or mid-inserted
				// (curOrder != noReorderProjection), or hold (order=null) on an open
				// order conflict — leaving rb's order so we never clobber a rb-side
				// reorder the incremental pull hasn't reconciled. The no-reorder
				// projection is what the writer yields for order=null: baseline
				// order minus Curator removes, then Curator adds at the tail.
				//
				// Also held while ANY member is unlinked: the writer appends
				// cids missing from `order` at the tail, so pushing an order
				// that can't name the unlinked members would tail-drift them —
				// the same damage the removal hold exists to prevent.
				const noReorderProjection = [...baseOrder.filter((id) => curSet.has(id)), ...curOrder.filter((id) => !baseSet.has(id))];
				const curatorReordered = !eqArr(curOrder, noReorderProjection);
				const orderHeld = this.hasOpenOrderConflict(rbPlaylistId) || holdReason !== null || order.unlinkedTrackIds.length > 0;
				if (holdReason !== null || (curatorReordered && order.unlinkedTrackIds.length > 0)) {
					holds.push({
						rbPlaylistId,
						playlistId: order.playlistId,
						playlistName: pl.name,
						heldRemovals: removeAll.length,
						reason: holdReason ?? 'unlinked-members',
						unlinkedTracks: this.unlinkedDisplay(order.unlinkedTrackIds),
					});
				}
				const pushOrder = (orderHeld || !curatorReordered) ? null : curOrder;
				// Nothing to send → no op. An op with no adds/removes/order and
				// the name rekordbox already holds is a writer no-op that still
				// costs a verify read-back; "Sync updates" sent ~110 of them per
				// run. Renames are detected against rbNameSeen (rekordbox's last
				// reported/verified name; NULL = unknown → sent). What a skipped
				// op gives up: the writer's dedupe + TrackNo compaction no longer
				// visit untouched playlists — holes only come from Curator
				// removals, which always emit an op, and every playlist was
				// already compacted by the per-run ops sent since 2026-09-15.
				// Holds are still reported (holds.push above) — only the empty
				// write is dropped.
				const renamed = pl.rbNameSeen !== pl.name;
				if (remove.length === 0 && add.length === 0 && pushOrder === null && !renamed) continue;
				ops.push({
					kind: 'playlist_merge',
					rb_playlist_id: rbPlaylistId,
					name: pl.name,
					remove,
					add,
					order: pushOrder,
				});
			}
		}

		return { ops, holds };
	}

	// Resolve unlinked member ids to the display shape RemovalHold carries —
	// the held-changes dialog names the tracks and tells the user how the
	// hold clears. hasFile = any source_link row with a file on disk:
	// false means a streaming-only add that was never downloaded (rb can't
	// have it yet), true means the file exists but rb hasn't linked it.
	// Holds are rare and their member lists small, so per-hold queries are
	// fine.
	private unlinkedDisplay(trackIds: string[]): RemovalHold['unlinkedTracks'] {
		if (trackIds.length === 0) return [];
		const rows = this.db
			.select({ id: track.id, title: track.title, artists: track.artists, overrides: track.overrides })
			.from(track)
			.where(inArray(track.id, trackIds))
			.all();
		const withFile = new Set(
			this.db
				.select({ trackId: sourceLink.trackId })
				.from(sourceLink)
				.where(and(inArray(sourceLink.trackId, trackIds), isNotNull(sourceLink.filePath)))
				.all()
				.map((r) => r.trackId),
		);
		const byId = new Map(rows.map((r) => [r.id, r]));
		return trackIds.map((id) => {
			const t = byId.get(id);
			return {
				trackId: id,
				title: t ? effectiveTitle(t, this.creditFormat()) : id,
				artist: t ? effectiveArtistName(t, this.creditFormat()) : null,
				hasFile: withFile.has(id),
			};
		});
	}

	// ──────────────────────────────────────────────────────────────────
	// Post-commit baseline advance + result tally.

	private advanceBaselines(
		linked: Array<{ curatorTrackId: string; rbContentId: string }>,
		baselines: Record<string, number | null>,
		writtenOps: WriteOp[],
		// rb ids whose ops FAILED (savepoint rolled back). Their link rows
		// keep every old baseline, pushedAt included — advancing it would
		// drop the track out of the next "Sync updates" selection and
		// silently never retry the failed write.
		failedRbIds?: ReadonlySet<string>,
		// pushedAt stamp: the run's START time, applied only to the tracks
		// this push fully carried (pushStampTrackIds). Null = leave pushedAt
		// alone.
		pushStamp: { at: Date; trackIds: ReadonlySet<string> } | null = null,
	): void {
		const now = new Date();

		// What we just verified onto the rb side IS rb's new state — fold it
		// into the value snapshots so the next pull's three-way merge sees
		// these fields as unchanged-on-both-sides instead of re-detecting
		// our own push as an rb edit. Only keys actually present in the op
		// advance (a shielded/omitted key keeps its old baseline).
		const pushedFields = new Map<string, FieldsSeen>();
		const pushedCues = new Map<string, CueUnit[]>();
		for (const op of writtenOps) {
			if (op.kind === 'track') {
				const f: FieldsSeen = {};
				if ('Title' in op.fields) f.title = op.fields.Title ?? null;
				if ('ArtistName' in op.fields) f.artist = op.fields.ArtistName ?? null;
				if ('AlbumName' in op.fields) f.album = op.fields.AlbumName ?? null;
				if ('GenreName' in op.fields) f.genre = op.fields.GenreName ?? null;
				if ('LabelName' in op.fields) f.label = op.fields.LabelName ?? null;
				if ('Rating' in op.fields) f.rating = op.fields.Rating ?? null;
				if ('Comment' in op.fields) f.comment = op.fields.Comment ?? null;
				if ('Color' in op.fields) f.colorLabel = op.fields.Color ?? null;
				pushedFields.set(op.rb_content_id, f);
			} else if (op.kind === 'cues') {
				pushedCues.set(op.rb_content_id, op.cues.map((c) => ({
					kind: c.kind,
					slot: c.slot,
					positionSec: c.position_sec,
					lengthSec: c.length_sec ?? null,
					color: c.color ?? null,
					name: c.name ?? null,
				})));
			}
		}

		for (const pair of linked) {
			if (failedRbIds?.has(pair.rbContentId)) continue;
			const ts = baselines[pair.rbContentId];
			if (ts == null) continue;
			// Bump rb_updated_at_seen to the post-commit timestamp + bump
			// last_synced_at so the link row reflects the fresh sync. The
			// LMW gate in importer.ts:decideRbWins reads
			// rbUpdatedAtSeen — if we DON'T advance it, the next read
			// pass sees rb.updated_at > seen and overwrites Curator's
			// edits with the values we JUST pushed up. Load-bearing.
			const set: Record<string, unknown> = {
				rbUpdatedAtSeen: new Date(ts),
				lastSyncedAt: now,
			};
			// Verified write → Curator's state as of the run's start is in
			// rekordbox; drops the track out of "Sync updates" until the next
			// edit (updatedAt >= pushedAt). Start time, not `now`: an edit
			// that landed mid-push must stay newer than the stamp.
			if (pushStamp?.trackIds.has(pair.curatorTrackId)) set['pushedAt'] = pushStamp.at;
			const fields = pushedFields.get(pair.rbContentId);
			if (fields && Object.keys(fields).length > 0) {
				const existing = this.db
					.select({ fieldsSeen: rekordboxLink.fieldsSeen, comment: track.comment })
					.from(rekordboxLink)
					.innerJoin(track, eq(track.id, rekordboxLink.trackId))
					.where(eq(rekordboxLink.trackId, pair.curatorTrackId))
					.get();
				set['fieldsSeen'] = { ...(existing?.fieldsSeen ?? {}), ...fields };
				// The pushed Comment may have been derived (tag block rebuilt
				// from the rb tag set). What rekordbox now holds is the truth
				// for Curator too — mirror it back so comment, baseline and rb
				// agree. No updatedAt bump: this is a mirror, not a user edit,
				// and bumping would re-dirty the track for the next sweep.
				if ('comment' in fields && existing) {
					const pushed = fields.comment == null ? null : String(fields.comment);
					if (pushed !== existing.comment) {
						this.db.update(track).set({ comment: pushed }).where(eq(track.id, pair.curatorTrackId)).run();
					}
				}
			}
			const cues = pushedCues.get(pair.rbContentId);
			if (cues) set['cuesSeen'] = cues;
			this.db.update(rekordboxLink)
				.set(set)
				.where(eq(rekordboxLink.trackId, pair.curatorTrackId))
				.run();
		}
	}

	// Which linked tracks a verified push may stamp pushedAt on. The stamp
	// says "everything Curator had for this track is in rekordbox", so a run
	// that left a track-level scope unchecked must not stamp a track whose
	// change could live in that scope — or "Sync updates" would drop the edit
	// for good. Metadata and tags share track.updatedAt with no finer signal,
	// so both must be in scope. Cues carry their own stamp (cuesEditedAt):
	// with cues unchecked, a track still stamps when its cues were last
	// edited before the previous push (that edit already went out) — keeps a
	// metadata-only user from re-sending the same tracks forever.
	// A track with an open rekordbox conflict is never stamped either: the
	// conflict shield dropped those fields/cues from its op, and resolving
	// "keep Curator" later doesn't touch updatedAt — only an unstamped
	// pushedAt keeps that track in the next "Sync updates".
	private pushStampTrackIds(
		flags: ExportFlags,
		linked: Array<{ curatorTrackId: string; rbContentId: string }>,
	): Set<string> {
		if (!flags.syncMetadata || !flags.syncTags) return new Set();
		const ids = linked.map((p) => p.curatorTrackId);
		const out = new Set<string>();
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500);
			const conflicted = new Set(this.db
				.select({ trackId: syncConflict.trackId })
				.from(syncConflict)
				.where(and(eq(syncConflict.provider, 'rekordbox'), inArray(syncConflict.trackId, chunk)))
				.all()
				.map((r) => r.trackId));
			if (flags.syncCues) {
				for (const id of chunk) if (!conflicted.has(id)) out.add(id);
				continue;
			}
			const rows = this.db
				.select({ id: track.id, cuesEditedAt: track.cuesEditedAt, pushedAt: rekordboxLink.pushedAt })
				.from(track)
				.innerJoin(rekordboxLink, eq(rekordboxLink.trackId, track.id))
				.where(inArray(track.id, chunk))
				.all();
			for (const r of rows) {
				if (conflicted.has(r.id)) continue;
				if (r.cuesEditedAt == null || (r.pushedAt != null && r.cuesEditedAt.getTime() < r.pushedAt.getTime())) out.add(r.id);
			}
		}
		return out;
	}

	// rekordbox now holds the name each verified playlist_merge carried —
	// record it as the rename baseline so the next run skips the playlist
	// until it's renamed again. A rename made while this push was in flight
	// differs from the pushed name and still goes out next time.
	private advancePlaylistNameBaselines(verifiedOps: WriteOp[]): void {
		for (const op of verifiedOps) {
			if (op.kind !== 'playlist_merge' || op.name == null) continue;
			this.db.update(playlistTable)
				.set({ rbNameSeen: op.name })
				.where(and(
					eq(playlistTable.source, 'rekordbox'),
					or(eq(playlistTable.id, `rb_${op.rb_playlist_id}`), eq(playlistTable.sourceId, op.rb_playlist_id)),
				))
				.run();
		}
	}

	// Resolve errored ops back to curator-side names (track titles via
	// rekordboxLink, playlist/folder names via sourceId) so the failure toast
	// and log can say WHICH item failed — the original lone-surrogate incident
	// surfaced only as an opaque whole-sync rollback. One batched query per
	// id kind; a target that can't be resolved keeps a null label.
	private attributeWriteFailures(errored: Array<{ op: WriteOp; error: string }>): WriteFailure[] {
		if (errored.length === 0) return [];
		const trackIds = new Set<string>();
		const playlistIds = new Set<string>();
		for (const { op } of errored) {
			if (op.kind === 'playlist_merge' || op.kind === 'playlist_rename') playlistIds.add(op.rb_playlist_id);
			else trackIds.add(op.rb_content_id);
		}
		const titleByRbId = new Map<string, string>();
		if (trackIds.size > 0) {
			const rows = this.db
				.select({ rbId: rekordboxLink.rbContentId, title: track.title })
				.from(rekordboxLink)
				.innerJoin(track, eq(track.id, rekordboxLink.trackId))
				.where(inArray(rekordboxLink.rbContentId, [...trackIds]))
				.all();
			for (const r of rows) titleByRbId.set(r.rbId, r.title);
		}
		const nameByRbId = new Map<string, string>();
		if (playlistIds.size > 0) {
			for (const t of [playlistTable, playlistFolderTable]) {
				const rows = this.db
					.select({ sourceId: t.sourceId, name: t.name })
					.from(t)
					.where(inArray(t.sourceId, [...playlistIds]))
					.all();
				for (const r of rows) if (r.sourceId != null) nameByRbId.set(r.sourceId, r.name);
			}
		}
		const failures: WriteFailure[] = errored.map(({ op, error }) => {
			const isPlaylist = op.kind === 'playlist_merge' || op.kind === 'playlist_rename';
			const target = isPlaylist ? op.rb_playlist_id : op.rb_content_id;
			return {
				kind: op.kind,
				target,
				targetLabel: (isPlaylist ? nameByRbId.get(target) : titleByRbId.get(target)) ?? null,
				error,
			};
		});
		for (const f of failures) {
			xlog.warn('write op failed', { kind: f.kind, target: f.target, label: f.targetLabel, error: f.error });
		}
		xlog.warn('write batch had failures', { count: failures.length });
		try {
			this.writeAudit?.({
				kind: 'rekordbox-write-batch-failures',
				count: failures.length,
				targets: failures.map((f) => ({ kind: f.kind, target: f.target, label: f.targetLabel })),
			});
		} catch { /* audit must never block the push */ }
		return failures;
	}

	private tallyWriteResults(results: Array<{ kind: string; changed?: boolean; inserted?: number; skipped?: boolean; tracks_written?: number }>): {
		tracksWritten: number;
		cuesWritten: number;
		tagsWritten: number;
		playlistsWritten: number;
		contentDeleted: number;
	} {
		let tracksWritten = 0, cuesWritten = 0, tagsWritten = 0, playlistsWritten = 0, contentDeleted = 0;
		for (const r of results) {
			// content_delete reports skipped:true only when the rb row was
			// already gone (missing) — an idempotent no-op re-push has
			// changed:false without skipped, so guard on kind before the
			// blanket skip-continue below.
			if (r.kind === 'content_delete') {
				if (r.changed) contentDeleted++;
				continue;
			}
			if (r.skipped) continue;
			if (r.kind === 'track' && r.changed) tracksWritten++;
			else if (r.kind === 'cues') cuesWritten += r.inserted ?? 0;
			else if (r.kind === 'tags') tagsWritten += r.inserted ?? 0;
			else if (r.kind === 'playlist_merge') {
				// Count a playlist as "written" only when the merge actually
				// changed rb state — keeps the toast honest when every playlist
				// op is a no-op diff.
				const rr = r as { added?: number; removed?: number; reordered?: boolean; name_changed?: boolean };
				if ((rr.added ?? 0) > 0 || (rr.removed ?? 0) > 0 || rr.reordered || rr.name_changed) playlistsWritten++;
			}
			else if (r.kind === 'playlist_rename') {
				// Folder-name push — only counts when the name actually moved.
				if ((r as { name_changed?: boolean }).name_changed) playlistsWritten++;
			}
		}
		return { tracksWritten, cuesWritten, tagsWritten, playlistsWritten, contentDeleted };
	}

	// Drop curator-side state for rb ids the writer reported as missing
	// (row was deleted from master.db between Curator's last read sync and
	// this write). Two independent deletes:
	//   • rekordbox_link rows where rb_content_id ∈ missingTrackRbIds —
	//     the link table loses the dead pointer; the canonical `track`
	//     row stays (it may still have Spotify/Tidal source_links).
	//   • playlist rows where source='rekordbox' AND sourceId ∈
	//     missingPlaylistRbIds — cascade clears playlist_track too.
	//     Folders containing the deleted playlist are left alone (folders
	//     can legitimately be empty).
	// Counts returned are the actual DELETE changes — not the input set
	// size — so the UI reports work that genuinely landed.
	private pruneStaleLinkages(
		missingTrackRbIds: ReadonlySet<string>,
		missingPlaylistRbIds: ReadonlySet<string>,
	): { tracksUnlinked: number; playlistsRemoved: number } {
		let tracksUnlinked = 0;
		if (missingTrackRbIds.size > 0) {
			const ids = Array.from(missingTrackRbIds);
			// Chunk to dodge SQLite's 999-variable IN-clause limit on
			// pathological inputs (a sync that surfaces thousands of
			// missing tracks is unlikely but free to defend against).
			for (let i = 0; i < ids.length; i += 500) {
				const chunk = ids.slice(i, i + 500);
				// Open conflicts for these tracks reference an rb row that no
				// longer exists — nothing left to resolve against.
				const deadLinks = this.db
					.select({ trackId: rekordboxLink.trackId })
					.from(rekordboxLink)
					.where(inArray(rekordboxLink.rbContentId, chunk))
					.all();
				if (deadLinks.length > 0) {
					this.db.delete(syncConflict)
						.where(and(
							eq(syncConflict.provider, 'rekordbox'),
							inArray(syncConflict.trackId, deadLinks.map((l) => l.trackId)),
						))
						.run();
				}
				const res = this.db.delete(rekordboxLink)
					.where(inArray(rekordboxLink.rbContentId, chunk))
					.run();
				tracksUnlinked += res.changes ?? 0;
			}
		}
		let playlistsRemoved = 0;
		if (missingPlaylistRbIds.size > 0) {
			const ids = Array.from(missingPlaylistRbIds);
			for (let i = 0; i < ids.length; i += 500) {
				const chunk = ids.slice(i, i + 500);
				// playlist delete op per row (mutators.deletePlaylist).
				const gone = this.db.select({ id: playlistTable.id }).from(playlistTable)
					.where(and(
						eq(playlistTable.source, 'rekordbox'),
						inArray(playlistTable.sourceId, chunk),
					))
					.all();
				for (const g of gone) if (deletePlaylist(this.db, g.id)) playlistsRemoved++;
			}
		}
		return { tracksUnlinked, playlistsRemoved };
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Convenience accessor — the CoreService needs to know the rekordbox
// directory (sibling to master.db) for the list_backups / clear_backups
// RPCs. Cheap helper to keep that logic in one place.

export function rekordboxDirOf(dbPath: string): string {
	return path.dirname(path.resolve(dbPath));
}
