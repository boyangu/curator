// One-time repair of remixer credits cut down to a one-word prefix.
//
// The multi-artist backfill (db/migrate.ts, step 4, 2026-09-21) asked the
// artist table whether a remix segment named a known artist with the
// segment's searchFold ("patrice baumel") against name_ascii, which holds
// the artistKey ("patricebaumel"). No multi-word artist was ever known
// there, so the parser's longest-known-word-prefix rule (remix-credit.ts
// resolveName) credited "(Patrice Bäumel Remix)" to "Patrice": 44 tracks on
// the 2026-10-27 library, e.g. Rodriguez for Rodriguez Jr., Oliver for
// Oliver Schories. The live ingest path always used the artistKey.
//
// A remixer credit X is replaced by Y when the title's remix segment, read
// again with the right lookup, names Y, Y's fold starts with X's fold plus a
// word, and Y is VOUCHED: credited somewhere as a main or plain artist, not
// only as a remixer. That keeps a named remix ("Ae:ther Dreaming Dub Remix"
// → Ae:ther) from turning into a bogus artist the same parse minted.
//
// Each device runs it on its own rows: the backfill ran per device, and a
// pulled set-meta never touches another device's own row. Canonical credits
// reach the op log through the meta trigger; override lists go through
// recordTrackStateChanges as set-override ops (a raw write would be projected
// back by the next op for the recording). updated_at is bumped so the next
// rekordbox push carries the corrected Artist. Remote rows are skipped: they
// re-project from the master's corrected meta.

import type Database from 'better-sqlite3';
import { artistKey, asciifyArtists, extractRemixers, searchFold } from '@curator/shared';
import type { TrackArtist, TrackOverrides } from '@curator/shared/schema';
import type { Db } from '../db/client.js';
import { backupDatabase } from '../db/migrate.js';
import { log } from '../log.js';
import { syncTrackAlbumsById } from './albums.js';
import { artistProtectRaw, artistsBaseCell, artistsBaseOf, lookupArtistRaw, rawOf, syncTrackArtistsByIdRaw } from './artists.js';
import { recordTrackStateChanges } from './mutators.js';

type Raw = Database.Database;

const REPAIR_VERSION = 1;
const REPAIR_KEY = 'remixer_prefix_repair_version';
// The splitter's collaboration joiners (shared artist-credit.ts), as words.
const JOINER_RE = /(^|\s)(&|\+|x|vs\.?|and|feat\.?|ft\.?|with)(\s|$)|[,;/]/i;

export type RemixerPrefixFix = { trackId: string; title: string; list: 'artists' | 'overrides'; from: string; to: string };
export type RemixerPrefixReport = { fixes: RemixerPrefixFix[]; tracks: number; prunedArtists: string[] };

type Row = { id: string; title: string | null; artists: string | null; artists_base: string | null; overrides: string | null };
type Planned = { id: string; artists: TrackArtist[] | null; base: TrackArtist[] | null; overrides: TrackOverrides | null };

const parse = <T>(s: string | null): T | null => {
	if (!s) return null;
	try { return JSON.parse(s) as T; } catch { return null; }
};

// The list with each truncated remixer replaced, or null when nothing is.
function fixList(list: readonly TrackArtist[], title: string, raw: Raw, vouched: (name: string) => string | null, found: (from: string, to: string) => void): TrackArtist[] | null {
	const named = extractRemixers(title, { known: artistProtectRaw(raw), credits: list });
	const replace = new Map<number, string>();
	list.forEach((a, i) => {
		if (a?.role !== 'remixer' || !a.name) return;
		const prefix = searchFold(a.name) + ' ';
		// "Frankey & Sandrino Remix" credited as Frankey + Sandrino is the
		// splitter's call, not a truncation: a name continuing with a joiner
		// is left alone.
		const y = named.find((n) => {
			const f = searchFold(n);
			return f.startsWith(prefix) && !JOINER_RE.test(f.slice(prefix.length));
		});
		const to = y ? vouched(y) : null;
		// An alias of the same artist ("X + Y" folding onto X) is no fix.
		if (to && artistKey(to) !== artistKey(a.name)) replace.set(i, to);
	});
	if (replace.size === 0) return null;
	// Y already credited (Spotify lists remixers as plain artists): X goes,
	// and Y takes the remixer role unless the list calls it main.
	const others = new Set(list.filter((_, i) => !replace.has(i)).map((a) => artistKey(a.name)));
	const promote = new Set<string>();
	const out: TrackArtist[] = [];
	const seen = new Set<string>();
	list.forEach((a, i) => {
		const to = replace.get(i);
		if (to) found(a.name, to);
		const next: TrackArtist = to ? { name: to, role: 'remixer' } : a.role ? { name: a.name, role: a.role } : { name: a.name };
		const k = artistKey(next.name);
		if (to && others.has(k)) { promote.add(k); return; }
		if (seen.has(k)) return;
		seen.add(k);
		out.push(next);
	});
	return out.map((a) => (promote.has(artistKey(a.name)) && a.role !== 'main' && a.role !== 'remixer' ? { name: a.name, role: 'remixer' } : a));
}

export function planRemixerPrefixRepair(raw: Raw): { planned: Planned[]; report: RemixerPrefixReport } {
	const vouchStmt = raw.prepare(`SELECT 1 FROM track_artist ta JOIN track t ON t.id = ta.track_id
		WHERE ta.artist_id = ? AND (ta.role IS NULL OR ta.role <> 'remixer') AND t.deleted_at IS NULL LIMIT 1`);
	const vouched = (name: string): string | null => {
		const live = lookupArtistRaw(raw, name);
		return live && vouchStmt.get(live.id) ? live.name : null;
	};
	const rows = raw.prepare(`SELECT id, title, artists, artists_base, overrides FROM track
		WHERE remote_only = 0 AND deleted_at IS NULL AND (artists LIKE '%"remixer"%' OR overrides LIKE '%"remixer"%')`).all() as Row[];
	const fixes: RemixerPrefixFix[] = [];
	const planned: Planned[] = [];
	for (const r of rows) {
		const overrides = parse<TrackOverrides>(r.overrides);
		const title = overrides?.title ?? r.title ?? '';
		if (!title) continue;
		const note = (list: 'artists' | 'overrides') => (from: string, to: string) => fixes.push({ trackId: r.id, title, list, from, to });
		const canon = parse<TrackArtist[]>(r.artists) ?? [];
		const artists = fixList(canon, title, raw, vouched, note('artists'));
		// The source credits get the same fix, so the base cell keeps
		// describing what the source said once the remixer is right.
		const source = artistsBaseOf({ artists: canon, artists_base: r.artists_base });
		const base = artists ? fixList(source, title, raw, vouched, () => {}) ?? source : null;
		const ov = overrides?.artists ? fixList(overrides.artists, title, raw, vouched, note('overrides')) : null;
		if (!artists && !ov) continue;
		planned.push({ id: r.id, artists, base, overrides: ov ? { ...overrides, artists: ov } : null });
	}
	return { planned, report: { fixes, tracks: planned.length, prunedArtists: [] } };
}

// Artist rows the repair left with no credit, link, alias or curated name.
function pruneOrphans(raw: Raw, names: readonly string[]): string[] {
	const orphan = raw.prepare(`SELECT id, name FROM artist a WHERE name_ascii = ? AND merged_into IS NULL AND name_curated_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM track_artist WHERE artist_id = a.id)
		AND NOT EXISTS (SELECT 1 FROM album_artist WHERE artist_id = a.id)
		AND NOT EXISTS (SELECT 1 FROM artist_link WHERE artist_id = a.id)
		AND NOT EXISTS (SELECT 1 FROM artist WHERE merged_into = a.id)`);
	const del = raw.prepare(`DELETE FROM artist WHERE id = ?`);
	const out: string[] = [];
	for (const key of new Set(names.map((n) => artistKey(n)))) {
		const row = orphan.get(key) as { id: string; name: string } | undefined;
		if (!row) continue;
		del.run(row.id);
		out.push(row.name);
	}
	return out;
}

export function applyRemixerPrefixRepair(db: Db, planned: readonly Planned[], now = Date.now()): void {
	const ids = planned.map((p) => p.id);
	recordTrackStateChanges(db, ids, (raw) => {
		const get = raw.prepare(`SELECT artists, overrides FROM track WHERE id = ?`);
		const canon = raw.prepare(`UPDATE track SET artists = ?, artists_base = ?, updated_at = ? WHERE id = ?`);
		const over = raw.prepare(`UPDATE track SET overrides = ?, updated_at = ? WHERE id = ?`);
		const ascii = raw.prepare(`UPDATE track SET artists_ascii = ? WHERE id = ?`);
		for (const p of planned) {
			if (p.artists) {
				const cell = artistsBaseCell(p.base ?? p.artists, p.artists);
				canon.run(JSON.stringify(p.artists), cell ? JSON.stringify(cell) : null, now, p.id);
			}
			if (p.overrides) over.run(JSON.stringify(p.overrides), now, p.id);
			const r = get.get(p.id) as { artists: string; overrides: string | null };
			ascii.run(asciifyArtists(parse<TrackOverrides>(r.overrides)?.artists ?? parse<TrackArtist[]>(r.artists)), p.id);
		}
	});
	syncTrackArtistsByIdRaw(rawOf(db), ids);
	syncTrackAlbumsById(db, ids);
}

function readVersion(raw: Raw): number {
	const v = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).pluck().get(REPAIR_KEY) as string | undefined;
	return v ? Number(JSON.parse(v)) || 0 : 0;
}

// Once per device (app_setting gate). Takes a backup beside the DB before
// the first write.
export function runRemixerPrefixRepair(db: Db, dbPath: string): RemixerPrefixReport | null {
	const raw = rawOf(db);
	if (readVersion(raw) >= REPAIR_VERSION) return null;
	const { planned, report } = planRemixerPrefixRepair(raw);
	if (planned.length) {
		backupDatabase(raw, dbPath, 'pre-remixer-repair');
		applyRemixerPrefixRepair(db, planned);
		report.prunedArtists = raw.transaction(() => pruneOrphans(raw, report.fixes.map((f) => f.from)))();
		log.for('artists').info('repaired remixer credits cut to a one-word prefix', {
			tracks: report.tracks,
			fixes: report.fixes.map((f) => `${f.from} → ${f.to} · ${f.title}${f.list === 'overrides' ? ' (edited credits)' : ''}`),
			prunedArtists: report.prunedArtists,
		});
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(REPAIR_KEY, JSON.stringify(REPAIR_VERSION), Date.now());
	return report;
}
