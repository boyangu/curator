package app.curator.mobile.ui.entity

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
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
import app.curator.mobile.model.RowPatch
import app.curator.mobile.model.Scope
import app.curator.mobile.model.EntitySection
import app.curator.mobile.model.StreamingService
import app.curator.mobile.model.WorkEvent
import app.curator.mobile.model.WorkStatus
import app.curator.mobile.model.WorldPage
import app.curator.mobile.model.chartOff
import app.curator.mobile.model.scopedReleases
import app.curator.mobile.model.ownedReleases
import app.curator.mobile.model.toggled
import app.curator.mobile.model.merged
import app.curator.mobile.model.worldReleases
import app.curator.mobile.player.PlayerTrack
import app.curator.mobile.ui.AppModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
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
 *
 * While the page is on the screen the core reads the stores for it
 * (js/work.ts: a release's missing tracklist, a track's BPM and key): the
 * page says when it is in front ([shown], [hidden]), shows where the reading
 * is ([work]), fills its rows with what was found, and reads its World pages
 * again when the catalogue kept something. Everything here runs on the main
 * thread.
 */
@Stable
class EntityPageModel(private val model: AppModel, private val asked: EntityRef) {
	var header by mutableStateOf<EntityHeader?>(null)
		private set
	/** Why the header could not be read at all (the core threw): a retry is offered. */
	var failed by mutableStateOf(false)
		private set

	/** The World pages read so far. One value, so a reload swaps every page in one go. */
	var pages by mutableStateOf<List<WorldPage>>(emptyList())
		private set
	var loadingMore by mutableStateOf(false)
		private set
	var worldError by mutableStateOf<String?>(null)
		private set
	private var cursor: String? = null
	private var worldDone by mutableStateOf(false)
	private var moreJob: Job? = null

	/** Where the store reading for this page is, while it is in front; null when nothing is being read. */
	var work by mutableStateOf<WorkStatus?>(null)
		private set
	// What the reading found for rows the page shows, by recording.
	private var patches by mutableStateOf<Map<String, RowPatch>>(emptyMap())
	private var showing = false
	// This showing's number at the core (AppModel.watch); 0 while not watched.
	private var watch = 0
	private var watching: Job? = null
	// The page was left with stores still being read for it: the reading ended there.
	private var cutOff = false
	private var reloading = false
	private var reloadQueued = false
	private var moreAfterReload = false

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
		// Before the first World page is asked for: a read of a page the core
		// was not told is in front comes back with nothing to read at the stores.
		watchNow()
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
		// The pages are being read again: the next one is asked for after the swap, from its cursor.
		if (reloading) { moreAfterReload = true; return }
		loadingMore = true
		moreJob = model.app.scope.launch(Dispatchers.Main) {
			watching?.join()
			val r = worldPage(h, id, cursor)
			loadingMore = false
			if (r == null) { worldError = "The catalogue did not answer."; return@launch }
			worldError = null
			pages = pages + r
			cursor = r.nextCursor
			worldDone = r.nextCursor == null
			adopt(r)
		}
	}

	private suspend fun worldPage(h: EntityHeader, id: String, cursor: String?): WorldPage? = runCatching {
		model.ask(
			"entityTracks",
			"kind" to JsonPrimitive(h.ref.kind), "catalogId" to JsonPrimitive(id),
			"cursor" to cursor.json(), "libraryId" to h.ref.libraryId.json(),
		)?.let { json.decodeFromJsonElement<WorldPage>(it) }
	}.onFailure { DiagLog.w("ui", "entity tracks failed", it) }.getOrNull()

	// The page found the library artist the header could not: My Library has its files now.
	private suspend fun adopt(r: WorldPage) {
		val lib = r.libraryId ?: return
		val cur = header ?: return
		if (cur.ref.libraryId != null) return
		header = cur.copy(ref = cur.ref.copy(libraryId = lib), owned = cur.owned.copy(filter = OwnedFilter(artistIds = listOf(lib))))
		loadOwned()
	}

	/**
	 * Reads the World pages again, in place: as many as are loaded, from the
	 * start, then all of them swapped in at once. The list is never emptied
	 * and its rows keep their keys, so it stays where it is scrolled to while
	 * rows change under it. While one reload runs, one more at most waits:
	 * it reads everything the ones it stands for would have.
	 */
	private fun reload() {
		if (reloading) { reloadQueued = true; return }
		val h = header ?: return
		val id = h.ref.catalogId ?: return
		reloading = true
		model.app.scope.launch(Dispatchers.Main) {
			// A page on its way lands first: it is one of the pages to read again.
			moreJob?.join()
			watching?.join()
			val want = pages.size
			val fresh = ArrayList<WorldPage>(want)
			var next: String? = null
			var ok = want > 0
			while (ok && fresh.size < want) {
				val r = worldPage(h, id, next)
				if (r == null) { ok = false; break }
				fresh += r
				next = r.nextCursor
				if (next == null) break
			}
			// A reload that failed leaves the list as it was: the next change tries again.
			if (ok) {
				pages = fresh
				cursor = next
				worldDone = next == null
				worldError = null
				fresh.firstOrNull { it.libraryId != null }?.let { adopt(it) }
			}
			reloading = false
			if (reloadQueued) {
				reloadQueued = false
				reload()
			} else if (moreAfterReload) {
				moreAfterReload = false
				more()
			}
		}
	}

	// ── in front: the core reads the stores for this page ───────────────────

	/** The page is on the screen (again): its first showing, back from a page over it, or the app back in front. */
	fun shown() {
		showing = true
		watchNow()
		// The reading the page's leaving ended starts again with a read of the
		// page: only an answer to the page in front carries work.
		if (cutOff && watch != 0) {
			cutOff = false
			reload()
		}
	}

	/** The page left the screen, or the app did: the core stops reading for it. */
	fun hidden() {
		showing = false
		if (watch == 0) return
		cutOff = cutOff || work != null
		watch = 0
		work = null
		model.unwatch(this)
	}

	// Tells the core this page is in front, under a new number, once there is
	// a catalogue object to name; the page's reads wait on it ([watching]).
	private fun watchNow() {
		if (!showing || watch != 0) return
		val id = header?.ref?.catalogId ?: return
		val (n, told) = model.watch(this, id)
		watch = n
		watching = told
	}

	/** A `work` event of the core's: this showing's only (an earlier one's may still be on its way). */
	fun onWork(e: WorkEvent) {
		if (e.watch != watch) return
		work = e.status.takeIf { it.phase != null }
		patches = patches.merged(e.rows)
		if (e.changed) reload()
	}

	val hasMore: Boolean get() = !worldDone && header?.world?.available == true

	// ── what the list shows ─────────────────────────────────────────────────

	val worldReleases: List<EntityRelease> get() = worldReleases(pages, patches)
	val ownedReleases: List<EntityRelease> get() = ownedReleases(owned ?: emptyList())

	fun releases(): List<EntityRelease> = scopedReleases(scope, pages, owned, filters, patches)

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
