package app.curator.mobile.data

import app.curator.mobile.model.HomePin
import app.curator.mobile.model.StreamingService
import app.curator.mobile.model.TracklistRows
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * What the views read from the library file, as the desktop shows it: a
 * user's overrides over the base values (track.overrides), deleted rows
 * hidden, tags fetched for a page of tracks at once (one IN query, never one
 * per row).
 *
 * Every read is sized for a screen, never for the library: track lists come
 * a page at a time (ListQuery, TrackPager), and Home's counts come from the
 * membership tables' indexes rather than a join to every track row (a
 * 38k-track library's track table is 500 MB: touching each row is what is
 * slow, sorting is not).
 *
 * On a joined device every row is a projection of the account (remote_only);
 * `remote_source` says where the recording lives: 'local' is a file on a
 * desktop (Owned), else the streaming service it came from.
 */
class Library(private val db: NativeDb) {

	private val trackColumns = """
		t.id, t.recording_id,
		${eff("title", "title")} AS title,
		(SELECT group_concat(json_extract(j.value, '$.name'), ', ') FROM json_each(
			CASE WHEN json_valid(coalesce(json_extract(t.overrides, '$.artists'), t.artists)) THEN coalesce(json_extract(t.overrides, '$.artists'), t.artists) END
		) j) AS artists,
		${eff("album_title", "albumTitle")} AS album,
		${eff("label", "label")} AS label,
		${eff("genre", "genre")} AS genre,
		${eff("release_date", "releaseDate")} AS released,
		${eff("bpm", "bpm")} AS bpm,
		${eff("key_camelot", "keyCamelot")} AS key,
		t.duration, t.rating, t.power, t.brightness, t.density, t.cover_url,
		t.added_at, t.created_at, t.remote_source
	""".trimIndent()

	private fun trackOf(r: Row, tags: Map<String, List<String>>, streams: Map<String, Set<String>>): Track {
		val (title, version) = splitVersion(r.string("title") ?: "")
		return Track(
			id = r.string("id")!!,
			recordingId = r.string("recording_id"),
			title = title,
			version = version,
			// Joined in SQLite: parsing each row's JSON here was most of a 38k-track library's load.
			artist = r.string("artists") ?: "",
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
			streams = streams[r.string("id")] ?: emptySet(),
		)
	}

	// ── Home ─────────────────────────────────────────────────────────────────

	fun playlists(): List<PlaylistSummary> {
		// Members per playlist from the membership index alone, less the deleted
		// ones (few, found through their own index): 7 ms, where a count joined
		// to every member's track row took 900 (nov8).
		val members = counts("SELECT playlist_id AS k, count(*) AS n FROM playlist_track GROUP BY playlist_id")
		val gone = counts("SELECT playlist_id AS k, count(*) AS n FROM playlist_track WHERE track_id IN ($DELETED_IDS) GROUP BY playlist_id")
		// A playlist without its own cover shows its first track's.
		val firstCovers = db.query(
			"""
			SELECT p.id AS k, (SELECT t.cover_url FROM playlist_track pt JOIN track t ON t.id = pt.track_id
				WHERE pt.playlist_id = p.id AND t.deleted_at IS NULL AND t.cover_url IS NOT NULL
				ORDER BY pt.order_key LIMIT 1) AS cover
			FROM playlist p WHERE coalesce(p.is_hidden, 0) = 0 AND p.cover_url IS NULL
			""".trimIndent(),
		).associate { it.string("k")!! to it.string("cover") }
		return db.query(
			"""
			SELECT id, name, source, cover_url, parent_folder_id FROM playlist
			WHERE coalesce(is_hidden, 0) = 0
			ORDER BY coalesce(position, 2147483647), name COLLATE NOCASE
			""".trimIndent(),
		).map {
			val id = it.string("id")!!
			PlaylistSummary(
				id = id,
				name = it.string("name") ?: "Untitled",
				source = it.string("source"),
				coverUrl = it.string("cover_url") ?: firstCovers[id],
				folderId = it.string("parent_folder_id"),
				tracks = (members[id] ?: 0) - (gone[id] ?: 0),
			)
		}
	}

	/** One playlist's name and source (a list's header), without reading the rest. */
	fun playlist(id: String): PlaylistSummary? = db.query("SELECT id, name, source, cover_url, parent_folder_id FROM playlist WHERE id = ?", id)
		.firstOrNull()?.let { PlaylistSummary(id, it.string("name") ?: "Untitled", it.string("source"), it.string("cover_url"), it.string("parent_folder_id"), 0) }

	fun tagName(id: String): String? = db.query("SELECT name FROM tag WHERE id = ?", id).firstOrNull()?.string("name")

	private fun counts(sql: String): Map<String, Int> = db.query(sql).associate { it.string("k")!! to (it.int("n") ?: 0) }

	fun lists(): Lists = Lists(playlists(), folders(), tags())

	fun folders(): List<Folder> = db.query(
		"SELECT id, name, parent_folder_id FROM playlist_folder ORDER BY coalesce(position, 2147483647), name COLLATE NOCASE",
	).map { Folder(it.string("id")!!, it.string("name") ?: "Folder", it.string("parent_folder_id")) }

	fun tags(): List<TagSummary> {
		// As playlists' counts: the membership index, less the deleted members.
		val members = counts("SELECT tag_id AS k, count(*) AS n FROM track_tag GROUP BY tag_id")
		val gone = counts("SELECT tag_id AS k, count(*) AS n FROM track_tag WHERE track_id IN ($DELETED_IDS) GROUP BY tag_id")
		return db.query(
			"SELECT id, name, kind FROM tag ORDER BY kind = 'system' DESC, coalesce(sort_order, 2147483647), name COLLATE NOCASE",
		).map {
			val id = it.string("id")!!
			TagSummary(id, it.string("name") ?: "", it.string("kind") == "system", (members[id] ?: 0) - (gone[id] ?: 0))
		}
	}

	// ── Track lists, a page at a time ────────────────────────────────────────

	/** A list's track ids in its order ([ListQuery.ids]). */
	fun ids(q: Sql): List<String> {
		val rows = try {
			db.query(q.text, *q.args)
		} catch (e: RuntimeException) {
			// The views open beside the core's start (CuratorApp): on the first
			// launch after an update its migrate may not have made a newly named
			// index yet. The same order without the hint, slower, this once.
			if (e.message?.contains("no such index") != true) throw e
			db.query(q.text.replace(Regex(" INDEXED BY \\w+"), ""), *q.args)
		}
		return rows.map { it.string("id")!! }
	}

	/** The tracks of one page, in the order of [ids], their tags with them. */
	fun tracks(ids: List<String>): List<Track> {
		if (ids.isEmpty()) return emptyList()
		val marks = ids.joinToString(",") { "?" }
		val args = ids.toTypedArray<Any?>()
		val tags = tagsFor(marks, *args)
		val streams = streamsFor(marks, *args)
		val byId = db.query("SELECT $trackColumns FROM track t WHERE t.id IN ($marks)", *args).associate { it.string("id")!! to trackOf(it, tags, streams) }
		return ids.mapNotNull { byId[it] }
	}

	/** A list's size and length before its view ([ListQuery.totals]). */
	fun totals(q: Sql): ListTotals = db.query(q.text, *q.args).first().let { ListTotals(it.int("n") ?: 0, it.long("secs") ?: 0) }

	/** The tag names a list's tracks carry, most used first ([ListQuery.tagCounts]). */
	fun tagNames(q: Sql): List<String> = db.query(q.text, *q.args).map { it.string("name")!! }

	/**
	 * Which of [sources] the library holds tracks from (Library's source
	 * picker). One EXISTS each, which stops at the first track it meets;
	 * DISTINCT over remote_source (no index) reads every track row.
	 */
	fun trackSources(sources: List<String>): Set<String> = sources.filter {
		db.query("SELECT EXISTS (SELECT 1 FROM track WHERE remote_source = ? AND deleted_at IS NULL) AS e", it).first().int("e") == 1
	}.toSet()

	fun artistName(artistId: String): String? =
		db.query("SELECT name FROM artist WHERE id = ?", artistId).takeIf { it.size > 0 }?.get(0)?.string("name")

	/** A track's credited artists in credit order, each with its artist row (track_artist, derived from track.artists). */
	fun trackArtists(trackId: String): List<ArtistRef> = db.query(
		"""
		SELECT a.id, a.name, ta.role FROM track_artist ta JOIN artist a ON a.id = ta.artist_id
		WHERE ta.track_id = ? ORDER BY ta.position
		""".trimIndent(), trackId,
	).map { ArtistRef(it.string("id")!!, it.string("name") ?: "", it.string("role")) }

	fun track(id: String): Track? {
		val rows = db.query("SELECT $trackColumns FROM track t WHERE t.id = ?", id)
		if (rows.size == 0) return null
		return trackOf(rows[0], tagsFor("SELECT ?", id), streamsFor("SELECT ?", id))
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

	// The streaming services each track has an id on, in one query: claim_link's
	// key leads with track_id. On a joined device every row is remote, so every
	// id it knows is a claimed one (no source_link rows of its own).
	private fun streamsFor(trackIdsSql: String, vararg args: Any?): Map<String, Set<String>> {
		val out = HashMap<String, MutableSet<String>>()
		for (r in db.query(
			"SELECT DISTINCT track_id, source FROM claim_link WHERE track_id IN ($trackIdsSql) AND source IN (${StreamingService.entries.joinToString(",") { "'${it.id}'" }})",
			*args,
		)) out.getOrPut(r.string("track_id")!!) { HashSet() } += r.string("source")!!
		return out
	}

	/** Whether the track carries a tag (Interested, Basket). */
	fun hasTag(trackId: String, tagId: String): Boolean =
		db.query("SELECT 1 FROM track_tag WHERE track_id = ? AND tag_id = ? LIMIT 1", trackId, tagId).size > 0

	/** The track a recording plays as on [service] (its best-ranked claim there), for the player. */
	fun streamId(trackId: String, service: String): String? =
		db.query("SELECT source_track_id FROM claim_link WHERE track_id = ? AND source = ? ORDER BY rank LIMIT 1", trackId, service)
			.takeIf { it.size > 0 }?.get(0)?.string("source_track_id")

	/**
	 * Of the library's own files (Owned), how many each streaming service has
	 * a claim for: what Settings shows beside each service. One pass over the
	 * files' claims (about 0.1 s for 5k files on a laptop), read when Settings
	 * opens, never per row.
	 */
	fun streamingCoverage(): StreamingCoverage {
		val owned = db.query("SELECT count(*) AS n FROM track t WHERE t.deleted_at IS NULL AND t.remote_source = 'local'")[0].int("n") ?: 0
		val by = db.query(
			"""
			SELECT c.source, count(DISTINCT t.id) AS n FROM track t JOIN claim_link c ON c.track_id = t.id
			WHERE t.deleted_at IS NULL AND t.remote_source = 'local'
			GROUP BY c.source
			""".trimIndent(),
		).associate { it.string("source")!! to (it.int("n") ?: 0) }
		return StreamingCoverage(owned, by)
	}

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
			// The regexes only where they can match: run on every title of a library, they cost.
			val t = title.trimEnd()
			val m = (if (t.endsWith(')') || t.endsWith(']')) versionRe.find(title) else null)
				?: (if (" - " in title) dashVersionRe.find(title) else null)
				?: return title to null
			return m.groupValues[1] to m.groupValues[2]
		}

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
	/** The streaming services it has an id on (its recording's claims there). */
	val streams: Set<String> = emptySet(),
) {
	val owned: Boolean get() = source == "local"

	/** Whether the service it plays through, with [main] picked in Settings, has it and plays here ([StreamingService.forTrack]). */
	fun foundOn(main: StreamingService): Boolean = StreamingService.forTrack(source, main).let { it.playable && it.id in streams }
}

/** A list's size and length (seconds) before its view. */
data class ListTotals(val count: Int, val seconds: Long)

@Serializable
data class PlaylistSummary(val id: String, val name: String, val source: String?, val coverUrl: String?, val folderId: String?, val tracks: Int)
@Serializable
data class Folder(val id: String, val name: String, val parentId: String?)
@Serializable
data class TagSummary(val id: String, val name: String, val system: Boolean, val tracks: Int)

/** Home's and Library's lists: every playlist (with its count and cover), folder and tag. */
@Serializable
data class Lists(val playlists: List<PlaylistSummary>, val folders: List<Folder>, val tags: List<TagSummary>)

data class ArtistRef(val id: String, val name: String, val role: String?)

/** [owned]: the library's own files; [by]: per source, how many of them it has a claim for. */
data class StreamingCoverage(val owned: Int, val by: Map<String, Int>)
data class Cue(val slot: Int, val positionSec: Double, val color: String?) {
	/** A, B, C… by slot. */
	val letter: String get() = ('A' + slot.coerceIn(0, 25)).toString()
}
data class Phrase(val startSec: Double, val endSec: Double, val label: String)
data class TrackAnalysis(val cues: List<Cue>, val beats: FloatArray, val downbeats: FloatArray, val phrases: List<Phrase>)
