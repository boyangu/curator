// The `CloudService` surface this protocol rides on (design: "Server API"),
// as types only. `apps/cloud` implements it behind tRPC; the desktop's
// `CloudTransport` port and the phone call it. Transport may change, these
// signatures should not — the same rule the desktop applies to `CoreService`.

import type { Op, RejectReason } from './ops.js';
import type { SNAPSHOT_ENCODING } from './snapshot.js';

// An op as the server stored it. `seq` is the per-user total order and the
// pull cursor; `user_id` comes from the JWT, never from the client;
// `received_at` is the audit stamp `client_ts` was clamped against. The
// reducer never reads `seq`: merge outcomes are functions of the op's own
// fields, `seq` only says what a device has and has not seen.
export type StoredOp = Op & {
	seq: number;
	user_id: string;
	received_at: number;
};

export type PushInput = {
	deviceId: string;
	// At most MAX_PUSH_OPS ops / MAX_PUSH_BYTES per call.
	ops: Op[];
};

export type PushResult = {
	// Count of ops now in the log, including re-pushed duplicates (a duplicate
	// `op_id` is accepted and ignored, scenario 10). Everything not listed in
	// `rejected` was accepted, so the outbox marks the rest `acked`.
	accepted: number;
	maxSeq: number;
	rejected: { opId: string; reason: RejectReason }[];
};

export type PullInput = {
	afterSeq: number;
	// At most MAX_PULL_OPS; the server caps it.
	limit?: number;
};

export type PullResult = {
	// Ordered by `seq`; includes the caller's own ops, which it skips by
	// `op_id` (and learns their `seq` from).
	ops: StoredOp[];
	// The seq of the last op returned, or `afterSeq` when the page is empty.
	// Pull again from it until a page comes back empty.
	nextSeq: number;
	// Present when the caller is too far behind to replay (more than 50k ops,
	// or a cursor older than tombstone compaction): bootstrap instead.
	snapshotSeq?: number;
};

export type BootstrapResult = {
	// The reducer's raw `LibraryState` after every op up to `snapshotSeq`,
	// inline: `serializeLibraryState` JSON, gzipped, base64 (snapshot.ts).
	// v1 keeps snapshots in Postgres, so there is no signed URL to fetch; an
	// account with no snapshot yet gets the empty state at seq 0, so the
	// client has one code path. Load it, then pull after `snapshotSeq`.
	snapshot: string;
	snapshotSeq: number;
	encoding: typeof SNAPSHOT_ENCODING;
};

// Why the server refused a whole call (as opposed to one op, which rides in
// `PushResult.rejected`). They arrive in the tRPC error's `data.reason`, so a
// client branches on these strings, never on a message. Whole-call errors are
// the transient ones: keep the outbox rows pending and retry after
// registering, after the server is upgraded, or after `retryAfterSec`; a
// permanent verdict on an op is a rejection.
export const CALL_ERROR_REASONS = [
	'missing_token',
	'token_expired',
	'invalid_token',
	// Push or pull from a device id the account has not registered: register,
	// then retry the same call.
	'device_not_registered',
	'device_revoked',
	'device_not_found',
	// An op stamped with a schema version newer than the server knows. Servers
	// deploy before clients bump SCHEMA_VERSION, so this is a deploy-order
	// slip: retry later rather than reject the op for good.
	'server_outdated',
	'batch_too_large',
	'rate_limited',
	// The client's protocol is below the server's minimum: stop syncing and
	// ask the user to update; local reads keep working.
	'update_required',
] as const;
export type CallErrorReason = (typeof CALL_ERROR_REASONS)[number];

export type DevicePlatform = 'win32' | 'darwin' | 'linux' | 'ios' | 'android';

export type RegisterDeviceInput = {
	deviceId: string;
	name: string;
	platform: DevicePlatform;
};

export type DeviceInfo = {
	deviceId: string;
	name: string;
	platform: DevicePlatform;
	registeredAt: number;
	lastSeenAt: number | null;
	revokedAt: number | null;
};

// ── catalogue (workstream D) ────────────────────────────────────────────────
// The identity + analysis exchange is a separate set of procedures; only the
// signatures the plan names are pinned here. Shapes marked TODO D are open
// until the catalogue schema (recording, recording_claim, recording_analysis,
// file_analysis, recording_vector, model) lands.

export type ClaimKind = 'isrc' | 'audio_hash' | 'fingerprint' | 'spotify' | 'tidal' | 'beatport';

export type CatalogueLookupInput = {
	recordingId?: string;
	audioHash?: string;
};

export type CatalogueLookupResult = {
	// The canonical recording after alias resolution, if the catalogue knows
	// either key.
	recordingId: string | null;
	// Analyses available for that recording / audio hash, keyed by unit so the
	// desktop can set the matching `skip*` options before computing.
	// TODO D: unit list and per-unit provenance (analyzer version, model id).
	available: { unit: string; version: string }[];
};

export type UploadClaimsInput = {
	recordingId: string;
	claims: { kind: ClaimKind; value: string; confidence: number; durationSec?: number }[];
};

export type UploadAnalysisInput = {
	recordingId: string;
	audioHash: string | null;
	// TODO D: scalars per recording (bpm, key, brightness, power, ...), grid /
	// downbeats / segments and the two `.cpk` files per audio hash as R2
	// objects, vectors per model with the licence from `mir_model`; plus
	// provenance (uploader device, analyzer and model versions).
	payload: unknown;
};

export type PullAnalysisInput = {
	recordingId: string;
	audioHash: string | null;
	units: string[];
};

export type PullAnalysisResult = {
	// TODO D: per-unit rows + signed URLs for blob units.
	units: { unit: string; version: string; data: unknown }[];
};

export interface CloudService {
	sync: {
		push(input: PushInput): Promise<PushResult>;
		pull(input: PullInput): Promise<PullResult>;
		bootstrap(): Promise<BootstrapResult>;
	};
	account: {
		registerDevice(input: RegisterDeviceInput): Promise<{ ok: true }>;
		devices(): Promise<DeviceInfo[]>;
		revokeDevice(input: { deviceId: string }): Promise<{ ok: true }>;
	};
	catalogue: {
		lookup(input: CatalogueLookupInput): Promise<CatalogueLookupResult>;
		uploadClaims(input: UploadClaimsInput): Promise<{ ok: true }>;
		uploadAnalysis(input: UploadAnalysisInput): Promise<{ ok: true }>;
		pullAnalysis(input: PullAnalysisInput): Promise<PullAnalysisResult>;
	};
}
