import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AUDIO_HASH_RE,
	CATALOGUE_UNITS,
	catalogueBlobPath,
	MAX_CATALOGUE_INVENTORY,
	MAX_CATALOGUE_PUT_ITEMS,
	type CatalogueItem,
	type CatalogueUnit,
} from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findSqlDir } from '../db/migrate.js';
import { TokenBucketLimiter } from '../rate-limit.js';
import { blobOf, hashOf, itemFor, randomAudioHash, sha } from '../test/catalogue-fixtures.js';
import { asUser, createTestApp, entitle, errorReason, uploadBlob, type TestApp } from '../test/harness.js';
import { CATALOGUE_POLICY_D_B, parseCataloguePolicy } from './policy.js';

let app: TestApp;
beforeAll(async () => {
	app = await createTestApp();
});
afterAll(() => app.db.close());

type Session = Awaited<ReturnType<TestApp['signIn']>>;

// A signed-in, registered, entitled user.
async function member(t: TestApp = app, quotaBytes?: number): Promise<Session> {
	const s = await t.signIn();
	await entitle(t.pg, s.userId, { quotaBytes });
	return s;
}

// Uploads every blob the items name, as the device would before the put.
async function uploadFor(t: TestApp, s: Session, items: CatalogueItem[]): Promise<void> {
	for (const it of items) {
		const b = blobOf(it);
		if (b) await uploadBlob(t.pg, s.userId, b.path, b.bytes).catch((e: unknown) => {
			// Content-addressed: the same blob twice is already there.
			if (!String(e).includes('duplicate key')) throw e;
		});
	}
}

const ALL_D_A: CatalogueUnit[] = ['rhythm', 'key', 'structure', 'advanced', 'fingerprint', 'peaks'];
const want = (units: CatalogueUnit[] = [...CATALOGUE_UNITS]) => units.map((unit) => ({ unit }));

describe('catalogue round trip', () => {
	it('stores one item per unit and hands each back exactly, with its rev and device', async () => {
		const s = await member();
		const hash = randomAudioHash();
		const items = ALL_D_A.map((u) => itemFor(s.userId, u, hash));
		await uploadFor(app, s, items);
		const put = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items });
		expect(put.rejected).toEqual([]);
		expect(put.accepted.map((a) => a.index)).toEqual(items.map((_, i) => i));
		expect(put.superseded).toEqual([]);
		// Revs follow the batch order.
		const revs = put.accepted.map((a) => a.rev);
		expect([...revs].sort((a, b) => a - b)).toEqual(revs);

		const { items: got } = await s.api.catalogue.lookup.mutate({ deviceId: s.deviceId, audioHashes: [hash], want: want() });
		expect(got).toHaveLength(items.length);
		for (const item of items) {
			const g = got.find((x) => x.unit === item.unit)!;
			const { rev, deviceId, updatedAt, ...rest } = g;
			expect(rest).toEqual(item);
			expect(deviceId).toBe(s.deviceId);
			expect(rev).toBe(put.accepted[items.indexOf(item)]!.rev);
			expect(Math.abs(updatedAt - Date.now())).toBeLessThan(60_000);
		}
	});

	it('takes hi peaks and vectors once the policy is D-b, with no code change', async () => {
		const b = await createTestApp({ catalogue: parseCataloguePolicy(CATALOGUE_POLICY_D_B) });
		try {
			const s = await member(b);
			const hash = randomAudioHash();
			const items = [
				itemFor(s.userId, 'peaks', hash, { variant: 'hi', bytes: 9_000_000 }),
				itemFor(s.userId, 'vectors', hash),
				itemFor(s.userId, 'vectors', hash, { variant: 'muq-mulan-large@1' }),
			];
			await uploadFor(b, s, items);
			const put = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items });
			expect(put.rejected).toEqual([]);
			const { items: got } = await s.api.catalogue.lookup.mutate({ deviceId: s.deviceId, audioHashes: [hash], want: [{ unit: 'vectors' }, { unit: 'peaks', variant: 'hi' }] });
			expect(got.map((g) => `${g.unit}:${g.variant}`).sort()).toEqual(['peaks:hi', 'vectors:mert-v2-fullsong@1', 'vectors:muq-mulan-large@1']);
			expect(got.find((g) => g.unit === 'vectors')!.licence).toBe('CC-BY-NC-4.0');
		} finally {
			await b.db.close();
		}
	});
});

describe('catalogue.lookup', () => {
	let s: Session;
	const hash = hashOf('lookup-floors');
	beforeAll(async () => {
		s = await member();
		const items = [
			itemFor(s.userId, 'rhythm', hash, { version: [2, 2, 0] }),
			itemFor(s.userId, 'rhythm', hash, { version: [2, 10, 0] }),
			itemFor(s.userId, 'fingerprint', hash, { version: [2, 3, 0] }),
			itemFor(s.userId, 'peaks', hash),
		];
		await uploadFor(app, s, items);
		// Both rhythm versions are kept (the newest two).
		expect((await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items })).rejected).toEqual([]);
	});
	const ask = (w: { unit: CatalogueUnit; variant?: string; minVersion?: number[]; maxSchema?: number }[], hashes = [hash]) =>
		s.api.catalogue.lookup.mutate({ deviceId: s.deviceId, audioHashes: hashes, want: w });

	it('returns the newest version, comparing versions numerically', async () => {
		const { items } = await ask([{ unit: 'rhythm' }]);
		expect(items.map((i) => i.version)).toEqual([[2, 10, 0]]);
	});

	it('honours the reader floor per unit', async () => {
		// The fingerprint floor is 2.4.0; this account only has 2.3.0.
		expect((await ask([{ unit: 'fingerprint', minVersion: [2, 4, 0] }])).items).toEqual([]);
		expect((await ask([{ unit: 'fingerprint', minVersion: [2, 3, 0] }])).items).toHaveLength(1);
		// Above every version held: nothing; between: the newer only.
		expect((await ask([{ unit: 'rhythm', minVersion: [2, 11, 0] }])).items).toEqual([]);
		expect((await ask([{ unit: 'rhythm', minVersion: [2, 3, 0] }])).items.map((i) => i.version)).toEqual([[2, 10, 0]]);
	});

	it('honours the reader schema ceiling', async () => {
		// All stored items are schema 1; a ceiling of 1 takes them.
		expect((await ask([{ unit: 'key', maxSchema: 1 }, { unit: 'rhythm', maxSchema: 1 }])).items).toHaveLength(1);
		await app.pg.query(`update curator.catalogue_item set unit_schema = 2 where audio_hash = $1 and unit = 'fingerprint'`, [hash]);
		try {
			expect((await ask([{ unit: 'fingerprint', maxSchema: 1 }])).items).toEqual([]);
			expect((await ask([{ unit: 'fingerprint' }])).items).toHaveLength(1);
		} finally {
			await app.pg.query(`update curator.catalogue_item set unit_schema = 1 where audio_hash = $1 and unit = 'fingerprint'`, [hash]);
		}
	});

	it('matches variants: absent = all, named = only that', async () => {
		expect((await ask([{ unit: 'peaks' }])).items.map((i) => i.variant)).toEqual(['lo']);
		expect((await ask([{ unit: 'peaks', variant: 'hi' }])).items).toEqual([]);
	});

	it('answers unknown hashes with nothing and duplicate wants once', async () => {
		expect((await ask([{ unit: 'rhythm' }], [randomAudioHash()])).items).toEqual([]);
		expect((await ask([{ unit: 'rhythm' }, { unit: 'rhythm', minVersion: [1] }])).items).toHaveLength(1);
	});

	it('refuses more than 50 hashes and malformed input as BAD_REQUEST', async () => {
		const many = Array.from({ length: 51 }, () => randomAudioHash());
		expect(await errorReason(ask([{ unit: 'rhythm' }], many))).toMatchObject({ code: 'BAD_REQUEST' });
		expect(await errorReason(ask([{ unit: 'rhythm' }], ['not-a-hash']))).toMatchObject({ code: 'BAD_REQUEST' });
	});
});

describe('catalogue.put rejections', () => {
	it('rejects each bad item alone and stores the rest', async () => {
		const s = await member();
		const other = await member();
		const hash = randomAudioHash();
		const good = itemFor(s.userId, 'key', hash);
		const missing = itemFor(s.userId, 'peaks', hash, { blobSeed: 'never uploaded' });
		const wrongSize = itemFor(s.userId, 'peaks', randomAudioHash(), { bytes: 5000 });
		await uploadBlob(app.pg, s.userId, blobOf(wrongSize)!.path, 4999);
		const foreignPath = itemFor(other.userId, 'peaks', randomAudioHash());
		const wrongDir = itemFor(s.userId, 'peaks', randomAudioHash());
		if (wrongDir.unit !== 'peaks') throw new Error('unreachable');
		wrongDir.data.blob.path = wrongDir.data.blob.path.replace('/peaks/', '/vec/');
		const items: unknown[] = [
			good,
			{ ...good, audioHash: 'pcm-md5:XYZ' },
			itemFor(s.userId, 'peaks', hash, { variant: 'hi' }),
			itemFor(s.userId, 'vectors', hash),
			missing,
			wrongSize,
			foreignPath,
			wrongDir,
			{ ...itemFor(s.userId, 'advanced', hash), data: { ...(itemFor(s.userId, 'advanced', hash).data as object), features: { bad: 'nul\u0000' } } },
			{ ...good, unitSchema: 99 },
		];
		const r = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items });
		expect(r.accepted.map((a) => a.index)).toEqual([0]);
		expect(r.rejected).toEqual([
			{ index: 1, reason: 'invalid_item' },
			{ index: 2, reason: 'unit_disabled' },
			{ index: 3, reason: 'unit_disabled' },
			{ index: 4, reason: 'blob_missing' },
			{ index: 5, reason: 'blob_size_mismatch' },
			{ index: 6, reason: 'blob_path_invalid' },
			{ index: 7, reason: 'blob_path_invalid' },
			{ index: 8, reason: 'invalid_item' },
			{ index: 9, reason: 'invalid_item' },
		]);
	});

	it('lets the last copy of a key in a batch win', async () => {
		const s = await member();
		const hash = randomAudioHash();
		const first = itemFor(s.userId, 'key', hash);
		const second = { ...first, data: { camelot: '6B', strength: 0.5 } };
		const r = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [first, second] });
		expect(r.rejected).toEqual([{ index: 0, reason: 'duplicate_in_batch' }]);
		const { items } = await s.api.catalogue.lookup.mutate({ deviceId: s.deviceId, audioHashes: [hash], want: [{ unit: 'key' }] });
		expect(items[0]!.data).toEqual({ camelot: '6B', strength: 0.5 });
	});

	it('refuses a version older than the two it keeps', async () => {
		const s = await member();
		const hash = randomAudioHash();
		await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [itemFor(s.userId, 'key', hash, { version: [2, 4, 0] }), itemFor(s.userId, 'key', hash, { version: [2, 5, 0] })] });
		const r = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [itemFor(s.userId, 'key', hash, { version: [2, 3, 0] })] });
		expect(r.rejected).toEqual([{ index: 0, reason: 'version_outdated' }]);
		// One already kept is an overwrite, not outdated.
		expect((await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [itemFor(s.userId, 'key', hash, { version: [2, 4, 0] })] })).rejected).toEqual([]);
	});

	it('enforces the quota and reports usage', async () => {
		const s = await member(app, 20_000);
		const hash = randomAudioHash();
		const lo = itemFor(s.userId, 'peaks', hash, { bytes: 15_000 });
		const big = itemFor(s.userId, 'peaks', randomAudioHash(), { bytes: 6000 });
		await uploadFor(app, s, [lo, big]);
		const first = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [lo] });
		expect(first.rejected).toEqual([]);
		expect(first.usage.quotaBytes).toBe(20_000);
		expect(first.usage.usedBytes).toBeGreaterThan(15_000);
		expect(first.usage.usedBytes).toBeLessThan(15_500);
		const second = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [big, itemFor(s.userId, 'key', hash)] });
		expect(second.rejected).toEqual([{ index: 0, reason: 'quota_exceeded' }]);
		// Small inline items still fit beside it.
		expect(second.accepted.map((a) => a.index)).toEqual([1]);
	});

	it('refuses a whole batch over 100 items or 1 MiB', async () => {
		const s = await member();
		const items = Array.from({ length: MAX_CATALOGUE_PUT_ITEMS + 1 }, () => itemFor(s.userId, 'key', randomAudioHash()));
		expect(await errorReason(s.api.catalogue.put.mutate({ deviceId: s.deviceId, items }))).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', reason: 'batch_too_large' });
		const fat = Array.from({ length: 3 }, () => {
			const it = itemFor(s.userId, 'advanced', randomAudioHash());
			return { ...it, data: { ...(it.data as object), features: { pad: 'x'.repeat(400_000) } } };
		});
		expect(await errorReason(s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: fat }))).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', reason: 'batch_too_large' });
		// Exactly 100 is fine.
		expect((await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: items.slice(0, MAX_CATALOGUE_PUT_ITEMS) })).accepted).toHaveLength(100);
	});
});

describe('catalogue revs and retention', () => {
	it('bumps the rev on an overwrite of the same version', async () => {
		const s = await member();
		const hash = randomAudioHash();
		const a = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [itemFor(s.userId, 'key', hash)] });
		const b = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [{ ...itemFor(s.userId, 'key', hash), data: { camelot: '1B', strength: null } }] });
		expect(b.accepted[0]!.rev).toBeGreaterThan(a.accepted[0]!.rev);
		const inv = await s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: a.accepted[0]!.rev });
		expect(inv.entries).toEqual([expect.objectContaining({ audioHash: hash, unit: 'key', rev: b.accepted[0]!.rev })]);
	});

	it('keeps the newest two versions and names the dropped blob as superseded', async () => {
		const s = await member();
		const hash = randomAudioHash();
		const v = (version: number[], blobSeed?: string) => itemFor(s.userId, 'peaks', hash, { version, blobSeed });
		const [v1, v2, v3] = [v([2, 3, 0]), v([2, 4, 0]), v([2, 5, 0])];
		await uploadFor(app, s, [v1, v2, v3]);
		expect((await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [v1, v2] })).superseded).toEqual([]);
		const r = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [v3] });
		expect(r.superseded).toEqual([blobOf(v1)!.path]);
		const left = await app.pg.query<{ version: number[] }>(`select version from curator.catalogue_item where audio_hash = $1 order by version`, [hash]);
		expect(left.rows.map((x) => x.version)).toEqual([
			[2, 4, 0],
			[2, 5, 0],
		]);
	});

	it('never names a blob another item still uses', async () => {
		const s = await member();
		const hash = randomAudioHash();
		// Same bytes from three analyzer versions: one content-addressed object.
		const items = [[2, 3, 0], [2, 4, 0], [2, 5, 0]].map((version) => itemFor(s.userId, 'peaks', hash, { version, blobSeed: 'identical cpk' }));
		await uploadFor(app, s, items);
		const r = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items });
		expect(r.rejected).toEqual([]);
		expect(r.superseded).toEqual([]);
	});

	it('names the old blob when a version is overwritten with new bytes', async () => {
		const s = await member();
		const hash = randomAudioHash();
		const a = itemFor(s.userId, 'peaks', hash, { blobSeed: 'run 1' });
		const b = itemFor(s.userId, 'peaks', hash, { blobSeed: 'run 2' });
		await uploadFor(app, s, [a, b]);
		await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [a] });
		expect((await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [b] })).superseded).toEqual([blobOf(a)!.path]);
	});
});

describe('catalogue.inventory', () => {
	it('pages by rev with the account and the policy', async () => {
		const s = await member();
		const items = Array.from({ length: 5 }, () => itemFor(s.userId, 'key', randomAudioHash()));
		const put = await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items });
		const p1 = await s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: 0, limit: 3 });
		expect(p1.entries.map((e) => e.rev)).toEqual(put.accepted.slice(0, 3).map((a) => a.rev));
		expect(p1.more).toBe(true);
		expect(p1.nextRev).toBe(put.accepted[2]!.rev);
		expect(p1.account).toEqual({ entitled: true, quotaBytes: 943718400, usedBytes: expect.any(Number) });
		expect(p1.policy).toEqual(app.deps.catalogue);
		expect(p1.entries[0]).toEqual({ audioHash: items[0]!.audioHash, unit: 'key', variant: 'default', version: [2, 4, 0], unitSchema: 1, rev: put.accepted[0]!.rev, bytes: expect.any(Number), deviceId: s.deviceId });
		const p2 = await s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: p1.nextRev, limit: 3 });
		expect(p2.entries).toHaveLength(2);
		expect(p2.more).toBe(false);
		const p3 = await s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: p2.nextRev });
		expect(p3).toMatchObject({ entries: [], nextRev: p2.nextRev, more: false });
	});

	it('caps the page at 5000 rather than refusing', async () => {
		const s = await member();
		const r = await s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: 0, limit: MAX_CATALOGUE_INVENTORY * 10 });
		expect(r.entries).toEqual([]);
	});
});

describe('catalogue access', () => {
	it('lets an account without entitlement look up but not put', async () => {
		const s = await app.signIn();
		const hash = randomAudioHash();
		expect((await s.api.catalogue.lookup.mutate({ deviceId: s.deviceId, audioHashes: [hash], want: want() })).items).toEqual([]);
		expect((await s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: 0 })).account).toEqual({ entitled: false, quotaBytes: 0, usedBytes: 0 });
		expect(await errorReason(s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [itemFor(s.userId, 'key', hash)] }))).toMatchObject({
			code: 'FORBIDDEN',
			reason: 'catalogue_not_entitled',
		});
		await entitle(app.pg, s.userId, { entitled: false });
		expect(await errorReason(s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [itemFor(s.userId, 'key', hash)] }))).toMatchObject({ reason: 'catalogue_not_entitled' });
	});

	it('refuses an unregistered device and a revoked one, on every procedure', async () => {
		const s = await member();
		// Thunks, run one at a time, so the audit rows come out in this order.
		const calls = (deviceId: string) => [
			() => s.api.catalogue.lookup.mutate({ deviceId, audioHashes: [randomAudioHash()], want: want() }),
			() => s.api.catalogue.put.mutate({ deviceId, items: [itemFor(s.userId, 'key', randomAudioHash())] }),
			() => s.api.catalogue.inventory.query({ deviceId, afterRev: 0 }),
		];
		for (const call of calls('never-registered')) expect(await errorReason(call())).toMatchObject({ code: 'PRECONDITION_FAILED', reason: 'device_not_registered' });
		await s.api.account.revokeDevice.mutate({ deviceId: s.deviceId });
		for (const call of calls(s.deviceId)) expect(await errorReason(call())).toMatchObject({ code: 'FORBIDDEN', reason: 'device_revoked' });
		await app.audit.flush();
		const events = await app.pg.query<{ detail: { procedure: string; reason: string; via: string } }>(
			`select detail from curator.audit_event where user_id = $1 and kind = 'catalogue_rejected' order by id`,
			[s.userId],
		);
		// Its session acted as the revoked device, so the session is what
		// refuses first; a fresh sign-in naming the same device is refused by
		// the device itself.
		expect(events.rows.map((e) => e.detail)).toEqual([
			{ procedure: 'lookup', reason: 'device_revoked', via: 'session' },
			{ procedure: 'put', reason: 'device_revoked', via: 'session' },
			{ procedure: 'inventory', reason: 'device_revoked', via: 'session' },
		]);
		const fresh = app.client(await app.sign(s.userId, { sessionId: 'a later sign-in' }));
		expect(await errorReason(fresh.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: 0 }))).toMatchObject({ code: 'FORBIDDEN', reason: 'device_revoked' });
		await app.audit.flush();
		const last = await app.pg.query<{ detail: unknown }>(
			`select detail from curator.audit_event where user_id = $1 and kind = 'catalogue_rejected' order by id desc limit 1`,
			[s.userId],
		);
		expect(last.rows[0]!.detail).toEqual({ procedure: 'inventory', reason: 'device_revoked', via: 'device' });
	});

	it('answers catalogue_disabled on a server without a policy', async () => {
		const off = await createTestApp({ catalogue: null });
		try {
			const s = await member(off);
			expect(await errorReason(s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: 0 }))).toMatchObject({
				code: 'PRECONDITION_FAILED',
				reason: 'catalogue_disabled',
			});
			expect(await errorReason(s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [] }))).toMatchObject({ reason: 'catalogue_disabled' });
		} finally {
			await off.db.close();
		}
	});

	it('refuses an unsigned call', async () => {
		expect(await errorReason(app.client().catalogue.inventory.query({ deviceId: 'd', afterRev: 0 }))).toMatchObject({ code: 'UNAUTHORIZED' });
	});
});

describe('catalogue isolation between users', () => {
	it('never shows, overwrites or links to another user’s rows and blobs', async () => {
		const a = await member();
		const b = await member();
		const hash = randomAudioHash();
		const aItems = [itemFor(a.userId, 'key', hash), itemFor(a.userId, 'peaks', hash)];
		await uploadFor(app, a, aItems);
		expect((await a.api.catalogue.put.mutate({ deviceId: a.deviceId, items: aItems })).rejected).toEqual([]);

		// Rows: B sees nothing of A's under the same hash, in lookup or inventory.
		expect((await b.api.catalogue.lookup.mutate({ deviceId: b.deviceId, audioHashes: [hash], want: want() })).items).toEqual([]);
		expect((await b.api.catalogue.inventory.query({ deviceId: b.deviceId, afterRev: 0 })).entries).toEqual([]);

		// B's own put of the same key is B's row; A's stays as it was.
		const bKey = { ...itemFor(b.userId, 'key', hash), data: { camelot: '12B', strength: 0.1 } };
		expect((await b.api.catalogue.put.mutate({ deviceId: b.deviceId, items: [bKey] })).rejected).toEqual([]);
		const aLook = await a.api.catalogue.lookup.mutate({ deviceId: a.deviceId, audioHashes: [hash], want: [{ unit: 'key' }] });
		expect(aLook.items[0]!.data).toEqual(aItems[0]!.data);

		// Blobs: B cannot name A's object (wrong prefix), and the same sha under
		// B's own prefix is missing, because A's object is invisible to B.
		const aBlob = blobOf(aItems[1]!)!;
		const viaA = { ...aItems[1]!, data: { blob: aBlob, cpkVersion: 3 } };
		const viaOwn = { ...aItems[1]!, data: { blob: { ...aBlob, path: catalogueBlobPath(b.userId, 'peaks', aBlob.sha256) }, cpkVersion: 3 } };
		const r = await b.api.catalogue.put.mutate({ deviceId: b.deviceId, items: [viaA, viaOwn] });
		expect(r.rejected).toEqual([
			{ index: 0, reason: 'blob_path_invalid' },
			{ index: 1, reason: 'blob_missing' },
		]);
	});

	it('holds at the database too: RLS on catalogue_item and catalogue_account', async () => {
		const a = await member();
		const b = await member();
		await a.api.catalogue.put.mutate({ deviceId: a.deviceId, items: [itemFor(a.userId, 'key', randomAudioHash())] });
		await asUser(app.pg, b.userId, async (tx) => {
			expect((await tx.query(`select 1 from curator.catalogue_item where user_id = $1`, [a.userId])).rows).toEqual([]);
			expect((await tx.query(`select 1 from curator.catalogue_account where user_id = $1`, [a.userId])).rows).toEqual([]);
			expect((await tx.query(`update curator.catalogue_item set device_id = 'x' where user_id = $1 returning 1`, [a.userId])).rows).toEqual([]);
			expect((await tx.query(`delete from curator.catalogue_item where user_id = $1 returning 1`, [a.userId])).rows).toEqual([]);
		});
		await expect(
			asUser(app.pg, b.userId, (tx) =>
				tx.query(
					`insert into curator.catalogue_item (user_id, audio_hash, unit, variant, version, unit_schema, duration_sec, data, data_bytes, digest, device_id)
					values ($1, $2, 'key', 'default', '{2,4,0}', 1, 300, '{}', 2, $3, 'd')`,
					[a.userId, randomAudioHash(), sha('x')],
				),
			),
		).rejects.toThrow(/row-level security/);
		// A user cannot grant themselves an entitlement or more quota.
		await expect(asUser(app.pg, b.userId, (tx) => tx.query(`update curator.catalogue_account set quota_bytes = 1e12 where user_id = $1`, [b.userId]))).rejects.toThrow(
			/permission denied/,
		);
		const c = await app.signIn();
		await expect(asUser(app.pg, c.userId, (tx) => tx.query(`insert into curator.catalogue_account (user_id) values ($1)`, [c.userId]))).rejects.toThrow(/permission denied/);
	});

	it('refuses a direct insert for an account without entitlement', async () => {
		const c = await app.signIn();
		await expect(
			asUser(app.pg, c.userId, (tx) =>
				tx.query(
					`insert into curator.catalogue_item (audio_hash, unit, variant, version, unit_schema, duration_sec, data, data_bytes, digest, device_id)
					values ($1, 'key', 'default', '{2,4,0}', 1, 300, '{}', 2, $2, 'd')`,
					[randomAudioHash(), sha('y')],
				),
			),
		).rejects.toThrow(/row-level security/);
	});
});

describe('catalogue logging and limits', () => {
	it('logs item counts in request_log and rejections in audit_event', async () => {
		const s = await member();
		const hash = randomAudioHash();
		await s.api.catalogue.put.mutate({ deviceId: s.deviceId, items: [itemFor(s.userId, 'key', hash), itemFor(s.userId, 'vectors', hash), { junk: true }] });
		await s.api.catalogue.lookup.mutate({ deviceId: s.deviceId, audioHashes: [hash, randomAudioHash()], want: want() });
		await s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: 0 });
		await app.audit.flush();
		const rows = await app.pg.query<{ procedure: string; ops_in: number | null; ops_out: number | null; device_id: string; http_status: number }>(
			`select procedure, ops_in, ops_out, device_id, http_status from curator.request_log where user_id = $1 and procedure like 'catalogue.%' order by id`,
			[s.userId],
		);
		expect(rows.rows).toEqual([
			{ procedure: 'catalogue.put', ops_in: 3, ops_out: 1, device_id: s.deviceId, http_status: 200 },
			{ procedure: 'catalogue.lookup', ops_in: 2, ops_out: 1, device_id: s.deviceId, http_status: 200 },
			{ procedure: 'catalogue.inventory', ops_in: null, ops_out: 1, device_id: s.deviceId, http_status: 200 },
		]);
		const events = await app.pg.query<{ detail: unknown; device_id: string }>(
			`select detail, device_id from curator.audit_event where user_id = $1 and kind = 'catalogue_rejected'`,
			[s.userId],
		);
		expect(events.rows).toEqual([{ detail: { procedure: 'put', byReason: { invalid_item: 1, unit_disabled: 1 } }, device_id: s.deviceId }]);
	});

	it('rate-limits per user and device in its own bucket', async () => {
		const limited = await createTestApp({
			limits: { push: new TokenBucketLimiter(1e9, 1e9), pull: new TokenBucketLimiter(1e9, 1e9), catalogue: new TokenBucketLimiter(2, 0.001) },
		});
		try {
			const s = await member(limited);
			const inv = () => s.api.catalogue.inventory.query({ deviceId: s.deviceId, afterRev: 0 });
			await inv();
			await inv();
			expect(await errorReason(inv())).toMatchObject({ code: 'TOO_MANY_REQUESTS', reason: 'rate_limited' });
			// Sync is not throttled by it.
			await expect(s.api.sync.push.mutate({ deviceId: s.deviceId, ops: [] })).resolves.toMatchObject({ accepted: 0 });
			// Another device of the same user has its own bucket.
			await s.api.account.registerDevice.mutate({ deviceId: 'second', name: 'Laptop', platform: 'darwin' });
			await expect(s.api.catalogue.inventory.query({ deviceId: 'second', afterRev: 0 })).resolves.toMatchObject({ entries: [] });
		} finally {
			await limited.db.close();
		}
	});
});

describe('catalogue schema', () => {
	const sql = readFileSync(join(findSqlDir(), '0004_catalogue.sql'), 'utf8');

	it('checks audio hashes with the protocol’s exact pattern', () => {
		expect(sql).toContain(`audio_hash ~ '${AUDIO_HASH_RE.source}'`);
	});

	it('refuses keys the protocol would refuse, even from the owner', async () => {
		const u = await member();
		const bad = (cols: Record<string, string>) =>
			app.pg.query(
				`insert into curator.catalogue_item (user_id, audio_hash, unit, variant, version, unit_schema, duration_sec, data, data_bytes, digest, device_id)
				values ($1, $2, $3, $4, $5::int[], 1, 300, '{}', 2, $6, 'd')`,
				[u.userId, cols.hash ?? randomAudioHash(), cols.unit ?? 'key', cols.variant ?? 'default', cols.version ?? '{2,4,0}', cols.digest ?? sha('z')],
			);
		await expect(bad({ hash: 'md5:abc' })).rejects.toThrow(/check constraint/);
		await expect(bad({ unit: 'tempo' })).rejects.toThrow(/check constraint/);
		await expect(bad({ variant: 'Default' })).rejects.toThrow(/check constraint/);
		await expect(bad({ version: '{}' })).rejects.toThrow(/check constraint/);
		await expect(bad({ version: '{1,null}' })).rejects.toThrow(/check constraint/);
		await expect(bad({ version: '{70000}' })).rejects.toThrow(/check constraint/);
		await expect(bad({ digest: 'nope' })).rejects.toThrow(/check constraint/);
		await expect(bad({})).resolves.toBeDefined();
	});
});
