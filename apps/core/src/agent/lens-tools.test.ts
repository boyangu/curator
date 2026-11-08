// The assistant's standing-lens tools: add_feed_lens builds the rule from flat
// args, checks genre/label values against the feed, keeps the user's words as
// the label; remove_feed_lens takes an id or a kind.

import { describe, expect, it } from 'vitest';
import { buildAgentTools, type AgentTool, type AgentToolCtx } from './tools.js';
import { parseRule, withLens, withoutLens, type FeedLens } from '../feed/lenses.js';
import type { CoreService } from '../service.js';

function setup(): { tools: Map<string, AgentTool>; lenses: () => FeedLens[] } {
	let lenses: FeedLens[] = [];
	let n = 0;
	const svc = {
		getFeedFilterOptions: async () => ({ genres: ['Deep House', 'Techno'], labels: ['Anjunadeep'] }),
		getFeedLenses: async () => lenses,
		addFeedLens: async (input: { rule: unknown; label?: string | null; by: 'user' | 'assistant' }) => {
			const rule = parseRule(input.rule);
			if (!rule) throw new Error('invalid lens rule');
			lenses = withLens(lenses, { rule, label: input.label ?? null, by: input.by }, 1, () => `l${++n}`);
			return lenses;
		},
		removeFeedLens: async (id: string) => (lenses = withoutLens(lenses, id)),
	} as unknown as CoreService;
	const tools = new Map(buildAgentTools({ svc: () => svc, getSpotifyClient: async () => null, beatport: null, waitForKbExpansion: async () => false }).map((t) => [t.name, t]));
	return { tools, lenses: () => lenses };
}

const ctx = {} as AgentToolCtx;

describe('feed lens tools', () => {
	it('adds lenses in the user’s words, one per kind, with genre values matched to the feed', async () => {
		const { tools, lenses } = setup();
		const add = tools.get('add_feed_lens')!;
		expect(await add.execute({ kind: 'library-artist', has: false, label: 'only artists I don’t have' }, ctx)).toMatchObject({ ok: true });
		expect(await add.execute({ kind: 'genre', value: 'deep house', label: 'deep house only' }, ctx)).toMatchObject({ ok: true });
		expect(lenses().map((l) => [l.rule, l.label, l.by])).toEqual([
			[{ kind: 'library-artist', has: false }, 'only artists I don’t have', 'assistant'],
			[{ kind: 'genre', value: 'Deep House' }, 'deep house only', 'assistant'],
		]);
		const miss = await add.execute({ kind: 'genre', value: 'Trance', label: 'trance' }, ctx) as { ok: boolean; note: string };
		expect(miss.ok).toBe(false);
		expect(miss.note).toContain('available: Deep House, Techno');
		expect(await add.execute({ kind: 'set-artist', atLeast: 2, label: 'played out twice' }, ctx)).toMatchObject({ ok: true, lenses: expect.arrayContaining([{ id: 'l3', kind: 'set-artist', label: 'played out twice' }]) });
	});

	it('removes by id or by kind, and says when there is no such lens', async () => {
		const { tools, lenses } = setup();
		const add = tools.get('add_feed_lens')!;
		const remove = tools.get('remove_feed_lens')!;
		await add.execute({ kind: 'library-artist', has: false, label: 'a' }, ctx);
		await add.execute({ kind: 'archived-artist', atLeast: 3, label: 'b' }, ctx);
		expect(await remove.execute({ kind: 'archived-artist' }, ctx)).toMatchObject({ ok: true, removed: 'b' });
		expect(await remove.execute({ id: 'nope' }, ctx)).toMatchObject({ ok: false, note: 'no such lens' });
		expect(await remove.execute({ id: lenses()[0]!.id }, ctx)).toMatchObject({ ok: true, lenses: [] });
	});

	it('marks both tools as non-destructive writes', () => {
		const { tools } = setup();
		for (const name of ['add_feed_lens', 'remove_feed_lens']) expect(tools.get(name)!.annotations).toEqual({ readOnly: false, destructive: false, idempotent: true });
		expect(tools.has('update_feed_filters')).toBe(false);
	});
});
