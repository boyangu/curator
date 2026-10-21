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
//     A `snapshotSeq` hint means "too far behind": bootstrap from the
//     snapshot instead.
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
//   - A library is bound to the first account that syncs it. Signing in as
//     someone else does not merge two people's libraries; it reports an error.
//   - Reads name the device when the server offers 'device_reads'. A
//     `device_revoked` answer on anything (push, pull, bootstrap,
//     registration) is final for this device id: the client records it and
//     stops pushing AND pulling — no further calls — until `unlink` detaches
//     the install (a fresh device id, signed out; local data untouched).
//
// The transport is a port: the desktop main injects an HTTP/tRPC transport
// holding the Supabase session; tests inject an in-memory fake server.

import type Database from 'better-sqlite3';
import {
	MAX_PULL_OPS,
	MAX_PUSH_BYTES,
	MAX_PUSH_OPS,
	OpValidationError,
	parseOp,
	schemaVersionStatus,
	utf8ByteLength,
	type CloudService,
	type DevicePlatform,
	type EntityRef,
	type Op,
	type BootstrapInput,
	type PullInput,
	type PullResult,
	type RejectReason,
	type StoredOp,
	type SyncFeature,
} from '@curator/protocol';
import type { AreaLogger } from '@curator/shared/log';
import { log } from '../log.js';
import { artistCreditRewritePending, drainArtistCreditRewritesAsync } from '../library/artist-alias.js';
import { applyOps, INITIAL_PUSH_KEY, recordsComplete, SyncRecordsIncompleteError, type ApplyOutcome } from './apply.js';
import { getDeviceId } from './device.js';
import { heldCount, holdOps, replayHeldOps } from './held.js';
import { claimsBackfillAsync, claimsBackfillPending, initialPushAsync, rbBackfillAsync, rbBackfillPending, type InitialPushAsyncResult, type InitialPushProgress } from './initial-push.js';
import { resolveRecordingIdentitiesAsync } from './identity.js';
import { CLOCK_KEY, observeServerTs, onOutboxAppend } from './outbox.js';
import { healAfterApply, streamingDedupeSwept, type DedupeResult, sweepStreamingDuplicatesAsync } from './playlist-dedupe.js';
import { normalizePollPolicy, samePollPolicy, type SyncPollPolicy } from './poll-policy.js';
import { remintDeviceForDetach } from './remint.js';
import { derivePendingCount, drainTrackDerivationsAsync, materializeSwept, remotePendingCount } from './remote-rows.js';
import { drainRemotePendingAsync, sweepRemoteRowsAsync } from './remote-sweep.js';
import { claimLinkPendingCount, claimLinksSwept, drainClaimLinksAsync, sweepClaimLinksAsync } from './claim-links.js';
import { loadSnapshot, type SnapshotRecord } from './snapshot.js';
import {
	defaultMasterDevice, drainTrackMetaAsync, masterDevice, queueTrackMetaBackfillAsync, serverReadsTrackMeta, setMasterDevice, trackMetaBackfillPending, trackMetaDirtyCount,
} from './track-meta.js';

type Raw = Database.Database;

// ── port ────────────────────────────────────────────────────────────────────

export type CloudSession = { userId: string; email: string | null };

// The protocol's `sync` + `account` procedures and who is signed in (the
// session lives with the transport, in desktop main). `sync.bootstrap` is
// lifted out and returned decoded: the wire carries base64 gzip of the
// serialised state, and inflating it (node:zlib, off the JS thread) is the
// transport's job — the client only needs the records and their seq.
export interface CloudTransport {
	sync: Pick<CloudService['sync'], 'push' | 'pull'>;
	account: CloudService['account'];
	bootstrap(input?: BootstrapInput): Promise<{ snapshotSeq: number; records: readonly SnapshotRecord[] }>;
	session(): CloudSession | null;
	// Ends this install's session (Supabase scope 'local'; other devices stay
	// signed in). `unlink` calls it so the detached library cannot re-bind on
	// the next wake-up.
	signOut(): Promise<void>;
	// The shared analysis catalogue's procedures (apps/core/src/catalogue/).
	// Optional: without them (or without a blob store beside them) the
	// catalogue layer is simply not built.
	catalogue?: CloudService['catalogue'];
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
	// Set while the first-sign-in push of the existing library runs.
	initialPush: InitialPushProgress | null;
	// Set while a snapshot is being loaded.
	bootstrap: { done: number; total: number } | null;
	running: boolean;
	// When the next retry fires after a transient failure.
	nextRetryAt: number | null;
	// The fallback poll: the cadence in force, whether the host reports the
	// app in use (false = the idle cadence applies), and when it next fires.
	poll: { policy: SyncPollPolicy; active: boolean; nextPollAt: number | null };
};

export type CloudSyncApplied = {
	// Local track ids whose visible rows changed, and playlists whose
	// membership changed — what the renderer refreshes.
	tracks: string[];
	playlists: string[];
	// The entities that changed (capped; containers drive sidebar refreshes).
	entities: EntityRef[];
};

export type CloudSyncEvent =
	| { kind: 'status'; status: CloudSyncStatus }
	| { kind: 'applied'; applied: CloudSyncApplied };

// 'resume': the host reported the app back in use after an idle spell.
export type WakeReason = 'realtime' | 'focus' | 'network' | 'session' | 'local' | 'interval' | 'resume' | 'manual';
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
	// Ops per apply transaction within a pulled page, fixed (PULL_SLICE_MS).
	pullApplyChunk?: number;
	random?: () => number;
	// Test seam: runs inside a pull page's last transaction (the one that
	// moves the cursor) after its apply, with the whole page — throwing here
	// is a crash mid-page.
	beforeCursorAdvance?: (page: StoredOp[]) => void;
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
	bootstrap(opts?: { resetCursor?: boolean }): Promise<void>;
	runInitialPush(): Promise<void>;
	// One full cycle now: register, initial push, push until drained, pull
	// until drained. Resets any backoff. Resolves when the cycle is done.
	syncNow(): Promise<void>;
	// Debounced cycle trigger for wake-ups (Realtime, focus, network, local
	// writes, the fallback poll).
	wake(reason?: WakeReason): void;
	// The fallback poll's cadence. Applies at once: the next poll is due one
	// (new) interval after the previous one, or now if that has passed.
	setPollPolicy(policy: Partial<SyncPollPolicy>): void;
	// The host's verdict on whether the app is in use. Idle → in use syncs
	// once right away ('resume') and returns to the active cadence.
	setActive(active: boolean): void;
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

// Set when a pull first reached the head of the log (or a snapshot loaded):
// from then on this device's records hold every claim the account had, so
// a streaming import binds to the recordings other desktops hold instead of
// minting its own (claim-bind.ts). Device-local; never an account key.
export const FIRST_PULL_KEY = 'sync.first_pull_at';

export function firstPullDone(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(FIRST_PULL_KEY) !== undefined;
}

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
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	// When the current poll period started counting (start, last poll, or a
	// return to use).
	let pollBase = 0;
	let nextPollAt: number | null = null;
	// Why the next cycle runs; taken (and cleared) when a cycle starts.
	const reasons = new Set<CycleReason>();
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
			needsUpdate: pushRefused || heldCount(raw) > 0,
			revoked: isRevoked(st),
			boundUserId: st.userId,
			initialPushDone: raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY) !== undefined,
			initialPush: initialPushProgress,
			bootstrap: bootstrapProgress,
			running,
			nextRetryAt,
			poll: { policy: { ...pollPolicy }, active, nextPollAt },
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

	const pendingStmt = raw.prepare(`SELECT op_id, device_id, client_ts, schema_version, entity, entity_id, kind, payload
		FROM sync_outbox WHERE state = 'pending' ORDER BY seq_local LIMIT ?`);
	const markAcked = raw.prepare(`UPDATE sync_outbox SET state = 'acked', reason = NULL WHERE op_id = ? AND state = 'pending'`);
	const markRejected = raw.prepare(`UPDATE sync_outbox SET state = 'rejected', reason = ? WHERE op_id = ? AND state = 'pending'`);

	const pushOnce = async (): Promise<PushOutcome> => {
		const rows = pendingStmt.all(MAX_PUSH_OPS) as OutboxRow[];
		if (rows.length === 0) return { pushed: 0, rejected: 0, more: false, stopped: null };
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
		if (ops.length > 0) markMoving();
		const res = await transport.sync.push({ deviceId, ops });
		learnFeatures(res.features);
		const rejected = new Map<string, RejectReason>(res.rejected.map((r) => [r.opId, r.reason]));
		const clampedTs = new Map((res.clamped ?? []).map((c) => [c.opId, c.clientTs]));
		let held: PushOutcome['stopped'] = null;
		let nAcked = 0;
		let nRejected = 0;
		let nHeld = 0;
		let restamp: ApplyOutcome | null = null;
		raw.transaction(() => {
			const restamped: Op[] = [];
			for (const op of ops) {
				const reason = rejected.get(op.op_id);
				if (reason === undefined) {
					markAcked.run(op.op_id);
					nAcked++;
					const ts = clampedTs.get(op.op_id);
					if (ts !== undefined && ts !== op.client_ts) restamped.push({ ...op, client_ts: ts } as Op);
					continue;
				}
				// Not the op's fault: keep it pending for after the update /
				// for a device that is re-admitted.
				if (reason === 'update_required' || reason === 'device_revoked') { held = reason; nHeld++; continue; }
				markRejected.run(reason, op.op_id);
				nRejected++;
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
			// ownThroughSeq follows the batch only when nothing stamped with
			// this device id lies above it outside the batch (ClientState).
			const through = st.ownThroughSeq ?? 0;
			if (res.batchMaxSeq !== undefined && res.priorOwnMaxSeq !== undefined && res.priorOwnMaxSeq <= through && res.batchMaxSeq > through) {
				next.ownThroughSeq = res.batchMaxSeq;
			}
			if (next.needsRepair !== st.needsRepair || next.ownThroughSeq !== st.ownThroughSeq) writeClientState(raw, next);
		})();
		const r = restamp as ApplyOutcome | null;
		if (r && r.restamped > 0) {
			slog.warn('push: the server clamped own ops (clock skew) — re-stamped; the next pull reloads the snapshot to repair', { count: r.restamped });
			emitApplied(r.tracksTouched, r.playlistsTouched, r.changed);
		}
		if (tally) { tally.pushed += nAcked; tally.rejected += nRejected; tally.held += nHeld; }
		if (nRejected > 0) slog.warn('push: ops rejected', { count: nRejected, sample: res.rejected.slice(0, 5) });
		patchClientState(nAcked > 0 ? { lastPushAt: Date.now(), lastChangedAt: Date.now() } : { lastPushAt: Date.now() });
		if (held === 'update_required') pushRefused = true;
		if (held === 'device_revoked') markRevoked();
		const full = rows.length === MAX_PUSH_OPS || ops.length < rows.length;
		return { pushed: nAcked, rejected: nRejected, more: held === null && full, stopped: held };
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
	const pullOnce = async (): Promise<PullOutcome> => {
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
				if (res.ops.length === 0) {
					if (readClientState(raw).needsRepair && !out.bootstrapped) {
						slog.warn('own ops were re-stamped by the server (clock skew) — reloading the snapshot to repair');
						await bootstrap({ resetCursor: true });
						patchClientState({ needsRepair: false });
						out.bootstrapped = true;
						continue;
					}
					// Drained. An empty page can still move the cursor (a run of
					// own ops the server left out), and everything up to the
					// cursor is now held here, so ownThroughSeq follows it.
					raw.transaction(() => {
						const at = Math.max(res.nextSeq, cursor.lastSeq);
						if (at > cursor.lastSeq) writeCursor(raw, at);
						const st = readClientState(raw);
						if (at > (st.ownThroughSeq ?? 0)) writeClientState(raw, { ...st, ownThroughSeq: at });
						markFirstPull(raw);
					})();
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

	// `resetCursor`: replay from the snapshot's seq even when the cursor is
	// past it (the clamp repair), instead of keeping the further cursor.
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

	const bootstrap = async (bopts: { resetCursor?: boolean } = {}): Promise<void> => {
		const b = await fetchSnapshot();
		const records = b.records;
		if (tally) { tally.bootstrapped = true; tally.snapshotRecords += records.length; }
		slog.info('bootstrap: loading snapshot', { records: records.length, snapshotSeq: b.snapshotSeq });
		bootstrapProgress = { done: 0, total: records.length };
		emitStatus();
		try {
			const res = await loadSnapshot(raw, records, {
				onProgress: (p) => { bootstrapProgress = p; emitStatus({ progress: true }); },
			});
			const cursor = readCursor(raw);
			raw.transaction(() => {
				writeCursor(raw, bopts.resetCursor ? b.snapshotSeq : Math.max(cursor.lastSeq, b.snapshotSeq), b.snapshotSeq);
				markFirstPull(raw);
			})();
			slog.info('bootstrap: done', { changed: res.changed, chunks: res.chunks, maxSliceMs: Math.round(res.maxSliceMs) });
			emitApplied(res.tracksTouched, res.playlistsTouched, res.changedRefs);
		} finally {
			bootstrapProgress = null;
			emitStatus();
		}
	};

	// ── initial push ────────────────────────────────────────────────────

	const initialPushDone = (): boolean => raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(INITIAL_PUSH_KEY) !== undefined;
	let initialPushRun: Promise<void> | null = null;
	type Driver = (r: Raw, o: { chunk?: number; onProgress?: (p: InitialPushProgress) => void }) => Promise<InitialPushAsyncResult>;
	const runInitialPush = (): Promise<void> => {
		// A library pushed before rekordbox units, or before recordings and
		// their claims, were emitted states them once, through the same
		// chunked driver (initial-push.ts).
		const runs: Array<[string, Driver]> = initialPushDone()
			? [
				...(rbBackfillPending(raw) ? [['rekordbox analysis backfill: done', rbBackfillAsync] as [string, Driver]] : []),
				...(claimsBackfillPending(raw) ? [['recording claims backfill: done', claimsBackfillAsync] as [string, Driver]] : []),
			]
			: [['initial push: done', initialPushAsync]];
		if (runs.length === 0) return Promise.resolve();
		if (!initialPushRun) {
			initialPushRun = (async () => {
				initialPushProgress = { done: 0, estimate: 0 };
				emitStatus();
				try {
					for (const [done, drive] of runs) {
						const r = await drive(raw, {
							chunk: opts.initialPushChunk,
							onProgress: (p) => { initialPushProgress = p; emitStatus({ progress: true }); },
						});
						slog.info(done, { ops: r.ops, chunks: r.chunks, ms: r.ms, maxSliceMs: Math.round(r.maxSliceMs) });
					}
				} finally {
					initialPushProgress = null;
					initialPushRun = null;
					emitStatus();
				}
			})();
		}
		return initialPushRun;
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

	// This device's own rows' meta, once the server reads v3: the one-time
	// backfill queues every row, the drain states what changed.
	const syncTrackMeta = async (): Promise<number> => {
		if (!serverReadsTrackMeta(features) || !recordsComplete(raw)) return 0;
		if (trackMetaBackfillPending(raw)) {
			const queued = await queueTrackMetaBackfillAsync(raw);
			slog.info('track meta: queued every own row for the one-time backfill', { rows: queued });
		}
		if (trackMetaDirtyCount(raw) === 0) return 0;
		const r = await drainTrackMetaAsync(raw);
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

	const stage = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
		try { await fn(); } catch (err) { slog.warn(`${name} failed; retrying next cycle`, undefined, err); }
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
				case 'bad_request': return `The sync server refused a request (${err.message}).`;
			}
		}
		return err instanceof Error ? err.message : String(err);
	};

	const takeReason = (): string => {
		const r = [...reasons].join('+') || 'unknown';
		reasons.clear();
		return r;
	};

	const runOnce = async (): Promise<void> => {
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
		const started = Date.now();
		let outcome = 'ok';
		try {
			await ensureRegistered(session);
			await runInitialPush();
			// Claims made here since the last cycle (and by the backfills just
			// above) resolve before the push carries them.
			await resolveIdentities();
			// Push first (design "Offline": on reconnect push, then pull).
			while (!pushRefused) {
				const p = await pushOnce();
				if (p.stopped === 'device_revoked') { outcome = 'device_revoked'; return; }
				if (!p.more) break;
			}
			// Base metadata and the default master, once the server is known
			// to read them (a push or pull answer this session said so): after
			// the push that may have just told us, and pushed before the pull,
			// so the cursor ends the cycle at the head. A session whose first
			// cycle had nothing to push learns it from the pull and states them
			// on the next cycle.
			const metaStage = async (): Promise<void> => {
				await stage('master device', ensureMaster);
				await stage('track meta', syncTrackMeta);
				while (!pushRefused) {
					const p = await pushOnce();
					if (p.stopped === 'device_revoked') { outcome = 'device_revoked'; return; }
					if (!p.more) break;
				}
			};
			const metaBeforePull = serverReadsTrackMeta(features) && !pushRefused;
			if (metaBeforePull) await metaStage();
			if (outcome === 'device_revoked') return;
			await pullOnce();
			// Claims from other devices; merges it emits wake the next cycle's
			// push through the outbox listener.
			await resolveIdentities();
			await sweepStreamingDuplicates();
			await stage('remote rows', settleRemoteRows);
			// The pull was what told this session the server reads v3 (the
			// push before it had nothing to send): the meta stage runs now,
			// and one more pull brings the cursor back to the head past this
			// device's own new ops (the server leaves them out).
			if (!metaBeforePull && serverReadsTrackMeta(features) && !pushRefused) {
				await metaStage();
				if (outcome === 'device_revoked') return;
				await pullOnce();
			}
			lastError = null;
			attempt = 0;
			clearRetry();
		} catch (err) {
			if (err instanceof SyncRecordsIncompleteError) {
				// The initial-push marker vanished under us (a restore?): the
				// next cycle runs the push again.
				slog.warn('pull refused: records incomplete — re-running the initial push next cycle');
			}
			lastError = describe(err);
			outcome = err instanceof CloudTransportError ? err.kind : 'error';
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
			if (moved || outcome !== 'ok') slog.info('sync cycle', fields);
			else slog.debug('sync cycle', fields);
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
				} while (again && nextRetryAt === null);
			} finally {
				running = false;
				moving = false;
				inflight = null;
				emitStatus();
			}
		})();
		return inflight;
	};

	const wake = (reason: WakeReason = 'manual'): void => {
		// A regained network or a new session is a reason to stop waiting out
		// a backoff; a Realtime ping or a focus is not (the outage that caused
		// it is likely still there, and the retry timer will run anyway).
		if (reason === 'network' || reason === 'session' || reason === 'manual') { attempt = 0; clearRetry(); }
		if (nextRetryAt !== null) return;
		reasons.add(reason);
		// Coalesce into the pending timer rather than restarting it: a long
		// burst of local writes (an import) must not postpone the push for as
		// long as it lasts. Wakes during a running cycle rerun it (`again`).
		if (debounceTimer) return;
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
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

	const pollPeriodMs = (): number => (active ? pollPolicy.activeSec : pollPolicy.idleSec) * 1000;

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

	const cadenceFields = (): Record<string, unknown> => ({ everySec: active ? pollPolicy.activeSec : pollPolicy.idleSec, ...pollPolicy });

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

	return {
		pushOnce,
		pullOnce,
		bootstrap,
		runInitialPush,
		syncNow,
		wake,
		setPollPolicy,
		setActive,
		start() {
			if (!stopped) return;
			stopped = false;
			unsubOutbox = onOutboxAppend(raw, () => wake('local'));
			pollBase = Date.now();
			armPoll();
			wake('session');
		},
		stop() {
			stopped = true;
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
