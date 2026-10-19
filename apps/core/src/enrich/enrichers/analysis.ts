// Analysis enricher — the Plane-B member of the enricher family. Unlike the
// metadata enrichers (Beatport et al.), it needs the actual audio bytes on the
// user's disk, so it can NEVER run server-side or on a remote feed item — that
// constraint is encoded in applicableTo (requires a localAudio resolver). See
// planning/tech/cloud-architecture.md.
//
// It is a thin adapter over the existing AnalysisQueue, NOT a reimplementation:
// the queue keeps its persisted job state, priority gate, stale-version
// backfill, and sidecar worker pool — folding that into the metadata runner
// would throw real machinery away. This adapter only presents "analyze this
// track and tell me when it's done" through the shared Enricher contract, so
// "analysis is one of many enrichers" is true in code. The queue persists the
// track_analysis rows + peaks itself; the enricher just reports completion.

import type { AnalyzeOptions } from '../../analyzer/sidecar.js';
import type { AnalysisJobEvent } from '../../analyzer/queue.js';
import type { Enricher, EnricherOutput, EnrichmentTarget } from '../contract.js';

// The slice of AnalysisQueue this enricher depends on. Declared as a port (not
// the concrete class) so the enricher is decoupled from the queue's internals
// and unit-testable with a fake. AnalysisQueue satisfies it structurally.
export interface AnalysisJobs {
	enqueue(trackIds: string[], opts?: { priority?: number; force?: boolean; analyzeOptions?: AnalyzeOptions }): void;
	cancel(trackId: string): void;
	on(event: 'event', listener: (e: AnalysisJobEvent) => void): unknown;
	off(event: 'event', listener: (e: AnalysisJobEvent) => void): unknown;
}

// Priority for explicit, user-initiated enrichment — matches the Analyze
// modal's 100, well above scanner-ingest (0) so it preempts the backlog.
const EXPLICIT_PRIORITY = 100;

export class AnalysisEnricher implements Enricher {
	readonly id = 'analysis';
	readonly produces = 'analysis' as const;

	constructor(
		private readonly jobs: AnalysisJobs,
		private readonly analyzeOptions?: AnalyzeOptions,
	) {}

	// Needs both a track id (to enqueue) and local audio (the Plane-B gate —
	// false for feed/remote targets, which carry no localAudio resolver).
	applicableTo(target: EnrichmentTarget): boolean {
		return !!target.id && !!target.localAudio;
	}

	// Enqueue an analysis job and resolve when it reaches a terminal state.
	// `force` is on: explicit enrichment re-analyzes even an already-`done`
	// track, which also guarantees a terminal event lands (a no-op enqueue of a
	// done track would never emit `completed` and the await would hang).
	enrich(target: EnrichmentTarget, signal?: AbortSignal): Promise<EnricherOutput | null> {
		const trackId = target.id;
		if (!trackId) return Promise.resolve(null);

		return new Promise<EnricherOutput | null>((resolve) => {
			let settled = false;
			const finish = (val: EnricherOutput | null) => {
				if (settled) return;
				settled = true;
				this.jobs.off('event', onEvent);
				signal?.removeEventListener('abort', onAbort);
				resolve(val);
			};
			const onEvent = (e: AnalysisJobEvent) => {
				if (e.trackId !== trackId) return;
				if (e.kind === 'completed') finish({ kind: 'analysis', trackId });
				else if (e.kind === 'failed' || e.kind === 'cancelled') finish(null);
			};
			const onAbort = () => {
				this.jobs.cancel(trackId);
				finish(null);
			};

			this.jobs.on('event', onEvent);
			if (signal) {
				if (signal.aborted) { onAbort(); return; }
				signal.addEventListener('abort', onAbort);
			}
			// Subscribe before enqueue so a fast completion can't slip through.
			this.jobs.enqueue([trackId], { priority: EXPLICIT_PRIORITY, force: true, analyzeOptions: this.analyzeOptions });
		});
	}
}
