// Curator tag ↔ rekordbox MyTag identity.
//
// Two shapes of rb identity:
//   - a tag imported FROM rekordbox carries it in its id: `rb_<DjmdMyTag.ID>`
//     (importer.ts applyMyTagDelta mints those);
//   - a Curator-made tag the push created or found in rekordbox keeps its own
//     id (an account-wide identity on the op log — see the
//     rekordbox_tag_link schema comment) and carries the rb id in
//     rekordbox_tag_link (mytag-phase.ts writes it).
// Everything that maps between the two sides goes through here, so the pull
// and the push can't disagree about which Curator tag a MyTag is.

import { eq, inArray } from 'drizzle-orm';
import { rekordboxTagLink, tag as tagTable } from '@curator/shared/schema';
import type { Db } from '@curator/sync-core/db/client';

// The rb id of each of `tagIds` that has one; tags without rb identity are
// absent from the map.
export function rbTagIdsFor(db: Db, tagIds: string[]): Map<string, string> {
	const out = new Map<string, string>();
	const unprefixed: string[] = [];
	for (const id of tagIds) {
		if (id.startsWith('rb_')) out.set(id, id.slice(3));
		else unprefixed.push(id);
	}
	for (let i = 0; i < unprefixed.length; i += 500) {
		for (const l of db
			.select({ tagId: rekordboxTagLink.tagId, rbTagId: rekordboxTagLink.rbTagId })
			.from(rekordboxTagLink)
			.where(inArray(rekordboxTagLink.tagId, unprefixed.slice(i, i + 500)))
			.all()) out.set(l.tagId, l.rbTagId);
	}
	return out;
}

// The Curator tag id a MyTag maps to: the linked Curator tag when one is
// linked and still exists, else the importer's `rb_<ID>`. The join keeps a
// dangling link (tag deleted on a handle without FK enforcement) from
// resurrecting a deleted tag under its old id on the next pull.
export function curatorTagIdForRb(db: Db, rbTagId: string): string {
	const linked = db
		.select({ tagId: rekordboxTagLink.tagId })
		.from(rekordboxTagLink)
		.innerJoin(tagTable, eq(tagTable.id, rekordboxTagLink.tagId))
		.where(eq(rekordboxTagLink.rbTagId, rbTagId))
		.get();
	return linked?.tagId ?? `rb_${rbTagId}`;
}
