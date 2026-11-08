// Research on the agent sidecar (apps/agent): the knowledge base's
// similar-artists tier, run with the user's own assistant key (BYOK) in the
// sidecar's research lane. This side owns what the sidecar must not: the
// prompt (versioned by its hash), the claims schema the model answers
// through (`record_claims`, a terminal tool — no prose to parse), validation
// of what comes back, and a decision-log row per run.
//
// Replaces apps/researcher (Claude Agent SDK, a machine-wide env key, JSON
// parsed out of the final text). Unconfigured or disabled is a supported
// state: the port rejects and the KB expansion reports it.

import { randomUUID } from 'node:crypto';
import { assemblePrompt, RESEARCH_TOOL, type DecisionLog, type ResearchResult, type WireToolSpec } from '@curator/agent-core';
import { z } from 'zod';
import type { AgentSidecarManager } from '../agent/sidecar.js';
import { log } from '../log.js';
import type { ResearchClaim, ResearchPort, ResearchRequest } from './research.js';

const rlog = log.for('research');

const MAX_STEPS = 16;
const MAX_TOOL_RESULT_BYTES = 16_384;
const MAX_CITATIONS = 3;

export const UNAVAILABLE = 'research unavailable: configure the assistant\'s API key in Settings';

const CORE = `You are a music-discovery research agent embedded in a DJ library app. You research relationships between electronic-music artists, labels and scenes using web search, and you answer only by calling ${RESEARCH_TOOL} once, at the end.`;

const PACKS: Record<string, { id: string; version: string; text: string }> = {
	'artist.similar-artists': {
		id: 'research.artist.similar-artists',
		version: '1',
		text: `Task: find the artists most similar to the subject artist.

Use web search to research shared labels, remix relationships, back-to-back sets, press/RA/Beatport editorial groupings and "fans also like" style coverage. Prefer electronic/DJ-culture sources. 5 to 10 artists, best first.

Rules:
- Only include artists you found actual evidence for; every claim needs 1-3 citation URLs.
- confidence is 0..1: your belief that a fan of the subject would rate this artist as similar.
- rationale is ONE short sentence naming the evidence (e.g. "both release on Afterlife; b2b at Awakenings 2025").
- If the known facts point to a specific scene/genre, stay inside it.`,
	},
};

// What record_claims takes. Strict-shaped (every key required, nullable where
// optional) so providers that enforce schemas accept it.
const CLAIMS_SCHEMA: Record<string, unknown> = {
	type: 'object',
	additionalProperties: false,
	required: ['claims'],
	properties: {
		claims: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'confidence', 'citations', 'rationale'],
				properties: {
					name: { type: 'string' },
					confidence: { type: 'number' },
					citations: { type: 'array', items: { type: 'string' } },
					rationale: { type: ['string', 'null'] },
				},
			},
		},
	},
};

const CLAIMS = z.object({
	claims: z.array(
		z.object({
			name: z.unknown(),
			confidence: z.unknown(),
			citations: z.unknown(),
			rationale: z.unknown(),
		}).partial(),
	),
});

// Today's parseClaims rules, on structured input: empty names dropped,
// confidence clamped (missing → 0.5), at most three string citations.
export function toClaims(raw: unknown): ResearchClaim[] {
	const parsed = CLAIMS.safeParse(raw);
	if (!parsed.success) throw new Error('research answered without a claims list');
	const out: ResearchClaim[] = [];
	for (const c of parsed.data.claims) {
		if (typeof c.name !== 'string' || !c.name.trim()) continue;
		out.push({
			name: c.name.trim(),
			confidence: Math.min(Math.max(typeof c.confidence === 'number' ? c.confidence : 0.5, 0), 1),
			citations: Array.isArray(c.citations) ? c.citations.filter((u): u is string => typeof u === 'string').slice(0, MAX_CITATIONS) : [],
			...(typeof c.rationale === 'string' && c.rationale.trim() ? { rationale: c.rationale.trim() } : {}),
		});
	}
	return out;
}

const tool = (): WireToolSpec => ({ name: RESEARCH_TOOL, description: 'Record your findings.', parameters: CLAIMS_SCHEMA, annotations: { readOnly: true } });

export function researchPrompt(req: ResearchRequest): { system: string; prompt: string; hash: string } {
	const key = `${req.kind}.${req.aspect}`;
	const pack = PACKS[key];
	if (!pack) throw new Error(`unsupported research aspect: ${key}`);
	const prefix = assemblePrompt({ core: CORE, pack, tools: [tool()] });
	const prompt = [
		`Subject artist: "${req.entity.name}".`,
		`Known facts about this artist (from a DJ library — use them to disambiguate homonyms): ${JSON.stringify(req.entity.knownFacts ?? {})}`,
		'',
		`Research, then call ${RESEARCH_TOOL} with your claims.`,
	].join('\n');
	return { system: prefix.system, prompt, hash: prefix.hash };
}

// The manager slice this port needs (tests pass a fake).
export type ResearchSidecar = Pick<AgentSidecarManager, 'available' | 'configured' | 'research'>;

export class AgentResearchPort implements ResearchPort {
	constructor(
		private readonly sidecar: ResearchSidecar,
		private readonly decisions: DecisionLog,
	) {}

	async research(req: ResearchRequest): Promise<{ claims: ResearchClaim[] }> {
		if (!this.sidecar.available || !this.sidecar.configured) throw new Error(UNAVAILABLE);
		const { system, prompt, hash } = researchPrompt(req);
		const requestId = randomUUID();
		const startedAt = Date.now();
		let result: ResearchResult | null = null;
		let claims: ResearchClaim[] = [];
		try {
			result = await this.sidecar.research({
				requestId,
				system,
				prompt,
				claimsSchema: CLAIMS_SCHEMA,
				limits: { maxSteps: MAX_STEPS, maxToolResultBytes: MAX_TOOL_RESULT_BYTES },
			});
			if (result.stopReason !== 'structured') throw new Error(`research ended without claims (${result.stopReason}${result.errorMessage ? `: ${result.errorMessage}` : ''})`);
			claims = toClaims(result.structured);
			return { claims };
		} finally {
			// The run on the decision log, whatever ended it; logging never fails it.
			try {
				this.decisions.record({
					id: requestId,
					surface: 'research',
					task: `${req.kind}.${req.aspect}`,
					promptHash: hash,
					model: result?.model ?? '',
					subject: req.entity.name,
					startedAt,
					endedAt: Date.now(),
					stopReason: result?.stopReason ?? 'error',
					usage: result?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, steps: 0 },
					costUsd: null,
					toolCalls: [],
					verdict: result ? { claims: claims.length, sources: result.sources.length } : null,
				});
			} catch (err) {
				rlog.warn('decision log write failed', { requestId }, err);
			}
		}
	}
}
