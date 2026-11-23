// Fetches what the app is built from but Gradle does not resolve, into
// vendor/ (not in git), each pinned by sha256:
//   - SQLite's amalgamation, the version the desktop's better-sqlite3
//     carries: the one SQLite in the process, shared by the sync core (JS)
//     and the views (Kotlin) — two SQLite builds locking one file in one
//     process can corrupt it;
//   - Hermes's JSI sources at the engine's tag (the hermes-android AAR
//     leaves libjsi to the app) and its bytecode compiler, hermesc (bytecode
//     is only read by the release that wrote it);
//   - on Windows, a JDK for Gradle (none is installed system-wide).
// Hermes itself and fbjni come from Maven through Gradle (app/build.gradle.kts).
// Archives already fetched by the sync-core spike are reused when they match.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor');
const spikeVendor = resolve(root, '../../research/mobile/sync-core-spike/vendor');
mkdirSync(vendor, { recursive: true });

export const HERMES_VERSION = '260318099.0.8';
export const SQLITE_VERSION = '3.53.1';

// bsdtar ships with Windows and reads zip. By its path: from Git Bash, `tar`
// is GNU tar, which reads `C:` in a path as a remote host.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// The archive at `file`, from the spike's copy when it matches, else the url.
async function pinned(url, sha256, file, spikeCopy) {
	if (existsSync(file) && sha(file) === sha256) return;
	if (spikeCopy && existsSync(spikeCopy) && sha(spikeCopy) === sha256) {
		copyFileSync(spikeCopy, file);
		return;
	}
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	writeFileSync(file, Buffer.from(await res.arrayBuffer()));
	const got = sha(file);
	if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
}

// Antivirus holds freshly unpacked files for a while: a rename is retried.
async function renameRetried(from, to) {
	for (let i = 0; ; i++) {
		try { renameSync(from, to); return; } catch (err) {
			if (i >= 10) throw err;
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}

const sqliteDir = join(vendor, 'sqlite');
if (!existsSync(join(sqliteDir, 'sqlite3.c'))) {
	const name = 'sqlite-amalgamation-3530100';
	await pinned(`https://sqlite.org/2026/${name}.zip`, '36ad6e7f38540a3b21a2ac36340833f0a9e426bc1c752751c3ba669466827eae', join(vendor, 'sqlite.zip'), join(spikeVendor, 'sqlite.zip'));
	rmSync(join(vendor, name), { recursive: true, force: true });
	execFileSync(tar, ['-xf', join(vendor, 'sqlite.zip'), '-C', vendor], { stdio: 'inherit' });
	rmSync(sqliteDir, { recursive: true, force: true });
	await renameRetried(join(vendor, name), sqliteDir);
}

const hermes = join(vendor, 'hermes');
mkdirSync(hermes, { recursive: true });
if (!existsSync(join(hermes, 'jsi', 'jsi', 'jsi.cpp'))) {
	await pinned(`https://codeload.github.com/facebook/hermes/tar.gz/refs/tags/hermes-v${HERMES_VERSION}`, '10a4e05147d0eb8c2d43b07d324a7ac38a400806423bb3f5649b156168561b96', join(hermes, 'hermes-src.tgz'), join(spikeVendor, 'hermes', 'hermes-src.tgz'));
	const tmp = join(hermes, 'jsi-tmp');
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	execFileSync(tar, ['-xzf', join(hermes, 'hermes-src.tgz'), '-C', tmp, '--strip-components', '3', `hermes-hermes-v${HERMES_VERSION}/API/jsi`], { stdio: 'inherit' });
	rmSync(join(hermes, 'jsi'), { recursive: true, force: true });
	await renameRetried(tmp, join(hermes, 'jsi'));
}
if (!existsSync(join(hermes, 'compiler', 'package', 'hermesc'))) {
	await pinned(`https://registry.npmjs.org/hermes-compiler/-/hermes-compiler-${HERMES_VERSION}.tgz`, '27abf690176db6027b3b27b30186cce994bdbb540ccba981f365c9ab8c7a5196', join(hermes, 'hermes-compiler.tgz'), join(spikeVendor, 'hermes', 'hermes-compiler.tgz'));
	mkdirSync(join(hermes, 'compiler'), { recursive: true });
	execFileSync(tar, ['-xzf', join(hermes, 'hermes-compiler.tgz'), '-C', join(hermes, 'compiler')], { stdio: 'inherit' });
}

if (process.platform === 'win32' && !existsSync(join(vendor, 'jdk', 'bin', 'java.exe'))) {
	const name = 'jdk-21.0.13.1+2';
	await pinned('https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13.1%2B2/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13.1_2.zip', 'bbebea1469996b276683c9299c227b294f85c847039c82633218186a4ad4fbf2', join(vendor, 'jdk.zip'), join(spikeVendor, 'jdk.zip'));
	rmSync(join(vendor, name), { recursive: true, force: true });
	execFileSync(tar, ['-xf', join(vendor, 'jdk.zip'), '-C', vendor], { stdio: 'inherit' });
	await renameRetried(join(vendor, name), join(vendor, 'jdk'));
}

// Spotify's App Remote SDK (Spotify tracks play through the installed Spotify
// app, under our controls): published as an AAR on GitHub, not on Maven.
const spotify = join(vendor, 'spotify');
mkdirSync(spotify, { recursive: true });
await pinned(
	'https://github.com/spotify/android-sdk/releases/download/v0.8.0-appremote_v2.1.0-auth/spotify-app-remote-release-0.8.0.aar',
	'b5a6dd880eaf01f63a871cba9ef7af77c341f8a94ffc8fdf2e9021f9a9d4c198',
	join(spotify, 'spotify-app-remote-release-0.8.0.aar'),
);

// The design system's faces (OFL), bundled so the first frame never falls
// back: Inter (variable: every weight from one file) for the UI, IBM Plex Mono
// for every number. Into the app's resources, not git.
const fonts = join(root, 'android', 'app', 'src', 'main', 'res', 'font');
mkdirSync(fonts, { recursive: true });
const FONTS_AT = 'https://raw.githubusercontent.com/google/fonts/06bfe0d62a98375cb09c942fa18e68bd32cff057/ofl';
for (const [file, path, sha256] of [
	['inter.ttf', 'inter/Inter%5Bopsz,wght%5D.ttf', '29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031'],
	['ibm_plex_mono_regular.ttf', 'ibmplexmono/IBMPlexMono-Regular.ttf', '6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46'],
	['ibm_plex_mono_medium.ttf', 'ibmplexmono/IBMPlexMono-Medium.ttf', 'a9b4c49bb299e05b5f6c481e7fb5e78943d2793249a0c8874ab574a2d1ea6755'],
]) await pinned(`${FONTS_AT}/${path}`, sha256, join(fonts, file));

for (const f of ['sqlite.zip', 'jdk.zip', join('hermes', 'hermes-src.tgz'), join('hermes', 'hermes-compiler.tgz')]) rmSync(join(vendor, f), { force: true });
console.log(`vendor: sqlite ${SQLITE_VERSION}, hermes jsi + hermesc ${HERMES_VERSION}${existsSync(join(vendor, 'jdk')) ? ', jdk 21.0.13.1' : ''}`);
