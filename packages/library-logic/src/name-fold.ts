// The name an entity is searched and compared by: case, accents, punctuation
// and spacing folded away, so "Âme" / "ame", "Kölsch" / "Kolsch" and
// "Innervisions." / "innervisions" meet. The cloud catalogue keys its name
// lookups on it and the desktop searches with the same fold, so both sides
// find the same rows for the same text.
//
// It is never an identity on its own: two artists or two labels sharing a
// folded name are often different entities (namesakes), so a match on this
// value only narrows candidates that other evidence then confirms.

export function nameFold(s: string | null | undefined): string {
	return (s ?? '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

// A credit's folds for COMPARISON: the whole, and each act it names when read
// as a compound ("Frankey & Sandrino" → "frankey and sandrino", "frankey",
// "sandrino"). One store credits a duo as one act and another as two people;
// matched on the whole alone they never meet (a Bandcamp and a Beatport copy
// of one compilation were two releases for it, 2026-11-06). Never a credit
// splitter — the library keeps "&" acts whole (@curator/shared artist-credit)
// — only evidence beside a title and a date. Pieces of one character and
// "various artists" carry nothing and are left out.
const CREDIT_PIECE_RE = /\s*[,;/+]\s*|\s+(?:&|and|x|vs\.?|versus|with|feat\.?|featuring|ft\.?|pres\.?|presents|b2b)\s+/i;
export function creditFolds(name: string | null | undefined): string[] {
	const whole = nameFold(name);
	if (!whole) return [];
	const out = new Set<string>([whole]);
	for (const piece of (name ?? '').split(CREDIT_PIECE_RE)) {
		const p = nameFold(piece);
		if (p.length > 1 && p !== whole && p !== 'various artists') out.add(p);
	}
	return [...out];
}

// Whether two credits name a common act, by their folds (creditFolds).
export function creditsShareAct(a: readonly string[], b: readonly string[]): boolean {
	const folds = new Set(a.flatMap(creditFolds));
	return b.some((n) => creditFolds(n).some((f) => folds.has(f)));
}
