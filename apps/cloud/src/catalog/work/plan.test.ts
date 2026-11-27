// The planner of device work over a seeded catalogue (PGlite): what a page
// read is handed, and everything that keeps a job quiet — the switch, the
// ages, the memory of "not found", a spent day, the visit's size — and which
// store pages may be named at all.

import type { CatalogClaim, CatalogDeviceProfile, CatalogJob, CatalogRef, CatalogWork } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../db/db.js';
import { withSystemTx, type SystemTx } from '../../db/system-tx.js';
import { createTestDb } from '../../test/harness.js';
import { ingestClaims } from '../ingest.js';
import { resolveRefs } from '../objects.js';
import { pageTracks } from '../pages.js';
import { parseJobId, planPage, planRead, planUnknown, unknownPages } from './plan.js';
import { setWorkSetting } from './settings.js';

const USER = '11111111-1111-4111-8111-111111111111';
const DESKTOP: CatalogDeviceProfile = { form: 'desktop', reader: 1, stores: ['spotify', 'deezer', 'beatport', 'bandcamp', 'traxsource'] };
const PHONE: CatalogDeviceProfile = { form: 'phone', reader: 1, stores: ['spotify', 'deezer'] };

const artist = (id: string, name: string, provider: CatalogClaim['provider'] = 'spotify'): CatalogClaim => ({ provider, kind: 'artist', providerId: id, name });
const MARSH = artist('sa1', 'Marsh');

function release(provider: CatalogClaim['provider'], id: string, title: string, o: { date?: string; tracks?: string[]; upc?: string; label?: CatalogClaim; artists?: CatalogClaim[] } = {}): CatalogClaim {
	return {
		provider,
		kind: 'release',
		providerId: id,
		name: title,
		facts: { releaseDate: o.date ?? '2026-01-01' },
		artists: o.artists ?? [MARSH],
		...(o.upc ? { identifiers: [{ namespace: 'upc', value: o.upc }] } : {}),
		...(o.label ? { label: o.label } : {}),
		recordings: (o.tracks ?? []).map((t, i) => ({ provider, kind: 'recording', providerId: `${id}-t${i + 1}`, name: t, facts: { trackNumber: i + 1, durationSec: 300 + i } })),
	};
}

async function seed(claims: CatalogClaim[], on = true): Promise<{ db: Db; idOf: (kind: string, name: string) => Promise<string> }> {
	const { db } = await createTestDb();
	await withSystemTx(db, async (tx) => {
		await ingestClaims(tx, claims, { reason: 'tracker' });
		if (on) await setWorkSetting(tx, 'work.enabled', true);
	});
	const idOf = async (kind: string, name: string) => (await db.query<{ id: string }>(`select id from curator.catalog_object where kind = $1 and name = $2`, [kind, name]))[0]!.id;
	return { db, idOf };
}

const plan = (db: Db, id: string, profile: CatalogDeviceProfile | undefined, hints: CatalogRef[] = []): Promise<CatalogWork | undefined> =>
	withSystemTx(db, async (tx) => {
		const page = (await pageTracks(tx, id))!;
		return planPage(tx, { userId: USER, profile, hints, object: page.object, releases: page.releases, first: true, nowMs: tx.nowMs });
	});

const kinds = (w: CatalogWork | undefined): string[] => (w?.jobs ?? []).map((j) => j.kind);
const job = <K extends CatalogJob['kind']>(w: CatalogWork | undefined, kind: K, n = 0): Extract<CatalogJob, { kind: K }> => (w?.jobs ?? []).filter((j) => j.kind === kind)[n] as Extract<CatalogJob, { kind: K }>;
const answered = (db: Db, objectId: string, jobName: string, provider: string, outcome: string, daysAgo = 0, providerId = ''): Promise<unknown> =>
	db.query(`insert into curator.catalog_work_state (object_id, job, provider, provider_id, outcome, answered_at) values ($1, $2, $3, $4, $5, now() - make_interval(days => $6::int))`, [objectId, jobName, provider, providerId, outcome, String(daysAgo)]);
const inbox = (db: Db): Promise<{ kind: string; title: string }[]> => db.query(`select kind, title from curator.catalog_inbox order by id`);

const MARSH_RELEASES = [
	release('spotify', 'sr1', 'Lailonie', { date: '2026-03-01', tracks: ['Lailonie', 'Eu Topos'], upc: '4066004975924' }),
	release('spotify', 'sr2', 'Bare Listing', { date: '2026-05-01' }),
];

describe('the plan for a page', () => {
	it('is nothing while the switch is off, or for a device that says it can read nothing', async () => {
		const off = await seed(MARSH_RELEASES, false);
		expect(await plan(off.db, await off.idOf('artist', 'Marsh'), DESKTOP)).toBeUndefined();
		const on = await seed(MARSH_RELEASES);
		const id = await on.idOf('artist', 'Marsh');
		expect(await plan(on.db, id, undefined)).toBeUndefined();
		expect(await plan(on.db, id, { ...DESKTOP, stores: [] })).toBeUndefined();
	});

	it('names the listing to read, the tracklist to fetch, the stores to look at and the facts to fill', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const work = await plan(db, await idOf('artist', 'Marsh'), DESKTOP);
		expect(work!.limits).toEqual({ rounds: 3, releases: 100 });
		// The artist's one Spotify page, from the start.
		const find = job(work, 'find');
		expect(find).toMatchObject({ of: 'artist', name: 'Marsh', page: { provider: 'spotify', providerId: 'sa1', cursor: {} } });
		expect(find.page!.probe).toBeUndefined();
		expect(parseJobId(find.id)).toMatchObject({ kind: 'find', provider: 'spotify', providerId: 'sa1' });
		// Newest first. The bare one: its tracklist at Spotify, then the other stores.
		const bare = job(work, 'release', 0);
		expect(bare.release.title).toBe('Bare Listing');
		expect(bare.read.map((h) => [h.provider, h.id])).toEqual([['spotify', 'sr2']]);
		expect(bare.find).toEqual(['deezer', 'beatport']);
		// The full one: looked for by its UPC and tracklist where it is not.
		const full = job(work, 'release', 1);
		expect(full.read).toEqual([]);
		expect(full.find).toEqual(['deezer', 'beatport']);
		expect(full.release.upcs).toEqual(['4066004975924']);
		expect(full.release.tracks.map((t) => [t.title, t.durationSec, t.position])).toEqual([['Lailonie', 300, 1], ['Eu Topos', 301, 2]]);
		// Its two tracks lack BPM and key.
		const facts = job(work, 'facts');
		expect(facts.stores).toEqual(['beatport', 'traxsource']);
		expect(facts.tracks.map((t) => t.title)).toEqual(['Lailonie', 'Eu Topos']);
		expect(kinds(work)).toEqual(['find', 'release', 'release', 'facts']);
	});

	it('asks a device only for the stores it reads, and not for one that is resting', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		const phone = await plan(db, id, PHONE);
		expect(job(phone, 'release', 1).find).toEqual(['deezer']);
		expect(kinds(phone)).not.toContain('facts');
		const rested = await plan(db, id, { ...DESKTOP, resting: [{ store: 'beatport', until: Date.now() + 3600_000 }, { store: 'deezer', until: Date.now() - 1000 }] });
		expect(job(rested, 'release', 1).find).toEqual(['deezer']);
		expect(job(rested, 'facts').stores).toEqual(['traxsource']);
	});

	it('hands a visit no more releases than its form is set to, and nothing once its rounds are run', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		await withSystemTx(db, (tx) => setWorkSetting(tx, 'work.releases', { phone: 1, desktop: 100 }));
		const first = await plan(db, id, PHONE);
		expect(first!.jobs.filter((j) => j.kind === 'release').map((j) => (j as { release: { title: string } }).release.title)).toEqual(['Bare Listing']);
		expect(await plan(db, id, { ...PHONE, visit: { id: 'visit-0001', round: 0, taken: 1 } }).then(kinds)).toEqual(['find']);
		expect(await plan(db, id, { ...PHONE, visit: { id: 'visit-0001', round: 3, taken: 0 } })).toBeUndefined();
	});

	it('stays quiet about what was answered, until its age passes', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		const full = await idOf('release', 'Lailonie');
		const track = await idOf('recording', 'Eu Topos');
		await answered(db, id, 'find', 'spotify', 'ok', 1, 'sa1');
		await answered(db, full, 'release', 'deezer', 'not_found', 2);
		await answered(db, track, 'facts', 'beatport', 'not_found', 2);
		await answered(db, track, 'facts', 'traxsource', 'not_found', 2);
		const work = await plan(db, id, DESKTOP);
		expect(kinds(work)).not.toContain('find');
		expect(job(work, 'release', 1).find).toEqual(['beatport']);
		expect(job(work, 'facts').tracks.map((t) => t.title)).toEqual(['Lailonie']);

		// Past the ages (7 days for a listing and for a miss) each is asked again.
		await db.query(`update curator.catalog_work_state set answered_at = now() - interval '8 days'`);
		const later = await plan(db, id, DESKTOP);
		expect(kinds(later)).toContain('find');
		expect(job(later, 'release', 1).find).toEqual(['deezer', 'beatport']);
		expect(job(later, 'facts').tracks).toHaveLength(2);
	});

	it('reads a listing on, whatever its age, while the last reading left releases unread', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		await db.query(`insert into curator.catalog_work_state (object_id, job, provider, provider_id, outcome, cursor) values ($1, 'find', 'spotify', 'sa1', 'more', '{"seen": ["sr1"]}')`, [id]);
		expect(job(await plan(db, id, DESKTOP), 'find').page!.cursor).toEqual({ seen: ['sr1'] });
	});

	it('is switched off for one account by its own row', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		await withSystemTx(db, (tx) => setWorkSetting(tx, 'work.enabled', false, { scope: USER }));
		expect(await plan(db, await idOf('artist', 'Marsh'), DESKTOP)).toBeUndefined();
	});

	it('hands out nothing for a store whose day is spent', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		await withSystemTx(db, (tx) => setWorkSetting(tx, 'work.per_day', { beatport: 100, spotify: 100 }));
		await db.query(`insert into curator.provider_budget (provider, day, units_used) values ('beatport', (now() at time zone 'utc')::date, 100), ('spotify', (now() at time zone 'utc')::date, 99)`);
		const work = await plan(db, await idOf('artist', 'Marsh'), DESKTOP);
		expect(kinds(work)).toContain('find');
		expect(job(work, 'release', 1).find).toEqual(['deezer']);
		expect(job(work, 'facts').stores).toEqual(['traxsource']);
	});
});

describe('which pages are named', () => {
	it("an artist's one Spotify page, and never Deezer's page of everyone of that name", async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		await db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'deezer', 'artist', '465319', 'https://www.deezer.com/artist/465319')`, [id]);
		const finds = (await plan(db, id, DESKTOP))!.jobs.filter((j) => j.kind === 'find');
		expect(finds.map((j) => (j as { page: { provider: string } }).page.provider)).toEqual(['spotify']);
	});

	it('of two Spotify pages on one artist, none — whatever a device names — and the operator is asked which is theirs, once', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		// Read while it had one page: the second, attached since, stops it at the next read.
		expect(kinds(await plan(db, id, DESKTOP))).toContain('find');
		await db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'spotify', 'artist', 'namesake', null)`, [id]);
		expect(kinds(await plan(db, id, DESKTOP))).not.toContain('find');
		// A user holding the namesake's track would name the namesake's page: a hint settles nothing.
		expect(kinds(await plan(db, id, DESKTOP, [{ provider: 'spotify', kind: 'artist', providerId: 'sa1' }]))).not.toContain('find');
		expect(await inbox(db)).toEqual([{ kind: 'work.pages', title: expect.stringContaining('2 spotify pages on one artist') }]);
	});

	it('not a page blocked since the last read', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		expect(kinds(await plan(db, id, DESKTOP))).toContain('find');
		await db.query(`insert into curator.catalog_source_block (provider, kind, provider_id, reason, by_whom) values ('spotify', 'artist', 'sa1', 'bucket', 'guy')`);
		expect(kinds(await plan(db, id, DESKTOP))).not.toContain('find');
	});

	it('not a page under a block, nor one judged mixed', async () => {
		const blocked = await seed(MARSH_RELEASES);
		await blocked.db.query(`insert into curator.catalog_source_block (provider, kind, provider_id, reason, by_whom) values ('spotify', 'artist', 'sa1', 'bucket', 'guy')`);
		expect(kinds(await plan(blocked.db, await blocked.idOf('artist', 'Marsh'), DESKTOP))).not.toContain('find');
		const mixed = await seed(MARSH_RELEASES);
		const id = await mixed.idOf('artist', 'Marsh');
		await mixed.db.query(`insert into curator.catalog_page_check (provider, kind, provider_id, object_id, verdict) values ('spotify', 'artist', 'sa1', $1, 'mixed')`, [id]);
		expect(kinds(await plan(mixed.db, id, DESKTOP))).not.toContain('find');
	});

	const BP_LABEL: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '111', name: 'Monada' };
	const BC_LABEL: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '222', name: 'Monada' };
	const beatport = Array.from({ length: 6 }, (_, i) => release('beatport', `bp${i}`, `Monada ${i}`, { label: BP_LABEL, tracks: ['A'] }));
	const findPages = (w: CatalogWork | undefined) => (w?.jobs ?? []).filter((j): j is Extract<CatalogJob, { kind: 'find' }> => j.kind === 'find').map((j) => [j.page!.provider, j.page!.probe === true]);

	it("a label's second page when it lists what the anchor lists", async () => {
		const bandcamp = [0, 1, 2].map((i) => release('bandcamp', `bc${i}`, `Monada ${i}`, { label: BC_LABEL, tracks: ['A'], artists: [artist('bca', 'Marsh', 'bandcamp')] }));
		const { db, idOf } = await seed([...beatport, ...bandcamp]);
		const id = await idOf('label', 'Monada');
		// Neither read yet: what the catalogue holds of each is whatever a library owned there,
		// which says nothing of the other. The page it holds more of is the reference, read as
		// it is and first; the other is compared with it when it is read.
		expect(findPages(await plan(db, id, DESKTOP))).toEqual([['beatport', false], ['bandcamp', true]]);
		// A device that cannot read the reference is not handed the probe: compared with
		// nothing, its reading would be thrown away.
		expect(findPages(await plan(db, id, { ...DESKTOP, stores: ['bandcamp'] }))).toEqual([]);
		// One read: it is the reference now, and a title on the other store is not a reading
		// of that store's page (releases linked across stores put titles there).
		await answered(db, id, 'find', 'bandcamp', 'ok', 30, '222');
		expect(findPages(await plan(db, id, DESKTOP))).toEqual([['bandcamp', false], ['beatport', true]]);
		expect(findPages(await plan(db, id, { ...DESKTOP, stores: ['beatport'] }))).toEqual([['beatport', true]]);
		// Both read, and their listings agree: both, as they are.
		await answered(db, id, 'find', 'beatport', 'ok', 30, '111');
		expect(findPages(await plan(db, id, DESKTOP))).toEqual([['beatport', false], ['bandcamp', false]]);
		expect(await inbox(db)).toEqual([]);
	});

	it("a label's page the weekly reading has read counts as read, also after a run of it failed", async () => {
		const bandcamp = [0, 1, 2].map((i) => release('bandcamp', `bc${i}`, `Monada ${i}`, { label: BC_LABEL, tracks: ['A'], artists: [artist('bca', 'Marsh', 'bandcamp')] }));
		const { db, idOf } = await seed([...beatport, ...bandcamp]);
		const id = await idOf('label', 'Monada');
		await answered(db, id, 'find', 'bandcamp', 'ok', 30, '222');
		// What a poll left is the reading; the failed run after it stamps its error, not the memory.
		await db.query(
			`insert into curator.catalog_cursor (object_id, provider, cursor, last_run_at, last_error, fail_count) values ($1, 'beatport', '{"seen":["bp0"]}', now(), 'HTTP 429', 1)
			on conflict (object_id, provider) do update set cursor = excluded.cursor, last_run_at = excluded.last_run_at, last_error = excluded.last_error, fail_count = excluded.fail_count`,
			[id],
		);
		await db.query(`update curator.catalog_source_object set first_seen_at = now() - interval '30 days' where object_id = $1`, [id]);
		expect(findPages(await plan(db, id, DESKTOP))).toEqual([['beatport', false], ['bandcamp', false]]);
	});

	it("a label's never-read page beside the one it is known by, as a probe — also when a device names it", async () => {
		const { db, idOf } = await seed(beatport);
		const id = await idOf('label', 'Monada');
		await db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'bandcamp', 'label', '222', 'https://monada.bandcamp.com')`, [id]);
		expect(findPages(await plan(db, id, DESKTOP, [{ provider: 'bandcamp', kind: 'label', providerId: '222' }]))).toEqual([['beatport', false], ['bandcamp', true]]);
		expect(await inbox(db)).toEqual([]);
	});

	it("neither of a label's two pages when they list different things, and the operator is told", async () => {
		const elsewhere = Array.from({ length: 8 }, (_, i) => release('bandcamp', `bc${i}`, i === 0 ? 'Monada 0' : `Cuarteto ${i}`, { label: BC_LABEL, tracks: ['A'], artists: [artist('bcx', 'Monada (AR)', 'bandcamp')] }));
		// Which of the two is the label cannot be read off their sizes (here
		// the off-topic one is the larger): neither is read.
		const { db, idOf } = await seed([...beatport, ...elsewhere]);
		// Both read: two listings, not two samples.
		await answered(db, await idOf('label', 'Monada'), 'find', 'beatport', 'ok', 30, '111');
		await answered(db, await idOf('label', 'Monada'), 'find', 'bandcamp', 'ok', 30, '222');
		expect(findPages(await plan(db, await idOf('label', 'Monada'), DESKTOP))).toEqual([]);
		expect((await inbox(db)).map((i) => i.title)).toEqual([expect.stringContaining('shares 1 of 6 releases with its bandcamp page — neither is read')]);
		// The page a device's own library names is read whatever the other says.
		const hinted = await plan(db, await idOf('label', 'Monada'), DESKTOP, [{ provider: 'beatport', kind: 'label', providerId: '111' }]);
		expect(findPages(hinted)).toEqual([['beatport', false]]);
		// The verdict is kept: a second page open asks no one again.
		await plan(db, await idOf('label', 'Monada'), DESKTOP);
		await plan(db, await idOf('label', 'Monada'), DESKTOP);
		expect((await inbox(db)).filter((i) => i.title.includes('neither'))).toHaveLength(1);
	});

	it("a label's never-read page as a probe", async () => {
		const { db, idOf } = await seed(beatport);
		const id = await idOf('label', 'Monada');
		await db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'bandcamp', 'label', '222', 'https://monada.bandcamp.com')`, [id]);
		expect(findPages(await plan(db, id, DESKTOP))).toEqual([['beatport', false], ['bandcamp', true]]);
	});
});

describe('the plan for something the catalogue does not hold', () => {
	it("is to read the artist's or label's own page the device named, unless it is blocked", async () => {
		const { db } = await seed(MARSH_RELEASES);
		await db.query(`insert into curator.catalog_source_block (provider, kind, provider_id, reason, by_whom) values ('spotify', 'artist', 'bucket', 'bucket', 'guy')`);
		const refs: CatalogRef[] = [
			{ provider: 'spotify', kind: 'artist', providerId: 'sa1' },
			{ provider: 'spotify', kind: 'artist', providerId: 'unknown-artist' },
			{ provider: 'spotify', kind: 'artist', providerId: 'bucket' },
			{ provider: 'deezer', kind: 'artist', providerId: '465319' },
			{ provider: 'spotify', kind: 'recording', providerId: 'unknown-track' },
			{ provider: 'beatport', kind: 'label', providerId: '999' },
		];
		const work = await withSystemTx(db, async (tx) => planUnknown(tx, { userId: USER, profile: DESKTOP, refs, objects: await resolveRefs(tx, refs), nowMs: tx.nowMs }));
		expect(work!.jobs.map((j) => j.id)).toEqual(['find:new:spotify:unknown-artist', 'find:new:beatport:999']);
		expect(work!.jobs[0]).toMatchObject({ kind: 'find', objectId: null, of: 'artist', page: { cursor: {} } });
	});
});

describe('a job id', () => {
	it('is read as a name, and nothing else', () => {
		expect(parseJobId('release:75db776e-df95-4b02-b243-6ad2171696e1')).toEqual({ kind: 'release', releaseId: '75db776e-df95-4b02-b243-6ad2171696e1' });
		expect(parseJobId('find:new:beatport:monada:x')).toEqual({ kind: 'find', objectId: null, provider: 'beatport', providerId: 'monada:x' });
		expect(parseJobId('find:nope:spotify:x')).toBeNull();
		expect(parseJobId('release:nope')).toBeNull();
		expect(parseJobId('drop:everything')).toBeNull();
	});
});

describe('what keeps a job quiet', () => {
	it('a page a device found gone or empty is not read again at every visit, nor a store that just failed', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		const bare = await idOf('release', 'Bare Listing');
		expect((await plan(db, id, DESKTOP))!.jobs.some((j) => j.id === `release:${bare}`)).toBe(true);
		await answered(db, bare, 'check', 'spotify', 'gone', 1, 'sr2');
		expect((await plan(db, id, DESKTOP))!.jobs.some((j) => j.id === `release:${bare}`)).toBe(false);
		// A store that did not answer rests a day, not the retry age: nothing was learned.
		await db.query(`delete from curator.catalog_work_state`);
		await answered(db, bare, 'release', 'spotify', 'error', 0);
		expect((await plan(db, id, DESKTOP))!.jobs.some((j) => j.id === `release:${bare}`)).toBe(false);
		await db.query(`update curator.catalog_work_state set answered_at = now() - interval '2 days'`);
		expect((await plan(db, id, DESKTOP))!.jobs.some((j) => j.id === `release:${bare}`)).toBe(true);
	});

	it('a store that answered for a track is not asked for it again, whatever it left unfilled', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		for (const name of ['Lailonie', 'Eu Topos']) {
			await answered(db, await idOf('recording', name), 'facts', 'beatport', 'ok', 1);
			await answered(db, await idOf('recording', name), 'facts', 'traxsource', 'unplaced', 1);
		}
		expect(kinds(await plan(db, id, DESKTOP))).not.toContain('facts');
	});

	it('a build that reads wrongly is handed nothing once the oldest reader asked is raised past it', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		await withSystemTx(db, (tx) => setWorkSetting(tx, 'work.min_reader', 2));
		const id = await idOf('artist', 'Marsh');
		expect(await plan(db, id, DESKTOP)).toBeUndefined();
		expect(await plan(db, id, { ...DESKTOP, reader: 2 })).toBeDefined();
	});
});

describe('pages the catalogue does not hold', () => {
	it('are read a handful a resolve, each once, and only by a store id', async () => {
		const { db } = await seed(MARSH_RELEASES);
		const refs: CatalogRef[] = [
			{ provider: 'bandcamp', kind: 'label', providerId: 'monada' },
			...Array.from({ length: 8 }, (_, i): CatalogRef => ({ provider: 'spotify', kind: 'artist', providerId: `new${i}` })),
			{ provider: 'spotify', kind: 'artist', providerId: 'new0' },
		];
		const ask = (profile: CatalogDeviceProfile) => withSystemTx(db, async (tx) => planUnknown(tx, { userId: USER, profile, refs, objects: await resolveRefs(tx, refs), nowMs: tx.nowMs }));
		expect((await ask(DESKTOP))!.jobs.map((j) => j.id)).toEqual(['find:new:spotify:new0', 'find:new:spotify:new1', 'find:new:spotify:new2', 'find:new:spotify:new3', 'find:new:spotify:new4']);
		// A visit that has had its share is handed no more.
		expect(await ask({ ...PHONE, visit: { id: 'visit-0001', round: 0, taken: 20 } })).toBeUndefined();
	});
});

describe('a release that has its page on a store but none of its tracks there', () => {
	// One release on two stores (the same UPC), its tracklist read at one of them.
	const onBoth = (tracksAt: 'spotify' | 'beatport'): CatalogClaim[] => [
		release(tracksAt, 'full1', 'Lailonie', { tracks: ['Lailonie', 'Eu Topos'], upc: '4066004975924' }),
		release(tracksAt === 'spotify' ? 'beatport' : 'spotify', 'bare1', 'Lailonie', { upc: '4066004975924' }),
	];
	const releaseJob = (w: CatalogWork | undefined) => (w?.jobs ?? []).find((j): j is Extract<CatalogJob, { kind: 'release' }> => j.kind === 'release');

	it('is read at that page once, never searched for there again, and read again only when its confirmation is due', async () => {
		const { db, idOf } = await seed(onBoth('beatport'));
		const id = await idOf('artist', 'Marsh');
		const release1 = await idOf('release', 'Lailonie');
		const first = releaseJob(await plan(db, id, DESKTOP))!;
		expect(first.read.map((h) => [h.provider, h.id])).toEqual([['spotify', 'bare1']]);
		expect(first.find).not.toContain('spotify');
		// Read: whether or not its tracks paired, the match stands for the confirmation age.
		await answered(db, release1, 'check', 'spotify', 'read', 30, 'bare1');
		expect(releaseJob(await plan(db, id, DESKTOP))?.read ?? []).toEqual([]);
		await db.query(`update curator.catalog_work_state set answered_at = now() - interval '91 days' where job = 'check'`);
		expect(releaseJob(await plan(db, id, DESKTOP))!.read.map((h) => h.provider)).toEqual(['spotify']);
	});

	it("has its Beatport page read for every track's facts at once, the lookups waiting for what that leaves", async () => {
		const { db, idOf } = await seed(onBoth('spotify'));
		const id = await idOf('artist', 'Marsh');
		const release1 = await idOf('release', 'Lailonie');
		const work = await plan(db, id, DESKTOP);
		expect(releaseJob(work)!.read.map((h) => [h.provider, h.id])).toEqual([['beatport', 'bare1']]);
		expect(kinds(work)).not.toContain('facts');
		// The page read, the tracks it did not have are looked up one by one.
		await answered(db, release1, 'check', 'beatport', 'read', 0, 'bare1');
		const after = await plan(db, id, DESKTOP);
		expect(releaseJob(after)?.read ?? []).toEqual([]);
		expect(job(after, 'facts').tracks).toHaveLength(2);
	});
});

describe('a distributor', () => {
	it('is no label to read, whatever page it has', async () => {
		const DK: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '555', name: 'DistroKid' };
		const { db, idOf } = await seed([release('beatport', 'dk1', 'Anything', { label: DK, tracks: ['A'] })]);
		const id = await idOf('label', 'DistroKid');
		expect((await plan(db, id, DESKTOP))?.jobs.some((j) => j.kind === 'find') ?? false).toBe(false);
	});
});

// The third review's (2026-11-27): what a read pays for its planner, and what the planner walks.
describe('what a read pays to be planned', () => {
	// The statements a planner sends, wherever it sends them (the fence runs on its own handle).
	const counted = <T>(db: Db, fn: (tx: SystemTx) => Promise<T>): Promise<{ out: T; sent: string[] }> =>
		withSystemTx(db, async (tx) => {
			const sent: string[] = [];
			const wrap = (t: SystemTx): SystemTx => ({
				...t,
				query: ((sql: string, params?: unknown[]) => (sent.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40)), t.query(sql, params as never))) as typeof t.query,
				savepoint: (inner) => (sent.push('savepoint'), t.savepoint((s) => inner(wrap(s))).finally(() => sent.push('release'))),
			});
			return { out: await fn(wrap(tx)), sent };
		});
	const read = async (db: Db, id: string, profile: CatalogDeviceProfile | undefined) => {
		const page = (await withSystemTx(db, (tx) => pageTracks(tx, id)))!;
		return counted(db, (tx) => planRead(tx, { userId: USER, profile }, () => {}, (fenced, scope) => planPage(fenced, { userId: USER, profile, object: page.object, releases: page.releases, first: true, nowMs: fenced.nowMs, scope })));
	};

	it('nothing without a profile, one statement while the switch is off, and no fence opened for either', async () => {
		const off = await seed(MARSH_RELEASES, false);
		const id = await off.idOf('artist', 'Marsh');
		expect((await read(off.db, id, undefined)).sent).toEqual([]);
		expect((await read(off.db, id, { ...DESKTOP, stores: [] })).sent).toEqual([]);
		const quiet = await read(off.db, id, DESKTOP);
		expect(quiet.out).toBeUndefined();
		expect(quiet.sent).toHaveLength(1);
		// A visit whose rounds are run pays the same and no more.
		const on = await seed(MARSH_RELEASES);
		const done = await read(on.db, await on.idOf('artist', 'Marsh'), { ...DESKTOP, visit: { id: 'visit-0001', round: 3, taken: 0 } });
		expect(done.sent).toHaveLength(1);
	});

	it('the settings, the fence, and three statements of its own for an artist page', async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const planned = await read(db, await idOf('artist', 'Marsh'), DESKTOP);
		expect(kinds(planned.out)).toEqual(['find', 'release', 'release', 'facts']);
		// Settings and the day's counts; savepoint; what was learned, the artist's pages, the UPCs; release.
		expect(planned.sent).toHaveLength(6);
		expect(planned.sent[1]).toBe('savepoint');
		expect(planned.sent.at(-1)).toBe('release');
	});

	it('nothing at all for a resolve of things the catalogue holds', async () => {
		const { db } = await seed(MARSH_RELEASES);
		const refs: CatalogRef[] = [{ provider: 'spotify', kind: 'artist', providerId: 'sa1' }, { provider: 'spotify', kind: 'recording', providerId: 'unknown-track' }, { provider: 'deezer', kind: 'artist', providerId: '1' }];
		const objects = await withSystemTx(db, (tx) => resolveRefs(tx, refs));
		expect(unknownPages(refs, objects)).toEqual([]);
		expect(unknownPages([...refs, { provider: 'spotify', kind: 'artist', providerId: 'nv1' }, { provider: 'spotify', kind: 'artist', providerId: 'nv1' }], [...objects, null, null])).toEqual([{ provider: 'spotify', kind: 'artist', providerId: 'nv1' }]);
	});
});

describe("a label's pages, for a device that reads neither store", () => {
	const BP: CatalogClaim = { provider: 'beatport', kind: 'label', providerId: '111', name: 'Monada' };
	const BC: CatalogClaim = { provider: 'bandcamp', kind: 'label', providerId: '222', name: 'Monada' };
	const beatport = Array.from({ length: 6 }, (_, i) => release('beatport', `bp${i}`, `Monada ${i}`, { label: BP, tracks: ['A'] }));

	it('are not named at all: nothing is walked, compared or put to the operator', async () => {
		const { db, idOf } = await seed(beatport);
		const id = await idOf('label', 'Monada');
		// Two Beatport pages on one label: a fault a device that reads Beatport raises.
		await db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'beatport', 'label', '999', null), ($1, 'bandcamp', 'label', '222', null)`, [id]);
		await plan(db, id, PHONE);
		expect(await inbox(db)).toEqual([]);
		expect(await db.query(`select 1 from curator.catalog_work_state where job = 'page'`)).toEqual([]);
		await plan(db, id, DESKTOP);
		expect((await inbox(db)).map((i) => i.kind)).toEqual(['work.pages']);
	});

	it('are compared once a day while nobody has read either, and afresh once both were read: a sample is not taken for a listing', async () => {
		const { db, idOf } = await seed(beatport);
		const id = await idOf('label', 'Monada');
		await db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id, url) values ($1, 'bandcamp', 'label', '222', null)`, [id]);
		const kept = async () => (await db.query<{ evidence: string; answered_at: unknown }>(`select evidence::text as evidence, answered_at from curator.catalog_work_state where object_id = $1 and job = 'page'`, [id])).map((r) => ({ ...(JSON.parse(r.evidence) as { read: boolean; agrees: boolean; size: Record<string, number> }), at: String(r.answered_at) }));
		await plan(db, id, DESKTOP);
		const first = await kept();
		expect(first).toMatchObject([{ read: false, agrees: false, size: { beatport: 6, bandcamp: 0 } }]);
		// The next page open walks nothing: the row is the one kept.
		await plan(db, id, DESKTOP);
		expect(await kept()).toEqual(first);
		// Both read since (the weekly reading's, which forgets nothing here), and Bandcamp's
		// releases in: what the samples said of each other is not what the listings say.
		await withSystemTx(db, (tx) => ingestClaims(tx, [0, 1, 2].map((i) => release('bandcamp', `bc${i}`, `Monada ${i}`, { label: BC, tracks: ['A'], artists: [artist('bca', 'Marsh', 'bandcamp')] })), { reason: 'tracker' }));
		await answered(db, id, 'find', 'beatport', 'ok', 30, '111');
		await answered(db, id, 'find', 'bandcamp', 'ok', 30, '222');
		const both = (await plan(db, id, DESKTOP))!.jobs.filter((j): j is Extract<CatalogJob, { kind: 'find' }> => j.kind === 'find').map((j) => [j.page!.provider, j.page!.probe === true]);
		expect(both).toEqual([['beatport', false], ['bandcamp', false]]);
		expect(await kept()).toMatchObject([{ read: true, agrees: true }]);
		expect(await inbox(db)).toEqual([]);
	});
});

describe('a track nobody credited', () => {
	it("is looked up by its release's artists", async () => {
		const { db, idOf } = await seed(MARSH_RELEASES);
		const id = await idOf('artist', 'Marsh');
		const track = await idOf('recording', 'Eu Topos');
		// As a tracklist only Deezer gave leaves it: its credits are not kept.
		await db.query(`delete from curator.catalog_edge where kind = 'recording-artist' and $1 in (src, dst)`, [track]);
		const facts = job(await plan(db, id, DESKTOP), 'facts');
		expect(facts.tracks.map((t) => [t.title, t.artists])).toEqual([['Lailonie', ['Marsh']], ['Eu Topos', ['Marsh']]]);
	});
});
