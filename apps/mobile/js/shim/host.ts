// The native host's surface (android/app/src/main/cpp/js_host.cpp), typed
// loosely: the only boundary between the sync core (JS) and the app. Values
// map as better-sqlite3 maps them; files and gzip are the host's; HTTP and
// events cross to Kotlin (core/CoreRuntime.kt).

export type Host = {
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
	makeDirs(path: string): void;
	utf8Decode(bytes: Uint8Array | ArrayBuffer): string;
	utf8Encode(text: string): Uint8Array;
	gunzip(bytes: Uint8Array | ArrayBuffer): ArrayBuffer;
	inflateOpen(bytes: Uint8Array | ArrayBuffer): unknown;
	inflateRead(handle: unknown, max: number): ArrayBuffer | null;
	// Starts a request on Kotlin's side; the answer comes back through
	// __httpDone(id, status, body, error) on this thread.
	httpStart(id: number, method: string, url: string, headersJson: string, body: string | Uint8Array | null): void;
	// One JSON event for Kotlin (sync status, applied changes, call results).
	emit(json: string): void;
	log(level: number, line: string): void;
	now(): number;
	hrtime(): number;
	randomUUID(): string;
	setBlobWrap(fn: (bytes: Uint8Array) => Uint8Array): void;
};

export const host = (globalThis as unknown as { __host: Host }).__host;
