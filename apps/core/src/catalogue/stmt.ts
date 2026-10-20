// Prepared-statement cache for the catalogue's fixed SQL. The hydrator runs
// the same few statements per track and per mirror entry inside time-boxed
// transactions; compiling them each time was a measurable part of a slice.
// Keyed by connection, so a closed database takes its statements with it.

import type Database from 'better-sqlite3';

const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function stmt(raw: Database.Database, sql: string): Database.Statement {
	let m = cache.get(raw);
	if (!m) cache.set(raw, (m = new Map()));
	let s = m.get(sql);
	if (!s) {
		s = raw.prepare(sql);
		m.set(sql, s);
	}
	return s;
}
