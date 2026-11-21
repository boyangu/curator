// better-sqlite3's API, as far as the sync core uses it, over the host's
// SQLite (host/host.c). The JavaScript half of what would be the phone's
// database port: parameter mapping, pluck/raw modes and transactions follow
// better-sqlite3's own behaviour, since the core relies on it (nested
// transactions are savepoints, a throw rolls back and rethrows).

import { host } from './host.js';

const ROW = 0;
const PLUCK = 1;
const RAW = 2;

type RunResult = { changes: number; lastInsertRowid: number };

const isNamedBag = (a: unknown): a is Record<string, unknown> => {
	if (typeof a !== 'object' || a === null || Array.isArray(a) || ArrayBuffer.isView(a)) return false;
	const proto = Object.getPrototypeOf(a);
	return proto === Object.prototype || proto === null;
};

class Statement {
	private mode = ROW;
	private bound: unknown[] | null = null;
	private readonly named: boolean;

	constructor(
		readonly database: Database,
		private readonly native: unknown,
		readonly reader: boolean,
		private readonly names: Array<string | null>,
		readonly source: string,
	) {
		this.named = names.some((n) => n !== null);
		if (names.some((n) => n !== null && n.startsWith('?'))) throw new Error(`numbered parameters (?NNN) are not in the spike's binding: ${source}`);
	}

	pluck(on = true): this { this.mode = on ? PLUCK : ROW; return this; }
	raw(on = true): this { this.mode = on ? RAW : ROW; return this; }

	bind(...args: unknown[]): this {
		if (this.bound) throw new TypeError('The bind() method can only be invoked once per statement object');
		this.bound = this.params(args);
		return this;
	}

	run(...args: unknown[]): RunResult {
		return host.stmtRun(this.native, this.params(args));
	}

	get(...args: unknown[]): unknown {
		this.mustRead();
		return host.stmtGet(this.native, this.params(args), this.mode);
	}

	all(...args: unknown[]): unknown[] {
		this.mustRead();
		return host.stmtAll(this.native, this.params(args), this.mode);
	}

	*iterate(...args: unknown[]): IterableIterator<unknown> {
		this.mustRead();
		host.stmtIterStart(this.native, this.params(args));
		try {
			for (;;) {
				const row = host.stmtIterNext(this.native, this.mode);
				if (row === undefined) return;
				yield row;
			}
		} finally {
			host.stmtReset(this.native);
		}
	}

	private mustRead(): void {
		if (!this.reader) throw new TypeError('This statement does not return data. Use run() instead');
	}

	// The call's arguments as one value per parameter, in SQLite's order.
	private params(args: unknown[]): unknown[] {
		if (this.bound) {
			if (args.length > 0) throw new TypeError('This statement already has bound parameters');
			return this.bound;
		}
		if (!this.named) {
			if (args.length === 1 && Array.isArray(args[0])) return args[0];
			for (let i = 0; i < args.length; i++) if (Array.isArray(args[i])) return args.flat(1);
			return args;
		}
		let bag: Record<string, unknown> | null = null;
		const anon: unknown[] = [];
		for (const a of args) {
			if (Array.isArray(a)) anon.push(...a);
			else if (isNamedBag(a)) {
				if (bag) throw new TypeError('You cannot specify named parameters in two different objects');
				bag = a;
			} else anon.push(a);
		}
		const out = new Array<unknown>(this.names.length);
		let next = 0;
		for (let i = 0; i < this.names.length; i++) {
			const name = this.names[i];
			if (name === null) {
				if (next >= anon.length) throw new RangeError('Too few parameter values were provided');
				out[i] = anon[next++];
			} else {
				const key = name.slice(1);
				if (!bag || !(key in bag)) throw new RangeError(`Missing named parameter "${key}"`);
				out[i] = bag[key];
			}
		}
		if (next < anon.length) throw new RangeError('Too many parameter values were provided');
		return out;
	}
}

type Txn<F extends (...a: never[]) => unknown> = F & { default: F; deferred: F; immediate: F; exclusive: F; database: Database };

class Database {
	readonly name: string;
	readonly readonly: boolean;
	open = true;
	private readonly native: unknown;
	private txn: Record<'begin' | 'commit' | 'rollback' | 'savepoint' | 'release' | 'rollbackTo', Statement> & Record<'deferred' | 'immediate' | 'exclusive', Statement> | null = null;

	constructor(path: string, opts: { readonly?: boolean; fileMustExist?: boolean } = {}) {
		this.name = path;
		this.readonly = !!opts.readonly;
		this.native = host.dbOpen(path, this.readonly, !!opts.fileMustExist);
	}

	get inTransaction(): boolean {
		return !host.dbAutocommit(this.native);
	}

	prepare(sql: string): Statement {
		const [native, reader, names] = host.dbPrepare(this.native, sql) as [unknown, boolean, Array<string | null>];
		return new Statement(this, native, reader, names, sql);
	}

	exec(sql: string): this {
		host.dbExec(this.native, sql);
		return this;
	}

	pragma(source: string, opts: { simple?: boolean } = {}): unknown {
		const stmt = this.prepare(`PRAGMA ${source}`);
		if (!stmt.reader) {
			stmt.run();
			return opts.simple ? undefined : [];
		}
		return opts.simple ? stmt.pluck().get() : stmt.all();
	}

	// better-sqlite3 lib/methods/transaction.js: BEGIN outside a transaction,
	// a savepoint inside one; the function's throw undoes its own level only.
	transaction<F extends (...a: never[]) => unknown>(fn: F): Txn<F> {
		const t = (this.txn ??= {
			begin: this.prepare('BEGIN'),
			deferred: this.prepare('BEGIN DEFERRED'),
			immediate: this.prepare('BEGIN IMMEDIATE'),
			exclusive: this.prepare('BEGIN EXCLUSIVE'),
			commit: this.prepare('COMMIT'),
			rollback: this.prepare('ROLLBACK'),
			savepoint: this.prepare('SAVEPOINT `\t_bs3.\t`'),
			release: this.prepare('RELEASE `\t_bs3.\t`'),
			rollbackTo: this.prepare('ROLLBACK TO `\t_bs3.\t`'),
		});
		const db = this;
		const wrap = (begin: Statement): F => function (this: unknown, ...args: unknown[]): unknown {
			let after: Statement;
			let undo: Statement;
			if (db.inTransaction) {
				t.savepoint.run();
				after = t.release;
				undo = t.rollbackTo;
			} else {
				begin.run();
				after = t.commit;
				undo = t.rollback;
			}
			try {
				const result = (fn as (...a: unknown[]) => unknown).apply(this, args);
				if (result && typeof (result as { then?: unknown }).then === 'function') throw new TypeError('Transaction function cannot return a promise');
				after.run();
				return result;
			} catch (err) {
				if (db.inTransaction) {
					undo.run();
					if (undo !== t.rollback) after.run();
				}
				throw err;
			}
		} as unknown as F;
		const out = wrap(t.begin) as Txn<F>;
		out.default = out;
		out.deferred = wrap(t.deferred);
		out.immediate = wrap(t.immediate);
		out.exclusive = wrap(t.exclusive);
		out.database = this;
		return out;
	}

	close(): this {
		this.txn = null;
		host.dbClose(this.native);
		this.open = false;
		return this;
	}
}

export default Database;
