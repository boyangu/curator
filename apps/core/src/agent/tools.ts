// Agent tool registry — the explicit, read-only allowlist of what the agent
// can do. Deliberately NOT derived from TOOL_CATALOG: the catalog carries
// writes (tracks:delete, playlist mutations, rekordbox push) and the
// in-process CoreService holds remoteWritePolicy — read-only here is a
// property enforced by construction, not by prompt.
//
// Tool parameter schemas are plain JSON Schema constants (never zod): they
// cross the sidecar boundary as JSON, and core's zod 3 must not couple to
// the sidecar's zod 4.
//
// Every query tool returns COMPACT rows with a hard limit — tool results
// live in model context, and context is the cost floor of every turn.

import type { SpotifyClient } from '@curator/spotify';
import type { BeatportClient } from '@curator/beatport';
import type { CoreService } from '../service.js';
import type { KbAspect, KbEntity, KbEntityDetail, KbExpansion } from '../knowledge/types.js';
import type { WireToolSpec } from './protocol.js';
import { draftsFromWorkspaceRows, ProviderHitCache, type AgentResultItemDraft } from './result-set.js';
import type { SessionWorkspace, WorkspaceLoadSummary, RowProvenance } from './workspace/manager.js';
import { validTableName, type WorkspaceColumn } from './workspace/engine.js';

// Per-turn context handed to every execute. The view-tool callbacks are
// implemented by AgentService (they need the session/turn identity and the
// event bus); the provider-hit cache scopes result-set validation to what
// the model actually saw this turn. `workspace` is the session's
// deterministic data runtime — null when disabled (:memory: core, no paths).
export interface AgentToolCtx {
	providerHits: ProviderHitCache;
	workspace: SessionWorkspace | null;
	presentResultSet(input: {
		title: string;
		summary?: string;
		items: AgentResultItemDraft[];
	}): Promise<{ resultSetId: string; accepted: number; rejected: { index: number; reason: string }[] }>;
	setFeedFilters(input: { genre?: string | null; label?: string | null }): Promise<{ ok: boolean; note?: string }>;
}

export interface AgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	// Host-side watchdog override for long-running tools (the pipeline map);
	// absent ⇒ the sidecar manager's 60s default.
	timeoutMs?: number;
	execute(args: unknown, ctx: AgentToolCtx): Promise<unknown>;
}

// Ports into the rest of core. `svc` is a thunk because the agent service is
// composed inside createCoreService before the service object literal exists
// (same forward-ref pattern as feedUnpromote).
export interface AgentToolPorts {
	svc(): CoreService;
	getSpotifyClient(): Promise<SpotifyClient | null>;
	beatport: BeatportClient | null;
	// Bounded wait for an agent-tier KB expansion to land (kb:event stream).
	waitForKbExpansion(entityId: string, aspect: KbAspect, timeoutMs: number): Promise<boolean>;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clampLimit(v: unknown): number {
	const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_LIMIT;
	return Math.min(Math.max(n, 1), MAX_LIMIT);
}

type Args = Record<string, unknown>;
const asArgs = (a: unknown): Args => (a && typeof a === 'object' ? (a as Args) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// ISO date/datetime string → epoch ms; undefined for anything unparseable.
const isoToMs = (v: unknown): number | undefined => {
	const s = str(v);
	if (!s) return undefined;
	const ms = Date.parse(s);
	return Number.isFinite(ms) ? ms : undefined;
};

// Shared JSON-Schema fragment for the loadInto option (workspace ingestion).
const LOAD_INTO_SCHEMA = {
	type: 'object',
	description: 'Load the FULL result (not one page) into a workspace table instead of returning rows. You get back only {table, rowCount, columns, sample} — then use query_workspace SQL for the heavy lifting.',
	properties: {
		table: { type: 'string', description: 'Table name: lowercase, letters/digits/underscore, e.g. "afterlife_tracks".' },
	},
	required: ['table'],
	additionalProperties: false,
} as const;

function loadIntoTable(a: Args): string | null {
	const li = a['loadInto'];
	if (!li || typeof li !== 'object') return null;
	return str((li as Args)['table']) ?? null;
}

function requireWorkspace(ctx: AgentToolCtx): SessionWorkspace {
	if (!ctx.workspace) throw new Error('the workspace is unavailable in this environment');
	return ctx.workspace;
}

// Yield the event loop between paged reads so a big load can't starve main.
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

async function loadRowsInto(
	ws: SessionWorkspace,
	table: string,
	columns: WorkspaceColumn[],
	rows: Record<string, unknown>[],
	provenance: (row: Record<string, unknown>) => RowProvenance,
): Promise<WorkspaceLoadSummary & { note: string }> {
	const summary = await ws.loadDataset({ table, columns, rows, provenance });
	return { ...summary, note: `loaded into workspace table "${summary.table}" — query it with query_workspace` };
}

// Compact one library track row for model context.
function compactTrack(t: {
	id: string;
	title: string;
	artists: { name: string }[];
	albumTitle?: string | null;
	bpm?: number | null;
	keyCamelot?: string | null;
	genre?: string | null;
	label?: string | null;
	rating?: number | null;
	state?: string | null;
	duration?: number | null;
	releaseDate?: string | null;
	deletedAt?: Date | null;
}): Record<string, unknown> {
	return {
		id: t.id,
		// Only a followed playlist's read returns one (the user deleted it, the
		// playlist they don't own still lists it — the app shows a "deleted" chip).
		...(t.deletedAt ? { deleted: true } : {}),
		title: t.title,
		artists: t.artists.map((a) => a.name),
		...(t.albumTitle ? { album: t.albumTitle } : {}),
		...(t.bpm != null ? { bpm: t.bpm } : {}),
		...(t.keyCamelot ? { key: t.keyCamelot } : {}),
		...(t.genre ? { genre: t.genre } : {}),
		...(t.label ? { label: t.label } : {}),
		...(t.rating != null ? { rating: t.rating } : {}),
		...(t.state ? { state: t.state } : {}),
		...(t.duration != null ? { durationSec: t.duration } : {}),
		...(t.releaseDate ? { releaseDate: t.releaseDate } : {}),
	};
}

function compactKbEntity(e: KbEntity): Record<string, unknown> {
	return {
		id: e.id,
		kind: e.kind,
		name: e.name,
		...(e.isrc ? { isrc: e.isrc } : {}),
		...(e.releaseDate ? { releaseDate: e.releaseDate } : {}),
		...(e.durationSec != null ? { durationSec: e.durationSec } : {}),
	};
}

function compactKbDetail(d: KbEntityDetail): Record<string, unknown> {
	return {
		entity: compactKbEntity(d.entity),
		edges: d.edges.slice(0, 100).map((e) => {
			const neighborId = e.srcId === d.entity.id ? e.dstId : e.srcId;
			const neighbor = d.neighbors[neighborId];
			return {
				kind: e.kind,
				neighborId,
				...(neighbor ? { neighborKind: neighbor.kind, neighborName: neighbor.name } : {}),
				tier: e.tier,
				...(e.tier === 'agent' ? { confidence: e.confidence, citations: (e.attrs?.['citations'] as string[] | undefined) ?? [] } : {}),
			};
		}),
		...(d.edges.length > 100 ? { edgesTruncated: d.edges.length } : {}),
		availableAspects: d.availableAspects,
		inLibraryTrackIds: d.inLibrary,
	};
}

function compactExpansion(x: KbExpansion): Record<string, unknown> {
	return {
		status: x.status,
		entities: x.entities.slice(0, MAX_LIMIT).map(compactKbEntity),
		...(x.entities.length > MAX_LIMIT ? { entitiesTruncated: x.entities.length } : {}),
	};
}

// Inner tools the pipeline map may fan out over, with per-tool row caps
// (Beatport is rate-gated — a bigger batch would just trip the cooldown).
const MAPPABLE_TOOLS: Record<string, { maxRows: number }> = {
	lookup_beatport: { maxRows: 25 },
	search_spotify: { maxRows: 50 },
	get_track_detail: { maxRows: 100 },
	get_kb_entity: { maxRows: 100 },
	get_similar_tracks: { maxRows: 50 },
};

const RESULT_ITEM_KINDS = new Set(['library-track', 'feed-item', 'kb-entity', 'provider-hit']);

// Turn-cache wrapper that mirrors every record into the session cache —
// provider hits discovered DURING a pipeline map must stay presentable in
// later turns, exactly like workspace-loaded rows.
class MirroringProviderHitCache extends ProviderHitCache {
	constructor(
		private readonly primary: ProviderHitCache,
		private readonly sessionMirror: ProviderHitCache,
	) { super(); }
	override record(provider: string, id: string, extra?: { url?: string; playSpotifyId?: string }): void {
		this.primary.record(provider, id, extra);
		this.sessionMirror.record(provider, id, extra);
	}
	override get(provider: string, id: string): { url?: string; playSpotifyId?: string } | undefined {
		return this.primary.get(provider, id);
	}
	override has(provider: string, id: string): boolean {
		return this.primary.has(provider, id);
	}
}

export function buildAgentTools(ports: AgentToolPorts): AgentTool[] {
	const tools: AgentTool[] = [
		{
			name: 'query_library',
			description:
				'Search the user\'s music library (their canonical track collection). Filterable by free-text search, '
				+ 'genre, label, Camelot key, BPM range, workflow state and playlist. Returns one page of compact rows '
				+ 'plus the matching total. Call get_library_facets first when filtering by genre/label so you use values '
				+ 'that actually exist. For multi-page work (aggregate/dedupe/sort across many tracks) pass loadInto to '
				+ 'materialize the FULL filter result into a workspace table. Scope with playlistId / source when the '
				+ 'user\'s current view implies it.',
			parameters: {
				type: 'object',
				properties: {
					search: { type: 'string', description: 'Free-text over title/artist/album.' },
					genre: { type: 'string' },
					label: { type: 'string' },
					keyCamelot: { type: 'string', description: 'Camelot key, e.g. "8A".' },
					bpmMin: { type: 'number' },
					bpmMax: { type: 'number' },
					state: { type: 'string', enum: ['feed', 'backlog', 'progress', 'purchased', 'unsorted'] },
					playlistId: { type: 'string' },
					source: { type: 'string', enum: ['spotify', 'tidal', 'local', 'rekordbox'], description: 'Restrict to tracks carrying this source (local = has a file on disk; rekordbox = in the rekordbox collection) — use when the user\'s current view is a source tab and the ask is ambiguous.' },
					minRating: { type: 'number', description: 'Only tracks rated at least this (1–5 stars).' },
					sortColumn: { type: 'string', enum: ['title', 'artist', 'album', 'releaseDate', 'label', 'genre', 'bpm', 'keyCamelot', 'duration', 'createdAt', 'rating'] },
					sortDir: { type: 'string', enum: ['asc', 'desc'] },
					limit: { type: 'number', description: 'Rows per page, max 100 (default 25).' },
					offset: { type: 'number' },
					loadInto: LOAD_INTO_SCHEMA,
				},
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const filter = {
					...(str(a['search']) ? { search: str(a['search']) } : {}),
					...(str(a['genre']) ? { genre: str(a['genre']) } : {}),
					...(str(a['label']) ? { label: str(a['label']) } : {}),
					...(str(a['keyCamelot']) ? { keyCamelot: str(a['keyCamelot']) } : {}),
					...(num(a['bpmMin']) != null ? { bpmMin: num(a['bpmMin']) } : {}),
					...(num(a['bpmMax']) != null ? { bpmMax: num(a['bpmMax']) } : {}),
					...(str(a['state']) ? { state: a['state'] as 'feed' } : {}),
					...(str(a['playlistId']) ? { playlistId: str(a['playlistId']) } : {}),
					// Membership predicate rather than the source_link join: it
					// resolves 'rekordbox' to rekordbox_link (rb provenance isn't a
					// source_link row) and composes with the other filters.
					...(str(a['source']) ? { hasSource: str(a['source'])! } : {}),
					...(num(a['minRating']) != null ? { scalarBounds: [{ field: 'rating' as const, min: num(a['minRating'])! }] } : {}),
				};
				const sort = str(a['sortColumn'])
					? { column: a['sortColumn'] as 'title', dir: (str(a['sortDir']) ?? 'asc') as 'asc' | 'desc' }
					: undefined;
				const loadTable = loadIntoTable(a);
				if (loadTable) {
					const ws = requireWorkspace(ctx);
					const LOAD_PAGE = 5000;
					const LOAD_CAP = 50_000;
					const rows: Record<string, unknown>[] = [];
					for (let offset = 0; rows.length < LOAD_CAP; offset += LOAD_PAGE) {
						const page = await ports.svc().getTracksPage(filter, sort, { limit: LOAD_PAGE, offset });
						for (const t of page.items) {
							// A followed playlist still lists tracks the user deleted;
							// they aren't library tracks, so they don't enter the workspace.
							if (t.deletedAt) continue;
							rows.push({
								id: t.id,
								title: t.title,
								artists: t.artists.map((ar) => ar.name).join(' | '),
								album: t.albumTitle ?? null,
								genre: t.genre ?? null,
								label: t.label ?? null,
								bpm: t.bpm ?? null,
								key_camelot: t.keyCamelot ?? null,
								isrc: t.isrc ?? null,
								release_date: t.releaseDate ?? null,
								duration_sec: t.duration ?? null,
								rating: t.rating ?? null,
								state: t.state,
							});
						}
						if (page.items.length < LOAD_PAGE) break;
						await yieldLoop();
					}
					return loadRowsInto(ws, loadTable, [
						{ name: 'id', type: 'text' }, { name: 'title', type: 'text' }, { name: 'artists', type: 'text' },
						{ name: 'album', type: 'text' }, { name: 'genre', type: 'text' }, { name: 'label', type: 'text' },
						{ name: 'bpm', type: 'real' }, { name: 'key_camelot', type: 'text' }, { name: 'isrc', type: 'text' },
						{ name: 'release_date', type: 'text' }, { name: 'duration_sec', type: 'integer' },
						{ name: 'rating', type: 'integer' }, { name: 'state', type: 'text' },
					], rows.slice(0, LOAD_CAP), (row) => ({ kind: 'library-track', refId: String(row['id']) }));
				}
				const page = await ports.svc().getTracksPage(filter, sort, {
					limit: clampLimit(a['limit']),
					offset: num(a['offset']) ?? 0,
				});
				return { total: page.total, tracks: page.items.map(compactTrack) };
			},
		},
		{
			name: 'get_library_facets',
			description:
				'Return the library\'s total track count, distinct genres and labels (capped lists), track counts per '
				+ 'workflow state, and the user\'s playlists (id + name). Call this before filtering by genre/label/playlist '
				+ 'so your filter values match real data instead of guesses.',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			async execute() {
				const svc = ports.svc();
				const [fields, states, playlists, page] = await Promise.all([
					svc.getLibraryFieldOptions(),
					svc.getStateCounts(),
					svc.getPlaylists(),
					svc.getTracksPage(undefined, undefined, { limit: 1 }),
				]);
				// Capped lists: a large library's label set alone (1000+) would eat
				// the tool-result byte budget; the model filters via query_library
				// search when it needs the long tail.
				const FACET_CAP = 150;
				return {
					totalTracks: page.total,
					genres: fields.genres.slice(0, FACET_CAP),
					...(fields.genres.length > FACET_CAP ? { genresTruncated: fields.genres.length } : {}),
					labels: fields.labels.slice(0, FACET_CAP),
					...(fields.labels.length > FACET_CAP ? { labelsTruncated: fields.labels.length } : {}),
					stateCounts: states,
					playlists: playlists.slice(0, 200).map((p) => ({ id: p.id, name: p.name, source: p.source })),
				};
			},
		},
		{
			name: 'get_library_favorites',
			description:
				'The user\'s top artists / labels / genres, derived from their library: track count + average rating per '
				+ 'name, most-collected first. THE first call for any "my favourite …" request. Then cross-reference in '
				+ 'one more call — e.g. new feed releases by these names: present_result_set fromWorkspace with '
				+ 'SELECT DISTINCT \'feed-item\' AS _kind, f.id AS _ref_id, f.title, f.artists, f.label, f.release_date '
				+ 'FROM v_feed_item f JOIN v_feed_artist fa ON fa.item_id = f.id WHERE fa.artist IN (…names…) '
				+ 'ORDER BY f.published_at DESC (for labels: WHERE f.label IN (…)).',
			parameters: {
				type: 'object',
				properties: {
					dimension: { type: 'string', enum: ['artists', 'labels', 'genres'] },
					limit: { type: 'number', description: 'Top N, max 200 (default 10).' },
					minRating: { type: 'number', description: 'Only count tracks rated at least this (1–5) — "favourite" as in rated, not just collected.' },
				},
				required: ['dimension'],
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const ws = requireWorkspace(ctx);
				const dimension = str(a['dimension']);
				const limit = Math.min(Math.max(num(a['limit']) ?? 10, 1), 200);
				const minRating = num(a['minRating']);
				const ratingWhere = minRating != null ? `t.rating >= ${Math.min(Math.max(minRating, 0), 5)}` : null;
				let sql: string;
				if (dimension === 'artists') {
					sql = `
						SELECT a.artist AS name, COUNT(*) AS track_count, ROUND(AVG(t.rating), 2) AS avg_rating
						FROM v_track_artist a JOIN v_track t ON t.id = a.track_id
						${ratingWhere ? `WHERE ${ratingWhere}` : ''}
						GROUP BY a.artist ORDER BY track_count DESC, avg_rating DESC LIMIT ${limit}`;
				} else if (dimension === 'labels' || dimension === 'genres') {
					const col = dimension === 'labels' ? 'label' : 'genre';
					sql = `
						SELECT t.${col} AS name, COUNT(*) AS track_count, ROUND(AVG(t.rating), 2) AS avg_rating
						FROM v_track t WHERE t.${col} IS NOT NULL${ratingWhere ? ` AND ${ratingWhere}` : ''}
						GROUP BY t.${col} ORDER BY track_count DESC, avg_rating DESC LIMIT ${limit}`;
				} else {
					throw new Error('dimension must be artists | labels | genres');
				}
				const res = await ws.query(sql, limit);
				return {
					favorites: res.rows.map((row) => ({
						name: row[0],
						trackCount: row[1],
						...(row[2] != null ? { avgRating: row[2] } : {}),
					})),
				};
			},
		},
		{
			name: 'get_track_detail',
			description: 'Full detail for one library track by id: all fields, per-provider source links, and audio analysis (BPM, key, brightness, power) when available.',
			parameters: {
				type: 'object',
				properties: { trackId: { type: 'string' } },
				required: ['trackId'],
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const trackId = str(asArgs(rawArgs)['trackId']);
				if (!trackId) throw new Error('trackId required');
				const svc = ports.svc();
				const [rows, links, analysis] = await Promise.all([
					svc.getTracks({ ids: [trackId] }),
					svc.getTrackSourceLinks(trackId),
					svc.getTrackAnalysis(trackId).catch(() => null),
				]);
				const track = rows[0];
				if (!track) throw new Error(`no library track with id ${trackId}`);
				return {
					track: compactTrack(track),
					sourceLinks: links,
					...(analysis
						? { analysis: { bpm: analysis.bpm, key: analysis.keyCamelot, brightness: analysis.brightness, power: analysis.power } }
						: {}),
				};
			},
		},
		{
			name: 'query_feed',
			description:
				'Page through the user\'s Discover feed (new releases from followed artists/playlists, newest first). '
				+ 'Optional genre/label filter (use values from the feed itself — an unknown value returns nothing). '
				+ 'Returns compact items + keyset cursor for the next page. Pass loadInto to materialize the whole '
				+ '(filtered) feed into a workspace table instead of paging manually.',
			parameters: {
				type: 'object',
				properties: {
					genre: { type: 'string' },
					label: { type: 'string' },
					cursor: { type: 'string', description: 'nextCursor from the previous page.' },
					limit: { type: 'number', description: 'Max 100 (default 25).' },
					loadInto: LOAD_INTO_SCHEMA,
				},
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const loadTable = loadIntoTable(a);
				if (loadTable) {
					const ws = requireWorkspace(ctx);
					const LOAD_CAP = 5000;
					const rows: Record<string, unknown>[] = [];
					let cursor: string | null = null;
					do {
						const page = await ports.svc().getFeedPage({
							limit: 100,
							...(cursor ? { cursor } : {}),
							...(str(a['genre']) ? { genre: str(a['genre']) } : {}),
							...(str(a['label']) ? { label: str(a['label']) } : {}),
						});
						for (const item of page.items) {
							if (item.type === 'track' && item.source === 'spotify') {
								ctx.providerHits.record('spotify', item.sourceId, { playSpotifyId: item.sourceId });
							}
							rows.push({
								id: item.id,
								type: item.type,
								title: item.payload.title,
								artists: item.payload.artists.join(' | '),
								genre: item.payload.genre ?? null,
								label: item.payload.label ?? null,
								bpm: item.payload.bpm ?? null,
								key_camelot: item.payload.keyCamelot ?? null,
								isrc: item.payload.isrc ?? null,
								release_date: item.payload.releaseDate ?? null,
								published_at: item.publishedAt,
								origin: item.origin?.name ?? null,
							});
						}
						cursor = page.nextCursor;
						await yieldLoop();
					} while (cursor && rows.length < LOAD_CAP);
					return loadRowsInto(ws, loadTable, [
						{ name: 'id', type: 'text' }, { name: 'type', type: 'text' }, { name: 'title', type: 'text' },
						{ name: 'artists', type: 'text' }, { name: 'genre', type: 'text' }, { name: 'label', type: 'text' },
						{ name: 'bpm', type: 'real' }, { name: 'key_camelot', type: 'text' }, { name: 'isrc', type: 'text' },
						{ name: 'release_date', type: 'text' }, { name: 'published_at', type: 'integer' }, { name: 'origin', type: 'text' },
					], rows.slice(0, LOAD_CAP), (row) => ({ kind: 'feed-item', refId: String(row['id']) }));
				}
				const page = await ports.svc().getFeedPage({
					limit: clampLimit(a['limit']),
					...(str(a['cursor']) ? { cursor: str(a['cursor']) } : {}),
					...(str(a['genre']) ? { genre: str(a['genre']) } : {}),
					...(str(a['label']) ? { label: str(a['label']) } : {}),
				});
				for (const item of page.items) {
					if (item.type === 'track' && item.source === 'spotify') {
						ctx.providerHits.record('spotify', item.sourceId, { playSpotifyId: item.sourceId });
					}
				}
				return {
					total: page.total,
					nextCursor: page.nextCursor,
					items: page.items.map((i) => ({
						id: i.id,
						type: i.type,
						title: i.payload.title,
						artists: i.payload.artists,
						...(i.payload.genre ? { genre: i.payload.genre } : {}),
						...(i.payload.label ? { label: i.payload.label } : {}),
						...(i.payload.bpm != null ? { bpm: i.payload.bpm } : {}),
						...(i.payload.releaseDate ? { releaseDate: i.payload.releaseDate } : {}),
						...(i.origin?.name ? { origin: i.origin.name } : {}),
						...(i.publishedAt ? { publishedAt: new Date(i.publishedAt).toISOString().slice(0, 10) } : {}),
					})),
				};
			},
		},
		{
			name: 'get_feed_item',
			description: 'Expand one Discover feed item by id: album tracklist with per-track DJ metadata (BPM/key/genre/label) and which tracks the library already holds. Pass loadInto to add the tracklist rows to a workspace table.',
			parameters: {
				type: 'object',
				properties: { itemId: { type: 'string' }, loadInto: LOAD_INTO_SCHEMA },
				required: ['itemId'],
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const itemId = str(a['itemId']);
				if (!itemId) throw new Error('itemId required');
				const detail = await ports.svc().getFeedItemDetail(itemId);
				if (!detail) throw new Error(`no feed item with id ${itemId}`);
				const tracks = detail.item.payload.tracks ?? [];
				for (const t of tracks) {
					ctx.providerHits.record('spotify', t.sourceTrackId, { playSpotifyId: t.sourceTrackId });
				}
				const loadTable = loadIntoTable(a);
				if (loadTable) {
					const ws = requireWorkspace(ctx);
					const rows = tracks.slice(0, 500).map((t) => ({
						spotify_track_id: t.sourceTrackId,
						title: t.title,
						artists: t.artists.join(' | '),
						bpm: t.bpm ?? null,
						key_camelot: t.keyCamelot ?? null,
						genre: t.genre ?? null,
						label: t.label ?? null,
						isrc: t.isrc ?? null,
						duration_sec: t.durationSec ?? null,
						in_library_track_id: detail.inLibraryTrackIds[t.sourceTrackId] ?? null,
					}));
					return loadRowsInto(ws, loadTable, [
						{ name: 'spotify_track_id', type: 'text' }, { name: 'title', type: 'text' }, { name: 'artists', type: 'text' },
						{ name: 'bpm', type: 'real' }, { name: 'key_camelot', type: 'text' }, { name: 'genre', type: 'text' },
						{ name: 'label', type: 'text' }, { name: 'isrc', type: 'text' }, { name: 'duration_sec', type: 'integer' },
						{ name: 'in_library_track_id', type: 'text' },
					], rows, (row) => ({
						kind: 'provider-hit',
						refId: String(row['spotify_track_id']),
						provider: 'spotify',
						playSpotifyId: String(row['spotify_track_id']),
					}));
				}
				return {
					id: detail.item.id,
					type: detail.item.type,
					title: detail.item.payload.title,
					artists: detail.item.payload.artists,
					...(detail.item.payload.label ? { label: detail.item.payload.label } : {}),
					...(detail.item.payload.releaseDate ? { releaseDate: detail.item.payload.releaseDate } : {}),
					tracks: tracks.slice(0, MAX_LIMIT).map((t) => ({
						spotifyTrackId: t.sourceTrackId,
						title: t.title,
						artists: t.artists,
						...(t.bpm != null ? { bpm: t.bpm } : {}),
						...(t.keyCamelot ? { key: t.keyCamelot } : {}),
						...(t.genre ? { genre: t.genre } : {}),
						...(t.label ? { label: t.label } : {}),
						...(t.isrc ? { isrc: t.isrc } : {}),
						...(detail.inLibraryTrackIds[t.sourceTrackId] ? { inLibraryTrackId: detail.inLibraryTrackIds[t.sourceTrackId] } : {}),
					})),
				};
			},
		},
		{
			name: 'search_kb',
			description:
				'Search the knowledge base (everything Curator has already learned about artists, releases, tracks, labels '
				+ 'and genres) by name. Local and instant — never hits the network. Use get_kb_entity on a hit to see its '
				+ 'relationships.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string' },
					kinds: { type: 'array', items: { type: 'string', enum: ['artist', 'release', 'track', 'label', 'genre'] } },
				},
				required: ['query'],
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const query = str(a['query']);
				if (!query) throw new Error('query required');
				const kinds = Array.isArray(a['kinds']) ? (a['kinds'] as KbEntity['kind'][]) : undefined;
				const hits = await ports.svc().searchKb(query, kinds);
				return { entities: hits.slice(0, MAX_LIMIT).map(compactKbEntity) };
			},
		},
		{
			name: 'get_kb_entity',
			description:
				'Read one knowledge-base entity by id: its fields, relationship edges (releases, tracks, labels, genres, '
				+ 'agent-researched similar artists with confidence + citations), and which related tracks are already in '
				+ 'the library.',
			parameters: {
				type: 'object',
				properties: { entityId: { type: 'string' } },
				required: ['entityId'],
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const entityId = str(asArgs(rawArgs)['entityId']);
				if (!entityId) throw new Error('entityId required');
				const detail = await ports.svc().getKbEntity(entityId);
				if (!detail) throw new Error(`no KB entity with id ${entityId}`);
				return compactKbDetail(detail);
			},
		},
		{
			name: 'expand_kb_entity',
			description:
				'Fetch one aspect of a KB entity through the resolver ladder: "detail" / "releases" (artist), "tracks" '
				+ '(release) hit the catalog; "similar-artists" (artist) runs web research and can take up to a minute — '
				+ 'if this returns status "running", continue with other work and re-call later to collect results.',
			parameters: {
				type: 'object',
				properties: {
					entityId: { type: 'string' },
					aspect: { type: 'string', enum: ['detail', 'releases', 'tracks', 'similar-artists'] },
					loadInto: LOAD_INTO_SCHEMA,
				},
				required: ['entityId', 'aspect'],
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const entityId = str(a['entityId']);
				const aspect = str(a['aspect']) as KbAspect | undefined;
				if (!entityId || !aspect) throw new Error('entityId and aspect required');
				const svc = ports.svc();
				let expansion = await svc.expandKbEntity(entityId, aspect);
				if (expansion.status === 'running') {
					// Agent-tier research: give it a bounded window, then hand the
					// "re-call later" contract back to the model.
					const landed = await ports.waitForKbExpansion(entityId, aspect, 30_000);
					if (landed) expansion = await svc.expandKbEntity(entityId, aspect);
					else return { status: 'running', note: 'research still in progress — re-call expand_kb_entity later to collect results' };
				}
				const loadTable = loadIntoTable(a);
				if (loadTable) {
					const ws = requireWorkspace(ctx);
					const rows = expansion.entities.slice(0, 1000).map((e) => ({
						id: e.id,
						kind: e.kind,
						name: e.name,
						isrc: e.isrc,
						release_date: e.releaseDate,
						duration_sec: e.durationSec,
					}));
					return loadRowsInto(ws, loadTable, [
						{ name: 'id', type: 'text' }, { name: 'kind', type: 'text' }, { name: 'name', type: 'text' },
						{ name: 'isrc', type: 'text' }, { name: 'release_date', type: 'text' }, { name: 'duration_sec', type: 'integer' },
					], rows, (row) => ({ kind: 'kb-entity', refId: String(row['id']) }));
				}
				return compactExpansion(expansion);
			},
		},
		{
			name: 'search_spotify',
			description:
				'Search the Spotify catalog (via the user\'s connected account) for tracks or artists. Use for music that '
				+ 'is NOT in the library/feed/KB yet. Track hits are playable and can be cited in result sets by their id. '
				+ 'Pass loadInto to add the hits to a workspace table (e.g. accumulating candidates across searches).',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Free text; supports Spotify operators like artist:"Max Cooper" year:2026.' },
					kind: { type: 'string', enum: ['track', 'artist'] },
					limit: { type: 'number', description: 'Max 25 (default 10; up to 50 with loadInto).' },
					loadInto: LOAD_INTO_SCHEMA,
				},
				required: ['query', 'kind'],
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const query = str(a['query']);
				const kind = str(a['kind']);
				if (!query || (kind !== 'track' && kind !== 'artist')) throw new Error('query and kind (track|artist) required');
				const client = await ports.getSpotifyClient();
				if (!client) throw new Error('Spotify is not connected — this tool is unavailable');
				const loadTable = loadIntoTable(a);
				if (loadTable && kind === 'track') {
					const ws = requireWorkspace(ctx);
					const tracks = await client.searchTracks(query, Math.min(clampLimit(a['limit'] ?? 50), 50));
					for (const t of tracks) ctx.providerHits.record('spotify', t.id, { playSpotifyId: t.id });
					const rows = tracks.map((t) => ({
						spotify_track_id: t.id,
						title: t.name,
						artists: t.artists.map((ar) => ar.name).join(' | '),
						album: t.album?.name ?? null,
						release_date: t.album?.release_date ?? null,
						isrc: t.external_ids?.isrc ?? null,
						duration_sec: Math.round(t.duration_ms / 1000),
					}));
					return loadRowsInto(ws, loadTable, [
						{ name: 'spotify_track_id', type: 'text' }, { name: 'title', type: 'text' }, { name: 'artists', type: 'text' },
						{ name: 'album', type: 'text' }, { name: 'release_date', type: 'text' }, { name: 'isrc', type: 'text' },
						{ name: 'duration_sec', type: 'integer' },
					], rows, (row) => ({
						kind: 'provider-hit',
						refId: String(row['spotify_track_id']),
						provider: 'spotify',
						playSpotifyId: String(row['spotify_track_id']),
						url: `https://open.spotify.com/track/${String(row['spotify_track_id'])}`,
					}));
				}
				const limit = Math.min(clampLimit(a['limit'] ?? 10), 25);
				if (kind === 'artist') {
					const artists = await client.searchArtists(query, limit);
					for (const ar of artists) ctx.providerHits.record('spotify', ar.id, {});
					return {
						artists: artists.map((ar) => ({
							id: ar.id,
							name: ar.name,
							...(ar.genres && ar.genres.length > 0 ? { genres: ar.genres } : {}),
						})),
					};
				}
				const tracks = await client.searchTracks(query, limit);
				for (const t of tracks) ctx.providerHits.record('spotify', t.id, { playSpotifyId: t.id });
				return {
					tracks: tracks.map((t) => ({
						id: t.id,
						title: t.name,
						artists: t.artists.map((ar) => ar.name),
						...(t.album?.name ? { album: t.album.name } : {}),
						...(t.album?.release_date ? { releaseDate: t.album.release_date } : {}),
						...(t.external_ids?.isrc ? { isrc: t.external_ids.isrc } : {}),
						durationSec: Math.round(t.duration_ms / 1000),
					})),
				};
			},
		},
		{
			name: 'lookup_beatport',
			description:
				'Look up one specific track on Beatport by title + artists to get DJ metadata (BPM, key, genre, label, '
				+ 'release date). One track per call, rate-limited — use for tracks you are seriously considering, not for '
				+ 'bulk scans. May be temporarily blocked; if so, do not retry this turn.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					artists: { type: 'array', items: { type: 'string' } },
					durationSec: { type: 'number', description: 'Improves match confidence when known.' },
				},
				required: ['title', 'artists'],
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const title = str(a['title']);
				const artists = Array.isArray(a['artists']) ? (a['artists'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
				if (!title || artists.length === 0) throw new Error('title and artists required');
				if (!ports.beatport) throw new Error('Beatport lookups are unavailable');
				const hit = await ports.beatport.lookup({ title, artists, duration: num(a['durationSec']) ?? null });
				if (!hit) return { found: false };
				ctx.providerHits.record('beatport', String(hit.id), { url: hit.url });
				return {
					found: true,
					track: {
						beatportId: String(hit.id),
						url: hit.url,
						title: hit.title,
						...(hit.mix ? { mix: hit.mix } : {}),
						artists: hit.artists,
						...(hit.bpm != null ? { bpm: hit.bpm } : {}),
						...(hit.key ? { key: hit.key } : {}),
						...(hit.genre ? { genre: hit.genre } : {}),
						...(hit.label ? { label: hit.label } : {}),
						...(hit.release_date ? { releaseDate: hit.release_date } : {}),
						...(hit.isrc ? { isrc: hit.isrc } : {}),
					},
				};
			},
		},
		{
			name: 'query_workspace',
			description: [
				'Run ONE SQL statement per call (SQLite) over the workspace: your loaded tables (from loadInto on',
				'query_library / query_feed / search_spotify / get_feed_item / expand_kb_entity) plus live READ-ONLY',
				'views of the user\'s data. Use SQL for the heavy lifting — dedupe, joins, aggregation, sorting — then',
				'present with present_result_set fromWorkspace. Results cap at 200 rows; aggregate or add LIMIT.',
				'DERIVE values in SQL, never retype data from earlier tool results as literals — e.g. top artists is',
				'CREATE TEMP TABLE top_artists AS SELECT artist, COUNT(*) AS n FROM v_track_artist GROUP BY artist',
				'ORDER BY n DESC LIMIT 100 — NOT a UNION ALL of hand-copied names/counts.',
				'Scratch space: CREATE TEMP TABLE name AS SELECT … (scratch MUST be TEMP; everything else is read-only).',
				'Live data (prefer the v_ views — they apply the user\'s edits):',
				'• v_track — the library: id, title, artists, album_title, label, genre, bpm, key_camelot, isrc,',
				'  release_date, duration_sec, rating (0-5), state, membership, play_count, brightness, power, added_at',
				'• v_track_artist (track_id, artist) · v_feed_artist (item_id, artist) — exploded one-row-per-artist:',
				'  use for per-artist GROUP BYs and artist-set joins between library and feed',
				'• v_source_link — per-provider refs: track_id, source (spotify|tidal|local|beatport), source_track_id, url',
				'• playlist (id, name, source) · v_playlist_track (playlist_id, track_id, position) — count members',
				'  from v_playlist_track, not playlist.track_count (a provider total that includes deleted tracks)',
				'• tag (id, name) · v_track_tag (track_id, tag_id)',
				'• v_feed_item — discover feed: id, type (track|album), title, artists, genre, label, bpm, isrc,',
				'  release_date, published_at (epoch ms), state, promoted_track_id, covered_by (non-NULL = hidden',
				'  duplicate folded into another feed item — add covered_by IS NULL to match what the feed shows)',
				'• v_feed_track — tracklists of ALREADY-EXPANDED feed albums only: item_id, spotify_track_id, title,',
				'  artists, bpm, key_camelot, genre, label, isrc, duration_sec',
				'• kb.kb_entity (id, kind: artist|release|track|label|genre, name, isrc, release_date) ·',
				'  kb.kb_edge (src_id, kind, dst_id, confidence) · kb.kb_entity_source (entity_id, source, source_id, url)',
				'Raw `track` holds canonical values only (user edits live in overrides JSON) and deleted tracks — always',
				'use v_track. The v_ junction views (v_source_link, v_playlist_track, v_track_tag) drop deleted tracks;',
				'the raw tables of the same name keep them, so never count or join through those.',
				'ATTACH/PRAGMA are forbidden. On a "workspace was reset" error, re-load your tables and retry.',
			].join('\n'),
			parameters: {
				type: 'object',
				properties: { sql: { type: 'string' } },
				required: ['sql'],
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const sql = str(asArgs(rawArgs)['sql']);
				if (!sql) throw new Error('sql required');
				const ws = requireWorkspace(ctx);
				const result = await ws.query(sql, 200);
				// Shape the byte cap ourselves (drop whole rows + explain) rather
				// than letting the generic 16KB truncation chop mid-JSON.
				let rows = result.rows;
				let byteCapped = false;
				while (rows.length > 20 && Buffer.byteLength(JSON.stringify(rows), 'utf8') > 14_000) {
					rows = rows.slice(0, Math.floor(rows.length / 2));
					byteCapped = true;
				}
				const truncated = result.truncated || byteCapped;
				return {
					columns: result.columns,
					rows,
					...(result.changes != null ? { changes: result.changes } : {}),
					...(truncated ? { truncated: true, note: 'truncated — aggregate, narrow the SELECT list, or add LIMIT/ORDER BY' } : {}),
				};
			},
		},
		{
			name: 'present_result_set',
			description:
				'Present a curated list of tracks/releases to the user — it renders as a playable track list in the app. '
				+ 'Two modes (exactly one): `fromWorkspace.sql` — a workspace SELECT whose rows become the list (must '
				+ 'include _kind, _ref_id, title/name, artists; SELECT * from a loaded table works; add a `note` column '
				+ 'for per-row "why". Live views present directly by aliasing: SELECT \'feed-item\' AS _kind, id AS '
				+ '_ref_id, … FROM v_feed_item, or \'library-track\' AS _kind, id AS _ref_id, … FROM v_track — no '
				+ 'loading step needed); or explicit `items` — every item MUST reference an id you obtained from a tool '
				+ 'call this turn/session: a library trackId, a feed itemId, a KB entityId, or a provider hit '
				+ '(spotify/beatport id). Unknown refs are rejected — fix and re-present. Add citations (URLs you '
				+ 'actually read) for claims from web research. The list itself is shown to the user; do not repeat it in text.',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Short list title, e.g. "Berlin labels × Max Cooper — last 14 days".' },
					summary: { type: 'string', description: 'One-sentence description of how the list was built.' },
					fromWorkspace: {
						type: 'object',
						description: 'Select the list from workspace rows (max 100). Mutually exclusive with items.',
						properties: { sql: { type: 'string' } },
						required: ['sql'],
						additionalProperties: false,
					},
					items: {
						type: 'array',
						maxItems: 100,
						items: {
							type: 'object',
							properties: {
								kind: { type: 'string', enum: ['library-track', 'feed-item', 'kb-entity', 'provider-hit'] },
								title: { type: 'string' },
								artists: { type: 'array', items: { type: 'string' } },
								trackId: { type: 'string', description: 'library-track: id from query_library / get_track_detail.' },
								feedItemId: { type: 'string', description: 'feed-item: id from query_feed.' },
								kbEntityId: { type: 'string', description: 'kb-entity: id from search_kb / get_kb_entity / expand_kb_entity.' },
								providerRef: {
									type: 'object',
									properties: {
										provider: { type: 'string', enum: ['spotify', 'beatport', 'tidal', 'traxsource'] },
										id: { type: 'string' },
										url: { type: 'string' },
									},
									required: ['provider', 'id'],
									additionalProperties: false,
								},
								meta: {
									type: 'object',
									properties: {
										bpm: { type: 'number' },
										keyCamelot: { type: 'string' },
										genre: { type: 'string' },
										label: { type: 'string' },
										releaseDate: { type: 'string' },
										durationSec: { type: 'number' },
										coverUrl: { type: 'string' },
									},
									additionalProperties: false,
								},
								citations: {
									type: 'array',
									maxItems: 5,
									items: {
										type: 'object',
										properties: { url: { type: 'string' }, note: { type: 'string' } },
										required: ['url'],
										additionalProperties: false,
									},
								},
								note: { type: 'string' },
							},
							required: ['kind', 'title', 'artists'],
							additionalProperties: false,
						},
					},
				},
				required: ['title'],
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				const title = str(a['title']);
				if (!title) {
					throw new Error('title required — call shape: {"title": "…", "fromWorkspace": {"sql": "SELECT * FROM my_table LIMIT 40"}}');
				}
				let fromWs: string | undefined;
				const rawFw = a['fromWorkspace'];
				if (rawFw && typeof rawFw === 'object') {
					fromWs = str((rawFw as Args)['sql']);
				} else if (typeof rawFw === 'string') {
					// Observed model glitch: XML tool-call syntax bleeding into the
					// JSON string ("<parameter name=\"sql\">…"). Recover the SQL
					// instead of failing on a technicality.
					const unwrapped = /<parameter name="sql">\s*([\s\S]*?)\s*(?:<\/parameter>)?\s*$/.exec(rawFw);
					fromWs = str((unwrapped ? unwrapped[1]! : rawFw).trim());
					if (!fromWs) {
						throw new Error('fromWorkspace must be an object: {"sql": "SELECT …"}');
					}
				}
				const explicit = Array.isArray(a['items']) ? (a['items'] as AgentResultItemDraft[]) : [];
				if (fromWs && explicit.length > 0) throw new Error('pass either fromWorkspace or items, not both');
				let items: AgentResultItemDraft[];
				let mapErrors: string[] = [];
				if (fromWs) {
					const ws = requireWorkspace(ctx);
					const result = await ws.query(fromWs, 100);
					const mapped = draftsFromWorkspaceRows(result.columns, result.rows);
					items = mapped.drafts;
					mapErrors = mapped.errors;
					if (items.length === 0) {
						throw new Error(mapErrors[0] ?? 'the workspace query returned no presentable rows');
					}
				} else {
					if (explicit.length === 0) throw new Error('items must not be empty');
					items = explicit.slice(0, 100);
				}
				const res = await ctx.presentResultSet({
					title,
					...(str(a['summary']) ? { summary: str(a['summary']) } : {}),
					items,
				});
				return mapErrors.length > 0 ? { ...res, rowErrors: mapErrors.slice(0, 10) } : res;
			},
		},
		{
			name: 'update_feed_filters',
			description:
				'Change the genre/label filters of the Discover feed the user is looking at. Pass null to clear a filter. '
				+ 'Values must exist in the feed (see query_feed / the feed\'s filter options); unknown values are rejected.',
			parameters: {
				type: 'object',
				properties: {
					genre: { type: ['string', 'null'] },
					label: { type: ['string', 'null'] },
				},
				additionalProperties: false,
			},
			async execute(rawArgs, ctx) {
				const a = asArgs(rawArgs);
				return ctx.setFeedFilters({
					...('genre' in a ? { genre: a['genre'] === null ? null : str(a['genre']) ?? null } : {}),
					...('label' in a ? { label: a['label'] === null ? null : str(a['label']) ?? null } : {}),
				});
			},
		},

		// ─── Play history ───────────────────────────────────────────────────
		// Read side of the play_session / play_event audit log. Two origins:
		// 'curator' (in-app plays with audible-ms + played75) and 'rekordbox'
		// (imported history — kind 'set' = a real USB/CDJ set, 'prep' =
		// rekordbox auditioning; rekordbox rows carry no duration data).
		{
			name: 'get_play_history',
			description:
				'Play history for ONE library track, newest first — when it was played, from which player '
				+ '(curator local/spotify vs rekordbox), in which session (set vs prep), how long, and whether 75% '
				+ 'of the track was heard (curator plays only; rekordbox history has no durations). Returns one page + total.',
			parameters: {
				type: 'object',
				properties: {
					trackId: { type: 'string', description: 'Curator track id (from query_library).' },
					limit: { type: 'number', description: 'Rows per page, max 100 (default 25).' },
					offset: { type: 'number' },
				},
				required: ['trackId'],
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const trackId = str(a['trackId']);
				if (!trackId) throw new Error('trackId is required');
				const { rows, total } = await ports.svc().getTrackPlayHistory(trackId, {
					limit: clampLimit(a['limit']),
					offset: num(a['offset']) ?? 0,
				});
				return {
					total,
					plays: rows.map((r) => ({
						playedAt: r.playedAt != null ? new Date(r.playedAt).toISOString() : null,
						source: r.source,
						sessionId: r.sessionId,
						sessionName: r.sessionName,
						sessionKind: r.sessionKind,
						playedSec: r.playedMs != null ? Math.round(r.playedMs / 1000) : null,
						played75: r.played75,
						endedReason: r.endedReason,
						context: r.contextType ? { type: r.contextType, id: r.contextId } : null,
					})),
				};
			},
		},
		{
			name: 'list_play_sessions',
			description:
				'List play sessions (groups of tracks played together), newest first. origin "rekordbox" = imported '
				+ 'rekordbox history (kind "set" = played from USB/CDJs, "prep" = auditioning in rekordbox); origin '
				+ '"curator" = in-app listening, grouped by ~30-min idle gaps. Filter by origin/kind/date range.',
			parameters: {
				type: 'object',
				properties: {
					origin: { type: 'string', enum: ['curator', 'rekordbox'] },
					kind: { type: 'string', enum: ['set', 'prep', 'unknown'] },
					fromDate: { type: 'string', description: 'ISO date — sessions starting on/after this.' },
					toDate: { type: 'string', description: 'ISO date — sessions starting on/before this.' },
					limit: { type: 'number', description: 'Max sessions, max 100 (default 25).' },
					offset: { type: 'number' },
				},
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const sessions = await ports.svc().listPlaySessions({
					...(str(a['origin']) ? { origin: a['origin'] as 'curator' } : {}),
					...(str(a['kind']) ? { kind: a['kind'] as 'set' } : {}),
					...(isoToMs(a['fromDate']) != null ? { fromMs: isoToMs(a['fromDate'])! } : {}),
					...(isoToMs(a['toDate']) != null ? { toMs: isoToMs(a['toDate'])! } : {}),
					limit: clampLimit(a['limit']),
					offset: num(a['offset']) ?? 0,
				});
				return {
					sessions: sessions.map((s) => ({
						id: s.id,
						name: s.name,
						origin: s.origin,
						kind: s.kind,
						kindSource: s.kindSource,
						startedAt: s.startedAt.toISOString(),
						endedAt: s.endedAt?.toISOString() ?? null,
						playCount: s.playCount,
					})),
				};
			},
		},
		{
			name: 'get_play_session',
			description:
				'One play session with its tracks in played order (set order for rekordbox sessions). Rows carry track '
				+ 'title/artists when the play is linked to a library track; unlinked rekordbox plays surface their '
				+ 'rbContentId instead.',
			parameters: {
				type: 'object',
				properties: {
					sessionId: { type: 'string', description: 'Session id (from list_play_sessions / get_play_history).' },
				},
				required: ['sessionId'],
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const sessionId = str(a['sessionId']);
				if (!sessionId) throw new Error('sessionId is required');
				const res = await ports.svc().getPlaySession(sessionId);
				if (!res) return { found: false };
				return {
					found: true,
					session: {
						id: res.session.id,
						name: res.session.name,
						origin: res.session.origin,
						kind: res.session.kind,
						kindSource: res.session.kindSource,
						startedAt: res.session.startedAt.toISOString(),
						endedAt: res.session.endedAt?.toISOString() ?? null,
					},
					plays: res.plays.map((p) => ({
						pos: p.pos,
						trackId: p.trackId,
						...(p.trackId ? {} : { rbContentId: p.rbContentId }),
						title: p.title,
						artists: p.artists?.map((ar) => ar.name).join(', ') ?? null,
						playedAt: p.playedAt != null ? new Date(p.playedAt).toISOString() : null,
						playedSec: p.playedMs != null ? Math.round(p.playedMs / 1000) : null,
						played75: p.played75,
						source: p.source,
					})),
				};
			},
		},
		{
			name: 'get_top_played',
			description:
				'Most-played library tracks by play count (optionally within a date range and/or one origin — '
				+ '"rekordbox" for DJ history, "curator" for in-app listening). Returns trackId/title/artists/plays/lastPlayedAt.',
			parameters: {
				type: 'object',
				properties: {
					origin: { type: 'string', enum: ['curator', 'rekordbox'] },
					fromDate: { type: 'string', description: 'ISO date — count plays on/after this.' },
					toDate: { type: 'string', description: 'ISO date — count plays on/before this.' },
					limit: { type: 'number', description: 'Max tracks, max 100 (default 25).' },
				},
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const rows = await ports.svc().getTopPlayed({
					...(str(a['origin']) ? { origin: a['origin'] as 'curator' } : {}),
					...(isoToMs(a['fromDate']) != null ? { fromMs: isoToMs(a['fromDate'])! } : {}),
					...(isoToMs(a['toDate']) != null ? { toMs: isoToMs(a['toDate'])! } : {}),
					limit: clampLimit(a['limit']),
				});
				return {
					tracks: rows.map((r) => ({
						trackId: r.trackId,
						title: r.title,
						artists: r.artists?.map((ar) => ar.name).join(', ') ?? null,
						plays: r.plays,
						lastPlayedAt: r.lastPlayedAt != null ? new Date(r.lastPlayedAt).toISOString() : null,
					})),
				};
			},
		},
		// ─── AI audio engine (apps/mir) ─────────────────────────────────
		// Similarity over foundation-model audio embeddings of the playable
		// (local-file) library. Streaming-only tracks have no vectors.
		{
			name: 'get_similar_tracks',
			description:
				'Library tracks that SOUND most like the given seed track(s), ranked by the AI audio engine embedding '
				+ 'similarity (score = cosine, higher is closer). Several seeds = "more like all of these". Optional BPM '
				+ 'bounds restrict candidates. missingSeeds lists seeds with no audio analysis (streaming-only or not yet analyzed).',
			parameters: {
				type: 'object',
				properties: {
					trackIds: { type: 'array', items: { type: 'string' }, description: 'Seed library track ids (1-20).' },
					trackId: { type: 'string', description: 'Single seed (alternative to trackIds).' },
					bpmMin: { type: 'number' },
					bpmMax: { type: 'number' },
					model: { type: 'string', description: 'Engine model key (default: the model chosen in Settings).' },
					limit: { type: 'number', description: 'Max tracks, max 100 (default 25).' },
				},
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const seeds = [...(Array.isArray(a['trackIds']) ? a['trackIds'].filter((x): x is string => typeof x === 'string') : []),
					...(str(a['trackId']) ? [a['trackId'] as string] : [])].slice(0, 20);
				if (seeds.length === 0) return { error: 'Pass trackIds (or trackId).' };
				return similarRows(seeds, undefined, a);
			},
		},
		{
			name: 'search_tracks_by_sound',
			description:
				'Find library tracks matching a description of how they SOUND ("warm rolling bassline", "dark hypnotic '
				+ 'techno with vocal chops"), via a text-capable AI audio model (MuQ-MuLan / CLAP) — the text lands in the '
				+ 'same embedding space as the audio. Fails if no text-capable model has analyzed the library yet.',
			parameters: {
				type: 'object',
				properties: {
					description: { type: 'string', description: 'What the music sounds like, in plain words.' },
					bpmMin: { type: 'number' },
					bpmMax: { type: 'number' },
					model: { type: 'string', description: 'Text-capable engine model key (default: first enabled one).' },
					limit: { type: 'number', description: 'Max tracks, max 100 (default 25).' },
				},
				required: ['description'],
				additionalProperties: false,
			},
			async execute(rawArgs) {
				const a = asArgs(rawArgs);
				const text = str(a['description']);
				if (!text) return { error: 'description is required' };
				return similarRows([], text, a);
			},
		},
	];

	// Shared body of the two engine tools: rank, then hydrate compact rows.
	async function similarRows(seeds: string[], text: string | undefined, a: Args) {
		const filter = {
			...(typeof a['bpmMin'] === 'number' ? { bpmMin: a['bpmMin'] } : {}),
			...(typeof a['bpmMax'] === 'number' ? { bpmMax: a['bpmMax'] } : {}),
		};
		const r = await ports.svc().getSimilarTracks({
			seeds, ...(text ? { text } : {}), k: clampLimit(a['limit']),
			...(str(a['model']) ? { model: a['model'] as string } : {}),
			...(Object.keys(filter).length ? { filter } : {}),
		});
		const rows = r.items.length ? await ports.svc().getTracks({ ids: r.items.map((i) => i.trackId) }) : [];
		const byId = new Map(rows.map((t) => [t.id, t]));
		return {
			model: r.model,
			missingSeeds: r.missingSeeds,
			tracks: r.items.flatMap((i) => {
				const t = byId.get(i.trackId);
				return t ? [{
					trackId: t.id, title: t.title, artists: t.artists.map((x) => x.name).join(', '),
					bpm: t.bpm, key: t.keyCamelot, label: t.label, score: Math.round(i.score * 1000) / 1000,
				}] : [];
			}),
		};
	}

	// ─── Pipeline: map a tool over workspace rows ───────────────────────
	// The bridge that keeps tool-chaining out of model context: instead of N
	// per-row tool calls relayed through the conversation, one call fans out
	// host-side and lands results back in the workspace.
	const byName = new Map(tools.map((t) => [t.name, t]));
	tools.push({
		name: 'map_tool_over_table',
		timeoutMs: 300_000,
		description: [
			'Run one tool once per row of a workspace table, host-side, without the results passing through the',
			'conversation — THE way to enrich many rows (never call a tool per row yourself).',
			`Mappable tools + row caps: ${Object.entries(MAPPABLE_TOOLS).map(([n, c]) => `${n} (${c.maxRows})`).join(', ')}.`,
			'`args` is a template: "$column" binds the row\'s column value, "$column[]" splits a \' | \' text into a',
			'string array (e.g. artists), other values pass literally. Example for lookup_beatport:',
			'{"title": "$title", "artists": "$artists[]", "durationSec": "$duration_sec"}.',
			'Results land in `into` as: src_ref_id, src_kind, ok (0/1), error, result_json (the tool\'s full result).',
			'Query with json_extract(result_json, \'$.path\') and JOIN back to the source table on',
			'src_ref_id = _ref_id. Failed rows carry `error` and the map continues; 5 consecutive failures stop it.',
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				table: { type: 'string', description: 'Source workspace table.' },
				tool: { type: 'string', enum: Object.keys(MAPPABLE_TOOLS) },
				args: { type: 'object', description: 'Args template with $column bindings.' },
				where: { type: 'string', description: 'Optional SQL WHERE filter over the source table.' },
				limit: { type: 'number', description: 'Max rows to map (clamped to the tool\'s cap).' },
				into: { type: 'string', description: 'Result table name.' },
			},
			required: ['table', 'tool', 'args', 'into'],
			additionalProperties: false,
		},
		async execute(rawArgs, ctx) {
			const a = asArgs(rawArgs);
			const ws = requireWorkspace(ctx);
			const table = str(a['table']);
			const into = str(a['into']);
			const toolName = str(a['tool']);
			if (!table || !validTableName(table)) throw new Error('valid source `table` required');
			if (!into) throw new Error('`into` result table required');
			const cap = toolName ? MAPPABLE_TOOLS[toolName] : undefined;
			const inner = toolName ? byName.get(toolName) : undefined;
			if (!cap || !inner) {
				throw new Error(`tool must be one of: ${Object.keys(MAPPABLE_TOOLS).join(', ')}`);
			}
			const template = a['args'] && typeof a['args'] === 'object' ? (a['args'] as Args) : {};
			const limit = Math.min(Math.max(num(a['limit']) ?? cap.maxRows, 1), cap.maxRows);
			const where = str(a['where']);
			const src = await ws.query(
				`SELECT * FROM "${table}"${where ? ` WHERE ${where}` : ''} LIMIT ${limit}`,
				limit,
			);
			if (src.rows.length === 0) throw new Error('no source rows matched — check table/where');
			const idx = new Map(src.columns.map((c, i) => [c, i]));
			// Validate bindings once against the source columns, not per row.
			for (const v of Object.values(template)) {
				if (typeof v === 'string' && v.startsWith('$')) {
					const col = v.endsWith('[]') ? v.slice(1, -2) : v.slice(1);
					if (!idx.has(col)) throw new Error(`binding "${v}": column "${col}" is not in ${table} (${src.columns.join(', ')})`);
				}
			}
			const bind = (row: unknown[]): Record<string, unknown> => {
				const out: Record<string, unknown> = {};
				for (const [key, v] of Object.entries(template)) {
					if (typeof v === 'string' && v.startsWith('$')) {
						const split = v.endsWith('[]');
						const col = split ? v.slice(1, -2) : v.slice(1);
						const value = row[idx.get(col)!];
						out[key] = split
							? (typeof value === 'string' ? value.split(' | ').filter((s) => s.length > 0) : [])
							: value;
					} else {
						out[key] = v;
					}
				}
				return out;
			};
			// Provider hits discovered mid-map mirror into the session cache so
			// they stay presentable in later turns (fabricated ids are still in
			// neither cache).
			const innerCtx: AgentToolCtx = {
				...ctx,
				providerHits: new MirroringProviderHitCache(ctx.providerHits, ws.sessionProviderHits),
			};
			const srcCol = (row: unknown[], name: string): string | null => {
				const v = idx.has(name) ? row[idx.get(name)!] : null;
				return typeof v === 'string' ? v : null;
			};
			const results: Record<string, unknown>[] = [];
			let okCount = 0;
			let consecutiveFailures = 0;
			let broke = false;
			for (const row of src.rows) {
				const base = { src_ref_id: srcCol(row, '_ref_id'), src_kind: srcCol(row, '_kind') };
				try {
					const result = await inner.execute(bind(row), innerCtx);
					okCount++;
					consecutiveFailures = 0;
					results.push({ ...base, ok: 1, error: null, result_json: JSON.stringify(result ?? null) });
				} catch (err) {
					consecutiveFailures++;
					results.push({ ...base, ok: 0, error: err instanceof Error ? err.message : String(err), result_json: null });
					if (consecutiveFailures >= 5) { broke = true; break; }
				}
			}
			const summary = await ws.loadDataset({
				table: into,
				columns: [
					{ name: 'src_ref_id', type: 'text' }, { name: 'src_kind', type: 'text' },
					{ name: 'ok', type: 'integer' }, { name: 'error', type: 'text' }, { name: 'result_json', type: 'text' },
				],
				rows: results,
				// Enrichment rows inherit the SOURCE row's identity — they're
				// meta about it, presented via a JOIN back to the source table.
				provenance: (row) => ({
					kind: (RESULT_ITEM_KINDS.has(String(row['src_kind'])) ? row['src_kind'] : 'provider-hit') as 'provider-hit',
					refId: String(row['src_ref_id'] ?? ''),
				}),
			});
			return {
				...summary,
				mapped: results.length,
				ok: okCount,
				failed: results.length - okCount,
				note: `results in "${into}".result_json — query with json_extract(result_json, '$.path'), JOIN back on src_ref_id = ${table}._ref_id`
					+ (broke ? ` — STOPPED after 5 consecutive failures (${results[results.length - 1]?.['error'] as string}); do not retry this turn` : ''),
			};
		},
	});

	return tools;
}

export function toolSpecs(tools: AgentTool[]): WireToolSpec[] {
	// Fixed registry order — the serialized tool list is part of the cached
	// prompt prefix; reordering would cold the cache.
	return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}
