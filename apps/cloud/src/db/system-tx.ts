// Transactions on the shared catalogue (sql/0011_catalog.sql), which belongs to
// no user: they run as the API's own role, `curator_api`, with the grants
// sql/roles.sql gives it on those tables and nothing else. No user claims are
// set, so a statement that strays onto a per-user table finds RLS refusing it.
//
// `asUser` switches the same transaction to the caller for the per-user rows
// a catalogue call also touches (catalog_watch), exactly as withUserTx does,
// and back afterwards: one transaction, so a watch and the object it names
// commit together or not at all.

import { num, type Db, type Queryable, type Tx } from './db.js';

export type SystemTx = Queryable & {
	nowMs: number;
	// Runs `fn` as `userId` (role `authenticated`, RLS on), then returns the
	// transaction to curator_api.
	asUser<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T>;
	// `fn` behind a savepoint, on its own handle (db.ts Tx): its failure costs
	// what it wrote and nothing else.
	savepoint<T>(fn: (tx: SystemTx) => Promise<T>): Promise<T>;
};

export async function withSystemTx<T>(db: Db, fn: (tx: SystemTx) => Promise<T>): Promise<T> {
	return db.begin(async (root) => {
		const [row] = await root.query<{ now_ms: unknown }>(`select floor(extract(epoch from now()) * 1000)::float8 as now_ms`);
		const nowMs = num(row!.now_ms);
		const over = (tx: Tx): SystemTx => ({
			query: tx.query.bind(tx),
			exec: tx.exec.bind(tx),
			nowMs,
			savepoint: (inner) => tx.savepoint((s) => inner(over(s))),
			async asUser<U>(userId: string, inner: (q: Queryable) => Promise<U>): Promise<U> {
				await tx.query(`select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)`, [
					JSON.stringify({ sub: userId, role: 'authenticated' }),
				]);
				try {
					return await inner(tx);
				} finally {
					// `none` is RESET ROLE: back to the session's own role. The claims
					// are cleared too, so nothing later reads as this user.
					await tx.query(`select set_config('role', 'none', true), set_config('request.jwt.claims', '', true)`);
				}
			},
		});
		return fn(over(root));
	});
}
