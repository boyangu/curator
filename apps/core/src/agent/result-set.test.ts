import { describe, expect, it } from 'vitest';
import { ProviderHitCache, validateResultItems, type AgentResultItemDraft, type ResultRefPorts } from './result-set.js';

// Deterministic fake stores: two library tracks (one spotify-linked), one
// feed item, one KB entity redirected by a merge.
const ports: ResultRefPorts = {
	async libraryTracks(ids) {
		const out = new Map<string, string | null>();
		if (ids.includes('lib1')) out.set('lib1', 'sp-lib1');
		if (ids.includes('lib2')) out.set('lib2', null);
		return out;
	},
	async feedItems(ids) {
		const out = new Map<string, { playSpotifyId: string | null }>();
		if (ids.includes('feed1')) out.set('feed1', { playSpotifyId: 'sp-feed1' });
		return out;
	},
	async kbEntities(ids) {
		const out = new Map<string, { resolvedId: string; playSpotifyId: string | null }>();
		if (ids.includes('kb-old')) out.set('kb-old', { resolvedId: 'kb-new', playSpotifyId: null });
		return out;
	},
};

const draft = (over: Partial<AgentResultItemDraft>): AgentResultItemDraft => ({
	kind: 'library-track',
	title: 'T',
	artists: ['A'],
	...over,
});

describe('validateResultItems', () => {
	it('accepts known refs and derives badge + playRef host-side', async () => {
		const hits = new ProviderHitCache();
		const { accepted, rejected } = await validateResultItems(
			[
				draft({ trackId: 'lib1' }),
				draft({ trackId: 'lib2', note: 'no spotify link' }),
				draft({ kind: 'feed-item', feedItemId: 'feed1' }),
				draft({ kind: 'kb-entity', kbEntityId: 'kb-old' }),
			],
			ports,
			hits,
		);
		expect(rejected).toEqual([]);
		expect(accepted).toHaveLength(4);
		expect(accepted[0]).toMatchObject({ badge: 'library', playRef: { source: 'spotify', sourceTrackId: 'sp-lib1' } });
		expect(accepted[1]).toMatchObject({ badge: 'library', playRef: null });
		expect(accepted[2]).toMatchObject({ badge: 'feed', playRef: { source: 'spotify', sourceTrackId: 'sp-feed1' } });
		// Merged KB entity resolves to the live row id.
		expect(accepted[3]).toMatchObject({ badge: 'kb', kbEntityId: 'kb-new' });
	});

	it('rejects unknown store refs with actionable reasons', async () => {
		const { accepted, rejected } = await validateResultItems(
			[draft({ trackId: 'nope' }), draft({ kind: 'feed-item', feedItemId: 'nope' })],
			ports,
			new ProviderHitCache(),
		);
		expect(accepted).toEqual([]);
		expect(rejected).toHaveLength(2);
		expect(rejected[0]!.reason).toContain('query_library');
	});

	it('accepts provider hits only when the turn cache recorded them', async () => {
		const hits = new ProviderHitCache();
		hits.record('spotify', 'sp9', { playSpotifyId: 'sp9' });
		hits.record('beatport', '42', { url: 'https://beatport.com/track/42' });
		const { accepted, rejected } = await validateResultItems(
			[
				draft({ kind: 'provider-hit', providerRef: { provider: 'spotify', id: 'sp9' } }),
				draft({ kind: 'provider-hit', providerRef: { provider: 'beatport', id: '42' } }),
				draft({ kind: 'provider-hit', providerRef: { provider: 'spotify', id: 'hallucinated' } }),
			],
			ports,
			hits,
		);
		expect(accepted).toHaveLength(2);
		// Spotify hit is directly playable; beatport hit inherits the recorded url.
		expect(accepted[0]).toMatchObject({ badge: 'web', playRef: { source: 'spotify', sourceTrackId: 'sp9' } });
		expect(accepted[1]).toMatchObject({ providerRef: { provider: 'beatport', id: '42', url: 'https://beatport.com/track/42' }, playRef: null });
		expect(rejected).toEqual([{ index: 2, reason: expect.stringContaining('not returned by any tool call') }]);
	});

	it('rejects malformed items (missing title, missing kind ref, unknown kind)', async () => {
		const { accepted, rejected } = await validateResultItems(
			[
				draft({ title: '  ' }),
				draft({ trackId: undefined }),
				{ ...draft({}), kind: 'nonsense' as 'library-track' },
			],
			ports,
			new ProviderHitCache(),
		);
		expect(accepted).toEqual([]);
		expect(rejected).toHaveLength(3);
	});

	it('caps citations and drops malformed ones', async () => {
		const hits = new ProviderHitCache();
		hits.record('spotify', 'sp1', {});
		const { accepted } = await validateResultItems(
			[draft({
				kind: 'provider-hit',
				providerRef: { provider: 'spotify', id: 'sp1' },
				citations: [
					{ url: 'https://a' }, { url: 'https://b' }, { url: 'https://c' },
					{ url: 'https://d' }, { url: 'https://e' }, { url: 'https://f' },
					{ url: 123 as unknown as string },
				],
			})],
			ports,
			hits,
		);
		expect(accepted[0]!.citations).toHaveLength(5);
	});
});
