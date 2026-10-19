// Conflict listing + resolution for the pull→merge→pause→push pipeline.
// The pipeline itself is orchestrated in service.ts:syncToRekordbox (pull
// via RekordboxImporter, push via RekordboxExporter — strictly sequential,
// which is what keeps the single sidecar session safe); this module owns
// the pause state in between: reading open sync_conflict rows into the
// renderer-facing SyncConflict shape and applying the user's decisions.
//
// Provider note: the SHAPES here (SyncConflict, choices) are neutral —
// see packages/shared/src/sync.ts — but this implementation is the
// Rekordbox provider's. A future Traktor/Serato provider gets its own
// resolution apply (different link table) behind the same wire format.

import { and, eq, inArray } from 'drizzle-orm';
import { DEFAULT_ARTIST_CREDIT_FORMAT, type ArtistCreditFormat } from '@curator/shared';
import type { TrackArtist } from '@curator/shared/schema';
import {
	cue as cueTable,
	rekordboxLink,
	syncConflict,
	track,
	playlist as playlistTable,
	playlistTrack,
	playlistConflict,
	rekordboxMembershipBaseline,
} from '@curator/shared/schema';
import {
	cueUnitKey,
	type CueUnit,
	type FieldsSeen,
	type SyncConflict,
	type SyncConflictChoice,
	type SyncFieldKey,
} from '@curator/shared';
import type { Db } from '../db/client.js';
import { curatorFieldsView } from '../sync/curator-view.js';
import { applyCueOpsToTrack, buildPullPatch } from '../sync/apply.js';
import { artistProtect, normalizeIncomingArtists, syncTrackArtistsById } from '../library/artists.js';
import { syncTrackAlbumsById } from '../library/albums.js';
import * as mut from '../library/mutators.js';

// Read every open rekordbox conflict, resolving Curator's CURRENT value at
// listing time (the stored row only carries base + theirs — ours is live
// so the modal never shows a stale "your value").
export function listOpenConflicts(db: Db, fmt: ArtistCreditFormat = DEFAULT_ARTIST_CREDIT_FORMAT): SyncConflict[] {
	const rows = db
		.select({
			id: syncConflict.id,
			trackId: syncConflict.trackId,
			kind: syncConflict.kind,
			fieldKey: syncConflict.fieldKey,
			baseJson: syncConflict.baseJson,
			theirsJson: syncConflict.theirsJson,
		})
		.from(syncConflict)
		.where(eq(syncConflict.provider, 'rekordbox'))
		.all();
	if (rows.length === 0) return [];

	const trackIds = Array.from(new Set(rows.map((r) => r.trackId)));
	const trackRows = db.select().from(track).where(inArray(track.id, trackIds)).all();
	const trackById = new Map(trackRows.map((t) => [t.id, t]));
	const needCues = rows.some((r) => r.kind === 'cue');
	const cueRows = needCues
		? db.select().from(cueTable).where(inArray(cueTable.trackId, trackIds)).all()
		: [];
	const cuesByTrack = new Map<string, Map<string, CueUnit>>();
	for (const c of cueRows) {
		const unit: CueUnit = {
			kind: c.kind,
			slot: c.slot,
			positionSec: c.positionSec,
			lengthSec: c.lengthSec ?? null,
			color: c.color ?? null,
			name: c.name ?? null,
		};
		const map = cuesByTrack.get(c.trackId) ?? new Map<string, CueUnit>();
		map.set(cueUnitKey(unit), unit);
		cuesByTrack.set(c.trackId, map);
	}

	const out: SyncConflict[] = [];
	for (const r of rows) {
		const t = trackById.get(r.trackId);
		if (!t) continue; // track deleted since detection; cascade will clean the row
		const fields = curatorFieldsView(t, fmt);
		const ours = r.kind === 'field'
			? fields[r.fieldKey as SyncFieldKey] ?? null
			: cuesByTrack.get(r.trackId)?.get(r.fieldKey) ?? null;
		out.push({
			id: r.id,
			provider: 'rekordbox',
			trackId: r.trackId,
			trackTitle: fields.title == null ? t.title : String(fields.title),
			trackArtist: fields.artist == null ? '' : String(fields.artist),
			kind: r.kind,
			fieldKey: r.fieldKey,
			baseValue: r.baseJson ?? null,
			theirsValue: r.theirsJson ?? null,
			oursValue: ours,
		});
	}

	// Playlist-scoped order conflicts (both sides reordered the same playlist).
	// Curator's live order is resolved here from the current playlist_track
	// (rb-linked members only, matching how the merge compares order).
	const orderRows = db
		.select({ id: playlistConflict.id, rbPlaylistId: playlistConflict.rbPlaylistId, baseJson: playlistConflict.baseJson, theirsJson: playlistConflict.theirsJson })
		.from(playlistConflict)
		.where(and(eq(playlistConflict.provider, 'rekordbox'), eq(playlistConflict.kind, 'order')))
		.all();
	for (const r of orderRows) {
		const curatorPlaylistId = `rb_${r.rbPlaylistId}`;
		const pl = db.select({ name: playlistTable.name }).from(playlistTable).where(eq(playlistTable.id, curatorPlaylistId)).get();
		// Live Curator order of rb-linked members.
		const members = db
			.select({ trackId: playlistTrack.trackId, position: playlistTrack.position })
			.from(playlistTrack)
			.where(eq(playlistTrack.playlistId, curatorPlaylistId))
			.orderBy(playlistTrack.position)
			.all();
		const trackIds = members.map((m) => m.trackId);
		const links = trackIds.length === 0 ? [] : db
			.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
			.from(rekordboxLink)
			.where(inArray(rekordboxLink.trackId, trackIds))
			.all();
		const rbByTrack = new Map(links.map((l) => [l.trackId, l.rbContentId]));
		const oursOrder = members.map((m) => rbByTrack.get(m.trackId)).filter((x): x is string => !!x);
		out.push({
			id: r.id,
			provider: 'rekordbox',
			trackId: `playlist:${r.rbPlaylistId}`,
			trackTitle: pl?.name ?? 'Playlist',
			trackArtist: '',
			kind: 'order',
			fieldKey: 'order',
			baseValue: r.baseJson ?? [],
			theirsValue: r.theirsJson ?? [],
			oursValue: oursOrder,
			rbPlaylistId: r.rbPlaylistId,
		});
	}
	return out;
}

// Apply the user's per-conflict decisions. Both choices converge the
// stored baseline to THEIRS (rb's value at detection) — that's rb's
// actual current state, so the snapshot stays a truthful mirror:
//   'theirs' → additionally write rb's value into Curator (same code path
//              as a merge pull: override clear, ascii mirrors, no
//              updatedAt bump). Both sides now match the baseline.
//   'ours'   → Curator keeps its value; with baseline = rb's value, the
//              next merge reads "ours changed, theirs didn't" and the
//              push (run right after this by the service) writes
//              Curator's value to rb.
// Unknown/stale conflict ids no-op — the row may have been replaced by a
// newer detection or cleaned up by a prune since the modal listed it.
export function applyConflictResolutions(
	db: Db,
	resolutions: Array<{ conflictId: string; choice: SyncConflictChoice }>,
): { applied: number; skipped: number } {
	let applied = 0;
	let skipped = 0;
	db.transaction(() => {
		for (const res of resolutions) {
			// Playlist order conflict? Resolve and continue. 'ours' just clears
			// the conflict (the exporter then pushes Curator's order); 'theirs'
			// reorders Curator's playlist_track to rekordbox's order first.
			const orderRow = db.select().from(playlistConflict).where(eq(playlistConflict.id, res.conflictId)).get();
			if (orderRow) {
				if (orderRow.provider === 'rekordbox' && res.choice === 'theirs') {
					reorderPlaylistToRbOrder(db, orderRow.rbPlaylistId, (orderRow.theirsJson ?? []) as string[]);
				}
				db.delete(playlistConflict).where(eq(playlistConflict.id, orderRow.id)).run();
				applied++;
				continue;
			}

			const row = db.select().from(syncConflict).where(eq(syncConflict.id, res.conflictId)).get();
			if (!row || row.provider !== 'rekordbox') { skipped++; continue; }
			const link = db.select().from(rekordboxLink).where(eq(rekordboxLink.trackId, row.trackId)).get();
			if (!link) {
				// Link pruned since detection — the conflict is moot.
				db.delete(syncConflict).where(eq(syncConflict.id, row.id)).run();
				skipped++;
				continue;
			}

			if (row.kind === 'field') {
				const field = row.fieldKey as SyncFieldKey;
				const theirs = (row.theirsJson ?? null) as string | number | null;
				if (res.choice === 'theirs') {
					const trackRow = db.select().from(track).where(eq(track.id, row.trackId)).get();
					if (trackRow) {
						const pull: FieldsSeen = { [field]: theirs };
						const patch = buildPullPatch(pull, trackRow.overrides, { nullPreserve: false, clearOverrides: true, protect: artistProtect(db) });
						if (Array.isArray(patch['artists'])) {
							patch['artists'] = normalizeIncomingArtists(db, patch['artists'] as TrackArtist[], { title: trackRow.overrides?.title ?? trackRow.title });
						}
						if (Object.keys(patch).length > 0) {
							// Override clears / a pulled rating travel as ops.
							mut.recordTrackStateChanges(db, [row.trackId], () => {
								db.update(track).set(patch).where(eq(track.id, row.trackId)).run();
								if ('artists' in patch || 'overrides' in patch) syncTrackArtistsById(db, [row.trackId]);
								if ('albumTitle' in patch || 'artists' in patch || 'overrides' in patch) syncTrackAlbumsById(db, [row.trackId]);
							});
						}
					}
				}
				db.update(rekordboxLink)
					.set({ fieldsSeen: { ...(link.fieldsSeen ?? {}), [field]: theirs } })
					.where(eq(rekordboxLink.trackId, row.trackId))
					.run();
			} else {
				const theirs = (row.theirsJson ?? null) as CueUnit | null;
				if (res.choice === 'theirs') {
					const oursRows = db.select().from(cueTable).where(eq(cueTable.trackId, row.trackId)).all();
					// theirs == null means "deleted on the rb side" — mirror
					// the delete locally by removing whatever unit currently
					// occupies the conflicted key.
					const target = theirs ?? oursRows
						.map((c) => ({
							kind: c.kind,
							slot: c.slot,
							positionSec: c.positionSec,
							lengthSec: c.lengthSec ?? null,
							color: c.color ?? null,
							name: c.name ?? null,
						}))
						.find((u) => cueUnitKey(u) === row.fieldKey) ?? null;
					if (target) {
						mut.recordCueChanges(db, [row.trackId], () => applyCueOpsToTrack(db, row.trackId, [{ op: theirs ? 'upsert' : 'delete', unit: target }], oursRows));
					}
				}
				// Baseline: replace the unit at this key with rb's value
				// (or drop it when rb deleted the cue).
				const seen = (link.cuesSeen ?? []).filter((u) => cueUnitKey(u) !== row.fieldKey);
				if (theirs) seen.push(theirs);
				db.update(rekordboxLink)
					.set({ cuesSeen: seen })
					.where(eq(rekordboxLink.trackId, row.trackId))
					.run();
			}

			db.delete(syncConflict).where(eq(syncConflict.id, row.id)).run();
			applied++;
		}
	});
	return { applied, skipped };
}

// Reorder a Curator rb-playlist's playlist_track to follow rekordbox's order
// (`rbOrder` = rb_content_ids). rb-linked members are sequenced by their rank
// in rbOrder; members not in rbOrder (curator-only, or rb members rbOrder
// omitted) keep their relative order, appended after. Caller is inside the
// resolution transaction. Rows keep their ids; only the ones that move get
// new order keys, one `move` op each (mutators.reorderMembers).
function reorderPlaylistToRbOrder(db: Db, rbPlaylistId: string, rbOrder: string[]): void {
	const curatorPlaylistId = `rb_${rbPlaylistId}`;
	const members = db
		.select({ id: playlistTrack.id, trackId: playlistTrack.trackId })
		.from(playlistTrack)
		.where(eq(playlistTrack.playlistId, curatorPlaylistId))
		.orderBy(playlistTrack.position)
		.all();
	if (members.length === 0) return;
	const trackIds = members.map((m) => m.trackId);
	const links = db
		.select({ trackId: rekordboxLink.trackId, rbContentId: rekordboxLink.rbContentId })
		.from(rekordboxLink)
		.where(inArray(rekordboxLink.trackId, trackIds))
		.all();
	const rbByTrack = new Map(links.map((l) => [l.trackId, l.rbContentId]));
	const rank = new Map(rbOrder.map((cid, i) => [cid, i]));
	const ranked = members
		.map((m, idx) => ({ m, idx, r: rank.get(rbByTrack.get(m.trackId) ?? '') }))
		.sort((a, b) => {
			const ar = a.r ?? Infinity, br = b.r ?? Infinity;
			if (ar !== br) return ar - br;
			return a.idx - b.idx; // stable for un-ranked members
		});

	mut.reorderMembers(db, curatorPlaylistId, ranked.map(({ m }) => m.id));
	// Keep the baseline's stored order in step so a follow-up sync doesn't
	// re-detect the just-resolved divergence.
	const baseRows = db
		.select({ memberKind: rekordboxMembershipBaseline.memberKind, memberId: rekordboxMembershipBaseline.memberId })
		.from(rekordboxMembershipBaseline)
		.where(eq(rekordboxMembershipBaseline.rbPlaylistId, rbPlaylistId))
		.all();
	if (baseRows.length > 0) {
		const baseRank = new Map(rbOrder.map((cid, i) => [cid, i]));
		const reranked = baseRows
			.map((b, idx) => ({ b, idx, r: b.memberKind === 'rb' ? baseRank.get(b.memberId) : undefined }))
			.sort((a, b) => {
				const ar = a.r ?? Infinity, br = b.r ?? Infinity;
				if (ar !== br) return ar - br;
				return a.idx - b.idx;
			});
		let bpos = 0;
		for (const { b } of reranked) {
			db.update(rekordboxMembershipBaseline)
				.set({ position: bpos++ })
				.where(and(
					eq(rekordboxMembershipBaseline.rbPlaylistId, rbPlaylistId),
					eq(rekordboxMembershipBaseline.memberKind, b.memberKind),
					eq(rekordboxMembershipBaseline.memberId, b.memberId),
				))
				.run();
		}
	}
}
