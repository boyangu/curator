// The procedures (design: "Server API"). Thin on purpose: input shape here,
// rate limit, then the domain function. Each resolver's return type is the
// protocol's (or src/wire.ts's), so a drift between this server and the
// contract the desktop and phone compile against is a type error.

import {
	MIN_SUPPORTED_SCHEMA_VERSION,
	SCHEMA_VERSION,
	SYNC_FEATURES,
	ZCatalogueInventoryInput,
	ZCatalogueLookupInput,
	ZDeviceId,
	ZPullInput,
	type CatalogueInventoryResult,
	type CatalogueLookupResult,
	type CataloguePolicy,
	type CataloguePutResult,
	type DeviceInfo,
	type PullResult,
	type PushResult,
	type SyncFeature,
} from '@curator/protocol';
import { z } from 'zod';
import { DEVICE_PLATFORMS, listDevices, registerDevice, revokeDevice } from './account/devices.js';
import { inventory, lookup, put } from './catalogue/catalogue.js';
import { CloudError } from './errors.js';
import { bootstrap } from './sync/bootstrap.js';
import { pull } from './sync/pull.js';
import { push } from './sync/push.js';
import { authedProcedure, publicProcedure, rateLimit, router, type AppContext } from './trpc.js';
import type { BootstrapResult, HealthResult } from './wire.js';

// What this server offers: every protocol feature it implements, minus the
// catalogue when it runs without a catalogue policy. Health, push and pull
// all answer with this one list, so a client never sees them disagree.
export function serverFeatures(catalogue: CataloguePolicy | null): SyncFeature[] {
	return SYNC_FEATURES.filter((f) => f !== 'catalogue' || catalogue !== null);
}

const withFeatures = <T extends { features?: SyncFeature[] }>(ctx: AppContext, r: T): T =>
	r.features ? { ...r, features: serverFeatures(ctx.deps.catalogue) } : r;

// The catalogue procedures refuse outright on a server configured without
// one; a client that read `features` never gets here.
function cataloguePolicy(ctx: AppContext): CataloguePolicy {
	if (!ctx.deps.catalogue) throw new CloudError('PRECONDITION_FAILED', 'catalogue_disabled');
	return ctx.deps.catalogue;
}

// Like a push: `items` is unknown[] so each item is validated on its own and
// one malformed item is rejected alone; the 100-item / 1 MiB caps are checked
// in put() so they answer `batch_too_large`.
const ZCataloguePutInput = z.object({ deviceId: ZDeviceId, items: z.array(z.unknown()) }).strict();

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
	health: publicProcedure.query(({ ctx }): HealthResult => ({
		ok: true,
		schemaVersion: SCHEMA_VERSION,
		minSupportedSchemaVersion: MIN_SUPPORTED_SCHEMA_VERSION,
		features: serverFeatures(ctx.deps.catalogue),
		...(ctx.deps.catalogue ? { catalogue: { policy: ctx.deps.catalogue } } : {}),
		// Baked into the image by the deploy workflow (Dockerfile ARG GIT_SHA);
		// the workflow polls this until it shows the commit it deployed. `||`
		// rather than `??`: an image built without the arg carries an empty
		// string, which should read as unknown too.
		commit: process.env.GIT_SHA || 'unknown',
	})),

	sync: router({
		push: authedProcedure.input(ZPushInput).mutation(async ({ ctx, input }): Promise<PushResult> => {
			// Set before the rate limit, so a throttled push is attributed too.
			// The device id is trusted only because the token above it verified.
			ctx.call.deviceId = input.deviceId;
			ctx.call.opsIn = input.ops.length;
			rateLimit(ctx, 'push', `${ctx.user.id}:${input.deviceId}`);
			return withFeatures(ctx, await push(ctx.deps.db, ctx.call.audit, ctx.user.id, input));
		}),
		pull: authedProcedure.input(ZPullInput).query(async ({ ctx, input }): Promise<PullResult> => {
			rateLimit(ctx, 'pull', pullKey(ctx.user));
			const { result, skippedOwn } = await pull(ctx.deps.db, ctx.user.id, input, ctx.deps.pull);
			// What was actually sent; the own ops left out go to the stdout
			// line only (request_log has no column for them).
			ctx.call.opsOut = result.ops.length;
			if (input.deviceId !== undefined) ctx.call.opsSkippedOwn = skippedOwn;
			return withFeatures(ctx, result);
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

	// Workstream D, phase 1 (src/catalogue/catalogue.ts). request_log reuses
	// its op columns as item counts: ops_in = hashes asked / items put,
	// ops_out = items returned / accepted / inventory entries.
	catalogue: router({
		// A mutation only so the input rides in the body (POST): 50 hashes and
		// a want list do not belong in a query string. It writes nothing.
		lookup: authedProcedure.input(ZCatalogueLookupInput).mutation(async ({ ctx, input }): Promise<CatalogueLookupResult> => {
			ctx.call.deviceId = input.deviceId;
			ctx.call.opsIn = input.audioHashes.length;
			cataloguePolicy(ctx);
			rateLimit(ctx, 'catalogue', `${ctx.user.id}:${input.deviceId}`);
			const r = await lookup(ctx.deps.db, ctx.call.audit, ctx.user.id, input);
			ctx.call.opsOut = r.items.length;
			return r;
		}),
		put: authedProcedure.input(ZCataloguePutInput).mutation(async ({ ctx, input }): Promise<CataloguePutResult> => {
			ctx.call.deviceId = input.deviceId;
			ctx.call.opsIn = input.items.length;
			const policy = cataloguePolicy(ctx);
			rateLimit(ctx, 'catalogue', `${ctx.user.id}:${input.deviceId}`);
			const r = await put(ctx.deps.db, ctx.call.audit, ctx.user.id, policy, input);
			ctx.call.opsOut = r.accepted.length;
			return r;
		}),
		inventory: authedProcedure.input(ZCatalogueInventoryInput).query(async ({ ctx, input }): Promise<CatalogueInventoryResult> => {
			ctx.call.deviceId = input.deviceId;
			const policy = cataloguePolicy(ctx);
			rateLimit(ctx, 'catalogue', `${ctx.user.id}:${input.deviceId}`);
			const r = await inventory(ctx.deps.db, ctx.call.audit, ctx.user.id, policy, input);
			ctx.call.opsOut = r.entries.length;
			return r;
		}),
	}),
});

export type AppRouter = typeof appRouter;
