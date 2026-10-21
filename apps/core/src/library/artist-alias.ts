// Artist alias rules (protocol v2 `artist_alias`) on the desktop: a rename or
// merge of an artist, carried to other devices as "every credit whose artist
// key is K is written N" (packages/protocol ops.ts for the rule shape,
// reduce.ts `rebuildArtistAlias` for chains and cycles).
//
// Source of truth: the reducer's records in sync_state (map
// 'artistAliases'), like every other synced entity; no second table. The
// resolved map is rebuilt from them in memory (there are a handful of rules
// per library, against tens of thousands of other records).
//
// Three consumers:
//   1. Ingest. The `artist` table is the fast lookup: an alias rule is
//      projected onto it exactly as renameArtist / mergeArtists shape it
//      locally (the renamed row moves to the new key, an alias row parks
//      under the old one, a merged row points `merged_into` at the
//      survivor, a spelling rule marks the row curated). The ONE ingest seam,
//      `normalizeIncomingArtistsRaw` (artists.ts), already substitutes the
//      curated / merge-target spelling through that table on every path
//      that accepts credits from outside (scanner, Spotify, Tidal, rekordbox
//      pull, the edit field), so a track ingested after a rule arrived gets
//      the renamed credit without a second lookup.
//   2. Existing canonical credits (`track.artists`, catalogue data that rides
//      no op) are DERIVED, not edited: a track's credits are its source
//      credits (`track.artists_base`, or `artists` when no rule touched it)
//      with every resolved rule applied by `mapCredits`. Whenever a rule's
//      resolution changes (a local rename, a pulled rule, a later rule
//      winning a key, a cycle withdrawing one, a remove) the tracks whose
//      source or current credits name an affected key are re-derived from
//      the converged map. So credits are a function of (source credits,
//      converged rules), and two devices that applied concurrent renames of
//      one artist in opposite orders land on the same names: the losing
//      rename's rewrite is not "undone", it simply stops being what the map
//      says. This is local projection: it emits no ops (every device holds
//      the same rules and derives the same lists; ops would only echo).
//   3. Override lists are NOT rewritten on apply: they are op-log records
//      (set-override), and the renaming device emits set-override ops for
//      every override list its rewrite changed, in the same transaction as
//      the rule. Rewriting them here as well would leave the visible row
//      ahead of its record, and the next projection of that record (a rating
//      op, say) would put the old name back. Records converge by their own
//      LWW, so override lists agree across devices without derivation.
//
// The re-derivation on apply is a scan of every track (a credit hidden
// under an override list is still re-derived, and the junction cannot find
// those; nor can it find a source credit a rename rewrote away), so it is a
// persisted job drained in row-id chunks: a little inline at apply (enough
// for a small library), the rest by the sync client between pull pages with
// the event loop yielding between chunks. Only rows naming a queued key are
// written. A crash mid-job resumes from the stored cursor. Ingest is correct
// from the apply commit on, because (1) happens inside the apply transaction.
//
// `remove` stops a rule applying, to new and existing credits alike: a
// removed (or cycle-withdrawn) key is queued like a changed one, and its
// tracks re-derive to their source spelling. A device that pulled the rule
// and its remove in one batch never rewrote anything, so a remove that left
// earlier rewrites in place would leave devices disagreeing by pull timing.
// Rows a rule rewrote before track.artists_base existed have no recorded
// source credits and keep the spelling they have.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLibraryState, rebuildArtistAlias, type ArtistAliasRecord, type ArtistAliasTarget } from '@curator/protocol';
import { artistKey, asciifyArtists, searchFold } from '@curator/shared';
import type { ArtistsBase, TrackArtist, TrackOverrides } from '@curator/shared/schema';
import { healAlbumArtistAliasesRaw } from './albums.js';
import { artistsBaseCell, artistsBaseOf, creditsKey, syncTrackArtistsByIdRaw } from './artists.js';

type Raw = Database.Database;

// ── the shared credit transform ─────────────────────────────────────────────

// Every credit whose artist key `target` maps is written with the mapped
// name; credits that collapse onto one spelling are deduped by fold AND
// role. A list none of whose keys map is returned untouched (even if it
// already holds a duplicate), so a whole-library scan changes exactly the
// tracks a local rename's own selection would.
//
// Roles merge, none is lost (decided 2026-10-21): when an alias folds two
// credits into one artist, the artist keeps every role the two carried — a
// main credit and a remixer credit of "Rho" and "Rho (NL)" stay a main and
// a remixer credit of "Rho (NL)", one each. Deduping by fold alone dropped
// whichever came second, and a remote row derived through the rule then lost
// the remixer the master showed (the 2026-10-21 replay: a real-library recording,
// "Night Tide - Rho, Vela, Orin Remix"). Two credits of one artist
// with the same role still collapse to the first.
export function mapCredits(list: readonly TrackArtist[] | null | undefined, target: (key: string) => string | undefined): { list: TrackArtist[]; changed: boolean } {
	if (!list || list.length === 0) return { list: list ? [...list] : [], changed: false };
	let hit = false;
	const mapped = list.map((el) => {
		const to = el && typeof el.name === 'string' ? target(artistKey(el.name)) : undefined;
		if (to === undefined) return el;
		hit = true;
		return to === el.name ? el : (el.role ? { name: to, role: el.role } : { name: to });
	});
	if (!hit) return { list: [...list], changed: false };
	let changed = false;
	const out: TrackArtist[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < mapped.length; i++) {
		const el = mapped[i]!;
		if (el !== list[i]) changed = true;
		// A credit without a role and a 'main' one are the same role.
		const key = `${searchFold(el.name)}\u0000${el.role && el.role !== 'main' ? el.role : 'main'}`;
		if (seen.has(key)) { changed = true; continue; }
		seen.add(key);
		out.push(el);
	}
	return { list: changed ? out : [...list], changed };
}

// ── the derivation ──────────────────────────────────────────────────────────

type CreditRow = { id: string; artists: string | null; artists_base: string | null; overrides: string | null };

type Rederived = { artists: TrackArtist[]; artistsBase: ArtistsBase | null; changed: boolean; baseChanged: boolean };

// A row's canonical credits under the resolved map: its source credits with
// every rule applied. `changed`: `artists` differs from the row's.
// `baseChanged`: the stored cell differs (a stale cell to clear, or a source
// spelling to record under unchanged credits).
function rederiveCredits(row: Pick<CreditRow, 'artists' | 'artists_base'>, alias: ReadonlyMap<string, ArtistAliasTarget>): Rederived {
	const canon = parseJson<TrackArtist[]>(row.artists) ?? [];
	const base = artistsBaseOf(row);
	const artists = mapCredits(base, (k) => alias.get(k)?.name).list;
	const artistsBase = artistsBaseCell(base, artists);
	const stored = parseJson<ArtistsBase>(row.artists_base);
	return {
		artists,
		artistsBase,
		changed: creditsKey(artists) !== creditsKey(canon),
		baseChanged: JSON.stringify(stored ?? null) !== JSON.stringify(artistsBase),
	};
}

const namesKey = (list: readonly TrackArtist[] | null | undefined, keys: ReadonlySet<string>): boolean =>
	Array.isArray(list) && list.some((a) => a && typeof a.name === 'string' && keys.has(artistKey(a.name)));

// Re-derives the canonical credits of those `trackIds` whose source or
// current credits name one of `keys`, writing `artists`, `artists_base` and
// the effective `artists_ascii`. Returns the rows whose `artists` changed;
// the caller re-derives the junction (it may have more rows to relink).
export function rederiveTrackCreditsRaw(raw: Raw, trackIds: readonly string[], keys: ReadonlySet<string>, alias: ReadonlyMap<string, ArtistAliasTarget> = loadArtistAliasMap(raw), now = Date.now()): string[] {
	const get = raw.prepare(`SELECT id, artists, artists_base, overrides FROM track WHERE id = ?`);
	const w = writers(raw);
	const out: string[] = [];
	for (const id of trackIds) {
		const r = get.get(id) as CreditRow | undefined;
		if (r && rederiveRow(r, keys, alias, now, w) === 'artists') out.push(id);
	}
	return out;
}

type Writers = { full: Database.Statement; base: Database.Statement };
function writers(raw: Raw): Writers {
	return {
		full: raw.prepare(`UPDATE track SET artists = ?, artists_base = ?, artists_ascii = ?, updated_at = ? WHERE id = ?`),
		base: raw.prepare(`UPDATE track SET artists_base = ? WHERE id = ?`),
	};
}

// 'artists' when the credits changed, 'base' when only the cell did, null
// when the row names no queued key or nothing moved.
function rederiveRow(r: CreditRow, keys: ReadonlySet<string>, alias: ReadonlyMap<string, ArtistAliasTarget>, now: number, w: Writers): 'artists' | 'base' | null {
	if (!namesKey(parseJson<TrackArtist[]>(r.artists), keys) && !namesKey(artistsBaseOf(r), keys)) return null;
	const d = rederiveCredits(r, alias);
	const cell = d.artistsBase ? JSON.stringify(d.artistsBase) : null;
	if (d.changed) {
		const ov = parseJson<TrackOverrides>(r.overrides);
		w.full.run(JSON.stringify(d.artists), cell, asciifyArtists(ov?.artists ?? d.artists), now, r.id);
		return 'artists';
	}
	if (d.baseChanged) {
		w.base.run(cell, r.id);
		return 'base';
	}
	return null;
}

// ── resolved rules ──────────────────────────────────────────────────────────

export function loadArtistAliasMap(raw: Raw): Map<string, ArtistAliasTarget> {
	const state = createLibraryState();
	for (const r of raw.prepare(`SELECT key, value FROM sync_state WHERE map = 'artistAliases'`).all() as Array<{ key: string; value: string }>) {
		state.artistAliases.set(r.key, JSON.parse(r.value) as ArtistAliasRecord);
	}
	rebuildArtistAlias(state);
	return state.artistAlias;
}

// ── artist-table projection ─────────────────────────────────────────────────

type ArtistRow = { id: string; name: string; name_ascii: string; merged_into: string | null };

export type ArtistAliasChange = { key: string; from: string | null; before: ArtistAliasTarget | null; after: ArtistAliasTarget | null };

// The resolved-map entries that differ between two rebuilds.
export function diffArtistAlias(
	before: ReadonlyMap<string, ArtistAliasTarget>,
	after: ReadonlyMap<string, ArtistAliasTarget>,
	fromOf: (key: string) => string | null,
): ArtistAliasChange[] {
	const out: ArtistAliasChange[] = [];
	for (const key of new Set([...before.keys(), ...after.keys()])) {
		const b = before.get(key) ?? null;
		const a = after.get(key) ?? null;
		if (b && a && b.name === a.name && b.key === a.key) continue;
		out.push({ key, from: fromOf(key), before: b, after: a });
	}
	return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

// Applies changed rules to the artist table (see the header, consumer 1)
// and queues the credit re-derivation for every key whose resolution moved.
// Runs inside the apply transaction; it touches a few artist rows per rule,
// never the tracks.
export function projectArtistAliasChanges(raw: Raw, changes: readonly ArtistAliasChange[]): void {
	if (changes.length === 0) return;
	const now = Date.now();
	const byFold = raw.prepare(`SELECT id, name, name_ascii, merged_into FROM artist WHERE name_ascii = ?`);
	const byId = raw.prepare(`SELECT id, name, name_ascii, merged_into FROM artist WHERE id = ?`);
	const fold = (k: string): ArtistRow | undefined => byFold.get(k) as ArtistRow | undefined;
	const resolve = (row: ArtistRow): ArtistRow => {
		let cur = row;
		for (let hops = 0; cur.merged_into && hops < 8; hops++) {
			const next = byId.get(cur.merged_into) as ArtistRow | undefined;
			if (!next) break;
			cur = next;
		}
		return cur;
	};
	const insert = (name: string, key: string, mergedInto: string | null, curated: boolean): ArtistRow => {
		const id = randomUUID();
		raw.prepare(`INSERT INTO artist (id, name, name_ascii, merged_into, name_curated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(id, name, key, mergedInto, curated ? now : null, now, now);
		return { id, name, name_ascii: key, merged_into: mergedInto };
	};
	const rewriteKeys = new Set<string>();
	let merged = false;

	// Withdrawn first: a cycle broken by a later rule withdraws the earlier
	// one's alias row before the later rule reclaims that key.
	for (const c of changes) {
		if (c.after) continue;
		// Its tracks re-derive to their source spelling (header, `remove`).
		rewriteKeys.add(c.key);
		const row = fold(c.key);
		if (!row) continue;
		if (row.merged_into) raw.prepare(`DELETE FROM artist WHERE id = ?`).run(row.id);
		else if (c.before?.key === c.key) raw.prepare(`UPDATE artist SET name_curated_at = NULL, updated_at = ? WHERE id = ?`).run(now, row.id);
	}

	// Renames before spellings, so a rename that moves a row to a new key
	// lands first and the spelling rule then finds that row.
	const renames = changes.filter((c) => c.after && c.after.key !== c.key);
	const spellings = changes.filter((c) => c.after && c.after.key === c.key);
	for (const c of renames) {
		const t = c.after!;
		rewriteKeys.add(c.key);
		const kRow = fold(c.key);
		const kLive = kRow ? resolve(kRow) : null;
		let tRow = fold(t.key);
		// The target key is an alias INTO this artist (renaming back to an
		// earlier spelling): reclaim it, as renameArtist does locally.
		if (tRow && kLive && tRow.id !== kLive.id && resolve(tRow).id === kLive.id) {
			raw.prepare(`DELETE FROM artist WHERE id = ?`).run(tRow.id);
			tRow = undefined;
		}
		if (!tRow && kRow && !kRow.merged_into) {
			// The plain rename: the row (and its links, releases, id) moves
			// to the new key, an alias parks under the old one.
			raw.prepare(`UPDATE artist SET name = ?, name_ascii = ?, updated_at = ? WHERE id = ?`).run(t.name, t.key, now, kRow.id);
			insert(c.from ?? kRow.name, c.key, kRow.id, false);
			continue;
		}
		const target = tRow ? resolve(tRow) : insert(t.name, t.key, null, false);
		if (target.name_ascii === t.key && target.name !== t.name) raw.prepare(`UPDATE artist SET name = ?, updated_at = ? WHERE id = ?`).run(t.name, now, target.id);
		if (!kRow) {
			insert(c.from ?? t.name, c.key, target.id, false);
		} else if (kRow.merged_into) {
			if (kLive!.id !== target.id) raw.prepare(`UPDATE artist SET merged_into = ?, updated_at = ? WHERE id = ?`).run(target.id, now, kRow.id);
		} else if (kRow.id !== target.id) {
			// A merge, as mergeArtists does it: the row and every alias of it
			// point at the survivor. Aliases only this device knew get their
			// credits' junction re-derived by the job too (keys with no rule
			// map to nothing, so they are re-linked, not renamed).
			for (const a of raw.prepare(`SELECT name_ascii FROM artist WHERE merged_into = ?`).all(kRow.id) as Array<{ name_ascii: string }>) rewriteKeys.add(a.name_ascii);
			raw.prepare(`UPDATE artist SET merged_into = ?, updated_at = ? WHERE id = ?`).run(target.id, now, kRow.id);
			raw.prepare(`UPDATE artist SET merged_into = ?, updated_at = ? WHERE merged_into = ? AND id != ?`).run(target.id, now, kRow.id, target.id);
			merged = true;
		}
	}
	for (const c of spellings) {
		const t = c.after!;
		rewriteKeys.add(c.key);
		const row = fold(c.key);
		if (!row) insert(t.name, c.key, null, true);
		else if (!row.merged_into) raw.prepare(`UPDATE artist SET name = ?, name_curated_at = ?, updated_at = ? WHERE id = ?`).run(t.name, now, now, row.id);
	}
	if (merged) healAlbumArtistAliasesRaw(raw);
	queueArtistCreditRewrite(raw, [...rewriteKeys]);
}

// ── the credit rewrite job ──────────────────────────────────────────────────
// Device-local state in app_setting (never an account key): FIFO jobs, each
// a key set and the last track id scanned (the id, not the rowid: a VACUUM
// may renumber rowids of a table without an INTEGER PRIMARY KEY).

export const ARTIST_REWRITE_KEY = 'sync.artist_rewrite';

type Job = { keys: string[]; after: string };

function readJobs(raw: Raw): Job[] {
	const row = raw.prepare(`SELECT value FROM app_setting WHERE key = ?`).get(ARTIST_REWRITE_KEY) as { value: string } | undefined;
	if (!row) return [];
	try {
		const v = JSON.parse(row.value) as unknown;
		return Array.isArray(v) ? (v as Job[]).filter((j) => Array.isArray(j?.keys) && typeof j.after === 'string') : [];
	} catch {
		return [];
	}
}

function writeJobs(raw: Raw, jobs: Job[]): void {
	if (jobs.length === 0) {
		raw.prepare(`DELETE FROM app_setting WHERE key = ?`).run(ARTIST_REWRITE_KEY);
		return;
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(ARTIST_REWRITE_KEY, JSON.stringify(jobs), Date.now());
}

export function queueArtistCreditRewrite(raw: Raw, keys: readonly string[]): void {
	if (keys.length === 0) return;
	const jobs = readJobs(raw);
	// A job that has not scanned a row yet takes the new keys too: a burst
	// of rules over several pull pages is one library scan, not one each.
	const fresh = jobs.find((j) => j.after === '');
	if (fresh) fresh.keys = [...new Set([...fresh.keys, ...keys])].sort();
	else jobs.push({ keys: [...new Set(keys)].sort(), after: '' });
	writeJobs(raw, jobs);
}

// Once (gate key below): every rule's credits re-derived under the role-
// merging mapCredits. Rows a rule rewrote before it lost a role the rule
// collapsed; rows ingested while a rule stood (normalize substitutes the
// spelling, then reads remixers off the title) hold credits mapCredits
// would not produce, so the device stating them and a device deriving them
// disagreed. After this every row's credits are f(source credits, rules)
// again, on every device.
export const ROLE_MERGE_REDERIVE_KEY = 'artist.rederive_role_merge_v1_at';
export function queueRoleMergeRederive(raw: Raw): number {
	if (raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(ROLE_MERGE_REDERIVE_KEY)) return 0;
	const keys = new Set<string>();
	for (const r of raw.prepare(`SELECT key, value FROM sync_state WHERE map = 'artistAliases'`).all() as Array<{ key: string; value: string }>) {
		keys.add(r.key);
		const to = parseJson<{ value?: { to_key?: string } | null }>(r.value)?.value?.to_key;
		if (to) keys.add(to);
	}
	queueArtistCreditRewrite(raw, [...keys]);
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`).run(ROLE_MERGE_REDERIVE_KEY, JSON.stringify(Date.now()), Date.now());
	return keys.size;
}

export function artistCreditRewritePending(raw: Raw): boolean {
	return readJobs(raw).length > 0;
}

// `tracks`: every row rewritten or re-linked, for the renderer's refresh.
export type DrainResult = { rowsScanned: number; tracksRewritten: number; tracks: string[]; done: boolean };

function parseJson<T>(v: string | null): T | null {
	if (!v) return null;
	try { return JSON.parse(v) as T; } catch { return null; }
}

// Scans up to `maxRows` track rows (in id order) of the queued jobs,
// re-deriving the canonical credits of every track whose source or current
// credits name a queued key (from the converged map, header consumer 2) and
// re-linking every track whose effective list names one. One transaction (a
// savepoint inside the caller's).
export function drainArtistCreditRewrites(raw: Raw, opts: { maxRows?: number } = {}): DrainResult {
	const budget = Math.max(1, opts.maxRows ?? Number.MAX_SAFE_INTEGER);
	return raw.transaction((): DrainResult => {
		const jobs = readJobs(raw);
		const res: DrainResult = { rowsScanned: 0, tracksRewritten: 0, tracks: [], done: jobs.length === 0 };
		if (jobs.length === 0) return res;
		const alias = loadArtistAliasMap(raw);
		const page = raw.prepare(`SELECT id, artists, artists_base, overrides FROM track WHERE id > ? ORDER BY id LIMIT ?`);
		const w = writers(raw);
		const now = Date.now();
		while (jobs.length > 0 && res.rowsScanned < budget) {
			const job = jobs[0]!;
			const keys = new Set(job.keys);
			const limit = Math.min(1_000, budget - res.rowsScanned);
			const rows = page.all(job.after, limit) as CreditRow[];
			const relink: string[] = [];
			for (const r of rows) {
				const done = rederiveRow(r, keys, alias, now, w);
				if (done === 'artists') res.tracksRewritten++;
				if (done === 'artists' || namesKey(parseJson<TrackOverrides>(r.overrides)?.artists, keys) || namesKey(parseJson<TrackArtist[]>(r.artists), keys)) relink.push(r.id);
			}
			if (relink.length > 0) {
				syncTrackArtistsByIdRaw(raw, relink);
				res.tracks.push(...relink);
			}
			res.rowsScanned += rows.length;
			if (rows.length > 0) job.after = rows[rows.length - 1]!.id;
			if (rows.length < limit) jobs.shift();
		}
		writeJobs(raw, jobs);
		res.done = jobs.length === 0;
		return res;
	})();
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// The event-loop-friendly driver: `chunk` rows per transaction, a yield
// between. Returns the longest synchronous slice, the worst stall it caused.
export async function drainArtistCreditRewritesAsync(raw: Raw, opts: { chunk?: number; signal?: { aborted: boolean } } = {}): Promise<DrainResult & { chunks: number; maxSliceMs: number }> {
	const chunk = Math.max(1, Math.min(5_000, opts.chunk ?? 1_000));
	const total: DrainResult & { chunks: number; maxSliceMs: number } = { rowsScanned: 0, tracksRewritten: 0, tracks: [], done: false, chunks: 0, maxSliceMs: 0 };
	for (;;) {
		if (opts.signal?.aborted) return total;
		const t0 = performance.now();
		const r = drainArtistCreditRewrites(raw, { maxRows: chunk });
		total.maxSliceMs = Math.max(total.maxSliceMs, performance.now() - t0);
		total.chunks++;
		total.rowsScanned += r.rowsScanned;
		total.tracksRewritten += r.tracksRewritten;
		total.tracks.push(...r.tracks);
		if (r.done) { total.done = true; return total; }
		await yieldToLoop();
	}
}
