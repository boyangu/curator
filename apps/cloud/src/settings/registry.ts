// Every value the operator sets for the whole service (curator.catalog_setting,
// sql/0038), with its type, default and bounds: what the back office shows
// and checks before it writes, and what the readers fall back to. One value
// for every account; a key that allows it (`perAccount`) can also be set for
// one account, which wins for that account only.
//
// Two kinds of key:
//   client  carried down to the desktops (cloud-config.ts, protocol
//           CloudConfig) — how they schedule themselves;
//   server  read by the cloud's own planner (catalog/work/settings.ts).
//
// Writes come only from the back office (admin-ops configSet), whose only
// path to the database is the operator's own credential on loopback.

import { CATALOG_READ_CADENCES, CATALOG_TRACKING_KINDS, CATALOG_WORK_STORES, CLOUD_CONFIG_DEFAULTS, WORKER_TICK_SEC_MAX, WORKER_TICK_SEC_MIN } from '@curator/protocol';
import { WORK_DEFAULTS } from '../catalog/work/settings.js';

export type SettingType =
	| { kind: 'bool' }
	| { kind: 'int'; min: number; max: number; unit?: string }
	| { kind: 'enum'; values: readonly string[] }
	// A whole number per named part ({ phone, desktop }, a store each).
	| { kind: 'counts'; parts: readonly string[]; min: number; max: number; optional?: boolean };

export type SettingEntry = {
	key: string;
	group: 'Scheduling' | 'Device work' | 'Background work';
	label: string;
	help: string;
	type: SettingType;
	default: unknown;
	client?: boolean;
	perAccount?: boolean;
};

const DAY = 'days';

export const SETTINGS: readonly SettingEntry[] = [
	{
		key: 'worker.tick_sec',
		group: 'Scheduling',
		label: 'Desktop check interval',
		help: 'How often a desktop asks the cloud for its due reads and work.',
		type: { kind: 'int', min: WORKER_TICK_SEC_MIN, max: WORKER_TICK_SEC_MAX, unit: 's' },
		default: CLOUD_CONFIG_DEFAULTS.workerTickSec,
		client: true,
	},
	...CATALOG_TRACKING_KINDS.map(
		(kind): SettingEntry => ({
			key: `read.cadence.${kind}`,
			group: 'Scheduling',
			label: `Followed ${kind}s read`,
			help: "'source': as often as the source allows · 'daily' · 'weekly': once, in the Friday window.",
			type: { kind: 'enum', values: CATALOG_READ_CADENCES },
			default: CLOUD_CONFIG_DEFAULTS.readCadence[kind],
			client: true,
		}),
	),
	{ key: 'work.enabled', group: 'Device work', label: 'Device work on', help: 'Devices read the stores for the pages they open. Set per account to roll out.', type: { kind: 'bool' }, default: WORK_DEFAULTS.enabled, perAccount: true },
	{ key: 'work.find_days', group: 'Device work', label: 'Listing read again after', help: "An artist's or a label's store page.", type: { kind: 'int', min: 1, max: 90, unit: DAY }, default: WORK_DEFAULTS.findDays },
	{ key: 'work.check_days', group: 'Device work', label: 'Release page confirmed again after', help: 'A release page read in full or confirmed.', type: { kind: 'int', min: 7, max: 365, unit: DAY }, default: WORK_DEFAULTS.checkDays },
	{ key: 'work.retry_days', group: 'Device work', label: '"Not there" asked again after', help: 'A release or a track a store did not have.', type: { kind: 'int', min: 1, max: 90, unit: DAY }, default: WORK_DEFAULTS.retryDays },
	{ key: 'work.rounds', group: 'Device work', label: 'Follow-up rounds per visit', help: 'Answers to a report that may hand more work.', type: { kind: 'int', min: 0, max: 10 }, default: WORK_DEFAULTS.rounds },
	{ key: 'work.min_reader', group: 'Device work', label: 'Oldest reader asked', help: 'Raise past a build that reads wrongly to stop it, without a release.', type: { kind: 'int', min: 1, max: 1000 }, default: WORK_DEFAULTS.minReader },
	{ key: 'work.releases', group: 'Device work', label: 'Releases per visit', help: 'Work one page visit is handed, by form of device.', type: { kind: 'counts', parts: ['phone', 'desktop'], min: 0, max: 1000 }, default: WORK_DEFAULTS.releases },
	{ key: 'work.per_day', group: 'Device work', label: 'Store calls a day', help: "Over everyone and everything (the trackers' too); past it, no work for that store until tomorrow (UTC).", type: { kind: 'counts', parts: CATALOG_WORK_STORES, min: 0, max: 1_000_000, optional: true }, default: WORK_DEFAULTS.perDay },
	{ key: 'work.background.enabled', group: 'Background work', label: 'Background work on', help: "The account's main desktop completes what its weekly reads found (tracklists, store pages, track facts) on its regular check. Set per account to roll out.", type: { kind: 'bool' }, default: WORK_DEFAULTS.background.enabled, perAccount: true },
	{ key: 'work.background.releases', group: 'Background work', label: 'Releases per check', help: 'Releases planned for the main desktop on one check, at most.', type: { kind: 'int', min: 1, max: 100 }, default: WORK_DEFAULTS.background.releases },
	{ key: 'work.background.share_pct', group: 'Background work', label: "Share of a store's day", help: "Background work stops for a store once this much of its day's calls is used, leaving the rest to the pages people open.", type: { kind: 'int', min: 0, max: 100, unit: '%' }, default: WORK_DEFAULTS.background.sharePct },
	{ key: 'work.background.lease_min', group: 'Background work', label: 'Job held for', help: 'How long a job handed to the main desktop is held before it may be handed again.', type: { kind: 'int', min: 1, max: 240, unit: 'min' }, default: WORK_DEFAULTS.background.leaseMin },
];

export const settingOf = (key: string): SettingEntry | undefined => SETTINGS.find((s) => s.key === key);

// A value as the entry takes it, or why not.
export function checkSetting(entry: SettingEntry, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
	const t = entry.type;
	if (t.kind === 'bool') return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'true or false' };
	if (t.kind === 'int') {
		if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, error: 'a whole number' };
		if (value < t.min || value > t.max) return { ok: false, error: `between ${t.min} and ${t.max}` };
		return { ok: true, value };
	}
	if (t.kind === 'enum') return typeof value === 'string' && t.values.includes(value) ? { ok: true, value } : { ok: false, error: `one of ${t.values.join(', ')}` };
	if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: `a number for each of ${t.parts.join(', ')}` };
	const out: Record<string, number> = {};
	for (const [part, n] of Object.entries(value as Record<string, unknown>)) {
		if (!t.parts.includes(part)) return { ok: false, error: `${part}: not one of ${t.parts.join(', ')}` };
		if (typeof n !== 'number' || !Number.isInteger(n) || n < t.min || n > t.max) return { ok: false, error: `${part}: a whole number between ${t.min} and ${t.max}` };
		out[part] = n;
	}
	if (!t.optional) for (const part of t.parts) if (!(part in out)) return { ok: false, error: `${part}: missing` };
	return { ok: true, value: out };
}
