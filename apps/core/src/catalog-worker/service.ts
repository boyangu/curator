// This desktop as a catalogue worker ('catalog_workers'; the master side is
// apps/cloud catalog/workers.ts). Every minute while the app runs and the
// account is signed in to a server that offers it, the worker asks the master
// for the due reads of the objects its user follows, runs the same provider
// readers the cloud runs (@curator/catalog-readers) over this machine's own
// network and Spotify login, and reports each poll back; the master applies
// it as it applies its own and raises the events Discover is fed from.
//
// Why here: the user's Spotify login is the only thing that reads followed
// playlists, every provider sees this machine's IP rather than the cloud's
// one, and a desktop idles most of the week. One worker per user per week:
// the master says `active: false` to a second device, which then only keeps
// asking.
//
// Network-bound, so a core-side loop on the main process like
// library/album-enrich.ts — the Spotify rate gate and Electron's net.fetch
// for Beatport live there. Nothing here writes the library.

import type { CatalogCheckReport, CatalogProvider, CatalogProviderPause, CatalogTracker, CatalogTrackingKind, CatalogWorkerDueResult, CatalogWorkerTask, CloudService } from '@curator/protocol';
import { BandcampTracker, BeatportTracker, DeezerTracker, SpotifyTracker, SpotifyUserPlaylistTracker, TrackerRateLimitedError, type FetchLike, type TrackerAdapter } from '@curator/catalog-readers';
import { gatedFetch, isSpotifyQuotaBackoff, spotifyBackoffUntil } from '@curator/spotify';
import { log } from '../log.js';

const wlog = log.for('catalog-worker');

// The master's cadence; the sync client's active poll is the same minute.
export const CATALOG_WORKER_TICK_MS = 60_000;
// The first ask after start: let the window and the first sync come up.
const FIRST_TICK_MS = 5_000;
// After the transport failed (offline, the server erroring, signed out mid-call).
const TRANSPORT_BACKOFF_MS = 5 * 60_000;
// Results per report call (the protocol caps a call at 100).
const REPORT_BATCH = 20;

export type CatalogWorkerStatus = {
	// Whether this desktop may read for the catalogue, and why not.
	reason: 'ok' | 'signed_out' | 'server_off' | 'inactive' | 'stopped';
	// The master's answer: this device holds its user's week.
	active: boolean;
	providers: CatalogProvider[];
	// The user's checked trackers (settings.ts), as offered on the last ask.
	trackers: CatalogTracker[];
	weekEndsAt: number | null;
	lastAskedAt: number | null;
	lastReportAt: number | null;
	// This session's tallies.
	polled: number;
	events: number;
	// Tasks in hand right now.
	inHand: number;
	// Providers parked after a rate limit this machine met.
	paused: CatalogProviderPause[];
	lastError: string | null;
	// The last check (a Refresh's "check now") while its reads drain: how
	// many it queued and how many of those this machine has read since.
	// Null once an ask came back with nothing in hand.
	check: { at: number; queued: number; polled: number } | null;
};

export type CatalogWorkerCheck = { kind?: CatalogTrackingKind };

export type CatalogWorkerPort = Pick<CloudService['catalog'], 'workerDue' | 'workerReport'>;

export type CatalogWorkerDeps = {
	// The master's procedures, or null while this build has no cloud transport.
	procs: () => CatalogWorkerPort | null;
	deviceId: () => string;
	// Signed in, and the server offers 'catalog_workers'.
	offered: () => 'ok' | 'signed_out' | 'server_off';
	// The user's Spotify access token, or null while Spotify is not connected.
	spotifyToken: () => Promise<string | null>;
	// The user's checked trackers (settings.ts checkedTrackers), read on every
	// ask so a change in the Refresh menu applies at the next one.
	trackers: () => CatalogTracker[];
	// Electron's net.fetch for Beatport (apps/desktop main/index.ts); plain
	// fetch otherwise.
	beatportFetch?: FetchLike;
	fetchFn?: FetchLike;
	// Tests: readers of their own, and a faster clock.
	adapters?: readonly TrackerAdapter[];
	tickMs?: number;
	firstTickMs?: number;
	now?: () => number;
};

export interface CatalogWorker {
	// Arm the loop (idempotent): the desktop main calls it after the renderer
	// is up, like startFeedPolling.
	start(): void;
	stop(): void;
	status(): CatalogWorkerStatus;
	subscribe(cb: (s: CatalogWorkerStatus) => void): () => void;
	// Ask now instead of at the next minute, with a check (a Refresh: the
	// user's follows of the kind, every checked kind without one, become due
	// on the checked sources and are leased by the same ask). Resolves with
	// the master's report once the ask is answered — the reads it handed out
	// go on in the background. Null while the worker cannot ask (stopped,
	// signed out, the server without the feature, or the ask failed).
	tickNow(check: CatalogWorkerCheck): Promise<CatalogCheckReport | null>;
}

export function createCatalogWorker(deps: CatalogWorkerDeps): CatalogWorker {
	const now = deps.now ?? Date.now;
	const fetchFn = deps.fetchFn ?? ((u, i) => fetch(u, i));
	const token = async (signal?: AbortSignal): Promise<string> => {
		void signal;
		const t = await deps.spotifyToken();
		if (!t) throw new Error('Spotify is not connected');
		return t;
	};
	// The Spotify readers share the process-wide gate with the feed's producers.
	const spotifyFetch: FetchLike = (u, i) => gatedFetch(u, i);
	const adapters: readonly TrackerAdapter[] = deps.adapters ?? [
		new DeezerTracker(fetchFn),
		new BandcampTracker(fetchFn),
		new BeatportTracker(deps.beatportFetch ?? fetchFn),
		new SpotifyTracker({ token }, spotifyFetch),
		// Whatever the playlist: this machine's own login reads it.
		new SpotifyUserPlaylistTracker({ token: () => token() }, spotifyFetch),
	];

	const status: CatalogWorkerStatus = { reason: 'stopped', active: false, providers: [], trackers: [], weekEndsAt: null, lastAskedAt: null, lastReportAt: null, polled: 0, events: 0, inHand: 0, paused: [], lastError: null, check: null };
	const snapshot = (): CatalogWorkerStatus => ({ ...status, providers: [...status.providers], trackers: [...status.trackers], paused: livePauses(), check: status.check ? { ...status.check } : null });
	const listeners = new Set<(s: CatalogWorkerStatus) => void>();
	const emit = (): void => {
		const snap = snapshot();
		for (const l of listeners) {
			try {
				l(snap);
			} catch (err) {
				wlog.warn('status listener failed', undefined, err);
			}
		}
	};
	// Providers this machine parked itself, until when. Spotify's pause is
	// also the provider gate's quota ban (@curator/spotify), which any caller
	// in this process may have taken and which survives a restart.
	const pausedUntil = new Map<CatalogProvider, number>();
	const livePauses = (): CatalogProviderPause[] => {
		for (const [p, until] of pausedUntil) if (until <= now()) pausedUntil.delete(p);
		const ban = spotifyBackoffUntil();
		if (ban > now() && (pausedUntil.get('spotify') ?? 0) < ban) pausedUntil.set('spotify', ban);
		return [...pausedUntil].map(([provider, until]) => ({ provider, until }));
	};

	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = true;
	let inFlight: Promise<unknown> | null = null;
	let aborter = new AbortController();

	const run = (check?: CatalogWorkerCheck): Promise<CatalogCheckReport | null> => {
		const p = tick(check).finally(() => {
			if (inFlight === p) inFlight = null;
		});
		inFlight = p;
		return p;
	};
	const schedule = (ms: number): void => {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			void run();
		}, ms);
		timer.unref();
	};

	// What this machine can read right now: Spotify only while a token vends.
	const providersNow = async (): Promise<CatalogProvider[]> => {
		const offered = new Set<CatalogProvider>();
		for (const a of adapters) offered.add(a.provider);
		if (offered.has('spotify') && !(await deps.spotifyToken().catch(() => null))) offered.delete('spotify');
		return [...offered];
	};

	async function tick(check?: CatalogWorkerCheck): Promise<CatalogCheckReport | null> {
		const procs = deps.procs();
		const offered = deps.offered();
		if (!procs || offered !== 'ok') {
			status.reason = procs ? offered : 'server_off';
			status.active = false;
			status.inHand = 0;
			status.check = null;
			emit();
			schedule(deps.tickMs ?? CATALOG_WORKER_TICK_MS);
			return null;
		}
		let next = deps.tickMs ?? CATALOG_WORKER_TICK_MS;
		let report: CatalogCheckReport | null = null;
		try {
			// A provider that rate-limited this machine is not one it can read
			// now: left out of the offer, so the master's own pass (its token,
			// its IP) reads it instead of standing aside for the pause.
			const paused = livePauses();
			const parked = new Set(paused.map((p) => p.provider));
			const providers = (await providersNow()).filter((p) => !parked.has(p));
			const trackers = deps.trackers();
			status.providers = providers;
			status.trackers = trackers;
			const due = await procs.workerDue({ deviceId: deps.deviceId(), providers, trackers, paused, ...(check ? { check } : {}) });
			status.lastAskedAt = now();
			status.reason = 'ok';
			status.active = due.active;
			status.weekEndsAt = due.weekEndsAt;
			status.lastError = null;
			if (due.check) {
				report = due.check;
				status.check = { at: now(), queued: due.check.queued, polled: 0 };
			} else if (!due.tasks.length) status.check = null;
			if (due.active && due.tasks.length) {
				await work(procs, due);
				// The master hands a tick's worth at a time (its BATCH): ask again
				// at once while it has more, so a check drains in minutes.
				next = 0;
			} else status.inHand = 0;
			if (!due.active) status.reason = 'inactive';
		} catch (err) {
			// Offline, the server erroring, the session gone mid-call: later.
			status.lastError = err instanceof Error ? err.message : String(err);
			status.inHand = 0;
			wlog.warn('tick failed; backing off', { error: status.lastError });
			next = TRANSPORT_BACKOFF_MS;
		}
		status.paused = livePauses();
		emit();
		schedule(next);
		return report;
	}

	// Polls the handed tasks, paced per provider, and reports them in batches.
	async function work(procs: CatalogWorkerPort, due: CatalogWorkerDueResult): Promise<void> {
		status.inHand = due.tasks.length;
		emit();
		const results: Parameters<CatalogWorkerPort['workerReport']>[0]['results'] = [];
		const lastCallAt = new Map<string, number>();
		const flush = async (): Promise<void> => {
			if (!results.length) return;
			const batch = results.splice(0, results.length);
			const r = await procs.workerReport({ deviceId: deps.deviceId(), results: batch });
			status.lastReportAt = now();
			status.polled += r.applied;
			status.events += r.events;
			if (r.stale) wlog.info('report: stale results', { stale: r.stale });
			emit();
		};
		for (const task of due.tasks) {
			if (stopped) break;
			results.push({ objectId: task.objectId, provider: task.provider, outcome: await poll(task, lastCallAt) });
			status.inHand--;
			if (status.check) status.check.polled++;
			if (results.length >= REPORT_BATCH) await flush();
		}
		await flush();
		status.inHand = 0;
	}

	async function poll(task: CatalogWorkerTask, lastCallAt: Map<string, number>): Promise<Parameters<CatalogWorkerPort['workerReport']>[0]['results'][number]['outcome']> {
		const adapter = adapters.find((a) => a.provider === task.provider && a.kinds.includes(task.kind));
		if (!adapter) return { error: { message: `no reader for ${task.kind} on ${task.provider}`, rateLimitedSec: null } };
		// The tracker's pacing between this machine's polls of one provider.
		const last = lastCallAt.get(task.provider);
		if (last !== undefined && task.minGapMs > 0) {
			const wait = last + task.minGapMs - now();
			if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		}
		lastCallAt.set(task.provider, now());
		// A ban that landed mid-batch (another caller's 429, or a restart with
		// one stored): the rest of the batch is reported as the wait it is,
		// not as failed polls, and no call goes out for it.
		const banned = task.provider === 'spotify' ? spotifyBackoffUntil() : 0;
		if (banned > now()) {
			const sec = Math.ceil((banned - now()) / 1000);
			return { error: { message: `rate limited (${sec}s)`, rateLimitedSec: sec } };
		}
		try {
			const signal = AbortSignal.any([AbortSignal.timeout(task.timeoutMs), aborter.signal]);
			return { poll: await adapter.poll(task.target, signal) };
		} catch (err) {
			if (err instanceof TrackerRateLimitedError) {
				pausedUntil.set(task.provider, now() + err.retryAfterSec * 1000);
				wlog.warn('provider rate-limited this machine', { provider: task.provider, retryAfterSec: err.retryAfterSec });
				return { error: { message: err.message, rateLimitedSec: err.retryAfterSec } };
			}
			if (isSpotifyQuotaBackoff(err)) {
				const sec = Math.max(1, Math.ceil((spotifyBackoffUntil() - now()) / 1000));
				return { error: { message: `rate limited (${sec}s)`, rateLimitedSec: sec } };
			}
			return { error: { message: err instanceof Error ? err.message : String(err), rateLimitedSec: null } };
		}
	}

	return {
		start() {
			if (!stopped) return;
			stopped = false;
			aborter = new AbortController();
			status.reason = deps.offered();
			emit();
			schedule(deps.firstTickMs ?? FIRST_TICK_MS);
		},
		stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			aborter.abort();
			status.reason = 'stopped';
			status.active = false;
			status.inHand = 0;
			status.check = null;
			emit();
		},
		status() {
			return snapshot();
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => {
				listeners.delete(cb);
			};
		},
		async tickNow(check) {
			if (stopped) return null;
			if (timer) clearTimeout(timer);
			timer = null;
			// An ask in flight (its reads included) finishes first: one ask at a
			// time, and the check's cursors are leased by the ask that carries it.
			if (inFlight) await inFlight.catch(() => undefined);
			if (stopped) return null;
			return run(check);
		},
	};
}
