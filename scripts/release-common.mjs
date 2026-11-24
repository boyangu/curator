// What the release scripts share (release-cloud.mjs, release-mobile.mjs):
// the maintainer's machine builds every release, from a pushed tag on
// origin/main exported with `git archive`, so what ships maps to a public,
// reviewed commit and nothing uncommitted, nor `.env`, nor the live library,
// can reach the build.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// bsdtar by its path on Windows: from Git Bash, `tar` is GNU tar, which reads
// `C:` in a path as a remote host.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// A minimal .env reader: KEY=value per line, `#` comments, optional quotes,
// whitespace around `=` tolerated. The shell wins over the file.
export function loadDotEnv(path = join(repoRoot, '.env')) {
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

/** The helpers, their failures prefixed with the script's [name]. */
export function releaseKit(name) {
	function fail(msg) {
		console.error(`${name}: ${msg}`);
		process.exit(1);
	}

	function step(msg) {
		console.log(`\n== ${msg}`);
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

	/**
	 * The commit [tag] names on origin, which must be on origin/main: a local
	 * tag that was never pushed, or moved, does not count.
	 */
	function verifyTag(tag) {
		const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
		if (!remote) fail(`${tag} is not on origin; push it first (git push origin ${tag})`);
		const lines = remote.split('\n').map((l) => l.split('\t'));
		const peeled = lines.find(([, ref]) => ref.endsWith('^{}')) ?? lines[0];
		const sha = peeled[0];
		git(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
		if (run('git', ['cat-file', '-e', `${sha}^{commit}`], { capture: true, allowFail: true }).status !== 0) git(['fetch', '--quiet', 'origin', sha]);
		if (run('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { capture: true, allowFail: true }).status !== 0) fail(`${tag} (${sha}) is not on origin/main`);
		console.log(`${tag} -> ${sha}, on origin/main`);
		return sha;
	}

	// git archive | tar -x: the tracked tree of exactly that commit, nothing else.
	async function exportCommit(sha, dir) {
		await new Promise((resolve, reject) => {
			const archive = spawn('git', ['archive', '--format=tar', sha], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
			const untar = spawn(tar, ['-xf', '-', '-C', dir], { stdio: ['pipe', 'inherit', 'inherit'] });
			archive.stdout.pipe(untar.stdin);
			let pending = 2;
			const done = (what) => (code) => {
				if (code !== 0) reject(new Error(`${what} exited ${code}`));
				else if (--pending === 0) resolve();
			};
			archive.on('error', reject).on('close', done('git archive'));
			untar.on('error', reject).on('close', done('tar'));
		});
	}

	return { fail, step, run, git, verifyTag, exportCommit };
}
