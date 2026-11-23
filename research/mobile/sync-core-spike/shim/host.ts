// The host's surface (host/host.c, host/host-hermes.cpp), typed loosely: the
// spike's only boundary between the JavaScript core and native code.

export type Host = {
	args: string[];
	engine: string;
	sqlite: string;
	dbOpen(path: string, readonly: boolean, fileMustExist: boolean): unknown;
	dbClose(db: unknown): void;
	dbExec(db: unknown, sql: string): void;
	dbAutocommit(db: unknown): boolean;
	dbPrepare(db: unknown, sql: string): unknown;
	stmtRun(stmt: unknown, params: unknown[]): { changes: number; lastInsertRowid: number };
	stmtGet(stmt: unknown, params: unknown[], mode: number): unknown;
	stmtAll(stmt: unknown, params: unknown[], mode: number): unknown[];
	stmtIterStart(stmt: unknown, params: unknown[]): void;
	stmtIterNext(stmt: unknown, mode: number): unknown;
	stmtReset(stmt: unknown): void;
	hash(parts: Array<string | Uint8Array>, hex: boolean, bits: number): string | Uint8Array;
	hashOpen(bits: number): unknown;
	hashUpdate(handle: unknown, data: string | Uint8Array): void;
	hashDigest(handle: unknown, hex: boolean): string | Uint8Array;
	readText(path: string): string;
	readBytes(path: string): ArrayBuffer;
	writeText(path: string, text: string): void;
	writeBytes(path: string, bytes: Uint8Array | ArrayBuffer, append: boolean): void;
	fileSize(path: string): number;
	renameFile(from: string, to: string): void;
	removeFile(path: string): void;
	utf8Decode(bytes: Uint8Array | ArrayBuffer): string;
	utf8Encode(text: string): Uint8Array;
	gunzip(bytes: Uint8Array | ArrayBuffer): ArrayBuffer;
	inflateOpen(bytes: Uint8Array | ArrayBuffer): unknown;
	inflateRead(handle: unknown, max: number): ArrayBuffer | null;
	http(method: string, hostName: string, port: number, path: string, headerLines: string, body: string | null): { status: number; body: ArrayBuffer };
	print(line: string): void;
	now(): number;
	hrtime(): number;
	randomUUID(): string;
	mem(deep?: boolean): { rssKb: number; peakRssKb: number; jsHeapKb?: number; jsObjects?: number; jsStringsKb?: number };
	gc(): void;
	setBlobWrap(fn: (bytes: Uint8Array) => Uint8Array): void;
};

export const host = (globalThis as unknown as { __host: Host }).__host;
