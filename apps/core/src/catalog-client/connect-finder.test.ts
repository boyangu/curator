// The background search behind "Connect the dots": which stores it looks at
// for which follows, what it sends by itself, what it leaves for the user,
// and that it does not ask a store or the cloud twice. Made-up names.

import { describe, expect, it } from 'vitest';
import type { CatalogConnectAnswer, CatalogConnectCandidate, CatalogConnectItem, CatalogHandle, CatalogProvider, CatalogWatch } from '@curator/protocol';
import type { CatalogConnect, ConnectSearch } from './connect.js';
import { clearMatch, connectSlots, createConnectFinder, worthAsking } from './connect-finder.js';

const watch = (id: string, kind: 'artist' | 'label' | 'playlist', name: string, handles: CatalogHandle[] = [], muted = false): CatalogWatch => ({
	object: { id, kind, name, handles, coverUrl: null, watchCount: 1 },
	source: 'manual',
	muted,
	createdAt: 0,
	tracking: [],
});
const h = (provider: CatalogProvider, id: string): CatalogHandle => ({ provider, id, url: null });
const page = (provider: CatalogProvider, id: string, name: string, shared: string[] = [], releases: string[] = shared): CatalogConnectCandidate => ({ provider, providerId: id, name, url: `https://${provider}.example/${id}`, releases, shared, source: 'search' });

const SALT = watch('l-salt', 'label', 'Saltmarsh', [h('beatport', '77')]);
const NORTH = watch('l-north', 'label', 'Northfold Records', [h('beatport', '12'), h('bandcamp', '900'), h('soundcloud', '5')]);
const IVO = watch('a-ivo', 'artist', 'Ivo Lark', [h('spotify', 'sp1'), h('deezer', 'name/ivo lark')]);

function setup(over: { watches?: CatalogWatch[]; found?: Record<string, ConnectSearch | CatalogConnectCandidate[]>; cloud?: Record<string, CatalogConnectCandidate[]>; outcome?: 'attached' | 'waiting'; kept?: string | null } = {}) {
	const watches = over.watches ?? [IVO, SALT, NORTH];
	const calls: string[] = [];
	const answers: CatalogConnectAnswer[] = [];
	let kept: string | null = over.kept ?? null;
	let active = true;
	let clock = 1_000_000;
	const item = (id: string): CatalogConnectItem | null => {
		const w = watches.find((x) => x.object.id === id);
		if (!w) return null;
		const stores: CatalogProvider[] = w.object.kind === 'label' ? ['beatport', 'soundcloud', 'bandcamp'] : ['beatport', 'soundcloud', 'bandcamp', 'spotify', 'deezer', 'tidal'];
		const held = new Set([...w.object.handles.filter((x) => !x.id.includes('/')).map((x) => x.provider), ...answers.filter((a) => a.objectId === id && a.verdict === 'is').map((a) => a.provider)]);
		return { object: w.object, titles: ['Glass Rivers', 'Drift', 'Northern Line'], detail: null, missing: stores.filter((p) => !held.has(p)).map((provider) => ({ provider, candidates: over.cloud?.[`${id}|${provider}`] ?? [] })) };
	};
	const connect: CatalogConnect = {
		status: () => ({ available: true, reason: 'ok' }),
		async queue(opts) {
			calls.push(`cloud:queue:${opts.objectIds.join(',')}${opts.compare ? ':compare' : ''}`);
			const items = opts.objectIds.flatMap((id) => item(id) ?? []);
			return { items, total: items.length };
		},
		async search(subject, provider) {
			calls.push(`search:${provider}:${subject.name}`);
			const r = over.found?.[`${subject.name}|${provider}`] ?? [];
			return Array.isArray(r) ? { provider, candidates: r, searchUrl: null, note: null } : r;
		},
		async answer(sent) {
			answers.push(...sent);
			return { results: sent.map((a) => ({ outcome: a.verdict === 'is' ? (over.outcome ?? 'attached') : ('noted' as const) })) };
		},
	};
	const make = () =>
		createConnectFinder({ connect, watches: async () => (calls.push('watches'), watches), active: () => active, load: () => kept, save: (s) => { kept = s; }, now: () => clock });
	const finder = make();
	// Steps until there is nothing to search; the waits it asked for.
	const drain = async (f = finder): Promise<number[]> => {
		const waits: number[] = [];
		for (let i = 0; i < 20; i++) {
			const ms = await f.step();
			waits.push(ms);
			if (ms >= 600_000) break;
		}
		return waits;
	};
	return { finder, make, drain, calls, answers, kept: () => kept, setActive: (on: boolean) => { active = on; }, advance: (ms: number) => { clock += ms; } };
}

describe('connect finder: what it looks for', () => {
	it('asks about the stores a tracker reads through, labels first, and counts a reader’s name key as no page', () => {
		const slots = connectSlots([IVO, watch('p1', 'playlist', 'Sunday'), watch('a-muted', 'artist', 'Quiet One', [], true), NORTH, SALT]);
		// Ivo's Deezer handle is a name key; Northfold lacks nothing; an artist's Beatport is not the queue's.
		expect(slots.map((s) => `${s.name}:${s.provider}`)).toEqual(['Saltmarsh:bandcamp', 'Saltmarsh:soundcloud', 'Ivo Lark:deezer']);
	});

	it('takes a page as the object’s only when it stands out: two shared releases, and twice any rival’s', () => {
		const a = page('bandcamp', '1', 'Saltmarsh', ['Drift', 'Glass Rivers']);
		expect(clearMatch('Saltmarsh', [a, page('bandcamp', '2', 'Saltmarsh')])?.providerId).toBe('1');
		// The cloud finders' rule: twice the runner-up's is clear, less is not.
		expect(clearMatch('Saltmarsh', [a, page('bandcamp', '2', 'Saltmarsh (uk)', ['Drift'])])?.providerId).toBe('1');
		expect(clearMatch('Saltmarsh', [page('bandcamp', '1', 'Saltmarsh', ['Drift', 'Glass Rivers', 'Northern Line']), page('bandcamp', '2', 'Saltmarsh (uk)', ['Drift', 'Glass Rivers'])])).toBeNull();
		expect(clearMatch('Saltmarsh', [page('bandcamp', '1', 'Saltmarsh', ['Drift'])])).toBeNull();
		// Another name is not this object's page, whatever it lists.
		expect(clearMatch('Saltmarsh', [page('bandcamp', '3', 'Saltmarsh Recordings', ['Drift', 'Glass Rivers'])])).toBeNull();
		expect(clearMatch('Saltmarsh', [page('bandcamp', '4', 'Saltmarsh', ['A', 'B', 'C', 'D']), page('bandcamp', '5', 'SALTMARSH', ['A'])])?.providerId).toBe('4');
	});

	it('asks a person only about a page of that name that may be theirs', () => {
		const known = ['Glass Rivers', 'Drift', 'Northern Line', 'Low Tide', 'Home'];
		// Another name, whatever the store thought of the search.
		expect(worthAsking('Magnifik Music', known, [page('bandcamp', '1', 'Magnetik Music')])).toBe(false);
		// A namesake whose own list shares nothing with a label the catalogue knows well.
		expect(worthAsking('Saltmarsh', known, [page('bandcamp', '2', 'Saltmarsh', [], ['Balcanic', 'Somantir'])])).toBe(false);
		// One shared release, a list the store does not give, or a label barely known: a person can tell.
		expect(worthAsking('Saltmarsh', known, [page('bandcamp', '3', 'Saltmarsh', ['Drift'], ['Drift', 'Balcanic'])])).toBe(true);
		expect(worthAsking('Saltmarsh', known, [page('soundcloud', '4', 'SALTMARSH')])).toBe(true);
		expect(worthAsking('Saltmarsh', ['Drift'], [page('bandcamp', '2', 'Saltmarsh', [], ['Balcanic'])])).toBe(true);
	});
});

describe('connect finder: a pass', () => {
	it('sends a clear match by itself, remembers a store with nothing, and leaves the unclear for the user', async () => {
		const { finder, drain, calls, answers } = setup({
			found: {
				'Saltmarsh|bandcamp': [page('bandcamp', '51', 'Saltmarsh', ['Drift', 'Glass Rivers'], ['Drift', 'Glass Rivers', 'Other']), page('bandcamp', '52', 'Saltmarsh')],
				'Ivo Lark|deezer': [page('deezer', '111', 'Ivo Lark', ['Drift']), page('deezer', '222', 'Ivo Lark')],
			},
		});
		const waits = await drain();
		// One search a slot, a few seconds apart; then idle until the follows are read again.
		expect(waits).toEqual([5_000, 5_000, 5_000, 1_800_000]);
		expect(answers).toEqual([{ objectId: 'l-salt', provider: 'bandcamp', verdict: 'is', url: 'https://bandcamp.example/51', name: 'Saltmarsh', source: 'auto', releases: ['Drift', 'Glass Rivers', 'Other'] }]);
		// The Following list once, each object's titles once (to compare with), each store once.
		expect(calls).toEqual(['watches', 'cloud:queue:l-salt:compare', 'search:bandcamp:Saltmarsh', 'search:soundcloud:Saltmarsh', 'cloud:queue:a-ivo:compare', 'search:deezer:Ivo Lark']);
		expect(finder.pending()).toEqual({ count: 1 });
		const q = await finder.queue();
		expect(q.total).toBe(1);
		// Only the store it could not settle, not every store the artist lacks.
		expect(q.items.map((i) => `${i.object.name}:${i.missing.map((m) => m.provider).join(',')}`)).toEqual(['Ivo Lark:deezer']);
	});

	it('does not send a match the catalogue’s own finders doubted, or one the cloud refused', async () => {
		const found = { 'Saltmarsh|bandcamp': [page('bandcamp', '51', 'Saltmarsh', ['Drift', 'Glass Rivers'])] };
		const doubted = setup({ watches: [SALT], found, cloud: { 'l-salt|bandcamp': [page('bandcamp', '99', 'Saltmarsh')] } });
		await doubted.drain();
		expect(doubted.answers).toEqual([]);
		expect(doubted.finder.pending()).toEqual({ count: 1 });
		// Held for the operator: sent, and not the user's to answer again.
		const held = setup({ watches: [SALT], found, outcome: 'waiting' });
		await held.drain();
		expect(held.answers).toHaveLength(1);
		expect(held.finder.pending()).toEqual({ count: 0 });
	});

	it('leaves a store alone after it turned this machine away, and goes on with the others', async () => {
		const { finder, drain, calls, advance } = setup({
			watches: [SALT, watch('l-two', 'label', 'Tidewrack', [h('beatport', '8')])],
			found: { 'Saltmarsh|bandcamp': { provider: 'bandcamp', candidates: [], searchUrl: null, note: 'blocked' } },
		});
		await drain();
		// Bandcamp was asked once and not again; SoundCloud for both labels.
		expect(calls.filter((c) => c.startsWith('search:'))).toEqual(['search:bandcamp:Saltmarsh', 'search:soundcloud:Saltmarsh', 'search:soundcloud:Tidewrack']);
		expect(finder.pending()).toEqual({ count: 0 });
		// Six hours on it is asked again — once: turned away again, the other label waits too.
		advance(6 * 3600_000 + 1);
		await drain();
		expect(calls.filter((c) => c.startsWith('search:bandcamp'))).toEqual(['search:bandcamp:Saltmarsh', 'search:bandcamp:Saltmarsh']);
	});

	it('remembers across launches, drops what the user settled, and looks again after three months', async () => {
		const first = setup({ watches: [IVO], found: { 'Ivo Lark|deezer': [page('deezer', '111', 'Ivo Lark', ['Drift']), page('deezer', '222', 'Ivo Lark')] } });
		await first.drain();
		expect(first.finder.pending()).toEqual({ count: 1 });

		const again = setup({ watches: [IVO], kept: first.kept() });
		// The number on the button is there before the follows are read again.
		expect(again.finder.pending()).toEqual({ count: 1 });
		expect(again.calls).toEqual([]);
		await again.drain();
		expect(again.calls.filter((c) => c.startsWith('search:'))).toEqual([]);
		expect(again.finder.pending()).toEqual({ count: 1 });
		// The user says none of the pages is his: out of the queue.
		again.finder.settled([{ objectId: 'a-ivo', provider: 'deezer', verdict: 'none' }], [{ outcome: 'noted' }]);
		expect(again.finder.pending()).toEqual({ count: 0 });
		expect((await again.finder.queue()).items).toEqual([]);
		again.advance(91 * 86_400_000);
		await again.drain();
		expect(again.calls.filter((c) => c.startsWith('search:'))).toEqual(['search:deezer:Ivo Lark']);
	});

	it('searches nothing while it is not this device’s to do', async () => {
		const { finder, calls, setActive } = setup();
		setActive(false);
		expect(await finder.step()).toBe(600_000);
		expect(calls).toEqual([]);
	});
});
