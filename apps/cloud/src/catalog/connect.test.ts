// "Help us connect the dots": what a user is asked, and what the catalogue
// does with each answer — attached when the cloud can back it, with the
// operator when it cannot, refused when the page is someone else's. Made-up names.

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '@curator/catalog-readers';
import type { CatalogClaim } from '@curator/protocol';
import { withSystemTx } from '../db/system-tx.js';
import { createTestApp, type TestApp } from '../test/harness.js';
import { openReview } from './admin.js';
import { decideInbox, listInbox } from './inbox.js';
import { ingestClaims } from './ingest.js';

const artist = (id: string, name: string): CatalogClaim => ({ provider: 'spotify', kind: 'artist', providerId: id, name, url: `https://open.spotify.com/artist/${id}` });
const release = (id: string, title: string, by: CatalogClaim): CatalogClaim => ({ provider: 'spotify', kind: 'release', providerId: id, name: title, facts: { releaseDate: '2026-03-01' }, artists: [by] });

const IVO = artist('sp-ivo', 'Ivo Lark');
const TITLES = ['Glass Rivers', 'Drift', 'Northern Line'];

// Deezer's album list per artist id; anything else does not answer.
const deezer = (albums: Record<string, string[]>): FetchLike => async (url) => {
	const u = new URL(String(url));
	const m = /^\/artist\/(\d+)\/albums$/.exec(u.pathname);
	if (u.hostname === 'api.deezer.com' && m) return new Response(JSON.stringify({ data: (albums[m[1]!] ?? []).map((title) => ({ title })) }), { status: 200, headers: { 'content-type': 'application/json' } });
	return new Response('not found', { status: 404 });
};

async function setup(albums: Record<string, string[]> = {}) {
	const app = await createTestApp();
	app.deps.connectFetch = deezer(albums);
	const fan = await app.signIn();
	const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: IVO, source: 'manual' });
	await withSystemTx(app.db, (tx) => ingestClaims(tx, TITLES.map((t, i) => release(`sp-r${i}`, t, IVO)), { reason: 'tracker' }));
	return { app, fan, ivo: w.watch.object.id };
}

const handles = async (app: TestApp, objectId: string) =>
	(await app.db.query<{ h: string }>(`select provider || ':' || provider_id as h from curator.catalog_source_object where object_id = $1 order by 1`, [objectId])).map((r) => r.h);
const inbox = async (app: TestApp, kind: string) => (await withSystemTx(app.db, (tx) => listInbox(tx, { status: 'all', kind }))).rows;
const answer = (fan: Awaited<ReturnType<TestApp['signIn']>>, objectId: string, provider: 'deezer' | 'beatport' | 'spotify' | 'soundcloud', url: string | undefined, verdict: 'is' | 'not' | 'none' = 'is') =>
	fan.api.catalog.connectAnswer.mutate({ deviceId: fan.deviceId, answers: [{ objectId, provider, verdict, ...(url ? { url } : {}) }] }).then((r) => r.results[0]!);

describe('connect the dots', () => {
	it('asks about a followed artist’s unmapped stores, with the candidates the finders left open', async () => {
		const { app, fan, ivo } = await setup();
		await withSystemTx(app.db, (tx) => openReview(tx, { kind: 'artist_link', objectId: ivo, candidates: [{ provider: 'deezer', providerId: '111', name: 'Ivo Lark', url: 'https://www.deezer.com/artist/111', releases: ['Drift'] }, { provider: 'deezer', providerId: '222', name: 'Ivo Lark', url: 'https://www.deezer.com/artist/222' }] }));
		const q = await fan.api.catalog.connectQueue.mutate({ deviceId: fan.deviceId });
		expect(q.total).toBe(1);
		const [item] = q.items;
		expect(item!.object.id).toBe(ivo);
		expect(item!.titles.sort()).toEqual([...TITLES].sort());
		// Spotify is held; the rest of an artist's stores are asked.
		expect(item!.missing.map((m) => m.provider)).toEqual(['beatport', 'soundcloud', 'bandcamp', 'deezer', 'tidal']);
		expect(item!.missing.find((m) => m.provider === 'deezer')!.candidates.map((c) => `${c.providerId}:${c.source}`)).toEqual(['111:cloud', '222:cloud']);
		// "Not this one" takes a candidate out of this user's list; "none of
		// these" takes the store out of their queue, until they open the artist.
		expect((await answer(fan, ivo, 'deezer', 'https://www.deezer.com/artist/222', 'not')).outcome).toBe('noted');
		expect((await answer(fan, ivo, 'beatport', undefined, 'none')).outcome).toBe('noted');
		const again = (await fan.api.catalog.connectQueue.mutate({ deviceId: fan.deviceId })).items[0]!;
		expect(again.missing.map((m) => m.provider)).toEqual(['soundcloud', 'bandcamp', 'deezer', 'tidal']);
		expect(again.missing.find((m) => m.provider === 'deezer')!.candidates.map((c) => c.providerId)).toEqual(['111']);
		const named = (await fan.api.catalog.connectQueue.mutate({ deviceId: fan.deviceId, objectIds: [ivo] })).items[0]!;
		expect(named.missing.map((m) => m.provider)).toContain('beatport');
	});

	it('attaches a page whose own releases the cloud reads and finds shared, with an undo', async () => {
		const { app, fan, ivo } = await setup({ '111': ['Glass Rivers', 'Drift (Remixes)', 'Northern Line'] });
		expect(await answer(fan, ivo, 'deezer', 'https://www.deezer.com/en/artist/111')).toEqual({ outcome: 'attached' });
		expect(await handles(app, ivo)).toEqual(['deezer:111', 'spotify:sp-ivo']);
		const [log] = await inbox(app, 'connect.attach');
		expect(log).toMatchObject({ actor: 'user', undo: { op: 'unlinkPage', args: { kind: 'artist' } }, evidence: { shared: ['Glass Rivers', 'Northern Line'], trusted: false } });
		// Asked again, it is already theirs; and Deezer is no longer missing.
		expect((await answer(fan, ivo, 'deezer', 'https://www.deezer.com/artist/111')).outcome).toBe('already');
		expect((await fan.api.catalog.connectQueue.mutate({ deviceId: fan.deviceId })).items[0]!.missing.map((m) => m.provider)).not.toContain('deezer');
		// The operator's undo takes it off and rules it out.
		await withSystemTx(app.db, (tx) => decideInbox(tx, log!.id, { action: 'reject', by: 'guy' }));
		expect(await handles(app, ivo)).toEqual(['spotify:sp-ivo']);
		expect(await answer(fan, ivo, 'deezer', 'https://www.deezer.com/artist/111')).toEqual({ outcome: 'conflict', reason: 'ruled_out' });
	});

	it('leaves an answer it cannot back with the operator: one click attaches, a reject rules the page out', async () => {
		// One shared title is a namesake's coincidence; what the device says it read counts for nothing.
		const { app, fan, ivo } = await setup({ '111': ['Drift', 'Someone Else’s Album'] });
		const r = await fan.api.catalog.connectAnswer.mutate({ deviceId: fan.deviceId, answers: [{ objectId: ivo, provider: 'deezer', verdict: 'is', url: 'https://www.deezer.com/artist/111', releases: TITLES }, { objectId: ivo, provider: 'beatport', verdict: 'is', url: 'https://www.beatport.com/artist/ivo-lark/900' }] });
		expect(r.results.map((x) => x.outcome)).toEqual(['waiting', 'waiting']);
		expect(await handles(app, ivo)).toEqual(['spotify:sp-ivo']);
		const other = await app.signIn();
		expect((await answer(other, ivo, 'deezer', 'https://www.deezer.com/artist/111')).outcome).toBe('waiting');
		const held = await inbox(app, 'connect.link');
		expect(held).toHaveLength(2);
		const dz = held.find((i) => i.title.includes('deezer:111'))!;
		const bp = held.find((i) => i.title.includes('beatport:900'))!;
		expect(dz).toMatchObject({ severity: 'approval', status: 'open', evidence: { votes: 2, shared: ['Drift'], deviceRead: TITLES } });
		await withSystemTx(app.db, (tx) => decideInbox(tx, dz.id, { action: 'approve', by: 'guy' }));
		await withSystemTx(app.db, (tx) => decideInbox(tx, bp.id, { action: 'reject', by: 'guy' }));
		expect(await handles(app, ivo)).toEqual(['deezer:111', 'spotify:sp-ivo']);
		expect(await answer(other, ivo, 'beatport', 'https://www.beatport.com/artist/ivo-lark/900')).toEqual({ outcome: 'conflict', reason: 'ruled_out' });
	});

	it('never moves a page that is another artist’s, and holds a second id of a store the artist is on', async () => {
		const { app, fan, ivo } = await setup({ '333': TITLES });
		const twin = (await withSystemTx(app.db, (tx) => ingestClaims(tx, [{ provider: 'deezer', kind: 'artist', providerId: '111', name: 'Ivo Lark' }], { reason: 'tracker' }))).outcomes[0]!.objectId;
		expect(twin).not.toBe(ivo);
		expect(await answer(fan, ivo, 'deezer', 'https://www.deezer.com/artist/111')).toEqual({ outcome: 'conflict', reason: 'held_by_another' });
		expect(await handles(app, twin)).toEqual(['deezer:111']);
		const [notice] = await inbox(app, 'connect.conflict');
		expect(notice).toMatchObject({ severity: 'notice' });
		expect([...notice!.subjects].sort()).toEqual([ivo, twin].sort());
		// Two Spotify ids on one artist is Spotify saying two people: asked, however well it overlaps.
		await app.db.query(`insert into curator.admin_user (user_id) values ($1)`, [fan.userId]);
		expect((await answer(fan, ivo, 'spotify', 'https://open.spotify.com/artist/1yatuhSYBeceXdDRg67hrm')).outcome).toBe('waiting');
	});

	it('takes a trusted account at its word, for pages the cloud cannot read and for albums', async () => {
		const { app, fan, ivo } = await setup();
		await app.db.query(`insert into curator.admin_user (user_id) values ($1)`, [fan.userId]);
		expect((await answer(fan, ivo, 'beatport', 'https://www.beatport.com/artist/ivo-lark/900')).outcome).toBe('attached');
		expect(await handles(app, ivo)).toEqual(['beatport:900', 'spotify:sp-ivo']);
		expect((await answer(fan, ivo, 'deezer', 'https://www.deezer.com/artist/222', 'not')).outcome).toBe('noted');
		await app.db.query(`delete from curator.admin_user`);
		expect(await answer(fan, ivo, 'deezer', 'https://www.deezer.com/artist/222')).toEqual({ outcome: 'conflict', reason: 'ruled_out' });
		// An album enters only by name; its Deezer page is attached as a release page.
		await app.db.query(`insert into curator.admin_user (user_id) values ($1)`, [fan.userId]);
		const [album] = await app.db.query<{ object_id: string }>(`select object_id from curator.catalog_source_object where provider = 'spotify' and provider_id = 'sp-r0'`);
		const q = await fan.api.catalog.connectQueue.mutate({ deviceId: fan.deviceId, objectIds: [album!.object_id] });
		expect(q.items[0]).toMatchObject({ detail: 'Ivo Lark · 2026-03-01', missing: [{ provider: 'beatport' }, { provider: 'deezer' }, { provider: 'tidal' }] });
		expect((await answer(fan, album!.object_id, 'deezer', 'https://www.deezer.com/album/5150')).outcome).toBe('attached');
		expect(await handles(app, album!.object_id)).toEqual(['deezer:5150', 'spotify:sp-r0']);
	});

	it('searches SoundCloud for a device with the app’s credentials, and says when it has none', async () => {
		const { app, fan } = await setup();
		expect(await fan.api.catalog.connectSearch.mutate({ deviceId: fan.deviceId, provider: 'soundcloud', kind: 'artist', name: 'Ivo Lark' })).toEqual({ candidates: [], searched: false });
		const asked: string[] = [];
		app.deps.connectSoundcloud = {
			searchUsers: async (q) => {
				asked.push(q);
				return [{ id: 9001, username: 'Ivo Lark', permalink_url: 'https://soundcloud.com/ivo-lark', avatar_url: 'https://img.example/sc.jpg', followers_count: 12400, track_count: 31, city: 'Leeds' }, { id: 9002, username: 'No Page' }];
			},
		};
		const r = await fan.api.catalog.connectSearch.mutate({ deviceId: fan.deviceId, provider: 'soundcloud', kind: 'artist', name: 'Ivo Lark' });
		expect(asked).toEqual(['Ivo Lark']);
		expect(r).toEqual({ searched: true, candidates: [{ provider: 'soundcloud', providerId: '9001', name: 'Ivo Lark', url: 'https://soundcloud.com/ivo-lark', imageUrl: 'https://img.example/sc.jpg', followers: 12400, detail: 'Leeds · 31 tracks', source: 'search' }] });
	});

	it('refuses a link that is not that store’s page of that kind', async () => {
		const { fan, ivo } = await setup();
		expect(await answer(fan, ivo, 'beatport', 'https://www.beatport.com/label/northfold/804')).toEqual({ outcome: 'invalid', reason: 'that_is_a_label_page' });
		expect(await answer(fan, ivo, 'beatport', 'https://www.deezer.com/artist/111')).toEqual({ outcome: 'invalid', reason: 'not_a_page_of_that_store' });
		expect(await answer(fan, ivo, 'deezer', undefined)).toEqual({ outcome: 'invalid', reason: 'not_a_page_of_that_store' });
		expect((await answer(fan, '00000000-0000-4000-8000-000000000000', 'deezer', 'https://www.deezer.com/artist/111')).outcome).toBe('invalid');
	});
});
