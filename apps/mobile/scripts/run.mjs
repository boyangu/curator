// Puts the debug app on a device wired to the local test server and starts it:
// the server's port reversed onto the device, its server.json handed to the
// app (core/DevServer.kt), the APK installed, the app launched, its core's log
// followed until Ctrl-C.
//
//   node scripts/run.mjs --server <dir holding server.json> [--serial <id>] [--fresh] [--no-log]
//
// The server is the sync-core spike's (research/mobile/sync-core-spike/scripts/
// serve-cloud.ts, started from apps/cloud): local testing only, for now.
// --fresh clears the app's data first, so it joins as a new device.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const PKG = 'app.curator.mobile';

const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
const adbPath = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const serial = arg('serial');
// MSYS_NO_PATHCONV: from Git Bash, device paths like /sdcard would be rewritten as Windows paths.
const adb = (...a) => {
	const r = spawnSync(adbPath, [...(serial ? ['-s', serial] : []), ...a], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
	if (r.status !== 0) throw new Error(`adb ${a.join(' ')}: ${r.stderr || r.stdout}`);
	return r.stdout;
};

const serverDir = arg('server');
if (!serverDir || !existsSync(join(serverDir, 'server.json'))) throw new Error('--server <dir> must hold the test server\'s server.json');
const server = JSON.parse(readFileSync(join(serverDir, 'server.json'), 'utf8'));
const port = new URL(server.apiUrl).port || '80';

const apk = join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
if (!existsSync(apk)) throw new Error('no debug APK: run `pnpm --filter @curator/mobile build`');

adb('reverse', `tcp:${port}`, `tcp:${port}`);
adb('install', '-r', apk);
if (args.includes('--fresh')) adb('shell', 'pm', 'clear', PKG);
const files = `/sdcard/Android/data/${PKG}/files`;
adb('shell', 'mkdir', '-p', files);
adb('push', join(serverDir, 'server.json'), `${files}/dev-server.json`);
adb('logcat', '-c');
adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
console.log(`started ${PKG} against ${server.apiUrl}`);

if (!args.includes('--no-log')) {
	const log = spawn(adbPath, [...(serial ? ['-s', serial] : []), 'logcat', '-v', 'time', 'curator-core:V', 'AndroidRuntime:E', 'DEBUG:V', '*:S'], { stdio: 'inherit' });
	process.on('SIGINT', () => { log.kill(); process.exit(0); });
}
