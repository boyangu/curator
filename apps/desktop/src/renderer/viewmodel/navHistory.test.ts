// Navigation-history semantics — per-tab stacks like browser tabs: a push
// lands on its location's tab and truncates that tab's forward branch,
// re-navigating to what a tab already shows replaces instead of stacking,
// switching tabs records nothing and resumes the tab where it was, Back /
// Forward walk only the active tab, dead entries drop without losing the
// pointer, a re-keyed playlist keeps its entries everywhere, and drill-down
// parents may live on another tab. Tested through the pure reducers (not
// the live signal store) so they run without the Solid runtime — same
// convention as shell.test.ts.

import { describe, expect, it } from 'vitest';
import {
	EMPTY_HISTORY,
	activateTab,
	ancestorsOf,
	canBack,
	canForward,
	currentEntry,
	dropAt,
	go,
	locate,
	locationKey,
	makeEntry,
	push,
	replace,
	rewritePlaylistId,
	setIndex,
	stackOf,
	tabOf,
	updateRestore,
	type HistoryState,
	type NavLocation,
	type TracksScope,
} from './navHistory.js';

const tracks = (source: 'spotify' | 'rekordbox', scope: TracksScope): NavLocation => ({ kind: 'tracks', source, scope });
const playlist = (id: string, source: 'spotify' | 'rekordbox' = 'spotify'): NavLocation => tracks(source, { type: 'playlist', id });
const jit = (query: string, source: 'spotify' | 'rekordbox' = 'spotify'): NavLocation => tracks(source, { type: 'jit', jit: { name: query, query } });
const all = (source: 'spotify' | 'rekordbox' = 'spotify'): NavLocation => tracks(source, { type: 'all' });
const feed: NavLocation = { kind: 'discover', mode: 'feed', archived: false, genre: null, label: null };
const pinned: NavLocation = { kind: 'tag', view: 'interested' };

const keys = (s: HistoryState, tab: Parameters<typeof stackOf>[1]): string[] =>
	(stackOf(s, tab)?.entries ?? []).map((e) => locationKey(e.location));

function stack(...locs: NavLocation[]): HistoryState {
	let s: HistoryState = EMPTY_HISTORY;
	for (const loc of locs) s = push(s, makeEntry(loc, locationKey(loc)));
	return s;
}

describe('locationKey / tabOf', () => {
	it('keys a JIT by its query, not its name or pin', () => {
		const a: NavLocation = tracks('spotify', { type: 'jit', jit: { name: 'Artist: Fink', query: 'artistid={1}' } });
		const b: NavLocation = tracks('spotify', { type: 'jit', jit: { name: 'Fink (pinned)', query: 'artistid={1}', pinnedId: 'p1' } });
		expect(locationKey(a)).toBe(locationKey(b));
	});

	it('separates the Discover sub-states', () => {
		const archived: NavLocation = { kind: 'discover', mode: 'feed', archived: true, genre: null, label: null };
		const genre: NavLocation = { kind: 'discover', mode: 'feed', archived: false, genre: 'House', label: null };
		const node: NavLocation = { kind: 'discover', mode: 'journeys', journeyId: 'j1', nodeId: 'n2' };
		expect(new Set([feed, archived, genre, node].map(locationKey)).size).toBe(4);
	});

	it('maps every location onto its top-strip tab', () => {
		expect(tabOf(playlist('a', 'rekordbox'))).toBe('rekordbox');
		expect(tabOf(pinned)).toBe('interested');
		expect(tabOf(feed)).toBe('discover');
		expect(tabOf({ kind: 'sync' })).toBe('sync');
	});
});

describe('push', () => {
	it('seeds a tab, appends after its current entry and activates it', () => {
		const s = stack(all(), playlist('a'));
		expect(s.activeTab).toBe('spotify');
		expect(currentEntry(s)?.location).toEqual(playlist('a'));
		expect(canBack(s)).toBe(true);
		expect(canForward(s)).toBe(false);
	});

	it('lands on the location\'s own tab, leaving the other tabs untouched', () => {
		let s = stack(all(), playlist('a'));
		s = push(s, makeEntry(feed, 'feed'));
		expect(s.activeTab).toBe('discover');
		expect(keys(s, 'spotify')).toEqual([locationKey(all()), locationKey(playlist('a'))]);
		expect(keys(s, 'discover')).toEqual([locationKey(feed)]);
		expect(canBack(s)).toBe(false); // Discover's own stack has one entry
	});

	it('truncates the tab\'s forward branch when pushing after going back', () => {
		let s = stack(all(), playlist('a'), playlist('b'));
		s = go(s, -1);
		s = go(s, -1);
		expect(canForward(s)).toBe(true);
		s = push(s, makeEntry(playlist('c'), 'c'));
		expect(keys(s, 'spotify')).toEqual([locationKey(all()), locationKey(playlist('c'))]);
		expect(canForward(s)).toBe(false);
	});

	it('replaces instead of stacking when navigating to what the tab already shows, keeping its restore state', () => {
		let s = stack(all(), playlist('a'));
		s = updateRestore(s, { scrollTop: 420 });
		s = push(s, makeEntry(playlist('a'), 'a again'));
		expect(keys(s, 'spotify')).toHaveLength(2);
		expect(currentEntry(s)?.label).toBe('a again');
		expect(currentEntry(s)?.restore).toEqual({ scrollTop: 420 });
	});

	it('evicts the oldest entries of a tab past the cap', () => {
		let s: HistoryState = EMPTY_HISTORY;
		for (let i = 0; i < 6; i++) s = push(s, makeEntry(playlist(`p${i}`), `p${i}`), 4);
		expect(stackOf(s, 'spotify')?.entries.map((e) => e.label)).toEqual(['p2', 'p3', 'p4', 'p5']);
		expect(stackOf(s, 'spotify')?.index).toBe(3);
	});
});

describe('tab switching (the user\'s scenario)', () => {
	it('drill → Discover → back to the source tab → Back lands on the pre-drill scope, not Discover', () => {
		let s = stack(playlist('x', 'rekordbox'));
		s = push(s, makeEntry(jit('artistid={1}', 'rekordbox'), 'Artist', { parentId: currentEntry(s)!.id }));
		s = push(s, makeEntry(feed, 'Discover'));           // Discover tab click (first visit seeds it)
		s = activateTab(s, 'rekordbox');                      // Rekordbox tab click — no entry recorded
		expect(currentEntry(s)?.location).toEqual(jit('artistid={1}', 'rekordbox'));
		s = go(s, -1);
		expect(currentEntry(s)?.location).toEqual(playlist('x', 'rekordbox'));
		expect(canForward(s)).toBe(true);
		expect(keys(s, 'discover')).toEqual([locationKey(feed)]);
	});

	it('activating a tab with no history is a no-op (the caller seeds it)', () => {
		const s = stack(all());
		expect(activateTab(s, 'discover')).toBe(s);
	});
});

describe('replace / go / setIndex', () => {
	it('replace swaps the tab\'s current entry in place and seeds an empty tab', () => {
		expect(replace(EMPTY_HISTORY, makeEntry(all(), 'all')).activeTab).toBe('spotify');
		let s = stack(all(), playlist('a'));
		s = replace(s, makeEntry(playlist('z'), 'z'));
		expect(keys(s, 'spotify')).toHaveLength(2);
		expect(currentEntry(s)?.label).toBe('z');
	});

	it('go clamps at both ends of the active tab', () => {
		let s = stack(all(), playlist('a'));
		s = go(s, 1);
		expect(stackOf(s, 'spotify')?.index).toBe(1);
		s = go(s, -1);
		s = go(s, -1);
		expect(stackOf(s, 'spotify')?.index).toBe(0);
		expect(canBack(s)).toBe(false);
		expect(setIndex(s, 'spotify', 7)).toBe(s);
	});
});

describe('dropAt', () => {
	it('keeps the pointer on the same entry when a lower entry is removed', () => {
		let s = stack(all(), playlist('a'), playlist('b'));
		s = dropAt(s, 'spotify', 1);
		expect(keys(s, 'spotify')).toEqual([locationKey(all()), locationKey(playlist('b'))]);
		expect(stackOf(s, 'spotify')?.index).toBe(1);
	});

	it('slides onto the next entry when the current one is removed, clamping at the end', () => {
		let s = stack(all(), playlist('a'), playlist('b'));
		s = go(s, -1);
		s = dropAt(s, 'spotify', 1);
		expect(currentEntry(s)?.label).toBe(locationKey(playlist('b')));
		s = dropAt(s, 'spotify', 1);
		expect(currentEntry(s)?.label).toBe(locationKey(all()));
	});

	it('drops an emptied tab\'s stack', () => {
		let s = stack(all());
		s = push(s, makeEntry(feed, 'feed'));
		s = dropAt(s, 'discover', 0);
		expect(stackOf(s, 'discover')).toBeNull();
		expect(s.activeTab).toBeNull();
	});
});

describe('drill-down tree (parentId / ancestorsOf / locate)', () => {
	const drill = (s: HistoryState, loc: NavLocation): HistoryState =>
		push(s, makeEntry(loc, locationKey(loc), { parentId: currentEntry(s)!.id }));

	it('builds the ancestor chain root-first and leaves roots bare', () => {
		let s = stack(all(), playlist('x'));
		s = drill(s, jit('artistid={1}'));
		s = drill(s, jit('similar={t}'));
		expect(ancestorsOf(s, currentEntry(s)!).map((e) => locationKey(e.location)))
			.toEqual([locationKey(playlist('x')), locationKey(jit('artistid={1}'))]);
		expect(ancestorsOf(s, stackOf(s, 'spotify')!.entries[1]!)).toEqual([]);
	});

	it('follows a parent on another tab (artist drilled from Pinned)', () => {
		let s = stack(all());
		s = push(s, makeEntry(pinned, 'Interested'));
		s = drill(s, jit('artistid={1}'));
		expect(s.activeTab).toBe('spotify');
		expect(ancestorsOf(s, currentEntry(s)!).map((e) => e.label)).toEqual(['Interested']);
		expect(locate(s, currentEntry(s)!.parentId!)).toEqual({ tab: 'interested', index: 0 });
	});

	it('stops the chain at a parent that fell off the stack', () => {
		let s = stack(all(), playlist('x'));
		s = drill(s, jit('a'));
		s = drill(s, jit('b'));
		s = dropAt(s, 'spotify', 1); // the playlist root is gone
		expect(ancestorsOf(s, currentEntry(s)!).map((e) => e.label)).toEqual([locationKey(jit('a'))]);
	});

	it('drilling onto the scope already open keeps its identity and parent', () => {
		let s = stack(all(), playlist('x'));
		s = drill(s, jit('artistid={1}'));
		const before = currentEntry(s)!;
		s = drill(s, jit('artistid={1}')); // same artist chip clicked again
		const after = currentEntry(s)!;
		expect(keys(s, 'spotify')).toHaveLength(3);
		expect(after.id).toBe(before.id);
		expect(after.parentId).toBe(before.parentId);
	});

	it('a root navigation after a drill starts a new chain', () => {
		let s = stack(all(), playlist('x'));
		s = drill(s, jit('a'));
		s = push(s, makeEntry(playlist('y'), 'y'));
		expect(currentEntry(s)!.parentId).toBeNull();
		expect(ancestorsOf(s, currentEntry(s)!)).toEqual([]);
	});
});

describe('rewritePlaylistId', () => {
	it('re-keys every entry scoped to the old playlist on every tab and leaves the rest untouched', () => {
		let s = stack(all(), playlist('old'), playlist('other'));
		s = push(s, makeEntry(playlist('old', 'rekordbox'), 'rb old'));
		const r = rewritePlaylistId(s, 'old', 'new');
		expect(keys(r, 'spotify')).toEqual([locationKey(all()), locationKey(playlist('new')), locationKey(playlist('other'))]);
		expect(keys(r, 'rekordbox')).toEqual([locationKey(playlist('new', 'rekordbox'))]);
		expect(r.activeTab).toBe(s.activeTab);
		expect(rewritePlaylistId(s, 'missing', 'x')).toBe(s);
	});
});
