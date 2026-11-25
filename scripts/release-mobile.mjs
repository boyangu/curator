#!/usr/bin/env node
// Releases the Android app from this machine, as a GitHub release the
// installed apps update from (apps/mobile/.../update/Updater.kt).
//
//   pnpm release:mobile mobile-v0.2.0
//
// As with the cloud (release-common.mjs): only a pushed `mobile-vX.Y.Z` tag
// whose commit is on origin/main ships, built from a `git archive` export of
// that commit, after the same gate as CI's mobile job (apps/mobile/scripts/
// check.mjs). GitHub never holds the signing key: the build is signed here,
// and the script checks the APK was signed with the release key and carries
// the tag's version before it publishes anything.
//
// The release carries the APK and an update.json naming it (version, version
// code, SHA-256, size, commit); the apps read the repo's public release list,
// so the repo must be public.
//
// Configuration comes from the git-ignored root `.env` (or the shell):
//   CURATOR_MOBILE_KEYSTORE           the release keystore (PKCS12), kept off GitHub
//   CURATOR_MOBILE_KEYSTORE_PASSWORD  its password
//   CURATOR_MOBILE_KEY_ALIAS          the key's alias (default: curator)
//   CURATOR_MOBILE_UPDATE_REPO        owner/name of the repo the releases go to
//   CURATOR_SPOTIFY_CLIENT_ID, CURATOR_CLOUD_API_URL, CURATOR_SUPABASE_URL,
//   CURATOR_SUPABASE_PUBLISHABLE_KEY  baked into the build, as for the desktop
// The password reaches Gradle and keytool through their environment only;
// it is never printed or passed on a command line.

import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDotEnv, releaseKit, repoRoot } from './release-common.mjs';

const TAG_RE = /^mobile-v(\d+)\.(\d+)\.(\d+)$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PACKAGE = 'app.curator.mobile';

const { fail, step, run, git, verifyTag, exportCommit } = releaseKit('release-mobile');

// The SDK's newest build-tools, for apksigner and aapt2.
function buildTools(sdk) {
	const dir = join(sdk, 'build-tools');
	const versions = existsSync(dir) ? readdirSync(dir).filter((v) => /^\d/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) : [];
	if (!versions.length) fail(`no build-tools under ${dir}`);
	const at = join(dir, versions.at(-1));
	const win = process.platform === 'win32';
	return { apksigner: join(at, win ? 'apksigner.bat' : 'apksigner'), aapt2: join(at, win ? 'aapt2.exe' : 'aapt2') };
}

// The release key's certificate SHA-256 (hex, lower case), and its SHA-1 for Spotify's dashboard.
function keyFingerprints(keytool, keystore, alias, env) {
	const out = run(keytool, ['-list', '-v', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', alias, '-storepass:env', 'CURATOR_MOBILE_KEYSTORE_PASSWORD'], { capture: true, env }).stdout;
	const fp = (name) => out.match(new RegExp(`${name}:\\s*([0-9A-F:]+)`))?.[1];
	const sha256 = fp('SHA256');
	if (!sha256) fail(`keytool printed no SHA256 for ${alias} in ${keystore}`);
	return { sha256: sha256.replace(/:/g, '').toLowerCase(), sha1: fp('SHA1') };
}

async function main() {
	const tag = process.argv[2];
	const m = tag && TAG_RE.exec(tag);
	if (!m) fail('usage: pnpm release:mobile mobile-vX.Y.Z (the tag must already be pushed to origin)');
	const version = `${m[1]}.${m[2]}.${m[3]}`;
	const versionCode = Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);

	const env = { ...loadDotEnv(), ...process.env };
	const keystore = env.CURATOR_MOBILE_KEYSTORE?.trim();
	const alias = env.CURATOR_MOBILE_KEY_ALIAS?.trim() || 'curator';
	const repo = env.CURATOR_MOBILE_UPDATE_REPO?.trim();
	if (!keystore || !existsSync(keystore)) fail('CURATOR_MOBILE_KEYSTORE does not name a keystore file (root .env or shell)');
	if (!env.CURATOR_MOBILE_KEYSTORE_PASSWORD) fail('CURATOR_MOBILE_KEYSTORE_PASSWORD is not set (root .env or shell)');
	if (!repo || !REPO_RE.test(repo)) fail('CURATOR_MOBILE_UPDATE_REPO is not set to owner/name (root .env or shell)');
	// A published build plays Spotify: an unconfigured one would reach every installed app.
	if (!env.CURATOR_SPOTIFY_CLIENT_ID?.trim()) fail('CURATOR_SPOTIFY_CLIENT_ID is not set (root .env or shell)');
	// And signs in, to the cloud and nothing on this machine.
	for (const name of ['CURATOR_CLOUD_API_URL', 'CURATOR_SUPABASE_URL', 'CURATOR_SUPABASE_PUBLISHABLE_KEY']) {
		const value = env[name]?.trim();
		if (!value) fail(`${name} is not set (root .env or shell)`);
		if (name.endsWith('_URL') && !value.startsWith('https://')) fail(`${name} must be https:// in a release`);
	}

	const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(env.HOME ?? '', 'Android', 'Sdk'));
	const tools = buildTools(sdk);
	const jdk = join(repoRoot, 'apps', 'mobile', 'vendor', 'jdk');
	const keytool = existsSync(jdk) ? join(jdk, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : join(env.JAVA_HOME ?? '', 'bin', 'keytool');
	const key = keyFingerprints(keytool, keystore, alias, env);

	step(`check ${repo}`);
	if (run('gh', ['--version'], { capture: true, allowFail: true }).status !== 0) fail('gh not found: install the GitHub CLI and `gh auth login`');
	const perms = run('gh', ['api', `repos/${repo}`, '--jq', '[.private, .permissions.push] | @tsv'], { capture: true }).stdout.trim().split('\t');
	if (perms[0] !== 'false') fail(`${repo} is not public: installed apps read its releases without a token`);
	if (perms[1] !== 'true') fail(`the gh account cannot push to ${repo}`);
	if (run('gh', ['release', 'view', tag, '--repo', repo], { capture: true, allowFail: true }).status === 0) fail(`${repo} already has a release ${tag}`);

	step(`verify ${tag}`);
	const sha = verifyTag(tag);

	const dir = mkdtempSync(join(tmpdir(), 'curator-mobile-release-'));
	try {
		step(`export ${sha.slice(0, 7)} to ${dir}`);
		await exportCommit(sha, dir);
		const mobile = join(dir, 'apps', 'mobile');
		// The pinned toolchain inputs this machine already fetched (each checked
		// by its SHA-256 when it was): fetch-vendor finds them and skips the
		// downloads, the JDK's among them.
		for (const rel of ['vendor', 'android/app/src/main/res/font']) {
			const from = join(repoRoot, 'apps', 'mobile', rel);
			if (existsSync(from)) cpSync(from, join(mobile, rel), { recursive: true });
		}

		step('install, then the CI mobile gate with the signed release build');
		const buildEnv = {
			...process.env,
			ANDROID_HOME: sdk,
			CURATOR_MOBILE_KEYSTORE: keystore,
			CURATOR_MOBILE_KEYSTORE_PASSWORD: env.CURATOR_MOBILE_KEYSTORE_PASSWORD,
			CURATOR_MOBILE_KEY_ALIAS: alias,
			CURATOR_MOBILE_UPDATE_REPO: repo,
			// The repo's own release list, never a test feed from the shell.
			CURATOR_MOBILE_UPDATE_FEED: '',
			CURATOR_SPOTIFY_CLIENT_ID: env.CURATOR_SPOTIFY_CLIENT_ID,
			CURATOR_CLOUD_API_URL: env.CURATOR_CLOUD_API_URL,
			CURATOR_SUPABASE_URL: env.CURATOR_SUPABASE_URL,
			CURATOR_SUPABASE_PUBLISHABLE_KEY: env.CURATOR_SUPABASE_PUBLISHABLE_KEY,
		};
		run('pnpm', ['install', '--frozen-lockfile', '--filter', '@curator/mobile...'], { cwd: dir, env: buildEnv, shell: process.platform === 'win32' });
		// No daemons: one left running from the export holds its files (its JDK
		// among them) and the export can't be removed afterwards.
		run(process.execPath, [join(mobile, 'scripts', 'check.mjs'), `-PcuratorVersion=${version}`, '--no-daemon', '-Pkotlin.compiler.execution.strategy=in-process'], { cwd: mobile, env: buildEnv });

		step('verify the APK');
		const built = join(mobile, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
		if (!existsSync(built)) fail(`no APK at ${built}`);
		const shell = process.platform === 'win32';
		const certs = run(tools.apksigner, ['verify', '--print-certs', built], { capture: true, shell }).stdout;
		const signers = [...certs.matchAll(/certificate SHA-256 digest:\s*([0-9a-f]+)/g)].map((x) => x[1]);
		if (signers.length !== 1 || signers[0] !== key.sha256) fail(`the APK is signed by ${signers.join(', ') || 'nothing'}, not the release key (${key.sha256})`);
		const badging = run(tools.aapt2, ['dump', 'badging', built], { capture: true }).stdout;
		const pkg = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging);
		if (!pkg || pkg[1] !== PACKAGE || Number(pkg[2]) !== versionCode || pkg[3] !== version) fail(`the APK says ${pkg?.slice(1).join(' ') ?? 'nothing'}, expected ${PACKAGE} ${versionCode} ${version}`);
		console.log(`${PACKAGE} ${version} (${versionCode}), signed with the release key`);

		const apk = `curator-mobile-${version}.apk`;
		const out = join(dir, 'out');
		mkdirSync(out);
		copyFileSync(built, join(out, apk));
		const manifest = { version, versionCode, apk, sha256: createHash('sha256').update(readFileSync(join(out, apk))).digest('hex'), size: statSync(join(out, apk)).size, commit: sha };
		writeFileSync(join(out, 'update.json'), JSON.stringify(manifest, null, '\t') + '\n');

		// What changed in the app since the last mobile release.
		const prev = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'mobile-v*', `${sha}^`], { capture: true, allowFail: true }).stdout.trim();
		const log = prev ? git(['log', '--format=- %s', `${prev}..${sha}`, '--', 'apps/mobile', 'packages/sync-core', 'packages/protocol']) : '';
		writeFileSync(join(out, 'notes.md'), `${prev ? `Since ${prev}:\n\n${log || '- (no app changes)'}` : 'First release.'}\n\nCommit ${sha}. Installed apps update to it on their own.\n`);

		step(`publish ${tag} on ${repo}`);
		// --latest=false: the repo's "latest" belongs to no single app.
		run('gh', ['release', 'create', tag, '--repo', repo, '--verify-tag', '--latest=false', '--title', `Curator mobile ${version}`, '--notes-file', join(out, 'notes.md'), join(out, apk), join(out, 'update.json')]);
		console.log(`\nreleased ${tag} (${sha}): ${apk}, sha256 ${manifest.sha256}`);
	} finally {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			console.warn(`release-mobile: could not remove ${dir}`);
		}
	}
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
