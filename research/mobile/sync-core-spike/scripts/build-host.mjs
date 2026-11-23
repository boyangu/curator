// Compiles a host with SQLite and zlib's inflate (vendor/, fetched by
// scripts/fetch-vendor.mjs) into one executable per target:
//
//   node scripts/build-host.mjs android-arm64    a phone (NDK clang)
//   node scripts/build-host.mjs android-x86_64   the emulator
//   node scripts/build-host.mjs linux            this machine, through WSL's gcc
//
// QuickJS by default (host/host.c, the engine compiled in). The engine is
// built with one local fix, to its Map/Set hashing of long concatenated
// strings (host/quickjs-map-rope-fix.mjs). `--stock` builds it as released,
// into dist/host-<target>-stock.
//
// `--engine hermes` builds host/host-hermes.cpp instead, for Android only:
// Hermes is Meta's prebuilt library and needs Android's Java runtime, so the
// host is a folder, dist/hermes-<target>/, that app_process runs: the host
// as libspikehost.so, the libraries it loads (libhermesvm.so and libfbjni.so
// as shipped, libjsi.so built here from the matching tag, the NDK's
// libc++_shared.so) and spike.dex (host/java/spike/Main.java with the Java classes
// of both AARs). Needs vendor/jdk and the SDK's build-tools and platform.
//
// SQLite is built with better-sqlite3's compile options where they change
// behaviour (foreign keys and recursive triggers on by default, DQS off, the
// same extensions), so a statement means the same thing on both sides.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixMapRopeHash } from '../host/quickjs-map-rope-fix.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const target = args[0];
const engineAt = args.indexOf('--engine');
const engine = engineAt >= 0 ? args[engineAt + 1] : 'quickjs';
const sqliteDir = join(root, 'vendor', readdirSync(join(root, 'vendor')).find((d) => d.startsWith('sqlite-amalgamation-')) ?? 'sqlite-amalgamation');
const quickjsDir = join(root, 'vendor', 'quickjs');
mkdirSync(join(root, 'dist'), { recursive: true });

const SQLITE_FLAGS = [
	'-DSQLITE_DQS=0', '-DSQLITE_DEFAULT_FOREIGN_KEYS=1', '-DSQLITE_DEFAULT_RECURSIVE_TRIGGERS=1', '-DSQLITE_DEFAULT_CACHE_SIZE=-16000',
	'-DSQLITE_DEFAULT_MEMSTATUS=0', '-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1', '-DSQLITE_LIKE_DOESNT_MATCH_BLOBS', '-DSQLITE_THREADSAFE=2',
	'-DSQLITE_TEMP_STORE=1', '-DSQLITE_USE_URI=1', '-DSQLITE_OMIT_DEPRECATED', '-DSQLITE_OMIT_SHARED_CACHE', '-DSQLITE_OMIT_PROGRESS_CALLBACK',
	'-DSQLITE_ENABLE_FTS3', '-DSQLITE_ENABLE_FTS3_PARENTHESIS', '-DSQLITE_ENABLE_FTS4', '-DSQLITE_ENABLE_FTS5', '-DSQLITE_ENABLE_RTREE',
	'-DSQLITE_ENABLE_GEOPOLY', '-DSQLITE_ENABLE_MATH_FUNCTIONS', '-DSQLITE_ENABLE_STAT4', '-DSQLITE_ENABLE_COLUMN_METADATA',
	'-DSQLITE_ENABLE_DBSTAT_VTAB', '-DSQLITE_SOUNDEX', '-DSQLITE_DEFAULT_SECTOR_SIZE=4096',
];

// The NDK: its newest version, its clang, the target's triple and sysroot libraries.
const ndkFor = (target) => {
	const ndkRoot = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'), 'ndk');
	const ndk = existsSync(ndkRoot) ? readdirSync(ndkRoot).sort().pop() : null;
	if (!ndk) throw new Error(`no Android NDK under ${ndkRoot}`);
	const triple = target === 'android-arm64' ? 'aarch64-linux-android' : 'x86_64-linux-android';
	const llvm = join(ndkRoot, ndk, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64');
	return {
		triple,
		abi: target === 'android-arm64' ? 'arm64-v8a' : 'x86_64',
		clang: join(llvm, 'bin', 'clang.exe'),
		clangxx: join(llvm, 'bin', 'clang++.exe'),
		cxxShared: join(llvm, 'sysroot', 'usr', 'lib', triple, 'libc++_shared.so'),
	};
};

if (engine === 'hermes') {
	if (target !== 'android-arm64' && target !== 'android-x86_64') throw new Error('the Hermes host is built for android-arm64 or android-x86_64 only (the engine is Meta\'s Android library)');
	const hermes = join(root, 'vendor', 'hermes');
	const version = JSON.parse(readFileSync(join(hermes, 'compiler', 'package', 'package.json'), 'utf8')).version;
	const { triple, abi, clang, clangxx, cxxShared } = ndkFor(target);
	const out = join(root, 'dist', `hermes-${target}`);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const jsiDir = join(hermes, 'jsi');
	const cxx = [`--target=${triple}24`, '-O2', '-DNDEBUG', '-std=c++20', '-fexceptions', '-frtti', '-w', `-I${jsiDir}`];
	// The engine's libraries as shipped, and the C++ runtime they were built for.
	copyFileSync(join(hermes, 'android', 'jni', abi, 'libhermesvm.so'), join(out, 'libhermesvm.so'));
	copyFileSync(join(hermes, 'fbjni', 'jni', abi, 'libfbjni.so'), join(out, 'libfbjni.so'));
	copyFileSync(cxxShared, join(out, 'libc++_shared.so'));
	// libjsi.so: libhermesvm.so needs it, and the AAR leaves it to the app.
	execFileSync(clangxx, [...cxx, '-fPIC', '-shared', join(jsiDir, 'jsi', 'jsi.cpp'), '-Wl,-soname,libjsi.so', '-nostdlib++', '-lc++_shared', '-o', join(out, 'libjsi.so')], { stdio: 'inherit' });
	// SQLite as C, then the host as C++ against it, both into one library.
	const sqliteObj = join(out, 'sqlite3.o');
	execFileSync(clang, [`--target=${triple}24`, '-O2', '-DNDEBUG', '-fPIC', '-w', '-c', ...SQLITE_FLAGS, join(sqliteDir, 'sqlite3.c'), '-o', sqliteObj], { stdio: 'inherit' });
	execFileSync(clangxx, [
		...cxx, '-fPIC', '-shared', `-I${join(hermes, 'android', 'prefab', 'modules', 'hermesvm', 'include')}`, `-I${sqliteDir}`,
		'-DSPIKE_ZLIB', `-DSPIKE_HERMES_VERSION="${version}"`,
		join(root, 'host', 'host-hermes.cpp'), sqliteObj, '-Wl,-soname,libspikehost.so',
		`-L${out}`, '-lhermesvm', '-ljsi', '-lz', '-lm', '-llog', '-nostdlib++', '-lc++_shared', '-o', join(out, 'libspikehost.so'),
	], { stdio: 'inherit' });
	rmSync(sqliteObj);
	// The Java side: the entry point, and the classes fbjni and Hermes look up.
	const sdk = process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk');
	const newest = (dir) => readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
	const d8 = join(sdk, 'build-tools', newest(join(sdk, 'build-tools')), 'lib', 'd8.jar');
	const androidJar = join(sdk, 'platforms', newest(join(sdk, 'platforms')), 'android.jar');
	const jdk = join(root, 'vendor', 'jdk', 'bin');
	const classes = join(out, 'classes');
	execFileSync(join(jdk, 'javac.exe'), ['--release', '8', '-Xlint:-options', '-d', classes, join(root, 'host', 'java', 'spike', 'Main.java')], { stdio: 'inherit' });
	execFileSync(join(jdk, 'java.exe'), [
		'-cp', d8, 'com.android.tools.r8.D8', '--min-api', '24', '--lib', androidJar, '--output', out,
		join(classes, 'spike', 'Main.class'), join(hermes, 'android', 'classes.jar'), join(hermes, 'fbjni', 'classes.jar'),
	], { stdio: 'inherit' });
	rmSync(classes, { recursive: true });
	renameSync(join(out, 'classes.dex'), join(out, 'spike.dex'));
	writeFileSync(join(out, 'version.txt'), `hermes ${version}\n`);
	console.log(out);
} else {
	const stock = args.includes('--stock');
	// The fixed engine is a copy beside the released source, which stays as fetched.
	const quickjs = join(quickjsDir, stock ? 'quickjs-amalgam.c' : 'quickjs-amalgam.fixed.c');
	if (!stock) writeFileSync(quickjs, fixMapRopeHash(readFileSync(join(quickjsDir, 'quickjs-amalgam.c'), 'utf8')));
	const tag = stock ? '-stock' : '';
	const sources = (p) => [p(join(root, 'host', 'host.c')), p(quickjs), p(join(sqliteDir, 'sqlite3.c'))];
	const common = (p) => ['-O2', '-DNDEBUG', '-fno-strict-aliasing', '-w', `-I${p(quickjsDir)}`, `-I${p(sqliteDir)}`, ...SQLITE_FLAGS];

	if (target === 'linux') {
		const wsl = (p) => resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
		const out = join(root, 'dist', `host-linux${tag}`);
		// No zlib headers in the analyzer's WSL image: its inflate half is compiled in from vendor/.
		const zlibDir = join(root, 'vendor', readdirSync(join(root, 'vendor')).find((d) => /^zlib-[0-9]/.test(d)) ?? 'zlib');
		const inflate = ['adler32.c', 'crc32.c', 'inffast.c', 'inflate.c', 'inftrees.c', 'zutil.c'].map((f) => wsl(join(zlibDir, f)));
		execFileSync('wsl.exe', ['-e', 'gcc', ...common(wsl), '-DSPIKE_ZLIB', `-I${wsl(zlibDir)}`, ...sources(wsl), ...inflate, '-o', wsl(out), '-lm', '-lpthread', '-ldl'], { stdio: 'inherit' });
		console.log(out);
	} else if (target === 'android-arm64' || target === 'android-x86_64') {
		const { triple, clang } = ndkFor(target);
		const out = join(root, 'dist', `host-${target}${tag}`);
		const same = (p) => p;
		execFileSync(clang, [`--target=${triple}24`, ...common(same), '-DSPIKE_ZLIB', ...sources(same), '-o', out, '-lm', '-lz'], { stdio: 'inherit' });
		console.log(out);
	} else {
		throw new Error('usage: build-host.mjs linux | android-arm64 | android-x86_64 [--stock] [--engine hermes]');
	}
}
