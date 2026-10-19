// Typed main → renderer event emission. The only sanctioned way to push on
// an EventChannels channel — raw webContents.send(channel, payload) calls
// bypass the payload typing and let a renamed channel rot silently (the
// preload subscription would keep listening on the old name with no
// compile error anywhere). Both helpers are typed against the same
// EventChannels map the preload derives its subscriptions from, so emitter
// and listener can't disagree on channel name or payload shape.

import { BrowserWindow } from 'electron';
import type { EventChannels } from '../ipc.js';

// Broadcast to every open window. The default — all current event streams
// are global app state (sync progress, analyzer ticks, audio position).
export function broadcastEvent<K extends keyof EventChannels>(channel: K, payload: EventChannels[K]): void {
	for (const w of BrowserWindow.getAllWindows()) {
		if (!w.isDestroyed()) w.webContents.send(channel, payload);
	}
}

// Targeted variant for per-window streams (e.g. a download progress bar
// owned by the window that initiated it).
export function sendEvent<K extends keyof EventChannels>(
	win: BrowserWindow | null,
	channel: K,
	payload: EventChannels[K],
): void {
	if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
