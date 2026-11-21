// The driver's view of the machine; shim/platform.node.ts and
// shim/platform.qjs.ts implement it (the bundler picks one).

export type Mem = { rssKb: number; peakRssKb: number; jsHeapKb?: number; jsObjects?: number; jsStringsKb?: number };

export type Platform = {
	runtime: string;
	readText(path: string): string;
	// A gzip file's content as text.
	readGzipText(path: string): string;
	readBytes(path: string): Uint8Array;
	writeText(path: string, text: string): void;
	// A gzip body as its text in pieces, inflated as they are asked for;
	// absent where the product's own inflater runs (Node).
	inflateText?(body: Uint8Array): Iterable<string>;
	// One HTTP request, one answer: the body as text, or as bytes when asked.
	// Plain http:// to this machine only — the test server (serve-cloud.ts).
	http?(req: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string; bytes: boolean }): Promise<{ status: number; text?: string; bytes?: Uint8Array }>;
	// `deep` adds the JS heap figures where they cost a heap walk.
	mem(deep?: boolean): Mem;
	// Monotonic milliseconds.
	now(): number;
	log(line: string): void;
	// Replaces the core's random ids with `next`'s.
	fixIds(next: () => string): void;
};
