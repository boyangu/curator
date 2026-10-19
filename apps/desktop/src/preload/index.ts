import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { TOOL_CATALOG, EVENT_CATALOG, LOG_BATCH_CHANNEL, type Api, type IpcChannels } from '../ipc.js';

// Channel list is derived from TOOL_CATALOG so adding a channel to the catalog
// automatically exposes it on `window.api`. No hand-maintained array.
const channels = Object.keys(TOOL_CATALOG) as (keyof IpcChannels)[];

const api = channels.reduce((acc, ch) => {
	(acc as Record<string, unknown>)[ch] = (...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
	return acc;
}, {} as Api);

// Event subscriptions derive from EVENT_CATALOG the same way invoke channels
// derive from TOOL_CATALOG — adding an event there exposes the typed onX
// method here with no hand-written binding (the Api type carries the payload
// typing; this loop is just the runtime plumbing).
for (const [method, channel] of Object.entries(EVENT_CATALOG)) {
	(api as Record<string, unknown>)[method] = (cb: (payload: unknown) => void) => {
		const listener = (_evt: unknown, payload: unknown): void => cb(payload);
		ipcRenderer.on(channel, listener);
		return () => ipcRenderer.off(channel, listener);
	};
}

// Chromium-native zoom. setZoomLevel takes an integer-ish "level" where each
// unit ≈ 20% (level 1 ≈ 1.2× factor, level -1 ≈ 0.83×). Clamped here so a
// runaway keypress can't push the UI to unreadable extremes.
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;
const ZOOM_STEP = 0.5;
api.zoom = {
	in: () => webFrame.setZoomLevel(Math.min(webFrame.getZoomLevel() + ZOOM_STEP, ZOOM_MAX)),
	out: () => webFrame.setZoomLevel(Math.max(webFrame.getZoomLevel() - ZOOM_STEP, ZOOM_MIN)),
	reset: () => webFrame.setZoomLevel(0),
	get: () => webFrame.getZoomLevel(),
	set: (n: number) => webFrame.setZoomLevel(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n))),
};

// tRPC transport bridge. One generic channel fronts the whole main-side
// router; the renderer's typed client (data/trpc.ts) supplies the typing. Kept
// outside the catalog-derived loop because it's a single path-addressed
// channel, not one entry per IPC channel.
(api as Record<string, unknown>).trpc = (path: string, input: unknown) =>
	ipcRenderer.invoke('trpc:call', { path, input });

// Log shipping — fire-and-forget send (no invoke roundtrip; a log record
// must never add renderer latency). Batching lives renderer-side in
// renderer/data/log.ts.
api.log = {
	send: (records) => ipcRenderer.send(LOG_BATCH_CHANNEL, records),
};

contextBridge.exposeInMainWorld('api', api);

declare global {
	interface Window {
		api: Api;
	}
}
