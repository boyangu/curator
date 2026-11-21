// Artists whose name reads as several ("Citizen Kain & Aaron Suiss", "Marcus
// Meinhardt, Aaron Suiss"), sorted by what the catalogue itself can tell of
// each (`catalog repair compound-artists --dry`). Found 2026-11-19 on one
// artist's collaborator list: 9 of 49 were such names, from three sources.
//
//   - Apple's lookup gives a song the id of ONE of its artists (most often
//     the first) beside the whole credit line as `artistName`, and the reader
//     named the id with the line.
//   - A live object takes its latest claim's name (ingest.ts attachFacts), so
//     that line also renamed real artists: Citizen Kain's own object, with
//     his Spotify, Deezer and Tidal pages, read "Citizen Kain & Aaron Suiss".
//   - Deezer holds artist pages for whole credits ("Stan Kolev & Aaron
//     Suiss", an id with albums): a store id that is no artist.
//
// The name alone settles nothing: "Frankey & Sandrino" and "Stil & Bense" are
// one act each, which is why the library never splits `&` (@curator/shared
// artist-credit). So each class below rests on evidence beside the name, and
// what has none is `unsure` — a question for the reasoner, not for a rule.
//
// Read-only. One call reads one bounded page of candidates in one short
// transaction (PGlite holds one lock per transaction); the caller pages by
// `next`.

import { splitCredit } from '@curator/catalog-readers';
import { creditPieces, nameFold } from '@curator/library-logic';
import type { Db, Queryable } from '../db/db.js';
import { num } from '../db/db.js';
import { withSystemTx } from '../db/system-tx.js';
import { WEAK_SQL } from './identity.js';
import { NAME_SOURCES, nameAnswers, type NameAnswers, type NameSource } from './name-lookup.js';

// renamed:   its own store pages call it something plainer — the name is a
//             credit line a claim left on a real artist.
// apple_line: Apple pages only, named by the reader from a credit line; the
//             id is one artist's (`to`, once Apple was asked).
// alias:      every act the name lists is credited beside it on one track, by
//             artists a store holds: a store's page for a credit, not an artist.
// packed:     a credit the library's splitter separates (`,` `;` ` / `
//             feat.) that a reader stored whole.
// tokens:     Spotify, asked, holds no artist of the whole name, and every
//             name in it is a Spotify or Beatport artist of its own.
// act:        a store that credits each artist by their own page holds a
//             page of this name (in the catalogue, or asked: name-lookup.ts):
//             one act, whoever else is credited beside it.
// unsure:     none of the above, or the evidence disagrees.
export const COMPOUND_CLASSES = ['renamed', 'apple_line', 'alias', 'tokens', 'packed', 'act', 'unsure'] as const;
export type CompoundClass = (typeof COMPOUND_CLASSES)[number];

// What a class means for the name. Only what a store itself says is acted on:
//   keep    one act: a page of the name at a store that credits each artist
//           apart.
//   rename  one artist whose id a credit line was written on (its own pages
//           say who, or Apple does): it takes that artist's name. Its credits
//           were its own all along — attached by id, the line only named it —
//           so nothing moves to the others the line names (`also`).
//   split   a page or a reader's key for a whole credit: every credit on it is
//           each listed act's (`into`). Either all of them are credited beside
//           it by artists a store holds, or the whole name is no artist at
//           Spotify while each name in it is.
//   ask     the reasoner. A comma or an `&` alone decides nothing: "Emerson,
//           Lake & Palmer" and "Black Country, New Road" read exactly like
//           packed credits. Nor do the names in it: "Frankey" and "Sandrino"
//           are each a Spotify artist, as the pieces of a quarter of all real
//           duos are (measured 2026-11-19) — so the whole name is asked first.
export type CompoundDecision = 'keep' | 'rename' | 'split' | 'ask';

export type CompoundPage = { provider: string; providerId: string; name: string | null; weak: boolean };
export type CompoundEvidence = {
	name: string;
	pages: CompoundPage[];
	// Tracks / releases where every listed act is credited beside it, and
	// where only some are.
	tracks: { all: number; some: number };
	releases: { all: number; some: number };
	// Another artist of this very name holds a page at such a store.
	actTwin: boolean;
	// Apple's own name for the id, when asked.
	appleName?: string | null;
	// Each name it lists, by how it is known as an artist of its own: 0 not at
	// all, 1 by name only, 2 a store's page, 3 a Spotify or Beatport page.
	tokens: number[];
	// What sources outside the catalogue answered for the whole name.
	asked?: NameAnswers;
	// The tracks and releases it is credited on.
	credited: number;
};
export type CompoundRow = {
	id: string;
	name: string;
	class: CompoundClass;
	decision: CompoundDecision;
	// rename: the name it takes (its pages', or Apple's own for the id).
	to?: string;
	// rename: who else the line named.
	also?: string[];
	// split: the artists its credits go to, as the name writes them.
	into?: string[];
	why: string;
	pieces: string[];
	// How each piece is known as an artist of its own (CompoundEvidence.tokens).
	tokens: number[];
	// The outside sources that answered for the whole name.
	asked: NameSource[];
	pages: string[];
	credits: { tracks: number; releases: number };
};
export type CompoundReport = {
	candidates: number;
	rows: CompoundRow[];
	// Apple ids asked this call (the lookup refuses bursts: the caller paces).
	appleAsked: number;
	// The cursor for the next page; null when this was the last.
	next: string | null;
};

export const COMPOUND_PAGE = 400;

// Stores that credit every artist of a track by their own page, so that a
// page named "A & B" there is an act. Deezer and Apple are not: Deezer
// mints a page for a credit, and Apple's name here is the reader's.
const ACT_STORES = new Set(['spotify', 'beatport']);
// At most this many credits and a store's page of the name may be a stray one
// (classifyCompound): the ones seen held one to four.
const STRAY_CREDITS = 5;
// A Spotify artist followed by this many is an act, however little of it the
// catalogue holds.
const STRAY_FOLLOWERS = 1_000;
// What `creditFolds` splits on, for the candidate filter: a superset is fine,
// a name with no pieces is dropped after the read.
const JOINER_SQL = `o.name ~* '[,;/+]|\\s(&|and|x|vs\\.?|versus|with|feat\\.?|featuring|ft\\.?|pres\\.?|presents|b2b)\\s'`;

export const piecesOf = (name: string): string[] => creditPieces(name).map(nameFold);

// The acts a credit line names, as written. With its leading act known
// (`lead`) that act stays whole, so "Above & Beyond & OceanLab" led by
// "Above & Beyond" is those two and not three.
export function splitInto(name: string, lead?: string): string[] {
	const fold = lead ? nameFold(lead) : '';
	if (fold) {
		for (let i = 1; i < name.length; i++) {
			// A cut inside a word is no cut ("Sub" does not lead "Subliminal & …").
			if (/[\p{L}\p{N}]/u.test(name[i]!) || nameFold(name.slice(0, i)) !== fold) continue;
			// The rest read behind a one-letter stand-in for the lead (dropped as a
			// piece): alone, a rest of one name would be no compound at all.
			const rest = creditPieces(`q${name.slice(i)}`).filter((p) => nameFold(p) !== fold);
			return rest.length ? [lead!, ...rest] : [lead!];
		}
	}
	return creditPieces(name);
}

export function decideCompound(name: string, c: { class: CompoundClass; to?: string }): { decision: CompoundDecision; into?: string[]; also?: string[] } {
	if (c.class === 'act') return { decision: 'keep' };
	if (c.class === 'renamed' || c.class === 'apple_line') {
		// Apple did not answer for the id: nothing says whose it is.
		if (!c.to) return { decision: 'ask' };
		const lead = nameFold(c.to);
		const also = splitInto(name, c.to).filter((p) => nameFold(p) !== lead);
		return { decision: 'rename', ...(also.length ? { also } : {}) };
	}
	if (c.class === 'alias' || c.class === 'tokens') {
		const into = creditPieces(name);
		if (into.length > 1) return { decision: 'split', into };
	}
	return { decision: 'ask' };
}

export function classifyCompound(e: CompoundEvidence): { class: CompoundClass; to?: string; why: string } {
	const fold = nameFold(e.name);
	const strong = e.pages.filter((p) => !p.weak && p.name);
	// An Apple page's stored name is a song's credit line too — the first one
	// seen, not always the one the object now carries ("Yves V & Sidney Samson"
	// under "Yves V, Axel Cooper & Shanguy") — so it vouches for no name and
	// against none: only another store's page does ("Hunter/Game" stands,
	// whatever "Hunter/Game & Drown" Apple once sent).
	const others = strong.filter((p) => p.provider !== 'apple');
	const plain = others.filter((p) => nameFold(p.name) !== fold);
	const named = others.filter((p) => nameFold(p.name) === fold);
	if (plain.length) {
		const to = commonest(plain.map((p) => p.name!));
		if (!named.length) return { class: 'renamed', to, why: `${plain.length} of its ${others.length} store page(s) call it "${to}"` };
		return { class: 'unsure', why: `its pages disagree: ${plain.length} call it "${to}", ${named.length} "${e.name}" (${named.map((p) => p.provider).join(', ')})` };
	}
	const appleOnly = strong.length > 0 && !others.length;
	if (appleOnly) {
		if (e.appleName === undefined) return { class: 'apple_line', why: 'Apple pages only, named from a credit line: ask Apple for the id\'s own name' };
		if (e.appleName && nameFold(e.appleName) !== fold) return { class: 'apple_line', to: e.appleName, why: `Apple calls the id "${e.appleName}"` };
		// Apple itself holds a page of this name (or no longer answers for the
		// id): judged like any other page below.
	}
	// The whole name as an artist: a page of it the catalogue holds, or one a
	// source outside answered with. MusicBrainz files a collaboration under its
	// members, so an artist of the name there is an act — unless a person, which
	// a name listing several is not.
	const sp = e.asked?.spotify;
	const mb = e.asked?.musicbrainz;
	const own = e.tokens.length >= 2 && e.tokens.every((l) => l >= 3);
	const store = strong.some((p) => ACT_STORES.has(p.provider) && nameFold(p.name) === fold)
		? 'a Spotify or Beatport page of this name'
		: e.actTwin
			? 'another artist of this name holds a Spotify or Beatport page'
			: sp
				? `Spotify, asked, holds an artist of this name${sp.followers !== null && sp.followers !== undefined ? ` (${sp.followers} followers)` : ''}`
				: null;
	const listed = mb && mb.type !== 'Person' ? `MusicBrainz lists it as ${mb.type ? `a ${mb.type.toLowerCase()}` : 'an artist'}` : null;
	// A store's page is not always an act's: a distributor typing a whole
	// credit into the artist field gets a Spotify artist of that name ("Marc
	// Romboy vs. Gui Boratto", "Nick Devon feat. Miroir": own ids, one track).
	// Such a page shows as a handful of credits under a name whose every part
	// is an artist of its own; then only MusicBrainz listing the act keeps it,
	// (or Spotify's followers, where it was asked) keeps it, and without that
	// it is a question, never a split by rule.
	const stray = !!store && !listed && own && e.credited <= STRAY_CREDITS && (sp?.followers ?? 0) < STRAY_FOLLOWERS;
	const act = stray ? null : (store ?? listed);
	// The act's own page outweighs its members credited beside it ("Stil &
	// Bense" with "Stil" and "Bense" on 17 tracks): there the members are the
	// copies, not the duo.
	if (act) return { class: 'act', why: e.tracks.all > 0 ? `${act}; the acts it names are also credited beside it on ${e.tracks.all} track(s)` : act };
	if (stray) return { class: 'unsure', why: `${store}, yet it has ${e.credited} credit(s) and every name in it is an artist of its own: a credit line a store gave a page? (${mb === null ? 'MusicBrainz lists no such act' : 'MusicBrainz not asked'})` };
	if (e.tracks.all > 0) return { class: 'alias', why: `every act it names is credited beside it on ${e.tracks.all} track(s)` };
	// Its names as artists of their own decide only once Spotify has said the
	// whole is none: alone they would split one real duo in four.
	if (own && sp === null) return { class: 'tokens', why: 'Spotify, asked, holds no artist of this name, and every name in it is a Spotify or Beatport artist of its own' };
	const said = [
		own ? 'every name in it is a Spotify or Beatport artist of its own' : e.tokens.some((l) => l === 0) ? 'a name in it is no artist anywhere in the catalogue' : null,
		sp === null ? 'Spotify holds no artist of this name' : sp === undefined ? 'Spotify not asked' : null,
		mb === null ? 'nor does MusicBrainz' : mb === undefined ? 'MusicBrainz not asked' : null,
	].filter(Boolean);
	const tail = said.length ? ` (${said.join('; ')})` : '';
	if (splitCredit(e.name).length > 1) return { class: 'packed', why: `a credit the splitter separates, stored whole${tail}` };
	if (e.releases.all > 0) return { class: 'unsure', why: `every act it names is credited beside it on ${e.releases.all} release(s), on no track${tail}` };
	if (e.tracks.some + e.releases.some > 0) return { class: 'unsure', why: `some of the acts it names are credited beside it (${e.tracks.some} track(s), ${e.releases.some} release(s))${tail}` };
	return { class: 'unsure', why: `nothing in the catalogue says one act or several${tail}` };
}

function commonest(names: string[]): string {
	const by = new Map<string, { name: string; n: number }>();
	for (const n of names) {
		const k = nameFold(n);
		const e = by.get(k);
		if (e) e.n++;
		else by.set(k, { name: n, n: 1 });
	}
	return [...by.values()].sort((a, b) => b.n - a.n)[0]!.name;
}

const uuids = (ids: string[]) => `{${ids.join(',')}}`;
// nameFold leaves letters, digits and single spaces: nothing to escape.
const texts = (folds: string[]) => `{${folds.map((f) => `"${f}"`).join(',')}}`;

type Beside = { id: string; folds: string };

async function readPage(tx: Queryable, after: string | null, limit: number): Promise<{ scanned: { id: string; name: string }[]; evidence: Map<string, CompoundEvidence>; credits: Map<string, { tracks: number; releases: number }> }> {
	const scanned = await tx.query<{ id: string; name: string }>(
		`select o.id, o.name from curator.catalog_object o
		where o.kind = 'artist' and o.merged_into is null and ${JOINER_SQL} and ($1::uuid is null or o.id > $1::uuid)
		order by o.id limit $2::int`,
		[after, String(limit)],
	);
	const cands = scanned.filter((c) => piecesOf(c.name).length >= 2);
	const evidence = new Map<string, CompoundEvidence>();
	const credits = new Map<string, { tracks: number; releases: number }>();
	if (!cands.length) return { scanned, evidence, credits };
	const ids = uuids(cands.map((c) => c.id));
	const pieces = new Map(cands.map((c) => [c.id, piecesOf(c.name)]));
	const pieceFolds = texts([...new Set([...pieces.values()].flat())]);
	for (const c of cands) {
		evidence.set(c.id, { name: c.name, pages: [], tracks: { all: 0, some: 0 }, releases: { all: 0, some: 0 }, actTwin: false, tokens: [], credited: 0 });
		credits.set(c.id, { tracks: 0, releases: 0 });
	}

	const pages = await tx.query<{ id: string; provider: string; provider_id: string; name: string | null; weak: boolean }>(
		`select s.object_id as id, s.provider, s.provider_id, s.payload->>'name' as name, ${WEAK_SQL} as weak
		from curator.catalog_source_object s where s.kind = 'artist' and s.object_id = any($1::uuid[])`,
		[ids],
	);
	for (const p of pages) evidence.get(p.id)!.pages.push({ provider: p.provider, providerId: p.provider_id, name: p.name, weak: p.weak === true });

	// Which of the acts a name lists are credited beside it, per track and per
	// release: only the artists of those names are read, so a compilation's
	// seventy credits cost nothing. Only artists a store holds count: the old
	// SoundCloud splitter left "Drumsound" and "Bassline Smith" beside the trio
	// of that name, known by name alone (repair-credits.ts undoes those).
	const onTracks = await tx.query<Beside>(
		`select e.dst as id, string_agg(distinct a.name_fold, E'\\n') as folds
		from curator.catalog_edge e
		join curator.catalog_edge co on co.src = e.src and co.kind = 'recording-artist' and co.dst <> e.dst
		join curator.catalog_object a on a.id = co.dst and a.merged_into is null and a.name_fold = any($2::text[])
			and exists (select 1 from curator.catalog_source_object s where s.object_id = a.id and not ${WEAK_SQL})
		where e.kind = 'recording-artist' and e.dst = any($1::uuid[])
		group by e.dst, e.src`,
		[ids, pieceFolds],
	);
	const onReleases = await tx.query<Beside>(
		`select e.src as id, string_agg(distinct a.name_fold, E'\\n') as folds
		from curator.catalog_edge e
		join curator.catalog_edge co on co.dst = e.dst and co.kind = 'artist-release' and co.src <> e.src
		join curator.catalog_object a on a.id = co.src and a.merged_into is null and a.name_fold = any($2::text[])
			and exists (select 1 from curator.catalog_source_object s where s.object_id = a.id and not ${WEAK_SQL})
		where e.kind = 'artist-release' and e.src = any($1::uuid[])
		group by e.src, e.dst`,
		[ids, pieceFolds],
	);
	const tally = (rows: Beside[], into: 'tracks' | 'releases') => {
		for (const r of rows) {
			const mine = pieces.get(r.id)!;
			const beside = new Set(r.folds.split('\n'));
			const found = mine.filter((p) => beside.has(p)).length;
			if (!found) continue;
			evidence.get(r.id)![into][found === mine.length ? 'all' : 'some']++;
		}
	};
	tally(onTracks, 'tracks');
	tally(onReleases, 'releases');

	for (const r of await tx.query<{ id: string; n: unknown }>(`select dst as id, count(*) as n from curator.catalog_edge where kind = 'recording-artist' and dst = any($1::uuid[]) group by dst`, [ids])) credits.get(r.id)!.tracks = num(r.n);
	for (const r of await tx.query<{ id: string; n: unknown }>(`select src as id, count(*) as n from curator.catalog_edge where kind = 'artist-release' and src = any($1::uuid[]) group by src`, [ids])) credits.get(r.id)!.releases = num(r.n);

	// A reader's or the library's copy of an act ("Stil & Bense" known by name
	// only) beside the store's own object of that name, not yet joined.
	const twins = await tx.query<{ fold: string; name: string | null }>(
		`select o.name_fold as fold, s.payload->>'name' as name
		from curator.catalog_object o
		join curator.catalog_source_object s on s.object_id = o.id and s.kind = 'artist' and s.provider = any($2::text[]) and not ${WEAK_SQL}
		where o.kind = 'artist' and o.merged_into is null and o.name_fold = any($1::text[])`,
		[texts([...new Set(cands.map((c) => nameFold(c.name)))]), texts([...ACT_STORES])],
	);
	const acts = new Set(twins.filter((t) => nameFold(t.name) === t.fold).map((t) => t.fold));
	for (const c of cands) if (acts.has(nameFold(c.name))) evidence.get(c.id)!.actTwin = true;

	// Each listed name as an artist of its own, anywhere in the catalogue. A
	// Spotify or Beatport page counts as such only under that very name: a
	// page a credit line renamed vouches for nothing.
	const known = await tx.query<{ fold: string; provider: string | null; name: string | null; weak: boolean | null }>(
		`select o.name_fold as fold, s.provider, s.payload->>'name' as name, ${WEAK_SQL} as weak
		from curator.catalog_object o
		left join curator.catalog_source_object s on s.object_id = o.id and s.kind = 'artist'
		where o.kind = 'artist' and o.merged_into is null and o.name_fold = any($1::text[])`,
		[pieceFolds],
	);
	const level = new Map<string, number>();
	for (const k of known) {
		const l = !k.provider || k.weak === true ? 1 : ACT_STORES.has(k.provider) && nameFold(k.name) === k.fold ? 3 : 2;
		level.set(k.fold, Math.max(level.get(k.fold) ?? 0, l));
	}
	const answers = await nameAnswers(tx, [...new Set(cands.map((c) => nameFold(c.name)))]);
	for (const c of cands) {
		const e = evidence.get(c.id)!;
		e.credited = credits.get(c.id)!.tracks + credits.get(c.id)!.releases;
		e.tokens = pieces.get(c.id)!.map((p) => level.get(p) ?? 0);
		const asked = answers.get(nameFold(c.name));
		if (asked) e.asked = asked;
	}

	return { scanned, evidence, credits };
}

export type CompoundOptions = {
	after?: string | null;
	limit?: number;
	// Apple's own name for each id (one lookup for the page's Apple-only
	// candidates); without it they stay `apple_line` with no `to`.
	appleNames?: (ids: string[]) => Promise<Map<string, string>>;
};

export async function compoundArtists(db: Db, opts: CompoundOptions = {}): Promise<CompoundReport> {
	const limit = Math.max(1, Math.min(opts.limit ?? COMPOUND_PAGE, 2000));
	const { scanned, evidence, credits } = await withSystemTx(db, (tx) => readPage(tx, opts.after ?? null, limit));

	// The network after the transaction, never inside it.
	let appleAsked = 0;
	if (opts.appleNames) {
		const ask = new Map<string, string>();
		for (const [id, e] of evidence) {
			const strong = e.pages.filter((p) => !p.weak && p.name);
			if (!strong.length || !strong.every((p) => p.provider === 'apple')) continue;
			ask.set(id, strong[0]!.providerId);
		}
		if (ask.size) {
			const names = await opts.appleNames([...new Set(ask.values())]);
			appleAsked = ask.size;
			for (const [id, appleId] of ask) evidence.get(id)!.appleName = names.get(appleId) ?? null;
		}
	}

	const rows: CompoundRow[] = [];
	for (const [id, e] of evidence) {
		const c = classifyCompound(e);
		rows.push({
			id,
			name: e.name,
			class: c.class,
			...decideCompound(e.name, c),
			...(c.to ? { to: c.to } : {}),
			why: c.why,
			pieces: piecesOf(e.name),
			tokens: e.tokens,
			asked: NAME_SOURCES.filter((s) => e.asked?.[s] !== undefined),
			pages: e.pages.map((p) => `${p.provider}:${p.providerId}`),
			credits: credits.get(id)!,
		});
	}
	return { candidates: rows.length, rows, appleAsked, next: scanned.length === limit ? scanned[scanned.length - 1]!.id : null };
}
