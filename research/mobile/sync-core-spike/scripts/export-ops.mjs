// The ops a dataset's library made itself and still holds (its acked
// outbox), as wire ops in the order it made them: the real edits a phone
// that last synced before them would pull.
//
//   node scripts/export-ops.mjs [--name main] [--work <dir>] [--out <file>]

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readOutbox } from '../dist/desktop.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'main'));
const out = resolve(arg('out', join(dir, 'ops.json')));

const db = new Database(join(dir, 'copy.db'), { readonly: true, fileMustExist: true });
const ops = readOutbox(db, { state: 'acked' });
db.close();
writeFileSync(out, JSON.stringify(ops));
const days = new Set(ops.map((o) => new Date(o.client_ts).toISOString().slice(0, 10)));
console.log(`${ops.length} ops over ${days.size} days (${[...days].sort()[0]} to ${[...days].sort().pop()}) -> ${out}`);
