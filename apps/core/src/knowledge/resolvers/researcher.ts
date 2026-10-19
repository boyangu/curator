// Agent resolver — routes KB aspects no catalog API can answer to the
// research sidecar. v1: artist.similar-artists only.
//
// Everything that comes back is a CLAIM: the drafts carry source='agent'
// with a name-keyed source id (research has no stable provider ids), the
// edges carry the model's confidence + citations, and identity treats
// them accordingly (an unambiguous name match may POINT at an existing
// artist; ambiguity mints a stub; merges never happen off a claim).

import { searchFold } from '@curator/shared';
import type { ResearchPort } from '../researcher-sidecar.js';
import type { KbAspect, KbEdgeDraft, KbEntityDraft, KbEntityKind, KbResolver, KbResolverPage } from '../types.js';

export class ResearcherKbResolver implements KbResolver {
	readonly source = 'agent' as const;
	readonly tier = 'agent' as const;

	constructor(private readonly port: ResearchPort) {}

	supports(kind: KbEntityKind, aspect: KbAspect): boolean {
		return kind === 'artist' && aspect === 'similar-artists';
	}

	async fetchPage(req: Parameters<KbResolver['fetchPage']>[0]): Promise<KbResolverPage> {
		const { claims } = await this.port.research({
			kind: req.kind,
			aspect: req.aspect,
			entity: { name: req.entity.name, knownFacts: req.entity.knownFacts },
		});
		const selfFolded = searchFold(req.entity.name);
		const entities: KbEntityDraft[] = [];
		const edges: KbEdgeDraft[] = [];
		const seen = new Set<string>();
		for (const claim of claims) {
			const folded = searchFold(claim.name);
			// The subject itself, or a duplicate claim — skip.
			if (!folded || folded === selfFolded || seen.has(folded)) continue;
			seen.add(folded);
			const draft: KbEntityDraft = {
				kind: 'artist',
				name: claim.name,
				source: 'agent',
				sourceKind: 'artist',
				sourceId: `name:${folded}`,
				payload: claim,
			};
			entities.push(draft);
			edges.push({
				kind: 'similar-artist',
				src: { entityId: req.entity.id },
				dst: { source: 'agent', sourceKind: 'artist', sourceId: draft.sourceId },
				confidence: claim.confidence,
				attrs: {
					citations: claim.citations,
					...(claim.rationale ? { rationale: claim.rationale } : {}),
				},
			});
		}
		// Research is one-shot per aspect — no pagination.
		return { entities, edges, cursor: null };
	}
}
