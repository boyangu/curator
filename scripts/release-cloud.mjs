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

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, releaseKit, repoRoot } from './release-common.mjs';

const TAG_RE = /^cloud-v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const APP_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HEALTH_TIMEOUT_MS = 180_000;

const { fail, step, run, verifyTag, exportCommit } = releaseKit('release-cloud');

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
	const sha = verifyTag(tag);

	const flyEnv = { ...process.env, FLY_API_TOKEN: token };
	// JSON, not the table: the table's box-drawing borders and colours make
	// line matching unreliable.
	let secretNames;
	try {
		const raw = run(flyctl, ['secrets', 'list', '--app', app, '--json'], { capture: true, env: flyEnv }).stdout;
		secretNames = new Set(JSON.parse(raw).map((s) => s.name ?? s.Name));
	} catch (e) {
		fail(`could not read the Fly secrets of ${app}: ${e instanceof Error ? e.message : e}`);
	}
	for (const name of ['DATABASE_URL', 'SUPABASE_URL']) if (!secretNames.has(name)) fail(`Fly secret ${name} is not set on ${app} (apps/cloud/README.md, "Database setup")`);

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
