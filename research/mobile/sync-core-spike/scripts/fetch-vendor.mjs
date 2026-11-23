// Fetches what the hosts are built from into vendor/ (not in git):
// QuickJS-ng's amalgamated source, SQLite's (the version the desktop's
// better-sqlite3 carries) and zlib; and for the Hermes host, Hermes V1 as
// Meta ships it for Android (the engine prebuilt, its compiler, the JSI
// sources of the same tag) and the fbjni library the engine links against.

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendor = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'vendor');
mkdirSync(vendor, { recursive: true });

const get = async (url, file) => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	writeFileSync(file, Buffer.from(await res.arrayBuffer()));
};
// bsdtar ships with Windows and reads zip. By its path: from Git Bash, `tar`
// is GNU tar, which reads `C:` in a path as a remote host.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const unzip = (file, into) => { mkdirSync(into, { recursive: true }); execFileSync(tar, ['-xf', file, '-C', into], { stdio: 'inherit' }); };

// Pinned: the engine is part of what the comparison vouches for, and the
// local fix (host/quickjs-map-rope-fix.mjs) is written against this source.
if (!existsSync(join(vendor, 'quickjs', 'quickjs-amalgam.c'))) {
	await get('https://github.com/quickjs-ng/quickjs/releases/download/v0.18.0/quickjs-amalgam.zip', join(vendor, 'quickjs-amalgam.zip'));
	unzip(join(vendor, 'quickjs-amalgam.zip'), join(vendor, 'quickjs'));
}

const db = new Database(':memory:');
const version = db.prepare('select sqlite_version()').pluck().get();
db.close();
const [a, b, c] = version.split('.').map(Number);
const name = `sqlite-amalgamation-${a}${String(b).padStart(2, '0')}${String(c).padStart(2, '0')}00`;
if (!existsSync(join(vendor, name, 'sqlite3.c'))) {
	// SQLite files releases under the year they came out.
	const year = new Date().getFullYear();
	let got = false;
	for (const y of [year, year - 1, year - 2]) {
		try { await get(`https://sqlite.org/${y}/${name}.zip`, join(vendor, 'sqlite.zip')); got = true; break; } catch { /* another year */ }
	}
	if (!got) throw new Error(`could not fetch ${name}.zip from sqlite.org`);
	unzip(join(vendor, 'sqlite.zip'), vendor);
}
// Android has zlib; the Linux host compiles its inflate half from source.
if (!existsSync(join(vendor, 'zlib-1.3.1', 'inflate.c'))) {
	await get('https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz', join(vendor, 'zlib.tar.gz'));
	execFileSync(tar, ['-xzf', join(vendor, 'zlib.tar.gz'), '-C', vendor], { stdio: 'inherit' });
}
// Hermes V1, pinned like the rest. One version for the engine, its compiler
// (bytecode is only read by the release that wrote it) and the JSI the engine
// was built against; fbjni at the version Hermes's own Android build names
// (android/gradle/libs.versions.toml at the tag).
export const HERMES_VERSION = '260318099.0.8';
const hermes = join(vendor, 'hermes');
const pinned = async (url, sha256, file) => {
	await get(url, file);
	const got = createHash('sha256').update(readFileSync(file)).digest('hex');
	if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
};
if (!existsSync(join(hermes, 'android', 'jni', 'arm64-v8a', 'libhermesvm.so'))) {
	mkdirSync(hermes, { recursive: true });
	const base = `https://repo1.maven.org/maven2/com/facebook/hermes/hermes-android/${HERMES_VERSION}/hermes-android-${HERMES_VERSION}-release.aar`;
	await pinned(base, '0596bae80860f3e357596f286a1ebf52560a1d2b6be8bb919aa637da61e8e171', join(hermes, 'hermes-android.aar'));
	unzip(join(hermes, 'hermes-android.aar'), join(hermes, 'android'));
}
if (!existsSync(join(hermes, 'fbjni', 'jni', 'arm64-v8a', 'libfbjni.so'))) {
	await pinned('https://repo1.maven.org/maven2/com/facebook/fbjni/fbjni/0.7.0/fbjni-0.7.0.aar', '7e319ae110ac5e5ef18904170aea5c3e753e915d196699d7fd39d36c8e1dfe36', join(hermes, 'fbjni.aar'));
	unzip(join(hermes, 'fbjni.aar'), join(hermes, 'fbjni'));
}
if (!existsSync(join(hermes, 'jsi', 'jsi', 'jsi.cpp'))) {
	await pinned(`https://codeload.github.com/facebook/hermes/tar.gz/refs/tags/hermes-v${HERMES_VERSION}`, '10a4e05147d0eb8c2d43b07d324a7ac38a400806423bb3f5649b156168561b96', join(hermes, 'hermes-src.tgz'));
	rmSync(join(hermes, 'src'), { recursive: true, force: true });
	mkdirSync(join(hermes, 'src'), { recursive: true });
	execFileSync(tar, ['-xzf', join(hermes, 'hermes-src.tgz'), '-C', join(hermes, 'src'), '--strip-components', '3', `hermes-hermes-v${HERMES_VERSION}/API/jsi`], { stdio: 'inherit' });
	renameSync(join(hermes, 'src'), join(hermes, 'jsi'));
}
if (!existsSync(join(hermes, 'compiler', 'package', 'hermesc'))) {
	await pinned(`https://registry.npmjs.org/hermes-compiler/-/hermes-compiler-${HERMES_VERSION}.tgz`, '27abf690176db6027b3b27b30186cce994bdbb540ccba981f365c9ab8c7a5196', join(hermes, 'hermes-compiler.tgz'));
	mkdirSync(join(hermes, 'compiler'), { recursive: true });
	execFileSync(tar, ['-xzf', join(hermes, 'hermes-compiler.tgz'), '-C', join(hermes, 'compiler')], { stdio: 'inherit' });
}
// A JDK for the Hermes host: Hermes on Android hands Unicode work to Java, so
// the host runs inside Android's Java runtime (host/java/spike/Main.java), and its
// small dex needs javac and the SDK's d8 (Java 11 or newer). Portable,
// unzipped here, used for nothing else.
if (process.platform === 'win32' && !existsSync(join(vendor, 'jdk', 'bin', 'javac.exe'))) {
	const name = 'jdk-21.0.13.1+2';
	if (!existsSync(join(vendor, name))) {
		await pinned('https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13.1%2B2/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13.1_2.zip', 'bbebea1469996b276683c9299c227b294f85c847039c82633218186a4ad4fbf2', join(vendor, 'jdk.zip'));
		unzip(join(vendor, 'jdk.zip'), vendor);
	}
	// Antivirus holds freshly unzipped files for a while: the rename is retried.
	for (let i = 0; ; i++) {
		try { renameSync(join(vendor, name), join(vendor, 'jdk')); break; } catch (err) {
			if (i >= 10) throw err;
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}
console.log(`vendor: quickjs-ng 0.18.0, sqlite ${version}, zlib 1.3.1, hermes ${HERMES_VERSION}, fbjni 0.7.0${existsSync(join(vendor, 'jdk')) ? ', jdk 21.0.13.1' : ''}`);
