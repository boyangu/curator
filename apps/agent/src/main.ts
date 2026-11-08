// curator-agent — the in-app agent sidecar. The protocol and the loop come
// from @curator/agent-core, shared with the host (apps/core/src/agent/
// sidecar.ts); this program is the AI SDK adapter plus the stdio framing.
//
// The process is stateless across turns: `configure` arms it with BYOK
// provider config (re-send = key rotation, no respawn), `classify` runs the
// cheap router pre-pass, `run` executes one streamed turn of the harness
// loop with host tools forwarded over reverse-RPC tool-call frames, and
// `research` runs one web-research task that answers through a terminal
// tool (the knowledge base's similar-artists tier).

// The protocol owns stdout — rebind console BEFORE any import can log.
// Host treats stderr lines as log records (researcher convention).
/* eslint-disable no-console */
console.log = console.info = console.warn = console.error = (...args: unknown[]) => {
	process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
};

import { createInterface } from 'node:readline';
import {
	AGENT_PROTOCOL,
	AGENT_SIDECAR_NAME,
	defaultLoop,
	noopLog,
	type AgentConfig,
	type AgentDelta,
	type AgentHostFrame,
	type ClassifyResult,
	type LocalTool,
	type ResearchParams,
	type ResearchResult,
	type RunParams,
	type ToolPort,
	type WireMessage,
	RESEARCH_TOOL,
} from '@curator/agent-core';
import { aiSdkAdapter } from './harness/model-aisdk.js';
import { webFetchTool } from './harness/web-fetch.js';

const VERSION = '0.1.0';

function send(frame: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(frame) + '\n');
}

let config: AgentConfig | null = null;

// Reverse-RPC tool port: post a tool-call frame, await the host's
// tool-result / tool-error. The host owns per-call timeouts. Entries carry
// their turn so a run that ends rejects only its own calls.
const pendingTools = new Map<string, { turnId: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function makeToolPort(turnId: string): ToolPort {
	return {
		execute(callId, tool, args) {
			return new Promise((resolve, reject) => {
				pendingTools.set(callId, { turnId, resolve, reject });
				send({ event: 'tool-call', turnId, callId, tool, args });
			});
		},
	};
}

// Research has no host tools: the model gets record_claims and the
// provider's web tools only, so a call here is a model error.
const noHostTools: ToolPort = {
	execute: async (_callId, tool) => {
		throw new Error(`research has no host tools (${tool})`);
	},
};

function rejectPending(turnId: string): void {
	for (const [callId, p] of pendingTools) {
		if (p.turnId !== turnId) continue;
		pendingTools.delete(callId);
		p.reject(new Error('turn ended'));
	}
}

// Two lanes, one run each: an assistant turn (the host's AgentService
// serializes turns; this is the belt to its braces) and a research task (the
// knowledge base's agent lane sends one at a time). They run side by side.
const lanes: Record<'turn' | 'research', { turnId: string; abort: AbortController } | null> = { turn: null, research: null };

// The local web_fetch floor where the provider has no native fetch.
// Anthropic's native web_fetch replaces it (same name — never register both).
function webFloor(cfg: AgentConfig): Record<string, LocalTool> {
	return cfg.provider === 'anthropic' ? {} : { [webFetchTool.spec.name]: webFetchTool };
}

const CLASSIFY_SYSTEM = [
	'You are the router for a music-discovery agent inside a DJ library app.',
	'Classify the user\'s LATEST request:',
	'- "quick": answerable from local data (the user\'s library, the discover feed, the knowledge base, workspace SQL over already-loaded data) or a view change — filters, lookups, counts, aggregations, "show me…" over known data.',
	'- "research": needs web research, provider searches, multi-step curation, or building a list of music the user does not have yet.',
	'Respond with ONLY this JSON, no prose: {"mode":"quick"} or {"mode":"research"}',
].join('\n');

async function classify(messages: WireMessage[]): Promise<ClassifyResult> {
	if (!config) throw new Error('agent not configured');
	const text = await aiSdkAdapter.complete(config, config.routerModel, CLASSIFY_SYSTEM, messages);
	const m = /"mode"\s*:\s*"(quick|research)"/.exec(text);
	// Misrouting research→quick starves the answer; unparseable output falls
	// back to the capable side.
	return { mode: m?.[1] === 'quick' ? 'quick' : 'research' };
}

async function run(params: RunParams): Promise<unknown> {
	if (!config) throw new Error('agent not configured');
	if (lanes.turn) throw new Error('a turn is already running');
	const abort = new AbortController();
	lanes.turn = { turnId: params.turnId, abort };
	try {
		const emit = (delta: AgentDelta): void => send({ event: 'delta', turnId: params.turnId, delta });
		return await defaultLoop.run(
			params,
			config,
			{ model: aiSdkAdapter, tools: makeToolPort(params.turnId), localTools: webFloor(config), log: noopLog },
			emit,
			abort.signal,
		);
	} finally {
		lanes.turn = null;
		// A cancelled/failed run must not leave dangling host-call promises.
		rejectPending(params.turnId);
	}
}

async function research(params: ResearchParams): Promise<ResearchResult> {
	if (!config) throw new Error('agent not configured');
	if (lanes.research) throw new Error('a research task is already running');
	const abort = new AbortController();
	lanes.research = { turnId: params.requestId, abort };
	const sources: ResearchResult['sources'] = [];
	try {
		const result = await defaultLoop.run(
			{
				turnId: params.requestId,
				// Research mode: the research model and the provider's web tools.
				mode: 'research',
				system: params.system,
				messages: [{ role: 'user', content: params.prompt }],
				tools: [{ name: RESEARCH_TOOL, description: 'Record your findings. Call it exactly once, at the end.', parameters: params.claimsSchema, annotations: { readOnly: true } }],
				limits: params.limits,
				terminalTool: RESEARCH_TOOL,
			},
			config,
			{ model: aiSdkAdapter, tools: noHostTools, localTools: webFloor(config), log: noopLog },
			// No delta frames for research: only the pages it cited are kept.
			(delta) => {
				if (delta.type === 'source' && !sources.some((x) => x.url === delta.url)) sources.push({ url: delta.url, ...(delta.title ? { title: delta.title } : {}) });
			},
			abort.signal,
		);
		return {
			requestId: params.requestId,
			stopReason: result.stopReason,
			structured: result.structured ?? null,
			usage: result.usage,
			model: config.researchModel,
			sources,
			...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
		};
	} finally {
		lanes.research = null;
	}
}

async function main(): Promise<void> {
	send({ event: 'hello', name: AGENT_SIDECAR_NAME, version: VERSION, protocol: AGENT_PROTOCOL });
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) continue;
		let frame: AgentHostFrame;
		try {
			frame = JSON.parse(line) as AgentHostFrame;
		} catch {
			continue; // not our protocol — skip rather than crash
		}
		if (!('method' in frame)) continue;
		switch (frame.method) {
			case 'shutdown':
				process.exit(0);
				break;
			case 'tool-result': {
				const p = pendingTools.get(frame.callId);
				if (p) { pendingTools.delete(frame.callId); p.resolve(frame.result); }
				break;
			}
			case 'tool-error': {
				const p = pendingTools.get(frame.callId);
				if (p) { pendingTools.delete(frame.callId); p.reject(new Error(frame.message)); }
				break;
			}
			case 'cancel':
				for (const lane of Object.values(lanes)) if (lane && lane.turnId === frame.params.turnId) lane.abort.abort();
				break;
			case 'configure':
				config = frame.params;
				send({ id: frame.id, result: { ok: true } });
				break;
			case 'classify':
				classify(frame.params.messages)
					.then((r) => send({ id: frame.id, result: r }))
					.catch((err: unknown) => send({ id: frame.id, error: { message: err instanceof Error ? err.message : String(err) } }));
				break;
			case 'run':
				// Async on purpose — the readline loop must stay free to receive
				// tool-result and cancel frames while the turn runs.
				run(frame.params)
					.then((result) => send({ id: frame.id, result }))
					.catch((err: unknown) => send({ id: frame.id, error: { message: err instanceof Error ? err.message : String(err) } }));
				break;
			case 'research':
				research(frame.params)
					.then((result) => send({ id: frame.id, result }))
					.catch((err: unknown) => send({ id: frame.id, error: { message: err instanceof Error ? err.message : String(err) } }));
				break;
		}
	}
}

void main();
