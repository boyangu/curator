// The back office: reviews opened where the pipeline refused to guess, and
// the decisions a session takes on them — attach, merge, not the same —
// with every layer following a merge. Made-up names.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp } from '../test/harness.js';
import { adminOps } from './admin-ops.js';
import { listReviews, mergeObjects, notSame, scanDuplicates } from './admin.js';
import { ingestClaims } from './ingest.js';
import { runLabelProfiler } from './profile/label-profiler.js';
import { DeezerFinder, runPlanner } from './planner.js';
import type { FetchLike } from './trackers/http.js';

const quiet = createLogger(() => {});
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });

const artist = (provider: 'spotify' | 'deezer', id: string, name: string) => ({ provider, kind: 'artist' as const, providerId: id, name });
const release = (provider: 'spotify' | 'deezer', id: string, title: string, a: ReturnType<typeof artist>, date = '2026-10-23') => ({
	provider,
	kind: 'release' as const,
	providerId: id,
	name: title,
	facts: { releaseDate: date },
	artists: [a],
	recordings: [{ provider, kind: 'recording' as const, providerId: `${id}-t1`, name: title, identifiers: [{ namespace: 'isrc' as const, value: `GB${provider === 'spotify' ? 'S' : 'D'}${id.padStart(9, '0')}` }] }],
});

describe('merge', () => {
	it('re-points every layer onto the winner, moves watches as their owners, and leaves an alias', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		// Two "Northfold" artists: one from Spotify (watched), one from Deezer, each with a release.
		const sp = artist('spotify', 'sa1', 'Northfold');
		const dz = artist('deezer', 'da1', 'Northfold');
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [release('spotify', 'r1', 'Glass Rivers', sp), release('deezer', 'r2', 'Drift', dz)], { reason: 'library_import' }));
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: sp, source: 'manual' });
		const winner = w.watch.object.id;
		const [loser] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'deezer' and kind = 'artist'`);
		expect(loser!.object_id).not.toBe(winner);

		const r = await withSystemTx(app.db, (tx) => mergeObjects(tx, loser!.object_id, winner, 'test', 'same artist'));
		expect(r.moved).toMatchObject({ representations: 1, edges_src: 1 });
		const reps = await app.db.query<{ provider: string }>(`select provider from curator.catalog_source_object where object_id = $1 order by provider`, [winner]);
		expect(reps.map((x) => x.provider)).toEqual(['deezer', 'spotify']);
		const releases = await app.db.query<{ name: string }>(`select r.name from curator.catalog_edge e join curator.catalog_object r on r.id = e.dst where e.src = $1 and e.kind = 'artist-release' order by r.name`, [winner]);
		expect(releases.map((x) => x.name)).toEqual(['Drift', 'Glass Rivers']);
		const [alias] = await app.db.query<{ merged_into: string; watch_count: unknown }>(`select merged_into, watch_count from curator.catalog_object where id = $1`, [loser!.object_id]);
		expect(alias).toMatchObject({ merged_into: winner });
		expect(Number(alias!.watch_count)).toBe(0);
		const [log] = await app.db.query<{ from_id: string; into_id: string; by_whom: string }>(`select from_id, into_id, by_whom from curator.catalog_merge_log`);
		expect(log).toEqual({ from_id: loser!.object_id, into_id: winner, by_whom: 'test' });
		// A pair ruled apart cannot be merged.
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [artist('deezer', 'da2', 'Northfold')], { reason: 'library_import' }));
		const [other] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider_id = 'da2'`);
		await withSystemTx(app.db, (tx) => notSame(tx, winner, other!.object_id, 'test', 'different act'));
		await expect(withSystemTx(app.db, (tx) => mergeObjects(tx, other!.object_id, winner, 'test', 'x'))).rejects.toThrow(/not the same/);
	});

	it('a watched loser hands its watch to the winner', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const a = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: artist('spotify', 'sa1', 'Northfold'), source: 'manual' });
		const b = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: artist('deezer', 'da1', 'Northfold'), source: 'imported' });
		await withSystemTx(app.db, (tx) => mergeObjects(tx, b.watch.object.id, a.watch.object.id, 'test', 'same'));
		const list = await fan.api.catalog.listWatches.query({ deviceId: fan.deviceId });
		expect(list.map((w) => [w.object.id, w.source])).toEqual([[a.watch.object.id, 'manual']]);
		const [count] = await app.db.query<{ watch_count: unknown }>(`select watch_count from curator.catalog_object where id = $1`, [a.watch.object.id]);
		expect(Number(count!.watch_count)).toBe(1);
	});
});

describe('label ops', () => {
	it('registers a label by name or page, shows its standing with gaps, links a page by hand, and refreshes', async () => {
		const app = await createTestApp();
		// The pages `label link` resolves to the ids their APIs take.
		const pages: FetchLike = async (input) => {
			const u = new URL(input);
			if (u.hostname === 'soundcloud.com' && u.pathname === '/northfold-records') return new Response('<script>window.__sc_hydration = [{"hydratable":"user","data":{"id":237204}}];</script>', { status: 200 });
			if (u.hostname === 'northfold.bandcamp.com') return new Response('<a href="/album/y?label=2140572776&tab=music">y</a>', { status: 200 });
			if (u.hostname === 'bandcamp.com') return json({ sites: [] });
			return new Response('', { status: 404 });
		};
		const ops = adminOps(app.db, { fetch: pages });
		const v = await ops.labelAdd({ q: 'https://www.beatport.com/label/northfold-records/804' });
		expect(v).toMatchObject({ name: 'Northfold Records', watchers: 0, releases: 0, pages: [{ provider: 'beatport', id: '804' }] });
		expect(v.gaps).toEqual(['profile pending', 'no bandcamp page', 'no soundcloud page', 'no youtube page', 'no website page']);
		expect(v.tasks.map((t) => `${t.need}/${t.provider}`)).toEqual(['dedupe/catalog', 'profile/catalog']);
		// The same label again, by name: found, not duplicated.
		expect((await ops.labelAdd({ q: 'northfold records' })).id).toBe(v.id);
		expect((await ops.search({ q: 'northfold' })).map((r) => r.name)).toEqual(['Northfold Records']);

		const linked = await ops.labelLink({ q: v.id, url: 'https://soundcloud.com/northfold-records' });
		expect(linked.pages.map((p) => `${p.provider}:${p.id}`)).toEqual(['beatport:804', 'soundcloud:237204']);
		// A Bandcamp subdomain becomes its band id, and its releases are queued; one that does not answer keeps the slug.
		const bc = await ops.labelLink({ q: v.id, url: 'https://northfold.bandcamp.com/' });
		expect(bc.pages.map((p) => `${p.provider}:${p.id}`)).toEqual(['bandcamp:2140572776', 'beatport:804', 'soundcloud:237204']);
		expect(bc.tasks.map((t) => `${t.need}/${t.provider}`)).toEqual(['backfill/bandcamp', 'dedupe/catalog', 'profile/catalog']);
		expect((await ops.labelLink({ q: v.id, url: 'https://unknown.bandcamp.com/' })).pages.map((p) => `${p.provider}:${p.id}`)).toContain('bandcamp:unknown');
		// A plain domain is the label's website; a social page we do not read is nothing.
		expect((await ops.labelLink({ q: 'Northfold Records', url: 'https://northfold.example/' })).pages.map((p) => p.provider)).toContain('website');
		await expect(ops.labelLink({ q: 'Northfold Records', url: 'https://www.facebook.com/northfold' })).rejects.toThrow(/not a label page/);
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ provider: 'beatport', kind: 'label', providerId: '805', name: 'Other', url: null }], { reason: 'library_import' }));
		await expect(ops.labelLink({ q: 'Northfold Records', url: 'https://www.beatport.com/label/other/805' })).rejects.toThrow(/already belongs/);

		// Nobody watches it: a refresh queues backfills, not cursors; the profile is already queued.
		await app.pg.query(`delete from curator.catalog_enrich_task`);
		expect(await ops.labelRefresh({ q: 'Northfold Records' })).toEqual({ cursors: 0, backfills: 3, profile: false });
		const verify = await ops.labelVerify({});
		expect(verify.map((r) => [r.name, [...r.pages].sort(), r.gaps.some((g) => g.startsWith('backfill beatport pending'))])).toEqual([
			['Northfold Records', ['bandcamp', 'bandcamp', 'beatport', 'soundcloud', 'website'], true],
			['Other', ['beatport'], false],
		]);
		await expect(ops.labelShow({ q: 'nobody' })).rejects.toThrow(/no label matches/);
	});
});

describe('reviews', () => {
	it('the duplicates scan opens one review per look-alike pair, with both sides\' releases, and a decision merges or rules them apart', async () => {
		const app = await createTestApp();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [release('spotify', 'r1', 'Glass Rivers', artist('spotify', 'sa1', 'Northfold')), release('deezer', 'r2', 'Glass Rivers', artist('deezer', 'da1', 'Northfold'), '2026-01-01'), artist('spotify', 'sa3', 'Kaske')], { reason: 'library_import' }),
		);
		expect(await withSystemTx(app.db, (tx) => scanDuplicates(tx))).toBe(1);
		expect(await withSystemTx(app.db, (tx) => scanDuplicates(tx))).toBe(0);
		const ops = adminOps(app.db, {});
		const [rv] = await ops.list({ evidence: true });
		expect(rv).toMatchObject({ kind: 'duplicate', object: { name: 'Northfold', kind: 'artist' } });
		expect(rv!.candidateViews[0]).toMatchObject({ overlap: 1, releases: ['Glass Rivers'] });
		const d = await ops.decide({ id: rv!.id, decision: { action: 'merge', candidate: 0 }, by: 'claude-code', note: 'same release on both' });
		expect(d.review.status).toBe('decided');
		expect(d.merge).toMatchObject({ into: rv!.objectId });
		expect(await withSystemTx(app.db, (tx) => listReviews(tx))).toEqual([]);
	});

	it('the profiler opens a review for namesakes it will not pick between, and honours a "not the same" ruling', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: { provider: 'user', kind: 'label', providerId: 'name:northfold', name: 'Northfold' }, source: 'manual' });
		const fetch: FetchLike = async (input) => {
			const u = new URL(input);
			if (u.hostname === 'musicbrainz.org') return json({ labels: [{ id: 'a0000000-0000-4000-8000-000000000001', name: 'Northfold' }, { id: 'a0000000-0000-4000-8000-000000000002', name: 'Northfold' }] });
			if (u.hostname === 'api.discogs.com') return json({ results: [] });
			return new Response('{}', { status: 404 });
		};
		await runLabelProfiler({ db: app.db, log: quiet, fetch, spotify: null, providers: { beatport: false, bandcamp: false }, sleep: async () => {} });
		const ops = adminOps(app.db, { fetch });
		const [rv] = await ops.list({});
		expect(rv).toMatchObject({ kind: 'label_page', objectId: w.watch.object.id });
		expect(rv!.candidates.map((c) => c.providerId)).toEqual(['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002']);
		// Attaching one by decision gives the label its MusicBrainz id.
		await ops.decide({ id: rv!.id, decision: { action: 'attach', candidate: 0 }, by: 'claude-code', note: 'its releases match' });
		const ids = await app.db.query<{ namespace: string; value: string }>(`select namespace, value from curator.catalog_identifier where object_id = $1`, [w.watch.object.id]);
		expect(ids).toEqual([{ namespace: 'mbid_label', value: 'a0000000-0000-4000-8000-000000000001' }]);
	});

	it('the planner opens a review when two namesakes both overlap, and never re-attaches a page ruled not the artist\'s', async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: artist('spotify', 'sa1', 'Northfold'), source: 'manual' });
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [release('spotify', 'r1', 'Glass Rivers', artist('spotify', 'sa1', 'Northfold'))], { reason: 'library_import' }));
		const fetch: FetchLike = async (input) => {
			const u = new URL(input);
			if (u.pathname === '/search/artist') return json({ data: [{ id: 1, name: 'Northfold' }, { id: 2, name: 'Northfold' }] });
			if (u.pathname.startsWith('/artist/')) return json({ data: [{ title: 'Glass Rivers' }] });
			return json({ data: [] });
		};
		await runPlanner({ db: app.db, log: quiet, finders: [new DeezerFinder(fetch)] });
		const ops = adminOps(app.db, {});
		const [rv] = await ops.list({});
		expect(rv).toMatchObject({ kind: 'artist_link', objectId: w.watch.object.id, evidence: { reason: 'ambiguous' } });
		expect(rv!.candidateViews.map((c) => [c.candidate.providerId, c.overlap])).toEqual([['1', 1], ['2', 1]]);
		// Ruled: candidate 1 is not this artist. A later pass that finds only
		// candidate 1 does not attach it.
		await ops.decide({ id: rv!.id, decision: { action: 'not_same', candidate: 0 }, by: 'claude-code', note: null });
		const only1: FetchLike = async (input) => (new URL(input).pathname === '/search/artist' ? json({ data: [{ id: 1, name: 'Northfold' }] }) : json({ data: [{ title: 'Glass Rivers' }] }));
		await app.pg.query(`update curator.catalog_enrich_task set next_due_at = now() - interval '1 minute'`);
		await runPlanner({ db: app.db, log: quiet, finders: [new DeezerFinder(only1)] });
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'deezer' and kind = 'artist'`)).toEqual([]);
		const [task] = await app.db.query<{ last_error: string }>(`select last_error from curator.catalog_enrich_task where need = 'representation' and provider = 'deezer'`);
		expect(task?.last_error).toBe('ruled_not_same');
	});
});
