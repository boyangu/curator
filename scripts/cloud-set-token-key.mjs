#!/usr/bin/env node
// Sets the Spotify gateway's secrets on the Fly app (apps/cloud/README.md,
// "Spotify gateway"):
//
//   pnpm cloud:set-token-key            # first time: a new CURATOR_TOKEN_KEY
//   pnpm cloud:set-token-key --rotate   # a new key; the current one becomes CURATOR_TOKEN_KEY_PREV
//
// CURATOR_TOKEN_KEY seals the Spotify refresh and access tokens the cloud
// keeps (AES-256-GCM, apps/cloud/src/spotify/crypto.ts). It is generated here
// (32 random bytes) and goes straight to Fly: it is never printed, never on a
// command line, never in a file, and nobody needs to know it. Losing it costs
// every user one Spotify reconnect, nothing more, so there is no copy to keep.
// CURATOR_SPOTIFY_CLIENT_ID (the Spotify app's client id) is copied from the
// root .env alongside it.
//
// Both go in through `flyctl secrets import --stage`, NAME=VALUE lines on its
// stdin; staged secrets take effect on the next release (or `flyctl secrets
// deploy`). Configuration, like scripts/release-cloud.mjs, from the
// git-ignored root .env (or the shell):
//   CURATOR_FLY_TOKEN           a Fly token for the app
//   CURATOR_FLY_APP             the Fly app name
//   CURATOR_SPOTIFY_CLIENT_ID   the Spotify app's client id
//
// An existing CURATOR_TOKEN_KEY is never replaced without --rotate: the
// tokens already sealed under it would be unreadable. --rotate reads the
// current key from a running machine (`flyctl ssh console`, captured, never
// shown) and sets it as CURATOR_TOKEN_KEY_PREV, so sealed rows still open; each
// grant moves to the new key on its next refresh. A PREV from an earlier
// rotation is dropped, so rotate again only after every active grant has
// refreshed (an hour of use); a grant idle across two rotations needs a
// reconnect.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
// What apps/cloud/src/spotify/crypto.ts accepts.
const KEY_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const rotate = process.argv.includes('--rotate');

function fail(msg) {
	console.error(`cloud-set-token-key: ${msg}`);
	process.exit(1);
}

// The same reader as release-cloud.mjs: KEY=value, `#` comments, optional
// quotes. The shell wins over the file.
function loadDotEnv(path) {
	const out = {};
	if (!existsSync(path)) return out;
	for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		out[line.slice(0, eq).trim()] = value;
	}
	return out;
}

function findFlyctl() {
	const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['flyctl'], { encoding: 'utf8' });
	if (probe.status === 0) return 'flyctl';
	const local = join(homedir(), '.fly', 'bin', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
	if (existsSync(local)) return local;
	fail('flyctl not found: install it from https://fly.io/docs/flyctl/install/');
}

// Captured output never reaches the screen: on failure only flyctl's stderr
// is shown, which carries no secret value (none is ever on its command line).
function fly(flyctl, args, env, opts = {}) {
	const r = spawnSync(flyctl, args, { env, encoding: 'utf8', input: opts.input, stdio: [opts.input === undefined ? 'ignore' : 'pipe', opts.capture ? 'pipe' : 'inherit', 'pipe'] });
	if (r.error) fail(`flyctl could not start: ${r.error.message}`);
	if (r.status !== 0) fail(`flyctl ${args.slice(0, 2).join(' ')} exited ${r.status}\n${(r.stderr ?? '').trim()}`);
	return r;
}

function decodedLength(b64) {
	return Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length;
}

function main() {
	const env = { ...loadDotEnv(join(repoRoot, '.env')), ...process.env };
	const token = env.CURATOR_FLY_TOKEN?.trim();
	const app = env.CURATOR_FLY_APP?.trim();
	const clientId = env.CURATOR_SPOTIFY_CLIENT_ID?.trim();
	if (!token) fail('CURATOR_FLY_TOKEN is not set (root .env or shell)');
	if (!app || !APP_RE.test(app)) fail('CURATOR_FLY_APP is not set to a Fly app name (root .env or shell)');
	// The server refuses to boot on anything else (apps/cloud/src/config.ts).
	if (!clientId || !/^[0-9a-f]{32}$/i.test(clientId)) fail('CURATOR_SPOTIFY_CLIENT_ID is not set to a Spotify client id (32 hex characters) in the root .env');
	const flyctl = findFlyctl();
	const flyEnv = { ...process.env, FLY_API_TOKEN: token };

	// Names only: flyctl never shows a secret's value, and this list is all
	// that is read from it.
	let secrets;
	try {
		secrets = JSON.parse(fly(flyctl, ['secrets', 'list', '--app', app, '--json'], flyEnv, { capture: true }).stdout);
	} catch (e) {
		fail(`could not read the Fly secrets of ${app}: ${e instanceof Error ? e.message : e}`);
	}
	const byName = new Map(secrets.map((s) => [s.name ?? s.Name, s]));
	const existing = byName.get('CURATOR_TOKEN_KEY');
	if (existing && !rotate) fail(`CURATOR_TOKEN_KEY is already set on ${app}. Replacing it would make every sealed Spotify grant unreadable; pass --rotate to keep the current one as CURATOR_TOKEN_KEY_PREV.`);
	if (!existing && rotate) fail(`CURATOR_TOKEN_KEY is not set on ${app} yet: run without --rotate first.`);

	const lines = [];
	if (rotate) {
		// A staged key is not on the machines yet, so the one read below would
		// not be it, and the staged one would be lost.
		const status = String(existing.status ?? existing.Status ?? '');
		if (/stag/i.test(status)) fail('CURATOR_TOKEN_KEY has a staged value that is not deployed yet; release (or `flyctl secrets deploy`) first, then rotate.');
		const r = fly(flyctl, ['ssh', 'console', '--app', app, '--quiet', '-C', 'printenv CURATOR_TOKEN_KEY'], flyEnv, { capture: true });
		const current = (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
		if (!KEY_RE.test(current) || decodedLength(current) !== 32) fail(`could not read the current CURATOR_TOKEN_KEY from a running machine of ${app} (is one running?); nothing was changed.`);
		if (byName.has('CURATOR_TOKEN_KEY_PREV')) console.log('The previous CURATOR_TOKEN_KEY_PREV is dropped: grants still sealed under it will need a reconnect.');
		lines.push(`CURATOR_TOKEN_KEY_PREV=${current}`);
	}
	lines.push(`CURATOR_TOKEN_KEY=${randomBytes(32).toString('base64')}`);
	lines.push(`CURATOR_SPOTIFY_CLIENT_ID=${clientId}`);

	fly(flyctl, ['secrets', 'import', '--app', app, '--stage'], flyEnv, { input: lines.join('\n') + '\n', capture: true });
	const names = lines.map((l) => l.slice(0, l.indexOf('=')));
	console.log(`Staged on ${app}: ${names.join(', ')} (values not shown).`);
	console.log(`They take effect on the next release (pnpm release:cloud <tag>) or now with: flyctl secrets deploy --app ${app}`);
	console.log('Check after: the boot line `spotify_gateway` in `flyctl logs` shows enabled: true and the key ids, and /trpc/health lists spotify_gateway.');
}

main();
