import { describe, expect, it } from 'vitest';
import { ANALYSIS_COLUMNS, LIST_PROFILES, profileHides } from './listProfile.js';
import { ALL_COLUMNS, oneLineColumns, twoLineColumns, type Column } from './track-list.js';
import type { GroupBy } from './trackGroups.js';

// What the list's owner lets through, with every user column switched on.
const shown = (ctx: keyof typeof LIST_PROFILES, groupBy: GroupBy): Column[] =>
	ALL_COLUMNS.filter((c) => c !== 'match' && !profileHides(LIST_PROFILES[ctx], c, groupBy));

describe('list profiles', () => {
	it('leaves the library list to the user: nothing hidden, no room around it', () => {
		const p = LIST_PROFILES.library;
		for (const g of ['none', 'artist', 'album', 'label'] as GroupBy[]) expect(shown('library', g)).toEqual(ALL_COLUMNS.filter((c) => c !== 'match'));
		expect([p.gutter, p.groupIndent]).toEqual([0, 0]);
	});

	it('shows a Discover page without the user\'s curation or the analyzer\'s measurements', () => {
		const cols = shown('discover', 'none');
		for (const c of ['added', 'rating', 'tags', ...ANALYSIS_COLUMNS] as Column[]) expect(cols).not.toContain(c);
		// What a release says about itself stays — BPM and key included.
		expect(cols).toEqual(['src', 'idx', 'art', 'title', 'artist', 'album', 'rel', 'label', 'genre', 'bpm', 'key', 'time']);
		expect([LIST_PROFILES.discover.gutter, LIST_PROFILES.discover.groupIndent]).toEqual([48, 24]);
	});

	it('drops what an album header already says from the rows under it, and only there', () => {
		expect(shown('discover', 'album')).toEqual(['src', 'idx', 'art', 'title', 'artist', 'genre', 'bpm', 'key', 'time']);
		expect(shown('discover', 'label')).toContain('album');
		expect(shown('discover', 'artist')).toContain('rel');
	});

	it('leaves the two-line layout without the label / released pair and the added date on an album-grouped page', () => {
		const visible = (c: Column): boolean => !profileHides(LIST_PROFILES.discover, c, 'album');
		expect(twoLineColumns(visible, { groupBy: 'album', match: false })).toEqual(['src', 'idx', 'title2', 'genretags', 'keyfx', 'timerating']);
		const ungrouped = (c: Column): boolean => !profileHides(LIST_PROFILES.discover, c, 'none');
		expect(twoLineColumns(ungrouped, { groupBy: 'none', match: false })).toEqual(['src', 'idx', 'art', 'title2', 'labelrel', 'genretags', 'keyfx', 'timerating']);
	});

	it('leaves the one-line layout without the cover under album grouping — the header carries it — in the library too', () => {
		const all = (): boolean => true;
		expect(oneLineColumns(ALL_COLUMNS, all, { groupBy: 'album', match: false })).not.toContain('art');
		expect(oneLineColumns(ALL_COLUMNS, all, { groupBy: 'label', match: false })).toContain('art');
		const visible = (c: Column): boolean => !profileHides(LIST_PROFILES.discover, c, 'album');
		expect(oneLineColumns(ALL_COLUMNS, visible, { groupBy: 'album', match: false })).toEqual(['src', 'idx', 'title', 'artist', 'genre', 'bpm', 'key', 'time']);
		// Match is the scope's, not a user column.
		expect(oneLineColumns(ALL_COLUMNS, all, { groupBy: 'none', match: true })).toContain('match');
	});
});
