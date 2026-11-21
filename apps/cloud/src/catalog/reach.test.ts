// Reach: the Spotify page parser, the score's arithmetic, and the passes
// that read the stores and write the scores. The artists are made up; the
// page strings are the shapes Spotify served on 2026-11-19.

import { parseMonthlyListeners, SpotifyPageShapeError } from '@curator/catalog-readers';
import { describe, expect, it } from 'vitest';
import type { Db } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { createLogger } from '../log.js';
import { createTestApp, createTestDb } from '../test/harness.js';
import { AUDIENCE_PROVIDERS, queueAudience, runAudience, type AudiencePage, type AudienceProvider, type AudienceReader } from './audience.js';
import { browseForClient } from './browse.js';
import { calibrate, reachOf, runReachScores, type Calibration } from './reach.js';

const quiet = createLogger(() => {});

const page = (description: string | null) =>
	`<html><head><meta property="og:title" content="Someone"/>${description === null ? '' : `<meta property="og:description" content="${description}"/>`}</head></html>`;

describe("Spotify's artist page", () => {
	it('reads monthly listeners in every form the page writes them', () => {
		expect(parseMonthlyListeners(page('Artist · 27.8M monthly listeners.'))).toBe(27_800_000);
		expect(parseMonthlyListeners(page('Artist · 103.9K monthly listeners.'))).toBe(103_900);
		expect(parseMonthlyListeners(page('Artist · 990 monthly listeners.'))).toBe(990);
		expect(parseMonthlyListeners(page('Artist · 1,234 monthly listeners.'))).toBe(1234);
	});

	it('says none for an artist page without listeners, and stops at a page it does not know', () => {
		expect(parseMonthlyListeners(page('Artist'))).toBeNull();
		expect(parseMonthlyListeners(page(null))).toBeNull();
		// The web player's empty shell, what a browser is served.
		expect(() => parseMonthlyListeners('<html><head><title>Spotify – Web Player</title></head></html>')).toThrow(SpotifyPageShapeError);
	});
});

// A calibration with every store on Spotify's scale one to one.
const flat = Object.fromEntries(AUDIENCE_PROVIDERS.map((p) => [p, { a: 0, b: 1, pairs: 0, fitted: false }])) as Calibration;
const readings = (r: Partial<Record<AudienceProvider, number>>) => new Map(Object.entries(r) as [AudienceProvider, number][]);

describe('the score', () => {
	it('is ten times the log of the audience, without a ceiling', () => {
		expect(reachOf(readings({ spotify: 999 }), flat)!.score).toBe(30);
		expect(reachOf(readings({ spotify: 999_999 }), flat)!.score).toBe(60);
		expect(reachOf(readings({ spotify: 9_999_999_999 }), flat)!.score).toBe(100);
	});

	it('weights the stores, and leaves out the one the others contradict by over 30×', () => {
		// Spotify (weight 1) and Deezer (0.6) a decade apart: 10·(1·5 + 0.6·4)/1.6.
		expect(reachOf(readings({ spotify: 99_999, deezer: 9_999 }), flat)!.score).toBe(46.3);
		// A namesake's Last.fm page, 1,000× the rest: out, and said so.
		const s = reachOf(readings({ spotify: 99_999, deezer: 99_999, lastfm: 99_999_999 }), flat)!;
		expect(s.score).toBe(50);
		expect(s.parts.find((p) => p.provider === 'lastfm')).toMatchObject({ outlier: true });
		// Two that disagree: the more direct measure stands.
		expect(reachOf(readings({ spotify: 999, tidal: 9_999_999 }), flat)).toMatchObject({ score: 30, parts: expect.arrayContaining([{ provider: 'tidal', n: 9_999_999, outlier: true }]) });
	});

	it('never scores Last.fm alone', () => {
		expect(reachOf(readings({ lastfm: 50_000 }), flat)).toBeNull();
		expect(reachOf(readings({}), flat)).toBeNull();
	});

	it("fits each store onto Spotify's listeners once there are enough artists with both, and keeps the prior until then", () => {
		const few = calibrate(new Map([['a', readings({ spotify: 1000, deezer: 100 })]]));
		expect(few.deezer).toMatchObject({ fitted: false, pairs: 1 });
		// Spotify listeners are always 10× the Deezer fans, but for two wrong pages
		// (a fan or two against thousands of listeners) the second fit leaves out.
		const many = new Map(Array.from({ length: 60 }, (_, i) => [`a${i}`, readings({ spotify: 10 * 10 ** (2 + (i % 5)), deezer: i < 2 ? 1 : 10 ** (2 + (i % 5)) })]));
		const cal = calibrate(many);
		expect(cal.deezer.fitted).toBe(true);
		expect(cal.deezer.b).toBeCloseTo(1, 1);
		expect(cal.deezer.a).toBeCloseTo(1, 1);
	});

});

// A store that answers from a table, and remembers what it was asked.
function store(provider: AudienceProvider, counts: Record<string, number | null>, asked: string[] = []): AudienceReader {
	return {
		provider,
		perPass: 10,
		async read(pages: readonly AudiencePage[]) {
			asked.push(...pages.map((p) => p.providerId));
			return { values: new Map(pages.map((p) => [p, counts[p.providerId] ?? null])) };
		},
	};
}

async function artist(db: Db, name: string, pages: Partial<Record<AudienceProvider, string>>, watchers = 0): Promise<string> {
	const [o] = await db.query<{ id: string }>(
		`insert into curator.catalog_object (kind, name, name_fold, discovered_via, watch_count) values ('artist', $1, lower($1), 'manual_registration', $2::int) returning id`,
		[name, String(watchers)],
	);
	for (const [provider, id] of Object.entries(pages)) {
		await db.query(`insert into curator.catalog_source_object (object_id, provider, kind, provider_id) values ($1, $2, 'artist', $3)`, [o!.id, provider, id]);
	}
	return o!.id;
}

describe('the audience and scoring passes', () => {
	it('reads followed and opened artists at each store they have a page at, scores them, and hands the score to the page', async () => {
		const { db } = await createTestDb();
		const followed = await artist(db, 'Northfold', { spotify: 'sp1', deezer: 'dz1' }, 1);
		const opened = await artist(db, 'Glass Rivers', { spotify: 'sp2' });
		const nobody = await artist(db, 'Unseen', { spotify: 'sp3' });
		// A Deezer page the page validation found to hold several acts: never read.
		await artist(db, 'Fade', { deezer: 'dz9' }, 1);
		await db.query(`insert into curator.catalog_page_check (provider, kind, provider_id, object_id, verdict) select 'deezer', 'artist', 'dz9', id, 'mixed' from curator.catalog_object where name = 'Fade'`);
		await withSystemTx(db, (tx) => queueAudience(tx, opened));

		const asked: string[] = [];
		const readers = [store('spotify', { sp1: 120_000, sp2: 900, sp3: 5 }, asked), store('deezer', { dz1: 30_000, dz9: 9_000_000 }, asked)];
		expect(await runAudience({ db, log: quiet, readers, holder: 'test' })).toEqual({ read: 3, failed: 0, parked: [] });
		expect(asked.sort()).toEqual(['dz1', 'sp1', 'sp2']);
		// Read: nothing is due again this month.
		expect(await runAudience({ db, log: quiet, readers, holder: 'test' })).toEqual({ read: 0, failed: 0, parked: [] });

		expect(await runReachScores({ db, log: quiet, force: true })).toEqual({ scored: 2, full: true });
		const header = (await withSystemTx(db, (tx) => browseForClient(tx, followed, { brief: true })))!;
		expect(header.reach).toMatchObject({ change: null });
		expect(header.reach!.score).toBeGreaterThan(45);
		expect(header.reach!.parts.map((p) => [p.provider, p.metric, p.n])).toEqual([
			['spotify', 'monthly_listeners', 120_000],
			['deezer', 'fans', 30_000],
		]);
		expect((await withSystemTx(db, (tx) => browseForClient(tx, opened, { brief: true })))!.reach).toMatchObject({ score: 29.5 });
		expect((await withSystemTx(db, (tx) => browseForClient(tx, nobody, { brief: true })))!.reach).toBeUndefined();
	});

	it('scores an artist read after the full pass at once, on its calibration', async () => {
		const { db } = await createTestDb();
		await artist(db, 'Northfold', { spotify: 'sp1' }, 1);
		await runAudience({ db, log: quiet, readers: [store('spotify', { sp1: 99_999 })], holder: 'test' });
		expect(await runReachScores({ db, log: quiet, force: true })).toEqual({ scored: 1, full: true });
		// Nothing new: nothing to do until the hour is up.
		expect(await runReachScores({ db, log: quiet })).toBeNull();
		// An artist opened for the first time: read by the next pass, scored by the one after it.
		const opened = await artist(db, 'Glass Rivers', { spotify: 'sp2' });
		await withSystemTx(db, (tx) => queueAudience(tx, opened));
		await runAudience({ db, log: quiet, readers: [store('spotify', { sp2: 999 })], holder: 'test' });
		expect(await runReachScores({ db, log: quiet })).toEqual({ scored: 1, full: false });
		expect((await withSystemTx(db, (tx) => browseForClient(tx, opened, { brief: true })))!.reach).toMatchObject({ score: 30 });
		expect(await runReachScores({ db, log: quiet })).toBeNull();
	});

	it("queues an artist's reads when its page header is read, whichever side the page shows", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const id = await artist(app.db, 'Northfold', { spotify: 'sp1', deezer: 'dz1' });
		await fan.api.catalog.browse.query({ deviceId: fan.deviceId, id, brief: true });
		const tasks = await app.db.query<{ provider: string }>(`select provider from curator.catalog_enrich_task where need = 'audience' and object_id = $1 order by provider`, [id]);
		expect(tasks.map((t) => t.provider)).toEqual(['deezer', 'lastfm', 'spotify']);
	});

	it("queues a library's artists for their reads when a desktop sends them, and only artists", async () => {
		const app = await createTestApp();
		const fan = await app.signIn();
		const a = await artist(app.db, 'Northfold', { spotify: 'sp1' });
		const [label] = await app.db.query<{ id: string }>(`insert into curator.catalog_object (kind, name, name_fold, discovered_via) values ('label', 'Cobalt Pier', 'cobalt pier', 'library_import') returning id`);
		expect(await fan.api.catalog.enrich.mutate({ deviceId: fan.deviceId, objectIds: [a, label!.id], need: 'audience' })).toEqual({ queued: 2 });
		const tasks = await app.db.query<{ object_id: string; provider: string }>(`select object_id, provider from curator.catalog_enrich_task where need = 'audience' order by provider`);
		expect(tasks).toEqual([{ object_id: a, provider: 'lastfm' }, { object_id: a, provider: 'spotify' }]);
		// Sent again within the month: nothing new.
		expect(await fan.api.catalog.enrich.mutate({ deviceId: fan.deviceId, objectIds: [a], need: 'audience' })).toEqual({ queued: 0 });
	});

	it('sets the score against the readings of three months before', async () => {
		const { db } = await createTestDb();
		const id = await artist(db, 'Northfold', { spotify: 'sp1' }, 1);
		const [src] = await db.query<{ id: string }>(`select id from curator.catalog_source_object where provider_id = 'sp1'`);
		await db.query(
			`insert into curator.catalog_signal (object_id, source_object_id, kind, value, observed_at) values
				($1, $2, 'audience', '{"provider":"spotify","metric":"monthly_listeners","n":9999}', now() - interval '100 days'),
				($1, $2, 'audience', '{"provider":"spotify","metric":"monthly_listeners","n":99999}', now() - interval '2 days')`,
			[id, src!.id],
		);
		await runReachScores({ db, log: quiet, force: true });
		expect((await withSystemTx(db, (tx) => browseForClient(tx, id, { brief: true })))!.reach).toMatchObject({ score: 50, change: 10 });
	});

	it('parks a store that asks to be left alone, and leaves what it did not reach due', async () => {
		const { db } = await createTestDb();
		await artist(db, 'Northfold', { spotify: 'sp1' }, 1);
		const stopping: AudienceReader = { provider: 'spotify', perPass: 10, read: async () => ({ values: new Map(), stop: { parkSec: 3600, reason: 'rate limited' } }) };
		expect(await runAudience({ db, log: quiet, readers: [stopping], holder: 'test' })).toEqual({ read: 0, failed: 0, parked: ['spotify'] });
		const [task] = await db.query<{ due: boolean; lease: string | null }>(`select next_due_at <= now() as due, lease_holder as lease from curator.catalog_enrich_task where need = 'audience'`);
		expect(task).toEqual({ due: true, lease: null });
	});
});
