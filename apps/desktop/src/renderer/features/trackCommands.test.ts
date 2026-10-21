// The track context menu's shape is a product spec (order, groups, submenus,
// mnemonics), so pin it: build the menu for representative selections.
import { describe, expect, it, vi } from 'vitest';
import type { Track } from '@curator/shared';

vi.mock('../data/api.js', async (importOriginal) => ({
	...(await importOriginal<object>()),
	mirApi: { similar: async () => ({ model: 'm', items: [], missingSeeds: [] }), analyzeNow: async () => ({ queued: 0 }) },
}));

import { buildTrackMenu, initTrackCommands, runTrackCommand, trackCommandAvailable, type TrackCommandContext } from './trackCommands.js';
import type { ContextMenusFeatureDeps } from './contextMenus.js';
import type { ContextMenuItem } from '../components/ContextMenu.jsx';
import { isRemoteRow, REMOTE_ONLY_REASON, remoteMarkSource, remoteRowTitle } from '../remoteRows.js';

const track = (sources: string[], extra: Partial<Track> = {}): Track =>
	({ id: `t-${sources.join('-')}`, title: 'Mother Nature', artists: [{ name: 'Solee' }], sources, ...extra }) as unknown as Track;

const shape = (ctx: TrackCommandContext): string[] =>
	buildTrackMenu(ctx).items.map((i) => {
		if (i.kind === 'divider') return '--';
		if (i.kind === 'header') return `# ${i.label}`;
		if (i.kind === 'submenu') return `${i.label} > ${i.items.map((c) => (c.kind === 'item' ? c.label : '?')).join(' | ')}`;
		if (i.kind === 'item') return i.mnemonic ? `${i.label} [${i.mnemonic}]` : i.label;
		return '?';
	});

describe('track context menu', () => {
	it('local track in a playlist: spec order, groups, submenus, mnemonics', () => {
		const t = track(['local', 'spotify', 'rekordbox']);
		const ctx: TrackCommandContext = {
			tracks: [t], view: 'tracks', source: 'rekordbox' as never, tagIds: new Set(),
			drillPlaylists: [], playlist: { id: 'p1', name: 'night', source: 'local' } as never,
		};
		expect(shape(ctx)).toEqual([
			'# Mother Nature',
			'Organize… [o]', 'Edit Metadata… [e]', 'Analyze… [a]',
			'--',
			'Enhance with BPM, Key, Label, Genre', 'Enhance with Tidal',
			'--',
			'Find Similar', 'Navigate to > Solee',
			'--',
			'Open in **Spotify**', 'Copy **Spotify** URL', 'Search in **Tidal**', 'Search in **Beatport**', 'Open File Location',
			'--',
			'Sync > Sync from Rekordbox… | Sync to Rekordbox…',
			'--',
			'Delete > Delete from Library… | Delete from Playlist…',
		]);
	});

	it('no Rate, no Start Journey, no standalone AI item; basketed local track stays removable', () => {
		const t = track(['local']);
		const labels = shape({ tracks: [t], view: 'tracks', source: 'rekordbox' as never, tagIds: new Set(['basket']), drillPlaylists: [] });
		expect(labels.join('\n')).not.toMatch(/Rate|Start Journey|AI Engine/);
		expect(labels).toContain('Remove from Basket');
		expect(labels.some((l) => l.startsWith('Delete > Delete from Library…'))).toBe(true);
		expect(labels.join('\n')).not.toMatch(/Delete from Playlist/);
		expect(labels).toContain('Sync > Sync to Rekordbox… | Add to Rekordbox…');
	});
});

describe('remote rows (not on this device)', () => {
	const remote = track([], { id: 'r1', remoteOnly: true, remoteSource: 'local' } as Partial<Track>);
	const local = track(['local'], { id: 'l1' } as Partial<Track>);
	const ctx = (tracks: Track[]): TrackCommandContext => ({ tracks, view: 'tracks', source: 'rekordbox' as never, tagIds: new Set(), drillPlaylists: [] });

	it('keeps curation, explains Analyze / Sync to Rekordbox, hides device-local writers', () => {
		const menu = buildTrackMenu(ctx([remote]));
		const flat = menu.items.flatMap((i) => (i.kind === 'submenu' ? i.items : [i]));
		const item = (id: string) => flat.find((i) => i.kind === 'item' && i.id === id) as (ContextMenuItem & { kind: 'item' }) | undefined;
		expect(item('organize')?.disabled).toBeFalsy();
		expect(item('edit')?.disabled).toBeFalsy();
		expect(item('analyze')).toMatchObject({ disabled: true, title: REMOTE_ONLY_REASON });
		expect(item('sync-to-rekordbox')).toMatchObject({ disabled: true, title: REMOTE_ONLY_REASON });
		expect(item('analyze')?.mnemonic).toBeUndefined();
		expect(menu.handlers['analyze']).toBeUndefined();
		expect(menu.handlers['sync-to-rekordbox']).toBeUndefined();
		for (const id of ['enrich-beatport', 'sync-tidal', 'download', 'open-local-folder', 'add-to-rekordbox', 'delete']) expect(item(id)).toBeUndefined();
	});

	it('a mixed selection is gated as a whole, menu and keyboard alike', () => {
		const sel = ctx([local, remote]);
		expect(trackCommandAvailable('analyze', sel)).toBe(false);
		expect(runTrackCommand('analyze', sel)).toBe(false);
		expect(trackCommandAvailable('organize', sel)).toBe(true);
		// Add to Rekordbox stays: it only ever adds the local rows of a selection.
		expect(shape(sel).join('\n')).toMatch(/Add 1 to Rekordbox…/);
		// The gate holds even if a remote row ever carried a source mark.
		const marked = track(['local'], { id: 'r2', remoteOnly: true } as Partial<Track>);
		expect(trackCommandAvailable('analyze', ctx([marked]))).toBe(false);
		expect(trackCommandAvailable('open-local-folder', ctx([marked]))).toBe(false);
		// A plain local selection is untouched.
		expect(trackCommandAvailable('analyze', ctx([local]))).toBe(true);
	});

	it('the row helpers', () => {
		expect(isRemoteRow(remote)).toBe(true);
		expect(isRemoteRow(local)).toBe(false);
		expect(remoteRowTitle(remote)).toBe(`${REMOTE_ONLY_REASON} (as a local file)`);
		expect(remoteRowTitle({ remoteSource: 'other' })).toBe(REMOTE_ONLY_REASON);
		expect(remoteMarkSource({ remoteSource: 'spotify' })).toBe('spotify');
		expect(remoteMarkSource({ remoteSource: null })).toBe('other');
	});
});

describe('Add to Similarity Match', () => {
	const t = track(['local'], { id: 'new-track' } as Partial<Track>);
	const ctxIn = (query: string | null): TrackCommandContext => ({
		tracks: [t], view: 'tracks', source: 'rekordbox' as never, tagIds: new Set(), drillPlaylists: [],
		jit: query === null ? null : { name: 'Similar: A', query },
	});

	it('is offered only inside a similarity scope, right below Find Similar', () => {
		const inScope = shape(ctxIn('similar={seed-a}'));
		const i = inScope.indexOf('Find Similar');
		expect(inScope[i + 1]).toBe('Add to Similarity Match');
		expect(shape(ctxIn(null))).not.toContain('Add to Similarity Match');
		expect(shape(ctxIn('label:"Anjunadeep"'))).not.toContain('Add to Similarity Match');
		// a seed of the current match can't be added again
		expect(shape(ctxIn('similar={new-track}'))).not.toContain('Add to Similarity Match');
	});

	it('opens a new (child) scope that keeps the current terms and adds the seed', async () => {
		const entered: { name: string; query: string }[] = [];
		initTrackCommands({ enterJitScope: async (jit: { name: string; query: string }) => { entered.push(jit); } } as unknown as ContextMenusFeatureDeps);
		const { handlers } = buildTrackMenu(ctxIn('sounds:"warm pads" similar={seed-a} bpm>=120'));
		await handlers['add-to-similar']!();
		await new Promise((r) => setTimeout(r, 0)); // the menu handler fires the action without awaiting it
		expect(entered).toEqual([{ name: 'Similar to 2 tracks', query: 'sounds:"warm pads" similar={seed-a} bpm>=120 similar={new-track}' }]);
	});
});

