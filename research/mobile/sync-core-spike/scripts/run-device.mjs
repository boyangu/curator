// The driver on a machine that is not this Node:
//
//   node scripts/run-device.mjs wsl       QuickJS on this CPU, through WSL (dist/host-linux)
//   node scripts/run-device.mjs wsl-node  Node in the same WSL, same disk: the two engines on one machine
//   node scripts/run-device.mjs adb       QuickJS on the attached phone or emulator
//
//   [--fixed]          the comparison run (counted clock and ids)
//   [--stream]         the loader fed the snapshot in pieces (needs scripts/split-snapshot.mjs)
//   [--ops <file>]     ops after the snapshot for the client to pull
//   [--http] [--tail]  sync through the plain-HTTP transport against scripts/serve-cloud.ts on this
//                      machine (adb: reached through `adb reverse`); --tail adds the server's later ops
//   [--scale <n>]      the client's sliceScale: longer slices for a host with its own sync thread
//   [--engine hermes]  adb only: the Hermes host (dist/hermes-<target>/, dist/core.hbc) instead of QuickJS
//   [--replica]        with --http: join from the server's ready-made replica (scripts/build-replica.mjs)
//                      instead of its snapshot; --tail adds the later ops as before
//   [--name main] [--work <dir>] [--run <name>] [--serial <adb id>]
//
// Sends the program, the bundle and the inputs to a scratch folder on the
// target, runs there, and brings back replica.db, dump.json, result.json and
// run.log into <work>/<name>/<run>/. The run is named after the target (the
// phone's model for adb), plus -stream / -fixed.
//
// wsl-node needs a Node build at /tmp/spike-node/node and better-sqlite3
// installed beside it (README).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const fixed = args.includes('--fixed');
const stream = args.includes('--stream');
const http = args.includes('--http') || args.includes('--replica');
const replica = args.includes('--replica');
const target = args[0];
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'main'));
const ops = arg('ops') ? resolve(arg('ops')) : null;
const hermes = arg('engine') === 'hermes';
if (arg('engine') && !hermes && arg('engine') !== 'quickjs') throw new Error(`no host for engine ${arg('engine')}`);
const suffix = `${hermes ? '-hermes' : ''}${stream ? '-stream' : ''}${replica ? '-replica' : http ? '-http' : ''}${fixed ? '-fixed' : ''}${arg('scale') ? `-x${arg('scale')}` : ''}`;

// The input files, as [local path, path under the target's data folder].
const inputs = http
	? [['server.json', 'server.json']]
	: stream
	? [['chunks/index.json', 'chunks/index.json'], ...JSON.parse(readFileSync(join(dir, 'chunks', 'index.json'), 'utf8')).map((n) => [`chunks/${n}`, `chunks/${n}`])]
	: [['manifest.json', 'manifest.json'], ...JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).manifest.parts.map((p) => [`parts/${p.sha256}.cgz`, `parts/${p.sha256}.cgz`])];
const scale = arg('scale');
const driverArgs = (t) => http
	? `${replica ? 'replica' : 'sync'} --db ${t}/out/replica.db --server ${t}/data/server.json --out ${t}/out${args.includes('--tail') ? ' --tail' : ''}${fixed ? ' --fixed' : ''}${scale ? ` --scale ${scale}` : ''}`
	: `${stream ? 'stream' : 'join'} --db ${t}/out/replica.db --data ${t}/data --out ${t}/out${ops ? ` --ops ${t}/ops.json` : ''}${fixed ? ' --fixed' : ''}${scale ? ` --scale ${scale}` : ''}`;

const fresh = (name) => {
	const run = join(dir, arg('run', name + suffix));
	rmSync(run, { recursive: true, force: true });
	mkdirSync(run, { recursive: true });
	return run;
};
const finish = (run) => {
	const log = readFileSync(join(run, 'run.log'), 'utf8');
	console.log(log.split('\n').filter((l) => /^cycle |^[a-z ]+: \d+ ms|Maximum resident|Elapsed|unhandled|Error|exit=/.test(l)).join('\n'));
	console.log(run);
};

if (hermes && target !== 'adb') throw new Error('the Hermes host runs on adb only (Meta ships the engine for Android)');

if (target === 'wsl' || target === 'wsl-node') {
	const wsl = (p) => resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
	const run = fresh(target);
	// The database lives on WSL's own disk: SQLite's WAL needs shared memory
	// the Windows mount does not give.
	const t = target === 'wsl' ? '/tmp/curator-spike' : '/tmp/curator-spike-node';
	const n = '/tmp/spike-node';
	const program = target === 'wsl'
		? [`cp ${wsl(join(root, 'dist', 'host-linux'))} ${wsl(join(root, 'dist', 'core.js'))} ${t}/`]
		: [
			`mkdir -p ${n}/dist && cp ${wsl(join(root, 'dist', 'desktop.mjs'))} ${n}/dist/`,
			`printf "import { main } from './dist/desktop.mjs';\\nawait main(process.argv.slice(2));\\n" > ${n}/run.mjs`,
		];
	const command = target === 'wsl' ? `cd ${t} && /usr/bin/time -v ./host-linux core.js -- ${driverArgs(t)}` : `cd ${n} && /usr/bin/time -v ./node/bin/node run.mjs ${driverArgs(t)}`;
	const script = [
		`rm -rf ${t} && mkdir -p ${t}/data/parts ${t}/data/chunks ${t}/out`,
		...program,
		`cd ${wsl(dir)} && cp --parents ${inputs.map(([from]) => from).join(' ')} ${t}/data/`,
		`cp ${wsl(join(dir, 'empty.db'))} ${t}/out/replica.db`,
		...(ops ? [`cp ${wsl(ops)} ${t}/ops.json`] : []),
		`${command} > ${t}/out/run.log 2>&1; echo exit=$? >> ${t}/out/run.log`,
		`cp ${t}/out/replica.db ${t}/out/run.log ${wsl(run)}/; cp ${t}/out/dump.json ${t}/out/result.json ${wsl(run)}/ 2>/dev/null; true`,
	].join(' && ');
	spawnSync('wsl.exe', ['-e', 'bash', '-c', script], { stdio: 'inherit' });
	finish(run);
} else if (target === 'adb') {
	const adbPath = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'), 'platform-tools', 'adb.exe');
	const serial = arg('serial');
	const adb = (...a) => execFileSync(adbPath, [...(serial ? ['-s', serial] : []), ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
	const sh = (cmd) => adb('shell', cmd).trim();
	const abi = sh('getprop ro.product.cpu.abi');
	const model = sh('getprop ro.product.model').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
	const androidTarget = abi === 'arm64-v8a' ? 'android-arm64' : abi === 'x86_64' ? 'android-x86_64' : '';
	const host = join(root, 'dist', hermes ? `hermes-${androidTarget}` : `host-${androidTarget}`);
	if (!existsSync(host)) throw new Error(`no host built for ${abi}: node scripts/build-host.mjs ${androidTarget || 'android-arm64'}${hermes ? ' --engine hermes' : ''}`);
	const run = fresh(model);
	// The shell user's scratch folder: files there may be executed.
	const t = '/data/local/tmp/curator-spike';
	sh(`rm -rf ${t} && mkdir -p ${t}/data/parts ${t}/data/chunks ${t}/out`);
	// Hermes: the host library, the libraries it loads and its dex, for app_process.
	if (hermes) for (const f of readdirSync(host)) adb('push', join(host, f), `${t}/${f}`);
	else { adb('push', host, `${t}/host`); sh(`chmod 755 ${t}/host`); }
	const script = hermes ? 'core.hbc' : 'core.js';
	adb('push', join(root, 'dist', script), `${t}/${script}`);
	if (stream) adb('push', join(dir, 'chunks'), `${t}/data/`);
	else for (const [from, to] of inputs) adb('push', join(dir, from), `${t}/data/${to}`);
	// A replica join makes its own library file.
	if (!replica) adb('push', join(dir, 'empty.db'), `${t}/out/replica.db`);
	if (ops) adb('push', ops, `${t}/ops.json`);
	// The phone's 127.0.0.1:<port> is this machine's, for the test server.
	if (http) { const port = new URL(JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')).apiUrl).port; adb('reverse', `tcp:${port}`, `tcp:${port}`); }
	const device = { model: sh('getprop ro.product.model'), soc: sh('getprop ro.soc.model') || sh('getprop ro.board.platform'), android: sh('getprop ro.build.version.release'), abi, memKb: Number(/MemTotal:\s+(\d+)/.exec(sh('cat /proc/meminfo'))?.[1] ?? 0), cores: Number(sh('nproc')) };
	console.log(JSON.stringify(device));
	const started = Date.now();
	// A run the system kills (out of memory) leaves no exit line of its own.
	// Hermes inside Android's Java runtime, as an app runs it (host/java/spike/Main.java).
	const launch = hermes ? `CLASSPATH=${t}/spike.dex app_process -Dspike.dir=${t} ${t} spike.Main ${script}` : `./host ${script}`;
	try { sh(`cd ${t} && ${launch} -- ${driverArgs(t)} > ${t}/out/run.log 2>&1; echo exit=$? >> ${t}/out/run.log`); } catch (err) { console.log(`adb shell ended: ${String(err.message).split('\n')[0]}`); }
	const wallMs = Date.now() - started;
	for (const f of ['run.log', 'result.json', 'dump.json', 'replica.db']) {
		try { adb('pull', `${t}/out/${f}`, join(run, f)); } catch { /* a failed run leaves no result */ }
	}
	writeFileSync(join(run, 'device.json'), JSON.stringify({ ...device, wallMs }, null, 1));
	sh(`rm -rf ${t}`);
	finish(run);
} else {
	throw new Error('usage: run-device.mjs wsl | wsl-node | adb [--fixed] [--stream] [--ops <file>] [--name main] [--serial <id>]');
}
