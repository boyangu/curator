// tRPC plumbing: context, error shape, the auth and error-mapping
// middleware. Procedures live in router.ts.
//
// Errors cross the wire as `{ code, httpStatus, reason, retryAfterSec }` in
// the error's `data`: `reason` is the stable string a client branches on
// (src/errors.ts), never the message. Stacks are never sent, and an internal
// error's message is replaced, because a Postgres error text names tables,
// columns and constraint internals.

import type { CataloguePolicy } from '@curator/protocol';
import { initTRPC, TRPCError } from '@trpc/server';
import type { AuditWriter } from './audit.js';
import { AuthError, type AuthUser, type TokenVerifier } from './auth/jwt.js';
import type { CallState } from './call.js';
import type { Db } from './db/db.js';
import { CloudError } from './errors.js';
import type { Logger } from './log.js';
import type { RateLimits, TokenBucketLimiter } from './rate-limit.js';
import type { PullOptions } from './sync/pull.js';

export type AppDeps = {
	db: Db;
	log: Logger;
	auth: TokenVerifier;
	limits: RateLimits;
	pull: PullOptions;
	// The buffered request_log / audit_event writer (src/audit.ts).
	audit: AuditWriter;
	// The catalogue units this server accepts (src/catalogue/policy.ts), or
	// null: catalogue off, procedures refuse, 'catalogue' not advertised.
	catalogue: CataloguePolicy | null;
	// Refuse reads that name no device (config.ts `requireDeviceId`).
	requireDeviceId: boolean;
};

export type AppContext = {
	deps: AppDeps;
	authorization: string | null;
	call: CallState;
};

const t = initTRPC.context<AppContext>().create({
	isDev: false,
	errorFormatter({ shape, error }) {
		const cause = error.cause instanceof CloudError ? error.cause : null;
		return {
			code: shape.code,
			message: error.code === 'INTERNAL_SERVER_ERROR' ? 'internal error' : shape.message,
			data: {
				code: shape.data.code,
				httpStatus: shape.data.httpStatus,
				path: shape.data.path,
				reason: cause?.reason ?? null,
				retryAfterSec: cause?.retryAfterSec ?? null,
			},
		};
	},
});

export const router = t.router;

// Turns the domain's CloudError into the matching TRPCError so the status
// code and `data.reason` come out right; anything else stays a 500.
export const publicProcedure = t.procedure.use(async ({ next }) => {
	const result = await next();
	if (!result.ok && result.error.cause instanceof CloudError) {
		const c = result.error.cause;
		throw new TRPCError({ code: c.code, message: c.reason, cause: c });
	}
	return result;
});

export const authedProcedure = publicProcedure.use(async ({ ctx, next }) => {
	let user: AuthUser;
	try {
		user = await ctx.deps.auth.verify(ctx.authorization);
	} catch (e) {
		if (e instanceof AuthError) {
			// No user on the event: nothing about the caller is verified yet.
			ctx.call.audit('auth_failed', { reason: e.reason });
			throw new CloudError('UNAUTHORIZED', e.reason);
		}
		throw e;
	}
	// The only place the log's user and session ids come from.
	ctx.call.userId = user.id;
	ctx.call.sessionId = user.sessionId;
	return next({ ctx: { user } });
});

export function rateLimit(ctx: AppContext, bucket: keyof RateLimits, key: string): void {
	const limiter: TokenBucketLimiter = ctx.deps.limits[bucket];
	const r = limiter.take(key);
	if (!r.ok) {
		ctx.call.audit('rate_limited', { bucket });
		throw new CloudError('TOO_MANY_REQUESTS', 'rate_limited', r.retryAfterSec);
	}
}
