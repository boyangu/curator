// Renderer logger. Console sink keeps everything visible in DevTools; the
// IPC batch sink ships info-and-above to the main process, which folds them
// into the session JSONL file (userData/logs) — the only place packaged-build
// renderer errors are visible at all.
//
// Lives under renderer/data/ because it touches window.api (boundary Rule 2).
// Batching is renderer-side so a chatty code path costs one ipcRenderer.send
// per flush, not per record; the channel is fire-and-forget (no invoke
// roundtrip) so logging never adds latency to the caller.

import { createLogger, consoleSink, type LogRecord, type LogSink } from '@curator/shared/log';

// Vite dev server is http; packaged builds load the renderer off a custom
// scheme/file. No import.meta.env typing in this project, so key off
// protocol. The typeof guard keeps this module loadable under node-env
// vitest, where feature modules import it transitively and `location`
// doesn't exist.
const isDev = typeof location !== 'undefined' && location.protocol === 'http:';

const FLUSH_COUNT = 20;
const FLUSH_MS = 300;
const QUEUE_CAP = 500;

function ipcBatchSink(): LogSink {
	let queue: LogRecord[] = [];
	let dropped = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = (): void => {
		if (timer) { clearTimeout(timer); timer = null; }
		if (queue.length === 0) return;
		const batch = queue;
		queue = [];
		if (dropped > 0) {
			batch.push({
				ts: Date.now(), level: 'warn', proc: 'renderer', area: 'log',
				msg: 'records dropped under backpressure', data: { dropped },
			});
			dropped = 0;
		}
		try {
			window.api.log.send(batch);
		} catch {
			// preload gone (window teardown) — nothing useful to do
		}
	};

	return {
		write(rec: LogRecord): void {
			// Debug stays DevTools-only: the renderer is chatty and the file is
			// for signal. info+ is what makes a packaged-build error log
			// interpretable (breadcrumbs around the error).
			if (rec.level === 'debug') return;
			if (queue.length >= QUEUE_CAP) {
				queue.shift();
				dropped++;
			}
			queue.push(rec);
			if (queue.length >= FLUSH_COUNT) flush();
			else if (!timer) timer = setTimeout(flush, FLUSH_MS);
		},
		flush,
	};
}

export const log = createLogger({
	proc: 'renderer',
	level: isDev ? 'debug' : 'info',
	sinks: [consoleSink(), ipcBatchSink()],
});

// Wire window-level error capture. Called first thing in boot() so errors
// during the rest of bootstrap are already caught.
export function installGlobalErrorCapture(): void {
	const rlog = log.for('renderer');
	window.addEventListener('error', (evt) => {
		rlog.error(evt.message || 'uncaught error', evt.error ?? undefined, {
			source: `${evt.filename}:${evt.lineno}:${evt.colno}`,
		});
	});
	window.addEventListener('unhandledrejection', (evt) => {
		rlog.error('unhandled rejection', evt.reason);
	});
}
