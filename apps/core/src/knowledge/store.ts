// KnowledgeStore — storage contract for the knowledge base + journeys, plus
// the SQLite implementation over a separate knowledge.db.
//
// Why a separate DB: the KB is a permanent, accumulating memory of scraped/
// fetched catalog knowledge — the opposite lifecycle of the disposable,
// pruned feed.db, and deliberately OUT of the sacred curator.db (its churn,
// migrations, and any future experiments must never touch the library file).
// No foreign keys cross databases: library linkage is a computed join over
// source ids / ISRC at read time (feed LibraryPort convention).
//
// Unlike FeedStore, methods here are SYNCHRONOUS: identity resolution
// composes several store calls inside one better-sqlite3 transaction (find →
// insert → ref → edges must commit atomically per resolver page), and you
// can't await inside a better-sqlite3 txn. The async cloud seam lives one
// layer up, on the KnowledgeService interface.

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { searchFold } from '@curator/shared';
import type {
	Journey,
	JourneyDetail,
	JourneyNode,
	JourneySummary,
	KbAspect,
	KbEdge,
	KbEntity,
	KbEntityKind,
	KbExpansionState,
	KbExpansionStatus,
	KbSource,
	KbSourceRef,
} from './types.js';

export interface KbEntityInsert {
	kind: KbEntityKind;
	name: string;
	isrc?: string | null;
	durationSec?: number | null;
	releaseDate?: string | null;
	coverUrl?: string | null;
	attrs?: Record<string, unknown> | null;
}

// Patch semantics: fill-or-refresh scalar fields; null/undefined leaves the
// stored value alone (a later source with LESS data must not blank an
// earlier source's fields).
export interface KbEntityPatch {
	name?: string;
	isrc?: string | null;
	durationSec?: number | null;
	releaseDate?: string | null;
	coverUrl?: string | null;
	attrs?: Record<string, unknown> | null;
}

export interface KbSourceRefInsert {
	source: KbSource;
	sourceKind: string;
	sourceId: string;
	url?: string | null;
	payload?: unknown;
}

// Concrete edge write — endpoints already resolved to KB ids by the merge
// pass. Upsert keeps an existing row's hardened_at (a re-fetch must not
// un-harden a user-confirmed claim).
export interface KbEdgeUpsert {
	srcId: string;
	kind: KbEdge['kind'];
	dstId: string;
	role?: string | null;
	position?: number | null;
	source: KbSource;
	confidence?: number;
	attrs?: Record<string, unknown> | null;
}

export interface KbExpansionUpsert {
	entityId: string;
	aspect: KbAspect;
	source: KbSource;
	status: KbExpansionStatus;
	cursor?: unknown;
	error?: string | null;
	// Stamp fetched_at (a page landed) / completed_at (aspect finished).
	pageLanded?: boolean;
	completed?: boolean;
}

export interface JourneyNodeEntity {
	id: string;
	kind: KbEntityKind;
	title: string;
}

export interface KnowledgeStore {
	// ── Entities ──
	insertEntity(e: KbEntityInsert): KbEntity;
	// Follows the merged_into chain — callers always get the live row.
	getEntity(id: string): KbEntity | null;
	getEntities(ids: string[]): KbEntity[];
	patchEntity(id: string, patch: KbEntityPatch): void;
	findBySourceRef(source: KbSource, sourceKind: string, sourceId: string): KbEntity | null;
	upsertSourceRef(entityId: string, ref: KbSourceRefInsert): void;
	getSourceRefs(entityId: string): KbSourceRef[];
	findTrackByIsrc(isrc: string): KbEntity | null;
	// Live (unmerged) rows with this kind + folded name.
	findByName(kind: KbEntityKind, nameAscii: string): KbEntity[];
	findTracksByNameDuration(nameAscii: string, durationSec: number, toleranceSec: number): KbEntity[];
	searchEntities(query: string, kinds?: KbEntityKind[], limit?: number): KbEntity[];
	// Identity merge: redirect loser → winner, move source refs, rewrite
	// edges onto the winner (keeping max confidence / hardened_at). The
	// loser row survives as a redirect so journey nodes never dangle.
	mergeEntities(winnerId: string, loserId: string): void;
	// Corroboration probe: number of distinct entities that BOTH a and b
	// touch via structured (non-agent) edges, in either direction. Shared
	// structural facts justify an artist auto-merge; names alone never do.
	countSharedStructuredNeighbors(aId: string, bId: string): number;

	// ── Edges ──
	upsertEdges(edges: KbEdgeUpsert[]): void;
	// Both directions for one entity.
	getEdgesFor(entityId: string): KbEdge[];
	hardenEdge(srcId: string, kind: KbEdge['kind'], dstId: string): void;

	// ── Expansions ──
	getExpansions(entityId: string): KbExpansionState[];
	getExpansion(entityId: string, aspect: KbAspect, source: KbSource): (KbExpansionState & { cursor: unknown }) | null;
	setExpansion(u: KbExpansionUpsert): void;
	// Boot crash-recovery: rows stuck 'running' go back to 'pending'
	// (analysis_job convention).
	resetRunningExpansions(): void;

	// ── Journeys ──
	createJourney(name: string, root: JourneyNodeEntity): JourneyDetail;
	listJourneys(): JourneySummary[];
	getJourneyRow(journeyId: string): Journey | null;
	getJourney(journeyId: string): JourneyDetail | null;
	renameJourney(journeyId: string, name: string): void;
	deleteJourney(journeyId: string): void;
	getNode(nodeId: string): JourneyNode | null;
	// Existing child of `parentNodeId` pointing at `entityId` — the sibling-
	// reuse probe (navigating to an already-visited child re-enters it
	// instead of spawning a twin).
	findChild(journeyId: string, parentNodeId: string, entityId: string): JourneyNode | null;
	// Append a child under parent + move the journey's current pointer —
	// one transaction; this IS "navigate". Fork needs no special case: an
	// append under an interior node is a new branch by construction.
	appendChild(journeyId: string, parentNodeId: string, entity: JourneyNodeEntity): JourneyNode;
	// Move the pointer only ("jump back"); re-stamps visited_at.
	setCurrent(journeyId: string, nodeId: string): void;
	setNodeView(nodeId: string, view: unknown): void;
	// Remove a subtree. Refuses the root (delete the journey instead);
	// repoints current to the subtree's parent when current was inside.
	deleteBranch(journeyId: string, nodeId: string): { removed: number };

	// Compose multiple store calls atomically (resolver page merges).
	transaction<T>(fn: () => T): T;
	close(): void;
}

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS kb_meta (
	key TEXT PRIMARY KEY,
	value TEXT
);
CREATE TABLE IF NOT EXISTS kb_entity (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	name TEXT NOT NULL,
	name_ascii TEXT NOT NULL,
	isrc TEXT,
	duration_sec INTEGER,
	release_date TEXT,
	cover_url TEXT,
	attrs_json TEXT,
	merged_into TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_entity_kind_name ON kb_entity (kind, name_ascii);
CREATE INDEX IF NOT EXISTS idx_kb_entity_isrc ON kb_entity (isrc);
CREATE TABLE IF NOT EXISTS kb_entity_source (
	entity_id TEXT NOT NULL,
	source TEXT NOT NULL,
	source_kind TEXT NOT NULL,
	source_id TEXT NOT NULL,
	url TEXT,
	payload_json TEXT,
	fetched_at INTEGER NOT NULL,
	PRIMARY KEY (source, source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_entity_source_entity ON kb_entity_source (entity_id);
CREATE TABLE IF NOT EXISTS kb_edge (
	src_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	dst_id TEXT NOT NULL,
	role TEXT,
	position INTEGER,
	source TEXT NOT NULL,
	confidence REAL NOT NULL DEFAULT 1,
	hardened_at INTEGER,
	attrs_json TEXT,
	fetched_at INTEGER NOT NULL,
	PRIMARY KEY (src_id, kind, dst_id, source)
);
CREATE INDEX IF NOT EXISTS idx_kb_edge_dst ON kb_edge (dst_id, kind);
CREATE TABLE IF NOT EXISTS kb_expansion (
	entity_id TEXT NOT NULL,
	aspect TEXT NOT NULL,
	source TEXT NOT NULL,
	status TEXT NOT NULL,
	cursor_json TEXT,
	error TEXT,
	fetched_at INTEGER,
	completed_at INTEGER,
	PRIMARY KEY (entity_id, aspect, source)
);
CREATE TABLE IF NOT EXISTS journey (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	root_node_id TEXT NOT NULL,
	current_node_id TEXT NOT NULL,
	archived_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journey_node (
	id TEXT PRIMARY KEY,
	journey_id TEXT NOT NULL,
	parent_node_id TEXT,
	entity_id TEXT NOT NULL,
	entity_kind TEXT NOT NULL,
	title_snapshot TEXT NOT NULL,
	view_json TEXT,
	position INTEGER NOT NULL,
	note TEXT,
	created_at INTEGER NOT NULL,
	visited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journey_node_journey ON journey_node (journey_id);
`;

interface EntityRow {
	id: string;
	kind: string;
	name: string;
	name_ascii: string;
	isrc: string | null;
	duration_sec: number | null;
	release_date: string | null;
	cover_url: string | null;
	attrs_json: string | null;
	merged_into: string | null;
	created_at: number;
	updated_at: number;
}

interface EdgeRow {
	src_id: string;
	kind: string;
	dst_id: string;
	role: string | null;
	position: number | null;
	source: string;
	confidence: number;
	hardened_at: number | null;
	attrs_json: string | null;
	fetched_at: number;
}

interface NodeRow {
	id: string;
	journey_id: string;
	parent_node_id: string | null;
	entity_id: string;
	entity_kind: string;
	title_snapshot: string;
	view_json: string | null;
	position: number;
	note: string | null;
	created_at: number;
	visited_at: number;
}

interface JourneyRow {
	id: string;
	name: string;
	root_node_id: string;
	current_node_id: string;
	archived_at: number | null;
	created_at: number;
	updated_at: number;
}

function rowToEntity(r: EntityRow): KbEntity {
	return {
		id: r.id,
		kind: r.kind as KbEntityKind,
		name: r.name,
		nameAscii: r.name_ascii,
		isrc: r.isrc,
		durationSec: r.duration_sec,
		releaseDate: r.release_date,
		coverUrl: r.cover_url,
		attrs: r.attrs_json ? (JSON.parse(r.attrs_json) as Record<string, unknown>) : null,
		mergedInto: r.merged_into,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

function rowToEdge(r: EdgeRow): KbEdge {
	return {
		srcId: r.src_id,
		kind: r.kind as KbEdge['kind'],
		dstId: r.dst_id,
		role: r.role,
		position: r.position,
		source: r.source as KbSource,
		confidence: r.confidence,
		hardenedAt: r.hardened_at,
		attrs: r.attrs_json ? (JSON.parse(r.attrs_json) as Record<string, unknown>) : null,
		fetchedAt: r.fetched_at,
	};
}

function rowToNode(r: NodeRow): JourneyNode {
	return {
		id: r.id,
		journeyId: r.journey_id,
		parentNodeId: r.parent_node_id,
		entityId: r.entity_id,
		entityKind: r.entity_kind as KbEntityKind,
		titleSnapshot: r.title_snapshot,
		view: r.view_json ? (JSON.parse(r.view_json) as unknown) : null,
		position: r.position,
		note: r.note,
		createdAt: r.created_at,
		visitedAt: r.visited_at,
	};
}

function rowToJourney(r: JourneyRow): Journey {
	return {
		id: r.id,
		name: r.name,
		rootNodeId: r.root_node_id,
		currentNodeId: r.current_node_id,
		archivedAt: r.archived_at,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
}

export class SqliteKnowledgeStore implements KnowledgeStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.db.exec(DDL);
		this.db
			.prepare(`INSERT OR REPLACE INTO kb_meta (key, value) VALUES ('schema_version', ?)`)
			.run(String(SCHEMA_VERSION));
	}

	// ── Entities ──

	insertEntity(e: KbEntityInsert): KbEntity {
		const now = Date.now();
		const id = randomUUID();
		this.db
			.prepare(`
				INSERT INTO kb_entity (id, kind, name, name_ascii, isrc, duration_sec, release_date, cover_url, attrs_json, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`)
			.run(
				id,
				e.kind,
				e.name,
				searchFold(e.name),
				e.isrc ?? null,
				e.durationSec ?? null,
				e.releaseDate ?? null,
				e.coverUrl ?? null,
				e.attrs ? JSON.stringify(e.attrs) : null,
				now,
				now,
			);
		return this.getEntity(id)!;
	}

	getEntity(id: string): KbEntity | null {
		// Follow the merged_into chain (bounded — a cycle would be a bug, not
		// a state to loop on).
		let cur = id;
		for (let i = 0; i < 10; i++) {
			const row = this.db.prepare(`SELECT * FROM kb_entity WHERE id = ?`).get(cur) as EntityRow | undefined;
			if (!row) return null;
			if (!row.merged_into) return rowToEntity(row);
			cur = row.merged_into;
		}
		return null;
	}

	getEntities(ids: string[]): KbEntity[] {
		const out: KbEntity[] = [];
		const seen = new Set<string>();
		// Batched, but per-id chain resolution — merged rows are rare and the
		// chain is short; the common case is one IN() probe per chunk.
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500);
			const rows = this.db
				.prepare(`SELECT * FROM kb_entity WHERE id IN (${chunk.map(() => '?').join(',')})`)
				.all(...chunk) as EntityRow[];
			for (const row of rows) {
				const e = row.merged_into ? this.getEntity(row.id) : rowToEntity(row);
				if (e && !seen.has(e.id)) {
					seen.add(e.id);
					out.push(e);
				}
			}
		}
		return out;
	}

	patchEntity(id: string, patch: KbEntityPatch): void {
		// COALESCE-style fill: an incoming null/undefined never blanks a field
		// an earlier source filled. Name updates also refresh name_ascii.
		const existing = this.db.prepare(`SELECT * FROM kb_entity WHERE id = ?`).get(id) as EntityRow | undefined;
		if (!existing) return;
		const attrs = patch.attrs
			? { ...(existing.attrs_json ? (JSON.parse(existing.attrs_json) as Record<string, unknown>) : {}), ...patch.attrs }
			: undefined;
		this.db
			.prepare(`
				UPDATE kb_entity SET
					name = COALESCE(?, name),
					name_ascii = COALESCE(?, name_ascii),
					isrc = COALESCE(?, isrc),
					duration_sec = COALESCE(?, duration_sec),
					release_date = COALESCE(?, release_date),
					cover_url = COALESCE(?, cover_url),
					attrs_json = COALESCE(?, attrs_json),
					updated_at = ?
				WHERE id = ?
			`)
			.run(
				patch.name ?? null,
				patch.name ? searchFold(patch.name) : null,
				patch.isrc ?? null,
				patch.durationSec ?? null,
				patch.releaseDate ?? null,
				patch.coverUrl ?? null,
				attrs ? JSON.stringify(attrs) : null,
				Date.now(),
				id,
			);
	}

	findBySourceRef(source: KbSource, sourceKind: string, sourceId: string): KbEntity | null {
		const row = this.db
			.prepare(`SELECT entity_id FROM kb_entity_source WHERE source = ? AND source_kind = ? AND source_id = ?`)
			.get(source, sourceKind, sourceId) as { entity_id: string } | undefined;
		return row ? this.getEntity(row.entity_id) : null;
	}

	upsertSourceRef(entityId: string, ref: KbSourceRefInsert): void {
		this.db
			.prepare(`
				INSERT INTO kb_entity_source (entity_id, source, source_kind, source_id, url, payload_json, fetched_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (source, source_kind, source_id) DO UPDATE SET
					entity_id = excluded.entity_id,
					url = COALESCE(excluded.url, kb_entity_source.url),
					payload_json = COALESCE(excluded.payload_json, kb_entity_source.payload_json),
					fetched_at = excluded.fetched_at
			`)
			.run(
				entityId,
				ref.source,
				ref.sourceKind,
				ref.sourceId,
				ref.url ?? null,
				ref.payload === undefined ? null : JSON.stringify(ref.payload),
				Date.now(),
			);
	}

	getSourceRefs(entityId: string): KbSourceRef[] {
		const rows = this.db
			.prepare(`SELECT entity_id, source, source_kind, source_id, url, fetched_at FROM kb_entity_source WHERE entity_id = ?`)
			.all(entityId) as { entity_id: string; source: string; source_kind: string; source_id: string; url: string | null; fetched_at: number }[];
		return rows.map((r) => ({
			entityId: r.entity_id,
			source: r.source as KbSource,
			sourceKind: r.source_kind,
			sourceId: r.source_id,
			url: r.url,
			fetchedAt: r.fetched_at,
		}));
	}

	findTrackByIsrc(isrc: string): KbEntity | null {
		const row = this.db
			.prepare(`SELECT * FROM kb_entity WHERE kind = 'track' AND isrc = ? AND merged_into IS NULL LIMIT 1`)
			.get(isrc) as EntityRow | undefined;
		return row ? rowToEntity(row) : null;
	}

	findByName(kind: KbEntityKind, nameAscii: string): KbEntity[] {
		const rows = this.db
			.prepare(`SELECT * FROM kb_entity WHERE kind = ? AND name_ascii = ? AND merged_into IS NULL`)
			.all(kind, nameAscii) as EntityRow[];
		return rows.map(rowToEntity);
	}

	findTracksByNameDuration(nameAscii: string, durationSec: number, toleranceSec: number): KbEntity[] {
		const rows = this.db
			.prepare(`
				SELECT * FROM kb_entity
				WHERE kind = 'track' AND name_ascii = ? AND merged_into IS NULL
					AND duration_sec IS NOT NULL AND ABS(duration_sec - ?) <= ?
			`)
			.all(nameAscii, durationSec, toleranceSec) as EntityRow[];
		return rows.map(rowToEntity);
	}

	searchEntities(query: string, kinds?: KbEntityKind[], limit = 30): KbEntity[] {
		const folded = searchFold(query);
		if (!folded) return [];
		const kindFilter = kinds && kinds.length > 0 ? `AND kind IN (${kinds.map(() => '?').join(',')})` : '';
		const rows = this.db
			.prepare(`
				SELECT * FROM kb_entity
				WHERE name_ascii LIKE ? AND merged_into IS NULL ${kindFilter}
				ORDER BY name_ascii LIKE ? DESC, name COLLATE NOCASE
				LIMIT ?
			`)
			.all(`%${folded}%`, ...(kinds ?? []), `${folded}%`, Math.min(Math.max(limit, 1), 100)) as EntityRow[];
		return rows.map(rowToEntity);
	}

	mergeEntities(winnerId: string, loserId: string): void {
		if (winnerId === loserId) return;
		const txn = this.db.transaction(() => {
			const winner = this.db.prepare(`SELECT id, merged_into FROM kb_entity WHERE id = ?`).get(winnerId) as
				| { id: string; merged_into: string | null }
				| undefined;
			const loser = this.db.prepare(`SELECT id, merged_into FROM kb_entity WHERE id = ?`).get(loserId) as
				| { id: string; merged_into: string | null }
				| undefined;
			if (!winner || !loser || winner.merged_into || loser.merged_into) return;
			this.db.prepare(`UPDATE kb_entity SET merged_into = ?, updated_at = ? WHERE id = ?`).run(winnerId, Date.now(), loserId);
			this.db.prepare(`UPDATE kb_entity_source SET entity_id = ? WHERE entity_id = ?`).run(winnerId, loserId);
			// Rewrite edges onto the winner. Delete + re-upsert (not UPDATE):
			// the winner may already carry the same (kind, dst, source) row —
			// keep the stronger fact (max confidence, earliest hardening).
			const touching = this.db
				.prepare(`SELECT * FROM kb_edge WHERE src_id = ? OR dst_id = ?`)
				.all(loserId, loserId) as EdgeRow[];
			const del = this.db.prepare(`DELETE FROM kb_edge WHERE src_id = ? AND kind = ? AND dst_id = ? AND source = ?`);
			const upsert = this.db.prepare(`
				INSERT INTO kb_edge (src_id, kind, dst_id, role, position, source, confidence, hardened_at, attrs_json, fetched_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (src_id, kind, dst_id, source) DO UPDATE SET
					confidence = MAX(kb_edge.confidence, excluded.confidence),
					hardened_at = COALESCE(kb_edge.hardened_at, excluded.hardened_at),
					role = COALESCE(excluded.role, kb_edge.role),
					position = COALESCE(excluded.position, kb_edge.position),
					attrs_json = COALESCE(excluded.attrs_json, kb_edge.attrs_json),
					fetched_at = MAX(kb_edge.fetched_at, excluded.fetched_at)
			`);
			for (const e of touching) {
				del.run(e.src_id, e.kind, e.dst_id, e.source);
				const src = e.src_id === loserId ? winnerId : e.src_id;
				const dst = e.dst_id === loserId ? winnerId : e.dst_id;
				if (src === dst) continue; // self-edge after merge — drop
				upsert.run(src, e.kind, dst, e.role, e.position, e.source, e.confidence, e.hardened_at, e.attrs_json, e.fetched_at);
			}
		});
		txn();
	}

	countSharedStructuredNeighbors(aId: string, bId: string): number {
		// Distinct entities both a and b touch via non-agent edges, either
		// direction. One query, no JS set math.
		const row = this.db
			.prepare(`
				SELECT COUNT(*) AS n FROM (
					SELECT CASE WHEN src_id = ? THEN dst_id ELSE src_id END AS other
					FROM kb_edge WHERE (src_id = ? OR dst_id = ?) AND source != 'agent'
					INTERSECT
					SELECT CASE WHEN src_id = ? THEN dst_id ELSE src_id END AS other
					FROM kb_edge WHERE (src_id = ? OR dst_id = ?) AND source != 'agent'
				)
			`)
			.get(aId, aId, aId, bId, bId, bId) as { n: number };
		return row.n;
	}

	// ── Edges ──

	upsertEdges(edges: KbEdgeUpsert[]): void {
		if (edges.length === 0) return;
		const now = Date.now();
		const stmt = this.db.prepare(`
			INSERT INTO kb_edge (src_id, kind, dst_id, role, position, source, confidence, attrs_json, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (src_id, kind, dst_id, source) DO UPDATE SET
				role = COALESCE(excluded.role, kb_edge.role),
				position = COALESCE(excluded.position, kb_edge.position),
				confidence = excluded.confidence,
				attrs_json = COALESCE(excluded.attrs_json, kb_edge.attrs_json),
				fetched_at = excluded.fetched_at
		`);
		const txn = this.db.transaction(() => {
			for (const e of edges) {
				if (e.srcId === e.dstId) continue;
				stmt.run(
					e.srcId,
					e.kind,
					e.dstId,
					e.role ?? null,
					e.position ?? null,
					e.source,
					e.confidence ?? 1,
					e.attrs ? JSON.stringify(e.attrs) : null,
					now,
				);
			}
		});
		txn();
	}

	getEdgesFor(entityId: string): KbEdge[] {
		const rows = this.db
			.prepare(`SELECT * FROM kb_edge WHERE src_id = ? OR dst_id = ?`)
			.all(entityId, entityId) as EdgeRow[];
		return rows.map(rowToEdge);
	}

	hardenEdge(srcId: string, kind: KbEdge['kind'], dstId: string): void {
		// Any-source rows for the triple; only stamps the first time.
		this.db
			.prepare(`UPDATE kb_edge SET hardened_at = COALESCE(hardened_at, ?) WHERE src_id = ? AND kind = ? AND dst_id = ?`)
			.run(Date.now(), srcId, kind, dstId);
	}

	// ── Expansions ──

	getExpansions(entityId: string): KbExpansionState[] {
		const rows = this.db
			.prepare(`SELECT entity_id, aspect, source, status, error, fetched_at, completed_at FROM kb_expansion WHERE entity_id = ?`)
			.all(entityId) as { entity_id: string; aspect: string; source: string; status: string; error: string | null; fetched_at: number | null; completed_at: number | null }[];
		return rows.map((r) => ({
			entityId: r.entity_id,
			aspect: r.aspect as KbAspect,
			source: r.source as KbSource,
			status: r.status as KbExpansionStatus,
			error: r.error,
			fetchedAt: r.fetched_at,
			completedAt: r.completed_at,
		}));
	}

	getExpansion(entityId: string, aspect: KbAspect, source: KbSource): (KbExpansionState & { cursor: unknown }) | null {
		const r = this.db
			.prepare(`SELECT * FROM kb_expansion WHERE entity_id = ? AND aspect = ? AND source = ?`)
			.get(entityId, aspect, source) as
			| { entity_id: string; aspect: string; source: string; status: string; cursor_json: string | null; error: string | null; fetched_at: number | null; completed_at: number | null }
			| undefined;
		if (!r) return null;
		return {
			entityId: r.entity_id,
			aspect: r.aspect as KbAspect,
			source: r.source as KbSource,
			status: r.status as KbExpansionStatus,
			error: r.error,
			fetchedAt: r.fetched_at,
			completedAt: r.completed_at,
			cursor: r.cursor_json ? JSON.parse(r.cursor_json) : null,
		};
	}

	setExpansion(u: KbExpansionUpsert): void {
		const now = Date.now();
		this.db
			.prepare(`
				INSERT INTO kb_expansion (entity_id, aspect, source, status, cursor_json, error, fetched_at, completed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (entity_id, aspect, source) DO UPDATE SET
					status = excluded.status,
					cursor_json = excluded.cursor_json,
					error = excluded.error,
					fetched_at = COALESCE(excluded.fetched_at, kb_expansion.fetched_at),
					completed_at = COALESCE(excluded.completed_at, kb_expansion.completed_at)
			`)
			.run(
				u.entityId,
				u.aspect,
				u.source,
				u.status,
				u.cursor === undefined || u.cursor === null ? null : JSON.stringify(u.cursor),
				u.error ?? null,
				u.pageLanded ? now : null,
				u.completed ? now : null,
			);
	}

	resetRunningExpansions(): void {
		this.db.prepare(`UPDATE kb_expansion SET status = 'pending' WHERE status = 'running'`).run();
	}

	// ── Journeys ──

	createJourney(name: string, root: JourneyNodeEntity): JourneyDetail {
		const now = Date.now();
		const journeyId = randomUUID();
		const nodeId = randomUUID();
		const txn = this.db.transaction(() => {
			this.db
				.prepare(`
					INSERT INTO journey_node (id, journey_id, parent_node_id, entity_id, entity_kind, title_snapshot, position, created_at, visited_at)
					VALUES (?, ?, NULL, ?, ?, ?, 0, ?, ?)
				`)
				.run(nodeId, journeyId, root.id, root.kind, root.title, now, now);
			this.db
				.prepare(`
					INSERT INTO journey (id, name, root_node_id, current_node_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?)
				`)
				.run(journeyId, name, nodeId, nodeId, now, now);
		});
		txn();
		return this.getJourney(journeyId)!;
	}

	listJourneys(): JourneySummary[] {
		const rows = this.db
			.prepare(`
				SELECT j.id, j.name, j.updated_at,
					(SELECT COUNT(*) FROM journey_node n WHERE n.journey_id = j.id) AS node_count,
					(SELECT title_snapshot FROM journey_node n WHERE n.id = j.current_node_id) AS current_name
				FROM journey j
				WHERE j.archived_at IS NULL
				ORDER BY j.updated_at DESC
			`)
			.all() as { id: string; name: string; updated_at: number; node_count: number; current_name: string | null }[];
		return rows.map((r) => ({
			id: r.id,
			name: r.name,
			nodeCount: r.node_count,
			currentEntityName: r.current_name ?? '',
			updatedAt: r.updated_at,
		}));
	}

	getJourneyRow(journeyId: string): Journey | null {
		const row = this.db.prepare(`SELECT * FROM journey WHERE id = ?`).get(journeyId) as JourneyRow | undefined;
		return row ? rowToJourney(row) : null;
	}

	getJourney(journeyId: string): JourneyDetail | null {
		const journey = this.getJourneyRow(journeyId);
		if (!journey) return null;
		const rows = this.db
			.prepare(`SELECT * FROM journey_node WHERE journey_id = ? ORDER BY created_at, position`)
			.all(journeyId) as NodeRow[];
		return { journey, nodes: rows.map(rowToNode) };
	}

	renameJourney(journeyId: string, name: string): void {
		this.db.prepare(`UPDATE journey SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), journeyId);
	}

	deleteJourney(journeyId: string): void {
		const txn = this.db.transaction(() => {
			this.db.prepare(`DELETE FROM journey_node WHERE journey_id = ?`).run(journeyId);
			this.db.prepare(`DELETE FROM journey WHERE id = ?`).run(journeyId);
		});
		txn();
	}

	getNode(nodeId: string): JourneyNode | null {
		const row = this.db.prepare(`SELECT * FROM journey_node WHERE id = ?`).get(nodeId) as NodeRow | undefined;
		return row ? rowToNode(row) : null;
	}

	findChild(journeyId: string, parentNodeId: string, entityId: string): JourneyNode | null {
		const row = this.db
			.prepare(`SELECT * FROM journey_node WHERE journey_id = ? AND parent_node_id = ? AND entity_id = ? LIMIT 1`)
			.get(journeyId, parentNodeId, entityId) as NodeRow | undefined;
		return row ? rowToNode(row) : null;
	}

	appendChild(journeyId: string, parentNodeId: string, entity: JourneyNodeEntity): JourneyNode {
		const now = Date.now();
		const id = randomUUID();
		const txn = this.db.transaction(() => {
			const pos = (
				this.db
					.prepare(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM journey_node WHERE journey_id = ? AND parent_node_id = ?`)
					.get(journeyId, parentNodeId) as { p: number }
			).p;
			this.db
				.prepare(`
					INSERT INTO journey_node (id, journey_id, parent_node_id, entity_id, entity_kind, title_snapshot, position, created_at, visited_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(id, journeyId, parentNodeId, entity.id, entity.kind, entity.title, pos, now, now);
			this.db.prepare(`UPDATE journey SET current_node_id = ?, updated_at = ? WHERE id = ?`).run(id, now, journeyId);
		});
		txn();
		return this.getNode(id)!;
	}

	setCurrent(journeyId: string, nodeId: string): void {
		const now = Date.now();
		const txn = this.db.transaction(() => {
			this.db.prepare(`UPDATE journey SET current_node_id = ?, updated_at = ? WHERE id = ?`).run(nodeId, now, journeyId);
			this.db.prepare(`UPDATE journey_node SET visited_at = ? WHERE id = ?`).run(now, nodeId);
		});
		txn();
	}

	setNodeView(nodeId: string, view: unknown): void {
		this.db
			.prepare(`UPDATE journey_node SET view_json = ? WHERE id = ?`)
			.run(view == null ? null : JSON.stringify(view), nodeId);
	}

	deleteBranch(journeyId: string, nodeId: string): { removed: number } {
		const journey = this.getJourneyRow(journeyId);
		if (!journey) return { removed: 0 };
		if (journey.rootNodeId === nodeId) {
			throw new Error('cannot delete the root branch — delete the journey instead');
		}
		const txn = this.db.transaction((): number => {
			// Collect the subtree by walking children breadth-first.
			const node = this.getNode(nodeId);
			if (!node || node.journeyId !== journeyId) return 0;
			const subtree: string[] = [];
			let frontier = [nodeId];
			while (frontier.length > 0) {
				subtree.push(...frontier);
				const rows = this.db
					.prepare(`SELECT id FROM journey_node WHERE journey_id = ? AND parent_node_id IN (${frontier.map(() => '?').join(',')})`)
					.all(journeyId, ...frontier) as { id: string }[];
				frontier = rows.map((r) => r.id);
			}
			// Current inside the subtree → repoint to the removed branch's parent.
			if (subtree.includes(journey.currentNodeId)) {
				this.db
					.prepare(`UPDATE journey SET current_node_id = ?, updated_at = ? WHERE id = ?`)
					.run(node.parentNodeId, Date.now(), journeyId);
			}
			const del = this.db.prepare(`DELETE FROM journey_node WHERE id = ?`);
			for (const id of subtree) del.run(id);
			return subtree.length;
		});
		return { removed: txn() };
	}

	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn)();
	}

	close(): void {
		this.db.close();
	}
}
