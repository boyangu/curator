// What one HTTP request accumulates for its request_log row as it runs: the
// handler creates it, the tRPC context carries it, the auth middleware and
// the resolvers fill in what only they know (the verified user, the pushing
// device, op counts), and the handler writes the row once the response is
// built. Mutable on purpose: tRPC's context is the only thing threaded from
// the adapter into the resolvers, and the row is written exactly once, by
// the handler, whatever path the request took.

import type { AuditDetail, AuditEmit, AuditKind, AuditWriter } from './audit.js';

export class CallState {
	// The tRPC path, or `http:<status>` when tRPC never ran.
	procedure: string | null = null;
	// From the verified token only.
	userId: string | null = null;
	sessionId: string | null = null;
	// From a verified push's input only: the calling device.
	deviceId: string | null = null;
	opsIn: number | null = null;
	opsOut: number | null = null;
	// A pull that asked to skip its own ops: how many it left out. Stdout
	// only; request_log has no column for it.
	opsSkippedOwn: number | null = null;
	// The stable reason a failed call answered with.
	reason: string | null = null;

	constructor(
		readonly requestId: string,
		private readonly writer: AuditWriter,
	) {}

	readonly audit: AuditEmit = (kind: AuditKind, detail: AuditDetail = {}, opts: { deviceId?: string } = {}) => {
		this.writer.event({
			at: new Date().toISOString(),
			request_id: this.requestId,
			user_id: this.userId,
			device_id: opts.deviceId ?? this.deviceId,
			kind,
			detail,
		});
	};
}
