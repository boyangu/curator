// The per-call access log (curator.request_log) and the security audit trail
// (curator.audit_event), sql/0002_audit.sql. Both are written through one
// in-memory buffer that flushes every second or every 100 rows via the
// SECURITY DEFINER writers, on the pool and outside any user transaction:
// a request only pushes onto an array, it never waits on a log write, and a
// log write can never fail or roll back a request.
//
// When a flush fails (database down, pooler refusing) the rows go to stdout
// as JSON lines instead, so Fly's log retention still holds them. The buffer
// is capped: if a flush hangs (a stalled connection) while traffic keeps
// arriving, the oldest rows spill to stdout rather than grow memory without
// bound, and the overflow count is logged.
//
// Every field here is an id, a count, a size or a stable reason string. Never
// put a token, an op payload, an email, a connection string or a query string
// into a row or into `detail`.

import { randomUUID } from 'node:crypto';
import type { Queryable } from './db/db.js';
import { num } from './db/db.js';
import type { Logger } from './log.js';

// ── rows ────────────────────────────────────────────────────────────────────

// Column-named, so the JSON array maps 1:1 onto curator.log_requests.
export type RequestRow = {
	at: string;
	request_id: string;
	user_id: string | null;
	device_id: string | null;
	session_id: string | null;
	procedure: string;
	http_status: number;
	reason: string | null;
	duration_ms: number;
	ops_in: number | null;
	ops_out: number | null;
	bytes_in: number | null;
	bytes_out: number | null;
	client_ip: string | null;
	client: string | null;
};

export const AUDIT_KINDS = [
	'auth_failed',
	'rate_limited',
	'device_registered',
	'device_revoked',
	'device_reregister_refused',
	// `{ ops, via }`: `via` is 'device' (the device named is revoked) or
	// 'session' (the session acts as a revoked device, whatever it named).
	'push_from_revoked_device',
	// sync.pull / sync.bootstrap refused for a revoked device:
	// `{ procedure, via }` as above.
	'read_from_revoked_device',
	'ops_rejected',
	'client_ts_clamped',
	'bootstrap_served',
	// catalogue.*: per-item rejections of a put ({ procedure, byReason }), or
	// a whole call refused for a revoked device ({ procedure, reason, via })
	// or a missing entitlement ({ procedure, reason }).
	'catalogue_rejected',
	// 'batches' (src/sync/batch.ts): a batch opened or resumed
	// ({ batchId, label, resumed, stagedOps, expectedOps }), published
	// ({ batchId, label, totalOps, insertedOps, rejected, fenceSeq,
	// committedSeq, ms }), dropped by its device ({ batchId,
	// label, stagedOps }) or expired idle by the sweep ({ ..., idleMs }).
	// Raised by the commit runner and the sweep too, so not every one has a
	// request id.
	'batch_begun',
	'batch_committed',
	'batch_aborted',
	'batch_expired',
	// 'snapshot_storage' (src/sync/publish-snapshot.ts): the master indexed a
	// Storage snapshot ({ snapshotSeq, bytes, parts, pruned, superseded }).
	'snapshot_published',
	// sync.push / batchPush accepted source ops (library_track set-meta /
	// set-attrs, album set-meta) from a device that is not the account's
	// master ({ procedure, master, byKind }). Audit only: the ops are kept.
	'source_from_non_master',
	// The compaction sweep (src/sync/compact.ts) raised an account's base
	// and deleted the log below it ({ through, baseSeq, deleted }). No
	// request id: the sweep raised it.
	'ops_compacted',
	// A pull or bootstrap found an account with a base above 0 and no
	// snapshot ({ procedure, baseSeq }): a server invariant violation
	// (base.ts), answered as an internal error.
	'base_without_snapshot',
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export type AuditDetail = Record<string, string | number | boolean | null | Record<string, number>>;

export type AuditRow = {
	at: string;
	request_id: string | null;
	user_id: string | null;
	device_id: string | null;
	kind: AuditKind;
	detail: AuditDetail;
};

// What domain code (push, devices) is handed to raise an event; the request
// context stamps the request id, verified user and device onto it.
export type AuditEmit = (kind: AuditKind, detail?: AuditDetail, opts?: { deviceId?: string }) => void;

// The stdout line's level per kind: warn for what someone may want to look
// at, info for the routine lifecycle.
const AUDIT_LEVEL: Record<AuditKind, 'info' | 'warn'> = {
	auth_failed: 'warn',
	rate_limited: 'warn',
	device_registered: 'info',
	device_revoked: 'info',
	device_reregister_refused: 'warn',
	push_from_revoked_device: 'warn',
	read_from_revoked_device: 'warn',
	ops_rejected: 'info',
	client_ts_clamped: 'warn',
	bootstrap_served: 'info',
	catalogue_rejected: 'info',
	batch_begun: 'info',
	batch_committed: 'info',
	batch_aborted: 'info',
	batch_expired: 'warn',
	snapshot_published: 'info',
	source_from_non_master: 'info',
	ops_compacted: 'info',
	base_without_snapshot: 'warn',
};

// ── request ids and headers ─────────────────────────────────────────────────

export const REQUEST_ID_HEADER = 'x-request-id';
export const CLIENT_HEADER = 'x-curator-client';
// Fly's edge sets this to the TCP peer it accepted the connection from.
// X-Forwarded-For is client-appendable and is deliberately not read.
export const CLIENT_IP_HEADER = 'fly-client-ip';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A client's id is kept only when it is a UUID (the column's type, and no
// room to smuggle text into the log); anything else gets a fresh one.
export function requestIdFrom(headers: Headers): string {
	const v = headers.get(REQUEST_ID_HEADER)?.trim();
	return v && UUID_RE.test(v) ? v.toLowerCase() : randomUUID();
}

// Printable ASCII only, capped: a header is attacker-chosen text.
function cleanHeader(v: string | null, max: number): string | null {
	if (!v) return null;
	const s = v.replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);
	return s.length > 0 ? s : null;
}

export function clientFrom(headers: Headers): string | null {
	return cleanHeader(headers.get(CLIENT_HEADER), 100);
}

export function clientIpFrom(headers: Headers): string | null {
	return cleanHeader(headers.get(CLIENT_IP_HEADER), 64);
}

// ── writer ──────────────────────────────────────────────────────────────────

export type AuditWriterOptions = {
	// The pool, never a user transaction.
	db: Queryable;
	log: Logger;
	flushMs?: number;
	// Rows buffered before a flush is kicked without waiting for the timer.
	flushAt?: number;
	// Rows per writer call.
	batchSize?: number;
	// Per buffer (requests, audit events). Past it the oldest spill to stdout.
	maxBuffered?: number;
};

type Kind = 'request' | 'audit';

const WRITER_SQL: Record<Kind, string> = {
	request: 'select curator.log_requests($1::text::jsonb)',
	audit: 'select curator.log_audit_events($1::text::jsonb)',
};

// The stdout line a row becomes when it cannot reach the database.
const UNSAVED_MSG: Record<Kind, string> = { request: 'request_log_unsaved', audit: 'audit_event_unsaved' };

export class AuditWriter {
	private readonly buffers: { request: RequestRow[]; audit: AuditRow[] } = { request: [], audit: [] };
	private readonly overflowed: Record<Kind, number> = { request: 0, audit: 0 };
	private inflight: Promise<void> | null = null;
	private again = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly flushMs: number;
	private readonly flushAt: number;
	private readonly batchSize: number;
	private readonly maxBuffered: number;

	constructor(private readonly opts: AuditWriterOptions) {
		this.flushMs = opts.flushMs ?? 1000;
		this.flushAt = opts.flushAt ?? 100;
		this.batchSize = opts.batchSize ?? 500;
		this.maxBuffered = opts.maxBuffered ?? 10_000;
	}

	// Starts the periodic flush. Tests leave it off and call flush().
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.flush(), this.flushMs);
		this.timer.unref();
	}

	request(row: RequestRow): void {
		this.add('request', row);
	}

	// Also one stdout line per event, named after the kind, so `fly logs`
	// shows security events without a database query.
	event(row: AuditRow): void {
		const { kind, detail, request_id, user_id, device_id } = row;
		this.opts.log[AUDIT_LEVEL[kind]](kind, { requestId: request_id, userId: user_id, deviceId: device_id, ...detail });
		this.add('audit', row);
	}

	get buffered(): { request: number; audit: number } {
		return { request: this.buffers.request.length, audit: this.buffers.audit.length };
	}

	// Never rejects. Resolves once everything buffered at the time of the call
	// (and anything added while it ran) is written or spilled.
	// One flush runs at a time; a call while one runs makes it go round again
	// instead of queueing another, so a stalled database costs one pending
	// query, not one per incoming request.
	flush(): Promise<void> {
		this.again = true;
		this.inflight ??= (async () => {
			try {
				while (this.again) {
					this.again = false;
					this.reportOverflow();
					await this.drain('request');
					await this.drain('audit');
				}
			} finally {
				this.inflight = null;
			}
		})();
		return this.inflight;
	}

	// SIGTERM: stop the timer and write what is left.
	async close(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		await this.flush();
	}

	// Last resort at a forced exit: every buffered row to stdout, now.
	spillBuffered(): void {
		this.spill('request', this.buffers.request.splice(0));
		this.spill('audit', this.buffers.audit.splice(0));
	}

	private add<K extends Kind>(kind: K, row: K extends 'request' ? RequestRow : AuditRow): void {
		const buf = this.buffers[kind] as (RequestRow | AuditRow)[];
		buf.push(row);
		if (buf.length > this.maxBuffered) {
			const spilled = buf.splice(0, buf.length - this.maxBuffered);
			this.overflowed[kind] += spilled.length;
			this.spill(kind, spilled);
		}
		if (buf.length >= this.flushAt) void this.flush();
	}

	private async drain(kind: Kind): Promise<void> {
		const buf = this.buffers[kind] as (RequestRow | AuditRow)[];
		while (buf.length > 0) {
			const batch = buf.splice(0, this.batchSize);
			try {
				await this.opts.db.query(WRITER_SQL[kind], [JSON.stringify(batch)]);
			} catch (e) {
				// The database is most likely down: spill this batch and everything
				// behind it at once rather than retry a timeout per batch.
				const rest = buf.splice(0, buf.length);
				this.opts.log.error('log_flush_failed', { kind, rows: batch.length + rest.length, error: e });
				this.spill(kind, batch);
				this.spill(kind, rest);
				return;
			}
		}
	}

	private spill(kind: Kind, rows: readonly (RequestRow | AuditRow)[]): void {
		for (const row of rows) this.opts.log.info(UNSAVED_MSG[kind], row);
	}

	private reportOverflow(): void {
		for (const kind of ['request', 'audit'] as const) {
			if (this.overflowed[kind] === 0) continue;
			this.opts.log.warn('log_buffer_overflow', { kind, spilled: this.overflowed[kind], maxBuffered: this.maxBuffered });
			this.overflowed[kind] = 0;
		}
	}
}

// ── retention ───────────────────────────────────────────────────────────────

export const REQUEST_LOG_RETENTION = '90 days';
export const PRUNE_EVERY_MS = 24 * 3600 * 1000;

// Rows deleted. audit_event is never pruned.
export async function pruneRequestLog(db: Queryable, olderThan: string = REQUEST_LOG_RETENTION): Promise<number> {
	const [row] = await db.query<{ n: unknown }>('select curator.prune_request_log($1::interval)::float8 as n', [olderThan]);
	return num(row!.n);
}
