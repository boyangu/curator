// FeedScheduler — per-producer poll timers over registered FeedProducers.
//
// Each producer runs on its own cadence (register's pollIntervalMs): cheap
// snapshot-diff producers (playlists) poll often; expensive scan producers
// (new releases) poll rarely. All poll/backfill/refresh work is SERIALIZED
// through one promise chain — producers share Spotify's rolling rate limit and
// are single-writer on their cursors, so only one pass runs at a time.
//
// NOT started inside createCoreService — the desktop main calls
// startFeedPolling() after the renderer bootstrap lands, same constraint as
// startLibraryWatching() (sync better-sqlite3 work before first paint produces
// a blank window).

import type { FeedItemDraft, FeedProducer, FeedRefreshResult } from './types.js';
import type { FeedStore } from './store.js';
import type { FeedStage, FeedStageContext } from './pipeline.js';
import { log } from '../log.js';

const flog = log.for('feed');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// First pass shortly after start so a fresh launch populates the feed without
// waiting a full interval. Each producer gets its own first-run timer, so a
// daily producer still polls once per launch.
const FIRST_RUN_DELAY_MS = 15 * 1000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

interface ProducerEntry {
	producer: FeedProducer;
	pollIntervalMs: number;
	// When false the producer is registered (so runAll / refreshProducer /
	// backfill can drive it on explicit user action) but gets NO background
	// timer — start() skips it. Lets a quota-heavy producer stay manual-only.
	autoPoll: boolean;
}

export class FeedScheduler {
	private readonly entries: ProducerEntry[] = [];
	private intervalTimers: ReturnType<typeof setInterval>[] = [];
	private firstRunTimers: ReturnType<typeof setTimeout>[] = [];
	// Serialization chain: every poll/backfill/refresh appends here so passes
	// never overlap (shared upstream rate limit + single-writer cursors).
	private tail: Promise<unknown> = Promise.resolve();
	// Aborted by stop() so a now-longer pass (the album-expander stage does
	// network I/O per album) can bail between items on teardown instead of
	// running to completion.
	private aborter = new AbortController();

	constructor(
		private readonly store: FeedStore,
		// Fired after every completed poll/backfill pass — wires the
		// enrichment queue without coupling the scheduler to it.
		private readonly onPassComplete?: () => void,
		// Ordered enrich/filter stages run over each producer's drafts before
		// upsert (see pipeline.ts). Empty by default — tests/CLI run raw.
		private readonly stages: FeedStage[] = [],
	) {}

	// pollIntervalMs defaults to 30 min; pass a larger value for low-churn
	// producers (e.g. new releases, which drop ≤ daily and scan every followed
	// artist per pass).
	register(producer: FeedProducer, pollIntervalMs: number = DEFAULT_INTERVAL_MS, autoPoll = true): void {
		this.entries.push({ producer, pollIntervalMs, autoPoll });
	}

	start(): void {
		if (this.intervalTimers.length) return;
		if (this.aborter.signal.aborted) this.aborter = new AbortController();
		for (const { producer, pollIntervalMs, autoPoll } of this.entries) {
			if (!autoPoll) continue; // manual-only producer — no background timer
			this.firstRunTimers.push(setTimeout(() => { void this.pollNow([producer]); }, FIRST_RUN_DELAY_MS));
			this.intervalTimers.push(setInterval(() => { void this.pollNow([producer]); }, pollIntervalMs));
		}
	}

	stop(): void {
		for (const t of this.intervalTimers) clearInterval(t);
		for (const t of this.firstRunTimers) clearTimeout(t);
		this.intervalTimers = [];
		this.firstRunTimers = [];
		this.aborter.abort();
	}

	// Manual Refresh — poll every producer now, ignoring per-producer cadence.
	// Queues after any in-flight pass and runs its own fresh poll, so it never
	// returns an empty "up to date" before a pass has committed.
	async runAll(): Promise<FeedRefreshResult> {
		return this.serialize(() => this.doPoll(this.entries.map((e) => e.producer)));
	}

	// Manual Refresh of a SINGLE registered producer by id — same serialized
	// poll as runAll, scoped to one producer. Unknown id resolves to an empty
	// result (no producers polled) rather than throwing.
	async refreshProducer(producerId: string): Promise<FeedRefreshResult> {
		const entry = this.entries.find((e) => e.producer.id === producerId);
		return this.serialize(() => this.doPoll(entry ? [entry.producer] : []));
	}

	// "Load more" — extend every backfill-capable producer's horizon back by
	// `days` and pull the newly-uncovered window. Engine-level dedupe makes
	// overlap with prior fetches free.
	async backfillAll(days: number): Promise<FeedRefreshResult> {
		return this.serialize(() => this.doBackfill(days));
	}

	// Background tick: poll the given producer(s), serialized.
	private pollNow(producers: FeedProducer[]): Promise<FeedRefreshResult> {
		return this.serialize(() => this.doPoll(producers));
	}

	// Run fn after any in-flight scheduler work; the chain is never left
	// rejected so a failed pass can't wedge later ones.
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.tail.then(fn, fn);
		this.tail = run.then(() => undefined, () => undefined);
		return run;
	}

	private async doPoll(producers: FeedProducer[]): Promise<FeedRefreshResult> {
		const results: FeedRefreshResult['producers'] = [];
		for (const p of producers) {
			try {
				const cursor = await this.store.getCursor(p.id);
				const { drafts, nextCursor } = await p.poll(cursor);
				const survivors = await this.pipe(drafts, { producerId: p.id, mode: 'poll', signal: this.aborter.signal });
				const { inserted } = await this.store.upsertItems(survivors);
				await this.store.setCursor(p.id, nextCursor);
				if (inserted > 0) flog.info('poll inserted items', { producerId: p.id, inserted });
				results.push({ producerId: p.id, inserted, error: null });
			} catch (err) {
				flog.warn('poll failed', { producerId: p.id }, err);
				results.push({ producerId: p.id, inserted: 0, error: err instanceof Error ? err.message : String(err) });
			}
		}
		await this.pruneStale();
		this.onPassComplete?.();
		return { producers: results };
	}

	private async doBackfill(days: number): Promise<FeedRefreshResult> {
		const results: FeedRefreshResult['producers'] = [];
		for (const { producer: p } of this.entries) {
			if (!p.backfill) continue;
			try {
				const cursor = await this.store.getCursor(p.id);
				const { drafts, nextCursor } = await p.backfill(cursor, days);
				const survivors = await this.pipe(drafts, { producerId: p.id, mode: 'backfill', signal: this.aborter.signal });
				const { inserted } = await this.store.upsertItems(survivors);
				await this.store.setCursor(p.id, nextCursor);
				flog.info('backfill inserted items', { producerId: p.id, days, inserted });
				results.push({ producerId: p.id, inserted, error: null });
			} catch (err) {
				flog.warn('backfill failed', { producerId: p.id }, err);
				results.push({ producerId: p.id, inserted: 0, error: err instanceof Error ? err.message : String(err) });
			}
		}
		this.onPassComplete?.();
		return { producers: results };
	}

	private async pruneStale(): Promise<void> {
		try {
			const pruned = await this.store.prune(PRUNE_AFTER_MS);
			if (pruned > 0) flog.info('pruned stale items', { pruned });
		} catch (err) {
			flog.warn('prune failed', undefined, err);
		}
	}

	// Thread a producer's drafts through the ordered stages before upsert.
	// A whole-stage failure is caught and the batch continues with that
	// stage's input — a filter that can't query just doesn't filter
	// (dedupe_key UNIQUE backstops dedup), an enricher that throws leaves the
	// payload as-is. Short-circuits once a filter empties the batch so the
	// expensive network stages don't run on nothing.
	private async pipe(drafts: FeedItemDraft[], ctx: FeedStageContext): Promise<FeedItemDraft[]> {
		let cur = drafts;
		for (const stage of this.stages) {
			if (cur.length === 0) break;
			try {
				cur = await stage.run(cur, ctx);
			} catch (err) {
				flog.warn('stage failed', { stageId: stage.id, producerId: ctx.producerId }, err);
			}
		}
		return cur;
	}
}
