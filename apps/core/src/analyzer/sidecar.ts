// Node-side manager for the Python analyzer sidecar.
//
// Responsibilities:
//   1. Spawn the sidecar process when the host says so (start()) and keep it
//      alive. Construction never spawns: on Windows the spawn boots WSL,
//      whose Hyper-V vEthernet adapter coming up makes Chromium abort every
//      in-flight request with ERR_NETWORK_CHANGED — so the desktop main
//      defers start() until the window has loaded (CoreService.startAnalyzer).
//      Requests made before the first start() wait for it instead of failing.
//   2. Wrap stdio JSON-RPC in a typed request/response API. Requests are
//      correlated by id; multiple in-flight requests multiplex over the same
//      pipe.
//   3. Re-spawn on crash with exponential backoff. Pending requests rejected
//      with a typed error so the queue can retry/surface them.
//   4. Provide event streams (progress, partial) per request.
//   5. Know whether the process is actually alive — a launch check, the hello
//      window and a heartbeat — and say so (`status`, the 'health' event). A
//      hung process is killed and treated like a crashed one; without this a
//      request written to its stdin waits forever and the job reads as
//      running.
//
// The protocol contract is documented at the top of
// apps/analyzer/src/curator_analyzer/main.py. Keep the two in sync.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isWellFormedString } from '@curator/shared';
import type { ProductionMeasurements } from '@curator/shared/schema';
import { log } from '@curator/sync-core/log';
import { killProcessTree } from './wsl.js';

const alog = log.for('analyzer');

export interface SidecarOptions {
	// Absolute path to the Python sidecar entry. In dev: the venv python +
	// `-m curator_analyzer.main`. In production: the bundled PyInstaller
	// binary path. Resolved by the desktop main process and passed in here.
	executable: string;
	args?: string[];
	// Working directory for the spawned process. Should contain the bundled
	// model weights / config if any.
	cwd?: string;
	// Environment overrides — e.g. PYTHONPATH in dev, PATH adjustments to
	// the bundled ffmpeg binary in production.
	env?: NodeJS.ProcessEnv;
	// When true, translate file paths between Windows form ('c:/foo/bar')
	// and WSL form ('/mnt/c/foo/bar') across the JSON-RPC boundary. Needed
	// when the analyzer runs inside WSL (no published Windows wheel for
	// Essentia) while the rest of the app uses native Windows paths.
	translatePathsToWsl?: boolean;
	// Launch check, run before every spawn: resolves null when the host the
	// analyzer runs in can take a process, else a user-facing reason. The
	// desktop main passes a WSL probe on Windows — spawning `wsl.exe` into a
	// hung WSL service succeeds and then never produces a byte, which from
	// here looks exactly like a slow start.
	preflight?: () => Promise<string | null>;
	// Liveness timings (tests shorten them).
	helloTimeoutMs?: number;
	pingIntervalMs?: number;
}

// Liveness of the analyzer as the status surfaces show it (getAnalysisStatus
// and the health subscription).
//   off           no analyzer in this build (reported by the service)
//   idle          start() not called yet — the desktop main defers it
//   starting      launching: launch check, spawn, waiting for the hello frame
//   ready         said hello and answers the heartbeat
//   unresponsive  failed a liveness check; being relaunched
//   disabled      gave up — restart() tries again
export type AnalyzerHealth =
	| { state: 'off' | 'idle' | 'starting' }
	| { state: 'ready'; version: string | null }
	| { state: 'unresponsive' | 'disabled'; reason: string };

// c:/foo/bar.flac  → /mnt/c/foo/bar.flac
// C:\foo\bar.flac  → /mnt/c/foo/bar.flac
// Paths without a drive letter pass through unchanged.
function winToWsl(p: string): string {
	const m = p.match(/^([A-Za-z]):[/\\](.*)$/);
	if (!m) return p;
	return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}`;
}

// /mnt/c/foo/bar.flac → c:/foo/bar.flac (the scanner's normalized form).
function wslToWin(p: string): string {
	const m = p.match(/^\/mnt\/([a-z])\/(.*)$/);
	if (!m) return p;
	return `${m[1]}:/${m[2]}`;
}

export interface ProgressEvent {
	trackId: string;
	stage: 'decode' | 'fingerprint' | 'beatgrid' | 'downbeats' | 'key' | 'features' | 'structure' | 'peaks' | 'done';
	pct: number | null;
}

export interface PartialEvent {
	trackId: string;
	fields: Record<string, unknown>;
}

// Advanced feature keys the user can request via the Analyze window.
// All six are MusicExtractor-derived (Essentia is all-or-nothing on ME),
// so the worker runs ME if any one of these is in the list and skips ME
// entirely when the list is empty / undefined. The keys match the
// `track_analysis` column names directly so renderer code and persistence
// don't need a translation table.
export type AdvancedFeature =
	| 'brightness'
	| 'power'
	| 'dynamic_complexity'
	| 'loudness_range_lu'
	| 'dissonance'
	| 'density';

export const ADVANCED_FEATURES: readonly AdvancedFeature[] = [
	'brightness',
	'power',
	'dynamic_complexity',
	'loudness_range_lu',
	'dissonance',
	'density',
];

// Per-call analyzer tuning. Optional; absent ⇒ Python-side defaults apply
// (rhythmMethod = 'multifeature', features = [] meaning skip
// MusicExtractor). The scanner-driven auto-analyse path never sets this;
// only the user-driven "Analyze…" window does. Forward-compatible:
// unknown keys are silently ignored by the worker so a newer renderer
// talking to an older sidecar still works.
//
// Override flags: by default the analyzer never overwrites an existing
// beatgrid / bpm / key / segments row — these are "respect what's there"
// fields because they're typically rb-sourced and the user has invested
// effort matching cues to that grid. Set the corresponding override flag
// from the Analyze modal to force overwrite on a per-field basis. These
// are evaluated in persist.ts persistAnalysisResult, not in the Python worker.
export interface AnalyzeOptions {
	// RhythmExtractor2013 method. 'multifeature' is the robust-but-slow
	// default; 'degara' is ~2x faster with a small accuracy hit on
	// non-4/4 material.
	rhythmMethod?: 'multifeature' | 'degara';
	// Advanced features to compute. Empty/undefined ⇒ skip MusicExtractor
	// (fast basic analysis: bpm/key/beatgrid/peaks only).
	features?: readonly AdvancedFeature[];
	// Force overwrite of the existing beatgrid + downbeats. Default off:
	// once a grid lands (from rb import or a prior analyzer run), it stays
	// unless the user explicitly opts in.
	overrideBeatgrid?: boolean;
	// Force overwrite of the existing track_analysis.bpm.
	overrideBpm?: boolean;
	// Force overwrite of the existing track_analysis.keyCamelot + keyStrength.
	overrideKey?: boolean;
	// Force overwrite of the existing structural segmentation (segmentsJson +
	// intro/outro/drop scalars). Same atomic-group rule as the segment
	// stage: all six fields move together.
	overrideSegments?: boolean;
	// Force regeneration of the waveform peaks (.cpk). Default off: when a
	// track already has peaks on disk, the queue sets `skipPeaks` so a re-run
	// doesn't redo the (relatively cheap but non-trivial) decode + band pass.
	// Ticking this in the Analyze modal clears the skip so the peaks are
	// rebuilt — e.g. to upgrade an older mono waveform to stereo L/R.
	overridePeaks?: boolean;
	// Prior-value injection — when these are present, the Python worker
	// skips the corresponding detection stage and uses the prior values
	// directly. Filled in by queue.dispatchOne from the existing
	// track_analysis row when the user has NOT ticked the corresponding
	// override flag above. Saves CPU AND keeps downstream analytics
	// anchored on the authoritative values instead of freshly-detected-
	// then-discarded ones. MusicExtractor (advanced features) does its own
	// internal beat/key detection and can't be injected — out of scope.
	//
	// Beatgrid/bpm/downbeats: skip RhythmExtractor2013 (~2-3s/track).
	priorBeatgrid?: readonly number[];   // float seconds, ascending
	priorDownbeats?: readonly number[];  // float seconds, subset of priorBeatgrid
	priorBpm?: number;
	// Key (Camelot string + strength): skip KeyExtractor (~0.5-1s/track).
	priorKey?: string;
	priorKeyStrength?: number;
	// Segments: when true, the worker skips the entire structural
	// segmentation stage (novelty curve + peak picking + labelling) and
	// returns empty segments + null scalars. The TS-side preserveSegments
	// guard then leaves the existing row untouched. Saves ~1-3s/track on
	// the segment stage. Boolean rather than an array because the worker
	// doesn't need to know the prior values — it just needs to know "don't
	// bother".
	skipSegments?: boolean;
	// Beatgrid + BPM: when true, the worker skips RhythmExtractor2013 AND
	// returns bpm=null, beatgrid=[]. preserveBpm + preserveBeatgrid then
	// no-op the write. Implies skipSegments (segments need beats), which
	// the worker enforces defensively. Used by the auto-analyze sub-flag
	// model when the user doesn't want background re-detection of grids
	// they've already committed to (typically: rb-sourced).
	skipBeatgrid?: boolean;
	// Key: when true, the worker skips KeyExtractor and returns null/null.
	// preserveKey no-ops the write.
	skipKey?: boolean;
	// Peaks/waveform: when true, the worker skips the decode + band pass and
	// leaves the existing .cpk files untouched. Set by the queue when peaks
	// already exist and the user hasn't ticked the Waveform override.
	skipPeaks?: boolean;
	// Fingerprint: when true, the worker skips the Chromaprint stage and
	// returns fingerprint=null. Off by default — the stage runs on the mono
	// decode every pass already pays for (~0.1 s) and the queue writes the
	// print onto the local source_link only when one was produced.
	skipFingerprint?: boolean;
	// Production measurements (stage 7): opt-in like the advanced bundle —
	// a stereo decode plus a few seconds of DSP per track.
	production?: boolean;
	// The track's existing segments, injected by buildEffectiveOptions next
	// to skipSegments so the production stage can still report per-section
	// rows when the structure stage doesn't run this pass.
	priorSegments?: readonly { startSec: number; endSec: number; label?: string | null }[];
	// Beat times for the production stage's kick measures when this pass has
	// no Curator grid (skipped or never computed): the Rekordbox grid. Not a
	// prior — the worker never returns it as the track's beatgrid.
	productionBeats?: readonly number[];
}

export interface AnalyzeParams {
	trackId: string;
	path: string;
	outPeaksLoPath: string;  // 20 Hz strip — always loaded by the UI
	outPeaksHiPath: string;  // 100 Hz detail — loaded only for deck/big view
	options?: AnalyzeOptions;
}

// Phase 2A segment record on the JSON-RPC wire. Mirrors the Python dataclass
// dict produced by worker._build_segments / _label_segments. persist.ts persistAnalysisResult
// re-maps to the canonical TS `SegmentRecord` from @curator/shared/schema.
export interface AnalyzerSegment {
	startSec: number;
	endSec: number;
	label: 'intro' | 'build' | 'drop' | 'breakdown' | 'main' | 'outro' | 'unknown';
	confidence: number;
	energy: number;
}

export interface AnalyzeResult {
	track_id: string;
	duration: number;
	bpm: number | null;
	beatgrid: number[];
	downbeats: number[];
	key_camelot: string | null;
	key_strength: number | null;
	// `brightness` is the curator-aligned learned score (analyzer 2.3.0+), `power`
	// the new energy/density score — both from the Python scoring.py.
	brightness: number | null;
	power: number | null;
	// Product names mirroring the Python AnalyzeResult dataclass. `density` =
	// Essentia's lowlevel.spectral_complexity.mean.
	dynamic_complexity: number | null;
	loudness_range_lu: number | null;
	dissonance: number | null;
	density: number | null;
	// Stage 6 — structural segmentation. Empty array on stage failure; the
	// five derived scalars are non-null counts (0) when the stage ran cleanly
	// but found nothing labelled, and `null` only when the stage itself failed.
	segments: AnalyzerSegment[];
	intro_length_sec: number | null;
	outro_length_sec: number | null;
	first_drop_sec: number | null;
	drop_count: number | null;
	breakdown_count: number | null;
	// Chromaprint of the first 120 s (AcoustID window) + the integer duration
	// AcoustID lookups take with it. Both null when skipped or failed.
	fingerprint: string | null;
	fingerprint_duration_sec: number | null;
	// Stage 7 — production measurements. Null when the stage was not
	// requested (options.production) or failed; persist.ts writes the group
	// only when present. Optional: a pre-2.5.0 sidecar omits the key.
	production?: ProductionMeasurements | null;
	features: Record<string, unknown>;
	peaks_lo_path: string;
	peaks_hi_path: string;
	analyzer_version: string;
}

export interface SidecarError extends Error {
	kind: 'decode' | 'beatgrid' | 'key' | 'structure' | 'peaks' | 'internal' | 'cancelled' | 'sidecar_unavailable';
}

function sidecarError(kind: SidecarError['kind'], message: string): SidecarError {
	const e = new Error(message) as SidecarError;
	e.kind = kind;
	return e;
}

interface PendingRequest {
	resolve: (r: AnalyzeResult) => void;
	reject: (e: SidecarError) => void;
	trackId: string;
}

// Re-spawn backoff. We don't want a runaway respawn loop if the sidecar
// crash-loops (missing python, broken Essentia install, etc.) — cap at 30s
// and stop trying after MAX_RESPAWN consecutive failures inside a minute.
const RESPAWN_DELAYS_MS = [500, 1000, 2000, 5000, 10000, 30000];
const MAX_RESPAWN_BURST = 6;

// Hello handshake. The sidecar's first stdout frame announces
// {event:'hello', name, version, protocol}; we refuse to talk to a process
// announcing the wrong name or protocol (wrong executable, stale PyInstaller
// bundle) instead of letting it produce schema-mismatched results. A process
// that never says hello is not running the analyzer at all: it used to pass
// with a warning, and a hung WSL then swallowed every job for days while the
// queue showed them as running. The window covers a cold start — the worker
// imports alone (Essentia, read over /mnt/c) take 10-25 s.
const EXPECTED_SIDECAR_NAME = 'curator-analyzer';
const EXPECTED_PROTOCOL = 1;
const HELLO_TIMEOUT_MS = 90_000;

// Heartbeat. After the hello the host pings on an interval, and ANY frame
// from the sidecar counts as life — so a bundle that predates `ping` still
// passes (it answers with an unknown-method error). Progress frames can't do
// this job: the worker buffers them and they arrive with the result.
const PING_INTERVAL_MS = 15_000;
const PING_MISSES_ALLOWED = 3;

// Liveness failures in a row (launch check, hello window, heartbeat) before
// the sidecar stops relaunching and waits for restart(). A hello resets it.
const MAX_UNRESPONSIVE_STRIKES = 3;

// Python import failures look like this in stderr. When we see one, the
// sidecar is permanently broken (a missing-dep can't fix itself) — stop
// respawning immediately and surface a single actionable message instead
// of cycling through six tracebacks. Tested against `scipy`, `essentia`,
// `numpy`, `soundfile` failure modes.
const IMPORT_ERROR_PATTERNS = [
	/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/,
	/ImportError: (.+)/,
];

export interface SidecarConfig {
	// Worker-process pool size; one analysis per worker, one core per worker.
	workers: number;
}

export class AnalyzerSidecar extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private stdoutBuffer = '';
	private stderrBuf = '';
	private respawnAttempts = 0;
	private respawnBurstAt = 0;
	private respawnTimer: NodeJS.Timeout | null = null;
	private shuttingDown = false;
	// Set once we observe a Python import error in stderr — scheduleRespawn
	// then refuses to restart. A missing module can't fix itself, and looping
	// six retries just floods the console with the same traceback.
	private permanentlyBroken = false;
	// Why the sidecar stopped for good (import error, handshake mismatch,
	// executable not found, respawn limit). Set when 'disabled' is emitted;
	// surfaced to user-initiated enqueues so a click isn't silently parked.
	private disabledReason: string | null = null;
	private helloSeen = false;
	private helloTimer: NodeJS.Timeout | null = null;
	private health: AnalyzerHealth = { state: 'idle' };
	private unresponsiveStrikes = 0;
	// The launch check is running; no process yet. Requests park (as before
	// the first start) instead of bouncing off a process that isn't there.
	private preflighting = false;
	private heartbeatTimer: NodeJS.Timeout | null = null;
	// When the sidecar last wrote anything, and when the heartbeat last ran.
	private lastFrameAt = 0;
	private lastBeatAt = 0;
	// Logical CPUs as the sidecar sees them (from the hello frame). Under
	// WSL this is the VM's allowance, which .wslconfig can cap below the
	// host's — so it, not os.cpus(), bounds the user's worker choice.
	private cpuCount: number | null = null;
	// Last configure() payload, re-sent after every (re)spawn so a crashed
	// sidecar comes back with the user's pool size rather than the default.
	private config: SidecarConfig | null = null;
	// Until the first start(), analyze() parks requests here rather than
	// rejecting them: the queue treats `sidecar_unavailable` as transient and
	// would re-dispatch the same job in a loop for as long as the deferred
	// start takes. Flushed by start(); rejected by shutdown()/cancel().
	private started = false;
	private awaitingStart: Array<{
		params: AnalyzeParams;
		resolve: (r: AnalyzeResult) => void;
		reject: (e: SidecarError) => void;
	}> = [];

	constructor(private readonly opts: SidecarOptions) { super(); }

	// True once start() has been called (whether or not the process is alive
	// right now — a crashed sidecar respawns on its own).
	get hasStarted(): boolean { return this.started; }

	// Non-null once the sidecar has given up (no further respawns).
	get disabled(): string | null { return this.disabledReason; }

	get cpus(): number | null { return this.cpuCount; }

	get status(): AnalyzerHealth { return this.health; }

	private setHealth(next: AnalyzerHealth): void {
		if (JSON.stringify(next) === JSON.stringify(this.health)) return;
		this.health = next;
		this.emit('health', next);
	}

	// Resize the sidecar's worker pool. Fire-and-forget (no reply frame): the
	// sidecar swaps in a pool of the new size for new work and lets the old
	// one finish what it holds, so nothing running is interrupted. Safe
	// before start() — the value is sent on hello.
	configure(cfg: SidecarConfig): void {
		this.config = { ...cfg };
		this.sendConfig();
	}

	private sendConfig(): void {
		if (!this.config || !this.proc || !this.proc.stdin.writable) return;
		try {
			this.proc.stdin.write(JSON.stringify({ method: 'configure', params: this.config }) + '\n');
		} catch { /* sidecar going away; the respawn re-sends */ }
	}

	// Idempotent — a no-op while a process is alive or a launch is under way.
	start(): void {
		if (this.proc || this.preflighting) return;
		this.shuttingDown = false;
		this.started = true;
		// An unresponsive sidecar keeps saying so through its relaunch, until
		// a hello frame proves otherwise.
		if (this.health.state !== 'unresponsive') this.setHealth({ state: 'starting' });
		const preflight = this.opts.preflight;
		if (!preflight) { this.spawnProcess(); return; }
		this.preflighting = true;
		preflight()
			.catch((err: unknown) => `analyzer launch check failed: ${err instanceof Error ? err.message : String(err)}`)
			.then((problem) => {
				this.preflighting = false;
				if (this.shuttingDown) return;
				if (problem) this.failUnresponsive(problem);
				else this.spawnProcess();
			});
	}

	// Relaunch on request — the way back from 'disabled', and a shortcut
	// through the backoff while unresponsive. No-op before the first start()
	// (the host decides when that is) and while a process is alive or
	// launching: a live-but-hung one is the heartbeat's to catch.
	restart(): void {
		if (!this.started || this.shuttingDown || this.proc || this.preflighting) return;
		if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
		this.permanentlyBroken = false;
		this.disabledReason = null;
		this.unresponsiveStrikes = 0;
		this.respawnAttempts = 0;
		alog.info('restart requested');
		this.setHealth({ state: 'starting' });
		this.start();
	}

	private spawnProcess(): void {
		const proc = spawn(this.opts.executable, this.opts.args ?? [], {
			cwd: this.opts.cwd,
			env: {
				...process.env,
				...this.opts.env,
				PYTHONUNBUFFERED: '1',
				// Force UTF-8 stdio — without it, Windows' cp1252 default
				// makes print() raise on any non-Latin-1 character (Polish,
				// Japanese, emoji …) and kills the sidecar mid-job.
				PYTHONIOENCODING: 'utf-8',
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc = proc;

		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk: string) => {
			// Python's tracebacks and Essentia's warnings come through here —
			// route them into the session log, line-buffered so a traceback
			// split across chunks doesn't produce broken records.
			this.stderrBuf += chunk;
			let idx = this.stderrBuf.indexOf('\n');
			while (idx >= 0) {
				const line = this.stderrBuf.slice(0, idx);
				this.stderrBuf = this.stderrBuf.slice(idx + 1);
				if (line.length > 0) log.for('analyzer').info(line);
				idx = this.stderrBuf.indexOf('\n');
			}
			this.detectImportError(chunk);
		});
		proc.on('exit', (code, signal) => this.onExit(proc, code, signal));
		// 'ready' means a process actually exists — the queue resumes on it,
		// so emitting before a failed spawn would buy one more doomed dispatch.
		let spawned = false;
		proc.once('spawn', () => {
			spawned = true;
			this.emit('ready');
		});
		proc.on('error', (err) => {
			alog.error('spawn error', err);
			// A process that never started emits 'error' and NO 'exit' (e.g.
			// `wsl` not on PATH → ENOENT), so without this every request
			// written to its buffered stdin would hang forever and the queue's
			// jobs would sit in 'running'. Post-spawn errors (a failed kill)
			// leave a live process whose own 'exit' does the cleanup.
			if (spawned) return;
			const code = (err as NodeJS.ErrnoException).code;
			// The executable isn't there — retrying won't conjure it up.
			if (code === 'ENOENT') this.markBroken(`analyzer executable not found: ${this.opts.executable}`);
			for (const s of [proc.stdin, proc.stdout, proc.stderr]) s.destroy();
			this.onExit(proc, null, null, `analyzer failed to start: ${err.message}`);
		});
		// Requests are written the moment the process is spawned; if the spawn
		// failed that write can error on stdin, and an unhandled stream error
		// would take the host down. The 'error' handler above rejects them.
		proc.stdin.on('error', (err) => {
			alog.warn('stdin write failed', undefined, err);
		});

		this.helloSeen = false;
		if (this.helloTimer) clearTimeout(this.helloTimer);
		const helloTimeoutMs = this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
		this.helloTimer = setTimeout(() => {
			this.helloTimer = null;
			if (this.helloSeen || this.proc !== proc) return;
			this.failUnresponsive(`The analyzer did not start (no hello frame after ${Math.round(helloTimeoutMs / 1000)} s).`);
		}, helloTimeoutMs);

		// stdin buffers until the interpreter reads it, so parked requests can
		// go out now rather than after the hello frame.
		const parked = this.awaitingStart.splice(0);
		for (const p of parked) this.analyze(p.params).then(p.resolve, p.reject);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		const interval = this.opts.pingIntervalMs ?? PING_INTERVAL_MS;
		this.lastFrameAt = this.lastBeatAt = Date.now();
		this.heartbeatTimer = setInterval(() => {
			const now = Date.now();
			// Timers stop while the machine sleeps (and stall with the event
			// loop): the first beat afterwards would count the whole gap as
			// the sidecar's silence. Start the count again instead.
			if (now - this.lastBeatAt > interval * 2) this.lastFrameAt = now;
			this.lastBeatAt = now;
			if (now - this.lastFrameAt > interval * PING_MISSES_ALLOWED) {
				this.failUnresponsive('The analyzer stopped responding.');
				return;
			}
			if (!this.proc || !this.proc.stdin.writable) return;
			try { this.proc.stdin.write(JSON.stringify({ id: this.nextId++, method: 'ping' }) + '\n'); }
			catch { /* going away; 'exit' cleans up */ }
		}, interval);
		this.heartbeatTimer.unref?.();
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
	}

	// A liveness check failed (launch check, hello window, heartbeat). The
	// process, if there is one, is hung rather than dead, so nothing else
	// would ever reject what it holds: kill it, hand the work back, relaunch.
	// MAX_UNRESPONSIVE_STRIKES in a row and the sidecar stops for restart().
	private failUnresponsive(reason: string): void {
		this.unresponsiveStrikes++;
		const giveUp = this.unresponsiveStrikes >= MAX_UNRESPONSIVE_STRIKES;
		alog.warn('analyzer unresponsive', { reason, strike: this.unresponsiveStrikes, giveUp });
		if (giveUp) this.markBroken(reason);
		else this.setHealth({ state: 'unresponsive', reason });
		const proc = this.proc;
		if (proc) {
			killProcessTree(proc);
			// A hung process may never deliver 'exit', and anything it still
			// writes belongs to no one — settle now; onExit's guard drops the
			// real event if it does come.
			for (const s of [proc.stdin, proc.stdout, proc.stderr]) s.destroy();
			this.onExit(proc, null, null, reason);
			return;
		}
		for (const p of this.awaitingStart.splice(0)) p.reject(sidecarError('sidecar_unavailable', reason));
		this.scheduleRespawn();
	}

	private onStdout(chunk: string): void {
		this.lastFrameAt = Date.now();
		this.stdoutBuffer += chunk;
		// Frames are newline-delimited JSON. Process one frame at a time;
		// leftover partials stay in the buffer for the next chunk.
		let nl: number;
		while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
			const line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: unknown;
			try { frame = JSON.parse(line); }
			catch (err) {
				alog.error('bad frame from sidecar', err, { line });
				continue;
			}
			this.dispatchFrame(frame as Record<string, unknown>);
		}
	}

	private dispatchFrame(frame: Record<string, unknown>): void {
		const id = frame['id'] as number | null | undefined;
		const event = frame['event'] as string | undefined;

		if (event === 'hello') {
			this.helloSeen = true;
			if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
			const name = frame['name'];
			const protocol = frame['protocol'];
			if (name !== EXPECTED_SIDECAR_NAME || protocol !== EXPECTED_PROTOCOL) {
				// Wrong executable or incompatible wire format — letting it run
				// would produce silently-wrong results. Kill; onExit sees
				// permanentlyBroken and refuses to respawn.
				this.markBroken('analyzer handshake mismatch — stale or wrong sidecar build');
				alog.error(
					'sidecar handshake mismatch — sidecar disabled; rebuild or repoint it',
					undefined,
					{ gotName: String(name), gotProtocol: String(protocol), expectedName: EXPECTED_SIDECAR_NAME, expectedProtocol: EXPECTED_PROTOCOL },
				);
				try { this.proc?.kill(); } catch { /* already gone */ }
				return;
			}
			const cpus = frame['cpus'];
			if (typeof cpus === 'number' && cpus >= 1) this.cpuCount = Math.floor(cpus);
			alog.info('sidecar hello', { version: String(frame['version']), protocol: String(protocol), cpus: String(cpus) });
			this.unresponsiveStrikes = 0;
			this.setHealth({ state: 'ready', version: typeof frame['version'] === 'string' ? frame['version'] : null });
			this.startHeartbeat();
			this.sendConfig();
			return;
		}

		// Heartbeat answer — the arrival itself was the point (onStdout).
		if (event === 'pong') return;

		if (event === 'progress' && typeof id === 'number') {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.emit('progress', {
				trackId: pending.trackId,
				stage: frame['stage'] as ProgressEvent['stage'],
				pct: (frame['pct'] as number | null) ?? null,
			} satisfies ProgressEvent);
			return;
		}

		if (event === 'partial' && typeof id === 'number') {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.emit('partial', {
				trackId: pending.trackId,
				fields: (frame['fields'] as Record<string, unknown> | undefined) ?? {},
			} satisfies PartialEvent);
			return;
		}

		// Terminal frames: result or error.
		if (typeof id === 'number' && (frame['result'] !== undefined || frame['error'] !== undefined)) {
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			if (frame['error']) {
				const err = frame['error'] as { kind?: string; message?: string };
				pending.reject(sidecarError(
					(err.kind as SidecarError['kind']) ?? 'internal',
					err.message ?? 'analyzer error',
				));
			} else {
				const result = frame['result'] as AnalyzeResult;
				if (this.opts.translatePathsToWsl) {
					// Echo paths come back in WSL form; the rest of the app
					// expects Windows form so we flip them back before resolving.
					if (result.peaks_lo_path) result.peaks_lo_path = wslToWin(result.peaks_lo_path);
					if (result.peaks_hi_path) result.peaks_hi_path = wslToWin(result.peaks_hi_path);
				}
				pending.resolve(result);
			}
			return;
		}

		alog.warn('unhandled frame', { frame });
	}

	// `proc` guards against a late event from a process we've already
	// written off (a failed spawn handled via 'error', then a stray 'exit').
	private onExit(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null, reason?: string): void {
		if (this.proc !== proc) return;
		alog.warn('sidecar exited', { code, signal, inFlight: this.pending.size, ...(reason ? { reason } : {}) });
		this.proc = null;
		// Reject every in-flight request — caller decides retry policy. The
		// queue treats `sidecar_unavailable` as transient: the job goes back
		// to 'queued' and the queue waits for 'ready' before dispatching again.
		const message = reason ?? `sidecar exited (code=${code}, signal=${signal})`;
		for (const [, p] of this.pending) {
			p.reject(sidecarError('sidecar_unavailable', message));
		}
		this.pending.clear();
		this.stdoutBuffer = '';
		if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
		this.stopHeartbeat();

		if (this.shuttingDown) return;
		// A crash: back to launching (an unresponsive one keeps its state).
		if (this.health.state === 'ready' && !this.permanentlyBroken) this.setHealth({ state: 'starting' });
		this.scheduleRespawn();
	}

	private markBroken(reason: string): void {
		this.permanentlyBroken = true;
		this.disabledReason ??= reason;
	}

	private scheduleRespawn(): void {
		if (this.permanentlyBroken) {
			this.disabledReason ??= 'analyzer stopped';
			this.setHealth({ state: 'disabled', reason: this.disabledReason });
			this.emit('disabled');
			return;
		}
		const now = Date.now();
		if (now - this.respawnBurstAt > 60_000) {
			this.respawnBurstAt = now;
			this.respawnAttempts = 0;
		}
		if (this.respawnAttempts >= MAX_RESPAWN_BURST) {
			alog.error('respawn limit reached — sidecar disabled. Investigate the sidecar logs.');
			this.disabledReason = 'analyzer kept crashing and was stopped — see the analyzer log';
			this.setHealth({ state: 'disabled', reason: this.disabledReason });
			this.emit('disabled');
			return;
		}
		const delay = RESPAWN_DELAYS_MS[Math.min(this.respawnAttempts, RESPAWN_DELAYS_MS.length - 1)]!;
		this.respawnAttempts++;
		this.respawnTimer = setTimeout(() => {
			this.respawnTimer = null;
			alog.info('respawning sidecar', { attempt: this.respawnAttempts });
			this.start();
		}, delay);
	}

	// Watch stderr for Python ImportError / ModuleNotFoundError. Hitting one
	// of those means the Python env is broken (missing dep, wrong version);
	// no point respawning. Mark the sidecar permanently broken and log one
	// actionable line.
	private detectImportError(chunk: string): void {
		if (this.permanentlyBroken) return;
		for (const pat of IMPORT_ERROR_PATTERNS) {
			const m = chunk.match(pat);
			if (!m) continue;
			this.markBroken(`analyzer Python environment is broken (import failed${m[1] ? `: ${m[1]}` : ''})`);
			const missing = m[1];
			alog.error(
				'disabled — Python import failed. Fix: set up apps/analyzer\'s venv per apps/analyzer/README.md, or set CURATOR_DISABLE_ANALYZER=1 to skip spawning the sidecar.',
				undefined,
				{ missing },
			);
			return;
		}
	}

	// Submit an analyze request. Promise resolves with the parsed result or
	// rejects with a typed SidecarError. Progress/partial events are emitted
	// on `this` keyed by trackId (subscribe before calling).
	analyze(params: AnalyzeParams): Promise<AnalyzeResult> {
		// Guard, don't scrub: a path with a lone UTF-16 surrogate (NTFS allows
		// them) cannot round-trip UTF-8 to Python, and scrubbing it would
		// silently name a DIFFERENT file. Reject this one request loudly so
		// the queue marks the track failed instead of the JSON boundary
		// corrupting the path.
		for (const p of [params.path, params.outPeaksLoPath, params.outPeaksHiPath]) {
			if (!isWellFormedString(p)) {
				return Promise.reject(sidecarError('internal', `file path is not valid Unicode (lone surrogate): ${p.replace(/[\uD800-\uDFFF]/g, '�')}`));
			}
		}
		if ((!this.started || this.preflighting) && !this.shuttingDown) {
			return new Promise<AnalyzeResult>((resolve, reject) => {
				this.awaitingStart.push({ params, resolve, reject });
			});
		}
		if (!this.proc || !this.proc.stdin.writable) {
			return Promise.reject(sidecarError('sidecar_unavailable', this.disabledReason ?? 'sidecar not running'));
		}
		const id = this.nextId++;
		const wsl = this.opts.translatePathsToWsl === true;
		return new Promise<AnalyzeResult>((resolve, reject) => {
			this.pending.set(id, { resolve, reject, trackId: params.trackId });
			// Translate the typed AnalyzeOptions to the snake_case shape the
			// Python worker reads. Only emitted when present so the wire
			// stays compact for the common default-options case.
			//
			// override* flags are deliberately NOT forwarded — they're
			// consumed in persist.ts persistAnalysisResult on the TS side to gate which
			// fields get written, not by the worker.
			const wireOptions = params.options
				? {
					...(params.options.rhythmMethod !== undefined
						? { rhythm_method: params.options.rhythmMethod }
						: {}),
					...(params.options.features !== undefined
						? { features: [...params.options.features] }
						: {}),
					...(params.options.priorBeatgrid !== undefined
						? { prior_beatgrid: [...params.options.priorBeatgrid] }
						: {}),
					...(params.options.priorDownbeats !== undefined
						? { prior_downbeats: [...params.options.priorDownbeats] }
						: {}),
					...(params.options.priorBpm !== undefined
						? { prior_bpm: params.options.priorBpm }
						: {}),
					...(params.options.priorKey !== undefined
						? { prior_key: params.options.priorKey }
						: {}),
					...(params.options.priorKeyStrength !== undefined
						? { prior_key_strength: params.options.priorKeyStrength }
						: {}),
					...(params.options.skipSegments
						? { skip_segments: true }
						: {}),
					...(params.options.skipBeatgrid
						? { skip_beatgrid: true }
						: {}),
					...(params.options.skipKey
						? { skip_key: true }
						: {}),
					...(params.options.skipPeaks
						? { skip_peaks: true }
						: {}),
					...(params.options.skipFingerprint
						? { skip_fingerprint: true }
						: {}),
					...(params.options.production
						? { production: true }
						: {}),
					...(params.options.production && params.options.productionBeats?.length
						? { production_beats: [...params.options.productionBeats] }
						: {}),
					...(params.options.production && params.options.priorSegments?.length
						? { prior_segments: params.options.priorSegments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, label: s.label ?? null })) }
						: {}),
				}
				: undefined;
			const payload = JSON.stringify({
				id,
				method: 'analyze',
				params: {
					trackId: params.trackId,
					path: wsl ? winToWsl(params.path) : params.path,
					outPeaksLoPath: wsl ? winToWsl(params.outPeaksLoPath) : params.outPeaksLoPath,
					outPeaksHiPath: wsl ? winToWsl(params.outPeaksHiPath) : params.outPeaksHiPath,
					...(wireOptions ? { options: wireOptions } : {}),
				},
			});
			try { this.proc!.stdin.write(payload + '\n'); }
			catch (err) {
				this.pending.delete(id);
				reject(sidecarError('sidecar_unavailable', err instanceof Error ? err.message : String(err)));
			}
		});
	}

	cancel(trackId: string): void {
		const parked = this.awaitingStart.filter((p) => p.params.trackId === trackId);
		if (parked.length > 0) {
			this.awaitingStart = this.awaitingStart.filter((p) => p.params.trackId !== trackId);
			for (const p of parked) p.reject(sidecarError('cancelled', 'cancelled before the analyzer started'));
		}
		if (!this.proc || !this.proc.stdin.writable) return;
		const payload = JSON.stringify({ method: 'cancel', params: { trackId } });
		try { this.proc.stdin.write(payload + '\n'); } catch { /* sidecar going away anyway */ }
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
		if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
		this.stopHeartbeat();
		for (const p of this.awaitingStart.splice(0)) {
			p.reject(sidecarError('sidecar_unavailable', 'analyzer shut down before it started'));
		}
		if (!this.proc) return;
		try {
			this.proc.stdin.write(JSON.stringify({ method: 'shutdown' }) + '\n');
		} catch { /* ignore */ }
		// Give the sidecar 2s to exit cleanly before killing it.
		const proc = this.proc;
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				killProcessTree(proc);
				resolve();
			}, 2000);
			proc.once('exit', () => { clearTimeout(t); resolve(); });
		});
		this.proc = null;
	}
}
