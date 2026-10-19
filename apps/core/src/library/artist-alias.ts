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
//      no op) are rewritten by `mapCredits` — the same transform the local
//      rename runs — so both devices end with identical lists.
//   3. Override lists are NOT rewritten on apply: they are op-log records
//      (set-override), and the renaming device emits set-override ops for
//      every override list its rewrite changed, in the same transaction as
//      the rule. Rewriting them here as well would leave the visible row
//      ahead of its record, and the next projection of that record (a rating
//      op, say) would put the old name back.
//
// The canonical rewrite on apply is a scan of every track (a credit hidden
// under an override list is still rewritten, and the junction cannot find
// those), so it is a persisted job drained in row-id chunks: a little inline
// at apply (enough for a small library), the rest by the sync client between
// pull pages with the event loop yielding between chunks. A crash mid-job
// resumes from the stored cursor. Ingest is correct from the apply commit
// on, because (1) happens inside the apply transaction.
//
// `remove` stops a rule applying to credits that arrive afterwards (its alias
// row goes, a spelling rule's curated mark is cleared). It never un-rewrites
// credits a rule already rewrote; renaming back is a new rule.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createLibraryState, rebuildArtistAlias, type ArtistAliasRecord, type ArtistAliasTarget } from '@curator/protocol';
import { artistKey, asciifyArtists, searchFold } from '@curator/shared';
import type { TrackArtist, TrackOverrides } from '@curator/shared/schema';
import { healAlbumArtistAliasesRaw } from './albums.js';
import { syncTrackArtistsByIdRaw } from './artists.js';

type Raw = Database.Database;

// ── the shared credit transform ─────────────────────────────────────────────

// Every credit whose artist key `target` maps is written with the mapped
// name; credits that collapse onto one spelling are deduped by fold. A list
// none of whose keys map is returned untouched (even if it already holds a
// duplicate), so a whole-library scan changes exactly the tracks a local
// rename's own selection would.
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
		const key = searchFold(el.name);
		if (seen.has(key)) { changed = true; continue; }
		seen.add(key);
		out.push(el);
	}
	return { list: changed ? out : [...list], changed };
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
// and queues the credit rewrite for them. Runs inside the apply transaction;
// it touches a few artist rows per rule, never the tracks.
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

export function artistCreditRewritePending(raw: Raw): boolean {
	return readJobs(raw).length > 0;
}

// `tracks`: every row rewritten or re-linked, for the renderer's refresh.
export type DrainResult = { rowsScanned: number; tracksRewritten: number; tracks: string[]; done: boolean };

function parseJson<T>(v: string | null): T | null {
	if (!v) return null;
	try { return JSON.parse(v) as T; } catch { return null; }
}

// Scans up to `maxRows` track rows (in id order) of the queued jobs, rewriting canonical
// credits and re-deriving the junction of every track whose effective list
// names a queued key. One transaction (a savepoint inside the caller's).
export function drainArtistCreditRewrites(raw: Raw, opts: { maxRows?: number } = {}): DrainResult {
	const budget = Math.max(1, opts.maxRows ?? Number.MAX_SAFE_INTEGER);
	return raw.transaction((): DrainResult => {
		const jobs = readJobs(raw);
		const res: DrainResult = { rowsScanned: 0, tracksRewritten: 0, tracks: [], done: jobs.length === 0 };
		if (jobs.length === 0) return res;
		const alias = loadArtistAliasMap(raw);
		const page = raw.prepare(`SELECT id, artists, overrides FROM track WHERE id > ? ORDER BY id LIMIT ?`);
		const update = raw.prepare(`UPDATE track SET artists = ?, artists_ascii = ?, updated_at = ? WHERE id = ?`);
		const now = Date.now();
		while (jobs.length > 0 && res.rowsScanned < budget) {
			const job = jobs[0]!;
			const keys = new Set(job.keys);
			const target = (k: string): string | undefined => (keys.has(k) ? alias.get(k)?.name : undefined);
			const limit = Math.min(1_000, budget - res.rowsScanned);
			const rows = page.all(job.after, limit) as Array<{ id: string; artists: string | null; overrides: string | null }>;
			const relink: string[] = [];
			for (const r of rows) {
				const canon = parseJson<TrackArtist[]>(r.artists) ?? [];
				const ov = parseJson<TrackOverrides>(r.overrides);
				const m = mapCredits(canon, target);
				const effective = ov?.artists ?? (m.changed ? m.list : canon);
				if (m.changed) {
					update.run(JSON.stringify(m.list), asciifyArtists(effective), now, r.id);
					res.tracksRewritten++;
				}
				if (m.changed || (Array.isArray(effective) && effective.some((a) => a && typeof a.name === 'string' && keys.has(artistKey(a.name))))) relink.push(r.id);
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
