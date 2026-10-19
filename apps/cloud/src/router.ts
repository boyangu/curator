// The procedures (design: "Server API"). Thin on purpose: input shape here,
// rate limit, then the domain function. Each resolver's return type is the
// protocol's (or src/wire.ts's), so a drift between this server and the
// contract the desktop and phone compile against is a type error.
//
// `catalogue.*` (workstream D) is not here yet.

import { MIN_SUPPORTED_SCHEMA_VERSION, SCHEMA_VERSION, SYNC_FEATURES, ZDeviceId, ZPullInput, type DeviceInfo, type PullResult, type PushResult } from '@curator/protocol';
import { z } from 'zod';
import { DEVICE_PLATFORMS, listDevices, registerDevice, revokeDevice } from './account/devices.js';
import { CloudError } from './errors.js';
import { bootstrap } from './sync/bootstrap.js';
import { pull } from './sync/pull.js';
import { push } from './sync/push.js';
import { authedProcedure, publicProcedure, rateLimit, router } from './trpc.js';
import type { BootstrapResult, HealthResult } from './wire.js';

// `ops` is unknown[] on purpose: each op is validated on its own with
// `parseOp` so one malformed op is rejected alone while the rest land. The
// 500-op / 1 MB caps are checked in push() so they answer `batch_too_large`.
const ZPushInput = z.object({ deviceId: ZDeviceId, ops: z.array(z.unknown()) }).strict();

// sync.pull's input lives in the protocol (sync-input.ts), next to the
// 'pull_skip_own' contract it carries.

const ZRegisterDeviceInput = z
	.object({
		deviceId: ZDeviceId,
		name: z.string().trim().min(1).max(200),
		platform: z.enum(DEVICE_PLATFORMS),
	})
	.strict();

// A pull's optional device id is a filter, not an identity (nothing checks
// it is registered, and a client could rotate it at will), so the bucket is
// per Supabase session, which is one per signed-in install.
const pullKey = (user: { id: string; sessionId: string | null }) => `${user.id}:${user.sessionId ?? '-'}`;

export const appRouter = router({
	health: publicProcedure.query((): HealthResult => ({
		ok: true,
		schemaVersion: SCHEMA_VERSION,
		minSupportedSchemaVersion: MIN_SUPPORTED_SCHEMA_VERSION,
		features: [...SYNC_FEATURES],
		// Baked into the image by the deploy workflow (Dockerfile ARG GIT_SHA);
		// the workflow polls this until it shows the commit it deployed. `||`
		// rather than `??`: an image built without the arg carries an empty
		// string, which should read as unknown too.
		commit: process.env.GIT_SHA || 'unknown',
	})),

	sync: router({
		push: authedProcedure.input(ZPushInput).mutation(({ ctx, input }): Promise<PushResult> => {
			// Set before the rate limit, so a throttled push is attributed too.
			// The device id is trusted only because the token above it verified.
			ctx.call.deviceId = input.deviceId;
			ctx.call.opsIn = input.ops.length;
			rateLimit(ctx, 'push', `${ctx.user.id}:${input.deviceId}`);
			return push(ctx.deps.db, ctx.call.audit, ctx.user.id, input);
		}),
		pull: authedProcedure.input(ZPullInput).query(async ({ ctx, input }): Promise<PullResult> => {
			rateLimit(ctx, 'pull', pullKey(ctx.user));
			const { result, skippedOwn } = await pull(ctx.deps.db, ctx.user.id, input, ctx.deps.pull);
			// What was actually sent; the own ops left out go to the stdout
			// line only (request_log has no column for them).
			ctx.call.opsOut = result.ops.length;
			if (input.deviceId !== undefined) ctx.call.opsSkippedOwn = skippedOwn;
			return result;
		}),
		// Shares the pull bucket: it is the heaviest read there is. Audited
		// because it hands out the whole library in one response.
		bootstrap: authedProcedure.query(async ({ ctx }): Promise<BootstrapResult> => {
			rateLimit(ctx, 'pull', pullKey(ctx.user));
			const r = await bootstrap(ctx.deps.db, ctx.user.id);
			ctx.call.audit('bootstrap_served', { snapshotSeq: r.snapshotSeq, bytes: Buffer.byteLength(r.snapshot, 'base64') });
			return r;
		}),
	}),

	account: router({
		registerDevice: authedProcedure.input(ZRegisterDeviceInput).mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
			try {
				const r = await registerDevice(ctx.deps.db, ctx.user.id, input);
				ctx.call.audit('device_registered', { platform: input.platform, created: r.created }, { deviceId: input.deviceId });
				return { ok: true };
			} catch (e) {
				if (e instanceof CloudError && e.reason === 'device_revoked') ctx.call.audit('device_reregister_refused', {}, { deviceId: input.deviceId });
				throw e;
			}
		}),
		devices: authedProcedure.query(({ ctx }): Promise<DeviceInfo[]> => listDevices(ctx.deps.db, ctx.user.id)),
		revokeDevice: authedProcedure.input(z.object({ deviceId: ZDeviceId }).strict()).mutation(async ({ ctx, input }): Promise<{ ok: true }> => {
			const r = await revokeDevice(ctx.deps.db, ctx.user.id, input.deviceId);
			ctx.call.audit('device_revoked', {}, { deviceId: input.deviceId });
			return r;
		}),
	}),
});

export type AppRouter = typeof appRouter;
