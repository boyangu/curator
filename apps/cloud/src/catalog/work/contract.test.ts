// The device-work engine (@curator/catalog-work) against the real cloud: a
// signed-in device opens an artist's page, does the work the read hands it
// over fake stores, and reports through catalog.workReport — the seam where
// the defects of the first two reviews sat, each side right on its own and
// wrong together (2026-11-27). Nothing here is mocked on the cloud's side.

import { createWorkEngine, type FactHit, type WorkEvent, type WorkReaders } from '@curator/catalog-work';
import type { CatalogClaim, CatalogHandle } from '@curator/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { withSystemTx } from '../../db/system-tx.js';
import { createTestApp, type TestApp } from '../../test/harness.js';
import { ingestClaims } from '../ingest.js';
import { pageTracks } from '../pages.js';
import { setWorkSetting } from './settings.js';

const MARSH: CatalogClaim = { provider: 'spotify', kind: 'artist', providerId: 'sa1', name: 'Marsh', url: 'https://open.spotify.com/artist/sa1' };
const recent = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);

type Tracks = [title: string, sec: number, isrc?: string][];
function release(provider: CatalogClaim['provider'], id: string, title: string, tracks: Tracks = [], date = '2026-01-01'): CatalogClaim {
	return {
		provider,
		kind: 'release',
		providerId: id,
		name: title,
		url: `https://example.test/${provider}/${id}`,
		facts: { releaseDate: date },
		artists: [provider === 'spotify' ? MARSH : { provider, kind: 'artist', providerId: `${provider}-marsh`, name: 'Marsh' }],
		recordings: tracks.map(([t, sec, isrc], i) => ({
			provider,
			kind: 'recording',
			providerId: `${id}-t${i + 1}`,
			name: t,
			...(isrc ? { identifiers: [{ namespace: 'isrc' as const, value: isrc }] } : {}),
			facts: { trackNumber: i + 1, durationSec: sec },
		})),
	};
}

// The stores as the fake world has them.
const LAILONIE = release('spotify', 'sr1', 'Lailonie', [['Lailonie', 300], ['Eu Topos', 410]]);
const BARE = release('spotify', 'sr2', 'Bare Listing');
const BARE_FULL = release('spotify', 'sr2', 'Bare Listing', [['One', 200], ['Two', 240]]);
const GLASS_LISTED = release('spotify', 'sr9', 'Glass Rivers', [], recent);
const GLASS_FULL = release('spotify', 'sr9', 'Glass Rivers', [['Glass Rivers', 333, 'GBKQU2600009'], ['Glass Rivers (Dub)', 344, 'GBKQU2600010']], recent);
const GLASS_DEEZER = release('deezer', 'dz9', 'Glass Rivers', [['Glass Rivers', 333, 'GBKQU2600009'], ['Glass Rivers (Dub)', 344, 'GBKQU2600010']], recent);

let app: TestApp;
let api: Awaited<ReturnType<TestApp['signIn']>>['api'];
let deviceId: string;

beforeEach(async () => {
	app = await createTestApp();
	({ api, deviceId } = await app.signIn());
	await withSystemTx(app.db, async (tx) => {
		await ingestClaims(tx, [LAILONIE, BARE], { reason: 'tracker' });
		await setWorkSetting(tx, 'work.enabled', true);
	});
});

const idOf = async (kind: string, name: string): Promise<string> => (await app.db.query<{ id: string }>(`select id from curator.catalog_object where kind = $1 and name = $2 and merged_into is null`, [kind, name]))[0]!.id;

function device(readers: Partial<WorkReaders>) {
	const outcomes: { jobId: string; outcome: string; note?: string }[] = [];
	const events: WorkEvent[] = [];
	const engine = createWorkEngine({
		form: 'phone',
		enabled: () => true,
		fetch: () => Promise.reject(new Error('no network in tests')),
		beatportFetch: () => Promise.reject(new Error('no network in tests')),
		traxsourceFetch: () => Promise.reject(new Error('no network in tests')),
		spotifyToken: async () => 'token',
		report: async (input) => {
			const r = await api.catalog.workReport.mutate({ deviceId, ...input });
			outcomes.push(...r.results);
			return r;
		},
		sleep: async () => {},
		gaps: { spotify: 0, deezer: 0, beatport: 0, bandcamp: 0, traxsource: 0 },
		readers,
	});
	// A page visit: the read hands the work, the engine does it.
	const visit = async (objectId: string): Promise<number> => {
		const v = engine.visit();
		const page = await api.catalog.tracks.query({ deviceId, id: objectId, profile: engine.profile(v) });
		if (!page.work) return 0;
		await engine.run(page.work, { visit: v, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
		return page.work.jobs.length;
	};
	return { engine, outcomes, events, visit };
}

const stores: Partial<WorkReaders> = {
	listing: async (store, target) => {
		if (store !== 'spotify' || target.representation?.providerId !== 'sa1') throw new Error(`unexpected listing ${store}`);
		return { children: [LAILONIE, BARE, GLASS_LISTED].map((c) => ({ ...c, recordings: [] })), listingHash: 'h1', cursor: { seen: ['sr1', 'sr2', 'sr9'] }, calls: 1 };
	},
	release: async (h: CatalogHandle) => (h.provider === 'spotify' && h.id === 'sr2' ? BARE_FULL : h.provider === 'spotify' && h.id === 'sr9' ? GLASS_FULL : null),
	byIsrc: async (store, isrc) => (store === 'deezer' && isrc === 'GBKQU2600009' ? GLASS_DEEZER : null),
	byUpc: async () => null,
	byName: async () => [],
	facts: async (store, q): Promise<FactHit | null> =>
		store === 'beatport' && q.title === 'Eu Topos'
			? { id: 'bp-eu', url: 'https://www.beatport.com/track/eu-topos/1', title: 'Eu Topos', mix: null, isrc: null, durationSec: null, bpm: 124, key: 'F♯ Minor', genre: 'Melodic House & Techno', label: null, artists: ['Marsh'] }
			: null,
};

describe('a phone opening an artist page, end to end', () => {
	it("reads what the cloud asks, and the cloud keeps all of it: a new release, its tracklist, its Deezer page, a bare release's tracks, a track's facts", async () => {
		const marsh = await idOf('artist', 'Marsh');
		await api.catalog.watch.mutate({ deviceId, objectId: marsh, source: 'manual' });
		const phone = device(stores);
		await phone.visit(marsh);

		// Nothing the engine sent was refused or lost.
		expect(phone.outcomes.filter((o) => o.outcome === 'refused' || o.outcome === 'failed')).toEqual([]);
		expect(phone.events.some((e) => e.type === 'unsent')).toBe(false);

		// The listing's new release is in the catalogue, completed in the follow-up round,
		// found at Deezer by its ISRC — and announced to the follower at once.
		const glass = await idOf('release', 'Glass Rivers');
		const page = await withSystemTx(app.db, async (tx) => pageTracks(tx, marsh));
		const byTitle = new Map(page!.releases.map((r) => [r.title, r]));
		expect(byTitle.get('Glass Rivers')!.tracks.map((t) => t.title)).toEqual(['Glass Rivers', 'Glass Rivers (Dub)']);
		expect(byTitle.get('Glass Rivers')!.handles.map((h) => h.provider).sort()).toEqual(['deezer', 'spotify']);
		expect(await app.db.query(`select raised_by from curator.catalog_event where dedupe_key = $1`, [`release:${glass}`])).toEqual([{ raised_by: `device:${deviceId}` }]);
		// The bare release read in full; Lailonie's track has Beatport's facts.
		expect(byTitle.get('Bare Listing')!.tracks.map((t) => t.title)).toEqual(['One', 'Two']);
		expect(byTitle.get('Lailonie')!.tracks.map((t) => [t.title, t.bpm])).toEqual([['Lailonie', null], ['Eu Topos', 124]]);
		// Tidal and Apple are the cloud's to ask next, for what was completed.
		expect((await app.db.query<{ release_id: string }>(`select release_id from curator.catalog_work_followup`)).length).toBeGreaterThan(0);
		// Who said so: this device, on every item.
		expect(await app.db.query(`select distinct r.device_id from curator.catalog_work_item i join curator.catalog_work_report r on r.id = i.report_id`)).toEqual([{ device_id: deviceId }]);
		// What it found showed on the page before the cloud had it.
		expect(phone.events.find((e) => e.type === 'found')).toMatchObject({ objectId: marsh });
		expect(phone.events.some((e) => e.type === 'rows')).toBe(true);
	});

	it('hands the next visit only what is still due, and a second device the same quiet', async () => {
		const marsh = await idOf('artist', 'Marsh');
		const first = await device(stores).visit(marsh);
		expect(first).toBeGreaterThan(0);
		// What was answered keeps quiet: no listing, no tracklist, no store looked at again.
		const again = device(stores);
		const handed = await api.catalog.tracks.query({ deviceId, id: marsh, profile: again.engine.profile(again.engine.visit()) });
		const kinds = (handed.work?.jobs ?? []).map((j) => j.kind);
		expect(kinds).not.toContain('find');
		expect(kinds).not.toContain('release');
	});

	it("keeps nothing a store's lookalike says: a title search that finds another release is not linked", async () => {
		const marsh = await idOf('artist', 'Marsh');
		const lookalike = release('deezer', 'dz5', 'Lailonie', [['Lailonie', 300], ['Other', 200], ['More', 250], ['And More', 260]]);
		const phone = device({ ...stores, byIsrc: async () => null, byName: async (store) => (store === 'deezer' ? [async () => lookalike] : []) });
		await phone.visit(marsh);
		const lailonie = await idOf('release', 'Lailonie');
		expect(await app.db.query(`select provider from curator.catalog_source_object where object_id = $1 and kind = 'release' order by provider`, [lailonie])).toEqual([{ provider: 'spotify' }]);
		// The engine did not even send it: it confirms by the cloud's rule before it shows anything.
		expect(phone.outcomes.filter((o) => o.outcome === 'unconfirmed')).toEqual([]);
	});
});
