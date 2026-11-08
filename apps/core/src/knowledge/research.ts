// What the knowledge base asks of research: one (kind, aspect) question
// about an entity, answered as claims — each confidence-scored and cited,
// never a catalogue fact. The agent resolver (resolvers/researcher.ts)
// depends on this port; the agent sidecar satisfies it (agent-research.ts)
// and tests inject a fake.

export interface ResearchRequest {
	kind: string;
	aspect: string;
	entity: {
		name: string;
		knownFacts: Record<string, unknown>;
	};
}

export interface ResearchClaim {
	name: string;
	confidence: number;
	citations: string[];
	rationale?: string;
}

export interface ResearchPort {
	research(req: ResearchRequest): Promise<{ claims: ResearchClaim[] }>;
}
