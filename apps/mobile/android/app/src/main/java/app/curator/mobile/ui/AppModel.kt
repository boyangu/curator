package app.curator.mobile.ui

import app.curator.mobile.CuratorApp
import app.curator.mobile.data.Library
import app.curator.mobile.data.ViewState
import app.curator.mobile.model.HomePin
import app.curator.mobile.model.TracklistRows
import app.curator.mobile.player.AppPlayer
import app.curator.mobile.ui.list.Metrics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

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

	private val _metrics = MutableStateFlow(Metrics.EMPTY)
	/** The library's power / brightness / density distributions (rows and meters show percentiles). */
	val metrics: StateFlow<Metrics> = _metrics

	init {
		app.scope.launch {
			app.db.collectLatest { db ->
				if (db == null) return@collectLatest
				val lib = Library(db)
				_library.value = lib
				reloadSettings(lib)
				reloadMetrics(lib)
				app.core.applied.collect { a ->
					reloadSettings(lib)
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

	private suspend fun reloadMetrics(lib: Library) = withContext(Dispatchers.IO) {
		_metrics.value = Metrics(lib.metricValues("power"), lib.metricValues("brightness"), lib.metricValues("density"))
	}

	private fun call(name: String, vararg args: Pair<String, JsonElement>, then: () -> Unit = {}) {
		app.scope.launch {
			runCatching { app.core.call(name, buildJsonObject { for ((k, v) in args) put(k, v) }) }
				.onFailure { android.util.Log.w("curator-ui", "$name failed", it) }
			then()
		}
	}

	private fun writeSetting(key: String, value: JsonElement) {
		pendingSettings.incrementAndGet()
		call("setSetting", "key" to JsonPrimitive(key), "value" to value) { pendingSettings.decrementAndGet() }
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
