// Query-grammar tests — parser, evaluator, and SQL-prefilter extraction.
// The grammar backs both the omnibar and the tracklist filterbox; the
// matchTrack/extractSqlPrefilter split must agree (JS post-filter can't
// reject what SQL kept) so both halves are pinned here.

import { describe, expect, it } from 'vitest';
import type { Track } from '@curator/shared';
import {
	collectTagNames,
	extractSqlPrefilter,
	isEmptyExpr,
	matchTrack,
	parseQuery,
	type TagResolver,
} from './query.js';

function mkTrack(p: Partial<Track> = {}): Track {
	return {
		id: 't1',
		title: 'Beyond Beliefs',
		artists: [{ name: 'Ben Böhmer' }],
		albumTitle: 'Breathing',
		label: 'Anjunadeep',
		genre: 'Melodic House',
		keyCamelot: '9A',
		bpm: 120,
		duration: 372,
		rating: 4,
		dissonance: null,
		...p,
	} as Track;
}

const resolver: TagResolver = {
	idsForTrack: (id) => (id === 't1' ? ['tag-deep'] : []),
	nameToId: (name) => (name.toLowerCase() === 'deep' ? 'tag-deep' : null),
	hasPlaylistName: (ascii) => ascii === 'zen mix',
};

describe('parseQuery', () => {
	it('returns the empty expr for blank input', () => {
		expect(isEmptyExpr(parseQuery(''))).toBe(true);
		expect(isEmptyExpr(parseQuery('   '))).toBe(true);
	});

	it('parses implicit AND between bare terms', () => {
		const e = parseQuery('ben böhmer');
		expect(e.kind).toBe('and');
	});

	it('parses tag lists and boolean grouping', () => {
		expect(collectTagNames(parseQuery('#deep #balkan'))).toEqual(['deep', 'balkan']);
		expect(collectTagNames(parseQuery('(#b1 | #b2) & #p3'))).toEqual(['b1', 'b2', 'p3']);
		// Same name referenced twice collapses to one entry.
		expect(collectTagNames(parseQuery('#deep | #deep'))).toEqual(['deep']);
	});
});

describe('matchTrack — free text', () => {
	const t = mkTrack();

	it('matches across title/artist/album/label/genre', () => {
		expect(matchTrack(parseQuery('beyond'), t)).toBe(true);
		expect(matchTrack(parseQuery('anjunadeep'), t)).toBe(true);
		expect(matchTrack(parseQuery('melodic'), t)).toBe(true);
		expect(matchTrack(parseQuery('nosuchterm'), t)).toBe(false);
	});

	it('is diacritic-insensitive both directions', () => {
		expect(matchTrack(parseQuery('bohmer'), t)).toBe(true);
		expect(matchTrack(parseQuery('böhmer'), t)).toBe(true);
	});

	it('ANDs multiple bare terms', () => {
		expect(matchTrack(parseQuery('ben breathing'), t)).toBe(true);
		expect(matchTrack(parseQuery('ben nosuchterm'), t)).toBe(false);
	});

	it('matches quoted phrases as one needle', () => {
		expect(matchTrack(parseQuery('"ben böhmer"'), t)).toBe(true);
		expect(matchTrack(parseQuery('"böhmer ben"'), t)).toBe(false);
	});

	it('matches numeric bare terms against exact bpm', () => {
		expect(matchTrack(parseQuery('120'), t)).toBe(true);
		expect(matchTrack(parseQuery('121'), t)).toBe(false);
	});

	it('folds connector punctuation both directions', () => {
		const dwy = mkTrack({ title: 'D.W.Y', artists: [{ name: 'Jay-Z' }] });
		// punctuated stored value, bare needle
		expect(matchTrack(parseQuery('dwy'), dwy)).toBe(true);
		// bare stored value, punctuated needle
		const bare = mkTrack({ title: 'DWY' });
		expect(matchTrack(parseQuery('d.w.y'), bare)).toBe(true);
		// hyphen + apostrophe
		expect(matchTrack(parseQuery('jayz'), dwy)).toBe(true);
		expect(matchTrack(parseQuery("don't"), mkTrack({ title: 'Dont Stop' }))).toBe(true);
	});

	it('keeps `&` literal so "&ME" does not match every "…me…"', () => {
		const ampMe = mkTrack({ title: 'Track', artists: [{ name: '&ME' }] });
		const plainMe = mkTrack({ title: 'Tame Impala', artists: [{ name: 'Someone' }] });
		// "&ME" stays a single free term (not AND + "ME") and the `&` is part
		// of the needle, so only the artist literally containing "&me" matches.
		expect(parseQuery('&ME').kind).toBe('free');
		expect(matchTrack(parseQuery('&ME'), ampMe)).toBe(true);
		expect(matchTrack(parseQuery('&ME'), plainMe)).toBe(false);
	});

	it('treats a space-delimited `&` as boolean AND', () => {
		expect(parseQuery('ben & breathing').kind).toBe('and');
		expect(matchTrack(parseQuery('ben & breathing'), t)).toBe(true);
		expect(matchTrack(parseQuery('ben & nosuchterm'), t)).toBe(false);
	});
});

describe('matchTrack — attributes', () => {
	const t = mkTrack();

	it('attr substring', () => {
		expect(matchTrack(parseQuery('artist:böhm'), t)).toBe(true);
		expect(matchTrack(parseQuery('artist:bohm'), t)).toBe(true);
		expect(matchTrack(parseQuery('label:deep'), t)).toBe(true);
		expect(matchTrack(parseQuery('title:bohm'), t)).toBe(false);
	});

	it('exact attr requires the full value', () => {
		expect(matchTrack(parseQuery('artist={Ben Böhmer}'), t)).toBe(true);
		expect(matchTrack(parseQuery('artist={Ben}'), t)).toBe(false);
	});

	it('key matches both Camelot and musical spellings', () => {
		expect(matchTrack(parseQuery('key={9A}'), t)).toBe(true);
		expect(matchTrack(parseQuery('key={Em}'), t)).toBe(true);
		expect(matchTrack(parseQuery('key={8A}'), t)).toBe(false);
	});
});

describe('matchTrack — numeric comparisons', () => {
	const t = mkTrack(); // bpm 120, rating 4, dissonance null

	it('handles bound operators and equality', () => {
		expect(matchTrack(parseQuery('bpm<120'), t)).toBe(false);
		expect(matchTrack(parseQuery('bpm<=120'), t)).toBe(true);
		expect(matchTrack(parseQuery('bpm=120'), t)).toBe(true);
		expect(matchTrack(parseQuery('bpm>119'), t)).toBe(true);
		expect(matchTrack(parseQuery('rating>=4'), t)).toBe(true);
		expect(matchTrack(parseQuery('rating>4'), t)).toBe(false);
	});

	it('handles double-bounded ranges', () => {
		expect(matchTrack(parseQuery('118<=bpm<=122'), t)).toBe(true);
		expect(matchTrack(parseQuery('121<=bpm<=122'), t)).toBe(false);
	});

	it('rejects comparisons on missing analyzer fields', () => {
		expect(matchTrack(parseQuery('diss>0'), t)).toBe(false);
		expect(matchTrack(parseQuery('diss<1'), t)).toBe(false);
	});

	it('resolves field aliases', () => {
		expect(matchTrack(parseQuery('stars>=4'), t)).toBe(true);
		expect(matchTrack(parseQuery('duration>300'), t)).toBe(true);
	});
});

describe('matchTrack — # namespace (tags + playlist names)', () => {
	it('matches by resolved tag membership', () => {
		expect(matchTrack(parseQuery('#deep'), mkTrack(), resolver)).toBe(true);
		expect(matchTrack(parseQuery('#deep'), mkTrack({ id: 't2' }), resolver)).toBe(false);
	});

	it('falls back to playlist-name membership', () => {
		const inPlaylist = mkTrack({ id: 't2', playlistNamesAscii: ['zen mix'] } as Partial<Track>);
		expect(matchTrack(parseQuery('#"zen mix"'), inPlaylist, resolver)).toBe(true);
		expect(matchTrack(parseQuery('#"zen mix"'), mkTrack({ id: 't2' }), resolver)).toBe(false);
	});

	it('treats #name as a pass-through without a resolver', () => {
		expect(matchTrack(parseQuery('#deep'), mkTrack({ id: 't2' }))).toBe(true);
	});

	it('composes with booleans', () => {
		const t = mkTrack();
		expect(matchTrack(parseQuery('(#deep | #dark) & bpm<125'), t, resolver)).toBe(true);
		expect(matchTrack(parseQuery('(#dark | #missing) & bpm<125'), t, resolver)).toBe(false);
	});
});

describe('matchTrack — source membership', () => {
	// `sources` is decorated by getTracks: source_link sources plus
	// 'rekordbox' from rekordbox_link.
	const rb = mkTrack({ sources: ['local', 'rekordbox'] } as Partial<Track>);
	const sp = mkTrack({ sources: ['spotify'] } as Partial<Track>);

	it('matches against the decorated sources array', () => {
		expect(matchTrack(parseQuery('source:rekordbox'), rb)).toBe(true);
		expect(matchTrack(parseQuery('source:rekordbox'), sp)).toBe(false);
		expect(matchTrack(parseQuery('source:spotify'), sp)).toBe(true);
	});

	it('resolves src/rb aliases and normalizes case', () => {
		expect(matchTrack(parseQuery('src:rb'), rb)).toBe(true);
		expect(matchTrack(parseQuery('SOURCE:Rekordbox'), rb)).toBe(true);
		expect(matchTrack(parseQuery('source={rekordbox}'), rb)).toBe(true);
	});

	it('composes with other terms', () => {
		expect(matchTrack(parseQuery('source:rekordbox böhmer'), rb)).toBe(true);
		expect(matchTrack(parseQuery('source:spotify böhmer'), rb)).toBe(false);
		expect(matchTrack(parseQuery('source:spotify | source:local'), rb)).toBe(true);
	});

	it('unknown source values match nothing', () => {
		expect(matchTrack(parseQuery('source:nosuch'), rb)).toBe(false);
	});

	it('passes through when sources is undecorated', () => {
		expect(matchTrack(parseQuery('source:rekordbox'), mkTrack())).toBe(true);
	});
});

describe('matchTrack — OR precedence', () => {
	// `a OR b c` reads as `a OR (b AND c)` — implicit AND binds tighter.
	const q = parseQuery('alpha OR bravo charlie');
	it('left branch alone matches', () => {
		expect(matchTrack(q, mkTrack({ title: 'alpha only' }))).toBe(true);
	});
	it('right branch needs both terms', () => {
		expect(matchTrack(q, mkTrack({ title: 'bravo charlie' }))).toBe(true);
		expect(matchTrack(q, mkTrack({ title: 'bravo only' }))).toBe(false);
	});
});

describe('extractSqlPrefilter', () => {
	it('pushes bpm bounds with exclusive-bound adjustment', () => {
		const pre = extractSqlPrefilter(parseQuery('bpm>=120 bpm<=126'));
		expect(pre.bpmMin).toBe(120);
		expect(pre.bpmMax).toBe(126);
		expect(pre.complete).toBe(true);

		const excl = extractSqlPrefilter(parseQuery('bpm>120 bpm<126'));
		expect(excl.bpmMin).toBe(121);
		expect(excl.bpmMax).toBe(125);
	});

	it('pushes exact key, leaves other attrs to the search chain', () => {
		const pre = extractSqlPrefilter(parseQuery('key={9a}'));
		expect(pre.keyCamelot).toBe('9A');
		expect(pre.complete).toBe(true);

		const attr = extractSqlPrefilter(parseQuery('label:anjuna'));
		expect(attr.keyCamelot).toBeUndefined();
		expect(attr.search).toBe('anjuna');
		expect(attr.complete).toBe(false);
	});

	it('picks the longest free term for the single search slot', () => {
		const pre = extractSqlPrefilter(parseQuery('ben böhmer'));
		expect(pre.search).toBe('böhmer');
		expect(pre.complete).toBe(false);
	});

	it('builds name clauses from resolved tags', () => {
		const pre = extractSqlPrefilter(parseQuery('#deep'), resolver);
		expect(pre.nameClauses).toEqual([{ tagIds: ['tag-deep'], playlistNamesAscii: [] }]);
		expect(pre.hasUnresolvedRequiredTag).toBe(false);
	});

	it('flags a #name that resolves to neither tag nor playlist', () => {
		const pre = extractSqlPrefilter(parseQuery('#nosuch'), resolver);
		expect(pre.hasUnresolvedRequiredTag).toBe(true);
		expect(pre.nameClauses).toBeUndefined();
	});

	it('keeps playlist-name clauses when the resolver confirms the name', () => {
		const pre = extractSqlPrefilter(parseQuery('#"zen mix"'), resolver);
		expect(pre.nameClauses).toEqual([{ tagIds: [], playlistNamesAscii: ['zen mix'] }]);
	});

	it('pushes inclusive scalar bounds and stays complete', () => {
		const pre = extractSqlPrefilter(parseQuery('rating>=4 diss<=0.3'));
		expect(pre.scalarBounds).toEqual([
			{ field: 'rating', min: 4 },
			{ field: 'dissonance', max: 0.3 },
		]);
		expect(pre.complete).toBe(true);
	});

	it('pushes exclusive scalar bounds as inclusive over-approximations', () => {
		// diss>0.3 can't be ±1-adjusted (REAL column) — SQL keeps the boundary
		// value and complete=false keeps the in-memory pass on to enforce it.
		const pre = extractSqlPrefilter(parseQuery('diss>0.3'));
		expect(pre.scalarBounds).toEqual([{ field: 'dissonance', min: 0.3 }]);
		expect(pre.complete).toBe(false);
	});

	it('maps grammar aliases to canonical scalar columns', () => {
		const pre = extractSqlPrefilter(parseQuery('punch>=0.5 intro<=30'));
		expect(pre.scalarBounds).toEqual([
			{ field: 'dynamicComplexity', min: 0.5 },
			{ field: 'introLengthSec', max: 30 },
		]);
	});

	it('refuses to push anything inside an OR', () => {
		const pre = extractSqlPrefilter(parseQuery('bpm>120 | bpm<90'));
		expect(pre.bpmMin).toBeUndefined();
		expect(pre.bpmMax).toBeUndefined();
		expect(pre.complete).toBe(false);
	});

	it('pushes source: to hasSource and stays complete', () => {
		// Every source — rekordbox included — is one membership slot; core
		// resolves 'rekordbox' to rekordbox_link. An exact pushdown either way.
		const rb = extractSqlPrefilter(parseQuery('source:rekordbox ben'));
		expect(rb.hasSource).toBe('rekordbox');
		expect(rb.search).toBe('ben');
		expect(rb.complete).toBe(true);

		const sp = extractSqlPrefilter(parseQuery('source:spotify'));
		expect(sp.hasSource).toBe('spotify');
		expect(sp.complete).toBe(true);
	});

	it('pushes one source EXISTS; extra distinct sources fall to the client pass', () => {
		const both = extractSqlPrefilter(parseQuery('source:spotify source:local'));
		expect(both.hasSource).toBe('spotify');
		expect(both.complete).toBe(false);
		// The same source twice (alias included) is still one slot, still complete.
		const same = extractSqlPrefilter(parseQuery('source:rb source:rekordbox'));
		expect(same.hasSource).toBe('rekordbox');
		expect(same.complete).toBe(true);
	});

	it('pushes an OR made only of source: terms as the any-of array', () => {
		// The Rekordbox omnibar pill bakes itself as this disjunction — it has
		// to stay a complete pushdown or every `r/` JIT would truncate at the
		// in-memory fetch cap.
		const pre = extractSqlPrefilter(parseQuery('(source:rekordbox | source:local) ben'));
		expect(pre.hasSource).toEqual(['rekordbox', 'local']);
		expect(pre.search).toBe('ben');
		expect(pre.complete).toBe(true);
		// Bare (no parens) reads as `rekordbox OR (local AND ben)` — not a pure
		// source disjunction, so nothing is pushed.
		const bare = extractSqlPrefilter(parseQuery('source:rekordbox | source:local ben'));
		expect(bare.hasSource).toBeUndefined();
		expect(bare.complete).toBe(false);
	});

	it('refuses to push an OR that mixes source: with anything else', () => {
		const pre = extractSqlPrefilter(parseQuery('source:spotify | #deep'));
		expect(pre.hasSource).toBeUndefined();
		expect(pre.complete).toBe(false);
		// Any-of plus a conflicting single source MUST: one slot, client pass.
		const mixed = extractSqlPrefilter(parseQuery('(source:rekordbox | source:local) source:spotify'));
		expect(mixed.complete).toBe(false);
	});
});

describe('artistid — Curator artist id scope', () => {
	const t = mkTrack({ artists: [{ name: 'A' }, { name: 'B' }], artistIds: ['id-a', 'id-b'] });

	it('matches any credited artist id (alias: aid)', () => {
		expect(matchTrack(parseQuery('artistid={id-b}'), t)).toBe(true);
		expect(matchTrack(parseQuery('aid={id-a}'), t)).toBe(true);
		expect(matchTrack(parseQuery('artistid={id-c}'), t)).toBe(false);
		// Undecorated rows (no artistIds) never match by id.
		expect(matchTrack(parseQuery('artistid={id-a}'), mkTrack())).toBe(false);
	});

	it('one term is a complete pushdown; two AND-ed terms widen SQL to OR and keep the client pass', () => {
		const one = extractSqlPrefilter(parseQuery('artistid={id-b}'));
		expect(one.artistIds).toEqual(['id-b']);
		expect(one.complete).toBe(true);
		const two = extractSqlPrefilter(parseQuery('artistid={id-a} artistid={id-b}'));
		expect(two.artistIds).toEqual(['id-a', 'id-b']);
		expect(two.complete).toBe(false);
	});
});

describe('albumid — Curator album id scope', () => {
	it('matches the track\'s release id (alias: alb) and pushes down to albumIds', () => {
		const t = mkTrack({ albumId: 'al-1' } as Partial<Track>);
		expect(matchTrack(parseQuery('albumid={al-1}'), t)).toBe(true);
		expect(matchTrack(parseQuery('alb={al-1}'), t)).toBe(true);
		expect(matchTrack(parseQuery('albumid={al-2}'), t)).toBe(false);
		expect(matchTrack(parseQuery('albumid={al-1}'), mkTrack())).toBe(false);
		const one = extractSqlPrefilter(parseQuery('albumid={al-1}'));
		expect(one.albumIds).toEqual(['al-1']);
		expect(one.complete).toBe(true);
	});
});

describe('AI similarity terms', () => {
	it('similar: seeds push down as similarTo and match every fetched row', () => {
		const expr = parseQuery('similar:id-a,id-b');
		const pre = extractSqlPrefilter(expr);
		expect(pre.similarTo).toEqual({ seeds: ['id-a', 'id-b'] });
		expect(pre.complete).toBe(true);
		expect(matchTrack(expr, {} as never)).toBe(true);
	});
	it('sounds: carries a text description; like={…} is a seed alias; both combine with filters', () => {
		const pre = extractSqlPrefilter(parseQuery('sounds:"rolling acid bassline" like={x} bpm>=120'));
		expect(pre.similarTo).toEqual({ text: 'rolling acid bassline', seeds: ['x'] });
		expect(pre.bpmMin).toBe(120);
	});
	it('under an OR it cannot be pushed', () => {
		const pre = extractSqlPrefilter(parseQuery('similar:a | label:x'));
		expect(pre.similarTo).toBeUndefined();
		expect(pre.complete).toBe(false);
	});
});
