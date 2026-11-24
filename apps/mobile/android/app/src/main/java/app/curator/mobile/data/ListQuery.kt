package app.curator.mobile.data

import app.curator.mobile.model.BpmBucket
import app.curator.mobile.model.ListView
import app.curator.mobile.model.Sort
import app.curator.mobile.model.searchWords

/** Which tracks a list holds before its view (§5): a playlist's, a tag's, an artist's, or the library's. */
sealed interface ListScope {
	data class Playlist(val id: String) : ListScope
	data class Tag(val id: String) : ListScope
	data class Artist(val id: String) : ListScope
	/** [remoteSource]: where the recordings live ('local': the Owned files); null: all of them. */
	data class Library(val remoteSource: String?) : ListScope
}

/** A statement and its arguments. */
class Sql(val text: String, val args: Array<Any?>)

/** The effective value of an overridable field (TrackOverrides in the shared schema). */
internal fun eff(col: String, key: String) = "coalesce(json_extract(t.overrides, '$.$key'), t.$col)"

// Camelot as a number (1A 2, 1B 3 … 12B 25), 999 for anything else: the Key
// sort, and every sort's tie-break, as the design's list orders them.
private val KEY_ORDER = "upper(trim(${eff("key_camelot", "keyCamelot")}))".let { k ->
	"(CASE WHEN $k GLOB '[1-9][AB]' OR $k GLOB '1[0-2][AB]' THEN CAST(substr($k, 1, length($k) - 1) AS INTEGER) * 2 + (substr($k, -1) = 'B') ELSE 999 END)"
}

// When a track came into the library: track_added_order_idx's expression, word for word.
private const val ADDED = "coalesce(t.added_at, t.created_at)"

// The deleted tracks, through their index: the replica carries no ANALYZE
// stats, and without the hint the planner scans every (wide) track row for
// them, 25 ms where the index takes 0.3 (nov8, 38k tracks).
internal const val DELETED_IDS = "SELECT id FROM track INDEXED BY track_deleted_at_idx WHERE deleted_at IS NOT NULL"

// What a search looks through: the folded shadow columns the desktop keeps
// for exactly this (searchFold; packages/sync-core migrate.ts).
private const val HAYSTACK =
	"(coalesce(t.title_ascii, '') || ' ' || coalesce(t.artists_ascii, '') || ' ' || coalesce(t.album_title_ascii, '') || ' ' || coalesce(t.label_ascii, '') || ' ' || coalesce(t.genre_ascii, ''))"

/**
 * A track list as SQL: its scope, then its view's filters and sort, then the
 * search words. Every list (playlist, tag, artist, the library) is read this
 * way, a page at a time (TrackPager): ordering and filtering happen in
 * SQLite, so a 38k-track library never comes into memory whole.
 *
 * The view's semantics, as the design states them: missing values go last in
 * both directions; ties break on the key (Camelot), in the sort's direction;
 * a tag filter matches any of its tags.
 */
class ListQuery(val scope: ListScope, val view: ListView, val search: String = "") {
	private val words = searchWords(search)

	/** Two queries with equal keys read the same rows (a pager is kept per key: AppModel.pager). */
	val key: Any = Triple(scope, view, words)

	// The list's own order, nothing filtered: read from the membership table
	// alone, never touching the wide track rows.
	private val plain = view.sort == Sort.CUSTOM && !view.filtered && words.isEmpty() && (scope is ListScope.Playlist || scope is ListScope.Tag)

	/** The track ids in order; the first [limit] of them when given (the first screen, before the rest). */
	fun ids(limit: Int? = null): Sql {
		val tail = limit?.let { " LIMIT $it" } ?: ""
		val desc = view.dir < 0
		if (plain) return when (scope) {
			is ListScope.Playlist -> Sql(
				"SELECT pt.track_id AS id FROM playlist_track pt WHERE pt.playlist_id = ? AND pt.track_id NOT IN ($DELETED_IDS) ORDER BY pt.order_key ${dir(desc)}$tail",
				arrayOf(scope.id),
			)
			// A tag's own order is newest tagging first.
			is ListScope.Tag -> Sql(
				"SELECT tt.track_id AS id FROM track_tag tt WHERE tt.tag_id = ? AND tt.track_id NOT IN ($DELETED_IDS) ORDER BY tt.added_at ${dir(!desc)}, tt.track_id$tail",
				arrayOf(scope.id),
			)
			else -> error("not a plain scope")
		}
		val args = mutableListOf<Any?>()
		val (scopeFrom, where) = scoped(args)
		val conds = mutableListOf(where, "t.deleted_at IS NULL")
		filters(conds, args)
		// The library's first screen in added order walks the added-order index
		// (0.1 ms) instead of sorting every row (15-100 ms). Without stats the
		// planner prefers the deleted_at index, so it is named. The first screen
		// only: reading every id through it costs a row lookup each (160 ms
		// against a 55 ms scan and sort).
		val from = if (limit != null && scope is ListScope.Library && addedFirst) "track t INDEXED BY track_added_order_idx" else scopeFrom
		return Sql("SELECT t.id AS id FROM $from WHERE ${conds.joinToString(" AND ")} ORDER BY ${order()}$tail", args.toTypedArray())
	}

	// Whether the order starts with the added date (what track_added_order_idx holds).
	private val addedFirst = view.sort == Sort.ADDED || (view.sort == Sort.CUSTOM && (scope is ListScope.Library || scope is ListScope.Artist))

	/** The scope's size and length, before the view: the list's header ("312 tracks · 21 h"), the "of" in "40 of 312". */
	fun totals(): Sql {
		val args = mutableListOf<Any?>()
		val (from, where) = scoped(args)
		return Sql("SELECT count(*) AS n, coalesce(sum(t.duration), 0) AS secs FROM $from WHERE $where AND t.deleted_at IS NULL", args.toTypedArray())
	}

	/** The tags the scope's tracks carry, most used first: the Actions page's tag filter. */
	fun tagCounts(): Sql {
		val args = mutableListOf<Any?>()
		val (from, where) = scoped(args)
		return Sql(
			"""
			SELECT g.name AS name, count(*) AS n FROM track_tag x JOIN tag g ON g.id = x.tag_id
			WHERE g.kind != 'system' AND x.track_id IN (SELECT t.id FROM $from WHERE $where AND t.deleted_at IS NULL)
			GROUP BY g.name ORDER BY n DESC, g.name COLLATE NOCASE
			""".trimIndent(),
			args.toTypedArray(),
		)
	}

	private fun scoped(args: MutableList<Any?>): Pair<String, String> = when (scope) {
		is ListScope.Playlist -> { args += scope.id; "playlist_track pt JOIN track t ON t.id = pt.track_id" to "pt.playlist_id = ?" }
		is ListScope.Tag -> { args += scope.id; "track_tag tt JOIN track t ON t.id = tt.track_id" to "tt.tag_id = ?" }
		is ListScope.Artist -> { args += scope.id; "track t" to "t.id IN (SELECT track_id FROM track_artist WHERE artist_id = ?)" }
		is ListScope.Library -> scope.remoteSource?.let { args += it; "track t" to "t.remote_source = ?" } ?: ("track t" to "1")
	}

	private fun filters(conds: MutableList<String>, args: MutableList<Any?>) {
		if (view.ownedOnly) conds += "t.remote_source = 'local'"
		val bpm = eff("bpm", "bpm")
		when (view.bpm) {
			BpmBucket.ANY -> {}
			BpmBucket.LOW -> conds += "$bpm < 120"
			BpmBucket.MID -> conds += "$bpm BETWEEN 120 AND 124"
			BpmBucket.HIGH -> conds += "$bpm > 124"
		}
		if (view.tags.isNotEmpty()) {
			conds += "t.id IN (SELECT f.track_id FROM track_tag f JOIN tag g ON g.id = f.tag_id WHERE g.name IN (${view.tags.joinToString(",") { "?" }}))"
			args.addAll(view.tags.sorted())
		}
		for (w in words) {
			conds += "$HAYSTACK LIKE ? ESCAPE '\\'"
			args += "%" + w.replace("\\", "\\\\").replace("%", "\\%") + "%"
		}
	}

	private fun order(): String {
		// [natural]: the list's own direction when ascending is asked (newest first, for most).
		val (expr, naturalDesc, missing) = when (view.sort) {
			Sort.CUSTOM -> when (scope) {
				is ListScope.Playlist -> Triple("pt.order_key", false, null)
				is ListScope.Tag -> Triple("tt.added_at", true, null)
				else -> Triple(ADDED, true, null)
			}
			Sort.ENERGY -> Triple("t.power", false, "t.power IS NULL")
			Sort.BPM -> eff("bpm", "bpm").let { Triple(it, false, "$it IS NULL") }
			Sort.KEY -> Triple(KEY_ORDER, false, "$KEY_ORDER = 999")
			// Never missing: created_at is NOT NULL.
			Sort.ADDED -> Triple(ADDED, false, null)
			Sort.TITLE -> Triple("${eff("title", "title")} COLLATE NOCASE", false, null)
		}
		val desc = view.dir < 0
		return listOfNotNull(missing, "$expr ${dir(desc != naturalDesc)}", "$KEY_ORDER ${dir(desc)}", "t.id").joinToString(", ")
	}

	private fun dir(desc: Boolean) = if (desc) "DESC" else "ASC"
}
