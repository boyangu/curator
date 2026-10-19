// Write-tool gating: which ops block on the confirm modal vs proceed with a
// toast, that a deny executes NOTHING, and that id validation rejects
// unknown refs before any write. CoreService is faked to spies — the
// default-deny remote-write gate itself is covered in sources/adapter.test.ts,
// which createStreamingPlaylist inherits by routing through the guarded
// adapter.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreService } from '../service.js';
import { buildMcpWriteTools, type McpConfirmRequest, type McpWriteToolRegistry } from './write-tools.js';

const TRACKS = [
	{ id: 't1', title: 'One', artists: [{ name: 'A' }], bpm: 122 },
	{ id: 't2', title: 'Two', artists: [{ name: 'B' }] },
];

const PLAYLISTS = [
	{ id: 'pl-local', name: 'Crate', source: 'local', trackCount: 3, isSmart: false },
	{ id: 'pl-sp', name: 'Melodic', source: 'spotify', trackCount: 10, isSmart: false },
];

function makeFakeSvc() {
	return {
		getTracks: vi.fn(async (filter?: { ids?: string[] }) =>
			TRACKS.filter((t) => !filter?.ids || filter.ids.includes(t.id))),
		getPlaylists: vi.fn(async () => PLAYLISTS),
		createLocalPlaylistFromTracks: vi.fn(async (name: string) => ({ id: 'new-local', name, source: 'local' })),
		createStreamingPlaylist: vi.fn(async (_src: string, name: string, trackIds: string[]) =>
			({ playlist: { id: 'new-sp', name, source: 'spotify' }, added: trackIds.length, skipped: 0 })),
		addTracksToPlaylist: vi.fn(async (_id: string, trackIds: string[]) => ({ added: trackIds.length, skipped: 0, noUpstreamTrackIds: [] as string[], upstream: 'none' as const })),
		removeTracksFromPlaylist: vi.fn(async (_id: string, trackIds: string[]) => ({ removed: trackIds.length, upstream: 'none' as const })),
		renamePlaylist: vi.fn(async () => ({ pushedToSource: true })),
		getTags: vi.fn(async () => [{ id: 'tag1', name: 'Peak Time' }]),
		createTag: vi.fn(async (name: string) => ({ id: `tag-${name}`, name })),
		addTrackTag: vi.fn(async () => undefined),
		removeTrackTag: vi.fn(async () => undefined),
		setRating: vi.fn(async () => []),
		setTrackOverrides: vi.fn(async (trackId: string) => ({ id: trackId, title: 'One', artists: [{ name: 'A' }] })),
		clearTrackFields: vi.fn(async (trackId: string) => ({ id: trackId, title: 'One', artists: [{ name: 'A' }] })),
		setTrackSourceLinks: vi.fn(async () => ({ updated: ['beatport'], refetched: ['beatport'], errors: [] })),
		setPlaySessionKind: vi.fn(async () => undefined),
	};
}

describe('MCP write tools', () => {
	let svc: ReturnType<typeof makeFakeSvc>;
	let confirms: McpConfirmRequest[];
	let confirmAnswer: boolean;
	let toasts: string[];
	let tools: McpWriteToolRegistry;

	beforeEach(() => {
		svc = makeFakeSvc();
		confirms = [];
		confirmAnswer = true;
		toasts = [];
		tools = buildMcpWriteTools({
			svc: () => svc as unknown as CoreService,
			confirm: async (req) => { confirms.push(req); return confirmAnswer; },
			notify: (msg) => toasts.push(msg),
		});
	});

	it('exposes specs for every tool', () => {
		expect(tools.specs().map((s) => s.name)).toEqual([
			'list_playlists', 'get_playlist_tracks', 'create_playlist', 'add_tracks_to_playlist',
			'remove_tracks_from_playlist', 'rename_playlist', 'tag_tracks', 'set_rating',
			'set_track_source_links', 'update_track_fields', 'set_play_session_kind',
		]);
	});

	it('set_play_session_kind is local-only: no confirm, toast, validated kind', async () => {
		const res = await tools.execute('set_play_session_kind', { sessionId: 's1', kind: 'set' });
		expect(res).toMatchObject({ ok: true, sessionId: 's1', kind: 'set' });
		expect(svc.setPlaySessionKind).toHaveBeenCalledWith('s1', 'set');
		expect(confirms).toHaveLength(0);
		expect(toasts).toHaveLength(1);
		await expect(tools.execute('set_play_session_kind', { sessionId: 's1', kind: 'unknown' }))
			.rejects.toThrow(/"set" or "prep"/);
		await expect(tools.execute('set_play_session_kind', { kind: 'set' }))
			.rejects.toThrow(/sessionId/);
	});

	it('set_track_source_links forwards URLs, validates the track, requires at least one source', async () => {
		await expect(tools.execute('set_track_source_links', { trackId: 't1' }))
			.rejects.toThrow('at least one');
		await expect(tools.execute('set_track_source_links', { trackId: 'ghost', beatport: 'https://www.beatport.com/track/x/123' }))
			.rejects.toThrow('unknown trackIds');
		const res = await tools.execute('set_track_source_links', { trackId: 't1', beatport: 'https://www.beatport.com/track/x/123' }) as { ok: boolean };
		expect(res.ok).toBe(true);
		expect(svc.setTrackSourceLinks).toHaveBeenCalledWith('t1', { beatport: 'https://www.beatport.com/track/x/123' });
		expect(toasts.some((t) => t.includes('linked beatport'))).toBe(true);
	});

	it('local playlist create: no modal, toast, executes', async () => {
		const res = await tools.execute('create_playlist', { name: 'Night', trackIds: ['t1', 't2'] }) as { ok: boolean };
		expect(res.ok).toBe(true);
		expect(confirms).toHaveLength(0);
		expect(toasts).toHaveLength(1);
		expect(svc.createLocalPlaylistFromTracks).toHaveBeenCalledWith('Night', ['t1', 't2']);
	});

	it('spotify playlist create: modal with track lines, approved → executes', async () => {
		const res = await tools.execute('create_playlist', { name: 'Night', trackIds: ['t1'], on: 'spotify' }) as { added: number };
		expect(confirms).toHaveLength(1);
		expect(confirms[0]!.kind).toBe('streaming-playlist-write');
		expect(confirms[0]!.detailLines[0]).toContain('One');
		expect(res.added).toBe(1);
		expect(svc.createStreamingPlaylist).toHaveBeenCalledWith('spotify', 'Night', ['t1']);
	});

	it('deny executes NOTHING', async () => {
		confirmAnswer = false;
		await expect(tools.execute('create_playlist', { name: 'N', trackIds: ['t1'], on: 'spotify' }))
			.rejects.toThrow('declined');
		expect(svc.createStreamingPlaylist).not.toHaveBeenCalled();
		await expect(tools.execute('remove_tracks_from_playlist', { playlistId: 'pl-local', trackIds: ['t1'] }))
			.rejects.toThrow('declined');
		expect(svc.removeTracksFromPlaylist).not.toHaveBeenCalled();
	});

	it('add to streaming playlist gates on the modal; add to local does not', async () => {
		await tools.execute('add_tracks_to_playlist', { playlistId: 'pl-sp', trackIds: ['t1'] });
		expect(confirms).toHaveLength(1);
		await tools.execute('add_tracks_to_playlist', { playlistId: 'pl-local', trackIds: ['t1'] });
		expect(confirms).toHaveLength(1); // unchanged — local went straight through
		expect(toasts.some((t) => t.includes('Crate'))).toBe(true);
	});

	it('remove always gates, even on a local playlist', async () => {
		await tools.execute('remove_tracks_from_playlist', { playlistId: 'pl-local', trackIds: ['t1'] });
		expect(confirms).toHaveLength(1);
		expect(confirms[0]!.kind).toBe('destructive-write');
	});

	it('rename gates only for streaming sources', async () => {
		await tools.execute('rename_playlist', { playlistId: 'pl-local', newName: 'X' });
		expect(confirms).toHaveLength(0);
		await tools.execute('rename_playlist', { playlistId: 'pl-sp', newName: 'Y' });
		expect(confirms).toHaveLength(1);
	});

	it('rejects unknown track and playlist ids before any write', async () => {
		await expect(tools.execute('add_tracks_to_playlist', { playlistId: 'pl-sp', trackIds: ['ghost'] }))
			.rejects.toThrow('unknown trackIds');
		await expect(tools.execute('add_tracks_to_playlist', { playlistId: 'ghost', trackIds: ['t1'] }))
			.rejects.toThrow('unknown playlistId');
		expect(svc.addTracksToPlaylist).not.toHaveBeenCalled();
	});

	it('tag_tracks resolves names case-insensitively and gates unknown tags on createMissing', async () => {
		await tools.execute('tag_tracks', { trackIds: ['t1'], add: ['peak time'] });
		expect(svc.addTrackTag).toHaveBeenCalledWith('t1', 'tag1');
		await expect(tools.execute('tag_tracks', { trackIds: ['t1'], add: ['Brand New'] }))
			.rejects.toThrow('unknown tag');
		expect(svc.createTag).not.toHaveBeenCalled();
		await tools.execute('tag_tracks', { trackIds: ['t1'], add: ['Brand New'], createMissing: true });
		expect(svc.createTag).toHaveBeenCalledWith('Brand New');
	});

	it('set_rating validates the range', async () => {
		await expect(tools.execute('set_rating', { trackIds: ['t1'], rating: 7 })).rejects.toThrow('0–5');
		await tools.execute('set_rating', { trackIds: ['t1'], rating: null });
		expect(svc.setRating).toHaveBeenCalledWith(['t1'], null);
	});

	it('update_track_fields takes artist credits verbatim (no positional roles) and applies the patch to every track', async () => {
		const res = await tools.execute('update_track_fields', { trackIds: ['t1', 't2'], patch: { artists: ['X', 'Y'], genre: 'Techno' } }) as { tracks: number };
		expect(res.tracks).toBe(2);
		expect(svc.setTrackOverrides).toHaveBeenCalledTimes(2);
		expect(svc.setTrackOverrides).toHaveBeenCalledWith('t1', {
			artists: [{ name: 'X' }, { name: 'Y' }],
			genre: 'Techno',
		});
	});

	it('update_track_fields splits packed strings with the shared rules and honours explicit roles', async () => {
		await tools.execute('update_track_fields', { trackIds: ['t1'], patch: { artists: ['A, B feat. C', { name: 'D', role: 'remixer' }, { name: 'E', role: 'main' }] } });
		expect(svc.setTrackOverrides).toHaveBeenLastCalledWith('t1', {
			artists: [{ name: 'A' }, { name: 'B' }, { name: 'C', role: 'featured' }, { name: 'D', role: 'remixer' }, { name: 'E' }],
		});
		await expect(tools.execute('update_track_fields', { trackIds: ['t1'], patch: { artists: [{ name: 'F', role: 'producer' }] } }))
			.rejects.toThrow('artist role must be');
	});

	it('update_track_fields routes nulls to clearTrackFields (hard clear), non-nulls to overrides', async () => {
		const res = await tools.execute('update_track_fields', { trackIds: ['t1'], patch: { genre: 'House', releaseDate: null } }) as { set: string[]; cleared: string[] };
		expect(svc.setTrackOverrides).toHaveBeenCalledWith('t1', { genre: 'House' });
		expect(svc.clearTrackFields).toHaveBeenCalledWith('t1', ['releaseDate']);
		expect(res).toMatchObject({ set: ['genre'], cleared: ['releaseDate'] });
	});

	it('update_track_fields validates releaseDate, bpm and key (musical → Camelot)', async () => {
		await expect(tools.execute('update_track_fields', { trackIds: ['t1'], patch: { releaseDate: 'March 2021' } }))
			.rejects.toThrow('releaseDate must be');
		await expect(tools.execute('update_track_fields', { trackIds: ['t1'], patch: { bpm: -3 } }))
			.rejects.toThrow('bpm must be');
		await expect(tools.execute('update_track_fields', { trackIds: ['t1'], patch: { keyCamelot: 'H#' } }))
			.rejects.toThrow('unrecognized key');
		await tools.execute('update_track_fields', { trackIds: ['t1'], patch: { releaseDate: '2021-03-15', keyCamelot: 'F# minor' } });
		expect(svc.setTrackOverrides).toHaveBeenCalledWith('t1', { releaseDate: '2021-03-15', keyCamelot: '11A' });
		await tools.execute('update_track_fields', { trackIds: ['t1'], patch: { keyCamelot: '8a' } });
		expect(svc.setTrackOverrides).toHaveBeenLastCalledWith('t1', { keyCamelot: '8A' });
	});
});
