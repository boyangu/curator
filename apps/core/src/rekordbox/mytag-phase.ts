// Rekordbox MYTAG phase — runs inside RekordboxExporter.runExport ahead of the
// update push whenever tags are in scope.
//
// A tag made in Curator has no DjmdMyTag, so the tags pass had no id to point
// its tracks at and left it out (2026-11-27: #bluerama sat on 26 linked
// tracks and never reached rekordbox). This phase gives each such tag — user
// kind, on at least one rb-linked track in the push's scope — a MyTag:
//   1. one mytag_ensure op per tag (writer.py: reuse a live same-name tag,
//      revive a tombstoned one, else create it the way rekordbox does, in the
//      group chosen in Settings);
//   2. commit — its own write session, so the update push that follows
//      references committed ids, exactly as it does for an imported tag;
//   3. a rekordbox_tag_link per tag the writer resolved. From then on the
//      tag is an rb tag to every rb code path (tag-link.ts): the tags pass,
//      the comment block, the stale sweep and the pull.
// A tag only on tracks rekordbox doesn't have stays Curator-only: no empty
// MyTag in rekordbox. A user tag on no linked track at all never reaches
// the phase.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { rekordboxLink, rekordboxTagLink, tag as tagTable, track, trackTag } from '@curator/shared/schema';
import type { Db } from '@curator/sync-core/db/client';
import * as mut from '@curator/sync-core/library/mutators';
import { log } from '@curator/sync-core/log';
import type { MyTagEnsureOp, RekordboxSidecar, WriteFailure } from './sidecar.js';
import { curatorTagIdForRb } from './tag-link.js';

const mlog = log.for('rb-mytag');

// Where new MyTags go when Settings names no group (or the named group is
// gone): the user's own "attributes" group, by name — group ids are per
// library. The writer falls back to the first live group when this one
// doesn't exist either.
export const DEFAULT_MYTAG_GROUP_NAME = 'attributes';

export interface MyTagGroupChoice {
	id: string | null;
	name: string;
}

// The group a new MyTag lands in — writer.apply_mytag_ensure's rule (the
// chosen id, else the chosen name, else the first group), restated here so
// Settings shows where the next push really puts a tag. Keep the two in step.
export function pickMyTagGroup<G extends { id: string; name: string }>(groups: G[], choice: MyTagGroupChoice): G | null {
	const norm = (s: string): string => s.trim().toLowerCase();
	return (choice.id ? groups.find((g) => g.id === choice.id) : undefined)
		?? groups.find((g) => norm(g.name) === norm(choice.name))
		?? groups[0]
		?? null;
}

type LinkedPair = { curatorTrackId: string; rbContentId: string };

export interface MyTagPlan {
	ops: MyTagEnsureOp[];
	// Curator tag id → its rb-linked tracks in scope. The exporter adds them
	// to the push so the tags pass writes their membership this run.
	tracks: Map<string, LinkedPair[]>;
}

export interface MyTagPhaseSummary {
	created: number;
	revived: number;
	reused: number;
	// Curator tags folded into an existing same-name rb tag (see linkOnCurator).
	merged: number;
	// Every tag that now has rb identity, linked or merged — the exporter
	// adds their planned tracks to a "Sync updates" push.
	resolvedTagIds: string[];
	backupPath: string | null;
	writeFailures: WriteFailure[];
}

// `scope` = the push's linked tracks, or 'all' for "Sync updates": a track
// tagged before this phase existed was pushed since (pushedAt past its
// tagging), so the changed-since-push selection would never offer its tag.
export function planMyTagPhase(db: Db, scope: LinkedPair[] | 'all', group: MyTagGroupChoice): MyTagPlan | null {
	const query = (trackIds: string[] | null) => db
		.select({ tagId: tagTable.id, name: tagTable.name, trackId: trackTag.trackId, rbContentId: rekordboxLink.rbContentId })
		.from(trackTag)
		.innerJoin(tagTable, eq(tagTable.id, trackTag.tagId))
		.innerJoin(rekordboxLink, eq(rekordboxLink.trackId, trackTag.trackId))
		.innerJoin(track, eq(track.id, trackTag.trackId))
		.leftJoin(rekordboxTagLink, eq(rekordboxTagLink.tagId, tagTable.id))
		.where(and(
			eq(tagTable.kind, 'user'),
			sql`substr(${tagTable.id}, 1, 3) <> 'rb_'`,
			isNull(rekordboxTagLink.tagId),
			isNull(track.deletedAt),
			trackIds ? inArray(trackTag.trackId, trackIds) : undefined,
		))
		.all();
	const rows = scope === 'all'
		? query(null)
		: Array.from({ length: Math.ceil(scope.length / 500) }, (_, i) => query(scope.slice(i * 500, (i + 1) * 500).map((p) => p.curatorTrackId))).flat();
	if (rows.length === 0) return null;

	const tracks = new Map<string, LinkedPair[]>();
	const names = new Map<string, string>();
	for (const r of rows) {
		names.set(r.tagId, r.name);
		const list = tracks.get(r.tagId) ?? [];
		list.push({ curatorTrackId: r.trackId, rbContentId: r.rbContentId });
		tracks.set(r.tagId, list);
	}
	const ops: MyTagEnsureOp[] = Array.from(names, ([tagId, name]) => ({
		kind: 'mytag_ensure',
		curator_tag_id: tagId,
		name,
		group_id: group.id,
		group_name: group.name,
	}));
	return { ops, tracks };
}

export interface MyTagPhaseDeps {
	db: Db;
	sidecar: RekordboxSidecar;
	writeAudit?: (entry: Record<string, unknown>) => void;
	progress: (phase: string, done: number, total: number) => void;
}

// `backupPath` = the run's backup when an earlier phase already took one;
// null → this phase takes it (before any write) and reports it back.
export async function runMyTagPhase(
	deps: MyTagPhaseDeps,
	plan: MyTagPlan,
	conn: { dbPath: string; key?: string },
	backupPath: string | null,
): Promise<MyTagPhaseSummary> {
	const { db, sidecar } = deps;
	if (!backupPath) {
		deps.progress('mytags:backup', 0, 1);
		backupPath = (await sidecar.backup(conn.dbPath)).path;
		deps.progress('mytags:backup', 1, 1);
	}

	await sidecar.openForWrite({ dbPath: conn.dbPath, key: conn.key });
	try {
		deps.writeAudit?.({
			kind: 'rekordbox-mytag-batch',
			tags: plan.ops.map((o) => o.name),
			group: plan.ops[0]?.group_id ?? plan.ops[0]?.group_name,
			backupPath,
		});
	} catch { /* audit must never block the push */ }
	deps.progress('mytags:write', 0, plan.ops.length);
	const { results } = await sidecar.applyWriteBatch(plan.ops, (done, total) => deps.progress('mytags:write', done, total));
	deps.progress('mytags:write', plan.ops.length, plan.ops.length);
	await sidecar.commitAndClose([]);

	const summary: MyTagPhaseSummary = { created: 0, revived: 0, reused: 0, merged: 0, resolvedTagIds: [], backupPath, writeFailures: [] };
	const resolved: Array<{ tagId: string; rbTagId: string }> = [];
	plan.ops.forEach((op, i) => {
		const r = results[i];
		// A sidecar older than 0.7.0 answers an unknown kind with
		// {skipped: true} and no id — same as a failure: no link, the tag
		// stays Curator-only and the next push asks again.
		if (!r || r.error || r.skipped || !r.rb_tag_id) {
			summary.writeFailures.push({
				kind: op.kind,
				target: op.curator_tag_id,
				targetLabel: op.name,
				error: r?.error ?? 'skipped by the writer — rebuild the rekordbox sidecar if this persists',
			});
			return;
		}
		if (r.created) summary.created++;
		else if (r.revived) summary.revived++;
		else summary.reused++;
		resolved.push({ tagId: op.curator_tag_id, rbTagId: r.rb_tag_id });
	});
	// Committed rows exist in rekordbox whatever happens next — link them now
	// (ensure is idempotent by name, so a lost link would only re-find them).
	summary.merged = linkOnCurator(db, resolved);
	summary.resolvedTagIds = resolved.map((r) => r.tagId);
	mlog.info('mytag phase done', { ...summary, resolvedTagIds: summary.resolvedTagIds.length, writeFailures: summary.writeFailures.length });
	return summary;
}

// One transaction. The rb id may already belong to a Curator tag: an
// imported `rb_<ID>` (rekordbox had the name and Curator held both the
// imported tag and its own same-name tag), or another Curator tag linked
// earlier in this batch ("Warmup" and "warmup" both resolve to one MyTag).
// rekordbox can show one tag only, so this one folds into the owner — its
// assignments move over, then it's deleted — the same same-name merge the
// importer makes for a tombstoned tag (reconcileDeadMyTags).
function linkOnCurator(db: Db, resolved: Array<{ tagId: string; rbTagId: string }>): number {
	if (resolved.length === 0) return 0;
	const now = new Date();
	let merged = 0;
	db.transaction((tx) => {
		for (const { tagId, rbTagId } of resolved) {
			const owner = curatorTagIdForRb(db, rbTagId);
			const ownerExists = owner !== tagId
				&& tx.select({ id: tagTable.id }).from(tagTable).where(eq(tagTable.id, owner)).get() != null;
			if (!ownerExists) {
				tx.insert(rekordboxTagLink)
					.values({ tagId, rbTagId, linkedAt: now })
					.onConflictDoUpdate({ target: rekordboxTagLink.tagId, set: { rbTagId, linkedAt: now } })
					.run();
				continue;
			}
			const members = tx.select({ trackId: trackTag.trackId }).from(trackTag).where(eq(trackTag.tagId, tagId)).all().map((m) => m.trackId);
			mut.tagTracks(db, members, owner, { addedAt: now });
			mut.deleteTag(db, tagId);
			mlog.info('curator tag merged into same-name rb tag', { tag: tagId, owner, rbTagId, members: members.length });
			merged++;
		}
	});
	return merged;
}
