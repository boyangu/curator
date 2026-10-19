// Every request runs as the user inside Postgres, not just in our code: the
// transaction switches to the `authenticated` role and publishes the JWT's
// `sub` the way PostgREST does, so `auth.uid()` resolves and the RLS policies
// in sql/0001_init.sql judge every statement. A query that forgets its
// `where user_id = ...` then returns nothing instead of another user's rows.
//
// `set_config(..., true)` is the parameterisable form of `set local`: both
// settings die with the transaction, so a pooled connection never carries
// one user's identity into the next request. One round trip sets both and
// reads the transaction's clock.

import type { Db, Queryable } from './db.js';
import { num } from './db.js';

export type UserTx = Queryable & {
	// Postgres `now()` of this transaction in epoch ms: the `received_at` of
	// anything inserted in it, and the reference `client_ts` is clamped to.
	nowMs: number;
};

export async function withUserTx<T>(db: Db, userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> {
	return db.begin(async (tx) => {
		const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
		const [row] = await tx.query<{ now_ms: unknown }>(
			`select set_config('role', 'authenticated', true),
				set_config('request.jwt.claims', $1, true),
				floor(extract(epoch from now()) * 1000)::float8 as now_ms`,
			[claims],
		);
		const userTx: UserTx = { query: tx.query.bind(tx), exec: tx.exec.bind(tx), nowMs: num(row!.now_ms) };
		return fn(userTx);
	});
}
