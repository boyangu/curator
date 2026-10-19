// The one seam between the API and Postgres. Production runs it on the
// `postgres` (porsager) driver; tests run the same SQL on PGlite
// (src/test/harness.ts). The surface is deliberately tiny, text + params in
// and rows out, so both drivers satisfy it without a mapping layer and no
// query builder sits between the reader and the SQL that RLS judges.
//
// Parameters are strings (or null) only, cast in SQL (`$1::bigint`,
// `$2::jsonb`, `decode($3, 'base64')`). The two drivers infer types for JS
// numbers, arrays and buffers differently; a string with an explicit cast
// means the same thing to both, so a test on PGlite exercises the production
// query. Results are normalised the same way at the call sites: `num()` on
// bigint columns, epoch-ms columns computed in SQL, jsonb read as text.

import postgres from 'postgres';

export type Param = string | null;
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

export function createPostgresDb(url: string, opts: { max?: number } = {}): Db {
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
