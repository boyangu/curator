import { randomUUID } from 'node:crypto';
import type { CatalogClaim } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { withSystemTx } from '../db/system-tx.js';
import { asUser, createTestApp, createTestDb, errorReason, ROLES_SQL } from '../test/harness.js';
import { createLogger } from '../log.js';
import { ingestClaims } from './ingest.js';
import { nextDueAt } from './trackers/cadence.js';
import { runTrackers } from './trackers/sweep.js';
import type { TrackerAdapter, TrackerPoll, TrackerTarget } from './trackers/types.js';

const DAY = 86400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function artist(provider: 'spotify' | 'deezer', id: string, name: string): CatalogClaim {
	return { provider, kind: 'artist', providerId: id, name };
}

function release(
	provider: 'spotify' | 'deezer',
	id: string,
	title: string,
	artists: CatalogClaim[],
	opts: { date?: string; upc?: string; tracks?: { id: string; title: string; isrc?: string; dur?: number }[]; label?: string } = {},
): CatalogClaim {
	return {
		provider,
		kind: 'release',
		providerId: id,
		name: title,
		identifiers: opts.upc ? [{ namespace: 'upc', value: opts.upc }] : [],
		facts: { releaseDate: opts.date ?? iso(Date.now()), releaseType: 'single', ...(opts.label ? { labelText: opts.label } : {}) },
		artists,
		recordings: (opts.tracks ?? [{ id: `${id}-t1`, title }]).map((t) => ({
			provider,
			kind: 'recording' as const,
			providerId: t.id,
			name: t.title,
			identifiers: t.isrc ? [{ namespace: 'isrc' as const, value: t.isrc }] : [],
			facts: t.dur ? { durationSec: t.dur } : {},
		})),
	};
}

async function count(db: { query: (s: string, p?: (string | null)[]) => Promise<unknown[]> }, sql: string, params: (string | null)[] = []): Promise<number> {
	const [row] = (await db.query(sql, params)) as { n: unknown }[];
	return Number(row!.n);
}

// A provider whose listings the test sets per tracked object.
class FakeTracker implements TrackerAdapter {
	readonly kinds = ['artist', 'label'] as const;
	readonly callsPerPoll = 1;
	listings = new Map<string, CatalogClaim[]>();
	polls: TrackerTarget[] = [];
	fail: Error | null = null;
	constructor(readonly provider: 'spotify' | 'deezer') {}
	async poll(target: TrackerTarget): Promise<TrackerPoll> {
		this.polls.push(target);
		if (this.fail) throw this.fail;
		const children = this.listings.get(target.representation?.providerId ?? target.object.name) ?? [];
		return { children, listingHash: children.map((c) => c.providerId).join(','), cursor: { seen: children.length }, calls: 1 };
	}
}

const quiet = createLogger(() => {});

async function settle(pg: { query: (s: string) => Promise<unknown> }): Promise<void> {
	await pg.query(`update curator.catalog_event set first_seen_at = first_seen_at - interval '5 minutes'`);
}

describe('ingestion', () => {
	it('creates only what is missing; the same claims twice change nothing', async () => {
		const { db } = await createTestDb();
		const a = artist('spotify', 'sa1', 'Northfold');
		const r = release('spotify', 'sr1', 'Glass Rivers', [a], { tracks: [{ id: 'st1', title: 'Glass Rivers', isrc: 'GBAAA2600001', dur: 400 }] });
		const first = await withSystemTx(db, (tx) => ingestClaims(tx, [r], { reason: 'library_import' }));
		expect(first.created).toBe(3);
		const again = await withSystemTx(db, (tx) => ingestClaims(tx, [r], { reason: 'library_import' }));
		expect(again.created).toBe(0);
		expect(again.attached).toBe(0);
		expect(again.outcomes[0]!.objectId).toBe(first.outcomes[0]!.objectId);
		expect(await count(db, `select count(*) as n from curator.catalog_object where kind <> 'genre'`)).toBe(3);
	});

	it("joins another provider's copy of a release by UPC and its artist by corroboration, never by name alone", async () => {
		const { db } = await createTestDb();
		const sp = release('spotify', 'sr1', 'Glass Rivers', [artist('spotify', 'sa1', 'Northfold')], { upc: '0123456789012' });
		const dz = release('deezer', 'dr1', 'Glass Rivers', [artist('deezer', 'da1', 'Northfold')], { upc: '123456789012' });
		// A namesake on an unrelated release stays a different artist.
		const other = release('deezer', 'dr2', 'Elsewhere', [artist('deezer', 'da9', 'Northfold')]);
		const a = await withSystemTx(db, (tx) => ingestClaims(tx, [sp], { reason: 'library_import' }));
		const b = await withSystemTx(db, (tx) => ingestClaims(tx, [dz, other], { reason: 'library_import' }));
		expect(b.outcomes[0]!.objectId).toBe(a.outcomes[0]!.objectId);
		const artists = await db.query<{ id: string; reps: string }>(
			`select o.id, string_agg(so.provider || ':' || so.provider_id, ',' order by so.provider_id) as reps
			from curator.catalog_object o join curator.catalog_source_object so on so.object_id = o.id
			where o.kind = 'artist' group by o.id order by reps`,
		);
		expect(artists.map((x) => x.reps)).toEqual(['deezer:da1,spotify:sa1', 'deezer:da9']);
	});

	it("joins a track's credit to the release's namesake across stores, keeps a store's second id apart, and never mints a third copy", async () => {
		const { db } = await createTestDb();
		const upc = { upc: '0123456789012' };
		const sp = release('spotify', 'sr1', 'Glass Rivers', [artist('spotify', 'sa1', 'Northfold')], upc);
		// Deezer credits the release to one profile and a track of its own (no
		// other store's) to another: the track's copy is on the release the
		// track arrives in, but Deezer holds that copy already — two ids, two
		// people as far as Deezer knows.
		const dz: CatalogClaim = {
			...release('deezer', 'dr1', 'Glass Rivers', [artist('deezer', 'da1', 'Northfold')], upc),
			recordings: [{ provider: 'deezer', kind: 'recording', providerId: 'dt1', name: 'Glass Rivers (Dub)', artists: [artist('deezer', 'da2', 'Northfold')] }],
		};
		// Tidal credits the artist on a track of its own only; its release has none.
		const ti: CatalogClaim = {
			...release('deezer', 'tr1', 'Glass Rivers', [], upc),
			provider: 'tidal' as CatalogClaim['provider'],
			recordings: [{ provider: 'tidal' as CatalogClaim['provider'], kind: 'recording', providerId: 'tt1', name: 'Glass Rivers (Live)', artists: [{ ...artist('deezer', 'ta1', 'Northfold'), provider: 'tidal' as CatalogClaim['provider'] }] }],
		};
		await withSystemTx(db, (tx) => ingestClaims(tx, [sp], { reason: 'library_import' }));
		await withSystemTx(db, (tx) => ingestClaims(tx, [dz], { reason: 'library_import' }));
		await withSystemTx(db, (tx) => ingestClaims(tx, [ti], { reason: 'library_import' }));
		const reps = async () =>
			(
				await db.query<{ reps: string }>(
					`select string_agg(so.provider || ':' || so.provider_id, ',' order by so.provider, so.provider_id) as reps
					from curator.catalog_object o join curator.catalog_source_object so on so.object_id = o.id
					where o.kind = 'artist' and o.merged_into is null group by o.id order by reps`,
				)
			).map((x) => x.reps);
		// Two copies on the release (Deezer's second id apart), Tidal's joined to
		// the one more stores hold — not a third.
		expect(await reps()).toEqual(['deezer:da1,spotify:sa1,tidal:ta1', 'deezer:da2']);
		// Apple's release-level credit then meets two copies on the release and
		// still joins one rather than minting another.
		const ap: CatalogClaim = { ...release('deezer', 'ar1', 'Glass Rivers', [{ ...artist('deezer', 'aa1', 'Northfold'), provider: 'apple' as CatalogClaim['provider'] }], upc), provider: 'apple' as CatalogClaim['provider'], recordings: [] };
		await withSystemTx(db, (tx) => ingestClaims(tx, [ap], { reason: 'library_import' }));
		expect(await reps()).toEqual(['apple:aa1,deezer:da1,spotify:sa1,tidal:ta1', 'deezer:da2']);
	});

	it('matches a recording by ISRC unless the lengths disagree', async () => {
		const { db } = await createTestDb();
		const a = artist('spotify', 'sa1', 'Northfold');
		await withSystemTx(db, (tx) => ingestClaims(tx, [release('spotify', 'sr1', 'One', [a], { tracks: [{ id: 'st1', title: 'One', isrc: 'GBAAA2600001', dur: 300 }] })], { reason: 'library_import' }));
		const near = release('deezer', 'dr1', 'One', [artist('deezer', 'da1', 'Northfold')], { tracks: [{ id: 'dt1', title: 'One', isrc: 'gb-aaa-26-00001', dur: 305 }] });
		const far = release('deezer', 'dr2', 'One (Extended)', [artist('deezer', 'da1', 'Northfold')], { tracks: [{ id: 'dt2', title: 'One (Extended Mix)', isrc: 'GBAAA2600001', dur: 480 }] });
		await withSystemTx(db, (tx) => ingestClaims(tx, [near, far], { reason: 'library_import' }));
		expect(await count(db, `select count(*) as n from curator.catalog_object where kind = 'recording'`)).toBe(2);
	});

	it('keeps the first value of a static fact; a later source only fills empty fields', async () => {
		const { db } = await createTestDb();
		const a = [artist('spotify', 'sa1', 'Northfold')];
		const sp = release('spotify', 'sr1', 'Glass Rivers', a, { upc: '111111111111', date: '2026-10-23' });
		const dz = { ...release('deezer', 'dr1', 'Glass Rivers', [artist('deezer', 'da1', 'Northfold')], { upc: '111111111111', date: '2026-10-24', label: 'Northfold Records' }) };
		await withSystemTx(db, (tx) => ingestClaims(tx, [sp], { reason: 'library_import' }));
		await withSystemTx(db, (tx) => ingestClaims(tx, [dz], { reason: 'library_import' }));
		const [rel] = await db.query<{ attrs: string; label_text: string }>(`select attrs::text as attrs, label_text from curator.catalog_object where kind = 'release'`);
		const attrs = JSON.parse(rel!.attrs) as Record<string, unknown>;
		expect(attrs.releaseDate).toBe('2026-10-23');
		expect(attrs.labelText).toBe('Northfold Records');
		expect(rel!.label_text).toBe('Northfold Records');
		// Both sources' dates are kept as facts.
		expect(await count(db, `select count(*) as n from curator.catalog_fact where field = 'releaseDate'`)).toBe(2);
	});

	it('maps provider genre strings onto the taxonomy and records unknown ones for review', async () => {
		const { db } = await createTestDb();
		const r = { ...release('spotify', 'sr1', 'Glass Rivers', [artist('spotify', 'sa1', 'Northfold')]), genres: ['melodic techno', 'zydeco fusion'] };
		await withSystemTx(db, (tx) => ingestClaims(tx, [r], { reason: 'library_import' }));
		const genres = await db.query<{ name: string }>(
			`select g.name from curator.catalog_edge e join curator.catalog_object g on g.id = e.dst where e.kind = 'object-genre'`,
		);
		expect(genres.map((g) => g.name)).toEqual(['Melodic House & Techno']);
		expect(await count(db, `select count(*) as n from curator.genre_alias where provider = 'spotify' and raw_fold = 'zydeco fusion' and genre_id is null`)).toBe(1);
	});
});

describe('watches and tracking', () => {
	it('an import creates objects but no events and no tracking; a watch starts tracking', async () => {
		const app = await createTestApp();
		const { api, deviceId } = await app.signIn();
		const imported = await api.catalog.ingest.mutate({
			deviceId,
			reason: 'library_import',
			idempotencyKey: 'library-batch-0001',
			claims: [release('spotify', 'sr1', 'Glass Rivers', [artist('spotify', 'sa1', 'Northfold')])],
		});
		expect(imported.created).toBe(3);
		expect(await count(app.db, `select count(*) as n from curator.catalog_event`)).toBe(0);
		expect(await count(app.db, `select count(*) as n from curator.catalog_cursor`)).toBe(0);
		// The same key again is answered from the first run.
		const dup = await api.catalog.ingest.mutate({ deviceId, reason: 'library_import', idempotencyKey: 'library-batch-0001', claims: [] });
		expect(dup.duplicate).toBe(true);
		expect(dup.created).toBe(3);

		const w = await api.catalog.watch.mutate({ deviceId, claim: artist('spotify', 'sa1', 'Northfold'), source: 'manual' });
		expect(w.watch.object.name).toBe('Northfold');
		expect(w.watch.tracking.map((t) => t.provider)).toEqual(['spotify']);
		// Deezer's artist tracker needs a Deezer id; it gains one with the representation.
		await withSystemTx(app.db, (tx) =>
			ingestClaims(tx, [release('deezer', 'dr1', 'Glass Rivers', [artist('deezer', 'da1', 'Northfold')], { date: iso(Date.now()) })], { reason: 'enrichment' }),
		);
		// Corroborated through the release both providers list.
		const [list] = await api.catalog.listWatches.query({ deviceId });
		expect(list!.tracking.map((t) => t.provider)).toEqual(['deezer', 'spotify']);

		await api.catalog.unwatch.mutate({ deviceId, objectId: w.watch.object.id });
		expect(await count(app.db, `select count(*) as n from curator.catalog_cursor`)).toBe(0);
	});

	it('refuses to watch a release, and an unknown object', async () => {
		const app = await createTestApp();
		const { api, deviceId } = await app.signIn();
		expect((await errorReason(api.catalog.watch.mutate({ deviceId, claim: release('spotify', 'sr1', 'X', []), source: 'manual' }))).reason).toBe('catalog_claim_invalid');
		expect((await errorReason(api.catalog.watch.mutate({ deviceId, objectId: randomUUID(), source: 'manual' }))).reason).toBe('catalog_not_found');
	});

	it("a user cannot read another user's watches", async () => {
		const app = await createTestApp();
		const a = await app.signIn();
		const b = await app.signIn();
		await a.api.catalog.watch.mutate({ deviceId: a.deviceId, claim: artist('spotify', 'sa1', 'Northfold'), source: 'manual' });
		expect(await b.api.catalog.listWatches.query({ deviceId: b.deviceId })).toEqual([]);
		const rows = await asUser(app.pg, b.userId, (tx) => tx.query('select * from curator.catalog_watch'));
		expect(rows.rows).toHaveLength(0);
	});
});

describe('trackers and events', () => {
	async function setup() {
		const app = await createTestApp();
		const fan = await app.signIn();
		const other = await app.signIn();
		const w = await fan.api.catalog.watch.mutate({ deviceId: fan.deviceId, claim: artist('spotify', 'sa1', 'Northfold'), source: 'manual' });
		const spotify = new FakeTracker('spotify');
		const run = (now = Date.now()) => runTrackers({ db: app.db, log: quiet, adapters: [spotify], holder: 'test', now: () => now, sleep: async () => {} });
		return { app, fan, other, objectId: w.watch.object.id, spotify, run };
	}

	it("announces recent releases only, once, and not an artist's back catalogue", async () => {
		const { app, fan, spotify, run } = await setup();
		const a = artist('spotify', 'sa1', 'Northfold');
		spotify.listings.set('sa1', [
			release('spotify', 'old', 'Old Album', [a], { date: iso(Date.now() - 400 * DAY) }),
			release('spotify', 'new', 'New Single', [a], { date: iso(Date.now() - 2 * DAY) }),
		]);
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'artist' and scanned_at is not null`)).toEqual([]);
		const [pass] = await run();
		expect(pass).toMatchObject({ claimed: 1, polled: 1, events: 1 });
		// A successful poll is a scan.
		expect(await app.db.query(`select 1 from curator.catalog_object where kind = 'artist' and scanned_at is not null`)).toHaveLength(1);
		await settle(app.pg);
		const { events, nextSeq } = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(events.map((e) => [e.kind, (e.card as { title: string }).title])).toEqual([['new_release', 'New Single']]);
		expect(events[0]!.subjects.map((s) => s.name)).toContain('Northfold');

		// Not due yet: nothing runs. Due again with the same listing: one call, no ingest.
		expect((await run())[0]!.claimed).toBe(0);
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		const [quietPass] = await run();
		expect(quietPass).toMatchObject({ polled: 1, unchanged: 1, events: 0 });

		// A new release appears.
		spotify.listings.get('sa1')!.push(release('spotify', 'newer', 'Newer Single', [a], { date: iso(Date.now()) }));
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		expect((await run())[0]!.events).toBe(1);
		await settle(app.pg);
		const more = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: nextSeq });
		expect(more.events.map((e) => (e.card as { title: string }).title)).toEqual(['Newer Single']);
	});

	it('a release known before (imported) is still announced once when a tracker first sees it; known tracks make it a reissue', async () => {
		const { app, fan, spotify, run } = await setup();
		const a = artist('spotify', 'sa1', 'Northfold');
		const track = { id: 'st1', title: 'Glass Rivers', isrc: 'GBAAA2600001', dur: 400 };
		// Imported first, a year ago: the recording is known.
		await withSystemTx(app.db, (tx) => ingestClaims(tx, [release('spotify', 'orig', 'Glass Rivers', [a], { date: iso(Date.now() - 365 * DAY), tracks: [track] })], { reason: 'library_import' }));
		await app.pg.query(`update curator.catalog_object set discovered_at = now() - interval '300 days'`);
		spotify.listings.set('sa1', [release('spotify', 'comp', 'Best Of 2026', [a], { date: iso(Date.now() - DAY), tracks: [{ ...track, id: 'st9' }] })]);
		await run();
		await settle(app.pg);
		const { events } = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		expect(events.map((e) => [e.kind, e.recordingsNew])).toEqual([['reissue', 0]]);
	});

	it('only watchers see an event; a muted watch hides it', async () => {
		const { app, fan, other, objectId, spotify, run } = await setup();
		spotify.listings.set('sa1', [release('spotify', 'new', 'New Single', [artist('spotify', 'sa1', 'Northfold')])]);
		await run();
		await settle(app.pg);
		const theirs = await other.api.feed.events.query({ deviceId: other.deviceId, afterSeq: 0 });
		expect(theirs.events).toEqual([]);
		// Their cursor still moves past it.
		expect(theirs.nextSeq).toBeGreaterThan(0);
		await fan.api.catalog.mute.mutate({ deviceId: fan.deviceId, objectId, muted: true });
		expect((await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 })).events).toEqual([]);
	});

	it("Load more returns the window of a watcher's events, past its cursor; a muted watch none", async () => {
		const { app, fan, objectId, spotify, run } = await setup();
		spotify.listings.set('sa1', [release('spotify', 'new', 'New Single', [artist('spotify', 'sa1', 'Northfold')])]);
		await run();
		const r = await fan.api.feed.recent.query({ deviceId: fan.deviceId, days: 14 });
		expect(r.events.map((e) => (e.card as { title: string }).title)).toEqual(['New Single']);
		await fan.api.catalog.mute.mutate({ deviceId: fan.deviceId, objectId, muted: true });
		expect((await fan.api.feed.recent.query({ deviceId: fan.deviceId, days: 14 })).events).toEqual([]);
		void app;
	});

	it('the same release from a second provider stays one event, re-announced with its new handles', async () => {
		const { app, fan, spotify, run } = await setup();
		const deezer = new FakeTracker('deezer');
		const sp = release('spotify', 'new', 'New Single', [artist('spotify', 'sa1', 'Northfold')], { upc: '222222222222' });
		const dz = release('deezer', 'dnew', 'New Single', [artist('deezer', 'da1', 'Northfold')], { upc: '222222222222' });
		// The artist's Deezer id arrives by enrichment, through an old release both list.
		const back = { date: iso(Date.now() - 300 * DAY), upc: '333333333333' };
		await withSystemTx(app.db, (tx) =>
			ingestClaims(
				tx,
				[release('spotify', 'sold', 'Back Catalogue', [artist('spotify', 'sa1', 'Northfold')], back), release('deezer', 'dold', 'Back Catalogue', [artist('deezer', 'da1', 'Northfold')], back)],
				{ reason: 'enrichment' },
			),
		);
		// Deezer finds the new release first.
		deezer.listings.set('da1', [dz]);
		const runDeezer = () => runTrackers({ db: app.db, log: quiet, adapters: [deezer], holder: 'test', sleep: async () => {} });
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		await runDeezer();
		await settle(app.pg);
		const first = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: 0 });
		const handles = (e: (typeof first.events)[number]) => (e.card as { handles: { provider: string }[] }).handles.map((h) => h.provider).sort();
		expect(first.events.map(handles)).toEqual([['deezer']]);

		// Spotify's tracker reaches it: the device, past the first event, reads it again with both handles.
		spotify.listings.set('sa1', [sp]);
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		await run();
		await settle(app.pg);
		const again = await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: first.nextSeq });
		expect(again.events.map(handles)).toEqual([['deezer', 'spotify']]);
		expect(again.events[0]!.subjects.map((s) => s.name)).toEqual(['Northfold']);
		expect(await count(app.db, `select count(*) as n from curator.catalog_event`)).toBe(1);

		// Deezer seeing it again changes nothing.
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		deezer.listings.set('da1', [dz, release('deezer', 'dother', 'Other', [artist('deezer', 'da1', 'Northfold')], { date: iso(Date.now() - 300 * DAY) })]);
		await runDeezer();
		await settle(app.pg);
		expect((await fan.api.feed.events.query({ deviceId: fan.deviceId, afterSeq: again.nextSeq })).events).toEqual([]);
		expect(await count(app.db, `select count(*) as n from curator.catalog_source_object where kind = 'release'`)).toBe(5);
	});

	it('a failing poll backs off; a quota ends the pass', async () => {
		const { app, spotify, run } = await setup();
		spotify.fail = new Error('boom');
		const [pass] = await run();
		expect(pass!.failed).toBe(1);
		const [cur] = await app.db.query<{ fail_count: number; due_in: number }>(
			`select fail_count, extract(epoch from next_due_at - now()) as due_in from curator.catalog_cursor`,
		);
		expect(cur!.fail_count).toBe(1);
		expect(Number(cur!.due_in)).toBeGreaterThan(10 * 60);
		await app.pg.query(`update curator.tracker set budget = '{"perDay": 0, "minGapMs": 0}' where provider = 'spotify'`);
		await app.pg.query(`update curator.catalog_cursor set next_due_at = now() - interval '1 minute'`);
		spotify.fail = null;
		const [out] = await run();
		expect(out).toMatchObject({ claimed: 1, polled: 0, budgetOut: true });
	});
});

describe('quota and cadence', () => {
	it('two workers never reserve past the cap', async () => {
		const { db } = await createTestDb();
		const grants = await Promise.all(
			Array.from({ length: 8 }, () => db.query<{ n: number }>(`select curator.catalog_reserve_calls('spotify', 3, 10) as n`).then((r) => Number(r[0]!.n))),
		);
		expect(grants.reduce((a, b) => a + b, 0)).toBe(10);
	});

	it('polls tighter inside the Friday window and snaps to its start', () => {
		const cadence = { everyMin: 1440, friday: { fromUtc: '00:00', toUtc: '12:00', everyMin: 120 } };
		const thursdayNoon = Date.UTC(2026, 9, 22, 12);
		expect(new Date(nextDueAt(thursdayNoon, cadence)).toISOString()).toBe('2026-10-23T00:00:00.000Z');
		const fridayTwo = Date.UTC(2026, 9, 23, 2);
		expect(new Date(nextDueAt(fridayTwo, cadence)).toISOString()).toBe('2026-10-23T04:00:00.000Z');
		const saturday = Date.UTC(2026, 9, 24, 9);
		expect(new Date(nextDueAt(saturday, cadence)).toISOString()).toBe('2026-10-25T09:00:00.000Z');
	});
});

describe('access', () => {
	it('the shared catalogue is the API role\'s alone', async () => {
		const { pg, db, createUser } = await createTestDb();
		await pg.exec(ROLES_SQL);
		const user = await createUser();
		await withSystemTx(db, (tx) => ingestClaims(tx, [release('spotify', 'sr1', 'X', [artist('spotify', 'sa1', 'Y')])], { reason: 'library_import' }));
		await expect(asUser(pg, user, (tx) => tx.query('select * from curator.catalog_object'))).rejects.toThrow(/permission denied/);
		await expect(asUser(pg, user, (tx) => tx.query(`insert into curator.catalog_object (kind, name, name_fold, discovered_via) values ('artist', 'x', 'x', 'tracker')`))).rejects.toThrow(
			/permission denied/,
		);
		const visible = await pg.transaction(async (tx) => {
			await tx.query('set local role curator_api');
			return (await tx.query('select count(*) as n from curator.catalog_object')).rows;
		});
		expect(Number((visible[0] as { n: number }).n)).toBeGreaterThan(0);
	});

	it('is refused on a server without it, and advertised on one with it', async () => {
		const off = await createTestApp({ catalog: false });
		const { api, deviceId } = await off.signIn();
		expect((await errorReason(api.feed.events.query({ deviceId, afterSeq: 0 }))).reason).toBe('catalog_disabled');
		expect((await off.client().health.query()).features).not.toContain('global_catalog');
		const on = await createTestApp();
		expect((await on.client().health.query()).features).toContain('global_catalog');
	});
});
