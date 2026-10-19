// Host-side manager for the agent sidecar (apps/agent) — the researcher
// manager's spawn/handshake/respawn skeleton plus the bidirectional parts:
// streamed delta fan-out, reverse-RPC tool-call dispatch, cancellation, and
// re-arm (configure) after a respawn.
//
// Protocol contract lives at apps/agent/src/protocol.ts; host-side copy of
// the types in ./protocol.ts — keep them in sync.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { log } from '../log.js';
import {
	AGENT_PROTOCOL,
	AGENT_SIDECAR_NAME,
	type AgentConfig,
	type AgentDelta,
	type ClassifyResult,
	type RunParams,
	type RunResult,
	type WireMessage,
} from './protocol.js';

const alog = log.for('agent');

export interface AgentSidecarSpec {
	executable: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

// Per-run callbacks. Deltas stream as they arrive; tool calls are executed
// by the host (the registry) and their results posted back to the sidecar.
export interface RunHandlers {
	onDelta(delta: AgentDelta): void;
	onToolCall(callId: string, tool: string, args: unknown): Promise<unknown>;
	// Per-tool watchdog override — long-running host tools (the workspace
	// pipeline map) need more than the default before the manager gives up
	// and reports a tool-error. Absent/undefined ⇒ TOOL_CALL_TIMEOUT_MS.
	toolTimeoutMs?(tool: string): number | undefined;
}

const CONFIGURE_TIMEOUT_MS = 10_000;
const CLASSIFY_TIMEOUT_MS = 30_000;
// Host-side per-tool-call watchdog: a tool that hangs must not wedge the
// whole turn — the sidecar receives a tool-error and the model reacts.
const TOOL_CALL_TIMEOUT_MS = 60_000;
const RESPAWN_DELAYS_MS = [1000, 5000, 15000, 30000];
const MAX_RESPAWN_BURST = 4;

interface Pending {
	resolve: (r: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout | null;
}

export class AgentSidecarManager {
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
	// Last config — re-armed automatically after a respawn (the sidecar is
	// stateless; without this a crash would silently un-configure it).
	private lastConfig: AgentConfig | null = null;
	// Active run's handlers, keyed by turnId — routes delta + tool-call frames.
	private runs = new Map<string, RunHandlers>();

	constructor(private readonly opts: AgentSidecarSpec) {}

	get available(): boolean {
		return this.proc !== null && !this.disabled;
	}

	get configured(): boolean {
		return this.lastConfig !== null;
	}

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
				if (line.length > 0) alog.info(line);
				idx = this.stderrBuf.indexOf('\n');
			}
		});
		proc.on('exit', (code, signal) => this.onExit(code, signal));
		proc.on('error', (err) => alog.error('spawn error', err));
	}

	async configure(config: AgentConfig): Promise<void> {
		this.lastConfig = config;
		if (!this.proc) this.start();
		await this.rpc('configure', config, CONFIGURE_TIMEOUT_MS);
	}

	clearConfig(): void {
		this.lastConfig = null;
	}

	async classify(messages: WireMessage[]): Promise<ClassifyResult> {
		return (await this.rpc('classify', { messages }, CLASSIFY_TIMEOUT_MS)) as ClassifyResult;
	}

	// One streamed turn. No RPC timeout — turns are long by design; the
	// AgentService enforces the per-turn wall clock via cancel().
	async run(params: RunParams, handlers: RunHandlers): Promise<RunResult> {
		this.runs.set(params.turnId, handlers);
		try {
			return (await this.rpc('run', params, null)) as RunResult;
		} finally {
			this.runs.delete(params.turnId);
		}
	}

	cancel(turnId: string): void {
		this.notify({ method: 'cancel', params: { turnId } });
	}

	private rpc(method: string, params: unknown, timeoutMs: number | null): Promise<unknown> {
		if (this.disabled) return Promise.reject(new Error('agent sidecar disabled'));
		if (!this.proc || !this.proc.stdin.writable) return Promise.reject(new Error('agent sidecar not running'));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = timeoutMs
				? setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`agent ${method} timed out after ${timeoutMs / 1000}s`));
				}, timeoutMs)
				: null;
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.proc!.stdin.write(JSON.stringify({ id, method, params }) + '\n');
			} catch (err) {
				if (timer) clearTimeout(timer);
				this.pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private notify(frame: Record<string, unknown>): void {
		if (!this.proc || !this.proc.stdin.writable) return;
		try {
			this.proc.stdin.write(JSON.stringify(frame) + '\n');
		} catch { /* dying process — exit handler cleans up */ }
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
				alog.warn('bad frame', { line: line.slice(0, 200) });
				continue;
			}
			this.dispatch(frame);
		}
	}

	private dispatch(frame: Record<string, unknown>): void {
		if (frame['event'] === 'hello') {
			if (frame['name'] !== AGENT_SIDECAR_NAME || frame['protocol'] !== AGENT_PROTOCOL) {
				this.disabled = true;
				alog.error('handshake mismatch — agent disabled', undefined, {
					gotName: String(frame['name']),
					gotProtocol: String(frame['protocol']),
				});
				try { this.proc?.kill(); } catch { /* already gone */ }
				return;
			}
			alog.info('sidecar hello', { version: String(frame['version']) });
			// Respawn re-arm: the fresh process boots unconfigured.
			if (this.lastConfig) {
				this.rpc('configure', this.lastConfig, CONFIGURE_TIMEOUT_MS).catch((err: unknown) => {
					alog.error('re-configure after respawn failed', err instanceof Error ? err : undefined);
				});
			}
			return;
		}
		if (frame['event'] === 'delta') {
			const handlers = this.runs.get(String(frame['turnId']));
			if (handlers) {
				try { handlers.onDelta(frame['delta'] as AgentDelta); } catch (err) { alog.warn('delta handler threw', undefined, err); }
			}
			return;
		}
		if (frame['event'] === 'tool-call') {
			const turnId = String(frame['turnId']);
			const callId = String(frame['callId']);
			const tool = String(frame['tool']);
			const handlers = this.runs.get(turnId);
			if (!handlers) {
				this.notify({ method: 'tool-error', callId, message: 'no active turn for tool call' });
				return;
			}
			void this.executeToolCall(handlers, callId, tool, frame['args']);
			return;
		}
		const id = frame['id'];
		if (typeof id !== 'number') return;
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		if (p.timer) clearTimeout(p.timer);
		if (frame['error']) {
			const err = frame['error'] as { message?: string };
			p.reject(new Error(err.message ?? 'agent error'));
		} else {
			p.resolve(frame['result']);
		}
	}

	private async executeToolCall(handlers: RunHandlers, callId: string, tool: string, args: unknown): Promise<void> {
		let timedOut = false;
		const timeoutMs = handlers.toolTimeoutMs?.(tool) ?? TOOL_CALL_TIMEOUT_MS;
		const watchdog = setTimeout(() => {
			timedOut = true;
			this.notify({ method: 'tool-error', callId, message: `tool ${tool} timed out after ${timeoutMs / 1000}s` });
		}, timeoutMs);
		try {
			const result = await handlers.onToolCall(callId, tool, args);
			if (!timedOut) this.notify({ method: 'tool-result', callId, result });
		} catch (err) {
			if (!timedOut) this.notify({ method: 'tool-error', callId, message: err instanceof Error ? err.message : String(err) });
		} finally {
			clearTimeout(watchdog);
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		alog.warn('sidecar exited', { code, signal, inFlight: this.pending.size });
		this.proc = null;
		for (const [, p] of this.pending) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(new Error(`agent sidecar exited (code=${code}, signal=${signal})`));
		}
		this.pending.clear();
		this.runs.clear();
		this.stdoutBuf = '';
		if (this.shuttingDown || this.disabled) return;
		const now = Date.now();
		if (now - this.respawnBurstAt > 60_000) {
			this.respawnBurstAt = now;
			this.respawnAttempts = 0;
		}
		if (this.respawnAttempts >= MAX_RESPAWN_BURST) {
			alog.error('respawn limit reached — agent disabled for this session');
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
