package app.curator.mobile.model

import kotlin.math.roundToInt

/** One of the player's analysis meters: its name and value out of 100. */
data class Score(val label: String, val value: Int)

/**
 * The player's Analysis meters from the track's percentiles in the library
 * (0–1; ui/list Metrics): each out of 100, rounded. The raw values have no
 * common scale (power reads about 3, density about 12), so the percentile
 * is what a bar can be filled to. A score the track lacks is left out; an unanalysed track (none of them) has no section.
 */
fun analysisScores(power: Double?, brightness: Double?, density: Double?): List<Score> =
	listOf("Power" to power, "Brightness" to brightness, "Density" to density)
		.mapNotNull { (label, v) -> v?.let { Score(label, (it.coerceIn(0.0, 1.0) * 100).roundToInt()) } }

private val CAMELOT = Regex("^(1[0-2]|[1-9])([AB])$")

/**
 * The keys Find similar takes as related to [key]: the desktop's similarity
 * at its default level (rekordbox's Traffic Light "Related key 2"): the same
 * key, its relative major or minor, and one step either way round the wheel
 * in the same mode. Empty for a key that is not Camelot.
 */
fun relatedKeys(key: String?): List<String> {
	val m = CAMELOT.matchEntire(key?.trim()?.uppercase() ?: return emptyList()) ?: return emptyList()
	val n = m.groupValues[1].toInt()
	val mode = m.groupValues[2]
	val other = if (mode == "A") "B" else "A"
	val down = if (n == 1) 12 else n - 1
	val up = if (n == 12) 1 else n + 1
	return listOf("$n$mode", "$n$other", "$down$mode", "$up$mode")
}
