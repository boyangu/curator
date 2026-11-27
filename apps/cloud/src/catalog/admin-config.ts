// The operator's settings in the back office (settings/registry.ts): what each
// is, what it is set to, and the writes — one value for everyone, or one
// account's own where the key allows it. Reached only through admin-ops from
// the back office's /admin on loopback, so only a machine holding the
// operator's database credential can write; `by` is that machine and its
// user, stamped by the CLI process, never by the page.
//
// A reset of everyone's value writes the default instead of deleting the row:
// the desktops' copy is versioned by when a client value last changed
// (settings/cloud-config.ts), and a deleted row would move that back.

import { CATALOG_TRACKING_KINDS, type CatalogReadCadence, type CatalogTrackingKind } from '@curator/protocol';
import type { Db, Queryable } from '../db/db.js';
import { withSystemTx, type SystemTx } from '../db/system-tx.js';
import { loadCloudConfig } from '../settings/cloud-config.js';
import { checkSetting, SETTINGS, settingOf, type SettingEntry } from '../settings/registry.js';
import { retimeKind } from './tracking.js';

export type ConfigOverride = { userId: string; email: string | null; value: unknown; updatedAt: number; updatedBy: string };
export type ConfigRow = Omit<SettingEntry, 'default'> & {
	default: unknown;
	value: unknown;
	atDefault: boolean;
	updatedAt: number | null;
	updatedBy: string | null;
	overrides: ConfigOverride[];
};
export type ConfigList = { version: number; rows: ConfigRow[] };
export type ConfigWrite = { key: string; scope: 'everyone' | string; value: unknown; retimed: number; version: number };

type Row = { key: string; scope: string; value: string; at: unknown; by: string };

// An account's email where auth.users can be read from this connection
// (Supabase's has it; the local shim's has none): on its own savepoint, so
// a refusal costs the lookup and not the transaction.
async function emailsOf(tx: SystemTx, ids: readonly string[]): Promise<Map<string, string>> {
	if (!ids.length) return new Map();
	try {
		const rows = await tx.savepoint((s) =>
			s.query<{ id: string; email: string | null }>(`select id::text, to_jsonb(u) ->> 'email' as email from auth.users u where id = any($1::uuid[])`, [`{${ids.join(',')}}`]),
		);
		return new Map(rows.filter((r) => r.email).map((r) => [r.id, r.email!]));
	} catch {
		return new Map();
	}
}

// The account named by its id or its email.
async function accountOf(tx: SystemTx, account: string): Promise<string> {
	const q = account.trim();
	if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
		let known: boolean;
		try {
			known = (await tx.savepoint((s) => s.query(`select 1 from auth.users where id = $1`, [q]))).length > 0;
		} catch {
			// auth.users is not this connection's to read: the id is taken as given.
			return q.toLowerCase();
		}
		if (!known) throw new Error(`no account ${q}`);
		return q.toLowerCase();
	}
	let found: { id: string }[] = [];
	try {
		found = await tx.savepoint((s) => s.query<{ id: string }>(`select id::text from auth.users u where lower(to_jsonb(u) ->> 'email') = lower($1)`, [q]));
	} catch {
		throw new Error('accounts cannot be looked up by email from here: give the account id');
	}
	if (found.length !== 1) throw new Error(found.length ? `${q} names ${found.length} accounts` : `no account with the email ${q}`);
	return found[0]!.id;
}

const parse = (v: string): unknown => JSON.parse(v) as unknown;

export async function configList(db: Db): Promise<ConfigList> {
	return withSystemTx(db, async (tx) => {
		const rows = await tx.query<Row>(`select key, scope, value::text as value, extract(epoch from updated_at) * 1000 as at, updated_by as by from curator.catalog_setting`);
		const emails = await emailsOf(tx, [...new Set(rows.filter((r) => r.scope !== '*').map((r) => r.scope))]);
		const { version } = await loadCloudConfig(tx);
		return {
			version,
			rows: SETTINGS.map((entry): ConfigRow => {
				const everyone = rows.find((r) => r.key === entry.key && r.scope === '*');
				const checked = everyone ? checkSetting(entry, parse(everyone.value)) : null;
				const value = checked?.ok ? checked.value : entry.default;
				return {
					...entry,
					value,
					atDefault: JSON.stringify(value) === JSON.stringify(entry.default),
					updatedAt: everyone ? Math.floor(Number(everyone.at)) : null,
					updatedBy: everyone?.by ?? null,
					overrides: entry.perAccount
						? rows
								.filter((r) => r.key === entry.key && r.scope !== '*')
								.map((r) => ({ userId: r.scope, email: emails.get(r.scope) ?? null, value: parse(r.value), updatedAt: Math.floor(Number(r.at)), updatedBy: r.by }))
						: [],
				};
			}),
		};
	});
}

const entryOf = (key: string): SettingEntry => {
	const entry = settingOf(key);
	if (!entry) throw new Error(`no setting ${key}`);
	return entry;
};

async function write(tx: SystemTx, entry: SettingEntry, scope: string, value: unknown, by: string): Promise<number> {
	const [prev] = await tx.query<{ value: string }>(`select value::text as value from curator.catalog_setting where key = $1 and scope = $2 for update`, [entry.key, scope]);
	await tx.query(
		`insert into curator.catalog_setting (key, scope, value, updated_by) values ($1, $2, $3::text::jsonb, $4)
		on conflict (key, scope) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
		[entry.key, scope, JSON.stringify(value), by],
	);
	// A kind now read more often: everyone's cursors of it come forward.
	const kind = CATALOG_TRACKING_KINDS.find((k) => entry.key === `read.cadence.${k}`);
	if (scope !== '*' || !kind) return 0;
	const before = prev ? checkSetting(entry, parse(prev.value)) : null;
	return retimeKind(tx, kind as CatalogTrackingKind, (before?.ok ? before.value : entry.default) as CatalogReadCadence, value as CatalogReadCadence);
}

async function done(tx: Queryable, key: string, scope: string, value: unknown, retimed: number): Promise<ConfigWrite> {
	return { key, scope: scope === '*' ? 'everyone' : scope, value, retimed, version: (await loadCloudConfig(tx)).version };
}

export async function configSet(db: Db, args: { key: string; value: unknown; account?: string; by: string }): Promise<ConfigWrite> {
	const entry = entryOf(args.key);
	const checked = checkSetting(entry, args.value);
	if (!checked.ok) throw new Error(`${entry.label}: ${checked.error}`);
	return withSystemTx(db, async (tx) => {
		if (args.account && !entry.perAccount) throw new Error(`${entry.label} is one value for everyone`);
		const scope = args.account ? await accountOf(tx, args.account) : '*';
		const retimed = await write(tx, entry, scope, checked.value, args.by);
		return done(tx, entry.key, scope, checked.value, retimed);
	});
}

export async function configReset(db: Db, args: { key: string; account?: string; by: string }): Promise<ConfigWrite> {
	const entry = entryOf(args.key);
	return withSystemTx(db, async (tx) => {
		if (args.account) {
			const scope = await accountOf(tx, args.account);
			await tx.query(`delete from curator.catalog_setting where key = $1 and scope = $2`, [entry.key, scope]);
			return done(tx, entry.key, scope, null, 0);
		}
		const retimed = await write(tx, entry, '*', entry.default, args.by);
		return done(tx, entry.key, '*', entry.default, retimed);
	});
}
