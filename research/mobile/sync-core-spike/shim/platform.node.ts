// What the driver asks of the machine, on Node (the desktop reference).

import crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import type { Platform } from '../src/platform.js';

// One request, this thread waiting for the whole answer — as the phone
// host's socket does. The request itself runs on a worker: Node's fetch reads
// Date and performance.now (measured: one and four readings a request), which
// in a comparison run are the counted clocks the client's rows are stamped
// from. A worker has clocks of its own.
type HttpReq = Parameters<NonNullable<Platform['http']>>[0];
type HttpRes = { status: number; text?: string; bytes?: Uint8Array; error?: string };
let http: { port: MessagePort; signal: Int32Array } | null = null;
function httpBlocking(req: HttpReq): HttpRes {
	if (!http) {
		const { port1, port2 } = new MessageChannel();
		const signal = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(`
			const { workerData } = require('node:worker_threads');
			workerData.port.on('message', async (req) => {
				let out;
				try {
					const res = await fetch(req.url, { method: req.method, headers: req.headers, ...(req.body === undefined ? {} : { body: req.body }) });
					out = req.bytes ? { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) } : { status: res.status, text: await res.text() };
				} catch (err) {
					out = { status: 0, error: String(err && err.cause ? err.cause.message || err.cause : err) };
				}
				workerData.port.postMessage(out);
				Atomics.store(workerData.signal, 0, 1);
				Atomics.notify(workerData.signal, 0);
			});
		`, { eval: true, workerData: { port: port2, signal }, transferList: [port2] });
		worker.unref();
		http = { port: port1, signal };
	}
	Atomics.store(http.signal, 0, 0);
	http.port.postMessage(req);
	Atomics.wait(http.signal, 0, 0);
	const res = receiveMessageOnPort(http.port)?.message as HttpRes | undefined;
	if (!res || res.error !== undefined) throw new Error(`cannot reach ${req.url}: ${res?.error ?? 'no answer'}`);
	return res;
}

export const platform: Platform = {
	runtime: `node ${process.versions.node} (v8 ${process.versions.v8})`,
	readText: (path) => readFileSync(path, 'utf8'),
	readGzipText: (path) => gunzipSync(readFileSync(path)).toString('utf8'),
	readBytes: (path) => readFileSync(path),
	writeText: (path, text) => writeFileSync(path, text),
	mem: () => ({ rssKb: Math.round(process.memoryUsage().rss / 1024), peakRssKb: process.resourceUsage().maxRSS, jsHeapKb: Math.round(process.memoryUsage().heapUsed / 1024) }),
	http: async (req) => httpBlocking(req),
	// Not performance.now(): the comparison run replaces it (src/driver.ts).
	now: () => Number(process.hrtime.bigint()) / 1e6,
	log: (line) => console.log(line),
	// The core imports randomUUID from node:crypto by name; the builtin's ESM
	// bindings follow its CommonJS exports once synced.
	fixIds: (next) => {
		(crypto as { randomUUID: unknown }).randomUUID = next;
		syncBuiltinESMExports();
	},
};
