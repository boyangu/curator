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
