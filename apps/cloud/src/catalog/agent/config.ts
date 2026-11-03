// The reasoner's configuration, from the environment like every other
// provider of the worker (worker/main.ts): on when CURATOR_ANTHROPIC_API_KEY
// is set or the Claude Code backend is chosen, off otherwise — disabled is a
// supported state, the cases still queue and the inbox detectors raise their
// items as before.
//
//   CURATOR_AGENT_BACKEND         api (default: the key below) | claude-code (Guy's Claude Code
//                                 subscription through `claude -p`, local only: model-claude-code.ts)
//   CURATOR_CLAUDE_BIN            the claude executable, default `claude` on PATH
//   CURATOR_ANTHROPIC_API_KEY     Curator's own key (the hosted mode of the agent foundation)
//   CURATOR_AGENT_MODEL           default claude-opus-5-5
//   CURATOR_AGENT_CONFIDENCE      0..1, default 0.8: below it a verdict is proposed, never applied
//   CURATOR_AGENT_DAILY_USD       default 2: the day's spend ceiling, in dollars
//   CURATOR_AGENT_DAILY_CALLS     default 200: the day's call ceiling (curator.catalog_reserve_calls)
//   CURATOR_AGENT_BATCH           cases per pass, default 5
//   CURATOR_AGENT_SEARCH_USD      what one web search costs, default 0.01

import { ConfigError } from '../../config.js';
import { claudeCodeModelCall } from './model-claude-code.js';
import { anthropicModelCall, type ModelCall } from './model.js';

export type AgentBackend = 'api' | 'claude-code';

export type AgentReasonerConfig = {
	backend: AgentBackend;
	// Empty on the claude-code backend.
	apiKey: string;
	claudeBin?: string;
	model: string;
	confidenceFloor: number;
	dailyUsd: number;
	dailyCalls: number;
	batch: number;
	searchUsd: number;
};

function numberOf(env: NodeJS.ProcessEnv, name: string, fallback: number, check: (n: number) => boolean): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || !check(n)) throw new ConfigError(`${name} is not a valid value: ${raw}`);
	return n;
}

export function agentReasonerConfig(env: NodeJS.ProcessEnv = process.env): AgentReasonerConfig | null {
	const backend = (env.CURATOR_AGENT_BACKEND?.trim() || 'api') as AgentBackend;
	if (backend !== 'api' && backend !== 'claude-code') throw new ConfigError(`CURATOR_AGENT_BACKEND is api or claude-code, not ${backend}`);
	const apiKey = env.CURATOR_ANTHROPIC_API_KEY?.trim() ?? '';
	if (backend === 'api' && !apiKey) return null;
	return {
		backend,
		apiKey,
		...(env.CURATOR_CLAUDE_BIN?.trim() ? { claudeBin: env.CURATOR_CLAUDE_BIN.trim() } : {}),
		model: env.CURATOR_AGENT_MODEL?.trim() || 'claude-opus-5-5',
		confidenceFloor: numberOf(env, 'CURATOR_AGENT_CONFIDENCE', 0.8, (n) => n >= 0 && n <= 1),
		dailyUsd: numberOf(env, 'CURATOR_AGENT_DAILY_USD', 2, (n) => n >= 0),
		dailyCalls: numberOf(env, 'CURATOR_AGENT_DAILY_CALLS', 200, (n) => Number.isInteger(n) && n >= 0),
		batch: numberOf(env, 'CURATOR_AGENT_BATCH', 5, (n) => Number.isInteger(n) && n >= 1 && n <= 50),
		searchUsd: numberOf(env, 'CURATOR_AGENT_SEARCH_USD', 0.01, (n) => n >= 0),
	};
}

// The model the configuration names: the API adapter on Curator's key, or
// Claude Code on the subscription.
export function reasonerModel(cfg: AgentReasonerConfig): ModelCall {
	return cfg.backend === 'claude-code'
		? claudeCodeModelCall({ model: cfg.model, bin: cfg.claudeBin })
		: anthropicModelCall({ apiKey: cfg.apiKey, model: cfg.model, searchUsd: cfg.searchUsd });
}

export function describeReasoner(cfg: AgentReasonerConfig | null): string {
	if (!cfg) return 'off (no CURATOR_ANTHROPIC_API_KEY; or set CURATOR_AGENT_BACKEND=claude-code)';
	const how = cfg.backend === 'claude-code' ? 'Claude Code subscription' : `API key, ceiling $${cfg.dailyUsd}/day`;
	return `${cfg.model} via ${how}, ${cfg.batch} cases a pass, ${cfg.dailyCalls} calls/day`;
}
