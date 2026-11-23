// FlareSolverr supervisor — the browser service that carries Beatport past
// Cloudflare (core enrich/flaresolverr.ts). It runs as a Docker container
// inside WSL; Curator starts it when it loads (unless "Start with Curator"
// is off), starts it on demand from Settings → Discover, restarts it when a
// lookup finds it down, and stops it on quit if this session started it.
//
// Why a container we drive with `docker`, not a process we spawn: its Chrome
// listens on a debug port, which this machine's endpoint agent treats as
// credential theft when it appears on Windows. Inside the WSL VM it stays
// out of sight, and Guy chose to run it there (2026-11-23).
//
// Disabled (CURATOR_DISABLE_FLARESOLVERR=1) is a supported state: Beatport
// then goes direct, as before.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlareSolverrStatus } from '../ipc.js';
import { broadcastEvent } from './events.js';
import { mainLog } from './log.js';

const flog = mainLog.for('flaresolverr');

const CONTAINER = 'flaresolverr';
// Pinned: a new release is a choice, not something a restart picks up.
const IMAGE = 'ghcr.io/flaresolverr/flaresolverr:v3.5.2';
const READY_TIMEOUT_MS = 90_000;
// A lookup that finds the service down restarts it at most this often.
const RESTART_GAP_MS = 60_000;

interface Settings { autoStart: boolean }
interface RunResult { ok: boolean; out: string; err: string; code: string | number | null }

export interface FlareSolverrHost {
	readonly url: string;
	readonly enabled: boolean;
	status(refresh?: boolean): Promise<FlareSolverrStatus>;
	start(): Promise<FlareSolverrStatus>;
	stop(): Promise<FlareSolverrStatus>;
	setAutoStart(on: boolean): Promise<FlareSolverrStatus>;
	// Boot: start it if "Start with Curator" is on.
	boot(): void;
	// For the fetch adapter: what we know about the service, and "it's down".
	describe(): string | null;
	noteDown(): void;
	// Settles when a start under way is done, or after `maxWaitMs`.
	whenReady(maxWaitMs: number): Promise<void>;
	shutdown(): void;
}

export function createFlareSolverrHost(userData: string): FlareSolverrHost {
	const enabled = process.env['CURATOR_DISABLE_FLARESOLVERR'] !== '1';
	const url = (process.env['CURATOR_FLARESOLVERR_URL']?.trim() || 'http://localhost:8191').replace(/\/+$/, '');
	const port = new URL(url).port || '8191';
	const settingsPath = join(userData, 'flaresolverr.json');
	// Docker lives in the WSL distro on Windows; elsewhere, on the host.
	const [cmd, prefix] = process.platform === 'win32' ? ['wsl.exe', ['-e', 'docker']] : ['docker', [] as string[]];

	let settings: Settings = { autoStart: true };
	try {
		if (existsSync(settingsPath)) settings = { ...settings, ...(JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<Settings>) };
	} catch (err) {
		flog.warn('settings unreadable; using defaults', { settingsPath }, err);
	}

	let st: FlareSolverrStatus = {
		enabled, url, state: enabled ? 'unknown' : 'stopped', autoStart: settings.autoStart,
		managed: false, version: null, reason: enabled ? null : 'turned off (CURATOR_DISABLE_FLARESOLVERR=1)', since: Date.now(),
	};
	let inflight: Promise<FlareSolverrStatus> | null = null;
	let lastStartAt = 0;

	const set = (patch: Partial<FlareSolverrStatus>): FlareSolverrStatus => {
		const changed = (patch.state && patch.state !== st.state) || (patch.reason !== undefined && patch.reason !== st.reason);
		st = { ...st, ...patch, ...(patch.state && patch.state !== st.state ? { since: Date.now() } : {}) };
		if (changed) {
			flog.info('status', { state: st.state, reason: st.reason, version: st.version });
			broadcastEvent('flaresolverr:event', st);
		}
		return st;
	};

	const docker = (args: string[], timeoutMs: number): Promise<RunResult> => new Promise((resolve) => {
		execFile(cmd, [...prefix, ...args], { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
			// wsl.exe's own messages are UTF-16; docker's pass through as UTF-8.
			const clean = (s: string | Buffer) => String(s).replace(/\0/g, '').trim();
			const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
			resolve({ ok: !e, out: clean(stdout), err: clean(stderr) || (e ? e.message : ''), code: e ? (e.killed ? 'TIMEOUT' : e.code ?? null) : 0 });
		});
	});

	// A docker failure in words a person can act on.
	const explain = (r: RunResult, timeoutMs: number): string => {
		const text = `${r.err} ${r.out}`;
		if (r.code === 'ENOENT') return `${cmd} not found — ${process.platform === 'win32' ? 'WSL is not installed' : 'Docker is not installed'}`;
		if (r.code === 'TIMEOUT') return `docker did not answer within ${Math.round(timeoutMs / 1000)}s`;
		if (/Cannot connect to the Docker daemon|docker\.sock/i.test(text)) return 'Docker is not running inside WSL (cannot reach the Docker daemon)';
		if (/execvpe\(docker\) failed|docker: not found|No such file or directory/i.test(text)) return 'Docker is not installed in the WSL distro';
		if (/port is already allocated|address already in use/i.test(text)) return `port ${port} is taken by something else`;
		return (r.err || r.out).split('\n')[0]!.slice(0, 300) || `docker exited with ${r.code}`;
	};

	const probe = async (): Promise<{ ok: true; version: string | null } | { ok: false; reason: string }> => {
		try {
			const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(3000) });
			const body = (await res.json()) as { msg?: string; version?: string };
			if (!/ready/i.test(body.msg ?? '')) return { ok: false, reason: `answered but not ready (${body.msg ?? res.status})` };
			return { ok: true, version: body.version ?? null };
		} catch (err) {
			const cause = (err as { cause?: { code?: string } }).cause;
			return { ok: false, reason: cause?.code === 'ECONNREFUSED' ? 'nothing listening' : err instanceof Error ? err.message : String(err) };
		}
	};

	const start = (): Promise<FlareSolverrStatus> => {
		if (!enabled) return Promise.resolve(st);
		inflight ??= (async () => {
			lastStartAt = Date.now();
			const already = await probe();
			if (already.ok) return set({ state: 'running', version: already.version, reason: null });
			set({ state: 'starting', reason: null });
			// Running but not answering = wedged: restart it, but it stays
			// whoever's it was (a container Guy started isn't ours to stop on quit).
			const running = (await docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], 30_000)).out === 'true';
			let r = await docker([running ? 'restart' : 'start', ...(running ? ['-t', '5'] : []), CONTAINER], 60_000);
			if (!r.ok && /No such container/i.test(`${r.err} ${r.out}`)) {
				// First run on this machine: create it. Pulls the image (minutes).
				flog.info('creating container', { image: IMAGE, port });
				r = await docker(['run', '-d', '--name', CONTAINER, '-p', `${port}:8191`, IMAGE], 600_000);
			}
			if (!r.ok) return set({ state: 'failed', reason: explain(r, 60_000) });
			if (!running) st.managed = true;
			let last = 'not answering yet';
			for (const deadline = Date.now() + READY_TIMEOUT_MS; Date.now() < deadline;) {
				const p = await probe();
				if (p.ok) return set({ state: 'running', version: p.version, reason: null });
				last = p.reason;
				await new Promise((res) => setTimeout(res, 1000));
			}
			return set({ state: 'failed', reason: `container started but FlareSolverr did not answer within ${READY_TIMEOUT_MS / 1000}s (${last})` });
		})().finally(() => { inflight = null; });
		return inflight;
	};

	const stop = async (): Promise<FlareSolverrStatus> => {
		if (!enabled) return st;
		await inflight?.catch(() => undefined);
		set({ state: 'stopping' });
		const r = await docker(['stop', '-t', '5', CONTAINER], 30_000);
		if (!r.ok && !/No such container|is not running/i.test(`${r.err} ${r.out}`)) return set({ state: 'failed', reason: `stop failed: ${explain(r, 30_000)}` });
		st.managed = false;
		return set({ state: 'stopped', reason: 'stopped from Settings', version: null });
	};

	return {
		url,
		enabled,
		async status(refresh = false) {
			if (refresh && enabled && !inflight && st.state !== 'stopping') {
				const p = await probe();
				if (p.ok) set({ state: 'running', version: p.version, reason: null });
				else if (st.state === 'running' || st.state === 'unknown') set({ state: 'stopped', reason: `not answering at ${url} (${p.reason})` });
			}
			return st;
		},
		start,
		stop,
		async setAutoStart(on) {
			settings = { ...settings, autoStart: on };
			try {
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			} catch (err) {
				flog.warn('settings write failed', { settingsPath }, err);
			}
			return set({ autoStart: on });
		},
		boot() {
			if (!enabled) return;
			if (settings.autoStart) void start();
			else void this.status(true);
		},
		describe() {
			if (!enabled) return 'turned off (CURATOR_DISABLE_FLARESOLVERR=1)';
			const secs = Math.round((Date.now() - st.since) / 1000);
			switch (st.state) {
				case 'starting': return `Curator is starting it (${secs}s so far)`;
				case 'failed': return `Curator could not start it: ${st.reason}`;
				case 'stopping': return 'it is being stopped';
				case 'stopped': return settings.autoStart
					? `it is stopped${st.reason ? ` (${st.reason})` : ''}; Curator is restarting it`
					: `it is stopped${st.reason ? ` (${st.reason})` : ''} and "Start with Curator" is off — start it in Settings → Discover`;
				case 'running': return `it was running ${secs}s ago — it may have crashed; Curator is restarting it`;
				default: return null;
			}
		},
		noteDown() {
			if (!enabled || inflight || st.state === 'stopping') return;
			if (st.state === 'running') set({ state: 'stopped', reason: 'stopped answering' });
			// Stopped by the user (or auto-start off): leave it stopped.
			if (!settings.autoStart || st.reason === 'stopped from Settings') return;
			if (Date.now() - lastStartAt < RESTART_GAP_MS) return;
			flog.info('lookup found it down; restarting');
			void start();
		},
		async whenReady(maxWaitMs) {
			if (!enabled) return;
			// Asked before boot() ran: the start boot would make, made now (start
			// is shared, so boot joins it rather than starting twice).
			const pending = inflight ?? (st.state === 'unknown' && settings.autoStart ? start() : null);
			if (!pending) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				pending.catch(() => undefined),
				new Promise<void>((res) => { timer = setTimeout(res, maxWaitMs); }),
			]);
			clearTimeout(timer);
		},
		shutdown() {
			// Only what this session started; a container Guy runs by hand stays up.
			if (!enabled || !st.managed) return;
			try {
				spawn(cmd, [...prefix, 'stop', '-t', '3', CONTAINER], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
			} catch (err) {
				flog.warn('stop on quit failed', undefined, err);
			}
		},
	};
}
