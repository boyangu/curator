// SpotifyAdapter — concrete implementation of StreamingSourceAdapter for
// the Spotify Web API. Wraps SpotifyClient (the low-level HTTP client in
// packages/providers/spotify) and normalizes its result shapes into the
// adapter's provider-agnostic types.
//
// One adapter instance per service lifetime (constructed in the core
// service). Each call freshly resolves the access token via the
// AuthService so we get auto-refresh + reconnect handling for free —
// the adapter never holds a token, so a long-lived poll loop can't
// stall on a stale credential.

import { SpotifyClient } from '@curator/spotify';
import { getSourceCapabilities, type SourceCapabilities } from '@curator/shared';
import type { AuthService } from '../auth/service.js';
import type { StreamingSourceAdapter, RemotePlaylistRef, RemoteTrackRef } from './adapter.js';

export class SpotifyAdapter implements StreamingSourceAdapter {
	readonly source = 'spotify' as const;
	readonly displayName = 'Spotify';
	readonly capabilities: SourceCapabilities = getSourceCapabilities('spotify');

	constructor(private readonly auth: AuthService) {}

	// Resolve a fresh client per call. Cheap (just wraps an access token);
	// auto-refresh lives one layer up in AuthService. Throws when the user
	// isn't connected — caller surfaces as a "reconnect" toast.
	private async client(): Promise<SpotifyClient> {
		const token = await this.auth.getSpotifyAccessToken();
		if (!token) throw new Error('Spotify not connected');
		return new SpotifyClient(token, 'source:spotify');
	}

	// Defense-in-depth per the adapter contract: the service-layer router
	// checks capabilities before calling, but a bug there shouldn't turn
	// into a silent provider mutation. All Spotify caps are true today, so
	// these never fire — they exist for copy-paste fidelity when the next
	// adapter (with real false capabilities) is written from this one.
	private assertCap(cap: keyof SourceCapabilities, op: string): void {
		if (!this.capabilities[cap]) {
			throw new Error(`${this.displayName} adapter: ${op} called but capability ${cap} is false`);
		}
	}

	async listRemotePlaylists(): Promise<RemotePlaylistRef[]> {
		const c = await this.client();
		const pls = await c.getUserPlaylists();
		return pls.map((p) => ({
			remoteId: p.id,
			name: p.name,
			snapshotId: p.snapshot_id ?? null,
			trackCount: p.tracks?.total ?? 0,
		}));
	}

	async fetchPlaylistTracks(remoteId: string): Promise<RemoteTrackRef[]> {
		const c = await this.client();
		const items = await c.getPlaylistTracks(remoteId);
		const out: RemoteTrackRef[] = [];
		for (const it of items) {
			// Spotify sometimes returns null `track` when a song has been
			// pulled from the catalog. Drop those — they have no usable id.
			if (!it.track) continue;
			out.push({
				remoteId: it.track.id,
				title: it.track.name,
				artistNames: (it.track.artists ?? []).map((a) => a.name),
				albumTitle: it.track.album?.name ?? null,
				durationSec: it.track.duration_ms != null ? it.track.duration_ms / 1000 : null,
				isrc: it.track.external_ids?.isrc ?? null,
			});
		}
		return out;
	}

	async createPlaylist(name: string, opts: { description?: string; isPublic?: boolean } = {}): Promise<RemotePlaylistRef> {
		this.assertCap('canCreatePlaylist', 'createPlaylist');
		const c = await this.client();
		const me = await c.getMe();
		const created = await c.createPlaylist(me.id, name, opts);
		return {
			remoteId: created.id,
			name: created.name,
			snapshotId: created.snapshot_id ?? null,
			trackCount: created.tracks?.total ?? 0,
		};
	}

	async deletePlaylist(remoteId: string): Promise<void> {
		this.assertCap('canDeletePlaylist', 'deletePlaylist');
		const c = await this.client();
		// Spotify's "delete" is "unfollow" — see SpotifyClient.unfollowPlaylist.
		await c.unfollowPlaylist(remoteId);
	}

	async renamePlaylist(remoteId: string, name: string): Promise<void> {
		this.assertCap('canRename', 'renamePlaylist');
		const c = await this.client();
		await c.changePlaylistDetails(remoteId, { name });
	}

	async addTracks(remoteId: string, remoteTrackIds: string[]): Promise<{ snapshotId: string | null }> {
		this.assertCap('canAddTracks', 'addTracks');
		if (remoteTrackIds.length === 0) return { snapshotId: null };
		const c = await this.client();
		const res = await c.addPlaylistTracks(remoteId, remoteTrackIds);
		return { snapshotId: res.snapshot_id || null };
	}

	async removeTracks(remoteId: string, remoteTrackIds: string[]): Promise<{ snapshotId: string | null }> {
		this.assertCap('canRemoveTracks', 'removeTracks');
		if (remoteTrackIds.length === 0) return { snapshotId: null };
		const c = await this.client();
		const res = await c.removePlaylistTracks(remoteId, remoteTrackIds);
		return { snapshotId: res.snapshot_id || null };
	}

	async replaceTracks(remoteId: string, remoteTrackIds: string[]): Promise<{ snapshotId: string | null }> {
		this.assertCap('canReorder', 'replaceTracks');
		const c = await this.client();
		const res = await c.replacePlaylistTracks(remoteId, remoteTrackIds);
		return { snapshotId: res.snapshot_id || null };
	}

	async reorderTracks(
		remoteId: string,
		moves: Array<{ rangeStart: number; insertBefore: number }>,
		snapshotId?: string | null,
	): Promise<{ snapshotId: string | null }> {
		this.assertCap('canReorder', 'reorderTracks');
		if (moves.length === 0) return { snapshotId: null };
		const c = await this.client();
		const res = await c.reorderPlaylistTracks(
			remoteId,
			moves.map((m) => ({ range_start: m.rangeStart, insert_before: m.insertBefore })),
			snapshotId,
		);
		return { snapshotId: res.snapshot_id || null };
	}
}
