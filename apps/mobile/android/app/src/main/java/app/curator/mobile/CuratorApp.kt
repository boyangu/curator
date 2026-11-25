package app.curator.mobile

import android.app.Application
import android.content.Intent
import android.os.Build
import app.curator.mobile.core.Account
import app.curator.mobile.core.AccountVault
import app.curator.mobile.core.CloudConfig
import app.curator.mobile.core.CoreRuntime
import app.curator.mobile.core.KeystoreSealer
import app.curator.mobile.core.LibraryFiles
import app.curator.mobile.data.NativeDb
import app.curator.mobile.data.ViewState
import app.curator.mobile.diag.Crashes
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.diag.LogStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/** Where the app is on its way to a library. */
sealed interface Stage {
	data object Starting : Stage
	/** Nobody's library is here, or whose it is can't be read: the sign-in screen. */
	data object SignedOut : Stage
	data object Opening : Stage
	data object Ready : Stage
	/** [retry]: opening may work on another try (no connection during the install). */
	data class Failed(val why: String, val retry: Boolean) : Stage
}

/**
 * The process: the sync core starts with it and outlives every screen, and
 * the views' read connection opens once the core says the library is ready
 * (a new device installs it first).
 *
 * The account comes before the library (core/AccountVault). A phone with no
 * account holds no library: what an earlier one left is removed here, before
 * anything opens it. That is also how signing out ends ([signOut]): the
 * account goes, and the process starts over. Closing a library that is open
 * all over the app in place would be the larger thing to get right.
 */
class CuratorApp : Application() {
	val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
	lateinit var core: CoreRuntime
		private set
	/** The views' shared state; lives with the process, not an activity. */
	val model: app.curator.mobile.ui.AppModel by lazy { app.curator.mobile.ui.AppModel(this) }

	private val _db = MutableStateFlow<NativeDb?>(null)
	val db: StateFlow<NativeDb?> = _db

	private val _feedDb = MutableStateFlow<NativeDb?>(null)
	/** The feed's own file, which the core makes (js/entry.ts). */
	val feedDb: StateFlow<NativeDb?> = _feedDb

	private val _stage = MutableStateFlow<Stage>(Stage.Starting)
	val stage: StateFlow<Stage> = _stage

	private val _account = MutableStateFlow<Account?>(null)
	val account: StateFlow<Account?> = _account

	val files by lazy { LibraryFiles(filesDir) }
	val version: String by lazy { packageManager.getPackageInfo(packageName, 0).versionName ?: "0" }
	var cloud: CloudConfig? = null
		private set
	private lateinit var vault: AccountVault
	private val opening = Mutex()

	override fun onCreate() {
		super.onCreate()
		DiagLog.attach(LogStore(File(filesDir, "logs")))
		Crashes.install()
		DiagLog.i("app", "start", mapOf("version" to version, "device" to deviceName, "android" to Build.VERSION.SDK_INT))
		scope.launch(Dispatchers.IO) { Crashes.reportExits(this@CuratorApp, File(noBackupFilesDir, "exits-seen")) }

		vault = AccountVault(noBackupFilesDir, KeystoreSealer())
		val kept = vault.read()
		if (kept == AccountVault.State.None) {
			files.wipe()
			scope.launch { ViewState(this@CuratorApp).forgetLibrary() }
		}
		if (kept == AccountVault.State.Broken) DiagLog.w("account", "the kept account could not be read")
		_account.value = (kept as? AccountVault.State.Kept)?.account

		core = CoreRuntime(this, ::keep)
		val config = CloudConfig.read(this)
		cloud = config
		if (config == null) {
			_stage.value = Stage.Failed("This build isn’t set up for Curator’s cloud.", retry = false)
			return
		}
		// A library this device installed before opens for the views at once:
		// the core's start (its migrate, 0.7 s) goes on beside them, and a WAL
		// reader sees the last committed state meanwhile. The core's `applied`
		// events bring the views up to date after.
		if (files.installed.exists() && kept is AccountVault.State.Kept) scope.launch(Dispatchers.IO) { runCatching { openViews() } }
		scope.launch {
			try {
				core.call("boot", buildJsonObject {
					put("dbPath", files.db.absolutePath)
					put("feedDbPath", files.feedDb.absolutePath)
					put("feedWatchesPath", files.feedWatches.absolutePath)
					put("peaksDir", files.peaks.absolutePath)
					put("apiUrl", config.apiUrl)
					put("supabaseUrl", config.supabaseUrl)
					put("publishableKey", config.publishableKey)
					put("account", _account.value?.let { Json.encodeToJsonElement(Account.serializer(), it) } ?: JsonNull)
					put("deviceName", deviceName)
					put("appVersion", version)
				})
				val a = _account.value
				// Without a session a library that is here still opens; one that isn't can't be fetched.
				if (a == null || (a.tokens == null && !files.installed.exists())) _stage.value = Stage.SignedOut
				else openLibrary()
			} catch (e: Exception) {
				DiagLog.e("app", "the core did not boot", e)
				_stage.value = Stage.Failed("The sync core did not start.", retry = false)
			}
		}
	}

	private val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}"

	// The core's `session` event, on the core's thread: kept before the call
	// that caused it answers, since a rotated refresh token works once.
	private fun keep(account: Account?) {
		runCatching { vault.write(account) }.onFailure { DiagLog.e("account", "keeping the account failed", it) }
		_account.value = account
	}

	/** Opens the library, installing it first on a phone without one; again after it failed, or after a sign-in. */
	suspend fun openLibrary() = opening.withLock {
		if (_stage.value == Stage.Ready) return@withLock
		_stage.value = Stage.Opening
		try {
			val t0 = android.os.SystemClock.elapsedRealtime()
			val opened = core.call("open")
			core.phase.first { it == "ready" }
			openViews()
			openFeed()
			files.installed.createNewFile()
			_stage.value = Stage.Ready
			DiagLog.i("app", "library ready", mapOf("ms" to android.os.SystemClock.elapsedRealtime() - t0, "opened" to opened?.toString()))
		} catch (e: Exception) {
			DiagLog.e("app", "the library did not open", e)
			_stage.value = if (_account.value?.tokens == null) Stage.SignedOut else Stage.Failed("Your library couldn’t be brought here. Check the connection and try again.", retry = true)
		}
	}

	/** Ends the account here and takes its library off this phone; the app starts over, signed out. */
	suspend fun signOut(restartInto: Class<*>) {
		// The core sends what is pending, takes this phone off the account and
		// ends the session; none of that may keep anyone signed in.
		withTimeoutOrNull(25_000) { runCatching { core.call("signOut") }.onFailure { DiagLog.w("account", "signing out at the cloud failed", it) } }
		withContext(Dispatchers.IO) {
			keep(null)
			// What wasn't sent is this account's, not the next one's.
			DiagLog.flushed { it.skipUnsent() }
		}
		startActivity(Intent.makeRestartActivityTask(android.content.ComponentName(this, restartInto)))
		Runtime.getRuntime().exit(0)
	}

	/** This phone was removed from the account: a new device id, then a sign-in carries on with the library as it is. */
	suspend fun relink() {
		core.call("relink")
	}

	// The views' read connection, once (the early open and the core's ready may both ask).
	private fun openViews() {
		if (_db.value != null) return
		val db = NativeDb.open(files.db.absolutePath)
		if (!_db.compareAndSet(null, db)) db.close()
	}

	// The feed's, once the core has opened the file: a feed.db an older build
	// left may lack what this build's views read (feed_visible).
	private fun openFeed() {
		if (_feedDb.value != null) return
		val db = NativeDb.open(files.feedDb.absolutePath)
		if (!_feedDb.compareAndSet(null, db)) db.close()
	}
}
