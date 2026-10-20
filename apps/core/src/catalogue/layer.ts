// CatalogueLayer — this device's side of the shared analysis catalogue
// (workstream D, phase 1; plan cloud-catalogue-phase1.md "Desktop"). One
// account, its own devices: what one machine analysed, another reuses.
//
// Four jobs, one module (service.ts delegates, like MirLayer):
//
//   inventory  pages of the account's holdings after the last rev seen, into
//              the local mirror (`catalogue_entry`). Carries the server's
//              policy (the D-a / D-b stage) and the account's entitlement and
//              quota. Nothing here moves a unit the policy does not allow.
//   hydrator   for every hash the mirror names that a live local file has and
//              whose track lacks the unit: look it up (50 hashes a call),
//              download lo/hi `.cpk` blobs (sha256, size and header checked,
//              temp file + rename), write the inline units through the
//              analyzer's own persist path (one transaction per batch), with
//              a ±1 s duration guard. Yields between batches; the longest
//              synchronous slice is recorded (stats().maxSliceMs).
//   prepare    pull-before-compute for a background analysis job (queue.ts
//              AnalysisCatalogueHook): ≤ 3 s, joins a lookup already in
//              flight, opens a 60 s breaker after a failure so an offline
//              machine pays that wait once, not per track.
//   uploader   kicked in memory after a result lands (never network inside a
//              write), plus the "upload existing analysis" backfill that only
//              the button starts. Derived pending work (what this device has
//              that the mirror says the account lacks at that version), blobs
//              ≤ 2 in flight at ≤ maxKBps, puts of ≤ 100 items, superseded
//              blobs deleted.
//
// Disabled is a supported state at every level: no cloud option = no layer;
// signed out, setting off, a server without 'catalogue' in its features or
// without our entitlement = no calls, prepare answers at once, the analyzer
// runs as it always did.
//
// Never shared: rows stamped with another audio or none (local.ts trusted /
// inlineItemsFor), rows under the 'rekordbox' marker, rb_* data, results of a
// non-default rhythm method (the queue clears their stamp).

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
	CATALOGUE_UNIT_SCHEMA,
	MAX_CATALOGUE_BLOB_BYTES,
	MAX_CATALOGUE_LOOKUP_HASHES,
	MAX_CATALOGUE_PUT_BYTES,
	MAX_CATALOGUE_PUT_ITEMS,
	catalogueBlobPath,
	compareVersions,
	parseVersionString,
	utf8ByteLength,
	type CatalogueItem,
	type CataloguePolicy,
	type CataloguePutResult,
	type StoredCatalogueItem,
	type SyncFeature,
} from '@curator/protocol';
import type { AreaLogger } from '@curator/shared/log';
import type { Db } from '../db/client.js';
import { log } from '../log.js';
import { CPK_HEADER_SIZE_V1, CPK_HEADER_SIZE_V2, CPK_MAGIC, CPK_NUM_BANDS, CPK_VERSION } from '../analyzer/cpk.js';
import { persistAnalysisResult } from '../analyzer/persist.js';
import type { AnalysisCatalogueHook, CataloguePrepared } from '../analyzer/queue.js';
import type { AnalyzeOptions } from '../analyzer/sidecar.js';
import { CloudTransportError } from '../sync-log/client.js';
import {
	PEAKS_HI,
	acceptable,
	allowedKeys,
	durationMatches,
	hasPeaks,
	inlineItemsFor,
	keyId,
	partialResult,
	peaksPath,
	presentLocally,
	readLocalTrack,
	readLocalTracks,
	readLocalTracksByHash,
	trusted,
	unitFloor,
	type InlineKeyUnit,
	type LocalTrack,
	type UnitKey,
} from './local.js';
import {
	applyInventory,
	bindMirrorAccount,
	clampKbps,
	markEntry,
	mirrorCounts,
	pendingHydrateHashes,
	readCatalogueSettings,
	readEntries,
	readInventoryRev,
	setEntry,
	writeCatalogueSettings,
	writeInventoryRev,
	type MirrorCounts,
} from './mirror.js';
import { coverage, jobNeeds, remainingWork, skipCovered } from './needs.js';
import {
	CatalogueBlobError,
	type CatalogueBackfillAction,
	type CatalogueBlobStore,
	type CatalogueEvent,
	type CatalogueSettings,
	type CatalogueSettingsPatch,
	type CatalogueStatus,
	type CatalogueTransport,
} from './types.js';

type Raw = Database.Database;

export type CatalogueWakeReason =
	| 'start' | 'session' | 'network' | 'focus' | 'realtime' | 'interval' | 'resume' | 'local'
	| 'ingest' | 'features' | 'settings' | 'manual' | 'retry';

export interface CatalogueLayerDeps {
	db: Db;
	raw: Raw;
	transport: CatalogueTransport;
	blobs: CatalogueBlobStore;
	deviceId: string;
	// Root of the analyzer's `.cpk` tiers (`<peaksDir>/lo`, `<peaksDir>/hi`);
	// null = no peaks on this device, so peaks never move.
	peaksDir: string | null;
	// The server's optional features as the sync client last learnt them
	// (null = no answer yet this session). 'catalogue' gates every call.
	serverFeatures: () => readonly SyncFeature[] | null;
	// The heavy job the backfill waits for, e.g. 'audio analysis'; null = go.
	busyElsewhere?: () => string | null;
	// Tracks filled in outside an analysis job (settle their queued jobs,
	// refresh their rows).
	onHydrated?: (trackIds: string[]) => void;
	logger?: AreaLogger;
	// Knobs (tests shorten them).
	prepareTimeoutMs?: number;
	breakerMs?: number;
	backoffBaseMs?: number;
	backoffCapMs?: number;
	intervalMs?: number;
	uploadDebounceMs?: number;
	busyPollMs?: number;
	hydrateBatch?: number;
}

export interface CatalogueLayer {
	status(): CatalogueStatus;
	setSettings(patch: CatalogueSettingsPatch): CatalogueStatus;
	setBackfill(action: CatalogueBackfillAction): CatalogueStatus;
	subscribe(cb: (e: CatalogueEvent) => void): () => void;
	// The analyzer queue's seam (queue.ts AnalysisCatalogueHook).
	readonly queueHook: AnalysisCatalogueHook;
	// What a queued job for this track would still compute (settleSatisfied).
	remaining(trackId: string, options: AnalyzeOptions | undefined): number;
	wake(reason: CatalogueWakeReason): void;
	start(): void;
	stop(): void;
	// One inventory + hydrate pass now (also what wake() schedules).
	syncNow(): Promise<void>;
	// Upload what is kicked (and the backfill, while running) now.
	uploadNow(): Promise<void>;
	// Uploading the backfill right now (the backup scheduler yields to it).
	isUploading(): boolean;
	stats(): { maxSliceMs: number; maxSliceAt: string; lookups: number; puts: number; blobUploads: number; blobDownloads: number };
}

const DEFAULTS = {
	prepareTimeoutMs: 3_000,
	breakerMs: 60_000,
	backoffBaseMs: 30_000,
	backoffCapMs: 600_000,
	intervalMs: 600_000,
	uploadDebounceMs: 2_000,
	busyPollMs: 5_000,
	hydrateBatch: MAX_CATALOGUE_LOOKUP_HASHES,
};

// Uploads: tracks per derived-pending page, blobs in flight, and how much of
// the put byte cap a batch may fill (JSON framing and `deviceId` ride on top).
const UPLOAD_PAGE = 50;
const BLOBS_IN_FLIGHT = 2;
const PUT_BYTES_BUDGET = MAX_CATALOGUE_PUT_BYTES - 16 * 1024;
const INVENTORY_CHUNK = 500;
const DOWNLOADS_IN_FLIGHT = 4;
const STATUS_MIN_INTERVAL_MS = 250;
const COUNTS_TTL_MS = 2_000;
const ESTIMATE_TTL_MS = 60_000;
// Ingest bursts (a folder being scanned) coalesce into one pass.
const INGEST_DEBOUNCE_MS = 30_000;
const WAKE_DEBOUNCE_MS = 1_000;
// How long one hydrate write transaction may run before it commits and
// yields (see commitPlan).
const COMMIT_SLICE_MS = 8;
const MARKS_PER_TX = 200;

class TimeoutError extends Error {
	override readonly name = 'TimeoutError';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const t = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
		t.unref?.();
		p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
	});
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));
const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// ── failures ────────────────────────────────────────────────────────────────

type FailureKind = 'offline' | 'rate' | 'auth' | 'device' | 'revoked' | 'disabled' | 'not_entitled' | 'too_large' | 'denied' | 'other';
type Failure = { kind: FailureKind; message: string; retryAfterMs?: number };

function classify(err: unknown): Failure {
	if (err instanceof CloudTransportError) {
		switch (err.kind) {
			case 'network':
			case 'server': return { kind: 'offline', message: err.message };
			case 'rate_limited': return { kind: 'rate', message: err.message, retryAfterMs: err.retryAfterMs };
			case 'auth': return { kind: 'auth', message: err.message };
			case 'device_not_registered': return { kind: 'device', message: err.message };
			case 'device_revoked': return { kind: 'revoked', message: err.message };
			case 'update_required': return { kind: 'other', message: err.message };
			case 'bad_request':
				if (err.message === 'catalogue_disabled') return { kind: 'disabled', message: err.message };
				if (err.message === 'catalogue_not_entitled') return { kind: 'not_entitled', message: err.message };
				if (err.message === 'batch_too_large') return { kind: 'too_large', message: err.message };
				return { kind: 'other', message: err.message };
		}
	}
	if (err instanceof CatalogueBlobError) {
		if (err.kind === 'denied') return { kind: 'denied', message: err.message };
		if (err.kind === 'transient') return { kind: 'offline', message: err.message };
		return { kind: 'other', message: err.message };
	}
	if (err instanceof TimeoutError) return { kind: 'offline', message: err.message };
	return { kind: 'other', message: err instanceof Error ? err.message : String(err) };
}

function describe(f: Failure): string {
	switch (f.kind) {
		case 'offline': return 'Offline — shared analysis resumes when the connection is back.';
		case 'rate': return 'The server asked to slow down; retrying shortly.';
		case 'auth': return 'Your session expired — sign in again.';
		case 'device': return 'Waiting for this device to register with your account.';
		case 'revoked': return 'This device was removed from your Curator account.';
		case 'disabled': return 'The server has shared analysis switched off.';
		case 'not_entitled': return 'This account is not enabled for shared analysis yet — reusing still works, uploading does not.';
		case 'denied': return 'Storage refused an upload (account not enabled, or over quota).';
		case 'too_large': return 'A batch was too large for the server.';
		case 'other': return `Shared analysis failed (${f.message}).`;
	}
}

// ── .cpk header ─────────────────────────────────────────────────────────────

// The format version when `buf` is a whole .cpk (header sane, body at least
// as long as the header says), else null. Header only: decodePeaks would
// split an 8 MB hi tier into arrays just to say yes.
export function cpkVersionOf(buf: Uint8Array): number | null {
	if (buf.byteLength < CPK_HEADER_SIZE_V1) return null;
	for (let i = 0; i < CPK_MAGIC.length; i++) if (buf[i] !== CPK_MAGIC[i]) return null;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const version = dv.getUint8(8);
	if (version < 1 || version > 3 || dv.getUint8(9) !== CPK_NUM_BANDS) return null;
	const channels = version === 1 ? 1 : dv.getUint8(10);
	if (channels !== 1 && channels !== 2) return null;
	const spsOff = version === 1 ? 10 : 11;
	if (buf.byteLength < spsOff + 10) return null;
	const detail = dv.getUint32(spsOff + 2, true);
	const overview = dv.getUint32(spsOff + 6, true);
	const header = version === 1 ? CPK_HEADER_SIZE_V1 : CPK_HEADER_SIZE_V2;
	const metrics = version === 3 ? 2 : 1;
	return buf.byteLength >= header + (detail + overview) * CPK_NUM_BANDS * metrics * channels ? version : null;
}

// sha256 in 1 MB steps with a yield between, so a hi tier never holds the
// loop for one long hash.
async function sha256Yielding(buf: Uint8Array): Promise<string> {
	const h = createHash('sha256');
	const STEP = 1 << 20;
	for (let o = 0; o < buf.byteLength; o += STEP) {
		h.update(buf.subarray(o, o + STEP));
		if (o + STEP < buf.byteLength) await yieldNow();
	}
	return h.digest('hex');
}

// ── upload pacing ───────────────────────────────────────────────────────────

class Pacer {
	private nextAt = 0;
	constructor(private readonly bytesPerSec: () => number) {}
	// Reserve `bytes` of the budget; resolves when the transfer may start.
	async take(bytes: number): Promise<void> {
		const now = Date.now();
		const start = Math.max(now, this.nextAt);
		this.nextAt = start + (bytes / Math.max(1, this.bytesPerSec())) * 1000;
		if (start > now) await sleep(start - now);
	}
}

// ── the hydrate plan (fetch phase → commit phase) ──────────────────────────

type TrackApply = {
	t: LocalTrack;
	inline: StoredCatalogueItem[];
	peaks: { tier: string; tmp: string; final: string }[];
};

type HydratePlan = {
	tracks: Map<string, TrackApply>;
	// Verdicts on mirror entries, written with the commit (hydrate mode).
	marks: { hash: string; key: UnitKey; version: number[]; state: 'hydrated' | 'skipped' }[];
	// Hashes left 'remote' by a transient failure: not picked again this pass.
	retry: Set<string>;
	tmpFiles: string[];
	skippedGuard: number;
};

export function createCatalogueLayer(deps: CatalogueLayerDeps): CatalogueLayer {
	const { db, raw, transport, blobs, deviceId, peaksDir } = deps;
	const clog = deps.logger ?? log.for('catalogue');
	const cfg = {
		prepareTimeoutMs: deps.prepareTimeoutMs ?? DEFAULTS.prepareTimeoutMs,
		breakerMs: deps.breakerMs ?? DEFAULTS.breakerMs,
		backoffBaseMs: deps.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
		backoffCapMs: deps.backoffCapMs ?? DEFAULTS.backoffCapMs,
		intervalMs: deps.intervalMs ?? DEFAULTS.intervalMs,
		uploadDebounceMs: deps.uploadDebounceMs ?? DEFAULTS.uploadDebounceMs,
		busyPollMs: deps.busyPollMs ?? DEFAULTS.busyPollMs,
		hydrateBatch: Math.min(deps.hydrateBatch ?? DEFAULTS.hydrateBatch, MAX_CATALOGUE_LOOKUP_HASHES),
	};

	let settings: CatalogueSettings = readCatalogueSettings(raw);
	// What the server last told us (inventory pages). Reset on account change.
	let policy: CataloguePolicy | null = null;
	let entitled: boolean | null = null;
	let usage: { usedBytes: number; quotaBytes: number } | null = null;
	// A call answered catalogue_disabled: stay quiet until the features list
	// (or a manual wake) says otherwise.
	let serverDisabled = false;
	let boundUser: string | null = null;

	let lastError: string | null = null;
	let lastHydrateAt: number | null = null;
	let lastUploadAt: number | null = null;
	let activity: CatalogueStatus['activity'] = null;
	let waitingFor: string | null = null;
	let backfillUploaded = { items: 0, bytes: 0 };
	let backfillCursor = '';
	let estimate: { items: number; bytes: number; at: number } | null = null;
	let estimating: Promise<void> | null = null;

	const stats = { maxSliceMs: 0, maxSliceAt: '', lookups: 0, puts: 0, blobUploads: 0, blobDownloads: 0 };
	// Every synchronous stretch the layer runs on the main loop goes through
	// here, so the longest one is measured rather than guessed.
	const slice = <T>(fn: () => T, label = 'other'): T => {
		const t0 = performance.now();
		try { return fn(); } finally {
			const ms = performance.now() - t0;
			if (ms > stats.maxSliceMs) { stats.maxSliceMs = ms; stats.maxSliceAt = label; }
		}
	};

	// ── status ──────────────────────────────────────────────────────────

	const listeners = new Set<(e: CatalogueEvent) => void>();
	let counts: { at: number; v: MirrorCounts } | null = null;
	const mirror = (): MirrorCounts => {
		if (!counts || Date.now() - counts.at > COUNTS_TTL_MS) counts = { at: Date.now(), v: slice(() => mirrorCounts(raw)) };
		return counts.v;
	};
	const invalidate = (): void => { counts = null; };

	const offers = (): boolean | null => {
		const f = deps.serverFeatures();
		return f === null ? null : f.includes('catalogue');
	};

	let nextRetryAt: number | null = null;

	const status = (): CatalogueStatus => {
		const c = mirror();
		return {
			available: true,
			settings: { ...settings },
			signedIn: transport.session() !== null,
			serverOffers: serverDisabled ? false : offers(),
			policy,
			entitled,
			usage,
			account: { items: c.items, bytes: c.bytes },
			device: { reused: c.reused, uploaded: c.uploaded, pending: estimate ? { items: estimate.items, bytes: estimate.bytes } : null },
			backfill: { state: settings.backfill, uploadedItems: backfillUploaded.items, uploadedBytes: backfillUploaded.bytes, waitingFor },
			activity,
			lastHydrateAt,
			lastUploadAt,
			lastError,
			nextRetryAt,
		};
	};

	const emit = (e: CatalogueEvent): void => {
		for (const cb of listeners) {
			try { cb(e); } catch (err) { clog.warn('listener threw', undefined, err); }
		}
	};
	let lastEmit = 0;
	let emitTimer: ReturnType<typeof setTimeout> | null = null;
	// Coalesced to ≤ 4/s: a hydrate of thousands of hashes is a stream of
	// small changes, and each status costs a mirror count.
	const emitStatus = (): void => {
		if (listeners.size === 0) return;
		const wait = lastEmit + STATUS_MIN_INTERVAL_MS - Date.now();
		if (wait > 0) {
			if (!emitTimer) {
				emitTimer = setTimeout(() => { emitTimer = null; emitStatus(); }, wait);
				emitTimer.unref?.();
			}
			return;
		}
		lastEmit = Date.now();
		invalidate();
		emit({ kind: 'status', status: status() });
	};

	// ── gates ───────────────────────────────────────────────────────────

	// The mirror belongs to one account; another signing in starts it over.
	const ensureAccount = (): boolean => {
		const s = transport.session();
		if (!s) return false;
		if (boundUser === s.userId) return true;
		const reset = slice(() => bindMirrorAccount(raw, s.userId));
		boundUser = s.userId;
		if (reset) {
			policy = null;
			entitled = null;
			usage = null;
			estimate = null;
			backfillUploaded = { items: 0, bytes: 0 };
			backfillCursor = '';
			if (settings.backfill !== 'off') {
				settings = { ...settings, backfill: 'off' };
				writeCatalogueSettings(raw, settings);
			}
			invalidate();
			clog.info('account changed — catalogue mirror cleared', { userId: s.userId });
		}
		return true;
	};

	// Calls are worth making at all.
	const usable = (): boolean => settings.enabled && transport.session() !== null && offers() === true && !serverDisabled;

	// ── failures, breaker, backoff ──────────────────────────────────────

	let breakerUntil = 0;
	let failures = 0;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let started = false;

	const clearRetry = (): void => {
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = null;
		nextRetryAt = null;
	};

	// One place every failed call lands: the message the panel shows, the
	// breaker that keeps prepare from waiting on a dead network per track,
	// and the backoff of the background passes (30 s doubling to 10 min).
	const fail = (where: string, err: unknown): Failure => {
		const f = classify(err);
		lastError = describe(f);
		if (f.kind === 'disabled') serverDisabled = true;
		if (f.kind === 'not_entitled') entitled = false;
		if (f.kind === 'offline' || f.kind === 'rate' || f.kind === 'device' || f.kind === 'other') {
			breakerUntil = Date.now() + Math.max(cfg.breakerMs, f.retryAfterMs ?? 0);
		}
		clog.warn(`${where} failed`, { kind: f.kind, ...(f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {}) }, f.kind === 'other' ? err : undefined);
		if (started && (f.kind === 'offline' || f.kind === 'rate' || f.kind === 'device' || f.kind === 'other')) {
			failures++;
			const exp = Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (failures - 1));
			const delay = Math.min(cfg.backoffCapMs, Math.max(f.retryAfterMs ?? 0, exp / 2 + Math.random() * (exp / 2)));
			clearRetry();
			nextRetryAt = Date.now() + delay;
			retryTimer = setTimeout(() => {
				retryTimer = null;
				nextRetryAt = null;
				void syncNow().then(() => uploadNow());
			}, delay);
			retryTimer.unref?.();
		}
		emitStatus();
		return f;
	};

	const succeeded = (): void => {
		failures = 0;
		breakerUntil = 0;
		clearRetry();
		lastError = null;
	};

	// ── lookups (joined) ────────────────────────────────────────────────

	type LookupMap = Map<string, StoredCatalogueItem[]>;
	const inflightLookups = new Map<string, { keys: ReadonlySet<string>; promise: Promise<LookupMap> }>();

	// Newest acceptable item per (hash, key) for these hashes. A hash already
	// being looked up for at least these keys (the hydrator's batch, another
	// job's prepare) is joined, not asked again.
	const lookup = async (hashes: readonly string[], keys: readonly UnitKey[]): Promise<LookupMap> => {
		const keySet = new Set(keys.map(keyId));
		const joined: Promise<LookupMap>[] = [];
		const fresh: string[] = [];
		for (const h of new Set(hashes)) {
			const f = inflightLookups.get(h);
			if (f && [...keySet].every((k) => f.keys.has(k))) joined.push(f.promise);
			else fresh.push(h);
		}
		let own: Promise<LookupMap> | null = null;
		if (fresh.length > 0) {
			const want = keys.map((k) => ({ unit: k.unit, variant: k.variant, minVersion: unitFloor(k.unit), maxSchema: CATALOGUE_UNIT_SCHEMA[k.unit] }));
			own = (async () => {
				const out: LookupMap = new Map();
				for (let i = 0; i < fresh.length; i += MAX_CATALOGUE_LOOKUP_HASHES) {
					stats.lookups++;
					const res = await transport.catalogue.lookup({ deviceId, audioHashes: fresh.slice(i, i + MAX_CATALOGUE_LOOKUP_HASHES), want });
					for (const item of res.items) {
						if (!keySet.has(keyId(item)) || !acceptable(item)) continue;
						const list = out.get(item.audioHash) ?? [];
						// The server answers the newest per key; keep that rule
						// locally too in case two arrive.
						const at = list.findIndex((x) => keyId(x) === keyId(item));
						if (at < 0) list.push(item);
						else if (compareVersions(item.version, list[at]!.version) > 0) list[at] = item;
						out.set(item.audioHash, list);
					}
				}
				return out;
			})();
			const entry = { keys: keySet, promise: own };
			for (const h of fresh) inflightLookups.set(h, entry);
			const forget = (): void => { for (const h of fresh) if (inflightLookups.get(h) === entry) inflightLookups.delete(h); };
			own.then(forget, forget);
		}
		const maps = await Promise.all([...joined, ...(own ? [own] : [])]);
		const out: LookupMap = new Map();
		for (const h of hashes) {
			for (const m of maps) {
				const items = m.get(h)?.filter((i) => keySet.has(keyId(i)));
				if (items && items.length > 0) { out.set(h, items); break; }
			}
		}
		return out;
	};

	// ── hydrate: fetch phase ────────────────────────────────────────────

	const download = async (item: StoredCatalogueItem): Promise<Uint8Array | 'bad' | 'transient'> => {
		if (item.unit !== 'peaks') return 'bad';
		const blob = item.data.blob;
		try {
			stats.blobDownloads++;
			const bytes = await blobs.download(blob.path);
			if (bytes.byteLength !== blob.bytes || bytes.byteLength > MAX_CATALOGUE_BLOB_BYTES) return 'bad';
			if (await sha256Yielding(bytes) !== blob.sha256) return 'bad';
			const v = cpkVersionOf(bytes);
			if (v === null || v !== item.data.cpkVersion) return 'bad';
			return bytes;
		} catch (err) {
			const f = classify(err);
			// A missing object under a live item is the server's inconsistency,
			// not ours to retry forever; anything else may pass next time.
			if (err instanceof CatalogueBlobError && err.kind === 'not_found') return 'bad';
			if (f.kind === 'offline' || f.kind === 'rate') throw err;
			return 'transient';
		}
	};

	// Decide, per hash and key, which live tracks get which item, then fetch
	// the blobs into temp files. No database writes here; `onlyTrack`
	// narrows to one track (prepare) and leaves the mirror's verdicts alone,
	// since other tracks with the hash may still lack the unit.
	const fetchPlan = async (hashes: readonly string[], items: LookupMap, keys: readonly UnitKey[], onlyTrack: string | null): Promise<HydratePlan> => {
		const plan: HydratePlan = { tracks: new Map(), marks: [], retry: new Set(), tmpFiles: [], skippedGuard: 0 };
		const keySet = new Set(keys.map(keyId));
		const byHash = slice(() => readLocalTracksByHash(raw, hashes), 'plan:read');
		const blobWanted = new Map<string, { item: StoredCatalogueItem; tracks: LocalTrack[] }>();
		const entries = slice(() => readEntries(raw, hashes), 'plan:entries');
		slice(() => {
			for (const hash of hashes) {
				let cands = byHash.get(hash) ?? [];
				if (onlyTrack) cands = cands.filter((t) => t.trackId === onlyTrack);
				const got = (items.get(hash) ?? []).filter((i) => keySet.has(keyId(i)));
				// Keys the mirror names that the lookup did not return (below a
				// floor, newer schema, removed meanwhile): nothing to apply.
				if (!onlyTrack) {
					for (const e of entries.get(hash)?.values() ?? []) {
						if (e.state !== 'remote') continue;
						const k: UnitKey = { unit: e.unit as UnitKey['unit'], variant: e.variant };
						if (keySet.has(keyId(k)) && !got.some((i) => keyId(i) === keyId(k))) plan.marks.push({ hash, key: k, version: e.version, state: 'skipped' });
					}
				}
				for (const item of got) {
					const k: UnitKey = { unit: item.unit, variant: item.variant };
					let had = false;
					let applied = false;
					let guard = false;
					const needing: LocalTrack[] = [];
					for (const t of cands) {
						if (!trusted(t)) continue;
						if (presentLocally(t, k, peaksDir)) { had = true; continue; }
						if (!durationMatches(t, item.durationSec)) { guard = true; plan.skippedGuard++; continue; }
						applied = true;
						if (item.unit === 'peaks') {
							needing.push(t);
						} else {
							const ta = plan.tracks.get(t.trackId) ?? { t, inline: [], peaks: [] };
							ta.inline.push(item);
							plan.tracks.set(t.trackId, ta);
						}
					}
					if (needing.length > 0) blobWanted.set(`${hash}|${keyId(k)}`, { item, tracks: needing });
					if (onlyTrack) continue;
					if (applied || had) {
						// Peaks are marked once their file is in place (below).
						if (item.unit !== 'peaks' || needing.length === 0) plan.marks.push({ hash, key: k, version: item.version, state: 'hydrated' });
					} else if (guard || cands.length > 0) {
						plan.marks.push({ hash, key: k, version: item.version, state: 'skipped' });
					} else {
						plan.retry.add(hash);
					}
				}
			}
		});

		// Blobs: one download per (hash, tier), copied to every track lacking it.
		const jobs = [...blobWanted.values()];
		let next = 0;
		const worker = async (): Promise<void> => {
			while (next < jobs.length) {
				const { item, tracks } = jobs[next++]!;
				const got = await download(item);
				const k: UnitKey = { unit: item.unit, variant: item.variant };
				if (got === 'bad') {
					if (!onlyTrack) plan.marks.push({ hash: item.audioHash, key: k, version: item.version, state: 'skipped' });
					continue;
				}
				if (got === 'transient') { plan.retry.add(item.audioHash); continue; }
				for (const t of tracks) {
					const final = peaksPath(peaksDir!, item.variant, t.trackId);
					const tmp = `${final}.${randomUUID().slice(0, 8)}.part`;
					await fsp.mkdir(join(peaksDir!, item.variant), { recursive: true });
					await fsp.writeFile(tmp, got);
					plan.tmpFiles.push(tmp);
					const ta = plan.tracks.get(t.trackId) ?? { t, inline: [], peaks: [] };
					ta.peaks.push({ tier: item.variant, tmp, final });
					plan.tracks.set(t.trackId, ta);
				}
				if (!onlyTrack) plan.marks.push({ hash: item.audioHash, key: k, version: item.version, state: 'hydrated' });
			}
		};
		try {
			await Promise.all(Array.from({ length: Math.min(DOWNLOADS_IN_FLIGHT, jobs.length) }, worker));
		} catch (err) {
			await discardPlan(plan);
			throw err;
		}
		return plan;
	};

	const discardPlan = async (plan: HydratePlan): Promise<void> => {
		await Promise.all(plan.tmpFiles.map((f) => fsp.rm(f, { force: true }).catch(() => { /* best effort */ })));
		plan.tmpFiles = [];
	};

	// ── hydrate: commit phase ───────────────────────────────────────────

	// Peaks files land first (temp → rename, never over a file that appeared
	// meanwhile — the analyzer may have written its own), then the inline
	// units go through the analyzer's persist path, re-checking presence
	// inside the transaction so a result the analyzer persisted since the
	// plan was made always wins.
	//
	// Transactions are time-boxed (COMMIT_SLICE_MS), not one per batch: a
	// batch of 50 tracks in one transaction measured ~75 ms on a dev machine
	// (each pulled fingerprint is a recording claim on the op log, ~0.8 ms),
	// which is the jank the hydrator must not cause. Every write is a fill of
	// something absent, so a crash between two of them leaves nothing to
	// undo; the mirror's verdicts are written only after every unit, so an
	// interrupted batch is simply looked at again.
	const commitPlan = async (plan: HydratePlan): Promise<{ trackIds: string[]; units: number; peaks: number }> => {
		let peaks = 0;
		const landed = new Set<string>();
		for (const ta of plan.tracks.values()) {
			for (const p of ta.peaks) {
				if (existsSync(p.final)) continue;
				try {
					await fsp.rename(p.tmp, p.final);
					peaks++;
					landed.add(ta.t.trackId);
				} catch (err) {
					clog.warn('placing a hydrated waveform failed', { tier: p.tier }, err);
				}
			}
		}
		await discardPlan(plan);
		const todo = [...plan.tracks.values()].filter((ta) => ta.inline.length > 0);
		let units = 0;
		let i = 0;
		for (;;) {
			const finished = slice(() => raw.transaction(() => {
				const t0 = performance.now();
				while (i < todo.length && (performance.now() - t0 < COMMIT_SLICE_MS)) {
					const ta = todo[i++]!;
					const t = readLocalTrack(raw, ta.t.trackId);
					if (!t || !t.path || t.hash !== ta.t.hash || !trusted(t)) continue;
					const items = ta.inline.filter((it) => !presentLocally(t, { unit: it.unit, variant: it.variant }, peaksDir));
					if (items.length === 0) continue;
					persistAnalysisResult(db, partialResult(t, items), t.path, { audioHash: t.hash });
					units += items.length;
					landed.add(t.trackId);
				}
				return i >= todo.length;
			})(), 'commit');
			if (finished) break;
			await yieldNow();
		}
		for (let m = 0; m < plan.marks.length; m += MARKS_PER_TX) {
			const chunk = plan.marks.slice(m, m + MARKS_PER_TX);
			slice(() => raw.transaction(() => {
				for (const x of chunk) markEntry(raw, x.hash, x.key.unit, x.key.variant, x.version, x.state);
			})(), 'marks');
			if (m + MARKS_PER_TX < plan.marks.length) await yieldNow();
		}
		invalidate();
		return { trackIds: [...landed], units, peaks };
	};

	// ── inventory ───────────────────────────────────────────────────────

	const syncInventory = async (): Promise<void> => {
		const t0 = performance.now();
		let after = readInventoryRev(raw);
		let pages = 0;
		let entries = 0;
		let changed = 0;
		for (;;) {
			const res = await transport.catalogue.inventory({ deviceId, afterRev: after });
			pages++;
			policy = res.policy;
			entitled = res.account.entitled;
			usage = { usedBytes: res.account.usedBytes, quotaBytes: res.account.quotaBytes };
			for (let i = 0; i < res.entries.length; i += INVENTORY_CHUNK) {
				const chunk = res.entries.slice(i, i + INVENTORY_CHUNK);
				changed += slice(() => raw.transaction(() => applyInventory(raw, chunk))(), 'inventory');
				await yieldNow();
			}
			entries += res.entries.length;
			slice(() => writeInventoryRev(raw, res.nextRev));
			after = res.nextRev;
			if (!res.more) break;
		}
		invalidate();
		const fields = { pages, entries, changed, rev: after, ms: Math.round(performance.now() - t0) };
		if (entries > 0) clog.info('inventory', fields);
		else clog.debug('inventory', fields);
	};

	// ── hydrate pass ────────────────────────────────────────────────────

	// Inline units and the lo tier first, the hi tier after (D-b), so a new
	// device's library lights up before the bulky downloads.
	const hydrateAll = async (): Promise<void> => {
		const keys = allowedKeys(policy, { peaks: !!peaksDir });
		const phases = [keys.filter((k) => keyId(k) !== keyId(PEAKS_HI)), keys.filter((k) => keyId(k) === keyId(PEAKS_HI))].filter((p) => p.length > 0);
		for (const phase of phases) {
			const passed = new Set<string>();
			for (;;) {
				if (!usable()) return;
				const hashes = slice(() => pendingHydrateHashes(raw, phase, cfg.hydrateBatch, passed), 'pending');
				if (hashes.length === 0) break;
				const t0 = performance.now();
				activity = 'hydrating';
				emitStatus();
				const items = await lookup(hashes, phase);
				const plan = await fetchPlan(hashes, items, phase, null);
				const r = await commitPlan(plan);
				for (const h of plan.retry) passed.add(h);
				// A hash whose verdicts did not move it off 'remote' (no usable
				// track yet) must not be picked again in this pass.
				for (const h of hashes) passed.add(h);
				lastHydrateAt = Date.now();
				const itemCount = [...items.values()].reduce((n, l) => n + l.length, 0);
				clog.info('hydrate batch', {
					hashes: hashes.length, items: itemCount, tracks: r.trackIds.length, units: r.units, peaks: r.peaks,
					skippedGuard: plan.skippedGuard, retry: plan.retry.size, ms: Math.round(performance.now() - t0), maxSliceMs: Math.round(stats.maxSliceMs * 10) / 10,
				});
				if (r.trackIds.length > 0) {
					try { deps.onHydrated?.(r.trackIds); } catch (err) { clog.warn('onHydrated hook failed', undefined, err); }
					emit({ kind: 'hydrated', trackIds: r.trackIds });
				}
				emitStatus();
				await yieldNow();
			}
		}
	};

	// ── cycle (inventory + hydrate), single flight ──────────────────────

	let cycleRun: Promise<void> | null = null;
	let cycleAgain = false;
	const syncNow = async (): Promise<void> => {
		if (cycleRun) { cycleAgain = true; return cycleRun; }
		// `run` is cleared by identity once it settles, never from inside the
		// async body: a pass that ends before its first await (not usable yet,
		// e.g. the server does not offer the catalogue) would run its cleanup
		// synchronously, BEFORE the assignment below, and leave a finished
		// promise in cycleRun forever, so every later wake only set cycleAgain.
		// That stranded the catalogue for a whole session when the app started
		// during the cloud-v0.1.2 → v0.2.0 changeover (2026-10-20).
		const run: Promise<void> = (async () => {
			try {
				do {
					cycleAgain = false;
					if (!usable() || !ensureAccount()) break;
					activity = 'inventory';
					emitStatus();
					try {
						await syncInventory();
						await hydrateAll();
						succeeded();
					} catch (err) {
						fail('catalogue pass', err);
						break;
					}
				} while (cycleAgain);
			} finally {
				activity = null;
				emitStatus();
			}
			// Work waiting for the policy (kicked uploads, a running backfill).
			if (kicked.size > 0 || settings.backfill === 'running') scheduleUpload(0);
		})();
		cycleRun = run;
		void run.finally(() => { if (cycleRun === run) cycleRun = null; });
		return run;
	};

	// ── prepare (pull-before-compute) ───────────────────────────────────

	const prepare = async (job: { trackId: string; path: string; options: AnalyzeOptions | undefined }): Promise<CataloguePrepared | null> => {
		if (!usable() || !ensureAccount() || !policy || Date.now() < breakerUntil) return null;
		const t = slice(() => readLocalTrack(raw, job.trackId));
		if (!t || !t.hash || t.path !== job.path || !trusted(t)) return null;
		const hash = t.hash;
		const needs = jobNeeds(job.options, t, peaksDir);
		if (needs.inline.size === 0 && !needs.peaks) return null;
		const allowed = allowedKeys(policy, { peaks: !!peaksDir });
		const relevant = allowed.filter((k) => (k.unit === 'peaks' ? needs.peaks : needs.inline.has(k.unit as InlineKeyUnit)));
		let entries = slice(() => readEntries(raw, [hash]).get(hash));
		// Only what the mirror says the account holds is worth a round trip:
		// a track no other device analysed (the common case on the machine
		// doing the analysing) costs no network at all.
		const wanted = relevant.filter((k) => {
			const e = entries?.get(keyId(k));
			return !!e && e.state !== 'rejected' && !presentLocally(t, k, peaksDir);
		});
		const pulled = new Set<string>();
		let current = t;
		if (wanted.length > 0) {
			const work = (async () => {
				const items = await lookup([hash], allowed);
				return fetchPlan([hash], items, wanted, t.trackId);
			})();
			let plan: HydratePlan | null = null;
			try {
				plan = await withTimeout(work, cfg.prepareTimeoutMs);
			} catch (err) {
				// Whatever the abandoned fetch still writes is cleaned up when
				// it settles; the job goes ahead with the analyzer.
				work.then((p) => discardPlan(p), () => { /* already reported */ });
				fail('pull-before-compute', err);
				return null;
			}
			const r = await commitPlan(plan);
			for (const ta of plan.tracks.values()) {
				for (const i of ta.inline) pulled.add(keyId(i));
				for (const p of ta.peaks) if (existsSync(p.final)) pulled.add(keyId({ unit: 'peaks', variant: p.tier }));
			}
			if (r.trackIds.length > 0) {
				lastHydrateAt = Date.now();
				clog.debug('pulled before compute', { units: r.units, peaks: r.peaks });
			}
			current = slice(() => readLocalTrack(raw, t.trackId)) ?? t;
			entries = slice(() => readEntries(raw, [hash]).get(hash));
		}
		const cov = coverage(current, entries, pulled, peaksDir);
		const needsNow = jobNeeds(job.options, current, peaksDir);
		// Units this pass pulled count as needed even though they are now
		// present (jobNeeds re-read without the override would drop them).
		for (const u of needs.inline) needsNow.inline.add(u);
		needsNow.peaks = needs.peaks;
		const left = remainingWork(needsNow, cov);
		const skip = skipCovered(job.options, needsNow, cov);
		if (!skip.changed) return null;
		return { options: skip.options, done: left.count === 0, keepLo: skip.keepLo };
	};

	const remaining = (trackId: string, options: AnalyzeOptions | undefined): number => {
		const t = readLocalTrack(raw, trackId);
		if (!t || !t.hash || !trusted(t)) return 1;
		const entries = readEntries(raw, [t.hash]).get(t.hash);
		return remainingWork(jobNeeds(options, t, peaksDir), coverage(t, entries, new Set(), peaksDir)).count;
	};

	// ── uploader ────────────────────────────────────────────────────────

	const kicked = new Set<string>();
	let uploadTimer: ReturnType<typeof setTimeout> | null = null;
	let uploadRun: Promise<void> | null = null;
	let uploadAgain = false;
	let uploadingBackfill = false;
	const pacer = new Pacer(() => settings.maxKBps * 1024);

	const canUpload = (): boolean => usable() && policy !== null && entitled === true;

	type Candidate = { item: CatalogueItem; hash: string; key: UnitKey; bytes: number };
	type BlobJob = { t: LocalTrack; tier: string; version: number[]; durationSec: number };

	// Derived pending work for these tracks: each allowed key this device
	// holds (local.ts inlineItemsFor rules) that the mirror says the account
	// lacks at this version or newer.
	const pendingFor = (trackIds: readonly string[]): { inline: Candidate[]; blobs: BlobJob[]; tracks: number } => {
		const keys = allowedKeys(policy, { peaks: !!peaksDir });
		const tracks = readLocalTracks(raw, trackIds).filter((t) => t.hash && t.row && t.row.audioHash === t.hash && parseVersionString(t.row.version));
		const entries = readEntries(raw, [...new Set(tracks.map((t) => t.hash!))]);
		const seen = new Set<string>();
		const inline: Candidate[] = [];
		const blobJobs: BlobJob[] = [];
		for (const t of tracks) {
			const hash = t.hash!;
			const version = parseVersionString(t.row!.version)!;
			const pend = keys.filter((k) => {
				if (seen.has(`${hash}|${keyId(k)}`)) return false;
				const e = entries.get(hash)?.get(keyId(k));
				return !e || compareVersions(e.version, version) < 0;
			});
			if (pend.length === 0) continue;
			const units = new Set(pend.filter((k) => k.unit !== 'peaks').map((k) => k.unit as InlineKeyUnit));
			for (const item of inlineItemsFor(raw, t, units)) {
				seen.add(`${hash}|${keyId(item)}`);
				inline.push({ item, hash, key: { unit: item.unit, variant: item.variant }, bytes: utf8ByteLength(JSON.stringify(item.data)) });
			}
			const dur = t.row!.duration;
			if (dur != null && dur > 0 && compareVersions(version, unitFloor('peaks')) >= 0) {
				for (const k of pend) {
					if (k.unit !== 'peaks' || !hasPeaks(peaksDir, k.variant, t.trackId)) continue;
					seen.add(`${hash}|${keyId(k)}`);
					blobJobs.push({ t, tier: k.variant, version, durationSec: dur });
				}
			}
		}
		return { inline, blobs: blobJobs, tracks: tracks.length };
	};

	// Read, check and upload one tier file; the item that names it, or null
	// when this file is not shareable (old format, too big) or the upload
	// failed transiently (it stays pending).
	const uploadBlob = async (job: BlobJob, userId: string): Promise<Candidate | null> => {
		let bytes: Buffer;
		try { bytes = await fsp.readFile(peaksPath(peaksDir!, job.tier, job.t.trackId)); } catch { return null; }
		// Only the current writer's format: an older mono/peak-only strip is
		// better recomputed by the next device than handed on.
		const v = cpkVersionOf(bytes);
		if (v !== CPK_VERSION || bytes.byteLength > MAX_CATALOGUE_BLOB_BYTES) return null;
		const sha256 = await sha256Yielding(bytes);
		const path = catalogueBlobPath(userId, 'peaks', sha256);
		await pacer.take(bytes.byteLength);
		stats.blobUploads++;
		await blobs.upload(path, bytes);
		const item: CatalogueItem = {
			audioHash: job.t.hash!,
			unit: 'peaks',
			variant: job.tier as 'lo' | 'hi',
			version: job.version,
			unitSchema: CATALOGUE_UNIT_SCHEMA.peaks,
			durationSec: job.durationSec,
			licence: null,
			data: { blob: { path, sha256, bytes: bytes.byteLength }, cpkVersion: v },
		};
		return { item, hash: job.t.hash!, key: { unit: 'peaks', variant: job.tier }, bytes: bytes.byteLength + utf8ByteLength(JSON.stringify(item.data)) };
	};

	type PutTally = { accepted: number; rejected: number; superseded: number; bytes: number; stop: boolean };

	const putBatch = async (batch: Candidate[], tally: PutTally): Promise<void> => {
		if (batch.length === 0) return;
		let res: CataloguePutResult;
		try {
			stats.puts++;
			res = await transport.catalogue.put({ deviceId, items: batch.map((c) => c.item) });
		} catch (err) {
			const f = classify(err);
			if (f.kind === 'too_large' && batch.length > 1) {
				const mid = Math.ceil(batch.length / 2);
				await putBatch(batch.slice(0, mid), tally);
				if (!tally.stop) await putBatch(batch.slice(mid), tally);
				return;
			}
			throw err;
		}
		slice(() => raw.transaction(() => {
			for (const a of res.accepted) {
				const c = batch[a.index];
				if (!c) continue;
				setEntry(raw, { audioHash: c.hash, unit: c.key.unit, variant: c.key.variant, version: c.item.version, state: 'uploaded', remoteRev: a.rev, bytes: c.bytes });
				tally.accepted++;
				tally.bytes += c.bytes;
			}
			for (const r of res.rejected) {
				const c = batch[r.index];
				if (!c) continue;
				tally.rejected++;
				// Quota: nothing more fits; stop and say so. A missing blob is
				// an upload that has not landed yet — try again next time.
				if (r.reason === 'quota_exceeded') { tally.stop = true; continue; }
				if (r.reason === 'blob_missing') continue;
				setEntry(raw, { audioHash: c.hash, unit: c.key.unit, variant: c.key.variant, version: c.item.version, state: 'rejected' });
			}
		})());
		usage = res.usage;
		if (res.rejected.length > 0) clog.warn('put: items refused', { count: res.rejected.length, reasons: [...new Set(res.rejected.map((r) => r.reason))] });
		if (tally.stop) lastError = 'The account\'s shared-analysis storage is full — uploading stopped.';
		if (res.superseded.length > 0) {
			tally.superseded += res.superseded.length;
			try { await blobs.remove(res.superseded); } catch (err) { clog.warn('deleting superseded blobs failed', { count: res.superseded.length }, err); }
		}
		invalidate();
	};

	// Upload one page of tracks: blobs first (they must exist before an item
	// names them), then the items in puts under both caps.
	const uploadTracks = async (trackIds: readonly string[]): Promise<{ stop: boolean; items: number; bytes: number }> => {
		const session = transport.session();
		if (!session) return { stop: true, items: 0, bytes: 0 };
		const t0 = performance.now();
		const pend = slice(() => pendingFor(trackIds));
		const tally: PutTally = { accepted: 0, rejected: 0, superseded: 0, bytes: 0, stop: false };
		const ready: Candidate[] = [...pend.inline];
		let blobBytes = 0;
		let blobFailed = 0;
		let next = 0;
		let denied: unknown = null;
		const worker = async (): Promise<void> => {
			while (next < pend.blobs.length && !denied) {
				const job = pend.blobs[next++]!;
				try {
					const c = await uploadBlob(job, session.userId);
					if (c) { ready.push(c); blobBytes += c.item.unit === 'peaks' ? c.item.data.blob.bytes : 0; }
				} catch (err) {
					const f = classify(err);
					if (f.kind === 'denied' || f.kind === 'offline' || f.kind === 'auth') { denied = err; return; }
					blobFailed++;
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(BLOBS_IN_FLIGHT, pend.blobs.length) }, worker));
		// Items whose blobs did land still go up; the rest stays pending.
		let batch: Candidate[] = [];
		let size = 2;
		for (const c of ready) {
			if (tally.stop) break;
			const n = utf8ByteLength(JSON.stringify(c.item)) + 1;
			if (batch.length > 0 && (batch.length >= MAX_CATALOGUE_PUT_ITEMS || size + n > PUT_BYTES_BUDGET)) {
				await putBatch(batch, tally);
				batch = [];
				size = 2;
			}
			batch.push(c);
			size += n;
		}
		if (!tally.stop) await putBatch(batch, tally);
		if (pend.inline.length + pend.blobs.length > 0) {
			lastUploadAt = Date.now();
			clog.info('upload batch', {
				tracks: pend.tracks, items: ready.length, blobs: pend.blobs.length, blobBytes, blobFailed,
				accepted: tally.accepted, rejected: tally.rejected, superseded: tally.superseded, ms: Math.round(performance.now() - t0),
			});
		}
		if (denied) throw denied;
		return { stop: tally.stop, items: tally.accepted, bytes: tally.bytes };
	};

	const runBackfill = async (): Promise<void> => {
		while (settings.backfill === 'running' && canUpload()) {
			const busy = deps.busyElsewhere?.() ?? null;
			if (busy) {
				if (waitingFor !== busy) { waitingFor = busy; emitStatus(); }
				await sleep(cfg.busyPollMs);
				continue;
			}
			if (waitingFor) { waitingFor = null; emitStatus(); }
			const cursor = backfillCursor;
			const ids = slice(() => (raw.prepare(`SELECT track_id AS id FROM track_analysis WHERE audio_hash IS NOT NULL AND track_id > ? ORDER BY track_id LIMIT ?`)
				.all(cursor, UPLOAD_PAGE) as Array<{ id: string }>).map((r) => r.id));
			if (ids.length === 0) {
				settings = { ...settings, backfill: 'done' };
				writeCatalogueSettings(raw, settings);
				backfillCursor = '';
				estimate = null;
				clog.info('backfill done', { items: backfillUploaded.items, bytes: backfillUploaded.bytes });
				emitStatus();
				return;
			}
			uploadingBackfill = true;
			const r = await uploadTracks(ids);
			backfillUploaded = { items: backfillUploaded.items + r.items, bytes: backfillUploaded.bytes + r.bytes };
			backfillCursor = ids[ids.length - 1]!;
			if (r.stop) {
				settings = { ...settings, backfill: 'paused' };
				writeCatalogueSettings(raw, settings);
				emitStatus();
				return;
			}
			emitStatus();
			await yieldNow();
		}
	};

	const uploadOnce = async (): Promise<void> => {
		if (!usable()) return;
		if (!ensureAccount()) return;
		// The policy and entitlement come with the inventory.
		if (policy === null) await syncNow();
		if (!canUpload()) return;
		const ids = [...kicked];
		kicked.clear();
		activity = 'uploading';
		emitStatus();
		let done = 0;
		try {
			for (let i = 0; i < ids.length; i += UPLOAD_PAGE) {
				const r = await uploadTracks(ids.slice(i, i + UPLOAD_PAGE));
				done = i + UPLOAD_PAGE;
				if (r.stop) return;
			}
			await runBackfill();
			succeeded();
		} catch (err) {
			for (const id of ids.slice(done)) kicked.add(id);
			fail('upload', err);
		} finally {
			uploadingBackfill = false;
			waitingFor = null;
			activity = null;
			estimate = null;
			emitStatus();
		}
	};

	const uploadNow = async (): Promise<void> => {
		if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }
		if (uploadRun) { uploadAgain = true; return uploadRun; }
		uploadRun = (async () => {
			try {
				do {
					uploadAgain = false;
					await uploadOnce();
				} while (uploadAgain && kicked.size > 0);
			} finally {
				uploadRun = null;
			}
		})();
		return uploadRun;
	};

	const scheduleUpload = (delay: number): void => {
		if (!started || uploadTimer || nextRetryAt !== null) return;
		uploadTimer = setTimeout(() => { uploadTimer = null; void uploadNow(); }, delay);
		uploadTimer.unref?.();
	};

	// ── pending estimate (the backfill button's "≈ N MB") ───────────────

	const refreshEstimate = (): void => {
		if (estimating || !canUpload()) return;
		// Cleared by identity after it settles, like syncNow's run: with no
		// rows the body finishes before its first await.
		const run: Promise<void> = (async () => {
			let items = 0;
			let bytes = 0;
			let cursor = '';
			try {
				for (;;) {
					const ids = slice(() => (raw.prepare(`SELECT track_id AS id FROM track_analysis WHERE audio_hash IS NOT NULL AND track_id > ? ORDER BY track_id LIMIT ?`)
						.all(cursor, UPLOAD_PAGE) as Array<{ id: string }>).map((r) => r.id));
					if (ids.length === 0) break;
					cursor = ids[ids.length - 1]!;
					const p = slice(() => pendingFor(ids));
					items += p.inline.length + p.blobs.length;
					bytes += p.inline.reduce((n, c) => n + c.bytes, 0);
					for (const b of p.blobs) {
						try { bytes += (await fsp.stat(peaksPath(peaksDir!, b.tier, b.t.trackId))).size; } catch { /* gone since */ }
					}
					await yieldNow();
				}
				estimate = { items, bytes, at: Date.now() };
			} catch (err) {
				clog.warn('estimating pending uploads failed', undefined, err);
			} finally {
				emitStatus();
			}
		})();
		estimating = run;
		void run.finally(() => { if (estimating === run) estimating = null; });
	};

	// ── scheduling ──────────────────────────────────────────────────────

	let wakeTimer: ReturnType<typeof setTimeout> | null = null;
	let wakeAt = 0;
	let intervalTimer: ReturnType<typeof setInterval> | null = null;

	const wake = (reason: CatalogueWakeReason): void => {
		if (!started) return;
		// A regained network, a new session, a server that now lists the
		// feature or the user's own action end any backoff; a focus or an
		// ingest does not (the cause of the failure is likely still there).
		if (reason === 'network' || reason === 'session' || reason === 'manual' || reason === 'features' || reason === 'settings') {
			failures = 0;
			breakerUntil = 0;
			clearRetry();
			if (reason === 'features' || reason === 'manual') serverDisabled = false;
		}
		if (nextRetryAt !== null) return;
		const delay = reason === 'ingest' ? INGEST_DEBOUNCE_MS : WAKE_DEBOUNCE_MS;
		const at = Date.now() + delay;
		// An earlier due time wins: a sign-in during an ingest burst runs now.
		if (wakeTimer && wakeAt <= at) return;
		if (wakeTimer) clearTimeout(wakeTimer);
		wakeAt = at;
		wakeTimer = setTimeout(() => {
			wakeTimer = null;
			void syncNow();
		}, delay);
		wakeTimer.unref?.();
	};

	const queueHook: AnalysisCatalogueHook = {
		prepare: (job) => prepare(job),
		persisted: (trackId) => {
			if (!settings.enabled) return;
			kicked.add(trackId);
			scheduleUpload(cfg.uploadDebounceMs);
		},
	};

	return {
		status: () => {
			if (!estimate || Date.now() - estimate.at > ESTIMATE_TTL_MS) refreshEstimate();
			return status();
		},
		setSettings(patch) {
			const next: CatalogueSettings = {
				...settings,
				...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
				...(typeof patch.vectors === 'boolean' ? { vectors: patch.vectors } : {}),
				...(typeof patch.maxKBps === 'number' && Number.isFinite(patch.maxKBps) ? { maxKBps: clampKbps(patch.maxKBps) } : {}),
			};
			const turnedOn = next.enabled && !settings.enabled;
			settings = next;
			writeCatalogueSettings(raw, settings);
			clog.info('settings changed', { enabled: settings.enabled, vectors: settings.vectors, maxKBps: settings.maxKBps });
			if (turnedOn) wake('settings');
			emitStatus();
			return status();
		},
		setBackfill(action) {
			const cur = settings.backfill;
			const next = action === 'start' ? 'running'
				: action === 'resume' ? (cur === 'paused' ? 'running' : cur)
				: action === 'pause' ? (cur === 'running' ? 'paused' : cur)
				: 'off';
			if (action === 'start' && cur !== 'running') {
				backfillCursor = '';
				backfillUploaded = { items: 0, bytes: 0 };
			}
			if (next !== cur) {
				settings = { ...settings, backfill: next };
				writeCatalogueSettings(raw, settings);
				clog.info('backfill', { action, state: next });
			}
			if (next === 'running') {
				lastError = null;
				if (started) void uploadNow();
			}
			emitStatus();
			return status();
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		queueHook,
		remaining,
		wake,
		start() {
			if (started) return;
			started = true;
			intervalTimer = setInterval(() => wake('interval'), cfg.intervalMs);
			intervalTimer.unref?.();
			wake('start');
			if (settings.backfill === 'running' || kicked.size > 0) scheduleUpload(cfg.uploadDebounceMs);
		},
		stop() {
			started = false;
			for (const t of [wakeTimer, uploadTimer, emitTimer]) if (t) clearTimeout(t);
			wakeTimer = uploadTimer = emitTimer = null;
			if (intervalTimer) clearInterval(intervalTimer);
			intervalTimer = null;
			clearRetry();
		},
		syncNow,
		uploadNow,
		isUploading: () => uploadingBackfill,
		stats: () => ({ ...stats }),
	};
}
