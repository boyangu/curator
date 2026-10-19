// curator-agent — the in-app agent sidecar. Protocol contract lives in
// ./protocol.ts (host side: apps/core/src/agent/sidecar.ts — keep in sync).
//
// The process is stateless across turns: `configure` arms it with BYOK
// provider config (re-send = key rotation, no respawn), `classify` runs the
// cheap router pre-pass, `run` executes one streamed turn of the harness
// loop with host tools forwarded over reverse-RPC tool-call frames.

// The protocol owns stdout — rebind console BEFORE any import can log.
// Host treats stderr lines as log records (researcher convention).
/* eslint-disable no-console */
console.log = console.info = console.warn = console.error = (...args: unknown[]) => {
	process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
};

import { createInterface } from 'node:readline';
import {
	PROTOCOL,
	SIDECAR_NAME,
	type AgentConfig,
	type AgentDelta,
	type AgentHostFrame,
	type ClassifyResult,
	type RunParams,
	type WireMessage,
} from './protocol.js';
import { defaultLoop } from './harness/loop.js';
import { aiSdkAdapter } from './harness/model-aisdk.js';
import { webFetchTool } from './harness/web-fetch.js';
import { noopLog, type LocalTool, type ToolPort } from './harness/types.js';

const VERSION = '0.1.0';

function send(frame: Record<string, unknown>): void {
	process.stdout.write(JSON.stringify(frame) + '\n');
}

let config: AgentConfig | null = null;

// Reverse-RPC tool port: post a tool-call frame, await the host's
// tool-result / tool-error. The host owns per-call timeouts.
const pendingTools = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function makeToolPort(turnId: string): ToolPort {
	return {
		execute(callId, tool, args) {
			return new Promise((resolve, reject) => {
				pendingTools.set(callId, { resolve, reject });
				send({ event: 'tool-call', turnId, callId, tool, args });
			});
		},
	};
}

// One run at a time — the host's AgentService serializes turns; this is the
// belt to its braces.
let activeRun: { turnId: string; abort: AbortController } | null = null;

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
	if (activeRun) throw new Error('a turn is already running');
	const abort = new AbortController();
	activeRun = { turnId: params.turnId, abort };
	try {
		// Anthropic's native web_fetch replaces the local floor (same name —
		// avoid registering both).
		const localTools: Record<string, LocalTool> = {};
		if (config.provider !== 'anthropic') localTools[webFetchTool.spec.name] = webFetchTool;
		const emit = (delta: AgentDelta): void => send({ event: 'delta', turnId: params.turnId, delta });
		return await defaultLoop.run(
			params,
			config,
			{ model: aiSdkAdapter, tools: makeToolPort(params.turnId), localTools, log: noopLog },
			emit,
			abort.signal,
		);
	} finally {
		activeRun = null;
		// A cancelled/failed run must not leave dangling host-call promises.
		for (const [, p] of pendingTools) p.reject(new Error('turn ended'));
		pendingTools.clear();
	}
}

async function main(): Promise<void> {
	send({ event: 'hello', name: SIDECAR_NAME, version: VERSION, protocol: PROTOCOL });
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
				if (activeRun && activeRun.turnId === frame.params.turnId) activeRun.abort.abort();
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
		}
	}
}

void main();
