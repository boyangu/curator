// The whole-name check outside the catalogue (made-up names): each source is
// asked once per name and its answer kept, "no artist of that name" included;
// a refused call keeps nothing and ends the batch.

import { describe, expect, it } from 'vitest';
import { TrackerRateLimitedError, type SpotifyReader } from '@curator/catalog-readers';
import { createTestApp } from '../test/harness.js';
import { lookUpNames, nameAnswers } from './name-lookup.js';

// MusicBrainz: the duo is a group there; one name is refused (its 503).
function musicbrainz() {
	const calls: string[] = [];
	const fetch = async (url: string) => {
		const q = new URL(url).searchParams.get('query') ?? '';
		calls.push(q);
		if (q.includes('Slack Water')) return new Response('slow down', { status: 503 });
		const artists = q.includes('North & Vale') ? [{ id: 'mb-1', name: 'North and Vale', type: 'Group' }, { id: 'mb-2', name: 'North & Vale Trio', type: 'Group' }] : [];
		return new Response(JSON.stringify({ artists }), { headers: { 'content-type': 'application/json' } });
	};
	return { fetch, calls };
}

const spotify = (items: { id: string; name: string; followers?: { total?: number } }[], calls: string[] = []): SpotifyReader => ({
	get: async <T>(path: string) => {
		calls.push(path);
		return { artists: { items } } as T;
	},
});

describe('name lookups', () => {
	it('asks a source once per name and keeps its answer, a "none" included', async () => {
		const app = await createTestApp();
		const mb = musicbrainz();
		const deps = { fetch: mb.fetch, sleep: async () => {} };
		const first = await lookUpNames(app.db, deps, { names: ['North & Vale', 'Paper Mill, Quiet Harbour', 'north and vale'], source: 'musicbrainz' });
		// Two names: the third folds to the first.
		expect(first).toEqual({ asked: 2, known: 0, stopped: null });
		expect(mb.calls).toHaveLength(2);
		const again = await lookUpNames(app.db, deps, { names: ['North & Vale', 'Paper Mill, Quiet Harbour'], source: 'musicbrainz' });
		expect(again).toEqual({ asked: 0, known: 2, stopped: null });
		expect(mb.calls).toHaveLength(2);
		const answers = await nameAnswers(app.db, ['north and vale', 'paper mill quiet harbour', 'never asked']);
		// The exact name, whatever else the search returned.
		expect(answers.get('north and vale')).toEqual({ musicbrainz: { id: 'mb-1', name: 'North and Vale', type: 'Group' } });
		expect(answers.get('paper mill quiet harbour')).toEqual({ musicbrainz: null });
		expect(answers.has('never asked')).toBe(false);
	});

	it('waits a busy MusicBrainz out a few times, then keeps nothing of the refused call and ends the batch there', async () => {
		const app = await createTestApp();
		const mb = musicbrainz();
		const waits: number[] = [];
		const r = await lookUpNames(app.db, { fetch: mb.fetch, sleep: async (ms) => void waits.push(ms) }, { names: ['North & Vale', 'Slack Water & Kaske', 'Sun & Moon'], source: 'musicbrainz' });
		expect(r).toEqual({ asked: 1, known: 0, stopped: 'refused', error: 'musicbrainz 503 /ws/2/artist' });
		// The gap after the first answer, then the three waits on the refused name: four calls for it.
		expect(waits).toEqual([1100, 3000, 10000, 30000]);
		expect(mb.calls.filter((q) => q.includes('Slack Water'))).toHaveLength(4);
		const answers = await nameAnswers(app.db, ['north and vale', 'slack water and kaske', 'sun and moon']);
		expect([...answers.keys()]).toEqual(['north and vale']);
	});

	it('asks Spotify through the app reader: the most followed artist of the exact name, or none', async () => {
		const app = await createTestApp();
		const calls: string[] = [];
		const reader = spotify([{ id: 'sp-9', name: 'North & Vale', followers: { total: 12 } }, { id: 'sp-1', name: 'North & Vale', followers: { total: 4100 } }, { id: 'sp-2', name: 'North' }], calls);
		expect(await lookUpNames(app.db, { spotify: reader }, { names: ['North & Vale', 'Sun & Moon'], source: 'spotify' })).toEqual({ asked: 2, known: 0, stopped: null });
		expect(calls[0]).toBe('/search?type=artist&limit=10&q=North%20%26%20Vale');
		const answers = await nameAnswers(app.db, ['north and vale', 'sun and moon']);
		expect(answers.get('north and vale')).toEqual({ spotify: { id: 'sp-1', name: 'North & Vale', followers: 4100 } });
		expect(answers.get('sun and moon')).toEqual({ spotify: null });
		// No app credentials here, or Spotify's wall: said, nothing kept.
		expect(await lookUpNames(app.db, {}, { names: ['Kaske & Lowtide'], source: 'spotify' })).toMatchObject({ asked: 0, stopped: 'unavailable' });
		const walled: SpotifyReader = { get: async () => { throw new TrackerRateLimitedError(7200); } };
		expect(await lookUpNames(app.db, { spotify: walled }, { names: ['Kaske & Lowtide'], source: 'spotify' })).toEqual({ asked: 0, known: 0, stopped: 'refused', retryAfterSec: 7200 });
		expect((await nameAnswers(app.db, ['kaske and lowtide'])).size).toBe(0);
	});
});
