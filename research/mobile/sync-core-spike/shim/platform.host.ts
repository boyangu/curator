// What the driver asks of the machine, on a host (host/host.c for QuickJS,
// host/host-hermes.cpp for Hermes: the same `__host` either way).

import { host } from './host.js';
import type { Platform } from '../src/platform.js';

export const platform: Platform = {
	runtime: `${host.engine}, sqlite ${host.sqlite}`,
	readText: (path) => host.readText(path),
	// The gzip body, the inflated bytes and the string are each dropped as
	// soon as the next one exists.
	readGzipText: (path) => host.utf8Decode(host.gunzip(host.readBytes(path))),
	readBytes: (path) => new Uint8Array(host.readBytes(path)),
	writeText: (path, text) => host.writeText(path, text),
	appendBytes: (path, bytes) => host.writeBytes(path, bytes, true),
	gunzip: (bytes) => new Uint8Array(host.gunzip(bytes)),
	sha256: (bytes) => host.hash([bytes], true, 256) as string,
	// About a megabyte of text at a time. A piece of bytes may end inside a
	// character: those bytes wait for the next piece.
	*inflateText(body) {
		const handle = host.inflateOpen(body);
		let carry = new Uint8Array(0);
		for (;;) {
			const next = host.inflateRead(handle, 1 << 20);
			if (next === null) break;
			let bytes = new Uint8Array(next);
			if (carry.length > 0) {
				const joined = new Uint8Array(carry.length + bytes.length);
				joined.set(carry);
				joined.set(bytes, carry.length);
				bytes = joined;
			}
			let end = bytes.length;
			let i = end - 1;
			while (i >= 0 && end - i <= 3 && (bytes[i]! & 0xc0) === 0x80) i--;
			if (i >= 0) {
				const lead = bytes[i]!;
				const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
				if (end - i < need) end = i;
			}
			carry = bytes.slice(end);
			if (end > 0) yield host.utf8Decode(bytes.subarray(0, end));
		}
		if (carry.length > 0) yield host.utf8Decode(carry);
	},
	// The host's socket, one request a connection. It blocks until the answer
	// is whole: fine for a program that does nothing else meanwhile.
	http: async (req) => {
		const m = /^http:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(req.url);
		if (!m) throw new Error(`the spike host speaks plain http only: ${req.url}`);
		const lines = Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
		const res = host.http(req.method, m[1]!, Number(m[2] ?? 80), m[3] ?? '/', lines, req.body ?? null);
		return req.bytes ? { status: res.status, bytes: new Uint8Array(res.body) } : { status: res.status, text: host.utf8Decode(res.body) };
	},
	mem: (deep) => host.mem(deep),
	now: () => host.hrtime(),
	log: (line) => host.print(line),
	fixIds: (next) => { (globalThis as { __spikeUuid?: () => string }).__spikeUuid = next; },
};
