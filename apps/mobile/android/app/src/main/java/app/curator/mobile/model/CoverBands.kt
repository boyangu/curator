package app.curator.mobile.model

import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * What the player's cover carries, a corner at a time, as the feed cards do:
 * top left who and what (title, artists, album), top right the BPM and key,
 * bottom left the label and genre, bottom right the release. A line with no
 * data is left out, and a corner with none is not drawn.
 */
data class CoverBands(
	val title: String?,
	val artists: String?,
	val album: String?,
	val bpm: String?,
	val key: String?,
	val label: String?,
	val genre: String?,
	val released: String?,
) {
	val topLeft: List<String> get() = listOfNotNull(title, artists, album)
	val bottomLeft: List<String> get() = listOfNotNull(label, genre)
	val hasTopRight: Boolean get() = bpm != null || key != null

	/** All of it, as a screen reader says it. */
	fun spoken(): String = buildList {
		listOfNotNull(title, artists?.let { "by $it" }).joinToString(" ").let { who ->
			add(if (album != null) "$who, from $album" else who)
		}
		listOfNotNull(bpm?.let { "$it BPM" }, key?.let { "key $it" }).joinToString(", ").let(::add)
		listOfNotNull(label, genre).joinToString(", ").let(::add)
		released?.let { add("Released $it") }
	}.filter { it.isNotBlank() }.joinToString(". ", postfix = ".")
}

fun coverBands(
	title: String?, artists: String?, album: String?, bpm: Double?, key: String?,
	label: String?, genre: String?, released: String?, today: LocalDate = LocalDate.now(),
): CoverBands = CoverBands(
	title = title.present(),
	artists = artists.present(),
	album = album.present(),
	bpm = bpm?.takeIf { it > 0 }?.let { Math.round(it).toString() },
	key = key.present(),
	label = label.present(),
	genre = genre.present(),
	released = releaseLabel(released, today),
)

private fun String?.present(): String? = this?.trim()?.takeIf { it.isNotEmpty() }

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * The release date as the desktop's lists show it (library-logic
 * fmtReleaseLabel): a full date in the last 30 days as an age ("today",
 * "1 day", "12 days"), anything older or without a day as "Mar, 2021" or
 * "2021". Null where the desktop shows a dash: here the line is left out.
 */
fun releaseLabel(d: String?, today: LocalDate = LocalDate.now()): String? {
	if (d.isNullOrBlank()) return null
	val parts = d.trim().split('-')
	val y = parts[0].toIntOrNull() ?: return null
	val m = parts.getOrNull(1)?.toIntOrNull()
	val day = parts.getOrNull(2)?.take(2)?.toIntOrNull()
	if (m != null && day != null) {
		val days = runCatching { ChronoUnit.DAYS.between(LocalDate.of(y, m, day), today) }.getOrNull()
		if (days != null && days in 0..30) return when (days) {
			0L -> "today"
			1L -> "1 day"
			else -> "$days days"
		}
	}
	return MONTHS.getOrNull((m ?: 0) - 1)?.let { "$it, ${parts[0]}" } ?: parts[0]
}
