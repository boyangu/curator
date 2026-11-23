// Prepared statements kept per connection, for fixed SQL that a loop runs
// over and over: the catalogue's hydrator runs the same few statements per
// track, and the sync client's projection the same few per record — a join
// of the 39k-track library compiled 600,000 statements anew, ~8 s of 145
// (measured 2026-11-21). Keyed by connection, so a closed database takes its
// statements with it.
//
// The mode is part of the key: better-sqlite3's pluck() and raw() switch the
// statement object itself, so a caller must never switch a shared one — it
// asks for the mode here instead.

import type Database from 'better-sqlite3';

export type StmtMode = 'row' | 'pluck' | 'raw';

const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

export function stmt(raw: Database.Database, sql: string, mode: StmtMode = 'row'): Database.Statement {
	let m = cache.get(raw);
	if (!m) cache.set(raw, (m = new Map()));
	const key = mode === 'row' ? sql : `${mode}\u0000${sql}`;
	let s = m.get(key);
	if (!s) {
		s = raw.prepare(sql);
		if (mode === 'pluck') s.pluck();
		else if (mode === 'raw') s.raw();
		m.set(key, s);
	}
	return s;
}
