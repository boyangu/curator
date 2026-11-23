// Waveform peaks for the test server's catalogue (serve-cloud.ts --peaks):
// for the tracks of the named playlists in a joined copy of the dataset, the
// recording's claimed audio hash, then this machine's own .cpk files for that
// audio, copied into <work>/<name>/peaks/<hi|lo>/<audio hash, ':' as '_'>.cpk,
// listed in index.json.
//
//   node scripts/prepare-peaks.mjs --playlists "night,bedroom" [--max 300] [--name nov8] [--work c:/tmp/curator-mobile-spike]
//
// The desktop's live library is opened READ-ONLY, only to find which of its
// tracks holds a given audio (source_link.audio_hash); its peaks files are
// read, never written. Everything written goes under <work>.

import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const dir = join(resolve(arg('work', 'c:/tmp/curator-mobile-spike')), arg('name', 'nov8'));
const names = (arg('playlists', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const max = Number(arg('max', '300'));
if (names.length === 0) throw new Error('--playlists "<name>,<name>" names the playlists whose tracks get waveforms');

const appData = process.env.APPDATA ?? '';
const peaksRoot = join(appData, 'Curator', 'peaks');
const replica = new Database(join(dir, 'node-replica', 'replica.db'), { readonly: true, fileMustExist: true });
const live = new Database(join(appData, 'Curator', 'curator.db'), { readonly: true, fileMustExist: true });

// The recordings of those playlists, with one claimed audio hash each.
const rows = replica.prepare(`
	SELECT DISTINCT t.recording_id AS rec, t.duration AS duration, substr(s.parent_id, 12) AS hash
	FROM playlist p JOIN playlist_track pt ON pt.playlist_id = p.id JOIN track t ON t.id = pt.track_id
	JOIN sync_state s ON s.recording_id = t.recording_id AND +s.map = 'claims' AND s.parent_id >= 'audio_hash:' AND s.parent_id < 'audio_hash;'
	WHERE p.name IN (${names.map(() => '?').join(',')}) AND t.deleted_at IS NULL`).all(...names);
const byHash = live.prepare(`SELECT track_id FROM source_link WHERE source = 'local' AND audio_hash = ? AND missing_at IS NULL`);

const out = join(dir, 'peaks');
rmSync(out, { recursive: true, force: true });
for (const v of ['hi', 'lo']) mkdirSync(join(out, v), { recursive: true });
const index = [];
for (const r of rows) {
	if (index.length >= max) break;
	const ids = byHash.all(r.hash).map((x) => x.track_id);
	const id = ids.find((i) => existsSync(join(peaksRoot, 'lo', `${i}.cpk`)));
	if (!id) continue;
	const tiers = [];
	for (const v of ['hi', 'lo']) {
		const src = join(peaksRoot, v, `${id}.cpk`);
		if (!existsSync(src)) continue;
		// No ':' in a Windows file name (it names an NTFS stream instead).
		copyFileSync(src, join(out, v, `${r.hash.replace(':', '_')}.cpk`));
		tiers.push(v);
	}
	index.push({ hash: r.hash, durationSec: r.duration, tiers });
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));
console.log(`${index.length} recordings with waveforms (of ${rows.length} with a claimed hash in ${names.join(', ')}) → ${out}`);
