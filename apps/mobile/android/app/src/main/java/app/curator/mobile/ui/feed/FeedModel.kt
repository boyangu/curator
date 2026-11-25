package app.curator.mobile.ui.feed

import androidx.compose.runtime.Stable
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.data.FeedDb
import app.curator.mobile.data.FeedKey
import app.curator.mobile.data.FeedRow
import app.curator.mobile.data.Library
import app.curator.mobile.data.holdings
import app.curator.mobile.data.playlistOwners
import app.curator.mobile.model.FeedArtist
import app.curator.mobile.model.FeedItem
import app.curator.mobile.model.FeedTrack
import app.curator.mobile.model.Heart
import app.curator.mobile.model.Held
import app.curator.mobile.model.Holdings
import app.curator.mobile.model.Slide
import app.curator.mobile.model.StreamingService
import app.curator.mobile.model.credits
import app.curator.mobile.model.slidesOf
import app.curator.mobile.player.PlayerTrack
import app.curator.mobile.ui.AppModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.File

enum class FeedFilter(val label: String) { ALL("All"), TRACKS("Tracks"), RELEASES("Releases"), LIBRARY("In library") }

/**
 * The feed as shown. Its order is read whole (ids only: a few thousand narrow
 * rows); the cards' payloads [PAGE] at a time as they scroll into view; what
 * the library holds of every track in it in one pass, again whenever the
 * library changes. All SQL is off the main thread; state changes are on it.
 */
@Stable
class FeedModel(private val model: AppModel) {
	private val scope = model.app.scope

	/** Every card shown, newest first; null until the first read. */
	private var rows by mutableStateOf<List<FeedRow>?>(null)
	private var inLibrary by mutableStateOf<Set<String>>(emptySet())
	var holdings by mutableStateOf(Holdings.EMPTY)
		private set
	var unavailable by mutableStateOf<Set<String>>(emptySet())
		private set
	var filter by mutableStateOf(FeedFilter.ALL)

	val loaded: Boolean get() = rows != null
	val shown: List<FeedRow> by derivedStateOf { rows.orEmpty().filter { matches(it, filter) } }
	val counts: Map<FeedFilter, Int> by derivedStateOf { FeedFilter.entries.associateWith { f -> rows.orEmpty().count { matches(it, f) } } }

	private fun matches(r: FeedRow, f: FeedFilter) = when (f) {
		FeedFilter.ALL -> true
		FeedFilter.TRACKS -> !r.release
		FeedFilter.RELEASES -> r.release
		FeedFilter.LIBRARY -> r.id in inLibrary
	}

	private val items = mutableStateMapOf<String, FeedItem>()
	private val fetchedAt = HashMap<String, Int>()
	private val fetching = HashSet<String>()
	// Which read of the feed an item was fetched at; one from an older read shows until refetched.
	private var read = 0

	/** Which slide each gallery is on. */
	val slideAt = mutableStateMapOf<String, Int>()
	private val owners = mutableStateMapOf<String, String>()
	private val pictures = mutableStateMapOf<String, String>()
	private val askedFor = HashSet<String>()

	var refreshing by mutableStateOf(false)
		private set
	/** A Refresh was asked for: what it brings is at the top, and so is the list once it is in. */
	var toTop by mutableStateOf(false)
	/** A line for the user, shown for a few seconds. */
	var notice by mutableStateOf<String?>(null)
	/** The feed track Play was last pressed on: why it cannot play is said on this screen. */
	var lastPlayed by mutableStateOf<String?>(null)
		private set

	// Hearts pressed but not yet in the library as read.
	private val pressed = mutableStateMapOf<String, Boolean>()

	private var keys: List<FeedKey> = emptyList()
	private var all: List<FeedRow> = emptyList()
	private val reading = Mutex()

	init {
		scope.launch { loadPictures() }
		scope.launch(Dispatchers.Main) {
			combine(model.app.feedDb, model.app.core.feed.onStart { emit(Unit) }) { db, _ -> db }.collectLatest { db -> if (db != null) reload(FeedDb(db)) }
		}
		scope.launch(Dispatchers.Main) {
			combine(model.library, model.version) { lib, _ -> lib }.collectLatest { if (it != null) reloadHoldings() }
		}
	}

	private suspend fun reload(db: FeedDb) {
		val t0 = android.os.SystemClock.elapsedRealtime()
		val (r, k, u) = withContext(Dispatchers.IO) { Triple(db.rows(), db.keys(), db.unavailable()) }
		all = r
		keys = k
		unavailable = u
		read++
		reloadHoldings()
		DiagLog.d("ui", "feed: ${r.size} cards, ${k.size} tracks read in ${android.os.SystemClock.elapsedRealtime() - t0} ms")
	}

	// The cards left out here are the desktop's (feed/service.ts
	// decorateTrackItems): a track whose file the library holds is not a
	// discovery, one the user deleted is not wanted. One marked from a card
	// stays, whatever came of it since.
	private suspend fun reloadHoldings() = reading.withLock {
		val lib = model.library.value ?: return@withLock
		val k = keys
		val r = all
		val read = withContext(Dispatchers.IO) {
			val h = lib.holdings(k)
			val out = HashSet<String>()
			val gone = HashSet<String>()
			val release = r.associate { it.id to it }
			for (key in k) {
				val held = h.of(key.isrc, key.spotifyId) ?: continue
				val row = release[key.itemId] ?: continue
				if (held.inLibrary) out += key.itemId
				if (!row.release && (held.deleted || (held.local && !row.promoted))) gone += key.itemId
			}
			Triple(h, out as Set<String>, r.filter { it.id !in gone })
		}
		if (r !== all) return@withLock
		holdings = read.first
		inLibrary = read.second
		rows = read.third
	}

	/** The card [id], or null while its page is on its way (asking fetches it). */
	fun item(index: Int, id: String): FeedItem? {
		if (fetchedAt[id] != read && id !in fetching) fetch(index)
		return items[id]
	}

	private fun fetch(index: Int) {
		val db = model.app.feedDb.value ?: return
		val from = index / PAGE * PAGE
		val at = read
		val ids = shown.drop(from).take(PAGE).map { it.id }.filter { fetchedAt[it] != at && it !in fetching }
		if (ids.isEmpty()) return
		fetching += ids
		scope.launch(Dispatchers.Main) {
			try {
				val got = withContext(Dispatchers.IO) { FeedDb(db).items(ids) }
				for (i in got) items[i.id] = i
				for (id in ids) fetchedAt[id] = at
				readOwners(got)
				askPictures(got)
			} finally {
				fetching -= ids.toSet()
			}
		}
	}

	private suspend fun readOwners(got: List<FeedItem>) {
		val lib = model.library.value ?: return
		val ids = got.mapNotNull { i -> i.origin?.takeIf { it.kind == "playlist" && it.owner?.name == null }?.id }.filter { it !in owners }.toSet()
		if (ids.isEmpty()) return
		owners += withContext(Dispatchers.IO) { lib.playlistOwners(ids) }
	}

	fun owner(item: FeedItem): String? = item.origin?.takeIf { it.kind == "playlist" }?.let { owners[it.id] }

	// ── the cards ───────────────────────────────────────────────────────────

	fun slides(item: FeedItem): List<Slide> = slidesOf(item, holdings, unavailable).map { s ->
		val now = s.track?.let { pressed[heartKey(item, it)] } ?: return@map s
		s.copy(heart = if (now) Heart.ON else Heart.OFF, ribbon = now || s.held?.local == true)
	}

	private fun heartKey(item: FeedItem, t: FeedTrack) = "${item.id}|${t.sourceTrackId ?: ""}"

	/**
	 * Interested on one track. [organize]: it was a long press, which also
	 * opens Organize once the phone has that view ([onOrganize]).
	 */
	fun heart(item: FeedItem, t: FeedTrack, held: Held?, on: Boolean, organize: Boolean = false) {
		val key = heartKey(item, t)
		if (key in pressed) return
		pressed[key] = on
		scope.launch(Dispatchers.Main) {
			val failure = try {
				// A track the library holds that Spotify lacks: only its tag moves.
				if (t.spotifyId == null && held != null) {
					model.ask("setTag", "trackId" to JsonPrimitive(held.trackId), "tagId" to JsonPrimitive("interested"), "on" to JsonPrimitive(on))
					if (organize) onOrganize(held.trackId)
					null
				} else {
					val r = model.ask(
						"feedInterested", "itemId" to JsonPrimitive(item.id), "sourceTrackId" to (t.sourceTrackId?.let(::JsonPrimitive) ?: JsonNull),
						"on" to JsonPrimitive(on), "trackId" to (held?.trackId?.let(::JsonPrimitive) ?: JsonNull),
					)?.jsonObject
					val ok = r?.get("ok")?.jsonPrimitive?.booleanOrNull == true
					if (ok && organize) r["trackId"]?.jsonPrimitive?.contentOrNull?.let(::onOrganize)
					if (ok) null else when (r?.get("reason")?.jsonPrimitive?.contentOrNull) {
						"not-on-spotify" -> NOT_ON_SPOTIFY
						"deleted" -> DELETED
						"not-ready" -> "Still syncing your library. Try again in a moment."
						else -> "That did not work."
					}
				}
			} catch (e: Exception) {
				DiagLog.w("ui", "feedInterested failed", e)
				"That did not work."
			}
			if (failure == null) reloadHoldings() else notice = failure
			pressed -= key
		}
	}

	/** The Organize view, when there is one: the track a long-pressed heart just marked. */
	@Suppress("UNUSED_PARAMETER")
	private fun onOrganize(trackId: String) = Unit

	fun dismiss(item: FeedItem) = act("feedArchive", "itemId" to JsonPrimitive(item.id))

	fun hide(item: FeedItem, artist: FeedArtist) {
		val key = artist.spotifyId ?: artist.catalogId?.let { "catalog:$it" } ?: return
		act("feedMuteArtist", "itemId" to JsonPrimitive(item.id), "artistKey" to JsonPrimitive(key))
	}

	private fun act(name: String, vararg args: Pair<String, kotlinx.serialization.json.JsonElement>) {
		scope.launch(Dispatchers.Main) {
			runCatching { model.ask(name, *args) }.onFailure {
				DiagLog.w("ui", "$name failed", it)
				notice = "That did not work."
			}
		}
	}

	fun refresh() {
		if (refreshing) return
		refreshing = true
		toTop = true
		scope.launch(Dispatchers.Main) {
			try {
				val r = model.ask("feedRefresh")?.jsonObject
				val wait = r?.get("retryAfterMs")?.jsonPrimitive?.longOrNull
				val error = r?.get("error")?.jsonPrimitive?.contentOrNull
				val n = r?.get("inserted")?.jsonPrimitive?.intOrNull ?: 0
				if (n == 0) toTop = false
				notice = when {
					wait != null -> "Try again in ${(wait + 999) / 1000} s"
					error != null -> "Could not reach Curator Cloud"
					n == 0 -> "Up to date"
					else -> "$n new"
				}
			} catch (e: Exception) {
				DiagLog.w("ui", "feedRefresh failed", e)
				toTop = false
				notice = "Could not refresh"
			} finally {
				refreshing = false
			}
		}
	}

	// ── playing ─────────────────────────────────────────────────────────────

	/** The player's id for a feed track: the library's own when it holds it, so its Track view opens. */
	fun playerId(t: FeedTrack): String? = holdings.of(t)?.takeUnless { it.deleted }?.trackId ?: t.spotifyId?.let { PREFIX + it }

	fun play(item: FeedItem, t: FeedTrack) {
		val id = playerId(t) ?: return
		val held = holdings.of(t)
		val player = model.player
		val now = player.state.value
		lastPlayed = id
		if (now.track?.trackId == id && now.playing) { player.pause(); return }
		player.load(
			PlayerTrack(
				trackId = id, title = t.title, artist = t.artists.joinToString(", "), coverUrl = item.payload.coverUrl, durationSec = t.durationSec ?: 0.0,
				source = if (held?.local == true) "local" else "spotify", service = StreamingService.SPOTIFY, streamId = t.spotifyId,
			),
		)
		player.play()
		// Nothing here can play it (no Spotify on this phone): not a listen.
		if (player.state.value.unavailable != null) return
		scope.launch {
			runCatching { model.ask("feedPlayed", "itemId" to JsonPrimitive(item.id), "sourceTrackId" to (t.sourceTrackId?.let(::JsonPrimitive) ?: JsonNull)) }
				.onFailure { DiagLog.w("ui", "feedPlayed failed", it) }
		}
	}

	// ── artist pictures ─────────────────────────────────────────────────────
	// Asked of the core for the cards a page brought, kept on the device: the
	// avatars read a map, so nothing is asked while scrolling a row into view.

	fun picture(a: FeedArtist): String? = a.key?.let { pictures[it] }

	private val picturesFile = model.app.files.feedArtists

	private suspend fun loadPictures() {
		val kept = withContext(Dispatchers.IO) { runCatching { Json.decodeFromString<Map<String, String>>(picturesFile.readText()) }.getOrNull() } ?: return
		withContext(Dispatchers.Main) { pictures.putAll(kept) }
	}

	private suspend fun askPictures(got: List<FeedItem>) {
		val want = got.flatMap { it.payload.credits.take(AVATARS) }.filter { a -> a.key != null && a.key !in pictures && askedFor.add(a.key!!) }
		if (want.isEmpty()) return
		val refs = JsonArray(want.map { a ->
			buildJsonObject {
				put("catalogId", a.catalogId?.let(::JsonPrimitive) ?: JsonNull)
				put("spotifyId", a.spotifyId?.let(::JsonPrimitive) ?: JsonNull)
			}
		})
		val answer = runCatching { model.ask("feedArtists", "refs" to refs) as? JsonObject }.onFailure { DiagLog.w("ui", "feedArtists failed", it) }.getOrNull()
		// What it could not ask is asked again when another card needs it.
		for (a in want) if (answer == null || a.key !in answer) askedFor -= a.key!!
		val found = answer.orEmpty().mapNotNull { (k, v) -> (v as? JsonPrimitive)?.contentOrNull?.let { k to it } }
		if (found.isEmpty()) return
		pictures.putAll(found)
		val all = pictures.toMap()
		withContext(Dispatchers.IO) {
			runCatching {
				val tmp = File(picturesFile.path + ".part")
				tmp.writeText(Json.encodeToString(all))
				tmp.renameTo(picturesFile)
			}.onFailure { DiagLog.w("ui", "keeping the artist pictures failed", it) }
		}
	}

	companion object {
		private const val PAGE = 20
		private const val PREFIX = "feed:"
		const val AVATARS = 3
		const val NOT_ON_SPOTIFY = "Not on Spotify yet"
		const val DELETED = "You deleted this track from your library"

		/** Whether the player's track is one the library does not hold, played from a card. */
		fun isFeedTrack(trackId: String) = trackId.startsWith(PREFIX)
	}
}
