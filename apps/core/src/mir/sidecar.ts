// Node-side client for the AI engine sidecar (apps/mir, Python, Windows-native).
//
// Same stdio JSON-RPC framing and lifecycle as the analyzer client
// (analyzer/sidecar.ts): spawn once, correlate requests by id, hello handshake,
// respawn with capped backoff, reject in-flight requests on exit. Differences:
//   - no WSL path translation (torch runs natively on Windows);
//   - no stderr ImportError sniffing: transformers/muq log the word in harmless
//     warnings, and a genuinely missing module surfaces as a typed 'model'
//     error frame on the request that needed it (the engine imports lazily),
//     which the scheduler turns into a status message instead of a dead sidecar.
// Protocol contract: apps/mir/src/curator_mir/main.py. Keep the two in sync.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { isWellFormedString } from '@curator/shared';
import { log } from '../log.js';

const mlog = log.for('mir');

export interface MirSidecarSpec {
	executable: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export type MirErrorKind =
	| 'decode' | 'model' | 'unsupported' | 'cancelled' | 'oom' | 'internal' | 'sidecar_unavailable';

export interface MirSidecarError extends Error {
	kind: MirErrorKind;
}

export function mirError(kind: MirErrorKind, message: string): MirSidecarError {
	const e = new Error(message) as MirSidecarError;
	e.kind = kind;
	return e;
}

export interface MirCapabilities {
	version: string;
	device: string;
	torch: string;
	threads: number;
	xpu: boolean;
	cuda: boolean;
	cloudConfigured: boolean;
	loaded: string[];
	models: { key: string; modelId: string; dim: number; sampleRate: number; text: boolean;
		license: string; repo: string; summary: string }[];
}

export interface MirSegmentIn { startSec: number; endSec: number; label?: string | null }

export interface MirEmbedding {
	model: string;
	version: number;
	dim: number;
	vec: string; // base64 Float32 LE
	segments: { index: number; startSec: number; endSec: number; label: string | null; vec: string }[];
	loadMs: number;
	ms: number;
}

export interface MirAnalyzeResult {
	trackId: string;
	duration: number;
	sourceSampleRate: number;
	decodeMs: number;
	embeddings: Record<string, MirEmbedding>; // keyed by modelId
}

export type MirBatchItemResult =
	| { trackId: string; result: Omit<MirAnalyzeResult, 'trackId'> }
	| { trackId: string; error: { kind: MirErrorKind; message: string } };

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: MirSidecarError) => void;
	onProgress?: (stage: string, pct: number | null) => void;
}

const RESPAWN_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const MAX_RESPAWN_BURST = 5;
const EXPECTED_NAME = 'curator-mir';
const EXPECTED_PROTOCOL = 1;
const HELLO_TIMEOUT_MS = 20_000;

// Events: 'ready' (hello accepted), 'exit', 'disabled' (gave up respawning or
// handshake mismatch — permanent until app restart).
export class MirSidecar extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private stdoutBuf = '';
	private stderrBuf = '';
	private respawnAttempts = 0;
	private respawnBurstAt = 0;
	private respawnTimer: NodeJS.Timeout | null = null;
	private helloTimer: NodeJS.Timeout | null = null;
	private shuttingDown = false;
	private broken = false;
	ready = false;

	constructor(private readonly spec: MirSidecarSpec) { super(); }

	get disabled(): boolean { return this.broken; }

	start(): void {
		if (this.proc || this.broken) return;
		this.shuttingDown = false;
		this.ready = false;
		const proc = spawn(this.spec.executable, this.spec.args ?? [], {
			cwd: this.spec.cwd,
			env: { ...process.env, ...this.spec.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
			stdio: ['pipe', 'pipe', 'pipe'],
			windowsHide: true,
		});
		this.proc = proc;
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (c: string) => this.onStdout(c));
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (c: string) => {
			this.stderrBuf += c;
			let i = this.stderrBuf.indexOf('\n');
			while (i >= 0) {
				const line = this.stderrBuf.slice(0, i).trimEnd();
				this.stderrBuf = this.stderrBuf.slice(i + 1);
				if (line) mlog.info(line);
				i = this.stderrBuf.indexOf('\n');
			}
		});
		proc.on('exit', (code, signal) => this.onExit(code, signal));
		proc.on('error', (err) => mlog.error('spawn error', err));
		if (this.helloTimer) clearTimeout(this.helloTimer);
		this.helloTimer = setTimeout(() => {
			this.helloTimer = null;
			if (!this.ready && this.proc) mlog.warn('no hello frame yet — engine slow to start or wrong executable', { timeoutMs: HELLO_TIMEOUT_MS });
		}, HELLO_TIMEOUT_MS);
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let nl: number;
		while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
			const line = this.stdoutBuf.slice(0, nl);
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: Record<string, unknown>;
			try { frame = JSON.parse(line) as Record<string, unknown>; }
			catch (err) { mlog.error('bad frame from engine', err, { line: line.slice(0, 200) }); continue; }
			this.dispatch(frame);
		}
	}

	private dispatch(frame: Record<string, unknown>): void {
		const id = frame['id'];
		if (frame['event'] === 'hello') {
			if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
			if (frame['name'] !== EXPECTED_NAME || frame['protocol'] !== EXPECTED_PROTOCOL) {
				this.broken = true;
				mlog.error('engine handshake mismatch — disabled; reprovision apps/mir', undefined,
					{ name: String(frame['name']), protocol: String(frame['protocol']) });
				try { this.proc?.kill(); } catch { /* gone */ }
				return;
			}
			this.ready = true;
			this.respawnAttempts = 0;
			mlog.info('engine hello', { version: String(frame['version']) });
			this.emit('ready');
			return;
		}
		if (typeof id !== 'number') {
			if (frame['error']) mlog.warn('engine error frame without id', { error: frame['error'] });
			return;
		}
		const p = this.pending.get(id);
		if (!p) return;
		if (frame['event'] === 'progress') {
			p.onProgress?.(String(frame['stage']), (frame['pct'] as number | null) ?? null);
			return;
		}
		if (frame['result'] !== undefined || frame['error'] !== undefined) {
			this.pending.delete(id);
			if (frame['error']) {
				const e = frame['error'] as { kind?: string; message?: string };
				p.reject(mirError((e.kind as MirErrorKind) ?? 'internal', e.message ?? 'engine error'));
			} else {
				p.resolve(frame['result']);
			}
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		mlog.warn('engine exited', { code, signal, inFlight: this.pending.size });
		this.proc = null;
		this.ready = false;
		for (const [, p] of this.pending) p.reject(mirError('sidecar_unavailable', `engine exited (code=${code}, signal=${signal})`));
		this.pending.clear();
		this.stdoutBuf = '';
		if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
		this.emit('exit');
		if (this.shuttingDown) return;
		if (this.broken) { this.emit('disabled'); return; }
		const now = Date.now();
		if (now - this.respawnBurstAt > 60_000) { this.respawnBurstAt = now; this.respawnAttempts = 0; }
		if (this.respawnAttempts >= MAX_RESPAWN_BURST) {
			this.broken = true;
			mlog.error('engine respawn limit reached — disabled until restart. See the session log.');
			this.emit('disabled');
			return;
		}
		const delay = RESPAWN_DELAYS_MS[Math.min(this.respawnAttempts, RESPAWN_DELAYS_MS.length - 1)]!;
		this.respawnAttempts++;
		this.respawnTimer = setTimeout(() => { this.respawnTimer = null; this.start(); }, delay);
	}

	private request<T>(method: string, params: Record<string, unknown>,
		onProgress?: (stage: string, pct: number | null) => void): Promise<T> {
		if (!this.proc || !this.proc.stdin.writable) return Promise.reject(mirError('sidecar_unavailable', 'engine not running'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(onProgress ? { onProgress } : {}) });
			try { this.proc!.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
			catch (err) {
				this.pending.delete(id);
				reject(mirError('sidecar_unavailable', err instanceof Error ? err.message : String(err)));
			}
		});
	}

	capabilities(): Promise<MirCapabilities> {
		return this.request<MirCapabilities>('capabilities', {});
	}

	warmup(models: string[]): Promise<{ loaded: string[] }> {
		return this.request('warmup', { models });
	}

	analyze(params: { trackId: string; path: string; models: string[]; segments?: MirSegmentIn[] },
		onProgress?: (stage: string, pct: number | null) => void): Promise<MirAnalyzeResult> {
		// Guard, don't scrub (analyzer precedent): a lone surrogate can't
		// round-trip UTF-8, and scrubbing would name a different file.
		if (!isWellFormedString(params.path)) {
			return Promise.reject(mirError('decode', 'file path is not valid Unicode (lone surrogate)'));
		}
		return this.request<MirAnalyzeResult>('analyze', { ...params }, onProgress);
	}

	analyzeBatchCloud(items: { trackId: string; path: string; segments?: MirSegmentIn[] }[], models: string[]):
		Promise<{ items: MirBatchItemResult[] }> {
		const ok = items.filter((it) => isWellFormedString(it.path));
		return this.request('analyze_batch', { executor: 'cloud', items: ok, models });
	}

	textEmbed(model: string, texts: string[]): Promise<{ modelId: string; dim: number; vecs: string[] }> {
		return this.request('text_embed', { model, texts });
	}

	cancel(trackId: string): void {
		if (!this.proc || !this.proc.stdin.writable) return;
		try { this.proc.stdin.write(JSON.stringify({ method: 'cancel', params: { trackId } }) + '\n'); } catch { /* going away */ }
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
		if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
		const proc = this.proc;
		if (!proc) return;
		try { proc.stdin.write(JSON.stringify({ method: 'shutdown' }) + '\n'); } catch { /* ignore */ }
		// A running embed can't be interrupted mid-window; give it 3 s, then kill.
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => { try { proc.kill(); } catch { /* */ } resolve(); }, 3000);
			proc.once('exit', () => { clearTimeout(t); resolve(); });
		});
		this.proc = null;
	}
}

export function decodeVec(b64: string): Buffer {
	return Buffer.from(b64, 'base64');
}
