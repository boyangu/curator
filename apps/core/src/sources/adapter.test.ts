import { describe, expect, it } from 'vitest';
import {
	guardRemoteWrites,
	makeRemoteWriteGate,
	RemoteWriteDeniedError,
	type RemoteWritePolicy,
	type StreamingSourceAdapter,
} from './adapter.js';

// Records which underlying adapter methods actually got called, so we can prove
// a denied write never reaches the provider.
function fakeAdapter(): { adapter: StreamingSourceAdapter; calls: string[] } {
	const calls: string[] = [];
	const adapter: StreamingSourceAdapter = {
		source: 'spotify',
		displayName: 'Spotify',
		capabilities: {} as StreamingSourceAdapter['capabilities'],
		listRemotePlaylists: async () => { calls.push('listRemotePlaylists'); return []; },
		fetchPlaylistTracks: async () => { calls.push('fetchPlaylistTracks'); return []; },
		createPlaylist: async (name) => { calls.push('createPlaylist'); return { remoteId: 'x', name, snapshotId: null, trackCount: 0 }; },
		deletePlaylist: async () => { calls.push('deletePlaylist'); },
		renamePlaylist: async () => { calls.push('renamePlaylist'); },
		addTracks: async () => { calls.push('addTracks'); return { snapshotId: null }; },
		removeTracks: async () => { calls.push('removeTracks'); return { snapshotId: null }; },
		replaceTracks: async () => { calls.push('replaceTracks'); return { snapshotId: null }; },
		reorderTracks: async () => { calls.push('reorderTracks'); return { snapshotId: null }; },
	};
	return { adapter, calls };
}

describe('guardRemoteWrites — default-deny remote streaming writes', () => {
	it('throws on every mutating op when no policy is injected, and never reaches the provider', () => {
		const { adapter, calls } = fakeAdapter();
		const guarded = guardRemoteWrites(adapter, makeRemoteWriteGate(undefined));
		// The gate throws synchronously, before the provider call — this is what
		// off-product code (scripts/tests/CLI/core-sidecar) gets.
		expect(() => guarded.addTracks('p', ['a'])).toThrow(RemoteWriteDeniedError);
		expect(() => guarded.removeTracks('p', ['a'])).toThrow(RemoteWriteDeniedError);
		expect(() => guarded.replaceTracks('p', ['a'])).toThrow(RemoteWriteDeniedError);
		expect(() => guarded.reorderTracks!('p', [{ rangeStart: 1, insertBefore: 0 }])).toThrow(RemoteWriteDeniedError);
		expect(() => guarded.renamePlaylist('p', 'n')).toThrow(RemoteWriteDeniedError);
		expect(() => guarded.createPlaylist('n')).toThrow(RemoteWriteDeniedError);
		expect(() => guarded.deletePlaylist('p')).toThrow(RemoteWriteDeniedError);
		expect(calls).toEqual([]);
	});

	it('lets read methods through without a policy', async () => {
		const { adapter, calls } = fakeAdapter();
		const guarded = guardRemoteWrites(adapter, makeRemoteWriteGate(undefined));
		await guarded.listRemotePlaylists();
		await guarded.fetchPlaylistTracks('p');
		expect(calls).toEqual(['listRemotePlaylists', 'fetchPlaylistTracks']);
	});

	it('delegates mutating ops when a permissive policy is injected (the desktop-app path)', async () => {
		const { adapter, calls } = fakeAdapter();
		const allowAll: RemoteWritePolicy = { allow: () => true };
		const guarded = guardRemoteWrites(adapter, makeRemoteWriteGate(allowAll));
		await guarded.addTracks('p', ['a']);
		await guarded.removeTracks('p', ['a']);
		await guarded.renamePlaylist('p', 'n');
		expect(calls).toEqual(['addTracks', 'removeTracks', 'renamePlaylist']);
	});

	it('honors a selective policy (allow by op)', async () => {
		const { adapter, calls } = fakeAdapter();
		const policy: RemoteWritePolicy = { allow: (req) => req.op === 'addTracks' };
		const guarded = guardRemoteWrites(adapter, makeRemoteWriteGate(policy));
		await guarded.addTracks('p', ['a']);
		expect(() => guarded.removeTracks('p', ['a'])).toThrow(RemoteWriteDeniedError);
		expect(calls).toEqual(['addTracks']);
	});
});
