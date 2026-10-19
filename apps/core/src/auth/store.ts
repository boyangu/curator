// Token persistence — wraps the `token` table with type-safe getters/setters
// keyed by (source, kind, scope). Tokens stored plaintext in single-user mode;
// encryption-at-rest is the obvious next step when we deploy server-remote.

import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { token } from '@curator/shared/schema';

export type TokenSource = 'spotify' | 'tidal';
export type TokenKind = 'access' | 'refresh' | 'session' | 'app_credentials';
export type TokenScope = 'user' | 'app';

export interface StoredToken {
	value: string;
	expiresAt: Date | null;
	fetchedAt: Date;
	meta: Record<string, unknown> | null;
}

export class TokenStore {
	constructor(private readonly db: Db) {}

	get(source: TokenSource, kind: TokenKind, scope: TokenScope): StoredToken | null {
		const row = this.db
			.select()
			.from(token)
			.where(
				and(eq(token.source, source), eq(token.kind, kind), eq(token.scope, scope))
			)
			.get();
		if (!row) return null;
		return {
			value: row.value,
			expiresAt: row.expiresAt,
			fetchedAt: row.fetchedAt,
			meta: row.meta,
		};
	}

	put(
		source: TokenSource,
		kind: TokenKind,
		scope: TokenScope,
		value: string,
		opts: { expiresAt?: Date | null; meta?: Record<string, unknown> | null } = {}
	): void {
		// upsert
		this.db
			.insert(token)
			.values({
				source,
				kind,
				scope,
				value,
				expiresAt: opts.expiresAt ?? null,
				fetchedAt: new Date(),
				meta: opts.meta ?? null,
			})
			.onConflictDoUpdate({
				target: [token.source, token.kind, token.scope],
				set: {
					value,
					expiresAt: opts.expiresAt ?? null,
					fetchedAt: new Date(),
					meta: opts.meta ?? null,
				},
			})
			.run();
	}

	clear(source: TokenSource, kind?: TokenKind, scope?: TokenScope): void {
		const conditions = [eq(token.source, source)];
		if (kind) conditions.push(eq(token.kind, kind));
		if (scope) conditions.push(eq(token.scope, scope));
		this.db
			.delete(token)
			.where(and(...conditions))
			.run();
	}

	// Convenience: is there any usable user token for this source?
	hasUserAuth(source: TokenSource): boolean {
		return this.get(source, source === 'spotify' ? 'access' : 'session', 'user') !== null;
	}

	// Every row, for the backup's machine-bound token sidecar. Main-process
	// only — never exposed over IPC (CLAUDE.md's token-rows lesson).
	all(): Array<{ source: string; kind: string; scope: string; value: string; expiresAt: Date | null; fetchedAt: Date; meta: Record<string, unknown> | null }> {
		return this.db.select().from(token).all();
	}

	// Inverse of all(): put rows back after a same-machine restore. Upserts
	// so a session the user re-created meanwhile is not clobbered by an
	// older row from the snapshot.
	importRows(rows: Array<{ source: string; kind: string; scope: string; value: string; expiresAt: Date | null; fetchedAt: Date; meta: Record<string, unknown> | null }>): void {
		for (const r of rows) {
			this.db.insert(token)
				.values({ source: r.source as TokenSource, kind: r.kind as TokenKind, scope: r.scope as TokenScope, value: r.value, expiresAt: r.expiresAt, fetchedAt: r.fetchedAt, meta: r.meta })
				.onConflictDoNothing()
				.run();
		}
	}
}
