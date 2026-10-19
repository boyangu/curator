import { describe, it, expect } from 'vitest';
import { SqliteKnowledgeStore } from './store.js';
import { KbExpansionQueue } from './expansion.js';
import type { KbEntity, KbEvent, KbResolver, KbResolverPage } from './types.js';

function makeStore(): SqliteKnowledgeStore {
	return new SqliteKnowledgeStore(':memory:');
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

// Two-page fake: page 1 → artists A1, page 2 → A2. Cursor {page:2} between.
function twoPageResolver(calls: unknown[] = []): KbResolver {
	return {
		source: 'spotify',
		tier: 'structured',
		supports: (kind, aspect) => kind === 'artist' && aspect === 'releases',
		async fetchPage(req): Promise<KbResolverPage> {
			calls.push(req.cursor);
			const page = req.cursor == null ? 1 : (req.cursor as { page: number }).page;
			const rel = {
				kind: 'release' as const, name: `R${page}`,
				source: 'spotify' as const, sourceKind: 'album', sourceId: `al${page}`,
			};
			return {
				entities: [rel],
				edges: [{ kind: 'artist-release', src: { entityId: req.entity.id }, dst: { source: 'spotify', sourceKind: 'album', sourceId: `al${page}` } }],
				cursor: page === 1 ? { page: 2 } : null,
			};
		},
	};
}

function seedArtist(s: SqliteKnowledgeStore): KbEntity {
	const a = s.insertEntity({ kind: 'artist', name: 'Seed Artist' });
	s.upsertSourceRef(a.id, { source: 'spotify', sourceKind: 'artist', sourceId: 'sp-seed' });
	return a;
}

describe('KbExpansionQueue — structured', () => {
	it('awaits the first page, drains the rest in background, emits per page', async () => {
		const s = makeStore();
		const artist = seedArtist(s);
		const events: KbEvent[] = [];
		const q = new KbExpansionQueue(s, [twoPageResolver()], { onEvent: (e) => events.push(e) });
		const first = await q.expand(artist, 'releases');
		// First page awaited: R1 present, status partial (page 2 pending).
		expect(first.status).toBe('partial');
		expect(first.entities.map((e) => e.name)).toEqual(['R1']);
		expect(first.edges).toHaveLength(1);
		await waitFor(() => s.getExpansion(artist.id, 'releases', 'spotify')?.status === 'complete');
		// Both releases landed, edges point at the artist.
		const edges = s.getEdgesFor(artist.id).filter((e) => e.kind === 'artist-release');
		expect(edges).toHaveLength(2);
		const expansionEvents = events.filter((e) => e.kind === 'expansion');
		expect(expansionEvents.map((e) => e.kind === 'expansion' && e.status)).toEqual(['partial', 'complete']);
		s.close();
	});

	it('persists the cursor on failure and resumes from it', async () => {
		const s = makeStore();
		const artist = seedArtist(s);
		let failPage2 = true;
		const calls: unknown[] = [];
		const inner = twoPageResolver(calls);
		const flaky: KbResolver = {
			...inner,
			supports: inner.supports.bind(inner),
			async fetchPage(req) {
				if (failPage2 && req.cursor != null) throw new Error('boom');
				return inner.fetchPage(req);
			},
		};
		const q = new KbExpansionQueue(s, [flaky]);
		await q.expand(artist, 'releases');
		await waitFor(() => s.getExpansion(artist.id, 'releases', 'spotify')?.status === 'error');
		// Cursor for page 2 survived the failure.
		expect(s.getExpansion(artist.id, 'releases', 'spotify')!.cursor).toEqual({ page: 2 });
		// Re-expand resumes at page 2 — not from scratch.
		failPage2 = false;
		calls.length = 0;
		const resumed = await q.expand(artist, 'releases');
		expect(resumed.status).toBe('complete');
		expect(calls).toEqual([{ page: 2 }]);
		s.close();
	});

	it('reports error when no resolver supports the aspect', async () => {
		const s = makeStore();
		const artist = seedArtist(s);
		const q = new KbExpansionQueue(s, []);
		const res = await q.expand(artist, 'similar-artists');
		expect(res.status).toBe('error');
		expect(q.availableAspects('artist')).toEqual([]);
		s.close();
	});
});

describe('KbExpansionQueue — agent tier', () => {
	function agentResolver(): KbResolver {
		return {
			source: 'agent',
			tier: 'agent',
			supports: (kind, aspect) => kind === 'artist' && aspect === 'similar-artists',
			async fetchPage(req): Promise<KbResolverPage> {
				const claim = {
					kind: 'artist' as const, name: 'Suggested One',
					source: 'agent' as const, sourceKind: 'artist', sourceId: 'name:suggested one',
				};
				return {
					entities: [claim],
					edges: [{
						kind: 'similar-artist',
						src: { entityId: req.entity.id },
						dst: { source: 'agent', sourceKind: 'artist', sourceId: 'name:suggested one' },
						confidence: 0.8,
						attrs: { citations: ['https://ra.co/x'] },
					}],
					cursor: null,
				};
			},
		};
	}

	it('returns running immediately; claims land via the background lane', async () => {
		const s = makeStore();
		const artist = seedArtist(s);
		const events: KbEvent[] = [];
		const q = new KbExpansionQueue(s, [agentResolver()], { onEvent: (e) => events.push(e) });
		const res = await q.expand(artist, 'similar-artists');
		expect(res.status).toBe('running');
		expect(res.entities).toEqual([]);
		await waitFor(() => s.getExpansion(artist.id, 'similar-artists', 'agent')?.status === 'complete');
		const edge = s.getEdgesFor(artist.id).find((e) => e.kind === 'similar-artist')!;
		expect(edge.confidence).toBe(0.8);
		expect(edge.source).toBe('agent');
		expect(edge.attrs).toEqual({ citations: ['https://ra.co/x'] });
		s.close();
	});

	it('an agent claim resolves onto a unique existing artist instead of duplicating it', async () => {
		const s = makeStore();
		const artist = seedArtist(s);
		const known = s.insertEntity({ kind: 'artist', name: 'Suggested One' });
		const q = new KbExpansionQueue(s, [agentResolver()]);
		await q.expand(artist, 'similar-artists');
		await waitFor(() => s.getExpansion(artist.id, 'similar-artists', 'agent')?.status === 'complete');
		const edge = s.getEdgesFor(artist.id).find((e) => e.kind === 'similar-artist')!;
		expect(edge.dstId).toBe(known.id);
		// No duplicate row was created.
		expect(s.findByName('artist', 'suggested one')).toHaveLength(1);
		s.close();
	});
});

describe('KbExpansionQueue — ladder order', () => {
	it('prefers the structured resolver when both tiers support an aspect', async () => {
		const s = makeStore();
		const artist = seedArtist(s);
		const hit: string[] = [];
		const structured: KbResolver = {
			source: 'spotify', tier: 'structured',
			supports: () => true,
			async fetchPage() { hit.push('structured'); return { entities: [], edges: [], cursor: null }; },
		};
		const agent: KbResolver = {
			source: 'agent', tier: 'agent',
			supports: () => true,
			async fetchPage() { hit.push('agent'); return { entities: [], edges: [], cursor: null }; },
		};
		const q = new KbExpansionQueue(s, [structured, agent]);
		await q.expand(artist, 'detail');
		expect(hit).toEqual(['structured']);
		expect(q.availableAspects('artist').map((a) => a.tier)).toEqual(['structured', 'structured', 'structured', 'structured']);
		s.close();
	});
});
