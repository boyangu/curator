// One track in one slot of one release, across stores. Without ISRCs
// (Spotify's and Bandcamp's tracklists carry none) the catalogue's title +
// artists rule misses whenever the stores credit differently — Spotify names
// the featured artist, Deezer the main one only, Bandcamp none — and one
// track becomes two recordings on the same slot (2026-11-09, Marsh "Home":
// "Run Away" by Marsh and by Marsh, ALLKNIGHT, 267.0 s and 267.2 s, both at
// position 3). Within one release the evidence is stronger than the credits:
// the same title in the same slot, or with a length within three seconds, is
// the same track. The rule is shared by ingestion (ingest.ts candidate, when a
// track arrives inside a release the catalogue holds), the store linker and
// the fill (store-links.ts joinTracks) and the dedupe sweep
// (release-fill.ts dedupeRelease), so they agree on what one track is.

import { nameFold } from '@curator/library-logic';
import type { Queryable } from '../db/db.js';
import { numOrNull } from '../db/db.js';

export type HeldTrack = { id: string; name: string; durationSec: number | null; position: number | null };

// A title with its credits ("ft. JAW", "feat. …") and bracket tags ("[Heimlich
// Musik]") set aside, and "Title - Mix" read as "Title (Mix)".
export const coreTitle = (t: string): string =>
	t.toLowerCase().normalize('NFKD').replace(/\[[^\]]*\]/g, ' ').replace(/\b(?:ft|feat|featuring)\.?\s+[^()[\]-]+/g, ' ').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// One track's two titles: equal at their core, one holding the other ("Low
// Tide" in "Low Tide (Radio Edit)"), or a typo apart ("Nostagia 92"). Two
// different tracks in one slot — a compilation's discs both number from 1
// (2026-10-31, Anjunadeep 07: "Glass Voices" and "Red Sky") — are none of these.
export function sameTrackTitle(a: string, b: string): boolean {
	const [x, y] = [coreTitle(a), coreTitle(b)];
	if (!x || !y) return false;
	if (x === y || x.includes(y) || y.includes(x)) return true;
	let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
	for (let i = 1; i <= x.length; i++) {
		const cur = [i];
		for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[y.length]! <= Math.max(1, Math.floor(Math.max(x.length, y.length) * 0.15));
}

// A track title compared within a release: without a leading "Artist - " (a
// label's Bandcamp account titles its tracks that way).
export function trackFold(title: string, artistFolds: readonly string[]): string {
	const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(title);
	if (m && artistFolds.some((a) => nameFold(m[1]!).includes(a))) return m[2]!;
	return title;
}

export type SlotProbe = { title: string; position: number | null | undefined; durationSec: number | null | undefined };

// The one held track a store's track is, or null: the same title (credits
// and tags aside) in the same slot or within three seconds; a title that only
// holds the other ("Low Tide (Radio Edit)") or is a typo apart needs the slot
// and the length both — "Glass Rivers (Dub)" is another track until its slot
// and length say otherwise. `anyTitle` also takes the same slot
// within two seconds whatever the title (Bandcamp retitles: "… (Featuring
// X)", a cut-short "Losing Someone") — the fill's rule, for a store read onto
// a release already known to be the same. Anything less clear, or more than
// one fit, is left to the identity rules.
export function slotMatch(held: readonly HeldTrack[], probe: SlotProbe, artistFolds: readonly string[], opts: { anyTitle?: boolean } = {}): HeldTrack | null {
	const title = trackFold(probe.title, artistFolds);
	const core = coreTitle(title);
	const len = probe.durationSec ?? null;
	const pos = probe.position ?? null;
	const hits = held.filter((h) => {
		const d = h.durationSec;
		const near = len !== null && d !== null && Math.abs(d - len) <= 3;
		const samePos = pos !== null && h.position === pos;
		if (opts.anyTitle && samePos && len !== null && d !== null && Math.abs(d - len) <= 2) return true;
		const theirs = trackFold(h.name, artistFolds);
		if (core && coreTitle(theirs) === core) return samePos || near;
		return samePos && near && sameTrackTitle(theirs, title);
	});
	return hits.length === 1 ? hits[0]! : null;
}

// The live recordings a release holds, with their slots.
export async function heldTracks(tx: Queryable, releaseId: string): Promise<HeldTrack[]> {
	const rows = await tx.query<{ id: string; name: string; duration_sec: unknown; position: unknown }>(
		`select o.id, o.name, o.duration_sec, e.position from curator.catalog_edge e join curator.catalog_object o on o.id = e.dst and o.merged_into is null
		where e.src = $1 and e.kind = 'release-recording' order by e.position nulls last, o.id`,
		[releaseId],
	);
	return rows.map((r) => ({ id: r.id, name: r.name, durationSec: numOrNull(r.duration_sec), position: numOrNull(r.position) }));
}
