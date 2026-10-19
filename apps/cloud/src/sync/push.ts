// sync.push (design: "Server API"). The server stores ops; it does not judge
// them. Merge conflicts resolve later and deterministically in every
// reducer, so the only verdicts here are "malformed or unauthorised" (a
// per-op rejection the device keeps and shows) and "not now" (a whole-call
// CloudError the device retries).
//
// Order of work, all before the first write: shape and size caps, schema
// version gate, zod payload validation (`parseOp`), provenance, storability.
// Then one transaction: device check, per-user advisory lock, one INSERT for
// the whole batch (one statement, so one wake-up), duplicate resolution.

import {
	clampClientTs,
	MAX_PUSH_BYTES,
	MAX_PUSH_OPS,
	safeParseOp,
	schemaVersionStatus,
	utf8ByteLength,
	type Op,
	type PushResult,
	type RejectReason,
} from '@curator/protocol';
import type { AuditEmit } from '../audit.js';
import { num, type Db, type Queryable } from '../db/db.js';
import { withUserTx } from '../db/user-tx.js';
import { CloudError } from '../errors.js';

export type PushCall = { deviceId: string; ops: readonly unknown[] };

type Rejection = PushResult['rejected'][number];

function rawField(raw: unknown, key: string): unknown {
	return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
}

function rawOpId(raw: unknown): string {
	const id = rawField(raw, 'op_id');
	return typeof id === 'string' ? id : '';
}

// Postgres text and jsonb cannot hold U+0000, and jsonb refuses a lone UTF-16
// surrogate (JSON.stringify escapes it as `\udXXX`, which jsonb rejects).
// Either one inside a batch would fail the single INSERT and with it every
// valid op beside it, so such an op is rejected on its own here instead.
// Keys are checked too: a payload object key is jsonb text like any value.
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function hasUnstorableText(v: unknown): boolean {
	if (typeof v === 'string') return UNSTORABLE.test(v);
	if (Array.isArray(v)) return v.some(hasUnstorableText);
	if (v !== null && typeof v === 'object') return Object.entries(v).some(([k, x]) => UNSTORABLE.test(k) || hasUnstorableText(x));
	return false;
}

// The design's batch caps (500 ops, 1 MB). Whole-call: the client splits the
// batch and retries; nothing in it is wrong.
export function assertBatchSize(ops: readonly unknown[]): void {
	if (ops.length > MAX_PUSH_OPS || utf8ByteLength(JSON.stringify(ops)) > MAX_PUSH_BYTES) {
		throw new CloudError('PAYLOAD_TOO_LARGE', 'batch_too_large');
	}
}

type Validated = { valid: Op[]; rejected: Rejection[]; clamped: { opId: string; aheadMs: number }[] };

// Pure: everything that needs no database. `nowMs` is the clamp reference.
export function validatePush(call: PushCall, nowMs: number): Validated {
	assertBatchSize(call.ops);
	const valid: Op[] = [];
	const rejected: Rejection[] = [];
	const clamped: Validated['clamped'] = [];
	let ahead = false;
	const reject = (raw: unknown, reason: RejectReason) => rejected.push({ opId: rawOpId(raw), reason });

	for (const raw of call.ops) {
		// The version gate runs before the payload schema on purpose: an op
		// from a client below the minimum is in an obsolete shape and would
		// fail today's zod as `invalid_payload`; the answer it needs is
		// "update", not "your op is broken".
		const version = rawField(raw, 'schema_version');
		if (typeof version === 'number' && Number.isInteger(version)) {
			const status = schemaVersionStatus(version);
			if (status === 'update_required') {
				reject(raw, 'update_required');
				continue;
			}
			if (status === 'ahead') {
				ahead = true;
				continue;
			}
		}
		const parsed = safeParseOp(raw);
		if (!parsed.ok) {
			reject(raw, parsed.error.reason);
			continue;
		}
		const op = parsed.op;
		// Provenance is the LWW tie-break and the audit trail; a device may
		// only push ops it stamped itself.
		if (op.device_id !== call.deviceId) {
			reject(raw, 'not_owner');
			continue;
		}
		if (hasUnstorableText(op)) {
			reject(raw, 'invalid_payload');
			continue;
		}
		// Scenario 9: a clock far in the future would win every LWW race
		// until real time caught up with it. The stored op then differs from
		// the one the pushing device applied locally, so that device must
		// re-apply its own op from the pull when `client_ts` differs instead
		// of skipping it by `op_id` (client-side rule, workstream C desktop).
		const c = clampClientTs(op.client_ts, nowMs);
		if (c.clamped) {
			clamped.push({ opId: op.op_id, aheadMs: op.client_ts - nowMs });
			valid.push({ ...op, client_ts: c.clientTs });
		} else {
			valid.push(op);
		}
	}
	if (ahead) throw new CloudError('PRECONDITION_FAILED', 'server_outdated');
	return { valid, rejected, clamped };
}

async function headSeq(tx: Queryable): Promise<number> {
	const [row] = await tx.query<{ head: unknown }>('select coalesce(max(seq), 0)::float8 as head from curator.library_op where user_id = (select auth.uid())');
	return num(row!.head);
}

// `audit` raises the security events (revoked device, rejections, clamps);
// the request context stamps the request id, user and device on them.
export async function push(db: Db, audit: AuditEmit, userId: string, call: PushCall): Promise<PushResult> {
	// Size caps first, before a connection is even taken.
	assertBatchSize(call.ops);

	// Collected in the transaction, raised after it commits, so no event
	// describes a push that then rolled back.
	const events: Parameters<AuditEmit>[] = [];
	const result = await withUserTx(db, userId, async (tx): Promise<PushResult> => {
		const { valid, rejected, clamped } = validatePush(call, tx.nowMs);

		// `last_seen_at` moves for a revoked device too: "still trying" is what
		// the account's device list should show for it.
		const [device] = await tx.query<{ revoked: boolean }>(
			`update curator.device set last_seen_at = now()
			where user_id = (select auth.uid()) and device_id = $1
			returning revoked_at is not null as revoked`,
			[call.deviceId],
		);
		if (!device) throw new CloudError('PRECONDITION_FAILED', 'device_not_registered');
		if (device.revoked) {
			events.push(['push_from_revoked_device', { ops: call.ops.length }]);
			return {
				accepted: 0,
				maxSeq: await headSeq(tx),
				rejected: call.ops.map((raw) => ({ opId: rawOpId(raw), reason: 'device_revoked' as const })),
			};
		}

		if (valid.length > 0) {
			// Serialise one user's pushes so seq order equals commit order:
			// without it a slow transaction holding seq 100 could commit after a
			// fast one holding 101, and a device that already cursored past 101
			// would never see 100. Transaction-scoped, released at commit.
			await tx.query(`select pg_advisory_xact_lock(hashtextextended('library_op:' || (select auth.uid())::text, 0))`);

			// One statement for the batch: the statement-level trigger then sends
			// one wake-up, and `with ordinality` keeps seq in the device's order.
			// `user_id` and `received_at` are not in the column list: the defaults
			// (`auth.uid()`, the transaction's `now()`) set them.
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
			const inserted = await tx.query<{ op_id: string }>(
				`insert into curator.library_op (op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload)
				select (e.op ->> 'op_id')::uuid, e.op ->> 'device_id', (e.op ->> 'client_ts')::bigint,
					(e.op ->> 'schema_version')::int, e.op ->> 'entity', e.op ->> 'entity_id', e.op ->> 'kind', e.op -> 'payload'
				from jsonb_array_elements($1::text::jsonb) with ordinality as e(op, ord)
				order by e.ord
				on conflict (op_id) do nothing
				returning op_id::text as op_id`,
				[JSON.stringify(rows)],
			);

			// Not inserted means the op id already exists. If this user can see it
			// (RLS), it is a re-push of their own op: accepted, a no-op (scenario
			// 10). If not, the id belongs to another account: an op id is a global
			// idempotency key, and silently "accepting" it would drop this op.
			const insertedIds = new Set(inserted.map((r) => r.op_id));
			const conflicted = [...new Set(valid.map((op) => op.op_id.toLowerCase()))].filter((id) => !insertedIds.has(id));
			if (conflicted.length > 0) {
				const mine = new Set(
					(
						await tx.query<{ op_id: string }>(
							`select op_id::text as op_id from curator.library_op
							where user_id = (select auth.uid())
								and op_id in (select jsonb_array_elements_text($1::text::jsonb)::uuid)`,
							[JSON.stringify(conflicted)],
						)
					).map((r) => r.op_id),
				);
				const foreign = new Set(conflicted.filter((id) => !mine.has(id)));
				if (foreign.size > 0) {
					for (let i = valid.length - 1; i >= 0; i--) {
						const op = valid[i]!;
						if (!foreign.has(op.op_id.toLowerCase())) continue;
						rejected.push({ opId: op.op_id, reason: 'not_owner' });
						valid.splice(i, 1);
					}
				}
			}
		}

		if (clamped.length > 0) {
			events.push(['client_ts_clamped', { count: clamped.length, maxSkewMs: Math.max(...clamped.map((c) => c.aheadMs)) }]);
		}
		if (rejected.length > 0) {
			const byReason: Record<string, number> = {};
			for (const r of rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
			events.push(['ops_rejected', { byReason }]);
		}

		return { accepted: valid.length, maxSeq: await headSeq(tx), rejected };
	});
	for (const e of events) audit(...e);
	return result;
}
