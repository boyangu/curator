// Does a joined replica hold what the desktop's own library holds? The
// replay check's comparison (normalised dump: tracks by recording, tags,
// playlists and their order, cues, ratings, overrides, rekordbox analysis,
// credits) between the dataset's copy of the real library and a run.
//
//   node scripts/compare-desktop.mjs <run dir> [--name main] [--work <dir>]

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareDumps, dumpLibrary } from '../dist/desktop.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'main'));
const run = resolve(process.argv[2]);

const copy = new Database(join(dir, 'copy.db'), { readonly: true, fileMustExist: true });
const desktop = dumpLibrary(copy);
copy.close();
const replica = JSON.parse(readFileSync(join(run, 'dump.json'), 'utf8'));

// The snapshot writes object keys sorted; the desktop's own rows keep the
// order they were written in. Key order is not content: both sides sorted.
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
for (const d of [desktop, replica]) {
	d.settings = sorted(d.settings);
	for (const r of d.rbAnalysis) if (r.segments) r.segments = JSON.stringify(sorted(JSON.parse(r.segments)));
}

let same = true;
for (const t of compareDumps(desktop, replica, 3)) {
	same &&= t.equal;
	console.log(`  ${t.equal ? 'same  ' : 'DIFFER'} ${t.table.padEnd(16)} desktop ${t.left} / replica ${t.right}${t.equal ? '' : `\n    only desktop: ${JSON.stringify(t.onlyLeft).slice(0, 600)}\n    only replica: ${JSON.stringify(t.onlyRight).slice(0, 600)}`}`);
}
console.log(same ? 'the replica holds the desktop library' : 'differences above');
