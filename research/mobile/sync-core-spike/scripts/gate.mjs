// The gate for any change to the sync client, its shims or the engine: the
// same join on Node and on QuickJS with a counted clock and counted ids must
// write the same database, row for row. With --ops it also pulls a file of
// real ops after the join (the path the engine's Map bug hid in).
//
//   node scripts/gate.mjs [--name main] [--ops <ops.json>] [--device adb]
//
// Rebuilds the bundles, runs both sides, compares. Exit code 0 only when
// every table is identical. QuickJS runs through WSL unless --device adb
// names the attached phone. Needs the inputs (scripts/prepare.mjs) and the
// host (scripts/build-host.mjs) to exist.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const name = arg('name', 'main');
const ops = arg('ops');
const device = arg('device', 'wsl');
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), name);
const pass = ['--fixed', '--name', name, ...(ops ? ['--ops', ops] : [])];

const run = (script, ...a) => {
	const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...a], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28 });
	if (r.status !== 0) { process.stdout.write(r.stdout.split('\n').slice(-15).join('\n')); throw new Error(`${script} ${a.join(' ')} failed`); }
	return r.stdout;
};

run('bundle.mjs');
console.log('bundles built; running Node…');
run('reference.mjs', ...pass);
console.log(`running QuickJS (${device})…`);
const started = Date.now();
run('run-device.mjs', device, ...pass);
// The device run's folder: the newest *-fixed run that is not Node's.
const theirs = readdirSync(dir)
	.filter((d) => d.endsWith('-fixed') && !d.startsWith('node') && statSync(join(dir, d)).isDirectory() && statSync(join(dir, d)).mtimeMs >= started - 1_000)
	.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0];
if (!theirs) throw new Error('the device run left no folder');
const compared = spawnSync(process.execPath, [join(root, 'scripts', 'compare.mjs'), join(dir, 'node-fixed'), join(dir, theirs)], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const lines = compared.stdout.trim().split('\n');
console.log(lines.filter((l) => /DIFFER|IDENTICAL|tables differ/.test(l)).join('\n'));
process.exitCode = compared.status === 0 ? 0 : 1;
