// KB identity resolution — how a resolver draft finds (or creates) its
// canonical kb_entity row. Per-source-first, unify lazily:
//
//   • Tracks: ISRC is the pivot; name+duration cluster only WITH an artist
//     edge to corroborate (the curator matcher convention).
//   • Artists: exact source-ref only. Names alone NEVER merge — homonyms
//     stay split; wrong merges corrupt the map permanently while duplicate
//     rows are cosmetic. Cross-source unification happens later, either via
//     corroborateArtist (shared structured neighbors) or attachSourceRef
//     (a provider search deliberately matched an id).
//   • Labels/genres: normalized-name identity — Spotify only has label
//     strings, and genre is a controlled-ish vocabulary.
//   • Agent drafts are claims: they may POINT at an existing entity (a
//     single unambiguous name match) but never cause a merge — an ambiguous
//     name gets a fresh stub instead of a guess.
//
// Pure functions over the store; every path is synchronous so the caller
// can compose a whole resolver page inside one store.transaction().

import { searchFold } from '@curator/shared';
import type { KnowledgeStore } from './store.js';
import type { KbEntity, KbEntityDraft } from './types.js';

// Duration tolerance for the track name+duration cluster (± seconds) —
// mirrors the curator.db matcher convention.
const TRACK_DURATION_TOLERANCE_SEC = 5;

export interface ResolveContext {
	// Known primary-artist entity for a track draft — enables the
	// name+duration cluster fallback (a same-name same-length track by the
	// same artist is the same recording).
	primaryArtistEntityId?: string;
}

export interface ResolveResult {
	entity: KbEntity;
	created: boolean;
}

// Find-or-create the canonical entity for a draft, then upsert its source
// ref + fill any missing fields from the draft. The returned entity is the
// live post-patch row.
export function resolveDraft(store: KnowledgeStore, draft: KbEntityDraft, ctx?: ResolveContext): ResolveResult {
	const existing = findExisting(store, draft, ctx);
	const entity = existing ?? store.insertEntity({
		kind: draft.kind,
		name: draft.name,
		isrc: draft.isrc ?? null,
		durationSec: draft.durationSec ?? null,
		releaseDate: draft.releaseDate ?? null,
		coverUrl: draft.coverUrl ?? null,
		attrs: draft.attrs ?? null,
	});
	if (existing) {
		store.patchEntity(entity.id, {
			// Only trust a structured source to correct the display name; an
			// agent claim matching an existing row keeps the catalog spelling.
			name: draft.source !== 'agent' ? draft.name : undefined,
			isrc: draft.isrc ?? null,
			durationSec: draft.durationSec ?? null,
			releaseDate: draft.releaseDate ?? null,
			coverUrl: draft.coverUrl ?? null,
			attrs: draft.attrs ?? null,
		});
	}
	const finalId = attachSourceRef(store, entity.id, draft);
	return { entity: store.getEntity(finalId)!, created: !existing };
}

function findExisting(store: KnowledgeStore, draft: KbEntityDraft, ctx?: ResolveContext): KbEntity | null {
	// Exact per-source identity always wins, for every kind.
	const byRef = store.findBySourceRef(draft.source, draft.sourceKind, draft.sourceId);
	if (byRef) return byRef;
	switch (draft.kind) {
		case 'track': {
			if (draft.isrc) {
				const byIsrc = store.findTrackByIsrc(draft.isrc);
				if (byIsrc) return byIsrc;
			}
			// Cluster fallback: same folded name + duration ±5s + a credit
			// edge to the same primary artist. Without the artist context the
			// fallback is off — name+duration alone is not identity.
			if (ctx?.primaryArtistEntityId && draft.durationSec != null) {
				const candidates = store.findTracksByNameDuration(
					searchFold(draft.name),
					draft.durationSec,
					TRACK_DURATION_TOLERANCE_SEC,
				);
				for (const c of candidates) {
					const credited = store
						.getEdgesFor(c.id)
						.some((e) => e.kind === 'track-artist' && e.srcId === c.id && e.dstId === ctx.primaryArtistEntityId);
					if (credited) return c;
				}
			}
			return null;
		}
		case 'label':
		case 'genre': {
			const twins = store.findByName(draft.kind, searchFold(draft.name));
			return twins[0] ?? null;
		}
		case 'artist': {
			// Agent claims may point at ONE unambiguous existing artist —
			// re-using a known entity is not a merge. Zero or 2+ same-name
			// candidates → fresh stub (never guess between homonyms).
			if (draft.source === 'agent') {
				const twins = store.findByName('artist', searchFold(draft.name));
				return twins.length === 1 ? twins[0]! : null;
			}
			return null;
		}
		case 'release':
			// Per-source only in v1 (Spotify is the sole release source; a
			// cross-source release match needs UPC/label+catalog — deferred).
			return null;
	}
}

// Upsert the draft's source ref onto `entityId` — merge-aware: if another
// live entity already owns that (source, sourceKind, sourceId), the two are
// THE SAME thing identified independently (e.g. an agent stub whose later
// Spotify search-match resolves to an artist the user already visited).
// Merge the newcomer into the established owner and return the winner's id.
export function attachSourceRef(store: KnowledgeStore, entityId: string, ref: KbEntityDraft): string {
	const owner = store.findBySourceRef(ref.source, ref.sourceKind, ref.sourceId);
	if (owner && owner.id !== entityId) {
		store.mergeEntities(owner.id, entityId);
		store.upsertSourceRef(owner.id, {
			source: ref.source,
			sourceKind: ref.sourceKind,
			sourceId: ref.sourceId,
			url: ref.url ?? null,
			payload: ref.payload,
		});
		return owner.id;
	}
	store.upsertSourceRef(entityId, {
		source: ref.source,
		sourceKind: ref.sourceKind,
		sourceId: ref.sourceId,
		url: ref.url ?? null,
		payload: ref.payload,
	});
	return entityId;
}

// Post-page corroboration: merge `entityId` with a same-name artist twin
// when they share at least one STRUCTURED neighbor (an ISRC-linked track,
// a release both are credited on). Called after a resolver page lands, for
// touched artist entities. Names alone never merge; agent edges never count
// (countSharedStructuredNeighbors excludes them). Winner = the older row
// (stable ids for journeys). Returns the surviving id, or null if nothing
// merged.
export function corroborateArtist(store: KnowledgeStore, entityId: string): string | null {
	const entity = store.getEntity(entityId);
	if (!entity || entity.kind !== 'artist') return null;
	const twins = store.findByName('artist', entity.nameAscii).filter((t) => t.id !== entity.id);
	for (const twin of twins) {
		if (store.countSharedStructuredNeighbors(entity.id, twin.id) >= 1) {
			const [winner, loser] = twin.createdAt <= entity.createdAt ? [twin, entity] : [entity, twin];
			store.mergeEntities(winner.id, loser.id);
			return winner.id;
		}
	}
	return null;
}
