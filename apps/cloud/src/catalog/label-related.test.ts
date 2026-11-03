// One label under two names: retrieval by name, shared releases and roster;
// the review oriented so merge:0 keeps the stronger side; rulings remembered;
// a new label checked when minted. Made-up names.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { listReviews, notSame, ruledNotSame } from './admin.js';
import { agentImport, type AgentRelease } from './agent-import.js';
import { ingestClaims } from './ingest.js';
import { labelCore, plainerLabelName } from './label-names.js';
import { nameRelation, relatedLabels, runLabelDedupe, scanRelatedLabels } from './label-related.js';

const labelClaim = (name: string) => ({ provider: 'user' as const, kind: 'label' as const, providerId: `name:${name.toLowerCase()}`, name });
const rel = (id: number, title: string, artists: string[], date = '2025-03-14'): AgentRelease => ({ title, artists, date, url: `https://www.beatport.com/release/x/${id}` });

async function mint(app: Awaited<ReturnType<typeof createTestApp>>, names: string[]): Promise<Record<string, string>> {
	const r = await withSystemTx(app.db, (tx) => ingestClaims(tx, names.map(labelClaim), { reason: 'library_import' }));
	return Object.fromEntries(names.map((n, i) => [n, r.outcomes[i]!.objectId]));
}

describe('names', () => {
	it('drops the words a label name carries without naming it', () => {
		expect(labelCore('Afterlife Records')).toEqual(['afterlife']);
		expect(labelCore('TRAUM Schallplatten')).toEqual(['traum']);
		expect(labelCore('Music Records')).toEqual(['music', 'records']);
	});
	it('relates names that are equal at their core, or where one begins the other', () => {
		expect(nameRelation('Afterlife', 'Afterlife Records')).toBe('same');
		expect(nameRelation('Renaissance Records', 'Renaissance Music')).toBe('same');
		expect(nameRelation('Steyoyoke', 'Steyoyoke Black')).toBe('contains');
		expect(nameRelation('Mesh', 'Meshuggah Records')).toBeNull();
		expect(nameRelation('A', 'A Records Black')).toBeNull();
	});
	it('keeps the plainer of two names for one label', () => {
		expect(plainerLabelName('Diynamic Music', 'Diynamic')).toBe('Diynamic');
		expect(plainerLabelName('TRAUM Schallplatten', 'Traum')).toBe('Traum');
		expect(plainerLabelName('Afterlife Records', 'Afterlife')).toBe('Afterlife');
		expect(plainerLabelName('Renaissance Music', 'Renaissance Records')).toBe('Renaissance Music');
		expect(plainerLabelName('Kompakt', 'Kompakt Digital')).toBe('Kompakt');
	});
});

describe('related labels', () => {
	it('raises look-alikes by name, shared releases and roster, keeps the stronger side, and remembers a ruling', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const id = await mint(app, ['Northfold', 'Northfold Recordings', 'Northfold Black', 'Saltmarsh', 'Quarry']);
		// The same two releases imported under two names, and under a third
		// label with no name in common; Quarry shares nothing.
		const both = [rel(101, 'Glass Rivers', ['Ivo Lark']), rel(102, 'Drift', ['Ivo Lark', 'Tamsin Ode'])];
		await agentImport(app.db, id['Northfold']!, { source: 'test', releases: both });
		await agentImport(app.db, id['Northfold Recordings']!, { source: 'test', releases: [...both, rel(103, 'Tidewater', ['Ivo Lark'])] });
		await agentImport(app.db, id['Saltmarsh']!, { source: 'test', releases: both });
		await agentImport(app.db, id['Quarry']!, { source: 'test', releases: [rel(201, 'Stone', ['Pell Ward'])] });
		// People follow "Northfold Recordings": it is the side a merge keeps.
		await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: labelClaim('Northfold Recordings'), source: 'manual' });

		const found = await withSystemTx(app.db, (tx) => relatedLabels(tx, id['Northfold']!));
		const by = new Map(found.map((f) => [f.fold, f]));
		expect(by.get(id['Northfold Recordings']!)!.evidence).toMatchObject({ name: 'same', sharedReleases: 2, sharedArtists: 2 });
		expect(by.get(id['Northfold Recordings']!)!.keep).toBe(id['Northfold Recordings']);
		expect(by.get(id['Northfold Black']!)!.evidence).toMatchObject({ name: 'contains', sharedReleases: 0 });
		expect(by.get(id['Saltmarsh']!)!.evidence).toMatchObject({ name: null, sharedReleases: 2 });
		expect(by.has(id['Quarry']!)).toBe(false);
		// The strongest first: the same name with shared releases.
		expect(found[0]!.fold).toBe(id['Northfold Recordings']);

		const ops = adminOps(app.db, {});
		expect(await ops.scan({ kind: 'label', labels: [id['Northfold']!] })).toEqual({ checked: 1, opened: 3 });
		// Asked once: a second scan opens nothing.
		expect((await ops.scan({ kind: 'label', labels: [id['Northfold']!] })).opened).toBe(0);
		const reviews = await withSystemTx(app.db, (tx) => listReviews(tx, { kind: 'duplicate' }));
		// Reachable on their own, newest first, however many artist look-alikes wait.
		const related = await ops.list({ related: true });
		expect(related.map((r) => r.id)).toEqual(reviews.map((r) => r.id).sort((a, b) => b - a));
		const pair = reviews.find((r) => r.candidates[0]!.objectId === id['Northfold'])!;
		// Oriented: the object is the kept side, the candidate the one folded in.
		expect(pair.objectId).toBe(id['Northfold Recordings']);
		// Guy said so in chat (approved): done and logged, not held for the inbox (inbox.test.ts has the held path).
		const d = await ops.decide({ id: pair.id, decision: { action: 'merge', candidate: 0 }, by: 'claude-code', note: 'same label, two names', approved: true });
		expect(d.merge).toMatchObject({ from: id['Northfold'], into: id['Northfold Recordings'] });
		// The kept object takes the plainer name.
		const [kept] = await app.db.query<{ name: string }>(`select name from curator.catalog_object where id = $1`, [id['Northfold Recordings']!]);
		expect(kept!.name).toBe('Northfold');

		// A ruling apart is never raised again, even from the other side.
		await withSystemTx(app.db, (tx) => notSame(tx, id['Northfold Recordings']!, id['Saltmarsh']!, 'test', 'distributor'));
		const again = await withSystemTx(app.db, (tx) => relatedLabels(tx, id['Saltmarsh']!));
		expect(again.map((f) => f.fold)).not.toContain(id['Northfold Recordings']);
		// …until the owner says otherwise: merged, overruling the ruling.
		await expect(ops.labelMerge({ from: id['Saltmarsh']!, into: id['Northfold Recordings']!, note: '' })).rejects.toThrow(/--note/);
		const m = await ops.labelMerge({ from: id['Saltmarsh']!, into: id['Northfold Recordings']!, note: 'owner: one label', approved: true });
		expect(m).toMatchObject({ from: id['Saltmarsh'], into: id['Northfold Recordings'], name: 'Northfold' });
		const [log] = await app.db.query<{ reason: string }>(`select reason from curator.catalog_merge_log where from_id = $1`, [id['Saltmarsh']!]);
		expect(log!.reason).toMatch(/^overruled not-same/);
	});

	it('takes a wrong page off a label and never attaches it again', async () => {
		const app = await createTestApp();
		const id = await mint(app, ['Cobalt Pier']);
		const ops = adminOps(app.db, {});
		// A namesake's SoundCloud, with the release-label edge only it evidenced.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [{ provider: 'soundcloud', kind: 'label', providerId: '592686081', name: 'Cobalt Pier', url: 'https://soundcloud.com/someone-else' }], { reason: 'enrichment' }),
		);
		const [rep] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'soundcloud' and provider_id = '592686081'`);
		// Joined by name or minted: put it on our label either way.
		await app.db.query(`update curator.catalog_source_object set object_id = $1 where provider = 'soundcloud' and provider_id = '592686081'`, [id['Cobalt Pier']!]);
		expect(rep).toBeDefined();
		const r = await ops.labelUnlink({ q: id['Cobalt Pier']!, url: 'https://soundcloud.com/someone-else/', note: 'an artist page, not the label' });
		expect(r).toMatchObject({ provider: 'soundcloud', providerId: '592686081' });
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'soundcloud' and provider_id = '592686081'`)).toEqual([]);
		const ruled = await withSystemTx(app.db, (tx) => ruledNotSame(tx, id['Cobalt Pier']!, { provider: 'soundcloud', providerId: '592686081', name: 'Cobalt Pier' }));
		expect(ruled).toBe(true);
		await expect(ops.labelUnlink({ q: id['Cobalt Pier']!, url: 'https://soundcloud.com/someone-else' })).rejects.toThrow(/no soundcloud page/);
		// Pages no link names (the profiler's Discogs, an archived site): by
		// `provider:id`, or by the URL the label holds; their ids go with them.
		await withSystemTx(app.db, async (tx) => {
			await tx.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'discogs', 'label', '82275', 'https://www.discogs.com/label/82275'), ($1, 'website', 'label', 'web.archive.org', 'http://web.archive.org/web/2011/http://namesake.example/')`, [id['Cobalt Pier']!]);
			await tx.query(`insert into curator.catalog_identifier (namespace, value, object_id) values ('discogs_label', '82275', $1)`, [id['Cobalt Pier']!]);
		});
		expect(await ops.labelUnlink({ q: id['Cobalt Pier']!, url: 'discogs:82275' })).toMatchObject({ provider: 'discogs', identifiers: 1 });
		expect(await ops.labelUnlink({ q: id['Cobalt Pier']!, url: 'http://web.archive.org/web/2011/http://namesake.example' })).toMatchObject({ provider: 'website' });
		expect(await app.db.query(`select provider from curator.catalog_source_object where object_id = $1 and provider <> 'user'`, [id['Cobalt Pier']!])).toEqual([]);
	});

	it('checks a label when it is minted, and again while it is young', async () => {
		const app = await createTestApp();
		const id = await mint(app, ['Cobalt Pier']);
		const tasks = await app.db.query<{ need: string }>(`select need from curator.catalog_enrich_task where object_id = $1 and need = 'dedupe'`, [id['Cobalt Pier']!]);
		expect(tasks).toHaveLength(1);
		// Nothing to compare yet: re-armed for tomorrow, not dropped.
		expect(await runLabelDedupe({ db: app.db })).toEqual({ checked: 1, opened: 0 });
		const [t] = await app.db.query<{ attempts: unknown; later: boolean }>(`select attempts, next_due_at > now() as later from curator.catalog_enrich_task where object_id = $1 and need = 'dedupe'`, [id['Cobalt Pier']!]);
		expect(Number(t!.attempts)).toBe(1);
		expect(t!.later).toBe(true);
		// Its look-alike arrives; the next due check raises the pair.
		const more = await mint(app, ['Cobalt Pier Records']);
		await app.db.query(`update curator.catalog_enrich_task set next_due_at = now() where need = 'dedupe'`);
		const r = await runLabelDedupe({ db: app.db });
		expect(r.checked).toBe(2);
		expect(r.opened).toBe(1);
		const all = await withSystemTx(app.db, (tx) => scanRelatedLabels(tx, { labels: [more['Cobalt Pier Records']!] }));
		expect(all.opened).toBe(0);
	});
});
