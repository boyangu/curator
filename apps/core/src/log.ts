// Core's logging accessor. Modules grab area loggers at module scope
// (`const slog = log.for('scanner')`) — the facades are LATE-BOUND, resolving
// the current root on every call, so createCoreService can inject the host's
// logger after those modules have already loaded and nothing re-wires.
//
// The default root logs to the console: tests, the headless CLI, and scripts
// get sensible output with zero configuration — same "disabled is a supported
// state" contract as the sidecars. The desktop main injects its root logger
// (records land in the session JSONL file); the core-sidecar entry injects a
// port-forwarding logger.

import { createLogger, consoleSink, type AreaLogger, type Logger } from '@curator/shared/log';

let root: Logger = createLogger({
	proc: 'core',
	// Default to debug: the injecting host applies its own level policy, and
	// console-only fallback contexts (tests/CLI) historically saw every call.
	level: 'debug',
	sinks: [consoleSink()],
});

export function setCoreLogger(logger: Logger): void {
	root = logger;
}

const facades = new Map<string, AreaLogger>();

export const log = {
	for(area: string): AreaLogger {
		let facade = facades.get(area);
		if (!facade) {
			facade = {
				debug: (msg, data) => root.for(area).debug(msg, data),
				info: (msg, data) => root.for(area).info(msg, data),
				warn: (msg, data, err) => root.for(area).warn(msg, data, err),
				error: (msg, err, data) => root.for(area).error(msg, err, data),
			};
			facades.set(area, facade);
		}
		return facade;
	},
};
