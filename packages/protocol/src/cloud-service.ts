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
import type { SpotifyAdoptInput, SpotifyConnectInput, SpotifyDisconnectInput, SpotifyGrantStatus, SpotifyTokenInput, SpotifyTokenResult } from './spotify-gateway.js';

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
//   - 'track_meta': the server reads protocol v3 — `library_track.set-meta`
//     and the `library.master_device` setting. A desktop emits neither
//     before it sees this: an older server refuses both, and a refused op
//     is never retried.
//   - 'zero_loss_v4': the server reads protocol v4 — every kind, claim kind,
//     rekordbox unit and entity ops.ts stamps 4 (set-attrs, set-cues-edited,
//     cue.upsert2, play_event.append2, playlist / folder set-attrs, the feed
//     decisions, album set-meta, the traxsource / musicbrainz / discogs
//     claims, rb bpm / key_strength). Before it a desktop emits and pushes
//     none of them: a v3 server answers a v4 op `server_outdated` for the
//     whole push.
//   - 'batches': a device may upload a large one-time backlog (the initial
//     push, a backfill) as a per-user virtual transaction instead of plain
//     pushes: sync.batchBegin opens (or resumes) a batch per device and
//     label, sync.batchPush stages ops into it with push's own validation,
//     caps and per-op rejections, and sync.batchCommit moves them into the
//     log under fresh seqs and only then makes them visible, all at once
//     with one wake-up. Staged ops are never seen by a pull or a bootstrap. Normal edits never ride a batch. Without the feature a
//     client pushes everything plainly.
//   - 'snapshot_storage': the snapshot is the account's BASE, published by
//     its master device (section below): the first device folds its library
//     into its own records and publishes them whole; a joining device
//     bootstraps from the newest snapshot, binds its rows to the account's
//     recordings and sends only what it alone holds. The log carries only
//     the changes since a base, and the server deletes what the oldest kept
//     snapshot covers after a week (`baseSeq`: a cursor below it must
//     bootstrap). The server never folds the log and holds no snapshot
//     body: sync.bootstrap takes `storage: true` and answers the manifest of
//     the newest snapshot (or the empty state while an account has none); a
//     client that cannot read Storage is answered `update_required`.
//   - 'analysis_v5': the server reads protocol v5 — `library_track
//     .set-analysis`, the analyzer's results as library data. Before it a
//     desktop emits and pushes none (a v4 server answers a v5 op
//     `server_outdated` for the whole push) and keeps hydrating analysis
//     from the catalogue; with it the catalogue moves only waveform peaks,
//     one track at a time when the player asks.
//   - 'spotify_gateway': the `spotify.*` procedures exist and are switched on
//     (spotify-gateway.ts): the account's Spotify grant lives in the cloud
//     and devices ask it for access tokens. Like 'catalogue', listed only by
//     a server configured for it.
export const SYNC_FEATURES = ['pull_skip_own', 'catalogue', 'device_reads', 'track_meta', 'zero_loss_v4', 'batches', 'snapshot_storage', 'analysis_v5', 'spotify_gateway'] as const;
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

// ── 'batches' ───────────────────────────────────────────────────────────────

// What a batch is for, chosen by the client ('initial-push', 'backfill'):
// one open batch per device and label, so a restart resumes the batch
// instead of opening another. Lower-case ASCII, at most 64 characters.
export const BATCH_LABEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

// open: staging. committing: the commit runs (moving the staged ops into the
// log); still invisible to every reader. committed:
// published. aborted: by its device. expired: idle past the server's limit
// (24 h), its staged ops deleted.
export type BatchStatus = 'open' | 'committing' | 'committed' | 'aborted' | 'expired';

// sync.batchBegin: the device's open (or committing) batch for `label`, or a
// new one. `expectedOps` is the client's estimate, for the server's log only.
export type BatchBeginInput = { deviceId: string; label: string; expectedOps?: number };

export type BatchBeginResult = {
	batchId: string;
	status: 'open' | 'committing';
	// True when the batch existed already (a restart resuming it).
	resumed: boolean;
	// Distinct ops staged in it so far.
	stagedOps: number;
	features?: SyncFeature[];
};

// sync.batchPush: like sync.push (same caps, validation and per-op
// rejections), but the ops are staged, not stored in the log: no seq, no
// wake-up, invisible to every read. Staging the same op id twice is a no-op.
export type BatchPushInput = { deviceId: string; batchId: string; ops: Op[] };

export type BatchPushResult = {
	// Ops now staged (re-staged duplicates included). Everything not in
	// `rejected` is staged.
	accepted: number;
	rejected: { opId: string; reason: RejectReason }[];
	// As PushResult.clamped: staged ops whose stored `client_ts` differs from
	// the one sent (the clamp runs at staging).
	clamped?: { opId: string; clientTs: number }[];
	stagedOps: number;
	features?: SyncFeature[];
};

// sync.batchCommit: starts the commit (idempotent) and reports how far it
// got. The server works on it in the background; the client calls again
// until `committed` (the server's wake-up on publish is the other cue).
// Called on a committed batch it answers the same result again, so a client
// that crashed before recording the answer learns it.
export type BatchCommitInput = { deviceId: string; batchId: string };

export type BatchCommitResult = {
	status: 'committing' | 'committed';
	// Ops moved into the log so far, of the batch's staged total.
	movedOps: number;
	totalOps: number;
	// `committed` only (0 while committing): the highest seq the log holds
	// for any of the batch's ops.
	committedSeq: number;
	// `committed` only: as PushResult.priorOwnMaxSeq, the highest seq of
	// this device's ops outside the batch when the commit began.
	priorOwnMaxSeq?: number;
	// Ops the commit could not store: their op id belongs to another
	// account (`not_owner`). Never retried.
	rejected: { opId: string; reason: RejectReason }[];
	features?: SyncFeature[];
};

// sync.batchAbort: drops an open batch and its staged ops. A committing
// batch cannot be aborted (`batch_committing`); a closed one answers its
// status.
export type BatchAbortInput = { deviceId: string; batchId: string };
export type BatchAbortResult = { status: BatchStatus };

// ── 'snapshot_storage' ──────────────────────────────────────────────────────
// The account's master device publishes the snapshot; the server indexes it
// (2026-10-22 sync review). The master already holds the fold of the log in
// its records (desktop sync_state), so it serialises that, gzips it, and
// uploads it in parts to the private `snapshots` Storage bucket under its
// own `<uid>/` prefix, with its own session, as catalogue blobs go
// (apps/cloud sql/storage.sql). sync.publishSnapshot then names the parts;
// the server checks they exist with the stated sizes under the caller's RLS,
// that the caller is the account's master and that the seq is at or below
// the visible head, and records the manifest. A device that bootstraps with
// `storage: true` gets the manifest and downloads the parts straight from
// Storage. The server's own fold (one 227 MB state in a 512 MB API process)
// remains only as the fallback for an account whose master never published.
// A snapshot is still only a cache of the log.

export const SNAPSHOT_BUCKET = 'snapshots';
// One part's most bytes: well under the bucket's per-object limit, and one
// short request each way.
export const SNAPSHOT_PART_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_SNAPSHOT_PARTS = 64;
// A Storage snapshot is the serialised JSON (snapshot.ts), gzipped, cut into
// parts: their concatenation is the gzip body. No base64 anywhere.
export const SNAPSHOT_STORAGE_ENCODING = 'curator.library-state.v1+json+gzip';

// Parts are content-addressed (sha256 of the part's bytes), so the same
// bytes always land on the same path and an object is never overwritten
// (the bucket has no update policy).
export function snapshotPartPath(userId: string, sha256: string): string {
	return `${userId.toLowerCase()}/snap/${sha256}.cgz`;
}

export type SnapshotPart = { path: string; bytes: number; sha256: string };

export type SnapshotManifest = {
	encoding: typeof SNAPSHOT_STORAGE_ENCODING;
	parts: SnapshotPart[];
	// The gzip body: the sum of the parts' sizes, and the sha256 of their
	// concatenation (a reader checks both before it inflates).
	totalBytes: number;
	sha256: string;
	// sha256 of the serialised JSON itself. gzip output is not canonical
	// across zlib builds; the JSON is (snapshot.ts), so this is what a
	// verifier compares with a server fold at the same seq.
	stateSha256: string;
};

// sync.publishSnapshot: the state after every op up to `snapshotSeq`.
// Whole-call errors: `not_master`, `snapshot_ahead`, `snapshot_part_missing`,
// `snapshot_part_invalid`.
export type PublishSnapshotInput = { deviceId: string; snapshotSeq: number; manifest: SnapshotManifest };

export type PublishSnapshotResult = {
	// stored: indexed. exists: a snapshot at this seq was stored already.
	// stale: a newer snapshot is stored already; nothing was done.
	status: 'stored' | 'exists' | 'stale';
	// The newest snapshot's seq after this call.
	latestSeq: number;
	// Part paths no kept snapshot references any more: the parts of older
	// snapshots this call pruned or, on 'exists' / 'stale', this call's own
	// parts (its manifest was not stored). The publisher deletes them from
	// Storage. A path a kept manifest still lists is never named.
	superseded: string[];
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
// `storage` ('snapshot_storage'): the client can read a Storage snapshot. A
// server that holds no other kind answers a call without it `update_required`.
export type BootstrapInput = {
	deviceId?: string;
	storage?: true;
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
	// Present when the caller cannot replay from its cursor: it is below the
	// account's base (the log no longer holds those ops), more than 50k ops
	// behind, or older than tombstone compaction. Bootstrap instead; the
	// value is the newest snapshot's seq.
	snapshotSeq?: number;
	// 'snapshot_storage': the newest published snapshot, so a device whose
	// cursor is exactly at it can compare its own state digest with the
	// master's (the cross-device check that replaced the server's fold).
	published?: { seq: number; stateSha256: string };
	features?: SyncFeature[];
};

export type BootstrapResult = {
	// The newest snapshot: the reducer's raw `LibraryState` after every op
	// up to `snapshotSeq`, as parts in Storage (snapshot.ts, the section
	// above). Download and join them, load, then pull after `snapshotSeq`.
	// Absent, with `snapshotSeq` 0, for an account that holds none yet: the
	// empty state, which is exactly "pull everything".
	storage?: SnapshotManifest;
	snapshotSeq: number;
	// The account's base: ops at or below it are gone from the log. 0 until
	// the first compaction. A cursor below it must bootstrap, never pull.
	baseSeq: number;
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
	// sync.batchPush / batchCommit: no such open batch for this device (never
	// begun, aborted, or expired after a day idle). Its staged ops are gone:
	// stage them again in a new batch.
	'batch_gone',
	// sync.batchPush / batchAbort: the batch is committing; poll batchCommit.
	'batch_committing',
	// sync.publishSnapshot ('snapshot_storage'): the caller is not the
	// account's master device; only the master publishes.
	'not_master',
	// sync.publishSnapshot: `snapshotSeq` is above the visible head.
	'snapshot_ahead',
	// sync.publishSnapshot: a part is not in the caller's Storage prefix yet
	// (upload it, then publish again), or its size differs from the stated.
	'snapshot_part_missing',
	// sync.publishSnapshot: a part's path is not snapshotPartPath(caller,
	// sha256), or the manifest's sizes do not add up.
	'snapshot_part_invalid',
	// spotify.token ('spotify_gateway'): the account has no Spotify grant in
	// the cloud. Connect (or adopt the device's) first.
	'spotify_not_connected',
	// spotify.token / connect / adopt: Spotify refused the grant (revoked, a
	// scope change, an expired code). Sign in to Spotify again.
	'spotify_reconnect_required',
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
		// 'batches'.
		batchBegin(input: BatchBeginInput): Promise<BatchBeginResult>;
		batchPush(input: BatchPushInput): Promise<BatchPushResult>;
		batchCommit(input: BatchCommitInput): Promise<BatchCommitResult>;
		batchAbort(input: BatchAbortInput): Promise<BatchAbortResult>;
		// 'snapshot_storage'.
		publishSnapshot(input: PublishSnapshotInput): Promise<PublishSnapshotResult>;
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
	// 'spotify_gateway' (spotify-gateway.ts).
	spotify: {
		connect(input: SpotifyConnectInput): Promise<SpotifyGrantStatus>;
		adopt(input: SpotifyAdoptInput): Promise<SpotifyGrantStatus>;
		status(): Promise<SpotifyGrantStatus>;
		token(input: SpotifyTokenInput): Promise<SpotifyTokenResult>;
		disconnect(input: SpotifyDisconnectInput): Promise<SpotifyGrantStatus>;
	};
}
