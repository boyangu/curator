import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { AnalysisEnricher, type AnalysisJobs } from './analysis.js';
import type { AnalysisJobEvent } from '../../analyzer/queue.js';
import type { EnrichmentTarget } from '../contract.js';

// Fake queue: records enqueue/cancel calls and lets the test drive terminal
// events. No DB, no sidecar — exercises the adapter in isolation.
class FakeJobs extends EventEmitter implements AnalysisJobs {
	enqueued: string[][] = [];
	cancelled: string[] = [];
	enqueue(trackIds: string[]): void {
		this.enqueued.push(trackIds);
	}
	cancel(trackId: string): void {
		this.cancelled.push(trackId);
	}
	fire(e: AnalysisJobEvent): void {
		this.emit('event', e);
	}
}

const target = (over: Partial<EnrichmentTarget> = {}): EnrichmentTarget => ({
	id: 't1',
	query: { title: 'x', artists: ['y'] },
	localAudio: async () => '/music/x.wav',
	...over,
});

describe('AnalysisEnricher', () => {
	it('applicableTo requires both a track id and local audio', () => {
		const e = new AnalysisEnricher(new FakeJobs());
		expect(e.applicableTo(target())).toBe(true);
		expect(e.applicableTo(target({ localAudio: undefined }))).toBe(false);
		expect(e.applicableTo(target({ id: undefined }))).toBe(false);
	});

	it('enqueues the track and resolves an analysis output on completion', async () => {
		const jobs = new FakeJobs();
		const e = new AnalysisEnricher(jobs);
		const p = e.enrich(target());
		expect(jobs.enqueued).toEqual([['t1']]);
		jobs.fire({ kind: 'completed', trackId: 't1' });
		await expect(p).resolves.toEqual({ kind: 'analysis', trackId: 't1' });
	});

	it('ignores events for other tracks', async () => {
		const jobs = new FakeJobs();
		const e = new AnalysisEnricher(jobs);
		const p = e.enrich(target());
		jobs.fire({ kind: 'completed', trackId: 'other' });
		jobs.fire({ kind: 'completed', trackId: 't1' });
		await expect(p).resolves.toEqual({ kind: 'analysis', trackId: 't1' });
	});

	it('resolves null when the job fails or is cancelled', async () => {
		const jobs = new FakeJobs();
		const e = new AnalysisEnricher(jobs);
		const fail = e.enrich(target());
		jobs.fire({ kind: 'failed', trackId: 't1', errorKind: 'boom', message: 'x' });
		await expect(fail).resolves.toBeNull();

		const cancel = e.enrich(target());
		jobs.fire({ kind: 'cancelled', trackId: 't1' });
		await expect(cancel).resolves.toBeNull();
	});

	it('cancels the in-flight job and resolves null when the signal aborts', async () => {
		const jobs = new FakeJobs();
		const e = new AnalysisEnricher(jobs);
		const ac = new AbortController();
		const p = e.enrich(target(), ac.signal);
		ac.abort();
		await expect(p).resolves.toBeNull();
		expect(jobs.cancelled).toEqual(['t1']);
	});

	it('aborts immediately when the signal is already aborted', async () => {
		const jobs = new FakeJobs();
		const e = new AnalysisEnricher(jobs);
		const p = e.enrich(target(), AbortSignal.abort());
		await expect(p).resolves.toBeNull();
		expect(jobs.cancelled).toEqual(['t1']);
	});
});
