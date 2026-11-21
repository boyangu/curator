// Cuts the snapshot into small files of entries, in the order the loader
// takes them (merges and alias rules, then snapshot.ts LOAD_ORDER): what a
// streaming reader of the snapshot body would hand over, piece by piece.
// Input of the driver's `stream` run, which measures the loader when it never
// holds the whole snapshot.
//
//   node scripts/split-snapshot.mjs [--name main] [--work <dir>] [--entries 2000]
//
// Writes <work>/<name>/chunks/NNNN.json: { map, entries: [[key, value], …] }.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'main'));
const per = Number(arg('entries', '2000'));
// A chunk is also cut at this many characters of values, so no one piece is large.
const MAX_CHARS = 4_000_000;

const ORDER = [
	'merges', 'artistAliases', 'tombstones',
	'tags', 'playlistFolders', 'playlists', 'pinnedSearches', 'settings', 'playSessions',
	'libraryTracks', 'trackTags', 'playlistTracks', 'cues', 'playEvents', 'claims', 'upstreamAcks',
	'feedItems', 'feedSuppressions', 'albums',
];

const doc = JSON.parse(gunzipSync(readFileSync(join(dir, 'state.json.gz'))).toString('utf8'));
// recordingAlias and artistAlias are derived (snapshot.ts recordsFromState): not loaded.
const unknown = Object.keys(doc.maps).filter((m) => !ORDER.includes(m) && m !== 'recordingAlias' && m !== 'artistAlias');
if (unknown.length > 0) throw new Error(`maps this script does not order: ${unknown.join(', ')}`);

const out = join(dir, 'chunks');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let n = 0;
let largest = 0;
const names = [];
for (const map of ORDER) {
	const entries = doc.maps[map] ?? [];
	let batch = [];
	let chars = 0;
	const flush = () => {
		if (batch.length === 0) return;
		const name = `${String(n++).padStart(4, '0')}.json`;
		const text = JSON.stringify({ map, entries: batch });
		largest = Math.max(largest, text.length);
		writeFileSync(join(out, name), text);
		names.push(name);
		batch = [];
		chars = 0;
	};
	for (const e of entries) {
		batch.push(e);
		chars += JSON.stringify(e[1]).length;
		if (batch.length >= per || chars >= MAX_CHARS) flush();
	}
	flush();
}
writeFileSync(join(out, 'index.json'), JSON.stringify(names));
console.log(`${n} chunks of at most ${per} entries, the largest ${(largest / 1e6).toFixed(1)} MB of JSON`);
