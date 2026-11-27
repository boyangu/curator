// The follow-up after a device's report: the releases it completed looked up
// at the stores only the cloud can ask, by their UPCs. Readers are fakes.

import type { CatalogClaim } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../../db/system-tx.js';
import { createLogger } from '../../log.js';
import { createTestDb } from '../../test/harness.js';
import { ingestClaims } from '../ingest.js';
import type { AppleLookup } from '../trackers/apple.js';
import type { TidalApp } from '../trackers/tidal-app.js';
import { drainFollowUps } from './followup.js';
import { pruneWork } from './retention.js';

const MARSH: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Marsh' };
const release = (provider: CatalogClaim['provider'], id: string, upc?: string): CatalogClaim => ({
	provider,
	kind: 'release',
	providerId: id,
	name: 'Lailonie',
	facts: { releaseDate: '2026-03-01' },
	artists: [MARSH],
	...(upc ? { identifiers: [{ namespace: 'upc', value: upc }] } : {}),
	recordings: [{ provider, kind: 'recording', providerId: `${id}-t1`, name: 'Lailonie', facts: { trackNumber: 1, durationSec: 300 } }],
});

describe('the follow-up of a completed release', () => {
	it('links the Tidal and Apple pages its UPC finds, once, and leaves a release without a UPC alone', async () => {
		const { db } = await createTestDb();
		await withSystemTx(db, (tx) => ingestClaims(tx, [release('spotify', 'sr1', '4066004975924'), { ...release('spotify', 'sr2'), name: 'No Code' }], { reason: 'tracker' }));
		const ids = await db.query<{ id: string; name: string }>(`select id, name from curator.catalog_object where kind = 'release' order by name`);
		await db.query(`insert into curator.catalog_work_followup (release_id) select id from curator.catalog_object where kind = 'release'`);
		const asked: string[] = [];
		const tidal = { albumByUpc: async (upc: string) => (asked.push(`tidal:${upc}`), release('tidal', 'td1')) } as unknown as TidalApp;
		const apple = { albumByUpc: async (upc: string) => (asked.push(`apple:${upc}`), { claim: null, calls: 2 }) } as unknown as AppleLookup;
		const log = createLogger(() => {});
		const r = await drainFollowUps({ db, log, readers: { tidal, apple } });
		expect(r).toEqual({ releases: 1, linked: 1, requeued: 0 });
		expect(asked).toEqual(['tidal:4066004975924', 'apple:4066004975924']);
		const lailonie = ids.find((x) => x.name === 'Lailonie')!.id;
		expect(await db.query(`select provider from curator.catalog_source_object where object_id = $1 and kind = 'release' order by provider`, [lailonie])).toEqual([{ provider: 'spotify' }, { provider: 'tidal' }]);
		expect(await db.query(`select 1 from curator.catalog_work_followup`)).toEqual([]);
		// Nothing left: a second run asks nobody.
		expect(await drainFollowUps({ db, log, readers: { tidal, apple } })).toEqual({ releases: 0, linked: 0, requeued: 0 });
	});

	it('puts a release back when a store asked it to wait', async () => {
		const { db } = await createTestDb();
		await withSystemTx(db, (tx) => ingestClaims(tx, [release('spotify', 'sr1', '4066004975924')], { reason: 'tracker' }));
		await db.query(`insert into curator.catalog_work_followup (release_id) select id from curator.catalog_object where kind = 'release'`);
		const { TrackerRateLimitedError } = await import('@curator/catalog-readers');
		const tidal = { albumByUpc: async () => { throw new TrackerRateLimitedError(60); } } as unknown as TidalApp;
		const r = await drainFollowUps({ db, log: createLogger(() => {}), readers: { tidal, apple: null } });
		expect(r).toEqual({ releases: 1, linked: 0, requeued: 1 });
		// Back in a quarter of an hour, not at the next run: Tidal was not asked, so it still is to be.
		expect(await db.query(`select asked, not_before > now() + interval '10 minutes' as later, not_before < now() + interval '20 minutes' as soon from curator.catalog_work_followup`)).toEqual([{ asked: [], later: true, soon: true }]);
		expect(await drainFollowUps({ db, log: createLogger(() => {}), readers: { tidal, apple: null } })).toEqual({ releases: 0, linked: 0, requeued: 0 });
	});

	it("asks a store once for a release, though the other's day is spent: the queue waits for tomorrow's count and Tidal is left alone", async () => {
		const { db } = await createTestDb();
		await withSystemTx(db, (tx) => ingestClaims(tx, [release('spotify', 'sr1', '4066004975924')], { reason: 'tracker' }));
		await db.query(`insert into curator.catalog_work_followup (release_id) select id from curator.catalog_object where kind = 'release'`);
		await db.query(`insert into curator.provider_budget (provider, day, units_used) values ('apple', (now() at time zone 'utc')::date, 2000)`);
		const asked: string[] = [];
		const tidal = { albumByUpc: async () => (asked.push('tidal'), null) } as unknown as TidalApp;
		const apple = { albumByUpc: async () => (asked.push('apple'), { claim: null, calls: 1 }) } as unknown as AppleLookup;
		const log = createLogger(() => {});
		expect(await drainFollowUps({ db, log, readers: { tidal, apple } })).toEqual({ releases: 1, linked: 0, requeued: 1 });
		expect(asked).toEqual(['tidal']);
		// Kept with what was asked, until the day turns (UTC).
		expect(await db.query(`select asked, not_before = ((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc' as tomorrow from curator.catalog_work_followup`)).toEqual([{ asked: ['tidal'], tomorrow: true }]);
		// Every run until then takes nothing, and spends nothing of Tidal's day.
		for (let i = 0; i < 3; i++) expect(await drainFollowUps({ db, log, readers: { tidal, apple } })).toEqual({ releases: 0, linked: 0, requeued: 0 });
		expect(await db.query(`select units_used from curator.provider_budget where provider = 'tidal'`)).toEqual([{ units_used: 3 }]);
		// Due again with Apple still spent: Tidal, already asked, is not asked a second time.
		await db.query(`update curator.catalog_work_followup set not_before = now() - interval '1 minute'`);
		expect(await drainFollowUps({ db, log, readers: { tidal, apple } })).toEqual({ releases: 1, linked: 0, requeued: 1 });
		expect(asked).toEqual(['tidal']);
		// Apple's day back: asked, and the release leaves the queue.
		await db.query(`update curator.provider_budget set units_used = 0 where provider = 'apple'`);
		await db.query(`update curator.catalog_work_followup set not_before = now() - interval '1 minute'`);
		expect(await drainFollowUps({ db, log, readers: { tidal, apple } })).toEqual({ releases: 1, linked: 0, requeued: 0 });
		expect(asked).toEqual(['tidal', 'apple']);
		expect(await db.query(`select 1 from curator.catalog_work_followup`)).toEqual([]);
	});
});

describe('what device work stops keeping', () => {
	it("drops a report's stored answer after a day and what was learned once it is older than every age, and keeps who said what and a listing's memory", async () => {
		const { db } = await createTestDb();
		await withSystemTx(db, (tx) => ingestClaims(tx, [release('spotify', 'sr1', '4066004975924')], { reason: 'tracker' }));
		const [rel] = await db.query<{ id: string }>(`select id from curator.catalog_object where kind = 'release'`);
		const [art] = await db.query<{ id: string }>(`select id from curator.catalog_object where kind = 'artist'`);
		const user = '11111111-1111-4111-8111-111111111111';
		await db.query(
			`insert into curator.catalog_work_report (user_id, device_id, idempotency_key, profile, result, at) values
				($1, 'd1', 'old-00001', '{}', '{"results": []}', now() - interval '2 days'),
				($1, 'd1', 'new-00001', '{}', '{"results": []}', now() - interval '2 hours')`,
			[user],
		);
		await db.query(`insert into curator.catalog_work_item (report_id, job_id, object_id, provider, kind, provider_id, outcome) select id, 'release:x', $1, 'deezer', 'release', 'dz1', 'linked' from curator.catalog_work_report where idempotency_key = 'old-00001'`, [rel!.id]);
		await db.query(
			`insert into curator.catalog_work_state (object_id, job, provider, provider_id, outcome, answered_at) values
				($1, 'release', 'deezer', '', 'not_found', now() - interval '120 days'),
				($1, 'check', 'spotify', 'sr1', 'read', now() - interval '80 days'),
				($2, 'find', 'spotify', 'sa1', 'ok', now() - interval '400 days')`,
			[rel!.id, art!.id],
		);
		expect(await pruneWork(db)).toEqual({ answers: 1, state: 1 });
		expect(await db.query(`select idempotency_key, result is null as dropped from curator.catalog_work_report order by idempotency_key`)).toEqual([
			{ idempotency_key: 'new-00001', dropped: false },
			{ idempotency_key: 'old-00001', dropped: true },
		]);
		expect(await db.query(`select count(*)::int as n from curator.catalog_work_item`)).toEqual([{ n: 1 }]);
		expect(await db.query(`select job from curator.catalog_work_state order by job`)).toEqual([{ job: 'check' }, { job: 'find' }]);
		// Nothing left to drop.
		expect(await pruneWork(db)).toEqual({ answers: 0, state: 0 });
	});
});
