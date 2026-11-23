package app.curator.mobile.data

import app.curator.mobile.model.HomePin
import app.curator.mobile.model.TracklistRows
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * What the views read from the library file, as the desktop shows it: a
 * user's overrides over the base values (track.overrides), deleted rows
 * hidden, tags fetched for a whole list at once (one IN query, never one per
 * row).
 *
 * On a joined device every row is a projection of the account (remote_only);
 * `remote_source` says where the recording lives: 'local' is a file on a
 * desktop (Owned), else the streaming service it came from.
 */
class Library(private val db: NativeDb) {

	// The effective value of an overridable field (TrackOverrides in the shared schema).
	private fun eff(col: String, key: String) = "coalesce(json_extract(t.overrides, '$.$key'), t.$col)"

	private val trackColumns = """
		t.id, t.recording_id,
		${eff("title", "title")} AS title,
		coalesce(json_extract(t.overrides, '$.artists'), t.artists) AS artists,
		${eff("album_title", "albumTitle")} AS album,
		${eff("label", "label")} AS label,
		${eff("genre", "genre")} AS genre,
		${eff("release_date", "releaseDate")} AS released,
		${eff("bpm", "bpm")} AS bpm,
		${eff("key_camelot", "keyCamelot")} AS key,
		t.duration, t.rating, t.power, t.brightness, t.density, t.cover_url,
		t.added_at, t.created_at, t.remote_source
	""".trimIndent()

	private fun trackOf(r: Row, tags: Map<String, List<String>>, order: String? = null): Track {
		val (title, version) = splitVersion(r.string("title") ?: "")
		return Track(
			id = r.string("id")!!,
			recordingId = r.string("recording_id"),
			title = title,
			version = version,
			artist = artistsText(r.string("artists")),
			album = r.string("album"),
			label = r.string("label"),
			genre = r.string("genre"),
			released = r.string("released"),
			bpm = r.double("bpm"),
			key = r.string("key"),
			durationSec = r.int("duration"),
			rating = r.int("rating")?.takeIf { it > 0 },
			power = r.double("power"),
			brightness = r.double("brightness"),
			density = r.double("density"),
			coverUrl = r.string("cover_url"),
			addedAt = r.long("added_at") ?: r.long("created_at"),
			source = r.string("remote_source"),
			tags = tags[r.string("id")] ?: emptyList(),
			orderKey = order,
		)
	}

	// ── Home ─────────────────────────────────────────────────────────────────

	fun playlists(): List<PlaylistSummary> = db.query(
		"""
		SELECT p.id, p.name, p.source, p.cover_url, p.parent_folder_id, p.position,
			(SELECT count(*) FROM playlist_track pt JOIN track t ON t.id = pt.track_id
				WHERE pt.playlist_id = p.id AND t.deleted_at IS NULL) AS n,
			(SELECT t.cover_url FROM playlist_track pt JOIN track t ON t.id = pt.track_id
				WHERE pt.playlist_id = p.id AND t.deleted_at IS NULL AND t.cover_url IS NOT NULL
				ORDER BY pt.order_key LIMIT 1) AS first_cover
		FROM playlist p
		WHERE coalesce(p.is_hidden, 0) = 0
		ORDER BY coalesce(p.position, 2147483647), p.name COLLATE NOCASE
		""".trimIndent(),
	).map {
		PlaylistSummary(
			id = it.string("id")!!,
			name = it.string("name") ?: "Untitled",
			source = it.string("source"),
			coverUrl = it.string("cover_url") ?: it.string("first_cover"),
			folderId = it.string("parent_folder_id"),
			tracks = it.int("n") ?: 0,
		)
	}

	fun folders(): List<Folder> = db.query(
		"SELECT id, name, parent_folder_id FROM playlist_folder ORDER BY coalesce(position, 2147483647), name COLLATE NOCASE",
	).map { Folder(it.string("id")!!, it.string("name") ?: "Folder", it.string("parent_folder_id")) }

	fun tags(): List<TagSummary> = db.query(
		"""
		SELECT g.id, g.name, g.kind,
			(SELECT count(*) FROM track_tag tt JOIN track t ON t.id = tt.track_id
				WHERE tt.tag_id = g.id AND t.deleted_at IS NULL) AS n
		FROM tag g
		ORDER BY g.kind = 'system' DESC, coalesce(g.sort_order, 2147483647), g.name COLLATE NOCASE
		""".trimIndent(),
	).map { TagSummary(it.string("id")!!, it.string("name") ?: "", it.string("kind") == "system", it.int("n") ?: 0) }

	// ── Track lists ──────────────────────────────────────────────────────────

	fun playlistTracks(playlistId: String): List<Track> {
		val rows = db.query(
			"""
			SELECT $trackColumns, pt.order_key
			FROM playlist_track pt JOIN track t ON t.id = pt.track_id
			WHERE pt.playlist_id = ? AND t.deleted_at IS NULL
			ORDER BY pt.order_key
			""".trimIndent(), playlistId,
		)
		val tags = tagsFor("SELECT pt.track_id FROM playlist_track pt WHERE pt.playlist_id = ?", playlistId)
		return rows.map { trackOf(it, tags, it.string("order_key")) }
	}

	/** Every track carrying the tag, newest tagging first (its "custom" order). */
	fun tagTracks(tagId: String): List<Track> {
		val rows = db.query(
			"""
			SELECT $trackColumns, printf('%020d', 9223372036854775807 - tt.added_at) AS order_key
			FROM track_tag tt JOIN track t ON t.id = tt.track_id
			WHERE tt.tag_id = ? AND t.deleted_at IS NULL
			ORDER BY tt.added_at DESC
			""".trimIndent(), tagId,
		)
		val tags = tagsFor("SELECT tt.track_id FROM track_tag tt WHERE tt.tag_id = ?", tagId)
		return rows.map { trackOf(it, tags, it.string("order_key")) }
	}

	fun track(id: String): Track? {
		val rows = db.query("SELECT $trackColumns FROM track t WHERE t.id = ?", id)
		if (rows.size == 0) return null
		return trackOf(rows[0], tagsFor("SELECT ?", id))
	}

	// The tag names of every track a list holds, in one query.
	private fun tagsFor(trackIdsSql: String, vararg args: Any?): Map<String, List<String>> {
		val out = HashMap<String, MutableList<String>>()
		for (r in db.query(
			"""
			SELECT tt.track_id, g.name FROM track_tag tt JOIN tag g ON g.id = tt.tag_id
			WHERE tt.track_id IN ($trackIdsSql) AND g.kind != 'system'
			ORDER BY coalesce(g.sort_order, 2147483647), g.name COLLATE NOCASE
			""".trimIndent(), *args,
		)) out.getOrPut(r.string("track_id")!!) { mutableListOf() } += r.string("name")!!
		return out
	}

	/** Whether the track carries a tag (Interested, Basket). */
	fun hasTag(trackId: String, tagId: String): Boolean =
		db.query("SELECT 1 FROM track_tag WHERE track_id = ? AND tag_id = ? LIMIT 1", trackId, tagId).size > 0

	/** The Spotify track a recording plays as (its best-ranked claim), for the player. */
	fun spotifyId(trackId: String): String? =
		db.query("SELECT source_track_id FROM claim_link WHERE track_id = ? AND source = 'spotify' ORDER BY rank LIMIT 1", trackId)
			.takeIf { it.size > 0 }?.get(0)?.string("source_track_id")

	fun playlistsHolding(trackId: String): Int =
		db.query("SELECT count(DISTINCT playlist_id) AS n FROM playlist_track WHERE track_id = ?", trackId)[0].int("n") ?: 0

	// ── one track's analysis ─────────────────────────────────────────────────

	/**
	 * Cues, beat grid and phrases. rekordbox's slot when it has one (what the
	 * DJ prepared on the decks), else Curator's analyzer's — the desktop
	 * player's default.
	 */
	fun analysis(trackId: String): TrackAnalysis {
		val cues = db.query(
			"SELECT slot, position_sec, color, kind FROM cue WHERE track_id = ? AND kind = 'hot' ORDER BY slot", trackId,
		).map { Cue(it.int("slot") ?: 0, it.double("position_sec") ?: 0.0, it.string("color")) }
		val a = db.query(
			"""
			SELECT coalesce(rb_beatgrid, beatgrid) AS grid, coalesce(rb_downbeats, downbeats) AS downbeats,
				coalesce(rb_segments_json, segments_json) AS segments
			FROM track_analysis WHERE track_id = ?
			""".trimIndent(), trackId,
		)
		if (a.size == 0) return TrackAnalysis(cues, FloatArray(0), FloatArray(0), emptyList())
		val r = a[0]
		return TrackAnalysis(
			cues = cues,
			beats = floats(r.bytes("grid")),
			downbeats = floats(r.bytes("downbeats")),
			phrases = phrasesOf(r.string("segments")),
		)
	}

	/** The library's values of a metric, sorted: each track's meter is its percentile in them. */
	fun metricValues(column: String): DoubleArray {
		require(column in setOf("power", "brightness", "density"))
		val rows = db.query("SELECT $column AS v FROM track WHERE deleted_at IS NULL AND $column IS NOT NULL ORDER BY $column")
		return DoubleArray(rows.size) { rows[it].double("v")!! }
	}

	// ── settings ─────────────────────────────────────────────────────────────

	fun tracklistRows(): TracklistRows = setting("tracklist.rows")?.let { TracklistRows.fromJson(it) } ?: TracklistRows.DEFAULTS

	fun homePins(): List<HomePin> = runCatching {
		(setting("home.pins") as? JsonArray)?.map {
			val o = it.jsonObject
			HomePin(o["kind"]!!.jsonPrimitive.content, o["id"]!!.jsonPrimitive.content)
		}
	}.getOrNull() ?: emptyList()

	private fun setting(key: String) = db.query("SELECT value FROM app_setting WHERE key = ?", key)
		.takeIf { it.size > 0 }?.get(0)?.string("value")?.let { runCatching { Json.parseToJsonElement(it) }.getOrNull() }

	companion object {
		// "Hyperfall (Original Mix)" → ("Hyperfall", "Original Mix"): the
		// version is the last bracketed part, as the desktop's matcher reads
		// it; or Spotify's " - Extended Mix" form, when what follows the dash
		// names a version.
		private val versionRe = Regex("""^(.*\S)\s*[(\[]([^()\[\]]+)[)\]]\s*$""")
		private val dashVersionRe = Regex(
			"""^(.*\S)\s+-\s+(.*\b(?:mix|remix|edit|version|dub|rework|remaster(?:ed)?|instrumental|vip|bootleg|interpretation|reprise|rmx)\b.*)$""",
			RegexOption.IGNORE_CASE,
		)

		fun splitVersion(title: String): Pair<String, String?> {
			val m = versionRe.find(title) ?: dashVersionRe.find(title) ?: return title to null
			return m.groupValues[1] to m.groupValues[2]
		}

		fun artistsText(json: String?): String = runCatching {
			Json.parseToJsonElement(json!!).jsonArray.mapNotNull { it.jsonObject["name"]?.jsonPrimitive?.contentOrNull }.joinToString(", ")
		}.getOrNull() ?: ""

		// Float32 little-endian blobs of seconds (track_analysis.beatgrid / downbeats).
		fun floats(b: ByteArray?): FloatArray {
			if (b == null || b.size < 4) return FloatArray(0)
			val buf = java.nio.ByteBuffer.wrap(b).order(java.nio.ByteOrder.LITTLE_ENDIAN)
			return FloatArray(b.size / 4) { buf.getFloat(it * 4) }
		}

		fun phrasesOf(json: String?): List<Phrase> = runCatching {
			Json.parseToJsonElement(json!!).jsonArray.map {
				val o = it.jsonObject
				Phrase(
					startSec = o["startSec"]!!.jsonPrimitive.content.toDouble(),
					endSec = o["endSec"]!!.jsonPrimitive.content.toDouble(),
					label = o["label"]?.jsonPrimitive?.contentOrNull ?: "",
				)
			}
		}.getOrNull() ?: emptyList()
	}
}

data class Track(
	val id: String,
	val recordingId: String?,
	val title: String,
	val version: String?,
	val artist: String,
	val album: String?,
	val label: String?,
	val genre: String?,
	val released: String?,
	val bpm: Double?,
	val key: String?,
	val durationSec: Int?,
	val rating: Int?,
	val power: Double?,
	val brightness: Double?,
	val density: Double?,
	val coverUrl: String?,
	val addedAt: Long?,
	val source: String?,
	val tags: List<String>,
	val orderKey: String? = null,
) {
	val owned: Boolean get() = source == "local"
}

data class PlaylistSummary(val id: String, val name: String, val source: String?, val coverUrl: String?, val folderId: String?, val tracks: Int)
data class Folder(val id: String, val name: String, val parentId: String?)
data class TagSummary(val id: String, val name: String, val system: Boolean, val tracks: Int)
data class Cue(val slot: Int, val positionSec: Double, val color: String?) {
	/** A, B, C… by slot. */
	val letter: String get() = ('A' + slot.coerceIn(0, 25)).toString()
}
data class Phrase(val startSec: Double, val endSec: Double, val label: String)
data class TrackAnalysis(val cues: List<Cue>, val beats: FloatArray, val downbeats: FloatArray, val phrases: List<Phrase>)
