// Structured logging core — the transport seam for every Curator process.
//
// Call sites do `log.for('scanner').info('watching folder', { path })`; where
// those records GO is decided entirely by which LogSink implementations the
// process wired in (console in dev, rotating JSONL file in the main process,
// an IPC batch sink in the renderer, a port-forwarding sink in the core
// sidecar). LogSink is the hosted-mode seam: when core moves out of process
// or off machine, the sink changes but no call site does — same philosophy as
// the CoreService contract.
//
// This module is renderer-safe on purpose: zero runtime deps, zero node:*
// imports. Anything that touches the filesystem lives in log-node.ts behind
// the '@curator/shared/log-node' subpath export.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogErr {
	name: string;
	message: string;
	stack?: string;
}

export interface LogRecord {
	// Epoch ms. Stamped once at the emitting process; forwarded records keep
	// their original timestamp so cross-process interleaving stays truthful.
	ts: number;
	level: LogLevel;
	// Which process produced the record. Forwarding boundaries (renderer→main
	// IPC, core-sidecar→main port) must preserve/enforce this — it's the only
	// field a reader can trust to reconstruct the multi-process timeline.
	proc: 'main' | 'core' | 'renderer';
	// Feature area — the old '[scanner]' / '[feed]' console prefixes, minus
	// the brackets. Console sink re-renders them so dev greps don't change.
	area: string;
	msg: string;
	// JSON-safe structured fields. Keep values small — the file sink truncates
	// records that serialize past 8 KB.
	data?: Record<string, unknown>;
	err?: LogErr;
}

export interface LogSink {
	// Must not throw — the logger guards anyway, but a sink that throws gets
	// its records silently dropped, so treat the guard as a backstop.
	write(rec: LogRecord): void;
	flush?(): void | Promise<void>;
	close?(): void | Promise<void>;
}

export interface AreaLogger {
	debug(msg: string, data?: Record<string, unknown>): void;
	info(msg: string, data?: Record<string, unknown>): void;
	// Asymmetric signatures are deliberate, matching the dominant call shapes:
	// warns mostly carry structured context (data first), errors mostly carry
	// a caught exception (err first). Both accept the other as a trailing arg.
	warn(msg: string, data?: Record<string, unknown>, err?: unknown): void;
	error(msg: string, err?: unknown, data?: Record<string, unknown>): void;
}

export interface Logger {
	for(area: string): AreaLogger;
	setLevel(level: LogLevel): void;
	// Attach a sink after construction. The boot replay buffer is drained into
	// it first (in order), so a file sink attached at app.whenReady() still
	// receives the records logged during early boot.
	addSink(sink: LogSink): void;
	// Write an already-stamped record straight to the sinks, bypassing level
	// filtering and proc stamping. For forwarding boundaries only (records
	// were filtered and stamped in their origin process).
	emit(rec: LogRecord): void;
	flush(): Promise<void>;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function isLogLevel(v: unknown): v is LogLevel {
	return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

export function serializeErr(e: unknown): LogErr {
	if (e instanceof Error) {
		return { name: e.name, message: e.message, ...(e.stack ? { stack: e.stack } : {}) };
	}
	if (typeof e === 'string') return { name: 'Error', message: e };
	try {
		return { name: 'Error', message: JSON.stringify(e) };
	} catch {
		return { name: 'Error', message: String(e) };
	}
}

export interface CreateLoggerOptions {
	proc: LogRecord['proc'];
	level?: LogLevel;
	sinks?: LogSink[];
	// Records kept for replay into late-attached sinks (the file sink can only
	// attach after app.whenReady()). Bounded ring; oldest dropped first.
	replayBuffer?: number;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
	const sinks: LogSink[] = [...(opts.sinks ?? [])];
	let minRank = LEVEL_RANK[opts.level ?? 'info'];
	const replayCap = opts.replayBuffer ?? 300;
	const replay: LogRecord[] = [];
	const areas = new Map<string, AreaLogger>();

	const write = (rec: LogRecord): void => {
		for (const sink of sinks) {
			try {
				sink.write(rec);
			} catch {
				// A broken sink must never take the app (or the other sinks) down.
			}
		}
		if (replayCap > 0) {
			replay.push(rec);
			if (replay.length > replayCap) replay.shift();
		}
	};

	const record = (
		level: LogLevel,
		area: string,
		msg: string,
		data?: Record<string, unknown>,
		err?: unknown,
	): void => {
		if (LEVEL_RANK[level] < minRank) return;
		write({
			ts: Date.now(),
			level,
			proc: opts.proc,
			area,
			msg,
			...(data !== undefined ? { data } : {}),
			...(err !== undefined ? { err: serializeErr(err) } : {}),
		});
	};

	return {
		for(area: string): AreaLogger {
			let scoped = areas.get(area);
			if (!scoped) {
				scoped = {
					debug: (msg, data) => record('debug', area, msg, data),
					info: (msg, data) => record('info', area, msg, data),
					warn: (msg, data, err) => record('warn', area, msg, data, err),
					error: (msg, err, data) => record('error', area, msg, data, err),
				};
				areas.set(area, scoped);
			}
			return scoped;
		},
		setLevel(level: LogLevel): void {
			minRank = LEVEL_RANK[level];
		},
		addSink(sink: LogSink): void {
			for (const rec of replay) {
				try {
					sink.write(rec);
				} catch {
					break; // a sink that throws on replay won't fare better on the rest
				}
			}
			sinks.push(sink);
		},
		emit(rec: LogRecord): void {
			write(rec);
		},
		async flush(): Promise<void> {
			for (const sink of sinks) {
				try {
					await sink.flush?.();
				} catch {
					// flush failure is not actionable at shutdown
				}
			}
		},
	};
}

// Console sink — renders `[area] msg` so the existing grep/prefix muscle
// memory keeps working in dev terminals and DevTools.
export function consoleSink(): LogSink {
	const method: Record<LogLevel, (...args: unknown[]) => void> = {
		debug: console.debug.bind(console),
		info: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
	};
	return {
		write(rec: LogRecord): void {
			const args: unknown[] = [`[${rec.area}] ${rec.msg}`];
			if (rec.data !== undefined) args.push(rec.data);
			if (rec.err !== undefined) args.push(rec.err.stack ?? `${rec.err.name}: ${rec.err.message}`);
			method[rec.level](...args);
		},
	};
}
