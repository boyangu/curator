// The Postgres driver for the scripts that open the cloud's database
// themselves (cloud-db-apply, cloud-catalog-push, cloud-export-ops,
// cloud-logs, rotate-cloud-db-password), connecting by the rule the cloud's
// own code connects with: TLS, verified against Supabase's roots, to any host
// but this machine (apps/cloud/src/db/tls.ts). One copy of that rule and of
// the certificates: this loads the TypeScript file through tsx, which
// apps/cloud already carries for its CLIs.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cloudDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'cloud');

/** postgres.js (it lives in apps/cloud, not at the repo root), called as `postgres(url, options)`. */
export async function loadPostgres() {
	const require = createRequire(join(cloudDir, 'package.json'));
	const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
	const postgres = (await load('postgres')).default;
	const { tsImport } = await load('tsx/esm/api');
	const { tlsOptions } = await tsImport(pathToFileURL(join(cloudDir, 'src', 'db', 'tls.ts')).href, import.meta.url);
	return (url, options = {}) => postgres(url, { ...options, ...tlsOptions(url) });
}

/**
 * What Postgres stores for a password (RFC 5802; the form psql's \password
 * sends). `alter role … password '<this>'` sets the password without the
 * password being in the statement, and so in any statement log on the server.
 * `password` must be plain ASCII: no SASLprep is applied here.
 */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
	const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
	const hmac = (label) => createHmac('sha256', salted).update(label).digest();
	const storedKey = createHash('sha256').update(hmac('Client Key')).digest();
	return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${hmac('Server Key').toString('base64')}`;
}
