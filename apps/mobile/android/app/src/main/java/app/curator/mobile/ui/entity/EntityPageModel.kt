package app.curator.mobile.ui.entity

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.model.EntityHeader
import app.curator.mobile.model.EntityRef
import app.curator.mobile.model.EntityRelease
import app.curator.mobile.model.EntityRow
import app.curator.mobile.model.Filters
import app.curator.mobile.model.OwnedFilter
import app.curator.mobile.model.OwnedTrack
import app.curator.mobile.model.Pick
import app.curator.mobile.model.Scope
import app.curator.mobile.model.EntitySection
import app.curator.mobile.model.StreamingService
import app.curator.mobile.model.WorldPage
import app.curator.mobile.model.chartOff
import app.curator.mobile.model.scopedReleases
import app.curator.mobile.model.ownedReleases
import app.curator.mobile.model.toggled
import app.curator.mobile.model.worldReleases
import app.curator.mobile.player.PlayerTrack
import app.curator.mobile.ui.AppModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

enum class EntityTab { RELEASES, TRACKS }

/** What covers the page: the hamburger's sheet, a name's or bar's menu, Reach, About. */
sealed interface EntitySheet {
	data object Menu : EntitySheet
	data class Item(val section: EntitySection, val pick: Pick) : EntitySheet
	data object Reach : EntitySheet
	data object About : EntitySheet
}

/**
 * One artist or label page's state: kept by the app (AppModel.entityPage) for
 * as long as its stack entry may come back, so back returns to the scope,
 * filters and pages it left. The header and World pages come from the core
 * (js/entity.ts); My Library from the library file (Library.ownedOf).
 */
@Stable
class EntityPageModel(private val model: AppModel, private val asked: EntityRef) {
	var header by mutableStateOf<EntityHeader?>(null)
		private set
	/** Why the header could not be read at all (the core threw): a retry is offered. */
	var failed by mutableStateOf(false)
		private set

	val pages = mutableStateListOf<WorldPage>()
	var loadingMore by mutableStateOf(false)
		private set
	var worldError by mutableStateOf<String?>(null)
		private set
	private var cursor: String? = null
	private var worldDone = false

	var owned by mutableStateOf<List<OwnedTrack>?>(null)
		private set

	var scope by mutableStateOf(Scope.WORLD)
		private set
	var tab by mutableStateOf(EntityTab.RELEASES)
	var filters by mutableStateOf<Filters>(emptyMap())
		private set
	var charts by mutableStateOf<Set<EntitySection>>(emptySet())
		private set
	var steps by mutableStateOf<Map<EntitySection, Int>>(emptyMap())
		private set
	/** Release rows opened or closed by hand; the first stands open until it is. */
	var opened by mutableStateOf<Map<String, Boolean>>(emptyMap())
		private set
	var sheet by mutableStateOf<EntitySheet?>(null)
	/** Bumped when the list should go back to its top (a scope change). */
	var listReset by mutableStateOf(0)
		private set

	private var started = false
	private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

	fun start() {
		if (started) return
		started = true
		load()
	}

	fun retry() {
		failed = false
		load()
	}

	private fun load() = model.app.scope.launch(Dispatchers.Main) {
		val h = runCatching {
			model.ask(
				"entityPage",
				"kind" to JsonPrimitive(asked.kind), "name" to JsonPrimitive(asked.name),
				"libraryId" to asked.libraryId.json(), "catalogId" to asked.catalogId.json(),
			)?.let { json.decodeFromJsonElement<EntityHeader>(it) }
		}.onFailure { DiagLog.w("ui", "entity page failed", it) }.getOrNull()
		if (h == null) { failed = true; return@launch }
		header = h
		loadOwned()
		if (h.world.available && h.ref.catalogId != null) more()
	}

	private suspend fun loadOwned() {
		val f = header?.owned?.filter
		val lib = model.library.value
		owned = if (f == null || lib == null) emptyList() else withContext(Dispatchers.IO) { lib.ownedOf(f) }
	}

	/** The next page of World, when there is one and none is on its way. */
	fun more() {
		val h = header ?: return
		val id = h.ref.catalogId ?: return
		if (loadingMore || worldDone) return
		loadingMore = true
		model.app.scope.launch(Dispatchers.Main) {
			val r = runCatching {
				model.ask(
					"entityTracks",
					"kind" to JsonPrimitive(h.ref.kind), "catalogId" to JsonPrimitive(id),
					"cursor" to cursor.json(), "libraryId" to h.ref.libraryId.json(),
				)?.let { json.decodeFromJsonElement<WorldPage>(it) }
			}.onFailure { DiagLog.w("ui", "entity tracks failed", it) }.getOrNull()
			loadingMore = false
			if (r == null) { worldError = "The catalogue did not answer."; return@launch }
			worldError = null
			pages += r
			cursor = r.nextCursor
			worldDone = r.nextCursor == null
			// The page found the library artist the header could not: My Library has its files now.
			val lib = r.libraryId
			val cur = header
			if (lib != null && cur != null && cur.ref.libraryId == null) {
				header = cur.copy(ref = cur.ref.copy(libraryId = lib), owned = cur.owned.copy(filter = OwnedFilter(artistIds = listOf(lib))))
				loadOwned()
			}
		}
	}

	val hasMore: Boolean get() = !worldDone && header?.world?.available == true

	// ── what the list shows ─────────────────────────────────────────────────

	val worldReleases: List<EntityRelease> get() = worldReleases(pages)
	val ownedReleases: List<EntityRelease> get() = ownedReleases(owned ?: emptyList())

	fun releases(): List<EntityRelease> = scopedReleases(scope, pages, owned, filters)

	fun tracks(releases: List<EntityRelease>): List<EntityRow> = releases.flatMap { it.tracks }

	fun isOpen(index: Int, id: String): Boolean = opened[id] ?: (index == 0)

	fun toggleOpen(index: Int, id: String) {
		opened = opened + (id to !isOpen(index, id))
	}

	// ── the scope switch, charts and filters ────────────────────────────────

	fun toggleScope() {
		scope = if (scope == Scope.WORLD) Scope.OWNED else Scope.WORLD
		// The page stays where it is; the list goes back to its top.
		listReset++
	}

	fun toggleChart(s: EntitySection) {
		if (s in charts) {
			charts = charts - s
			filters = filters.chartOff(s)
		} else charts = charts + s
	}

	fun toggleFilter(s: EntitySection, p: Pick) {
		filters = filters.toggled(s, p)
	}

	fun clearFilters() {
		filters = emptyMap()
	}

	fun showMore(s: EntitySection) {
		steps = steps + (s to (steps[s] ?: 0) + 1)
	}

	// ── follow ──────────────────────────────────────────────────────────────

	/** The account's watch list only (catalog.watch / unwatch): never a follow at Spotify (2026-11-26). */
	fun toggleFollow() {
		val h = header ?: return
		val f = h.follow ?: return
		val id = h.ref.catalogId ?: return
		val want = !f.following
		header = h.copy(follow = f.copy(following = want))
		model.app.scope.launch(Dispatchers.Main) {
			runCatching { model.ask("entityFollow", "catalogId" to JsonPrimitive(id), "follow" to JsonPrimitive(want)) }
				.onFailure {
					DiagLog.w("ui", "follow failed", it)
					header?.let { cur -> header = cur.copy(follow = cur.follow?.copy(following = !want)) }
				}
		}
	}

	// ── playing ─────────────────────────────────────────────────────────────

	/**
	 * A catalogue recording the library doesn't hold plays as the feed's do,
	 * through Spotify by its id there; the mini bar shows it with no heart
	 * and no player view (there is no library track to open).
	 */
	fun playCatalogue(r: EntityRow) {
		val spotify = r.spotifyId ?: return
		val player = model.player
		val id = PREFIX + r.id
		if (player.state.value.track?.trackId == id && player.state.value.playing) { player.pause(); return }
		player.load(
			PlayerTrack(
				trackId = id, title = r.title + (r.version?.let { " ($it)" } ?: ""), artist = r.artistLine, coverUrl = r.coverUrl,
				durationSec = r.durationSec ?: 0.0, source = "spotify", service = StreamingService.SPOTIFY, streamId = spotify,
			),
		)
		player.play()
	}

	companion object {
		private const val PREFIX = "catalog:"
		fun isCatalogTrack(trackId: String) = trackId.startsWith(PREFIX)
	}
}

private fun String?.json(): JsonElement = this?.let(::JsonPrimitive) ?: JsonNull
