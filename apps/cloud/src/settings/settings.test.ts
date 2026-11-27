// The operator's settings (registry.ts) and their writes from the back office
// (catalog/admin-config.ts): bounds, who, one value for everyone or one
// account's own, and the version the desktops follow.

import { CLOUD_CONFIG_DEFAULTS } from '@curator/protocol';
import { describe, expect, it } from 'vitest';
import { configList, configReset, configSet } from '../catalog/admin-config.js';
import { loadWorkSettings } from '../catalog/work/settings.js';
import { stamped } from '../backoffice/operator.js';
import { createTestDb } from '../test/harness.js';
import { loadCloudConfig } from './cloud-config.js';
import { checkSetting, settingOf } from './registry.js';

const BY = 'guy-pc/guy';

describe('the registry', () => {
	it('takes a value only within its type and bounds', () => {
		const tick = settingOf('worker.tick_sec')!;
		expect(checkSetting(tick, 120)).toEqual({ ok: true, value: 120 });
		expect(checkSetting(tick, 5)).toMatchObject({ ok: false });
		expect(checkSetting(tick, 1e6)).toMatchObject({ ok: false });
		expect(checkSetting(tick, 60.5)).toMatchObject({ ok: false });
		expect(checkSetting(tick, '60')).toMatchObject({ ok: false });
		expect(checkSetting(settingOf('read.cadence.artist')!, 'hourly')).toMatchObject({ ok: false });
		expect(checkSetting(settingOf('work.enabled')!, 'yes')).toMatchObject({ ok: false });
		const releases = settingOf('work.releases')!;
		expect(checkSetting(releases, { phone: 10 })).toMatchObject({ ok: false, error: 'desktop: missing' });
		expect(checkSetting(releases, { phone: 10, desktop: 50, tablet: 1 })).toMatchObject({ ok: false });
		// A store with no cap is left out, not zero.
		expect(checkSetting(settingOf('work.per_day')!, { beatport: 4000 })).toEqual({ ok: true, value: { beatport: 4000 } });
	});
});

describe('writes from the back office', () => {
	it('refuses what the registry refuses, and writes nothing for it', async () => {
		const { db } = await createTestDb();
		await expect(configSet(db, { key: 'worker.tick_sec', value: 1, by: BY })).rejects.toThrow(/between 15 and 900/);
		await expect(configSet(db, { key: 'no.such', value: 1, by: BY })).rejects.toThrow(/no setting/);
		expect(await db.query(`select 1 from curator.catalog_setting where key = 'worker.tick_sec'`)).toEqual([]);
	});

	it('records who changed what, and a reset writes the default so the version only moves forward', async () => {
		const { db } = await createTestDb();
		expect((await loadCloudConfig(db)).version).toBe(0);
		const set = await configSet(db, { key: 'worker.tick_sec', value: 300, by: BY });
		expect(set.version).toBeGreaterThan(0);
		expect((await loadCloudConfig(db)).values.workerTickSec).toBe(300);
		const row = (await configList(db)).rows.find((r) => r.key === 'worker.tick_sec')!;
		expect(row).toMatchObject({ value: 300, atDefault: false, updatedBy: BY, default: CLOUD_CONFIG_DEFAULTS.workerTickSec });
		// Later than the set, whatever the clock's grain.
		await db.query(`update curator.catalog_setting set updated_at = updated_at - interval '1 minute' where key = 'worker.tick_sec'`);
		const before = (await loadCloudConfig(db)).version;
		const reset = await configReset(db, { key: 'worker.tick_sec', by: 'other-pc/guy' });
		expect(reset.version).toBeGreaterThan(before);
		expect(await db.query(`select value::text as value, updated_by as by from curator.catalog_setting where key = 'worker.tick_sec' and scope = '*'`)).toEqual([{ value: '60', by: 'other-pc/guy' }]);
		expect((await configList(db)).rows.find((r) => r.key === 'worker.tick_sec')).toMatchObject({ value: 60, atDefault: true });
	});

	it("lets an account have its own device-work switch, which wins for that account only — and nothing else per account", async () => {
		const t = await createTestDb();
		const [mine, theirs] = [await t.createUser(), await t.createUser()];
		await configSet(t.db, { key: 'work.enabled', value: true, account: mine, by: BY });
		expect((await loadWorkSettings(t.db, mine)).enabled).toBe(true);
		expect((await loadWorkSettings(t.db, theirs)).enabled).toBe(false);
		const list = await configList(t.db);
		expect(list.rows.find((r) => r.key === 'work.enabled')!.overrides).toEqual([expect.objectContaining({ userId: mine, value: true, updatedBy: BY })]);
		await expect(configSet(t.db, { key: 'worker.tick_sec', value: 90, account: mine, by: BY })).rejects.toThrow(/one value for everyone/);
		await expect(configSet(t.db, { key: 'work.enabled', value: true, account: '00000000-0000-4000-8000-000000000000', by: BY })).rejects.toThrow(/no account/);
		// Removing it leaves that account on everyone's value.
		await configReset(t.db, { key: 'work.enabled', account: mine, by: BY });
		expect((await loadWorkSettings(t.db, mine)).enabled).toBe(false);
	});

	it('stamps the writes with this machine, whatever the page says', () => {
		expect(stamped('configSet', { key: 'worker.tick_sec', value: 90, by: 'the page' })).toMatchObject({ key: 'worker.tick_sec', value: 90, by: expect.not.stringMatching(/the page/) });
		expect((stamped('configReset', { key: 'x' }) as { by: string }).by).toMatch(/.+\/.+/);
		// Other ops are left as sent.
		expect(stamped('inboxDecide', { id: 1, by: 'guy' })).toEqual({ id: 1, by: 'guy' });
	});
});
