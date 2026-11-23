package app.curator.mobile.model

import app.curator.mobile.data.Track
import app.curator.mobile.ui.theme.camelotOrder
import kotlinx.serialization.Serializable

/**
 * How one track list is shown on this device: its sort and filters. View
 * state, not library data: kept per list on the device (ViewState), never an op.
 */
@Serializable
data class ListView(
	val sort: Sort = Sort.CUSTOM,
	/** 1 ascending, -1 descending. */
	val dir: Int = 1,
	/** A track matches when it carries any of these tags. */
	val tags: Set<String> = emptySet(),
	val bpm: BpmBucket = BpmBucket.ANY,
	val ownedOnly: Boolean = false,
) {
	val filtered: Boolean get() = tags.isNotEmpty() || bpm != BpmBucket.ANY || ownedOnly

	fun cleared() = copy(tags = emptySet(), bpm = BpmBucket.ANY, ownedOnly = false)

	/** Tapping the active sort flips it; another sort starts ascending. */
	fun pick(s: Sort) = if (s == sort) copy(dir = -dir) else copy(sort = s, dir = 1)
}

enum class Sort(val label: String, val chip: String) {
	CUSTOM("Custom", "Custom order"),
	ENERGY("Energy", "Energy"),
	BPM("BPM", "BPM"),
	KEY("Key", "Key"),
	ADDED("Added", "Added"),
	TITLE("Title", "Title"),
}

/** Placeholder buckets from the design; a range slider may replace them. */
enum class BpmBucket(val label: String) {
	ANY("Any"), LOW("<120"), MID("120–124"), HIGH(">124");

	fun matches(bpm: Double?): Boolean = when (this) {
		ANY -> true
		LOW -> bpm != null && bpm < 120
		MID -> bpm != null && bpm >= 120 && bpm <= 124
		HIGH -> bpm != null && bpm > 124
	}
}

/**
 * The list as shown: filtered, then sorted. Secondary order is always the
 * key (Camelot: 1A, 1B, 2A…), and the direction applies to both, as the
 * design's list does. A track with no value for the sort goes last either way.
 */
fun ListView.apply(tracks: List<Track>): List<Track> {
	val kept = tracks.filter { t ->
		(!ownedOnly || t.owned) && bpm.matches(t.bpm) && (tags.isEmpty() || t.tags.any { it in tags })
	}
	val primary: Comparator<Track> = when (sort) {
		Sort.CUSTOM -> compareBy(nullsLast()) { it.orderKey }
		Sort.ENERGY -> compareBy(nullsLast()) { it.power }
		Sort.BPM -> compareBy(nullsLast()) { it.bpm }
		Sort.KEY -> compareBy { camelotOrder(it.key) }
		Sort.ADDED -> compareBy(nullsLast()) { it.addedAt }
		Sort.TITLE -> compareBy(nullsLast()) { it.title.lowercase() }
	}
	val missing: (Track) -> Boolean = when (sort) {
		Sort.CUSTOM -> { t -> t.orderKey == null }
		Sort.ENERGY -> { t -> t.power == null }
		Sort.BPM -> { t -> t.bpm == null }
		Sort.KEY -> { t -> camelotOrder(t.key) == Int.MAX_VALUE }
		Sort.ADDED -> { t -> t.addedAt == null }
		Sort.TITLE -> { _ -> false }
	}
	val byKey = compareBy<Track> { camelotOrder(it.key) }
	val (have, lack) = kept.partition { !missing(it) }
	val ordered = have.sortedWith { a, b ->
		val c = primary.compare(a, b).takeIf { it != 0 } ?: byKey.compare(a, b)
		c * dir
	}
	return ordered + lack
}
