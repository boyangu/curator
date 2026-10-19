// Main-process root logger. Every record from every process funnels here:
// main's own calls, core records forwarded over the sidecar port, renderer
// records shipped over the log:batch IPC channel, and sidecar stderr lines.
//
// Construction happens at module load with just the console sink — the file
// sink needs app.getPath('userData'), so attachFileSink() runs as the first
// statement inside app.whenReady(). Records logged before that (privileged
// scheme registration, spec resolution) are held in the logger's replay ring
// and land in the file retroactively.

import { app } from 'electron';
import { join } from 'node:path';
import { createLogger, consoleSink, isLogLevel, type LogLevel } from '@curator/shared/log';
import { fileSink } from '@curator/shared/log-node';

function envLevel(): LogLevel {
	const raw = process.env['CURATOR_LOG_LEVEL'];
	if (isLogLevel(raw)) return raw;
	// Dev keeps debug chatter in the terminal; packaged builds default to info
	// so the JSONL file stays signal-dense.
	return process.env['ELECTRON_RENDERER_URL'] ? 'debug' : 'info';
}

export const mainLog = createLogger({
	proc: 'main',
	level: envLevel(),
	sinks: [consoleSink()],
});

// Call once, first thing inside app.whenReady() — userData isn't reliable
// before that. The replay buffer back-fills everything logged since boot.
export function attachFileSink(): void {
	mainLog.addSink(fileSink({ dir: join(app.getPath('userData'), 'logs') }));
}

// Fatal-path capture. Log + flush, then still die — swallowing an
// uncaughtException leaves the app in an unknowable state. The file sink's
// flush drains synchronously, so the record is on disk before exit(1).
const flog = mainLog.for('fatal');
process.on('uncaughtException', (err) => {
	flog.error('uncaughtException', err);
	void mainLog.flush();
	process.exit(1);
});
process.on('unhandledRejection', (reason) => {
	flog.error('unhandledRejection', reason);
});
