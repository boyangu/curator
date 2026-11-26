// A label given as text is the label of that name (ingest.ts textLabel,
// IngestBatch.labelNamed), and a device's finding reaches the release it is
// about (catalog.ts attachFacts). Made-up names.

import type { CatalogClaim } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { ingestClaims } from './ingest.js';
import { detectLabelNamesakes, linkLabelTexts } from './label-texts.js';

type App = Awaited<ReturnType<typeof createTestApp>>;

const artist = (provider: CatalogClaim['provider'], id: string, name: string): CatalogClaim => ({ provider, kind: 'artist', providerId: id, name });

function release(provider: CatalogClaim['provider'], id: string, title: string, opts: { labelText?: string; label?: CatalogClaim; upc?: string; tracks?: { id: string; title: string; isrc?: string; sec?: number }[] } = {}): CatalogClaim {
	return {
		provider,
		kind: 'release',
		providerId: id,
		name: title,
		identifiers: opts.upc ? [{ namespace: 'upc', value: opts.upc }] : [],
		facts: { releaseDate: '2026-01-01', ...(opts.labelText ? { labelText: opts.labelText } : {}) },
		artists: [artist(provider, `${provider}-a1`, 'Northfold')],
		...(opts.label ? { label: opts.label } : {}),
		recordings: (opts.tracks ?? [{ id: `${id}-t1`, title }]).map((t) => ({
			provider,
			kind: 'recording' as const,
			providerId: t.id,
			name: t.title,
			identifiers: t.isrc ? [{ namespace: 'isrc' as const, value: t.isrc }] : [],
			facts: { durationSec: t.sec ?? 300 },
		})),
	};
}

const ingest = (app: App, claims: CatalogClaim[], reason: 'tracker' | 'enrichment' | 'library_import' = 'tracker') => withSystemTx(app.db, (tx) => ingestClaims(tx, claims, { reason }));

const labelsOf = async (app: App, provider: string, releaseId: string): Promise<string[]> => {
	const rows = await app.db.query<{ name: string }>(
		`select l.name from curator.catalog_source_object s
		join curator.catalog_edge e on e.src = s.object_id and e.kind = 'release-label'
		join curator.catalog_object l on l.id = e.dst
		where s.provider = $1 and s.kind = 'release' and s.provider_id = $2 order by l.name`,
		[provider, releaseId],
	);
	return rows.map((r) => r.name);
};

const labelObjects = async (app: App): Promise<{ name: string; releases: number }[]> =>
	(
		await app.db.query<{ name: string; n: unknown }>(
			`select l.name, (select count(*) from curator.catalog_edge e where e.dst = l.id and e.kind = 'release-label') as n
			from curator.catalog_object l where l.kind = 'label' and l.merged_into is null order by l.name`,
		)
	).map((r) => ({ name: r.name, releases: Number(r.n) }));

describe('a label given as text', () => {
	it('is the label of that name: a store’s label page, another store’s text and another spelling meet on one object', async () => {
		const app = await createTestApp();
		const beatport: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '804', name: 'Northfold Records' };
		await ingest(app, [release('beatport', 'b1', 'Glass Rivers', { label: beatport })]);
		await ingest(app, [release('spotify', 's1', 'Low Tide', { labelText: 'Northfold Records' }), release('deezer', 'd1', 'Undertow', { labelText: 'NORTHFOLD RECORDS' })]);
		expect(await labelObjects(app)).toEqual([{ name: 'Northfold Records', releases: 3 }]);
		expect(await labelsOf(app, 'spotify', 's1')).toEqual(['Northfold Records']);
	});

	it('names a new label when none of that name exists, and the label’s own page joins it later', async () => {
		const app = await createTestApp();
		await ingest(app, [release('spotify', 's1', 'Low Tide', { labelText: 'Cobalt Pier' })]);
		expect(await labelObjects(app)).toEqual([{ name: 'Cobalt Pier', releases: 1 }]);
		await ingest(app, [release('bandcamp', 'bc1', 'Slack Water', { label: { provider: 'bandcamp', kind: 'label', providerId: '77', name: 'Cobalt Pier' } })]);
		expect(await labelObjects(app)).toEqual([{ name: 'Cobalt Pier', releases: 2 }]);
		const [pages] = await app.db.query<{ n: unknown }>(`select count(distinct object_id) as n from curator.catalog_source_object where kind = 'label'`);
		expect(Number(pages!.n)).toBe(1);
	});

	it('stays text when it is a distributor’s name', async () => {
		const app = await createTestApp();
		await ingest(app, [release('spotify', 's1', 'Low Tide', { labelText: 'DistroKid' }), release('spotify', 's2', 'High Tide', { labelText: '1461444 Records DK' })]);
		expect(await labelObjects(app)).toEqual([]);
		const rows = await app.db.query<{ label_text: string }>(`select label_text from curator.catalog_object where kind = 'release' order by name`);
		expect(rows.map((r) => r.label_text)).toEqual(['1461444 Records DK', 'DistroKid']);
	});

	it('never joins two labels one store holds apart; text goes to the one more releases are on', async () => {
		const app = await createTestApp();
		const a: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '804', name: 'Harbour' };
		const b: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '805', name: 'Harbour' };
		await ingest(app, [release('beatport', 'b1', 'One', { label: a }), release('beatport', 'b2', 'Two', { label: b }), release('beatport', 'b3', 'Three', { label: b })]);
		expect(await labelObjects(app)).toEqual([
			{ name: 'Harbour', releases: 1 },
			{ name: 'Harbour', releases: 2 },
		]);
		await ingest(app, [release('spotify', 's1', 'Four', { labelText: 'Harbour' })]);
		expect(await labelObjects(app)).toEqual([
			{ name: 'Harbour', releases: 1 },
			{ name: 'Harbour', releases: 3 },
		]);
	});

	it('does not rename a label: a later spelling of the name is only a spelling', async () => {
		const app = await createTestApp();
		await ingest(app, [release('spotify', 's1', 'Low Tide', { labelText: 'Cobalt Pier' })]);
		await ingest(app, [release('deezer', 'd1', 'High Tide', { labelText: 'COBALT PIER' })]);
		expect(await labelObjects(app)).toEqual([{ name: 'Cobalt Pier', releases: 2 }]);
	});
});

describe('a device’s finding', () => {
	async function setup() {
		const app = await createTestApp();
		const fan = await app.signIn();
		// A Bandcamp release: no UPC, no ISRC, so no rule can find it from a store page.
		const [rel] = (await ingest(app, [release('bandcamp', 'bc1', 'Glass Rivers', { tracks: [{ id: 'bt1', title: 'Glass Rivers', sec: 401 }] })])).outcomes;
		const [track] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'bandcamp' and kind = 'recording'`);
		const send = (claims: CatalogClaim[], key: string) => fan.api.catalog.ingest.mutate({ deviceId: fan.deviceId, reason: 'enrichment', idempotencyKey: `facts-test-${key}`, claims });
		return { app, send, releaseId: rel!.objectId, trackId: track!.object_id };
	}

	it('reaches the release it is about when the title and a credited act agree', async () => {
		const { app, send, releaseId } = await setup();
		const page: CatalogClaim = { ...release('spotify', 'al1', 'Glass Rivers'), recordings: undefined, about: releaseId };
		const r = await send([page], 'k1');
		expect(r.results).toEqual([{ objectId: releaseId, created: false }]);
		const [held] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'spotify' and kind = 'release'`);
		expect(held!.object_id).toBe(releaseId);
	});

	it('is refused when it does not agree with the object it names', async () => {
		const { send, releaseId, trackId } = await setup();
		const wrongTitle: CatalogClaim = { ...release('spotify', 'al2', 'Other Rivers'), recordings: undefined, about: releaseId };
		const wrongLength: CatalogClaim = { provider: 'beatport', kind: 'recording', providerId: '99', name: 'Glass Rivers', facts: { durationSec: 300, bpm: 122 }, about: trackId };
		const r = await send([wrongTitle, wrongLength], 'k2');
		expect(r.results).toEqual([{ rejected: 'unknown' }, { rejected: 'unknown' }]);
	});

	it('gives a track its store page and facts, and its label to the release that has none', async () => {
		const { app, send, releaseId, trackId } = await setup();
		const r = await send([{ provider: 'beatport', kind: 'recording', providerId: '98', name: 'Glass Rivers (Original Mix)', facts: { durationSec: 402, bpm: 122, key: 'A Minor', labelText: 'Northfold Records' }, about: trackId }], 'k3');
		expect(r.results).toEqual([{ objectId: trackId, created: false }]);
		const [o] = await app.db.query<{ attrs: string }>(`select attrs::text as attrs from curator.catalog_object where id = $1`, [trackId]);
		expect(JSON.parse(o!.attrs)).toMatchObject({ bpm: 122, key: 'A Minor' });
		expect(await labelsOf(app, 'bandcamp', 'bc1')).toEqual(['Northfold Records']);
		// The release names a label now: another track's label does not add one.
		const [rel] = await app.db.query<{ n: unknown }>(`select count(*) as n from curator.catalog_edge where src = $1 and kind = 'release-label'`, [releaseId]);
		expect(Number(rel!.n)).toBe(1);
	});
});

describe('the releases ingested before labels were read from text', () => {
	it('are tied to the label of that name, a page at a time, once', async () => {
		const app = await createTestApp();
		await ingest(app, [
			release('spotify', 's1', 'Low Tide', { labelText: 'Cobalt Pier' }),
			release('deezer', 'd1', 'High Tide', { labelText: 'COBALT PIER' }),
			release('spotify', 's2', 'Ebb', { labelText: 'DistroKid' }),
		]);
		// As they stood before: the text only.
		await app.db.query(`delete from curator.catalog_edge_evidence where edge_id in (select id from curator.catalog_edge where kind = 'release-label')`);
		await app.db.query(`delete from curator.catalog_edge where kind = 'release-label'`);
		expect((await linkLabelTexts(app.db, { dry: true })).linked).toBe(3);
		const first = await linkLabelTexts(app.db, { limit: 2 });
		expect(first.next).not.toBeNull();
		const rest = await linkLabelTexts(app.db, { after: first.next, limit: 2 });
		expect(first.scanned + rest.scanned).toBe(3);
		expect((await labelObjects(app)).map((l) => [l.name, l.releases])).toEqual([['Cobalt Pier', 2]]);
		// The distributor's release is read again and left as text.
		expect(await linkLabelTexts(app.db)).toMatchObject({ scanned: 1, linked: 0 });
	});
});

describe('a label tied by name to a namesake’s releases', () => {
	it('is put to the operator when they share no artist with its own page’s releases', async () => {
		const app = await createTestApp();
		const page: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '804', name: 'Harbour' };
		const by = (provider: CatalogClaim['provider'], id: string, title: string, name: string, opts: { label?: CatalogClaim; labelText?: string }): CatalogClaim => ({
			...release(provider, id, title, opts),
			artists: [artist(provider, `${provider}-${name}`, name)],
		});
		await ingest(app, [by('beatport', 'b1', 'One', 'Ash', { label: page }), by('beatport', 'b2', 'Two', 'Birch', { label: page }), by('beatport', 'b3', 'Three', 'Cedar', { label: page })]);
		await ingest(app, [by('spotify', 's1', 'Four', 'Xeno', { labelText: 'Harbour' }), by('spotify', 's2', 'Five', 'Yarrow', { labelText: 'Harbour' }), by('spotify', 's3', 'Six', 'Zinc', { labelText: 'Harbour' })]);
		expect(await withSystemTx(app.db, (tx) => detectLabelNamesakes(tx))).toBe(1);
		const [item] = await app.db.query<{ kind: string; evidence: string }>(`select kind, evidence::text as evidence from curator.catalog_inbox where kind = 'label.namesake'`);
		expect(JSON.parse(item!.evidence)).toMatchObject({ own: 3, named: 3, providers: ['beatport'] });
		// Asked once.
		expect(await withSystemTx(app.db, (tx) => detectLabelNamesakes(tx))).toBe(0);
	});

	it('is left alone when the named releases share an artist with the page’s', async () => {
		const app = await createTestApp();
		const page: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '804', name: 'Harbour' };
		await ingest(app, [release('beatport', 'b1', 'One', { label: page }), release('beatport', 'b2', 'Two', { label: page }), release('beatport', 'b3', 'Three', { label: page })]);
		// The same act, found on Spotify: the corroboration rule joins it.
		await ingest(app, [release('spotify', 's1', 'Four', { labelText: 'Harbour' }), release('spotify', 's2', 'Five', { labelText: 'Harbour' }), release('spotify', 's3', 'Six', { labelText: 'Harbour' })]);
		const [sa] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'spotify' and kind = 'artist'`);
		const [ba] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'beatport' and kind = 'artist'`);
		// Two objects for one act until something corroborates them: shared
		// by name is not enough for the detector either way, so tie them.
		if (sa!.object_id !== ba!.object_id) await app.db.query(`insert into curator.catalog_edge (src, kind, dst) select $1, 'artist-release', e.dst from curator.catalog_edge e where e.src = $2 and e.kind = 'artist-release' on conflict do nothing`, [ba!.object_id, sa!.object_id]);
		expect(await withSystemTx(app.db, (tx) => detectLabelNamesakes(tx))).toBe(0);
	});
});
