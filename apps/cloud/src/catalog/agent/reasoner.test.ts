// The reasoner end to end with a scripted model (made-up names): a twin case
// the detector queues, a "same" that becomes a proposal the operator approves
// into a merge, a "different" ruled apart on the spot, a doubtful verdict
// proposed instead, a bucket id blocked and then read as a name only, a cut
// credit re-credited and remembered so the next claim is joined at ingest,
// a dry run that writes nothing, a spend ceiling that parks the pass, and a
// case made moot by a merge.

import { describe, expect, it } from 'vitest';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../../db/system-tx.js';
import { createTestApp, type TestApp } from '../../test/harness.js';
import { mergeObjects } from '../admin.js';
import { runInboxDetectors } from '../inbox-detectors.js';
import { decideInbox, listInbox, snoozeInbox } from '../inbox.js';
import { ingestClaims } from '../ingest.js';
import { enqueueCase, getCase, listCases } from './cases.js';
import type { AgentReasonerConfig } from './config.js';
import type { ModelAnswer, ModelCall } from './model.js';
import { runAgentReasoner } from './reasoner.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, for: () => quiet } as unknown as Parameters<typeof runAgentReasoner>[0]['log'];
const cfg: AgentReasonerConfig = { backend: 'api', apiKey: 'k', model: 'test-model', confidenceFloor: 0.8, dailyUsd: 2, dailyCalls: 200, batch: 5, searchUsd: 0 };

// A model that answers from a script, one verdict per call, and remembers
// what it was asked.
function scripted(verdicts: unknown[]): ModelCall & { asked: string[] } {
	const fn = (async (req) => {
		fn.asked.push(req.user);
		const verdict = verdicts.shift();
		if (verdict === undefined) throw new Error('model over-called');
		const answer: ModelAnswer = { verdict, stopReason: 'end_turn', declined: false, text: '', model: 'test-model', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 }, costUsd: 0.001 };
		return answer;
	}) as ModelCall & { asked: string[] };
	fn.asked = [];
	return fn;
}

const label: CatalogClaim = { provider: 'user', kind: 'label', providerId: 'name:northfold', name: 'Northfold' };
const artist = (provider: CatalogClaim['provider'], id: string, name: string): CatalogClaim => ({ provider, kind: 'artist', providerId: id, name });
// A release with its label; `date` absent keeps releaseByTitle from joining
// two of one title (no date, no match), which is how twins come to be.
const release = (provider: CatalogClaim['provider'], id: string, title: string, artists: CatalogClaim[], tracks: { id: string; name: string; dur: number }[], date?: string): CatalogClaim => ({
	provider,
	kind: 'release',
	providerId: id,
	name: title,
	facts: { ...(date ? { releaseDate: date } : {}), releaseType: 'single' },
	artists,
	label,
	recordings: tracks.map((t, i) => ({ provider, kind: 'recording', providerId: t.id, name: t.name, facts: { durationSec: t.dur, trackNumber: i + 1 }, artists })),
});

const idOf = async (app: TestApp, provider: string, kind: string, providerId: string) =>
	(await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = $1 and kind = $2 and provider_id = $3`, [provider, kind, providerId]))[0]!.object_id;
const live = async (app: TestApp, kind: string, name: string) => (await app.db.query(`select 1 from curator.catalog_object where kind = $1 and name = $2 and merged_into is null`, [kind, name])).length;
const run = (app: TestApp, model: ModelCall, opts: { dry?: boolean; only?: number; over?: Partial<AgentReasonerConfig> } = {}) =>
	runAgentReasoner({ db: app.db, log: quiet, model, cfg: { ...cfg, ...opts.over }, holder: 'test' }, { dry: opts.dry, only: opts.only });

describe('catalogue reasoner', () => {
	it('queues twin releases as a case when on, proposes a merge for "same", rules "different" apart, and proposes the doubtful', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					release('spotify', 'sp-1', 'Tidal Lines', [artist('spotify', 'sp-lowtide', 'Lowtide')], [{ id: 'sp-t1', name: 'Tidal Lines', dur: 300 }]),
					release('beatport', 'bp-1', 'Tidal Lines', [artist('beatport', 'bp-lowtide', 'Lowtide')], [{ id: 'bp-t1', name: 'Tidal Lines', dur: 300 }]),
					release('spotify', 'sp-2', 'Undertow', [artist('spotify', 'sp-lowtide', 'Lowtide')], [{ id: 'sp-t2', name: 'Undertow', dur: 200 }]),
					release('beatport', 'bp-2', 'Undertow', [artist('beatport', 'bp-lowtide', 'Lowtide')], [{ id: 'bp-t2', name: 'Undertow', dur: 200 }, { id: 'bp-t3', name: 'Undertow (Dub)', dur: 420 }]),
					release('spotify', 'sp-3', 'Halflight', [artist('spotify', 'sp-lowtide', 'Lowtide')], [{ id: 'sp-t4', name: 'Halflight', dur: 250 }]),
					release('beatport', 'bp-3', 'Halflight', [artist('beatport', 'bp-lowtide', 'Lowtide')], [{ id: 'bp-t4', name: 'Halflight', dur: 250 }]),
				],
				{ reason: 'library_import' },
			),
		);
		// The detector, with the reasoner on, queues cases instead of inbox items.
		const d = await runInboxDetectors({ db: app.db, agent: true });
		expect(d.twins).toBe(1);
		expect((await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'release.twins', limit: 10 }))).rows).toHaveLength(0);
		const cases = await withSystemTx(app.db, (tx) => listCases(tx, { status: 'queued' }));
		expect(cases.map((c) => c.kind)).toEqual(['release_twin']);
		const pairs = (cases[0]!.input as { pairs: { keep: string; fold: string }[] }).pairs;
		expect(pairs).toHaveLength(3);
		const byTitle = async (id: string) => (await app.db.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [id]))[0]!.name;
		const verdictFor = async (p: { keep: string; fold: string }) => ({ keep: p.keep, fold: p.fold, verdict: (await byTitle(p.keep)) === 'Tidal Lines' ? 'same' : (await byTitle(p.keep)) === 'Undertow' ? 'different' : 'unsure' });
		const model = scripted([{ pairs: await Promise.all(pairs.map(verdictFor)), confidence: 0.92, rationale: 'Tidal Lines: one track, same length. Undertow: the Beatport copy adds a dub. Halflight: too little to tell.', citations: [] }]);

		const r = await run(app, model);
		expect(r.results.map((x) => x.status)).toEqual(['proposed']);
		expect(model.asked[0]).toContain('Tidal Lines');
		const open = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', limit: 20 }))).rows;
		// "same" and "unsure" are proposals; "different" was done and logged.
		expect(open.map((i) => [i.kind, i.apply?.op]).sort()).toEqual([['agent.proposal', 'mergeReleases'], ['agent.proposal', 'mergeReleases']]);
		const all = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'all', limit: 20 }))).rows;
		const ruled = all.find((i) => i.kind === 'agent.verdict')!;
		expect(ruled.title).toContain('different releases');
		expect(ruled.evidence).toMatchObject({ rationale: expect.stringContaining('Undertow'), confidence: 0.92, model: 'test-model', case: cases[0]!.id });
		expect(await app.db.query(`select 1 from curator.catalog_not_same`)).toHaveLength(1);
		// Approving the "same" proposal merges the twins.
		const same = open.find((i) => !i.title.startsWith('Unsure'))!;
		await withSystemTx(app.db, (tx) => decideInbox(tx, same.id, { action: 'approve', by: 'guy' }));
		expect(await live(app, 'release', 'Tidal Lines')).toBe(1);
		expect(await live(app, 'release', 'Halflight')).toBe(2);
		const done = await withSystemTx(app.db, (tx) => getCase(tx, cases[0]!.id));
		expect(done).toMatchObject({ status: 'proposed', confidence: 0.92, model: 'test-model', costUsd: 0.001 });
		expect(done!.promptHash).toMatch(/^[0-9a-f]{16}$/);
		// Nothing left to do: the next pass finds no case.
		expect((await run(app, scripted([]))).leased).toBe(0);
	});

	it('does not ask again about a pair already before the operator: its own proposal, or a snoozed worker item', async () => {
		const app = await createTestApp();
		const pair = (t: string) => [release('spotify', `sp-${t}`, t, [artist('spotify', 'sp-lowtide', 'Lowtide')], [{ id: `sp-${t}-t`, name: t, dur: 300 }]), release('beatport', `bp-${t}`, t, [artist('beatport', 'bp-lowtide', 'Lowtide')], [{ id: `bp-${t}-t`, name: t, dur: 300 }])];
		await withSystemTx(app.db, (tx) => ingestClaims(tx, pair('Tidal Lines'), { reason: 'library_import' }));
		// Worker item first (reasoner off), snoozed by the operator.
		await runInboxDetectors({ db: app.db, agent: false });
		const item = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'release.twins', limit: 5 }))).rows[0]!;
		await withSystemTx(app.db, (tx) => snoozeInbox(tx, item.id, new Date(Date.now() + 30 * 86_400_000)));
		// Reasoner on: the snoozed pair is not queued.
		expect((await runInboxDetectors({ db: app.db, agent: true })).twins).toBe(0);
		expect(await withSystemTx(app.db, (tx) => listCases(tx, {}))).toHaveLength(0);

		// A new pair: asked once, proposed, and never asked again pass after pass.
		await withSystemTx(app.db, (tx) => ingestClaims(tx, pair('Undertow'), { reason: 'library_import' }));
		expect((await runInboxDetectors({ db: app.db, agent: true })).twins).toBe(1);
		const c = (await withSystemTx(app.db, (tx) => listCases(tx, { status: 'queued' })))[0]!;
		const p = (c.input as { pairs: { keep: string; fold: string }[] }).pairs[0]!;
		await run(app, scripted([{ pairs: [{ ...p, verdict: 'same' }], confidence: 0.9, rationale: 'same', citations: [] }]));
		expect((await withSystemTx(app.db, (tx) => getCase(tx, c.id)))!.status).toBe('proposed');
		for (let i = 0; i < 3; i++) expect((await runInboxDetectors({ db: app.db, agent: true })).twins).toBe(0);
		expect(await withSystemTx(app.db, (tx) => listCases(tx, {}))).toHaveLength(1);
	});

	it('blocks a bucket store id: unlinked, remembered, and read as a name only from then on', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [release('deezer', 'dz-1', 'Drift', [artist('deezer', '81453', 'Supernova')], [{ id: 'dz-t1', name: 'Drift', dur: 300 }], '2026-05-01')], { reason: 'library_import' }),
		);
		const supernova = await idOf(app, 'deezer', 'artist', '81453');
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ ...artist('spotify', 'sp-super', 'Supernova') }], { reason: 'enrichment' }).then(async (o) => mergeObjects(tx, o.outcomes[0]!.objectId, supernova, 'guy', 'test')));
		const id = await withSystemTx(app.db, (tx) => enqueueCase(tx, { kind: 'artist_bucket', subjects: [supernova], input: { artist: supernova, source: { provider: 'deezer', providerId: '81453' } } }));
		const r = await run(app, scripted([{ verdict: 'bucket', confidence: 0.95, rationale: 'releases span unrelated acts', citations: ['https://www.deezer.com/artist/81453'] }]), { only: id! });
		expect(r.results[0]!.status).toBe('applied');
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'deezer' and provider_id = '81453'`)).toHaveLength(0);
		expect(await app.db.query(`select 1 from curator.catalog_source_block where provider = 'deezer' and provider_id = '81453'`)).toHaveLength(1);
		// A later Deezer claim under the blocked id does not bind the artist to it:
		// it joins the namesake on the release as a name and leaves no Deezer id.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [release('deezer', 'dz-2', 'Drift (Remixes)', [artist('deezer', '81453', 'Supernova')], [{ id: 'dz-t2', name: 'Drift (Dub)', dur: 310 }], '2026-06-01')], { reason: 'tracker' }),
		);
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'deezer' and kind = 'artist' and provider_id = '81453'`)).toHaveLength(0);
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'user' and provider_id = 'name:supernova'`)).toHaveLength(1);
		// The undo puts the id back and lifts the block.
		const item = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'all', kind: 'agent.verdict', limit: 5 }))).rows[0]!;
		expect(item.undo?.op).toBe('unblockSource');
	});

	it('queues a bucket case for a store id spread over labels and decades, not for a coherent one, and packs both sides', async () => {
		const app = await createTestApp();
		const on = (provider: CatalogClaim['provider'], id: string, title: string, who: CatalogClaim, labelName: string, date: string): CatalogClaim => ({
			...release(provider, id, title, [who], [{ id: `${id}-t`, name: title, dur: 300 }], date),
			label: { provider: 'user', kind: 'label', providerId: `name:${labelName.toLowerCase()}`, name: labelName },
		});
		// Deezer's "Nova": 14 releases on 8 labels, 1994..2025 — several acts.
		const dz = artist('deezer', 'dz-nova', 'Nova');
		const bucket = Array.from({ length: 14 }, (_, i) => on('deezer', `dz-${i}`, `Bucket Song ${i}`, dz, `Label ${i % 8}`, `${1994 + i * 2}-03-01`));
		// Spotify's Nova: the act itself, six releases Deezer does not hold, on two labels Deezer never shows.
		const sp = artist('spotify', 'sp-nova', 'Nova');
		const real = Array.from({ length: 6 }, (_, i) => on('spotify', `sp-${i}`, `Nova Cut ${i}`, sp, i % 2 ? 'Southfold' : 'Northfold', `2024-0${i + 1}-01`));
		// Beatport's "Calm": 14 releases on two labels in two years — one act.
		const calm = artist('beatport', 'bp-calm', 'Calm');
		const coherent = Array.from({ length: 14 }, (_, i) => on('beatport', `bp-${i}`, `Calm ${i}`, calm, i % 2 ? 'Stillwater' : 'Northfold', `${2024 + (i % 2)}-0${(i % 9) + 1}-01`));
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [...bucket, ...real, ...coherent], { reason: 'library_import' }));
		const [dzNova, spNova] = [await idOf(app, 'deezer', 'artist', 'dz-nova'), await idOf(app, 'spotify', 'artist', 'sp-nova')];
		await withSystemTx(app.db, (tx) => mergeObjects(tx, dzNova, spNova, 'guy', 'test'));

		// Off: no bucket questions (nothing would answer them).
		expect((await runInboxDetectors({ db: app.db, agent: false })).buckets).toBe(0);
		const d = await runInboxDetectors({ db: app.db, agent: true });
		expect(d.buckets).toBe(1);
		const c = (await withSystemTx(app.db, (tx) => listCases(tx, { kind: 'artist_bucket' })))!;
		expect(c).toHaveLength(1);
		// The numbers behind the question ride along: Deezer's 14 releases share nothing with Spotify's 6.
		expect(c[0]!.input).toEqual({ artist: spNova, source: { provider: 'deezer', providerId: 'dz-nova' }, stats: { releases: 14, labels: 8, yearSpan: 26, shared: 0, others: 6, labelsShared: 0, labelsElsewhere: 2 } });
		// Asked once: the next pass does not ask again, whatever the verdict.
		expect((await runInboxDetectors({ db: app.db, agent: true })).buckets).toBe(0);

		const model = scripted([{ verdict: 'unsure', confidence: 0.5, rationale: 'thin', citations: [] }]);
		await run(app, model, { only: c[0]!.id, dry: true });
		const evidence = JSON.parse(model.asked[0]!.split('<evidence>\n')[1]!.split('\n</evidence>')[0]!) as { releasesThroughThisStore: string[]; releasesThroughOtherStoresOnly: string[] };
		expect(evidence.releasesThroughThisStore).toHaveLength(14);
		expect(evidence.releasesThroughThisStore.every((t) => t.startsWith('Bucket Song'))).toBe(true);
		expect(evidence.releasesThroughThisStore.some((t) => t.includes('[Label'))).toBe(true);
		expect(evidence.releasesThroughOtherStoresOnly.sort()).toEqual(real.map((r) => `${r.name} (2024) [${r.label!.name}]`).sort());
	});

	it('re-credits a cut credit on approval and joins the pieces at ingest from then on', async () => {
		const app = await createTestApp();
		const saints = artist('user', 'name:saints', 'Saints');
		const sinners = artist('user', 'name:sinners', 'Sinners');
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ ...release('soundcloud', 'sc-1', 'Peace', [saints, sinners], [{ id: 'sc-t1', name: 'Peace', dur: 400 }], '2026-05-01'), facts: { releaseDate: '2026-05-01', creditText: 'Saints & Sinners' } }], { reason: 'tracker' }));
		const d = await runInboxDetectors({ db: app.db, agent: true });
		expect(d.credits).toBe(1);
		const c = (await withSystemTx(app.db, (tx) => listCases(tx, { kind: 'credit' })))[0]!;
		const r = await run(app, scripted([{ verdict: 'compound', name: 'Saints & Sinners', confidence: 0.9, rationale: 'a known duo; the pieces are not artists', citations: [] }]), { only: c.id });
		expect(r.results[0]!.status).toBe('proposed');
		const item = (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'open', kind: 'agent.proposal', limit: 5 }))).rows[0]!;
		expect(item.apply?.op).toBe('recredit');
		await withSystemTx(app.db, (tx) => decideInbox(tx, item.id, { action: 'approve', by: 'guy' }));
		const credited = await app.db.query<{ name: string }>(
			`select a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.src where e.kind = 'artist-release' and e.dst = $1 order by a.name`,
			[await idOf(app, 'soundcloud', 'release', 'sc-1')],
		);
		expect(credited.map((x) => x.name)).toEqual(['Saints & Sinners']);
		expect(await app.db.query(`select 1 from curator.catalog_credit_rule where kind = 'compound'`)).toHaveLength(1);
		// The rule applies at ingest: another reader's split credit joins the one act.
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [release('bandcamp', 'bc-9', 'Pushin Too Hard', [saints, sinners], [{ id: 'bc-t9', name: 'Pushin Too Hard', dur: 380 }], '2026-07-01')], { reason: 'tracker' }));
		const again = await app.db.query<{ name: string }>(
			`select a.name from curator.catalog_edge e join curator.catalog_object a on a.id = e.src where e.kind = 'artist-release' and e.dst = $1 order by a.name`,
			[await idOf(app, 'bandcamp', 'release', 'bc-9')],
		);
		expect(again.map((x) => x.name)).toEqual(['Saints & Sinners']);
	});

	it('a dry run writes nothing, a spend ceiling parks the pass, and a merged subject makes a case moot', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					release('spotify', 'sp-1', 'Ember', [artist('spotify', 'sp-abel', 'Abel')], [{ id: 'sp-t1', name: 'Ember', dur: 300 }]),
					release('beatport', 'bp-1', 'Ember', [artist('beatport', 'bp-abel', 'Abel')], [{ id: 'bp-t1', name: 'Ember', dur: 300 }]),
				],
				{ reason: 'library_import' },
			),
		);
		const [keep, fold] = [await idOf(app, 'spotify', 'release', 'sp-1'), await idOf(app, 'beatport', 'release', 'bp-1')];
		const labelId = await idOf(app, 'user', 'label', 'name:northfold');
		const id = await withSystemTx(app.db, (tx) => enqueueCase(tx, { kind: 'release_twin', subjects: [keep, fold], input: { pairs: [{ keep, fold }], label: { id: labelId, name: 'Northfold' } } }));
		const verdict = { pairs: [{ keep, fold, verdict: 'same' }], confidence: 0.9, rationale: 'same track, same length', citations: [] };
		const dry = await run(app, scripted([verdict]), { dry: true });
		expect(dry.results[0]).toMatchObject({ status: 'queued', verdict: { confidence: 0.9 } });
		expect((await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'all', limit: 10 }))).rows).toHaveLength(0);
		expect((await withSystemTx(app.db, (tx) => getCase(tx, id!)))!.status).toBe('queued');
		// The ceiling: nothing runs, the case goes back to the queue.
		const parked = await run(app, scripted([verdict]), { over: { dailyUsd: 0 } });
		expect(parked.parked).toContain('ceiling');
		expect(parked.results).toHaveLength(0);
		expect((await withSystemTx(app.db, (tx) => getCase(tx, id!)))!.status).toBe('queued');
		// Merged by hand meanwhile: the case is moot, the model never asked.
		await withSystemTx(app.db, (tx) => mergeObjects(tx, fold, keep, 'guy', 'test'));
		const model = scripted([verdict]);
		const r = await run(app, model);
		expect(r.moot).toBe(1);
		expect(model.asked).toHaveLength(0);
		expect((await withSystemTx(app.db, (tx) => getCase(tx, id!)))!.status).toBe('moot');
	});
});
