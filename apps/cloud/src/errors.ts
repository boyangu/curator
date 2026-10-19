// Errors the sync and account code raises for a whole call (as opposed to
// per-op rejections, which ride in `PushResult.rejected`). The tRPC layer
// maps `code` onto the HTTP status and puts `reason` and `retryAfterSec`
// into the error's `data`, so a client branches on a stable string, never on
// a message.
//
// Whole-call errors are the transient ones: the client keeps its outbox rows
// pending and retries (after registering, after the server is upgraded,
// after `retryAfterSec`). A permanent verdict on an op is a rejection.

import type { CallErrorReason } from '@curator/protocol';

export type CloudErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'PAYLOAD_TOO_LARGE' | 'TOO_MANY_REQUESTS';

// The reasons are the protocol's (`CALL_ERROR_REASONS`), so the desktop and
// phone branch on the same list this server raises.
export type CloudErrorReason = CallErrorReason;

export class CloudError extends Error {
	override readonly name = 'CloudError';
	constructor(
		readonly code: CloudErrorCode,
		readonly reason: CloudErrorReason,
		readonly retryAfterSec?: number,
	) {
		super(reason);
	}
}
