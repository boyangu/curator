import { describe, expect, it } from 'vitest';
import { probeCommand } from './wsl.js';

// probeWsl is probeCommand over `wsl.exe -e true`; the command is the only
// part that needs WSL, so the behaviour is tested with plain Node children.
describe('probeCommand', () => {
	it('resolves null when the command exits 0 in time', async () => {
		expect(await probeCommand(process.execPath, ['-e', 'process.exit(0)'], 10_000, 'hung')).toBeNull();
	});

	it('reports a command that is still running at the deadline as hung', async () => {
		// Spawns fine and then never finishes — a hung WSL service from the outside.
		const started = Date.now();
		expect(await probeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 300, 'hung')).toBe('hung');
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it('reports a failing exit code', async () => {
		expect(await probeCommand(process.execPath, ['-e', 'process.exit(3)'], 10_000, 'hung')).toContain('exit code 3');
	});

	it('reports a command that cannot be started', async () => {
		expect(await probeCommand('curator-no-such-probe-exe', [], 10_000, 'hung')).toContain('could not be started');
	});
});
