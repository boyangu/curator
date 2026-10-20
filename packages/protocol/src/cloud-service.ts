// The `CloudService` surface this protocol rides on (design: "Server API"),
// as types only. `apps/cloud` implements it behind tRPC; the desktop's
// `CloudTransport` port and the phone call it. Transport may change, these
// signatures should not — the same rule the desktop applies to `CoreService`.

import type {
	CatalogueInventoryInput,
	CatalogueInventoryResult,
	CatalogueLookupInput,
	CatalogueLookupResult,
	CataloguePutInput,
	CataloguePutResult,
} from './catalogue.js';
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

// Optional server behaviours. A client uses one only after the server has
// named it in `features` (on every PushResult and PullResult, and in the
// health probe): the server's inputs are `.strict()`, so an older server
// refuses a field it does not know, and a client that sends it blind would
// stop syncing against it. Additive by construction: a server that omits
// `features` simply has none of them.
//   - 'pull_skip_own': sync.pull takes `deviceId` + `ownThroughSeq` and
//     leaves out the caller's own ops it already holds; PushResult carries
//     `clamped`, `batchMaxSeq` and `priorOwnMaxSeq`.
//   - 'catalogue': the `catalogue.*` procedures exist and are switched on
//     (catalogue.ts). A server lists it only when it is configured with a
//     catalogue policy, so this constant is what a server CAN offer, not
//     what every server does; read `features` from the server.
//   - 'device_reads': reads name the device. sync.pull takes `deviceId`
//     alone (no own-op skip implied) and sync.bootstrap takes
//     `{ deviceId }`; a revoked device is refused on both, as on push and
//     catalogue.*. A client that sees it sends its device id on every read.
//     Revocation does not rest on the client's word: the server also binds
//     each Supabase session to the device it acts as and refuses a session
//     whose device is revoked, named or not (apps/cloud device-gate.ts).
//     Pull and bootstrap without a device id stay accepted while older
//     desktops are in use; a server run with CURATOR_REQUIRE_DEVICE_ID
//     answers them `update_required` instead.
export const SYNC_FEATURES = ['pull_skip_own', 'catalogue', 'device_reads'] as const;
export type SyncFeature = (typeof SYNC_FEATURES)[number];

export type PushResult = {
	// Count of ops now in the log, including re-pushed duplicates (a duplicate
	// `op_id` is accepted and ignored, scenario 10). Everything not listed in
	// `rejected` was accepted, so the outbox marks the rest `acked`.
	accepted: number;
	// The account's head seq after this push (every device's ops).
	maxSeq: number;
	rejected: { opId: string; reason: RejectReason }[];
	// The rest is 'pull_skip_own' and absent from older servers.
	//
	// Accepted ops whose stored `client_ts` differs from the one sent: the
	// server clamped a stamp too far in the future (scenario 9), now or on
	// the push that first stored a re-pushed op. `clientTs` is what the log
	// holds. The device re-stamps its own records to it, which it used to
	// learn only from the op's echo on pull.
	clamped?: { opId: string; clientTs: number }[];
	// The highest seq the log holds for any op this call accepted (new or
	// re-pushed); 0 when none was.
	batchMaxSeq?: number;
	// The highest seq of this device's ops other than this call's; 0 when
	// there are none, absent when the call accepted nothing. Above what the
	// device knows it holds, it means ops stamped with its id that its
	// database lacks (a restored backup, a copied database), so it must not
	// ask pull to skip past them.
	priorOwnMaxSeq?: number;
	features?: SyncFeature[];
};

export type PullInput = {
	afterSeq: number;
	// At most MAX_PULL_OPS; the server caps it.
	limit?: number;
	// The calling device ('device_reads'; with 'pull_skip_own' alone it came
	// only together with `ownThroughSeq`). A revoked device is refused.
	// Optional on the wire while desktops from before 'device_reads' are in
	// use; a client that sees the feature always sends it.
	deviceId?: string;
	// 'pull_skip_own', only with `deviceId`: leave out this device's ops with
	// `seq <= ownThroughSeq`, which the caller vouches it already holds. Its
	// later ops still come (and are skipped by `op_id` as before), so a
	// restored or copied database gets back what it lost. Without it the
	// page is every op after the cursor, own ones included.
	ownThroughSeq?: number;
};

// sync.bootstrap's input ('device_reads'). An older client sends none.
export type BootstrapInput = {
	deviceId?: string;
};

export type PullResult = {
	// Ordered by `seq`. Includes the caller's own ops unless it asked to skip
	// them (above); it skips the rest by `op_id` and learns their `seq`.
	ops: StoredOp[];
	// Where to pull from next: the seq of the last op returned, or `afterSeq`
	// when the page is empty. With the own-op skip it can be further on: past
	// own ops left out of the page, up to the head when the page reached it,
	// so a run of own ops never stalls the cursor. Pull again from it until a
	// page comes back empty, and keep `nextSeq` from that empty page too.
	nextSeq: number;
	// Present when the caller is too far behind to replay (more than 50k ops,
	// or a cursor older than tombstone compaction): bootstrap instead.
	snapshotSeq?: number;
	features?: SyncFeature[];
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
	// The device the call names, or the device its session acts as, was
	// revoked. Final for that device id: stop pushing AND pulling; the way
	// back is a new sign-in under a new device id.
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
	// catalogue.*: this server runs without a catalogue policy (it did not
	// list 'catalogue' in `features`). Stop calling until it does.
	'catalogue_disabled',
	// catalogue.put: the account has no catalogue entitlement (the owner
	// adds it). Lookups still answer; do not upload.
	'catalogue_not_entitled',
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

export interface CloudService {
	sync: {
		push(input: PushInput): Promise<PushResult>;
		pull(input: PullInput): Promise<PullResult>;
		bootstrap(input?: BootstrapInput): Promise<BootstrapResult>;
	};
	account: {
		registerDevice(input: RegisterDeviceInput): Promise<{ ok: true }>;
		devices(): Promise<DeviceInfo[]>;
		revokeDevice(input: { deviceId: string }): Promise<{ ok: true }>;
	};
	catalogue: {
		// 'catalogue' (catalogue.ts). Recording identity claims are not here:
		// they ride the op log.
		lookup(input: CatalogueLookupInput): Promise<CatalogueLookupResult>;
		put(input: CataloguePutInput): Promise<CataloguePutResult>;
		inventory(input: CatalogueInventoryInput): Promise<CatalogueInventoryResult>;
	};
}
