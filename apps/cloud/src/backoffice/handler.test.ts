// The browser back office: lists and detail views over the shared catalogue,
// answered read-only. Made-up names.

import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp } from '../test/harness.js';
import { ingestClaims } from '../catalog/ingest.js';
import { adminOps } from '../catalog/admin-ops.js';
import { createBackofficeHandler } from './handler.js';

const artist = (id: string, name: string) => ({ provider: 'beatport' as const, kind: 'artist' as const, providerId: id, name });
const label = { provider: 'beatport' as const, kind: 'label' as const, providerId: 'l1', name: 'Northfold Records', artists: [artist('a3', 'Quiet Harbour')] };
const rec = (id: string, title: string, isrc: string, by = [artist('a1', 'Glass Rivers')]) => ({
	provider: 'beatport' as const,
	kind: 'recording' as const,
	providerId: id,
	name: title,
	artists: by,
	identifiers: [{ namespace: 'isrc' as const, value: isrc }],
});

async function seeded() {
	const app = await createTestApp();
	await withSystemTx(app.db, (tx) =>
		ingestClaims(
			tx,
			[
				label,
				{
					provider: 'beatport',
					kind: 'release',
					providerId: 'r1',
					name: 'Low Tide EP',
					facts: { releaseDate: '2026-09-04' },
					artists: [artist('a1', 'Glass Rivers')],
					label,
					recordings: [rec('t1', 'Low Tide', 'GBNFR2600001'), rec('t2', 'Undertow', 'GBNFR2600002', [artist('a1', 'Glass Rivers'), artist('a2', 'Northern Drift')])],
				},
			],
			{ reason: 'library_import' },
		),
	);
	const handler = createBackofficeHandler(app.db);
	const get = async (path: string) => {
		const res = await handler(new Request(`http://127.0.0.1${path}`));
		return { status: res!.status, body: (await res!.json()) as any };
	};
	return { app, handler, get };
}

describe('backoffice', () => {
	it('lists labels, artists and tracks with search, counts and the track’s release', async () => {
		const { get } = await seeded();
		expect((await get('/backoffice/api/stats')).body).toMatchObject({ label: 1, artist: 3, recording: 2, release: 1 });

		const labels = (await get('/backoffice/api/list?kind=label')).body;
		expect(labels).toMatchObject({ total: 1, rows: [{ name: 'Northfold Records', releases: 1, roster: 1, providers: ['beatport'] }] });

		const artists = (await get('/backoffice/api/list?kind=artist&q=north')).body;
		expect(artists.rows.map((r: { name: string }) => r.name)).toEqual(['Northern Drift']);
		// Contains, prefix hits first.
		expect((await get('/backoffice/api/list?kind=artist&q=r')).body.total).toBe(3);

		const tracks = (await get('/backoffice/api/list?kind=recording&sort=name')).body;
		expect(tracks.rows).toMatchObject([
			{ name: 'Low Tide', artists: ['Glass Rivers'], release: 'Low Tide EP', label: 'Northfold Records', date: '2026-09-04', isrc: 'GBNFR2600001' },
			{ name: 'Undertow', artists: ['Glass Rivers', 'Northern Drift'] },
		]);
		expect((await get('/backoffice/api/list?kind=recording&limit=1&offset=1')).body).toMatchObject({ total: 2, rows: [{ name: 'Undertow' }] });
	});

	it('shows a label, an artist, a release and a track with their relations', async () => {
		const { get } = await seeded();
		const id = async (kind: string, q: string) => (await get(`/backoffice/api/list?kind=${kind}&q=${encodeURIComponent(q)}`)).body.rows[0].id as string;

		const l = (await get(`/backoffice/api/object/${await id('label', 'Northfold')}`)).body;
		expect(l).toMatchObject({ kind: 'label', name: 'Northfold Records', releaseCount: 1, roster: [{ name: 'Quiet Harbour' }], artists: [{ name: 'Glass Rivers', releases: 1 }] });
		expect(l.releases[0]).toMatchObject({ title: 'Low Tide EP', date: '2026-09-04', tracks: 2, labels: [{ name: 'Northfold Records' }] });

		const a = (await get(`/backoffice/api/object/${await id('artist', 'Glass')}`)).body;
		expect(a).toMatchObject({ kind: 'artist', releaseCount: 1, trackCount: 2, labels: [{ name: 'Northfold Records', releases: 1 }] });
		expect(a.tracks.map((t: { title: string }) => t.title)).toEqual(['Low Tide', 'Undertow']);

		const r = (await get(`/backoffice/api/object/${l.releases[0].id}`)).body;
		expect(r).toMatchObject({ kind: 'release', release: { date: '2026-09-04' }, labels: [{ name: 'Northfold Records' }] });
		expect(r.tracks.map((t: { position: number; title: string }) => `${t.position} ${t.title}`)).toEqual(['1 Low Tide', '2 Undertow']);

		const t = (await get(`/backoffice/api/object/${r.tracks[1].id}`)).body;
		expect(t).toMatchObject({ kind: 'recording', identifiers: [{ namespace: 'isrc', value: 'GBNFR2600002' }], releases: [{ title: 'Low Tide EP' }] });
		expect(t.artists.map((x: { name: string; role: string }) => `${x.name}/${x.role}`)).toEqual(['Glass Rivers/main', 'Northern Drift/credited']);
		expect(t.sources).toMatchObject([{ provider: 'beatport', providerId: 't2' }]);
	});

	it('sorts labels by when they were last scanned, never-scanned last (or first, longest unscanned)', async () => {
		const { app, get } = await seeded();
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [{ provider: 'beatport', kind: 'label', providerId: 'l2', name: 'Amber Tide' }, { provider: 'beatport', kind: 'label', providerId: 'l3', name: 'Cold Shore' }], { reason: 'library_import' }),
		);
		await adminOps(app.db, {}).labelScanned({ q: 'Northfold Records', note: 'nothing new on its Beatport page' });
		await app.db.query(`update curator.catalog_object set scanned_at = now() - interval '3 days' where name = 'Cold Shore'`);
		const names = async (sort: string) => (await get(`/backoffice/api/list?kind=label&sort=${sort}`)).body.rows.map((r: { name: string }) => r.name);
		expect(await names('scanned')).toEqual(['Northfold Records', 'Cold Shore', 'Amber Tide']);
		expect(await names('stale')).toEqual(['Amber Tide', 'Cold Shore', 'Northfold Records']);
		const rows = (await get('/backoffice/api/list?kind=label&sort=scanned')).body.rows;
		expect(rows[0].scannedAt).toBeGreaterThan(Date.now() - 60_000);
		expect(rows[2].scannedAt).toBeNull();
		expect((await get(`/backoffice/api/object/${rows[0].id}`)).body.scannedAt).toBe(rows[0].scannedAt);
		// The scan is in the activity log.
		expect(await app.db.query(`select 1 from curator.catalog_inbox where kind = 'label.scanned'`)).toHaveLength(1);
	});

	it('refuses writes, bad input and paths outside /backoffice', async () => {
		const { handler, get } = await seeded();
		expect(await handler(new Request('http://127.0.0.1/trpc/x'))).toBeNull();
		expect((await handler(new Request('http://127.0.0.1/backoffice/api/list?kind=label', { method: 'POST' })))!.status).toBe(405);
		expect((await get('/backoffice/api/list?kind=release')).status).toBe(400);
		expect((await get('/backoffice/api/object/nope')).status).toBe(400);
		expect((await get('/backoffice/api/object/00000000-0000-0000-0000-000000000000')).status).toBe(404);
		const page = await handler(new Request('http://127.0.0.1/backoffice'));
		expect(page!.headers.get('content-type')).toMatch(/text\/html/);
	});
});
