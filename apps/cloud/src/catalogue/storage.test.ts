// sql/storage.sql: the `catalogue` bucket and its policies on storage.objects,
// judged the way Supabase's storage service has them judged (an insert,
// select or delete on storage.objects as `authenticated` with the caller's
// claims). The service's own byte and MIME limits live in the service and
// cannot be exercised here; the bucket row that configures them is checked.

import { catalogueBlobPath } from '@curator/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha } from '../test/catalogue-fixtures.js';
import { asUser, createTestDb, entitle, STORAGE_SQL, uploadBlob, type TestDb } from '../test/harness.js';

let t: TestDb;
beforeAll(async () => {
	t = await createTestDb();
	// Re-runnable by design (the harness already ran it once).
	await t.db.exec(STORAGE_SQL);
});
afterAll(() => t.db.close());

const peaks = (uid: string, seed: string) => catalogueBlobPath(uid, 'peaks', sha(seed));
const DENIED = /row-level security/;

async function entitledUser(quotaBytes?: number): Promise<string> {
	const id = await t.createUser();
	await entitle(t.pg, id, { quotaBytes });
	return id;
}

const visible = (uid: string) =>
	asUser(t.pg, uid, async (tx) => (await tx.query<{ name: string }>(`select name from storage.objects where bucket_id = 'catalogue' order by name`)).rows.map((r) => r.name));

describe('catalogue bucket', () => {
	it('is private, 16 MiB, octet-stream only, and exists once after two runs', async () => {
		const r = await t.pg.query(`select id, public, file_size_limit::float8 as limit, allowed_mime_types from storage.buckets`);
		expect(r.rows).toEqual([{ id: 'catalogue', public: false, limit: 16 * 1024 * 1024, allowed_mime_types: ['application/octet-stream'] }]);
	});

	it('has exactly select, insert and delete policies: no update', async () => {
		const r = await t.pg.query<{ policyname: string; cmd: string; roles: string }>(
			`select policyname, cmd, roles::text as roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname`,
		);
		expect(r.rows).toEqual([
			{ policyname: 'curator_catalogue_delete', cmd: 'DELETE', roles: '{authenticated}' },
			{ policyname: 'curator_catalogue_insert', cmd: 'INSERT', roles: '{authenticated}' },
			{ policyname: 'curator_catalogue_select', cmd: 'SELECT', roles: '{authenticated}' },
		]);
	});
});

describe('catalogue storage policies', () => {
	it('let an entitled user upload, read and delete under their own prefix', async () => {
		const a = await entitledUser();
		const path = peaks(a, 'own');
		const vec = catalogueBlobPath(a, 'vectors', sha('own vec'));
		await uploadBlob(t.pg, a, path, 1000);
		await uploadBlob(t.pg, a, vec, 2000);
		expect(await visible(a)).toEqual([path, vec].sort());
		const deleted = await asUser(t.pg, a, (tx) => tx.query(`delete from storage.objects where name = $1 returning name`, [path]));
		expect(deleted.rows).toEqual([{ name: path }]);
		expect(await visible(a)).toEqual([vec]);
	});

	it('keep users out of each other’s prefixes: no read, write or delete', async () => {
		const a = await entitledUser();
		const b = await entitledUser();
		const path = peaks(a, 'a only');
		await uploadBlob(t.pg, a, path, 1000);
		expect(await visible(b)).toEqual([]);
		await expect(uploadBlob(t.pg, b, peaks(a, 'planted by b'), 10)).rejects.toThrow(DENIED);
		const del = await asUser(t.pg, b, (tx) => tx.query(`delete from storage.objects where name = $1 returning name`, [path]));
		expect(del.rows).toEqual([]);
		expect(await visible(a)).toEqual([path]);
	});

	it('accept only the content-addressed layout', async () => {
		const a = await entitledUser();
		for (const name of [
			`${a}/peaks/${sha('x').toUpperCase()}.cpk`,
			`${a}/peaks/${sha('x')}.cvec`,
			`${a}/vec/${sha('x')}.cpk`,
			`${a}/peaks/${sha('x')}.cpk/extra`,
			`${a}/other/${sha('x')}.cpk`,
			`${a}/${sha('x')}.cpk`,
			`shared/peaks/${sha('x')}.cpk`,
		]) {
			await expect(uploadBlob(t.pg, a, name, 10), name).rejects.toThrow(DENIED);
		}
	});

	it('refuse uploads without an entitlement, or once it is withdrawn', async () => {
		const c = await t.createUser();
		await expect(uploadBlob(t.pg, c, peaks(c, 'no account'), 10)).rejects.toThrow(DENIED);
		await entitle(t.pg, c, { entitled: false });
		await expect(uploadBlob(t.pg, c, peaks(c, 'withdrawn'), 10)).rejects.toThrow(DENIED);
		await entitle(t.pg, c, { entitled: true });
		await expect(uploadBlob(t.pg, c, peaks(c, 'restored'), 10)).resolves.toBeUndefined();
	});

	it('refuse uploads once the account’s objects reach its quota', async () => {
		const q = await entitledUser(3000);
		await uploadBlob(t.pg, q, peaks(q, 'q1'), 2000);
		// Still under: allowed, and it takes the account past the line.
		await uploadBlob(t.pg, q, peaks(q, 'q2'), 2000);
		await expect(uploadBlob(t.pg, q, peaks(q, 'q3'), 10)).rejects.toThrow(DENIED);
		// Deleting makes room again.
		await asUser(t.pg, q, (tx) => tx.query(`delete from storage.objects where name = $1`, [peaks(q, 'q2')]));
		await expect(uploadBlob(t.pg, q, peaks(q, 'q3'), 10)).resolves.toBeUndefined();
	});

	it('have no update path: objects are immutable', async () => {
		const a = await entitledUser();
		const path = peaks(a, 'immutable');
		await uploadBlob(t.pg, a, path, 1000);
		const r = await asUser(t.pg, a, (tx) => tx.query(`update storage.objects set metadata = '{"size": 1}' where name = $1 returning name`, [path]));
		expect(r.rows).toEqual([]);
		const size = await t.pg.query<{ s: string }>(`select metadata ->> 'size' as s from storage.objects where name = $1`, [path]);
		expect(size.rows).toEqual([{ s: '1000' }]);
	});

	it('give anon nothing', async () => {
		const a = await entitledUser();
		await uploadBlob(t.pg, a, peaks(a, 'anon probe'), 10);
		const asAnon = <T>(sql: string, params: string[] = []) =>
			t.pg.transaction(async (tx) => {
				await tx.query(`select set_config('role', 'anon', true)`);
				return tx.query<T>(sql, params);
			});
		expect((await asAnon(`select name from storage.objects`)).rows).toEqual([]);
		await expect(asAnon(`insert into storage.objects (bucket_id, name) values ('catalogue', $1)`, [peaks(a, 'anon')])).rejects.toThrow(DENIED);
		await expect(asAnon(`select curator.catalogue_upload_allowed()`)).rejects.toThrow(/permission denied/);
	});

	it('answer catalogue_entitled() for the caller alone', async () => {
		const a = await entitledUser();
		const c = await t.createUser();
		const ask = async (uid: string) => (await asUser(t.pg, uid, (tx) => tx.query<{ e: boolean }>(`select curator.catalogue_entitled() as e`))).rows[0]!.e;
		expect(await ask(a)).toBe(true);
		expect(await ask(c)).toBe(false);
	});
});
