// Rekordbox's "Add MyTag to Comments" mirror. With that preference on,
// rekordbox keeps a token block at the END of DjmdContent.Commnt so its text
// search (which reads Comment, not DjmdSongMyTag) finds tagged tracks:
//
//     <user comment> /* tag1 / tag2 / tag3 */
//     e.g.  ' /* ! / p1 / b1 / piano+ / melodic / dreamy / warm / sunset */'
//           'Purchased at Beatport.com /* p3 / ! / b0 / house */'
//
// Tokens are the MyTag names in the order the tags were added (not sorted).
// rekordbox only regenerates the block when tags change INSIDE rekordbox, so
// a tag added/removed/renamed in Curator and pushed as DjmdSongMyTag rows
// leaves the block stale — the track then shows in rekordbox's MyTag filter
// but not in its search box (diagnosed 2026-09-10 on a 950-track "sunset"
// tag: every track missing from search had been tagged in Curator).
//
// The exporter derives the pushed Comment from Curator's tag set with these
// helpers. Pure string functions; the tag set is the caller's concern (only
// rb-identity tags belong here — see buildWriteOps).

const BLOCK_RE = /^(.*?)\s*\/\*\s*(.*?)\s*\*\/\s*$/s;
const SEP = ' / ';

export interface ParsedTagComment {
	// The user's own comment text, without the block (trailing whitespace
	// trimmed). '' when the comment is block-only or empty.
	prefix: string;
	// Tokens inside the block, or null when the comment carries no block.
	tokens: string[] | null;
}

export function parseTagComment(comment: string | null | undefined): ParsedTagComment {
	const s = comment ?? '';
	const m = BLOCK_RE.exec(s);
	if (!m) return { prefix: s.trimEnd(), tokens: null };
	const tokens = m[2]!.split(SEP).map((t) => t.trim()).filter((t) => t.length > 0);
	return { prefix: m[1]!.trimEnd(), tokens };
}

// Rebuild the comment so its block lists exactly `tagNames`.
//   - Empty `tagNames` returns the input untouched: an empty rb-tag set on
//     the Curator side means "not managed here", never "clear rekordbox's
//     block" (same rule as the exporter's tags-op skip).
//   - Tokens already in the block keep their position; new tags append in
//     the order given (callers pass track_tag.added_at order). That mirrors
//     rekordbox's own append behaviour, so a pull→push round-trip is
//     byte-stable and produces no write.
//   - Always exactly one space before `/*`, matching rekordbox's output
//     (3,941 of 3,984 real rows; the rest are hand-edited comments).
export function buildTagComment(existing: string | null | undefined, tagNames: readonly string[]): string | null {
	if (tagNames.length === 0) return existing ?? null;
	const { prefix, tokens } = parseTagComment(existing);
	const want = new Set(tagNames);
	const ordered: string[] = [];
	const seen = new Set<string>();
	for (const t of tokens ?? []) {
		if (want.has(t) && !seen.has(t)) { ordered.push(t); seen.add(t); }
	}
	for (const t of tagNames) {
		if (!seen.has(t)) { ordered.push(t); seen.add(t); }
	}
	return `${prefix} /* ${ordered.join(SEP)} */`;
}

// True when the block already lists exactly `tagNames` (order-insensitive):
// the cheap "is this track's comment stale?" probe the updates sweep uses.
export function tagCommentMatches(existing: string | null | undefined, tagNames: readonly string[]): boolean {
	if (tagNames.length === 0) return true;
	const { tokens } = parseTagComment(existing);
	if (!tokens) return false;
	if (tokens.length !== new Set(tokens).size) return false;
	const want = new Set(tagNames);
	return tokens.length === want.size && tokens.every((t) => want.has(t));
}
