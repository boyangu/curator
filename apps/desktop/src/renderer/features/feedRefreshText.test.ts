import { describe, it, expect } from 'vitest';
import type { CatalogWorkerStatus, FeedRefreshResult, FeedRefreshStatus, FeedRefreshStep } from '@curator/core';
import { passTitle, progressBody, resultBody, statusLines, statusTooltip, workerLine } from './feedRefreshText.js';

const step = (over: Partial<FeedRefreshStep>): FeedRefreshStep => ({
	producerId: 'p', name: 'Following', state: 'pending', detail: null, inserted: null, error: null, ...over,
});
const status = (steps: FeedRefreshStep[], over: Partial<NonNullable<FeedRefreshStatus['pass']>> = {}, waiting = 0): FeedRefreshStatus => ({
	pass: { mode: 'poll', manual: true, startedAt: 0, steps, ...over },
	waiting,
});

describe('feed refresh status text', () => {
	it('writes one line per source in its state', () => {
		const s = status([
			step({ state: 'done', inserted: 3 }),
			step({ name: 'Spotify playlists', state: 'running', detail: 'Playlist 12 of 136: Deep House' }),
			step({ name: 'Other', state: 'running' }),
			step({ name: 'Paused', state: 'skipped', detail: 'Spotify is not connected' }),
			step({ name: 'Broken', state: 'error', error: 'HTTP 500' }),
			step({ name: 'Later' }),
			step({ name: 'Quiet', state: 'done', inserted: 0 }),
		]);
		expect(statusLines(s)).toEqual([
			'✓ Following: 3 new',
			'▸ Spotify playlists: Playlist 12 of 136: Deep House',
			'▸ Other: starting…',
			'– Paused: Spotify is not connected',
			'✕ Broken: HTTP 500',
			'· Later',
			'✓ Quiet: nothing new',
		]);
	});

	it('names the pass by who started it and what it does', () => {
		expect(passTitle(status([]).pass!)).toBe('Refreshing Discover…');
		expect(passTitle(status([], { mode: 'backfill' }).pass!)).toBe('Loading older items…');
		expect(passTitle(status([], { manual: false }).pass!)).toBe('Checking for new releases…');
	});

	it('has nothing to say when idle', () => {
		const idle: FeedRefreshStatus = { pass: null, waiting: 0 };
		expect(statusLines(idle)).toEqual([]);
		expect(statusTooltip(idle)).toBeNull();
		expect(progressBody(idle)).toBeUndefined();
	});

	it('heads the tab popover with the pass and mentions what is queued', () => {
		const s = status([step({ state: 'running', detail: 'Asking the catalogue for new releases' })], { manual: false }, 1);
		expect(statusTooltip(s)).toBe('Checking for new releases…\n▸ Following: Asking the catalogue for new releases\n1 more queued behind this one');
	});

	it('tells a waiting click that a background pass runs first', () => {
		const s = status([step({ state: 'running' })], { manual: false }, 1);
		expect(progressBody(s)!.split('\n')[0]).toBe('A background check is finishing first:');
		expect(progressBody(status([step({ state: 'running' })]))).toBe('▸ Following: starting…');
	});

	it('breaks a result down only when there is something to tell apart', () => {
		const one: FeedRefreshResult = { producers: [{ producerId: 'a', name: 'Following', inserted: 3, error: null, skipped: null, note: null }] };
		expect(resultBody(one)).toBeUndefined();

		const mixed: FeedRefreshResult = {
			producers: [
				{ producerId: 'a', name: 'Following', inserted: 3, error: null, skipped: null, note: null },
				{ producerId: 'b', name: 'Spotify playlists', inserted: 0, error: null, skipped: 'Spotify is not connected', note: null },
				{ producerId: 'c', name: 'Other', inserted: 0, error: 'HTTP 500', skipped: null, note: null },
			],
		};
		expect(resultBody(mixed)).toBe('✓ Following: 3 new\n– Spotify playlists: Spotify is not connected\n✕ Other: HTTP 500');

		const skippedAlone: FeedRefreshResult = { producers: [{ producerId: 'b', name: 'Spotify playlists', inserted: 0, error: null, skipped: 'Spotify is not connected', note: null }] };
		expect(resultBody(skippedAlone)).toBe('– Spotify playlists: Spotify is not connected');

		// A check's note is worth a line of its own.
		const checked: FeedRefreshResult = { producers: [{ producerId: 'a', name: 'Following', inserted: 0, error: null, skipped: null, note: 'Checked your artists on spotify: 12 queued' }] };
		expect(resultBody(checked)).toBe('✓ Following: nothing new · Checked your artists on spotify: 12 queued');
		expect(statusLines(status([step({ state: 'done', inserted: 0, detail: 'Checked your artists on spotify: 12 queued' })]))).toEqual(['✓ Following: nothing new · Checked your artists on spotify: 12 queued']);
	});

	it('says what the catalogue worker is reading, in the popover with or without a pass', () => {
		const w: CatalogWorkerStatus = { reason: 'ok', active: true, providers: ['spotify'], trackers: ['artist/spotify'], weekEndsAt: null, lastAskedAt: null, lastReportAt: null, polled: 0, events: 0, inHand: 3, paused: [], lastError: null, check: { at: 0, queued: 1802, polled: 120 } };
		expect(workerLine(w)).toBe('▸ Reading 120 of 1,802 checked follows (3 in hand) — new releases land as they are read');
		expect(workerLine({ ...w, check: null })).toBe('▸ Reading 3 of your follows for the catalogue');
		expect(workerLine({ ...w, check: null, inHand: 0 })).toBeNull();
		expect(workerLine({ ...w, reason: 'inactive' })).toBeNull();
		expect(workerLine(null)).toBeNull();

		expect(statusTooltip({ pass: null, waiting: 0 }, w)).toBe('Reading for the catalogue…\n▸ Reading 120 of 1,802 checked follows (3 in hand) — new releases land as they are read');
		expect(statusTooltip({ pass: null, waiting: 0 }, null)).toBeNull();
		expect(statusTooltip(status([step({ state: 'running' })]), w)!.split('\n')).toEqual([
			'Refreshing Discover…',
			'▸ Following: starting…',
			'▸ Reading 120 of 1,802 checked follows (3 in hand) — new releases land as they are read',
		]);
	});
});
