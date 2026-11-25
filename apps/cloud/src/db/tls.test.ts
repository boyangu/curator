// The TLS rule for Postgres connections (tls.ts): which hosts it covers, that
// a connection string cannot switch it off, and that the roots it adds are
// exactly the one Supabase's dashboard hands out.

import { X509Certificate } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { isLocalDatabase, SUPABASE_ROOTS, tlsOptions } from './tls.js';

const POOLER = 'postgresql://curator_api.ref:pw@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres';

describe('tlsOptions', () => {
	it('leaves a database on this machine to its connection string', () => {
		for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) {
			const url = `postgres://u:pw@${host}:5432/db`;
			expect(isLocalDatabase(url)).toBe(true);
			expect(tlsOptions(url)).toEqual({});
		}
	});

	it('verifies every other host, a look-alike of localhost included', () => {
		for (const url of [POOLER, 'postgres://u:pw@db.ref.supabase.co/postgres', 'postgres://u:pw@127.0.0.1.example.com/db', 'postgres://u:pw@10.0.0.5/db']) {
			expect(isLocalDatabase(url)).toBe(false);
			const { ssl } = tlsOptions(url);
			expect(ssl?.rejectUnauthorized).toBe(true);
			for (const root of SUPABASE_ROOTS) expect(ssl?.ca).toContain(root);
		}
	});

	it('outranks the sslmode a connection string asks for', () => {
		// No connection is made: postgres.js connects lazily.
		for (const mode of ['disable', 'prefer', 'require']) {
			const url = `${POOLER}?sslmode=${mode}`;
			const sql = postgres(url, { prepare: false, ...tlsOptions(url) });
			expect(sql.options.ssl).toMatchObject({ rejectUnauthorized: true });
			void sql.end({ timeout: 0 });
		}
	});
});

describe('the bundled Supabase roots', () => {
	it('are the prod-ca-2021.crt of the dashboard alone', () => {
		const roots = SUPABASE_ROOTS.map((pem) => new X509Certificate(pem));
		expect(roots.map((r) => r.fingerprint256)).toEqual([
			'80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
		]);
		for (const r of roots) {
			expect(r.ca).toBe(true);
			expect(r.subject).toContain('CN=Supabase Root 2021 CA');
		}
	});
});
