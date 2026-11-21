// Are two runs' libraries the same? Compares the normalised dump (what the
// replay check compares) and then every table of the two databases, row for
// row — meaningful for `--fixed` runs, where clock and ids are counted and
// the same input must give the same bytes.
//
//   node scripts/compare.mjs <run dir A> <run dir B>

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareDumps } from '../dist/desktop.mjs';

const [a, b] = process.argv.slice(2).map((p) => resolve(p));
if (!a || !b) throw new Error('usage: compare.mjs <run dir A> <run dir B>');

const dumps = [a, b].map((d) => JSON.parse(readFileSync(join(d, 'dump.json'), 'utf8')));
const tables = compareDumps(dumps[0], dumps[1]);
console.log('normalised dump:');
for (const t of tables) console.log(`  ${t.equal ? 'same  ' : 'DIFFER'} ${t.table.padEnd(16)} ${t.left} / ${t.right}${t.equal ? '' : `\n    only A: ${JSON.stringify(t.onlyLeft).slice(0, 400)}\n    only B: ${JSON.stringify(t.onlyRight).slice(0, 400)}`}`);

const dbs = [a, b].map((d) => new Database(join(d, 'replica.db'), { readonly: true, fileMustExist: true }));

// Releases are derived on each device, not synced, so the dump above does
// not hold them — but two loads of one snapshot must file every track under
// the same release with the same album artists. By content (ids are minted):
// recording → release title + album artists.
const releases = (db) => new Map(db.prepare(`SELECT t.recording_id AS r, a.title_key || '|' || coalesce((SELECT group_concat(x, '/') FROM
		(SELECT ar.name_ascii AS x FROM album_artist aa JOIN artist ar ON ar.id = aa.artist_id WHERE aa.album_id = a.id ORDER BY 1)), '') AS v
	FROM track t JOIN album a ON a.id = t.album_id WHERE t.deleted_at IS NULL`).all().map((x) => [x.r, x.v]));
const [ra, rb] = dbs.map(releases);
const moved = [...new Set([...ra.keys(), ...rb.keys()])].filter((r) => ra.get(r) !== rb.get(r));
console.log(`\nreleases by content: ${moved.length === 0 ? `same for ${ra.size} tracks` : `DIFFER for ${moved.length} of ${ra.size} tracks, e.g. ${JSON.stringify(moved.slice(0, 3).map((r) => [ra.get(r), rb.get(r)]))}`}`);
const names = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).pluck().all();
const all = [...new Set([...names(dbs[0]), ...names(dbs[1])])].sort();

// Columns the schema fills from SQLite's own clock (`unixepoch() * 1000`):
// the wall time of the run, which no counted clock in JavaScript reaches. A
// table is compared whole first; only when that differs is it compared again
// without them, and the columns left out are named.
const clockColumns = (db, table) => db.prepare(`SELECT name, dflt_value FROM pragma_table_info(?)`).all(table).filter((c) => /unixepoch|strftime|current_/i.test(c.dflt_value ?? '')).map((c) => c.name);
// Every row as JSON, in the order of its compared columns; blobs as hex.
const rows = (db, table, without = []) => {
	const cols = db.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table).filter((c) => !without.includes(c));
	if (cols.length === 0) return null;
	return db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${table}" ORDER BY ${cols.map((_, i) => i + 1).join(', ')}`).raw().iterate();
};
const enc = (row) => JSON.stringify(row.map((v) => (Buffer.isBuffer(v) ? { hex: v.toString('hex') } : v)));

const diff = (table, without) => {
	const [ra, rb] = dbs.map((db) => rows(db, table, without));
	if (!ra || !rb) return { same: false, n: 0, m: 0, first: { a: 'missing on one side', b: '' } };
	const ha = createHash('sha256'), hb = createHash('sha256');
	let n = 0, m = 0, first = null;
	for (;;) {
		const x = ra.next(), y = rb.next();
		if (x.done && y.done) break;
		const sx = x.done ? null : enc(x.value), sy = y.done ? null : enc(y.value);
		if (sx !== null) { ha.update(sx); n++; }
		if (sy !== null) { hb.update(sy); m++; }
		if (sx !== sy && !first) first = { a: sx, b: sy };
	}
	return { same: n === m && ha.digest('hex') === hb.digest('hex'), n, m, first };
};

let different = 0;
let total = 0;
let butClock = 0;
console.log('\nevery table, row for row:');
for (const table of all) {
	let r = diff(table, []);
	let note = '';
	if (!r.same) {
		const clock = clockColumns(dbs[0], table);
		if (clock.length > 0) {
			const again = diff(table, clock);
			if (again.same) { r = again; note = `  (all but ${clock.join(', ')}: SQLite's own clock)`; butClock++; }
		}
	}
	total += r.n;
	if (!r.same) {
		different++;
		console.log(`  DIFFER ${table.padEnd(32)} ${r.n} / ${r.m} rows\n    A: ${String(r.first?.a).slice(0, 500)}\n    B: ${String(r.first?.b).slice(0, 500)}`);
	} else if (r.n > 0) console.log(`  same   ${table.padEnd(32)} ${r.n} rows${note}`);
}
const ok = different === 0 && tables.every((t) => t.equal);
console.log(`\n${all.length} tables, ${total} rows: ${ok ? `IDENTICAL${butClock ? ` (${butClock} tables apart from columns SQLite stamps with its own clock)` : ''}` : `${different} tables differ`}`);
for (const db of dbs) db.close();
process.exitCode = ok ? 0 : 1;
