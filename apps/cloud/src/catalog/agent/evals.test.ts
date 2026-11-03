// The regression set export (made-up names): the operator's twin decisions
// come out as replayable cases — an approval with an exception labels its
// pairs same / different, a rejection labels them all different, a reasoner
// proposal replays from the pack its case stored, and the views an item kept
// still read after the merge took the pair away.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../../db/system-tx.js';
import { createTestApp, type TestApp } from '../../test/harness.js';
import { runInboxDetectors } from '../inbox-detectors.js';
import { decideInbox, listInbox } from '../inbox.js';
import { ingestClaims } from '../ingest.js';
import type { AgentReasonerConfig } from './config.js';
import { exceptedPairs, exportEvalCases } from './evals.js';
import type { ModelAnswer, ModelCall } from './model.js';
import { renderPack } from './pack.js';
import { runAgentReasoner } from './reasoner.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, for: () => quiet } as unknown as Parameters<typeof runAgentReasoner>[0]['log'];
const cfg: AgentReasonerConfig = { backend: 'api', apiKey: 'k', model: 'test-model', confidenceFloor: 0.8, dailyUsd: 2, dailyCalls: 200, batch: 5, searchUsd: 0 };

const label: CatalogClaim = { provider: 'user', kind: 'label', providerId: 'name:northfold', name: 'Northfold' };
const artist = (provider: CatalogClaim['provider'], id: string): CatalogClaim => ({ provider, kind: 'artist', providerId: id, name: 'Lowtide' });
const release = (provider: CatalogClaim['provider'], id: string, title: string, tracks: number): CatalogClaim => ({
	provider,
	kind: 'release',
	providerId: id,
	name: title,
	facts: { releaseType: 'single' },
	artists: [artist(provider, `${provider}-lowtide`)],
	label,
	recordings: Array.from({ length: tracks }, (_, i) => ({ provider, kind: 'recording' as const, providerId: `${id}-t${i}`, name: i ? `${title} (Dub)` : title, facts: { durationSec: 300 + i, trackNumber: i + 1 }, artists: [artist(provider, `${provider}-lowtide`)] })),
});

async function twins(app: TestApp, titles: string[]): Promise<void> {
	await withSystemTx(app.db, (tx) =>
		ingestClaims(tx, titles.flatMap((t, i) => [release('spotify', `sp-${t}`, t, 1), release('beatport', `bp-${t}`, t, i === 1 ? 2 : 1)]), { reason: 'library_import' }),
	);
}

describe('regression set export', () => {
	it('reads exceptions out of the resolution text', () => {
		expect([...exceptedPairs('applied except pair 1 (not twins)')]).toEqual([1]);
		expect([...exceptedPairs('applied except pairs 1, 16 (not twins)')]).toEqual([1, 16]);
		expect(exceptedPairs('applied').size).toBe(0);
	});

	it('labels an approval with an exception, a rejection, and keeps the pair after the merge', async () => {
		const app = await createTestApp();
		await twins(app, ['Tidal Lines', 'Undertow', 'Halflight']);
		await runInboxDetectors({ db: app.db, agent: false });
		const item = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'release.twins', limit: 5 }))).rows[0]!;
		const pairs = item.evidence.pairs as { keep: { title: string } }[];
		const undertow = pairs.findIndex((p) => p.keep.title === 'Undertow');
		await withSystemTx(app.db, (tx) => decideInbox(tx, item.id, { action: 'approve', by: 'guy', except: [undertow] }));

		const { cases } = await withSystemTx(app.db, (tx) => exportEvalCases(tx));
		expect(cases).toHaveLength(1);
		const c = cases[0]!;
		expect(c).toMatchObject({ kind: 'release_twin', inbox: item.id, by: 'guy', packSource: 'snapshot', modelSaid: null });
		expect(c.expected).toEqual(pairs.map((_, i) => (i === undertow ? 'different' : 'same')));
		// The merged pairs still read as two releases, from the item's views.
		const user = renderPack(c.pack);
		expect(user).toContain('«Northfold»');
		expect(user).toContain('inbox snapshot');
		expect((c.pack.evidence.pairs as unknown[]).length).toBe(3);

		// A later rejection: every pair different.
		await twins(app, ['Ember']);
		await runInboxDetectors({ db: app.db, agent: false });
		const next = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'release.twins', limit: 5 }))).rows[0]!;
		await withSystemTx(app.db, (tx) => decideInbox(tx, next.id, { action: 'reject', by: 'guy' }));
		const again = await withSystemTx(app.db, (tx) => exportEvalCases(tx));
		expect(again.cases.map((x) => x.expected)).toEqual([c.expected, ['different']]);
	});

	it('replays a reasoner proposal from the pack its case stored, with what the model said', async () => {
		const app = await createTestApp();
		await twins(app, ['Tidal Lines', 'Halflight']);
		await runInboxDetectors({ db: app.db, agent: true });
		const model: ModelCall = async (req) => {
			const ids = [...req.user.matchAll(/"id": "([0-9a-f-]{36})",\n\s*"kind": "release"/g)].map((m) => m[1]!);
			const answer: ModelAnswer = {
				verdict: { pairs: [{ keep: ids[0]!, fold: ids[1]!, verdict: 'same' }, { keep: ids[2]!, fold: ids[3]!, verdict: 'same' }], confidence: 0.9, rationale: 'one track each, same length', citations: [] },
				stopReason: 'end_turn',
				declined: false,
				text: '',
				model: 'test-model',
				usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 },
				costUsd: 0,
			};
			return answer;
		};
		const r = await runAgentReasoner({ db: app.db, log: quiet, model, cfg, holder: 'test' });
		expect(r.results[0]!.status).toBe('proposed');
		const item = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'agent.proposal', limit: 5 }))).rows[0]!;
		// The page's table reads these views; the per-pair answers sit beside them.
		expect((item.evidence.pairs as { keep: { title: string } }[]).map((p) => p.keep.title).sort()).toEqual(['Halflight', 'Tidal Lines']);
		expect(item.evidence.verdicts).toEqual(['same', 'same']);
		// Guy merges one, rules the other apart: a correction of the model.
		await withSystemTx(app.db, (tx) => decideInbox(tx, item.id, { action: 'approve', by: 'guy', except: [1] }));
		const { cases } = await withSystemTx(app.db, (tx) => exportEvalCases(tx));
		expect(cases).toHaveLength(1);
		expect(cases[0]).toMatchObject({ packSource: 'case', expected: ['same', 'different'], modelSaid: ['same', 'same'] });
		expect(renderPack(cases[0]!.pack)).toContain('tracks');
	});
});
