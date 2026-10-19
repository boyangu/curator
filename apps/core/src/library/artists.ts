// The artist seam — the ONE place that derives `artist` + `track_artist` +
// `track.artist_sort` from a track's effective artist list
// (overrides.artists ?? artists). Every write site that touches `artists`
// or `overrides` calls syncTrackArtists afterwards; nothing else writes
// those tables. See the ARTIST / TRACK_ARTIST comment in
// packages/shared/src/schema.ts for the identity rules.
//
// Runs on the raw better-sqlite3 handle (`db.$client`) with cached prepared
// statements: a full sync touches tens of thousands of rows and drizzle's
// query builder would rebuild SQL per row. Never opens its own transaction —
// callers batch inside theirs (the migrate backfill, applyTrackMerge) or run
// autocommit like the rest of the sync loops.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { applyRemixers, artistKey, normalizeArtistList, searchFold, type ArtistProtect } from '@curator/shared';
import type { TrackArtist, TrackOverrides } from '@curator/shared/schema';
import type { Db } from '../db/client.js';

type Raw = Database.Database;

interface ArtistRow { id: string; name: string; merged_into: string | null; name_curated_at: number | null }

interface Stmts {
	byFold: Database.Statement<[string], ArtistRow>;
	byId: Database.Statement<[string], ArtistRow>;
	insArtist: Database.Statement<[string, string, string]>;
	delLinks: Database.Statement<[string]>;
	insLink: Database.Statement<[string, string, string | null, number]>;
	setSort: Database.Statement<[string | null, string]>;
	rowsById: Database.Statement<[string], { id: string; artists: string; overrides: string | null }>;
}

const STMTS = new WeakMap<Raw, Stmts>();

function stmts(raw: Raw): Stmts {
	let s = STMTS.get(raw);
	if (!s) {
		s = {
			byFold: raw.prepare(`SELECT id, name, merged_into, name_curated_at FROM artist WHERE name_ascii = ?`),
			byId: raw.prepare(`SELECT id, name, merged_into, name_curated_at FROM artist WHERE id = ?`),
			insArtist: raw.prepare(`INSERT INTO artist (id, name, name_ascii) VALUES (?, ?, ?)`),
			delLinks: raw.prepare(`DELETE FROM track_artist WHERE track_id = ?`),
			insLink: raw.prepare(`INSERT OR IGNORE INTO track_artist (track_id, artist_id, role, position) VALUES (?, ?, ?, ?)`),
			setSort: raw.prepare(`UPDATE track SET artist_sort = ? WHERE id = ?`),
			rowsById: raw.prepare(`SELECT id, artists, overrides FROM track WHERE id = ?`),
		};
		STMTS.set(raw, s);
	}
	return s;
}

// drizzle 0.36 attaches the raw better-sqlite3 handle as `db.$client` at
// runtime but doesn't type it. A transaction handle (`db.transaction((tx)
// => …)`) carries no $client — the seam must be handed the root Db; the
// statements it runs join whatever transaction is open on the connection.
export function rawOf(db: Db): Raw {
	const raw = (db as unknown as { $client?: Raw }).$client;
	if (!raw) throw new Error('artist seam needs the root Db (db.$client), not a transaction handle');
	return raw;
}

// Follow the alias chain to the live row. Bounded so a cyclic merge (which
// mergeArtists refuses to create) can't hang a sync.
function resolveAlias(s: Stmts, row: ArtistRow): ArtistRow {
	let cur = row;
	for (let hops = 0; cur.merged_into && hops < 8; hops++) {
		const next = s.byId.get(cur.merged_into);
		if (!next) break;
		cur = next;
	}
	return cur;
}

// Look up (or mint) the artist row for a name. Returns the LIVE row — an
// alias resolves to its merge target.
export function upsertArtistRaw(raw: Raw, name: string): ArtistRow {
	const s = stmts(raw);
	const fold = artistKey(name);
	const hit = s.byFold.get(fold);
	if (hit) return resolveAlias(s, hit);
	const id = randomUUID();
	s.insArtist.run(id, name.trim(), fold);
	return { id, name: name.trim(), merged_into: null, name_curated_at: null };
}

export function lookupArtistRaw(raw: Raw, name: string): ArtistRow | null {
	const s = stmts(raw);
	const hit = s.byFold.get(artistKey(name));
	return hit ? resolveAlias(s, hit) : null;
}

type ArtistsJson = TrackArtist[] | string | null | undefined;
type OverridesJson = TrackOverrides | string | null | undefined;

function parseArtists(v: ArtistsJson): TrackArtist[] {
	if (!v) return [];
	if (typeof v === 'string') {
		try { const arr = JSON.parse(v) as unknown; return Array.isArray(arr) ? (arr as TrackArtist[]) : []; }
		catch { return []; }
	}
	return v;
}

function parseOverrides(v: OverridesJson): TrackOverrides | null {
	if (!v) return null;
	if (typeof v === 'string') {
		try { return JSON.parse(v) as TrackOverrides; } catch { return null; }
	}
	return v;
}

export function effectiveArtists(row: { artists: ArtistsJson; overrides: OverridesJson }): TrackArtist[] {
	const o = parseOverrides(row.overrides);
	return o?.artists ?? parseArtists(row.artists);
}

export interface TrackArtistsRow { id: string; artists: ArtistsJson; overrides: OverridesJson }

// Rewrite one track's junction rows + artist_sort from its effective list.
export function syncTrackArtistsRaw(raw: Raw, rows: readonly TrackArtistsRow[]): void {
	const s = stmts(raw);
	for (const row of rows) {
		const list = effectiveArtists(row).filter((a) => a && typeof a.name === 'string' && a.name.trim() !== '');
		s.delLinks.run(row.id);
		list.forEach((a, i) => {
			const ar = upsertArtistRaw(raw, a.name);
			s.insLink.run(row.id, ar.id, a.role ?? null, i);
		});
		s.setSort.run(list.length ? searchFold(list[0]!.name) || null : null, row.id);
	}
}

export function syncTrackArtists(db: Db, rows: readonly TrackArtistsRow[]): void {
	syncTrackArtistsRaw(rawOf(db), rows);
}

export function syncTrackArtistsByIdRaw(raw: Raw, trackIds: readonly string[]): void {
	const s = stmts(raw);
	const rows: TrackArtistsRow[] = [];
	for (const id of trackIds) {
		const r = s.rowsById.get(id);
		if (r) rows.push(r);
	}
	syncTrackArtistsRaw(raw, rows);
}

export function syncTrackArtistsById(db: Db, trackIds: readonly string[]): void {
	syncTrackArtistsByIdRaw(rawOf(db), trackIds);
}

// "Is this fold a known standalone artist?" — the splitter's veto so a name
// that legitimately contains a separator stays whole once the library knows
// it. Aliases count (the merged-into row is the known artist). Callers hand
// in a searchFold; the table is keyed by artistKey, which is idempotent
// over it.
export function artistProtectRaw(raw: Raw): ArtistProtect {
	const s = stmts(raw);
	return (fold) => s.byFold.get(artistKey(fold)) != null;
}

export function artistProtect(db: Db): ArtistProtect {
	return artistProtectRaw(rawOf(db));
}

export interface NormalizeArtistsOptions {
	// The track's title. When given, the title's remix segment ("(X Remix)",
	// "Title - X Extended Remix") tags X as role 'remixer' — tagging the
	// existing credit when Spotify already listed X, adding X when the
	// library knows the name. The title itself is never touched (it is the
	// release name); see @curator/shared remix-credit.ts for the rules.
	title?: string | null;
	// Spotify artist objects are entities — "Crosby, Stills & Nash" is one
	// artist however it is spelled. Pass false to skip the credit splitter
	// and only dedupe / substitute. Everything else (tags, rb pull, the edit
	// field, MCP, and Tidal — whose catalog packs collaborations into one
	// entity) keeps the default.
	split?: boolean;
}

// Write-input normalisation for every path that accepts artists from
// outside: split packed credits (protected by the artist table), then
// substitute the curated spelling / merge target for names the user has
// renamed or merged, then dedupe by fold, then read remixers off the title.
// Pure w.r.t. the tables — it never mints artist rows; syncTrackArtists
// does that after the write.
//
// This is also where a rename made on ANOTHER device reaches new credits:
// a pulled artist_alias rule is projected onto the artist table in the
// shape a local rename leaves (library/artist-alias.ts), so the
// substitution below maps it with no lookup of its own. Keep it the only
// such place.
export function normalizeIncomingArtistsRaw(raw: Raw, list: readonly TrackArtist[] | null | undefined, opts: NormalizeArtistsOptions = {}): TrackArtist[] {
	const split = opts.split === false
		? (list ?? []).filter((a) => a && typeof a.name === 'string' && a.name.trim()).map((a) => (a.role ? { name: a.name.trim(), role: a.role } : { name: a.name.trim() }))
		: normalizeArtistList(list ?? [], { protect: artistProtectRaw(raw) });
	const out: TrackArtist[] = [];
	const seen = new Set<string>();
	const s = stmts(raw);
	for (const a of split) {
		// Direct hit = the row for this exact fold; live = after aliases. Take
		// the live spelling when the user curated it or when the direct row
		// is an alias (its target is the name the library shows).
		const direct = s.byFold.get(artistKey(a.name));
		const live = direct ? resolveAlias(s, direct) : null;
		const name = live && (live.name_curated_at != null || live.id !== direct!.id) ? live.name : a.name;
		const key = searchFold(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(a.role ? { name, role: a.role } : { name });
	}
	if (opts.title) return applyRemixers(out, opts.title, { known: (fold) => s.byFold.get(artistKey(fold)) != null });
	return out;
}

export function normalizeIncomingArtists(db: Db, list: readonly TrackArtist[] | null | undefined, opts: NormalizeArtistsOptions = {}): TrackArtist[] {
	return normalizeIncomingArtistsRaw(rawOf(db), list, opts);
}
