// Library reference data — playlists, the Rekordbox tree, watched local
// folders, per-source track counts, and the auth snapshot. Fourth F2 slice.
//
// OWNERSHIP-FIRST CUT: these keep their legacy shapes (Map / arrays) with
// one coarse invalidation tick, because their consumers (Sidebar snapshot,
// virtualized tracklist, omnibar) hold structural perf contracts — stable
// item references between updates, iterables, tree walks — that the F4
// component rewrites renegotiate. What this slice buys NOW: single writer,
// reads are reactive (the tick is read inside every getter, so Solid
// computations tracking these getters re-run on any update), and the
// sidebarRev-style manual bump chains for DATA changes die. Granular
// per-row stores arrive with F4 (TanStack tracklist + Sidebar rework).

import { createSignal } from 'solid-js';
import type { AuthStatus } from '@curator/core';
import type { LibraryFolder, Playlist, PlaylistFolder } from '@curator/shared';

const [tick, setTick] = createSignal(0);
const bump = (): void => { setTick((n) => n + 1); };

let playlistsById = new Map<string, Playlist>();
let rekordboxTree: { folders: PlaylistFolder[]; playlists: Playlist[] } = { folders: [], playlists: [] };
let libraryFolders: LibraryFolder[] = [];
let auth: AuthStatus | null = null;
// `tracks:source-counts` — refreshed by refreshAll. The Rekordbox tab's
// onboarding panel reads `local` to know whether files are already on disk.
export interface SourceCounts { spotify: number; tidal: number; local: number }
let sourceCounts: SourceCounts = { spotify: 0, tidal: 0, local: 0 };
// The Organize catalog: every write-eligible playlist WITH its folder
// ancestry (the `playlists:list-with-folders` shape). Kept warm in the
// background (boot + sync/CRUD refreshes) so opening Organize never has to
// await the folder-walk IPC — see refreshOrganizeCatalog in main.ts.
let playlistEntries: { playlist: Playlist; folderPath: PlaylistFolder[] }[] = [];

export const library = {
	// ── Reads (reactive — every getter touches the tick) ───────────────
	getPlaylist(id: string): Playlist | undefined {
		tick();
		return playlistsById.get(id);
	},
	allPlaylists(): Playlist[] {
		tick();
		return Array.from(playlistsById.values());
	},
	playlistCount(): number {
		tick();
		return playlistsById.size;
	},
	rekordboxTree(): { folders: PlaylistFolder[]; playlists: Playlist[] } {
		tick();
		return rekordboxTree;
	},
	libraryFolders(): LibraryFolder[] {
		tick();
		return libraryFolders;
	},
	auth(): AuthStatus | null {
		tick();
		return auth;
	},
	sourceCounts(): SourceCounts {
		tick();
		return sourceCounts;
	},
	playlistEntries(): { playlist: Playlist; folderPath: PlaylistFolder[] }[] {
		tick();
		return playlistEntries;
	},

	// ── Writes ─────────────────────────────────────────────────────────
	setPlaylists(list: Playlist[]): void {
		playlistsById = new Map(list.map((p) => [p.id, p]));
		bump();
	},
	// In-place patch for single-row updates (favorite toggles etc.) —
	// preserves every other row's reference per the sidebar perf contract.
	patchPlaylist(id: string, patch: Partial<Playlist>): void {
		const cur = playlistsById.get(id);
		if (!cur) return;
		playlistsById.set(id, { ...cur, ...patch });
		bump();
	},
	setRekordboxTree(tree: { folders: PlaylistFolder[]; playlists: Playlist[] }): void {
		rekordboxTree = tree;
		bump();
	},
	// Sync rb-tree playlist counts from a fresh `playlists:list` read. The
	// tree is a separate cache (lazy `rekordbox:tree` IPC), so a bulk playlist
	// refresh after a membership write would otherwise leave the tree rows'
	// sidebar badges stale. Both caches read the same `playlist` table, so the
	// fresh list is authoritative. Replaces only rows whose count actually
	// changed, preserving the rest's references per the sidebar perf contract.
	patchRekordboxCounts(fresh: Playlist[]): void {
		const byId = new Map(fresh.map((p) => [p.id, p.trackCount]));
		let changed = false;
		const next = rekordboxTree.playlists.map((p) => {
			const n = byId.get(p.id);
			if (n === undefined || n === p.trackCount) return p;
			changed = true;
			return { ...p, trackCount: n };
		});
		if (!changed) return;
		rekordboxTree = { folders: rekordboxTree.folders, playlists: next };
		bump();
	},
	setLibraryFolders(folders: LibraryFolder[]): void {
		libraryFolders = folders;
		bump();
	},
	setAuth(a: AuthStatus | null): void {
		auth = a;
		bump();
	},
	setSourceCounts(counts: SourceCounts): void {
		sourceCounts = counts;
		bump();
	},
	setPlaylistEntries(entries: { playlist: Playlist; folderPath: PlaylistFolder[] }[]): void {
		playlistEntries = entries;
		bump();
	},
};
