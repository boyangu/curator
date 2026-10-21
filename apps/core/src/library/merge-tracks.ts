// Merge two canonical track rows into one — the in-app successor to the
// Python repair scripts (scripts/repair-scanner-dedup.py `merge_bare`,
// scripts/fix-rb-holds-2026-08-29.py `apply_merge`). Every rule below is a
// port of what those scripts did to the live library, generalised from
// "orphan/usurper" to `keep`/`drop`.
//
// The merge is a UNION: tags, playlist memberships, source links, cues,
// analysis, play history and scalar attributes from both rows end up on
// `keep`; `drop` is soft-deleted (deleted_at stamped, row retained). Nothing
// here talks to a streaming provider or writes a rekordbox tombstone —
// playlist_track rows are rewritten directly, never through the playlist
// add/remove methods (which push upstream), and the loser is never routed
// through deleteTracks (which mints rekordbox_deleted_content). A moved
// membership onto a rekordbox playlist surfaces as an ADD in the next
// rekordbox sync *preview*; it is never pushed silently.
//
// Sync (cloud plan B4): the same transaction emits `recording.merge` plus the
// re-assert of keep's final state (mutators.ts mergeRecordingRaw), so every
// other device folds the same two recordings the same way. The soft-delete
// of `drop` is deliberately NOT a library_track delete op: an op addressed to
// the loser is redirected to the winner, and would delete the survivor.
//
// Blockers (refused, DB untouched): both rows carry their own rekordbox_link
// (two distinct rekordbox entries — resolve in rekordbox first), either row
// is already soft-deleted, either row is a remote row (not on this device),
// or keep === drop.

import { and, count, eq, sql } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import {
	track,
	playlist,
	playlistTrack,
	sourceLink,
	trackTag,
	cue,
	trackAnalysis,
	analysisJob,
	downloadJob,
	syncConflict,
	playEvent,
	rekordboxLink,
	rekordboxMembershipBaseline,
	type Track,
	type TrackOverrides,
} from '@curator/shared/schema';
import { asciify } from '@curator/shared';
import { mergeRecordingRaw } from './mutators.js';
import { recordingOf } from '../sync-log/rows.js';
import { syncTrackArtistsById } from './artists.js';
import { syncTrackAlbumsById } from './albums.js';
import { recomputePositions } from './playlist-order.js';
import type { Db } from '../db/client.js';

// Same tolerance the ISRC dedup migration and the matcher use: two rows more
// than 5 s apart are usually different mixes (Extended vs Radio Edit).
export const MERGE_DURATION_TOLERANCE_S = 5;

// Per-side snapshot the renderer shows in the merge dialog and the weight
// the survivor suggestion is based on.
export interface TrackMergeSide {
	track: Track;
	tags: number;
	playlists: number;
	cues: number;
	links: string[];
	localFile: boolean;
	rekordbox: boolean;
	analyzed: boolean;
	// rating*10 + tags + playlists + cues + links, +5 for a local file, +5 for
	// a rekordbox link — the repair script's curation_weight with the two
	// "hard to re-create" bindings weighted up.
	weight: number;
}

export interface TrackMergePlan {
	keepId: string;
	dropId: string;
	blockers: string[];
	warnings: string[];
	linksMoved: number;
	linksDropped: number;
	tagsAdded: number;
	tagsDuplicate: number;
	membershipsMoved: number;
	membershipsDuplicate: number;
	// Moved memberships whose playlist is a rekordbox playlist — the next
	// Sync to Rekordbox previews these as adds.
	rekordboxAdds: number;
	cues: 'keep' | 'take-drop' | 'none';
	analysis: 'keep' | 'take-drop' | 'graft-rb' | 'none';
	playsMoved: number;
	rekordboxLinkMoved: boolean;
	localFilesMoved: number;
}

export interface TrackMergeResult extends TrackMergePlan {
	// True when drop's analysis row became keep's — the caller renames the
	// on-disk peaks sidecars to follow it.
	analysisTakenFromDrop: boolean;
	// Playlists whose membership changed (moved or deduped) — the renderer
	// refreshes the sidebar counts for these.
	playlistsTouched: string[];
}

export class TrackMergeBlockedError extends Error {
	constructor(public readonly blockers: string[]) {
		super(blockers.join('; '));
		this.name = 'TrackMergeBlockedError';
	}
}

type Row = typeof track.$inferSelect;

function loadRow(db: Db, id: string): Row | undefined {
	return db.select().from(track).where(eq(track.id, id)).get();
}

export function describeMergeSide(db: Db, t: Track): TrackMergeSide {
	const n = (q: { get(): { n: number } | undefined }): number => q.get()?.n ?? 0;
	const tags = n(db.select({ n: sql<number>`count(*)` }).from(trackTag).where(eq(trackTag.trackId, t.id)));
	const playlists = n(db.select({ n: sql<number>`count(DISTINCT ${playlistTrack.playlistId})` }).from(playlistTrack).where(eq(playlistTrack.trackId, t.id)));
	const cues = n(db.select({ n: sql<number>`count(*)` }).from(cue).where(eq(cue.trackId, t.id)));
	const linkRows = db.select({ source: sourceLink.source }).from(sourceLink).where(eq(sourceLink.trackId, t.id)).all();
	const links = Array.from(new Set(linkRows.map((r) => r.source)));
	const localFile = links.includes('local');
	const rekordbox = db.select({ trackId: rekordboxLink.trackId }).from(rekordboxLink).where(eq(rekordboxLink.trackId, t.id)).get() != null;
	const analyzed = db.select({ trackId: trackAnalysis.trackId }).from(trackAnalysis).where(eq(trackAnalysis.trackId, t.id)).get() != null;
	const weight = (t.rating ?? 0) * 10 + tags + playlists + cues + links.length + (localFile ? 5 : 0) + (rekordbox ? 5 : 0);
	return { track: t, tags, playlists, cues, links, localFile, rekordbox, analyzed, weight };
}

// Read-only dry run. Safe to call for both directions to populate the
// dialog's "Keep" toggle.
export function planTrackMerge(db: Db, keepId: string, dropId: string): TrackMergePlan {
	const plan: TrackMergePlan = {
		keepId, dropId, blockers: [], warnings: [],
		linksMoved: 0, linksDropped: 0, tagsAdded: 0, tagsDuplicate: 0,
		membershipsMoved: 0, membershipsDuplicate: 0, rekordboxAdds: 0,
		cues: 'none', analysis: 'none', playsMoved: 0, rekordboxLinkMoved: false, localFilesMoved: 0,
	};
	if (keepId === dropId) { plan.blockers.push('A track cannot be merged with itself'); return plan; }
	const keep = loadRow(db, keepId);
	const drop = loadRow(db, dropId);
	if (!keep || !drop) { plan.blockers.push('One of the tracks no longer exists'); return plan; }
	if (keep.deletedAt || drop.deletedAt) { plan.blockers.push('One of the tracks is already deleted'); return plan; }
	// A remote row (track.remoteOnly) is the op log's projection of another
	// device's track, not a row this device owns: moving its tags/playlist
	// rows here and soft-deleting it would fight the projection (the next
	// apply re-derives it), and it has no file or link to bring across.
	// Recording-level merges of remote rows go through the sync log
	// (project.ts drops/absorbs them and never calls this with one).
	if (keep.remoteOnly || drop.remoteOnly) {
		plan.blockers.push('One of the tracks is not on this device — merge it on the device that holds it');
		return plan;
	}

	const keepRb = db.select({ trackId: rekordboxLink.trackId }).from(rekordboxLink).where(eq(rekordboxLink.trackId, keepId)).get();
	const dropRb = db.select({ trackId: rekordboxLink.trackId }).from(rekordboxLink).where(eq(rekordboxLink.trackId, dropId)).get();
	if (keepRb && dropRb) {
		plan.blockers.push('Both tracks are separate rekordbox entries — merge them in rekordbox first, then sync');
	}
	plan.rekordboxLinkMoved = !keepRb && !!dropRb;

	if (keep.duration != null && drop.duration != null && Math.abs(keep.duration - drop.duration) > MERGE_DURATION_TOLERANCE_S) {
		plan.warnings.push(`Durations differ by ${Math.abs(keep.duration - drop.duration)} s — these may be different mixes`);
	}
	if (keep.isrc && drop.isrc && keep.isrc.toUpperCase() !== drop.isrc.toUpperCase()) {
		plan.warnings.push(`ISRCs differ (${keep.isrc} vs ${drop.isrc})`);
	}

	// Source links: keep's row wins per provider; drop's same-provider extras
	// are discarded. Local links carry a unique file_path and always move.
	const keepSources = new Set(db.select({ source: sourceLink.source }).from(sourceLink).where(eq(sourceLink.trackId, keepId)).all().map((r) => r.source));
	const dropLinks = db.select({ source: sourceLink.source }).from(sourceLink).where(eq(sourceLink.trackId, dropId)).all();
	for (const l of dropLinks) {
		if (l.source === 'local') { plan.linksMoved++; plan.localFilesMoved++; }
		else if (keepSources.has(l.source)) plan.linksDropped++;
		else plan.linksMoved++;
	}

	const keepTags = new Set(db.select({ tagId: trackTag.tagId }).from(trackTag).where(eq(trackTag.trackId, keepId)).all().map((r) => r.tagId));
	for (const r of db.select({ tagId: trackTag.tagId }).from(trackTag).where(eq(trackTag.trackId, dropId)).all()) {
		if (keepTags.has(r.tagId)) plan.tagsDuplicate++; else plan.tagsAdded++;
	}

	const keepPlaylists = new Set(db.select({ playlistId: playlistTrack.playlistId }).from(playlistTrack).where(eq(playlistTrack.trackId, keepId)).all().map((r) => r.playlistId));
	const dropMemberships = db
		.select({ playlistId: playlistTrack.playlistId, source: playlist.source })
		.from(playlistTrack)
		.innerJoin(playlist, eq(playlist.id, playlistTrack.playlistId))
		.where(eq(playlistTrack.trackId, dropId))
		.all();
	for (const m of dropMemberships) {
		if (keepPlaylists.has(m.playlistId)) plan.membershipsDuplicate++;
		else { plan.membershipsMoved++; if (m.source === 'rekordbox') plan.rekordboxAdds++; }
	}

	const keepCues = db.select({ n: sql<number>`count(*)` }).from(cue).where(eq(cue.trackId, keepId)).get()?.n ?? 0;
	const dropCues = db.select({ n: sql<number>`count(*)` }).from(cue).where(eq(cue.trackId, dropId)).get()?.n ?? 0;
	plan.cues = keepCues > 0 ? 'keep' : dropCues > 0 ? 'take-drop' : 'none';

	plan.analysis = decideAnalysis(db, keepId, dropId);

	plan.playsMoved = db.select({ n: sql<number>`count(*)` }).from(playEvent).where(eq(playEvent.trackId, dropId)).get()?.n ?? 0;
	return plan;
}

type AnalysisProbe = { hasBeatgrid: boolean; hasRb: boolean } | null;

function probeAnalysis(db: Db, id: string): AnalysisProbe {
	const r = db
		.select({
			hasBeatgrid: sql<number>`${trackAnalysis.beatgrid} IS NOT NULL`,
			hasRb: sql<number>`${trackAnalysis.rbBeatgrid} IS NOT NULL`,
		})
		.from(trackAnalysis)
		.where(eq(trackAnalysis.trackId, id))
		.get();
	return r ? { hasBeatgrid: !!r.hasBeatgrid, hasRb: !!r.hasRb } : null;
}

// Keep whichever analysis row has a Curator beatgrid (keep's on a tie); the
// loser's rekordbox slot is grafted across when the winner lacks one.
function decideAnalysis(db: Db, keepId: string, dropId: string): TrackMergePlan['analysis'] {
	const k = probeAnalysis(db, keepId);
	const d = probeAnalysis(db, dropId);
	if (!d) return k ? 'keep' : 'none';
	if (!k || (!k.hasBeatgrid && d.hasBeatgrid)) return 'take-drop';
	if (!k.hasRb && d.hasRb) return 'graft-rb';
	return 'keep';
}

// Analyzer scalars denormalised onto `track` — travel with the analysis row.
const ANALYSIS_DENORM = [
	'loudnessRangeLu', 'dissonance', 'density', 'brightness', 'power', 'dynamicComplexity',
	'introLengthSec', 'outroLengthSec', 'firstDropSec', 'dropCount', 'breakdownCount',
] as const;

const RB_SLOT = ['rbBeatgrid', 'rbDownbeats', 'rbBpm', 'rbKeyCamelot', 'rbKeyStrength', 'rbSegmentsJson'] as const;

// Scalars filled keep-first: keep's value stands unless null/empty.
const COALESCE_FIELDS = [
	'rating', 'comment', 'genre', 'label', 'albumTitle', 'releaseDate', 'coverUrl', 'colorLabel',
	'isrc', 'mbid', 'bpm', 'keyCamelot', 'copyright', 'explicit', 'duration',
] as const;

function isEmpty(v: unknown): boolean {
	return v == null || v === '';
}

function maxDate(a: Date | null, b: Date | null): Date | null {
	if (!a) return b;
	if (!b) return a;
	return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date | null, b: Date | null): Date | null {
	if (!a) return b;
	if (!b) return a;
	return a.getTime() <= b.getTime() ? a : b;
}

// Apply the merge in one transaction. Throws TrackMergeBlockedError (before
// any write) on blockers. `sqlite` is the raw handle `db` is built on — the
// repo's transaction idiom wraps Drizzle calls in `sqlite.transaction(fn)()`.
//
// `emit: false` is the apply side (sync-log/apply.ts): a merge that arrived as
// an op re-runs the local row moves without echoing it.
export function applyTrackMerge(db: Db, sqlite: Database.Database, keepId: string, dropId: string, opts: { emit?: boolean } = {}): TrackMergeResult {
	const plan = planTrackMerge(db, keepId, dropId);
	if (plan.blockers.length > 0) throw new TrackMergeBlockedError(plan.blockers);
	const result: TrackMergeResult = { ...plan, analysisTakenFromDrop: false, playlistsTouched: [] };
	const now = new Date();

	sqlite.transaction(() => {
		const keep = loadRow(db, keepId)!;
		const drop = loadRow(db, dropId)!;
		// What the re-assert must state for the slots and rows the local
		// rules drop (see mergeRecordingRaw); read before anything moves.
		const loserRecording = opts.emit === false ? null : recordingOf(sqlite, dropId);
		const loserCueSlots = db.select({ slot: cue.slot, kind: cue.kind }).from(cue).where(eq(cue.trackId, dropId)).all();
		const droppedMemberRows: Array<{ id: string; playlistId: string }> = [];

		// ── source links ──────────────────────────────────────────────
		const keepSources = new Set(db.select({ source: sourceLink.source }).from(sourceLink).where(eq(sourceLink.trackId, keepId)).all().map((r) => r.source));
		for (const l of db.select({ id: sourceLink.id, source: sourceLink.source }).from(sourceLink).where(eq(sourceLink.trackId, dropId)).all()) {
			if (l.source !== 'local' && keepSources.has(l.source)) {
				db.delete(sourceLink).where(eq(sourceLink.id, l.id)).run();
			} else {
				db.update(sourceLink).set({ trackId: keepId }).where(eq(sourceLink.id, l.id)).run();
			}
		}
		if (plan.rekordboxLinkMoved) {
			db.update(rekordboxLink).set({ trackId: keepId }).where(eq(rekordboxLink.trackId, dropId)).run();
		}
		const keepHasRb = plan.rekordboxLinkMoved
			|| db.select({ trackId: rekordboxLink.trackId }).from(rekordboxLink).where(eq(rekordboxLink.trackId, keepId)).get() != null;

		// ── tags: union ───────────────────────────────────────────────
		const keepTags = new Set(db.select({ tagId: trackTag.tagId }).from(trackTag).where(eq(trackTag.trackId, keepId)).all().map((r) => r.tagId));
		for (const r of db.select({ tagId: trackTag.tagId }).from(trackTag).where(eq(trackTag.trackId, dropId)).all()) {
			if (keepTags.has(r.tagId)) {
				db.delete(trackTag).where(and(eq(trackTag.trackId, dropId), eq(trackTag.tagId, r.tagId))).run();
			} else {
				db.update(trackTag).set({ trackId: keepId }).where(and(eq(trackTag.trackId, dropId), eq(trackTag.tagId, r.tagId))).run();
			}
		}

		// ── playlists: union, one membership per playlist ─────────────
		// Rows are keyed by id, so re-pointing track_id can't collide; a
		// re-pointed row keeps its order key and so its place. Where keep is
		// already a member, drop's row is deleted and the playlist's
		// positions are restamped (same rule as removeTracksFromPlaylist).
		const keepPlaylists = new Set(db.select({ playlistId: playlistTrack.playlistId }).from(playlistTrack).where(eq(playlistTrack.trackId, keepId)).all().map((r) => r.playlistId));
		const touched = new Set<string>();
		const compactMe = new Set<string>();
		for (const r of db.select({ id: playlistTrack.id, playlistId: playlistTrack.playlistId }).from(playlistTrack).where(eq(playlistTrack.trackId, dropId)).all()) {
			touched.add(r.playlistId);
			if (keepPlaylists.has(r.playlistId)) {
				db.delete(playlistTrack).where(eq(playlistTrack.id, r.id)).run();
				droppedMemberRows.push({ id: r.id, playlistId: r.playlistId });
				compactMe.add(r.playlistId);
			} else {
				db.update(playlistTrack).set({ trackId: keepId }).where(eq(playlistTrack.id, r.id)).run();
			}
		}
		for (const pid of compactMe) {
			recomputePositions(sqlite, pid);
			const remaining = db.select({ n: count() }).from(playlistTrack).where(eq(playlistTrack.playlistId, pid)).get()?.n ?? 0;
			db.update(playlist).set({ trackCount: remaining, updatedAt: now }).where(eq(playlist.id, pid)).run();
		}
		result.playlistsTouched = [...touched];

		// ── cues ──────────────────────────────────────────────────────
		if (plan.cues === 'take-drop') {
			db.update(cue).set({ trackId: keepId }).where(eq(cue.trackId, dropId)).run();
		} else {
			db.delete(cue).where(eq(cue.trackId, dropId)).run();
		}

		// ── analysis ──────────────────────────────────────────────────
		const patch: Partial<Row> = {};
		if (plan.analysis === 'take-drop') {
			const k = probeAnalysis(db, keepId);
			const d = probeAnalysis(db, dropId);
			// Don't lose keep's rekordbox slot when its row is the one going.
			if (k?.hasRb && d && !d.hasRb) graftRbSlot(db, keepId, dropId);
			db.delete(trackAnalysis).where(eq(trackAnalysis.trackId, keepId)).run();
			db.update(trackAnalysis).set({ trackId: keepId }).where(eq(trackAnalysis.trackId, dropId)).run();
			for (const f of ANALYSIS_DENORM) (patch as Record<string, unknown>)[f] = drop[f];
			result.analysisTakenFromDrop = true;
		} else if (plan.analysis === 'graft-rb') {
			graftRbSlot(db, dropId, keepId);
			db.delete(trackAnalysis).where(eq(trackAnalysis.trackId, dropId)).run();
		} else {
			db.delete(trackAnalysis).where(eq(trackAnalysis.trackId, dropId)).run();
		}

		// ── transient rows ────────────────────────────────────────────
		db.delete(analysisJob).where(eq(analysisJob.trackId, dropId)).run();
		db.delete(downloadJob).where(eq(downloadJob.trackId, dropId)).run();
		db.delete(syncConflict).where(eq(syncConflict.trackId, dropId)).run();

		// ── play history: audit log, re-point never delete ────────────
		db.update(playEvent).set({ trackId: keepId }).where(eq(playEvent.trackId, dropId)).run();

		// ── rekordbox membership baseline ('curator'-kind rows key on trackId)
		// When keep is (now) rekordbox-linked its memberships are tracked as
		// 'rb'-kind rows by content id, so drop's curator-kind rows are stale:
		// delete. Otherwise re-point, deleting on PK clash.
		const dropBase = db
			.select({ rbPlaylistId: rekordboxMembershipBaseline.rbPlaylistId })
			.from(rekordboxMembershipBaseline)
			.where(and(eq(rekordboxMembershipBaseline.memberKind, 'curator'), eq(rekordboxMembershipBaseline.memberId, dropId)))
			.all();
		for (const b of dropBase) {
			const where = and(
				eq(rekordboxMembershipBaseline.rbPlaylistId, b.rbPlaylistId),
				eq(rekordboxMembershipBaseline.memberKind, 'curator'),
				eq(rekordboxMembershipBaseline.memberId, dropId),
			);
			const clash = keepHasRb || db
				.select({ memberId: rekordboxMembershipBaseline.memberId })
				.from(rekordboxMembershipBaseline)
				.where(and(
					eq(rekordboxMembershipBaseline.rbPlaylistId, b.rbPlaylistId),
					eq(rekordboxMembershipBaseline.memberKind, 'curator'),
					eq(rekordboxMembershipBaseline.memberId, keepId),
				))
				.get() != null;
			if (clash) db.delete(rekordboxMembershipBaseline).where(where).run();
			else db.update(rekordboxMembershipBaseline).set({ memberId: keepId }).where(where).run();
		}

		// ── scalars: keep-first fill, counters max, overrides union ───
		for (const f of COALESCE_FIELDS) {
			if (isEmpty(keep[f]) && !isEmpty(drop[f])) (patch as Record<string, unknown>)[f] = drop[f];
		}
		if (isEmpty(keep.title) && !isEmpty(drop.title)) patch.title = drop.title;
		if ((keep.artists ?? []).length === 0 && (drop.artists ?? []).length > 0) {
			patch.artists = drop.artists;
			patch.artistsBase = drop.artistsBase ?? null;
		}
		patch.playCount = Math.max(keep.playCount ?? 0, drop.playCount ?? 0);
		patch.lastPlayedAt = maxDate(keep.lastPlayedAt, drop.lastPlayedAt);
		patch.cuesEditedAt = maxDate(keep.cuesEditedAt, drop.cuesEditedAt);
		patch.addedAt = minDate(keep.addedAt, drop.addedAt);
		if (keep.state === 'unsorted' && drop.state !== 'unsorted') {
			patch.state = drop.state;
			patch.stateChangedAt = drop.stateChangedAt;
		}
		if (drop.overrides || keep.overrides) {
			patch.overrides = { ...(drop.overrides ?? {}), ...(keep.overrides ?? {}) } as TrackOverrides;
		}
		patch.updatedAt = now;
		db.update(track).set(asciify(patch)).where(eq(track.id, keepId)).run();
		// The survivor's effective artist list may have changed (filled from
		// drop, or overrides unioned) — re-derive its artist rows. The dropped
		// row keeps its junction rows like track_tag does; every artist count
		// joins track.deleted_at, so they don't show.
		syncTrackArtistsById(db, [keepId]);
		// Same for its release (album title may have been filled from drop,
		// and drop's provider links now sit on keep).
		syncTrackAlbumsById(db, [keepId]);

		// ── soft-delete the emptied row ───────────────────────────────
		db.update(track).set({ deletedAt: now, membership: null, updatedAt: now }).where(eq(track.id, dropId)).run();

		if (loserRecording) mergeRecordingRaw(sqlite, { loserRecordingId: loserRecording, winnerTrackId: keepId, droppedMemberRows, loserCueSlots });
	})();

	return result;
}

// Copy the rb_* analysis slot from one row onto another (only the slot —
// the Curator columns are untouched).
function graftRbSlot(db: Db, fromId: string, ontoId: string): void {
	const src = db
		.select({
			rbBeatgrid: trackAnalysis.rbBeatgrid, rbDownbeats: trackAnalysis.rbDownbeats, rbBpm: trackAnalysis.rbBpm,
			rbKeyCamelot: trackAnalysis.rbKeyCamelot, rbKeyStrength: trackAnalysis.rbKeyStrength, rbSegmentsJson: trackAnalysis.rbSegmentsJson,
		})
		.from(trackAnalysis)
		.where(eq(trackAnalysis.trackId, fromId))
		.get();
	if (!src) return;
	const set: Partial<typeof trackAnalysis.$inferInsert> = {};
	for (const f of RB_SLOT) (set as Record<string, unknown>)[f] = src[f];
	db.update(trackAnalysis).set(set).where(eq(trackAnalysis.trackId, ontoId)).run();
}

// Which side should stay: the more curated one; `a` on a tie (callers pass
// the track the user is working on first).
export function suggestKeepId(a: TrackMergeSide, b: TrackMergeSide): string {
	return b.weight > a.weight ? b.track.id : a.track.id;
}
