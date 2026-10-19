import { describe, it, expect } from 'vitest';
import { SqliteKnowledgeStore } from './store.js';
import { attachSourceRef, corroborateArtist, resolveDraft } from './identity.js';
import type { KbEntityDraft } from './types.js';

function makeStore(): SqliteKnowledgeStore {
	return new SqliteKnowledgeStore(':memory:');
}

function artistDraft(name: string, sourceId: string, source: KbEntityDraft['source'] = 'spotify'): KbEntityDraft {
	return { kind: 'artist', name, source, sourceKind: 'artist', sourceId };
}

describe('resolveDraft — tracks', () => {
	it('reuses by source ref, then by ISRC across sources', () => {
		const s = makeStore();
		const first = resolveDraft(s, {
			kind: 'track', name: 'Cruel', isrc: 'DE-X01', durationSec: 320,
			source: 'spotify', sourceKind: 'track', sourceId: 'sp-t1',
		});
		expect(first.created).toBe(true);
		// Same ISRC from another source → same entity, second ref attached.
		const second = resolveDraft(s, {
			kind: 'track', name: 'Cruel (Original Mix)', isrc: 'DE-X01', durationSec: 321,
			source: 'beatport', sourceKind: 'track', sourceId: 'bp-9',
		});
		expect(second.created).toBe(false);
		expect(second.entity.id).toBe(first.entity.id);
		expect(s.getSourceRefs(first.entity.id)).toHaveLength(2);
		s.close();
	});

	it('name+duration cluster only merges with a corroborating artist edge', () => {
		const s = makeStore();
		const artist = s.insertEntity({ kind: 'artist', name: 'Adriatique' });
		const t1 = resolveDraft(s, {
			kind: 'track', name: 'X', durationSec: 300,
			source: 'spotify', sourceKind: 'track', sourceId: 'sp-1',
		});
		s.upsertEdges([{ srcId: t1.entity.id, kind: 'track-artist', dstId: artist.id, source: 'spotify' }]);
		// No ISRC, no ctx → new row despite identical name/duration.
		const noCtx = resolveDraft(s, {
			kind: 'track', name: 'X', durationSec: 301,
			source: 'tidal', sourceKind: 'track', sourceId: 'td-1',
		});
		expect(noCtx.created).toBe(true);
		// With the artist context → clusters onto t1.
		const withCtx = resolveDraft(s, {
			kind: 'track', name: 'X', durationSec: 302,
			source: 'tidal', sourceKind: 'track', sourceId: 'td-2',
		}, { primaryArtistEntityId: artist.id });
		expect(withCtx.created).toBe(false);
		expect(withCtx.entity.id).toBe(t1.entity.id);
		s.close();
	});
});

describe('resolveDraft — artists', () => {
	it('structured drafts never merge on name alone', () => {
		const s = makeStore();
		const a = resolveDraft(s, artistDraft('Solee', 'sp-1'));
		const b = resolveDraft(s, artistDraft('Solee', 'bp-1', 'beatport'));
		expect(b.created).toBe(true);
		expect(b.entity.id).not.toBe(a.entity.id);
		s.close();
	});

	it('agent drafts point at a single unambiguous name match, stub otherwise', () => {
		const s = makeStore();
		const known = resolveDraft(s, artistDraft('Tale Of Us', 'sp-9'));
		const claim = resolveDraft(s, {
			kind: 'artist', name: 'Tale of Us',
			source: 'agent', sourceKind: 'artist', sourceId: 'name:tale of us',
		});
		expect(claim.created).toBe(false);
		expect(claim.entity.id).toBe(known.entity.id);
		// Agent match must not overwrite the catalog spelling.
		expect(claim.entity.name).toBe('Tale Of Us');
		// Two same-name candidates → ambiguous → fresh stub.
		s.insertEntity({ kind: 'artist', name: 'Duplicate' });
		s.insertEntity({ kind: 'artist', name: 'Duplicate' });
		const ambiguous = resolveDraft(s, {
			kind: 'artist', name: 'Duplicate',
			source: 'agent', sourceKind: 'artist', sourceId: 'name:duplicate',
		});
		expect(ambiguous.created).toBe(true);
		s.close();
	});
});

describe('resolveDraft — labels and genres', () => {
	it('labels unify by folded name across sources', () => {
		const s = makeStore();
		const a = resolveDraft(s, {
			kind: 'label', name: 'Anjunadeep',
			source: 'spotify', sourceKind: 'label', sourceId: 'name:anjunadeep',
		});
		const b = resolveDraft(s, {
			kind: 'label', name: 'ANJUNADEEP',
			source: 'beatport', sourceKind: 'label', sourceId: 'bp-123',
		});
		expect(b.entity.id).toBe(a.entity.id);
		s.close();
	});
});

describe('attachSourceRef merge-awareness', () => {
	it('attaching a ref another entity owns merges onto the owner', () => {
		const s = makeStore();
		// Established Spotify artist…
		const owner = resolveDraft(s, artistDraft('Massano', 'sp-m')).entity;
		// …and an agent stub created earlier while Massano didn't exist yet
		// (so the claim resolver stubbed it — simulate directly).
		const stub = s.insertEntity({ kind: 'artist', name: 'Massano (stub)' });
		const finalId = attachSourceRef(s, stub.id, artistDraft('Massano', 'sp-m'));
		expect(finalId).toBe(owner.id);
		expect(s.getEntity(stub.id)?.id).toBe(owner.id);
		s.close();
	});
});

describe('corroborateArtist', () => {
	it('merges name twins that share a structured neighbor; agent edges never corroborate', () => {
		const s = makeStore();
		const a = resolveDraft(s, artistDraft('Kevin de Vries', 'sp-k')).entity;
		const b = resolveDraft(s, artistDraft('Kevin De Vries', 'bp-k', 'beatport')).entity;
		const other = s.insertEntity({ kind: 'artist', name: 'Somebody Else' });
		// Only an agent-asserted shared neighbor → no merge.
		s.upsertEdges([
			{ srcId: a.id, kind: 'similar-artist', dstId: other.id, source: 'agent' },
			{ srcId: b.id, kind: 'similar-artist', dstId: other.id, source: 'agent' },
		]);
		expect(corroborateArtist(s, b.id)).toBeNull();
		// A shared release credit from structured sources → merge, older row wins.
		const rel = s.insertEntity({ kind: 'release', name: 'Dance With Me' });
		s.upsertEdges([
			{ srcId: a.id, kind: 'artist-release', dstId: rel.id, source: 'spotify' },
			{ srcId: b.id, kind: 'artist-release', dstId: rel.id, source: 'beatport' },
		]);
		expect(corroborateArtist(s, b.id)).toBe(a.id);
		expect(s.getEntity(b.id)?.id).toBe(a.id);
		s.close();
	});
});
