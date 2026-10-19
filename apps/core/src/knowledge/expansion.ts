// KbExpansionQueue — orchestrates the resolver ladder for one (entity,
// aspect) question: pick the first registered resolver that supports it,
// fetch page-granular, merge each page into the KB inside one transaction,
// persist the cursor so a mid-crawl crash resumes, and stream continuation
// pages over the event callback (the FeedEnrichmentQueue lineage).
//
// Hybrid sync/async: structured aspects AWAIT the first page (one fast
// provider call — the click must not render an empty room), then drain the
// rest in the background. Agent aspects return 'running' immediately —
// research takes 10–60s and streams in via kb:event when it lands.
//
// Per-source lanes: all work for one source serializes on a promise chain
// (Spotify additionally rides the client's own rate gate; future scraper
// sources get their politeness pacing here).

import { corroborateArtist, resolveDraft } from './identity.js';
import type { KnowledgeStore } from './store.js';
import type {
	KbAspect,
	KbDraftRef,
	KbEdgeOut,
	KbEntity,
	KbEntityKind,
	KbEvent,
	KbExpansion,
	KbResolver,
	KbResolverPage,
	KbSource,
} from './types.js';
import { log } from '../log.js';

const klog = log.for('kb');

function draftKey(ref: { source: KbSource; sourceKind: string; sourceId: string }): string {
	return `${ref.source}|${ref.sourceKind}|${ref.sourceId}`;
}

export class KbExpansionQueue {
	private stopped = false;
	// One serial lane per source — a lane's tail promise; new work chains on.
	private readonly lanes = new Map<string, Promise<void>>();

	constructor(
		private readonly store: KnowledgeStore,
		private readonly resolvers: KbResolver[],
		private readonly opts: {
			// Delay between background continuation pages, per source.
			// Spotify needs none (client gate); scraper sources will.
			pacingMs?: number;
			onEvent?: (e: KbEvent) => void;
		} = {},
	) {}

	stop(): void {
		this.stopped = true;
	}

	resolverFor(kind: KbEntityKind, aspect: KbAspect): KbResolver | null {
		return this.resolvers.find((r) => r.supports(kind, aspect)) ?? null;
	}

	availableAspects(kind: KbEntityKind): { aspect: KbAspect; tier: KbResolver['tier'] }[] {
		const aspects: KbAspect[] = ['detail', 'releases', 'tracks', 'similar-artists'];
		const out: { aspect: KbAspect; tier: KbResolver['tier'] }[] = [];
		for (const aspect of aspects) {
			const r = this.resolverFor(kind, aspect);
			if (r) out.push({ aspect, tier: r.tier });
		}
		return out;
	}

	// Answer (entity, aspect). Fresh 'complete' state short-circuits in the
	// service (memory tier) — by the time we're here, a fetch is wanted.
	async expand(entity: KbEntity, aspect: KbAspect, opts?: { refresh?: boolean }): Promise<KbExpansion> {
		const resolver = this.resolverFor(entity.kind, aspect);
		if (!resolver) {
			return { status: 'error', entities: [], edges: [] };
		}
		if (resolver.tier === 'agent') {
			// Fire-and-stream: mark running, kick the lane, return immediately.
			this.store.setExpansion({ entityId: entity.id, aspect, source: resolver.source, status: 'running' });
			this.enqueue(resolver.source, async () => {
				await this.runPages(entity, aspect, resolver, null, Infinity);
			});
			return { status: 'running', entities: [], edges: [] };
		}
		// Structured: await the first page on the lane, background the rest.
		// Resume from any persisted cursor — partial (mid-crawl), pending
		// (boot-reset running), or error (a failed page keeps its cursor so
		// retry continues where it broke, not from scratch).
		const prior = opts?.refresh ? null : this.store.getExpansion(entity.id, aspect, resolver.source);
		const startCursor = prior && prior.status !== 'complete' ? prior.cursor : null;
		this.store.setExpansion({
			entityId: entity.id,
			aspect,
			source: resolver.source,
			status: 'running',
			cursor: startCursor,
		});
		const first = await this.enqueue(resolver.source, () =>
			this.runPages(entity, aspect, resolver, startCursor, 1),
		);
		if (first.nextCursor !== null && !this.stopped) {
			this.enqueue(resolver.source, async () => {
				await this.runPages(entity, aspect, resolver, first.nextCursor, Infinity);
			});
		}
		return { status: first.status, entities: first.entities, edges: first.edges };
	}

	// Run up to `maxPages` pages, merging + persisting each. Returns the
	// last page's merged output plus the cursor to continue from.
	private async runPages(
		entity: KbEntity,
		aspect: KbAspect,
		resolver: KbResolver,
		cursor: unknown | null,
		maxPages: number,
	): Promise<{ status: KbExpansion['status']; entities: KbEntity[]; edges: KbEdgeOut[]; nextCursor: unknown | null }> {
		let pages = 0;
		let lastEntities: KbEntity[] = [];
		let lastEdges: KbEdgeOut[] = [];
		try {
			while (!this.stopped) {
				// A prior page may have merged this entity into a winner row
				// (attachSourceRef unification) — always work on the live row.
				entity = this.store.getEntity(entity.id) ?? entity;
				const sourceId = this.sourceIdFor(entity.id, resolver.source);
				const page = await resolver.fetchPage({
					kind: entity.kind,
					aspect,
					sourceId,
					entity: {
						id: entity.id,
						kind: entity.kind,
						name: entity.name,
						knownFacts: this.knownFacts(entity),
					},
					cursor,
				});
				const merged = this.mergePage(resolver.source, page);
				lastEntities = merged.entities;
				lastEdges = merged.edges;
				cursor = page.cursor;
				pages++;
				const done = page.cursor === null;
				this.store.setExpansion({
					entityId: entity.id,
					aspect,
					source: resolver.source,
					status: done ? 'complete' : 'partial',
					cursor: page.cursor,
					pageLanded: true,
					completed: done,
				});
				this.emit({
					kind: 'expansion',
					entityId: entity.id,
					aspect,
					status: done ? 'complete' : 'partial',
					newEntityIds: merged.entities.map((e) => e.id),
				});
				if (done) return { status: 'complete', entities: lastEntities, edges: lastEdges, nextCursor: null };
				if (pages >= maxPages) return { status: 'partial', entities: lastEntities, edges: lastEdges, nextCursor: cursor };
				if (this.opts.pacingMs) await new Promise((r) => setTimeout(r, this.opts.pacingMs));
			}
			return { status: 'partial', entities: lastEntities, edges: lastEdges, nextCursor: cursor };
		} catch (err) {
			klog.warn('expansion failed', { entityId: entity.id, aspect, source: resolver.source }, err);
			this.store.setExpansion({
				entityId: entity.id,
				aspect,
				source: resolver.source,
				status: 'error',
				cursor,
				error: err instanceof Error ? err.message : String(err),
			});
			this.emit({ kind: 'expansion', entityId: entity.id, aspect, status: 'error', newEntityIds: [] });
			return { status: 'error', entities: lastEntities, edges: lastEdges, nextCursor: null };
		}
	}

	// One transaction per landed page: resolve every entity draft through
	// identity, resolve edge endpoints (draft triple → KB id), upsert edges,
	// then corroborate touched structured artists. The expanded entity's own
	// row may gain fields (a detail page patches it via its draft).
	private mergePage(source: KbSource, page: KbResolverPage): { entities: KbEntity[]; edges: KbEdgeOut[] } {
		return this.store.transaction(() => {
			const byDraft = new Map<string, string>();
			const resolved: KbEntity[] = [];
			for (const draft of page.entities) {
				const { entity: e } = resolveDraft(this.store, draft);
				byDraft.set(draftKey(draft), e.id);
				resolved.push(e);
			}
			const resolveRef = (ref: KbDraftRef): string | null => {
				if ('entityId' in ref) {
					// The expanded entity itself (or any pre-known id) — follow
					// merges so edges always land on live rows.
					return this.store.getEntity(ref.entityId)?.id ?? null;
				}
				return byDraft.get(draftKey(ref)) ?? null;
			};
			const edges = page.edges.flatMap((d) => {
				const srcId = resolveRef(d.src);
				const dstId = resolveRef(d.dst);
				if (!srcId || !dstId || srcId === dstId) return [];
				return [{
					srcId,
					kind: d.kind,
					dstId,
					role: d.role ?? null,
					position: d.position ?? null,
					source,
					confidence: d.confidence ?? 1,
					attrs: d.attrs ?? null,
				}];
			});
			this.store.upsertEdges(edges);
			// Structured pages may have created a name-twin of an artist that
			// now shares a release/track with it — merge those. Agent pages
			// never corroborate (claims don't drive identity).
			if (source !== 'agent') {
				for (const e of resolved) {
					if (e.kind === 'artist') corroborateArtist(this.store, e.id);
				}
			}
			// Re-read post-merge rows and materialize edge tiers for the caller.
			const finalEntities = this.store.getEntities(resolved.map((e) => e.id));
			const finalEdges: KbEdgeOut[] = edges
				.map((e) => ({
					...e,
					srcId: this.store.getEntity(e.srcId)?.id ?? e.srcId,
					dstId: this.store.getEntity(e.dstId)?.id ?? e.dstId,
					hardenedAt: null,
					fetchedAt: Date.now(),
					tier: source === 'agent' ? 'agent' as const : 'structured' as const,
				}));
			return { entities: finalEntities, edges: finalEdges };
		});
	}

	private sourceIdFor(entityId: string, source: KbSource): string | null {
		const refs = this.store.getSourceRefs(entityId);
		return refs.find((r) => r.source === source)?.sourceId ?? null;
	}

	private knownFacts(entity: KbEntity): Record<string, unknown> {
		// Compact context for the agent resolver: the entity's stored facts
		// plus neighbor names by relation — enough to disambiguate homonyms
		// without handing over a DB.
		const edges = this.store.getEdgesFor(entity.id);
		const neighborIds = [...new Set(edges.flatMap((e) => [e.srcId, e.dstId]).filter((id) => id !== entity.id))];
		const neighbors = this.store.getEntities(neighborIds);
		const nameById = new Map(neighbors.map((n) => [n.id, n.name]));
		const related: Record<string, string[]> = {};
		for (const e of edges) {
			const otherId = e.srcId === entity.id ? e.dstId : e.srcId;
			const name = nameById.get(otherId);
			if (!name) continue;
			(related[e.kind] ??= []).push(name);
		}
		return { ...entity.attrs, related };
	}

	// Chain work onto a source's serial lane. Returns the task's promise;
	// lane failures never poison the chain (each link swallows).
	private enqueue<T>(source: KbSource, task: () => Promise<T>): Promise<T> {
		const tail = this.lanes.get(source) ?? Promise.resolve();
		const run = tail.then(task);
		this.lanes.set(source, run.then(() => undefined, () => undefined));
		return run;
	}

	private emit(e: KbEvent): void {
		try {
			this.opts.onEvent?.(e);
		} catch (err) {
			klog.warn('kb event listener threw', undefined, err);
		}
	}
}
