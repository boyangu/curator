// tRPC transport seam (renderer data-layer ⇄ main). This router is pure
// plumbing: every procedure is a thin pass-through to the EXISTING handler
// map (buildHandlers), so there is zero business logic here — the IPC handler
// surface remains the single execution surface. The renderer's data/api.ts
// facades call procedures by name (e.g. `tracks.list`, `downloads.queue`);
// the input is the channel's ARGS TUPLE and the resolver spreads it into the
// handler. Only the channels the facades actually use are mirrored.
//
// Everything is a `.mutation` on purpose: over IPC the query/mutation split
// is meaningless, and mutations sidestep tRPC's query input-serialization
// quirks. The procedure names — NOT the underlying channel strings — are the
// renderer-facing contract.

import { initTRPC } from '@trpc/server';
import type { Handlers } from './handlers.js';

const t = initTRPC.create();

export function buildAppRouter(h: Handlers) {
	// IPC is a trusted boundary — pass input through untouched; the types come
	// from IpcChannels via Handlers. The cast is the escape hatch tRPC v11's
	// input inference needs; the client-facing types stay correct because the
	// AppRouter type is what the renderer's typed client infers from.
	const proc = <K extends keyof Handlers>(ch: K) =>
		t.procedure
			.input((v: unknown) => v as Parameters<Handlers[K]>)
			// The resolver's RETURN type is what tRPC infers as the procedure's
			// output (and thus the client's `.mutate()` result), so it must be the
			// handler's real return — not the `unknown` the runtime cast uses to
			// spread the args tuple. We annotate the return explicitly to bridge
			// the two.
			.mutation(({ input }): ReturnType<Handlers[K]> =>
				(h[ch] as (...a: unknown[]) => Promise<unknown>)(...(input as unknown[])) as ReturnType<Handlers[K]>);

	return t.router({
		tracks: t.router({
			list: proc('tracks:list'),
			page: proc('tracks:page'),
			ids: proc('tracks:ids'),
			sourceLinks: proc('tracks:source-links'),
			setOverrides: proc('tracks:set-overrides'),
			setSourceLinks: proc('tracks:set-source-links'),
			deleteSourceLink: proc('tracks:delete-source-link'),
			mergePreview: proc('tracks:merge-preview'),
			merge: proc('tracks:merge'),
			clearFields: proc('tracks:clear-fields'),
			fieldOptions: proc('tracks:field-options'),
			playlists: proc('tracks:playlists'),
			tags: proc('tracks:tags'),
			addTag: proc('tracks:add-tag'),
			removeTag: proc('tracks:remove-tag'),
			addTagSkippingLocal: proc('tracks:add-tag-skipping-local'),
			delete: proc('tracks:delete'),
			removeSources: proc('tracks:remove-sources'),
		}),
		wav: t.router({
			getSettings: proc('wav:get-settings'),
			setSettings: proc('wav:set-settings'),
			preview: proc('wav:preview'),
			convert: proc('wav:convert'),
			cancel: proc('wav:cancel'),
		}),
		credits: t.router({
			getFormat: proc('credits:get-format'),
			setFormat: proc('credits:set-format'),
		}),
		artists: t.router({
			list: proc('artists:list'),
			get: proc('artists:get'),
			resolve: proc('artists:resolve'),
			links: proc('artists:links'),
			mergeSuggestions: proc('artists:merge-suggestions'),
			dismissMerge: proc('artists:dismiss-merge'),
			rename: proc('artists:rename'),
			merge: proc('artists:merge'),
		}),
		albums: t.router({
			byIds: proc('albums:by-ids'),
		}),
		plays: t.router({
			record: proc('plays:record'),
		}),
		playlists: t.router({
			rename: proc('playlists:rename'),
			removeTracks: proc('playlists:remove-tracks'),
			findTracksWithDeletedFiles: proc('playlists:find-tracks-with-deleted-files'),
			upstreamDrift: proc('playlists:upstream-drift'),
			pushLocalOnly: proc('playlists:push-local-only'),
		}),
		library: t.router({
			listFolders: proc('library:list-folders'),
			addFolder: proc('library:add-folder'),
			removeFolder: proc('library:remove-folder'),
			pruneDeletedFiles: proc('library:prune-deleted-files'),
			duplicateAudioGroups: proc('library:duplicate-audio-groups'),
			trackLocalFile: proc('library:track-local-file'),
		}),
		downloads: t.router({
			queue: proc('tidal:download:queue'),
			summary: proc('tidal:download:summary'),
			retry: proc('tidal:download:retry'),
			redownload: proc('tidal:download:redownload'),
			clearCompleted: proc('tidal:download:clear-completed'),
			clearAll: proc('tidal:download:clear-all'),
			openFolder: proc('tidal:download:open-folder'),
			status: proc('tidal:download:status'),
			enable: proc('tidal:download:enable'),
			enqueue: proc('tidal:download:enqueue'),
		}),
		auth: t.router({
			status: proc('auth:status'),
			spotifyStart: proc('auth:spotify:start'),
			spotifyDisconnect: proc('auth:spotify:disconnect'),
			tidalStart: proc('auth:tidal:start'),
			tidalDisconnect: proc('auth:tidal:disconnect'),
		}),
		sources: t.router({
			getSyncSettings: proc('sources:get-sync-settings'),
			setSyncSettings: proc('sources:set-sync-settings'),
		}),
		sync: t.router({
			spotifyPlaylist: proc('sync:spotify:playlist'),
			tidalPlaylist: proc('sync:tidal:playlist'),
			resolveConflicts: proc('sync:resolve-conflicts'),
		}),
		enrich: t.router({
			beatportPlaylist: proc('enrich:beatport:playlist'),
			beatportTrack: proc('enrich:beatport:track'),
			beatportTracks: proc('enrich:beatport:tracks'),
		}),
		tidal: t.router({
			matchTrack: proc('tidal:match-track'),
			matchTracks: proc('tidal:match-tracks'),
			setPlaylistHybrid: proc('tidal:set-playlist-hybrid'),
		}),
		shell: t.router({
			openExternal: proc('shell:open-external'),
			showInFolder: proc('shell:show-in-folder'),
			copyText: proc('shell:copy-text'),
		}),
		rekordbox: t.router({
			detect: proc('rekordbox:detect'),
			read: proc('rekordbox:read'),
			listBackups: proc('rekordbox:list-backups'),
			clearBackups: proc('rekordbox:clear-backups'),
			sync: proc('rekordbox:sync'),
			createPreview: proc('rekordbox:create-preview'),
			createPreviewTracks: proc('rekordbox:create-preview-tracks'),
			syncFrom: proc('rekordbox:sync-from'),
			resolvePullConflicts: proc('rekordbox:resolve-pull-conflicts'),
			restoreBackup: proc('rekordbox:restore-backup'),
		}),
		analysis: t.router({
			setAutoEnqueue: proc('analysis:set-auto-enqueue'),
		}),
		mir: t.router({
			setSettings: proc('mir:set-settings'),
			analyzeNow: proc('mir:analyze-now'),
			provision: proc('mir:provision'),
		}),
		backup: t.router({
			getSettings: proc('backup:get-settings'),
			setSettings: proc('backup:set-settings'),
			status: proc('backup:status'),
			targetStat: proc('backup:target-stat'),
			listSnapshots: proc('backup:list-snapshots'),
			run: proc('backup:run'),
			cancel: proc('backup:cancel'),
			pin: proc('backup:pin'),
			deleteSnapshot: proc('backup:delete-snapshot'),
			restorePreview: proc('backup:restore-preview'),
			restore: proc('backup:restore'),
			googleConnect: proc('backup:google-connect'),
			googleDisconnect: proc('backup:google-disconnect'),
			relaunch: proc('backup:relaunch'),
			takePendingRendererSettings: proc('backup:take-pending-renderer-settings'),
		}),
		account: t.router({
			status: proc('account:status'),
			signInPassword: proc('account:sign-in-password'),
			signInOtpRequest: proc('account:sign-in-otp-request'),
			signInOtpVerify: proc('account:sign-in-otp-verify'),
			signOut: proc('account:sign-out'),
			devices: proc('account:devices'),
		}),
		cloudSync: t.router({
			status: proc('cloud-sync:status'),
			now: proc('cloud-sync:now'),
		}),
		dialog: t.router({
			pickFolder: proc('dialog:pick-folder'),
		}),
	});
}

export type AppRouter = ReturnType<typeof buildAppRouter>;
