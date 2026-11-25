package app.curator.mobile.data

import app.curator.mobile.model.FeedItem
import app.curator.mobile.model.FeedJson
import app.curator.mobile.model.Held
import app.curator.mobile.model.Holdings
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

/** A feed item in its place in the list, before any of it is read. */
data class FeedRow(val id: String, val release: Boolean, val promoted: Boolean)

/** A track a feed item carries, as what the library can be asked about. */
data class FeedKey(val itemId: String, val isrc: String?, val spotifyId: String?)

/** The feed's statements, over feed.db (packages/sync-core feed/store.ts) and the library. */
object FeedSql {
	/**
	 * Every item shown, newest first: what the store calls visible, and the
	 * track cards taken into the library since. The desktop drops those from
	 * its feed; here they stay, with the ribbon (Guy, 2026-11-25: when handled
	 * cards leave is for the next phase).
	 */
	const val ROWS = """
		SELECT id, type, state, order_ts FROM feed_visible WHERE type IN ('track', 'album')
		UNION ALL
		SELECT id, type, state, order_ts FROM feed_item WHERE state = 'promoted' AND type = 'track' AND covered_by IS NULL
		ORDER BY order_ts DESC, id DESC"""

	/**
	 * The ISRC and Spotify id of every track the shown items carry
	 * (feed/handles.ts: the handle names the Spotify id, else the item's own
	 * identity when Spotify is its source).
	 */
	const val KEYS = """
		WITH shown AS (
			SELECT id, type, source, source_id, payload_json FROM feed_visible WHERE type IN ('track', 'album')
			UNION ALL
			SELECT id, type, source, source_id, payload_json FROM feed_item WHERE state = 'promoted' AND type = 'track' AND covered_by IS NULL
		)
		SELECT s.id AS id, json_extract(s.payload_json, '$.isrc') AS isrc,
			coalesce((SELECT json_extract(h.value, '$.id') FROM json_each(s.payload_json, '$.handles') h WHERE json_extract(h.value, '$.provider') = 'spotify' LIMIT 1),
				CASE WHEN s.source = 'spotify' THEN s.source_id END) AS spotify_id
		FROM shown s WHERE s.type = 'track'
		UNION ALL
		SELECT s.id, json_extract(r.value, '$.isrc'),
			coalesce((SELECT json_extract(h.value, '$.id') FROM json_each(r.value, '$.handles') h WHERE json_extract(h.value, '$.provider') = 'spotify' LIMIT 1),
				CASE WHEN s.source = 'spotify' AND json_extract(r.value, '$.sourceTrackId') IS NOT json_extract(r.value, '$.catalogId') THEN json_extract(r.value, '$.sourceTrackId') END)
		FROM shown s JOIN json_each(s.payload_json, '$.tracks') r WHERE s.type = 'album'"""

	fun items(ids: List<String>) = Sql(
		"SELECT id, type, source, source_id, payload_json, origin_json, coalesce(published_at, fetched_at) AS at, state FROM feed_item WHERE id IN (${marks(ids)})",
		ids.toTypedArray(),
	)

	const val UNAVAILABLE = "SELECT source_track_id AS id FROM feed_unavailable"

	private const val HELD = """t.id AS id, t.remote_source = 'local' AS local, t.deleted_at IS NOT NULL AS deleted,
		EXISTS (SELECT 1 FROM track_tag x WHERE x.track_id = t.id AND x.tag_id = 'interested') AS interested"""

	// One statement each for the whole feed, the keys as one JSON array: a
	// claim_link carries no index by its source's id, so asking in chunks
	// would walk it once per chunk.
	fun heldByIsrc(isrcs: Collection<String>) = Sql(
		"SELECT t.isrc AS k, $HELD FROM track t WHERE t.isrc IN (SELECT value FROM json_each(?)) AND +t.derived_from_track_id IS NULL",
		arrayOf(array(isrcs)),
	)

	fun heldBySpotifyId(ids: Collection<String>) = Sql(
		"SELECT c.source_track_id AS k, $HELD FROM claim_link c JOIN track t ON t.id = c.track_id WHERE c.source = 'spotify' AND c.source_track_id IN (SELECT value FROM json_each(?))",
		arrayOf(array(ids)),
	)

	/** The owners of these Spotify playlists, for the ones the library holds. */
	fun owners(playlistIds: Collection<String>) = Sql(
		"SELECT source_id AS id, owner_name AS name FROM playlist WHERE source = 'spotify' AND owner_name IS NOT NULL AND source_id IN (SELECT value FROM json_each(?))",
		arrayOf(array(playlistIds)),
	)

	private fun array(values: Collection<String>) = JsonArray(values.map { JsonPrimitive(it) }).toString()
	private fun marks(ids: List<String>) = ids.joinToString(",") { "?" }
}

/** What the views read of the feed: its own file, joined to nothing (Kotlin half; the core writes it). */
class FeedDb(private val db: NativeDb) {
	fun rows(): List<FeedRow> = db.query(FeedSql.ROWS).map { FeedRow(it.string("id")!!, it.string("type") == "album", it.string("state") == "promoted") }

	fun keys(): List<FeedKey> = db.query(FeedSql.KEYS).map { FeedKey(it.string("id")!!, it.string("isrc"), it.string("spotify_id")) }

	/** These items, in no order; one whose payload cannot be read is left out. */
	fun items(ids: List<String>): List<FeedItem> {
		if (ids.isEmpty()) return emptyList()
		val q = FeedSql.items(ids)
		return db.query(q.text, *q.args).mapNotNull { r ->
			FeedItem(
				id = r.string("id")!!, type = r.string("type")!!, source = r.string("source")!!, sourceId = r.string("source_id")!!,
				payload = FeedJson.payload(r.string("payload_json")!!) ?: return@mapNotNull null,
				origin = FeedJson.origin(r.string("origin_json")), date = r.long("at")!!, state = r.string("state")!!,
			)
		}
	}

	fun unavailable(): Set<String> = db.query(FeedSql.UNAVAILABLE).mapTo(HashSet()) { it.string("id")!! }
}

/** What the library holds of these feed tracks. */
fun Library.holdings(keys: List<FeedKey>): Holdings {
	fun read(q: Sql): Map<String, Held> {
		val out = HashMap<String, Held>()
		for (r in query(q)) {
			val h = Held(r.string("id")!!, interested = r.bool("interested"), local = r.bool("local"), deleted = r.bool("deleted"))
			val k = r.string("k")!!
			// Twins of one recording: a live row speaks, and the one marked.
			val cur = out[k]
			if (cur == null || (cur.deleted && !h.deleted) || (cur.deleted == h.deleted && h.interested && !cur.interested)) out[k] = h
		}
		return out
	}
	val isrcs = keys.mapNotNullTo(HashSet()) { it.isrc }
	val ids = keys.mapNotNullTo(HashSet()) { it.spotifyId }
	return Holdings(
		if (isrcs.isEmpty()) emptyMap() else read(FeedSql.heldByIsrc(isrcs)),
		if (ids.isEmpty()) emptyMap() else read(FeedSql.heldBySpotifyId(ids)),
	)
}

fun Library.playlistOwners(spotifyIds: Collection<String>): Map<String, String> =
	if (spotifyIds.isEmpty()) emptyMap() else query(FeedSql.owners(spotifyIds)).associate { it.string("id")!! to it.string("name")!! }
