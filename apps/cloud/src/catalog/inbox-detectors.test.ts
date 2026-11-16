// What the worker puts to the operator on its own: twin releases proposed for
// a merge, a dead page proposed for an unlink, a failing tracker and a parked
// provider noticed — and each cleared once its condition is gone. Made-up names.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import type { FetchLike } from '@curator/catalog-readers';
import { mergeObjects } from './admin.js';
import { adminOps } from './admin-ops.js';
import { bucketCandidates, runInboxDetectors, titleKeys, twinGroups } from './inbox-detectors.js';
import { ingestClaims, linkReleasesToLabel } from './ingest.js';

const labelClaim = (name: string) => ({ provider: 'user' as const, kind: 'label' as const, providerId: `name:${name.toLowerCase()}`, name });
const release = (provider: 'spotify' | 'deezer', id: string, title: string, artists: string[], date: string, tracks = 0) => ({
	provider,
	kind: 'release' as const,
	providerId: id,
	name: title,
	facts: { releaseDate: date },
	artists: artists.map((name) => ({ provider, kind: 'artist' as const, providerId: `${provider}-${name.toLowerCase().replace(/\W+/g, '-')}`, name })),
	recordings: Array.from({ length: tracks }, (_, i) => ({ provider, kind: 'recording' as const, providerId: `${id}-t${i + 1}`, name: `${title} ${i + 1}` })),
});
const twin = (id: string, over: Partial<{ title: string; artists: string[]; date: string | null; providers: string[]; tracks: number; discoveredMs: number }> = {}) => ({ id, title: 'Glass Rivers', artists: ['Ivo Lark'], date: '2026-03-01', providers: ['spotify'], tracks: 0, discoveredMs: 1, ...over });

describe('twin groups', () => {
	it('clusters same-title releases that share an artist within the date gap, keeping the best-held copy', () => {
		const g = twinGroups([twin('a', { providers: ['spotify', 'deezer'] }), twin('b', { artists: ['Ivo Lark', 'Tamsin Ode'], date: '2026-03-06' }), twin('c', { artists: ['Someone Else'] }), twin('d', { date: '2026-06-01' })], new Set());
		expect(g).toHaveLength(1);
		expect(g[0]!.keep.id).toBe('a');
		expect(g[0]!.folds.map((f) => f.id)).toEqual(['b']);
		// A pair ruled apart stays apart.
		expect(twinGroups([twin('a'), twin('b')], new Set(['a|b']))).toEqual([]);
	});

	it('a duo one store credits as one act and another as two people is one release', () => {
		const g = twinGroups([twin('a', { artists: ['Frankey & Sandrino'], providers: ['bandcamp'] }), twin('b', { artists: ['Frankey', 'Sandrino', 'Premiere: Jepe'], providers: ['beatport', 'spotify'] })], new Set());
		expect(g).toHaveLength(1);
		expect(g[0]!.keep.id).toBe('b');
		expect(g[0]!.folds.map((f) => f.id)).toEqual(['a']);
		// A different act on a same-titled release stays apart.
		expect(twinGroups([twin('a', { artists: ['Frankey & Sandrino'] }), twin('b', { artists: ['Someone & Else'] })], new Set())).toEqual([]);
	});
});

describe('page overlap', () => {
	it('reads a title in the forms stores write it, so a page of unjoined copies is not a namesake', () => {
		// 2026-10-29: Magician On Duty's Bandcamp ("Dnl Mike - My Heart [Magician On Duty]")
		// against "My Heart [Magician On Duty]" elsewhere was raised as a namesake page.
		const here = titleKeys('Dnl Mike - My Heart [Magician On Duty]');
		expect(titleKeys('My Heart [Magician On Duty]').some((k) => here.includes(k))).toBe(true);
		expect(titleKeys('My Heart').some((k) => here.includes(k))).toBe(true);
		expect(titleKeys('Lost My Shadow - DRMZ Remix')).toContain('lost my shadow drmz remix');
	});
});

describe('detectors', () => {
	it('proposes merging twin releases, and clears the item once they are merged or ruled apart', async () => {
		const app = await createTestApp();
		const [label] = (await withSystemTx(app.db, (tx) => ingestClaims(tx, [labelClaim('Northfold')], { reason: 'library_import' }))).outcomes;
		// Two stores' copies the title rule did not join: the credits differ and
		// the dates are five days apart.
		const claims = [release('spotify', 's1', 'Glass Rivers', ['Ivo Lark'], '2026-03-01', 2), release('deezer', 'd1', 'Glass Rivers', ['Ivo Lark', 'Tamsin Ode'], '2026-03-06'), release('deezer', 'd2', 'Drift', ['Ivo Lark'], '2026-03-06')];
		const r = await withSystemTx(app.db, async (tx) => {
			const out = await ingestClaims(tx, claims, { reason: 'tracker' });
			await linkReleasesToLabel(tx, label!.objectId, out.outcomes.map((o, i) => ({ objectId: o.objectId, claim: claims[i]! })));
			return out;
		});
		expect(new Set(r.outcomes.map((o) => o.objectId)).size).toBe(3);
		expect(await runInboxDetectors({ db: app.db })).toMatchObject({ twins: 1, pages: 0, trackers: 0 });
		const ops = adminOps(app.db, {});
		const [item] = (await ops.inboxList({ status: 'open', kind: 'release.twins' })).rows;
		expect(item).toMatchObject({ severity: 'approval', actor: 'worker', subjectNames: [{ name: 'Northfold' }], apply: { op: 'mergeReleases' } });
		const pairs = item!.evidence.pairs as { keep: { id: string; providers: string[] }; fold: { id: string } }[];
		expect(pairs).toHaveLength(1);
		expect(pairs[0]!.keep.id).toBe(r.outcomes[0]!.objectId);
		// Asked once.
		expect((await runInboxDetectors({ db: app.db })).twins).toBe(0);
		await ops.inboxDecide({ id: item!.id, action: 'approve' });
		const [folded] = await app.db.query<{ merged_into: string | null }>(`select merged_into from curator.catalog_object where id = $1`, [r.outcomes[1]!.objectId]);
		expect(folded!.merged_into).toBe(r.outcomes[0]!.objectId);
		// Another twin, dismissed: ruled apart, never proposed again.
		const more = [release('spotify', 's2', 'Drift', ['Ivo Lark', 'Pell Ward'], '2026-03-02')];
		await withSystemTx(app.db, async (tx) => {
			const out = await ingestClaims(tx, more, { reason: 'tracker' });
			await linkReleasesToLabel(tx, label!.objectId, [{ objectId: out.outcomes[0]!.objectId, claim: more[0]! }]);
		});
		expect((await runInboxDetectors({ db: app.db })).twins).toBe(1);
		const [second] = (await ops.inboxList({ status: 'open', kind: 'release.twins' })).rows;
		await ops.inboxDecide({ id: second!.id, action: 'reject', note: 'a remix' });
		expect(await app.db.query(`select 1 from curator.catalog_not_same`)).toHaveLength(1);
		expect((await runInboxDetectors({ db: app.db })).twins).toBe(0);
	});

	it('proposes unlinking a dead page, notices a failing tracker and a parked provider, and clears them when they recover', async () => {
		const app = await createTestApp();
		const out = await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[
					{ provider: 'soundcloud', kind: 'label', providerId: 'welcome-to-nowhere', name: 'Nowhere', url: 'https://soundcloud.com/welcome-to-nowhere' },
					{ provider: 'beatport', kind: 'label', providerId: '804', name: 'Marram', url: 'https://www.beatport.com/label/marram/804' },
				],
				{ reason: 'enrichment' },
			),
		);
		const [nowhere, marram] = out.outcomes.map((o) => o.objectId);
		await app.db.query(`insert into curator.catalog_cursor (object_id, provider, fail_count, last_error, last_run_at) values ($1, 'soundcloud', 7, 'soundcloud profile welcome-to-nowhere not found (404)', now()), ($2, 'beatport', 5, 'HTTP 503', now())`, [nowhere!, marram!]);
		await app.db.query(`insert into curator.catalog_enrich_task (object_id, need, provider, next_due_at, last_error) values ($1, 'backfill', 'beatport', now() + interval '6 hours', 'parked: beatport (21600s)')`, [marram!]);
		expect(await runInboxDetectors({ db: app.db })).toMatchObject({ twins: 0, pages: 1, trackers: 2 });
		const ops = adminOps(app.db, {});
		const open = (await ops.inboxList({ status: 'open' })).rows;
		const dead = open.find((i) => i.kind === 'page.dead')!;
		expect(dead).toMatchObject({ severity: 'approval', apply: { op: 'unlinkPage' }, subjectNames: [{ name: 'Nowhere' }] });
		expect(open.find((i) => i.kind === 'tracker.failing')).toMatchObject({ severity: 'notice', subjectNames: [{ name: 'Marram' }] });
		expect(open.find((i) => i.kind === 'provider.parked')).toMatchObject({ severity: 'notice', evidence: { provider: 'beatport', waiting: 1 } });
		// Asked once; approving the unlink takes the page off.
		expect(await runInboxDetectors({ db: app.db })).toMatchObject({ pages: 0, trackers: 0, cleared: 0 });
		await ops.inboxDecide({ id: dead.id, action: 'approve' });
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'soundcloud' and provider_id = 'welcome-to-nowhere'`)).toEqual([]);
		// The tracker recovers and the park ends: both notices clear.
		await app.db.query(`update curator.catalog_cursor set fail_count = 0, last_error = null where provider = 'beatport'`);
		await app.db.query(`update curator.catalog_enrich_task set next_due_at = now() - interval '1 minute'`);
		expect((await runInboxDetectors({ db: app.db })).cleared).toBe(2);
		expect(await ops.inboxCounts({})).toEqual({ approval: 0, notice: 0, snoozed: 0 });
		const cleared = (await ops.inboxList({ status: 'all' })).rows.filter((i) => i.status === 'cleared');
		expect(cleared.map((i) => i.resolution).sort()).toEqual(['nothing is parked any more', 'the tracker recovered']);
	});

	it('suspects each id of a store an artist holds twice, over a lower floor; the operator splits a namesake off and blocks a bucket', async () => {
		const app = await createTestApp();
		const by = (provider: 'spotify' | 'deezer', id: string) => [{ provider, kind: 'artist' as const, providerId: id, name: 'Ivo Lark' }];
		const rel = (provider: 'spotify' | 'deezer', id: string, title: string, labelText: string, artistId: string, upc?: string) => ({
			provider,
			kind: 'release' as const,
			providerId: id,
			name: title,
			facts: { releaseDate: '2026-03-01', labelText },
			identifiers: upc ? [{ namespace: 'upc' as const, value: upc }] : [],
			artists: by(provider, artistId),
		});
		const ids = await withSystemTx(app.db, async (tx) => {
			await ingestClaims(tx, [rel('spotify', 's1', 'Glass Rivers', 'Northfold', 'sa1'), rel('spotify', 's2', 'Low Tide', 'Northfold', 'sa1'), rel('spotify', 's3', 'Drift', 'Marram', 'sa1'), rel('spotify', 's4', 'Eos', 'Kiosk', 'sa1', '0123456789012')], { reason: 'tracker' });
			// Deezer's bucket under her name — hers "Eos" (joined by UPC, so the
			// page lands on her through it) beside a stranger's — and a namesake's
			// own Deezer page, minted apart and merged in as a twin (2026-11-09, ELIF).
			await ingestClaims(tx, [rel('deezer', '701', 'Eos', 'Kiosk', 'dzA', '0123456789012'), rel('deezer', '702', 'Depresiyon', 'Turkish Pop', 'dzA')], { reason: 'tracker' });
			await ingestClaims(tx, [rel('deezer', '801', 'Nacht', 'Pop Haus', 'dzB'), rel('deezer', '802', 'Alaska', 'Pop Haus', 'dzB'), rel('deezer', '803', 'Freunde', 'Universal', 'dzB'), rel('deezer', '804', 'Freunde II', 'Polydor', 'dzB')], { reason: 'tracker' });
			const own = async (provider: string, id: string) => (await tx.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = $1 and kind = 'artist' and provider_id = $2`, [provider, id]))[0]!.object_id;
			const [a, dzA, dzB] = [await own('spotify', 'sa1'), await own('deezer', 'dzA'), await own('deezer', 'dzB')];
			expect(dzA).toBe(a);
			expect(dzB).not.toBe(a);
			await mergeObjects(tx, dzB, a, 'test', 'twins');
			return { artist: a };
		});
		const c = await withSystemTx(app.db, (tx) => bucketCandidates(tx, { days: 30 }));
		const byId = Object.fromEntries(c.map((x) => [`${x.provider}:${x.providerId}`, x]));
		expect(byId['deezer:dzA']).toMatchObject({ artist: ids.artist, suspect: true, stats: { siblings: 2, releases: 6, labels: 5, shared: 1, others: 3, labelsShared: 1, labelsElsewhere: 3 } });
		expect(byId['deezer:dzB']).toMatchObject({ suspect: true, stats: { siblings: 2 } });
		expect(byId['spotify:sa1']).toBeUndefined();

		// The operator answers. dzB is the pop singer's own page: split off with
		// its releases, held until approved. dzA is Deezer's bucket: blocked, the
		// release only it brought loses the credit, hers on Spotify too stays.
		const fetch: FetchLike = async (input) => {
			const path = new URL(input).pathname;
			const m = /^\/artist\/(dz[AB])(\/albums)?$/.exec(path);
			const albums: Record<string, number[]> = { dzA: [701, 702], dzB: [801, 802, 803, 804] };
			const body = !m ? { error: { code: 800 } } : m[2] ? { data: albums[m[1]!]!.map((id) => ({ id })) } : { id: m[1], name: m[1] === 'dzB' ? 'IVO LARK' : 'Ivo Lark' };
			return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
		};
		const ops = adminOps(app.db, { fetch });
		const held = await ops.artistUnlink({ id: ids.artist, source: 'deezer:dzB', note: 'the pop singer' });
		expect(held).toMatchObject({ name: 'IVO LARK', releases: 4, held: expect.any(Number), result: null });
		await ops.inboxDecide({ id: held.held!, action: 'approve', note: 'yes' });
		const pop = (await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'deezer' and provider_id = 'dzB'`))[0]!.object_id;
		expect(pop).not.toBe(ids.artist);
		const credited = async (artist: string) => (await app.db.query<{ name: string }>(`select r.name from curator.catalog_edge e join curator.catalog_object r on r.id = e.dst where e.src = $1 and e.kind = 'artist-release' order by r.name`, [artist])).map((r) => r.name);
		expect(await credited(pop)).toEqual(['Alaska', 'Freunde', 'Freunde II', 'Nacht']);
		expect(await credited(ids.artist)).toEqual(['Depresiyon', 'Drift', 'Eos', 'Glass Rivers', 'Low Tide']);
		const direct = await ops.artistUnlink({ id: ids.artist, source: 'deezer:dzA', note: "Deezer's bucket", as: 'bucket', approved: true });
		expect(direct.result).toMatchObject({ into: null, uncredited: 1, kept: 1 });
		expect(await credited(ids.artist)).toEqual(['Drift', 'Eos', 'Glass Rivers', 'Low Tide']);
		expect(await app.db.query(`select 1 from curator.catalog_source_block where provider = 'deezer' and kind = 'artist' and provider_id = 'dzA'`)).toHaveLength(1);
		expect((await ops.inboxList({ status: 'all', kind: 'artist.unlink' })).rows.map((r) => r.severity).sort()).toEqual(['approval', 'audit']);
	});
});
