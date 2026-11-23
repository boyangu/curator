// The desktop's run of the driver: Node + better-sqlite3 on this machine,
// from a fresh copy of the empty library.
//
//   node scripts/reference.mjs [--fixed] [--stream] [--ops <file>] [--name main] [--work <dir>] [--run <name>]
//   node scripts/reference.mjs --http [--tail] [--fixed] …     through the plain-HTTP transport, against scripts/serve-cloud.ts
//   node scripts/reference.mjs --replica [--tail] …              joining from the server's ready-made replica
//
// Results land in <work>/<name>/<run>/ (replica.db, dump.json, result.json);
// the run is named node, plus -stream / -fixed, unless --run says otherwise.

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { main } from '../dist/desktop.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const fixed = args.includes('--fixed');
const stream = args.includes('--stream');
const replica = args.includes('--replica');
const http = args.includes('--http') || replica;
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'main'));
const run = join(dir, arg('run', `node${stream ? '-stream' : ''}${replica ? '-replica' : http ? '-http' : ''}${fixed ? '-fixed' : ''}`));

rmSync(run, { recursive: true, force: true });
mkdirSync(run, { recursive: true });
if (!replica) copyFileSync(join(dir, 'empty.db'), join(run, 'replica.db'));
if (http) await main([replica ? 'replica' : 'sync', '--db', join(run, 'replica.db'), '--server', join(dir, 'server.json'), '--out', run, ...(args.includes('--tail') ? ['--tail'] : []), ...(fixed ? ['--fixed'] : []), ...(arg('scale') ? ['--scale', arg('scale')] : [])]);
else await main([stream ? 'stream' : 'join', '--db', join(run, 'replica.db'), '--data', dir, '--out', run, ...(arg('ops') ? ['--ops', resolve(arg('ops'))] : []), ...(fixed ? ['--fixed'] : []), ...(arg('scale') ? ['--scale', arg('scale')] : [])]);
