// The cloud's settings for device work (sql/0038 catalog_setting): the ages a
// job is asked again after, how much one page visit is handed, the calls a
// day per store, and the switch. Read with every plan — one small statement
// by primary key — so a change takes effect on the next read of anything,
// with no release and no restart. A user's own row wins over everyone's.
//
// A read that carries a profile pays one statement for all of it
// (loadPlanInputs): the settings, what each store's day has used, and the
// wait its planner allows itself on a row a report is writing.

import { CATALOG_WORK_STORES, type CatalogDeviceForm, type CatalogWorkStore } from '@curator/protocol';
import type { Queryable } from '../../db/db.js';

export type WorkSettings = {
	enabled: boolean;
	findDays: number;
	checkDays: number;
	retryDays: number;
	rounds: number;
	// The oldest reading code still asked: a build that reads wrongly is
	// stopped by raising this past it, without a release of anything.
	minReader: number;
	releases: Record<CatalogDeviceForm, number>;
	perDay: Partial<Record<CatalogWorkStore, number>>;
	// What an account's main desktop completes on its checks (background.ts):
	// the switch (per account, to roll out), the releases planned a check, the
	// share of each store's day it may use, and how long a handed job is held.
	background: { enabled: boolean; releases: number; sharePct: number; leaseMin: number };
};

// What a database without the rows (a test's, a half-applied migration's)
// reads as: off.
export const WORK_DEFAULTS: WorkSettings = {
	enabled: false,
	findDays: 7,
	checkDays: 90,
	retryDays: 7,
	rounds: 3,
	minReader: 1,
	releases: { phone: 20, desktop: 100 },
	perDay: {},
	background: { enabled: false, releases: 10, sharePct: 50, leaseMin: 15 },
};

const count = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);

// `rows`: everyone's row before the user's, so the user's is the one kept.
function settingsOf(rows: readonly { key: string; value: string }[]): WorkSettings {
	const s: WorkSettings = { ...WORK_DEFAULTS, releases: { ...WORK_DEFAULTS.releases }, perDay: {}, background: { ...WORK_DEFAULTS.background } };
	for (const r of rows) {
		const v: unknown = JSON.parse(r.value);
		switch (r.key) {
			case 'work.enabled': s.enabled = v === true; break;
			case 'work.find_days': s.findDays = count(v, s.findDays); break;
			case 'work.check_days': s.checkDays = count(v, s.checkDays); break;
			case 'work.retry_days': s.retryDays = count(v, s.retryDays); break;
			case 'work.rounds': s.rounds = count(v, s.rounds); break;
			case 'work.min_reader': s.minReader = count(v, s.minReader); break;
			case 'work.releases':
				if (v && typeof v === 'object') {
					const o = v as Record<string, unknown>;
					s.releases = { phone: count(o['phone'], s.releases.phone), desktop: count(o['desktop'], s.releases.desktop) };
				}
				break;
			case 'work.background.enabled': s.background.enabled = v === true; break;
			case 'work.background.releases': s.background.releases = count(v, s.background.releases); break;
			case 'work.background.share_pct': s.background.sharePct = Math.min(100, count(v, s.background.sharePct)); break;
			case 'work.background.lease_min': s.background.leaseMin = count(v, s.background.leaseMin); break;
			case 'work.per_day':
				if (v && typeof v === 'object') {
					s.perDay = {};
					for (const store of CATALOG_WORK_STORES) {
						const n = (v as Record<string, unknown>)[store];
						if (typeof n === 'number' && n >= 0) s.perDay[store] = n;
					}
				}
				break;
		}
	}
	return s;
}

export async function loadWorkSettings(tx: Queryable, userId: string): Promise<WorkSettings> {
	return settingsOf(
		await tx.query<{ key: string; value: string }>(`select key, value::text as value from curator.catalog_setting where key like 'work.%' and scope in ('*', $1) order by (scope = '*') desc`, [userId]),
	);
}

// What a plan is made from besides the page: the settings, and what each
// store's day has used so far. One statement, which also sets how long the
// transaction waits for a row lock from here on (`lockWait`): the planner's
// only writes are a label's kept comparison and a notice to the operator, and
// a read must not hang on a report that is writing the same rows.
export type PlanInputs = { settings: WorkSettings; used: Partial<Record<CatalogWorkStore, number>> };

export async function loadPlanInputs(tx: Queryable, userId: string, lockWait: string): Promise<PlanInputs> {
	const [row] = await tx.query<{ settings: string | null; used: string | null }>(
		`select
			(select jsonb_agg(jsonb_build_object('key', key, 'value', value::text) order by (scope = '*') desc)::text
				from curator.catalog_setting where key like 'work.%' and scope in ('*', $1)) as settings,
			(select jsonb_object_agg(provider, units_used)::text
				from curator.provider_budget where day = (now() at time zone 'utc')::date and provider = any($2::text[])) as used,
			set_config('lock_timeout', $3, true) as lock_wait`,
		[userId, `{${CATALOG_WORK_STORES.join(',')}}`, lockWait],
	);
	const used: PlanInputs['used'] = {};
	for (const [store, n] of Object.entries((row?.used ? JSON.parse(row.used) : {}) as Record<string, unknown>)) used[store as CatalogWorkStore] = Number(n);
	return { settings: settingsOf(row?.settings ? (JSON.parse(row.settings) as { key: string; value: string }[]) : []), used };
}

// The stores whose day's count is used up: no work for them until tomorrow.
export const spentOf = (i: PlanInputs): Set<CatalogWorkStore> =>
	new Set(CATALOG_WORK_STORES.filter((s) => i.settings.perDay[s] !== undefined && (i.used[s] ?? 0) >= i.settings.perDay[s]!));

// A setting, for everyone or one user (the back office's command; tests).
export async function setWorkSetting(tx: Queryable, key: string, value: unknown, opts: { scope?: string; by?: string } = {}): Promise<void> {
	await tx.query(
		`insert into curator.catalog_setting (key, scope, value, updated_by) values ($1, $2, $3::text::jsonb, $4)
		on conflict (key, scope) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
		[key, opts.scope ?? '*', JSON.stringify(value), opts.by ?? 'operator'],
	);
}
