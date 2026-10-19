// Track-list grouping model — pure. Turns the caller's sorted track list
// into the flat DISPLAY list the virtualized table renders: group header
// rows interleaved with track rows, collapsed groups' tracks left out.
// Built once per (tracks, groupBy, collapsed) change — never on scroll or
// selection — and O(n).
//
// Rules (product decisions 2026-10-16):
//   • Groups follow the active sort: a group sits where its first track
//     falls in the sorted list (Added ↓ puts the newest release first; a
//     playlist's custom order keeps first-appearance order; sorting by
//     title / artist / label reads A–Z). The missing-value group is last.
//   • Album groups play in album order: members with a known disc / track
//     number come first in that order, the rest keep the sort.
//   • A collapsed group's tracks are NOT in `visibleTracks` — keyboard
//     navigation, range selection, select-all and the play queue all work
//     over what's on screen.

import type { Track } from '@curator/shared';
import { searchFold } from '@curator/shared';

export type GroupBy = 'none' | 'artist' | 'album' | 'label';
export const GROUP_BY_VALUES: readonly GroupBy[] = ['none', 'artist', 'album', 'label'];

export interface GroupStats {
	count: number;
	durationSec: number;
	bpmLo: number | null;
	bpmHi: number | null;
	// Up to 3 distinct Camelot keys, in member order.
	keys: string[];
	// Distinct releases (album id, else folded title) — the artist header's
	// "N releases".
	releaseCount: number;
	// Distinct labels / main artists / genres, most frequent first.
	labels: string[];
	artistNames: string[];
	genres: string[];
}

export interface GroupInfo {
	// Unique across fields: `<field>:<identity>`.
	key: string;
	field: Exclude<GroupBy, 'none'>;
	title: string;
	// The "No artist / album / label" bucket.
	missing: boolean;
	albumId: string | null;
	// Members in display order (all of them, collapsed or not).
	tracks: Track[];
	stats: GroupStats;
}

export type DisplayRow =
	| { kind: 'group'; group: GroupInfo; first: boolean; collapsed: boolean }
	| { kind: 'track'; track: Track; trackIndex: number };

export interface DisplayList {
	rows: DisplayRow[];
	// Tracks on screen, in display order. `trackIndex` indexes this.
	visibleTracks: Track[];
	// visibleTracks index → rows index.
	trackRow: number[];
	groups: GroupInfo[];
	// Group key → rows index of its header.
	groupRow: Map<string, number>;
	// Track id → group key (every track, collapsed included).
	groupOfTrack: Map<string, string>;
}

const MISSING_TITLE: Record<Exclude<GroupBy, 'none'>, string> = {
	artist: 'No artist',
	album: 'No album',
	label: 'No label',
};

// The credit a track is filed under: its first artist that isn't a remixer
// or a featured guest (Spotify / Tidal write no roles — usually the first).
export function mainArtistOf(t: Track): { name: string; id: string | null } | null {
	const list = t.artists ?? [];
	let idx = list.findIndex((a) => a && a.name && a.role !== 'remixer' && a.role !== 'featured');
	if (idx < 0) idx = list.findIndex((a) => a && a.name);
	if (idx < 0) return null;
	return { name: list[idx]!.name.trim(), id: t.artistIds?.[idx] ?? null };
}

export function groupIdentity(t: Track, by: Exclude<GroupBy, 'none'>): { key: string; title: string; missing: boolean; albumId: string | null } {
	if (by === 'artist') {
		const a = mainArtistOf(t);
		if (!a || !a.name) return { key: 'artist:', title: MISSING_TITLE.artist, missing: true, albumId: null };
		return { key: `artist:${a.id ?? `n:${searchFold(a.name)}`}`, title: a.name, missing: false, albumId: null };
	}
	if (by === 'album') {
		const title = (t.albumTitle ?? '').trim();
		if (t.albumId) return { key: `album:${t.albumId}`, title: title || MISSING_TITLE.album, missing: false, albumId: t.albumId };
		if (!title) return { key: 'album:', title: MISSING_TITLE.album, missing: true, albumId: null };
		const main = mainArtistOf(t);
		return { key: `album:t:${searchFold(title)}|${main ? searchFold(main.name) : ''}`, title, missing: false, albumId: null };
	}
	const label = (t.label ?? '').trim();
	if (!label) return { key: 'label:', title: MISSING_TITLE.label, missing: true, albumId: null };
	return { key: `label:${searchFold(label)}`, title: label, missing: false, albumId: null };
}

// Distinct non-empty values, most frequent first, ties in first-seen order.
function ranked(values: Iterable<string | null | undefined>): string[] {
	const counts = new Map<string, number>();
	for (const v of values) {
		const t = (v ?? '').trim();
		if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

export function groupStats(tracks: readonly Track[]): GroupStats {
	let durationSec = 0;
	let bpmLo: number | null = null;
	let bpmHi: number | null = null;
	const keys: string[] = [];
	const releases = new Set<string>();
	for (const t of tracks) {
		durationSec += t.duration ?? 0;
		if (t.bpm != null && Number.isFinite(t.bpm) && t.bpm > 0) {
			const b = Math.round(t.bpm);
			bpmLo = bpmLo == null ? b : Math.min(bpmLo, b);
			bpmHi = bpmHi == null ? b : Math.max(bpmHi, b);
		}
		if (t.keyCamelot && keys.length < 3 && !keys.includes(t.keyCamelot)) keys.push(t.keyCamelot);
		const rel = t.albumId ?? ((t.albumTitle ?? '').trim() ? `t:${searchFold(t.albumTitle)}` : '');
		if (rel) releases.add(rel);
	}
	return {
		count: tracks.length,
		durationSec,
		bpmLo,
		bpmHi,
		keys,
		releaseCount: releases.size,
		labels: ranked(tracks.map((t) => t.label)),
		artistNames: ranked(tracks.map((t) => mainArtistOf(t)?.name)),
		genres: ranked(tracks.map((t) => t.genre)),
	};
}

// Album order inside an album group: numbered members first by (disc,
// track), the unnumbered rest after them in sort order. Stable.
function albumOrder(tracks: Track[]): Track[] {
	if (!tracks.some((t) => t.trackNumber != null)) return tracks;
	const numbered = tracks.filter((t) => t.trackNumber != null);
	const rest = tracks.filter((t) => t.trackNumber == null);
	numbered.sort((a, b) => ((a.discNumber ?? 1) - (b.discNumber ?? 1)) || ((a.trackNumber ?? 0) - (b.trackNumber ?? 0)));
	return [...numbered, ...rest];
}

export function buildDisplayList(tracks: readonly Track[], by: GroupBy, collapsed: ReadonlySet<string> = new Set()): DisplayList {
	if (by === 'none') {
		const visibleTracks = tracks as Track[];
		return {
			rows: visibleTracks.map((track, trackIndex) => ({ kind: 'track', track, trackIndex })),
			visibleTracks,
			trackRow: visibleTracks.map((_, i) => i),
			groups: [],
			groupRow: new Map(),
			groupOfTrack: new Map(),
		};
	}
	const byKey = new Map<string, { id: ReturnType<typeof groupIdentity>; tracks: Track[] }>();
	const order: string[] = [];
	const groupOfTrack = new Map<string, string>();
	for (const t of tracks) {
		const id = groupIdentity(t, by);
		let g = byKey.get(id.key);
		if (!g) {
			g = { id, tracks: [] };
			byKey.set(id.key, g);
			order.push(id.key);
		}
		g.tracks.push(t);
		groupOfTrack.set(t.id, id.key);
	}
	// The missing-value bucket sinks to the end; everything else keeps the
	// position of its first sorted track.
	const keys = [...order.filter((k) => !byKey.get(k)!.id.missing), ...order.filter((k) => byKey.get(k)!.id.missing)];

	const rows: DisplayRow[] = [];
	const visibleTracks: Track[] = [];
	const trackRow: number[] = [];
	const groups: GroupInfo[] = [];
	const groupRow = new Map<string, number>();
	keys.forEach((key, gi) => {
		const g = byKey.get(key)!;
		const members = by === 'album' ? albumOrder(g.tracks) : g.tracks;
		const info: GroupInfo = {
			key,
			field: by,
			title: g.id.title,
			missing: g.id.missing,
			albumId: g.id.albumId,
			tracks: members,
			stats: groupStats(members),
		};
		groups.push(info);
		const isCollapsed = collapsed.has(key);
		groupRow.set(key, rows.length);
		rows.push({ kind: 'group', group: info, first: gi === 0, collapsed: isCollapsed });
		if (isCollapsed) return;
		for (const track of members) {
			trackRow.push(rows.length);
			rows.push({ kind: 'track', track, trackIndex: visibleTracks.length });
			visibleTracks.push(track);
		}
	});
	return { rows, visibleTracks, trackRow, groups, groupRow, groupOfTrack };
}

// ─── Row geometry — the one source of truth for row heights ────────────────
// The virtualizer never measures (estimateSize IS the layout), so these must
// match the CSS exactly: track rows get `--row-h` from the same number, group
// header rows carry their height inline.
export type RowLines = 1 | 2;
export const TRACK_ROW_H: Record<RowLines, number> = { 1: 30, 2: 52 };
export const GROUP_HEAD_H = 56;
export const ALBUM_HEAD_H = 84;
// Breathing room above every group after the first (it sits inside the
// header row, above its top rule).
export const GROUP_GAP_H = 28;

export function groupHeadInnerHeight(field: Exclude<GroupBy, 'none'>): number {
	return field === 'album' ? ALBUM_HEAD_H : GROUP_HEAD_H;
}

export function rowHeight(row: DisplayRow, lines: RowLines): number {
	if (row.kind === 'track') return TRACK_ROW_H[lines];
	return groupHeadInnerHeight(row.group.field) + (row.first ? 0 : GROUP_GAP_H);
}
