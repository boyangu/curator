import { describe, it, expect, vi } from 'vitest';
import { createLogger, consoleSink, serializeErr, isLogLevel, type LogRecord, type LogSink } from './log.js';

function collectSink(): LogSink & { records: LogRecord[] } {
	const records: LogRecord[] = [];
	return { records, write: (r) => { records.push(r); } };
}

describe('createLogger', () => {
	it('filters below the level and stamps proc/area/level', () => {
		const sink = collectSink();
		const logger = createLogger({ proc: 'core', level: 'info', sinks: [sink] });
		const slog = logger.for('scanner');
		slog.debug('nope');
		slog.info('yes', { n: 1 });
		slog.warn('watch out');
		expect(sink.records.map((r) => r.level)).toEqual(['info', 'warn']);
		expect(sink.records[0]).toMatchObject({ proc: 'core', area: 'scanner', msg: 'yes', data: { n: 1 } });
	});

	it('setLevel changes filtering live', () => {
		const sink = collectSink();
		const logger = createLogger({ proc: 'main', level: 'error', sinks: [sink] });
		logger.for('x').warn('dropped');
		logger.setLevel('debug');
		logger.for('x').debug('kept');
		expect(sink.records.map((r) => r.msg)).toEqual(['kept']);
	});

	it('caches area loggers', () => {
		const logger = createLogger({ proc: 'main', sinks: [] });
		expect(logger.for('a')).toBe(logger.for('a'));
	});

	it('a throwing sink does not break other sinks', () => {
		const bad: LogSink = { write: () => { throw new Error('boom'); } };
		const good = collectSink();
		const logger = createLogger({ proc: 'main', sinks: [bad, good] });
		logger.for('x').info('survives');
		expect(good.records).toHaveLength(1);
	});

	it('warn takes (msg, data, err); error takes (msg, err, data)', () => {
		const sink = collectSink();
		const logger = createLogger({ proc: 'renderer', sinks: [sink] });
		logger.for('x').warn('w', { a: 1 }, new Error('we'));
		logger.for('x').error('e', new Error('ee'), { b: 2 });
		expect(sink.records[0]).toMatchObject({ level: 'warn', data: { a: 1 }, err: { message: 'we' } });
		expect(sink.records[1]).toMatchObject({ level: 'error', data: { b: 2 }, err: { message: 'ee' } });
	});

	it('replay buffer back-fills a late-attached sink in order and caps at N', () => {
		const logger = createLogger({ proc: 'main', level: 'debug', sinks: [], replayBuffer: 3 });
		const slog = logger.for('boot');
		for (let i = 1; i <= 5; i++) slog.info(`m${i}`);
		const late = collectSink();
		logger.addSink(late);
		// Cap 3 → only the last three replay, oldest dropped.
		expect(late.records.map((r) => r.msg)).toEqual(['m3', 'm4', 'm5']);
		slog.info('m6');
		expect(late.records.map((r) => r.msg)).toEqual(['m3', 'm4', 'm5', 'm6']);
	});

	it('emit() bypasses level filtering and keeps the stamped proc', () => {
		const sink = collectSink();
		const logger = createLogger({ proc: 'main', level: 'error', sinks: [sink] });
		logger.emit({ ts: 1, level: 'debug', proc: 'core', area: 'fwd', msg: 'forwarded' });
		expect(sink.records[0]).toMatchObject({ proc: 'core', level: 'debug', msg: 'forwarded' });
	});

	it('flush awaits sink flush and swallows flush errors', async () => {
		const flushed = vi.fn();
		const logger = createLogger({
			proc: 'main',
			sinks: [
				{ write: () => {}, flush: flushed },
				{ write: () => {}, flush: () => { throw new Error('flush boom'); } },
			],
		});
		await expect(logger.flush()).resolves.toBeUndefined();
		expect(flushed).toHaveBeenCalled();
	});
});

describe('serializeErr', () => {
	it('serializes Error, string, and unknown values', () => {
		const e = serializeErr(new TypeError('bad'));
		expect(e).toMatchObject({ name: 'TypeError', message: 'bad' });
		expect(e.stack).toBeTruthy();
		expect(serializeErr('plain')).toEqual({ name: 'Error', message: 'plain' });
		expect(serializeErr({ code: 7 })).toEqual({ name: 'Error', message: '{"code":7}' });
	});
});

describe('consoleSink', () => {
	it('renders [area] msg with data and err trailing', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			consoleSink().write({ ts: 1, level: 'warn', proc: 'main', area: 'scanner', msg: 'hi', data: { a: 1 }, err: { name: 'E', message: 'm' } });
			expect(spy).toHaveBeenCalledWith('[scanner] hi', { a: 1 }, 'E: m');
		} finally {
			spy.mockRestore();
		}
	});
});

describe('isLogLevel', () => {
	it('accepts the four levels, rejects everything else', () => {
		expect(isLogLevel('debug') && isLogLevel('info') && isLogLevel('warn') && isLogLevel('error')).toBe(true);
		expect(isLogLevel('verbose')).toBe(false);
		expect(isLogLevel(undefined)).toBe(false);
	});
});
