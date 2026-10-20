// The zod shapes of sync.pull's and sync.bootstrap's inputs: the server
// validates with them, and the protocol tests pin what an old and a new
// client may send. Strict, like every server input: an unknown key is
// refused rather than ignored, which is exactly why a client may only send
// the 'pull_skip_own' / 'device_reads' fields to a server that advertised
// the feature (cloud-service.ts `SYNC_FEATURES`).

import { z } from 'zod';
import type { BootstrapInput, PullInput } from './cloud-service.js';

export const ZDeviceId = z.string().min(1).max(128);

const ZSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ZPullInput = z
	.object({
		afterSeq: ZSeq,
		// Capped at MAX_PULL_OPS by the server, not refused: asking for more is
		// not an error, the client just gets a page.
		limit: z.number().int().positive().optional(),
		deviceId: ZDeviceId.optional(),
		ownThroughSeq: ZSeq.optional(),
	})
	.strict()
	// The bound needs the device it is about. The reverse is not implied: a
	// device id alone ('device_reads') names the caller and skips nothing,
	// since "skip all my ops" is only safe for a database that holds every op
	// ever stamped with its id, which a restored backup does not.
	.refine((v) => v.ownThroughSeq === undefined || v.deviceId !== undefined, {
		message: 'ownThroughSeq needs deviceId',
		path: ['ownThroughSeq'],
	});

// `.optional()`: a client from before 'device_reads' sends no input at all.
export const ZBootstrapInput = z.object({ deviceId: ZDeviceId.optional() }).strict().optional();

// The schema and the protocol type must describe the same input.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _pullInputMatches: Same<z.infer<typeof ZPullInput>, PullInput> = true;
const _bootstrapInputMatches: Same<z.infer<typeof ZBootstrapInput>, BootstrapInput | undefined> = true;
void _pullInputMatches;
void _bootstrapInputMatches;
