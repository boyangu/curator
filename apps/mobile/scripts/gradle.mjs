// Runs the Android build's Gradle wrapper with the JDK scripts/fetch-vendor.mjs
// fetched (none is installed system-wide on Windows) and the SDK the
// environment names. Arguments pass through: `node scripts/gradle.mjs assembleDebug`.

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const jdk = join(root, 'vendor', 'jdk');
const env = { ...process.env };
if (existsSync(jdk)) env.JAVA_HOME = jdk;
else if (!env.JAVA_HOME) throw new Error('no JDK: run `node scripts/fetch-vendor.mjs`, or set JAVA_HOME to a JDK 17+');

// The SDK's path, for Gradle (local.properties is not in git).
const sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk') : join(env.HOME ?? '', 'Android', 'Sdk'));
if (!existsSync(join(android, 'local.properties'))) writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '/')}\n`);

// Through sh elsewhere: the wrapper is in git without its executable bit
// (committed from Windows), so a Linux checkout can't run it directly.
const win = process.platform === 'win32';
const args = ['--console=plain', ...process.argv.slice(2)];
const r = win
	? spawnSync(join(android, 'gradlew.bat'), args, { cwd: android, env, stdio: 'inherit', shell: true })
	: spawnSync('sh', [join(android, 'gradlew'), ...args], { cwd: android, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
