// The real rekordbox sidecar (apps/rekordbox, the dev venv) and the Python
// helpers beside this package, plus the "is rekordbox open?" probe.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT } from './paths.js';

const execFileAsync = promisify(execFile);

export const REKORDBOX_APP_DIR = join(REPO_ROOT, 'apps', 'rekordbox');

// The interpreter the desktop's dev spec uses (getRekordboxSpec): the
// sidecar's own venv, where pyrekordbox and sqlcipher3 live. CURATOR_PY wins.
export function pythonExe(): string {
	const venv = join(REKORDBOX_APP_DIR, '.venv', process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python'));
	return process.env['CURATOR_PY'] ?? venv;
}

export function pythonAvailable(): boolean {
	return !!process.env['CURATOR_PY'] || existsSync(pythonExe());
}

export type SidecarSpec = { executable: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv };

// The desktop's dev spec, plus the write guard: with CURATOR_RB_WRITE_ROOT
// set, open_for_write / backup / restore_backup / clear_backups refuse any
// path outside `writeRoot` (main.py write_root_refusal). TMP/TEMP point the
// read-side snapshot copies (reader.py snapshot_db_to_temp) into the work dir.
export function rekordboxSidecarSpec(writeRoot: string, tmpDir: string): SidecarSpec {
	return {
		executable: pythonExe(),
		args: ['-m', 'curator_rekordbox.main'],
		cwd: REKORDBOX_APP_DIR,
		env: { PYTHONPATH: join(REKORDBOX_APP_DIR, 'src'), CURATOR_RB_WRITE_ROOT: writeRoot, TMP: tmpDir, TEMP: tmpDir, TMPDIR: tmpDir },
	};
}

// Pioneer's rekordbox processes (not our own `curator-rekordbox` sidecar,
// the exclusion reader.py is_rekordbox_running makes). pyrekordbox refuses
// to commit while one runs, even to a copy; the run checks first so the
// refusal is a clear message, not a failed push.
export async function rekordboxProcesses(): Promise<string[]> {
	const names = process.platform === 'win32'
		? (await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout
			.split(/\r?\n/).map((l) => /^"([^"]*)"/.exec(l)?.[1] ?? '').filter(Boolean)
		: (await execFileAsync('ps', ['-A', '-o', 'comm='], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n').map((l) => l.trim());
	return [...new Set(names.filter((n) => /rekordbox/i.test(n) && !/curator/i.test(n)))];
}

// Runs one of e2e/py's scripts with the venv interpreter. stderr is kept for
// the error message; nothing is read from stdout.
export async function runPythonScript(script: string, args: readonly string[], opts: { tmpDir: string }): Promise<void> {
	const file = join(REPO_ROOT, 'e2e', 'py', script);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(pythonExe(), [file, ...args], {
			cwd: REKORDBOX_APP_DIR,
			env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', TMP: opts.tmpDir, TEMP: opts.tmpDir, TMPDIR: opts.tmpDir },
			windowsHide: true,
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let err = '';
		child.stderr.on('data', (b: Buffer) => { err += b.toString('utf8'); if (err.length > 64_000) err = err.slice(-64_000); });
		child.on('error', reject);
		child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}: ${err.trim().split('\n').slice(-12).join('\n')}`))));
	});
}
