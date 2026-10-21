// MCP write tools — the mutation surface exposed to an EXTERNAL model over
// the MCP bridge. Deliberately a separate registry from agent/tools.ts: the
// in-app agent is read-only BY CONSTRUCTION (its file header says exactly
// that), and keeping writes here means nothing can leak into it.
//
// Safety model (see CLAUDE.md "Streaming remote writes"): the desktop main
// injects remoteWritePolicy allow-all because the RENDERER confirms before
// calling write IPC — but MCP calls enter below that confirmation. So every
// op that cascades to the user's live Spotify/Tidal account (and every
// destructive op) blocks on `ports.confirm()` — an in-app modal the user
// must approve — before the CoreService call runs. Local-only writes
// proceed directly but surface via `ports.notify()` (toast) and, for
// streaming ops, the existing write-audit JSONL.

import type { StreamingSource, TrackOverrides, ZTrackSortT } from '@curator/shared';
import { splitArtistCredit, type TrackArtist } from '@curator/shared';
import type { CoreService } from '../service.js';
import type { WireToolSpec } from '../agent/protocol.js';
import { keyToCamelot } from '../enrich/keys.js';

export interface McpConfirmRequest {
	kind: 'streaming-playlist-write' | 'destructive-write';
	// One-line human summary, e.g. `Add 12 tracks to Spotify playlist "Melodic House"`.
	title: string;
	// Track titles etc. — first 15 + "…and N more".
	detailLines: string[];
}

export interface McpWritePorts {
	svc(): CoreService;
	// Desktop injects the modal round-trip; resolves false on deny/timeout.
	confirm(req: McpConfirmRequest): Promise<boolean>;
	// Toast for writes that proceed without a modal.
	notify(message: string): void;
}

export interface McpWriteTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(args: unknown): Promise<unknown>;
}

export interface McpWriteToolRegistry {
	specs(): WireToolSpec[];
	has(name: string): boolean;
	execute(name: string, args: unknown): Promise<unknown>;
}

const MAX_DETAIL_LINES = 15;
const DEFAULT_LIST_LIMIT = 50;

type Args = Record<string, unknown>;
const asArgs = (a: unknown): Args => (a && typeof a === 'object' ? (a as Args) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const STREAMING_SOURCES = new Set(['spotify', 'tidal']);

export function buildMcpWriteTools(ports: McpWritePorts): McpWriteToolRegistry {
	const svc = () => ports.svc();

	// Track titles for confirm dialogs / result echoes. Also serves as id
	// validation: unknown ids simply don't come back.
	const fetchTracks = async (trackIds: string[]) => {
		if (trackIds.length === 0) return [];
		return svc().getTracks({ ids: trackIds }, undefined, trackIds.length);
	};

	const detailLines = (tracks: { title: string; artists: { name: string }[] }[]): string[] => {
		const lines = tracks.slice(0, MAX_DETAIL_LINES).map((t) => `${t.artists.map((a) => a.name).join(', ')} — ${t.title}`);
		if (tracks.length > MAX_DETAIL_LINES) lines.push(`…and ${tracks.length - MAX_DETAIL_LINES} more`);
		return lines;
	};

	const requireTracks = async (trackIds: string[]) => {
		const tracks = await fetchTracks(trackIds);
		if (tracks.length !== trackIds.length) {
			const known = new Set(tracks.map((t) => t.id));
			const missing = trackIds.filter((id) => !known.has(id));
			throw new Error(`unknown trackIds (use ids from query_library): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` …and ${missing.length - 5} more` : ''}`);
		}
		return tracks;
	};

	const requirePlaylist = async (playlistId: string) => {
		const pl = (await svc().getPlaylists()).find((p) => p.id === playlistId);
		if (!pl) throw new Error(`unknown playlistId ${playlistId} — use ids from list_playlists`);
		return pl;
	};

	const deny = () => new Error('the user declined this write in the Curator app');

	const tools: McpWriteTool[] = [
		{
			name: 'list_playlists',
			description: 'List the user\'s playlists (all sources: spotify, tidal, local, rekordbox) with ids, sources and track counts. Use the returned playlistId with get_playlist_tracks / playlist write tools.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Case-insensitive name substring filter.' },
					source: { type: 'string', enum: ['spotify', 'tidal', 'local', 'rekordbox'], description: 'Only playlists from this source.' },
					limit: { type: 'number', description: `Max rows (default ${DEFAULT_LIST_LIMIT}).` },
				},
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const query = str(a['query'])?.toLowerCase();
				const source = str(a['source']);
				const limit = typeof a['limit'] === 'number' ? Math.max(1, Math.floor(a['limit'])) : DEFAULT_LIST_LIMIT;
				const all = await svc().getPlaylists();
				const filtered = all.filter((p) =>
					(!source || p.source === source) &&
					(!query || p.name.toLowerCase().includes(query)));
				return {
					total: filtered.length,
					playlists: filtered.slice(0, limit).map((p) => ({
						id: p.id,
						name: p.name,
						source: p.source,
						trackCount: p.trackCount ?? 0,
						...(p.isSmart ? { isSmart: true } : {}),
					})),
				};
			},
		},
		{
			name: 'get_playlist_tracks',
			description: 'List a playlist\'s tracks in playlist order (compact rows with library track ids).',
			parameters: {
				type: 'object',
				properties: {
					playlistId: { type: 'string' },
					limit: { type: 'number', description: 'Max rows (default 100).' },
					offset: { type: 'number' },
				},
				required: ['playlistId'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const playlistId = str(a['playlistId']);
				if (!playlistId) throw new Error('playlistId is required');
				const pl = await requirePlaylist(playlistId);
				const limit = typeof a['limit'] === 'number' ? Math.max(1, Math.floor(a['limit'])) : 100;
				const offset = typeof a['offset'] === 'number' ? Math.max(0, Math.floor(a['offset'])) : 0;
				const sort: ZTrackSortT = { column: 'index', dir: 'asc' };
				const tracks = await svc().getTracks({ playlistId }, sort, limit, offset);
				return {
					playlist: { id: pl.id, name: pl.name, source: pl.source, trackCount: pl.trackCount ?? 0 },
					tracks: tracks.map((t) => ({
						id: t.id,
						// A followed playlist keeps tracks the user deleted (the app
						// shows them with a "deleted" chip); they're not in the library.
						...(t.deletedAt ? { deleted: true } : {}),
						title: t.title,
						artists: t.artists.map((ar) => ar.name),
						...(t.bpm != null ? { bpm: t.bpm } : {}),
						...(t.keyCamelot ? { key: t.keyCamelot } : {}),
						...(t.genre ? { genre: t.genre } : {}),
						...(t.label ? { label: t.label } : {}),
						...(t.rating != null ? { rating: t.rating } : {}),
					})),
				};
			},
		},
		{
			name: 'create_playlist',
			description: 'Create a new playlist from library track ids. on="local" (default) creates a Curator-local playlist instantly. on="spotify" creates the playlist ON THE USER\'S LIVE SPOTIFY ACCOUNT (private) — this requires the user to approve an in-app confirmation, and tracks without a Spotify link are skipped.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					trackIds: { type: 'array', items: { type: 'string' }, description: 'Library track ids, in playlist order.' },
					on: { type: 'string', enum: ['local', 'spotify'], description: 'Where to create it. Default local.' },
				},
				required: ['name', 'trackIds'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const name = str(a['name']);
				if (!name) throw new Error('name is required');
				const trackIds = strArray(a['trackIds']);
				const on = str(a['on']) ?? 'local';
				const tracks = await requireTracks(trackIds);
				if (on === 'local') {
					const pl = await svc().createLocalPlaylistFromTracks(name, trackIds);
					ports.notify(`Claude created local playlist "${pl.name}" (${trackIds.length} tracks)`);
					return { ok: true, playlistId: pl.id, name: pl.name, source: 'local', added: trackIds.length };
				}
				if (on !== 'spotify') throw new Error(`unsupported target "${on}" — use "local" or "spotify"`);
				const approved = await ports.confirm({
					kind: 'streaming-playlist-write',
					title: `Create Spotify playlist "${name}" with ${trackIds.length} tracks`,
					detailLines: detailLines(tracks),
				});
				if (!approved) throw deny();
				const res = await svc().createStreamingPlaylist('spotify' as StreamingSource, name, trackIds);
				return { ok: true, playlistId: res.playlist.id, name: res.playlist.name, source: 'spotify', added: res.added, skippedNoSpotifyLink: res.skipped };
			},
		},
		{
			name: 'add_tracks_to_playlist',
			description: 'Add library tracks to an existing playlist. Adding to a spotify/tidal playlist MODIFIES THE USER\'S LIVE ACCOUNT and requires the user to approve an in-app confirmation; local playlists apply instantly. Idempotent for tracks already in the playlist. The result\'s `upstream` says whether the provider actually received the add (pushed / write-sync-off / not-owner / failed / none) — anything but pushed/none means the rows exist only in Curator.',
			parameters: {
				type: 'object',
				properties: {
					playlistId: { type: 'string' },
					trackIds: { type: 'array', items: { type: 'string' } },
				},
				required: ['playlistId', 'trackIds'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const playlistId = str(a['playlistId']);
				const trackIds = strArray(a['trackIds']);
				if (!playlistId) throw new Error('playlistId is required');
				if (trackIds.length === 0) throw new Error('trackIds is required');
				const pl = await requirePlaylist(playlistId);
				const tracks = await requireTracks(trackIds);
				if (STREAMING_SOURCES.has(pl.source)) {
					const approved = await ports.confirm({
						kind: 'streaming-playlist-write',
						title: `Add ${trackIds.length} tracks to ${pl.source} playlist "${pl.name}"`,
						detailLines: detailLines(tracks),
					});
					if (!approved) throw deny();
				}
				const res = await svc().addTracksToPlaylist(playlistId, trackIds);
				if (!STREAMING_SOURCES.has(pl.source)) {
					ports.notify(`Claude added ${res.added} tracks to "${pl.name}"`);
				}
				return { ok: true, added: res.added, skipped: res.skipped, upstream: res.upstream };
			},
		},
		{
			name: 'remove_tracks_from_playlist',
			description: 'Remove tracks from a playlist. DESTRUCTIVE — always requires the user to approve an in-app confirmation; removal from a spotify/tidal playlist also removes them on the user\'s live account.',
			parameters: {
				type: 'object',
				properties: {
					playlistId: { type: 'string' },
					trackIds: { type: 'array', items: { type: 'string' } },
				},
				required: ['playlistId', 'trackIds'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const playlistId = str(a['playlistId']);
				const trackIds = strArray(a['trackIds']);
				if (!playlistId) throw new Error('playlistId is required');
				if (trackIds.length === 0) throw new Error('trackIds is required');
				const pl = await requirePlaylist(playlistId);
				const tracks = await fetchTracks(trackIds); // partial ok — removal of a stale id is a no-op
				const approved = await ports.confirm({
					kind: 'destructive-write',
					title: `Remove ${trackIds.length} tracks from ${pl.source} playlist "${pl.name}"`,
					detailLines: detailLines(tracks),
				});
				if (!approved) throw deny();
				const res = await svc().removeTracksFromPlaylist(playlistId, trackIds);
				return { ok: true, removed: res.removed, upstream: res.upstream };
			},
		},
		{
			name: 'rename_playlist',
			description: 'Rename a playlist. Renaming a spotify/tidal playlist pushes the new name to the user\'s live account and requires in-app confirmation.',
			parameters: {
				type: 'object',
				properties: {
					playlistId: { type: 'string' },
					newName: { type: 'string' },
				},
				required: ['playlistId', 'newName'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const playlistId = str(a['playlistId']);
				const newName = str(a['newName']);
				if (!playlistId || !newName) throw new Error('playlistId and newName are required');
				const pl = await requirePlaylist(playlistId);
				if (STREAMING_SOURCES.has(pl.source)) {
					const approved = await ports.confirm({
						kind: 'streaming-playlist-write',
						title: `Rename ${pl.source} playlist "${pl.name}" to "${newName}"`,
						detailLines: [],
					});
					if (!approved) throw deny();
				}
				const res = await svc().renamePlaylist(playlistId, newName);
				if (!STREAMING_SOURCES.has(pl.source)) {
					ports.notify(`Claude renamed playlist "${pl.name}" to "${newName}"`);
				}
				return { ok: true, pushedToSource: res.pushedToSource };
			},
		},
		{
			name: 'tag_tracks',
			description: 'Add and/or remove Curator tags on library tracks (local metadata only — never touches streaming accounts). Tag names are matched case-insensitively; createMissing creates unknown tags in `add`.',
			parameters: {
				type: 'object',
				properties: {
					trackIds: { type: 'array', items: { type: 'string' } },
					add: { type: 'array', items: { type: 'string' }, description: 'Tag names to add.' },
					remove: { type: 'array', items: { type: 'string' }, description: 'Tag names to remove.' },
					createMissing: { type: 'boolean', description: 'Create tags in `add` that do not exist yet. Default false.' },
				},
				required: ['trackIds'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const trackIds = strArray(a['trackIds']);
				if (trackIds.length === 0) throw new Error('trackIds is required');
				const addNames = strArray(a['add']);
				const removeNames = strArray(a['remove']);
				if (addNames.length === 0 && removeNames.length === 0) throw new Error('nothing to do — pass add and/or remove');
				await requireTracks(trackIds);

				const tags = await svc().getTags();
				const byName = new Map(tags.map((t) => [t.name.toLowerCase(), t]));
				const resolve = async (name: string, createMissing: boolean) => {
					const hit = byName.get(name.toLowerCase());
					if (hit) return hit;
					if (!createMissing) throw new Error(`unknown tag "${name}" — existing tags: ${tags.map((t) => t.name).slice(0, 30).join(', ')} (pass createMissing to create it)`);
					const created = await svc().createTag(name);
					byName.set(created.name.toLowerCase(), created);
					return created;
				};

				let added = 0;
				let removed = 0;
				for (const name of addNames) {
					const tag = await resolve(name, a['createMissing'] === true);
					for (const trackId of trackIds) { await svc().addTrackTag(trackId, tag.id); added++; }
				}
				for (const name of removeNames) {
					const tag = byName.get(name.toLowerCase());
					if (!tag) continue; // removing a nonexistent tag is a no-op
					for (const trackId of trackIds) { await svc().removeTrackTag(trackId, tag.id); removed++; }
				}
				ports.notify(`Claude tagged ${trackIds.length} tracks (${addNames.length > 0 ? `+${addNames.join(', ')}` : ''}${removeNames.length > 0 ? ` -${removeNames.join(', ')}` : ''})`);
				return { ok: true, tracks: trackIds.length, added, removed };
			},
		},
		{
			name: 'set_rating',
			description: 'Set the rating (0–5 stars, or null to clear) on library tracks. Local metadata only.',
			parameters: {
				type: 'object',
				properties: {
					trackIds: { type: 'array', items: { type: 'string' } },
					rating: { type: ['number', 'null'], minimum: 0, maximum: 5 },
				},
				required: ['trackIds', 'rating'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const trackIds = strArray(a['trackIds']);
				if (trackIds.length === 0) throw new Error('trackIds is required');
				const rating = a['rating'];
				if (rating !== null && (typeof rating !== 'number' || rating < 0 || rating > 5)) {
					throw new Error('rating must be 0–5 or null');
				}
				await requireTracks(trackIds);
				await svc().setRating(trackIds, rating as number | null);
				ports.notify(`Claude set rating ${rating === null ? '(cleared)' : `${rating}★`} on ${trackIds.length} tracks`);
				return { ok: true, tracks: trackIds.length };
			},
		},
		{
			name: 'set_track_source_links',
			description:
				'Link a library track to its provider page by URL (spotify / tidal / beatport). Upserts the source link and refetches that provider\'s metadata server-side, filling canonical fields the user hasn\'t overridden. '
				+ 'Errors per source when the URL doesn\'t parse or the provider track is already linked to a DIFFERENT library track (identity guard). Local metadata only. Does not delete links — omit sources to leave them unchanged.',
			parameters: {
				type: 'object',
				properties: {
					trackId: { type: 'string' },
					spotify: { type: 'string', description: 'https://open.spotify.com/track/… URL.' },
					tidal: { type: 'string', description: 'https://tidal.com/browse/track/… URL.' },
					beatport: { type: 'string', description: 'https://www.beatport.com/track/…/… URL.' },
				},
				required: ['trackId'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const trackId = str(a['trackId']);
				if (!trackId) throw new Error('trackId is required');
				const urls: { spotify?: string; tidal?: string; beatport?: string } = {};
				for (const source of ['spotify', 'tidal', 'beatport'] as const) {
					const v = str(a[source]);
					if (v) urls[source] = v;
				}
				if (Object.keys(urls).length === 0) throw new Error('pass at least one of spotify / tidal / beatport');
				const [track] = await requireTracks([trackId]);
				const res = await svc().setTrackSourceLinks(trackId, urls);
				if (res.updated.length > 0) {
					ports.notify(`Claude linked ${res.updated.join(', ')} on "${track!.title}"${res.refetched.length > 0 ? ` (refetched ${res.refetched.join(', ')})` : ''}`);
				}
				return { ok: res.errors.length === 0, updated: res.updated, refetched: res.refetched, errors: res.errors };
			},
		},
		{
			name: 'update_track_fields',
			description:
				'Update metadata on one or more library tracks: title, artists, albumTitle, label, genre, bpm, key (Camelot "8A" or musical "Am"/"Bb major"), releaseDate ("2021" / "2021-03" / "2021-03-15"). '
				+ 'Non-null values become user overrides that shadow synced values and survive re-sync/enrichment; pass null for a field to CLEAR it (drops the override AND empties the stored value, except title/artists which revert to the synced value). '
				+ 'The same patch applies to every track in trackIds. For rating use set_rating; for tags use tag_tracks. Local metadata only — never touches streaming accounts.',
			parameters: {
				type: 'object',
				properties: {
					trackIds: { type: 'array', items: { type: 'string' }, description: 'Library track ids the patch applies to.' },
					patch: {
						type: 'object',
						properties: {
							title: { type: ['string', 'null'] },
							artists: {
								type: ['array', 'null'],
								items: { type: ['string', 'object'], properties: { name: { type: 'string' }, role: { type: 'string', enum: ['main', 'featured', 'remixer'] } } },
								description: 'Full replacement credit list. Entries are names ("Ben Böhmer"; a packed "A, B feat. C" is split with the app\'s credit rules) or { name, role } with role "featured" | "remixer" ("main" = no role).',
							},
							albumTitle: { type: ['string', 'null'] },
							label: { type: ['string', 'null'] },
							genre: { type: ['string', 'null'] },
							bpm: { type: ['number', 'null'] },
							keyCamelot: { type: ['string', 'null'], description: 'Camelot ("8A") or musical ("Am", "F# minor") — stored as Camelot.' },
							releaseDate: { type: ['string', 'null'], description: 'ISO date: "2021", "2021-03" or "2021-03-15".' },
						},
					},
				},
				required: ['trackIds', 'patch'],
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const trackIds = strArray(a['trackIds']);
				if (trackIds.length === 0) throw new Error('trackIds is required');
				const rawPatch = asArgs(a['patch']);

				// Same split as the in-app Edit Track modal (features/editTrack.ts):
				// non-null values apply as overrides, explicit nulls hard-clear via
				// clearTrackFields — "make this empty" beats "peel one layer".
				const setPatch: Partial<Record<keyof TrackOverrides, TrackOverrides[keyof TrackOverrides]>> = {};
				const clearList: (keyof TrackOverrides)[] = [];
				const FIELDS: (keyof TrackOverrides)[] = ['title', 'artists', 'albumTitle', 'label', 'genre', 'bpm', 'keyCamelot', 'releaseDate'];
				for (const f of FIELDS) {
					if (!(f in rawPatch)) continue;
					const v = rawPatch[f];
					if (v === null) { clearList.push(f); continue; }
					switch (f) {
						case 'artists': {
							if (!Array.isArray(v)) throw new Error('artists must be an array of names / { name, role } (or null)');
							// Roles are explicit per entry — never positional. A bare
							// string goes through the shared credit splitter so
							// "A, B feat. C" lands as three credits with C featured.
							const list: TrackArtist[] = [];
							for (const x of v) {
								if (typeof x === 'string') { list.push(...splitArtistCredit(x)); continue; }
								if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
									const role = (x as { role?: unknown }).role;
									if (role != null && role !== 'main' && role !== 'featured' && role !== 'remixer') {
										throw new Error(`artist role must be "main" | "featured" | "remixer" — got "${String(role)}"`);
									}
									const r = role === 'featured' || role === 'remixer' ? role : undefined;
									list.push(...splitArtistCredit((x as { name: string }).name, { role: r }));
									continue;
								}
								throw new Error('artists entries must be names or { name, role }');
							}
							if (list.length === 0) throw new Error('artists must contain at least one name (use null to clear)');
							setPatch.artists = list;
							break;
						}
						case 'bpm': {
							if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 300) throw new Error('bpm must be a number in (0, 300]');
							setPatch.bpm = v;
							break;
						}
						case 'keyCamelot': {
							if (typeof v !== 'string') throw new Error('keyCamelot must be a string (or null)');
							const raw = v.trim();
							const camelot = /^([0-9]|1[0-2])[AB]$/i.test(raw) ? raw.toUpperCase() : keyToCamelot(raw);
							if (!camelot) throw new Error(`unrecognized key "${v}" — use Camelot ("8A") or musical ("Am", "F# minor")`);
							setPatch.keyCamelot = camelot;
							break;
						}
						case 'releaseDate': {
							if (typeof v !== 'string' || !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(v.trim())) {
								throw new Error(`releaseDate must be "YYYY", "YYYY-MM" or "YYYY-MM-DD" — got "${String(v)}"`);
							}
							setPatch.releaseDate = v.trim();
							break;
						}
						default: {
							if (typeof v !== 'string' || v.trim().length === 0) throw new Error(`${f} must be a non-empty string (or null to clear)`);
							(setPatch as Record<string, unknown>)[f] = v.trim();
						}
					}
				}
				if (Object.keys(setPatch).length === 0 && clearList.length === 0) throw new Error('patch has no recognized fields');

				const tracks = await requireTracks(trackIds);
				for (const trackId of trackIds) {
					if (Object.keys(setPatch).length > 0) await svc().setTrackOverrides(trackId, setPatch);
					if (clearList.length > 0) await svc().clearTrackFields(trackId, clearList);
				}
				const what = [
					...Object.keys(setPatch),
					...clearList.map((f) => `${f} (cleared)`),
				].join(', ');
				ports.notify(trackIds.length === 1
					? `Claude updated ${what} on "${tracks[0]!.title}"`
					: `Claude updated ${what} on ${trackIds.length} tracks`);
				return { ok: true, tracks: trackIds.length, set: Object.keys(setPatch), cleared: clearList };
			},
		},
		{
			name: 'set_play_session_kind',
			description:
				'Reclassify a play session as "set" (a real DJ set) or "prep" (auditioning). Overrides the automatic '
				+ 'classification permanently — future rekordbox imports will not change it back. Local-DB only; '
				+ 'nothing is written to rekordbox or streaming accounts. Use session ids from list_play_sessions.',
			parameters: {
				type: 'object',
				properties: {
					sessionId: { type: 'string' },
					kind: { type: 'string', enum: ['set', 'prep'] },
				},
				required: ['sessionId', 'kind'],
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const sessionId = str(a['sessionId']);
				const kind = str(a['kind']);
				if (!sessionId) throw new Error('sessionId is required');
				if (kind !== 'set' && kind !== 'prep') throw new Error('kind must be "set" or "prep"');
				// Local-only write — no confirm gate per this file's policy;
				// the toast keeps the user in the loop.
				await svc().setPlaySessionKind(sessionId, kind);
				ports.notify(`Claude marked a play session as "${kind}"`);
				return { ok: true, sessionId, kind };
			},
		},
	];

	const byName = new Map(tools.map((t) => [t.name, t]));
	return {
		specs: () => tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		has: (name) => byName.has(name),
		async execute(name, args) {
			const tool = byName.get(name);
			if (!tool) throw new Error(`unknown write tool: ${name}`);
			return tool.execute(args);
		},
	};
}
