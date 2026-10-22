// 'batches': a per-user virtual transaction over the op log
// (sql/0007_library_op_batch.sql; protocol cloud-service.ts).
//
// A desktop's one-time backlog (an initial push, a backfill after a protocol
// upgrade: ~116k ops on the main library, 2026-10-21) is staged instead of
// pushed: batchPush validates exactly as sync.push does (shared
// validatePush: caps, schema gate, zod, provenance, storability, the clock
// clamp) and lands the ops in curator.library_op_staged, where nothing reads
// them. batchCommit then
//   1. fences the user's log at its head, under the push lock
//      (visibility.ts: from here no reader passes that seq);
//   2. moves the staged ops into library_op in chunks, a transaction each,
//      under the push lock, with fresh seqs in the device's order, skipping
//      op ids the log already holds (an idempotent re-push), with no
//      per-chunk wake-up;
//   3. publishes: drops the fence, marks the batch committed, rings once.
// No snapshot is built inside the commit: the fence alone keeps the moved
// ops unseen, and the regular sweep (snapshot/job.ts) snapshots them once
// the log has been quiet for its 5 minutes. Until then a new device
// bootstraps from the older snapshot and pulls the batch's ops after it.
// Seqs are handed out at commit, in an order unrelated to when the ops were
// made, and other devices' pushes interleave with the chunks. That is safe
// because the reducer is order-independent: every merge rule is a function
// of the ops' own fields (clocks, device ids), never of `seq`
// (protocol reduce.ts; the desktop's replay-check folds the same ops in
// shuffled orders and must land on the same state).
//
// The commit runs in the background of whichever request (or sweep) holds
// the batch's lease, so no HTTP request has to outlive Fly's proxy or the
// client's timeout; batchCommit answers its progress and the client asks
// again. A stalled commit (machine gone) is finished by the next poll or by
// the sweep once its lease lapses: a fenced user's other devices see nothing
// new until it publishes, so it must never be left standing. Moved chunks
// are append-only rows, so a commit is never rolled back, only completed.

import { randomUUID } from 'node:crypto';
import { SYNC_FEATURES, type BatchAbortResult, type BatchBeginInput, type BatchBeginResult, type BatchCommitResult, type BatchPushResult, type RejectReason } from '@curator/protocol';
import type { AuditDetail, AuditKind, AuditWriter } from '../audit.js';
import { bindSession, assertSessionNotRevoked, DeviceRevokedError, touchDevice, type Caller } from '../account/device-gate.js';
import { num, numOrNull, type Db, type Queryable } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';
import type { Logger } from '../log.js';
import { sourceFromNonMaster } from './master.js';
import { assertBatchSize, validatePush, type PushCall } from './push.js';

export type BatchOptions = {
	// Staged ops moved per statement. The size follows the time: each chunk
	// aims at `moveTargetMs` from the last one's cost (at most doubling), so
	// a loaded database gets smaller statements, far inside the role's 30 s
	// statement_timeout, and an idle one fewer round trips.
	moveChunk: number;
	moveMin: number;
	moveMax: number;
	moveTargetMs: number;
	// A commit runner's hold on its batch, renewed every step.
	leaseMs: number;
	// How long batchCommit waits for the running commit before it answers
	// with progress (the client polls). Under Fly's 60 s request timeout.
	commitWaitMs: number;
	// Open batches idle this long are expired and their staged ops deleted.
	idleExpiryMs: number;
	// Test seam: awaited before each commit step, so a test can hold a commit
	// between two chunks or just before it publishes and look around.
	beforeStep?: (step: CommitStep, batchId: string) => Promise<void>;
};

export type CommitStep = 'fence' | 'move' | 'publish';

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
	moveChunk: 2000,
	moveMin: 250,
	moveMax: 10_000,
	moveTargetMs: 3000,
	leaseMs: 120_000,
	commitWaitMs: 20_000,
	idleExpiryMs: 24 * 3600 * 1000,
};

// Everything a commit runner needs, outliving the request that started it.
export type BatchDeps = { db: Db; log: Logger; audit: AuditWriter | null; options: BatchOptions };

type Rejection = { opId: string; reason: RejectReason };

// The commit's rejection list is stored on the batch row; past this many
// (a hostile client, never a real one) the rest are only counted.
const MAX_STORED_REJECTIONS = 1000;

// Events from a commit runner or the sweep carry no request id: they are
// not tied to the request that happened to start them.
function emitter(deps: BatchDeps, userId: string, deviceId: string): (kind: AuditKind, detail: AuditDetail) => void {
	return (kind, detail) =>
		deps.audit?.event({ at: new Date().toISOString(), request_id: null, user_id: userId, device_id: deviceId, kind, detail });
}

// ── the device gate ─────────────────────────────────────────────────────────

// As sync.push judges its caller (account/device-gate.ts): a session acting
// as a revoked device, or the device named revoked, is refused; an unknown
// device must register first. Unlike a push, the refusal is the whole call
// (DeviceRevokedError): a batch has nothing to hand back op by op.
async function gateWriter(tx: Queryable, caller: Caller, deviceId: string): Promise<void> {
	await assertSessionNotRevoked(tx, caller);
	const device = await touchDevice(tx, deviceId);
	if (!device) throw new CloudError('PRECONDITION_FAILED', 'device_not_registered');
	if (device.revoked) throw new DeviceRevokedError('device');
	await bindSession(tx, caller, deviceId);
}

const PUSH_LOCK = `select pg_advisory_xact_lock(hashtextextended('library_op:' || (select auth.uid())::text, 0))`;

// ── header ──────────────────────────────────────────────────────────────────

type BatchRow = {
	id: string;
	device_id: string;
	label: string;
	status: 'open' | 'committing' | 'committed' | 'aborted' | 'expired';
	staged_ops: unknown;
	total_ops: unknown;
	moved_ops: unknown;
	inserted_ops: unknown;
	rejected: string;
	fence_seq: unknown;
	prior_own_max_seq: unknown;
	committed_seq: unknown;
	lease_holder: string | null;
	ms: unknown;
};

const BATCH_COLUMNS = `id::text as id, device_id, label, status, staged_ops::float8 as staged_ops, total_ops::float8 as total_ops,
	moved_ops::float8 as moved_ops, inserted_ops::float8 as inserted_ops, rejected::text as rejected,
	fence_seq::float8 as fence_seq, prior_own_max_seq::float8 as prior_own_max_seq, committed_seq::float8 as committed_seq, lease_holder,
	floor(extract(epoch from (now() - coalesce(commit_started_at, created_at))) * 1000)::float8 as ms`;

async function readBatch(tx: Queryable, batchId: string, opts: { deviceId?: string; forUpdate?: boolean } = {}): Promise<BatchRow | undefined> {
	const [row] = await tx.query<BatchRow>(
		`select ${BATCH_COLUMNS} from curator.library_op_batch
		where user_id = (select auth.uid()) and id = $1::uuid ${opts.deviceId !== undefined ? 'and device_id = $2' : ''}
		${opts.forUpdate ? 'for update' : ''}`,
		opts.deviceId !== undefined ? [batchId, opts.deviceId] : [batchId],
	);
	return row;
}

function commitResult(b: BatchRow): BatchCommitResult {
	const committed = b.status === 'committed';
	const prior = numOrNull(b.prior_own_max_seq);
	return {
		status: committed ? 'committed' : 'committing',
		movedOps: num(b.moved_ops),
		totalOps: numOrNull(b.total_ops) ?? num(b.staged_ops),
		committedSeq: committed ? numOrNull(b.committed_seq) ?? 0 : 0,
		...(committed && prior !== null ? { priorOwnMaxSeq: prior } : {}),
		rejected: committed ? (JSON.parse(b.rejected) as string[]).map((opId) => ({ opId, reason: 'not_owner' as const })) : [],
		features: [...SYNC_FEATURES],
	};
}

// ── begin ───────────────────────────────────────────────────────────────────

// The device's live batch for the label, or a new one. Resuming refreshes
// `updated_at`, which is what the idle expiry reads.
export async function batchBegin(deps: BatchDeps, userId: string, caller: Caller, input: BatchBeginInput): Promise<BatchBeginResult> {
	const r = await withUserTx(deps.db, userId, async (tx) => {
		await gateWriter(tx, caller, input.deviceId);
		const live = async (): Promise<{ id: string; status: 'open' | 'committing'; staged: unknown } | undefined> =>
			(
				await tx.query<{ id: string; status: 'open' | 'committing'; staged: unknown }>(
					`update curator.library_op_batch set updated_at = now()
					where user_id = (select auth.uid()) and device_id = $1 and label = $2 and status in ('open', 'committing')
					returning id::text as id, status, staged_ops::float8 as staged`,
					[input.deviceId, input.label],
				)
			)[0];
		const found = await live();
		if (found) return { batchId: found.id, status: found.status, resumed: true, stagedOps: num(found.staged) };
		const [created] = await tx.query<{ id: string }>(
			`insert into curator.library_op_batch (device_id, label, expected_ops) values ($1, $2, $3::bigint)
			on conflict (user_id, device_id, label) where status in ('open', 'committing') do nothing
			returning id::text as id`,
			[input.deviceId, input.label, input.expectedOps === undefined ? null : String(input.expectedOps)],
		);
		// Lost a race with a concurrent begin for the same label: theirs.
		if (!created) {
			const again = await live();
			if (!again) throw new Error('batch begin: no live batch after a conflicting insert');
			return { batchId: again.id, status: again.status, resumed: true, stagedOps: num(again.staged) };
		}
		return { batchId: created.id, status: 'open' as const, resumed: false, stagedOps: 0 };
	});
	emitter(deps, userId, input.deviceId)('batch_begun', {
		batchId: r.batchId,
		label: input.label,
		resumed: r.resumed,
		stagedOps: r.stagedOps,
		expectedOps: input.expectedOps ?? null,
	});
	return { ...r, features: [...SYNC_FEATURES] };
}

// ── push (stage) ────────────────────────────────────────────────────────────

export type BatchPushCall = PushCall & { batchId: string };

export async function batchPush(deps: BatchDeps, emit: (kind: AuditKind, detail: AuditDetail) => void, userId: string, caller: Caller, call: BatchPushCall): Promise<BatchPushResult> {
	assertBatchSize(call.ops);
	const events: Array<[AuditKind, AuditDetail]> = [];
	const result = await withUserTx(deps.db, userId, async (tx): Promise<BatchPushResult> => {
		const { valid, rejected, clamped, sentTs } = validatePush(call, tx.nowMs);
		await gateWriter(tx, caller, call.deviceId);
		// Row-locked, so a stage and the commit's start serialise: an op
		// staged here is either in the commit's total or refused.
		const b = await readBatch(tx, call.batchId, { deviceId: call.deviceId, forUpdate: true });
		if (!b) throw new CloudError('NOT_FOUND', 'batch_gone');
		if (b.status === 'committing') throw new CloudError('CONFLICT', 'batch_committing');
		if (b.status !== 'open') throw new CloudError('NOT_FOUND', 'batch_gone');

		const stored = new Map<string, number>();
		let added = 0;
		if (valid.length > 0) {
			const rows = valid.map((op) => ({
				op_id: op.op_id,
				device_id: op.device_id,
				client_ts: op.client_ts,
				schema_version: op.schema_version,
				entity: op.entity,
				entity_id: op.entity_id,
				kind: op.kind,
				payload: op.payload,
			}));
			const inserted = await tx.query<{ op_id: string; client_ts: unknown }>(
				`insert into curator.library_op_staged (batch_id, op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload)
				select $2::uuid, (e.op ->> 'op_id')::uuid, e.op ->> 'device_id', (e.op ->> 'client_ts')::bigint,
					(e.op ->> 'schema_version')::int, e.op ->> 'entity', e.op ->> 'entity_id', e.op ->> 'kind', e.op -> 'payload'
				from jsonb_array_elements($1::text::jsonb) with ordinality as e(op, ord)
				order by e.ord
				on conflict (batch_id, op_id) do nothing
				returning op_id::text as op_id, client_ts::float8 as client_ts`,
				[JSON.stringify(rows), call.batchId],
			);
			added = inserted.length;
			for (const r of inserted) stored.set(r.op_id, num(r.client_ts));
			const again = [...new Set(valid.map((op) => op.op_id.toLowerCase()))].filter((id) => !stored.has(id));
			if (again.length > 0) {
				for (const r of await tx.query<{ op_id: string; client_ts: unknown }>(
					`select op_id::text as op_id, client_ts::float8 as client_ts from curator.library_op_staged
					where batch_id = $1::uuid and op_id in (select jsonb_array_elements_text($2::text::jsonb)::uuid)`,
					[call.batchId, JSON.stringify(again)],
				)) {
					stored.set(r.op_id, num(r.client_ts));
				}
			}
		}
		const [h] = await tx.query<{ staged: unknown }>(
			`update curator.library_op_batch set staged_ops = staged_ops + $2::bigint, updated_at = now()
			where id = $1::uuid
			returning staged_ops::float8 as staged`,
			[call.batchId, String(added)],
		);

		if (clamped.length > 0) events.push(['client_ts_clamped', { count: clamped.length, maxSkewMs: Math.max(...clamped.map((c) => c.aheadMs)) }]);
		if (rejected.length > 0) {
			const byReason: Record<string, number> = {};
			for (const r of rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
			events.push(['ops_rejected', { byReason }]);
		}
		// Staged ops are not in the log, so this call's own master setting op
		// is passed in; one staged by an earlier call of the batch is not seen
		// (a master change rides a plain push, not a backlog).
		const nonMaster = await sourceFromNonMaster(tx, call.deviceId, valid, valid);
		if (nonMaster) events.push(['source_from_non_master', { procedure: 'sync.batchPush', master: nonMaster.master, byKind: nonMaster.byKind }]);
		// As a push reports it: every staged op whose stored stamp is not the
		// one sent (clamped now, or when it was first staged).
		const restamped: NonNullable<BatchPushResult['clamped']> = [];
		const reported = new Set<string>();
		for (const op of valid) {
			const id = op.op_id.toLowerCase();
			const ts = stored.get(id);
			if (ts === undefined || reported.has(id) || ts === sentTs.get(id)) continue;
			reported.add(id);
			restamped.push({ opId: op.op_id, clientTs: ts });
		}
		return { accepted: valid.length, rejected, clamped: restamped, stagedOps: num(h!.staged), features: [...SYNC_FEATURES] };
	});
	for (const [kind, detail] of events) emit(kind, detail);
	return result;
}

// ── commit ──────────────────────────────────────────────────────────────────

// Batch ids with a runner in this process. A runner on another machine is
// known by its lease instead.
const running = new Map<string, Promise<void>>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Starts the commit (open → committing) and answers how far it is, waiting
// up to `commitWaitMs` for a runner here to finish it.
export async function batchCommit(deps: BatchDeps, userId: string, caller: Caller, input: { deviceId: string; batchId: string }): Promise<BatchCommitResult> {
	const b = await withUserTx(deps.db, userId, async (tx) => {
		await gateWriter(tx, caller, input.deviceId);
		const row = await readBatch(tx, input.batchId, { deviceId: input.deviceId, forUpdate: true });
		if (!row || row.status === 'aborted' || row.status === 'expired') throw new CloudError('NOT_FOUND', 'batch_gone');
		if (row.status === 'open') {
			await tx.query(
				`update curator.library_op_batch set status = 'committing', total_ops = staged_ops, commit_started_at = now(), updated_at = now()
				where id = $1::uuid`,
				[input.batchId],
			);
			return { ...row, status: 'committing' as const, total_ops: row.staged_ops };
		}
		return row;
	});
	if (b.status === 'committed') return commitResult(b);
	const run = driveCommit(deps, userId, input.batchId);
	await Promise.race([run, sleep(deps.options.commitWaitMs)]);
	const now = await withUserTx(deps.db, userId, (tx) => readBatch(tx, input.batchId));
	return commitResult(now ?? b);
}

// The one runner for a batch in this process; never rejects (a failure is
// logged and the next poll or sweep starts it again).
export function driveCommit(deps: BatchDeps, userId: string, batchId: string): Promise<void> {
	let run = running.get(batchId);
	if (!run) {
		run = runCommit(deps, userId, batchId)
			.catch((e: unknown) => deps.log.error('batch_commit_failed', { userId, batchId, error: e }))
			.finally(() => running.delete(batchId));
		running.set(batchId, run);
	}
	return run;
}

async function runCommit(deps: BatchDeps, userId: string, batchId: string): Promise<void> {
	const { db, options } = deps;
	const holder = randomUUID();
	let chunk = options.moveChunk;
	let held = false;
	try {
		for (;;) {
			// Claim or renew, and read where the commit stands. Nothing back:
			// another runner holds it, or it is no longer committing.
			const h = await withUserTx(db, userId, async (tx) => {
				const [row] = await tx.query<BatchRow>(
					`update curator.library_op_batch
					set lease_holder = $2, lease_until = now() + make_interval(secs => $3::float8), updated_at = now()
					where user_id = (select auth.uid()) and id = $1::uuid and status = 'committing'
						and (lease_until is null or lease_until < now() or lease_holder = $2)
					returning ${BATCH_COLUMNS}`,
					[batchId, holder, String(options.leaseMs / 1000)],
				);
				return row;
			});
			if (!h) return;
			held = true;

			if (h.fence_seq === null) {
				await options.beforeStep?.('fence', batchId);
				if (!(await raiseFence(db, userId, batchId))) {
					// Another of the user's batches is committing: one fence per
					// user. Its publish wakes every device; this one's poll (or
					// the sweep) starts again then.
					deps.log.info('batch_commit_queued', { userId, batchId });
					return;
				}
				continue;
			}

			await options.beforeStep?.('move', batchId);
			const started = performance.now();
			const moved = await moveChunk(db, userId, batchId, chunk);
			if (moved > 0) {
				const ms = performance.now() - started;
				chunk = Math.max(options.moveMin, Math.min(options.moveMax, chunk * 2, Math.round((chunk * options.moveTargetMs) / Math.max(ms, 1))));
				continue;
			}

			await options.beforeStep?.('publish', batchId);
			const done = await publish(db, userId, batchId);
			if (done) {
				held = false;
				emitter(deps, userId, done.device_id)('batch_committed', {
					batchId,
					label: done.label,
					totalOps: numOrNull(done.total_ops) ?? 0,
					insertedOps: num(done.inserted_ops),
					rejected: (JSON.parse(done.rejected) as string[]).length,
					fenceSeq: numOrNull(done.fence_seq),
					committedSeq: numOrNull(done.committed_seq),
					ms: num(done.ms),
				});
			}
			return;
		}
	} finally {
		if (held) {
			// Let the next poll take over at once rather than after the lease.
			await withUserTx(db, userId, (tx) =>
				tx.query(`update curator.library_op_batch set lease_until = null, lease_holder = null where id = $1::uuid and lease_holder = $2`, [batchId, holder]),
			).catch(() => {});
		}
	}
}

// Step 1. Under the push lock, so the fence is the head exactly: every op
// at or below it is committed, every seq taken from here on is above it.
// Also fixes the batch's priorOwnMaxSeq: this device's newest op the batch
// does not carry (the walk stops at the first; staged ops the log already
// holds are skipped, as a re-push's are).
async function raiseFence(db: Db, userId: string, batchId: string): Promise<boolean> {
	return withUserTx(db, userId, async (tx) => {
		await tx.query(PUSH_LOCK);
		const [other] = await tx.query<{ batch_id: string }>(`select batch_id::text as batch_id from curator.library_op_fence where user_id = (select auth.uid())`);
		if (other && other.batch_id !== batchId) return false;
		if (!other) {
			const [b] = await tx.query<{ device_id: string }>(`select device_id from curator.library_op_batch where id = $1::uuid`, [batchId]);
			const [head] = await tx.query<{ head: unknown }>(`select coalesce(max(seq), 0)::float8 as head from curator.library_op where user_id = (select auth.uid())`);
			const [prior] = await tx.query<{ seq: unknown }>(
				`select o.seq::float8 as seq from curator.library_op o
				where o.user_id = (select auth.uid()) and o.device_id = $2
					and not exists (select 1 from curator.library_op_staged s where s.batch_id = $1::uuid and s.op_id = o.op_id)
				order by o.seq desc
				limit 1`,
				[batchId, b!.device_id],
			);
			const fence = String(num(head!.head));
			await tx.query(`insert into curator.library_op_fence (batch_id, visible_through) values ($1::uuid, $2::bigint)`, [batchId, fence]);
			await tx.query(`update curator.library_op_batch set fence_seq = $2::bigint, prior_own_max_seq = $3::bigint where id = $1::uuid`, [
				batchId,
				fence,
				String(prior ? num(prior.seq) : 0),
			]);
		}
		return true;
	});
}

// Step 2, one chunk: staged rows out, log rows in, one statement, under the
// push lock (seq order stays commit order) with the wake-up muted (the ops
// are fenced; publish rings once). Returns how many staged rows it took.
//
// In the main select, `library_op o` is read in the statement's snapshot,
// before `ins` ran: it finds exactly the ops the log held already (this
// user's, RLS) — re-pushes, accepted and skipped. An op neither inserted nor
// found there has an id another account holds: rejected as `not_owner`, as
// sync.push rejects it.
async function moveChunk(db: Db, userId: string, batchId: string, limit: number): Promise<number> {
	return withUserTx(db, userId, async (tx) => {
		await tx.query(PUSH_LOCK);
		await tx.query(`select set_config('curator.quiet_wake', 'on', true)`);
		const [r] = await tx.query<{ taken: unknown; inserted: unknown; max_new: unknown; max_old: unknown; foreign_ids: string }>(
			`with chunk as (
				delete from curator.library_op_staged
				where batch_id = $1::uuid and ord in (
					select ord from curator.library_op_staged where batch_id = $1::uuid order by ord limit $2::int
				)
				returning ord, op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload
			), ins as (
				insert into curator.library_op (op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload)
				select op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload from chunk
				order by ord
				on conflict (op_id) do nothing
				returning op_id, seq
			)
			select
				(select count(*) from chunk)::float8 as taken,
				(select count(*) from ins)::float8 as inserted,
				(select max(seq) from ins)::float8 as max_new,
				(select max(o.seq) from curator.library_op o join chunk c on c.op_id = o.op_id where o.user_id = (select auth.uid()))::float8 as max_old,
				coalesce((
					select jsonb_agg(c.op_id::text) from chunk c
					where not exists (select 1 from ins i where i.op_id = c.op_id)
						and not exists (select 1 from curator.library_op o where o.op_id = c.op_id)
				), '[]'::jsonb)::text as foreign_ids`,
			[batchId, String(limit)],
		);
		const taken = num(r!.taken);
		if (taken === 0) return 0;
		const top = Math.max(numOrNull(r!.max_new) ?? 0, numOrNull(r!.max_old) ?? 0);
		await tx.query(
			`update curator.library_op_batch
			set moved_ops = moved_ops + $2::bigint, inserted_ops = inserted_ops + $3::bigint,
				committed_seq = greatest(coalesce(committed_seq, 0), $4::bigint),
				rejected = case when jsonb_array_length(rejected) >= $6::int then rejected
					else rejected || (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements($5::text::jsonb) x limit $6::int - jsonb_array_length(rejected)) y) end,
				updated_at = now()
			where id = $1::uuid`,
			[batchId, String(taken), String(num(r!.inserted)), String(top), r!.foreign_ids, String(MAX_STORED_REJECTIONS)],
		);
		return taken;
	});
}

// Step 3. The fence comes down in the same transaction that marks the batch
// committed, so "visible" and "committed" are one fact, and one wake-up
// carries the head for every device.
async function publish(db: Db, userId: string, batchId: string): Promise<BatchRow | undefined> {
	return withUserTx(db, userId, async (tx) => {
		await tx.query(`delete from curator.library_op_fence where user_id = (select auth.uid()) and batch_id = $1::uuid`, [batchId]);
		const [row] = await tx.query<BatchRow>(
			`update curator.library_op_batch
			set status = 'committed', closed_at = now(), updated_at = now(), lease_until = null, lease_holder = null
			where id = $1::uuid and status = 'committing'
			returning ${BATCH_COLUMNS}`,
			[batchId],
		);
		if (!row) return undefined;
		await tx.query(`select curator.wake_self((select coalesce(max(seq), 0) from curator.library_op where user_id = (select auth.uid())))`);
		return row;
	});
}

// ── abort and expiry ────────────────────────────────────────────────────────

// Staged rows of a closed batch, deleted a chunk per transaction: one
// statement over ~100k rows could outlast the statement timeout.
async function purgeStaged(db: Db, userId: string, batchId: string): Promise<number> {
	let total = 0;
	for (;;) {
		const n = await withUserTx(db, userId, async (tx) => {
			const rows = await tx.query(
				`delete from curator.library_op_staged
				where batch_id = $1::uuid and op_id in (select op_id from curator.library_op_staged where batch_id = $1::uuid limit 5000)
				returning 1 as x`,
				[batchId],
			);
			return rows.length;
		});
		total += n;
		if (n === 0) return total;
	}
}

export async function batchAbort(deps: BatchDeps, userId: string, caller: Caller, input: { deviceId: string; batchId: string }): Promise<BatchAbortResult> {
	const b = await withUserTx(deps.db, userId, async (tx) => {
		await gateWriter(tx, caller, input.deviceId);
		const row = await readBatch(tx, input.batchId, { deviceId: input.deviceId, forUpdate: true });
		if (!row) throw new CloudError('NOT_FOUND', 'batch_gone');
		if (row.status === 'committing') throw new CloudError('CONFLICT', 'batch_committing');
		if (row.status === 'open') {
			await tx.query(`update curator.library_op_batch set status = 'aborted', closed_at = now(), updated_at = now() where id = $1::uuid`, [input.batchId]);
		}
		return row;
	});
	if (b.status !== 'open') return { status: b.status };
	await purgeStaged(deps.db, userId, input.batchId);
	emitter(deps, userId, input.deviceId)('batch_aborted', { batchId: input.batchId, label: b.label, stagedOps: num(b.staged_ops) });
	return { status: 'aborted' };
}

// `driven`: stalled commits run here (finished, or queued behind another
// batch's fence).
export type TendResult = { expired: number; driven: number; purged: number };

// The sweep's half of 'batches' (server.ts maintenance, the snapshot CLI):
// expire open batches idle past `idleExpiryMs`, finish commits nobody is
// driving, purge staged rows a closed batch left behind. Before the snapshot
// sweep, so a finished commit's user is not rebuilt twice.
export async function tendBatches(deps: BatchDeps): Promise<TendResult> {
	const out: TendResult = { expired: 0, driven: 0, purged: 0 };
	const rows = await deps.db.query<{ user_id: string; batch_id: string; device_id: string; status: string }>(
		`select user_id::text as user_id, batch_id::text as batch_id, device_id, status from curator.batches_to_tend(make_interval(secs => $1::float8))`,
		[String(deps.options.idleExpiryMs / 1000)],
	);
	for (const r of rows) {
		try {
			if (r.status === 'open') {
				const b = await withUserTx(deps.db, r.user_id, async (tx) => {
					const [row] = await tx.query<{ label: string; staged: unknown; idle_ms: unknown }>(
						`update curator.library_op_batch set status = 'expired', closed_at = now()
						where id = $1::uuid and status = 'open' and updated_at < now() - make_interval(secs => $2::float8)
						returning label, staged_ops::float8 as staged, floor(extract(epoch from (now() - updated_at)) * 1000)::float8 as idle_ms`,
						[r.batch_id, String(deps.options.idleExpiryMs / 1000)],
					);
					return row;
				});
				if (!b) continue;
				out.expired++;
				out.purged += await purgeStaged(deps.db, r.user_id, r.batch_id);
				emitter(deps, r.user_id, r.device_id)('batch_expired', { batchId: r.batch_id, label: b.label, stagedOps: num(b.staged), idleMs: num(b.idle_ms) });
			} else if (r.status === 'committing') {
				await driveCommit(deps, r.user_id, r.batch_id);
				out.driven++;
			} else {
				out.purged += await purgeStaged(deps.db, r.user_id, r.batch_id);
			}
		} catch (e) {
			// One batch's failure must not stop the rest.
			deps.log.error('batch_tend_failed', { userId: r.user_id, batchId: r.batch_id, error: e });
		}
	}
	if (out.expired + out.driven + out.purged > 0) deps.log.info('batches_tended', out);
	return out;
}
