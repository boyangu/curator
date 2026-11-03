// The hosted-mode model adapter: Curator's own Anthropic key, the Anthropic
// SDK directly (the agent foundation's BYOK adapter lives in apps/agent on
// the AI SDK; this one is a day's work by design, so the cloud gets
// structured verdicts, server-side web search and prompt caching without a
// provider facade in between).
//
// One request per case: the cached prefix (core + pack as system blocks, the
// strict verdict tool), the evidence pack and the question as the user turn,
// the server's web_search/web_fetch for research cases. The verdict comes
// back as the tool's arguments. A `pause_turn` (the server paused a long
// tool run) is resumed by re-sending the conversation; a `refusal` is a
// declined case, not a failure.

import Anthropic from '@anthropic-ai/sdk';
import type { PromptPrefix } from '@curator/agent-core';
import { VERDICT_TOOL } from './prompts.js';

export type ModelUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearches: number };

export type ModelRequest = {
	prefix: PromptPrefix;
	// The evidence pack and the question, already rendered.
	user: string;
	// Research cases get the server's web tools.
	research: boolean;
	abort?: AbortSignal;
};

export type ModelAnswer = {
	// The verdict tool's arguments, unvalidated; null when the model answered
	// in prose only or declined.
	verdict: unknown;
	stopReason: string;
	declined: boolean;
	text: string;
	model: string;
	usage: ModelUsage;
	costUsd: number;
};

export type ModelCall = (req: ModelRequest) => Promise<ModelAnswer>;

// USD per million tokens. Cache writes are 1.25× input; reads are a twentieth.
const RATES: { prefix: string; input: number; output: number; cacheRead: number }[] = [
	{ prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2 },
	{ prefix: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5 },
	{ prefix: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2 },
	{ prefix: 'claude-haiku-5', input: 0.1, output: 0.5, cacheRead: 0.01 },
];

export function costOf(model: string, u: ModelUsage, searchUsd: number): number {
	const r = RATES.find((x) => model.startsWith(x.prefix)) ?? RATES[0]!;
	const perTok = (u.inputTokens * r.input + u.outputTokens * r.output + u.cacheReadTokens * r.cacheRead + u.cacheWriteTokens * r.input * 1.25) / 1_000_000;
	return Math.round((perTok + u.webSearches * searchUsd) * 10_000) / 10_000;
}

const MAX_CONTINUATIONS = 3;
const SEARCH_MAX_USES = 4;

export function anthropicModelCall(cfg: { apiKey: string; model: string; searchUsd: number; timeoutMs?: number }): ModelCall {
	const client = new Anthropic({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs ?? 120_000, maxRetries: 1 });
	return async (req) => {
		const system: Anthropic.Beta.BetaTextBlockParam[] = req.prefix.blocks.map((b) => ({
			type: 'text',
			text: b.text,
			// The pack is the last block identical across this surface's requests:
			// an hour's cache, refreshed by every pass.
			...(b.cacheBreakpoint ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}),
		}));
		const verdict = req.prefix.tools.find((t) => t.name === VERDICT_TOOL)!;
		const tools: Anthropic.Beta.BetaToolUnion[] = [
			{ name: verdict.name, description: verdict.description, input_schema: verdict.parameters as Anthropic.Beta.BetaTool.InputSchema, strict: true },
			...(req.research
				? ([
						{ type: 'web_search_20260209', name: 'web_search', max_uses: SEARCH_MAX_USES },
						{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: SEARCH_MAX_USES },
					] as Anthropic.Beta.BetaToolUnion[])
				: []),
		];
		const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.user }];
		const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 };
		let text = '';
		let answer: unknown = null;
		let stopReason = '';
		let model = cfg.model;
		for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
			const res = await client.beta.messages.create(
				{
					model: cfg.model,
					max_tokens: 4000,
					// Opus 5.5 thinks adaptively by default; effort is the one dial.
					output_config: { effort: 'medium' },
					system,
					tools,
					tool_choice: { type: 'auto' },
					messages,
					// A policy decline re-runs on a fallback model inside the call.
					betas: ['server-side-fallback-2026-07-01'],
					fallbacks: 'default',
				},
				{ signal: req.abort },
			);
			model = res.model;
			usage.inputTokens += res.usage.input_tokens;
			usage.outputTokens += res.usage.output_tokens;
			usage.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
			usage.cacheWriteTokens += res.usage.cache_creation_input_tokens ?? 0;
			usage.webSearches += res.usage.server_tool_use?.web_search_requests ?? 0;
			stopReason = res.stop_reason ?? '';
			for (const block of res.content) {
				if (block.type === 'text') text += block.text;
				else if (block.type === 'tool_use' && block.name === VERDICT_TOOL) answer = block.input;
			}
			if (stopReason === 'pause_turn' && attempt < MAX_CONTINUATIONS) {
				// Resume: the assistant turn so far goes back as is; no new user text.
				messages.push({ role: 'assistant', content: res.content });
				continue;
			}
			break;
		}
		return { verdict: answer, stopReason, declined: stopReason === 'refusal', text, model, usage, costUsd: costOf(model, usage, cfg.searchUsd) };
	};
}
