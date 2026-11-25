// Token persistence — wraps the `token` table with type-safe getters/setters
// keyed by (source, kind, scope).
//
// At rest a value is sealed by the host's TokenSealer (the desktop main: the
// OS credential store, a key only this OS user's Curator holds), so the
// database file alone, or any copy of it, opens no streaming account. Core
// has no key of its own, which is the point: a process that was not handed a
// sealer (a script, the CLI, a test, the core sidecar) writes plaintext as it
// always did, and reads a sealed row as absent, i.e. "not connected".

import { and, eq, not, like } from 'drizzle-orm';
import type { Db } from '@curator/sync-core/db/client';
import { token } from '@curator/shared/schema';
import { log } from '@curator/sync-core/log';

const tlog = log.for('auth');

export type TokenSource = 'spotify' | 'tidal';
export type TokenKind = 'access' | 'refresh' | 'session' | 'app_credentials';
export type TokenScope = 'user' | 'app';

export interface StoredToken {
	value: string;
	expiresAt: Date | null;
	fetchedAt: Date;
	meta: Record<string, unknown> | null;
}

// Seals a token for the `value` column. open() throws when it cannot (sealed
// by another OS user or machine, or damaged). Both are synchronous: the store
// is read on the way to nearly every streaming call.
export interface TokenSealer {
	seal(plain: string): string;
	open(sealed: string): string;
}

// Marks a sealed value. No provider's token starts with it, so a plaintext
// row from before sealing (or from a process without a sealer) is told apart
// without a schema change.
const SEALED = 'sealed:v1:';

type TokenRow = { source: string; kind: string; scope: string; value: string; expiresAt: Date | null; fetchedAt: Date; meta: Record<string, unknown> | null };

export class TokenStore {
	private warned = false;

	constructor(private readonly db: Db, private readonly sealer?: TokenSealer) {}

	private toStored(plain: string): string {
		return this.sealer ? SEALED + this.sealer.seal(plain) : plain;
	}

	// Null: sealed, and not for this process to open.
	private toPlain(stored: string): string | null {
		if (!stored.startsWith(SEALED)) return stored;
		if (!this.sealer) return null;
		try {
			return this.sealer.open(stored.slice(SEALED.length));
		} catch (err) {
			// Once: every streaming call would say it again.
			if (!this.warned) tlog.warn('a stored token could not be opened (sealed by another OS user or machine); the account reads as not connected', undefined, err);
			this.warned = true;
			return null;
		}
	}

	get(source: TokenSource, kind: TokenKind, scope: TokenScope): StoredToken | null {
		const row = this.db
			.select()
			.from(token)
			.where(
				and(eq(token.source, source), eq(token.kind, kind), eq(token.scope, scope))
			)
			.get();
		if (!row) return null;
		const value = this.toPlain(row.value);
		if (value === null) return null;
		return {
			value,
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
		const stored = this.toStored(value);
		// upsert
		this.db
			.insert(token)
			.values({
				source,
				kind,
				scope,
				value: stored,
				expiresAt: opts.expiresAt ?? null,
				fetchedAt: new Date(),
				meta: opts.meta ?? null,
			})
			.onConflictDoUpdate({
				target: [token.source, token.kind, token.scope],
				set: {
					value: stored,
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

	// Every row this process can open, in plaintext, for the backup's
	// machine-bound token sidecar (which the desktop main encrypts as a whole).
	// Main-process only — never exposed over IPC (CLAUDE.md's token-rows lesson).
	all(): TokenRow[] {
		const rows: TokenRow[] = [];
		for (const r of this.db.select().from(token).all()) {
			const value = this.toPlain(r.value);
			if (value !== null) rows.push({ ...r, value });
		}
		return rows;
	}

	// Inverse of all(): put rows back after a same-machine restore. Upserts
	// so a session the user re-created meanwhile is not clobbered by an
	// older row from the snapshot.
	importRows(rows: TokenRow[]): void {
		for (const r of rows) {
			this.db.insert(token)
				.values({ source: r.source as TokenSource, kind: r.kind as TokenKind, scope: r.scope as TokenScope, value: this.toStored(r.value), expiresAt: r.expiresAt, fetchedAt: r.fetchedAt, meta: r.meta })
				.onConflictDoNothing()
				.run();
		}
	}

	// Seals the rows still in plaintext: those from before sealing existed, and
	// any a process without a sealer wrote since. Returns how many.
	sealPlaintext(): number {
		if (!this.sealer) return 0;
		const plain = this.db.select().from(token).where(not(like(token.value, `${SEALED}%`))).all();
		for (const r of plain) {
			this.db
				.update(token)
				.set({ value: this.toStored(r.value) })
				.where(and(eq(token.source, r.source), eq(token.kind, r.kind), eq(token.scope, r.scope)))
				.run();
		}
		return plain.length;
	}
}
