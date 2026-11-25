// One producer's pass: its cursor → what it found → the stages → the store →
// its next cursor. The desktop's scheduler (apps/core feed/scheduler.ts) and
// the phone's collector (feed/device-feed.ts) both run producers through
// here, so a draft meets the same stages in the same order on every device.

import { log } from '../log.js';
import type { FeedStage, FeedStageContext } from './filters.js';
import type { FeedStore } from './store.js';
import type { FeedItemDraft, FeedProducer, FeedProducerContext, FeedProducerResult } from './types.js';

const flog = log.for('feed');

export interface ProducerPassOptions {
	mode: 'poll' | 'backfill';
	// poll() or backfill(days) on the producer, with its stored cursor.
	fetch: (p: FeedProducer, cursor: unknown, ctx: FeedProducerContext) => Promise<FeedProducerResult>;
	ctx: FeedProducerContext;
	signal?: AbortSignal;
}

export interface ProducerPassResult {
	inserted: number;
	skipped: string | null;
	note: string | null;
}

// Throws what the producer or the store throws; a stage's own failure is
// swallowed (pipeStages).
export async function runProducerPass(
	store: Pick<FeedStore, 'getCursor' | 'setCursor' | 'upsertItems'>,
	producer: FeedProducer,
	stages: readonly FeedStage[],
	opts: ProducerPassOptions,
): Promise<ProducerPassResult> {
	const { ctx, mode, signal } = opts;
	const cursor = await store.getCursor(producer.id);
	const { drafts, nextCursor, skipped, note } = await opts.fetch(producer, cursor, ctx);
	if (drafts.length > 0) ctx.report(`Checking ${drafts.length} found`);
	const survivors = await pipeStages(stages, drafts, { producerId: producer.id, mode, signal, report: (d) => ctx.report(d) });
	const { inserted } = await store.upsertItems(survivors);
	await store.setCursor(producer.id, nextCursor);
	return { inserted, skipped: skipped ?? null, note: note ?? null };
}

// Thread a producer's drafts through the ordered stages before upsert.
// A whole-stage failure is caught and the batch continues with that
// stage's input — a filter that can't query just doesn't filter
// (dedupe_key UNIQUE backstops dedup), an enricher that throws leaves the
// payload as-is. Short-circuits once a filter empties the batch so the
// expensive network stages don't run on nothing.
async function pipeStages(stages: readonly FeedStage[], drafts: FeedItemDraft[], ctx: FeedStageContext): Promise<FeedItemDraft[]> {
	let cur = drafts;
	for (const stage of stages) {
		if (cur.length === 0) break;
		try {
			cur = await stage.run(cur, ctx);
		} catch (err) {
			flog.warn('stage failed', { stageId: stage.id, producerId: ctx.producerId }, err);
		}
	}
	return cur;
}
