import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERR_NETWORK_CHANGED, LoadRecovery, MAX_AUTO_RELOADS, RELOAD_SETTLE_MS } from './load-recovery.js';

const ERR_ABORTED = -3;

function setup(opts?: { destroyed?: boolean }) {
	const target = { reload: vi.fn(), isDestroyed: vi.fn(() => opts?.destroyed ?? false) };
	const log = { info: vi.fn(), warn: vi.fn() };
	const recovery = new LoadRecovery(target, log);
	return { target, log, recovery };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LoadRecovery', () => {
	it('reloads once after a main-frame ERR_NETWORK_CHANGED, after the settle delay', () => {
		const { target, log, recovery } = setup();
		recovery.onFailLoad(ERR_NETWORK_CHANGED, 'http://localhost:5173/', true);
		expect(target.reload).not.toHaveBeenCalled();
		vi.advanceTimersByTime(RELOAD_SETTLE_MS);
		expect(target.reload).toHaveBeenCalledTimes(1);
		expect(log.info).toHaveBeenCalledTimes(1);
	});

	it('coalesces a burst of failed module requests into one reload', () => {
		const { target, recovery } = setup();
		for (let i = 0; i < 40; i++) recovery.onRequestError('net::ERR_NETWORK_CHANGED', `http://localhost:5173/src/m${i}.ts`);
		vi.advanceTimersByTime(RELOAD_SETTLE_MS);
		expect(target.reload).toHaveBeenCalledTimes(1);
	});

	it('ignores other errors, sub-frames, and other codes', () => {
		const { target, recovery } = setup();
		recovery.onFailLoad(ERR_ABORTED, 'http://localhost:5173/', true);
		recovery.onFailLoad(ERR_NETWORK_CHANGED, 'http://localhost:5173/frame', false);
		recovery.onRequestError('net::ERR_ABORTED', 'http://localhost:5173/src/main.ts');
		recovery.onRequestError('net::ERR_CONNECTION_REFUSED', 'http://localhost:5173/src/main.ts');
		vi.advanceTimersByTime(RELOAD_SETTLE_MS * 10);
		expect(target.reload).not.toHaveBeenCalled();
		expect(recovery.reloadCount).toBe(0);
	});

	it('never loops: stops after the cap and warns exactly once', () => {
		const { target, log, recovery } = setup();
		for (let i = 0; i < MAX_AUTO_RELOADS + 3; i++) {
			recovery.onFailLoad(ERR_NETWORK_CHANGED, 'http://localhost:5173/', true);
			vi.advanceTimersByTime(RELOAD_SETTLE_MS);
		}
		expect(target.reload).toHaveBeenCalledTimes(MAX_AUTO_RELOADS);
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it('does not reload a destroyed window, and dispose cancels a pending reload', () => {
		const destroyed = setup({ destroyed: true });
		destroyed.recovery.onFailLoad(ERR_NETWORK_CHANGED, 'x', true);
		vi.advanceTimersByTime(RELOAD_SETTLE_MS);
		expect(destroyed.target.reload).not.toHaveBeenCalled();

		const disposed = setup();
		disposed.recovery.onFailLoad(ERR_NETWORK_CHANGED, 'x', true);
		disposed.recovery.dispose();
		vi.advanceTimersByTime(RELOAD_SETTLE_MS);
		expect(disposed.target.reload).not.toHaveBeenCalled();
	});
});
