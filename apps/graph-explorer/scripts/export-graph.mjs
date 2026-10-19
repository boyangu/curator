// curator.db → public/graph-data.json
//
// Emits a COMPACT, RAW-ish dump — one row per track with its denormalized
// entity strings (artist names, genre, label) plus a few musical scalars.
// Deliberately does NO graph modeling: the browser builds nodes/edges from
// these rows (src/model/buildGraph.ts) so we can iterate on the modeling
// without re-running this export. Re-run only when curator.db itself changes.
//
// Reads via the Node built-in `node:sqlite` (Node ≥ 22.5) so there is no
// better-sqlite3 ABI rebuild to worry about — this app is decoupled from the
// desktop/core native-module dance on purpose.

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');

// Default to the real Electron userData DB on Windows; override with CURATOR_DB_URL.
const defaultDb =
	process.platform === 'win32' && process.env.APPDATA
		? join(process.env.APPDATA, 'Curator', 'curator.db')
		: join(appDir, '..', '..', 'curator.db');
const dbPath = process.env.CURATOR_DB_URL ?? defaultDb;

console.log(`reading ${dbPath}`);
const db = new DatabaseSync(dbPath, { readOnly: true });

// Local files only — a track counts as "local" if it has a source_link with
// source='local' (an on-disk FLAC/M4A/WAV ingested from a watched folder).
// Streaming-only tracks are excluded from this graph by design.
const rows = db
	.prepare(
		`SELECT t.id, t.title, t.artists, t.genre, t.label, t.bpm,
		        t.key_camelot AS keyCamelot, t.release_date AS releaseDate
		 FROM track t
		 WHERE EXISTS (
		   SELECT 1 FROM source_link sl
		   WHERE sl.track_id = t.id AND sl.source = 'local'
		 )`
	)
	.all();

const tracks = rows.map((r) => {
	let artists = [];
	try {
		// track.artists is a JSON array of { name, role }.
		artists = JSON.parse(r.artists).map((a) => a?.name).filter(Boolean);
	} catch {
		artists = [];
	}
	const norm = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);
	return {
		id: r.id,
		title: r.title,
		artists,
		genre: norm(r.genre),
		label: norm(r.label),
		bpm: r.bpm ?? null,
		key: norm(r.keyCamelot),
		year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : null,
	};
});

const out = {
	meta: {
		source: dbPath,
		trackCount: tracks.length,
		// No Date.now() weirdness — just a coarse stamp for provenance.
		generatedAtMs: Date.now(),
	},
	tracks,
};

const dest = join(appDir, 'public', 'graph-data.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out));
db.close();

const mb = (JSON.stringify(out).length / 1e6).toFixed(1);
console.log(`wrote ${tracks.length} tracks → ${dest} (${mb} MB)`);
