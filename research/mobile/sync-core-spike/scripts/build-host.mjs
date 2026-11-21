// Compiles host/host.c with QuickJS, SQLite and zlib's inflate (vendor/, fetched by
// scripts/fetch-vendor.mjs) into one executable per target:
//
//   node scripts/build-host.mjs android-arm64    a phone (NDK clang)
//   node scripts/build-host.mjs android-x86_64   the emulator
//   node scripts/build-host.mjs linux            this machine, through WSL's gcc
//
// The engine is built with one local fix, to its Map/Set hashing of long
// concatenated strings (host/quickjs-map-rope-fix.mjs). `--stock` builds it
// as released, into dist/host-<target>-stock.
//
// SQLite is built with better-sqlite3's compile options where they change
// behaviour (foreign keys and recursive triggers on by default, DQS off, the
// same extensions), so a statement means the same thing on both sides.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixMapRopeHash } from '../host/quickjs-map-rope-fix.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const sqliteDir = join(root, 'vendor', readdirSync(join(root, 'vendor')).find((d) => d.startsWith('sqlite-amalgamation-')) ?? 'sqlite-amalgamation');
const quickjsDir = join(root, 'vendor', 'quickjs');
mkdirSync(join(root, 'dist'), { recursive: true });
const stock = process.argv.includes('--stock');
// The fixed engine is a copy beside the released source, which stays as fetched.
const engine = join(quickjsDir, stock ? 'quickjs-amalgam.c' : 'quickjs-amalgam.fixed.c');
if (!stock) writeFileSync(engine, fixMapRopeHash(readFileSync(join(quickjsDir, 'quickjs-amalgam.c'), 'utf8')));
const tag = stock ? '-stock' : '';

const SQLITE_FLAGS = [
	'-DSQLITE_DQS=0', '-DSQLITE_DEFAULT_FOREIGN_KEYS=1', '-DSQLITE_DEFAULT_RECURSIVE_TRIGGERS=1', '-DSQLITE_DEFAULT_CACHE_SIZE=-16000',
	'-DSQLITE_DEFAULT_MEMSTATUS=0', '-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1', '-DSQLITE_LIKE_DOESNT_MATCH_BLOBS', '-DSQLITE_THREADSAFE=2',
	'-DSQLITE_TEMP_STORE=1', '-DSQLITE_USE_URI=1', '-DSQLITE_OMIT_DEPRECATED', '-DSQLITE_OMIT_SHARED_CACHE', '-DSQLITE_OMIT_PROGRESS_CALLBACK',
	'-DSQLITE_ENABLE_FTS3', '-DSQLITE_ENABLE_FTS3_PARENTHESIS', '-DSQLITE_ENABLE_FTS4', '-DSQLITE_ENABLE_FTS5', '-DSQLITE_ENABLE_RTREE',
	'-DSQLITE_ENABLE_GEOPOLY', '-DSQLITE_ENABLE_MATH_FUNCTIONS', '-DSQLITE_ENABLE_STAT4', '-DSQLITE_ENABLE_COLUMN_METADATA',
	'-DSQLITE_ENABLE_DBSTAT_VTAB', '-DSQLITE_SOUNDEX', '-DSQLITE_DEFAULT_SECTOR_SIZE=4096',
];
const sources = (p) => [p(join(root, 'host', 'host.c')), p(engine), p(join(sqliteDir, 'sqlite3.c'))];
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
	const ndkRoot = join(process.env.ANDROID_HOME ?? join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'), 'ndk');
	const ndk = existsSync(ndkRoot) ? readdirSync(ndkRoot).sort().pop() : null;
	if (!ndk) throw new Error(`no Android NDK under ${ndkRoot}`);
	const triple = target === 'android-arm64' ? 'aarch64-linux-android' : 'x86_64-linux-android';
	const clang = join(ndkRoot, ndk, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin', 'clang.exe');
	const out = join(root, 'dist', `host-${target}${tag}`);
	const same = (p) => p;
	execFileSync(clang, [`--target=${triple}24`, ...common(same), '-DSPIKE_ZLIB', ...sources(same), '-o', out, '-lm', '-lz'], { stdio: 'inherit' });
	console.log(out);
} else {
	throw new Error('usage: build-host.mjs linux | android-arm64 | android-x86_64');
}
