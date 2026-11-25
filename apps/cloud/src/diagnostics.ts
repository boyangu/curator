// 'client_logs': a phone's own log records (sql/0036_client_log.sql). Any
// signed-in caller may send, a removed device included: the install that
// failed to register, or was just signed out elsewhere, is the one whose log
// is worth reading. So the write names the verified user and goes through a
// definer function, outside any user transaction and past the device gate.

import { CLIENT_LOG_MAX_RECORD_BYTES, ZClientLogRecord, type DiagnosticsUploadInput, type DiagnosticsUploadResult } from '@curator/protocol';
import type { Queryable } from './db/db.js';
import { num } from './db/db.js';
import { CloudError } from './errors.js';

export const CLIENT_LOG_RETENTION = '7 days';
// Records a day per account: a phone at info level writes a few thousand.
export const CLIENT_LOG_PER_DAY = 50_000;

// Text a jsonb parameter will take: no NUL, no half of a surrogate pair.
const clean = (s: string): string => s.replaceAll('\0', '').toWellFormed();

// JSON as text, so its own escapes never reach jsonb; too long a one is cut
// to a note, since a cut JSON reads as nothing.
function jsonText(v: unknown, max: number): string | null {
	if (v === undefined) return null;
	const s = JSON.stringify(v);
	return Buffer.byteLength(s) > max ? JSON.stringify({ truncated: s.slice(0, max / 2) }) : s;
}

export async function storeClientLog(db: Queryable, userId: string, input: DiagnosticsUploadInput, perDay = CLIENT_LOG_PER_DAY): Promise<DiagnosticsUploadResult> {
	const rows: Record<string, unknown>[] = [];
	for (const raw of input.records) {
		const r = ZClientLogRecord.safeParse(raw);
		if (!r.success) continue;
		const { data, err, proc, area, msg, ...rest } = r.data;
		rows.push({
			...rest,
			proc: clean(proc),
			area: clean(area),
			msg: clean(msg),
			data: clean(jsonText(data, CLIENT_LOG_MAX_RECORD_BYTES) ?? '') || null,
			err: clean(jsonText(err, CLIENT_LOG_MAX_RECORD_BYTES * 2) ?? '') || null,
		});
	}
	const rejected = input.records.length - rows.length;
	if (rows.length === 0) return { stored: 0, rejected };
	const [row] = await db.query<{ n: unknown }>('select curator.log_client($1::uuid, $2::uuid, $3, $4, $5::text::jsonb, $6::int) as n', [
		userId,
		input.installId,
		clean(input.appVersion),
		clean(input.device),
		JSON.stringify(rows),
		String(perDay),
	]);
	const stored = num(row!.n);
	if (stored < 0) throw new CloudError('TOO_MANY_REQUESTS', 'client_log_full', 3_600);
	return { stored, rejected };
}

// Rows deleted.
export async function pruneClientLog(db: Queryable, olderThan: string = CLIENT_LOG_RETENTION): Promise<number> {
	const [row] = await db.query<{ n: unknown }>('select curator.prune_client_log($1::interval)::float8 as n', [olderThan]);
	return num(row!.n);
}
