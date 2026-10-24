// The desktop's cloud sync client (cloud plan C; design: "Server API",
// "Client apply on the desktop"). It moves ops between the local op log and
// the server and nothing else: every merge decision already happened (emit
// side: mutators + emitOps; apply side: applyOps / loadSnapshot), so this
// file is delivery — batching, cursors, retries, scheduling, status.
//
// Delivery rules it keeps:
//   - Push drains `sync_outbox` (state 'pending') oldest first, ≤ 500 ops and
//     ≤ 1 MB per call. Accepted → 'acked' (kept for audit and so applyOps can
//     skip the echo). A per-op rejection → 'rejected' with the reason, shown
//     in Settings, never retried blindly. `update_required` leaves the op
//     pending and stops the loop: after an update it may well be accepted.
//   - Network / 5xx / rate-limit errors keep everything pending and back off
//     exponentially with jitter, capped at 60 s.
//   - Pull reads pages after `sync_cursor.last_seq` and applies each in
//     sub-batches sized to PULL_SLICE_MS, a transaction each with a yield
//     to the event loop between (core runs on the desktop's main loop);
//     only the page's last transaction advances the cursor. A crash mid-page keeps
//     the sub-batches already committed and the cursor before the page,
//     which is then simply pulled again: apply is idempotent, so re-applying
//     a committed sub-batch changes nothing, and a sub-batch boundary is no
//     different from the page boundaries the server draws anywhere in the
//     log. The page is validated whole before its first sub-batch, so an
//     unreadable op applies none of it.
//     A `snapshotSeq` hint means "too far behind" or "below the account's
//     base": bootstrap from the master's snapshot instead.
//   - Own ops: a server with 'pull_skip_own' leaves out this device's ops up
//     to `ownThroughSeq`, the seq through which this database provably holds
//     every op stamped with its device id (see ClientState). Anything else of
//     its own still comes back and applyOps skips it by op_id — the only path
//     against an older server. A clamped stamp is learnt from the push result
//     (or, from an older server, from the echo) and repaired the same way.
//   - An op from a newer protocol version is held aside (held.ts,
//     `sync_inbox_held`): everything else applies, the cursor moves on, and
//     `needsUpdate` reports it; the held ops replay once a build that reads
//     them pulls.
//   - A streaming read-sync waits for the first pull (FIRST_PULL_KEY): a
//     device that has not seen the account's claims yet would mint a fresh
//     recording for every track another desktop already holds (the
//     2026-10-20 incident).
//   - The account's BASE is a snapshot the master publishes, not a fold of
//     the log (the 2026-10-22 sync review; 'snapshot_storage'). A device
//     that has not stated its library yet (apply.ts INITIAL_PUSH_KEY) first
//     asks for the base (establishBase): with a snapshot it is a JOINER — it
//     loads the snapshot, binds its rows to the account's recordings
//     (join-bind.ts) and sends only what it alone holds (initial-push.ts
//     joinPushAsync); on an account with no snapshot and no ops it is the
//     FOUNDER — it folds its library into its own records without sending
//     an op (foldLibraryAsync), states itself master, and the publish stage
//     puts the base up; on an account with ops but no snapshot (a founder
//     still publishing, a legacy account whose master has not published
//     yet) it WAITS, asking again each cycle (status `phase`). A server
//     without 'snapshot_storage' has no base to give: the library goes up
//     as ops, as it did before.
//   - A secondary whose cursor sits exactly at the master's newest published
//     snapshot checks its records' digest against the manifest's
//     (snapshot-build.ts digest mode) and reloads the snapshot on a
//     mismatch — the cross-device check that replaced the server's fold.
//   - Acked outbox rows are deleted after a week (outbox.ts retention),
//     after a cycle that left nothing pending.
//   - A library is bound to the first account that syncs it. Signing in as
//     someone else does not merge two people's libraries; it reports an error.
//   - A one-time backlog (the initial push, a backfill: outbox rows with a
//     `batch_label`) goes up as a server batch when the server offers
//     'batches' and the backlog is worth one (BATCH_MIN_OPS, or a batch is
//     already open for it): staged with batchPush, then committed, so the
//     server publishes it in one piece with a fresh snapshot instead of
//     ~230 plain pushes every other device replays. Edits never ride a
//     batch: they keep going out as plain pushes beside it. The open batch
//     is recorded per label (ClientState.batches) and resumed after a
//     restart; a batch the server dropped (expired after a day idle) is
//     staged again under a new one. Without the feature everything is
//     pushed plainly, labels or not.
//   - Reads name the device when the server offers 'device_reads'. A
//     `device_revoked` answer on anything (push, pull, bootstrap,
//     registration) is final for this device id: the client records it and
//     stops pushing AND pulling — no further calls — until `unlink` detaches
//     the install (a fresh device id, signed out; local data untouched).
//
// The transport is a port: the desktop main injects an HTTP/tRPC transport
// holding the Supabase session; tests inject an in-memory fake server.

import type Database from 'better-sqlite3';
import { readFile, rm } from 'node:fs/promises';
import {
	MAX_PULL_OPS,
	MAX_PUSH_BYTES,
	MAX_PUSH_OPS,
	OpValidationError,
	parseOp,
	schemaVersionStatus,
	MASTER_DEVICE_SETTING,
	utf8ByteLength,
	type CloudService,
	type DevicePlatform,
	type EntityRef,
	type Op,
	type BatchCommitResult,
	type BootstrapInput,
	type PublishSnapshotResult,
	type PullInput,
	type PullResult,
	type RejectReason,
	type StoredOp,
	type SyncFeature,
} from '@curator/protocol';
import type { AreaLogger } from '@curator/shared/log';
import { log } from '../log.js';
import { artistCreditRewritePending, drainArtistCreditRewritesAsync } from '../library/artist-alias.js';
import { applyOps, initialPushDone as libraryStated, recordsComplete, SyncRecordsIncompleteError, type ApplyOutcome } from './apply.js';
import { getDeviceId } from './device.js';
import { heldCount, heldNewerCount, holdOps, replayHeldOps } from './held.js';
import { claimsBackfillAsync, claimsBackfillPending, foldLibraryAsync, joinPushAsync, rbBackfillAsync, rbBackfillPending, type InitialPushAsyncResult, type InitialPushProgress } from './initial-push.js';
import { joinBindAsync, joinBindDone } from './join-bind.js';
import { resolveRecordingIdentitiesAsync } from './identity.js';
import { BATCH_LABELS, CLOCK_KEY, observeServerTs, onOutboxAppend, OUTBOX_RETENTION_MS, pruneAckedOutbox, type BatchLabel } from './outbox.js';
import { healAfterApply, streamingDedupeSwept, type DedupeResult, sweepStreamingDuplicatesAsync } from './playlist-dedupe.js';
import { normalizePollPolicy, samePollPolicy, type SyncPollPolicy } from './poll-policy.js';
import { remintDeviceForDetach } from './remint.js';
import { derivePendingCount, drainTrackDerivationsAsync, materializeSwept, remotePendingCount } from './remote-rows.js';
import { drainRemotePendingAsync, sweepRemoteRowsAsync } from './remote-sweep.js';
import { claimLinkPendingCount, claimLinksSwept, drainClaimLinksAsync, sweepClaimLinksAsync } from './claim-links.js';
import { loadSnapshot, type SnapshotRecord } from './snapshot.js';
import type { SnapshotBuilder, SnapshotBuildOk } from './snapshot-build.js';
import type { SnapshotBlobStore } from './snapshot-storage.js';
import { healPlayHistoryAsync, playHealPending } from './play-heal.js';
import { reconcileProviderClaimsAsync } from './claim-reconcile.js';
import { ANALYSIS_FEATURE, featuresReadV4, featuresReadV5, pushableSchemaVersion, recordServerV4 } from './features.js';
import { FIRST_PULL_KEY, firstPullDone, sourceRole } from './role.js';
import { drainTrackAttrsAsync, queueTrackAttrsBackfillAsync, trackAttrsBackfillPending, trackAttrsDirtyCount } from './track-attrs.js';
import { drainTrackAnalysisAsync, queueTrackAnalysisBackfillAsync, trackAnalysisBackfillPending, trackAnalysisDirtyCount } from './track-analysis.js';
import { drainPlaylistAttrsAsync, playlistAttrsBackfillPending, playlistAttrsDirtyCount, queuePlaylistAttrsBackfill } from './playlist-attrs.js';
import { backfillCueOriginsAsync, backfillPlayRefsAsync, backfillRbUnitsV4Async, v4BackfillsPending } from './v4-backfill.js';
import { albumMetaBackfillAsync, albumMetaBackfillPending } from './album-meta.js';
import {
	defaultMasterDevice, drainTrackMetaAsync, masterDevice, queueTrackMetaBackfillAsync, serverReadsTrackMeta, setMasterDevice, trackMetaBackfillPending, trackMetaDirtyCount,
} from './track-meta.js';

type Raw = Database.Database;

// ── port ────────────────────────────────────────────────────────────────────

export type CloudSession = { userId: string; email: string | null };

// The protocol's `sync` + `account` procedures and who is signed in (the
// session lives with the transport, in desktop main). `sync.bootstrap` is
// lifted out and returned decoded: the transport reads the master-published
// snapshot out of Storage and inflates it (node:zlib, off the JS thread) —
// the client only needs the records, their seq and the account's base.
export interface CloudTransport {
	// The batch procedures ('batches') are optional: a transport without them
	// pushes everything plainly, whatever the server offers. Likewise
	// publishSnapshot ('snapshot_storage'), which also needs `snapshots`.
	sync: Pick<CloudService['sync'], 'push' | 'pull'> & Partial<Pick<CloudService['sync'], 'batchBegin' | 'batchPush' | 'batchCommit' | 'batchAbort' | 'publishSnapshot'>>;
	account: CloudService['account'];
	// `records` null: the account holds no snapshot yet (`snapshotSeq` 0).
	bootstrap(input?: BootstrapInput): Promise<{ snapshotSeq: number; baseSeq: number; records: readonly SnapshotRecord[] | null }>;
	session(): CloudSession | null;
	// Ends this install's session (Supabase scope 'local'; other devices stay
	// signed in). `unlink` calls it so the detached library cannot re-bind on
	// the next wake-up.
	signOut(): Promise<void>;
	// The shared analysis catalogue's procedures (apps/core/src/catalogue/).
	// Optional: without them (or without a blob store beside them) the
	// catalogue layer is simply not built.
	catalogue?: CloudService['catalogue'];
	// The `snapshots` Storage bucket under this user's session
	// ('snapshot_storage'). With it, `bootstrap` can read a master-published
	// snapshot (the client then asks with `storage: true`; joining and
	// checking the parts is the transport's, snapshot-storage.ts), and the
	// master uploads its own snapshots into it. Without it neither happens.
	snapshots?: SnapshotBlobStore;
}

// How a transport reports a failed call. Anything else thrown is treated as
// a network failure (transient).
export type CloudErrorKind =
	| 'network' // offline, DNS, timeout, connection reset
	| 'server' // 5xx
	| 'rate_limited' // 429 / retry_after
	| 'auth' // 401: no session, or the token was refused
	| 'update_required' // the server refuses this client's schema version
	| 'device_revoked' // this device was revoked from the account
	| 'device_not_registered' // the server lost (or never had) this device's registration
	| 'batch_gone' // the batch named is no longer open (expired, aborted): stage again
	| 'batch_committing' // the batch is committing: poll its commit
	// sync.publishSnapshot's refusals ('snapshot_storage'; protocol
	// CALL_ERROR_REASONS): not the account's master; a seq above the visible
	// head; a part not (yet) in Storage at its size; a manifest that does not
	// add up.
	| 'not_master'
	| 'snapshot_ahead'
	| 'snapshot_part_missing'
	| 'snapshot_part_invalid'
	| 'bad_request'; // any other 4xx: a client bug, not worth hammering

export class CloudTransportError extends Error {
	override readonly name = 'CloudTransportError';
	constructor(readonly kind: CloudErrorKind, message: string, readonly retryAfterMs?: number) {
		super(message);
	}
}

// ── status ──────────────────────────────────────────────────────────────────

export type CloudSyncStatus = {
	signedIn: boolean;
	userId: string | null;
	email: string | null;
	deviceId: string;
	pending: number;
	rejected: number;
	lastPushAt: number | null;
	lastPullAt: number | null;
	// When the device last completed a check with the server (a pull, empty
	// or not), and when a change last actually moved either way. The UI shows
	// "last checked", and says "Syncing…" only while `transferring`: a check
	// that moves nothing is not syncing, and every-minute polling must not
	// make the label flicker.
	lastCheckedAt: number | null;
	lastChangedAt: number | null;
	transferring: boolean;
	lastSeq: number;
	lastError: string | null;
	needsUpdate: boolean;
	// This device was revoked from the account: nothing is pushed or pulled
	// until it is unlinked (signed out under a fresh device id).
	revoked: boolean;
	// The account this library's sync history belongs to (null until the
	// first sign-in syncs it). Unlink keeps it: see `unlink`.
	boundUserId: string | null;
	initialPushDone: boolean;
	// Set while the first sign-in states the library: the founder's fold or
	// a joiner's bind sweep and push (initial-push.ts).
	initialPush: InitialPushProgress | null;
	// 'waiting_for_snapshot': this library has not stated itself and the
	// account has ops but no published snapshot to join from (the header);
	// the client asks again each cycle.
	phase: 'waiting_for_snapshot' | null;
	// Set while a snapshot is being loaded.
	bootstrap: { done: number; total: number } | null;
	// Set while a backlog goes up as a server batch ('batches'): staging
	// (`done` of `total` ops staged) or committing (`done` of `total` moved
	// into the server's log; nothing of it is visible elsewhere until done).
	batch: { label: string; phase: 'uploading' | 'committing'; done: number; total: number } | null;
	running: boolean;
	// The account snapshot this device published as its master
	// ('snapshot_storage'): whether a build or upload runs now, and the seq
	// and time of the last one the server took. `verifying` / `digest`: a
	// secondary's check of its records against the master's newest snapshot
	// (the header), running now, and the last one's result.
	snapshot: {
		publishing: boolean;
		lastSeq: number | null;
		lastAt: number | null;
		verifying: boolean;
		digest: { seq: number; at: number; matched: boolean } | null;
	};
	// When the next retry fires after a transient failure.
	nextRetryAt: number | null;
	// The fallback poll: the cadence in force, whether the host reports the
	// app in use, whether the Realtime wake channel is joined (the idle
	// cadence applies only when both say so), and when it next fires.
	poll: { policy: SyncPollPolicy; active: boolean; realtimeLive: boolean; nextPollAt: number | null };
};

export type CloudSyncApplied = {
	// Local track ids whose visible rows changed, and playlists whose
	// membership changed — what the renderer refreshes.
	tracks: string[];
	playlists: string[];
	// The entities that changed (capped; containers drive sidebar refreshes).
	entities: EntityRef[];
};

// 'reconnected': the first cycle that went through after a 'network' wake
// (the host saw the device come back online). Whatever the player is
// showing may have been asked of the account while it could not answer.
export type CloudSyncEvent =
	| { kind: 'status'; status: CloudSyncStatus }
	| { kind: 'applied'; applied: CloudSyncApplied }
	| { kind: 'reconnected'; at: number };

// 'resume': the host reported the app back in use after an idle spell.
// 'rejoin': the Realtime wake channel came back; pings sent while it was
// down were lost.
export type WakeReason = 'realtime' | 'focus' | 'network' | 'session' | 'local' | 'interval' | 'resume' | 'rejoin' | 'manual';
// What a cycle's summary line names as its cause: the wake reasons it
// coalesced, or the backoff timer.
type CycleReason = WakeReason | 'retry';

// ── options ─────────────────────────────────────────────────────────────────

export type SyncClientOptions = {
	db: Raw;
	transport: CloudTransport;
	logger?: AreaLogger;
	// What `account.registerDevice` sends on first sign-in.
	device?: { name: string; platform: DevicePlatform };
	// After a pull or bootstrap changed local rows (the service recomputes
	// the membership tier for them).
	onApplied?: (applied: CloudSyncApplied) => void;
	// The fallback poll cadence to start with (normalised; defaults
	// otherwise). setPollPolicy changes it later.
	pollPolicy?: Partial<SyncPollPolicy>;
	// Scheduling knobs (tests shorten them).
	debounceMs?: number;
	backoffBaseMs?: number;
	backoffCapMs?: number;
	initialPushChunk?: number;
	// 'batches' (tests shrink them): the labelled backlog that is worth a
	// batch, and how often / how many times a cycle asks after a running
	// commit before leaving it to the next cycle.
	batchMinOps?: number;
	batchCommitPollMs?: number;
	batchCommitPolls?: number;
	// Ops per apply transaction within a pulled page, fixed (PULL_SLICE_MS).
	pullApplyChunk?: number;
	// How long an acked outbox row is kept (outbox.ts OUTBOX_RETENTION_MS;
	// tests shrink it).
	outboxRetentionMs?: number;
	random?: () => number;
	// Test seam: runs inside a pull page's last transaction (the one that
	// moves the cursor) after its apply, with the whole page — throwing here
	// is a crash mid-page.
	beforeCursorAdvance?: (page: StoredOp[]) => void;
	// The Discover feed's decisions live in feed.db, another database
	// (feed/sync.ts): the client drives their two v4 steps through these.
	feed?: SyncFeedHooks;
	// The master's snapshot publish ('snapshot_storage'). Without it this
	// device never publishes.
	snapshot?: SnapshotPublishOptions;
};

export type SnapshotPublishOptions = {
	// Builds the snapshot off this thread (the desktop: a utility process;
	// tests and the CLI: inline, snapshot-build.ts).
	builder: SnapshotBuilder;
	// When a publish is due after the last one: this many ops past its seq,
	// or this long since it while the head moved. Tests shrink them.
	everyOps?: number;
	everyMs?: number;
	// How long a failed publish (network, Storage, a refusal worth retrying)
	// waits before the next attempt.
	retryMs?: number;
};

export type SyncFeedHooks = {
	// Decisions pulled for feed.db, queued by the projection.
	pending(): number;
	applyPending(): Promise<{ keys: number; changed: number }>;
	// The one-time statement of feed.db's decisions once the server reads v4
	// — or, for the founder fold, into the records alone (`local`).
	backfillPending(): boolean;
	backfill(opts?: { local?: boolean }): Promise<{ emitted: number }>;
};

export type PushOutcome = { pushed: number; rejected: number; more: boolean; stopped: 'update_required' | 'device_revoked' | null };
// What `unlink` did. `revokedOnServer` is false when the device was already
// revoked, never registered, or the server could not be reached (then it
// stays listed until another computer revokes it).
export type UnlinkOutcome = { revokedOnServer: boolean; signedOut: boolean; oldDeviceId: string | null; newDeviceId: string; restamped: number };
// `received`: ops the server sent; `applied`: how many changed local state
// (own echoes and already-seen ops are skipped).
// `held`: ops from a newer protocol version set aside this pull (held.ts).
// `maxSliceMs`: the longest apply transaction (one sub-batch), the
// longest this pull held the event loop.
export type PullOutcome = { applied: number; received: number; pages: number; bootstrapped: boolean; held: number; stopped: 'unreadable' | null; maxSliceMs: number };

// One cycle's totals for its summary log line: counts only, never an op.
type CycleTally = { pushed: number; rejected: number; held: number; pulled: number; applied: number; bootstrapped: boolean; snapshotRecords: number };

export interface SyncClient {
	pushOnce(): Promise<PushOutcome>;
	pullOnce(): Promise<PullOutcome>;
	// Loads the master's newest snapshot; false when the account holds none.
	bootstrap(opts?: { resetCursor?: boolean }): Promise<boolean>;
	// States this library to the account (the header: found, join, or go up
	// as ops to a server without a base) when it has not been, then the
	// one-time backfills still owed. The cycle runs it first.
	runInitialPush(): Promise<void>;
	// One full cycle now: register, state the library, push until drained,
	// pull until drained. Resets any backoff. Resolves when the cycle is done.
	syncNow(): Promise<void>;
	// Debounced cycle trigger for wake-ups (Realtime, focus, network, local
	// writes, the fallback poll). `seq`: the head a Realtime ping names
	// (`{seq}` of the server's broadcast); a ping at or below the pull cursor
	// is already here and wakes nothing. Absent (an older server) always wakes.
	wake(reason?: WakeReason, seq?: number): void;
	// The fallback poll's cadence. Applies at once: the next poll is due one
	// (new) interval after the previous one, or now if that has passed.
	setPollPolicy(policy: Partial<SyncPollPolicy>): void;
	// The host's verdict on whether the app is in use. Idle → in use syncs
	// once right away ('resume') and returns to the active cadence.
	setActive(active: boolean): void;
	// Whether the Realtime wake channel is joined (false until the host says
	// so). While it is not, nothing rings this device when another one
	// pushes, so the poll keeps the active cadence even when idle. Down →
	// live syncs once ('rejoin').
	setRealtimeLive(live: boolean): void;
	start(): void;
	stop(): void;
	status(): CloudSyncStatus;
	// The server's optional features as last answered on a push or pull
	// (null until the first answer this session, and while revoked). The
	// catalogue layer reads 'catalogue' here rather than probing the server
	// itself, so a revoked device's catalogue goes quiet with its sync.
	serverFeatures(): readonly SyncFeature[] | null;
	// This install's device id now (`unlink` replaces it).
	deviceId(): string;
	// Detach this install from the account, keeping every local row and
	// every outbox op: waits out a running cycle, revokes this device on the
	// account (best effort; skipped when already revoked), signs this install
	// out, and gives it a fresh device id (remint.ts: pending ops re-stamped
	// to it, registration and the own-op bound reset). The account binding
	// (`boundUserId`) and the pull cursor stay: this library's sync history
	// is that account's, so signing in with it again resumes as a new device
	// that uploads what it never pushed, and signing in with another account
	// is refused as before rather than mixing two accounts' libraries.
	unlink(): Promise<UnlinkOutcome>;
	subscribe(cb: (e: CloudSyncEvent) => void): () => void;
}

// ── persisted client state (device-local app_setting keys) ──────────────────

const CURSOR_KEY = 'library';

export { FIRST_PULL_KEY, firstPullDone };

function markFirstPull(raw: Raw): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`)
		.run(FIRST_PULL_KEY, JSON.stringify(Date.now()), Date.now());
}

// Exported for migrate.ts, which must know whether this library was ever
// bound to an account before it rewrites the outbox.
export const CLIENT_STATE_KEY = 'sync.client';

type ClientState = {
	// The account this library is bound to (first sign-in that synced it).
	userId: string | null;
	// The account the device id was registered with.
	registeredFor: string | null;
	lastPushAt: number | null;
	lastPullAt: number | null;
	lastChangedAt?: number | null;
	// Set when an own op was re-stamped by the server's clock clamp (named
	// in a push result, or seen in its echo from an older server): remote
	// writes applied before it may have lost locally to the unclamped stamp,
	// and an LWW cell keeps only its winner, so the next pull reloads the
	// snapshot and replays from its seq.
	needsRepair?: boolean;
	// Set when the server answered `device_revoked` for this device id. Tied
	// to the id: a re-mint (unlink, a restore) leaves a stale mark behind,
	// which then means nothing.
	revoked?: { deviceId: string; at: number } | null;
	// Every op stamped with this device id at or below this seq is held here
	// (in the outbox, or applied from a pull). What the pull asks the server
	// to leave out. Kept in this database, so a restored backup rewinds it
	// with the outbox it describes. It moves:
	//   - to a drained pull's cursor: everything up to it has been seen;
	//   - to a push's `batchMaxSeq`, but only when the server's
	//     `priorOwnMaxSeq` is not above it — otherwise ops with this id exist
	//     that this database never pushed (a restored or copied database),
	//     and they must come back on the pull.
	ownThroughSeq?: number;
	// 'batches': the server batch open (or committing) per label, so a
	// restart resumes it. `committing` once batchCommit was asked: from then
	// on the batch is only ever polled, never staged into.
	batches?: Partial<Record<BatchLabel, { batchId: string; committing: boolean }>>;
	// The account's base as the last bootstrap answered it: ops at or below
	// it are gone from the log, so a cursor below it bootstraps, never pulls.
	baseSeq?: number;
};

function readClientState(raw: Raw): ClientState {
	const blank: ClientState = { userId: null, registeredFor: null, lastPushAt: null, lastPullAt: null, needsRepair: false, ownThroughSeq: 0 };
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(CLIENT_STATE_KEY) as { value: string } | undefined;
	if (!row) return blank;
	try { return { ...blank, ...(JSON.parse(row.value) as Partial<ClientState>) }; } catch { return blank; }
}

function writeClientState(raw: Raw, s: ClientState): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(CLIENT_STATE_KEY, JSON.stringify(s), Date.now());
}

export function readCursor(raw: Raw): { lastSeq: number; snapshotSeq: number | null } {
	const row = raw.prepare(`SELECT last_seq, snapshot_seq FROM sync_cursor WHERE key = ?`).get(CURSOR_KEY) as { last_seq: number; snapshot_seq: number | null } | undefined;
	return { lastSeq: row?.last_seq ?? 0, snapshotSeq: row?.snapshot_seq ?? null };
}

function writeCursor(raw: Raw, lastSeq: number, snapshotSeq?: number): void {
	raw.prepare(`INSERT INTO sync_cursor (key, last_seq, snapshot_seq) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET last_seq = excluded.last_seq, snapshot_seq = COALESCE(excluded.snapshot_seq, sync_cursor.snapshot_seq)`)
		.run(CURSOR_KEY, lastSeq, snapshotSeq ?? null);
}

type OutboxRow = { op_id: string; device_id: string; client_ts: number; schema_version: number; entity: string; entity_id: string; kind: string; payload: string };

// The stored op minus the server's fields: what applyOps parses (the op
// schemas are strict about their envelope).
function wireOp(o: StoredOp): Op {
	const { seq: _seq, user_id: _user, received_at: _recv, ...op } = o;
	return op as Op;
}

// How many ops one apply transaction of a pulled page takes (see the
// header). A whole 1,000-op page in one transaction held the main loop up
// to 692 ms in the 2026-10-20 dry run on the live library. Ops differ ~15×
// in cost (a claim ~0.07 ms, a set-meta that makes a remote row ~1.1 ms on
// the live profile copy) and each transaction pays a fixed part on top (the
// commit of a few dozen dirtied index pages, a big playlist's position
// restamp: ~40-100 ms measured 2026-10-20), so the size follows the time:
// each transaction's next size aims at PULL_SLICE_MS from the last one's
// per-op cost, growing at most 2× a step (a run of cheap ops must not
// leave a size that a run of expensive ones then overruns by much) and kept
// within PULL_APPLY_MIN..PULL_APPLY_MAX — the floor so that a fixed cost
// above the target does not shrink the batches to nothing and multiply the
// commits (a 60 ms target sat on a floor of 25 there and took 3× as long
// as 100-op batches). Measured 2026-10-20 on the generated 40k library
// (sync-slices-perf.test.ts: 23,500 ops of two devices' imports and merges,
// 24 pages): one transaction per page ran 148 ms on average, worst 289 ms;
// these sizes ran 157 transactions, median 64 ms, p90 103 ms, worst 113 ms.
const PULL_SLICE_MS = 100;
const PULL_APPLY_START = 100;
const PULL_APPLY_MIN = 50;
const PULL_APPLY_MAX = 200;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const ENTITY_CAP = 2_000;

// A labelled backlog at least this large goes up as a server batch
// ('batches'); a smaller one is not worth the commit's snapshot rebuild and
// pushes plainly. Drains (track meta / attributes) label their ops for a
// batch from the same size on: a backfill's queue, never a few edits.
export const BATCH_MIN_OPS = 2_000;

// ── the master's snapshot ('snapshot_storage') ──────────────────────────────
// The master publishes the account's snapshot from its own records
// (snapshot-build.ts) when one is due: never yet, or SNAPSHOT_EVERY_OPS past
// the last, or SNAPSHOT_EVERY_MS since it while the head moved. A new device
// replays at most that many ops after loading it; the server's own fold
// stays only as the fallback for an account whose master never published.
export const SNAPSHOT_EVERY_OPS = 10_000;
export const SNAPSHOT_EVERY_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_RETRY_MS = 10 * 60 * 1000;
const SNAPSHOT_UPLOAD_CONCURRENCY = 2;

// Device-local (app_setting): the last publish the server took (`seq`, `at`),
// the master cell a `not_master` refusal came under (no publish until that
// cell changes), and superseded objects whose delete failed (retried with
// the next publish's).
export const SNAPSHOT_PUBLISH_KEY = 'sync.snapshot_publish';
type PublishRecord = { seq: number; at: number; refusedMaster?: string | null; orphans?: string[] };

function readPublishRecord(raw: Raw): PublishRecord | null {
	const json = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(SNAPSHOT_PUBLISH_KEY) as string | undefined;
	if (!json) return null;
	try { return JSON.parse(json) as PublishRecord; } catch { return null; }
}

function writePublishRecord(raw: Raw, rec: PublishRecord): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(SNAPSHOT_PUBLISH_KEY, JSON.stringify(rec), Date.now());
}

// Device-local: a publish asked for ahead of the cadence — the master's
// one-time analysis backfill (v5), whose statements belong in the base
// rather than in a log every later device replays. `owed` while the
// backfill still drains (nothing to publish yet), then `at` (when it was
// stated): the next publish whose build started after that clears it.
export const SNAPSHOT_PUBLISH_REQUEST_KEY = 'sync.snapshot_publish_requested';
type PublishRequest = { owed: true } | { at: number };

function readPublishRequest(raw: Raw): PublishRequest | null {
	const json = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(SNAPSHOT_PUBLISH_REQUEST_KEY) as string | undefined;
	if (!json) return null;
	try { return JSON.parse(json) as PublishRequest; } catch { return null; }
}

function writePublishRequest(raw: Raw, req: PublishRequest | null): void {
	if (req === null) { raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(SNAPSHOT_PUBLISH_REQUEST_KEY); return; }
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(SNAPSHOT_PUBLISH_REQUEST_KEY, JSON.stringify(req), Date.now());
}

// Device-local: the last digest check a secondary ran against the master's
// snapshot (the header), so one seq is checked once.
export const SNAPSHOT_DIGEST_KEY = 'sync.digest_checked';
type DigestRecord = { seq: number; at: number; matched: boolean };

function readDigestRecord(raw: Raw): DigestRecord | null {
	const json = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(SNAPSHOT_DIGEST_KEY) as string | undefined;
	if (!json) return null;
	try { return JSON.parse(json) as DigestRecord; } catch { return null; }
}

function writeDigestRecord(raw: Raw, rec: DigestRecord): void {
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(SNAPSHOT_DIGEST_KEY, JSON.stringify(rec), Date.now());
}

// ── client ──────────────────────────────────────────────────────────────────

export function createSyncClient(opts: SyncClientOptions): SyncClient {
	const raw = opts.db;
	const transport = opts.transport;
	const slog = opts.logger ?? log.for('cloud-sync');
	const debounceMs = opts.debounceMs ?? 250;
	const backoffBase = opts.backoffBaseMs ?? 1_000;
	const backoffCap = opts.backoffCapMs ?? 60_000;
	const random = opts.random ?? Math.random;
	// Replaced by unlink (a fresh identity); everything reads it per call.
	let deviceId = getDeviceId(raw);

	const listeners = new Set<(e: CloudSyncEvent) => void>();
	let lastError: string | null = null;
	// The server refused this client's schema version on push (ops stay
	// pending). Reads "update required", as do held newer-version ops
	// (heldCount, read per status).
	let pushRefused = false;
	let initialPushProgress: InitialPushProgress | null = null;
	let bootstrapProgress: { done: number; total: number } | null = null;
	// The header's waiting state, and whether it was logged this session.
	let waitingForSnapshot = false;
	let waitingLogged = false;
	let batchProgress: CloudSyncStatus['batch'] = null;
	let running = false;
	// True only while changes are actually moving in this cycle (a push with
	// ops, or a pull page that brought some); a quiet check never sets it.
	let moving = false;
	const markMoving = (): void => { if (!moving) { moving = true; emitStatus(); } };
	let again = false;
	let stopped = true;
	let attempt = 0;
	let nextRetryAt: number | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	// The fallback poll is a self-rescheduling timeout, not an interval, so a
	// cadence change takes effect without waiting out the old period.
	let pollPolicy = normalizePollPolicy(opts.pollPolicy);
	let active = true;
	let realtimeLive = false;
	// A 'network' wake whose cycle has not gone through yet: the next one
	// that does announces the reconnect ('reconnected').
	let reconnectOwed = false;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	// When the current poll period started counting (start, last poll, or a
	// return to use).
	let pollBase = 0;
	let nextPollAt: number | null = null;
	// Why the next cycle runs; taken (and cleared) when a cycle starts.
	const reasons = new Set<CycleReason>();
	// The Realtime pings among those reasons: the highest seq they named, and
	// whether one named none. A ping is this device's own push echoing back
	// (the server rings every device of the user, the pusher too) or a change
	// the cycle under way already pulled; see stalePingsOnly.
	let pingTop = 0;
	let pingUnnumbered = false;
	let unsubOutbox: (() => void) | null = null;
	let inflight: Promise<void> | null = null;
	let lastStatusEmit = 0;
	// Set while runOnce() runs; push/pull/bootstrap add to it.
	let tally: CycleTally | null = null;
	// Whether the server last said it offers the own-op skip. Learnt from
	// every push and pull result rather than kept: an older (or rolled back)
	// server refuses the extra pull fields, and one that omits `features`
	// simply has none. Until the first answer, pulls go without it.
	let serverSkipsOwn = false;
	// Likewise 'device_reads': pulls and bootstraps name this device.
	let serverDeviceReads = false;
	let features: SyncFeature[] | null = null;
	const learnFeatures = (f: readonly SyncFeature[] | undefined): void => {
		serverSkipsOwn = f?.includes('pull_skip_own') ?? false;
		serverDeviceReads = f?.includes('device_reads') ?? false;
		features = [...(f ?? [])];
		// The inline writers' copy (features.ts): they decide v4 vs v3 shapes
		// from it, outside this client.
		if (recordServerV4(raw, featuresReadV4(features))) slog.info('server protocol v4 support changed', { readsV4: featuresReadV4(features) });
	};
	const forgetFeatures = (): void => {
		serverSkipsOwn = false;
		serverDeviceReads = false;
		features = null;
	};

	// Set while unlink runs: no cycle may start (it would register the old
	// id again, or the new one under the session being ended).
	let detaching = false;

	const counts = raw.prepare(`SELECT state, count(*) AS n FROM sync_outbox WHERE state IN ('pending', 'rejected') GROUP BY state`);

	const REVOKED_MESSAGE = 'This computer was removed from your Curator account. Sign out to stop using that account here; your library stays on this computer.';
	const isRevoked = (st: ClientState = readClientState(raw)): boolean => st.revoked?.deviceId === deviceId;

	const status = (): CloudSyncStatus => {
		const session = transport.session();
		const c = { pending: 0, rejected: 0 };
		for (const r of counts.all() as Array<{ state: 'pending' | 'rejected'; n: number }>) c[r.state] = r.n;
		const st = readClientState(raw);
		return {
			signedIn: session !== null,
			userId: session?.userId ?? null,
			email: session?.email ?? null,
			deviceId,
			pending: c.pending,
			rejected: c.rejected,
			lastPushAt: st.lastPushAt,
			lastPullAt: st.lastPullAt,
			lastCheckedAt: st.lastPullAt,
			lastChangedAt: st.lastChangedAt ?? null,
			transferring: moving,
			lastSeq: readCursor(raw).lastSeq,
			lastError,
			needsUpdate: pushRefused || heldNewerCount(raw) > 0,
			revoked: isRevoked(st),
			boundUserId: st.userId,
			initialPushDone: libraryStated(raw),
			initialPush: initialPushProgress,
			phase: waitingForSnapshot ? 'waiting_for_snapshot' : null,
			bootstrap: bootstrapProgress,
			batch: batchProgress,
			running,
			snapshot: (() => {
				const rec = readPublishRecord(raw);
				return {
					publishing: publishing !== null,
					lastSeq: rec && rec.seq > 0 ? rec.seq : null,
					lastAt: rec && rec.at > 0 ? rec.at : null,
					verifying: verifying !== null,
					digest: readDigestRecord(raw),
				};
			})(),
			nextRetryAt,
			poll: { policy: { ...pollPolicy }, active, realtimeLive, nextPollAt },
		};
	};

	const emit = (e: CloudSyncEvent): void => {
		for (const cb of listeners) {
			try { cb(e); } catch (err) { slog.warn('listener threw', undefined, err); }
		}
	};
	// Progress ticks are coalesced (≤ 4/s); state changes go out at once.
	const emitStatus = (opts2: { progress?: boolean } = {}): void => {
		if (listeners.size === 0) return;
		const now = Date.now();
		if (opts2.progress && now - lastStatusEmit < 250) return;
		lastStatusEmit = now;
		emit({ kind: 'status', status: status() });
	};

	const patchClientState = (patch: Partial<ClientState>): void => {
		writeClientState(raw, { ...readClientState(raw), ...patch });
	};

	// Kept in the database, so a restart does not knock on the server again
	// just to be told the same thing; the features go too, which quiets the
	// catalogue layer (serverFeatures).
	const markRevoked = (): void => {
		if (!isRevoked()) {
			patchClientState({ revoked: { deviceId, at: Date.now() } });
			slog.warn('this device was revoked from the account — sync stopped (push and pull) until it is unlinked', { deviceId });
		}
		lastError = REVOKED_MESSAGE;
		forgetFeatures();
		clearRetry();
		attempt = 0;
	};

	const emitApplied = (tracks: Iterable<string>, playlists: Iterable<string>, entities: readonly EntityRef[]): void => {
		const applied: CloudSyncApplied = { tracks: [...new Set(tracks)], playlists: [...new Set(playlists)], entities: entities.slice(0, ENTITY_CAP) };
		if (applied.tracks.length === 0 && applied.playlists.length === 0 && applied.entities.length === 0) return;
		try { opts.onApplied?.(applied); } catch (err) { slog.warn('onApplied hook failed', undefined, err); }
		emit({ kind: 'applied', applied });
	};

	// ── session / account binding ───────────────────────────────────────

	// Null when it is fine to sync; otherwise the reason not to.
	const checkBinding = (session: CloudSession): string | null => {
		const st = readClientState(raw);
		if (st.userId && st.userId !== session.userId) {
			return 'This library is already synced with another Curator account. Sign in with that account to keep syncing.';
		}
		if (!st.userId) patchClientState({ userId: session.userId });
		return null;
	};

	const ensureRegistered = async (session: CloudSession): Promise<void> => {
		if (readClientState(raw).registeredFor === session.userId) return;
		const device = opts.device ?? { name: 'Curator desktop', platform: 'win32' as DevicePlatform };
		await transport.account.registerDevice({ deviceId, name: device.name, platform: device.platform });
		patchClientState({ registeredFor: session.userId });
		slog.info('device registered', { deviceId, name: device.name });
	};

	// ── push ────────────────────────────────────────────────────────────

	// Ops above what the server reads (features.ts pushableSchemaVersion) stay
	// pending rather than fail the batch: a v3 server answers a v4 op
	// `server_outdated` for the whole call. Order across versions does not
	// matter to the reducer (every rule is a max over clocks).
	const markAcked = raw.prepare(`UPDATE sync_outbox SET state = 'acked', reason = NULL WHERE op_id = ? AND state = 'pending'`);
	const markRejected = raw.prepare(`UPDATE sync_outbox SET state = 'rejected', reason = ? WHERE op_id = ? AND state = 'pending'`);
	// Plain pushes leave out the labels going up as batches (one prepared
	// statement per set; there are two labels).
	const pendingStmts = new Map<string, Database.Statement>();
	const pendingStmt = (batching: readonly BatchLabel[]): Database.Statement => {
		const key = batching.join(',');
		let s = pendingStmts.get(key);
		if (!s) {
			const skip = batching.length > 0 ? `AND (batch_label IS NULL OR batch_label NOT IN (${batching.map((l) => `'${l}'`).join(', ')}))` : '';
			s = raw.prepare(`SELECT op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload
				FROM sync_outbox WHERE state = 'pending' AND schema_version <= ? ${skip} ORDER BY seq_local LIMIT ?`);
			pendingStmts.set(key, s);
		}
		return s;
	};

	// The highest op version the last push (or batch stage) sent: what a
	// `server_outdated` refusal of it says the server no longer reads.
	let sentVersion = 0;

	const toOps = (rows: readonly OutboxRow[]): { ops: Op[]; all: boolean } => {
		// Fill to the byte cap; one op alone is always under it (16 KB max).
		const ops: Op[] = [];
		let bytes = 2;
		for (const r of rows) {
			const op = {
				op_id: r.op_id, device_id: r.device_id, client_ts: r.client_ts, schema_version: r.schema_version,
				entity: r.entity, entity_id: r.entity_id, kind: r.kind, payload: JSON.parse(r.payload) as unknown,
			} as Op;
			const size = utf8ByteLength(JSON.stringify(op)) + 1;
			if (ops.length > 0 && bytes + size > MAX_PUSH_BYTES) break;
			ops.push(op);
			bytes += size;
		}
		return { ops, all: ops.length === rows.length };
	};

	type Settled = { accepted: number; rejected: number; held: number; stopped: PushOutcome['stopped'] };

	// One push answer applied to the outbox, in one transaction: each op the
	// server took goes to `accept` (acked for a plain push, staged for a
	// batch), each refused op is marked rejected, the not-its-fault refusals
	// stay pending, and a clamped stamp is re-stamped locally. `extra` runs
	// in the same transaction (cursor bookkeeping).
	const settle = (
		ops: readonly Op[],
		answer: { rejected: readonly { opId: string; reason: RejectReason }[]; clamped?: readonly { opId: string; clientTs: number }[] },
		accept: (op: Op) => void,
		extra?: (st: ClientState, next: ClientState) => void,
	): Settled => {
		const rejected = new Map<string, RejectReason>(answer.rejected.map((r) => [r.opId, r.reason]));
		const clampedTs = new Map((answer.clamped ?? []).map((c) => [c.opId, c.clientTs]));
		const out: Settled = { accepted: 0, rejected: 0, held: 0, stopped: null };
		let restamp: ApplyOutcome | null = null;
		raw.transaction(() => {
			const restamped: Op[] = [];
			for (const op of ops) {
				const reason = rejected.get(op.op_id);
				if (reason === undefined) {
					accept(op);
					out.accepted++;
					const ts = clampedTs.get(op.op_id);
					if (ts !== undefined && ts !== op.client_ts) restamped.push({ ...op, client_ts: ts } as Op);
					continue;
				}
				// Not the op's fault: keep it pending for after the update /
				// for a device that is re-admitted.
				if (reason === 'update_required' || reason === 'device_revoked') { out.stopped = reason; out.held++; continue; }
				markRejected.run(reason, op.op_id);
				out.rejected++;
			}
			// The server stored these under its clock, not ours: the re-stamp a
			// clamped op's echo triggers in applyOps (it finds the op in the
			// outbox under another client_ts), done now with the acks, because
			// with the own-op skip the echo never comes.
			if (restamped.length > 0) restamp = applyOps(raw, restamped);
			const st = readClientState(raw);
			const next = { ...st };
			// In the same commit as the re-stamp, so a crash cannot keep one
			// without the other.
			if ((restamp as ApplyOutcome | null)?.restamped) next.needsRepair = true;
			extra?.(st, next);
			if (next.needsRepair !== st.needsRepair || next.ownThroughSeq !== st.ownThroughSeq) writeClientState(raw, next);
		})();
		const r = restamp as ApplyOutcome | null;
		if (r && r.restamped > 0) {
			slog.warn('push: the server clamped own ops (clock skew) — re-stamped; the next pull reloads the snapshot to repair', { count: r.restamped });
			emitApplied(r.tracksTouched, r.playlistsTouched, r.changed);
		}
		if (out.rejected > 0) slog.warn('push: ops rejected', { count: out.rejected, sample: answer.rejected.slice(0, 5) });
		if (out.stopped === 'update_required') pushRefused = true;
		if (out.stopped === 'device_revoked') markRevoked();
		return out;
	};

	// ownThroughSeq follows what the server just stored only when nothing
	// stamped with this device id lies above it outside the call (ClientState).
	const followOwn = (top: number | undefined, prior: number | undefined) => (st: ClientState, next: ClientState): void => {
		const through = st.ownThroughSeq ?? 0;
		if (top !== undefined && prior !== undefined && prior <= through && top > through) next.ownThroughSeq = top;
	};

	const pushOnce = async (): Promise<PushOutcome> => {
		const rows = pendingStmt(batchingLabels()).all(pushableSchemaVersion(features), MAX_PUSH_OPS) as OutboxRow[];
		if (rows.length === 0) return { pushed: 0, rejected: 0, more: false, stopped: null };
		const { ops, all } = toOps(rows);
		if (ops.length > 0) markMoving();
		sentVersion = Math.max(0, ...ops.map((o) => o.schema_version));
		const res = await transport.sync.push({ deviceId, ops });
		learnFeatures(res.features);
		const s = settle(ops, res, (op) => { markAcked.run(op.op_id); }, followOwn(res.batchMaxSeq, res.priorOwnMaxSeq));
		if (tally) { tally.pushed += s.accepted; tally.rejected += s.rejected; tally.held += s.held; }
		patchClientState(s.accepted > 0 ? { lastPushAt: Date.now(), lastChangedAt: Date.now() } : { lastPushAt: Date.now() });
		const full = rows.length === MAX_PUSH_OPS || !all;
		return { pushed: s.accepted, rejected: s.rejected, more: s.stopped === null && full, stopped: s.stopped };
	};

	// ── batches ─────────────────────────────────────────────────────────
	// A labelled backlog as one server batch ('batches'; header). Staged ops
	// stay `pending` with the batch's id on their row (still not in the log:
	// counted as waiting), and turn `acked` together when the commit lands.

	type BatchApi = Required<Pick<CloudTransport['sync'], 'batchBegin' | 'batchPush' | 'batchCommit' | 'batchAbort'>>;
	const batchApi = (): BatchApi | null => {
		const t = transport.sync;
		if (!features?.includes('batches') || !t.batchBegin || !t.batchPush || !t.batchCommit || !t.batchAbort) return null;
		return { batchBegin: t.batchBegin, batchPush: t.batchPush, batchCommit: t.batchCommit, batchAbort: t.batchAbort };
	};
	const batchMinOps = opts.batchMinOps ?? BATCH_MIN_OPS;
	const commitPollMs = opts.batchCommitPollMs ?? 2_000;
	const commitPolls = opts.batchCommitPolls ?? 90;

	const labelCounts = raw.prepare(`SELECT batch_label AS label, count(*) AS n FROM sync_outbox
		WHERE state = 'pending' AND batch_label IS NOT NULL GROUP BY batch_label`);
	const unstagedStmt = raw.prepare(`SELECT op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload
		FROM sync_outbox WHERE state = 'pending' AND batch_label = ? AND batch_id IS NULL AND schema_version <= ? ORDER BY seq_local LIMIT ?`);
	const countUnstaged = raw.prepare(`SELECT count(*) FROM sync_outbox WHERE state = 'pending' AND batch_label = ? AND batch_id IS NULL AND schema_version <= ?`).pluck();
	const countStaged = raw.prepare(`SELECT count(*) FROM sync_outbox WHERE state = 'pending' AND batch_label = ? AND batch_id = ?`).pluck();
	const markStaged = raw.prepare(`UPDATE sync_outbox SET batch_id = ? WHERE op_id = ? AND state = 'pending'`);
	// Rows staged in a batch the server no longer holds (expired, aborted, or
	// another one than the label's live batch after a crash): stage again.
	const unstage = raw.prepare(`UPDATE sync_outbox SET batch_id = NULL WHERE state = 'pending' AND batch_label = ? AND batch_id IS NOT NULL AND batch_id != ?`);
	const ackBatch = raw.prepare(`UPDATE sync_outbox SET state = 'acked', reason = NULL WHERE state = 'pending' AND batch_id = ?`);

	const batchRec = (label: BatchLabel): { batchId: string; committing: boolean } | null => readClientState(raw).batches?.[label] ?? null;
	const setBatchRec = (label: BatchLabel, rec: { batchId: string; committing: boolean } | null): void => {
		const st = readClientState(raw);
		const batches = { ...(st.batches ?? {}) };
		if (rec) batches[label] = rec;
		else delete batches[label];
		writeClientState(raw, { ...st, batches });
	};

	// The labels going up as batches now: the server takes them and the
	// backlog is worth it, or a batch is already open for it. The rest of the
	// labelled rows push plainly (a few reconciled claims at launch).
	const batchingLabels = (): BatchLabel[] => {
		if (!batchApi()) return [];
		const st = readClientState(raw);
		const counts = new Map((labelCounts.all() as Array<{ label: string; n: number }>).map((r) => [r.label, r.n]));
		return BATCH_LABELS.filter((l) => st.batches?.[l] !== undefined || (counts.get(l) ?? 0) >= batchMinOps);
	};

	// Commits already waited out this cycle: a cycle pushes twice (before and
	// after the meta stage), and the second time asks once, not for minutes.
	const commitWaited = new Set<string>();

	// Polls the commit until it lands (or `commitPolls` asks), then acks the
	// batch's rows in one transaction with the rejections and the own-op
	// bound. A commit still running is left to the next cycle: the server's
	// wake-up on publish starts one.
	const commitBatch = async (api: BatchApi, label: BatchLabel, batchId: string): Promise<void> => {
		const polls = commitWaited.has(batchId) ? 1 : commitPolls;
		for (let i = 0; i < polls; i++) {
			const r: BatchCommitResult = await api.batchCommit({ deviceId, batchId });
			learnFeatures(r.features);
			batchProgress = { label, phase: 'committing', done: r.movedOps, total: r.totalOps };
			emitStatus({ progress: true });
			if (r.status === 'committed') {
				let acked = 0;
				let rejectedN = 0;
				raw.transaction(() => {
					for (const rej of r.rejected) rejectedN += markRejected.run(rej.reason, rej.opId).changes;
					acked = ackBatch.run(batchId).changes;
					const st = readClientState(raw);
					const next: ClientState = { ...st, batches: { ...(st.batches ?? {}) } };
					delete next.batches![label];
					followOwn(r.committedSeq, r.priorOwnMaxSeq)(st, next);
					writeClientState(raw, next);
				})();
				if (tally) { tally.pushed += acked; tally.rejected += rejectedN; }
				patchClientState({ lastPushAt: Date.now(), lastChangedAt: Date.now() });
				slog.info('batch committed', { label, batchId, acked, rejected: rejectedN, committedSeq: r.committedSeq });
				return;
			}
			if (i + 1 < polls) await new Promise((resolve) => setTimeout(resolve, commitPollMs));
		}
		commitWaited.add(batchId);
		slog.info('batch: the server is still committing; resuming next cycle', { label, batchId, moved: batchProgress?.done, total: batchProgress?.total });
	};

	// One label's backlog: resume or open its batch, stage what is not staged,
	// commit. Ops held back by schema version wait for a later batch.
	const runBatch = async (api: BatchApi, label: BatchLabel): Promise<PushOutcome['stopped']> => {
		let rec = batchRec(label);
		try {
			if (rec?.committing) {
				await commitBatch(api, label, rec.batchId);
				return null;
			}
			const version = pushableSchemaVersion(features);
			const unstaged = countUnstaged.get(label, version) as number;
			if (!rec && unstaged === 0) return null;
			const b = await api.batchBegin({ deviceId, label, expectedOps: unstaged + (rec ? (countStaged.get(label, rec.batchId) as number) : 0) });
			learnFeatures(b.features);
			const dropped = unstage.run(label, b.batchId).changes;
			if (dropped > 0) slog.warn('batch: the server no longer holds the batch these ops were staged in; staging them again', { label, ops: dropped, batchId: b.batchId });
			rec = { batchId: b.batchId, committing: b.status === 'committing' };
			setBatchRec(label, rec);
			if (rec.committing) {
				await commitBatch(api, label, rec.batchId);
				return null;
			}
			let staged = countStaged.get(label, rec.batchId) as number;
			let total = staged + (countUnstaged.get(label, version) as number);
			for (;;) {
				const rows = unstagedStmt.all(label, version, MAX_PUSH_OPS) as OutboxRow[];
				if (rows.length === 0) break;
				const { ops } = toOps(rows);
				markMoving();
				batchProgress = { label, phase: 'uploading', done: staged, total };
				emitStatus({ progress: true });
				sentVersion = Math.max(0, ...ops.map((o) => o.schema_version));
				const res = await api.batchPush({ deviceId, batchId: rec.batchId, ops });
				learnFeatures(res.features);
				const id = rec.batchId;
				const s = settle(ops, res, (op) => { markStaged.run(id, op.op_id); });
				staged += s.accepted;
				total -= s.rejected;
				if (tally) { tally.rejected += s.rejected; tally.held += s.held; }
				if (s.stopped) return s.stopped;
			}
			if (staged === 0) {
				// Everything it held was pushed plainly meanwhile, or refused.
				await api.batchAbort({ deviceId, batchId: rec.batchId }).catch((err: unknown) => slog.warn('batch: abort of an empty batch failed', { label }, err));
				setBatchRec(label, null);
				return null;
			}
			setBatchRec(label, { batchId: rec.batchId, committing: true });
			await commitBatch(api, label, rec.batchId);
			return null;
		} catch (err) {
			if (err instanceof CloudTransportError && err.kind === 'batch_gone' && rec) {
				// Expired (a day idle) or aborted: its staged ops are gone from
				// the server. They go up again in a new batch: the cycle reruns.
				raw.transaction(() => {
					raw.prepare(`UPDATE sync_outbox SET batch_id = NULL WHERE state = 'pending' AND batch_id = ?`).run(rec!.batchId);
					setBatchRec(label, null);
				})();
				slog.warn('batch: the server dropped the batch; its ops go up again in a new one', { label, batchId: rec.batchId });
				again = true;
				return null;
			}
			throw err;
		} finally {
			batchProgress = null;
			emitStatus();
		}
	};

	// After the plain pushes, each batching label in turn.
	const pushBatches = async (): Promise<PushOutcome['stopped']> => {
		const api = batchApi();
		if (!api) return null;
		for (const label of batchingLabels()) {
			const stopped = await runBatch(api, label);
			if (stopped) return stopped;
		}
		return null;
	};

	// Everything waiting: plain pushes until drained, then the batches. A
	// session that has not heard the server's features yet asks first (an
	// empty push answers them) when a backlog is waiting, so a first sign-in's
	// initial push goes up as a batch, not as plain pushes.
	const pushAll = async (): Promise<PushOutcome['stopped']> => {
		if (features === null && transport.sync.batchBegin) {
			const backlog = (labelCounts.all() as Array<{ n: number }>).reduce((m, r) => Math.max(m, r.n), 0);
			if (backlog >= batchMinOps) learnFeatures((await transport.sync.push({ deviceId, ops: [] })).features);
		}
		while (!pushRefused) {
			const p = await pushOnce();
			if (p.stopped === 'device_revoked') return p.stopped;
			if (!p.more) break;
		}
		if (pushRefused) return 'update_required';
		return pushBatches();
	};

	// ── pull ────────────────────────────────────────────────────────────

	// One page, naming this device when the server offers 'device_reads' and
	// without its held ops when it offers the skip. A server that advertised
	// either and then refuses the fields (rolled back mid-session) gets the
	// same pull without them, so sync carries on.
	const pullPage = async (afterSeq: number): Promise<PullResult> => {
		const base: PullInput = { afterSeq, limit: MAX_PULL_OPS };
		const through = readClientState(raw).ownThroughSeq ?? 0;
		const skip = serverSkipsOwn && through > 0;
		if (serverDeviceReads || skip) {
			try {
				const res = await transport.sync.pull({ ...base, deviceId, ...(skip ? { ownThroughSeq: through } : {}) });
				learnFeatures(res.features);
				return res;
			} catch (err) {
				if (!(err instanceof CloudTransportError && err.kind === 'bad_request')) throw err;
				slog.warn('pull: the server refused the device fields; pulling without them', { reason: err.message });
				serverSkipsOwn = false;
				serverDeviceReads = false;
			}
		}
		const res = await transport.sync.pull(base);
		learnFeatures(res.features);
		return res;
	};

	// The apply size (PULL_SLICE_MS), carried across pages and pulls: the
	// cost of the next ops is best guessed from the last ones. A test's
	// `pullApplyChunk` pins it.
	const [applyMin, applyMax] = opts.pullApplyChunk ? [Math.max(1, opts.pullApplyChunk), Math.max(1, opts.pullApplyChunk)] : [PULL_APPLY_MIN, PULL_APPLY_MAX];
	let applyStep = opts.pullApplyChunk ? applyMin : PULL_APPLY_START;
	// Whether the last pull read up to the head (an empty page): the publish
	// stage runs only after a cycle whose final pull did.
	let pullReachedHead = false;
	const pullOnce = async (): Promise<PullOutcome> => {
		pullReachedHead = false;
		const out: PullOutcome = { applied: 0, received: 0, pages: 0, bootstrapped: false, held: 0, stopped: null, maxSliceMs: 0 };
		const tracks = new Set<string>();
		const playlists = new Set<string>();
		const entities: EntityRef[] = [];
		const collect = (o: { tracksTouched: readonly string[]; playlistsTouched: readonly string[]; changed?: readonly EntityRef[] }): void => {
			for (const t of o.tracksTouched) tracks.add(t);
			for (const p of o.playlistsTouched) playlists.add(p);
			if (o.changed && entities.length < ENTITY_CAP) entities.push(...o.changed.slice(0, ENTITY_CAP - entities.length));
		};
		try {
			// Ops held by an older build that this one reads (an update just
			// landed): applied before anything newer.
			if (heldCount(raw) > 0 && recordsComplete(raw)) {
				const replay = replayHeldOps(raw);
				if (replay.outcome) {
					collect(replay.outcome);
					slog.info('pull: replayed ops held for an update', { applied: replay.applied, remaining: replay.remaining });
				}
				if (replay.error) slog.warn('pull: held ops this version should read do not parse; still held', { error: replay.error, remaining: replay.remaining });
			}
			for (;;) {
				const cursor = readCursor(raw);
				// Below the account's base (learnt from the last bootstrap): the
				// log no longer holds the ops after this cursor.
				if (!out.bootstrapped && cursor.lastSeq < (readClientState(raw).baseSeq ?? 0)) {
					slog.info('pull: the cursor is below the account base; bootstrapping', { cursor: cursor.lastSeq, baseSeq: readClientState(raw).baseSeq });
					await bootstrap();
					out.bootstrapped = true;
					continue;
				}
				const res = await pullPage(cursor.lastSeq);
				out.received += res.ops.length;
				if (tally) tally.pulled += res.ops.length;
				if (res.ops.length > 0) markMoving();
				// Bootstrap at most once per pull: a second hint after loading
				// a snapshot would be a server bug, not a reason to loop.
				if (res.snapshotSeq !== undefined && res.snapshotSeq > cursor.lastSeq && !out.bootstrapped) {
					await bootstrap();
					out.bootstrapped = true;
					continue;
				}
				// A device that never loaded the account's base (snapshot_seq
				// null: it stated its library as ops under an older build, or to
				// a server without one) lacks what the founder folded — that is
				// in the snapshot and nowhere in the log. Once, unless it is the
				// master that publishes the base (its records are it).
				if (!out.bootstrapped && res.published && cursor.snapshotSeq === null && features?.includes('snapshot_storage') && masterDevice(raw) !== deviceId) {
					slog.info('pull: this device never loaded the account base; bootstrapping once', { cursor: cursor.lastSeq, published: res.published.seq });
					out.bootstrapped = true;
					await bootstrap();
					continue;
				}
				if (res.ops.length === 0) {
					if (readClientState(raw).needsRepair && !out.bootstrapped) {
						slog.warn('this device\'s records need the master\'s snapshot (a clock-skew re-stamp, or a digest mismatch) — reloading it to repair');
						out.bootstrapped = true;
						if (await bootstrap({ resetCursor: true })) {
							patchClientState({ needsRepair: false });
							continue;
						}
						slog.warn('repair: the account has no published snapshot yet; trying again next cycle');
					}
					// Drained. An empty page can still move the cursor (a run of
					// own ops the server left out), and everything up to the
					// cursor is now held here, so ownThroughSeq follows it.
					let at = 0;
					raw.transaction(() => {
						at = Math.max(res.nextSeq, cursor.lastSeq);
						if (at > cursor.lastSeq) writeCursor(raw, at);
						const st = readClientState(raw);
						if (at > (st.ownThroughSeq ?? 0)) writeClientState(raw, { ...st, ownThroughSeq: at });
						markFirstPull(raw);
					})();
					// At the master's newest snapshot exactly: the records here
					// should be that snapshot (the digest check, after the cycle).
					if (res.published && res.published.seq === at) digestDue = res.published;
					pullReachedHead = true;
					break;
				}
				out.pages++;
				// Newer-protocol ops are set aside (held.ts); the rest of
				// the page applies and the cursor passes both.
				const ahead = res.ops.filter((o) => schemaVersionStatus(o.schema_version) === 'ahead');
				const page = ahead.length === 0 ? res.ops : res.ops.filter((o) => schemaVersionStatus(o.schema_version) !== 'ahead');
				const lastSeq = res.ops[res.ops.length - 1]!.seq;
				const wire = page.map(wireOp);
				let dedupeRemoved = 0;
				const dedupePlaylists = new Set<string>();
				try {
					// The whole page first (applyOps parses each sub-batch again,
					// ~1% of its cost): a malformed op must not leave part of
					// its page applied.
					for (const o of wire) parseOp(o);
					for (let i = 0; i === 0 || i < wire.length;) {
						const batch = wire.slice(i, i + applyStep);
						i += applyStep;
						const last = i >= wire.length;
						// Before every sub-batch, the first included: the pull's
						// await is not a turn of the loop when the transport
						// answers from memory, and two pages' slices would run
						// back to back.
						await yieldToLoop();
						const t0 = performance.now();
						let outcome: ApplyOutcome | null = null;
						let healed: DedupeResult | null = null;
						raw.transaction(() => {
							if (batch.length > 0) {
								outcome = applyOps(raw, batch);
								// Doubled streaming rows the sub-batch brought
								// together fold in the same commit
								// (playlist-dedupe.ts): no commit shows them.
								healed = healAfterApply(raw, batch);
							}
							if (!last) return;
							out.held += holdOps(raw, ahead);
							opts.beforeCursorAdvance?.(page);
							// The whole page applied: the cursor may pass its last
							// op, over own ops the server left out.
							writeCursor(raw, Math.max(lastSeq, cursor.lastSeq, res.nextSeq));
						})();
						const ms = performance.now() - t0;
						out.maxSliceMs = Math.max(out.maxSliceMs, ms);
						// Only a full batch says what a batch of this size costs
						// (a page's short tail is mostly the fixed part).
						if (batch.length === applyStep) {
							applyStep = Math.max(applyMin, Math.min(applyMax, applyStep * 2, Math.round(applyStep * PULL_SLICE_MS / Math.max(ms, 1))));
						}
						const o = outcome as ApplyOutcome | null;
						if (o && o.restamped > 0) patchClientState({ needsRepair: true });
						if (o) {
							out.applied += o.applied;
							if (tally) tally.applied += o.applied;
							collect(o);
						}
						const h = healed as DedupeResult | null;
						if (h && h.removed > 0) {
							collect(h);
							dedupeRemoved += h.removed;
							for (const p of h.playlistsTouched) dedupePlaylists.add(p);
						}
					}
				} catch (err) {
					if (err instanceof OpValidationError) {
						// An op this version should read but cannot: never skip
						// it (it may matter), stop here and say so.
						lastError = `The server sent a change this version cannot read (${err.message}).`;
						slog.error('pull: unreadable op', err, { afterSeq: cursor.lastSeq });
						out.stopped = 'unreadable';
						break;
					}
					throw err;
				}
				if (dedupeRemoved > 0) slog.info('pull: removed streaming playlist rows doubled by merges', { removed: dedupeRemoved, playlists: dedupePlaylists.size });
				// The server's receive stamps floor this device's next clock.
				const serverTs = res.ops.reduce((m, op) => Math.max(m, op.received_at), 0);
				if (serverTs > 0) observeServerTs(raw, serverTs);
				if (ahead.length > 0) slog.warn('pull: ops from a newer version held aside until an update', { held: ahead.length, maxVersion: Math.max(...ahead.map((a) => a.schema_version)) });
			}
			// An artist alias rule pulled above (or left by an interrupted
			// run) rewrites existing credits in yielding chunks; ingest
			// already maps through it since the page committed.
			if (artistCreditRewritePending(raw)) {
				const d = await drainArtistCreditRewritesAsync(raw);
				for (const t of d.tracks) tracks.add(t);
				slog.info('artist alias rewrite: done', { rowsScanned: d.rowsScanned, tracksRewritten: d.tracksRewritten, chunks: d.chunks, maxSliceMs: Math.round(d.maxSliceMs) });
			}
		} finally {
			// Whatever landed before an error is reported, not lost.
			emitApplied(tracks, playlists, entities);
		}
		patchClientState(out.applied > 0 ? { lastPullAt: Date.now(), lastChangedAt: Date.now() } : { lastPullAt: Date.now() });
		return out;
	};

	// ── bootstrap ───────────────────────────────────────────────────────

	// The master's newest snapshot out of Storage (the transport reads and
	// checks the parts), naming this device when the server offers
	// 'device_reads'. A server that advertised it and then refuses the field
	// (rolled back mid-session) gets the same call without it.
	const fetchSnapshot = async (): ReturnType<CloudTransport['bootstrap']> => {
		if (serverDeviceReads) {
			try {
				return await transport.bootstrap({ deviceId });
			} catch (err) {
				if (!(err instanceof CloudTransportError && err.kind === 'bad_request')) throw err;
				slog.warn('bootstrap: the server refused the device id; loading without it', { reason: err.message });
				serverDeviceReads = false;
			}
		}
		return transport.bootstrap();
	};

	const rememberBase = (baseSeq: number): void => {
		if (baseSeq !== (readClientState(raw).baseSeq ?? 0)) patchClientState({ baseSeq });
	};

	// Loads `records` (the snapshot at `snapshotSeq`) onto this device.
	// `resetCursor`: replay from the snapshot's seq even when the cursor is
	// past it (a repair), instead of keeping the further cursor.
	const loadRecords = async (records: readonly SnapshotRecord[], snapshotSeq: number, bopts: { resetCursor?: boolean } = {}): Promise<void> => {
		if (tally) { tally.bootstrapped = true; tally.snapshotRecords += records.length; }
		slog.info('bootstrap: loading snapshot', { records: records.length, snapshotSeq });
		bootstrapProgress = { done: 0, total: records.length };
		emitStatus();
		try {
			const res = await loadSnapshot(raw, records, {
				onProgress: (p) => { bootstrapProgress = p; emitStatus({ progress: true }); },
			});
			const cursor = readCursor(raw);
			raw.transaction(() => {
				writeCursor(raw, bopts.resetCursor ? snapshotSeq : Math.max(cursor.lastSeq, snapshotSeq), snapshotSeq);
				markFirstPull(raw);
			})();
			slog.info('bootstrap: done', { changed: res.changed, chunks: res.chunks, maxSliceMs: Math.round(res.maxSliceMs) });
			emitApplied(res.tracksTouched, res.playlistsTouched, res.changedRefs);
		} finally {
			bootstrapProgress = null;
			emitStatus();
		}
	};

	// False when nothing could be loaded: the account holds no snapshot but
	// has a base (its log no longer starts at 0). No snapshot at base 0 is
	// the empty state (protocol BootstrapResult): "replay the log from 0",
	// which a repair (`resetCursor`) does by rewinding the cursor.
	const bootstrap = async (bopts: { resetCursor?: boolean } = {}): Promise<boolean> => {
		const b = await fetchSnapshot();
		rememberBase(b.baseSeq);
		if (b.records === null) {
			if (b.baseSeq > 0) {
				slog.warn('bootstrap: the account has no published snapshot', { baseSeq: b.baseSeq });
				return false;
			}
			if (bopts.resetCursor) raw.transaction(() => { writeCursor(raw, 0); markFirstPull(raw); })();
			return true;
		}
		await loadRecords(b.records, b.snapshotSeq, bopts);
		return true;
	};

	// ── stating the library (the header) ────────────────────────────────

	const initialPushDone = (): boolean => libraryStated(raw);

	// One pull of the head, for what the bootstrap does not say: whether the
	// account has any op at all, and the server's features when this session
	// has not heard them yet.
	const probeHead = async (): Promise<{ empty: boolean }> => {
		const res = await transport.sync.pull({ afterSeq: 0, limit: 1, ...(serverDeviceReads ? { deviceId } : {}) });
		learnFeatures(res.features);
		return { empty: res.ops.length === 0 && res.snapshotSeq === undefined };
	};

	type BaseOutcome = 'stated' | 'founded' | 'joined' | 'waiting' | 'pushed';
	let baseRun: Promise<BaseOutcome> | null = null;
	type Driver = (r: Raw, o: { chunk?: number; onProgress?: (p: InitialPushProgress) => void }) => Promise<InitialPushAsyncResult>;
	const progress = (p: InitialPushProgress): void => { initialPushProgress = p; emitStatus({ progress: true }); };

	// A joiner's statement: the bind sweep (once), then the join push as the
	// 'initial-push' batch.
	const joinAccount = async (): Promise<void> => {
		if (!joinBindDone(raw)) {
			const b = await joinBindAsync(raw);
			slog.info('join: own rows bound to the account\'s recordings', { rows: b.rows, bound: b.bound, boundDeleted: b.boundDeleted, known: b.known, unbound: b.unbound, held: b.held, chunks: b.chunks, maxSliceMs: Math.round(b.maxSliceMs) });
			emitApplied(b.tracksTouched, b.playlistsTouched, []);
		}
		const r = await joinPushAsync(raw, { chunk: opts.initialPushChunk, onProgress: progress });
		slog.info('join push: done', { ops: r.ops, chunks: r.chunks, ms: r.ms, maxSliceMs: Math.round(r.maxSliceMs) });
	};

	const establishBase = async (): Promise<BaseOutcome> => {
		if (initialPushDone()) return 'stated';
		// The features this session has not heard yet come with the probe the
		// founder check needs anyway: one call, not two.
		const probed = features === null ? await probeHead() : null;
		// No base to be had: the library goes up as ops (the path before the
		// account had a base at all; a server without 'snapshot_storage').
		if (!features?.includes('snapshot_storage')) {
			const r = await joinPushAsync(raw, { chunk: opts.initialPushChunk, onProgress: progress });
			slog.info('initial push: done (the server holds no base)', { ops: r.ops, chunks: r.chunks, ms: r.ms, maxSliceMs: Math.round(r.maxSliceMs) });
			return 'pushed';
		}
		// A device that has seen the account already (a bootstrap that landed,
		// then a crash before the join push) carries on from there.
		if (!firstPullDone(raw)) {
			const b = await fetchSnapshot();
			rememberBase(b.baseSeq);
			if (b.records !== null) {
				await loadRecords(b.records, b.snapshotSeq);
			} else if (b.baseSeq === 0 && (probed ?? await probeHead()).empty) {
				// The founder. The account is empty, so this device has seen all
				// of it (FIRST_PULL_KEY: the drains' role gate opens on it), and
				// the fold states everything into the records alone.
				// snapshot_seq 0: this device holds the base itself (the pull's
				// never-loaded-a-base rule below does not apply to it).
				raw.transaction(() => { markFirstPull(raw); writeCursor(raw, readCursor(raw).lastSeq, 0); })();
				const r = await foldLibraryAsync(raw, {
					chunk: opts.initialPushChunk,
					onProgress: progress,
					...(opts.feed ? { feed: { backfill: (o: { local: true }) => opts.feed!.backfill(o) } } : {}),
				});
				slog.info('founder: library folded into the records as the account base; nothing sent', { ops: r.ops, meta: r.meta, attrs: r.attrs, analysis: r.analysis, playlistAttrs: r.playlistAttrs, v4: r.v4, claims: r.claims, albums: r.albums, feed: r.feed, chunks: r.chunks, ms: r.ms, maxSliceMs: Math.round(r.maxSliceMs) });
				return 'founded';
			} else if (masterDevice(raw) === deviceId) {
				// The records already name this device the master (nothing to
				// join from): it publishes the base itself.
				markFirstPull(raw);
			} else {
				return 'waiting';
			}
		}
		await joinAccount();
		return 'joined';
	};

	// Single flight over the statement and the backfills a stated library
	// still owes (a library pushed before rekordbox units, or before
	// recordings and their claims, were emitted states them once, through
	// the same chunked driver).
	const runInitialPush = (): Promise<BaseOutcome> => {
		if (baseRun) return baseRun;
		baseRun = (async (): Promise<BaseOutcome> => {
			initialPushProgress = { done: 0, estimate: 0 };
			emitStatus();
			try {
				const outcome = await establishBase();
				if (outcome === 'waiting') return outcome;
				const runs: Array<[string, Driver]> = [
					...(rbBackfillPending(raw) ? [['rekordbox analysis backfill: done', rbBackfillAsync] as [string, Driver]] : []),
					...(claimsBackfillPending(raw) ? [['recording claims backfill: done', claimsBackfillAsync] as [string, Driver]] : []),
				];
				for (const [done, drive] of runs) {
					const r = await drive(raw, { chunk: opts.initialPushChunk, onProgress: progress });
					slog.info(done, { ops: r.ops, chunks: r.chunks, ms: r.ms, maxSliceMs: Math.round(r.maxSliceMs) });
				}
				return outcome;
			} finally {
				initialPushProgress = null;
				baseRun = null;
				emitStatus();
			}
		})();
		return baseRun;
	};

	// ── recording identity ──────────────────────────────────────────────
	// The identity resolver (identity.ts) whenever the op log moved since its
	// last run: this device's clock (any local op, the scanner's claims
	// among them) or the pull cursor (claims from elsewhere). The signature
	// is read before the run, so the run's own merges cost one more plan
	// (a range read) rather than hiding a claim made while it yielded. A
	// failure is logged and retried on the next cycle, never fails the sync.
	let identitySig: string | null = null;
	let identityHeld = -1;
	const resolveIdentities = async (): Promise<void> => {
		const clock = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(CLOCK_KEY) as string | undefined;
		const sig = `${clock ?? ''}|${readCursor(raw).lastSeq}`;
		if (sig === identitySig) return;
		identitySig = sig;
		try {
			const r = await resolveRecordingIdentitiesAsync(raw);
			if (r.merged > 0) {
				slog.info('identity: merged recordings that share an audio hash or a streaming id', {
					merged: r.merged, planned: r.merges.length, streaming: r.merges.filter((m) => m.tier === 'streaming').length,
					dedupeRemoved: r.dedupeRemoved, chunks: r.chunks, ms: r.ms, maxSliceMs: Math.round(r.maxSliceMs),
				});
				emitApplied(r.tracksTouched, r.playlistsTouched, []);
			}
			// Groups this device keeps apart (its own duplicate files, or a
			// hash on too many recordings), said once per change, not per cycle.
			if (r.held.length !== identityHeld) {
				identityHeld = r.held.length;
				if (r.held.length > 0) {
					slog.info('identity: groups held for the user, not merged', {
						held: r.held.length,
						sample: r.held.slice(0, 5).map((h) => ({ reason: h.reason, recordings: h.recordings.length, rows: h.trackIds, blockers: h.blockers })),
					});
				}
			}
		} catch (err) {
			identitySig = null;
			slog.warn('identity: resolver failed; retrying next cycle', undefined, err);
		}
	};

	// ── streaming playlist doubles: the one-time sweep ──────────────────
	// The merge chunks and alias-moving pulls fold the doubles they create;
	// this catches those older merges left (playlist-dedupe.ts), once, after
	// the first pull has brought every device's rows in.
	const sweepStreamingDuplicates = async (): Promise<void> => {
		if (streamingDedupeSwept(raw) || !firstPullDone(raw) || !recordsComplete(raw)) return;
		try {
			const r = await sweepStreamingDuplicatesAsync(raw);
			slog.info('streaming playlists: one-time sweep for doubled rows done', { playlists: r.playlists, removed: r.removed, maxSliceMs: Math.round(r.maxSliceMs) });
			if (r.removed > 0) emitApplied(r.tracksTouched, r.playlistsTouched, []);
		} catch (err) {
			slog.warn('streaming playlists: dedupe sweep failed; retrying next cycle', undefined, err);
		}
	};

	// ── base metadata and remote rows (protocol v3) ─────────────────────
	// After the pull, so the records are the account's and the features
	// are known. Every step is a no-op when it has nothing to do; each
	// yields between chunks. Failures are logged and retried next cycle.

	// A drain this large is a backfill's queue (or a bulk rewrite), never a
	// few edits: its ops are labelled for a batch ('batches').
	const drainLabel = (dirty: number): BatchLabel | undefined => (dirty >= batchMinOps ? 'backfill' : undefined);

	// This device's own rows' meta, once the server reads v3: the one-time
	// backfill queues every row, the drain states what changed.
	const syncTrackMeta = async (): Promise<number> => {
		if (!serverReadsTrackMeta(features) || !recordsComplete(raw)) return 0;
		if (trackMetaBackfillPending(raw)) {
			const queued = await queueTrackMetaBackfillAsync(raw);
			slog.info('track meta: queued every own row for the one-time backfill', { rows: queued });
		}
		const dirty = trackMetaDirtyCount(raw);
		if (dirty === 0) return 0;
		const r = await drainTrackMetaAsync(raw, { batchLabel: drainLabel(dirty) });
		if (r.emitted > 0) slog.info('track meta: stated', { rows: r.rows, emitted: r.emitted, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
		return r.emitted;
	};

	// The account's master device, stated once by the device that first
	// linked the library (the earliest still registered: track-meta.ts
	// defaultMasterDevice) when the records hold none. Asked of the server
	// at most once per session while unset.
	let masterChecked = false;
	const ensureMaster = async (): Promise<void> => {
		if (masterChecked || !serverReadsTrackMeta(features) || !firstPullDone(raw) || masterDevice(raw) !== null) return;
		masterChecked = true;
		const devices = await transport.account.devices();
		const first = defaultMasterDevice(devices);
		if (first === deviceId && masterDevice(raw) === null) {
			setMasterDevice(raw, deviceId);
			slog.info('master device: this device first linked the library; stated it as the master', { deviceId });
		}
	};

	// Remote rows: the one-time sweep (and the re-pick after a master
	// change), then the artist/album derivations queued by any
	// materialisation too large to derive inline.
	const settleRemoteRows = async (): Promise<void> => {
		const tracks = new Set<string>();
		const playlists = new Set<string>();
		if (!materializeSwept(raw) && firstPullDone(raw) && recordsComplete(raw)) {
			const r = await sweepRemoteRowsAsync(raw);
			for (const t of r.tracksTouched) tracks.add(t);
			for (const p of r.playlistsTouched) playlists.add(p);
		}
		// The creations a pull page, snapshot chunk or the sweep queued.
		if (remotePendingCount(raw) > 0) {
			const r = await drainRemotePendingAsync(raw);
			for (const t of r.tracksTouched) tracks.add(t);
			for (const p of r.playlistsTouched) playlists.add(p);
		}
		if (derivePendingCount(raw) > 0) {
			const d = await drainTrackDerivationsAsync(raw);
			for (const t of d.tracks) tracks.add(t);
			if (d.tracks.length > 0) slog.info('remote rows: artists and albums derived', { rows: d.tracks.length, chunks: d.chunks, maxSliceMs: Math.round(d.maxSliceMs) });
		}
		// Provider links from the account's claims (claim-links.ts), after
		// the rows above exist: once over every row, then whatever the
		// triggers and projections queued. Display data only — they emit
		// nothing and no upstream write reads them.
		if (!claimLinksSwept(raw) && firstPullDone(raw) && recordsComplete(raw)) {
			const r = await sweepClaimLinksAsync(raw);
			for (const t of r.tracks) tracks.add(t);
			slog.info('claim links: sweep done', { recordings: r.recordings, rows: r.tracks.length, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
		}
		if (claimLinkPendingCount(raw) > 0) {
			const r = await drainClaimLinksAsync(raw);
			for (const t of r.tracks) tracks.add(t);
			if (r.tracks.length > 0) slog.info('claim links: derived', { recordings: r.recordings, rows: r.tracks.length, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
		}
		emitApplied(tracks, playlists, []);
	};

	// Plays a projection left without their track (play-heal.ts), once, after
	// the remote rows above exist.
	const healPlayHistory = async (): Promise<void> => {
		if (!playHealPending(raw) || !firstPullDone(raw) || !recordsComplete(raw)) return;
		const r = await healPlayHistoryAsync(raw);
		if (r.relinked > 0) slog.info('play history: re-linked to tracks', { events: r.events, relinked: r.relinked, sessions: r.sessions, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
	};

	// Provider links this device holds that no claim states yet
	// (claim-reconcile.ts), once a session: the one-time claims backfill ran
	// at a single instant, and a link written after it by a path that did
	// not claim stayed invisible to every other device. Only once the
	// account's records are here (first pull): before it, every link of a
	// device joining an existing library would look unclaimed.
	// Run again, with the v4 kinds (traxsource), the first time this session
	// learns the server reads v4.
	let claimsReconciled: 'v3' | 'v4' | null = null;
	const reconcileClaims = async (): Promise<void> => {
		const v4 = featuresReadV4(features);
		if (claimsReconciled === 'v4' || (claimsReconciled === 'v3' && !v4) || !initialPushDone() || claimsBackfillPending(raw) || !recordsComplete(raw) || !firstPullDone(raw)) return;
		const r = await reconcileProviderClaimsAsync(raw, { v4 });
		claimsReconciled = v4 ? 'v4' : 'v3';
		if (r.emitted > 0) slog.info('provider claims: stated links no claim carried', { emitted: r.emitted, bySource: r.bySource, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
	};

	// ── protocol v4: the zero-loss statements ───────────────────────────
	// Once the server reads v4 (features.ts): the track attributes and the
	// playlist details (one-time backfill, then the drains of what changed),
	// the one-time backfills of cue origins, play references, rekordbox tempo /
	// key strength, provider album metadata and the feed's decisions. Each is
	// a no-op when it has nothing to do; each yields between chunks.
	const syncV4 = async (): Promise<number> => {
		// v4 implies v3 (a server reads every older kind).
		if (!featuresReadV4(features) || !serverReadsTrackMeta(features) || !recordsComplete(raw) || !initialPushDone() || !firstPullDone(raw)) return 0;
		let emitted = 0;
		if (trackAttrsBackfillPending(raw)) {
			const queued = await queueTrackAttrsBackfillAsync(raw);
			slog.info('track attributes: queued every own row for the one-time backfill', { rows: queued });
		}
		const attrsDirty = trackAttrsDirtyCount(raw);
		if (attrsDirty > 0) {
			const r = await drainTrackAttrsAsync(raw, { batchLabel: drainLabel(attrsDirty) });
			emitted += r.emitted;
			if (r.emitted > 0) slog.info('track attributes: stated', { rows: r.rows, emitted: r.emitted, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
		}
		if (playlistAttrsBackfillPending(raw)) queuePlaylistAttrsBackfill(raw);
		const playlistsDirty = playlistAttrsDirtyCount(raw);
		if (playlistsDirty > 0) {
			const r = await drainPlaylistAttrsAsync(raw, { batchLabel: drainLabel(playlistsDirty) });
			emitted += r.emitted;
			if (r.emitted > 0) slog.info('playlist details: stated', { rows: r.rows, emitted: r.emitted, maxSliceMs: Math.round(r.maxSliceMs) });
		}
		if (v4BackfillsPending(raw)) {
			for (const [name, run] of [['cue origins', backfillCueOriginsAsync], ['play references', backfillPlayRefsAsync], ['rekordbox tempo / key strength', backfillRbUnitsV4Async]] as const) {
				const r = await run(raw);
				emitted += r.emitted;
				if (r.rows > 0) slog.info(`v4 backfill: ${name}`, { rows: r.rows, emitted: r.emitted, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
			}
		}
		if (albumMetaBackfillPending(raw)) {
			const r = await albumMetaBackfillAsync(raw);
			emitted += r.emitted;
			if (r.albums > 0) slog.info('v4 backfill: provider album metadata', { albums: r.albums, emitted: r.emitted, maxSliceMs: Math.round(r.maxSliceMs) });
		}
		if (opts.feed?.backfillPending()) {
			const r = await opts.feed.backfill();
			emitted += r.emitted;
			slog.info('v4 backfill: feed decisions', { emitted: r.emitted });
		}
		return emitted;
	};

	// ── protocol v5: the analysis ───────────────────────────────────────
	// Once the server reads v5 (features.ts): the one-time backfill of every
	// own analysed row, then the drain of what changed (an analysis that
	// finished, a re-analysis, a file that went missing). On the master the
	// backfill also asks for a snapshot publish once it is all stated, so the
	// account's base carries the analysis (SNAPSHOT_PUBLISH_REQUEST_KEY).
	const syncV5 = async (): Promise<number> => {
		if (!featuresReadV5(features) || !serverReadsTrackMeta(features) || !recordsComplete(raw) || !initialPushDone() || !firstPullDone(raw)) return 0;
		if (trackAnalysisBackfillPending(raw)) {
			const queued = await queueTrackAnalysisBackfillAsync(raw);
			slog.info('track analysis: queued every own analysed row for the one-time backfill', { rows: queued });
			if (masterDevice(raw) === deviceId) writePublishRequest(raw, { owed: true });
		}
		const dirty = trackAnalysisDirtyCount(raw);
		let emitted = 0;
		if (dirty > 0) {
			const r = await drainTrackAnalysisAsync(raw, { batchLabel: drainLabel(dirty) });
			emitted = r.emitted;
			if (r.emitted > 0) slog.info('track analysis: stated', { rows: r.rows, emitted: r.emitted, chunks: r.chunks, maxSliceMs: Math.round(r.maxSliceMs) });
		}
		const req = readPublishRequest(raw);
		if (req && 'owed' in req && trackAnalysisDirtyCount(raw) === 0) writePublishRequest(raw, { at: Date.now() });
		return emitted;
	};

	// Feed decisions a pull brought, into feed.db.
	const applyFeedDecisions = async (): Promise<void> => {
		if (!opts.feed || opts.feed.pending() === 0) return;
		const r = await opts.feed.applyPending();
		if (r.changed > 0) slog.info('feed decisions applied', { keys: r.keys, changed: r.changed });
	};

	const stage = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
		try { await fn(); } catch (err) { slog.warn(`${name} failed; retrying next cycle`, undefined, err); }
	};

	// ── the master's snapshot ('snapshot_storage') ──────────────────────
	// Started at the end of a cycle whose final pull reached the head, and
	// run beside the cycles rather than inside one: the build happens off
	// this thread (the injected builder) and the upload is ~37 MB, a minute
	// or more on a slow uplink, which must not hold the next push or pull.
	// Running it concurrently is safe by construction: the build reads the
	// records, preconditions and cursor in one read transaction of its own
	// connection, so it is the state after exactly `snapshotSeq` whatever a
	// cycle writes meanwhile; the head only grows, so `seq <= head` stays
	// true; Storage objects are immutable. It has its own single flight
	// (`publishing`); unlink waits for it and it stops at the next step once
	// unlink or stop() begins. A failure is logged and retried after
	// SNAPSHOT_RETRY_MS; a failed precondition (an op waiting, a rejection,
	// a held op) just waits for a later cycle.
	const publishOpts = opts.snapshot;
	const publishEveryOps = publishOpts?.everyOps ?? SNAPSHOT_EVERY_OPS;
	const publishEveryMs = publishOpts?.everyMs ?? SNAPSHOT_EVERY_MS;
	const publishRetryMs = publishOpts?.retryMs ?? SNAPSHOT_RETRY_MS;
	let publishing: Promise<void> | null = null;
	let publishRetryAt = 0;
	let publishHalted = false;
	const masterCell = raw.prepare(`SELECT value FROM sync_state WHERE map = 'settings' AND key = ?`).pluck();
	const masterCellNow = (): string | null => (masterCell.get(MASTER_DEVICE_SETTING) as string | undefined) ?? null;

	// This device IS the stated master (not merely "no master yet": the
	// server checks the same LWW cell and would refuse), the server and the
	// transport can take a snapshot, and one is due.
	const publishDue = (): boolean => {
		if (!publishOpts || publishing || detaching || publishHalted) return false;
		if (!features?.includes('snapshot_storage') || !transport.snapshots || !transport.sync.publishSnapshot) return false;
		if (masterDevice(raw) !== deviceId || Date.now() < publishRetryAt) return false;
		const rec = readPublishRecord(raw);
		if (rec?.refusedMaster && rec.refusedMaster === masterCellNow()) return false;
		const seq = readCursor(raw).lastSeq;
		if (seq < 1) return false;
		if (!rec || rec.seq < 1) return true;
		const req = readPublishRequest(raw);
		if (req && 'at' in req && seq > rec.seq) return true;
		if (seq - rec.seq >= publishEveryOps) return true;
		return seq > rec.seq && Date.now() - rec.at >= publishEveryMs;
	};

	const publishKind = (err: unknown): string => (err instanceof CloudTransportError ? err.kind : 'unknown');

	const publishOnce = async (): Promise<void> => {
		const session = transport.session();
		const store = transport.snapshots;
		const publish = transport.sync.publishSnapshot;
		if (!session || !store || !publish || !publishOpts) return;
		// The cheap half of the builder's preconditions on this connection
		// first, so a cycle that left an op waiting does not start a build
		// (a process) only to be told so.
		const c = { pending: 0, rejected: 0 };
		for (const r of counts.all() as Array<{ state: 'pending' | 'rejected'; n: number }>) c[r.state] = r.n;
		const held = heldCount(raw);
		if (c.pending > 0 || c.rejected > 0 || held > 0) {
			slog.debug('snapshot: not now', { pending: c.pending, rejected: c.rejected, held });
			return;
		}
		const asDevice = deviceId;
		const t0 = performance.now();
		const startedAt = Date.now();
		const built = await publishOpts.builder({ userId: session.userId });
		if (!built.ok) {
			slog.debug('snapshot: not now', { skipped: built.skipped, count: built.count });
			return;
		}
		if (built.digestOnly) return;
		try {
			if (await uploadAndPublish(built, asDevice, store, publish, t0)) {
				// A request made before this build is answered by it.
				const req = readPublishRequest(raw);
				if (req && 'at' in req && req.at <= startedAt) writePublishRequest(raw, null);
			}
		} finally {
			await rm(built.dir, { recursive: true, force: true }).catch((err: unknown) => slog.warn('snapshot: could not remove the build directory', undefined, err));
		}
	};

	const uploadAndPublish = async (
		built: SnapshotBuildOk,
		asDevice: string,
		store: SnapshotBlobStore,
		publish: NonNullable<CloudTransport['sync']['publishSnapshot']>,
		t0: number,
	): Promise<boolean> => {
		const facts = { snapshotSeq: built.snapshotSeq, parts: built.files.length, gzipBytes: built.manifest.totalBytes, jsonBytes: built.jsonBytes, records: built.records, buildMs: built.buildMs, ...(built.peakRssBytes ? { peakRssMb: Math.round(built.peakRssBytes / 1048576) } : {}) };
		// Stopped (the database may be closing) or unlinking (a new device id):
		// nothing more is read, uploaded or published.
		const halted = (): boolean => publishHalted || detaching || deviceId !== asDevice;
		if (halted()) return false;
		const rec = readPublishRecord(raw);
		if (rec && built.snapshotSeq <= rec.seq) { slog.debug('snapshot: nothing newer than the last publish', facts); return false; }
		const tUp = performance.now();
		let next = 0;
		const uploader = async (): Promise<void> => {
			for (let i = next++; i < built.files.length; i = next++) {
				if (halted()) return;
				await store.upload(built.manifest.parts[i]!.path, await readFile(built.files[i]!));
			}
		};
		await Promise.all(Array.from({ length: Math.min(SNAPSHOT_UPLOAD_CONCURRENCY, built.files.length) }, uploader));
		if (halted()) return false;
		const uploadMs = Math.round(performance.now() - tUp);
		let res: PublishSnapshotResult;
		try {
			res = await publish({ deviceId: asDevice, snapshotSeq: built.snapshotSeq, manifest: built.manifest });
		} catch (err) {
			if (err instanceof CloudTransportError && err.kind === 'not_master') {
				// The server's fold names another master than these records do
				// (a change this device has not pulled yet): no publish until
				// the master cell here changes.
				writePublishRecord(raw, { seq: rec?.seq ?? 0, at: rec?.at ?? 0, refusedMaster: masterCellNow(), orphans: rec?.orphans ?? [] });
				slog.warn('snapshot: the server says this device is not the master; not publishing until the master changes', facts);
				return false;
			}
			throw err;
		}
		if (res.features !== undefined) learnFeatures(res.features);
		// Superseded objects — pruned snapshots' parts, and on 'exists' /
		// 'stale' this upload's own parts no kept snapshot references — plus
		// any a failed delete left last time. A path a kept snapshot still
		// lists is never named (content addressing makes an unchanged leading
		// part the same object across builds).
		const doomed = [...new Set([...(rec?.orphans ?? []), ...res.superseded])];
		let orphans: string[] = [];
		if (doomed.length > 0) {
			try { await store.remove(doomed); } catch (err) {
				orphans = doomed;
				slog.warn('snapshot: could not delete superseded parts; retrying with the next publish', { count: doomed.length, kind: publishKind(err) }, err);
			}
		}
		// stored, exists (an earlier attempt's answer was lost) and stale (a
		// newer one is stored) all mean the account has a snapshot at least
		// this new: recorded, and the next is due from there.
		writePublishRecord(raw, { seq: Math.max(built.snapshotSeq, res.latestSeq), at: Date.now(), refusedMaster: null, orphans });
		slog.info('snapshot: published', { ...facts, status: res.status, latestSeq: res.latestSeq, superseded: res.superseded.length, uploadMs, ms: Math.round(performance.now() - t0) });
		return true;
	};

	// ── a secondary's digest check (the header) ─────────────────────────
	// Set by a drained pull that ended exactly at the master's newest
	// published snapshot; run after the cycle, beside it like the publish
	// (the build is the same utility process). A mismatch sets needsRepair:
	// the next cycle's pull reloads the snapshot from its seq.
	let digestDue: { seq: number; stateSha256: string } | null = null;
	let verifying: Promise<void> | null = null;
	const startDigestCheck = (): void => {
		const target = digestDue;
		digestDue = null;
		if (!target || verifying || publishing || detaching || publishHalted || !publishOpts) return;
		if (masterDevice(raw) === deviceId) return;
		if (readDigestRecord(raw)?.seq === target.seq) return;
		const c = { pending: 0, rejected: 0 };
		for (const r of counts.all() as Array<{ state: 'pending' | 'rejected'; n: number }>) c[r.state] = r.n;
		if (c.pending > 0 || c.rejected > 0 || heldCount(raw) > 0 || readClientState(raw).needsRepair) return;
		const session = transport.session();
		if (!session) return;
		verifying = (async () => {
			const r = await publishOpts.builder({ userId: session.userId, digestOnly: true });
			if (!r.ok) { slog.debug('digest check: not now', { skipped: r.skipped, count: r.count }); return; }
			if (!r.digestOnly) return;
			// The cursor moved on while the build ran: not the same state.
			if (r.snapshotSeq !== target.seq) { slog.debug('digest check: the cursor moved; skipped', { built: r.snapshotSeq, published: target.seq }); return; }
			const matched = r.stateSha256 === target.stateSha256;
			writeDigestRecord(raw, { seq: target.seq, at: Date.now(), matched });
			if (matched) {
				slog.info('digest check: this device\'s records match the master\'s snapshot', { seq: target.seq, records: r.records, buildMs: r.buildMs });
				return;
			}
			patchClientState({ needsRepair: true });
			slog.warn('digest check: this device\'s records differ from the master\'s snapshot — reloading it next cycle', { seq: target.seq, ours: r.stateSha256, master: target.stateSha256, records: r.records });
			wake('local');
		})()
			.catch((err: unknown) => { slog.warn('digest check failed; trying again at the next snapshot', { seq: target.seq }, err); })
			.finally(() => { verifying = null; emitStatus(); });
		emitStatus();
	};

	// ── outbox retention (outbox.ts) ────────────────────────────────────
	const retentionMs = opts.outboxRetentionMs ?? OUTBOX_RETENTION_MS;
	const pruneOutbox = (): void => {
		const pending = (raw.prepare(`SELECT count(*) FROM sync_outbox WHERE state = 'pending'`).pluck().get() as number);
		if (pending > 0) return;
		const n = pruneAckedOutbox(raw, { olderThanMs: retentionMs });
		if (n > 0) slog.info('outbox: deleted acked rows past retention', { deleted: n, retentionDays: Math.round(retentionMs / 86_400_000) });
	};

	// A cycle that ends while a publish runs asks again once it is done: the
	// publish under way is of an older seq, and without the recheck the
	// newer state would wait for the next cycle (a poll away when idle).
	let publishRecheck = false;
	const startPublish = (): void => {
		if (publishing) { publishRecheck = true; return; }
		publishRecheck = false;
		if (!publishDue()) return;
		const run = publishOnce()
			.catch((err: unknown) => {
				publishRetryAt = Date.now() + publishRetryMs;
				const kind = publishKind(err);
				// A part the server cannot see yet, a seq past what it shows,
				// the network, Storage: all worth another try later.
				slog.warn('snapshot: publish failed; retrying later', { kind, retryInMs: publishRetryMs }, err);
			})
			.finally(() => {
				publishing = null;
				if (publishRecheck && !running) startPublish();
				emitStatus();
			});
		publishing = run;
		emitStatus();
	};

	// ── cycle + scheduling ──────────────────────────────────────────────

	const clearRetry = (): void => {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		nextRetryAt = null;
	};

	const scheduleRetry = (minMs = 0): void => {
		attempt++;
		const exp = Math.min(backoffCap, backoffBase * 2 ** (attempt - 1));
		// "Equal jitter": half fixed, half random, so retries from many
		// devices after an outage spread out but never collapse to zero.
		const delay = Math.min(backoffCap, Math.max(minMs, exp / 2 + random() * (exp / 2)));
		clearRetry();
		nextRetryAt = Date.now() + delay;
		if (!stopped) {
			retryTimer = setTimeout(() => {
				retryTimer = null;
				nextRetryAt = null;
				reasons.add('retry');
				void cycle();
			}, delay);
			retryTimer.unref?.();
		}
	};

	const describe = (err: unknown): string => {
		if (err instanceof CloudTransportError) {
			switch (err.kind) {
				case 'network': return 'Offline — changes will sync when the connection is back.';
				case 'server': return 'The sync server had a problem; retrying.';
				case 'rate_limited': return 'Syncing too fast; slowing down.';
				case 'auth': return 'Your session expired — sign in again.';
				case 'update_required': return 'Update Curator to keep syncing.';
				case 'device_revoked': return REVOKED_MESSAGE;
				case 'device_not_registered': return 'Registering this device with your account.';
				case 'batch_gone': return 'The server dropped an unfinished upload; sending it again.';
				case 'batch_committing': return 'The server is still publishing your upload.';
				case 'not_master': return 'Only the account master publishes the library snapshot.';
				case 'snapshot_ahead':
				case 'snapshot_part_missing':
				case 'snapshot_part_invalid': return 'The library snapshot upload did not go through; retrying later.';
				case 'bad_request': return `The sync server refused a request (${err.message}).`;
			}
		}
		return err instanceof Error ? err.message : String(err);
	};

	const takeReason = (): string => {
		const r = [...reasons].join('+') || 'unknown';
		reasons.clear();
		pingTop = 0;
		pingUnnumbered = false;
		return r;
	};

	// Only the pull cursor says what this device holds. Not a push's
	// `maxSeq` / `batchMaxSeq`: while a batch commits, the head runs past
	// the fence pulls stop at (cloud sync/pull.ts), and a ping skipped on
	// that number would be the batch's publish — missed until the next poll.
	// The pusher's own ping still lands at or below the cursor: every push
	// is followed by a pull in the same cycle, which carries the cursor
	// past it.
	const pingSeen = (seq: number): boolean => seq <= readCursor(raw).lastSeq;

	// Every reason waiting is a numbered Realtime ping the cursor has
	// already passed: the cycle would pull nothing. Clears them when so.
	const dropStalePings = (): boolean => {
		if (reasons.size === 0 || pingUnnumbered) return false;
		for (const r of reasons) if (r !== 'realtime') return false;
		if (!pingSeen(pingTop)) return false;
		slog.debug('realtime wake already pulled; no cycle', { seq: pingTop });
		reasons.clear();
		pingTop = 0;
		return true;
	};

	const runOnce = async (): Promise<void> => {
		if (reasons.has('network')) reconnectOwed = true;
		const reason = takeReason();
		const session = transport.session();
		if (!session) {
			clearRetry();
			attempt = 0;
			lastError = null;
			return;
		}
		// unlink is detaching this install: nothing may reach the server
		// until it has signed out under the new id.
		if (detaching) return;
		const bindingError = checkBinding(session);
		if (bindingError) { lastError = bindingError; return; }
		// Revoked: no call at all, push or pull. The poll keeps waking this,
		// at no cost, until unlink.
		if (isRevoked()) { lastError = REVOKED_MESSAGE; clearRetry(); attempt = 0; return; }
		const t: CycleTally = { pushed: 0, rejected: 0, held: 0, pulled: 0, applied: 0, bootstrapped: false, snapshotRecords: 0 };
		tally = t;
		commitWaited.clear();
		const started = Date.now();
		let outcome = 'ok';
		try {
			await ensureRegistered(session);
			if ((await runInitialPush()) === 'waiting') {
				waitingForSnapshot = true;
				if (!waitingLogged) {
					waitingLogged = true;
					slog.info('waiting for the account\'s snapshot: the account has ops but no published base yet; asking again each cycle');
				}
				outcome = 'waiting';
				return;
			}
			waitingForSnapshot = false;
			await stage('provider claims', reconcileClaims);
			// Claims made here since the last cycle (and by the backfills just
			// above) resolve before the push carries them.
			await resolveIdentities();
			// Push first (design "Offline": on reconnect push, then pull).
			if ((await pushAll()) === 'device_revoked') { outcome = 'device_revoked'; return; }
			// Base metadata and the default master, once the server is known
			// to read them (a push or pull answer this session said so): after
			// the push that may have just told us, and pushed before the pull,
			// so the cursor ends the cycle at the head. A session whose first
			// cycle had nothing to push learns it from the pull and states them
			// on the next cycle.
			const metaStage = async (): Promise<void> => {
				await stage('master device', ensureMaster);
				await stage('track meta', syncTrackMeta);
				await stage('provider claims (v4)', reconcileClaims);
				await stage('zero-loss v4', syncV4);
				await stage('analysis v5', syncV5);
				if ((await pushAll()) === 'device_revoked') outcome = 'device_revoked';
			};
			const metaBeforePull = serverReadsTrackMeta(features) && !pushRefused;
			const v4BeforePull = featuresReadV4(features);
			const v5BeforePull = featuresReadV5(features);
			if (metaBeforePull) await metaStage();
			if (outcome === 'device_revoked') return;
			await pullOnce();
			// Claims from other devices; merges it emits wake the next cycle's
			// push through the outbox listener.
			await resolveIdentities();
			await sweepStreamingDuplicates();
			await stage('remote rows', settleRemoteRows);
			await stage('play history heal', healPlayHistory);
			await stage('feed decisions', applyFeedDecisions);
			// The pull was what told this session the server reads v3 (the
			// push before it had nothing to send): the meta stage runs now,
			// and one more pull brings the cursor back to the head past this
			// device's own new ops (the server leaves them out).
			// Likewise when the pull was the first answer naming protocol v4 (a
			// server upgraded since the last push): the v4 statements go now,
			// not a poll later.
			if (((!metaBeforePull && serverReadsTrackMeta(features)) || (!v4BeforePull && featuresReadV4(features)) || (!v5BeforePull && featuresReadV5(features))) && !pushRefused) {
				await metaStage();
				if (outcome === 'device_revoked') return;
				await pullOnce();
			}
			lastError = null;
			attempt = 0;
			clearRetry();
			pruneOutbox();
			if (pullReachedHead) { startPublish(); startDigestCheck(); }
		} catch (err) {
			if (err instanceof SyncRecordsIncompleteError) {
				// The records-complete marker vanished under us (a restore?):
				// the next cycle states the library again.
				slog.warn('pull refused: records incomplete — stating the library again next cycle');
			}
			lastError = describe(err);
			outcome = err instanceof CloudTransportError ? err.kind : 'error';
			// The server no longer reads what this device last heard it read (a
			// rolled-back server refusing a v4 op, whole call): stop sending v4
			// until an answer names it again, so the rest of the outbox flows.
			// The refused push names how far: below the newest version it sent
			// (a v5 op refused leaves v4 standing; a v4 one refused, v5 goes too).
			if (err instanceof CloudTransportError && err.kind === 'server' && /server_outdated/.test(err.message)) {
				if (sentVersion >= 5 && featuresReadV5(features)) {
					features = (features ?? []).filter((f) => f !== ANALYSIS_FEATURE);
					slog.warn('the server refused protocol v5 ops; holding them until it reads v5 again');
				} else if (featuresReadV4(features)) {
					features = (features ?? []).filter((f) => f !== 'zero_loss_v4' && f !== ANALYSIS_FEATURE);
					recordServerV4(raw, false);
					slog.warn('the server refused protocol v4 ops; holding them until it reads v4 again');
				}
			}
			if (err instanceof CloudTransportError && err.kind === 'update_required') { pushRefused = true; return; }
			if (err instanceof CloudTransportError && err.kind === 'device_revoked') { markRevoked(); return; }
			// Re-register on the next attempt (the backoff's first step is short).
			if (err instanceof CloudTransportError && err.kind === 'device_not_registered') patchClientState({ registeredFor: null });
			slog.warn('sync cycle failed; backing off', { attempt: attempt + 1, kind: err instanceof CloudTransportError ? err.kind : 'unknown' }, err);
			scheduleRetry(err instanceof CloudTransportError ? err.retryAfterMs ?? 0 : 0);
		} finally {
			tally = null;
			// One line per cycle. An idle poll (nothing moved, no error) is
			// debug: at the 60 s interval it would be ~1,440 info lines a day
			// saying nothing. Anything that moved or failed is info.
			const moved = t.pushed + t.rejected + t.held + t.pulled > 0 || t.bootstrapped;
			const fields = { reason, outcome, pushed: t.pushed, rejected: t.rejected, held: t.held, pulled: t.pulled, applied: t.applied, bootstrapped: t.bootstrapped, snapshotRecords: t.snapshotRecords, needsUpdate: pushRefused || heldCount(raw) > 0, ms: Date.now() - started };
			// A reconnect's cycle is info even when quiet: it is the line that
			// says the device caught up after the outage.
			if (moved || outcome !== 'ok' || reconnectOwed) slog.info('sync cycle', fields);
			else slog.debug('sync cycle', fields);
			// Only a cycle that went through (a failure leaves it owed): the
			// renderer asks again for what the player is missing.
			if (reconnectOwed && outcome === 'ok' && lastError === null) {
				reconnectOwed = false;
				emit({ kind: 'reconnected', at: Date.now() });
			}
		}
	};

	const cycle = async (): Promise<void> => {
		if (running) { again = true; return inflight ?? undefined; }
		running = true;
		emitStatus();
		inflight = (async () => {
			try {
				do {
					again = false;
					await runOnce();
				// A ping that came in mid-cycle (most often this device's own
				// push ringing back before its answer) reruns only if the pull
				// just done did not already pass it.
				} while (again && nextRetryAt === null && !dropStalePings());
			} finally {
				running = false;
				moving = false;
				inflight = null;
				emitStatus();
			}
		})();
		return inflight;
	};

	const wake = (reason: WakeReason = 'manual', seq?: number): void => {
		// A regained network or a new session is a reason to stop waiting out
		// a backoff; a Realtime ping or a focus is not (the outage that caused
		// it is likely still there, and the retry timer will run anyway).
		if (reason === 'network' || reason === 'session' || reason === 'manual') { attempt = 0; clearRetry(); }
		// The cycle this wakes is the check the outage postponed: the next
		// poll counts from it, not from a tick that fell while offline.
		if (reason === 'network' && !stopped) { pollBase = Date.now(); armPoll(); }
		if (nextRetryAt !== null) return;
		if (reason === 'realtime') {
			const numbered = typeof seq === 'number' && Number.isFinite(seq);
			// Own pushes ring back to the pusher: without this, every push
			// cost a second, empty cycle.
			if (numbered && pingSeen(seq)) return;
			if (numbered) pingTop = Math.max(pingTop, seq);
			else pingUnnumbered = true;
		}
		reasons.add(reason);
		// Coalesce into the pending timer rather than restarting it: a long
		// burst of local writes (an import) must not postpone the push for as
		// long as it lasts. Wakes during a running cycle rerun it (`again`).
		if (debounceTimer) return;
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			// The pings that set this timer may have been pulled meanwhile
			// (a cycle was running when they came).
			if (dropStalePings()) return;
			void cycle();
		}, debounceMs);
		debounceTimer.unref?.();
	};

	// ── unlink ──────────────────────────────────────────────────────────

	const unlink = async (): Promise<UnlinkOutcome> => {
		detaching = true;
		try {
			clearRetry();
			if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
			// A cycle already past the `detaching` check finishes first; one
			// woken meanwhile returns at it.
			while (inflight) await inflight.catch(() => { /* reported by the cycle */ });
			// A snapshot publish stops at its next step (`detaching`); a digest
			// check is a read and finishes.
			while (publishing) await publishing;
			while (verifying) await verifying;
			const session = transport.session();
			const st = readClientState(raw);
			let revokedOnServer = false;
			// Revoke the old id so the account's list stops showing it as live,
			// and so its session — which is ending anyway — is refused if a
			// copy of it is still out there. Best effort: offline, the user
			// can remove it from another computer.
			if (session && !isRevoked(st) && st.registeredFor === session.userId) {
				try {
					await transport.account.revokeDevice({ deviceId });
					revokedOnServer = true;
				} catch (err) {
					slog.warn('unlink: could not revoke this device on the account; another computer can remove it', { kind: err instanceof CloudTransportError ? err.kind : 'unknown' }, err);
				}
			}
			if (session) await transport.signOut();
			const r = remintDeviceForDetach(raw);
			deviceId = r.newDeviceId;
			// remint reset registeredFor and ownThroughSeq; the revoked mark
			// was the old id's and goes with it.
			patchClientState({ revoked: null });
			forgetFeatures();
			lastError = null;
			pushRefused = false;
			attempt = 0;
			slog.info('unlinked this install from its account', { oldDeviceId: r.oldDeviceId, newDeviceId: r.newDeviceId, restamped: r.restamped, revokedOnServer, signedOut: session !== null });
			return { revokedOnServer, signedOut: session !== null, oldDeviceId: r.oldDeviceId, newDeviceId: r.newDeviceId, restamped: r.restamped };
		} finally {
			detaching = false;
			emitStatus();
		}
	};

	const syncNow = async (): Promise<void> => {
		attempt = 0;
		clearRetry();
		pushRefused = false;
		reasons.add('manual');
		if (running) {
			again = true;
			await inflight;
			if (running) await inflight;
			return;
		}
		await cycle();
	};

	// Idle decays the poll only while the Realtime channel is joined: without
	// it the poll is the only way a change from another device arrives, and
	// it must arrive within a minute (2026-10-23).
	const pollEverySec = (): number => (active || !realtimeLive ? pollPolicy.activeSec : pollPolicy.idleSec);
	const pollPeriodMs = (): number => pollEverySec() * 1000;

	const clearPoll = (): void => {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
		nextPollAt = null;
	};

	// (Re)arms the fallback poll for one period after `pollBase`. A due time
	// already past (the period was just shortened) polls now rather than
	// waiting out the old timer.
	const armPoll = (): void => {
		clearPoll();
		if (stopped) return;
		const now = Date.now();
		const due = Math.max(now, pollBase + pollPeriodMs());
		nextPollAt = due;
		pollTimer = setTimeout(() => {
			pollTimer = null;
			pollBase = Date.now();
			wake('interval');
			armPoll();
		}, due - now);
		pollTimer.unref?.();
	};

	const cadenceFields = (): Record<string, unknown> => ({ everySec: pollEverySec(), realtimeLive, ...pollPolicy });

	const setPollPolicy = (p: Partial<SyncPollPolicy>): void => {
		const next = normalizePollPolicy({ ...pollPolicy, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) });
		if (samePollPolicy(next, pollPolicy)) return;
		pollPolicy = next;
		slog.info('poll cadence changed', { active, ...cadenceFields() });
		armPoll();
		emitStatus();
	};

	const setActive = (next: boolean): void => {
		if (next === active) return;
		active = next;
		// One line per switch, never per tick.
		slog.info(next ? 'poll cadence: in use' : 'poll cadence: idle', cadenceFields());
		if (next) {
			// Back in use: whatever arrived while idle is fetched now, and
			// the active period counts from here.
			pollBase = Date.now();
			if (!stopped) wake('resume');
		}
		armPoll();
		emitStatus();
	};

	const setRealtimeLive = (next: boolean): void => {
		if (next === realtimeLive) return;
		realtimeLive = next;
		slog.info(`realtime wake channel ${next ? 'live' : 'down'} — polling every ${pollEverySec()}s`, cadenceFields());
		// Pings broadcast while the channel was down never reached this
		// device: one cycle picks up whatever they announced.
		if (next && !stopped) wake('rejoin');
		// Down while idle: the period shrinks, and a due time already past
		// polls now.
		armPoll();
		emitStatus();
	};

	return {
		pushOnce,
		pullOnce,
		bootstrap,
		runInitialPush: async () => { await runInitialPush(); },
		syncNow,
		wake,
		setPollPolicy,
		setActive,
		setRealtimeLive,
		start() {
			if (!stopped) return;
			stopped = false;
			publishHalted = false;
			unsubOutbox = onOutboxAppend(raw, () => wake('local'));
			pollBase = Date.now();
			armPoll();
			wake('session');
		},
		stop() {
			stopped = true;
			// A publish under way stops at its next step: the database may be
			// about to close.
			publishHalted = true;
			unsubOutbox?.();
			unsubOutbox = null;
			clearPoll();
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = null;
			clearRetry();
		},
		status,
		serverFeatures: () => (isRevoked() ? null : features),
		deviceId: () => deviceId,
		unlink,
		subscribe(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
	};
}
