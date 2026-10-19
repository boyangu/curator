// Shared "apply a pulled value to Curator" helpers — used by the importer's
// merge pass AND the conflict-resolution path in the sync pipeline. One
// implementation, or the two paths drift on the subtle parts (override
// clearing, *_ascii mirrors, never bumping track.updatedAt).

import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
	cue as cueTable,
	type NewCue,
	type TrackOverrides,
} from '@curator/shared/schema';
import { cueUnitKey, searchFold, splitArtistCredit, type ArtistProtect, type CueUnit, type FieldsSeen, type SyncFieldKey } from '@curator/shared';
import type { Db } from '../db/client.js';

// Translate a pulled FieldsSeen map into a track-table patch: canonical
// columns + the *_ascii search mirrors, plus (optionally) clearing the
// matching override key — a pulled value would otherwise stay masked by
// the override forever. `nullPreserve` keeps the legacy "empty rb value
// never erases Curator data" rule for bootstrap/overwrite paths; the
// merge path passes false because a null that SURVIVED the three-way
// diff is a genuine app-side clear.
//
// The returned patch deliberately does NOT touch track.updatedAt — that
// column means "last Curator-side user edit" and a pull that bumps it
// would defeat both LMW bootstrap and push-side change detection.
export function buildPullPatch(
	pull: FieldsSeen,
	overrides: TrackOverrides | null,
	opts: { nullPreserve: boolean; clearOverrides: boolean; protect?: ArtistProtect },
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	let nextOverrides: TrackOverrides | null = overrides;
	let overridesChanged = false;
	const clearOverride = (key: keyof TrackOverrides): void => {
		if (!opts.clearOverrides || nextOverrides == null || !(key in nextOverrides)) return;
		if (!overridesChanged) nextOverrides = { ...nextOverrides };
		delete (nextOverrides as Record<string, unknown>)[key];
		overridesChanged = true;
	};
	// "Empty" under nullPreserve must mean the same thing on both sides of
	// the wire: exporter.ts omits Rating when Curator's value is 0 because
	// rekordbox stores "unrated" as 0, never NULL (reader.py passes that 0
	// through). Without the mirror rule here, the bootstrap pull for a
	// freshly linked track let rb's 0 overwrite Curator's stars (2026-09-15:
	// 21 tracks downloaded + rated in Curator, imported into rb, synced —
	// stars gone on both sides). The merge path passes nullPreserve=false,
	// so a genuine rb de-rate (baseline 4 → theirs 0) still pulls.
	const isEmpty = (field: SyncFieldKey): boolean => {
		const v = pull[field];
		if (v == null || v === '') return true;
		return field === 'rating' && Number(v) === 0;
	};
	const want = (field: SyncFieldKey): boolean =>
		field in pull && !(opts.nullPreserve && isEmpty(field));

	if (want('title') && pull.title != null && pull.title !== '') {
		// track.title is NOT NULL — an app-side clear to empty would be
		// nonsense data; keep Curator's title in that case.
		patch['title'] = String(pull.title);
		patch['titleAscii'] = searchFold(String(pull.title));
		clearOverride('title');
	}
	if (want('artist')) {
		// rb has a single artist string. Split it with the shared credit
		// rules so an rb-side edit lands structured, not as one packed name.
		// Comma-split then ", "-join is a fixed point on comma-joined input,
		// so a wrong split never churns rb; a ";"-joined rb artist
		// self-normalizes to ", " on the next push, once. `protect` (the
		// artist table) keeps known names with a separator whole. The
		// caller re-derives track_artist after applying the patch.
		const name = pull.artist == null ? '' : String(pull.artist);
		const artists = name === '' ? [] : splitArtistCredit(name, { protect: opts.protect });
		patch['artists'] = artists;
		patch['artistsAscii'] = artists.map((a) => searchFold(a.name)).filter(Boolean).join(' | ');
		clearOverride('artists');
	}
	if (want('album')) {
		const v = pull.album == null ? null : String(pull.album);
		patch['albumTitle'] = v;
		patch['albumTitleAscii'] = searchFold(v);
		clearOverride('albumTitle');
	}
	if (want('genre')) {
		const v = pull.genre == null ? null : String(pull.genre);
		patch['genre'] = v;
		patch['genreAscii'] = searchFold(v);
		clearOverride('genre');
	}
	if (want('label')) {
		const v = pull.label == null ? null : String(pull.label);
		patch['label'] = v;
		patch['labelAscii'] = searchFold(v);
		clearOverride('label');
	}
	if (want('rating')) patch['rating'] = pull.rating == null ? 0 : Number(pull.rating);
	if (want('comment')) patch['comment'] = pull.comment == null ? null : String(pull.comment);
	if (want('colorLabel')) patch['colorLabel'] = pull.colorLabel == null ? null : String(pull.colorLabel);

	if (overridesChanged) {
		patch['overrides'] = nextOverrides && Object.keys(nextOverrides).length > 0 ? nextOverrides : null;
	}
	return patch;
}

export interface ExistingCueRow {
	slot: number;
	positionSec: number;
	lengthSec: number | null;
	color: string | null;
	name: string | null;
	kind: 'hot' | 'memory';
	origin: 'rekordbox' | 'curator';
}

// Rebuild the track's cue rows from (ours + merge ops). Memory-cue slots
// are reassigned as ordinals-by-position after the merge — a pulled unit
// carries the app's ordinal, which may collide with a DIFFERENT curator
// cue's slot under the (trackId, slot, kind) unique key, so per-row
// upserts would silently merge two distinct cues. Wipe-and-reinsert
// sidesteps slot collisions entirely; cue ids are not referenced by any
// other table. Returns the number of ops applied.
export function applyCueOpsToTrack(
	db: Db,
	trackId: string,
	ops: Array<{ op: 'upsert' | 'delete'; unit: CueUnit }>,
	oursRows: ExistingCueRow[],
): number {
	const finalUnits = new Map<string, { unit: CueUnit; origin: 'rekordbox' | 'curator' }>();
	for (const r of oursRows) {
		const unit: CueUnit = {
			kind: r.kind,
			slot: r.slot,
			positionSec: r.positionSec,
			lengthSec: r.lengthSec ?? null,
			color: r.color ?? null,
			name: r.name ?? null,
		};
		finalUnits.set(cueUnitKey(unit), { unit, origin: r.origin });
	}
	let applied = 0;
	for (const { op, unit } of ops) {
		const key = cueUnitKey(unit);
		if (op === 'delete') finalUnits.delete(key);
		else finalUnits.set(key, { unit, origin: 'rekordbox' });
		applied++;
	}

	db.delete(cueTable).where(eq(cueTable.trackId, trackId)).run();
	const hot = [...finalUnits.values()].filter((u) => u.unit.kind === 'hot');
	const memory = [...finalUnits.values()]
		.filter((u) => u.unit.kind === 'memory')
		.sort((a, b) => a.unit.positionSec - b.unit.positionSec);
	const rows: NewCue[] = [];
	for (const { unit, origin } of hot) {
		rows.push({
			id: randomUUID(),
			trackId,
			slot: unit.slot,
			positionSec: unit.positionSec,
			lengthSec: unit.lengthSec,
			color: unit.color,
			name: unit.name,
			kind: 'hot',
			origin,
			createdAt: new Date(),
		});
	}
	memory.forEach(({ unit, origin }, i) => {
		rows.push({
			id: randomUUID(),
			trackId,
			slot: 100 + i,
			positionSec: unit.positionSec,
			lengthSec: unit.lengthSec,
			color: unit.color,
			name: unit.name,
			kind: 'memory',
			origin,
			createdAt: new Date(),
		});
	});
	for (const r of rows) db.insert(cueTable).values(r).run();
	return applied;
}
