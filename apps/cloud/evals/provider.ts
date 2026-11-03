// promptfoo provider for the catalogue reasoner's regression set: the same
// prefix (prompts.ts) and Anthropic adapter (model.ts) the worker uses, fed a
// stored or snapshot evidence pack (agent/evals.ts) instead of a live one.
// Bundled by evals/build.mjs (workspace packages export TypeScript source,
// which promptfoo's loader will not read from node_modules).
//
// Web research is off unless CURATOR_EVAL_RESEARCH=1: a replay should grade
// the prompt pack on the evidence, not on what a search found today.

import { parseVerdict, type AgentCaseKind } from '../src/catalog/agent/cases.js';
import { agentReasonerConfig, reasonerModel } from '../src/catalog/agent/config.js';
import type { ModelCall } from '../src/catalog/agent/model.js';
import { renderPack, type EvidencePack } from '../src/catalog/agent/pack.js';
import { prefixFor } from '../src/catalog/agent/prompts.js';

// Strings: promptfoo reads an array var as a matrix and refuses objects.
type Vars = { id: string; kind: AgentCaseKind; pack: string };
type Context = { vars: Vars };

export default class CatalogReasonerProvider {
	private call: ModelCall | null = null;
	private model = '';

	id(): string {
		return `curator-catalog-reasoner:${process.env.CURATOR_AGENT_MODEL ?? 'claude-opus-5-5'}`;
	}

	async callApi(_prompt: string, context: Context): Promise<{ output?: string; error?: string; cost?: number; tokenUsage?: Record<string, number>; metadata?: Record<string, unknown> }> {
		if (!this.call) {
			const cfg = agentReasonerConfig(process.env);
			if (!cfg) return { error: 'the reasoner is off: set CURATOR_ANTHROPIC_API_KEY, or CURATOR_AGENT_BACKEND=claude-code (root .env)' };
			this.model = cfg.model;
			this.call = reasonerModel(cfg);
		}
		const kind = context.vars.kind;
		const pack = JSON.parse(context.vars.pack) as EvidencePack;
		const prefix = prefixFor(kind);
		try {
			const answer = await this.call({ prefix, user: renderPack(pack), research: pack.research && process.env.CURATOR_EVAL_RESEARCH === '1' });
			const tokenUsage = { prompt: answer.usage.inputTokens, completion: answer.usage.outputTokens, cached: answer.usage.cacheReadTokens, total: answer.usage.inputTokens + answer.usage.outputTokens };
			const metadata = { promptHash: prefix.hash, packId: prefix.packId, packVersion: prefix.packVersion, model: answer.model };
			if (answer.declined) return { error: 'declined', cost: answer.costUsd, tokenUsage, metadata };
			if (answer.verdict === null) return { error: `no verdict (${answer.stopReason}): ${answer.text.slice(0, 200)}`, cost: answer.costUsd, tokenUsage, metadata };
			return { output: JSON.stringify(parseVerdict(kind, answer.verdict)), cost: answer.costUsd, tokenUsage, metadata };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
}
