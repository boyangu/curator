// First-run provisioning of the engine's Python environment (packaged builds).
//
// torch + transformers make a multi-GB environment, far too big to bundle the
// way the analyzer's PyInstaller onedir is. The app instead ships the engine
// source, its uv.lock and a uv binary, and builds the env on demand into the
// user's app-data folder: `uv sync --frozen` pins every wheel to the lockfile,
// and uv fetches its own managed CPython so nothing depends on a system Python.
// Model weights then download lazily on first use (HF cache under HF_HOME).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface MirProvisionSpec {
	uv: string;          // bundled uv executable
	projectDir: string;  // staged apps/mir (pyproject.toml, uv.lock, src/)
	envDir: string;      // target venv, e.g. <userData>/mir/venv
	pythonDir: string;   // uv-managed CPython install dir
	cacheDir: string;    // uv download cache
	extra: 'cpu' | 'xpu';
}

export function provisionedPython(spec: Pick<MirProvisionSpec, 'envDir'>): string {
	return join(spec.envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

export function isProvisioned(spec: Pick<MirProvisionSpec, 'envDir'>): boolean {
	return existsSync(provisionedPython(spec));
}

export function runProvision(spec: MirProvisionSpec, onLine: (line: string) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(spec.uv, [
			'sync', '--frozen', '--no-install-project', '--extra', spec.extra,
			'--project', spec.projectDir, '--python', '3.11', '--python-preference', 'only-managed',
		], {
			cwd: spec.projectDir,
			env: {
				...process.env,
				UV_PROJECT_ENVIRONMENT: spec.envDir,
				UV_PYTHON_INSTALL_DIR: spec.pythonDir,
				UV_CACHE_DIR: spec.cacheDir,
				NO_COLOR: '1',
			},
			windowsHide: true,
		});
		let buf = '';
		const onData = (c: Buffer): void => {
			buf += c.toString('utf8');
			let i: number;
			while ((i = buf.search(/[\r\n]/)) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (line) onLine(line);
			}
		};
		proc.stdout.on('data', onData);
		proc.stderr.on('data', onData);
		proc.on('error', reject);
		proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`uv sync exited with code ${code}`))));
	});
}
