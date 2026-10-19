// The zod shape of sync.pull's input: the server validates with it, and the
// protocol tests pin what an old and a new client may send. Strict, like
// every server input: an unknown key is refused rather than ignored, which
// is exactly why a client may only send the 'pull_skip_own' fields to a
// server that advertised the feature (cloud-service.ts `SYNC_FEATURES`).

import { z } from 'zod';
import type { PullInput } from './cloud-service.js';

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
	// Both or neither. A device id alone would mean "skip all my ops", which
	// is only safe for a database that holds every op ever stamped with its
	// id — not true of a restored backup — so the bound is never implied.
	.refine((v) => (v.deviceId === undefined) === (v.ownThroughSeq === undefined), {
		message: 'deviceId and ownThroughSeq go together',
		path: ['ownThroughSeq'],
	});

// The schema and the protocol type must describe the same input.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _pullInputMatches: Same<z.infer<typeof ZPullInput>, PullInput> = true;
void _pullInputMatches;
