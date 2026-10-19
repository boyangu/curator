import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyTail, createAgentService, describeViewContext, type AgentEvent, type AgentService } from './service.js';
import { SqliteAgentStore } from './store.js';
import type { AgentTool } from './tools.js';
import type { ResultRefPorts } from './result-set.js';
import type { WireMessage } from './protocol.js';

describe('classifyTail', () => {
	const history: WireMessage[] = [
		{ role: 'user', content: 'find me tracks' },
		{ role: 'assistant', content: [
			{ type: 'text', text: 'searching… ' },
			{ type: 'tool-call', toolCallId: 'c1', toolName: 'query_library', input: {} },
		] },
		{ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'query_library', output: { type: 'json', value: {} } }] },
		{ role: 'assistant', content: [{ type: 'text', text: 'here you go' }] },
		{ role: 'user', content: 'more like that' },
	];

	it('drops tool traffic so a sliced window can never start with an orphaned tool_result', () => {
		const tail = classifyTail(history, 8);
		expect(tail.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
		expect(tail.every((m) => typeof m.content === 'string')).toBe(true);
		// The field bug: slice(-N) landing ON the tool message. Even limit 3
		// (which would have started at the tool_result) yields a clean window.
		expect(classifyTail(history, 3).map((m) => m.role)).toEqual(['assistant', 'assistant', 'user']);
	});

	it('flattens assistant parts to text and drops empty assistant turns', () => {
		const tail = classifyTail(history, 8);
		expect(tail[1]).toEqual({ role: 'assistant', content: 'searching… ' });
		const emptied = classifyTail([{ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'x', toolName: 't', input: {} }] }], 8);
		expect(emptied).toEqual([]);
	});
});

describe('describeViewContext', () => {
	it('describes source tabs, playlists and folders', () => {
		expect(describeViewContext({ view: 'tracks', source: 'spotify' })).toBe('Spotify tab');
		expect(describeViewContext({ view: 'tracks', source: 'tidal' })).toBe('Tidal tab');
		expect(describeViewContext({ view: 'tracks', source: 'rekordbox', playlist: { id: 'p1', name: 'Peak Time', source: 'rekordbox' } }))
			.toBe('Rekordbox tab, playlist "Peak Time" (playlistId p1)');
		expect(describeViewContext({ view: 'tracks', source: 'rekordbox', folderName: 'Bangers' }))
			.toBe('Rekordbox tab, folder "Bangers"');
	});

	it('describes discover modes and filters', () => {
		expect(describeViewContext({ view: 'discover', discover: { mode: 'feed' } })).toBe('Discover feed');
		expect(describeViewContext({ view: 'discover', discover: { mode: 'feed', genre: 'Techno', label: 'Afterlife' } }))
			.toBe('Discover feed with genre filter "Techno" and label filter "Afterlife"');
		expect(describeViewContext({ view: 'discover', discover: { mode: 'journeys' } })).toBe('Discover tab, Journeys view');
		expect(describeViewContext({ view: 'discover', discover: { mode: 'agent-results' } })).toBe('Discover tab, viewing an agent result list');
	});

	it('describes tag views and falls back generically', () => {
		expect(describeViewContext({ view: 'interested' })).toBe('the Interested (pinned) tracks view');
		expect(describeViewContext({ view: 'basket' })).toBe('the Basket tracks view');
		expect(describeViewContext({ view: 'downloads' })).toBe('the downloads view');
	});
});

describe('external tool API (MCP bridge)', () => {
	const SCHEMA = { type: 'object', properties: {} } as const;
	const refs: ResultRefPorts = {
		libraryTracks: async (ids) => new Map(ids.filter((id) => id === 'lib1').map((id) => [id, 'sp-lib1'])),
		feedItems: async () => new Map(),
		kbEntities: async () => new Map(),
	};
	const tools: AgentTool[] = [
		{
			name: 'find_hit',
			description: 'records a provider hit, like a search tool would',
			parameters: SCHEMA,
			async execute(_args, ctx) {
				ctx.providerHits.record('spotify', 'sp1', { url: 'https://open.spotify.com/track/sp1' });
				return { found: true };
			},
		},
		{
			name: 'present',
			description: 'forwards to ctx.presentResultSet',
			parameters: SCHEMA,
			async execute(args, ctx) {
				const a = args as { items: Parameters<typeof ctx.presentResultSet>[0]['items'] };
				return ctx.presentResultSet({ title: 'test set', items: a.items });
			},
		},
		{
			name: 'huge',
			description: 'oversized result',
			parameters: SCHEMA,
			async execute() {
				return { rows: 'x'.repeat(100_000) };
			},
		},
		{
			name: 'slow',
			description: 'never resolves',
			parameters: SCHEMA,
			timeoutMs: 30,
			async execute() {
				return new Promise(() => { /* hangs */ });
			},
		},
	];

	let dir: string;
	let store: SqliteAgentStore;
	let service: AgentService;
	let events: AgentEvent[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'curator-agent-ext-'));
		store = new SqliteAgentStore(join(dir, 'agent.db'));
		service = createAgentService({
			store,
			tools,
			refs,
			getFeedFilterOptions: async () => ({ genres: [], labels: [] }),
		});
		events = [];
		service.subscribeEvents((e) => events.push(e));
	});

	afterEach(() => {
		service.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it('exposes the registry specs and executes tools without a sidecar', async () => {
		expect(service.externalToolSpecs().map((s) => s.name)).toEqual(['find_hit', 'present', 'huge', 'slow']);
		const session = service.createExternalSession('Claude Desktop');
		const result = await service.runExternalTool({ sessionId: session.id, name: 'find_hit', args: {} });
		expect(result).toEqual({ found: true });
	});

	it('rejects unknown tools and unknown sessions', async () => {
		const session = service.createExternalSession('s');
		await expect(service.runExternalTool({ sessionId: session.id, name: 'nope', args: {} }))
			.rejects.toThrow('unknown tool: nope');
		await expect(service.runExternalTool({ sessionId: 'ghost', name: 'find_hit', args: {} }))
			.rejects.toThrow('unknown session: ghost');
	});

	it('scopes provider hits to the session, across calls', async () => {
		const session = service.createExternalSession('s');
		await service.runExternalTool({ sessionId: session.id, name: 'find_hit', args: {} });
		const items = [{ kind: 'provider-hit', title: 'Track', artists: ['A'], providerRef: { provider: 'spotify', id: 'sp1' } }];
		// Same session, LATER call — the hit recorded above must still validate.
		const ok = await service.runExternalTool({ sessionId: session.id, name: 'present', args: { items } }) as { accepted: number };
		expect(ok.accepted).toBe(1);
		// Fresh session never saw the hit — same draft must be rejected.
		const other = service.createExternalSession('other');
		const nope = await service.runExternalTool({ sessionId: other.id, name: 'present', args: { items } }) as { accepted: number; rejected: { reason: string }[] };
		expect(nope.accepted).toBe(0);
		expect(nope.rejected[0]!.reason).toContain('sp1');
	});

	it('emits result-set events and persists the set', async () => {
		const session = service.createExternalSession('s');
		const items = [{ kind: 'library-track', title: 'Known', artists: [], trackId: 'lib1' }];
		const res = await service.runExternalTool({ sessionId: session.id, name: 'present', args: { items } }) as { resultSetId: string };
		const evt = events.find((e) => e.kind === 'result-set');
		expect(evt).toBeDefined();
		expect(await service.getResultSet(res.resultSetId)).toMatchObject({ title: 'test set', sessionId: session.id });
	});

	it('truncates oversized results with an aggregation hint', async () => {
		const session = service.createExternalSession('s');
		const result = await service.runExternalTool({ sessionId: session.id, name: 'huge', args: {} }) as { truncated: boolean; note: string; head: string };
		expect(result.truncated).toBe(true);
		expect(result.note).toContain('query_workspace');
		expect(result.head.length).toBeLessThanOrEqual(64_000);
	});

	it('enforces the per-tool timeout host-side', async () => {
		const session = service.createExternalSession('s');
		await expect(service.runExternalTool({ sessionId: session.id, name: 'slow', args: {} }))
			.rejects.toThrow('slow timed out after 30ms');
	});
});
