// Downloads entity store — the data layer's first vertical slice
// (planning/tech/frontend-architecture.md F2). Owns the download queue
// mirror; consumers read reactively (Solid store), events patch rows.
//
// Pattern for every entity domain that follows:
//   • createStore-backed table keyed by id + plain-function selectors
//     (functions reading a Solid store ARE reactive accessors — no
//     manual rev-bump signals, no listener registries).
//   • refresh() = snapshot fetch reconciled into the store.
//   • ingest*() = push-event patches (wired by data/events.ts).
//   • Writes go through named mutators that call the api facade.

import { createStore, reconcile } from 'solid-js/store';
import type { DownloadJob, QueueSummary, QueueEvent } from '@curator/core';
import { downloadsApi } from './api.js';

const EMPTY_SUMMARY: QueueSummary = { total: 0, pending: 0, downloading: 0, done: 0, skipped: 0, error: 0, overallPct: 0 };

const [store, setStore] = createStore<{
	jobs: Record<string, DownloadJob>;
	summary: QueueSummary;
}>({ jobs: {}, summary: EMPTY_SUMMARY });

export const downloads = {
	// ── Selectors (reactive when read inside computations/JSX) ─────────
	job(trackId: string): DownloadJob | undefined {
		return store.jobs[trackId];
	},
	// Pre-sorted projection for DownloadsView's <For>. Sorting on read is
	// fine at queue scale (hundreds); rows keep stable order by enqueue time.
	jobsSorted(): DownloadJob[] {
		return Object.values(store.jobs).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
	},
	summary(): QueueSummary {
		return store.summary;
	},

	// ── Snapshot + event ingestion ─────────────────────────────────────
	async refresh(): Promise<void> {
		const [jobs, summary] = await Promise.all([downloadsApi.queue(), downloadsApi.summary()]);
		setStore('jobs', reconcile(Object.fromEntries(jobs.map((j) => [j.trackId, j]))));
		setStore('summary', summary);
	},
	// Seed-on-wire: events only deliver transitions, so a queue that
	// predates this window (restart with pending jobs) must be filled in
	// without trampling rows that already streamed in.
	async seedMissing(): Promise<void> {
		const [jobs, summary] = await Promise.all([downloadsApi.queue(), downloadsApi.summary()]);
		for (const j of jobs) {
			if (!store.jobs[j.trackId]) setStore('jobs', j.trackId, j);
		}
		setStore('summary', summary);
	},
	ingestEvent(evt: QueueEvent): void {
		if (evt.type === 'job') setStore('jobs', evt.job.trackId, evt.job);
		else if (evt.type === 'summary') setStore('summary', evt.summary);
	},

	// ── Mutators ───────────────────────────────────────────────────────
	retry: (trackId: string) => downloadsApi.retry(trackId),
	redownload: (trackId: string) => downloadsApi.redownload(trackId),
	async clearCompleted(): Promise<void> {
		await downloadsApi.clearCompleted();
		await downloads.refresh();
	},
	async clearAll(): Promise<void> {
		await downloadsApi.clearAll();
		await downloads.refresh();
	},
};
