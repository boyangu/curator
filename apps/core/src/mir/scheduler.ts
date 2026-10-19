// Background embedding scheduler for the playable library.
//
// No job table: pending work is derived — playable tracks x enabled models,
// minus tracks the store reports settled (done, or failed MAX_ATTEMPTS times).
// That survives restarts for free and makes a model-version bump re-embed by
// itself (new modelId => nothing settled). `analyzeNow` is the user lane: it
// clears prior failures and jumps the queue.
//
// One track at a time: the engine is a single GPU/CPU-bound worker, and the
// lane backs off while the Essentia analyzer is busy so the two never fight
// for the machine. Cloud executor = batches of CLOUD_BATCH tracks per call.

import { existsSync } from 'node:fs';
import { log } from '../log.js';
import type { MirLibraryPort } from './library-port.js';
import { decodeVec, type MirAnalyzeResult, type MirSidecar, type MirSidecarError } from './sidecar.js';
import type { SqliteMirStore } from './store.js';
import type { MirEvent, MirSettings } from './types.js';

const mlog = log.for('mir');
export const MAX_ATTEMPTS = 2;
const CLOUD_BATCH = 16;
const BUSY_BACKOFF_MS = 5000;

export interface MirSchedulerDeps {
	store: SqliteMirStore;
	sidecar: MirSidecar;
	library: MirLibraryPort;
	settings: () => MirSettings;
	// key -> modelId for models the engine reported (null until capabilities land).
	modelId: (key: string) => string | null;
	onChange: () => void;
	onEvent: (e: MirEvent) => void;
	// True while another heavy job (the Essentia analysis queue) is running.
	busyElsewhere?: () => boolean;
}

interface Next { trackId: string; models: string[] }

export class MirScheduler {
	running: string | null = null;
	sessionDone = 0;
	lastError: string | null = null;
	// Set by an engine-level failure (weights missing, env broken): the lane
	// stops until settings change or the user asks again — retrying every
	// track against a broken model would just stamp failures on the library.
	blocked: string | null = null;
	private priority: string[] = [];
	private backlog: string[] | null = null;
	private active = false;
	private stopped = false;

	constructor(private readonly d: MirSchedulerDeps) {}

	// Forget the derived backlog (settings/library changed); next pass recomputes.
	invalidate(): void { this.backlog = null; }

	unblock(): void { this.blocked = null; }

	analyzeNow(trackIds: string[]): number {
		const ids = trackIds.filter((id) => this.d.library.isLive(id));
		for (const key of this.d.settings().models) {
			const mid = this.d.modelId(key);
			if (mid) this.d.store.clearFailures(ids, mid);
		}
		const seen = new Set(this.priority);
		this.priority = [...ids.filter((id) => !seen.has(id)), ...this.priority];
		this.blocked = null;
		this.kick();
		return ids.length;
	}

	pendingCount(): number {
		return this.computeBacklog().length + this.priority.length;
	}

	private enabledModels(): { key: string; id: string }[] {
		return this.d.settings().models
			.map((key) => ({ key, id: this.d.modelId(key) }))
			.filter((m): m is { key: string; id: string } => m.id !== null);
	}

	private computeBacklog(): string[] {
		if (this.backlog) return this.backlog;
		if (!this.d.settings().enabled) return (this.backlog = []);
		const models = this.enabledModels();
		if (models.length === 0) return [];
		const settled = models.map((m) => this.d.store.settledTrackIds(m.id, MAX_ATTEMPTS));
		this.backlog = this.d.library.playableTrackIds().filter((id) => settled.some((s) => !s.has(id)));
		return this.backlog;
	}

	private missingModels(trackId: string, honourFailures: boolean): string[] {
		const out: string[] = [];
		for (const m of this.enabledModels()) {
			if (!this.d.store.isSettled(trackId, m.id, honourFailures ? MAX_ATTEMPTS : Number.MAX_SAFE_INTEGER)) out.push(m.key);
		}
		return out;
	}

	private next(): Next | null {
		// Models resolve only once the engine has reported its registry (or
		// vectors from an earlier run exist). Until then nothing can be
		// judged missing — keep the queue intact rather than draining it as
		// "nothing to do"; the layer kicks again when capabilities land.
		if (this.enabledModels().length === 0) return null;
		while (this.priority.length > 0) {
			const trackId = this.priority.shift()!;
			const models = this.missingModels(trackId, false);
			if (models.length > 0) return { trackId, models };
		}
		const backlog = this.computeBacklog();
		while (backlog.length > 0) {
			const trackId = backlog.shift()!;
			const models = this.missingModels(trackId, true);
			if (models.length > 0) return { trackId, models };
		}
		return null;
	}

	kick(): void {
		if (this.active || this.stopped || this.blocked) return;
		this.active = true;
		void this.loop().finally(() => {
			this.active = false;
			this.d.onChange();
		});
	}

	stop(): void { this.stopped = true; }

	private async loop(): Promise<void> {
		while (!this.stopped && !this.blocked && this.d.sidecar.ready) {
			if (this.d.busyElsewhere?.() && this.priority.length === 0) {
				await new Promise((r) => setTimeout(r, BUSY_BACKOFF_MS));
				continue;
			}
			if (this.d.settings().executor === 'cloud' && this.priority.length === 0) {
				if (!(await this.cloudBatch())) return;
				continue;
			}
			const job = this.next();
			if (!job) return;
			if (!(await this.runLocal(job))) return;
		}
	}

	// false = stop the loop (engine gone or lane blocked).
	private async runLocal(job: Next): Promise<boolean> {
		const path = this.d.library.trackFile(job.trackId);
		if (!path || !existsSync(path)) {
			this.fail(job.trackId, job.models, 'local', 'missing_file', 'audio file not found');
			return true;
		}
		this.running = job.trackId;
		this.d.onChange();
		try {
			const res = await this.d.sidecar.analyze({
				trackId: job.trackId, path, models: job.models, segments: this.d.library.trackSegments(job.trackId),
			});
			this.persist(job.trackId, res, 'local');
			return true;
		} catch (err) {
			return this.handleError(job.trackId, job.models, 'local', err as MirSidecarError);
		} finally {
			this.running = null;
			this.d.onChange();
		}
	}

	private async cloudBatch(): Promise<boolean> {
		const jobs: Next[] = [];
		while (jobs.length < CLOUD_BATCH) {
			const j = this.next();
			if (!j) break;
			jobs.push(j);
		}
		if (jobs.length === 0) return false;
		const items = [];
		for (const j of jobs) {
			const path = this.d.library.trackFile(j.trackId);
			if (!path || !existsSync(path)) { this.fail(j.trackId, j.models, 'cloud', 'missing_file', 'audio file not found'); continue; }
			items.push({ trackId: j.trackId, path, segments: this.d.library.trackSegments(j.trackId) });
		}
		const models = [...new Set(jobs.flatMap((j) => j.models))];
		try {
			const { items: out } = await this.d.sidecar.analyzeBatchCloud(items, models);
			for (const r of out) {
				if ('result' in r) this.persist(r.trackId, { trackId: r.trackId, ...r.result }, 'cloud');
				else this.fail(r.trackId, models, 'cloud', r.error.kind, r.error.message);
			}
			return true;
		} catch (err) {
			return this.handleError(null, models, 'cloud', err as MirSidecarError);
		}
	}

	private persist(trackId: string, res: MirAnalyzeResult, executor: string): void {
		const done: string[] = [];
		for (const [modelId, e] of Object.entries(res.embeddings)) {
			this.d.store.putResult(trackId, modelId, executor, e.ms ?? null, decodeVec(e.vec),
				e.segments.map((s) => ({ index: s.index, startSec: s.startSec, endSec: s.endSec, label: s.label ?? null, vec: decodeVec(s.vec) })));
			done.push(modelId);
		}
		this.sessionDone++;
		this.d.onEvent({ kind: 'analyzed', trackId, modelIds: done });
	}

	private fail(trackId: string, modelKeys: string[], executor: string, kind: string, message: string): void {
		for (const key of modelKeys) {
			const mid = this.d.modelId(key);
			if (!mid) continue;
			this.d.store.putFailure(trackId, mid, executor, kind, message);
			this.d.onEvent({ kind: 'failed', trackId, modelId: mid, errorKind: kind, message });
		}
	}

	// Decide what a failure means for the lane. true = keep going.
	private handleError(trackId: string | null, modelKeys: string[], executor: string, err: MirSidecarError): boolean {
		const kind = err.kind ?? 'internal';
		const message = err.message || String(err);
		if (kind === 'sidecar_unavailable') {
			// Engine restarting: retry this track first once it's back.
			if (trackId) this.priority.unshift(trackId);
			this.invalidate();
			return false;
		}
		if (kind === 'cancelled') return true;
		// Engine-level problems block the lane rather than stamping a failure
		// on every track: missing/corrupt weights, an unknown model, or (for a
		// whole cloud batch) credentials / deployment trouble.
		if (kind === 'model' || kind === 'unsupported' || trackId === null) {
			this.blocked = message;
			this.lastError = message;
			this.invalidate();
			mlog.error('engine lane blocked', undefined, { kind, message, executor });
			return false;
		}
		this.lastError = message;
		this.fail(trackId, modelKeys, executor, kind, message);
		return true;
	}
}
