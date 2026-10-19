// Host-side manager for the research sidecar (apps/researcher) — a lean
// sibling of AnalyzerSidecar: spawn, newline-framed JSON-RPC, hello
// handshake, capped respawn. Research requests are long (an agent doing
// web research runs 10–60s), so the per-request timeout is generous and
// concurrency is left to the KB queue's agent lane (serialized there —
// the sidecar processes one request at a time by design).
//
// Protocol contract lives at the top of apps/researcher/src/main.ts —
// keep the two in sync.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { log } from '../log.js';

const rlog = log.for('researcher');

export interface ResearcherSidecarOptions {
	executable: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export interface ResearchRequest {
	kind: string;
	aspect: string;
	entity: {
		name: string;
		knownFacts: Record<string, unknown>;
	};
}

export interface ResearchClaim {
	name: string;
	confidence: number;
	citations: string[];
	rationale?: string;
}

// The port the agent resolver depends on — the sidecar satisfies it; tests
// inject a fake.
export interface ResearchPort {
	research(req: ResearchRequest): Promise<{ claims: ResearchClaim[] }>;
}

const EXPECTED_NAME = 'curator-researcher';
const EXPECTED_PROTOCOL = 1;
const REQUEST_TIMEOUT_MS = 180_000;
const RESPAWN_DELAYS_MS = [1000, 5000, 15000, 30000];
const MAX_RESPAWN_BURST = 4;

interface Pending {
	resolve: (r: { claims: ResearchClaim[] }) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

export class ResearcherSidecar implements ResearchPort {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private stdoutBuf = '';
	private stderrBuf = '';
	private respawnAttempts = 0;
	private respawnBurstAt = 0;
	private respawnTimer: NodeJS.Timeout | null = null;
	private shuttingDown = false;
	private disabled = false;

	constructor(private readonly opts: ResearcherSidecarOptions) {}

	start(): void {
		if (this.proc || this.disabled) return;
		this.shuttingDown = false;
		const proc = spawn(this.opts.executable, this.opts.args ?? [], {
			cwd: this.opts.cwd,
			env: { ...process.env, ...this.opts.env },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.proc = proc;
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', (chunk: string) => {
			this.stderrBuf += chunk;
			let idx = this.stderrBuf.indexOf('\n');
			while (idx >= 0) {
				const line = this.stderrBuf.slice(0, idx);
				this.stderrBuf = this.stderrBuf.slice(idx + 1);
				if (line.length > 0) rlog.info(line);
				idx = this.stderrBuf.indexOf('\n');
			}
		});
		proc.on('exit', (code, signal) => this.onExit(code, signal));
		proc.on('error', (err) => rlog.error('spawn error', err));
	}

	research(req: ResearchRequest): Promise<{ claims: ResearchClaim[] }> {
		if (!this.proc || !this.proc.stdin.writable) {
			return Promise.reject(new Error('research sidecar not running'));
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`research timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.proc!.stdin.write(JSON.stringify({ id, method: 'research', params: req }) + '\n');
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		let nl: number;
		while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
			const line = this.stdoutBuf.slice(0, nl);
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (!line.trim()) continue;
			let frame: Record<string, unknown>;
			try {
				frame = JSON.parse(line) as Record<string, unknown>;
			} catch {
				rlog.warn('bad frame', { line: line.slice(0, 200) });
				continue;
			}
			this.dispatch(frame);
		}
	}

	private dispatch(frame: Record<string, unknown>): void {
		if (frame['event'] === 'hello') {
			if (frame['name'] !== EXPECTED_NAME || frame['protocol'] !== EXPECTED_PROTOCOL) {
				this.disabled = true;
				rlog.error('handshake mismatch — research disabled', undefined, {
					gotName: String(frame['name']),
					gotProtocol: String(frame['protocol']),
				});
				try { this.proc?.kill(); } catch { /* already gone */ }
				return;
			}
			rlog.info('sidecar hello', { version: String(frame['version']) });
			return;
		}
		const id = frame['id'];
		if (typeof id !== 'number') return;
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		if (frame['error']) {
			const err = frame['error'] as { message?: string };
			p.reject(new Error(err.message ?? 'research error'));
		} else {
			p.resolve(frame['result'] as { claims: ResearchClaim[] });
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		rlog.warn('sidecar exited', { code, signal, inFlight: this.pending.size });
		this.proc = null;
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(new Error(`research sidecar exited (code=${code}, signal=${signal})`));
		}
		this.pending.clear();
		this.stdoutBuf = '';
		if (this.shuttingDown || this.disabled) return;
		const now = Date.now();
		if (now - this.respawnBurstAt > 60_000) {
			this.respawnBurstAt = now;
			this.respawnAttempts = 0;
		}
		if (this.respawnAttempts >= MAX_RESPAWN_BURST) {
			rlog.error('respawn limit reached — research disabled for this session');
			this.disabled = true;
			return;
		}
		const delay = RESPAWN_DELAYS_MS[Math.min(this.respawnAttempts, RESPAWN_DELAYS_MS.length - 1)]!;
		this.respawnAttempts++;
		this.respawnTimer = setTimeout(() => {
			this.respawnTimer = null;
			this.start();
		}, delay);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.respawnTimer) { clearTimeout(this.respawnTimer); this.respawnTimer = null; }
		if (!this.proc) return;
		try {
			this.proc.stdin.write(JSON.stringify({ method: 'shutdown' }) + '\n');
		} catch { /* ignore */ }
		const proc = this.proc;
		await new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				try { proc.kill('SIGKILL'); } catch { /* */ }
				resolve();
			}, 2000);
			proc.once('exit', () => { clearTimeout(t); resolve(); });
		});
		this.proc = null;
	}
}
