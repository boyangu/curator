// A phone's own log records, sent to the account's cloud while its owner
// allows it ('client_logs'). The phone has no other way out: reading its logs
// takes a cable and developer options. Kept for a week, then gone.
//
// What a record may carry is the sender's to keep clean: ids, counts and
// stable reason strings, never an email, a password, a code or a token.

import { z } from 'zod';

export const CLIENT_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type ClientLogLevel = (typeof CLIENT_LOG_LEVELS)[number];

// One call's records, and one record's serialized size. With the cap a call
// stays inside the API's body limit even when every record is at its own.
export const CLIENT_LOG_MAX_RECORDS = 300;
export const CLIENT_LOG_MAX_RECORD_BYTES = 4 * 1024;

const text = (max: number) => z.string().transform((s) => s.slice(0, max));

// `n` counts up per install, so a batch sent twice is stored once. The shape
// is the desktop's LogRecord (@curator/shared/log) plus that number.
export const ZClientLogRecord = z.object({
	n: z.number().int().nonnegative(),
	ts: z.number().int().nonnegative(),
	level: z.enum(CLIENT_LOG_LEVELS),
	proc: text(32),
	area: text(64),
	msg: text(1_000),
	data: z.record(z.unknown()).optional(),
	err: z.object({ name: text(200), message: text(2_000), stack: text(8_000).optional() }).optional(),
});
export type ClientLogRecord = z.infer<typeof ZClientLogRecord>;

// `installId` is minted by the install and outlives its sign-ins; the device
// id does neither (it comes with the library and is re-made on sign-out).
// `records` is unknown[] on purpose: one malformed record is dropped alone.
export const ZDiagnosticsUploadInput = z
	.object({
		installId: z.string().uuid(),
		appVersion: z.string().min(1).max(64),
		device: z.string().min(1).max(200),
		records: z.array(z.unknown()).min(1).max(CLIENT_LOG_MAX_RECORDS),
	})
	.strict();
export type DiagnosticsUploadInput = z.infer<typeof ZDiagnosticsUploadInput>;

// `rejected`: records that were not log records, dropped.
export type DiagnosticsUploadResult = { stored: number; rejected: number };
