// The rekordbox check: rb/ after the push against rb-reference/ (the copy
// taken with it, i.e. "the real db"), restricted to the content rows
// Curator links and to the fields Curator writes. Both sides come from
// py/rb_dump.py (read-only). Normalised away, by nature: ids and UUIDs,
// USNs, timestamps, InFrame, TrackNo renumbering (playlist order is compared
// as the relative order of linked members), relation rows re-created for
// tombstoned ones (relations are compared by name). Not compared at all:
// what Curator never writes (BPM, key, ANLZ, play counts, history, the
// sampler, smart rules, the folder tree) and every unlinked content row.

import { parseTagComment } from '@curator/core/e2e';
import type { Classified, DiffClass, RbDiffItem } from './classify.js';
import { DIFF_SAMPLE, takeSample, type DiffRow } from './compare.js';

export type RbDump = {
	// keyCamelot / updatedAtMs are read for the classification (classify.ts),
	// never compared: Curator does not write the key, and the stamp moves on
	// every write.
	contents: Record<string, { title: string | null; artist: string | null; album: string | null; label: string | null; genre: string | null; rating: number | null; comment: string | null; colorId: string | null; deleted: number; path: string | null; keyCamelot?: string | null; updatedAtMs?: number | null }>;
	cues: Record<string, Array<[number, number, number | null, number | null, string]>>;
	myTags: Record<string, string[]>;
	playlists: Array<{ id: string; name: string | null; attribute: number | null; parentId: string | null; deleted: number; smart: boolean; members: string[] }>;
};

export type RbFieldCounts = Record<string, number>;
// `byClass`: per class, per field (classify.ts); without a classifier every
// difference is a failure.
export type RbDiff = { equal: boolean; linked: number; compared: number; missing: { pushed: number; reference: number }; fields: RbFieldCounts; byClass: Record<DiffClass, RbFieldCounts>; rows: DiffRow[] };

const s = (v: string | null | undefined): string => (v ?? '').trim();

function contentView(d: RbDump, id: string): Record<string, unknown> | null {
	const c = d.contents[id];
	if (!c) return null;
	const parsed = parseTagComment(c.comment);
	return {
		title: s(c.title),
		artist: s(c.artist),
		album: s(c.album),
		label: s(c.label),
		genre: s(c.genre),
		rating: c.rating ?? 0,
		commentText: s(parsed.prefix),
		// Order-insensitive: rekordbox appends in add order, Curator keeps
		// existing tokens in place (tag-comment.ts); the set is what search sees.
		commentTags: parsed.tokens === null ? null : [...parsed.tokens].sort(),
		colorId: c.colorId === null || c.colorId === '' ? '0' : c.colorId,
		deleted: c.deleted ? 1 : 0,
		cues: (d.cues[id] ?? []).map(([kind, inMs, outMs, cti, comment]) => `${kind}|${inMs}|${outMs ?? -1}|${cti ?? 0}|${comment ?? ''}`).sort(),
		myTags: [...(d.myTags[id] ?? [])].sort(),
	};
}

export function diffRekordbox(pushed: RbDump, reference: RbDump, linked: readonly string[], sample = DIFF_SAMPLE, classify?: (d: RbDiffItem) => Classified): RbDiff {
	const all: DiffRow[] = [];
	const fields: RbFieldCounts = {};
	const byClass: Record<DiffClass, RbFieldCounts> = { expected: {}, artefact: {}, failure: {} };
	const unclassified: Classified = { class: 'failure', note: 'not classified' };
	// One difference: counted per field and per class, kept for the sample.
	const note = (f: string, row: Omit<DiffRow, 'class' | 'note'>, item: RbDiffItem | null): void => {
		fields[f] = (fields[f] ?? 0) + 1;
		const c = item && classify ? classify(item) : unclassified;
		byClass[c.class][f] = (byClass[c.class][f] ?? 0) + 1;
		all.push({ ...row, class: c.class, note: c.note });
	};
	const ids = [...new Set(linked)].sort();
	const missing = { pushed: 0, reference: 0 };
	let compared = 0;
	for (const id of ids) {
		const a = contentView(pushed, id);
		const b = contentView(reference, id);
		if (!a || !b) {
			if (!a) missing.pushed++;
			if (!b) missing.reference++;
			note('content-missing', { table: 'content', key: id, left: a, right: b }, null);
			continue;
		}
		compared++;
		for (const f of Object.keys(a)) {
			if (JSON.stringify(a[f]) === JSON.stringify(b[f])) continue;
			note(f, { table: `content.${f}`, key: id, left: a[f], right: b[f] }, { kind: 'content', contentId: id, field: f, pushed: a[f], reference: b[f] });
		}
	}
	// Playlists: live, non-folder (Attribute 1), non-smart (Attribute 4 /
	// SmartList), by id — name, and the linked members in their relative order.
	const linkedSet = new Set(ids);
	const view = (d: RbDump): Map<string, { name: string; members: string[] }> => new Map(d.playlists
		.filter((p) => !p.deleted && p.attribute !== 1 && p.attribute !== 4 && !p.smart)
		.map((p) => [p.id, { name: s(p.name), members: p.members.filter((m) => linkedSet.has(m)) }]));
	const pa = view(pushed);
	const pb = view(reference);
	for (const id of [...new Set([...pa.keys(), ...pb.keys()])].sort()) {
		const a = pa.get(id);
		const b = pb.get(id);
		if (!a || !b) {
			note('playlist-missing', { table: 'playlist', key: id, left: a ?? null, right: b ?? null }, null);
			continue;
		}
		if (a.name !== b.name) {
			note('playlist.name', { table: 'playlist.name', key: id, left: a.name, right: b.name }, { kind: 'playlist', playlistId: id, field: 'playlist.name', pushed: a.name, reference: b.name });
		}
		if (JSON.stringify(a.members) !== JSON.stringify(b.members)) {
			const f = new Set(a.members).size === new Set(b.members).size && a.members.every((m) => b.members.includes(m)) ? 'playlist.order' : 'playlist.members';
			note(f, { table: 'playlist.members', key: `${id} (${a.name})`, left: a.members, right: b.members }, { kind: 'playlist', playlistId: id, field: f, pushed: a.members, reference: b.members });
		}
	}
	return { equal: Object.keys(fields).length === 0, linked: ids.length, compared, missing, fields, byClass, rows: takeSample(all, sample) };
}
