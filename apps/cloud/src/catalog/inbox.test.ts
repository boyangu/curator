// The operator's inbox: what the policy holds, surfaces or logs; a held merge
// applied or discarded; a done action undone; an escalated review decided
// with the operator's choice; the same question once; a failed apply left
// open with its error. Made-up names.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { getReview, listReviews, ruledNotSame } from './admin.js';
import { agentImport, type AgentRelease } from './agent-import.js';
import { ingestClaims } from './ingest.js';
import { mergePolicy, reversiblePolicy, type ObjectFacts } from './inbox-policy.js';
import { raise } from './inbox.js';

const labelClaim = (name: string) => ({ provider: 'user' as const, kind: 'label' as const, providerId: `name:${name.toLowerCase()}`, name });
const rel = (id: number, title: string, artists: string[], date = '2025-03-14'): AgentRelease => ({ title, artists, date, url: `https://www.beatport.com/release/x/${id}` });
type App = Awaited<ReturnType<typeof createTestApp>>;

async function mint(app: App, names: string[]): Promise<Record<string, string>> {
	const r = await withSystemTx(app.db, (tx) => ingestClaims(tx, names.map(labelClaim), { reason: 'library_import' }));
	return Object.fromEntries(names.map((n, i) => [n, r.outcomes[i]!.objectId]));
}
// Two labels holding the same releases, the second followed: a pair the
// related-label scan raises and the policy holds.
async function lookalikes(app: App, a: string, b: string): Promise<{ id: Record<string, string>; reviewId: number }> {
	const fan = await app.signIn();
	const id = await mint(app, [a, b]);
	const both = [rel(101, 'Glass Rivers', ['Ivo Lark']), rel(102, 'Drift', ['Ivo Lark', 'Tamsin Ode'])];
	await agentImport(app.db, id[a]!, { source: 'test', releases: both });
	await agentImport(app.db, id[b]!, { source: 'test', releases: both });
	await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: labelClaim(b), source: 'manual' });
	const ops = adminOps(app.db, {});
	await ops.scan({ kind: 'label', labels: [id[a]!] });
	const [review] = await withSystemTx(app.db, (tx) => listReviews(tx, { related: true }));
	return { id, reviewId: review!.id };
}
const merged = async (app: App, id: string) => (await app.db.query<{ merged_into: string | null }>(`select merged_into from curator.catalog_object where id = $1`, [id]))[0]!.merged_into;
const facts = (over: Partial<ObjectFacts> = {}): ObjectFacts => ({ id: 'x', kind: 'label', name: 'X', watchers: 0, inLibrary: false, releases: 0, ...over });

describe('policy', () => {
	it('holds merges that matter, surfaces reversible actions on followed labels, logs the rest and whatever was approved in chat', () => {
		expect(mergePolicy(facts(), facts())).toBe('notice');
		expect(mergePolicy(facts({ watchers: 1 }), facts())).toBe('approval');
		expect(mergePolicy(facts(), facts({ inLibrary: true }))).toBe('approval');
		expect(mergePolicy(facts({ releases: 20 }), facts())).toBe('approval');
		expect(mergePolicy(facts(), facts(), { overruling: true })).toBe('approval');
		expect(mergePolicy(facts({ watchers: 1 }), facts(), { approved: true })).toBe('audit');
		expect(reversiblePolicy(facts({ watchers: 1 }))).toBe('notice');
		expect(reversiblePolicy(facts({ inLibrary: true }))).toBe('notice');
		expect(reversiblePolicy(facts())).toBe('audit');
		expect(reversiblePolicy(facts({ watchers: 1 }), { approved: true })).toBe('audit');
	});
});

describe('inbox', () => {
	it('holds a merge the agent decides on a followed label until the operator approves, then runs it as decided', async () => {
		const app = await createTestApp();
		const { id, reviewId } = await lookalikes(app, 'Northfold', 'Northfold Recordings');
		const ops = adminOps(app.db, {});
		const d = await ops.decide({ id: reviewId, decision: { action: 'merge', candidate: 0 }, by: 'claude-code', note: 'one label' });
		expect(d.review.status).toBe('held');
		expect(d.held).toEqual(expect.any(Number));
		expect(d.merge).toBeUndefined();
		expect(await merged(app, id['Northfold']!)).toBeNull();
		// Out of the agent's queue, and not the agent's to decide again.
		expect(await withSystemTx(app.db, (tx) => listReviews(tx, { related: true }))).toEqual([]);
		await expect(ops.decide({ id: reviewId, decision: { action: 'not_same', candidate: 0 }, by: 'claude-code' })).rejects.toThrow(/held/);
		expect(await ops.inboxCounts({})).toEqual({ approval: 1, notice: 0, snoozed: 0 });
		const { rows } = await ops.inboxList({ status: 'open', severity: 'approval' });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ id: d.held, kind: 'review.merge', actor: 'claude-code', reviewId, apply: { op: 'decideReview' }, subjectNames: [{ name: 'Northfold Recordings' }, { name: 'Northfold' }] });
		expect(rows[0]!.title).toBe('Merge «Northfold» into «Northfold Recordings»');
		const done = await ops.inboxDecide({ id: d.held!, action: 'approve', note: 'yes' });
		expect(done).toMatchObject({ status: 'approved', resolution: 'applied', resolvedBy: 'guy', note: 'yes' });
		const review = await withSystemTx(app.db, (tx) => getReview(tx, reviewId));
		expect(review).toMatchObject({ status: 'decided', decidedBy: 'claude-code', note: 'one label' });
		expect(await merged(app, id['Northfold']!)).toBe(id['Northfold Recordings']);
		expect(await ops.inboxCounts({})).toEqual({ approval: 0, notice: 0, snoozed: 0 });
	});

	it('a rejected merge rules the pair apart; an escalated review waits for the operator\'s choice', async () => {
		const app = await createTestApp();
		const { id, reviewId } = await lookalikes(app, 'Cobalt Pier', 'Cobalt Pier Records');
		const ops = adminOps(app.db, {});
		const d = await ops.decide({ id: reviewId, decision: { action: 'merge', candidate: 0 }, by: 'claude-code', note: 'one label' });
		await ops.inboxDecide({ id: d.held!, action: 'reject', note: 'an imprint, not the label' });
		const review = await withSystemTx(app.db, (tx) => getReview(tx, reviewId));
		expect(review).toMatchObject({ status: 'decided', decidedBy: 'guy', decision: { action: 'not_same', candidate: 0 }, note: 'an imprint, not the label' });
		expect(await withSystemTx(app.db, (tx) => ruledNotSame(tx, id['Cobalt Pier']!, { objectId: id['Cobalt Pier Records'], name: '' }))).toBe(true);

		// The agent skips: escalated, with the candidates for the operator to pick from.
		const { reviewId: second } = await lookalikes(app, 'Saltmarsh', 'Saltmarsh Music');
		const s = await ops.decide({ id: second, decision: { action: 'skip' }, by: 'claude-code', note: 'thin' });
		expect(s.review.status).toBe('escalated');
		const { rows } = await ops.inboxList({ status: 'open', kind: 'review.escalated' });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.evidence).toMatchObject({ review: second, note: 'thin' });
		// Without a choice the apply cannot run: the item stays open and says why.
		await expect(ops.inboxDecide({ id: rows[0]!.id, action: 'approve' })).rejects.toThrow(/choice/);
		expect((await ops.inboxGet({ id: rows[0]!.id }))).toMatchObject({ status: 'open', lastError: expect.stringMatching(/choice/) });
		const done = await ops.inboxDecide({ id: rows[0]!.id, action: 'approve', choice: { action: 'not_same', candidate: 0 }, note: 'different acts' });
		expect(done).toMatchObject({ status: 'approved', resolution: 'applied', lastError: null });
		expect(await withSystemTx(app.db, (tx) => getReview(tx, second))).toMatchObject({ status: 'decided', decidedBy: 'guy', decision: { action: 'not_same', candidate: 0 } });
		// A skip by the operator closes a review for good.
		const { reviewId: third } = await lookalikes(app, 'Quarry', 'Quarry Records');
		await ops.decide({ id: third, decision: { action: 'skip' }, by: 'claude-code' });
		const [esc] = (await ops.inboxList({ status: 'open', kind: 'review.escalated' })).rows;
		await ops.inboxDecide({ id: esc!.id, action: 'reject', note: 'leave it' });
		expect(await withSystemTx(app.db, (tx) => getReview(tx, third))).toMatchObject({ status: 'decided', decidedBy: 'guy', decision: { action: 'skip' } });
	});

	it('surfaces reversible actions on a followed label with an undo, logs them on one nobody follows', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const id = await mint(app, ['Marram']);
		await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: labelClaim('Marram'), source: 'manual' });
		// A label only a store knows: nobody follows it, no library names it.
		const shelf = await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ provider: 'beatport', kind: 'label', providerId: '9001', name: 'Quiet Shelf', url: 'https://www.beatport.com/label/quiet-shelf/9001' }], { reason: 'tracker' }));
		id['Quiet Shelf'] = shelf.outcomes[0]!.objectId;
		const ops = adminOps(app.db, {});
		// A page linked, then undone: gone again, and ruled not the label's.
		await ops.labelLink({ q: id['Marram']!, url: 'https://www.beatport.com/label/marram/804' });
		let [item] = (await ops.inboxList({ status: 'open', severity: 'notice' })).rows;
		expect(item).toMatchObject({ kind: 'label.link', undo: { op: 'unlinkPage' } });
		await ops.inboxDecide({ id: item!.id, action: 'reject', note: 'a namesake' });
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'beatport' and provider_id = '804'`)).toEqual([]);
		expect(await withSystemTx(app.db, (tx) => ruledNotSame(tx, id['Marram']!, { provider: 'beatport', providerId: '804', name: 'Marram' }))).toBe(true);
		// A rename undone.
		await ops.labelRename({ q: id['Marram']!, name: 'Marram Records' });
		[item] = (await ops.inboxList({ status: 'open', severity: 'notice' })).rows;
		expect(item).toMatchObject({ kind: 'label.rename', title: 'Renamed «Marram» to «Marram Records»' });
		await ops.inboxDecide({ id: item!.id, action: 'reject' });
		expect((await app.db.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [id['Marram']!]))[0]!.name).toBe('Marram');
		// An unlink undone: the page is back with its id, and the ruling gone.
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ provider: 'discogs', kind: 'label', providerId: '82275', name: 'Marram', url: 'https://www.discogs.com/label/82275', identifiers: [{ namespace: 'discogs_label', value: '82275' }] }], { reason: 'enrichment' }));
		await app.db.query(`update curator.catalog_source_object set object_id = $1 where provider = 'discogs' and provider_id = '82275'`, [id['Marram']!]);
		await app.db.query(`update curator.catalog_identifier set object_id = $1 where namespace = 'discogs_label' and value = '82275'`, [id['Marram']!]);
		await ops.labelUnlink({ q: id['Marram']!, url: 'discogs:82275', note: 'wrong' });
		[item] = (await ops.inboxList({ status: 'open', severity: 'notice' })).rows;
		expect(item).toMatchObject({ kind: 'label.unlink', undo: { op: 'relinkPage' } });
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'discogs' and provider_id = '82275'`)).toEqual([]);
		await ops.inboxDecide({ id: item!.id, action: 'reject', note: 'it was right' });
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'discogs' and provider_id = '82275' and object_id = $1`, [id['Marram']!])).toHaveLength(1);
		expect(await app.db.query(`select 1 from curator.catalog_identifier where namespace = 'discogs_label' and value = '82275' and object_id = $1`, [id['Marram']!])).toHaveLength(1);
		expect(await withSystemTx(app.db, (tx) => ruledNotSame(tx, id['Marram']!, { provider: 'discogs', providerId: '82275', name: 'Marram' }))).toBe(false);
		// Acknowledged, not undone.
		await ops.labelRename({ q: id['Marram']!, name: 'Marram Recordings' });
		[item] = (await ops.inboxList({ status: 'open', severity: 'notice' })).rows;
		expect(await ops.inboxDecide({ id: item!.id, action: 'approve' })).toMatchObject({ status: 'approved', resolution: 'acknowledged' });
		// Nobody follows Quiet Shelf: logged, no question asked.
		await ops.labelRename({ q: id['Quiet Shelf']!, name: 'Quiet Shelf Records' });
		expect(await ops.inboxCounts({})).toEqual({ approval: 0, notice: 0, snoozed: 0 });
		const all = await ops.inboxList({ status: 'all', kind: 'label.rename' });
		expect(all.rows[0]).toMatchObject({ status: 'logged', severity: 'audit', title: 'Renamed «Quiet Shelf» to «Quiet Shelf Records»' });
	});

	it('a merge on the owner\'s word is held unless approved in chat, asked once, snoozable; a failed apply stays open with its error', async () => {
		const app = await createTestApp();
		const id = await mint(app, ['Harbour Light', 'Harbour Light Records', 'Tern', 'Tern Music']);
		const ops = adminOps(app.db, {});
		const h = await ops.labelMerge({ from: id['Harbour Light Records']!, into: id['Harbour Light']!, note: 'owner: one label' });
		expect(h.held).toEqual(expect.any(Number));
		expect(h.moved).toBeUndefined();
		// The same pair again waits where it is.
		expect((await ops.labelMerge({ from: id['Harbour Light Records']!, into: id['Harbour Light']!, note: 'again' })).held).toBeNull();
		expect((await ops.inboxList({ status: 'open' })).total).toBe(1);
		await ops.inboxSnooze({ id: h.held!, days: 7 });
		expect((await ops.inboxList({ status: 'open' })).total).toBe(0);
		expect(await ops.inboxCounts({})).toEqual({ approval: 0, notice: 0, snoozed: 1 });
		expect((await ops.inboxList({ status: 'snoozed' })).rows[0]!.id).toBe(h.held);
		await ops.inboxSnooze({ id: h.held!, days: 0 });
		expect((await ops.inboxList({ status: 'open' })).total).toBe(1);
		await ops.inboxDecide({ id: h.held!, action: 'approve' });
		expect(await merged(app, id['Harbour Light Records']!)).toBe(id['Harbour Light']);
		// Said yes in chat: done now, logged with who said so.
		const a = await ops.labelMerge({ from: id['Tern Music']!, into: id['Tern']!, note: 'Guy: one label', approved: true });
		expect(a.moved).toBeDefined();
		expect(await merged(app, id['Tern Music']!)).toBe(id['Tern']);
		const log = (await ops.inboxList({ status: 'all', kind: 'label.merge' })).rows;
		expect(log.find((r) => r.status === 'logged')).toMatchObject({ severity: 'audit', approvedBy: 'guy', actor: 'claude-code' });
		// An apply the inbox cannot run leaves the item open and says why.
		const bad = await withSystemTx(app.db, (tx) => raise(tx, { kind: 'test.bad', severity: 'approval', title: 'cannot', subjects: [], apply: { op: 'nope', args: {} }, actor: 'test' }));
		await expect(ops.inboxDecide({ id: bad!, action: 'approve' })).rejects.toThrow(/no apply for nope/);
		expect(await ops.inboxGet({ id: bad! })).toMatchObject({ status: 'open', lastError: expect.stringMatching(/nope/) });
	});
});
