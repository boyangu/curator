// SQL guard for agent-written workspace queries — pure and unit-testable.
// The real safety boundary is the connection itself (live DBs are file-level
// read-only; scratch lives in TEMP), so this guard only has to block the
// statements that could escape that model: ATTACH (arbitrary file access),
// DETACH, PRAGMA (connection reconfiguration), extension loading, and
// maintenance verbs that make no sense here. Word-boundary matching anywhere
// in the text — a false positive inside a string literal is acceptable (the
// model just rephrases), a false negative is not.

const BLOCKED = /\b(attach|detach|pragma|vacuum|reindex|analyze|load_extension)\b/i;

export type SqlGuardResult = { ok: true } | { ok: false; reason: string };

export function guardSql(sql: string): SqlGuardResult {
	const trimmed = sql.trim();
	if (trimmed.length === 0) return { ok: false, reason: 'empty SQL' };
	const blocked = BLOCKED.exec(trimmed);
	if (blocked) {
		return { ok: false, reason: `${blocked[1]!.toUpperCase()} is not allowed in workspace SQL` };
	}
	// One statement per call. Trailing semicolon(s) are fine; a semicolon
	// followed by more content is a second statement (better-sqlite3 would
	// also reject it, but with a less helpful message).
	if (/;\s*\S/.test(trimmed)) {
		return { ok: false, reason: 'one SQL statement per call' };
	}
	return { ok: true };
}
