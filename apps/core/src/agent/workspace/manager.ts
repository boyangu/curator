// WorkspaceManager — session-scoped access to the workspace host for the
// agent's tools. Owns the LRU of live session workspaces, the load pipeline
// (batching + provenance columns), and the session-scoped provider-hit
// cache that makes fromWorkspace result sets fabrication-proof: provider
// refs are only accepted when HOST code loaded them, never because a
// (model-writable) scratch table claims them.

import { log } from '../../log.js';
import { ProviderHitCache, type AgentResultItemKind } from '../result-set.js';
import { validTableName, type WorkspaceColumn, type WorkspaceQueryResult } from './engine.js';
import { WorkspaceResetError, type WorkspaceHost } from './host.js';

const wlog = log.for('agent-workspace');

// Provenance columns appended to every loaded table — written ONLY by this
// module. `_kind`/`_ref_id` drive result-set selection; `_provider`/`_url`/
// `_play_spotify_id` reconstruct provider refs without re-lookups.
const PROVENANCE_COLUMNS: WorkspaceColumn[] = [
	{ name: '_kind', type: 'text' },
	{ name: '_ref_id', type: 'text' },
	{ name: '_provider', type: 'text' },
	{ name: '_url', type: 'text' },
	{ name: '_play_spotify_id', type: 'text' },
];

const LOAD_BATCH_ROWS = 500;
const MAX_TABLES_PER_SESSION = 24;
const MAX_LIVE_WORKSPACES = 4;
const DEFAULT_QUERY_MAX_ROWS = 200;

export interface RowProvenance {
	kind: AgentResultItemKind;
	refId: string;
	provider?: string;
	url?: string;
	playSpotifyId?: string;
}

export interface WorkspaceLoadSummary {
	table: string;
	rowCount: number;
	columns: string[];
	// First ≤3 rows (data columns only) so the model sees the shape.
	sample: Record<string, unknown>[];
}

export interface SessionWorkspace {
	loadDataset(input: {
		table: string;
		columns: WorkspaceColumn[];
		rows: Record<string, unknown>[];
		provenance: (row: Record<string, unknown>) => RowProvenance;
	}): Promise<WorkspaceLoadSummary>;
	query(sql: string, maxRows?: number): Promise<WorkspaceQueryResult>;
	// Provider ids host-loaded into this session's workspace — consulted by
	// result-set validation alongside the per-turn cache.
	readonly sessionProviderHits: ProviderHitCache;
}

interface SessionState {
	workspace: SessionWorkspace;
	hits: ProviderHitCache;
	tables: Set<string>;
	lastUsed: number;
}

export interface WorkspaceManager {
	forSession(sessionId: string): SessionWorkspace;
	drop(sessionId: string): Promise<void>;
	stop(): Promise<void>;
}

export function createWorkspaceManager(host: WorkspaceHost, opts?: { maxLive?: number }): WorkspaceManager {
	const maxLive = opts?.maxLive ?? MAX_LIVE_WORKSPACES;
	const sessions = new Map<string, SessionState>();
	// Monotonic use-ticker for LRU — Date.now() ties within a millisecond.
	let useTick = 0;
	const touch = (s: SessionState): void => { s.lastUsed = ++useTick; };

	// A reset (watchdog kill) takes every session's connection with it —
	// clear all local mirrors. NOTE: a worker can also die while IDLE (no
	// in-flight call to reject), so this alone can't be the sync mechanism;
	// that's why every operation below re-ensures and resyncs its table
	// mirror from the host's answer.
	const onReset = (): void => {
		wlog.warn('workspace reset — clearing all session mirrors');
		for (const s of sessions.values()) s.tables.clear();
	};

	const guarded = async <T>(fn: () => Promise<T>): Promise<T> => {
		try {
			return await fn();
		} catch (err) {
			if (err instanceof WorkspaceResetError) onReset();
			throw err;
		}
	};

	const evictIfNeeded = (): void => {
		while (sessions.size > maxLive) {
			let oldest: { id: string; at: number } | null = null;
			for (const [id, s] of sessions) {
				if (!oldest || s.lastUsed < oldest.at) oldest = { id, at: s.lastUsed };
			}
			if (!oldest) return;
			sessions.delete(oldest.id);
			wlog.info('evicting LRU workspace', { sessionId: oldest.id });
			void host.drop(oldest.id).catch(() => { /* worker may be gone */ });
		}
	};

	const makeSession = (sessionId: string): SessionState => {
		const hits = new ProviderHitCache();
		// Idempotent per-op ensure: cheap (a map hit worker-side), survives a
		// worker that died while idle (fresh connection + resynced mirror), and
		// keeps the table-cap check honest after a reset.
		const ensureFresh = async (): Promise<void> => {
			const { tables } = await host.ensure(sessionId);
			state.tables = new Set(tables);
		};
		const state: SessionState = {
			hits,
			tables: new Set(),
			lastUsed: ++useTick,
			workspace: {
				sessionProviderHits: hits,
				async loadDataset({ table, columns, rows, provenance }) {
					touch(state);
					if (!validTableName(table)) {
						throw new Error(`invalid table name "${table}" — lowercase [a-z0-9_], no v_/sqlite_/_ prefix`);
					}
					if (columns.some((c) => c.name.startsWith('_'))) {
						throw new Error('column names starting with _ are reserved for provenance');
					}
					return guarded(async () => {
						await ensureFresh();
						if (!state.tables.has(table) && state.tables.size >= MAX_TABLES_PER_SESSION) {
							throw new Error(`workspace table limit reached (${MAX_TABLES_PER_SESSION}) — reuse or replace an existing table`);
						}
						const allColumns = [...columns, ...PROVENANCE_COLUMNS];
						await host.loadBegin(sessionId, table, allColumns);
						for (let i = 0; i < rows.length; i += LOAD_BATCH_ROWS) {
							const batch = rows.slice(i, i + LOAD_BATCH_ROWS).map((row) => {
								const p = provenance(row);
								if (p.kind === 'provider-hit' && p.provider) {
									hits.record(p.provider, p.refId, {
										...(p.url ? { url: p.url } : {}),
										...(p.playSpotifyId ? { playSpotifyId: p.playSpotifyId } : {}),
									});
								}
								return [
									...columns.map((c) => row[c.name] ?? null),
									p.kind,
									p.refId,
									p.provider ?? null,
									p.url ?? null,
									p.playSpotifyId ?? null,
								];
							});
							await host.loadRows(sessionId, table, batch);
						}
						const { rowCount } = await host.loadEnd(sessionId, table);
						state.tables.add(table);
						return {
							table,
							rowCount,
							columns: allColumns.map((c) => c.name),
							sample: rows.slice(0, 3).map((row) => {
								const out: Record<string, unknown> = {};
								for (const c of columns) if (row[c.name] != null) out[c.name] = row[c.name];
								return out;
							}),
						};
					});
				},
				async query(sql, maxRows = DEFAULT_QUERY_MAX_ROWS) {
					touch(state);
					return guarded(async () => {
						await ensureFresh();
						return host.query(sessionId, sql, maxRows);
					});
				},
			},
		};
		return state;
	};

	return {
		forSession(sessionId) {
			let s = sessions.get(sessionId);
			if (!s) {
				s = makeSession(sessionId);
				sessions.set(sessionId, s);
				evictIfNeeded();
			}
			touch(s);
			return s.workspace;
		},
		async drop(sessionId) {
			if (sessions.delete(sessionId)) {
				await host.drop(sessionId).catch(() => { /* worker may be gone */ });
			}
		},
		async stop() {
			sessions.clear();
			await host.stop().catch(() => { /* best-effort */ });
		},
	};
}
