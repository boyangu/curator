// Builds the spike's inputs from the real library, without touching it:
//
//   1. `VACUUM INTO` a copy from a READ-ONLY handle of the live database (the
//      replay check's way, packages/sync-core/src/sync-log/replay-check.ts);
//   2. the account snapshot of that copy, with the master's own builder
//      (snapshot-build.ts) — gzip parts, joined into state.json.gz;
//   3. an empty library at this build's schema (migrate), the file a new
//      device starts from.
//
//   node scripts/prepare.mjs [--source <curator.db>] [--work c:/tmp/curator-mobile-spike] [--name main] [--static]
//
// `--static`: the source is a closed backup file. It is copied as a file
// instead: opening a WAL database that has no -shm beside it would create one
// in the backup's folder.
//
// Everything is written under the work dir. `--name` keeps several datasets
// side by side (an older backup as the base of the op-apply run).

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildSnapshotParts, MASTER_DEVICE_SETTING, migrate } from '../dist/desktop.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const source = resolve(arg('source', join(process.env.APPDATA ?? '', 'Curator', 'curator.db')));
const work = resolve(arg('work', 'c:/tmp/curator-mobile-spike'));
const name = arg('name', 'main');
const dir = join(work, name);
const sql = (p) => p.replace(/'/g, "''").replace(/\\/g, '/');

if (!existsSync(source)) throw new Error(`no such database: ${source}`);
if (resolve(dir).startsWith(resolve(source, '..'))) throw new Error('the work dir must not be the library folder');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

// 1. The copy. The source is opened read-only and never written.
const copyPath = join(dir, 'copy.db');
let t = Date.now();
if (process.argv.includes('--static')) copyFileSync(source, copyPath);
else {
	const ro = new Database(source, { readonly: true, fileMustExist: true });
	try { ro.exec(`VACUUM INTO '${sql(copyPath)}'`); } finally { ro.close(); }
}
console.log(`copy: ${(statSync(copyPath).size / 1e6).toFixed(0)} MB in ${((Date.now() - t) / 1000).toFixed(1)} s`);

// 2. The snapshot. A library in use usually has a few ops not yet pushed,
// and the builder (rightly) refuses to publish then; on the copy they are
// dropped from the outbox so it builds. Their effect stays in the records —
// for this spike the snapshot only has to be real, not publishable.
const copy = new Database(copyPath);
const dropped = copy.prepare(`DELETE FROM sync_outbox WHERE state IN ('pending', 'rejected')`).run().changes;
const cursor = copy.prepare(`SELECT last_seq FROM sync_cursor`).pluck().get();
// The account's master as its records state it: the fake cloud registers it,
// so the phone joins an account that already has a first device.
const masterRecord = copy.prepare(`SELECT value FROM sync_state WHERE map = 'settings' AND key = ?`).pluck().get(MASTER_DEVICE_SETTING);
const masterDevice = masterRecord ? JSON.parse(masterRecord).value ?? null : null;
copy.close();
t = Date.now();
const built = await buildSnapshotParts({ dbPath: copyPath, outDir: join(dir, 'parts'), userId: 'spike' });
if (!built.ok) throw new Error(`snapshot not built: ${built.skipped} (${built.count ?? ''})`);
const gz = Buffer.concat(built.files.map((f) => readFileSync(f)));
if (createHash('sha256').update(gz).digest('hex') !== built.manifest.sha256) throw new Error('joined parts do not match the manifest');
writeFileSync(join(dir, 'state.json.gz'), gz);
// For a host built without zlib.
writeFileSync(join(dir, 'state.json'), gunzipSync(gz));
console.log(`snapshot: ${built.records} records, ${(built.jsonBytes / 1e6).toFixed(0)} MB of JSON, ${(gz.length / 1e6).toFixed(1)} MB gzipped, built in ${((Date.now() - t) / 1000).toFixed(1)} s (seq ${built.snapshotSeq}, ${dropped} unpushed ops dropped)`);

// 3. The empty library.
const emptyPath = join(dir, 'empty.db');
migrate(emptyPath);
const empty = new Database(emptyPath);
empty.pragma('wal_checkpoint(TRUNCATE)');
empty.close();
console.log(`empty library: ${(statSync(emptyPath).size / 1e3).toFixed(0)} KB`);

writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ seq: built.snapshotSeq, masterDevice, manifest: built.manifest }, null, 1));
writeFileSync(join(dir, 'inputs.json'), JSON.stringify({ source, at: new Date().toISOString(), cursor, dropped, records: built.records, jsonBytes: built.jsonBytes, gzBytes: gz.length, stateSha256: built.manifest.stateSha256 }, null, 1));
