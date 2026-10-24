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
const SEG_RE = /[([]([^()[\]]*)[)\]]/g;
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

// Remix-shaped segments of a title: every bracketed group plus a trailing
// " - X" tail (Spotify's "Title - X Remix"), kept only when they end with
// a mix-type word. Returns [segment, strong?].
function remixSegments(title: string): Array<{ seg: string; strong: boolean }> {
	const out: Array<{ seg: string; strong: boolean }> = [];
	const segs: string[] = [];
	for (const m of title.matchAll(SEG_RE)) segs.push(m[1]!.trim());
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
export function formatTrackTitle(title: string, artists: readonly TrackArtist[] | null | undefined, style: 'parenthesis' | 'dash'): string {
	// A converted copy's "[WAV]" tag stays last — lifting the remix segment
	// would otherwise re-attach it after the tag ("Song [WAV] (X Remix)").
	const { base: untagged, tag } = stripFormatTag(title);
	if (tag) return formatTrackTitle(untagged, artists, style) + tag;
	const remixers = (artists ?? []).filter((a) => a?.role === 'remixer' && a.name).map((a) => a.name);
	if (remixers.length === 0 || !title) return title;
	const keyOf = (s: string): string => searchFold(s).replace(/[^\p{L}\p{N}&]/gu, '');
	const keys = remixers.map(keyOf);
	// A collaboration segment names each of its remixers: "Adam Ten & Rafael
	// Remix" mentions Adam Ten AND Rafael. Comparing only the whole core
	// matched the first name and appended "(Rafael Remix)" for the second —
	// the doubled titles the e2e run found in rekordbox (2026-10-24). The
	// whole core stays a candidate for a duo credited as one remixer.
	const partsOf = (core: string): string[] => [core, ...core.split(/\s*[,;&+]\s*|\s+(?:x|vs\.?)\s+/i)].map(keyOf).filter(Boolean);
	const named = (k: string): boolean => keys.some((r) => k.startsWith(r) || r.startsWith(k));
	const names = (core: string): boolean => partsOf(core).some(named);
	// Spans to lift: bracket groups + the " - X" tail, each ending with a
	// mix-type word and naming a remixer.
	const spans: Array<{ start: number; end: number; text: string }> = [];
	for (const m of title.matchAll(SEG_RE)) {
		const seg = m[1]!.trim();
		if (TYPE_END_RE.test(seg) && names(coreOf(seg))) spans.push({ start: m.index!, end: m.index! + m[0].length, text: seg });
	}
	const tail = title.match(DASH_TAIL_RE);
	if (tail && tail.index != null) {
		const seg = tail[1]!.trim();
		if (TYPE_END_RE.test(seg) && names(coreOf(seg)) && !spans.some((s) => s.start >= tail.index!)) spans.push({ start: tail.index, end: tail.index + tail[0].length, text: seg });
	}
	let base = title;
	for (const s of [...spans].sort((a, b) => b.start - a.start)) base = base.slice(0, s.start) + base.slice(s.end);
	base = base.replace(/\s{2,}/g, ' ').trim();
	const segs = spans.sort((a, b) => a.start - b.start).map((s) => s.text);
	// Remixers the title never mentioned still get their credit.
	const mentioned = segs.flatMap((s) => partsOf(coreOf(s)));
	for (const r of remixers) {
		const k = keyOf(r);
		if (!mentioned.some((m) => m.startsWith(k) || k.startsWith(m))) segs.push(`${r} Remix`);
	}
	if (segs.length === 0) return title;
	const wrapped = style === 'dash' ? segs.map((s) => ` - ${s}`).join('') : segs.map((s) => ` (${s})`).join('');
	return (base || title) + wrapped;
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
