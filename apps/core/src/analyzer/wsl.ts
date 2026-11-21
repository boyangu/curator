// Host-side process helpers for the analyzer sidecar. On Windows the analyzer
// lives inside WSL (Essentia has no Windows wheel), and WSL fails in a way a
// plain child process never does: when its service hangs, `wsl.exe` still
// spawns, accepts stdin, and then produces nothing — no output, no exit.

import { spawn, type ChildProcess } from 'node:child_process';

// Kill a child and everything under it. `wsl.exe` relays through a second
// wsl.exe; terminating only the one we spawned strands that relay whenever
// WSL is hung, and the strays pile up across launches.
export function killProcessTree(proc: ChildProcess): void {
	if (process.platform === 'win32' && proc.pid !== undefined) {
		const fallback = (): void => { try { proc.kill(); } catch { /* already gone */ } };
		try {
			const tk = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
			tk.on('error', fallback);
		} catch { fallback(); }
		return;
	}
	try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

// Resolves null when `exe args` exits 0 inside the window, else a reason:
// `hung` when it was still running at the deadline (and has been killed).
export function probeCommand(exe: string, args: string[], timeoutMs: number, hung: string): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: NodeJS.Timeout | null = null;
		const finish = (problem: string | null): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(problem);
		};
		let child: ChildProcess;
		try {
			child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
		} catch (err) {
			finish(`${exe} could not be started: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		timer = setTimeout(() => {
			killProcessTree(child);
			finish(hung);
		}, timeoutMs);
		child.on('error', (err) => finish(`${exe} could not be started: ${err.message}`));
		child.on('exit', (code) => finish(code === 0 ? null : `${exe} failed (exit code ${code})`));
	});
}

// The window covers a cold VM boot (a few seconds, more on a loaded machine);
// a hung service never answers at all.
const WSL_PROBE_TIMEOUT_MS = 30_000;

// Whether WSL can run a process right now: one trivial command in the default
// distro, the same route the analyzer spawn takes (service → VM → distro).
// The reason carries the fix because nothing in the app can apply it —
// restarting the WSL service needs elevation.
export function probeWsl(timeoutMs: number = WSL_PROBE_TIMEOUT_MS): Promise<string | null> {
	return probeCommand(
		'wsl.exe', ['-e', 'true'], timeoutMs,
		'WSL is not responding. Restart it (admin terminal: taskkill /F /IM wslservice.exe) or reboot, then retry.',
	);
}
