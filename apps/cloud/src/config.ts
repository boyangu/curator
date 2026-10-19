// Configuration comes from the environment only, so the image is the same in
// every deployment and no value ever lives in the repo (`.env.example` holds
// placeholders). Read once at startup: a missing or malformed value fails the
// boot loudly instead of surfacing as a 500 on the first request.

export type Config = {
	databaseUrl: string;
	// Without a trailing slash; the issuer and the JWKS URL derive from it.
	supabaseUrl: string;
	port: number;
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
	return { databaseUrl, supabaseUrl, port };
}
