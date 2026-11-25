package app.curator.mobile.model

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
	/** A track matches when it carries every one of these tags. */
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

/** Placeholder buckets from the design; a range slider may replace them. Read in SQL (ListQuery). */
enum class BpmBucket(val label: String) {
	ANY("Any"), LOW("<120"), MID("120–124"), HIGH(">124");
}
