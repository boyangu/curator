// Claim-derived provider links (the 2026-10-21 second-desktop gap): the
// Spotify / Tidal / Beatport ids this device knows for a row only from the
// account's recording claims. source_link is device-local — a device only
// had the links its own syncs and matchers made — so a second desktop showed
// empty Tidal URLs for ~4k tracks the main desktop's hybrid matcher had
// linked, and every remote row (remote-rows.ts) showed none at all.
//
// The claims already carry them: every device states the provider ids its
// rows hold (`recording_claim` kind spotify / tidal / beatport; the streaming
// upserts, the hybrid matcher, enrichment, the Edit screen, the claims
// backfill). This materialises, per row of a recording, the best claim of
// each provider kind the row has no own link for, into claim_link — a table
// of its own (schema.ts claimLink says why it is not source_link).
//
// What a derived link is for: display (Edit screen URLs, a muted SRC pip,
// Open-in / Copy URL) and the hybrid matcher's "already matched". What it
// is never for: anything that reads source_link — upstream pushes and
// removals, remote → own conversion, membership, identity's own rows, the
// initial push and claims backfill. Those cannot see it. Derivation writes
// only claim_link / claim_link_pending and emits nothing: the claims ARE
// the record, and a derived link restated as a claim would be this device
// vouching for a track it never ingested.
//
// Which claim: the highest confidence (1 = minted from / found by that id,
// 0.9 an ISRC bind, 0.7 a content bind), then the latest — claims are
// append-only, so a changed link shows as a newer claim — then the smallest
// value, so every device picks the same one. A value this device dropped
// from the row on purpose (claim_link_veto) is skipped.
//
// Kept in step by: the projection (project.ts queues every recording whose
// claims a batch changed, and both sides of a merge), triggers on track (a
// row appears or is rebound) and source_link (an own link replaces the
// derived one in the same statement; a dropped one re-derives), a sliced
// drain in the sync client, and a one-time sweep over every row
// (CLAIM_LINKS_SWEEP_KEY) for libraries that had claims before this.

import type Database from 'better-sqlite3';

type Raw = Database.Database;

export const CLAIM_LINK_SOURCES = ['spotify', 'tidal', 'beatport'] as const;
export type ClaimLinkSource = (typeof CLAIM_LINK_SOURCES)[number];
const IS_SOURCE = new Set<string>(CLAIM_LINK_SOURCES);

export const CLAIM_LINKS_SWEEP_KEY = 'sync.claim_links_at';

// The canonical web URL of a provider id — the same forms the Edit screen
// and the context menu derive for a link stored without one.
export function claimLinkUrl(source: string, id: string): string | null {
	switch (source) {
		case 'spotify': return `https://open.spotify.com/track/${id}`;
		case 'tidal': return `https://tidal.com/browse/track/${id}`;
		case 'beatport': return `https://www.beatport.com/track/-/${id}`;
		default: return null;
	}
}

// Recordings per derivation pass: one IN list for the claims, one for the
// rows (a recording has one or two), each well under SQLite's bound limit.
const CHUNK = 400;

type ClaimRow = { rec: string; kind: string; value: string; conf: number | null; ts: number | null; dev: string | null; op: string | null };

// Best first: confidence, then clock (ts, device, op — protocol compareClock
// order), then value.
function better(a: ClaimRow, b: ClaimRow): number {
	const ca = a.conf ?? 0;
	const cb = b.conf ?? 0;
	if (ca !== cb) return cb - ca;
	if ((a.ts ?? 0) !== (b.ts ?? 0)) return (b.ts ?? 0) - (a.ts ?? 0);
	if ((a.dev ?? '') !== (b.dev ?? '')) return (a.dev ?? '') < (b.dev ?? '') ? 1 : -1;
	if ((a.op ?? '') !== (b.op ?? '')) return (a.op ?? '') < (b.op ?? '') ? 1 : -1;
	return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',');

// Re-derive the claim links of every row of these recordings against the
// records as they stand. Runs inside the caller's transaction; writes only
// what differs. Returns the rows whose links changed (for the renderer).
export function deriveClaimLinks(raw: Raw, recordingIds: Iterable<string>): string[] {
	const all = [...new Set(recordingIds)].filter((r) => r);
	const touched = new Set<string>();
	for (let i = 0; i < all.length; i += CHUNK) {
		for (const t of deriveChunk(raw, all.slice(i, i + CHUNK))) touched.add(t);
	}
	return [...touched];
}

function deriveChunk(raw: Raw, recs: readonly string[]): string[] {
	const touched: string[] = [];
	// `+map`: through the recording index, not the (map, parent_id) one —
	// the claims map is ~100k records on a real library.
	const claims = raw.prepare(`SELECT recording_id AS rec, json_extract(value, '$.kind') AS kind, json_extract(value, '$.value') AS value,
			json_extract(value, '$.cell.value.confidence') AS conf, json_extract(value, '$.cell.clock.ts') AS ts,
			json_extract(value, '$.cell.clock.device') AS dev, json_extract(value, '$.cell.clock.op') AS op
		FROM sync_state WHERE recording_id IN (${marks(recs.length)}) AND +map = 'claims'`).all(...recs) as ClaimRow[];
	const byRec = new Map<string, Map<string, ClaimRow[]>>();
	for (const c of claims) {
		if (!IS_SOURCE.has(c.kind) || !c.value) continue;
		let kinds = byRec.get(c.rec);
		if (!kinds) byRec.set(c.rec, (kinds = new Map()));
		let list = kinds.get(c.kind);
		if (!list) kinds.set(c.kind, (list = []));
		list.push(c);
	}
	for (const kinds of byRec.values()) for (const list of kinds.values()) list.sort(better);

	// Every catalogue row of these recordings — own or remote, live or
	// deleted (a deleted row still shows in followed playlists). Never a
	// derived WAV copy.
	const rows = raw.prepare(`SELECT id, recording_id AS rec FROM track WHERE recording_id IN (${marks(recs.length)}) AND derived_from_track_id IS NULL`)
		.all(...recs) as Array<{ id: string; rec: string }>;
	const ids = rows.map((r) => r.id);
	const own = new Set<string>();
	const veto = new Set<string>();
	const have = new Map<string, { value: string; rec: string }>();
	if (ids.length > 0) {
		for (const l of raw.prepare(`SELECT track_id AS t, source AS s FROM source_link WHERE track_id IN (${marks(ids.length)}) AND source IN ('spotify', 'tidal', 'beatport')`)
			.all(...ids) as Array<{ t: string; s: string }>) own.add(`${l.t}\u0000${l.s}`);
		for (const v of raw.prepare(`SELECT track_id AS t, source AS s, source_track_id AS v FROM claim_link_veto WHERE track_id IN (${marks(ids.length)})`)
			.all(...ids) as Array<{ t: string; s: string; v: string }>) veto.add(`${v.t}\u0000${v.s}\u0000${v.v}`);
		for (const l of raw.prepare(`SELECT track_id AS t, source AS s, source_track_id AS v, recording_id AS rec FROM claim_link WHERE track_id IN (${marks(ids.length)})`)
			.all(...ids) as Array<{ t: string; s: string; v: string; rec: string }>) have.set(`${l.t}\u0000${l.s}`, { value: l.v, rec: l.rec });
	}

	const put = raw.prepare(`INSERT INTO claim_link (track_id, source, source_track_id, recording_id) VALUES (?, ?, ?, ?)
		ON CONFLICT(track_id, source) DO UPDATE SET source_track_id = excluded.source_track_id, recording_id = excluded.recording_id`);
	const drop = raw.prepare(`DELETE FROM claim_link WHERE track_id = ? AND source = ?`);
	for (const row of rows) {
		let changed = false;
		const kinds = byRec.get(row.rec);
		for (const source of CLAIM_LINK_SOURCES) {
			const key = `${row.id}\u0000${source}`;
			const cur = have.get(key);
			const pick = own.has(key) ? undefined : kinds?.get(source)?.find((c) => !veto.has(`${key}\u0000${c.value}`));
			if (!pick) {
				if (cur) { drop.run(row.id, source); changed = true; }
				continue;
			}
			if (cur && cur.value === pick.value && cur.rec === row.rec) continue;
			put.run(row.id, source, pick.value, row.rec);
			changed = true;
		}
		if (changed) touched.push(row.id);
	}
	// A row rebound away from one of these recordings keeps nothing derived
	// from it (the rebind trigger drops them too; this covers a raw handle
	// that wrote the row before the trigger existed).
	const kept = new Set(ids);
	for (const t of raw.prepare(`SELECT DISTINCT track_id FROM claim_link WHERE recording_id IN (${marks(recs.length)})`).pluck().all(...recs) as string[]) {
		if (kept.has(t)) continue;
		raw.prepare(`DELETE FROM claim_link WHERE track_id = ? AND recording_id IN (${marks(recs.length)})`).run(t, ...recs);
		touched.push(t);
	}
	return touched;
}

// ── queue + drain ───────────────────────────────────────────────────────────

export function queueClaimLinks(raw: Raw, recordingIds: Iterable<string>): void {
	const q = raw.prepare(`INSERT OR IGNORE INTO claim_link_pending (recording_id) VALUES (?)`);
	for (const r of new Set(recordingIds)) if (r) q.run(r);
}

export function claimLinkPendingCount(raw: Raw): number {
	return raw.prepare(`SELECT count(*) FROM claim_link_pending`).pluck().get() as number;
}

// Whether at most `n` recordings are queued — bounded, so a projection can
// ask on every batch without counting a fresh device's 40k.
export function claimLinkPendingAtMost(raw: Raw, n: number): boolean {
	return (raw.prepare(`SELECT count(*) FROM (SELECT 1 FROM claim_link_pending LIMIT ?)`).pluck().get(n + 1) as number) <= n;
}

// Up to this many queued recordings a projection derives inline (a merge,
// another device's new claims, a bound import of a few tracks); more are
// left to the client's yielding drain.
export const INLINE_CLAIM_LINK_RECORDINGS = 50;

// One slice, inside the caller's transaction: up to `max` queued recordings
// derived and dequeued. Returns the rows whose links changed.
export function drainClaimLinksRaw(raw: Raw, max: number): { recordings: number; tracks: string[] } {
	const recs = raw.prepare(`SELECT recording_id FROM claim_link_pending LIMIT ?`).pluck().all(Math.max(1, max)) as string[];
	if (recs.length === 0) return { recordings: 0, tracks: [] };
	const tracks = deriveClaimLinks(raw, recs);
	for (let i = 0; i < recs.length; i += CHUNK) {
		const c = recs.slice(i, i + CHUNK);
		raw.prepare(`DELETE FROM claim_link_pending WHERE recording_id IN (${marks(c.length)})`).run(...c);
	}
	return { recordings: recs.length, tracks };
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export type ClaimLinkRun = { recordings: number; tracks: string[]; chunks: number; maxSliceMs: number };

// The queue, `chunk` recordings per transaction with a yield between.
// 400 a slice: measured on a 40k-row copy of the second desktop's library
// (2026-10-21) at well under the 100 ms slice budget.
export async function drainClaimLinksAsync(raw: Raw, opts: { chunk?: number } = {}): Promise<ClaimLinkRun> {
	const chunk = Math.max(1, opts.chunk ?? 400);
	const out: ClaimLinkRun = { recordings: 0, tracks: [], chunks: 0, maxSliceMs: 0 };
	const tracks = new Set<string>();
	for (;;) {
		const t0 = performance.now();
		const r = raw.transaction(() => drainClaimLinksRaw(raw, chunk))();
		if (r.recordings === 0) break;
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.recordings += r.recordings;
		out.chunks++;
		for (const t of r.tracks) tracks.add(t);
		await yieldToLoop();
	}
	out.tracks = [...tracks];
	return out;
}

// ── the one-time sweep ──────────────────────────────────────────────────────

export function claimLinksSwept(raw: Raw): boolean {
	return raw.prepare(`SELECT 1 FROM app_setting WHERE key = ?`).get(CLAIM_LINKS_SWEEP_KEY) !== undefined;
}

// Every row's recording, in pages of `page` recordings (keyset over the
// recording index), each derived in its own transaction with a yield
// between. The gate key is set only by a run that finished: an interrupted
// one starts over (each page is idempotent and writes only differences).
export async function sweepClaimLinksAsync(raw: Raw, opts: { page?: number } = {}): Promise<ClaimLinkRun> {
	const page = Math.max(1, opts.page ?? 400);
	const out: ClaimLinkRun = { recordings: 0, tracks: [], chunks: 0, maxSliceMs: 0 };
	const tracks = new Set<string>();
	const next = raw.prepare(`SELECT DISTINCT recording_id FROM track WHERE recording_id > ? ORDER BY recording_id LIMIT ?`).pluck();
	// No provider claim in the records (a library that never linked a
	// streaming or Beatport id): nothing to derive, no page to walk.
	for (let after = hasProviderClaims(raw) ? '' : null; after !== null;) {
		const t0 = performance.now();
		const recs = next.all(after, page) as string[];
		if (recs.length === 0) break;
		after = recs[recs.length - 1]!;
		const changed = raw.transaction(() => deriveClaimLinks(raw, recs))();
		out.maxSliceMs = Math.max(out.maxSliceMs, performance.now() - t0);
		out.recordings += recs.length;
		out.chunks++;
		for (const t of changed) tracks.add(t);
		await yieldToLoop();
	}
	raw.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
		.run(CLAIM_LINKS_SWEEP_KEY, JSON.stringify(Date.now()), Date.now());
	out.tracks = [...tracks];
	return out;
}

// One range probe per kind on the claims' (map, parent_id) index
// (parent_id = `${kind}:${value}`, store.ts claimParentId).
function hasProviderClaims(raw: Raw): boolean {
	const probe = raw.prepare(`SELECT 1 FROM sync_state WHERE map = 'claims' AND parent_id >= ? AND parent_id < ? LIMIT 1`);
	return CLAIM_LINK_SOURCES.some((k) => probe.get(`${k}:`, `${k};`) !== undefined);
}

// ── readers (display only) ──────────────────────────────────────────────────

export type ClaimLinkRead = { source: ClaimLinkSource; sourceTrackId: string };

// The derived links of these rows, batched (500 per IN list, like every
// decorate read in service.ts).
export function claimLinksOf(raw: Raw, trackIds: readonly string[]): Map<string, ClaimLinkRead[]> {
	const out = new Map<string, ClaimLinkRead[]>();
	for (let i = 0; i < trackIds.length; i += 500) {
		const chunk = trackIds.slice(i, i + 500);
		for (const r of raw.prepare(`SELECT track_id AS t, source AS s, source_track_id AS v FROM claim_link WHERE track_id IN (${marks(chunk.length)})`)
			.all(...chunk) as Array<{ t: string; s: ClaimLinkSource; v: string }>) {
			let list = out.get(r.t);
			if (!list) out.set(r.t, (list = []));
			list.push({ source: r.s, sourceTrackId: r.v });
		}
	}
	return out;
}

// Drop a row's derived link for one provider and keep it dropped (the user
// cleared it on the Edit screen). Returns whether one was there.
export function dismissClaimLink(raw: Raw, trackId: string, source: string): boolean {
	const cur = raw.prepare(`SELECT source_track_id FROM claim_link WHERE track_id = ? AND source = ?`).pluck().get(trackId, source) as string | undefined;
	if (cur === undefined) return false;
	raw.prepare(`INSERT OR IGNORE INTO claim_link_veto (track_id, source, source_track_id) VALUES (?, ?, ?)`).run(trackId, source, cur);
	raw.prepare(`DELETE FROM claim_link WHERE track_id = ? AND source = ?`).run(trackId, source);
	// Another claim of that provider may stand in for it.
	const rec = raw.prepare(`SELECT recording_id FROM track WHERE id = ?`).pluck().get(trackId) as string | undefined;
	if (rec) deriveClaimLinks(raw, [rec]);
	return true;
}
