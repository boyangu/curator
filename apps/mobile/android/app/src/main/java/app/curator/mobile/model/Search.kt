package app.curator.mobile.model

import java.text.Normalizer

private val DIACRITICS = Regex("[̀-ͯ]")
private val CONNECTOR_PUNCT = Regex("[._'‘’-]")
private val O_SLASH = Regex("ø", RegexOption.IGNORE_CASE)
private val AE = Regex("æ", RegexOption.IGNORE_CASE)
private val OE = Regex("œ", RegexOption.IGNORE_CASE)
private val L_STROKE = Regex("ł", RegexOption.IGNORE_CASE)

/**
 * The desktop's searchFold (packages/shared/src/search.ts), rule for rule:
 * the track's `*_ascii` columns hold their text folded by it, so a query
 * folded here matches them ("bohmer" finds "Böhmer", "jayz" finds "Jay-Z").
 * If the rules there change, change them here too.
 */
fun searchFold(s: String?): String {
	if (s.isNullOrEmpty()) return ""
	return Normalizer.normalize(s, Normalizer.Form.NFD)
		.replace(DIACRITICS, "")
		.replace("ß", "ss")
		.replace(O_SLASH, "o")
		.replace(AE, "ae")
		.replace(OE, "oe")
		.replace(L_STROKE, "l")
		.replace(CONNECTOR_PUNCT, "")
		.lowercase()
}

/** The words typed in a search box, folded. */
fun searchWords(q: String): List<String> = searchFold(q).split(' ', '\t').filter { it.isNotEmpty() }

/**
 * A short list's rows with their text folded once, filtered per keystroke:
 * a row matches when its text holds every word, anywhere, in any order.
 * (Track lists search in SQL, over the folded columns: ListQuery.)
 */
class SearchIndex<T>(val items: List<T>, text: (T) -> String) {
	private val folded = items.map { searchFold(text(it)) }

	fun search(q: String): List<T> {
		val words = searchWords(q)
		if (words.isEmpty()) return items
		return items.filterIndexed { i, _ -> words.all { it in folded[i] } }
	}
}
