// The one seam between the API and Postgres. Production runs it on the
// `postgres` (porsager) driver; tests run the same SQL on PGlite
// (src/test/harness.ts). The surface is deliberately tiny, text + params in
// and rows out, so both drivers satisfy it without a mapping layer and no
// query builder sits between the reader and the SQL that RLS judges.
//
// Parameters are strings (or null), cast in SQL (`$1::bigint`,
// `$2::text::jsonb`). The two drivers infer types for JS numbers and arrays
// differently; a string with an explicit cast means the same thing to both,
// so a test on PGlite exercises the production query. The one exception is
// a bytea body (a snapshot): a Uint8Array with `$n::bytea`, which both
// drivers send as bytea (postgres.js hex-encodes it in the driver, PGlite
// binds it natively), and bytea columns come back as bytes from both (`bytes()`
// below). Bodies never pass through SQL's encode()/decode(): base64 of a
// 37 MB snapshot (plus stripping its line breaks) inside Postgres was a
// measurable share of the load on a saturated free-tier database
// (2026-10-21).
//
// jsonb is the exception that needs two casts, `$1::text::jsonb`: postgres.js
// learns the parameter's type from the server and runs its json serializer
// (JSON.stringify) over a jsonb parameter, so an already-encoded string would
// arrive as one JSON string scalar ("cannot extract elements from a scalar").
// Typing the parameter as text keeps the driver's hands off it. PGlite does
// not do this, so only db.test.ts guards it.
//
// Results are normalised the same way at the call sites: `num()` on
// bigint columns, epoch-ms columns computed in SQL, jsonb read as text.

import postgres from 'postgres';

export type Param = string | null | Uint8Array;
export type Row = Record<string, unknown>;

export interface Queryable {
	query<T extends Row = Row>(text: string, params?: readonly Param[]): Promise<T[]>;
	// Several statements, no parameters (migrations).
	exec(text: string): Promise<void>;
}

export interface Db extends Queryable {
	// Runs `fn` in one transaction on one connection; commits when it
	// resolves, rolls back when it throws.
	begin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

export class ConnectionStringError extends Error {
	override readonly name = 'ConnectionStringError';
}

// Checks the shape of a connection string WITHOUT ever putting it in an error.
// postgres.js throws `new URL(input)`'s TypeError, whose `input` field carries
// the whole string, password included, into whatever logs the error; a
// mis-pasted secret (a bare password, a stray control character) then lands in
// the host's log stream. Every message here names the problem, never the value.
export function assertConnectionString(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ConnectionStringError('the database connection string is not a URL (expected postgresql://user:password@host:port/db; value not shown)');
	}
	if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
		throw new ConnectionStringError(`the database connection string must start with postgresql:// (got ${parsed.protocol}//; value not shown)`);
	}
	if (!parsed.username || !parsed.hostname) {
		throw new ConnectionStringError('the database connection string has no user or host (value not shown)');
	}
}

export function createPostgresDb(url: string, opts: { max?: number } = {}): Db {
	assertConnectionString(url);
	const sql = postgres(url, {
		// Unnamed statements only: Supabase's pooler (Supavisor in transaction
		// mode) cannot keep prepared statements across transactions. Every
		// request is one short transaction, so nothing is lost.
		prepare: false,
		max: opts.max ?? 10,
		idle_timeout: 30,
		connect_timeout: 10,
		onnotice: () => {},
		connection: { application_name: 'curator-cloud' },
	});
	const wrap = (q: postgres.Sql | postgres.TransactionSql): Queryable => ({
		async query<T extends Row = Row>(text: string, params: readonly Param[] = []): Promise<T[]> {
			const rows = await q.unsafe(text, params as Param[]);
			return rows as unknown as T[];
		},
		async exec(text: string): Promise<void> {
			await q.unsafe(text);
		},
	});
	const base = wrap(sql);
	return {
		query: base.query,
		exec: base.exec,
		async begin<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
			return (await sql.begin((tx) => fn(wrap(tx)))) as T;
		},
		async close(): Promise<void> {
			await sql.end({ timeout: 5 });
		},
	};
}

// bigint / numeric columns arrive as string (postgres.js) or number (PGlite).
export function num(v: unknown): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) throw new TypeError(`expected a number from the database, got ${String(v)}`);
	return n;
}

export function numOrNull(v: unknown): number | null {
	return v === null || v === undefined ? null : num(v);
}

// A bytea column: a Buffer from postgres.js, a Uint8Array from PGlite. A view
// over the same memory, never a copy (a snapshot body is tens of MB).
export function bytes(v: unknown): Buffer {
	if (Buffer.isBuffer(v)) return v;
	if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
	throw new TypeError('expected a bytea value from the database');
}
