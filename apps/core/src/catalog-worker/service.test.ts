import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogWorkerDueInput, CatalogWorkerDueResult, CatalogWorkerReportInput, CatalogWorkerReportResult, CatalogWorkerTask } from '@curator/protocol';
import { TrackerRateLimitedError, type TrackerAdapter, type TrackerPoll } from '@curator/catalog-readers';
import { createCatalogWorker, type CatalogWorkerPort, type CatalogWorkerStatus } from './service.js';

afterEach(() => {
	vi.useRealTimers();
});

const task = (objectId: string, provider: 'spotify' | 'deezer' = 'spotify'): CatalogWorkerTask => ({
	objectId,
	provider,
	kind: 'artist',
	target: { object: { id: objectId, kind: 'artist', name: objectId }, representation: { providerId: `p-${objectId}`, url: null }, cursor: {} },
	minGapMs: 0,
	timeoutMs: 5000,
});

// A master that hands out what the test queues and records what comes back.
function fakeMaster(opts: { active?: boolean; fail?: () => Error | null } = {}) {
	const dues: CatalogWorkerDueInput[] = [];
	const reports: CatalogWorkerReportInput[] = [];
	let queue: CatalogWorkerTask[] = [];
	const self = {
		// What the next ask carrying a check is answered with.
		check: null as CatalogWorkerDueResult['check'] | null,
		port: null as unknown as CatalogWorkerPort,
		dues,
		reports,
		hand: (...t: CatalogWorkerTask[]) => { queue = t; },
	};
	self.port = {
		async workerDue(input): Promise<CatalogWorkerDueResult> {
			const err = opts.fail?.();
			if (err) throw err;
			dues.push(input);
			const tasks = queue;
			queue = [];
			const check = input.check && self.check ? { check: self.check } : {};
			return { active: opts.active ?? true, weekEndsAt: Date.now() + 86400_000, tasks: opts.active === false ? [] : tasks, pauses: [], ...check };
		},
		async workerReport(input): Promise<CatalogWorkerReportResult> {
			reports.push(input);
			return { applied: input.results.length, stale: 0, events: input.results.filter((r) => 'poll' in r.outcome).length };
		},
	};
	return self;
}

function reader(provider: 'spotify' | 'deezer', answer: (name: string) => TrackerPoll | Error): TrackerAdapter & { polled: string[] } {
	const polled: string[] = [];
	return {
		provider,
		kinds: ['artist'],
		callsPerPoll: 1,
		polled,
		async poll(target) {
			polled.push(target.object.name);
			const a = answer(target.object.name);
			if (a instanceof Error) throw a;
			return a;
		},
	};
}

const okPoll = (): TrackerPoll => ({ children: [], listingHash: 'h', cursor: {}, calls: 1 });

function worker(master: ReturnType<typeof fakeMaster>, adapters: TrackerAdapter[], over: Partial<Parameters<typeof createCatalogWorker>[0]> = {}) {
	return createCatalogWorker({
		procs: () => master.port,
		deviceId: () => 'desk-1',
		offered: () => 'ok',
		spotifyToken: async () => 'tok',
		trackers: () => ['artist/spotify', 'artist/deezer', 'label/beatport'],
		adapters,
		tickMs: 1000,
		firstTickMs: 10,
		...over,
	});
}

describe('catalog worker', () => {
	it('asks, polls what it is handed with its readers, and reports', async () => {
		vi.useFakeTimers();
		const master = fakeMaster();
		const sp = reader('spotify', okPoll);
		master.hand(task('Northfold'), task('Amber Tide'));
		const w = worker(master, [sp]);
		const seen: string[] = [];
		w.subscribe((s) => seen.push(`${s.reason}/${s.active}/${s.inHand}/${s.polled}`));
		w.start();
		await vi.advanceTimersByTimeAsync(20);

		// Handed tasks, it asks again at once (the master hands a tick's worth
		// at a time); that ask brings nothing and the cadence resumes.
		expect(master.dues).toHaveLength(2);
		expect(master.dues[0]).toMatchObject({ deviceId: 'desk-1', providers: ['spotify'], trackers: ['artist/spotify', 'artist/deezer', 'label/beatport'], paused: [] });
		expect(sp.polled).toEqual(['Northfold', 'Amber Tide']);
		expect(master.reports).toHaveLength(1);
		expect(master.reports[0]!.results.map((r) => [r.objectId, 'poll' in r.outcome])).toEqual([['Northfold', true], ['Amber Tide', true]]);
		expect(w.status()).toMatchObject({ reason: 'ok', active: true, inHand: 0, polled: 2, events: 2, lastError: null, trackers: ['artist/spotify', 'artist/deezer', 'label/beatport'] });
		expect(seen.at(-1)).toBe('ok/true/0/2');

		// The next minute: one ask, nothing handed, nothing reported.
		await vi.advanceTimersByTimeAsync(1000);
		expect(master.dues).toHaveLength(3);
		expect(master.reports).toHaveLength(1);
		w.stop();
	});

	// A Refresh's "check now": asked at once with the check, answered with the
	// master's report, the reads it handed out drained in the background with
	// the check's progress in the status.
	it('asks now with a check, returns the report, and counts the reads against it', async () => {
		vi.useFakeTimers();
		const master = fakeMaster();
		const sp = reader('spotify', okPoll);
		const w = worker(master, [sp]);
		w.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(master.dues).toHaveLength(1);

		master.hand(task('Northfold'), task('Amber Tide'));
		master.check = { queued: 2, byProvider: [{ provider: 'spotify', queued: 2, alreadyDue: 0, recent: 0, reading: 0, paused: 0 }], pauses: [] };
		const checks: CatalogWorkerStatus['check'][] = [];
		w.subscribe((s) => checks.push(s.check));
		const report = w.tickNow({ kind: 'artist' });
		await vi.advanceTimersByTimeAsync(0);
		expect(master.dues[1]).toMatchObject({ check: { kind: 'artist' } });
		expect(await report).toMatchObject({ queued: 2 });
		expect(sp.polled).toEqual(['Northfold', 'Amber Tide']);
		// The status counted the reads against the check while it drained,
		// and the ask after the drain (at once) brought nothing: the check is over.
		expect(checks).toContainEqual({ at: expect.any(Number), queued: 2, polled: 2 });
		expect(master.dues).toHaveLength(3);
		expect(w.status().check).toBeNull();
		w.stop();
		expect(await w.tickNow({})).toBeNull();
	});

	it('offers Spotify only while a token vends, and reads nothing it has no reader for', async () => {
		vi.useFakeTimers();
		const master = fakeMaster();
		const dz = reader('deezer', okPoll);
		master.hand(task('A', 'deezer'), task('B', 'spotify'));
		const w = worker(master, [dz], { spotifyToken: async () => null });
		w.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(master.dues[0]!.providers).toEqual(['deezer']);
		expect(dz.polled).toEqual(['A']);
		const b = master.reports[0]!.results.find((r) => r.objectId === 'B')!;
		expect(b.outcome).toEqual({ error: { message: 'no reader for artist on spotify', rateLimitedSec: null } });
		w.stop();
	});

	it('reports a rate limit as such, parks the provider here, and says so on the next ask', async () => {
		vi.useFakeTimers();
		const master = fakeMaster();
		const sp = reader('spotify', (name) => (name === 'Northfold' ? new TrackerRateLimitedError(120) : okPoll()));
		master.hand(task('Northfold'), task('Amber Tide'));
		const w = worker(master, [sp]);
		w.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(master.reports[0]!.results[0]!.outcome).toEqual({ error: { message: 'rate limited (120s)', rateLimitedSec: 120 } });
		expect(w.status().paused).toMatchObject([{ provider: 'spotify' }]);

		await vi.advanceTimersByTimeAsync(1000);
		expect(master.dues[1]!.paused).toMatchObject([{ provider: 'spotify' }]);
		// The wait passes.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(master.dues.at(-1)!.paused).toEqual([]);
		w.stop();
	});

	it('backs off five minutes when the master cannot be reached, and idles when it is not the week’s worker', async () => {
		vi.useFakeTimers();
		let down = true;
		const master = fakeMaster({ fail: () => (down ? new Error('network') : null) });
		const w = worker(master, [reader('spotify', okPoll)]);
		w.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(w.status()).toMatchObject({ lastError: 'network' });
		expect(master.dues).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(master.dues).toHaveLength(0);
		down = false;
		// The five minutes end: one ask, then the usual cadence.
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(master.dues).toHaveLength(1);
		expect(w.status()).toMatchObject({ reason: 'ok', lastError: null });
		w.stop();

		const second = fakeMaster({ active: false });
		second.hand(task('Northfold'));
		const sp = reader('spotify', okPoll);
		const w2 = worker(second, [sp]);
		w2.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(w2.status()).toMatchObject({ reason: 'inactive', active: false });
		expect(sp.polled).toEqual([]);
		w2.stop();
	});

	it('does nothing while signed out or on a server without the feature, and stops cleanly', async () => {
		vi.useFakeTimers();
		const master = fakeMaster();
		master.hand(task('Northfold'));
		let offered: 'ok' | 'signed_out' | 'server_off' = 'signed_out';
		const sp = reader('spotify', okPoll);
		const w = worker(master, [sp], { offered: () => offered });
		w.start();
		await vi.advanceTimersByTimeAsync(20);
		expect(w.status().reason).toBe('signed_out');
		expect(master.dues).toHaveLength(0);
		offered = 'ok';
		await vi.advanceTimersByTimeAsync(1000);
		expect(sp.polled).toEqual(['Northfold']);
		w.stop();
		expect(w.status().reason).toBe('stopped');
		await vi.advanceTimersByTimeAsync(5000);
		// The ask that was handed a task, and the one at once after it; none since the stop.
		expect(master.dues).toHaveLength(2);
	});
});
