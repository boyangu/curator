// Harness seams — deepseek-harness-inspired: the model adapter, tool
// execution port, session log, and the loop itself are each replaceable
// interfaces with one default implementation. No plugin machinery — the
// seams exist so tests can script a model, a hosted v2 can swap the tool
// port for a service call, and an AI SDK major bump stays confined to
// model-aisdk.ts.

import type { AgentConfig, AgentDelta, RunParams, RunResult, WireMessage, WireToolSpec } from '../protocol.js';

export interface StepUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

// One model step's streamed parts, normalized away from any SDK shape.
export type ModelDelta =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	// providerExecuted: the provider ran the tool server-side (Anthropic web
	// search) — the loop must NOT round-trip it to the tool port.
	| { type: 'tool-call'; callId: string; tool: string; args: unknown; providerExecuted: boolean }
	// Provider-executed tool finished (its result is already in the step's
	// response messages).
	| { type: 'tool-end'; callId: string; tool: string; ok: boolean }
	| { type: 'source'; url: string; title?: string }
	| { type: 'finish'; stopReason: 'end' | 'tool-calls' | 'length' | 'error'; usage: StepUsage };

// Seam 1 — the provider facade boundary. One streamed step per call; the
// loop owns multi-step orchestration.
export interface ModelStep {
	parts: AsyncIterable<ModelDelta>;
	// The step's response messages (assistant text/tool-calls, plus any
	// provider-executed tool results), exactly as they must be appended to
	// history for the next step. Resolves after `parts` is fully consumed.
	responseMessages(): Promise<WireMessage[]>;
}

export interface ModelRequest {
	config: AgentConfig;
	model: string;
	system: string;
	messages: WireMessage[];
	// Host tools (schemas only — never executed by the adapter).
	tools: WireToolSpec[];
	// Register the provider's native web tools (Anthropic web_search/web_fetch,
	// OpenAI web_search) when the provider has them.
	nativeWebTools: boolean;
	abort: AbortSignal;
}

export interface ModelAdapter {
	stream(req: ModelRequest): ModelStep;
	// One small non-streamed completion — the router pre-pass.
	complete(config: AgentConfig, model: string, system: string, messages: WireMessage[]): Promise<string>;
}

// Seam 2 — where host tools actually run. The default implementation posts
// a tool-call frame and awaits the host's tool-result; tests execute inline.
export interface ToolPort {
	execute(callId: string, tool: string, args: unknown): Promise<unknown>;
}

// Sidecar-local tools (web_fetch floor). Executed in-process by the loop.
export type LocalTool = {
	spec: WireToolSpec;
	execute(args: unknown, abort: AbortSignal): Promise<unknown>;
};

// Seam 3 — the session log. The sidecar is stateless (host persists via
// frames), so the default is a no-op; tests use an in-memory one.
export interface SessionLog {
	append(turnId: string, entry: unknown): void;
}

// Seam 4 — the loop.
export interface LoopDeps {
	model: ModelAdapter;
	tools: ToolPort;
	localTools: Record<string, LocalTool>;
	log: SessionLog;
}

export interface AgentLoop {
	run(
		params: RunParams,
		config: AgentConfig,
		deps: LoopDeps,
		emit: (d: AgentDelta) => void,
		abort: AbortSignal,
	): Promise<RunResult>;
}

export const noopLog: SessionLog = { append: () => {} };
