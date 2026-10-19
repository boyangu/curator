// Is anyone using Curator? The cloud sync client's fallback poll relaxes to
// its idle cadence once the answer has been "no" for `idleAfterMs`
// (core/sync-log/poll-policy.ts). Decided here in main because only main
// sees the window and the OS: the renderer is never polled, and no per-input
// IPC exists for this — a mouse move must cost nothing.
//
// "Not in use" is either:
//   - the main window is not focused (minimised counts), measured from the
//     moment it lost focus — or the screen was locked, from the lock; or
//   - it is focused but the OS reports no keyboard/mouse input for at least
//     the threshold (powerMonitor.getSystemIdleTime): the user walked away
//     with Curator in front.
//
// Checked on focus/blur, lock/unlock and resume, plus a coarse 30 s timer —
// the only way to notice the system idle time crossing the threshold, and
// cheap (one OS call). Coming back with the window already in front is
// therefore noticed within ~30 s; refocusing the window is instant.

import { app, powerMonitor, type BrowserWindow } from 'electron';
import type { CloudActivityWatcher } from '@curator/core';
import { mainLog } from '../log.js';

const CHECK_MS = 30_000;

const alog = mainLog.for('cloud-activity');

export function watchAppActivity(getWindow: () => BrowserWindow | null, onChange: (active: boolean) => void): CloudActivityWatcher {
	let idleAfterMs = 600_000;
	// Core starts every client "in use"; only a change is reported.
	let active = true;
	// When the window lost focus / the screen locked; null while neither.
	let blurredAt: number | null = null;
	let lockedAt: number | null = null;

	const windowFocused = (): boolean => {
		const w = getWindow();
		return !!w && !w.isDestroyed() && w.isFocused() && !w.isMinimized();
	};

	const check = (): void => {
		const now = Date.now();
		const focused = windowFocused();
		if (focused) blurredAt = null;
		else blurredAt ??= now;
		let idle: boolean;
		if (lockedAt !== null) idle = now - lockedAt >= idleAfterMs;
		else if (!focused) idle = now - (blurredAt ?? now) >= idleAfterMs;
		else idle = powerMonitor.getSystemIdleTime() * 1000 >= idleAfterMs;
		if (active === !idle) return;
		active = !idle;
		alog.debug('activity changed', { active, focused, locked: lockedAt !== null });
		try { onChange(active); } catch (err) { alog.warn('activity listener threw', undefined, err); }
	};

	// Both app-wide events, so another window's focus change only triggers a
	// re-check; check() stamps the blur time once, for the main window.
	const onFocus = (): void => check();
	const onBlur = (): void => check();
	const onLock = (): void => { lockedAt = Date.now(); check(); };
	const onUnlock = (): void => { lockedAt = null; check(); };
	const onResume = (): void => check();

	app.on('browser-window-focus', onFocus);
	app.on('browser-window-blur', onBlur);
	powerMonitor.on('lock-screen', onLock);
	powerMonitor.on('unlock-screen', onUnlock);
	powerMonitor.on('resume', onResume);
	const timer = setInterval(check, CHECK_MS);
	timer.unref?.();
	check();

	return {
		setIdleAfterMs(ms) {
			if (ms === idleAfterMs) return;
			idleAfterMs = ms;
			check();
		},
		stop() {
			clearInterval(timer);
			app.off('browser-window-focus', onFocus);
			app.off('browser-window-blur', onBlur);
			powerMonitor.off('lock-screen', onLock);
			powerMonitor.off('unlock-screen', onUnlock);
			powerMonitor.off('resume', onResume);
		},
	};
}
