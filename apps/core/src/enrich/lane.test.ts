import { describe, expect, it } from 'vitest';
import type { Enricher } from '@curator/sync-core/enrich/contract';
import { inLane } from './lane.js';

const target = (title: string) => ({ query: { title, artists: ['A'] } });

describe('inLane', () => {
	it('starts lookups one after another, never closer than the gap, whoever asks', async () => {
		const starts: { title: string; at: number }[] = [];
		let running = 0;
		let overlapped = false;
		const inner: Enricher = {
			id: 'store',
			produces: 'metadata',
			applicableTo: () => true,
			enrich: async (t) => {
				if (running++) overlapped = true;
				starts.push({ title: t.query.title, at: Date.now() });
				await new Promise((r) => setTimeout(r, 5));
				running--;
				return { kind: 'metadata', patch: { bpm: 120 } };
			},
		};
		const lane = inLane(inner, 40);
		// Two callers at once, as the feed's drain and a page's rows would be.
		const out = await Promise.all([lane.enrich(target('one')), lane.enrich(target('two')), lane.enrich(target('three'))]);
		expect(out.every((o) => o?.kind === 'metadata')).toBe(true);
		expect(overlapped).toBe(false);
		expect(starts.map((s) => s.title)).toEqual(['one', 'two', 'three']);
		expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(38);
		expect(starts[2]!.at - starts[1]!.at).toBeGreaterThanOrEqual(38);
	});

	it('a failed lookup does not stall the ones behind it, and a blocked store is not asked', async () => {
		let blocked = false;
		let calls = 0;
		const inner: Enricher = {
			id: 'store',
			produces: 'metadata',
			applicableTo: () => !blocked,
			enrich: async () => {
				if (++calls === 1) { blocked = true; throw new Error('blocked'); }
				return null;
			},
		};
		const lane = inLane(inner, 0);
		const first = lane.enrich(target('one'));
		const second = lane.enrich(target('two'));
		await expect(first).rejects.toThrow('blocked');
		// The store blocked us while the second waited its turn: no call for it.
		expect(await second).toBeNull();
		expect(calls).toBe(1);
	});
});
