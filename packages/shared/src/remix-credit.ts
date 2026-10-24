// Remixer credits from the TITLE. Release names carry the remixer in their
// own words — "(X Remix)", "Title - X Extended Remix", "(X's Late Night
// Mix)" — and the title is never rewritten: it is the release name. What
// this module does is read that segment and turn it into an artist credit
// with role 'remixer', so the remixer is navigable like any other artist.
//
// Precision over recall (rules tuned on the live library, 2026-09-21,
// 5,239 titles with a remix-shaped segment):
//   • The credited name is resolved against what the library KNOWS —
//     the track's own credits (Spotify lists remixers as plain artists;
//     they just get the role) and the artist table. A known name inside
//     a longer segment is a named remix ("Ae:ther Dreaming Dub Remix" →
//     Ae:ther); a possessive names the owner ("Milio's 7am Dub Mix").
//   • Unknown names are accepted only after a STRONG remix word (remix,
//     rmx, rework, remake, bootleg, refix, flip, reshape, reboot,
//     rethink) and only when short (≤ 3 words) with no generic word.
//     Weak words (mix, edit, version, dub, vip, interpretation,
//     treatment) never mint an artist on their own — "Cercle Version",
//     "Neon Mix", "Japanese Version" would all be wrong.
//   • "A & B Remix" splits into two remixers only when BOTH sides are
//     known; otherwise the duo rule holds and it stays one name.
//   • A remixer that is also a main credit (self-remix) is left alone.

import { searchFold } from './search.js';
import { stripFormatTag } from './format-tag.js';
import type { TrackArtist } from './schema.js';

const STRONG = 'remix|rmx|re-mix|remake|rework|re-work|reworked|bootleg|refix|flip|reshape|reboot|rethink';
const WEAK = 'edit|re-edit|version|mix|dub|vip|interpretation|treatment|e-mix';
const TYPE_END_RE = new RegExp(`\\s*\\b(${STRONG}|${WEAK})\\s*$`, 'i');
const STRONG_END_RE = new RegExp(`\\b(${STRONG})\\s*$`, 'i');
const DASH_TAIL_RE = /\s-\s([^-]+)$/;

// Words that describe a mix rather than name an artist. Stripped from the
// tail of a candidate; a candidate made only of these is no artist.
const GENERIC = new Set((
	'original extended club radio vocal instrumental dub vip deep short long full alt alternative acoustic piano ' +
	'ambient beatless bonus live edit version main album single re remastered remaster stripped slow fast night late ' +
	'early chill dance dj tool intro outro festival clean dirty explicit uncut unreleased mono stereo demo cut part pt ' +
	'vol the a an of and in on at to for with by from mix remix rmx rework remake bootleg flip refix interpretation ' +
	'treatment reshape reboot rethink drum bass breaks beats techno house disco tech dubstep trance downtempo chillout ' +
	'lounge sunset sunrise beach morning afternoon evening midnight dawn dusk summer winter spring autumn hard soft big ' +
	'room special exclusive limited ep lp japanese english german french spanish italian streaming am pm raw dark light ' +
	'afro latin tribal organic melodic progressive minimal deeper harder softer slower faster'
).split(/\s+/));

export interface RemixCreditOptions {
	// "Does the library know this fold as an artist?" — the artist table.
	known?: (fold: string) => boolean;
	// The track's own credits: names here are known by definition.
	credits?: readonly TrackArtist[];
}

// Possessive apostrophes as titles actually spell them: ' ’ ‘ ´ `
const POSS_S_RE = /[’'‘´`]s$/;
const POSS_OWNER_RE = /^(.+?)[’'‘´`]s\b/;
const isGeneric = (w: string): boolean => GENERIC.has(w.toLowerCase().replace(POSS_S_RE, '')) || /^\d{2,4}$/.test(w);

// Every balanced bracket pair of a title, as [start, end) spans in order of
// start (an outer pair before the pairs inside it). Found with a stack, so
// an unclosed "(" leaves the pairs after it standing; a stray closer is text.
function bracketPairs(title: string): Array<{ start: number; end: number }> {
	const pairs: Array<{ start: number; end: number }> = [];
	const open: Array<{ ch: string; at: number }> = [];
	for (let i = 0; i < title.length; i++) {
		const ch = title[i]!;
		if (ch === '(' || ch === '[') { open.push({ ch, at: i }); continue; }
		if (ch !== ')' && ch !== ']') continue;
		const want = ch === ')' ? '(' : '[';
		let k = open.length - 1;
		while (k >= 0 && open[k]!.ch !== want) k--;
		if (k < 0) continue;
		pairs.push({ start: open[k]!.at, end: i + 1 });
		open.length = k;
	}
	return pairs.sort((a, b) => a.start - b.start);
}

// The bracket groups `accept` takes, outermost first: "(A, B (NL) Remix)"
// is ONE group — an innermost-group match only ever saw "(NL)" and
// appended both remixers again on every push. A group it does not take is
// searched for one inside it ("(Night Set (X Dub Mix))"), and a group's
// redundant wrapping brackets are not its text ("((X remix))" → "X remix").
function bracketGroups(title: string, accept: (text: string) => boolean): Array<{ start: number; end: number; text: string }> {
	const out: Array<{ start: number; end: number; text: string }> = [];
	for (const p of bracketPairs(title)) {
		if (out.some((g) => p.start >= g.start && p.end <= g.end)) continue;
		let text = title.slice(p.start + 1, p.end - 1).trim();
		while (bracketPairs(text).some((q) => q.start === 0 && q.end === text.length)) text = text.slice(1, -1).trim();
		if (accept(text)) out.push({ ...p, text });
	}
	return out;
}

// Remix-shaped segments of a title: every bracketed group plus a trailing
// " - X" tail (Spotify's "Title - X Remix"), kept only when they end with
// a mix-type word. Returns [segment, strong?].
function remixSegments(title: string): Array<{ seg: string; strong: boolean }> {
	const out: Array<{ seg: string; strong: boolean }> = [];
	const segs: string[] = bracketGroups(title, (text) => TYPE_END_RE.test(text)).map((g) => g.text);
	const tail = title.match(DASH_TAIL_RE);
	if (tail) segs.push(tail[1]!.trim());
	for (const seg of segs) {
		if (!TYPE_END_RE.test(seg)) continue;
		out.push({ seg, strong: STRONG_END_RE.test(seg) });
	}
	return out;
}

// Strip the mix-type word and trailing generic words: "Solee Extended
// Remix" → "Solee", "Luca Bacchetti Endless Remix" → "Luca Bacchetti
// Endless" (the named-remix remainder is resolved by resolveName).
function coreOf(seg: string): string {
	let core = seg.replace(TYPE_END_RE, '').trim();
	// Repeat: "X Extended Club Mix" → "X Extended Club" → "X".
	for (;;) {
		const words = core.split(/\s+/);
		if (words.length === 0 || !isGeneric(words[words.length - 1]!)) break;
		words.pop();
		core = words.join(' ');
	}
	return core.replace(POSS_S_RE, '').trim();
}

// Resolve a candidate to an artist name the library can vouch for, or —
// after a strong word — accept a short unknown one. Returns [] when the
// candidate is generic or unresolvable.
function resolveName(candidate: string, strong: boolean, isKnown: (fold: string) => boolean): string[] {
	const c = candidate.trim();
	if (!c || !/\p{L}/u.test(c)) return [];
	const fold = searchFold(c);
	if (isKnown(fold)) return [c];
	// Titles write disambiguators bare — "Ivory IT Remix" — where the
	// library spells the artist "Ivory (IT)". Prefer the library's spelling.
	const tagged = c.match(/^(.+?)\s+([A-Za-z]{2,3})$/);
	if (tagged && isKnown(searchFold(`${tagged[1]} (${tagged[2]})`))) return [`${tagged[1]} (${tagged[2]})`];
	// Possessive owner: "Milio's 7am" → Milio.
	const poss = c.match(POSS_OWNER_RE);
	if (poss && poss[1]!.trim()) {
		const owner = poss[1]!.trim();
		if (isKnown(searchFold(owner))) return [owner];
	}
	// Two known artists joined by &/+/x/vs — a collaboration remix, not a duo.
	const pair = c.split(/\s+(?:&|\+|x|X|vs\.?)\s+/);
	if (pair.length === 2 && isKnown(searchFold(pair[0]!)) && isKnown(searchFold(pair[1]!))) return [pair[0]!.trim(), pair[1]!.trim()];
	// Longest known word-prefix — the rest is the remix's own name.
	const words = c.split(/\s+/);
	for (let k = words.length - 1; k >= 1; k--) {
		const head = words.slice(0, k).join(' ');
		if (isKnown(searchFold(head))) return [head];
	}
	if (!strong) return [];
	if (poss) return [];
	if (words.length > 3 || words.some(isGeneric)) return [];
	return [c];
}

// Display form of a title whose track carries remixer credits: the
// release's remix segment(s) — "(X Remix)", "Title - X Extended Remix",
// "[X Dub]" — are lifted out and re-attached in the chosen style,
// wording intact: "Feel Me (JAMIEE Remix)" or "Feel Me - JAMIEE Remix".
// A segment is lifted only when it names one of the track's remixers, so a
// stray "(Original Mix)" stays where the release put it. A remixer credit
// with no matching segment (credited by hand) gets "<name> Remix". The
// stored title is never touched — Settings → User Interface picks the
// style; see artist-credit.ts ArtistCreditFormat.
//
// It is a fixed point: formatting its own output again gives the same
// string, and no remixer is named by two segments. rekordbox holds what was
// pushed and a first link can pull it back as the title, so anything else
// grows the title by a segment on every push (e2e 2026-10-24: "T (A, B (NL)
// Remix)" held in rekordbox as "T (A, B (NL) Remix) (B (NL) Remix)", pushed
// back as that plus "(A Remix) (B (NL) Remix)").
export function formatTrackTitle(title: string, artists: readonly TrackArtist[] | null | undefined, style: 'parenthesis' | 'dash'): string {
	// A converted copy's "[WAV]" tag stays last — lifting the remix segment
	// would otherwise re-attach it after the tag ("Song [WAV] (X Remix)").
	const { base: untagged, tag } = stripFormatTag(title);
	if (tag) return formatTrackTitle(untagged, artists, style) + tag;
	const keyOf = (s: string): string => searchFold(s).replace(/[^\p{L}\p{N}&]/gu, '');
	// One credit per remixer, however often the list repeats it.
	const remixers: string[] = [];
	const keys: string[] = [];
	for (const a of artists ?? []) {
		if (a?.role !== 'remixer' || !a.name) continue;
		const k = keyOf(a.name);
		if (!k || keys.includes(k)) continue;
		remixers.push(a.name);
		keys.push(k);
	}
	if (remixers.length === 0 || !title) return title;
	// A collaboration segment names each of its remixers: "Adam Ten & Rafael
	// Remix" mentions Adam Ten AND Rafael, "A, B (NL) Remix" both of its
	// names. The whole core stays a candidate for a duo credited as one
	// remixer.
	const partsOf = (core: string): string[] => [core, ...core.split(/\s*[,;&+]\s*|\s+(?:x|vs\.?)\s+/i)].map(keyOf).filter(Boolean);
	// The remixers a segment names, as indices into `remixers`. Read from the
	// core with its generic tail words stripped and with only the mix-type
	// word stripped: a remixer whose name ends in generic words ("Sunset
	// Dub") strips to nothing, and would be appended again on every format.
	const namedBy = (seg: string): Set<number> => {
		const parts = [...partsOf(coreOf(seg)), ...partsOf(seg.replace(TYPE_END_RE, '').trim())];
		const out = new Set<number>();
		keys.forEach((r, i) => { if (parts.some((k) => k.startsWith(r) || r.startsWith(k))) out.add(i); });
		return out;
	};
	type Span = { start: number; end: number; text: string; named: Set<number> };
	const spans: Span[] = [];
	for (const g of bracketGroups(title, (text) => TYPE_END_RE.test(text) && namedBy(text).size > 0)) spans.push({ ...g, named: namedBy(g.text) });
	// " - X Remix" parts: each spaced dash outside a bracket group starts one,
	// running to the next such dash or the end — the dash style's own output
	// ("T - A Remix - B Remix") reads back as both parts, and a hyphenated
	// name ("Jean-Michel") never splits one. A lifted group inside a part is
	// not part of its text.
	const inSpan = (i: number, list: ReadonlyArray<{ start: number; end: number }>): boolean => list.some((s) => i >= s.start && i < s.end);
	const liftedGroups = [...spans];
	const pairs = bracketPairs(title);
	const dashes = [...title.matchAll(/\s-\s/g)].filter((m) => !inSpan(m.index!, pairs));
	dashes.forEach((m, d) => {
		const start = m.index!;
		const end = d + 1 < dashes.length ? dashes[d + 1]!.index! : title.length;
		let text = '';
		for (let i = start + m[0].length; i < end; i++) text += inSpan(i, liftedGroups) ? ' ' : title[i];
		text = text.replace(/\s+/g, ' ').trim();
		if (!TYPE_END_RE.test(text)) return;
		const named = namedBy(text);
		if (named.size > 0) spans.push({ start, end, text, named });
	});
	spans.sort((a, b) => a.start - b.start);
	// One segment per remixer: a segment whose remixers another one already
	// names is lifted and dropped — the copies earlier pushes appended. The
	// list naming more is kept; of two naming the same, the first.
	const within = (a: Set<number>, b: Set<number>): boolean => [...a].every((i) => b.has(i));
	const kept = spans.filter((s, i) => !spans.some((o, j) => j !== i && within(s.named, o.named) && (o.named.size > s.named.size || j < i)));
	let base = '';
	for (let i = 0; i < title.length; i++) if (!inSpan(i, spans)) base += title[i];
	// An empty "()" is what an earlier formatter left of "((X Remix))"; a
	// segment lifted from inside a group leaves a space before its closer.
	base = base.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s+([)\]])/g, '$1').replace(/\s{2,}/g, ' ').trim();
	// Nothing but remix segments: there is no title to attach them to.
	if (!base) return title;
	const segs = kept.map((s) => s.text);
	// Remixers the title never mentioned still get their credit.
	const mentioned = new Set(kept.flatMap((s) => [...s.named]));
	remixers.forEach((r, i) => { if (!mentioned.has(i)) segs.push(`${r} Remix`); });
	// A segment holding a spaced dash of its own ("X Remix - Extended
	// Version") stays bracketed in the dash style: as a dash part it would
	// read back as two.
	const wrapped = segs.map((s) => (style === 'dash' && !/\s-\s/.test(s) ? ` - ${s}` : ` (${s})`)).join('');
	return base + wrapped;
}

export function extractRemixers(title: string, opts: RemixCreditOptions = {}): string[] {
	const creditFolds = new Set((opts.credits ?? []).map((a) => searchFold(a.name)));
	const isKnown = (fold: string): boolean => creditFolds.has(fold) || (opts.known?.(fold) ?? false);
	const out: string[] = [];
	const seen = new Set<string>();
	for (const { seg, strong } of remixSegments(title)) {
		const core = coreOf(seg);
		if (!core) continue;
		// "A, B Remix" — a plain list of remixers.
		for (const part of core.split(/\s*[,;]\s*/)) {
			for (const name of resolveName(part, strong, isKnown)) {
				const f = searchFold(name);
				if (!f || seen.has(f)) continue;
				seen.add(f);
				out.push(name);
			}
		}
	}
	return out;
}

// Apply the title's remixers to a credit list: tag matching credits with
// role 'remixer', append the missing ones. Main credits are never demoted
// (a self-remix stays main). Returns the SAME instance when nothing
// changes.
export function applyRemixers(list: readonly TrackArtist[], title: string | null | undefined, opts: RemixCreditOptions = {}): TrackArtist[] {
	if (!title) return list as TrackArtist[];
	const remixers = extractRemixers(title, { ...opts, credits: list });
	if (remixers.length === 0) return list as TrackArtist[];
	const byFold = new Map(list.map((a, i) => [searchFold(a.name), i] as const));
	let changed = false;
	const out = list.map((a) => a);
	for (const name of remixers) {
		const f = searchFold(name);
		const i = byFold.get(f);
		if (i != null) {
			const a = out[i]!;
			// Only an undecided or featured credit becomes the remixer; a
			// credit the list already calls main (explicit) stays main.
			if (a.role === 'main') continue;
			if (a.role !== 'remixer') { out[i] = { name: a.name, role: 'remixer' }; changed = true; }
			continue;
		}
		out.push({ name, role: 'remixer' });
		changed = true;
	}
	if (!changed) return list as TrackArtist[];
	// Whoever is left without a role is the release's main credit; when the
	// ONLY credits turned out to be remixers (self-remix spelled once) undo.
	if (!out.some((a) => a.role !== 'remixer' && a.role !== 'featured')) return list as TrackArtist[];
	return out;
}
