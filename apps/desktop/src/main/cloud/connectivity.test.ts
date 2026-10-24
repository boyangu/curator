// The account's network and Realtime transitions (connectivity.ts): one
// change per transition, never per 10 s probe; the outage's length on
// reconnect; channel statuses mapped to joined / not.

import { describe, it, expect } from 'vitest';
import { initialConnectivity, realtimeLiveFor, stepConnectivity, type Connectivity, type ConnectivityChange } from './connectivity.js';

function run(start: Connectivity, probes: ReadonlyArray<[online: boolean, at: number]>): ConnectivityChange[] {
	let c = start;
	const out: ConnectivityChange[] = [];
	for (const [online, at] of probes) {
		const r = stepConnectivity(c, online, at);
		c = r.next;
		if (r.change) out.push(r.change);
	}
	return out;
}

describe('stepConnectivity', () => {
	it('one offline and one online change per outage, with how long it lasted', () => {
		expect(run(initialConnectivity(true, 0), [[true, 10_000], [false, 20_000], [false, 30_000], [false, 40_000], [true, 95_000], [true, 105_000]]))
			.toEqual([{ kind: 'offline' }, { kind: 'online', offlineForSec: 75 }]);
	});

	it('counts from the launch when the device started offline', () => {
		const start = initialConnectivity(false, 1_000);
		expect(start).toEqual({ online: false, offlineSince: 1_000 });
		expect(run(start, [[false, 11_000], [true, 31_000]])).toEqual([{ kind: 'online', offlineForSec: 30 }]);
	});

	it('two outages are two reconnects', () => {
		expect(run(initialConnectivity(true, 0), [[false, 10_000], [true, 20_000], [false, 30_000], [true, 70_000]]))
			.toEqual([{ kind: 'offline' }, { kind: 'online', offlineForSec: 10 }, { kind: 'offline' }, { kind: 'online', offlineForSec: 40 }]);
	});

	it('an unchanged probe returns the same state', () => {
		const c = initialConnectivity(true, 0);
		expect(stepConnectivity(c, true, 5_000)).toEqual({ next: c, change: null });
	});
});

describe('realtimeLiveFor', () => {
	it('joined only on SUBSCRIBED', () => {
		expect(realtimeLiveFor('SUBSCRIBED')).toBe(true);
		for (const s of ['CLOSED', 'CHANNEL_ERROR', 'TIMED_OUT']) expect(realtimeLiveFor(s)).toBe(false);
		expect(realtimeLiveFor('joining')).toBeNull();
	});
});
