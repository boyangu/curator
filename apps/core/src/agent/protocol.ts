// Host-side copy of the curator-agent wire protocol. Contract lives at
// apps/agent/src/protocol.ts — keep the two in sync (same copy-with-comment
// convention as the researcher sidecar). Core cannot import from apps/agent:
// the sidecar is an independently-built program (its own zod major, its own
// AI SDK deps) and these types ARE the boundary.

export const AGENT_PROTOCOL = 1;
export const AGENT_SIDECAR_NAME = 'curator-agent';

export type AgentProvider = 'anthropic' | 'openai' | 'deepseek' | 'openai-compatible';

export interface AgentConfig {
	provider: AgentProvider;
	baseUrl?: string;
	apiKey: string;
	routerModel: string;
	researchModel: string;
}

export interface WireToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

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

export type AgentDelta =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'tool-start'; callId: string; tool: string; argsSummary: string }
	| { type: 'tool-end'; callId: string; tool: string; ok: boolean; summary: string }
	| { type: 'source'; url: string; title?: string }
	| { type: 'step'; model: string; step: number };

export interface RunParams {
	turnId: string;
	mode: 'quick' | 'research';
	system: string;
	messages: WireMessage[];
	tools: WireToolSpec[];
	limits: {
		maxSteps: number;
		maxToolResultBytes: number;
	};
}

export interface RunUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	steps: number;
}

export type RunStopReason = 'done' | 'cancelled' | 'max-steps' | 'error';

export interface RunResult {
	turnId: string;
	stopReason: RunStopReason;
	text: string;
	newMessages: WireMessage[];
	usage: RunUsage;
	errorMessage?: string;
}

export interface ClassifyResult {
	mode: 'quick' | 'research';
}
