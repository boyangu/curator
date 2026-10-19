// The ONE artist-credit splitter. Every path that turns a packed credit
// string ("Rampa, Adam Port, &ME", "A; B feat. C") into TrackArtist[] goes
// through here: rekordbox pull, local-tag fallback, the edit modal / MCP
// token input, KB seeding, the seed script and the one-shot backfill.
// Before this file the repo had four splitters that disagreed on `&` and
// `feat.`, and the disagreement is exactly how "Yohan & David" became two
// artists in one place and "B feat. C" became one artist in another.
//
// Rules (decided against the live library, 2026-09-21):
//   • `,` and `;` separate. `/` separates only when whitespace-padded on
//     at least one side — "AC/DC" is a name, "Yusuf / Cat Stevens" is the
//     rare alias form we accept splitting.
//   • `feat.` / `featuring` / `ft.` (bare or inside parens/brackets) mark
//     every name after them as role 'featured'.
//   • `&`, `+`, ` x `, ` vs ` NEVER split. In the library they are duo
//     names far more often than separators (Stil & Bense, Sultan +
//     Shepard, &ME, Meese X Hell), and searchFold keeps `&` literal for
//     the same reason.
//   • A `protect` predicate can veto splitting for a whole element whose
//     fold is a known standalone artist — the escape hatch for names that
//     legitimately contain a separator ("Tyler, The Creator").
//
// The matcher's scorer keeps its own `&`-splitting tokenizer on purpose:
// that is recall for *matching*, not identity, and both sides of a match
// are tokenized the same way. Don't unify the two.

import { searchFold } from './search.js';
import type { TrackArtist } from './schema.js';

export type ArtistRole = NonNullable<TrackArtist['role']>;
export type ArtistProtect = (nameAscii: string) => boolean;

export interface SplitArtistOptions {
	protect?: ArtistProtect;
	// Role the whole credit carried (an element's own role, or the rb pull's
	// none). Inherited by every non-featured token.
	role?: ArtistRole;
}

// `,` `;` or a whitespace-padded `/`.
const SEPARATOR_RE = /\s*[,;]\s*|\s+\/\s*|\s*\/\s+/;
// "(feat. X)" / "[ft X]" → " feat. X" so the paren form falls into the
// same path as the bare form. Lazy body up to the closing bracket.
const PAREN_FEAT_RE = /\s*[([]\s*(?:feat|featuring|ft)\.?\s+([^)\]]+?)\s*[)\]]/gi;
// Bare "feat." marker as its own word; requires trailing whitespace so a
// name like "Craft" or "Ft. Lauderdale…" mid-word doesn't trip it.
const FEAT_RE = /\s*\b(?:feat|featuring|ft)\.?\s+/i;

function mk(name: string, role: ArtistRole | undefined): TrackArtist {
	// Omit the key entirely when undefined — JSON.stringify would drop it
	// anyway, but list equality in normalizeArtistList compares objects.
	return role ? { name, role } : { name };
}

function splitNames(part: string): string[] {
	return part.split(SEPARATOR_RE).map((s) => s.trim()).filter((s) => s.length > 0);
}

export function splitArtistCredit(raw: string, opts: SplitArtistOptions = {}): TrackArtist[] {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return [];
	if (opts.protect?.(searchFold(trimmed))) return [mk(trimmed, opts.role)];

	const flat = trimmed.replace(PAREN_FEAT_RE, ' feat. $1');
	// First feat marker ends the main run; everything after it is featured
	// regardless of further markers ("A feat. B feat. C" → B, C featured).
	const featIdx = flat.search(FEAT_RE);
	const mainPart = featIdx < 0 ? flat : flat.slice(0, featIdx);
	// Every marker becomes a separator so "A feat. B feat. C" yields B, C.
	const featPart = featIdx < 0 ? '' : flat.slice(featIdx).replace(new RegExp(FEAT_RE.source, 'gi'), ', ');

	const out: TrackArtist[] = [];
	for (const n of splitNames(mainPart)) out.push(mk(n, opts.role));
	for (const n of splitNames(featPart)) out.push(mk(n, 'featured'));
	return out;
}

// "Would the splitter (unprotected) break this into more than one name?"
// — the backfill's definition of a packed credit when it decides which
// single-element names are safe to learn as standalone artists.
export function isPackedCredit(raw: string): boolean {
	return splitArtistCredit(raw).length > 1;
}

function sameArtist(a: TrackArtist, b: TrackArtist): boolean {
	return a.name === b.name && (a.role ?? undefined) === (b.role ?? undefined);
}

// Apply splitArtistCredit to every element of an existing list, keep order,
// dedupe by fold (first occurrence wins), drop empties. Returns the SAME
// array instance when nothing changed so write sites and the backfill can
// skip a rewrite with a reference check.
export function normalizeArtistList(
	list: readonly TrackArtist[] | null | undefined,
	opts: { protect?: ArtistProtect } = {},
): TrackArtist[] {
	const src = list ?? [];
	const out: TrackArtist[] = [];
	const seen = new Set<string>();
	for (const el of src) {
		if (!el || typeof el.name !== 'string') continue;
		for (const a of splitArtistCredit(el.name, { protect: opts.protect, role: el.role ?? undefined })) {
			const key = searchFold(a.name);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(a);
		}
	}
	if (out.length === src.length && out.every((a, i) => sameArtist(a, src[i]!))) {
		return src as TrackArtist[];
	}
	return out;
}

export function artistNames(list: readonly TrackArtist[] | null | undefined): string[] {
	return (list ?? []).map((a) => a?.name ?? '').filter(Boolean);
}

// How credits read. User-configurable in Settings → User Interface;
// display only — the rekordbox push keeps its own ", " join
// (sync/curator-view.ts effectiveArtistName).
//   separator  — between the names on the ARTIST line, remixers included
//                as plain names: "A, X" / "A / X" / "A; X".
//   remixStyle — how the TITLE shows the remix segment: "Feel Me (X Remix)"
//                or "Feel Me - X Remix". See formatTrackTitle in
//                remix-credit.ts; the stored title keeps the release's
//                wording, only the delimiter changes.
export type ArtistSeparator = ',' | '/' | ';';
export type RemixStyle = 'parenthesis' | 'dash';
export interface ArtistCreditFormat { separator: ArtistSeparator; remixStyle: RemixStyle }
export const DEFAULT_ARTIST_CREDIT_FORMAT: ArtistCreditFormat = { separator: ',', remixStyle: 'parenthesis' };

export type ArtistCreditPart =
	| { kind: 'sep'; text: string }
	| { kind: 'artist'; artist: TrackArtist; index: number };

const SEPARATOR_TEXT: Record<ArtistSeparator, string> = { ',': ', ', '/': ' / ', ';': '; ' };

// The one ordering: every non-featured credit in credit order (mains and
// remixers alike — the artist line lists names, the title says who
// remixed), joined by the user's separator, then "feat." + featured.
// Returned as parts so the text form (formatArtistCredit), the static
// track-list HTML and the Solid ArtistCredits component all read
// identically. `index` is the credit's position in the input list — what
// Track.artistIds is aligned with.
export function artistCreditParts(list: readonly TrackArtist[] | null | undefined, fmt: ArtistCreditFormat = DEFAULT_ARTIST_CREDIT_FORMAT): ArtistCreditPart[] {
	const src = (list ?? []).map((artist, index) => ({ artist, index })).filter((x) => x.artist && x.artist.name);
	if (src.length === 0) return [];
	const sep = SEPARATOR_TEXT[fmt.separator] ?? ', ';
	let mains = src.filter((x) => x.artist.role !== 'featured');
	let featured = src.filter((x) => x.artist.role === 'featured');
	// A featured-only credit still needs a headline.
	if (mains.length === 0) { mains = featured; featured = []; }
	const out: ArtistCreditPart[] = [];
	const join = (xs: typeof src): void => {
		xs.forEach((x, k) => {
			if (k > 0) out.push({ kind: 'sep', text: sep });
			out.push({ kind: 'artist', artist: x.artist, index: x.index });
		});
	};
	join(mains);
	if (featured.length) { out.push({ kind: 'sep', text: ' feat. ' }); join(featured); }
	return out;
}

// Text form — "A, X feat. C" under the default format.
export function formatArtistCredit(list: readonly TrackArtist[] | null | undefined, fmt: ArtistCreditFormat = DEFAULT_ARTIST_CREDIT_FORMAT): string {
	return artistCreditParts(list, fmt).map((p) => (p.kind === 'sep' ? p.text : p.artist.name)).join('');
}
