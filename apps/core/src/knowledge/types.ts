// Discovery journeys — shared types. See planning/tech/discovery-journeys.md.
//
// The knowledge base is a VIRTUAL service: the app asks it questions about
// music entities and it answers through a resolver ladder (memory →
// structured providers → agent research), recording every answer into
// knowledge.db — its write-behind memory. Entities here are deliberately
// OUT of the library: nothing points into curator.db; library linkage is a
// computed join over source ids / ISRC at read time (feed LibraryPort
// convention).

import type { Source } from '@curator/shared';

export type KbEntityKind = 'artist' | 'release' | 'track' | 'label' | 'genre';

// Who asserted a row/edge. Providers use the shared Source enum; 'agent' is
// the research sidecar — its rows are claims, not catalog facts, and they
// never drive identity merges (see identity.ts).
export type KbSource = Source | 'agent';

// One expandable facet of an entity — the unit of lazy resolution. An aspect
// is answered by whichever registered resolver supports (kind, aspect);
// kb_expansion tracks per-(entity, aspect, source) progress so a partially
// fetched catalog resumes instead of restarting.
export type KbAspect = 'detail' | 'releases' | 'tracks' | 'similar-artists';

export type KbEdgeKind =
	| 'artist-release'
	| 'release-track'
	| 'track-artist'
	| 'release-label'
	| 'track-label'
	| 'entity-genre'
	// Agent-researched relatedness — the aspect no available API provides
	// (Spotify revoked related-artists for newer third-party apps).
	| 'similar-artist';

export type KbExpansionStatus = 'pending' | 'running' | 'partial' | 'complete' | 'error';

export type KbResolverTier = 'structured' | 'agent';

export interface KbEntity {
	id: string;
	kind: KbEntityKind;
	name: string;
	nameAscii: string;
	// Tracks only — THE cross-source identity pivot.
	isrc: string | null;
	durationSec: number | null;
	releaseDate: string | null;
	coverUrl: string | null;
	attrs: Record<string, unknown> | null;
	// Identity-merge redirect: set when this row was merged into another.
	// Rows are never hard-deleted, only redirected, so journey nodes and
	// edges always stay resolvable. Readers follow the chain (loop-bounded).
	mergedInto: string | null;
	createdAt: number;
	updatedAt: number;
}

// Per-provider identity + provenance row. UNIQUE(source, sourceKind,
// sourceId) is the identity anchor; sources without stable ids (Spotify
// label strings, agent claims) key by 'name:'+searchFold(name).
export interface KbSourceRef {
	entityId: string;
	source: KbSource;
	sourceKind: string;
	sourceId: string;
	url: string | null;
	fetchedAt: number;
}

export interface KbEdge {
	srcId: string;
	kind: KbEdgeKind;
	dstId: string;
	// 'main' | 'featured' | 'remixer' for artist-credit edges.
	role: string | null;
	// Track index within a release (release-track edges).
	position: number | null;
	source: KbSource;
	// 1.0 for catalog facts; model-scored for agent claims.
	confidence: number;
	// Stamped when the user acts on an agent edge (navigates through it,
	// promotes a track from it) — implicit confirmation of the claim.
	hardenedAt: number | null;
	// Agent edges: { citations: string[], rationale?: string }.
	attrs: Record<string, unknown> | null;
	fetchedAt: number;
}

// ─── Resolver drafts ───────────────────────────────────────────────────
// What a resolver page emits. Drafts reference each other by source triple
// (not KB id — ids don't exist until the merge pass resolves identity).

export interface KbEntityDraft {
	kind: KbEntityKind;
	name: string;
	isrc?: string | null;
	durationSec?: number | null;
	releaseDate?: string | null;
	coverUrl?: string | null;
	attrs?: Record<string, unknown>;
	source: KbSource;
	sourceKind: string;
	sourceId: string;
	url?: string | null;
	// Raw normalized provider payload — persisted on kb_entity_source so a
	// later pass can re-process without re-fetching (source_link convention).
	payload?: unknown;
}

// Edge endpoint: either an already-known KB entity (the entity being
// expanded) or a draft in the same page, referenced by its source triple.
export type KbDraftRef =
	| { entityId: string }
	| { source: KbSource; sourceKind: string; sourceId: string };

export interface KbEdgeDraft {
	kind: KbEdgeKind;
	src: KbDraftRef;
	dst: KbDraftRef;
	role?: string | null;
	position?: number | null;
	confidence?: number;
	attrs?: Record<string, unknown>;
}

export interface KbResolverPage {
	entities: KbEntityDraft[];
	edges: KbEdgeDraft[];
	// Provider pagination cursor; null = aspect complete.
	cursor: unknown | null;
}

// Minimal entity snapshot handed to resolvers — the agent resolver forwards
// name + known facts to the sidecar as research context (never a DB handle).
export interface KbEntitySnapshot {
	id: string;
	kind: KbEntityKind;
	name: string;
	knownFacts: Record<string, unknown>;
}

export interface KbResolver {
	readonly source: KbSource;
	readonly tier: KbResolverTier;
	supports(kind: KbEntityKind, aspect: KbAspect): boolean;
	// One PAGE of work — the queue owns pacing + cursor persistence between
	// pages so a mid-crawl crash resumes and no single call holds the loop
	// for a whole catalog. cursor null = first page.
	fetchPage(req: {
		kind: KbEntityKind;
		aspect: KbAspect;
		// This resolver's own id for the entity (from kb_entity_source), or
		// null when it has none (agent resolvers work from the snapshot).
		sourceId: string | null;
		entity: KbEntitySnapshot;
		cursor: unknown | null;
	}): Promise<KbResolverPage>;
}

export interface KbExpansionState {
	entityId: string;
	aspect: KbAspect;
	source: KbSource;
	status: KbExpansionStatus;
	error: string | null;
	fetchedAt: number | null;
	completedAt: number | null;
}

// ─── Read shapes ───────────────────────────────────────────────────────

// Edge as returned to the app: endpoints resolved (merged_into followed),
// tier derived from source so the renderer can mark research claims.
export interface KbEdgeOut extends KbEdge {
	tier: KbResolverTier;
}

export interface KbEntityDetail {
	entity: KbEntity;
	sources: KbSourceRef[];
	edges: KbEdgeOut[];
	// Every entity referenced by `edges`, keyed by id — one batched lookup,
	// not N per-edge queries (CLAUDE.md batch rule).
	neighbors: Record<string, KbEntity>;
	expansions: KbExpansionState[];
	// Which aspects the current resolver registry can answer for this kind —
	// computed, not stored. An aspect absent here renders "unavailable"
	// (e.g. similar-artists with no research sidecar configured).
	availableAspects: { aspect: KbAspect; tier: KbResolverTier }[];
	// Library linkage, computed by the service via the curator.db probe —
	// entityId → canonical library track id, for this entity and any track
	// neighbors the library holds. Never stored.
	inLibrary: Record<string, string>;
}

// Result of expandKbEntity: first-page results inline (structured resolvers
// await page one; agent aspects return 'running' immediately and stream via
// kb:event).
export interface KbExpansion {
	status: KbExpansionStatus;
	entities: KbEntity[];
	edges: KbEdgeOut[];
}

export type KbEvent =
	| {
		kind: 'expansion';
		entityId: string;
		aspect: KbAspect;
		status: KbExpansionStatus;
		newEntityIds: string[];
	}
	| { kind: 'entity-updated'; entityId: string };

// ─── Journeys ──────────────────────────────────────────────────────────

export interface Journey {
	id: string;
	name: string;
	rootNodeId: string;
	// The resumable pointer — where the user is in the tree.
	currentNodeId: string;
	archivedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface JourneyNode {
	id: string;
	journeyId: string;
	// null = root. The tree IS parent pointers — no other structure.
	parentNodeId: string | null;
	// Soft ref into kb_entity (resolve mergedInto at read). entityKind +
	// titleSnapshot are visit-time copies so the tree renders without N
	// entity lookups and survives later KB re-fetches/merges.
	entityId: string;
	entityKind: KbEntityKind;
	titleSnapshot: string;
	// Renderer-owned opaque view state (tab, scroll, expanded aspect).
	view: unknown;
	// Sibling order under parent (branch creation order).
	position: number;
	note: string | null;
	createdAt: number;
	visitedAt: number;
}

export interface JourneySummary {
	id: string;
	name: string;
	nodeCount: number;
	currentEntityName: string;
	updatedAt: number;
}

export interface JourneyDetail {
	journey: Journey;
	// Flat array — the renderer reassembles the tree via parentNodeId
	// (getRekordboxTree convention).
	nodes: JourneyNode[];
}

// Where a journey (or a bare KB resolve) starts from. A source-ref seed
// (e.g. a feed card's Spotify track) carries the entity kind + display name
// so the KB can mint the entity before any provider fetch has run.
export type JourneySeed =
	| { kind: 'library-track'; trackId: string }
	| { kind: 'kb-entity'; entityId: string }
	| {
		kind: 'source-ref';
		source: KbSource;
		sourceKind: string;
		sourceId: string;
		entityKind: KbEntityKind;
		name: string;
	};
