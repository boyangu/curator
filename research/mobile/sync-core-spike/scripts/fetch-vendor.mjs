// Fetches the C sources the host is built from into vendor/ (not in git):
// QuickJS-ng's amalgamated source, SQLite's (the version the desktop's
// better-sqlite3 carries) and zlib.

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendor = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'vendor');
mkdirSync(vendor, { recursive: true });

const get = async (url, file) => {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	writeFileSync(file, Buffer.from(await res.arrayBuffer()));
};
// bsdtar ships with Windows and reads zip.
const unzip = (file, into) => { mkdirSync(into, { recursive: true }); execFileSync('tar', ['-xf', file, '-C', into], { stdio: 'inherit' }); };

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
	execFileSync('tar', ['-xzf', join(vendor, 'zlib.tar.gz'), '-C', vendor], { stdio: 'inherit' });
}
console.log(`vendor: quickjs-ng 0.18.0, sqlite ${version}, zlib 1.3.1`);
