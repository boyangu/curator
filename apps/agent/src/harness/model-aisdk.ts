// Default ModelAdapter on the Vercel AI SDK — the provider facade boundary.
// Everything SDK-shaped lives in this file: provider construction, tool
// registration (schemas only, never execute — the loop owns execution),
// prompt caching, native web tools, and stream-part normalization. An AI
// SDK major bump should touch only this file.

import { generateText, jsonSchema, streamText, tool, type JSONSchema7, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { AgentConfig, WireMessage, WireToolSpec } from '../protocol.js';
import type { ModelAdapter, ModelDelta, ModelRequest, ModelStep } from './types.js';

function makeModel(cfg: AgentConfig, modelId: string): LanguageModel {
	switch (cfg.provider) {
		case 'anthropic':
			return createAnthropic({ apiKey: cfg.apiKey })(modelId);
		case 'openai':
			return createOpenAI({ apiKey: cfg.apiKey })(modelId);
		case 'deepseek':
			return createDeepSeek({ apiKey: cfg.apiKey })(modelId);
		case 'openai-compatible':
			if (!cfg.baseUrl) throw new Error('openai-compatible provider requires baseUrl');
			return createOpenAICompatible({ name: 'byok', baseURL: cfg.baseUrl, apiKey: cfg.apiKey })(modelId);
	}
}

// Provider-native server-side web tools. Anthropic runs search + fetch on
// its side (results and citations stream back in-band, zero sidecar code);
// OpenAI has search only. DeepSeek / openai-compatible have none — the
// sidecar's local web_fetch floor covers fetching there, and the absence of
// web_search is a supported disabled state surfaced in the panel.
function nativeWebTools(cfg: AgentConfig): ToolSet {
	if (cfg.provider === 'anthropic') {
		const p = createAnthropic({ apiKey: cfg.apiKey });
		return {
			web_search: p.tools.webSearch_20250305({ maxUses: 8 }),
			web_fetch: p.tools.webFetch_20250910({ maxUses: 8 }),
		};
	}
	if (cfg.provider === 'openai') {
		const p = createOpenAI({ apiKey: cfg.apiKey });
		return { web_search: p.tools.webSearch() };
	}
	return {};
}

function buildTools(specs: WireToolSpec[]): ToolSet {
	const tools: ToolSet = {};
	for (const spec of specs) {
		// No execute — the SDK surfaces tool calls as stream parts instead of
		// running them, which is exactly the loop's seam.
		tools[spec.name] = tool({
			description: spec.description,
			inputSchema: jsonSchema(spec.parameters as JSONSchema7),
		});
	}
	return tools;
}

// System prompt as a message so Anthropic's cache_control can ride on it —
// the frozen system + fixed-order tool list form the stable cached prefix.
function buildMessages(cfg: AgentConfig, system: string, messages: WireMessage[]): ModelMessage[] {
	const systemMsg: ModelMessage = {
		role: 'system',
		content: system,
		...(cfg.provider === 'anthropic'
			? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
			: {}),
	};
	// WireMessage is a structural subset of ModelMessage by construction.
	return [systemMsg, ...(messages as ModelMessage[])];
}

function mapFinishReason(reason: string): 'end' | 'tool-calls' | 'length' | 'error' {
	switch (reason) {
		case 'tool-calls': return 'tool-calls';
		case 'length': return 'length';
		case 'error': return 'error';
		default: return 'end';
	}
}

export const aiSdkAdapter: ModelAdapter = {
	stream(req: ModelRequest): ModelStep {
		const result = streamText({
			model: makeModel(req.config, req.model),
			messages: buildMessages(req.config, req.system, req.messages),
			// Deliberate: the system prompt rides in messages so Anthropic's
			// cache_control can sit on it (buildMessages) — opt in to silence
			// the SDK's injection warning.
			allowSystemInMessages: true,
			tools: {
				...buildTools(req.tools),
				...(req.nativeWebTools ? nativeWebTools(req.config) : {}),
			},
			abortSignal: req.abort,
		});

		async function* parts(): AsyncGenerator<ModelDelta> {
			for await (const part of result.fullStream) {
				switch (part.type) {
					case 'text-delta':
						yield { type: 'text', text: part.text };
						break;
					case 'reasoning-delta':
						yield { type: 'reasoning', text: part.text };
						break;
					case 'tool-call':
						yield {
							type: 'tool-call',
							callId: part.toolCallId,
							tool: part.toolName,
							args: part.input,
							providerExecuted: part.providerExecuted === true,
						};
						break;
					case 'tool-result':
						yield { type: 'tool-end', callId: part.toolCallId, tool: part.toolName, ok: true };
						break;
					case 'tool-error':
						yield { type: 'tool-end', callId: part.toolCallId, tool: part.toolName, ok: false };
						break;
					case 'source':
						if (part.sourceType === 'url') {
							yield { type: 'source', url: part.url, ...(part.title ? { title: part.title } : {}) };
						}
						break;
					case 'finish':
						yield {
							type: 'finish',
							stopReason: mapFinishReason(part.finishReason),
							usage: {
								inputTokens: part.totalUsage.inputTokens ?? 0,
								outputTokens: part.totalUsage.outputTokens ?? 0,
								cacheReadTokens: part.totalUsage.cachedInputTokens ?? 0,
							},
						};
						break;
					case 'error':
						throw part.error instanceof Error ? part.error : new Error(String(part.error));
					case 'abort':
						throw new Error('aborted');
					default:
						break;
				}
			}
		}

		return {
			parts: parts(),
			async responseMessages(): Promise<WireMessage[]> {
				const response = await result.response;
				return response.messages as WireMessage[];
			},
		};
	},

	async complete(config, model, system, messages): Promise<string> {
		const result = await generateText({
			model: makeModel(config, model),
			messages: buildMessages(config, system, messages),
			allowSystemInMessages: true,
		});
		return result.text;
	},
};
