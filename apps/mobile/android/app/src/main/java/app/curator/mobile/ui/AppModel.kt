package app.curator.mobile.ui

import android.os.Build
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.diag.Uploader
import app.curator.mobile.CuratorApp
import app.curator.mobile.data.Library
import app.curator.mobile.data.ListQuery
import app.curator.mobile.data.Lists
import app.curator.mobile.data.Track
import app.curator.mobile.data.ViewState
import app.curator.mobile.model.HomePin
import app.curator.mobile.model.StreamingService
import app.curator.mobile.model.TracklistRows
import app.curator.mobile.player.AppPlayer
import app.curator.mobile.update.Updater
import app.curator.mobile.ui.feed.FeedModel
import app.curator.mobile.ui.list.Metrics
import app.curator.mobile.ui.list.TrackPager
import app.curator.mobile.ui.list.playFrom
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import java.io.File
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * What every screen shares: the library (once open), a change counter the
 * views reload on, the synced settings (row layout, Home's pins), this
 * device's view state, the player, and the edits.
 *
 * An edit goes to the sync core (the desktop's own writers, js/entry.ts),
 * which writes the row and its op; the core's `applied` event then bumps
 * [version] and the views reload. Settings change locally at once and are
 * written behind, so a drag in the row editor never waits on a write.
 */
class AppModel(val app: CuratorApp) {
	val viewState = ViewState(app)
	val player = AppPlayer()

	private val _library = MutableStateFlow<Library?>(null)
	val library: StateFlow<Library?> = _library

	private val _version = MutableStateFlow(0)
	/** Bumped whenever the library changed: a pull applied rows, or an edit here. */
	val version: StateFlow<Int> = _version

	private val _rows = MutableStateFlow(TracklistRows.DEFAULTS)
	val rows: StateFlow<TracklistRows> = _rows

	private val _pins = MutableStateFlow<List<HomePin>>(emptyList())
	val pins: StateFlow<List<HomePin>> = _pins

	/** Where the library's own files play from on this phone (Settings; per device). */
	val streaming: StateFlow<StreamingService> = viewState.streaming.stateIn(app.scope, SharingStarted.Eagerly, StreamingService.DEFAULT)

	fun setStreaming(s: StreamingService) {
		app.scope.launch { viewState.setStreaming(s) }
	}

	val autoUpdate: StateFlow<Boolean> = viewState.autoUpdate.stateIn(app.scope, SharingStarted.Eagerly, true)

	fun setAutoUpdate(on: Boolean) {
		app.scope.launch { viewState.setAutoUpdate(on) }
	}

	/** Installs new releases: never mid-play, since an update restarts the app and the player follows the service from it. */
	val updater = Updater(app, app.scope, autoUpdate, playing = { player.state.value.playing })

	val diagnostics: StateFlow<Boolean> = viewState.diagnostics.stateIn(app.scope, SharingStarted.Eagerly, true)

	fun setDiagnostics(on: Boolean) {
		app.scope.launch { viewState.setDiagnostics(on) }
	}

	/** Sends this phone's log while its owner allows it. */
	val logs = Uploader(
		app.scope,
		allowed = { diagnostics.value && app.account.value?.tokens != null },
		apiUrl = app.cloud?.apiUrl,
		appVersion = app.version,
		device = "${Build.MANUFACTURER} ${Build.MODEL} (Android ${Build.VERSION.RELEASE})",
		token = { (app.core.call("accessToken") as? JsonPrimitive)?.contentOrNull },
	)

	// ── the account ──

	// A phone that was removed from the account signs in as a new device.
	private suspend fun freshDevice() { if (app.core.status.value?.revoked == true) app.relink() }

	suspend fun signInPassword(email: String, password: String) { freshDevice(); ask("signInPassword", "email" to JsonPrimitive(email), "password" to JsonPrimitive(password)) }
	suspend fun requestCode(email: String) { ask("requestCode", "email" to JsonPrimitive(email)) }
	suspend fun setPassword(password: String) { ask("setPassword", "password" to JsonPrimitive(password)) }
	suspend fun verifyCode(email: String, code: String) { freshDevice(); ask("verifyCode", "email" to JsonPrimitive(email), "code" to JsonPrimitive(code)) }

	private val _lists = MutableStateFlow<Lists?>(null)
	/**
	 * Home's and Library's lists. Opening the app shows the copy kept on the
	 * device from the last read (Home's counts are a pass over every
	 * membership row: 7 ms warm, a quarter second while the app and its sync
	 * core start up), then the library's own, read again on every change.
	 */
	val lists: StateFlow<Lists?> = _lists
	private val listsFile = app.files.lists
	private val json = Json { ignoreUnknownKeys = true }

	/** The Feed tab's list: lives with the process, so a visit elsewhere keeps its place. */
	val feed: FeedModel by lazy { FeedModel(this) }

	private val _metrics = MutableStateFlow(Metrics.EMPTY)
	/** The library's power / brightness / density distributions (rows and meters show percentiles). */
	val metrics: StateFlow<Metrics> = _metrics

	init {
		app.scope.launch(Dispatchers.IO) {
			val kept = runCatching { json.decodeFromString<Lists>(listsFile.readText()) }.getOrNull()
			_lists.compareAndSet(null, kept)
		}
		app.scope.launch {
			app.db.collectLatest { db ->
				if (db == null) return@collectLatest
				val lib = Library(db)
				_library.value = lib
				reloadSettings(lib)
				reloadLists(lib)
				reloadMetrics(lib)
				app.core.applied.collect { a ->
					reloadSettings(lib)
					reloadLists(lib)
					// New analysis arrives with pulled tracks, never with a local edit.
					if (a.tracks > 1) reloadMetrics(lib)
					_version.value++
				}
			}
		}
	}

	// Setting writes still on their way to the core: while one is, a reload
	// would show an older value for a moment (two quick edits in the row
	// editor), so the stored value is read only once none are.
	private val pendingSettings = java.util.concurrent.atomic.AtomicInteger(0)

	private suspend fun reloadSettings(lib: Library) = withContext(Dispatchers.IO) {
		if (pendingSettings.get() > 0) return@withContext
		_rows.value = lib.tracklistRows()
		_pins.value = lib.homePins()
	}

	private suspend fun reloadLists(lib: Library) = withContext(Dispatchers.IO) {
		val fresh = lib.lists()
		if (fresh == _lists.value) return@withContext
		_lists.value = fresh
		runCatching {
			val tmp = File(listsFile.path + ".part")
			tmp.writeText(json.encodeToString(fresh))
			tmp.renameTo(listsFile)
		}.onFailure { DiagLog.w("ui", "keeping the lists failed", it) }
	}

	private suspend fun reloadMetrics(lib: Library) = withContext(Dispatchers.IO) {
		_metrics.value = Metrics(lib.metricValues("power"), lib.metricValues("brightness"), lib.metricValues("density"))
	}

	/** One call into the core with its answer; throws what it throws. */
	suspend fun ask(name: String, vararg args: Pair<String, JsonElement>): JsonElement? = app.core.call(name, buildJsonObject { for ((k, v) in args) put(k, v) })

	private fun call(name: String, vararg args: Pair<String, JsonElement>, then: () -> Unit = {}) {
		app.scope.launch {
			runCatching { ask(name, *args) }
				.onFailure { DiagLog.w("ui", "$name failed", it) }
			then()
		}
	}

	private fun writeSetting(key: String, value: JsonElement) {
		pendingSettings.incrementAndGet()
		call("setSetting", "key" to JsonPrimitive(key), "value" to value) { pendingSettings.decrementAndGet() }
	}

	// The last few lists' pagers, most recent last: the list, its Actions page
	// and the Track view's Next share one (same query, same rows), and going
	// back to a list finds its pages still there.
	private val pagers = object : LinkedHashMap<Any, TrackPager>(8, 0.75f, true) {
		override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Any, TrackPager>) = size > 6
	}

	/** The pager reading [query] (main thread: the views ask while composing). */
	fun pager(query: ListQuery): TrackPager {
		val lib = checkNotNull(_library.value) { "no library yet" }
		return pagers.getOrPut(query.key) { TrackPager(lib, query, app.scope, _version.value) }
	}

	/**
	 * Loads a track into the player, and plays it when [start]: from a row's
	 * tap or Next. On the app's scope (main thread, as App Remote wants): the
	 * screen that asked is covered or replaced by Track at once, and its own
	 * scope goes with it, mid-lookup.
	 */
	fun open(t: Track, start: Boolean) {
		app.scope.launch(Dispatchers.Main) { playFrom(this@AppModel, t, start) }
	}

	fun setRating(trackId: String, rating: Int?) = call("setRating", "trackId" to JsonPrimitive(trackId), "rating" to (rating?.let { JsonPrimitive(it) } ?: JsonNull))

	fun setTag(trackId: String, tagId: String, on: Boolean) = call("setTag", "trackId" to JsonPrimitive(trackId), "tagId" to JsonPrimitive(tagId), "on" to JsonPrimitive(on))

	/** Takes Interested off and deletes nothing (decided 2026-11-23; js/entry.ts). */
	fun notInterested(trackId: String) = call("notInterested", "trackId" to JsonPrimitive(trackId))

	fun setRows(next: TracklistRows) {
		if (!next.isValid() || next == _rows.value) return
		_rows.value = next
		writeSetting("tracklist.rows", next.toJson())
	}

	fun setPins(next: List<HomePin>) {
		if (next == _pins.value) return
		_pins.value = next
		writeSetting("home.pins", HomePin.toJson(next))
	}

	fun togglePin(pin: HomePin) {
		val now = _pins.value
		setPins(if (pin in now) now - pin else now + pin)
	}
}
