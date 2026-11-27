// Device work reported through the API, as a signed-in device sends it
// (catalog.tracks hands the work, catalog.workReport takes what was read):
// what is kept, what is refused, what is remembered, who is recorded, and
// what is announced.

import type { CatalogClaim, CatalogDeviceProfile, CatalogJob, CatalogTrackerPoll, CatalogWorkReportResult } from '@curator/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { withSystemTx } from '../../db/system-tx.js';
import { createTestApp, type TestApp } from '../../test/harness.js';
import { ingestClaims } from '../ingest.js';
import { pageTracks } from '../pages.js';
import { setWorkSetting } from './settings.js';

const PROFILE: CatalogDeviceProfile = { form: 'phone', reader: 1, stores: ['spotify', 'deezer', 'beatport', 'bandcamp'], visit: { id: 'visit-0001', round: 0, taken: 0 } };
const MARSH: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Marsh' };
const recent = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);

function release(provider: CatalogClaim['provider'], id: string, title: string, o: { date?: string; tracks?: [string, number][]; label?: CatalogClaim; artists?: CatalogClaim[] } = {}): CatalogClaim {
	return {
		provider,
		kind: 'release',
		providerId: id,
		name: title,
		url: `https://example.test/${provider}/${id}`,
		facts: { releaseDate: o.date ?? '2026-01-01' },
		artists: o.artists ?? [MARSH],
		...(o.label ? { label: o.label } : {}),
		recordings: (o.tracks ?? []).map(([t, sec], i) => ({ provider, kind: 'recording', providerId: `${id}-t${i + 1}`, name: t, facts: { trackNumber: i + 1, durationSec: sec } })),
	};
}

const LAILONIE = release('spotify', 'sr1', 'Lailonie', { date: '2026-03-01', tracks: [['Lailonie', 300], ['Eu Topos', 410]] });
const poll = (children: CatalogClaim[], more = false): CatalogTrackerPoll => ({ children, listingHash: more ? 'pending:1' : 'h1', cursor: { seen: children.map((c) => c.providerId) }, calls: 1 });

let app: TestApp;
let api: Awaited<ReturnType<TestApp['signIn']>>['api'];
let deviceId: string;

beforeEach(async () => {
	app = await createTestApp();
	({ api, deviceId } = await app.signIn());
	await withSystemTx(app.db, async (tx) => {
		await ingestClaims(tx, [LAILONIE], { reason: 'tracker' });
		await setWorkSetting(tx, 'work.enabled', true);
	});
});

const idOf = async (kind: string, name: string) => (await app.db.query<{ id: string }>(`select id from curator.catalog_object where kind = $1 and name = $2`, [kind, name]))[0]!.id;
const work = async (id: string, profile = PROFILE): Promise<CatalogJob[]> => (await api.catalog.tracks.query({ deviceId, id, profile })).work?.jobs ?? [];
const report = (results: unknown[], key = `visit-0001:${Math.random()}`, profile = PROFILE): Promise<CatalogWorkReportResult> => api.catalog.workReport.mutate({ deviceId, idempotencyKey: key, profile, results, calls: { spotify: 2 } });

describe('a find', () => {
	it("keeps what the artist's page lists, announces the new release to its followers, and hands its completion back", async () => {
		const marsh = await idOf('artist', 'Marsh');
		await api.catalog.watch.mutate({ deviceId, objectId: marsh, source: 'manual' });
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		expect(find.id).toBe(`find:${marsh}:spotify:sa1`);

		const fresh = release('spotify', 'sr9', 'Glass Rivers', { date: recent });
		const r = await report([{ jobId: find.id, kind: 'find', poll: poll([LAILONIE, fresh]) }]);
		expect(r.results).toEqual([{ jobId: find.id, outcome: 'saved' }]);
		const glass = await idOf('release', 'Glass Rivers');
		expect(r.changed).toEqual(expect.arrayContaining([marsh, glass]));
		// The new release, bare from the listing, is the next round's work: its tracklist at Spotify.
		const next = r.work!.jobs.find((j) => j.id === `release:${glass}`) as Extract<CatalogJob, { kind: 'release' }>;
		expect(next.read.map((h) => [h.provider, h.id])).toEqual([['spotify', 'sr9']]);
		expect(r.work!.jobs.some((j) => j.kind === 'find')).toBe(false);

		// Announced at once; the weekly reading's own memory untouched.
		const events = await app.db.query<{ raised_by: string }>(`select raised_by from curator.catalog_event where dedupe_key = $1`, [`release:${glass}`]);
		expect(events).toEqual([{ raised_by: `device:${deviceId}` }]);
		const cursors = await app.db.query<{ cursor: string; last_run_at: unknown }>(`select cursor::text as cursor, last_run_at from curator.catalog_cursor where object_id = $1`, [marsh]);
		expect(cursors.every((c) => c.cursor === '{}' && c.last_run_at === null)).toBe(true);

		// Remembered: no device is asked for the listing again this week, and the cursor is kept.
		const state = await app.db.query<{ outcome: string; cursor: string }>(`select outcome, cursor::text as cursor from curator.catalog_work_state where object_id = $1 and job = 'find'`, [marsh]);
		expect(state.map((s) => ({ outcome: s.outcome, cursor: JSON.parse(s.cursor) as unknown }))).toEqual([{ outcome: 'ok', cursor: { seen: ['sr1', 'sr9'] } }]);
		expect((await work(marsh)).some((j) => j.kind === 'find')).toBe(false);
		// Who said so: of what the report put in. A release it only listed again is no one's doing.
		const items = await app.db.query<{ device_id: string; provider_id: string; outcome: string }>(
			`select r.device_id, i.provider_id, i.outcome from curator.catalog_work_item i join curator.catalog_work_report r on r.id = i.report_id order by i.provider_id`,
		);
		expect(items).toEqual([{ device_id: deviceId, provider_id: 'sr9', outcome: 'created' }]);
		// The calls count against the day.
		expect(await app.db.query(`select units_used from curator.provider_budget where provider = 'spotify'`)).toEqual([{ units_used: 2 }]);
	});

	it('announces nothing for an artist nobody follows', async () => {
		const marsh = await idOf('artist', 'Marsh');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		await report([{ jobId: find.id, kind: 'find', poll: poll([release('spotify', 'sr9', 'Glass Rivers', { date: recent })]) }]);
		expect(await app.db.query(`select 1 from curator.catalog_event`)).toEqual([]);
	});

	it('reads on next round while the listing left releases unread', async () => {
		const marsh = await idOf('artist', 'Marsh');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		const r = await report([{ jobId: find.id, kind: 'find', poll: poll([LAILONIE], true) }]);
		expect(r.work!.jobs.find((j) => j.kind === 'find')).toMatchObject({ id: find.id, page: { cursor: { seen: ['sr1'] } } });
	});

	it("is refused for a page the catalogue did not ask for", async () => {
		const marsh = await idOf('artist', 'Marsh');
		await work(marsh);
		const r = await report([{ jobId: `find:${marsh}:spotify:namesake`, kind: 'find', poll: poll([release('spotify', 'sx1', 'Someone Else')]) }]);
		expect(r.results[0]).toMatchObject({ outcome: 'refused', note: 'not a page the catalogue asked for' });
		expect(await app.db.query(`select 1 from curator.catalog_object where name = 'Someone Else'`)).toEqual([]);
	});

	it("brings an artist the catalogue did not hold in by its own page", async () => {
		const r = await api.catalog.resolve.mutate({ deviceId, refs: [{ provider: 'spotify', kind: 'artist', providerId: 'nv1' }], profile: PROFILE });
		const find = r.work!.jobs[0]!;
		expect(find.id).toBe('find:new:spotify:nv1');
		const nox: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'nv1', name: 'Nox Vahn' };
		const out = await report([{ jobId: find.id, kind: 'find', poll: poll([release('spotify', 'sn1', 'Brainwasher', { artists: [nox] })]) }]);
		expect(out.results[0]!.outcome).toBe('saved');
		expect(out.changed).toContain(await idOf('artist', 'Nox Vahn'));
		// Recorded: the page this report brought in, and its release.
		expect(await app.db.query(`select kind, provider_id, outcome from curator.catalog_work_item order by kind`)).toEqual([
			{ kind: 'artist', provider_id: 'nv1', outcome: 'created' },
			{ kind: 'release', provider_id: 'sn1', outcome: 'created' },
		]);
	});
});

describe('a release', () => {
	it('is linked to a page on another store only when the cloud confirms the tracklists', async () => {
		const id = await idOf('release', 'Lailonie');
		const job = `release:${id}`;
		const same = release('deezer', 'dz1', 'Lailonie', { tracks: [['Lailonie (Original Mix)', 301], ['Eu Topos', 409]] });
		const r = await report([{ jobId: job, kind: 'release', found: [{ how: 'tracklist', claim: same }], notFound: ['beatport'], checks: [] }]);
		expect(r.results).toEqual([{ jobId: job, outcome: 'saved' }]);
		expect(await app.db.query(`select provider from curator.catalog_source_object where object_id = $1 and kind = 'release' order by provider`, [id])).toEqual([{ provider: 'deezer' }, { provider: 'spotify' }]);
		// Tidal and Apple are the cloud's to ask next.
		expect(await app.db.query(`select release_id from curator.catalog_work_followup`)).toEqual([{ release_id: id }]);
		// Beatport did not have it: not asked again before its retry age.
		const marsh = await idOf('artist', 'Marsh');
		const asked = (await work(marsh)).find((j) => j.id === job) as Extract<CatalogJob, { kind: 'release' }> | undefined;
		expect(asked?.find ?? []).toEqual([]);
	});

	it('is not linked to a page whose tracklist the cloud cannot confirm, and the store rests', async () => {
		const id = await idOf('release', 'Lailonie');
		const job = `release:${id}`;
		// Same title, another release: a compilation carrying one of its tracks.
		const other = release('deezer', 'dz2', 'Lailonie', { tracks: [['Lailonie', 300], ['Other', 200], ['More', 250], ['And More', 260]] });
		const r = await report([{ jobId: job, kind: 'release', found: [{ how: 'tracklist', claim: other }], notFound: [], checks: [] }]);
		expect(r.results).toEqual([{ jobId: job, outcome: 'unconfirmed' }]);
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'deezer'`)).toEqual([]);
		const marsh = await idOf('artist', 'Marsh');
		const asked = (await work(marsh)).find((j) => j.id === job) as Extract<CatalogJob, { kind: 'release' }> | undefined;
		expect(asked?.find ?? []).not.toContain('deezer');
	});

	it("does not lay another tracklist over the one it has, though it comes as its own page's: the link stays and the operator is asked", async () => {
		const id = await idOf('release', 'Lailonie');
		const other = { ...release('spotify', 'sr1', 'Lailonie', { tracks: [['Something', 100], ['Else', 120]] }), label: { provider: 'spotify' as const, kind: 'label' as const, providerId: 'evil', name: 'Evil Label' } };
		const r = await report([{ jobId: `release:${id}`, kind: 'release', found: [{ how: 'id', claim: other }], notFound: [], checks: [] }]);
		expect(r.results[0]!.outcome).toBe('unconfirmed');
		const page = await withSystemTx(app.db, async (tx) => pageTracks(tx, id));
		expect(page!.releases[0]!.tracks.map((t) => t.title)).toEqual(['Lailonie', 'Eu Topos']);
		expect(await app.db.query(`select 1 from curator.catalog_object where name = 'Evil Label'`)).toEqual([]);
		expect(await app.db.query(`select provider from curator.catalog_source_object where object_id = $1 and kind = 'release'`, [id])).toEqual([{ provider: 'spotify' }]);
		expect(await app.db.query(`select kind from curator.catalog_inbox`)).toEqual([{ kind: 'work.link' }]);
		// Not read again before its confirmation is due.
		expect(await app.db.query(`select outcome from curator.catalog_work_state where object_id = $1 and job = 'check'`, [id])).toEqual([{ outcome: 'disagrees' }]);
	});
});

describe('facts', () => {
	it("are kept on a track of the release named, from the store's own track page", async () => {
		const id = await idOf('release', 'Lailonie');
		const track = await idOf('recording', 'Eu Topos');
		const other = await idOf('recording', 'Lailonie');
		const claim = (rec: string, name: string, sec: number): unknown => ({ recordingId: rec, claim: { provider: 'beatport', kind: 'recording', providerId: `bp-${name}`, name, url: `https://www.beatport.com/track/x/${name}`, facts: { durationSec: sec, bpm: 122, key: 'A Minor' } } });
		const r = await report([{ jobId: `facts:${id}`, kind: 'facts', rows: [claim(track, 'Eu Topos', 410)], notFound: [{ recordingId: other, store: 'beatport' }] }]);
		expect(r.results).toEqual([{ jobId: `facts:${id}`, outcome: 'saved' }]);
		const page = await withSystemTx(app.db, async (tx) => pageTracks(tx, id));
		expect(page!.releases[0]!.tracks.map((t) => [t.title, t.bpm])).toEqual([['Lailonie', null], ['Eu Topos', 122]]);
		expect(await app.db.query(`select outcome from curator.catalog_work_state where object_id = $1 and job = 'facts'`, [other])).toEqual([{ outcome: 'not_found' }]);
	});
});

describe('the report itself', () => {
	it('answers a resend with its first answer, and keeps nothing twice', async () => {
		const marsh = await idOf('artist', 'Marsh');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		const body = [{ jobId: find.id, kind: 'find', poll: poll([release('spotify', 'sr9', 'Glass Rivers')]) }];
		const a = await report(body, 'visit-0001:same');
		const b = await report(body, 'visit-0001:same');
		expect(b).toEqual(a);
		expect(await app.db.query(`select count(*)::int as n from curator.catalog_work_report`)).toEqual([{ n: 1 }]);
	});

	it('takes the same job from two devices, the second finding it kept', async () => {
		const marsh = await idOf('artist', 'Marsh');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		const other = await app.signIn();
		const body = [{ jobId: find.id, kind: 'find', poll: poll([release('spotify', 'sr9', 'Glass Rivers')]) }];
		await report(body);
		const second = await other.api.catalog.workReport.mutate({ deviceId: other.deviceId, idempotencyKey: 'other-0001', profile: PROFILE, results: body });
		expect(second.results[0]!.outcome).toBe('saved');
		expect(await app.db.query(`select count(*)::int as n from curator.catalog_object where name = 'Glass Rivers'`)).toEqual([{ n: 1 }]);
	});

	it('refuses everything while device work is off, and a result it cannot read costs that one alone', async () => {
		const id = await idOf('release', 'Lailonie');
		const r = await report([{ jobId: `release:${id}`, kind: 'release', found: [], notFound: ['beatport'], checks: [] }, { jobId: 'x', kind: 'nonsense' }]);
		expect(r.results.map((x) => x.outcome)).toEqual(['kept', 'refused']);
		await withSystemTx(app.db, (tx) => setWorkSetting(tx, 'work.enabled', false));
		const before = await app.db.query(`select id from curator.catalog_work_report`);
		const off = await report([{ jobId: `release:${id}`, kind: 'release', found: [], notFound: ['deezer'], checks: [] }]);
		expect(off.results).toEqual([{ jobId: `release:${id}`, outcome: 'refused', note: 'device work is off' }]);
		// Nothing is written while it is off: not the report either.
		expect(await app.db.query(`select id from curator.catalog_work_report`)).toEqual(before);
	});
});

describe("a label's probe", () => {
	it('keeps nothing of a page that lists other things, and the page is not named again', async () => {
		const BP: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '111', name: 'Monada' };
		await withSystemTx(app.db, (tx) => ingestClaims(tx, Array.from({ length: 6 }, (_, i) => release('beatport', `bp${i}`, `Monada ${i}`, { label: BP, tracks: [['A', 300]] })), { reason: 'tracker' }));
		const label = await idOf('label', 'Monada');
		await app.db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'bandcamp', 'label', '222', null)`, [label]);
		const finds = (await work(label)).filter((j) => j.kind === 'find');
		const probe = finds.find((j) => j.page?.provider === 'bandcamp')!;
		expect(probe).toMatchObject({ page: { probe: true } });
		const BC: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '222', name: 'Monada' };
		const cuarteto = { jobId: probe.id, kind: 'find', poll: poll(Array.from({ length: 8 }, (_, i) => release('bandcamp', `bc${i}`, `Cuarteto ${i}`, { label: BC }))) };
		// Alone it is compared with nothing — the label's Beatport page has not been read, and
		// what the catalogue holds of it is a sample: nothing kept, nothing judged.
		const alone = await report([cuarteto]);
		expect(alone.results[0]).toMatchObject({ outcome: 'kept', note: 'its other page is read first' });
		expect(await app.db.query(`select 1 from curator.catalog_inbox`)).toEqual([]);
		// With the reference's listing in the same report (whichever came first), it is judged.
		const beatportListing = { jobId: finds.find((j) => j.page?.provider === 'beatport')!.id, kind: 'find', poll: poll(Array.from({ length: 6 }, (_, i) => release('beatport', `bp${i}`, `Monada ${i}`, { label: BP }))) };
		const r = await report([cuarteto, beatportListing]);
		expect(r.results.map((x) => x.outcome)).toEqual(['kept', 'saved']);
		expect(r.results[0]!.note).toBe('the page does not list what the label holds');
		expect(await app.db.query(`select 1 from curator.catalog_object where name like 'Cuarteto%'`)).toEqual([]);
		expect(await app.db.query(`select kind from curator.catalog_inbox`)).toEqual([{ kind: 'work.pages' }]);
		expect((await work(label)).some((j) => j.kind === 'find' && j.page?.provider === 'bandcamp')).toBe(false);
	});
});

// What a device may not do with a report, whatever it sends: each of these
// was a way in, found by review before anything shipped (2026-11-27).
describe('a report is taken at no more than its evidence', () => {
	const NOX: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'nv1', name: 'Nox Vahn' };

	it('refuses a "new" page the catalogue holds and would not name, and one its own listing does not name — keeping nothing of either', async () => {
		const marsh = await idOf('artist', 'Marsh');
		// Two Spotify pages on Marsh: neither is named, so neither may be reported.
		await app.db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'spotify', 'artist', 'namesake', null)`, [marsh]);
		const namesake: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'namesake', name: 'Marsh' };
		const r = await report([
			{ jobId: 'find:new:spotify:namesake', kind: 'find', poll: poll([release('spotify', 'sx1', 'Someone Else', { artists: [namesake] })]) },
			{ jobId: 'find:new:spotify:nv1', kind: 'find', poll: poll([release('spotify', 'sx2', 'Not Theirs', { artists: [MARSH] })]) },
			{ jobId: 'find:new:deezer:99', kind: 'find', poll: poll([release('deezer', 'dx1', 'Wrong Store', { artists: [{ provider: 'deezer', kind: 'artist', providerId: '99', name: 'X' }] })]) },
		]);
		expect(r.results.map((x) => [x.outcome, x.note])).toEqual([
			['refused', 'not a page the catalogue asked for'],
			['refused', 'the listing does not name the page'],
			['refused', 'the listing does not name the page'],
		]);
		expect(await app.db.query(`select name from curator.catalog_object where name in ('Someone Else', 'Not Theirs', 'Wrong Store')`)).toEqual([]);
		expect(await app.db.query(`select 1 from curator.catalog_work_item`)).toEqual([]);
	});

	it('takes a check only of a page the release has, and "not there" only of a store it is looked for at', async () => {
		const id = await idOf('release', 'Lailonie');
		const made = Array.from({ length: 5 }, (_, i) => ({ handle: { provider: 'tidal', id: `made-up-${i}`, url: null }, verdict: 'gone' }));
		const r = await report([{ jobId: `release:${id}`, kind: 'release', found: [], notFound: ['spotify', 'bandcamp', 'deezer'], checks: made }]);
		expect(r.results[0]).toMatchObject({ outcome: 'kept', note: '5 checks the catalogue did not ask for' });
		expect(await app.db.query(`select 1 from curator.catalog_inbox`)).toEqual([]);
		// Spotify it is on, Bandcamp nobody looks at: only Deezer's answer is kept.
		expect(await app.db.query(`select job, provider, outcome from curator.catalog_work_state where object_id = $1`, [id])).toEqual([{ job: 'release', provider: 'deezer', outcome: 'not_found' }]);
	});

	it("puts facts on the track the row names or on none: not on the track another store id belongs to, nor from a page that is not the store's", async () => {
		const id = await idOf('release', 'Lailonie');
		const first = await idOf('recording', 'Lailonie');
		const second = await idOf('recording', 'Eu Topos');
		const row = (rec: string, storeId: string, name: string, sec: number, bpm: number, url = `https://www.beatport.com/track/x/${storeId}`): unknown => ({ recordingId: rec, claim: { provider: 'beatport', kind: 'recording', providerId: storeId, name, url, facts: { durationSec: sec, bpm, key: 'A Minor' } } });
		await report([{ jobId: `facts:${id}`, kind: 'facts', rows: [row(first, 'bp-1', 'Lailonie', 300, 122)], notFound: [] }]);
		// bp-1 is the first track's: a row naming the second track with it would land on the first.
		const r = await report([{ jobId: `facts:${id}`, kind: 'facts', rows: [row(second, 'bp-1', 'Lailonie', 300, 140), row(second, 'bp-2', 'Eu Topos', 410, 128, 'https://evil.example/x')], notFound: [] }]);
		expect(r.results[0]).toMatchObject({ outcome: 'kept', note: expect.stringContaining('2 rows') });
		const page = await withSystemTx(app.db, async (tx) => pageTracks(tx, id));
		expect(page!.releases[0]!.tracks.map((t) => [t.title, t.bpm])).toEqual([['Lailonie', 122], ['Eu Topos', null]]);
		// Answered: Beatport is not asked for the first track again before its age.
		expect(await app.db.query(`select outcome from curator.catalog_work_state where object_id = $1 and job = 'facts'`, [first])).toEqual([{ outcome: 'ok' }]);
	});

	it('counts the calls a report states only up to what its results could have taken, and none while it is off', async () => {
		const send = (key: string) => api.catalog.workReport.mutate({ deviceId, idempotencyKey: key, profile: PROFILE, results: [], calls: { spotify: 100_000, traxsource: 100_000 } });
		await send('calls-0001');
		// Ten for a report with no results; Traxsource is not a store this device reads.
		expect(await app.db.query(`select provider, units_used from curator.provider_budget order by provider`)).toEqual([{ provider: 'spotify', units_used: 10 }]);
		await withSystemTx(app.db, (tx) => setWorkSetting(tx, 'work.enabled', false));
		await send('calls-0002');
		expect(await app.db.query(`select units_used from curator.provider_budget where provider = 'spotify'`)).toEqual([{ units_used: 10 }]);
	});

	it('hands a page read on with the hint its first read carried, and not without it', async () => {
		// A label whose two pages list different things: only the page the device's own library names is read.
		const BP: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '111', name: 'Monada' };
		const BC: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '222', name: 'Monada' };
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [
				...Array.from({ length: 6 }, (_, i) => release('beatport', `bp${i}`, `Monada ${i}`, { label: BP, tracks: [['A', 300]] })),
				...Array.from({ length: 8 }, (_, i) => release('bandcamp', `bc${i}`, `Cuarteto ${i}`, { label: BC, tracks: [['A', 300]], artists: [{ provider: 'bandcamp', kind: 'artist', providerId: 'bcx', name: 'Monada (AR)' }] })),
			], { reason: 'tracker' }),
		);
		const label = await idOf('label', 'Monada');
		// Both pages read, long enough ago to be due again: two listings that disagree.
		await app.db.query(`insert into curator.catalog_work_state (object_id, job, provider, provider_id, outcome, answered_at) values ($1, 'find', 'beatport', '111', 'ok', now() - interval '30 days'), ($1, 'find', 'bandcamp', '222', 'ok', now() - interval '30 days')`, [label]);
		const hints = [{ provider: 'beatport' as const, kind: 'label' as const, providerId: '111' }];
		const handed = (await api.catalog.tracks.query({ deviceId, id: label, profile: PROFILE, hints })).work!.jobs.find((j) => j.kind === 'find')!;
		expect(handed.id).toBe(`find:${label}:beatport:111`);
		const listing = poll([release('beatport', 'bp0', 'Monada 0', { label: BP })], true);
		const without = await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'hint-0001', profile: PROFILE, results: [{ jobId: handed.id, kind: 'find', poll: listing }] });
		expect(without.results[0]).toMatchObject({ outcome: 'refused', note: 'not a page the catalogue asked for' });
		const withHint = await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'hint-0002', profile: PROFILE, hints, results: [{ jobId: handed.id, kind: 'find', poll: listing }] });
		expect(withHint.results[0]!.outcome).toBe('saved');
		expect(withHint.work!.jobs.find((j) => j.kind === 'find')).toMatchObject({ id: handed.id, page: { cursor: { seen: ['bp0'] } } });
	});

	it("brings in what a new page's own listing names, once, when two devices report it", async () => {
		const body = [{ jobId: 'find:new:spotify:nv1', kind: 'find', poll: poll([release('spotify', 'sn1', 'Brainwasher', { artists: [NOX] })]) }];
		const other = await app.signIn();
		const [a, b] = await Promise.all([report(body), other.api.catalog.workReport.mutate({ deviceId: other.deviceId, idempotencyKey: 'other-0002', profile: PROFILE, results: body })]);
		expect([a.results[0]!.outcome, b.results[0]!.outcome]).toEqual(['saved', 'saved']);
		expect(await app.db.query(`select count(*)::int as n from curator.catalog_object where name in ('Nox Vahn', 'Brainwasher')`)).toEqual([{ n: 2 }]);
	});
});

describe('a release, read and looked for', () => {
	const bare = release('spotify', 'sr7', 'Bare Listing', { date: '2026-05-01' });
	const full = release('spotify', 'sr7', 'Bare Listing', { date: '2026-05-01', tracks: [['One', 200], ['Two', 240]] });
	const elsewhere = release('deezer', 'dz7', 'Bare Listing', { tracks: [['One', 201], ['Two', 239]] });

	it('is compared with its own tracklist whichever the device sent first, and queued for the stores the cloud asks', async () => {
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [bare], { reason: 'tracker' }));
		const id = await idOf('release', 'Bare Listing');
		const r = await report([{ jobId: `release:${id}`, kind: 'release', found: [{ how: 'tracklist', claim: elsewhere }, { how: 'id', claim: full }], notFound: [], checks: [] }]);
		expect(r.results).toEqual([{ jobId: `release:${id}`, outcome: 'saved' }]);
		expect(await app.db.query(`select provider from curator.catalog_source_object where object_id = $1 and kind = 'release' order by provider`, [id])).toEqual([{ provider: 'deezer' }, { provider: 'spotify' }]);
		expect(await app.db.query(`select release_id from curator.catalog_work_followup`)).toEqual([{ release_id: id }]);
	});

	it('is not read again at a page that had no tracklist, nor asked of a store that just failed for it', async () => {
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [bare], { reason: 'tracker' }));
		const id = await idOf('release', 'Bare Listing');
		const marsh = await idOf('artist', 'Marsh');
		const job = async () => (await work(marsh)).find((j) => j.id === `release:${id}`) as Extract<CatalogJob, { kind: 'release' }> | undefined;
		expect((await job())!.read.map((h) => h.id)).toEqual(['sr7']);
		const r = await report([{ jobId: `release:${id}`, kind: 'release', found: [{ how: 'id', claim: bare }], notFound: [], checks: [] }]);
		expect(r.results[0]!.outcome).toBe('kept');
		expect(await job()).toBeUndefined();

		// A store that did not answer for a release with a tracklist rests for it too.
		const lailonie = await idOf('release', 'Lailonie');
		const failed = await report([{ jobId: `release:${lailonie}`, kind: 'error', store: 'deezer', message: 'HTTP 503', rateLimitedSec: null }]);
		expect(failed.results[0]).toMatchObject({ outcome: 'failed', note: 'deezer: HTTP 503' });
		const again = (await work(marsh)).find((j) => j.id === `release:${lailonie}`) as Extract<CatalogJob, { kind: 'release' }>;
		expect(again.find).not.toContain('deezer');
	});
});

describe("a label's two pages in one report", () => {
	it('keeps the probe that agrees and the page it was compared with, whichever came first', async () => {
		const BP: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '111', name: 'Monada' };
		const BC: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '222', name: 'Monada' };
		const beatport = Array.from({ length: 6 }, (_, i) => release('beatport', `bp${i}`, `Monada ${i}`, { label: BP, tracks: [['A', 300]] }));
		await withSystemTx(app.db, (tx) => ingestClaims(tx, beatport, { reason: 'tracker' }));
		const label = await idOf('label', 'Monada');
		await app.db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'bandcamp', 'label', '222', null)`, [label]);
		const finds = (await work(label)).filter((j): j is Extract<CatalogJob, { kind: 'find' }> => j.kind === 'find');
		expect(finds.map((j) => [j.page!.provider, j.page!.probe === true])).toEqual([['beatport', false], ['bandcamp', true]]);
		const r = await report([
			{ jobId: finds[1]!.id, kind: 'find', poll: poll([0, 1, 2].map((i) => release('bandcamp', `bc${i}`, `Monada ${i}`, { label: BC }))) },
			{ jobId: finds[0]!.id, kind: 'find', poll: poll(beatport) },
		]);
		expect(r.results.map((x) => x.outcome)).toEqual(['saved', 'saved']);
		// Both read now: neither is a probe at the next visit, and neither is due.
		expect((await work(label)).some((j) => j.kind === 'find')).toBe(false);
	});
});

describe('the read that hands the work out', () => {
	it('answers its page when its planner fails, without the work', async () => {
		const marsh = await idOf('artist', 'Marsh');
		await app.db.query(`alter table curator.catalog_work_state rename to catalog_work_state_away`);
		const page = await api.catalog.tracks.query({ deviceId, id: marsh, profile: PROFILE });
		expect(page.releases.map((r) => r.title)).toEqual(['Lailonie']);
		expect(page.work).toBeUndefined();
	});
});

describe("what a store is not asked", () => {
	it("takes Deezer's page for its tracklist, never for who the release is by", async () => {
		const id = await idOf('release', 'Lailonie');
		const namesake: CatalogClaim = { provider: 'deezer', kind: 'artist', providerId: '465319', name: 'Marsh (everyone of that name)' };
		const deezer = release('deezer', 'dz1', 'Lailonie', { tracks: [['Lailonie', 301], ['Eu Topos', 409]], artists: [namesake] });
		deezer.recordings = deezer.recordings!.map((t) => ({ ...t, artists: [namesake] }));
		const r = await report([{ jobId: `release:${id}`, kind: 'release', found: [{ how: 'tracklist', claim: deezer }], notFound: [], checks: [] }]);
		expect(r.results[0]!.outcome).toBe('saved');
		expect(await app.db.query(`select provider from curator.catalog_source_object where object_id = $1 and kind = 'release' order by provider`, [id])).toEqual([{ provider: 'deezer' }, { provider: 'spotify' }]);
		// Deezer's artist page of everyone of that name came nowhere near the catalogue.
		expect(await app.db.query(`select 1 from curator.catalog_source_object where provider = 'deezer' and kind = 'artist'`)).toEqual([]);
		expect(await app.db.query(`select name from curator.catalog_object where kind = 'artist' order by name`)).toEqual([{ name: 'Marsh' }]);
	});

	it('reads a page of the release once: read in full, it is remembered so', async () => {
		const id = await idOf('release', 'Lailonie');
		const r = await report([{ jobId: `release:${id}`, kind: 'release', found: [{ how: 'id', claim: LAILONIE }], notFound: [], checks: [] }]);
		expect(r.results[0]!.outcome).toBe('saved');
		expect(await app.db.query(`select provider, provider_id, outcome from curator.catalog_work_state where object_id = $1 and job = 'check'`, [id])).toEqual([{ provider: 'spotify', provider_id: 'sr1', outcome: 'read' }]);
	});
});

describe('a listing is the word of the page it was read from', () => {
	it('keeps and announces only the releases that credit the page, at its own store', async () => {
		const marsh = await idOf('artist', 'Marsh');
		await api.catalog.watch.mutate({ deviceId, objectId: marsh, source: 'manual' });
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		const stranger: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'zz9', name: 'Someone Else' };
		const theirs = release('spotify', 'sx1', 'Not Marsh', { date: recent, artists: [stranger] });
		const elsewhere = release('deezer', 'dx1', 'Deezer Thing', { date: recent, artists: [{ provider: 'deezer', kind: 'artist', providerId: '1', name: 'Marsh' }] });
		const only = await report([{ jobId: find.id, kind: 'find', poll: poll([theirs, elsewhere]) }]);
		expect(only.results[0]).toMatchObject({ outcome: 'refused', note: 'the listing is of another page' });
		const mixed = await report([{ jobId: find.id, kind: 'find', poll: poll([theirs, release('spotify', 'sr9', 'Glass Rivers', { date: recent })]) }]);
		expect(mixed.results[0]!.outcome).toBe('saved');
		expect(await app.db.query(`select name from curator.catalog_object where name in ('Not Marsh', 'Deezer Thing', 'Glass Rivers') order by name`)).toEqual([{ name: 'Glass Rivers' }]);
		expect(await app.db.query(`select count(*)::int as n from curator.catalog_event`)).toEqual([{ n: 1 }]);
	});

	it("refuses a listing that says the page is another kind of thing than the object", async () => {
		const marsh = await idOf('artist', 'Marsh');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		const asLabel: CatalogClaim = { provider: 'spotify', kind: 'label', providerId: 'sa1', name: 'Marsh Records' };
		const r = await report([{ jobId: find.id, kind: 'find', poll: { ...poll([]), self: asLabel } }]);
		expect(r.results[0]).toMatchObject({ outcome: 'refused', note: 'the listing is of another page' });
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'label'`)).toEqual([]);
	});
});

describe('what a report cannot buy', () => {
	it('no calls for results the catalogue refused, and no memory of a failure for a page the object does not have', async () => {
		const refused = Array.from({ length: 20 }, (_, i) => ({ jobId: `find:00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}:spotify:x`, kind: 'find', poll: poll([]) }));
		await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'buy-0001', profile: PROFILE, results: refused, calls: { spotify: 100_000 } });
		expect(await app.db.query(`select units_used from curator.provider_budget where provider = 'spotify'`)).toEqual([{ units_used: 10 }]);
		const marsh = await idOf('artist', 'Marsh');
		const errors = Array.from({ length: 5 }, (_, i) => ({ jobId: `find:${marsh}:spotify:made-up-${i}`, kind: 'error', store: 'spotify', message: 'HTTP 500', rateLimitedSec: null }));
		const r = await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'buy-0002', profile: PROFILE, results: errors });
		expect(r.results.every((x) => x.outcome === 'refused')).toBe(true);
		expect(await app.db.query(`select 1 from curator.catalog_work_state`)).toEqual([]);
	});

	it("an answer for a track whose store page is another recording's here is remembered, not asked again at every visit", async () => {
		const id = await idOf('release', 'Lailonie');
		const first = await idOf('recording', 'Lailonie');
		const second = await idOf('recording', 'Eu Topos');
		const row = (rec: string, storeId: string, name: string, sec: number): unknown => ({ recordingId: rec, claim: { provider: 'beatport', kind: 'recording', providerId: storeId, name, url: `https://www.beatport.com/track/x/${storeId}`, facts: { durationSec: sec, bpm: 122, key: 'A Minor' } } });
		await report([{ jobId: `facts:${id}`, kind: 'facts', rows: [row(first, 'bp-1', 'Lailonie', 300)], notFound: [] }]);
		await report([{ jobId: `facts:${id}`, kind: 'facts', rows: [row(second, 'bp-1', 'Lailonie', 300)], notFound: [] }]);
		expect(await app.db.query(`select outcome from curator.catalog_work_state where object_id = $1 and job = 'facts' and provider = 'beatport'`, [second])).toEqual([{ outcome: 'unplaced' }]);
	});

	it('one result the cloud fails to save costs that result alone, and the rest of the report stands', async () => {
		const marsh = await idOf('artist', 'Marsh');
		const id = await idOf('release', 'Lailonie');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		// The facts job's table is gone: its result fails inside the database.
		await app.db.query(`alter table curator.catalog_fact rename to catalog_fact_away`);
		const claim = { provider: 'beatport', kind: 'recording', providerId: 'bp-9', name: 'Eu Topos', url: 'https://www.beatport.com/track/x/bp-9', facts: { durationSec: 410, bpm: 122 } };
		const r = await report([
			{ jobId: `facts:${id}`, kind: 'facts', rows: [{ recordingId: await idOf('recording', 'Eu Topos'), claim }], notFound: [] },
			{ jobId: `release:${id}`, kind: 'release', found: [], notFound: ['deezer'], checks: [] },
		]);
		expect(r.results.map((x) => x.outcome)).toEqual(['failed', 'kept']);
		expect(await app.db.query(`select provider, outcome from curator.catalog_work_state where object_id = $1`, [id])).toEqual([{ provider: 'deezer', outcome: 'not_found' }]);
		void find;
	});
});

describe("a label's probe against a store that carries less of it", () => {
	it('agrees when the five releases the reference lists are all among the forty it lists', async () => {
		const BP: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '111', name: 'Monada' };
		const BC: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '222', name: 'Monada' };
		await withSystemTx(app.db, (tx) => ingestClaims(tx, Array.from({ length: 5 }, (_, i) => release('bandcamp', `bc${i}`, `Monada ${i}`, { label: BC, tracks: [['A', 300]] })), { reason: 'tracker' }));
		const label = await idOf('label', 'Monada');
		await app.db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'beatport', 'label', '111', null)`, [label]);
		await app.db.query(`insert into curator.catalog_work_state (object_id, job, provider, provider_id, outcome) values ($1, 'find', 'bandcamp', '222', 'ok')`, [label]);
		const probe = (await work(label)).find((j) => j.kind === 'find' && j.page?.provider === 'beatport')!;
		expect(probe).toMatchObject({ page: { probe: true } });
		const r = await report([{ jobId: probe.id, kind: 'find', poll: poll(Array.from({ length: 40 }, (_, i) => release('beatport', `bp${i}`, `Monada ${i}`, { label: BP }))) }]);
		expect(r.results[0]!.outcome).toBe('saved');
		expect(await app.db.query(`select 1 from curator.catalog_inbox`)).toEqual([]);
	});
});

// Found by the third review (2026-11-27): each ran against the code before it was fixed.
describe('what a report is not taken for', () => {
	it("a page the catalogue holds is not renamed, re-pictured or re-linked by what a device says the page says", async () => {
		const marsh = await idOf('artist', 'Marsh');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		const self: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'PWNED', url: 'https://evil.example/marsh', facts: { coverUrl: 'https://evil.example/x.jpg' } };
		const r = await report([{ jobId: find.id, kind: 'find', poll: { ...poll([release('spotify', 'sr9', 'Glass Rivers', { date: recent })]), self } }]);
		// The listing is taken; the page's own claim is not.
		expect(r.results[0]!.outcome).toBe('saved');
		expect(await app.db.query(`select name from curator.catalog_object where id = $1`, [marsh])).toEqual([{ name: 'Marsh' }]);
		expect(await app.db.query(`select url, coalesce(payload::text, '') like '%PWNED%' as renamed from curator.catalog_source_object where object_id = $1 and provider = 'spotify'`, [marsh])).toEqual([{ url: null, renamed: false }]);
		expect(await app.db.query(`select 1 from curator.catalog_fact where object_id = $1 and value::text like '%evil.example%'`, [marsh])).toEqual([]);
	});

	it('the same answer sent twice in one report is judged once — a store failing beside what the job found is not that', async () => {
		const id = await idOf('release', 'Lailonie');
		const job = `release:${id}`;
		const same = release('deezer', 'dz1', 'Lailonie', { tracks: [['Lailonie (Original Mix)', 301], ['Eu Topos', 409]] });
		const answer = { jobId: job, kind: 'release', found: [{ how: 'tracklist', claim: same }], notFound: [], checks: [] };
		const failed = { jobId: job, kind: 'error', store: 'beatport', message: 'HTTP 503', rateLimitedSec: null };
		const r = await report([answer, failed, answer, failed]);
		expect(r.results.map((x) => [x.outcome, x.note])).toEqual([
			['saved', undefined],
			['failed', 'beatport: HTTP 503'],
			['refused', 'sent twice'],
			['refused', 'sent twice'],
		]);
	});

	it('calls: none for tracks that are not of the release, however many it lists as not found, and never more than a report can hold', async () => {
		const id = await idOf('release', 'Lailonie');
		const track = await idOf('recording', 'Eu Topos');
		const made = Array.from({ length: 300 }, (_, i) => ({ recordingId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, store: 'beatport' }));
		// The same real track listed over and over is one lookup a store.
		const repeated = Array.from({ length: 100 }, () => ({ recordingId: track, store: 'beatport' }));
		await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'calls-0101', profile: PROFILE, results: [{ jobId: `facts:${id}`, kind: 'facts', rows: [], notFound: [...made, ...repeated] }], calls: { beatport: 100_000 } });
		// Ten for the report, three for the one lookup it is believed to have made.
		expect(await app.db.query(`select units_used from curator.provider_budget where provider = 'beatport'`)).toEqual([{ units_used: 13 }]);
		// Twenty-five releases answered for are twenty-five jobs' worth: past what one report is ever counted for.
		await withSystemTx(app.db, (tx) => ingestClaims(tx, Array.from({ length: 25 }, (_, i) => release('spotify', `x${i}`, `Extra ${i}`, { tracks: [['A', 300]] })), { reason: 'tracker' }));
		const extras = await app.db.query<{ id: string }>(`select id from curator.catalog_object where kind = 'release' and name like 'Extra %'`);
		const answers = extras.map((x) => ({ jobId: `release:${x.id}`, kind: 'release', found: [], notFound: ['deezer'], checks: [] }));
		await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'calls-0102', profile: PROFILE, results: answers, calls: { deezer: 100_000 } });
		expect(await app.db.query(`select units_used from curator.provider_budget where provider = 'deezer'`)).toEqual([{ units_used: 600 }]);
	});

	it("counts the calls of a store that began to rest during the visit: it made them before it stopped", async () => {
		const resting: CatalogDeviceProfile = { ...PROFILE, stores: ['spotify'], resting: [{ store: 'beatport', until: Date.now() + 3600_000 }] };
		await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'rest-0001', profile: resting, results: [], calls: { spotify: 4, beatport: 6, deezer: 9 } });
		// Deezer is neither read nor resting on this device.
		expect(await app.db.query(`select provider, units_used from curator.provider_budget order by provider`)).toEqual([
			{ provider: 'beatport', units_used: 6 },
			{ provider: 'spotify', units_used: 4 },
		]);
	});

	it('plans its follow-up by the day as this report leaves it: a store its own calls spent is not handed on', async () => {
		const marsh = await idOf('artist', 'Marsh');
		const find = (await work(marsh)).find((j) => j.kind === 'find')!;
		await withSystemTx(app.db, (tx) => setWorkSetting(tx, 'work.per_day', { deezer: 5 }));
		const r = await api.catalog.workReport.mutate({ deviceId, idempotencyKey: 'day-0001', profile: PROFILE, results: [{ jobId: find.id, kind: 'find', poll: poll([LAILONIE]) }], calls: { deezer: 5 } });
		const next = r.work!.jobs.find((j) => j.kind === 'release') as Extract<CatalogJob, { kind: 'release' }>;
		expect(next.find).toEqual(['beatport']);
		expect(await app.db.query(`select units_used from curator.provider_budget where provider = 'deezer'`)).toEqual([{ units_used: 5 }]);
	});
});
