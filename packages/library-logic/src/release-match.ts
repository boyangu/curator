// Whether two stores' pages are the same release, read off their tracklists:
// the one comparison every side makes — a device finding a release at another
// store (the feed's lazy Spotify match, the page work engine) and the cloud
// checking that find before it links the two (apps/cloud catalog/work). A
// title and a name are never enough on their own: stores word mix tags
// differently and namesakes share titles, so a match stands on the tracks.
//
// Two strengths. The device's is lenient: a store that gives no length still
// pairs by title, and equal-length lists pair their leftovers by position —
// it is looking, and the cloud will check. The cloud's is strict: a pair
// needs an ISRC both sides state, or the same title with both lengths known
// and close; nothing pairs by position. What the strict pairing refuses stays
// two releases for the duplicate detector, which a person can overrule.

import { normalizeIsrc } from './isrc.js';
import { nameFold } from './name-fold.js';

// Tracklist confirmation: title and length agree for at least this share.
export const CONFIRM_SHARE = 0.5;
export const DURATION_TOLERANCE_SEC = 5;
// One recording's two masters differ more than two cuts of one title do.
export const ISRC_DURATION_TOLERANCE_SEC = 10;

export type MatchTrack = { title: string; durationSec?: number | null; isrc?: string | null };

// Titles across stores differ by their mix tags ("Original Mix", "[LABEL]"):
// folded without them, with the fold the catalogue uses.
export function titleKey(title: string): string {
	return nameFold(
		title
			.replace(/\s*[[(]\s*original\s+mix\s*[\])]/gi, '')
			.replace(/\s+-\s+original\s+mix\s*$/i, '')
			.replace(/\s*\[[^\]]*\]\s*$/g, ''),
	);
}

const known = (sec: number | null | undefined): sec is number => sec != null && sec > 0;

// Lengths agree; an unknown length agrees with anything.
export const closeSec = (a: number | null | undefined, b: number | null | undefined, tol: number): boolean => !known(a) || !known(b) || Math.abs(a - b) <= tol;

// Lengths agree and both are stated.
const bothClose = (a: number | null | undefined, b: number | null | undefined, tol: number): boolean => known(a) && known(b) && Math.abs(a - b) <= tol;

// One of our credited acts is among theirs. "Various Artists", or no credit
// at all, rules nothing out.
export function artistsOverlap(ours: readonly string[], theirs: readonly { name: string }[]): boolean {
	const folds = new Set(ours.map(nameFold).filter(Boolean));
	if (!folds.size || folds.has(nameFold('Various Artists'))) return true;
	return theirs.some((a) => folds.has(nameFold(a.name)));
}

export type PairOptions = { strict?: boolean };

// Our tracks paired with theirs. Null when fewer than half of ours found
// their track: the tracklist does not confirm.
export function pairTracklists<A extends MatchTrack, B extends MatchTrack>(ours: readonly A[], theirs: readonly B[], opts: PairOptions = {}): Map<A, B> | null {
	if (!ours.length || !theirs.length) return null;
	const strict = opts.strict ?? false;
	const pairs = new Map<A, B>();
	const taken = new Set<B>();
	const take = (r: A, t: B | undefined): void => {
		if (!t) return;
		pairs.set(r, t);
		taken.add(t);
	};
	if (strict) {
		// The code both stores state names the recording whatever its title says.
		for (const r of ours) {
			const code = normalizeIsrc(r.isrc);
			if (code) take(r, theirs.find((t) => !taken.has(t) && normalizeIsrc(t.isrc) === code && closeSec(r.durationSec, t.durationSec, ISRC_DURATION_TOLERANCE_SEC)));
		}
	}
	for (const r of ours) {
		if (pairs.has(r)) continue;
		const key = titleKey(r.title);
		const agrees = strict ? bothClose : closeSec;
		take(r, theirs.find((t) => !taken.has(t) && titleKey(t.title) === key && agrees(r.durationSec, t.durationSec, DURATION_TOLERANCE_SEC)));
	}
	if (pairs.size < Math.max(1, Math.ceil(ours.length * CONFIRM_SHARE))) return null;
	// The rest by position, when the lists are the same length.
	if (!strict && ours.length === theirs.length) {
		for (const [i, r] of ours.entries()) {
			const t = theirs[i]!;
			if (!pairs.has(r) && !taken.has(t) && closeSec(r.durationSec, t.durationSec, DURATION_TOLERANCE_SEC)) take(r, t);
		}
	}
	return pairs;
}

// The two tracklists are one release's: half of the LONGER list is paired. A
// single whose one track is also on a twenty-track compilation pairs all of
// its own tracks and is still not that compilation; an edition with a bonus
// track is still the release.
export function confirmRelease<A extends MatchTrack, B extends MatchTrack>(ours: readonly A[], theirs: readonly B[], opts: PairOptions = {}): Map<A, B> | null {
	const pairs = pairTracklists(ours, theirs, opts);
	if (!pairs) return null;
	return pairs.size >= Math.ceil(Math.max(ours.length, theirs.length) * CONFIRM_SHARE) ? pairs : null;
}

export const CLEAR_MIN_SHARED = 2;

// The one page that is an object's by what it lists: of a store's pages under
// the object's name, the one sharing two releases with it and at least twice
// as many as any other. Null when none stands out. `fold` is the caller's
// name fold (a store search drops a "(UK)" suffix the catalogue keeps).
export function clearMatch<C extends { name: string; shared?: readonly string[] }>(name: string, candidates: readonly C[], fold: (name: string) => string = nameFold): C | null {
	const want = fold(name);
	const ranked = candidates.filter((c) => fold(c.name) === want && (c.shared?.length ?? 0) > 0).sort((a, b) => b.shared!.length - a.shared!.length);
	const [top, next] = ranked;
	if (!top || top.shared!.length < CLEAR_MIN_SHARED) return null;
	return next && top.shared!.length < 2 * next.shared!.length ? null : top;
}

// Two listings are one label's: two titles in common (all of them, where one
// lists a single title), a quarter of the SHORTER listing, and a twentieth of
// the longer. The shorter, because stores carry different shares of a label —
// five of its releases on Bandcamp, forty on Beatport, are the same label,
// whichever of the two is being judged. The longer, because two titles alone
// let a bucket through: a page listing twenty times what the label has lists
// the label's releases beside everyone else's. Neither side is "the" label:
// the comparison reads the same either way round.
export const AGREE_MIN_SHARED = 2;
export const AGREE_MIN_RATIO = 0.25;
export const AGREE_MIN_OF_LONGER = 0.05;
export function listingsAgree(aTitles: readonly string[], bTitles: readonly string[]): { agrees: boolean; shared: number } {
	const a = new Set(aTitles.map(titleKey).filter(Boolean));
	const b = new Set(bTitles.map(titleKey).filter(Boolean));
	const [shorter, longer] = a.size <= b.size ? [a, b] : [b, a];
	const shared = [...shorter].filter((k) => longer.has(k)).length;
	const agrees = shorter.size > 0 && shared >= Math.min(AGREE_MIN_SHARED, shorter.size) && shared / shorter.size >= AGREE_MIN_RATIO && shared / longer.size >= AGREE_MIN_OF_LONGER;
	return { agrees, shared };
}
