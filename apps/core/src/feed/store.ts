// FeedStore — abstract storage contract for the Discover feed, plus the
// local SQLite implementation over a separate feed.db.
//
// Why a separate DB + abstract interface: the feed is high-churn and
// disposable while the library is sacred — keeping it out of curator.db
// avoids bloating the library file/backups and keeps migration paths
// independent. The interface is the cloud seam: today SqliteFeedStore,
// later a server-side store consumed over the same method shapes. No
// foreign keys cross the two databases — items reference remote content
// by source ids; `promoted_track_id` is a soft reference only.

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
	EnrichStatus,
	FeedItem,
	FeedItemDetail,
	FeedItemDraft,
	FeedItemPayload,
	FeedItemState,
	FeedOrigin,
	FeedPage,
	FeedSignalInput,
	FeedSuppressionScope,
	FeedDecisionsDump,
	SyncedFeedItem,
	SyncedFeedSuppression,
} from './types.js';
import { recordingKeysFor } from './recording.js';

// Ranking lift per EXTRA source (beyond the first) that surfaced an item —
// a recording several followed playlists/artists independently picked is a
// stronger signal than a one-off add, so it sorts above same-age single-source
// items. Additive on order_ts (ordering-only, never displayed); 3 days ≈ one
// "screen" of a typical feed, enough to be noticed without burying news.
const MULTI_SOURCE_BOOST_MS = 3 * 24 * 60 * 60 * 1000;

// Item states the user has acted on — a recording carried by one of these
// TRACK items is "handled", so a later release made up only of handled
// recordings stays hidden (see reconcile).
const HANDLED_STATES = `('archived','dismissed','promoted')`;
const VISIBLE_STATES = `('fresh','seen','expanded')`;

// Optional genre/label narrowing for the live feed. Matched against the
// item-level payload.genre/label — for album items that's the rollup derived
// from the per-track enrichment (see FeedEnrichmentQueue.applyAlbumGenreLabel),
// for track items their own enriched value. Backed by expression indexes on
// json_extract so the predicate stays sargable.
export interface FeedFilter {
	genre?: string | null;
	label?: string | null;
}

export interface FeedStore {
	upsertItems(drafts: FeedItemDraft[]): Promise<{ inserted: number }>;
	getPage(req?: { cursor?: string | null; limit?: number } & FeedFilter): Promise<FeedPage>;
	// Distinct genre/label values across the currently-visible feed — populates
	// the filter dropdowns. Sorted, non-null only.
	filterOptions(): Promise<{ genres: string[]; labels: string[] }>;
	// The Archived page — items the user set aside (state='archived'), newest
	// first. No suppression filter: archiving is an explicit per-item choice,
	// so muted scopes don't hide them here.
	getArchivedPage(req?: { cursor?: string | null; limit?: number }): Promise<FeedPage>;
	getItem(itemId: string): Promise<FeedItem | null>;
	getItemDetail(itemId: string): Promise<FeedItemDetail | null>;
	// Cache lazily-resolved payload additions (e.g. album tracklists) back
	// onto the row so the next expand is free.
	setPayload(itemId: string, payload: FeedItemPayload): Promise<void>;
	recordSignal(signal: FeedSignalInput): Promise<void>;
	addSuppression(scope: FeedSuppressionScope, key: string): Promise<void>;
	markState(
		itemId: string,
		state: FeedItemState,
		extra?: { playedAt?: number; promotedTrackId?: string },
	): Promise<void>;
	// Reverse of a track-item promotion: return it to the visible feed (state
	// 'seen') AND clear the now-deleted library reference. markState can't clear
	// promoted_track_id (it COALESCEs to keep the old value), so this is separate.
	clearPromotion(itemId: string): Promise<void>;
	// Library track merge: every item promoted to `fromTrackId` now points at
	// the surviving row. Soft reference, so this is a plain UPDATE.
	repointPromotedTrack(fromTrackId: string, toTrackId: string): Promise<number>;
	markPlayed(itemId: string): Promise<void>;
	// Flag a source track as unplayable in the account's market (reactive
	// play-failure probe). Global by source-track id — not per item — so the
	// same recording surfacing via several items reflects everywhere.
	markUnavailable(sourceTrackId: string): Promise<void>;
	// ── account decisions (protocol v4; feed/sync.ts) ──
	// This device's decisions, for the one-time statement to the op log.
	decisionsDump(): FeedDecisionsDump;
	// Decisions another device made, onto the items (by dedupe key) and the
	// suppression table. Returns the items changed.
	applySyncedDecisions(items: readonly SyncedFeedItem[], suppressions: readonly SyncedFeedSuppression[]): number;
	// What the account decided about items a producer is about to insert:
	// applied in the insert's own transaction, so a re-surfacing item never
	// shows before its decision lands.
	setDecisionSource(fn: ((dedupeKeys: readonly string[]) => SyncedFeedItem[]) | null): void;
	getCursor(producerId: string): Promise<unknown>;
	setCursor(producerId: string, cursor: unknown): Promise<void>;
	// Drop un-acted items older than the cutoff. Dismissed/promoted rows are
	// kept — they're tuning data.
	prune(olderThanMs: number): Promise<number>;
	// Unfollow eviction for an artist or playlist follow. Among <kind>-origin
	// items that credit `id` (via the 'artist:<id>' / 'playlist:<id>' key),
	// hard-delete only those for which NO other credited <kind> is still
	// followed — an item shared with a follow you keep stays. Selected by
	// credited key (not origin), so it survives the dedup race and a later
	// unfollow of the co-credit catches it without re-pointing the origin.
	// Returns rows removed.
	removeOriginItems(kind: 'artist' | 'playlist', id: string, stillFollowed: Set<string>): Promise<number>;
	// Cross-source accrual for drafts whose dedupeKey is ALREADY stored: record
	// each draft's suppress keys + named origin against the existing row (the
	// "+N sources" set, unfollow/mute coverage) and re-rank it. Called by the
	// FeedDedupFilter for the repeats it drops pre-bus — without this, a track
	// surfacing via a second playlist on a later poll left no trace.
	accrueSources(drafts: FeedItemDraft[]): Promise<void>;
	// Enrichment worklist, newest first: visible track items, plus album items
	// whose tracklist is resolved (per-track enrichment), that the enricher
	// pass hasn't touched yet.
	listUnenriched(limit: number): Promise<FeedItem[]>;
	// Record an enrichment attempt: stamp enriched_at + set enrich_status (the
	// outcome), and persist the merged payload when an enricher produced one.
	// 'ok'/'na' are terminal; 'err' leaves the row eligible for the next drain.
	markEnriched(itemId: string, status: EnrichStatus, payload?: FeedItemPayload): Promise<void>;
	// Pre-bus filter probes (see pipeline.ts): the subset of `keys` already
	// stored (feed-dedup filter), and every suppression key for a scope
	// (artist-dismiss filter).
	existingDedupeKeys(keys: string[]): Promise<Set<string>>;
	suppressedKeys(scope: FeedSuppressionScope): Promise<Set<string>>;
	close(): void;
}

const SCHEMA_VERSION = 8;

const DDL = `
CREATE TABLE IF NOT EXISTS feed_meta (
	key TEXT PRIMARY KEY,
	value TEXT
);
CREATE TABLE IF NOT EXISTS feed_item (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	source TEXT NOT NULL,
	source_id TEXT NOT NULL,
	dedupe_key TEXT NOT NULL UNIQUE,
	payload_json TEXT NOT NULL,
	origin_json TEXT,
	published_at INTEGER,
	fetched_at INTEGER NOT NULL,
	-- Precomputed ordering timestamp (COALESCE(published_at, fetched_at))
	-- so the page query hits one index instead of computing per row.
	order_ts INTEGER NOT NULL,
	score REAL NOT NULL DEFAULT 0,
	state TEXT NOT NULL DEFAULT 'fresh',
	played_at INTEGER,
	-- When the item was last set aside (state -> 'archived'). Orders the
	-- Archived page newest-archived-first, independent of published/fetched
	-- time. Re-stamped on every (re-)archive; left intact on unarchive (the
	-- page filters by state, so a stale value is never read).
	archived_at INTEGER,
	enriched_at INTEGER,
	-- Enrichment outcome: NULL (not attempted) | 'ok' | 'na' (clean miss) |
	-- 'err' (lookup threw — retryable). Drives the drain's worklist gate; the
	-- UI renders na/err as N/A / ERR. See feed/types.ts EnrichStatus.
	enrich_status TEXT,
	promoted_track_id TEXT,
	-- Soft reference to the item that absorbs this one (v8). A TRACK whose
	-- recording sits on an album item points at that album (album wins — the
	-- card shows the track's origins as extra sources). An ALBUM made up only of
	-- already-handled recordings points at one of the handled track items.
	-- Non-NULL = hidden from the feed. Written only by SqliteFeedStore.reconcile.
	covered_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_feed_item_page ON feed_item (state, order_ts DESC);
-- NOTE: the Archived-page index (state, archived_at DESC) is NOT created here —
-- archived_at is added by a constructor ALTER, and CREATE TABLE IF NOT EXISTS is
-- a no-op on existing DBs, so the column isn't guaranteed to exist at DDL time.
-- The index is created in the constructor, right after that ALTER.
-- v4 → v5: genre/label feed filter. Expression indexes over the payload JSON
-- (single source of truth — no dual-written columns to keep in sync) so the
-- filter predicate and the DISTINCT facet query are both sargable. The
-- predicate MUST use this exact json_extract() expression to hit the index.
CREATE INDEX IF NOT EXISTS idx_feed_item_genre ON feed_item (json_extract(payload_json, '$.genre'));
CREATE INDEX IF NOT EXISTS idx_feed_item_label ON feed_item (json_extract(payload_json, '$.label'));
CREATE TABLE IF NOT EXISTS feed_item_key (
	item_id TEXT NOT NULL,
	key TEXT NOT NULL,
	PRIMARY KEY (item_id, key)
);
CREATE INDEX IF NOT EXISTS idx_feed_item_key_key ON feed_item_key (key);
-- Every origin (playlist/artist/browse) that surfaced an item, with its display
-- NAME — the primary plus each cross-source repeat that collapsed onto the row
-- (upsertItems' dedupe branch for in-batch repeats, accrueSources for repeats
-- the dedup filter caught pre-bus; feed_item_key only keeps the id-form key,
-- which has no name to render). Powers the card's "+N sources" badge + tooltip
-- and the multi-source ranking. PK (item_id, kind, origin_id); writes upsert so
-- a renamed playlist/artist refreshes the stored name (see accrueOnto).
CREATE TABLE IF NOT EXISTS feed_item_origin (
	item_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	origin_id TEXT NOT NULL,
	name TEXT NOT NULL,
	-- When this origin surfaced the item (the draft's publishedAt — playlist
	-- added_at / release date). Drives the recency half of the multi-source
	-- ranking: a recording re-surfacing via a new playlist rises to that add.
	seen_at INTEGER,
	PRIMARY KEY (item_id, kind, origin_id)
);
CREATE INDEX IF NOT EXISTS idx_feed_item_origin_item ON feed_item_origin (item_id);
-- Recording identity per item (v8): one row per track item, one per album
-- tracklist ref, keyed by recordingKey() (normalized title + artist set — see
-- @curator/library-logic recording-key.ts for why not ISRC). The join table behind track↔album collapse.
CREATE TABLE IF NOT EXISTS feed_item_recording (
	item_id TEXT NOT NULL,
	rec_key TEXT NOT NULL,
	PRIMARY KEY (item_id, rec_key)
);
CREATE INDEX IF NOT EXISTS idx_feed_item_recording_key ON feed_item_recording (rec_key);
CREATE TABLE IF NOT EXISTS feed_signal (
	id TEXT PRIMARY KEY,
	item_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	value_json TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feed_signal_item ON feed_signal (item_id);
CREATE TABLE IF NOT EXISTS feed_suppression (
	id TEXT PRIMARY KEY,
	scope TEXT NOT NULL,
	key TEXT NOT NULL UNIQUE,
	at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_cursor (
	producer_id TEXT PRIMARY KEY,
	cursor_json TEXT,
	last_run_at INTEGER
);
-- Source tracks confirmed unplayable in the account's market (v2 → v3). Keyed
-- by source track id, not item id: unavailability is a fact about the track, so
-- it dims every item that carries it. A plain CREATE-IF-NOT-EXISTS migration —
-- no ALTER needed for an existing DB.
CREATE TABLE IF NOT EXISTS feed_unavailable (
	source_track_id TEXT PRIMARY KEY,
	at INTEGER NOT NULL
);
`;

// Page filter shared by getPage's select + count. Suppressions match via
// the normalized feed_item_key table so the check is one indexed NOT EXISTS
// instead of JSON string matching.
//
// Albums are exempt from ARTIST-scope mutes: muting one credited artist must
// not hide a multi-artist release — the album stays and its offending tracks
// get a "Muted" chip (getItemDetail). Playlist/label/source mutes still hide
// albums (you silenced the whole origin, not one contributor). Track items are
// hidden by an artist mute as before.
//
// covered_by IS NULL drops items absorbed by another (a playlist track that's
// on a release card; a release of only already-handled recordings).
const VISIBLE_WHERE = `
	state IN ('fresh','seen','expanded')
	AND covered_by IS NULL
	AND NOT EXISTS (
		SELECT 1 FROM feed_item_key k
		JOIN feed_suppression s ON s.key = k.key
		WHERE k.item_id = feed_item.id
			AND NOT (feed_item.type = 'album' AND s.scope = 'artist')
	)
`;

interface ItemRow {
	id: string;
	dedupe_key: string;
	type: string;
	source: string;
	source_id: string;
	payload_json: string;
	origin_json: string | null;
	published_at: number | null;
	fetched_at: number;
	order_ts: number;
	score: number;
	state: string;
	played_at: number | null;
	archived_at: number | null;
	enriched_at: number | null;
	enrich_status: string | null;
	promoted_track_id: string | null;
	// Computed (EXISTS subquery), not a stored column — present only on track
	// items whose source_id is in feed_unavailable. 1 / 0 / undefined.
	unavailable?: number;
}

function rowToItem(r: ItemRow): FeedItem {
	return {
		id: r.id,
		dedupeKey: r.dedupe_key,
		type: r.type as FeedItem['type'],
		source: r.source as FeedItem['source'],
		sourceId: r.source_id,
		payload: JSON.parse(r.payload_json) as FeedItemPayload,
		origin: r.origin_json ? (JSON.parse(r.origin_json) as FeedOrigin) : null,
		publishedAt: r.published_at,
		fetchedAt: r.fetched_at,
		score: r.score,
		state: r.state as FeedItemState,
		playedAt: r.played_at,
		archivedAt: r.archived_at,
		enrichedAt: r.enriched_at,
		enrichStatus: r.enrich_status as EnrichStatus | null,
		promotedTrackId: r.promoted_track_id,
		unavailable: !!r.unavailable,
	};
}

// The page/item read column list — feed_item plus the computed `unavailable`
// flag (track items only; an album's source_id is an album id and never
// matches a track row, so it stays 0 there).
const ITEM_SELECT = `feed_item.*, EXISTS (
	SELECT 1 FROM feed_unavailable u WHERE u.source_track_id = feed_item.source_id
) AS unavailable`;

export class SqliteFeedStore implements FeedStore {
	private readonly db: Database.Database;
	// Prepared-statement memo for the hot per-row helpers (accrueOnto,
	// reconcile, rerank) — they run once per touched item, so re-preparing per
	// call would dominate a large poll batch.
	private readonly stmts = new Map<string, Database.Statement>();

	private stmt(sql: string): Database.Statement {
		let s = this.stmts.get(sql);
		if (!s) {
			s = this.db.prepare(sql);
			this.stmts.set(sql, s);
		}
		return s;
	}

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.db.exec(DDL);
		// v1 → v2: enriched_at. Tolerant ALTER, same style as the main
		// migrate runner — swallow "duplicate column".
		try {
			this.db.exec(`ALTER TABLE feed_item ADD COLUMN enriched_at INTEGER`);
		} catch { /* column exists */ }
		// v3 → v4: enrich_status (NULL | 'ok' | 'na' | 'err'). Tolerant ALTER,
		// then a one-time backfill that classifies the legacy enriched_at-only
		// rows so the old binary "stamped = done" can't strand empties forever:
		//   • rows that landed metadata  → 'ok' (terminal; the drain skips them).
		//   • rows stamped but EMPTY     → left NULL, so the drain re-attempts them
		//     once. They settle into 'na' (genuinely not on Beatport — terminal)
		//     or 'err' (a lookup that throws — retried next pass). This is the
		//     one-time clear of the ~empty-but-stamped backlog.
		// `changes()` keys off it being a fresh column (all NULL) so the backfill
		// runs exactly once; a second boot finds rows already classified.
		try {
			this.db.exec(`ALTER TABLE feed_item ADD COLUMN enrich_status TEXT`);
			// Only reachable when the column was just added (else ALTER throws) —
			// so this backfill is inherently one-shot. Album items carry their
			// metadata on per-track refs, so probe the tracks[] too, not just the
			// item-level fields.
			this.db.exec(`
				UPDATE feed_item SET enrich_status = 'ok'
				WHERE enriched_at IS NOT NULL AND (
					json_extract(payload_json, '$.bpm') IS NOT NULL
					OR json_extract(payload_json, '$.genre') IS NOT NULL
					OR json_extract(payload_json, '$.label') IS NOT NULL
					OR (json_type(payload_json, '$.tracks') = 'array' AND EXISTS (
						SELECT 1 FROM json_each(payload_json, '$.tracks') t
						WHERE json_extract(t.value, '$.bpm') IS NOT NULL
							OR json_extract(t.value, '$.genre') IS NOT NULL
							OR json_extract(t.value, '$.label') IS NOT NULL
					))
				)
			`);
		} catch { /* column exists — backfill already ran on the boot that added it */ }
		// v5 → v6: archived_at, so the Archived page orders by set-aside time, not
		// published/fetched time. Tolerant ALTER + one-time backfill: existing
		// archived rows predate the column, so seed it from their most recent
		// 'archive' signal (recorded at archive time), falling back to order_ts.
		try {
			this.db.exec(`ALTER TABLE feed_item ADD COLUMN archived_at INTEGER`);
			this.db.exec(`
				UPDATE feed_item SET archived_at = COALESCE(
					(SELECT MAX(s.at) FROM feed_signal s WHERE s.item_id = feed_item.id AND s.kind = 'archive'),
					order_ts
				)
				WHERE state = 'archived'
			`);
		} catch { /* column exists — backfill already ran on the boot that added it */ }
		// Archived-page pager index. Created here (not in DDL) because archived_at
		// only exists after the ALTER above; IF NOT EXISTS keeps it idempotent and
		// it runs every boot (new DBs get the column from CREATE TABLE, existing
		// ones from the ALTER), so it's never skipped by the migration's catch.
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_feed_item_archived ON feed_item (state, archived_at DESC)`);
		// v7 → v8 columns: covered_by + origin seen_at. Tolerant ALTERs (the
		// backfill below keys off schema_version, not the ALTER succeeding). The
		// covered_by index serves reconcile's "who points at this host" lookups.
		try {
			this.db.exec(`ALTER TABLE feed_item ADD COLUMN covered_by TEXT`);
		} catch { /* column exists */ }
		try {
			this.db.exec(`ALTER TABLE feed_item_origin ADD COLUMN seen_at INTEGER`);
		} catch { /* column exists */ }
		this.db.exec(`CREATE INDEX IF NOT EXISTS idx_feed_item_covered ON feed_item (covered_by)`);
		// v6 → v7: feed_item_origin (the named source set behind the card's
		// "+N sources" badge). One-shot backfill from each row's primary
		// origin_json — the only origin whose NAME survived pre-v7 (dedupe-hit
		// repeats kept only the id-form key in feed_item_key, no name). Extra
		// sources re-accrue with names as followed playlists/artists re-poll.
		const priorVersion = Number(
			(this.db.prepare(`SELECT value FROM feed_meta WHERE key = 'schema_version'`).get() as
				| { value: string }
				| undefined)?.value ?? 0,
		);
		if (priorVersion < 7) {
			this.db.exec(`
				INSERT OR IGNORE INTO feed_item_origin (item_id, kind, origin_id, name)
				SELECT id,
					json_extract(origin_json, '$.kind'),
					json_extract(origin_json, '$.id'),
					json_extract(origin_json, '$.name')
				FROM feed_item
				WHERE origin_json IS NOT NULL
					AND json_extract(origin_json, '$.id') IS NOT NULL
					AND json_extract(origin_json, '$.name') IS NOT NULL
			`);
		}
		// v7 → v8: recording identity + track↔album collapse + multi-source rank.
		// One-shot: index every item's recordings from its payload, seed origin
		// seen_at from the item's own timestamp (the only sighting time pre-v8
		// knew), then reconcile the whole feed — which folds the existing
		// track/album duplicate pairs on first launch.
		if (priorVersion < 8) {
			this.db.transaction(() => {
				const rows = this.db.prepare(`SELECT id, type, payload_json FROM feed_item`).all() as
					{ id: string; type: string; payload_json: string }[];
				const ins = this.db.prepare(`INSERT OR IGNORE INTO feed_item_recording (item_id, rec_key) VALUES (?, ?)`);
				const keys = new Set<string>();
				for (const r of rows) {
					let payload: FeedItemPayload;
					try { payload = JSON.parse(r.payload_json) as FeedItemPayload; } catch { continue; }
					for (const k of recordingKeysFor(r.type as FeedItem['type'], payload)) {
						ins.run(r.id, k);
						keys.add(k);
					}
				}
				this.db.exec(`
					UPDATE feed_item_origin SET seen_at = (
						SELECT COALESCE(i.published_at, i.fetched_at) FROM feed_item i WHERE i.id = feed_item_origin.item_id
					) WHERE seen_at IS NULL
				`);
				this.reconcile(keys, rows.map((r) => r.id));
			})();
		}
		this.db
			.prepare(`INSERT OR REPLACE INTO feed_meta (key, value) VALUES ('schema_version', ?)`)
			.run(String(SCHEMA_VERSION));
	}

	private decisionSource: ((dedupeKeys: readonly string[]) => SyncedFeedItem[]) | null = null;

	setDecisionSource(fn: ((dedupeKeys: readonly string[]) => SyncedFeedItem[]) | null): void {
		this.decisionSource = fn;
	}

	async upsertItems(drafts: FeedItemDraft[]): Promise<{ inserted: number }> {
		if (drafts.length === 0) return { inserted: 0 };
		const now = Date.now();
		const insertItem = this.db.prepare(`
			INSERT INTO feed_item (id, type, source, source_id, dedupe_key, payload_json, origin_json,
				published_at, fetched_at, order_ts, score, state)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'fresh')
			ON CONFLICT (dedupe_key) DO NOTHING
		`);
		const insertRecording = this.db.prepare(`
			INSERT OR IGNORE INTO feed_item_recording (item_id, rec_key) VALUES (?, ?)
		`);
		const findId = this.db.prepare(`SELECT id FROM feed_item WHERE dedupe_key = ?`);
		let inserted = 0;
		const recKeys = new Set<string>();
		const touched: string[] = [];
		const insertedKeys: string[] = [];
		const txn = this.db.transaction(() => {
			for (const d of drafts) {
				const id = randomUUID();
				const res = insertItem.run(
					id,
					d.type,
					d.source,
					d.sourceId,
					d.dedupeKey,
					JSON.stringify(d.payload),
					d.origin ? JSON.stringify(d.origin) : null,
					d.publishedAt,
					now,
					d.publishedAt ?? now,
				);
				let itemId: string = id;
				if (res.changes === 0) {
					// Dedupe hit — the same recording surfacing via another
					// playlist/artist scan. Don't count it as inserted, but DO
					// record this draft's keys against the existing row so
					// cross-source membership accrues (a track in two followed
					// playlists ends up carrying both 'playlist:<id>' keys).
					// Unfollow + mute then see every source, not just the first.
					const existing = findId.get(d.dedupeKey) as { id: string } | undefined;
					if (!existing) continue;
					itemId = existing.id;
				} else {
					inserted++;
					insertedKeys.push(d.dedupeKey);
					for (const k of recordingKeysFor(d.type, d.payload)) {
						insertRecording.run(itemId, k);
						recKeys.add(k);
					}
				}
				this.accrueOnto(itemId, d, now);
				touched.push(itemId);
			}
			// An item the account already decided about (archived on another
			// device, say) lands with that decision, before reconcile.
			if (insertedKeys.length > 0 && this.decisionSource) this.applyItemDecisions(this.decisionSource(insertedKeys));
			// Collapse + re-rank everything this batch touched: new rows may absorb
			// (or be absorbed by) existing ones via a shared recording, and dedupe
			// hits gained a source.
			this.reconcile(recKeys, touched);
		});
		txn();
		return { inserted };
	}

	async accrueSources(drafts: FeedItemDraft[]): Promise<void> {
		if (drafts.length === 0) return;
		const findId = this.db.prepare(`SELECT id FROM feed_item WHERE dedupe_key = ?`);
		const now = Date.now();
		this.db.transaction(() => {
			const touched: string[] = [];
			for (const d of drafts) {
				const row = findId.get(d.dedupeKey) as { id: string } | undefined;
				if (!row) continue;
				this.accrueOnto(row.id, d, now);
				touched.push(row.id);
			}
			this.reconcile([], touched);
		})();
	}

	// Record a draft's suppress keys + named origin against an item row. Origin
	// upsert refreshes a renamed playlist/artist and keeps the LATEST sighting
	// time (a backfill re-emitting an older add must not pull seen_at back).
	// feed_item_key stays id-only (name-less) for suppression matching.
	private accrueOnto(itemId: string, d: FeedItemDraft, now: number): void {
		const insertKey = this.stmt(`INSERT OR IGNORE INTO feed_item_key (item_id, key) VALUES (?, ?)`);
		for (const key of d.suppressKeys) insertKey.run(itemId, key);
		if (!d.origin) return;
		this
			.stmt(`
				INSERT INTO feed_item_origin (item_id, kind, origin_id, name, seen_at) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT (item_id, kind, origin_id) DO UPDATE SET
					name = excluded.name,
					seen_at = MAX(COALESCE(feed_item_origin.seen_at, 0), excluded.seen_at)
			`)
			.run(itemId, d.origin.kind, d.origin.id, d.origin.name, d.publishedAt ?? now);
	}

	// ── Collapse + ranking: the single writer of covered_by and order_ts ──────
	//
	// Given recording keys whose holders may have changed (and item ids whose
	// sources changed), recompute:
	//   1. ALBUMS (visible state) — covered by a handled track when EVERY one of
	//      their recordings already has a track item in archived/dismissed/
	//      promoted ("you dealt with these"). Only TRACK items count as handled:
	//      a release never hides another release (user decision — releases are
	//      always news).
	//   2. TRACKS (visible state) — covered by an album carrying the same
	//      recording, any state (album wins; an archived/dismissed album means
	//      the recording is handled too). Albums first so a track prefers a
	//      still-visible album as its host — that's where its sources render.
	//   3. order_ts for every affected host (see rerank).
	// Must run inside the caller's transaction. Cheap: every probe is an indexed
	// rec_key / covered_by lookup, and batches are a poll's worth of items.
	private reconcile(keys: Iterable<string>, extraIds: Iterable<string> = []): void {
		const keyList = [...new Set(keys)];
		const ids = new Set<string>(extraIds);
		for (let i = 0; i < keyList.length; i += 500) {
			const chunk = keyList.slice(i, i + 500);
			const rows = this.db
				.prepare(`SELECT DISTINCT item_id FROM feed_item_recording WHERE rec_key IN (${chunk.map(() => '?').join(',')})`)
				.all(...chunk) as { item_id: string }[];
			for (const r of rows) ids.add(r.item_id);
		}
		if (ids.size === 0) return;

		const getItem = this.stmt(`SELECT id, type, state, covered_by FROM feed_item WHERE id = ?`);
		const recsOf = this.stmt(`SELECT rec_key FROM feed_item_recording WHERE item_id = ?`);
		const handledTrack = this.stmt(`
			SELECT t.id FROM feed_item_recording r JOIN feed_item t ON t.id = r.item_id
			WHERE r.rec_key = ? AND t.type = 'track' AND t.state IN ${HANDLED_STATES}
			LIMIT 1
		`);
		const hostAlbum = this.stmt(`
			SELECT a.id FROM feed_item_recording rt
			JOIN feed_item_recording ra ON ra.rec_key = rt.rec_key AND ra.item_id != rt.item_id
			JOIN feed_item a ON a.id = ra.item_id AND a.type = 'album'
			WHERE rt.item_id = ?
			ORDER BY (a.state IN ${VISIBLE_STATES} AND a.covered_by IS NULL) DESC, a.order_ts DESC, a.id
			LIMIT 1
		`);
		const setCovered = this.stmt(`UPDATE feed_item SET covered_by = ? WHERE id = ?`);

		type Row = { id: string; type: string; state: string; covered_by: string | null };
		const rows = [...ids]
			.map((id) => getItem.get(id) as Row | undefined)
			.filter((r): r is Row => !!r);
		const hosts = new Set<string>(ids);
		const visible = (r: Row) => r.state === 'fresh' || r.state === 'seen' || r.state === 'expanded';
		const apply = (r: Row, next: string | null) => {
			if (r.covered_by) hosts.add(r.covered_by);
			if (next) hosts.add(next);
			if (next !== r.covered_by) setCovered.run(next, r.id);
		};

		for (const r of rows) {
			if (r.type !== 'album' || !visible(r)) continue;
			const recs = (recsOf.all(r.id) as { rec_key: string }[]).map((x) => x.rec_key);
			let cover: string | null = null;
			for (const k of recs) {
				const h = handledTrack.get(k) as { id: string } | undefined;
				if (!h) { cover = null; break; }
				cover ??= h.id;
			}
			apply(r, cover);
		}
		for (const r of rows) {
			if (r.type !== 'track' || !visible(r)) continue;
			const host = hostAlbum.get(r.id) as { id: string } | undefined;
			apply(r, host?.id ?? null);
		}
		this.rerank(hosts);
	}

	// order_ts = latest sighting + MULTI_SOURCE_BOOST_MS per extra source. A
	// host's sources are its own origins plus those of the tracks it absorbed
	// (the same set attachSources renders as "+N"). Latest sighting = the max of
	// the item's own published/fetched time and every source's seen_at, so a
	// recording re-surfacing via a new playlist rises to that add.
	private rerank(ids: Iterable<string>): void {
		const base = this.stmt(`SELECT COALESCE(published_at, fetched_at) AS ts, order_ts FROM feed_item WHERE id = ?`);
		const sources = this.stmt(`
			SELECT kind, origin_id, seen_at FROM feed_item_origin WHERE item_id = ?
			UNION ALL
			SELECT o.kind, o.origin_id, o.seen_at FROM feed_item i
			JOIN feed_item_origin o ON o.item_id = i.id
			WHERE i.covered_by = ? AND i.type = 'track'
		`);
		const setOrder = this.stmt(`UPDATE feed_item SET order_ts = ? WHERE id = ?`);
		for (const id of ids) {
			const row = base.get(id) as { ts: number; order_ts: number } | undefined;
			if (!row) continue;
			const distinct = new Set<string>();
			let latest = row.ts;
			for (const s of sources.all(id, id) as { kind: string; origin_id: string; seen_at: number | null }[]) {
				distinct.add(`${s.kind}:${s.origin_id}`);
				if (s.seen_at != null && s.seen_at > latest) latest = s.seen_at;
			}
			const next = latest + Math.max(distinct.size - 1, 0) * MULTI_SOURCE_BOOST_MS;
			if (next !== row.order_ts) setOrder.run(next, id);
		}
	}

	// Recording keys an item currently holds — captured before a delete/state
	// change so reconcile can re-evaluate whoever shared them.
	private recordingKeysOf(itemIds: string[]): string[] {
		const stmt = this.stmt(`SELECT rec_key FROM feed_item_recording WHERE item_id = ?`);
		return itemIds.flatMap((id) => (stmt.all(id) as { rec_key: string }[]).map((r) => r.rec_key));
	}

	// Shared hard-delete for prune / unfollow eviction: drop the rows and their
	// side tables, release anything they were absorbing (an unfollowed artist's
	// release gives its playlist tracks back to the feed), then re-reconcile the
	// recordings they held so survivors re-pair.
	private deleteItems(itemIds: string[]): void {
		if (itemIds.length === 0) return;
		const keys = this.recordingKeysOf(itemIds);
		const released: string[] = [];
		const coveredBy = this.db.prepare(`SELECT id FROM feed_item WHERE covered_by = ?`);
		for (const id of itemIds) {
			for (const r of coveredBy.all(id) as { id: string }[]) released.push(r.id);
		}
		for (const table of ['feed_item_key', 'feed_item_origin', 'feed_item_recording', 'feed_signal']) {
			const del = this.db.prepare(`DELETE FROM ${table} WHERE item_id = ?`);
			for (const id of itemIds) del.run(id);
		}
		const del = this.db.prepare(`DELETE FROM feed_item WHERE id = ?`);
		const release = this.db.prepare(`UPDATE feed_item SET covered_by = NULL WHERE id = ?`);
		for (const id of itemIds) del.run(id);
		const gone = new Set(itemIds);
		const survivors = released.filter((id) => !gone.has(id));
		for (const id of survivors) release.run(id);
		this.reconcile(keys, survivors);
	}

	async getPage(req?: { cursor?: string | null; limit?: number } & FeedFilter): Promise<FeedPage> {
		return this.pageWhere(VISIBLE_WHERE, req);
	}

	async getArchivedPage(req?: { cursor?: string | null; limit?: number }): Promise<FeedPage> {
		// Order by set-aside time, not published/fetched — the user wants the
		// Archived page in the order they archived things (newest first).
		return this.pageWhere(`state = 'archived'`, req, 'archived_at');
	}

	async filterOptions(): Promise<{ genres: string[]; labels: string[] }> {
		// Distinct, non-null genre/label across visible items. Same VISIBLE_WHERE
		// as the page so options never offer a value that's all-suppressed. The
		// expression matches the index, so this is a cheap covering scan.
		const distinct = (field: 'genre' | 'label'): string[] =>
			(this.db.prepare(`
				SELECT DISTINCT json_extract(payload_json, '$.${field}') AS v
				FROM feed_item
				WHERE ${VISIBLE_WHERE} AND json_extract(payload_json, '$.${field}') IS NOT NULL
				ORDER BY v COLLATE NOCASE
			`).all() as { v: string }[]).map((r) => r.v);
		return { genres: distinct('genre'), labels: distinct('label') };
	}

	// Shared keyset pager. `where` is a row predicate over feed_item; both the
	// page select and the count use it, so a page and its `total` always agree.
	// Optional genre/label narrowing is appended as bound predicates (params
	// bind BEFORE the cursor/limit, matching their position in the SQL).
	private pageWhere(
		where: string,
		req?: { cursor?: string | null; limit?: number } & FeedFilter,
		// Ordering column for the keyset pager. The cursor token, ORDER BY, and
		// nextCursor all key off it, so a page stays internally consistent.
		orderCol: 'order_ts' | 'archived_at' = 'order_ts',
	): FeedPage {
		const limit = Math.min(Math.max(req?.limit ?? 50, 1), 200);
		const filterSql: string[] = [];
		const filterParams: unknown[] = [];
		if (req?.genre) { filterSql.push(`json_extract(payload_json, '$.genre') = ?`); filterParams.push(req.genre); }
		if (req?.label) { filterSql.push(`json_extract(payload_json, '$.label') = ?`); filterParams.push(req.label); }
		const fullWhere = [where, ...filterSql].join(' AND ');
		// Keyset cursor "orderTs|id" — stable under concurrent inserts at the
		// head, unlike offset pagination.
		let cursorTs: number | null = null;
		let cursorId: string | null = null;
		if (req?.cursor) {
			const sep = req.cursor.indexOf('|');
			if (sep > 0) {
				cursorTs = Number(req.cursor.slice(0, sep));
				cursorId = req.cursor.slice(sep + 1);
			}
		}
		const rows = (
			cursorTs !== null
				? this.db.prepare(`
					SELECT ${ITEM_SELECT} FROM feed_item
					WHERE ${fullWhere} AND (${orderCol} < ? OR (${orderCol} = ? AND id < ?))
					ORDER BY ${orderCol} DESC, id DESC LIMIT ?
				`).all(...filterParams, cursorTs, cursorTs, cursorId, limit)
				: this.db.prepare(`
					SELECT ${ITEM_SELECT} FROM feed_item
					WHERE ${fullWhere}
					ORDER BY ${orderCol} DESC, id DESC LIMIT ?
				`).all(...filterParams, limit)
		) as ItemRow[];
		const total = (
			this.db.prepare(`SELECT COUNT(*) AS n FROM feed_item WHERE ${fullWhere}`).get(...filterParams) as { n: number }
		).n;
		const last = rows[rows.length - 1];
		const items = rows.map(rowToItem);
		this.attachSources(items);
		return {
			items,
			nextCursor: rows.length === limit && last ? `${last[orderCol]}|${last.id}` : null,
			total,
		};
	}

	// Hydrate FeedItem.sources — the full named origin set behind the "+N sources"
	// badge — for a page of items in ONE indexed IN(...) query (per CLAUDE.md's
	// batch-lookup rule, not N per-row). Primary origin first (matching the shown
	// chip), then the rest by name; falls back to the row's own `origin` when no
	// feed_item_origin rows exist yet (pre-v7 rows before their next re-poll).
	private attachSources(items: FeedItem[]): void {
		if (items.length === 0) return;
		const ids = items.map((i) => i.id);
		const marks = ids.map(() => '?').join(',');
		// Own origins, plus those of the TRACK items this row absorbed (covered_by
		// — a playlist track folded into its release card), so the album's "+N"
		// names the playlists the song also came from. Still one query.
		const rows = this.db
			.prepare(`
				SELECT item_id AS host, kind, origin_id, name FROM feed_item_origin WHERE item_id IN (${marks})
				UNION ALL
				SELECT i.covered_by AS host, o.kind, o.origin_id, o.name FROM feed_item i
				JOIN feed_item_origin o ON o.item_id = i.id
				WHERE i.covered_by IN (${marks}) AND i.type = 'track'
			`)
			.all(...ids, ...ids) as { host: string; kind: string; origin_id: string; name: string }[];
		const byItem = new Map<string, FeedOrigin[]>();
		for (const r of rows) {
			const list = byItem.get(r.host) ?? [];
			if (list.some((o) => o.kind === r.kind && o.id === r.origin_id)) continue;
			list.push({ kind: r.kind as FeedOrigin['kind'], id: r.origin_id, name: r.name });
			byItem.set(r.host, list);
		}
		for (const item of items) {
			const all = byItem.get(item.id);
			if (!all || all.length === 0) {
				item.sources = item.origin ? [item.origin] : [];
				continue;
			}
			const primaryId = item.origin?.id;
			all.sort(
				(a, b) =>
					(a.id === primaryId ? -1 : 0) - (b.id === primaryId ? -1 : 0) ||
					a.name.localeCompare(b.name),
			);
			item.sources = all;
		}
	}

	async getItem(itemId: string): Promise<FeedItem | null> {
		const row = this.db.prepare(`SELECT ${ITEM_SELECT} FROM feed_item WHERE id = ?`).get(itemId) as ItemRow | undefined;
		if (!row) return null;
		const item = rowToItem(row);
		this.attachSources([item]);
		return item;
	}

	async getItemDetail(itemId: string): Promise<FeedItemDetail | null> {
		const item = await this.getItem(itemId);
		if (!item) return null;
		const rows = this.db
			.prepare(`SELECT value_json FROM feed_signal WHERE item_id = ? AND kind = 'listen'`)
			.all(itemId) as { value_json: string | null }[];
		const played = new Set<string>();
		for (const r of rows) {
			if (!r.value_json) continue;
			const v = JSON.parse(r.value_json) as { sourceTrackId?: string };
			if (v.sourceTrackId) played.add(v.sourceTrackId);
		}
		// Which of this item's tracks (its own id for track items, plus every
		// album-track ref) are flagged unplayable. One IN() probe.
		const candidateIds = new Set<string>();
		if (item.type === 'track') candidateIds.add(item.sourceId);
		for (const t of item.payload.tracks ?? []) candidateIds.add(t.sourceTrackId);
		const unavailable: string[] = [];
		if (candidateIds.size > 0) {
			const ids = [...candidateIds];
			const urows = this.db
				.prepare(`SELECT source_track_id FROM feed_unavailable WHERE source_track_id IN (${ids.map(() => '?').join(',')})`)
				.all(...ids) as { source_track_id: string }[];
			for (const r of urows) unavailable.push(r.source_track_id);
		}
		// inLibrary* are left empty here — the store is the cloud seam and never
		// queries curator.db. The service fills them via the LibraryPort probe
		// before returning the detail.
		// mutedSourceTrackIds left empty here — like inLibrary*, the artist-mute join
	// is filled by the service (it owns the suppressedKeys read + name fallback).
	return { item, playedSourceTrackIds: [...played], unavailableSourceTrackIds: unavailable, membershipBySourceTrackId: {}, inLibraryTrackIds: {}, pinnedSourceTrackIds: [], deletedSourceTrackIds: [], mutedSourceTrackIds: [] };
	}

	async setPayload(itemId: string, payload: FeedItemPayload): Promise<void> {
		// The lazy expand path lands an album's tracklist here (when the ingest
		// expander couldn't) — re-index its recordings and reconcile so playlist
		// tracks it carries fold into it.
		this.db.transaction(() => {
			const row = this.db.prepare(`SELECT type FROM feed_item WHERE id = ?`).get(itemId) as { type: string } | undefined;
			if (!row) return;
			this.db.prepare(`UPDATE feed_item SET payload_json = ? WHERE id = ?`).run(JSON.stringify(payload), itemId);
			const before = this.recordingKeysOf([itemId]);
			const after = recordingKeysFor(row.type as FeedItem['type'], payload);
			if (before.length === after.length && after.every((k) => before.includes(k))) return;
			this.db.prepare(`DELETE FROM feed_item_recording WHERE item_id = ?`).run(itemId);
			const ins = this.stmt(`INSERT OR IGNORE INTO feed_item_recording (item_id, rec_key) VALUES (?, ?)`);
			for (const k of after) ins.run(itemId, k);
			this.reconcile([...before, ...after], [itemId]);
		})();
	}

	async recordSignal(signal: FeedSignalInput): Promise<void> {
		this.db
			.prepare(`INSERT INTO feed_signal (id, item_id, kind, value_json, at) VALUES (?, ?, ?, ?, ?)`)
			.run(randomUUID(), signal.itemId, signal.kind, signal.value ? JSON.stringify(signal.value) : null, Date.now());
	}

	async addSuppression(scope: FeedSuppressionScope, key: string): Promise<void> {
		this.db
			.prepare(`INSERT OR IGNORE INTO feed_suppression (id, scope, key, at) VALUES (?, ?, ?, ?)`)
			.run(randomUUID(), scope, key, Date.now());
	}

	async markState(
		itemId: string,
		state: FeedItemState,
		extra?: { playedAt?: number; promotedTrackId?: string },
	): Promise<void> {
		// Stamp archived_at on entry to 'archived' (fresh on every re-archive);
		// leave it untouched for any other transition — the Archived page filters
		// by state, so a value left behind after unarchive is never read.
		this.db.transaction(() => {
			this.db
				.prepare(`
					UPDATE feed_item SET state = ?,
						played_at = COALESCE(?, played_at),
						promoted_track_id = COALESCE(?, promoted_track_id),
						archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END
					WHERE id = ?
				`)
				.run(state, extra?.playedAt ?? null, extra?.promotedTrackId ?? null, state, Date.now(), itemId);
			// A state flip changes who's "handled" / "visible" for collapse: a
			// restored track may re-fold into its album; an archived track can
			// make a later all-handled release hide.
			this.reconcile(this.recordingKeysOf([itemId]), [itemId]);
		})();
	}

	async clearPromotion(itemId: string): Promise<void> {
		this.db.transaction(() => {
			this.db
				.prepare(`UPDATE feed_item SET state = 'seen', promoted_track_id = NULL WHERE id = ?`)
				.run(itemId);
			this.reconcile(this.recordingKeysOf([itemId]), [itemId]);
		})();
	}

	async repointPromotedTrack(fromTrackId: string, toTrackId: string): Promise<number> {
		const res = this.db
			.prepare(`UPDATE feed_item SET promoted_track_id = ? WHERE promoted_track_id = ?`)
			.run(toTrackId, fromTrackId);
		return res.changes;
	}

	async markPlayed(itemId: string): Promise<void> {
		this.db.prepare(`UPDATE feed_item SET played_at = COALESCE(played_at, ?) WHERE id = ?`).run(Date.now(), itemId);
	}

	async markUnavailable(sourceTrackId: string): Promise<void> {
		this.db
			.prepare(`INSERT OR IGNORE INTO feed_unavailable (source_track_id, at) VALUES (?, ?)`)
			.run(sourceTrackId, Date.now());
	}

	// ── account decisions (protocol v4; feed/sync.ts) ────────────────────────

	decisionsDump(): FeedDecisionsDump {
		// The decision's time: when it was archived, else the latest signal
		// that made it, else when the item arrived — a statement stamped with it
		// loses to anything decided later anywhere.
		const items = this.db.prepare(`
			SELECT f.dedupe_key, f.state, f.promoted_track_id, f.played_at,
				CASE WHEN f.state = 'archived' AND f.archived_at IS NOT NULL THEN f.archived_at
					ELSE COALESCE((SELECT max(s.at) FROM feed_signal s WHERE s.item_id = f.id AND s.kind IN ('dismiss', 'promote', 'archive', 'expand', 'impression')), f.fetched_at) END AS at
			FROM feed_item f WHERE f.state != 'fresh' OR f.played_at IS NOT NULL`).all() as Array<{ dedupe_key: string; state: FeedItemState; promoted_track_id: string | null; played_at: number | null; at: number }>;
		const listens = this.db.prepare(`
			SELECT f.dedupe_key, json_extract(s.value_json, '$.sourceTrackId') AS sid, min(s.at) AS at
			FROM feed_signal s JOIN feed_item f ON f.id = s.item_id
			WHERE s.kind = 'listen' AND s.value_json IS NOT NULL AND json_valid(s.value_json) AND json_extract(s.value_json, '$.sourceTrackId') IS NOT NULL
			GROUP BY f.dedupe_key, sid`).all() as Array<{ dedupe_key: string; sid: string; at: number }>;
		return {
			items: items.map((i) => ({ dedupeKey: i.dedupe_key, state: i.state, at: i.at, promotedTrackId: i.promoted_track_id, playedAt: i.played_at })),
			listens: listens.map((l) => ({ dedupeKey: l.dedupe_key, sourceTrackId: String(l.sid), at: l.at })),
			suppressions: (this.db.prepare(`SELECT key, scope, at FROM feed_suppression`).all() as Array<{ key: string; scope: FeedSuppressionScope; at: number }>),
			unavailable: (this.db.prepare(`SELECT source_track_id, at FROM feed_unavailable`).all() as Array<{ source_track_id: string; at: number }>).map((u) => ({ sourceTrackId: u.source_track_id, at: u.at })),
		};
	}

	// Inside a transaction (the caller's). Writes only what differs.
	private applyItemDecisions(items: readonly SyncedFeedItem[]): string[] {
		const find = this.stmt(`SELECT id, state, promoted_track_id, played_at FROM feed_item WHERE dedupe_key = ?`);
		const setState = this.stmt(`UPDATE feed_item SET state = ?, promoted_track_id = ?,
			archived_at = CASE WHEN ? = 'archived' THEN COALESCE(?, archived_at, ?) ELSE archived_at END WHERE id = ?`);
		const setPlayed = this.stmt(`UPDATE feed_item SET played_at = ? WHERE id = ? AND played_at IS NULL`);
		const hasListen = this.stmt(`SELECT 1 FROM feed_signal WHERE item_id = ? AND kind = 'listen' AND json_extract(value_json, '$.sourceTrackId') = ? LIMIT 1`);
		const addListen = this.stmt(`INSERT INTO feed_signal (id, item_id, kind, value_json, at) VALUES (?, ?, 'listen', ?, ?)`);
		const changed: string[] = [];
		for (const d of items) {
			const row = find.get(d.dedupeKey) as { id: string; state: string; promoted_track_id: string | null; played_at: number | null } | undefined;
			if (!row) continue;
			let touched = false;
			if (d.state && (d.state !== row.state || (d.state === 'promoted' && (d.promotedTrackId ?? null) !== row.promoted_track_id))) {
				setState.run(d.state, d.state === 'promoted' ? d.promotedTrackId : null, d.state, d.stateAt, Date.now(), row.id);
				touched = true;
			}
			if (d.playedAt != null && row.played_at == null && setPlayed.run(d.playedAt, row.id).changes > 0) touched = true;
			for (const sid of d.listened) {
				if (hasListen.get(row.id, sid)) continue;
				addListen.run(randomUUID(), row.id, JSON.stringify({ sourceTrackId: sid, synced: true }), d.playedAt ?? Date.now());
				touched = true;
			}
			if (touched) changed.push(row.id);
		}
		return changed;
	}

	applySyncedDecisions(items: readonly SyncedFeedItem[], suppressions: readonly SyncedFeedSuppression[]): number {
		return this.db.transaction(() => {
			const changed = this.applyItemDecisions(items);
			for (const s of suppressions) {
				if (s.scope === 'track') {
					const id = s.key.startsWith('track:') ? s.key.slice('track:'.length) : s.key;
					if (s.active) this.stmt(`INSERT OR IGNORE INTO feed_unavailable (source_track_id, at) VALUES (?, ?)`).run(id, s.at);
					else this.stmt(`DELETE FROM feed_unavailable WHERE source_track_id = ?`).run(id);
				} else if (s.active) {
					this.stmt(`INSERT OR IGNORE INTO feed_suppression (id, scope, key, at) VALUES (?, ?, ?, ?)`).run(randomUUID(), s.scope, s.key, s.at);
				} else {
					this.stmt(`DELETE FROM feed_suppression WHERE key = ?`).run(s.key);
				}
			}
			if (changed.length > 0) this.reconcile(this.recordingKeysOf(changed), changed);
			return changed.length;
		})();
	}

	async getCursor(producerId: string): Promise<unknown> {
		const row = this.db.prepare(`SELECT cursor_json FROM feed_cursor WHERE producer_id = ?`).get(producerId) as
			| { cursor_json: string | null }
			| undefined;
		return row?.cursor_json ? JSON.parse(row.cursor_json) : null;
	}

	async setCursor(producerId: string, cursor: unknown): Promise<void> {
		this.db
			.prepare(`
				INSERT INTO feed_cursor (producer_id, cursor_json, last_run_at) VALUES (?, ?, ?)
				ON CONFLICT (producer_id) DO UPDATE SET cursor_json = excluded.cursor_json, last_run_at = excluded.last_run_at
			`)
			.run(producerId, cursor == null ? null : JSON.stringify(cursor), Date.now());
	}

	async prune(olderThanMs: number): Promise<number> {
		const cutoff = Date.now() - olderThanMs;
		const txn = this.db.transaction((): number => {
			const ids = this.db
				.prepare(`SELECT id FROM feed_item WHERE state IN ('fresh','seen') AND fetched_at < ?`)
				.all(cutoff) as { id: string }[];
			if (ids.length === 0) return 0;
			this.deleteItems(ids.map((r) => r.id));
			return ids.length;
		});
		return txn();
	}

	async removeOriginItems(kind: 'artist' | 'playlist', id: string, stillFollowed: Set<string>): Promise<number> {
		const prefix = `${kind}:`;
		const credited = this.db
			.prepare(`SELECT item_id AS id FROM feed_item_key WHERE key = ?`)
			.all(prefix + id) as { id: string }[];
		if (credited.length === 0) return 0;
		const originStmt = this.db.prepare(`SELECT origin_json FROM feed_item WHERE id = ?`);
		const keysStmt = this.db.prepare(`SELECT key FROM feed_item_key WHERE item_id = ? AND key LIKE ?`);
		const txn = this.db.transaction((): number => {
			const doomed: string[] = [];
			for (const { id: itemId } of credited) {
				const row = originStmt.get(itemId) as { origin_json: string | null } | undefined;
				if (!row) continue;
				// Only same-kind-origin items — e.g. a playlist-origin track that
				// merely features an unfollowed artist is out of scope, and vice
				// versa.
				const origin = row.origin_json ? (JSON.parse(row.origin_json) as FeedOrigin) : null;
				if (origin?.kind !== kind) continue;
				const keys = keysStmt.all(itemId, prefix + '%') as { key: string }[];
				const stillCredited = keys
					.map((k) => k.key.slice(prefix.length))
					.some((other) => other !== id && stillFollowed.has(other));
				if (stillCredited) continue; // shared with a follow you keep
				doomed.push(itemId);
			}
			this.deleteItems(doomed);
			return doomed.length;
		});
		return txn();
	}

	async listUnenriched(limit: number): Promise<FeedItem[]> {
		// Worklist = never-attempted (enrich_status IS NULL) OR last attempt
		// errored (status 'err' — retryable; a WAF/network blip shouldn't strand
		// the row like the old enriched_at stamp did). 'ok'/'na' are terminal.
		// Track items always; album items only once their tracklist is resolved
		// (the expander fills payload.tracks pre-bus) — otherwise there'd be
		// nothing to enrich and the un-stampable row would loop the drain.
		const rows = this.db
			.prepare(`
				SELECT * FROM feed_item
				WHERE (enrich_status IS NULL OR enrich_status = 'err')
					AND state IN ('fresh','seen','expanded')
					-- Absorbed items are hidden — don't spend Beatport lookups on
					-- them; they rejoin the worklist if they're ever released.
					AND covered_by IS NULL
					AND (type = 'track'
						OR (type = 'album' AND json_extract(payload_json, '$.tracks') IS NOT NULL))
				ORDER BY order_ts DESC LIMIT ?
			`)
			.all(Math.max(1, limit)) as ItemRow[];
		return rows.map(rowToItem);
	}

	async markEnriched(itemId: string, status: EnrichStatus, payload?: FeedItemPayload): Promise<void> {
		if (payload) {
			this.db
				.prepare(`UPDATE feed_item SET payload_json = ?, enriched_at = ?, enrich_status = ? WHERE id = ?`)
				.run(JSON.stringify(payload), Date.now(), status, itemId);
		} else {
			this.db
				.prepare(`UPDATE feed_item SET enriched_at = ?, enrich_status = ? WHERE id = ?`)
				.run(Date.now(), status, itemId);
		}
	}

	async existingDedupeKeys(keys: string[]): Promise<Set<string>> {
		const found = new Set<string>();
		if (keys.length === 0) return found;
		// Chunked IN() to stay under SQLite's 999-variable limit.
		for (let i = 0; i < keys.length; i += 500) {
			const chunk = keys.slice(i, i + 500);
			const rows = this.db
				.prepare(`SELECT dedupe_key FROM feed_item WHERE dedupe_key IN (${chunk.map(() => '?').join(',')})`)
				.all(...chunk) as { dedupe_key: string }[];
			for (const r of rows) found.add(r.dedupe_key);
		}
		return found;
	}

	async suppressedKeys(scope: FeedSuppressionScope): Promise<Set<string>> {
		const rows = this.db
			.prepare(`SELECT key FROM feed_suppression WHERE scope = ?`)
			.all(scope) as { key: string }[];
		return new Set(rows.map((r) => r.key));
	}

	close(): void {
		this.db.close();
	}
}
