// The Node globals the sync core touches, for an engine that has none of
// them: Buffer (as far as the core uses it), setImmediate / setTimeout over a
// task queue the host drains, performance.now, process and console.
//
// The host drives the queue: after every call into JS it runs __tick, which
// runs what is due and answers how long until the next timer (-1: none), and
// Kotlin schedules the next tick then (core/CoreRuntime.kt). Nothing spins.

import { host } from './host.js';

const HEX = '0123456789abcdef';

class CoreBuffer extends Uint8Array {
	static override from(value: unknown, a?: unknown, b?: unknown): CoreBuffer {
		if (typeof value === 'string') {
			if (a === 'hex') {
				const out = new CoreBuffer(value.length >> 1);
				for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(2 * i, 2), 16);
				return out;
			}
			// One byte a character, as Node takes them (the .cpk magic).
			if (a === 'ascii' || a === 'latin1' || a === 'binary') {
				const out = new CoreBuffer(value.length);
				for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
				return out;
			}
			if (a !== undefined && a !== 'utf8' && a !== 'utf-8') throw new Error(`Buffer.from(string, ${String(a)}) is not in the phone's Buffer`);
			const bytes = host.utf8Encode(value);
			return new CoreBuffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
		}
		// An ArrayBuffer is shared, as Node shares it; anything else is copied.
		if (value instanceof ArrayBuffer) return new CoreBuffer(value, (a as number | undefined) ?? 0, (b as number | undefined) ?? value.byteLength - ((a as number | undefined) ?? 0));
		const src = value as ArrayLike<number>;
		const out = new CoreBuffer(src.length);
		out.set(src);
		return out;
	}

	// A view or a copy is a Buffer too, as Node's are. Said here, not left to
	// the language's species rule: Hermes's subarray and slice ignore it and
	// return a plain Uint8Array, whose toString('hex') is a list of numbers
	// (found 2026-11-21: version-5 ids came out as "0,0,102,…").
	override subarray(begin?: number, end?: number): CoreBuffer {
		const view = Uint8Array.prototype.subarray.call(this, begin, end);
		return new CoreBuffer(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
	}

	override slice(begin?: number, end?: number): CoreBuffer {
		const copy = Uint8Array.prototype.slice.call(this, begin, end);
		return new CoreBuffer(copy.buffer as ArrayBuffer, copy.byteOffset, copy.byteLength);
	}

	static alloc(n: number): CoreBuffer { return new CoreBuffer(n); }
	static isBuffer(v: unknown): v is CoreBuffer { return v instanceof CoreBuffer; }

	static concat(list: readonly Uint8Array[]): CoreBuffer {
		let n = 0;
		for (const b of list) n += b.byteLength;
		const out = new CoreBuffer(n);
		let at = 0;
		for (const b of list) { out.set(b, at); at += b.byteLength; }
		return out;
	}

	override toString(enc?: string): string {
		if (enc === 'hex') {
			let s = '';
			for (let i = 0; i < this.length; i++) s += HEX[this[i]! >> 4]! + HEX[this[i]! & 15]!;
			return s;
		}
		if (enc !== undefined && enc !== 'utf8' && enc !== 'utf-8') throw new Error(`Buffer#toString(${enc}) is not in the phone's Buffer`);
		return host.utf8Decode(this);
	}

	equals(other: Uint8Array): boolean {
		if (other.byteLength !== this.byteLength) return false;
		for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
		return true;
	}
}

type Task = { due: number; seq: number; run: () => void; id: number };

const g = globalThis as Record<string, unknown>;
const tasks: Task[] = [];
let seq = 0;

const enqueue = (delay: number, fn: (...a: unknown[]) => void, args: unknown[]): number => {
	const id = ++seq;
	tasks.push({ due: delay > 0 ? host.hrtime() + delay : 0, seq: id, run: () => fn(...args), id });
	return id;
};

g['Buffer'] = CoreBuffer;
g['setImmediate'] = (fn: (...a: unknown[]) => void, ...args: unknown[]) => enqueue(0, fn, args);
g['setTimeout'] = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => enqueue(Math.max(0, ms), fn, args);
g['clearTimeout'] = g['clearImmediate'] = (id: number) => {
	const i = tasks.findIndex((t) => t.id === id);
	if (i >= 0) tasks.splice(i, 1);
};
g['performance'] ??= { now: () => host.hrtime() };
g['process'] ??= { argv: [], env: {} };

// android.util.Log priorities.
const DEBUG = 3, INFO = 4, WARN = 5, ERROR = 6;
const line = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : JSON.stringify(a))).join(' ');
g['console'] = {
	log: (...a: unknown[]) => host.log(INFO, line(a)),
	info: (...a: unknown[]) => host.log(INFO, line(a)),
	debug: (...a: unknown[]) => host.log(DEBUG, line(a)),
	warn: (...a: unknown[]) => host.log(WARN, line(a)),
	error: (...a: unknown[]) => host.log(ERROR, line(a)),
};

// Runs the earliest task if it is due (ties in the order queued) and answers
// 0 (another may be due), else the delay in ms until it is, or -1 when the
// queue is empty. One task a call, as Node runs them: the host drains promise
// jobs between calls, and the core's slices (yieldToLoop) count on that order.
g['__tick'] = (): number => {
	if (tasks.length === 0) return -1;
	let at = 0;
	for (let i = 1; i < tasks.length; i++) {
		const a = tasks[i]!, b = tasks[at]!;
		if (a.due < b.due || (a.due === b.due && a.seq < b.seq)) at = i;
	}
	const wait = tasks[at]!.due - host.hrtime();
	if (wait > 0) return Math.ceil(wait);
	const [task] = tasks.splice(at, 1);
	task!.run();
	return 0;
};

host.setBlobWrap((bytes) => new CoreBuffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength));

export { CoreBuffer as Buffer };
