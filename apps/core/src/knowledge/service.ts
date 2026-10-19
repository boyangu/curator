// Knowledge service — the virtual KB facade + journeys. The app asks it
// questions about music entities; it answers through the resolver ladder
// (memory → structured providers → agent research) and records every
// answer into knowledge.db. See planning/tech/discovery-journeys.md.
//
// Composition mirrors createFeedService: the service depends only on
// injected ports (store, auth, a narrow library port, an optional research
// port) — no curator.db schema, no Electron. Disabled states are supported
// at every seam: no Spotify token ⇒ structured expansion errors cleanly
// with memory answers intact; no research port ⇒ the agent tier simply
// isn't registered and similar-artists reads "unavailable".

import { SpotifyClient, type SpotifyTrack } from '@curator/spotify';
import { artistNames, searchFold, splitArtistCredit } from '@curator/shared';
import type { EnrichmentResult } from '../enrich/contract.js';
import type { FeedAuthPort } from '../feed/types.js';
import { KbExpansionQueue } from './expansion.js';
import { resolveDraft } from './identity.js';
import { ResearcherKbResolver } from './resolvers/researcher.js';
import { SpotifyKbResolver } from './resolvers/spotify.js';
import type { ResearchPort } from './researcher-sidecar.js';
import type { KnowledgeStore } from './store.js';
import type {
	Journey,
	JourneyDetail,
	JourneyNode,
	JourneySeed,
	JourneySummary,
	KbAspect,
	KbEdge,
	KbEdgeOut,
	KbEntity,
	KbEntityDetail,
	KbEntityKind,
	KbEvent,
	KbExpansion,
	KbResolver,
} from './types.js';
import { log } from '../log.js';

const klog = log.for('kb');

// The only place knowledge/ reaches the library — a narrow slice of the
// feed's LibraryPort plus a seed reader. Local adapter lives in service.ts;
// a cloud adapter would be a synced-library query/mutation.
export interface KnowledgeLibraryPort {
	// Same contract as feed LibraryPort.promote — reusing it keeps a
	// journey-promoted track byte-identical to a feed-promoted one.
	promote(track: SpotifyTrack, enrichment: EnrichmentResult | null, opts?: { pin?: boolean }): Promise<string>;
	// Canonical curator ids for tracks the library holds (KB→library linkage
	// is computed here at read time, never stored).
	libraryTrackIds(probe: { isrcs: string[]; spotifyTrackIds: string[] }): Promise<{
		bySpotify: Record<string, string>;
		byIsrc: Record<string, string>;
	}>;
	// What the KB needs to mint an entity from a library track: display
	// fields + the Spotify link when one exists.
	getTrackSeed(trackId: string): Promise<{
		title: string;
		artists: string[];
		isrc: string | null;
		durationSec: number | null;
		coverUrl: string | null;
		releaseDate: string | null;
		spotifyTrackId: string | null;
	} | null>;
}

export interface KnowledgeServiceDeps {
	store: KnowledgeStore;
	auth: FeedAuthPort;
	library: KnowledgeLibraryPort;
	// Absent ⇒ the agent tier is off (disabled is a supported state).
	researcher?: ResearchPort;
}

export interface KnowledgeService {
	// ── Journeys ──
	createJourney(seed: JourneySeed, opts?: { name?: string }): Promise<JourneyDetail>;
	listJourneys(): Promise<JourneySummary[]>;
	getJourney(journeyId: string): Promise<JourneyDetail | null>;
	renameJourney(journeyId: string, name: string): Promise<void>;
	deleteJourney(journeyId: string): Promise<void>;
	journeyNavigate(journeyId: string, entityId: string, opts?: { forceBranch?: boolean }): Promise<{ node: JourneyNode; entity: KbEntityDetail }>;
	journeyJumpTo(journeyId: string, nodeId: string): Promise<KbEntityDetail>;
	journeySetNodeView(journeyId: string, nodeId: string, view: unknown): Promise<void>;
	journeyDeleteBranch(journeyId: string, nodeId: string): Promise<{ removed: number }>;

	// ── Knowledge ──
	getKbEntity(entityId: string): Promise<KbEntityDetail | null>;
	expandKbEntity(entityId: string, aspect: KbAspect, opts?: { refresh?: boolean }): Promise<KbExpansion>;
	searchKb(query: string, kinds?: KbEntityKind[]): Promise<KbEntity[]>;
	resolveKbEntity(seed: JourneySeed): Promise<KbEntityDetail>;
	promoteKbTrack(entityId: string, opts?: { pin?: boolean }): Promise<{ trackId: string }>;
	subscribeEvents(cb: (e: KbEvent) => void): () => void;
	stop(): void;
}

// Which edge kinds answer an aspect from memory.
const ASPECT_EDGE_KINDS: Record<KbAspect, KbEdge['kind'][]> = {
	detail: ['entity-genre'],
	releases: ['artist-release'],
	tracks: ['release-track', 'release-label'],
	'similar-artists': ['similar-artist'],
};

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
	const { store, auth, library } = deps;

	const spotifyClient = async (): Promise<SpotifyClient | null> => {
		const token = await auth.getSpotifyAccessToken().catch(() => null);
		return token ? new SpotifyClient(token, 'kb') : null;
	};

	const listeners = new Set<(e: KbEvent) => void>();
	const resolvers: KbResolver[] = [new SpotifyKbResolver(spotifyClient)];
	if (deps.researcher) resolvers.push(new ResearcherKbResolver(deps.researcher));
	const queue = new KbExpansionQueue(store, resolvers, {
		onEvent: (e) => {
			for (const l of listeners) {
				try { l(e); } catch (err) { klog.warn('kb listener threw', undefined, err); }
			}
		},
	});
	// Crash recovery: anything left 'running' by a previous session resumes
	// as 'pending' (its cursor intact) the next time the aspect is opened.
	store.resetRunningExpansions();

	const toEdgeOut = (e: KbEdge): KbEdgeOut => ({
		...e,
		tier: e.source === 'agent' ? 'agent' : 'structured',
	});

	// Batched library-linkage probe for a set of entities (self + track
	// neighbors): one IN() query via the port, mapped back per entity.
	const probeLibrary = async (entities: KbEntity[]): Promise<Record<string, string>> => {
		const tracks = entities.filter((e) => e.kind === 'track');
		if (tracks.length === 0) return {};
		const bySpotifyId = new Map<string, string>(); // spotify id → entity id
		const byIsrc = new Map<string, string>();
		for (const t of tracks) {
			if (t.isrc) byIsrc.set(t.isrc, t.id);
			const sp = store.getSourceRefs(t.id).find((r) => r.source === 'spotify' && r.sourceKind === 'track');
			if (sp) bySpotifyId.set(sp.sourceId, t.id);
		}
		const res = await library.libraryTrackIds({
			isrcs: [...byIsrc.keys()],
			spotifyTrackIds: [...bySpotifyId.keys()],
		});
		const out: Record<string, string> = {};
		for (const [spId, entityId] of bySpotifyId) {
			const trackId = res.bySpotify[spId];
			if (trackId) out[entityId] = trackId;
		}
		for (const [isrc, entityId] of byIsrc) {
			const trackId = res.byIsrc[isrc];
			if (trackId) out[entityId] = trackId;
		}
		return out;
	};

	const entityDetail = async (entityId: string): Promise<KbEntityDetail | null> => {
		const entity = store.getEntity(entityId);
		if (!entity) return null;
		const edges = store.getEdgesFor(entity.id).map(toEdgeOut);
		const neighborIds = [...new Set(edges.flatMap((e) => [e.srcId, e.dstId]).filter((id) => id !== entity.id))];
		const neighborList = store.getEntities(neighborIds);
		const neighbors: Record<string, KbEntity> = {};
		for (const n of neighborList) neighbors[n.id] = n;
		return {
			entity,
			sources: store.getSourceRefs(entity.id),
			edges,
			neighbors,
			expansions: store.getExpansions(entity.id),
			availableAspects: queue.availableAspects(entity.kind),
			inLibrary: await probeLibrary([entity, ...neighborList]),
		};
	};

	// Memory-tier answer for an already-complete aspect: the stored edges of
	// that aspect's kinds + their far-end entities. Zero network.
	const fromMemory = (entity: KbEntity, aspect: KbAspect): KbExpansion => {
		const kinds = new Set<KbEdge['kind']>(ASPECT_EDGE_KINDS[aspect]);
		const edges = store.getEdgesFor(entity.id).filter((e) => kinds.has(e.kind)).map(toEdgeOut);
		const ids = [...new Set(edges.flatMap((e) => [e.srcId, e.dstId]).filter((id) => id !== entity.id))];
		return { status: 'complete', entities: store.getEntities(ids), edges };
	};

	const resolveSeed = async (seed: JourneySeed): Promise<KbEntity> => {
		switch (seed.kind) {
			case 'kb-entity': {
				const e = store.getEntity(seed.entityId);
				if (!e) throw new Error('KB entity not found');
				return e;
			}
			case 'source-ref': {
				const { entity } = store.transaction(() =>
					resolveDraft(store, {
						kind: seed.entityKind,
						name: seed.name,
						source: seed.source,
						sourceKind: seed.sourceKind,
						sourceId: seed.sourceId,
					}),
				);
				return entity;
			}
			case 'library-track': {
				const t = await library.getTrackSeed(seed.trackId);
				if (!t) throw new Error('library track not found');
				return store.transaction(() => {
					// Mint the track: by its Spotify link when one exists (that's
					// what makes it expandable), else as a local-sourced row keyed
					// by the stable curator id.
					const trackDraft = t.spotifyTrackId
						? { source: 'spotify' as const, sourceKind: 'track', sourceId: t.spotifyTrackId }
						: { source: 'local' as const, sourceKind: 'track', sourceId: seed.trackId };
					const { entity: track } = resolveDraft(store, {
						kind: 'track',
						name: t.title,
						isrc: t.isrc,
						durationSec: t.durationSec,
						coverUrl: t.coverUrl,
						releaseDate: t.releaseDate,
						...trackDraft,
					});
					// Artist stubs from the credit strings (shared splitter, so a
					// packed rb credit and a structured Spotify array seed the same
					// entities) — name-keyed local refs, unified later when a catalog
					// id shows up (attachSourceRef merges on the Spotify search
					// match during expansion).
					for (const rawName of t.artists.flatMap((raw) => artistNames(splitArtistCredit(raw)))) {
						const { entity: artist } = resolveDraft(store, {
							kind: 'artist',
							name: rawName,
							source: 'local',
							sourceKind: 'artist',
							sourceId: `name:${searchFold(rawName)}`,
						});
						store.upsertEdges([{ srcId: track.id, kind: 'track-artist', dstId: artist.id, source: 'local' }]);
					}
					return store.getEntity(track.id)!;
				});
			}
		}
	};

	// Navigating across an agent claim is its implicit confirmation — stamp
	// the edge. v1's only agent edge kind is similar-artist.
	const hardenTraversal = (fromEntityId: string, toEntityId: string): void => {
		const claim = store
			.getEdgesFor(fromEntityId)
			.find((e) => e.kind === 'similar-artist' && e.source === 'agent'
				&& ((e.srcId === fromEntityId && e.dstId === toEntityId) || (e.srcId === toEntityId && e.dstId === fromEntityId)));
		if (claim) store.hardenEdge(claim.srcId, claim.kind, claim.dstId);
	};

	const requireJourney = (journeyId: string): Journey => {
		const j = store.getJourneyRow(journeyId);
		if (!j) throw new Error('journey not found');
		return j;
	};

	return {
		// ── Journeys ──
		async createJourney(seed, opts) {
			const entity = await resolveSeed(seed);
			const name = opts?.name ?? `${entity.name} · ${new Date().toISOString().slice(0, 10)}`;
			return store.createJourney(name, { id: entity.id, kind: entity.kind, title: entity.name });
		},
		async listJourneys() {
			return store.listJourneys();
		},
		async getJourney(journeyId) {
			return store.getJourney(journeyId);
		},
		async renameJourney(journeyId, name) {
			requireJourney(journeyId);
			store.renameJourney(journeyId, name);
		},
		async deleteJourney(journeyId) {
			store.deleteJourney(journeyId);
		},
		async journeyNavigate(journeyId, entityId, opts) {
			const journey = requireJourney(journeyId);
			const entity = store.getEntity(entityId);
			if (!entity) throw new Error('KB entity not found');
			const current = store.getNode(journey.currentNodeId);
			const currentEntityId = current ? store.getEntity(current.entityId)?.id : undefined;
			let node: JourneyNode;
			if (current && currentEntityId === entity.id) {
				// Navigating to where you already stand — no twin node.
				node = current;
			} else {
				// Sibling reuse: revisiting an entity already branched from here
				// re-enters that node instead of spawning a twin.
				const existing = opts?.forceBranch ? null : store.findChild(journeyId, journey.currentNodeId, entity.id);
				if (existing) {
					store.setCurrent(journeyId, existing.id);
					node = store.getNode(existing.id)!;
				} else {
					node = store.appendChild(journeyId, journey.currentNodeId, {
						id: entity.id,
						kind: entity.kind,
						title: entity.name,
					});
				}
				if (currentEntityId) hardenTraversal(currentEntityId, entity.id);
			}
			const detail = await entityDetail(entity.id);
			return { node, entity: detail! };
		},
		async journeyJumpTo(journeyId, nodeId) {
			requireJourney(journeyId);
			const node = store.getNode(nodeId);
			if (!node || node.journeyId !== journeyId) throw new Error('journey node not found');
			store.setCurrent(journeyId, nodeId);
			const detail = await entityDetail(node.entityId);
			if (!detail) throw new Error('node entity no longer resolvable');
			return detail;
		},
		async journeySetNodeView(journeyId, nodeId, view) {
			const node = store.getNode(nodeId);
			if (!node || node.journeyId !== journeyId) return;
			store.setNodeView(nodeId, view);
		},
		async journeyDeleteBranch(journeyId, nodeId) {
			requireJourney(journeyId);
			return store.deleteBranch(journeyId, nodeId);
		},

		// ── Knowledge ──
		async getKbEntity(entityId) {
			return entityDetail(entityId);
		},
		async expandKbEntity(entityId, aspect, opts) {
			const entity = store.getEntity(entityId);
			if (!entity) throw new Error('KB entity not found');
			// Memory tier: a completed aspect answers from the DB instantly.
			// v1 refreshes only on explicit request (TTL staleness deferred).
			if (!opts?.refresh) {
				const states = store.getExpansions(entity.id).filter((s) => s.aspect === aspect);
				if (states.some((s) => s.status === 'complete')) return fromMemory(entity, aspect);
			}
			return queue.expand(entity, aspect, opts);
		},
		async searchKb(query, kinds) {
			return store.searchEntities(query, kinds);
		},
		async resolveKbEntity(seed) {
			const entity = await resolveSeed(seed);
			const detail = await entityDetail(entity.id);
			return detail!;
		},
		async promoteKbTrack(entityId, opts) {
			const entity = store.getEntity(entityId);
			if (!entity) throw new Error('KB entity not found');
			if (entity.kind !== 'track') throw new Error('only tracks can be promoted');
			const spRef = store.getSourceRefs(entity.id).find((r) => r.source === 'spotify' && r.sourceKind === 'track');
			if (!spRef) throw new Error('promotion requires a Spotify link (no ref on this track yet)');
			const client = await spotifyClient();
			if (!client) throw new Error('Spotify not connected');
			const [st] = await client.getTracksByIds([spRef.sourceId]);
			if (!st) throw new Error('track not found on Spotify');
			// Null enrichment ⇒ the port runs its own fallback library enrich,
			// exactly like a feed promotion without carried metadata.
			const trackId = await library.promote(st, null, { pin: opts?.pin ?? true });
			// Promoting from a claim is the strongest implicit confirmation —
			// stamp any agent edges touching this track.
			for (const e of store.getEdgesFor(entity.id)) {
				if (e.source === 'agent') store.hardenEdge(e.srcId, e.kind, e.dstId);
			}
			return { trackId };
		},
		subscribeEvents(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		stop() {
			queue.stop();
			store.close();
		},
	};
}
