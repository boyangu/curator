// What the track list looks like is decided by what owns it. The list itself
// is one component (track-list.ts) that takes columns, fields and spacing;
// a profile is the owner's say over those, on top of the user's own column
// choices: fields the context never shows, fields a grouping makes redundant
// there (the group's header already says them), and the room around the rows.
//
// Two owners today: the library (every tab's list — the user's columns,
// edge to edge) and Discover (an artist / label / album page — a catalogue
// read, not a working list: nothing of the user's own curation or analysis).

import type { Column } from './track-list.js';
import type { GroupBy } from './trackGroups.js';

export type ListContext = 'library' | 'discover';

export interface ListProfile {
	// Never shown here, whatever the user's column choices say.
	hidden: ReadonlySet<Column>;
	// Dropped from the ROWS under a grouping; the group headers keep them.
	hiddenInGroup: Partial<Record<GroupBy, ReadonlySet<Column>>>;
	// Room left and right of the whole list (px), and how much further in a
	// group's rows sit than its header.
	gutter: number;
	groupIndent: number;
	// Source marks set against the index number instead of the row's edge.
	sourcesByIndex: boolean;
}

// The analyzer's measurements. BPM and key are not in here: on a page they
// are the stores' facts about a release as much as an analysis result.
export const ANALYSIS_COLUMNS: readonly Column[] = ['lra', 'diss', 'dens', 'bright', 'power', 'punch', 'loud', 'plr', 'prodq', 'pq'];

export const LIST_PROFILES: Record<ListContext, ListProfile> = {
	library: { hidden: new Set(), hiddenInGroup: {}, gutter: 0, groupIndent: 0, sourcesByIndex: false },
	discover: {
		hidden: new Set<Column>(['added', 'rating', 'tags', ...ANALYSIS_COLUMNS]),
		hiddenInGroup: { album: new Set<Column>(['album', 'label', 'rel']) },
		gutter: 48,
		groupIndent: 24,
		sourcesByIndex: true,
	},
};

export function profileHides(profile: ListProfile, column: Column, groupBy: GroupBy): boolean {
	return profile.hidden.has(column) || (profile.hiddenInGroup[groupBy]?.has(column) ?? false);
}
