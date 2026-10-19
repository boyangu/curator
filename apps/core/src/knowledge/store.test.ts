import { describe, it, expect } from 'vitest';
import { SqliteKnowledgeStore } from './store.js';

function makeStore(): SqliteKnowledgeStore {
	return new SqliteKnowledgeStore(':memory:');
}

describe('SqliteKnowledgeStore entities', () => {
	it('insert + source-ref + lookup round-trips', () => {
		const s = makeStore();
		const artist = s.insertEntity({ kind: 'artist', name: 'Bén Böhmer' });
		s.upsertSourceRef(artist.id, { source: 'spotify', sourceKind: 'artist', sourceId: 'sp1' });
		expect(s.findBySourceRef('spotify', 'artist', 'sp1')?.id).toBe(artist.id);
		// name_ascii is folded — diacritics stripped.
		expect(s.findByName('artist', 'ben bohmer')[0]?.id).toBe(artist.id);
		s.close();
	});

	it('patchEntity fills but never blanks', () => {
		const s = makeStore();
		const t = s.insertEntity({ kind: 'track', name: 'Cruel', isrc: 'DE123', durationSec: 300 });
		s.patchEntity(t.id, { coverUrl: 'http://x/c.jpg', isrc: null, durationSec: null });
		const after = s.getEntity(t.id)!;
		expect(after.coverUrl).toBe('http://x/c.jpg');
		expect(after.isrc).toBe('DE123');
		expect(after.durationSec).toBe(300);
		s.close();
	});

	it('findTrackByIsrc and name+duration cluster probes', () => {
		const s = makeStore();
		const t = s.insertEntity({ kind: 'track', name: 'Beyond Beliefs', isrc: 'DE-A01', durationSec: 372 });
		expect(s.findTrackByIsrc('DE-A01')?.id).toBe(t.id);
		expect(s.findTracksByNameDuration('beyond beliefs', 375, 5).map((e) => e.id)).toEqual([t.id]);
		expect(s.findTracksByNameDuration('beyond beliefs', 380, 5)).toEqual([]);
		s.close();
	});

	it('searchEntities matches folded substrings with kind filter', () => {
		const s = makeStore();
		s.insertEntity({ kind: 'artist', name: 'Tinlicker' });
		s.insertEntity({ kind: 'label', name: 'Anjunadeep' });
		expect(s.searchEntities('tinlick').map((e) => e.name)).toEqual(['Tinlicker']);
		expect(s.searchEntities('anjuna', ['artist'])).toEqual([]);
		expect(s.searchEntities('anjuna', ['label']).map((e) => e.name)).toEqual(['Anjunadeep']);
		s.close();
	});
});

describe('SqliteKnowledgeStore merge semantics', () => {
	it('mergeEntities redirects, moves refs, rewrites edges; readers resolve the chain', () => {
		const s = makeStore();
		const a = s.insertEntity({ kind: 'artist', name: 'CamelPhat' });
		const b = s.insertEntity({ kind: 'artist', name: 'Camelphat' });
		const r = s.insertEntity({ kind: 'release', name: 'Dark Matter' });
		s.upsertSourceRef(b.id, { source: 'spotify', sourceKind: 'artist', sourceId: 'spB' });
		s.upsertEdges([{ srcId: b.id, kind: 'artist-release', dstId: r.id, source: 'spotify' }]);
		s.mergeEntities(a.id, b.id);
		// Loser resolves to winner; source ref moved; edge rewritten.
		expect(s.getEntity(b.id)?.id).toBe(a.id);
		expect(s.findBySourceRef('spotify', 'artist', 'spB')?.id).toBe(a.id);
		const edges = s.getEdgesFor(a.id);
		expect(edges).toHaveLength(1);
		expect(edges[0]!.srcId).toBe(a.id);
		// getEntities dedupes a live id + a merged alias to one row.
		expect(s.getEntities([a.id, b.id])).toHaveLength(1);
		s.close();
	});

	it('merge keeps the stronger fact when both sides carry the same edge', () => {
		const s = makeStore();
		const a = s.insertEntity({ kind: 'artist', name: 'X' });
		const b = s.insertEntity({ kind: 'artist', name: 'X' });
		const t = s.insertEntity({ kind: 'artist', name: 'Y' });
		s.upsertEdges([
			{ srcId: a.id, kind: 'similar-artist', dstId: t.id, source: 'agent', confidence: 0.4 },
			{ srcId: b.id, kind: 'similar-artist', dstId: t.id, source: 'agent', confidence: 0.9 },
		]);
		s.hardenEdge(b.id, 'similar-artist', t.id);
		s.mergeEntities(a.id, b.id);
		const [edge] = s.getEdgesFor(a.id);
		expect(edge!.confidence).toBe(0.9);
		expect(edge!.hardenedAt).not.toBeNull();
		s.close();
	});

	it('countSharedStructuredNeighbors ignores agent edges', () => {
		const s = makeStore();
		const a = s.insertEntity({ kind: 'artist', name: 'A' });
		const b = s.insertEntity({ kind: 'artist', name: 'A' });
		const rel = s.insertEntity({ kind: 'release', name: 'R' });
		const other = s.insertEntity({ kind: 'artist', name: 'O' });
		s.upsertEdges([
			{ srcId: a.id, kind: 'artist-release', dstId: rel.id, source: 'spotify' },
			{ srcId: b.id, kind: 'artist-release', dstId: rel.id, source: 'musicbrainz' },
			// Agent-asserted shared neighbor must NOT count as corroboration.
			{ srcId: a.id, kind: 'similar-artist', dstId: other.id, source: 'agent' },
			{ srcId: b.id, kind: 'similar-artist', dstId: other.id, source: 'agent' },
		]);
		expect(s.countSharedStructuredNeighbors(a.id, b.id)).toBe(1);
		s.close();
	});
});

describe('SqliteKnowledgeStore expansions', () => {
	it('upserts state, preserves stamps, resets running on boot', () => {
		const s = makeStore();
		const e = s.insertEntity({ kind: 'artist', name: 'A' });
		s.setExpansion({ entityId: e.id, aspect: 'releases', source: 'spotify', status: 'running' });
		s.setExpansion({ entityId: e.id, aspect: 'releases', source: 'spotify', status: 'partial', cursor: { offset: 50 }, pageLanded: true });
		let exp = s.getExpansion(e.id, 'releases', 'spotify')!;
		expect(exp.status).toBe('partial');
		expect(exp.cursor).toEqual({ offset: 50 });
		expect(exp.fetchedAt).not.toBeNull();
		// A later status write without pageLanded keeps the earlier stamp.
		s.setExpansion({ entityId: e.id, aspect: 'releases', source: 'spotify', status: 'running', cursor: { offset: 50 } });
		exp = s.getExpansion(e.id, 'releases', 'spotify')!;
		expect(exp.fetchedAt).not.toBeNull();
		s.resetRunningExpansions();
		expect(s.getExpansion(e.id, 'releases', 'spotify')!.status).toBe('pending');
		s.close();
	});
});

describe('SqliteKnowledgeStore journeys', () => {
	function seed(s: SqliteKnowledgeStore) {
		const artist = s.insertEntity({ kind: 'artist', name: 'Root Artist' });
		const detail = s.createJourney('Dig #1', { id: artist.id, kind: 'artist', title: 'Root Artist' });
		return { artist, detail };
	}

	it('create → root node is current; navigate appends and moves the pointer', () => {
		const s = makeStore();
		const { detail } = seed(s);
		const rel = s.insertEntity({ kind: 'release', name: 'R1' });
		const node = s.appendChild(detail.journey.id, detail.journey.currentNodeId, { id: rel.id, kind: 'release', title: 'R1' });
		const j = s.getJourneyRow(detail.journey.id)!;
		expect(j.currentNodeId).toBe(node.id);
		expect(node.parentNodeId).toBe(detail.journey.rootNodeId);
		expect(s.getJourney(detail.journey.id)!.nodes).toHaveLength(2);
		s.close();
	});

	it('jump back + navigate creates a sibling branch; findChild enables reuse', () => {
		const s = makeStore();
		const { detail } = seed(s);
		const root = detail.journey.rootNodeId;
		const r1 = s.insertEntity({ kind: 'release', name: 'R1' });
		const r2 = s.insertEntity({ kind: 'release', name: 'R2' });
		const n1 = s.appendChild(detail.journey.id, root, { id: r1.id, kind: 'release', title: 'R1' });
		// Jump back to root, then branch to R2.
		s.setCurrent(detail.journey.id, root);
		const n2 = s.appendChild(detail.journey.id, root, { id: r2.id, kind: 'release', title: 'R2' });
		expect(n2.parentNodeId).toBe(root);
		expect(n2.position).toBe(n1.position + 1);
		// Sibling-reuse probe finds the existing child for R1.
		expect(s.findChild(detail.journey.id, root, r1.id)?.id).toBe(n1.id);
		expect(s.findChild(detail.journey.id, root, 'nope')).toBeNull();
		s.close();
	});

	it('deleteBranch removes the subtree, repoints current, refuses root', () => {
		const s = makeStore();
		const { detail } = seed(s);
		const root = detail.journey.rootNodeId;
		const r1 = s.insertEntity({ kind: 'release', name: 'R1' });
		const t1 = s.insertEntity({ kind: 'track', name: 'T1' });
		const n1 = s.appendChild(detail.journey.id, root, { id: r1.id, kind: 'release', title: 'R1' });
		s.appendChild(detail.journey.id, n1.id, { id: t1.id, kind: 'track', title: 'T1' });
		// Current is the leaf (inside the branch) — deletion repoints to root.
		const res = s.deleteBranch(detail.journey.id, n1.id);
		expect(res.removed).toBe(2);
		expect(s.getJourneyRow(detail.journey.id)!.currentNodeId).toBe(root);
		expect(() => s.deleteBranch(detail.journey.id, root)).toThrow(/root/);
		s.close();
	});

	it('list + rename + delete + node view persistence', () => {
		const s = makeStore();
		const { detail } = seed(s);
		s.renameJourney(detail.journey.id, 'Saturday dig');
		const [summary] = s.listJourneys();
		expect(summary!.name).toBe('Saturday dig');
		expect(summary!.nodeCount).toBe(1);
		expect(summary!.currentEntityName).toBe('Root Artist');
		s.setNodeView(detail.journey.rootNodeId, { scrollTop: 120 });
		expect(s.getNode(detail.journey.rootNodeId)!.view).toEqual({ scrollTop: 120 });
		s.deleteJourney(detail.journey.id);
		expect(s.listJourneys()).toEqual([]);
		expect(s.getJourney(detail.journey.id)).toBeNull();
		s.close();
	});
});
