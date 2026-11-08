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

import type { FeedItemDraft, FeedProducer, FeedProducerContext, FeedProducerResult, FeedRefreshResult, FeedRefreshScope, FeedRefreshStatus, FeedRefreshStep } from './types.js';
import type { FeedStore } from './store.js';
import type { FeedStage, FeedStageContext } from './pipeline.js';
import { log } from '../log.js';

const flog = log.for('feed');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
// A step's detail moves per item of a long walk (one line per followed artist
// or playlist). State changes go out at once; details at most this often, so
// the walk stays a trickle on the desktop's IPC.
const STATUS_COALESCE_MS = 250;
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
	// The pass in flight and how many wait behind it (FeedRefreshStatus), pushed
	// to subscribers so a Refresh is never a silent wait.
	private pass: NonNullable<FeedRefreshStatus['pass']> | null = null;
	private waiting = 0;
	private readonly statusListeners = new Set<(s: FeedRefreshStatus) => void>();
	private statusTimer: ReturnType<typeof setTimeout> | null = null;

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
		if (this.statusTimer) clearTimeout(this.statusTimer);
		this.statusTimer = null;
		this.aborter.abort();
	}

	// Manual Refresh — poll every producer now, ignoring per-producer cadence.
	// Queues after any in-flight pass and runs its own fresh poll, so it never
	// returns an empty "up to date" before a pass has committed. A scope with
	// a kind runs only the producers serving it (FeedProducer.kinds); the
	// scope itself reaches the producers (FeedProducerContext.scope).
	async runAll(scope?: FeedRefreshScope): Promise<FeedRefreshResult> {
		const producers = this.entries.map((e) => e.producer).filter((p) => !scope?.kind || !p.kinds || p.kinds.includes(scope.kind));
		return this.serialize(() => this.doPoll(producers, true, scope));
	}

	// One registered producer by id — the same serialized poll, scoped to it:
	// a follower's Refresh (the cloud's stream is all it reads), and the
	// background poll the catalogue worker's new events ask for. Unknown id
	// resolves to an empty result (no producers polled) rather than throwing.
	async refreshProducer(producerId: string, opts: { manual?: boolean } = {}): Promise<FeedRefreshResult> {
		const entry = this.entries.find((e) => e.producer.id === producerId);
		return this.serialize(() => this.doPoll(entry ? [entry.producer] : [], opts.manual ?? true));
	}

	// "Load more" — extend every backfill-capable producer's horizon back by
	// `days` and pull the newly-uncovered window. Engine-level dedupe makes
	// overlap with prior fetches free.
	async backfillAll(days: number): Promise<FeedRefreshResult> {
		return this.serialize(() => this.doBackfill(days));
	}

	// What the scheduler is doing right now. A copy: the caller may keep it.
	status(): FeedRefreshStatus {
		return {
			pass: this.pass ? { ...this.pass, steps: this.pass.steps.map((s) => ({ ...s })) } : null,
			waiting: this.waiting,
		};
	}

	// Every change of status(), detail lines coalesced (STATUS_COALESCE_MS).
	subscribeStatus(cb: (s: FeedRefreshStatus) => void): () => void {
		this.statusListeners.add(cb);
		return () => { this.statusListeners.delete(cb); };
	}

	// Background tick: poll the given producer(s), serialized.
	private pollNow(producers: FeedProducer[]): Promise<FeedRefreshResult> {
		return this.serialize(() => this.doPoll(producers, false));
	}

	// Run fn after any in-flight scheduler work; the chain is never left
	// rejected so a failed pass can't wedge later ones.
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		this.waiting++;
		// Only worth saying when something is running ahead of it.
		if (this.pass) this.emitStatus();
		const begin = (): Promise<T> => {
			this.waiting--;
			return fn();
		};
		const run = this.tail.then(begin, begin);
		this.tail = run.then(() => undefined, () => undefined);
		return run;
	}

	private emitStatus(): void {
		if (this.statusTimer) clearTimeout(this.statusTimer);
		this.statusTimer = null;
		if (this.statusListeners.size === 0) return;
		const s = this.status();
		for (const l of this.statusListeners) {
			// A listener's throw must not derail the pass it is reporting on.
			try {
				l(s);
			} catch (err) {
				flog.warn('status listener failed', undefined, err);
			}
		}
	}

	private emitStatusSoon(): void {
		if (this.statusTimer || this.statusListeners.size === 0) return;
		this.statusTimer = setTimeout(() => this.emitStatus(), STATUS_COALESCE_MS);
		this.statusTimer.unref();
	}

	private doPoll(producers: FeedProducer[], manual: boolean, scope?: FeedRefreshScope): Promise<FeedRefreshResult> {
		return this.runPass('poll', manual, producers, (p, cursor, ctx) => p.poll(cursor, ctx), {}, scope);
	}

	private doBackfill(days: number): Promise<FeedRefreshResult> {
		const producers = this.entries.map((e) => e.producer).filter((p) => p.backfill);
		return this.runPass('backfill', true, producers, (p, cursor, ctx) => p.backfill!(cursor, days, ctx), { days });
	}

	// One pass: each producer in turn through fetch → stages → store, its step
	// in the status moving pending → running → done / error as it goes.
	private async runPass(
		mode: 'poll' | 'backfill',
		manual: boolean,
		producers: FeedProducer[],
		fetch: (p: FeedProducer, cursor: unknown, ctx: FeedProducerContext) => Promise<FeedProducerResult>,
		logData: Record<string, unknown> = {},
		scope?: FeedRefreshScope,
	): Promise<FeedRefreshResult> {
		const startedAt = Date.now();
		// A producer that has stood down neither runs nor shows.
		const live = producers.filter((p) => p.active?.() ?? true);
		const steps: FeedRefreshStep[] = live.map((p) => ({ producerId: p.id, name: p.displayName, state: 'pending', detail: null, inserted: null, error: null }));
		this.pass = { mode, manual, startedAt, steps };
		this.emitStatus();
		const results: FeedRefreshResult['producers'] = [];
		for (const [i, p] of live.entries()) {
			const step = steps[i]!;
			const report = (detail: string): void => {
				step.detail = detail;
				this.emitStatusSoon();
			};
			step.state = 'running';
			this.emitStatus();
			try {
				const cursor = await this.store.getCursor(p.id);
				const { drafts, nextCursor, skipped, note } = await fetch(p, cursor, { report, manual, ...(scope ? { scope } : {}) });
				if (drafts.length > 0) report(`Checking ${drafts.length} found`);
				const survivors = await this.pipe(drafts, { producerId: p.id, mode, signal: this.aborter.signal, report });
				const { inserted } = await this.store.upsertItems(survivors);
				await this.store.setCursor(p.id, nextCursor);
				if (mode === 'backfill' || inserted > 0) flog.info(`${mode} inserted items`, { producerId: p.id, ...logData, inserted });
				step.state = skipped ? 'skipped' : 'done';
				// A finished step keeps what it did beyond reading (its note), not
				// its last progress line.
				step.detail = skipped ?? note ?? null;
				step.inserted = inserted;
				results.push({ producerId: p.id, name: p.displayName, inserted, error: null, skipped: skipped ?? null, note: note ?? null });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				flog.warn(`${mode} failed`, { producerId: p.id }, err);
				step.state = 'error';
				step.detail = null;
				step.error = message;
				results.push({ producerId: p.id, name: p.displayName, inserted: 0, error: message, skipped: null, note: null });
			}
			this.emitStatus();
		}
		if (mode === 'poll') await this.pruneStale();
		this.onPassComplete?.();
		this.pass = null;
		this.emitStatus();
		// One line per pass: a pass that brought nothing is otherwise invisible
		// in the log, and "did my Refresh run?" has no answer.
		flog.info('pass finished', {
			mode,
			manual,
			...logData,
			ms: Date.now() - startedAt,
			inserted: results.reduce((n, r) => n + r.inserted, 0),
			failed: results.filter((r) => r.error).map((r) => r.producerId),
			skipped: results.filter((r) => r.skipped).map((r) => r.producerId),
		});
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
