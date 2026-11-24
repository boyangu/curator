package app.curator.mobile

import android.app.Application
import android.os.Build
import app.curator.mobile.core.CoreRuntime
import app.curator.mobile.core.DevServer
import app.curator.mobile.data.NativeDb
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.io.File

/**
 * The process: the sync core starts with it and outlives every screen, and
 * the views' read connection opens once the core says the library is ready
 * (a new device installs it first).
 */
class CuratorApp : Application() {
	val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
	lateinit var core: CoreRuntime
		private set
	/** The views' shared state; lives with the process, not an activity. */
	val model: app.curator.mobile.ui.AppModel by lazy { app.curator.mobile.ui.AppModel(this) }

	private val _db = MutableStateFlow<NativeDb?>(null)
	val db: StateFlow<NativeDb?> = _db

	private val _problem = MutableStateFlow<String?>(null)
	val problem: StateFlow<String?> = _problem

	val dbPath: String get() = File(filesDir, "library.db").absolutePath

	// Set once the core has said the library is ready on this device (its install is done).
	private val installedMark: File get() = File(filesDir, "library.installed")

	override fun onCreate() {
		super.onCreate()
		core = CoreRuntime(this)
		val server = DevServer.read(this)
		if (server == null) {
			_problem.value = "No dev server configured: run the app with scripts/run.mjs"
			return
		}
		// A library this device installed before opens for the views at once:
		// the core's start (its migrate, 0.7 s) goes on beside them, and a WAL
		// reader sees the last committed state meanwhile. The core's `applied`
		// events bring the views up to date after.
		if (installedMark.exists()) scope.launch(Dispatchers.IO) { runCatching { openViews() } }
		scope.launch {
			try {
				val t0 = android.os.SystemClock.elapsedRealtime()
				val started = core.call("start", buildJsonObject {
					put("dbPath", JsonPrimitive(dbPath))
					put("peaksDir", JsonPrimitive(File(filesDir, "peaks").absolutePath))
					put("apiUrl", JsonPrimitive(server.apiUrl))
					put("userId", JsonPrimitive(server.userId))
					put("token", JsonPrimitive(server.token))
					put("deviceName", JsonPrimitive("${Build.MANUFACTURER} ${Build.MODEL}"))
					put("appVersion", JsonPrimitive(packageManager.getPackageInfo(packageName, 0).versionName ?: "0"))
				})
				core.phase.first { it == "ready" }
				openViews()
				installedMark.createNewFile()
				android.util.Log.i("curator-core", "library ready after ${android.os.SystemClock.elapsedRealtime() - t0} ms: $started")
			} catch (e: Exception) {
				_problem.value = e.message ?: e.javaClass.simpleName
			}
		}
	}

	// The views' read connection, once (the early open and the core's ready may both ask).
	private fun openViews() {
		if (_db.value != null) return
		val db = NativeDb.open(dbPath)
		if (!_db.compareAndSet(null, db)) db.close()
	}
}
