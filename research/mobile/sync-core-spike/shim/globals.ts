// The Node globals the sync core touches, for an engine that has none of
// them: Buffer (as far as the core uses it), setImmediate / setTimeout over a
// task queue the host drains (host.c main loop), performance.now and console.
// Whatever is missing here shows up as a ReferenceError in the run — that
// list is one of the spike's findings.

import { host } from './host.js';

const HEX = '0123456789abcdef';

class SpikeBuffer extends Uint8Array {
	static override from(value: unknown, a?: unknown, b?: unknown): SpikeBuffer {
		if (typeof value === 'string') {
			if (a === 'hex') {
				const out = new SpikeBuffer(value.length >> 1);
				for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(2 * i, 2), 16);
				return out;
			}
			if (a !== undefined && a !== 'utf8' && a !== 'utf-8') throw new Error(`Buffer.from(string, ${String(a)}) is not in the spike's Buffer`);
			const bytes = host.utf8Encode(value);
			return new SpikeBuffer(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		}
		// An ArrayBuffer is shared, as Node shares it; anything else is copied.
		if (value instanceof ArrayBuffer) return new SpikeBuffer(value, (a as number | undefined) ?? 0, (b as number | undefined) ?? value.byteLength - ((a as number | undefined) ?? 0));
		const src = value as ArrayLike<number>;
		const out = new SpikeBuffer(src.length);
		out.set(src);
		return out;
	}

	static alloc(n: number): SpikeBuffer { return new SpikeBuffer(n); }
	static isBuffer(v: unknown): v is SpikeBuffer { return v instanceof SpikeBuffer; }

	static concat(list: readonly Uint8Array[]): SpikeBuffer {
		let n = 0;
		for (const b of list) n += b.byteLength;
		const out = new SpikeBuffer(n);
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
		if (enc !== undefined && enc !== 'utf8' && enc !== 'utf-8') throw new Error(`Buffer#toString(${enc}) is not in the spike's Buffer`);
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

g['Buffer'] = SpikeBuffer;
g['setImmediate'] = (fn: (...a: unknown[]) => void, ...args: unknown[]) => enqueue(0, fn, args);
g['setTimeout'] = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => enqueue(Math.max(0, ms), fn, args);
g['clearTimeout'] = g['clearImmediate'] = (id: number) => {
	const i = tasks.findIndex((t) => t.id === id);
	if (i >= 0) tasks.splice(i, 1);
};
g['performance'] ??= { now: () => host.hrtime() };

const line = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : JSON.stringify(a))).join(' ');
g['console'] ??= {
	log: (...a: unknown[]) => host.print(line(a)),
	info: (...a: unknown[]) => host.print(line(a)),
	debug: (...a: unknown[]) => host.print(line(a)),
	warn: (...a: unknown[]) => host.print(`[warn] ${line(a)}`),
	error: (...a: unknown[]) => host.print(`[error] ${line(a)}`),
};

// One task a call, the earliest due first (ties in the order queued); a timer
// not yet due is waited for by spinning — nothing else runs in this process.
// False when the queue is empty.
g['__tick'] = (): boolean => {
	if (tasks.length === 0) return false;
	let at = 0;
	for (let i = 1; i < tasks.length; i++) {
		const a = tasks[i]!, b = tasks[at]!;
		if (a.due < b.due || (a.due === b.due && a.seq < b.seq)) at = i;
	}
	const [task] = tasks.splice(at, 1);
	while (task!.due > host.hrtime()) { /* wait */ }
	task!.run();
	return true;
};

host.setBlobWrap((bytes) => new SpikeBuffer(bytes.buffer, bytes.byteOffset, bytes.byteLength));

export { SpikeBuffer as Buffer };
