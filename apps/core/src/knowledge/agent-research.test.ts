// Research on the agent sidecar, against a fake sidecar: the request it
// sends (prompt, terminal-tool schema, limits), claims cleaned the way the
// old researcher did, the unconfigured state, a run that ends without
// claims, and a decision-log row for every run.

import { describe, expect, it } from 'vitest';
import type { DecisionRecord, ResearchParams, ResearchResult } from '@curator/agent-core';
import { AgentResearchPort, toClaims, UNAVAILABLE, type ResearchSidecar } from './agent-research.js';

const REQ = { kind: 'artist', aspect: 'similar-artists', entity: { name: 'Lowtide', knownFacts: { labels: ['Northfold'] } } };
const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, steps: 3 };

function fake(answer: Partial<ResearchResult> | Error, state = { available: true, configured: true }): ResearchSidecar & { asked: ResearchParams[] } {
	const asked: ResearchParams[] = [];
	return {
		asked,
		get available() { return state.available; },
		get configured() { return state.configured; },
		async research(params: ResearchParams): Promise<ResearchResult> {
			asked.push(params);
			if (answer instanceof Error) throw answer;
			return { requestId: params.requestId, stopReason: 'structured', structured: null, usage: USAGE, model: 'research-model', sources: [], ...answer };
		},
	} as ResearchSidecar & { asked: ResearchParams[] };
}

const log = () => {
	const rows: DecisionRecord[] = [];
	return { rows, record: (d: DecisionRecord) => void rows.push(d), outcome: () => {} };
};

describe('research on the agent sidecar', () => {
	it('asks with the prompt and claims schema, cleans the claims, and logs the run', async () => {
		const sidecar = fake({
			structured: {
				claims: [
					{ name: '  Undertow  ', confidence: 1.4, citations: ['https://a', 'https://b', 'https://c', 'https://d', 7], rationale: 'both on Northfold' },
					{ name: '', confidence: 0.9, citations: [], rationale: null },
					{ name: 'Halflight', confidence: 'high', citations: null, rationale: null },
				],
			},
			sources: [{ url: 'https://a' }],
		});
		const decisions = log();
		const r = await new AgentResearchPort(sidecar, decisions).research(REQ);
		expect(r.claims).toEqual([
			{ name: 'Undertow', confidence: 1, citations: ['https://a', 'https://b', 'https://c'], rationale: 'both on Northfold' },
			{ name: 'Halflight', confidence: 0.5, citations: [] },
		]);
		const p = sidecar.asked[0]!;
		expect(p.prompt).toContain('"Lowtide"');
		expect(p.prompt).toContain('Northfold');
		expect(p.system).toContain('record_claims');
		expect((p.claimsSchema as { required: string[] }).required).toEqual(['claims']);
		expect(p.limits.maxSteps).toBeGreaterThan(0);
		expect(decisions.rows).toHaveLength(1);
		expect(decisions.rows[0]).toMatchObject({ id: p.requestId, surface: 'research', task: 'artist.similar-artists', subject: 'Lowtide', model: 'research-model', stopReason: 'structured', verdict: { claims: 2, sources: 1 } });
		expect(decisions.rows[0]!.promptHash).toMatch(/^[0-9a-f]{16}$/);
	});

	it('rejects while the assistant is unconfigured or the sidecar is down, without calling it', async () => {
		for (const state of [{ available: true, configured: false }, { available: false, configured: true }]) {
			const sidecar = fake({}, state);
			await expect(new AgentResearchPort(sidecar, log()).research(REQ)).rejects.toThrow(UNAVAILABLE);
			expect(sidecar.asked).toHaveLength(0);
		}
	});

	it('fails a run that ends without claims, and still logs it', async () => {
		const decisions = log();
		await expect(new AgentResearchPort(fake({ stopReason: 'max-steps' }), decisions).research(REQ)).rejects.toThrow(/without claims \(max-steps\)/);
		expect(decisions.rows[0]).toMatchObject({ stopReason: 'max-steps', verdict: { claims: 0, sources: 0 } });
		const crashed = log();
		await expect(new AgentResearchPort(fake(new Error('agent research timed out after 180s')), crashed).research(REQ)).rejects.toThrow(/timed out/);
		expect(crashed.rows[0]).toMatchObject({ stopReason: 'error', verdict: null });
	});

	it('refuses an aspect it has no prompt for', async () => {
		await expect(new AgentResearchPort(fake({}), log()).research({ ...REQ, aspect: 'releases' })).rejects.toThrow(/unsupported research aspect/);
	});

	it('treats an answer without a claims list as a failure', () => {
		expect(() => toClaims({ nope: true })).toThrow(/without a claims list/);
	});
});
