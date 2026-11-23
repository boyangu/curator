package app.curator.mobile.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * How every track list draws a row: the account setting `tracklist.rows`
 * (packages/protocol mobile-settings.ts holds its schema, the server checks
 * it). Three detail levels, each laid out as N lines × a left section
 * (flexible, truncates) and a right one (fixed, right-aligned); a level keeps
 * its layout while another is shown.
 */
enum class RowField(val key: String, val label: String) {
	TITLE("title", "Title"),
	VERSION("version", "Version"),
	ARTIST("artist", "Artist"),
	ALBUM("album", "Album"),
	LABEL("label", "Label"),
	GENRE("genre", "Genre"),
	RELEASED("released", "Released"),
	ADDED("added", "Added"),
	BPM("bpm", "BPM"),
	KEY("key", "Key"),
	TIME("time", "Time"),
	RATING("rating", "Rating"),
	POWER("power", "Power"),
	BRIGHTNESS("brightness", "Brightness"),
	TAGS("tags", "Tags"),
	SOURCE("source", "Source"),
	OWNED("owned", "Owned");

	companion object {
		private val byKey = entries.associateBy { it.key }
		fun of(key: String): RowField? = byKey[key]
	}
}

enum class Side { L, R }

/** One section of a level: a line and a side. */
data class Section(val line: Int, val side: Side) {
	val label: String get() = "Line ${line + 1} · ${if (side == Side.L) "left" else "right"}"
}

data class LevelConfig(val l: List<List<RowField>>, val r: List<List<RowField>>) {
	val lines: Int get() = l.size

	fun section(s: Section): List<RowField> = (if (s.side == Side.L) l else r).getOrElse(s.line) { emptyList() }

	/** Where a field is in this level, or null. */
	fun locate(f: RowField): Section? {
		for (i in 0 until lines) {
			if (f in l[i]) return Section(i, Side.L)
			if (f in r.getOrElse(i) { emptyList() }) return Section(i, Side.R)
		}
		return null
	}

	fun with(s: Section, fields: List<RowField>): LevelConfig =
		if (s.side == Side.L) copy(l = l.mapIndexed { i, x -> if (i == s.line) fields else x })
		else copy(r = r.mapIndexed { i, x -> if (i == s.line) fields else x })
}

data class TracklistRows(val density: Int, val levels: Map<Int, LevelConfig>) {
	fun level(n: Int): LevelConfig = levels[n] ?: DEFAULTS.levels.getValue(n)

	companion object {
		/** The handoff's defaults; the same as DEFAULT_TRACKLIST_ROWS in the protocol. */
		val DEFAULTS = TracklistRows(
			density = 2,
			levels = mapOf(
				1 to LevelConfig(l = listOf(listOf(RowField.TITLE, RowField.ARTIST)), r = listOf(listOf(RowField.BPM, RowField.KEY))),
				2 to LevelConfig(
					l = listOf(listOf(RowField.TITLE), listOf(RowField.ARTIST, RowField.LABEL)),
					r = listOf(listOf(RowField.BPM, RowField.KEY), listOf(RowField.TIME)),
				),
				3 to LevelConfig(
					l = listOf(listOf(RowField.TITLE, RowField.VERSION), listOf(RowField.ARTIST, RowField.LABEL), listOf(RowField.TAGS)),
					r = listOf(listOf(RowField.BPM, RowField.KEY), listOf(RowField.TIME), listOf(RowField.POWER)),
				),
			),
		)

		/** The stored value, or null when it does not fit the rules (the defaults then). */
		fun fromJson(e: JsonElement?): TracklistRows? = runCatching {
			val o = e!!.jsonObject
			val density = o["density"]!!.jsonPrimitive.int
			val levels = (1..3).associateWith { n ->
				val lv = o["levels"]!!.jsonObject[n.toString()]!!.jsonObject
				fun sections(k: String) = lv[k]!!.jsonArray.map { line -> line.jsonArray.map { RowField.of(it.jsonPrimitive.content)!! } }
				LevelConfig(sections("l"), sections("r"))
			}
			TracklistRows(density, levels).takeIf { it.isValid() }
		}.getOrNull()
	}

	fun toJson(): JsonObject = JsonObject(mapOf(
		"density" to JsonPrimitive(density),
		"levels" to JsonObject((1..3).associate { n ->
			val lv = level(n)
			n.toString() to JsonObject(mapOf(
				"l" to JsonArray(lv.l.map { line -> JsonArray(line.map { JsonPrimitive(it.key) }) }),
				"r" to JsonArray(lv.r.map { line -> JsonArray(line.map { JsonPrimitive(it.key) }) }),
			))
		}),
	))

	/** The protocol's rules: density 1–3; per level, N lines a side, the title once, no field twice. */
	fun isValid(): Boolean = density in 1..3 && (1..3).all { n ->
		val lv = levels[n] ?: return@all false
		val all = lv.l.flatten() + lv.r.flatten()
		lv.l.size == n && lv.r.size == n && all.count { it == RowField.TITLE } == 1 && all.toSet().size == all.size
	}
}

/** The Row fields editor's edits. Each keeps the level valid; an edit that cannot is a no-op. */
sealed interface RowEdit {
	val level: Int

	/** Moves the field at [index] of [section] by [by] (−1 up, +1 down). */
	data class Reorder(override val level: Int, val section: Section, val index: Int, val by: Int) : RowEdit

	/** Takes a field out of [section]; the title cannot be removed. */
	data class Remove(override val level: Int, val section: Section, val field: RowField) : RowEdit

	/**
	 * A tap on a field's chip while [section] is selected: in this section →
	 * removed (not the title); in another → moved here and taken from there;
	 * unused → added here. Always at the end of the section.
	 */
	data class Tap(override val level: Int, val section: Section, val field: RowField) : RowEdit

	/** The level's defaults back. */
	data class Reset(override val level: Int) : RowEdit
}

fun TracklistRows.apply(edit: RowEdit): TracklistRows {
	val lv = level(edit.level)
	val next: LevelConfig = when (edit) {
		is RowEdit.Reorder -> {
			val fields = lv.section(edit.section).toMutableList()
			val to = edit.index + edit.by
			if (edit.index !in fields.indices || to !in fields.indices) return this
			fields.add(to, fields.removeAt(edit.index))
			lv.with(edit.section, fields)
		}
		is RowEdit.Remove -> {
			if (edit.field == RowField.TITLE) return this
			val fields = lv.section(edit.section)
			if (edit.field !in fields) return this
			lv.with(edit.section, fields - edit.field)
		}
		is RowEdit.Tap -> {
			val at = lv.locate(edit.field)
			when {
				at == edit.section -> if (edit.field == RowField.TITLE) return this else lv.with(edit.section, lv.section(edit.section) - edit.field)
				at != null -> lv.with(at, lv.section(at) - edit.field).let { it.with(edit.section, it.section(edit.section) + edit.field) }
				else -> lv.with(edit.section, lv.section(edit.section) + edit.field)
			}
		}
		is RowEdit.Reset -> TracklistRows.DEFAULTS.level(edit.level)
	}
	return copy(levels = levels + (edit.level to next))
}
