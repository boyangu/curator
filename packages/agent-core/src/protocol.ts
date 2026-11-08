// The agent wire protocol — one copy, shared by both ends of the stdio
// boundary (apps/agent/src/main.ts and apps/core/src/agent/sidecar.ts), so
// the two can never drift.
//
// Unlike the researcher's one-shot request/response, this protocol is
// bidirectional: the agent loop runs in the sidecar, but tools execute
// host-side (CoreService queries). A `run` request streams `delta` frames,
// issues reverse-RPC `tool-call` frames (answered by `tool-result` /
// `tool-error`), and terminates with the usual {id, result} | {id, error}.
// Modeled on the core-sidecar's HostCallFrame reverse-RPC design.
//
// The sidecar is stateless across turns: the host re-sends the full message
// history on every `run`, so a crash/respawn loses at most the in-flight
// turn. `configure` can be re-sent at any time (key rotation without
// respawn); the sidecar boots unconfigured and rejects `run` until armed.

// 2: the `research` method (research runs in this sidecar; apps/researcher is gone).
export const AGENT_PROTOCOL = 2;
export const AGENT_SIDECAR_NAME = 'curator-agent';

export type AgentProvider = 'anthropic' | 'openai' | 'deepseek' | 'openai-compatible';

// BYOK model config. Two model roles, one loop: the router model handles
// classification + quick turns; the research model runs multi-step research
// turns. Provider-generic — a model adapter maps this onto its SDK.
export interface AgentConfig {
	provider: AgentProvider;
	// openai-compatible only: the endpoint base URL.
	baseUrl?: string;
	apiKey: string;
	routerModel: string;
	researchModel: string;
}

// What a tool does to the world, as MCP's tool annotations say it
// (readOnlyHint, destructiveHint, idempotentHint, openWorldHint). Hints a
// host feeds its confirm gate — never the authority on what runs: the host's
// registry decides that by construction.
export interface ToolAnnotations {
	readOnly?: boolean;
	destructive?: boolean;
	idempotent?: boolean;
	openWorld?: boolean;
}

// Tool schemas cross the wire as plain JSON Schema — deliberately NOT zod:
// core (zod 3) and the sidecar (zod 4, AI SDK requirement) must not share a
// schema library across the process boundary.
export interface WireToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	annotations?: ToolAnnotations;
}

// Conversation messages — a structural subset of the AI SDK's ModelMessage
// so the host can persist/re-send them without depending on the `ai`
// package. Assistant content may carry provider-executed tool calls/results
// (Anthropic server-side web search) — the host stores those opaquely.
export type WireMessage =
	| { role: 'system'; content: string; providerOptions?: Record<string, unknown> }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | WireAssistantPart[] }
	| { role: 'tool'; content: WireToolResultPart[] };

export type WireAssistantPart =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| WireToolCallPart
	| WireToolResultPart;

export interface WireToolCallPart {
	type: 'tool-call';
	toolCallId: string;
	toolName: string;
	input: unknown;
	providerExecuted?: boolean;
}

export interface WireToolResultPart {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	output:
		| { type: 'json'; value: unknown }
		| { type: 'text'; value: string }
		| { type: 'error-text'; value: string }
		| { type: 'error-json'; value: unknown };
}

// Streaming deltas for a running turn. The host forwards these onto the
// renderer's 'agent:event' push (adding sessionId). `tool-end` is emitted
// only for sidecar-executed tools (local web_fetch, provider-native web
// tools) — host-executed tool completions are emitted host-side, where the
// result is actually known.
export type AgentDelta =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'tool-start'; callId: string; tool: string; argsSummary: string }
	| { type: 'tool-end'; callId: string; tool: string; ok: boolean; summary: string }
	| { type: 'source'; url: string; title?: string }
	| { type: 'step'; model: string; step: number };

export interface RunParams {
	turnId: string;
	// Chosen by the host's classify pre-pass; picks the model + step budget.
	mode: 'quick' | 'research';
	// Frozen system prompt, assembled host-side (stable prefix = cache hits).
	system: string;
	messages: WireMessage[];
	// Host-executed tools. The sidecar adds its own (local web_fetch,
	// provider-native web tools) on top.
	tools: WireToolSpec[];
	limits: {
		maxSteps: number;
		maxToolResultBytes: number;
	};
	// The name of a tool in `tools` whose first call ends the run: its
	// arguments are the answer (RunResult.structured) and it is never
	// executed. Research and verdict-style runs answer through one strict
	// tool instead of prose that has to be parsed.
	terminalTool?: string;
}

export interface RunUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	steps: number;
}

export type RunStopReason = 'done' | 'structured' | 'cancelled' | 'max-steps' | 'error';

export interface RunResult {
	turnId: string;
	stopReason: RunStopReason;
	// Final assistant text of the turn ('' when cancelled early).
	text: string;
	// Every message produced this turn (assistant + tool), in order — the
	// host appends these to its session store and re-sends them next turn.
	newMessages: WireMessage[];
	usage: RunUsage;
	// Present when stopReason === 'error'.
	errorMessage?: string;
	// The terminal tool's arguments, when stopReason === 'structured'.
	structured?: unknown;
}

export interface ClassifyResult {
	mode: 'quick' | 'research';
}

// One research run: a single prompt, the provider's web tools, and one
// terminal tool (`record_claims`, the given schema) whose arguments are the
// answer. No host tools, no streamed deltas; runs in its own lane beside an
// assistant turn. The host owns the prompt, validation and the decision log
// (apps/core/src/knowledge/agent-research.ts).
export const RESEARCH_TOOL = 'record_claims';

export interface ResearchParams {
	requestId: string;
	system: string;
	prompt: string;
	// JSON Schema of record_claims' arguments.
	claimsSchema: Record<string, unknown>;
	limits: {
		maxSteps: number;
		maxToolResultBytes: number;
	};
}

export interface ResearchResult {
	requestId: string;
	stopReason: RunStopReason;
	// record_claims' arguments (unvalidated) when stopReason === 'structured'.
	structured: unknown;
	usage: RunUsage;
	model: string;
	// Pages the provider's web tools cited along the way.
	sources: { url: string; title?: string }[];
	errorMessage?: string;
}

// ─── Frames ──────────────────────────────────────────────────────────────

// Sidecar → host.
export type AgentSidecarFrame =
	| { event: 'hello'; name: string; version: string; protocol: number }
	| { event: 'delta'; turnId: string; delta: AgentDelta }
	| { event: 'tool-call'; turnId: string; callId: string; tool: string; args: unknown }
	| { id: number; result: unknown }
	| { id: number; error: { message: string } };

// Host → sidecar.
export type AgentHostFrame =
	| { id: number; method: 'configure'; params: AgentConfig }
	| { id: number; method: 'classify'; params: { messages: WireMessage[] } }
	| { id: number; method: 'run'; params: RunParams }
	| { id: number; method: 'research'; params: ResearchParams }
	| { method: 'tool-result'; callId: string; result: unknown }
	| { method: 'tool-error'; callId: string; message: string }
	// turnId: an assistant turn's id or a research requestId.
	| { method: 'cancel'; params: { turnId: string } }
	| { method: 'shutdown' };
