// The one seam between the API and Postgres. Production runs it on the
// `postgres` (porsager) driver; tests run the same SQL on PGlite
// (src/test/harness.ts). The surface is deliberately tiny, text + params in
// and rows out, so both drivers satisfy it without a mapping layer and no
// query builder sits between the reader and the SQL that RLS judges.
//
// Parameters are strings (or null), cast in SQL (`$1::bigint`,
// `$2::text::jsonb`). The two drivers infer types for JS numbers and arrays
// differently; a string with an explicit cast means the same thing to both,
// so a test on PGlite exercises the production query. No bytea crosses this
// seam any more: snapshot bodies left Postgres with sql/0009 (the master
// publishes them to Storage), and the API never touches object bytes.
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
import { tlsOptions } from './tls.js';

export type Param = string | null;
export type Row = Record<string, unknown>;

export interface Queryable {
	query<T extends Row = Row>(text: string, params?: readonly Param[]): Promise<T[]>;
	// Several statements, no parameters (migrations).
	exec(text: string): Promise<void>;
}

// A transaction's handle. `savepoint` runs `fn` behind a savepoint, on its own
// handle: when `fn` throws — a statement of its own failed, or it chose to —
// what it wrote is rolled back, the transaction goes on, and the error comes
// out of the returned promise for the caller to take or pass on.
//
// It is the ONLY way to survive a failed statement inside a transaction. A
// bare `savepoint` / `rollback to` typed as statements is not: postgres.js
// notes every rejected query of a transaction's handle, caught or not, and
// throws the first once the transaction's function returns — the whole
// transaction rolled back after all (found in review, 2026-11-27: PGlite has
// no such memory, so a suite on it passed). The savepoint's own handle keeps
// its own account.
export interface Tx extends Queryable {
	savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface Db extends Queryable {
	// Runs `fn` in one transaction on one connection; commits when it
	// resolves, rolls back when it throws.
	begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

// A transaction handle over statements alone (PGlite; tests), behaving as
// postgres.js does: a statement that failed on a handle fails that handle's
// scope when it ends, whoever caught it — so code that leans on a caught
// error fails here as it would in production.
export function scopedTx(q: Queryable): { tx: Tx; settle(): void } {
	let failed: unknown;
	let depth = 0;
	const noting = async <T>(run: () => Promise<T>): Promise<T> => {
		try {
			return await run();
		} catch (e) {
			failed ??= e;
			throw e;
		}
	};
	const tx: Tx = {
		query: (text, params) => noting(() => q.query(text, params)),
		exec: (text) => noting(() => q.exec(text)),
		async savepoint<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
			const name = `sp_${depth++}`;
			await tx.exec(`savepoint ${name}`);
			const inner = scopedTx(q);
			try {
				const out = await fn(inner.tx);
				inner.settle();
				await tx.exec(`release savepoint ${name}`);
				return out;
			} catch (e) {
				await tx.exec(`rollback to savepoint ${name}`);
				throw e;
			}
		},
	};
	return {
		tx,
		settle(): void {
			if (failed !== undefined) throw failed;
		},
	};
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

// `prepare`: named statements, for a connection that keeps them (Postgres
// itself or the session pooler, never the transaction pooler). A statement
// then costs one trip to the server instead of two, and statements issued
// together share it.
export function createPostgresDb(url: string, opts: { max?: number; prepare?: boolean } = {}): Db {
	assertConnectionString(url);
	const prepare = opts.prepare ?? false;
	const sql = postgres(url, {
		// Unnamed statements unless asked: Supabase's pooler (Supavisor in
		// transaction mode) cannot keep prepared statements across transactions.
		// Every API request is one short transaction, a millisecond from its
		// database, so nothing is lost.
		prepare,
		max: opts.max ?? 10,
		idle_timeout: 30,
		connect_timeout: 10,
		onnotice: () => {},
		connection: { application_name: 'curator-cloud' },
		// TLS, verified, to any host but this machine (tls.ts).
		...tlsOptions(url),
	});
	const wrap = (q: postgres.Sql | postgres.TransactionSql): Queryable => ({
		async query<T extends Row = Row>(text: string, params: readonly Param[] = []): Promise<T[]> {
			// `unsafe` prepares nothing unless told, whatever the pool says.
			const rows = await q.unsafe(text, params as Param[], { prepare: prepare && params.length > 0 });
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
		async begin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
			// postgres.js's own savepoint: a nested scope with its own handle.
			const txOf = (q: postgres.TransactionSql): Tx => ({ ...wrap(q), savepoint: <U>(inner: (tx: Tx) => Promise<U>) => q.savepoint((s) => inner(txOf(s))) as Promise<U> });
			return (await sql.begin((tx) => fn(txOf(tx)))) as T;
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
