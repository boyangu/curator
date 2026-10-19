// One-shot DB probe: given a trackId, dumps everything Curator knows about
// it across track / source_link / rekordbox_link / track_analysis / cue.
// Run from the repo root: `node scripts/debug-track.mjs <trackId>`
import { createRequire } from 'node:module';
// better-sqlite3 is a dependency of apps/core, not the root — resolve it from
// there so the script survives repo moves and version bumps.
const require = createRequire(new URL('../apps/core/package.json', import.meta.url));
const Database = require('better-sqlite3');
import { join } from 'node:path';

const trackId = process.argv[2];
if (!trackId) {
	console.error('usage: node scripts/debug-track.mjs <trackId>');
	process.exit(1);
}

const dbPath = join(process.env.APPDATA ?? '', '@curator', 'desktop', 'curator.db');
console.log('db:', dbPath);
const db = new Database(dbPath, { readonly: true });

const track = db.prepare('SELECT id, title, artist, source FROM track WHERE id = ?').get(trackId);
console.log('\n── track ─────────────────────────────────────');
console.log(track ?? '(no row)');

const links = db.prepare('SELECT source, source_id, file_path FROM source_link WHERE track_id = ?').all(trackId);
console.log('\n── source_link ──────────────────────────────');
console.log(links.length ? links : '(none)');

const rbLink = db.prepare('SELECT rb_content_id, rb_local_usn, rb_file_path, imported_at FROM rekordbox_link WHERE track_id = ?').get(trackId);
console.log('\n── rekordbox_link ───────────────────────────');
console.log(rbLink ?? '(none — track was never imported from Rekordbox)');

const analysis = db.prepare('SELECT track_id, bpm, key_camelot, analyzer_version, length(beatgrid) AS beatgrid_bytes, length(downbeats) AS downbeats_bytes, analyzed_at FROM track_analysis WHERE track_id = ?').get(trackId);
console.log('\n── track_analysis ───────────────────────────');
console.log(analysis ?? '(no row)');

const cues = db.prepare('SELECT slot, kind, position_sec, length_sec, color, name FROM cue WHERE track_id = ? ORDER BY slot').all(trackId);
console.log('\n── cue ──────────────────────────────────────');
console.log(cues.length ? cues : '(none)');

console.log('\n── watermarks ───────────────────────────────');
console.log(db.prepare('SELECT * FROM rekordbox_sync_watermark').all());

if (rbLink) {
	console.log('\n── nearby rekordbox_link rows (same path dir) ───');
	const dir = rbLink.rb_file_path?.replace(/[/\\][^/\\]*$/, '');
	if (dir) {
		const rows = db.prepare("SELECT track_id, rb_content_id, rb_file_path FROM rekordbox_link WHERE rb_file_path LIKE ? LIMIT 5").all(dir + '%');
		console.log(rows);
	}
}

db.close();
