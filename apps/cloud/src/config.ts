// Configuration comes from the environment only, so the image is the same in
// every deployment and no value ever lives in the repo (`.env.example` holds
// placeholders). Read once at startup: a missing or malformed value fails the
// boot loudly instead of surfacing as a 500 on the first request.

import type { CataloguePolicy } from '@curator/protocol';
import { CataloguePolicyError, parseCataloguePolicy } from './catalogue/policy.js';
import { assertConnectionString } from './db/db.js';

export type Config = {
	databaseUrl: string;
	// Without a trailing slash; the issuer and the JWKS URL derive from it.
	supabaseUrl: string;
	port: number;
	// CURATOR_CATALOGUE (src/catalogue/policy.ts): the catalogue units this
	// server accepts, or null when the catalogue is off. Not a secret: it
	// lives in fly.toml [env], so the stage (D-a / D-b) is versioned with the
	// code.
	catalogue: CataloguePolicy | null;
	// CURATOR_REQUIRE_DEVICE_ID=1: sync.pull and sync.bootstrap without a
	// device id are refused `update_required` instead of served. Off while
	// desktops from before 'device_reads' are in use; switched on once every
	// install has updated, which closes the last read path a revoked device
	// whose session the server never bound could still use (README
	// "Revoking a device").
	requireDeviceId: boolean;
};

export class ConfigError extends Error {
	override readonly name = 'ConfigError';
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const v = env[name]?.trim();
	if (!v) throw new ConfigError(`${name} is not set (see apps/cloud/.env.example)`);
	return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const databaseUrl = required(env, 'DATABASE_URL');
	try {
		assertConnectionString(databaseUrl);
	} catch (e) {
		throw new ConfigError(`DATABASE_URL: ${e instanceof Error ? e.message : 'invalid'}`);
	}
	const supabaseUrl = required(env, 'SUPABASE_URL').replace(/\/+$/, '');
	let parsed: URL;
	try {
		parsed = new URL(supabaseUrl);
	} catch {
		throw new ConfigError(`SUPABASE_URL is not a URL: ${supabaseUrl}`);
	}
	// The signing keys are fetched from here; plain http would let anyone on
	// the path swap them. Loopback stays allowed for a local Supabase stack.
	if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
		throw new ConfigError('SUPABASE_URL must be https');
	}
	const port = Number(env.PORT ?? 8080);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError(`PORT is not a port: ${env.PORT}`);
	let catalogue: CataloguePolicy | null;
	try {
		catalogue = parseCataloguePolicy(env.CURATOR_CATALOGUE);
	} catch (e) {
		if (e instanceof CataloguePolicyError) throw new ConfigError(e.message);
		throw e;
	}
	const flag = env.CURATOR_REQUIRE_DEVICE_ID?.trim().toLowerCase() ?? '';
	if (!['', '0', '1', 'false', 'true'].includes(flag)) throw new ConfigError(`CURATOR_REQUIRE_DEVICE_ID must be 0 or 1, not ${env.CURATOR_REQUIRE_DEVICE_ID}`);
	const requireDeviceId = flag === '1' || flag === 'true';
	return { databaseUrl, supabaseUrl, port, catalogue, requireDeviceId };
}
