import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@curator/shared/schema';

export type Db = BetterSQLite3Database<typeof schema>;

export function createDb(dbPath: string): { db: Db; sqlite: Database.Database } {
	const sqlite = new Database(dbPath);
	sqlite.pragma('journal_mode = WAL');
	sqlite.pragma('foreign_keys = ON');
	const db = drizzle(sqlite, { schema });
	return { db, sqlite };
}

export { schema };
