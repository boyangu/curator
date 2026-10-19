// Version annotation of a track title, the identity check that keeps two mixes
// of one title apart. The streaming dedup (core's match-existing) vetoes a
// title+artist+duration match whose versions differ — "More" (Fink, 557s)
// once bound onto "More - Klangkarussell Extended Remix" (555s) — and the
// catalogue resolver needs the same answer for the same titles.

import { sharedScorer } from '@curator/matcher';

// Featured-artist parentheticals are credits, not versions — "Foo (feat. X)"
// and "Foo" are the same recording.
const FEAT_RE = /\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^)\]]*[\)\]]/gi;
// Leftmost " - " wins so a hyphenated version ("- Re-Edit") stays whole and a
// "Foo - Bar (Extended Mix)" / "Foo - Bar - Extended Mix" pair both normalize to
// "bar extended mix".
const TRAILING_VERSION_RE = /(?:\s+-\s+(.+)|\s*[\(\[]([^)\]]+)[\)\]])\s*$/;

// The trailing mix/version annotation, normalized; '' for none. "Original
// Mix" counts as none (baseTitle strips it), and "Foo - Radio Edit" /
// "Foo (Radio Edit)" yield the same 'radio edit'.
export function versionOf(title: string): string {
	const base = sharedScorer.baseTitle(title.replace(FEAT_RE, ''));
	const m = base.match(TRAILING_VERSION_RE);
	return m ? sharedScorer.normalize(m[1] ?? m[2]) : '';
}
