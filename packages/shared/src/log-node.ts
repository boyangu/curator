// Node-only log sinks. Imported via the '@curator/shared/log-node' subpath —
// NEVER from renderer code (the boundary check enforces this). Kept in shared
// rather than the desktop app because sinks are the transport seam: the
// headless CLI and a future hosted core want the same file sink, and the sink
// implementations belong next to the interface they implement.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LogRecord, LogSink } from './log.js';

export interface FileSinkOptions {
	dir: string;
	// Base name; records land in `${name}.jsonl`, rotations shift to
	// `${name}.1.jsonl` … `${name}.${keep}.jsonl`.
	name?: string;
	maxBytes?: number;
	keep?: number;
}

// A single record past this size gets truncated to a stub — one runaway
// payload must not blow through the rotation budget.
const MAX_RECORD_BYTES = 8 * 1024;

// JSONL file sink with size-based rotation.
//
// Writes are queued and flushed on the next macrotask via appendFileSync:
// - queueing keeps a burst (scanner sweep) down to one fs call per tick;
// - sync append means no open stream, which makes rotation a plain rename
//   (Windows can't rename a file another handle holds open) and makes every
//   flushed line crash-durable;
// - flush() drains synchronously, so shutdown can await completeness.
//
// Any fs error disables the sink permanently (one console warning) — logging
// must never crash or wedge the app.
export function fileSink(opts: FileSinkOptions): LogSink {
	const name = opts.name ?? 'curator';
	const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
	const keep = opts.keep ?? 3;
	const current = join(opts.dir, `${name}.jsonl`);

	let disabled = false;
	let bytes = 0;
	let queue: string[] = [];
	let scheduled = false;

	try {
		mkdirSync(opts.dir, { recursive: true });
		bytes = existsSync(current) ? statSync(current).size : 0;
	} catch (err) {
		disabled = true;
		console.warn(`[log] file sink disabled (${err instanceof Error ? err.message : String(err)})`);
	}

	const rotate = (): void => {
		const slot = (n: number): string => join(opts.dir, `${name}.${n}.jsonl`);
		try {
			unlinkSync(slot(keep));
		} catch {
			// oldest slot may not exist yet
		}
		for (let n = keep - 1; n >= 1; n--) {
			try {
				renameSync(slot(n), slot(n + 1));
			} catch {
				// gap in the chain is fine — slots fill up over time
			}
		}
		renameSync(current, slot(1));
		bytes = 0;
	};

	const drain = (): void => {
		if (disabled || queue.length === 0) return;
		const chunk = queue.join('');
		queue = [];
		try {
			if (bytes + chunk.length > maxBytes && bytes > 0) rotate();
			appendFileSync(current, chunk, 'utf8');
			bytes += chunk.length;
		} catch (err) {
			disabled = true;
			console.warn(`[log] file sink disabled (${err instanceof Error ? err.message : String(err)})`);
		}
	};

	return {
		write(rec: LogRecord): void {
			if (disabled) return;
			let line = JSON.stringify(rec);
			if (line.length > MAX_RECORD_BYTES) {
				line = JSON.stringify({
					ts: rec.ts,
					level: rec.level,
					proc: rec.proc,
					area: rec.area,
					msg: rec.msg.slice(0, 500),
					data: { truncated: true, originalBytes: line.length },
				});
			}
			queue.push(line + '\n');
			if (!scheduled) {
				scheduled = true;
				setTimeout(() => {
					scheduled = false;
					drain();
				}, 0);
			}
		},
		flush(): void {
			drain();
		},
		close(): void {
			drain();
			disabled = true;
		},
	};
}
