// Builds engine-probe for a phone (aarch64-linux-android) with the NDK's
// clang as the linker. Needs `rustup target add aarch64-linux-android` once.
// AAudio is API 26+, so that is the level linked against.
//
//   node scripts/build-android.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ndkRoot = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'), 'ndk');
const ndk = existsSync(ndkRoot) ? readdirSync(ndkRoot).sort().pop() : null;
if (!ndk) throw new Error(`no Android NDK under ${ndkRoot}`);
const bin = join(ndkRoot, ndk, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin');

execFileSync('cargo', ['build', '--release', '--target', 'aarch64-linux-android'], {
	cwd: root,
	stdio: 'inherit',
	env: {
		...process.env,
		// clang.exe itself, told the target: cargo cannot run the NDK's .cmd wrappers as a linker.
		CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: join(bin, 'clang.exe'),
		CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS: '-Clink-arg=--target=aarch64-linux-android26',
		CC_aarch64_linux_android: join(bin, 'clang.exe'),
		AR_aarch64_linux_android: join(bin, 'llvm-ar.exe'),
	},
});
console.log(join(root, 'target', 'aarch64-linux-android', 'release', 'engine-probe'));
