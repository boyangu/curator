// The master's half of a replica join, with the product's own builder (apps/
// core sync-log/replica.ts buildReplica): the dataset's snapshot parts joined
// into an empty library by the real client, compacted, cut into gzip parts.
// What the desktop's snapshot process does after a publish.
//
//   node scripts/build-replica.mjs [--name nov8] [--work <dir>] [--seq 1]
//
// `--seq`: the snapshot's seq on the server that will serve the replica.
// scripts/serve-cloud.ts publishes the dataset's snapshot at seq 1 (its log
// starts with the master setting), so that is the default. Writes
// <work>/<name>/replica/{<sha256>.cgz, manifest.json}; serve-cloud.ts
// publishes them through sync.publishReplica when it starts.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildReplica } from '../dist/desktop.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'nov8'));
const seq = Number(arg('seq', '1'));
const given = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const out = join(dir, 'replica');
rmSync(out, { recursive: true, force: true });

// Built for serve-cloud's account (its fixed dev id, --user to change it),
// as a master builds for its own. The part paths name a user; serve-cloud
// re-files them under its account's prefix by their hashes.
const r = await buildReplica({
	userId: arg('user', '00000000-0000-4000-8000-00000000c0de'),
	masterDeviceId: given.masterDevice ?? 'desktop',
	snapshotSeq: seq,
	snapshotFiles: given.manifest.parts.map((p) => join(dir, 'parts', `${p.sha256}.cgz`)),
	outDir: out,
});
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ snapshotSeq: r.snapshotSeq, manifest: r.manifest }, null, 1));
console.log(`replica at seq ${r.snapshotSeq}: ${(r.manifest.rawBytes / 1e6).toFixed(0)} MB raw, ${r.manifest.parts.length} parts, ${(r.manifest.totalBytes / 1e6).toFixed(0)} MB gzip; join ${(r.joinMs / 1000).toFixed(0)} s, whole build ${(r.buildMs / 1000).toFixed(0)} s`);
