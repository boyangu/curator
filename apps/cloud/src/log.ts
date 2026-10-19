// One JSON object per line: Fly ships stdout as-is, and a line-per-event
// shape greps and parses without a log library. Never pass a token, an op
// payload or a connection string as a field.

export type LogFields = Record<string, unknown>;
export type LogLevel = 'info' | 'warn' | 'error';

export type Logger = {
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
};

function expandErrors(fields: LogFields | undefined): LogFields | undefined {
	if (!fields) return fields;
	const out: LogFields = {};
	for (const [k, v] of Object.entries(fields)) out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
	return out;
}

function defaultWrite(line: string, level: LogLevel): void {
	(level === 'info' ? process.stdout : process.stderr).write(line + '\n');
}

export function createLogger(write: (line: string, level: LogLevel) => void = defaultWrite): Logger {
	const emit = (level: LogLevel, msg: string, fields?: LogFields) =>
		write(JSON.stringify({ t: new Date().toISOString(), level, msg, ...expandErrors(fields) }), level);
	return {
		info: (m, f) => emit('info', m, f),
		warn: (m, f) => emit('warn', m, f),
		error: (m, f) => emit('error', m, f),
	};
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
