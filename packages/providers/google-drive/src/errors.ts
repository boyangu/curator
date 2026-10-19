// Error shapes callers branch on. GoogleAuthError.code is the OAuth error
// string from the token endpoint ('invalid_grant' is the one that matters:
// expired Testing-mode refresh token / revoked access → "reconnect").
// DriveApiError.retryable tells the engine whether a later run may succeed
// without user action (rate limit, 5xx, network) or not (quota full, 404).

export class GoogleAuthError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status = 0) {
		super(message);
		this.name = 'GoogleAuthError';
		this.code = code;
		this.status = status;
	}
}

export class DriveApiError extends Error {
	readonly status: number;
	// `error.errors[0].reason` from the JSON error body, when present
	// ('userRateLimitExceeded', 'storageQuotaExceeded', 'notFound'…).
	readonly reason: string | null;
	readonly retryable: boolean;

	constructor(message: string, o: { status: number; reason: string | null; retryable: boolean }) {
		super(message);
		this.name = 'DriveApiError';
		this.status = o.status;
		this.reason = o.reason;
		this.retryable = o.retryable;
	}
}
