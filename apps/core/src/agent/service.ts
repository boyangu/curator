// AgentService — the host-side face of the in-app agent. Owns sessions
// (agent.db), the router pre-pass, turn orchestration against the sidecar,
// tool execution, result-set validation, and the event stream the desktop
// forwards as 'agent:event'.
//
// Composition mirrors createKnowledgeService: injected ports only, no
// Electron. Disabled is a supported state at every seam — no sidecar spec ⇒
// state 'disabled'; no BYOK config ⇒ 'unconfigured'; both render as clean
// panel states, never errors.

import { randomUUID } from 'node:crypto';
import { log } from '../log.js';
import type { AgentSidecarManager } from './sidecar.js';
import type { AgentStore, AgentSessionDetail, AgentSessionSummary } from './store.js';
import type { AgentTool, AgentToolCtx } from './tools.js';
import { toolSpecs } from './tools.js';
import { CompositeProviderHits, ProviderHitCache, validateResultItems, type AgentResultSet, type ResultRefPorts } from './result-set.js';
import type { WorkspaceManager } from './workspace/manager.js';
import type { AgentConfig, AgentProvider, RunUsage, WireMessage, WireToolSpec } from './protocol.js';

const alog = log.for('agent');

// Step budgets per mode. Quick turns are local lookups + view changes;
// research turns may chain provider searches + web research.
const QUICK_MAX_STEPS = 6;
const RESEARCH_MAX_STEPS = 16;
const MAX_TOOL_RESULT_BYTES = 16_384;
// External (MCP) tool results ride a bigger context than the in-app sidecar
// budget — cap at 64 KB serialized, then hand back a truncation note instead.
const MAX_EXTERNAL_RESULT_BYTES = 64_000;
const EXTERNAL_TOOL_TIMEOUT_MS = 60_000;
// Per-turn wall clock — a runaway turn is cancelled, not awaited forever.
const TURN_WALL_CLOCK_MS = 10 * 60_000;
// How much history the router sees. Classification needs the tail (follow-up
// turns can be terse), not the whole conversation.
const CLASSIFY_TAIL = 8;

// Text-only classification context. A blind slice(-N) of the wire history
// can start mid-tool-exchange — a tool_result whose tool_use was sliced
// away — which the provider API rejects outright (seen in the field: every
// such turn silently fell back to the research model). Tool traffic is
// irrelevant to routing anyway, so classify sees only user text and
// assistant text, always a valid message sequence.
export function classifyTail(history: WireMessage[], limit = CLASSIFY_TAIL): WireMessage[] {
	const out: WireMessage[] = [];
	for (const m of history) {
		if (m.role === 'user' && typeof m.content === 'string') {
			out.push(m);
		} else if (m.role === 'assistant') {
			const text = typeof m.content === 'string'
				? m.content
				: m.content
					.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
					.map((p) => p.text)
					.join('');
			if (text.trim().length > 0) out.push({ role: 'assistant', content: text });
		}
	}
	return out.slice(-limit);
}

// The frozen system prompt. STABLE BY DESIGN: no timestamps, no per-session
// interpolation — together with the fixed-order tool list it forms the
// provider's cached prefix. Dynamic context belongs in user turns.
const SYSTEM_PROMPT = [
	'You are Curator\'s in-app music agent — embedded in a desktop DJ library / music discovery app.',
	'The user is a DJ exploring music: their library (canonical tracks), the Discover feed (new releases from followed sources), a knowledge base of artists/releases/labels the app has learned, plus live catalog access (Spotify, Beatport) and web research.',
	'',
	'How to work:',
	'- Prefer local data first: query_library / query_feed / search_kb are instant and free. Call get_library_facets before filtering by genre/label so values match real data.',
	'- Query tools return pages: use limit/offset or cursors instead of asking for everything. Results are truncated when oversized — refine rather than re-request.',
	'- Reach for search_spotify / lookup_beatport / web research only when local data cannot answer (new music, external facts, collaborations).',
	'- "Sounds like" questions use the AI audio engine: get_similar_tracks (seed tracks) and search_tracks_by_sound (a plain-words description). They cover analyzed local-file tracks only; mention missingSeeds when seeds had no analysis.',
	'- You are read-only: you cannot modify the library, playlists, or any connected account.',
	'',
	'Workspace (for any multi-page data work):',
	'- When a request spans more than one page of data — "all tracks from these labels", dedupe by ISRC, cross-source joins, sort-then-take-N — load full datasets with loadInto, do the heavy lifting in query_workspace SQL, and present with present_result_set fromWorkspace. Never page through large data manually.',
	'- The workspace also has live read-only SQL views of the library/feed/knowledge base (see query_workspace) — pure aggregation questions ("how many per label") can be answered with one SQL query, no loading.',
	'- To enrich many rows with another tool (Beatport metadata, Spotify searches, track details), use map_tool_over_table — one call fans out host-side and lands results in the workspace. NEVER call a tool once per row yourself.',
	'- NEVER issue many near-identical tool calls that differ only by a value (query_library once per artist name, search once per label, …). One SQL statement over the views — or one loadInto + one query_workspace — replaces all of them. If you catch yourself about to repeat a call with a different literal, switch to SQL.',
	'- NEVER retype values from earlier tool results into SQL literals (UNION ALL SELECT \'name\', count, …). Data you saw came FROM the database — derive it again in SQL (v_track, v_track_artist, v_feed_item, v_feed_artist) so it stays exact and complete.',
	'- "My favourite artists/labels/genres" questions are TWO calls: get_library_favorites, then one present_result_set fromWorkspace (or query_workspace) cross-referencing those names — e.g. new feed releases via v_feed_item + v_feed_artist. Live view rows present directly with the \'feed-item\'/\'library-track\' _kind alias — no loading needed.',
	'',
	'Current view context:',
	'- User messages may end with "[current view: …]" — where the user is standing right now. AMBIGUOUS asks scope to it: "show me tracks" / "filter these" / "sort by bpm" on a playlist means that playlist (query_library playlistId), on the Spotify/Tidal/Rekordbox tab means that source (query_library source), on the Discover feed means the feed with its active filters (query_feed / update_feed_filters).',
	'- EXPLICIT references override the view: "in my library", "overall", "my favourite artists (most songs in my library)" always mean the whole library, whatever tab is open.',
	'- Never mention the context line itself — it is instrumentation, not something the user typed.',
	'- Loaded tables persist across the conversation but are lost on app restart or a workspace reset — just re-load.',
	'',
	'Presenting results:',
	'- When the user asks for tracks/releases/a list to explore, ALWAYS finish by calling present_result_set — that renders a playable list in the app. Keep your text short: how you built the list, caveats, next-step suggestions. Never enumerate the list again in text.',
	'- Every result-set item must carry an id you obtained from a tool call this turn (or workspace rows loaded this session). Rejected items come back with reasons — fix and re-present.',
	'- Cite web sources on items that rest on web research (citations you actually read).',
	'- When the user asks to narrow/change what they see in the feed, call update_feed_filters.',
	'',
	'Answer in the user\'s language. Be concise — this is a working tool, not a chat companion.',
].join('\n');

export type AgentStatusState = 'disabled' | 'unconfigured' | 'ready' | 'running';

export interface AgentStatus {
	state: AgentStatusState;
	provider?: AgentProvider;
	routerModel?: string;
	researchModel?: string;
}

export type AgentViewCommand = { type: 'set-feed-filters'; genre?: string | null; label?: string | null };

// Where the user is standing when they send a message — captured by the
// renderer at send time and appended to the user turn (never the frozen
// system prompt: dynamic context would cold the cache). The model scopes
// ambiguous asks ("show me tracks") to it; explicit references ("in my
// library") override it.
export interface AgentViewContext {
	// 'tracks' | 'discover' | 'interested' | 'basket' | 'downloads' | 'sync' …
	view: string;
	// Source tab when browsing tracks: 'spotify' | 'tidal' | 'rekordbox' …
	source?: string;
	playlist?: { id: string; name: string; source: string };
	folderName?: string;
	discover?: { mode: string; genre?: string | null; label?: string | null };
}

// One readable line, appended to the wire user message (and stripped for
// display by the store). Readable beats JSON here — it's model-facing prose.
export function describeViewContext(ctx: AgentViewContext): string {
	if (ctx.view === 'discover') {
		const d = ctx.discover;
		if (d?.mode === 'journeys') return 'Discover tab, Journeys view';
		if (d?.mode === 'agent-results') return 'Discover tab, viewing an agent result list';
		const filters = [d?.genre ? `genre filter "${d.genre}"` : null, d?.label ? `label filter "${d.label}"` : null].filter(Boolean);
		return `Discover feed${filters.length > 0 ? ` with ${filters.join(' and ')}` : ''}`;
	}
	if (ctx.view === 'interested') return 'the Interested (pinned) tracks view';
	if (ctx.view === 'basket') return 'the Basket tracks view';
	if (ctx.view === 'tracks') {
		const tab = ctx.source === 'rekordbox' ? 'Rekordbox tab'
			: ctx.source ? `${ctx.source[0]!.toUpperCase()}${ctx.source.slice(1)} tab` : 'a tracks tab';
		if (ctx.playlist) return `${tab}, playlist "${ctx.playlist.name}" (playlistId ${ctx.playlist.id})`;
		if (ctx.folderName) return `${tab}, folder "${ctx.folderName}"`;
		return tab;
	}
	return `the ${ctx.view} view`;
}

// Marker for the context suffix on stored user messages — the store's
// display path strips it (see store.ts messageText).
export const VIEW_CONTEXT_PREFIX = '\n\n[current view: ';

export type AgentEvent =
	| { kind: 'turn-started'; sessionId: string; turnId: string; mode: 'quick' | 'research'; model: string }
	| { kind: 'text-delta'; sessionId: string; turnId: string; text: string }
	| { kind: 'reasoning-delta'; sessionId: string; turnId: string; text: string }
	| { kind: 'tool-started'; sessionId: string; turnId: string; callId: string; tool: string; label: string }
	| { kind: 'tool-finished'; sessionId: string; turnId: string; callId: string; tool: string; ok: boolean; summary: string }
	| { kind: 'source'; sessionId: string; turnId: string; url: string; title?: string }
	| { kind: 'result-set'; sessionId: string; turnId: string; resultSet: AgentResultSet }
	| { kind: 'view-command'; sessionId: string; turnId: string; command: AgentViewCommand }
	| { kind: 'turn-finished'; sessionId: string; turnId: string; stopReason: string; usage: RunUsage; costUsd: number | null }
	| { kind: 'error'; sessionId: string; turnId?: string; message: string };

export interface AgentServiceDeps {
	store: AgentStore;
	// Absent ⇒ the agent is off (disabled is a supported state).
	sidecar?: AgentSidecarManager;
	tools: AgentTool[];
	refs: ResultRefPorts;
	// Validation source for update_feed_filters.
	getFeedFilterOptions(): Promise<{ genres: string[]; labels: string[] }>;
	// Absent ⇒ the workspace is off (:memory: core) — tools report it
	// unavailable; everything else works.
	workspace?: WorkspaceManager;
}

export interface AgentService {
	status(): AgentStatus;
	configure(config: AgentConfig): Promise<AgentStatus>;
	send(req: { sessionId?: string; text: string; context?: AgentViewContext }): Promise<{ status: 'running'; sessionId: string; turnId: string }>;
	cancel(sessionId: string): Promise<void>;
	listSessions(): Promise<AgentSessionSummary[]>;
	getSession(sessionId: string): Promise<AgentSessionDetail | null>;
	newSession(): Promise<AgentSessionSummary>;
	deleteSession(sessionId: string): Promise<void>;
	getResultSet(resultSetId: string): Promise<AgentResultSet | null>;
	subscribeEvents(cb: (e: AgentEvent) => void): () => void;
	// External (MCP bridge) tool access — same registry, same ctx semantics,
	// but no sidecar/BYOK involved: an outside model drives the tools one call
	// at a time. Works even when the in-app agent is 'disabled'/'unconfigured'.
	externalToolSpecs(): WireToolSpec[];
	createExternalSession(title: string): AgentSessionSummary;
	runExternalTool(req: { sessionId: string; name: string; args: unknown }): Promise<unknown>;
	// Settles once the workspace host has stopped (agent.db closes at once).
	stop(): Promise<void>;
}

export function createAgentService(deps: AgentServiceDeps): AgentService {
	const { store, sidecar, tools, refs } = deps;
	const specs = toolSpecs(tools);
	const toolsByName = new Map(tools.map((t) => [t.name, t]));
	const listeners = new Set<(e: AgentEvent) => void>();
	// Current model config, mirrored from configure() for status display.
	let config: AgentConfig | null = null;
	let activeTurn: { sessionId: string; turnId: string } | null = null;
	// Per-external-session provider-hit caches (MCP bridge). Session-scoped,
	// not per-call: each MCP tool call is its own "turn", but one conversation
	// for result-set validation purposes.
	const externalHits = new Map<string, ProviderHitCache>();

	const emit = (e: AgentEvent): void => {
		for (const l of listeners) {
			try { l(e); } catch (err) { alog.warn('agent listener threw', undefined, err); }
		}
	};

	// One ctx per turn (in-app) or per call (external). The provider-hit cache
	// is caller-scoped: runTurn hands a fresh per-turn cache, the external
	// path hands a per-session cache so a query in one MCP call can validate
	// a present_result_set in a later one.
	const buildToolCtx = (sessionId: string, turnId: string, providerHits: ProviderHitCache): AgentToolCtx => {
		const workspace = deps.workspace?.forSession(sessionId) ?? null;
		// Provider refs are valid if the host returned them this turn OR loaded
		// them into this session's workspace (host-written provenance) — never
		// because a model-writable scratch table claims them.
		const validationHits = workspace
			? new CompositeProviderHits([providerHits, workspace.sessionProviderHits])
			: providerHits;
		return {
			providerHits,
			workspace,
			async presentResultSet(input) {
				const { accepted, rejected } = await validateResultItems(input.items, refs, validationHits);
				if (accepted.length === 0) {
					return { resultSetId: '', accepted: 0, rejected };
				}
				const rs: AgentResultSet = {
					id: randomUUID(),
					sessionId,
					turnId,
					title: input.title,
					summary: input.summary ?? null,
					createdAt: Date.now(),
					items: accepted,
				};
				store.insertResultSet(rs);
				emit({ kind: 'result-set', sessionId, turnId, resultSet: rs });
				return { resultSetId: rs.id, accepted: accepted.length, rejected };
			},
			async setFeedFilters(input) {
				const options = await deps.getFeedFilterOptions();
				const match = (value: string | null | undefined, pool: string[], what: string): { ok: true; value: string | null } | { ok: false; note: string } => {
					if (value == null) return { ok: true, value: null };
					const hit = pool.find((g) => g.localeCompare(value, undefined, { sensitivity: 'accent' }) === 0)
						?? pool.find((g) => g.toLowerCase() === value.toLowerCase());
					return hit ? { ok: true, value: hit } : { ok: false, note: `${what} "${value}" does not exist in the feed — available: ${pool.slice(0, 30).join(', ')}` };
				};
				const genre = 'genre' in input ? match(input.genre, options.genres, 'genre') : null;
				const label = 'label' in input ? match(input.label, options.labels, 'label') : null;
				if (genre && !genre.ok) return { ok: false, note: genre.note };
				if (label && !label.ok) return { ok: false, note: label.note };
				const command: AgentViewCommand = {
					type: 'set-feed-filters',
					...(genre ? { genre: genre.value } : {}),
					...(label ? { label: label.value } : {}),
				};
				emit({ kind: 'view-command', sessionId, turnId, command });
				return { ok: true };
			},
		};
	};

	const runTurn = async (sessionId: string, turnId: string): Promise<void> => {
		const ctx = buildToolCtx(sessionId, turnId, new ProviderHitCache());

		try {
			const history = store.getMessages(sessionId);
			let mode: 'quick' | 'research' = 'research';
			try {
				mode = (await sidecar!.classify(classifyTail(history))).mode;
			} catch (err) {
				// Router failure falls back to the capable side — worst case is
				// cost, not a wrong answer.
				alog.warn('classify failed — defaulting to research', undefined, err);
			}
			const model = mode === 'research' ? config!.researchModel : config!.routerModel;
			emit({ kind: 'turn-started', sessionId, turnId, mode, model });

			const wallClock = setTimeout(() => {
				alog.warn('turn wall clock exceeded — cancelling', { turnId });
				sidecar!.cancel(turnId);
			}, TURN_WALL_CLOCK_MS);
			try {
				const result = await sidecar!.run(
					{
						turnId,
						mode,
						system: SYSTEM_PROMPT,
						messages: history,
						tools: specs,
						limits: {
							maxSteps: mode === 'research' ? RESEARCH_MAX_STEPS : QUICK_MAX_STEPS,
							maxToolResultBytes: MAX_TOOL_RESULT_BYTES,
						},
					},
					{
						onDelta: (delta) => {
							switch (delta.type) {
								case 'text':
									emit({ kind: 'text-delta', sessionId, turnId, text: delta.text });
									break;
								case 'reasoning':
									emit({ kind: 'reasoning-delta', sessionId, turnId, text: delta.text });
									break;
								case 'tool-start':
									emit({ kind: 'tool-started', sessionId, turnId, callId: delta.callId, tool: delta.tool, label: delta.argsSummary });
									break;
								case 'tool-end':
									// Sidecar-executed tools (local web_fetch, provider
									// web tools) — host tools emit their finish below.
									emit({ kind: 'tool-finished', sessionId, turnId, callId: delta.callId, tool: delta.tool, ok: delta.ok, summary: delta.summary });
									break;
								case 'source':
									emit({ kind: 'source', sessionId, turnId, url: delta.url, ...(delta.title ? { title: delta.title } : {}) });
									break;
								case 'step':
									break;
							}
						},
						// Long-running host tools (the pipeline map) declare their own
						// watchdog budget; everything else gets the manager default.
						toolTimeoutMs: (toolName) => toolsByName.get(toolName)?.timeoutMs,
						onToolCall: async (callId, toolName, args) => {
							const tool = toolsByName.get(toolName);
							if (!tool) throw new Error(`unknown tool: ${toolName}`);
							try {
								const result = await tool.execute(args, ctx);
								emit({ kind: 'tool-finished', sessionId, turnId, callId, tool: toolName, ok: true, summary: summarizeResult(result) });
								return result;
							} catch (err) {
								const message = err instanceof Error ? err.message : String(err);
								emit({ kind: 'tool-finished', sessionId, turnId, callId, tool: toolName, ok: false, summary: message });
								throw err;
							}
						},
					},
				);
				for (const msg of result.newMessages) store.appendMessage(sessionId, turnId, msg);
				store.touchSession(sessionId);
				if (result.stopReason === 'error') {
					emit({ kind: 'error', sessionId, turnId, message: result.errorMessage ?? 'turn failed' });
				}
				emit({ kind: 'turn-finished', sessionId, turnId, stopReason: result.stopReason, usage: result.usage, costUsd: null });
			} finally {
				clearTimeout(wallClock);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			alog.error('turn failed', err instanceof Error ? err : undefined, { turnId });
			emit({ kind: 'error', sessionId, turnId, message });
			emit({
				kind: 'turn-finished',
				sessionId,
				turnId,
				stopReason: 'error',
				usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0 },
				costUsd: null,
			});
		} finally {
			activeTurn = null;
		}
	};

	const status = (): AgentStatus => {
		if (!sidecar || !sidecar.available) return { state: 'disabled' };
		if (!config) return { state: 'unconfigured' };
		return {
			state: activeTurn ? 'running' : 'ready',
			provider: config.provider,
			routerModel: config.routerModel,
			researchModel: config.researchModel,
		};
	};

	return {
		status,

		async configure(next) {
			if (!sidecar) throw new Error('agent sidecar is not available');
			await sidecar.configure(next);
			config = next;
			return status();
		},

		async send({ sessionId, text, context }) {
			if (!sidecar || !sidecar.available) throw new Error('agent is unavailable');
			if (!config) throw new Error('agent is not configured — set a provider + API key in settings');
			if (activeTurn) throw new Error('the agent is already working on a turn — wait or stop it first');
			const trimmed = text.trim();
			if (trimmed.length === 0) throw new Error('empty message');
			const session = sessionId && store.sessionExists(sessionId)
				? sessionId
				: store.createSession(trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed).id;
			const turnId = randomUUID();
			// The context rides the wire message (so history keeps each turn's
			// vantage point) but is stripped from the display transcript.
			const wireText = context ? `${trimmed}${VIEW_CONTEXT_PREFIX}${describeViewContext(context)}]` : trimmed;
			store.appendMessage(session, turnId, { role: 'user', content: wireText });
			store.touchSession(session);
			activeTurn = { sessionId: session, turnId };
			// Fire-and-forget: the turn streams via events; send() returns the
			// long-running handle immediately (kb:expand convention).
			void runTurn(session, turnId);
			return { status: 'running', sessionId: session, turnId };
		},

		async cancel(sessionId) {
			if (activeTurn && activeTurn.sessionId === sessionId) {
				sidecar?.cancel(activeTurn.turnId);
			}
		},

		async listSessions() {
			return store.listSessions();
		},

		async getSession(sessionId) {
			return store.getSession(sessionId);
		},

		async newSession() {
			return store.createSession('New session');
		},

		async deleteSession(sessionId) {
			if (activeTurn?.sessionId === sessionId) sidecar?.cancel(activeTurn.turnId);
			externalHits.delete(sessionId);
			store.deleteSession(sessionId);
			await deps.workspace?.drop(sessionId);
		},

		async getResultSet(resultSetId) {
			return store.getResultSet(resultSetId);
		},

		externalToolSpecs() {
			return specs;
		},

		createExternalSession(title) {
			return store.createSession(title);
		},

		async runExternalTool({ sessionId, name, args }) {
			const tool = toolsByName.get(name);
			if (!tool) throw new Error(`unknown tool: ${name}`);
			if (!store.sessionExists(sessionId)) throw new Error(`unknown session: ${sessionId}`);
			let hits = externalHits.get(sessionId);
			if (!hits) {
				hits = new ProviderHitCache();
				externalHits.set(sessionId, hits);
			}
			const ctx = buildToolCtx(sessionId, randomUUID(), hits);
			// The in-app path gets its watchdog from the sidecar manager —
			// external calls enforce the same budget host-side.
			const timeoutMs = tool.timeoutMs ?? EXTERNAL_TOOL_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const result = await Promise.race([
					tool.execute(args, ctx),
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
					}),
				]);
				store.touchSession(sessionId);
				return capExternalResult(result);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},

		subscribeEvents(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},

		async stop() {
			externalHits.clear();
			const workspace = deps.workspace?.stop();
			store.close();
			await workspace;
		},
	};
}

// External results return verbatim unless oversized: then the caller gets a
// truncation note plus a JSON-text head — enough to see the shape and switch
// to loadInto/query_workspace aggregation.
function capExternalResult(result: unknown): unknown {
	let json: string;
	try { json = JSON.stringify(result) ?? 'null'; } catch { return result; }
	if (json.length <= MAX_EXTERNAL_RESULT_BYTES) return result;
	return {
		truncated: true,
		note: 'result too large — use loadInto/query_workspace to aggregate instead of paging raw rows',
		head: json.slice(0, MAX_EXTERNAL_RESULT_BYTES),
	};
}

function summarizeResult(result: unknown): string {
	if (result == null) return 'ok';
	if (typeof result === 'object') {
		const r = result as Record<string, unknown>;
		if (typeof r['table'] === 'string' && typeof r['rowCount'] === 'number') return `loaded ${r['rowCount']} rows → ${r['table']}`;
		if (Array.isArray(r['rows']) && Array.isArray(r['columns'])) return `${r['rows'].length} rows`;
		if (Array.isArray(r['tracks'])) return `${r['tracks'].length} tracks${typeof r['total'] === 'number' ? ` of ${r['total']}` : ''}`;
		if (Array.isArray(r['items'])) return `${r['items'].length} items${typeof r['total'] === 'number' ? ` of ${r['total']}` : ''}`;
		if (Array.isArray(r['entities'])) return `${r['entities'].length} entities`;
		if (Array.isArray(r['artists'])) return `${r['artists'].length} artists`;
		if (typeof r['accepted'] === 'number') return `${r['accepted']} accepted${Array.isArray(r['rejected']) && r['rejected'].length > 0 ? `, ${r['rejected'].length} rejected` : ''}`;
		if (typeof r['found'] === 'boolean') return r['found'] ? 'found' : 'not found';
		if (typeof r['status'] === 'string') return r['status'];
	}
	let s: string;
	try { s = JSON.stringify(result) ?? 'ok'; } catch { s = 'ok'; }
	return s.length > 80 ? s.slice(0, 80) + '…' : s;
}
