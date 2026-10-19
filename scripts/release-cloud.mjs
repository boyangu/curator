#!/usr/bin/env node
// Releases the cloud API to Fly.io from this machine.
//
//   pnpm release:cloud cloud-v0.1.0
//
// Production deploys run from the maintainer's machine only: GitHub holds no
// credential for, and no access to, the production environment. What made a
// CI deploy trustworthy is enforced here instead:
//   - only a pushed `cloud-vX.Y.Z` tag whose commit is on origin/main ships,
//     so every running image maps to a public, reviewed commit;
//   - the image is built from `git archive` of that commit in a temporary
//     directory, never from the working tree, so uncommitted edits, `.env`,
//     the live library database and private files cannot reach the build;
//   - the same install / typecheck / test / build as CI runs on that export;
//   - the deploy passes GIT_SHA, and the release only counts once
//     /trpc/health reports that commit.
//
// Configuration comes from the git-ignored root `.env` (or the shell):
//   CURATOR_FLY_TOKEN  a Fly deploy token for the app (`fly tokens create deploy`)
//   CURATOR_FLY_APP    the Fly app name
// The token is handed to flyctl through its own environment only; it is never
// printed or written anywhere.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG_RE = /^cloud-v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const APP_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HEALTH_TIMEOUT_MS = 180_000;

function fail(msg) {
	console.error(`release-cloud: ${msg}`);
	process.exit(1);
}

function step(msg) {
	console.log(`\n== ${msg}`);
}

// A minimal .env reader: KEY=value per line, `#` comments, optional quotes,
// whitespace around `=` tolerated. The shell wins over the file.
function loadDotEnv(path) {
	const out = {};
	if (!existsSync(path)) return out;
	for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		out[key] = value;
	}
	return out;
}

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { cwd: opts.cwd ?? repoRoot, env: opts.env ?? process.env, stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8', shell: opts.shell ?? false });
	if (r.error) fail(`${cmd} could not start: ${r.error.message}`);
	if (r.status !== 0 && !opts.allowFail) fail(`${cmd} ${args.join(' ')} exited ${r.status}${opts.capture ? `\n${r.stderr}` : ''}`);
	return r;
}

function git(args, opts = {}) {
	return run('git', args, { capture: true, ...opts }).stdout.trim();
}

function findFlyctl() {
	const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['flyctl'], { encoding: 'utf8' });
	if (probe.status === 0) return 'flyctl';
	// The installer adds ~/.fly/bin to PATH, but a terminal opened before the
	// install does not see it yet.
	const local = join(homedir(), '.fly', 'bin', process.platform === 'win32' ? 'flyctl.exe' : 'flyctl');
	if (existsSync(local)) return local;
	fail('flyctl not found: install it from https://fly.io/docs/flyctl/install/');
}

async function waitForCommit(app, sha) {
	const url = `https://${app}.fly.dev/trpc/health`;
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	let last = 'no response';
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
			const body = await res.json();
			const commit = body?.result?.data?.commit;
			if (commit === sha) return;
			last = `HTTP ${res.status}, commit ${commit ?? 'missing'}`;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
		}
		await new Promise((r) => setTimeout(r, 10_000));
	}
	fail(`${url} did not report ${sha} within ${HEALTH_TIMEOUT_MS / 1000} s (last: ${last})`);
}

async function exportCommit(sha, dir) {
	// git archive | tar -x: the tracked tree of exactly that commit, nothing else.
	await new Promise((resolve, reject) => {
		const archive = spawn('git', ['archive', '--format=tar', sha], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
		const untar = spawn('tar', ['-xf', '-', '-C', dir], { stdio: ['pipe', 'inherit', 'inherit'] });
		archive.stdout.pipe(untar.stdin);
		let pending = 2;
		const done = (name) => (code) => {
			if (code !== 0) reject(new Error(`${name} exited ${code}`));
			else if (--pending === 0) resolve();
		};
		archive.on('error', reject).on('close', done('git archive'));
		untar.on('error', reject).on('close', done('tar'));
	});
}

async function main() {
	const tag = process.argv[2];
	if (!tag || !TAG_RE.test(tag)) fail('usage: pnpm release:cloud cloud-vX.Y.Z (the tag must already be pushed to origin)');

	const env = { ...loadDotEnv(join(repoRoot, '.env')), ...process.env };
	const token = env.CURATOR_FLY_TOKEN?.trim();
	const app = env.CURATOR_FLY_APP?.trim();
	if (!token) fail('CURATOR_FLY_TOKEN is not set (root .env or shell)');
	if (!app || !APP_RE.test(app)) fail('CURATOR_FLY_APP is not set to a Fly app name (root .env or shell)');
	const flyctl = findFlyctl();

	step(`verify ${tag}`);
	// The tag as origin has it is what ships: a local tag that was never
	// pushed, or moved, does not count.
	const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	if (!remote) fail(`${tag} is not on origin; push it first (git push origin ${tag})`);
	const lines = remote.split('\n').map((l) => l.split('\t'));
	const peeled = lines.find(([, ref]) => ref.endsWith('^{}')) ?? lines[0];
	const sha = peeled[0];
	git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
	if (run('git', ['cat-file', '-e', `${sha}^{commit}`], { capture: true, allowFail: true }).status !== 0) git(['fetch', '--quiet', 'origin', sha]);
	if (run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { capture: true, allowFail: true }).status !== 0) fail(`${tag} (${sha}) is not on origin/main`);
	console.log(`${tag} -> ${sha}, on origin/main`);

	const flyEnv = { ...process.env, FLY_API_TOKEN: token };
	const secrets = run(flyctl, ['secrets', 'list', '--app', app], { capture: true, env: flyEnv }).stdout;
	for (const name of ['DATABASE_URL', 'SUPABASE_URL']) if (!new RegExp(`^\\s*${name}\\b`, 'm').test(secrets)) fail(`Fly secret ${name} is not set on ${app} (apps/cloud/README.md, "Database setup")`);

	const dir = mkdtempSync(join(tmpdir(), 'curator-release-'));
	try {
		step(`export ${sha.slice(0, 7)} to ${dir}`);
		await exportCommit(sha, dir);
		if (/primary_region\s*=\s*"<region>"/.test(readFileSync(join(dir, 'apps/cloud/fly.toml'), 'utf8'))) fail('primary_region in apps/cloud/fly.toml is still a placeholder at this commit');

		step('install, typecheck, test, build (the CI cloud job)');
		const buildEnv = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', CURATOR_FLY_TOKEN: '' };
		const pnpm = { cwd: dir, env: buildEnv, shell: process.platform === 'win32' };
		run('pnpm', ['install', '--frozen-lockfile', '--filter', '@curator/cloud...'], pnpm);
		run('pnpm', ['--filter', '@curator/cloud', 'typecheck'], pnpm);
		run('pnpm', ['--filter', '@curator/cloud', 'test'], pnpm);
		run('pnpm', ['--filter', '@curator/cloud', 'build'], pnpm);
		// The remote builder gets the export's tree, filtered again by .dockerignore;
		// node_modules from the checks above is excluded there.

		step(`deploy ${tag} to ${app}`);
		run(flyctl, ['deploy', dir, '--app', app, '--config', join(dir, 'apps/cloud/fly.toml'), '--dockerfile', join(dir, 'Dockerfile'), '--remote-only', '--build-arg', `GIT_SHA=${sha}`, '--image-label', tag], { cwd: dir, env: flyEnv });

		step('wait for /trpc/health to report the commit');
		await waitForCommit(app, sha);
		console.log(`\nreleased ${tag} (${sha}) to https://${app}.fly.dev`);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			console.warn(`release-cloud: could not remove ${dir}`);
		}
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
