package app.curator.mobile.update

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Where the updater is, as Settings shows it. */
sealed interface UpdateState {
	/** This build doesn't update itself: a development build, or no feed configured. */
	data class Off(val why: String) : UpdateState
	data object Idle : UpdateState
	data object Checking : UpdateState
	data class UpToDate(val checkedAt: Long) : UpdateState
	/** Newer than this build, not downloaded: automatic updates are off. */
	data class Available(val version: String) : UpdateState
	data class Downloading(val version: String, val fraction: Float) : UpdateState
	/** Downloaded and verified: installs when Curator leaves the screen (automatic), or on a tap. */
	data class Ready(val version: String) : UpdateState
	data class Installing(val version: String) : UpdateState
	data class Failed(val reason: String) : UpdateState
}

/**
 * Keeps the app on its newest release. Checks the feed ([UpdateFeed]) when
 * the app comes to the screen, at most every [CHECK_EVERY_MS]; with
 * automatic updates on (the default), downloads a newer release, verifies
 * it (size, SHA-256, signed with this app's key) and installs it once
 * Curator has left the screen and nothing plays, since an update restarts
 * the app. Off, it says one is there and installs on a tap.
 *
 * The install is a PackageInstaller session that asks for no confirmation:
 * Android 12+ lets an app update itself silently once the user has allowed
 * it to install apps (the one-time "Install unknown apps" grant). Where
 * Android still wants a confirmation, it is shown over Curator, or waits for
 * the tap in Settings.
 */
class Updater(
	private val context: Context,
	private val scope: CoroutineScope,
	private val auto: StateFlow<Boolean>,
	private val playing: () -> Boolean,
) {
	private val _state = MutableStateFlow<UpdateState>(offReason()?.let { UpdateState.Off(it) } ?: UpdateState.Idle)
	val state: StateFlow<UpdateState> = _state

	/** This build's version, as Settings shows it. */
	val version: String = BuildConfig.VERSION_NAME

	private var activity = WeakReference<Activity>(null)
	private var lastCheck = 0L
	private var job: Job? = null
	private var found: Found? = null
	// Android's confirmation, when it wants one and Curator wasn't on the screen to show it.
	private var confirm: Intent? = null

	private class Found(val release: UpdateFeed.Release, val manifest: UpdateFeed.Manifest, var file: File? = null)

	// Every change but a download's progress goes to the log: what to read when an update didn't happen.
	private fun set(s: UpdateState) {
		if (s !is UpdateState.Downloading || s.fraction == 0f) DiagLog.i("update", s.toString())
		_state.value = s
	}

	private fun offReason(): String? = when {
		BuildConfig.DEBUG -> "Development build: scripts/run.mjs installs these"
		BuildConfig.UPDATE_FEED.isEmpty() -> "Updates aren't configured in this build"
		else -> null
	}

	/** Curator is on the screen (MainActivity.onStart). */
	fun onForeground(a: Activity) {
		activity = WeakReference(a)
		confirm?.let { if (auto.value) { confirm = null; a.startActivity(it) } }
		if (System.currentTimeMillis() - lastCheck > CHECK_EVERY_MS) check()
	}

	/** Curator has left the screen (MainActivity.onStop): the moment to install a downloaded update. */
	fun onBackground() {
		activity = WeakReference(null)
		if (auto.value && _state.value is UpdateState.Ready && !playing()) install()
	}

	/** Whether Android lets Curator install its updates (the "Install unknown apps" grant). */
	fun installAllowed(): Boolean = context.packageManager.canRequestPackageInstalls()

	/** Opens the grant's page for Curator. */
	fun allowInstalls(a: Activity) {
		a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
	}

	/** Settings' button: check now, or get and install the release it found. */
	fun act() {
		when (_state.value) {
			is UpdateState.Available -> run(download = true, installAfter = true)
			is UpdateState.Ready -> confirm?.let { c -> confirm = null; activity.get()?.startActivity(c) } ?: install()
			is UpdateState.Checking, is UpdateState.Downloading, is UpdateState.Installing, is UpdateState.Off -> {}
			else -> check()
		}
	}

	fun check() = run(download = auto.value, installAfter = false)

	private fun run(download: Boolean, installAfter: Boolean) {
		if (_state.value is UpdateState.Off || job?.isActive == true) return
		job = scope.launch(Dispatchers.IO) {
			try {
				// A tap on Available takes what the check found; a check looks again.
				val f = (if (installAfter) found else null) ?: find() ?: return@launch
				if (!download) { set(UpdateState.Available(f.manifest.version)); return@launch }
				if (f.file == null) f.file = fetch(f)
				set(UpdateState.Ready(f.manifest.version))
				if (installAfter || (activity.get() == null && !playing())) withContext(Dispatchers.Main) { install() }
			} catch (e: Exception) {
				DiagLog.w("update", "update failed", e)
				set(UpdateState.Failed(e.message ?: e.javaClass.simpleName))
			}
		}
	}

	// The newest release when it is newer than this build, else null (up to date).
	private fun find(): Found? {
		set(UpdateState.Checking)
		lastCheck = System.currentTimeMillis()
		val release = UpdateFeed.newest(get(BuildConfig.UPDATE_FEED))
		if (release == null || release.versionCode <= installedCode()) {
			set(UpdateState.UpToDate(lastCheck))
			return null
		}
		val manifest = UpdateFeed.manifest(get(release.manifestUrl))
		check(manifest.versionCode == release.versionCode) { "${release.tag}'s update.json says version ${manifest.version}" }
		return Found(release, manifest).also { found = it }
	}

	// Downloads the release's APK (or keeps the copy already here) and checks it is what update.json says, signed as this app is.
	private fun fetch(f: Found): File {
		val m = f.manifest
		val url = f.release.assets[m.apk] ?: error("${f.release.tag} has no ${m.apk}")
		val dir = File(context.cacheDir, "updates").apply { mkdirs() }
		dir.listFiles()?.filter { it.name != m.apk }?.forEach { it.delete() }
		val file = File(dir, m.apk)
		if (!(file.length() == m.size && sha256(file) == m.sha256)) {
			set(UpdateState.Downloading(m.version, 0f))
			open(url).run {
				inputStream.use { input ->
					file.outputStream().use { out ->
						val buf = ByteArray(64 * 1024)
						var done = 0L
						while (true) {
							val n = input.read(buf)
							if (n < 0) break
							out.write(buf, 0, n)
							done += n
							set(UpdateState.Downloading(m.version, (done.toFloat() / m.size).coerceIn(0f, 1f)))
						}
					}
				}
			}
			check(file.length() == m.size) { "Download was ${file.length()} bytes, expected ${m.size}" }
			check(sha256(file) == m.sha256) { "Download doesn't match its checksum" }
		}
		val pm = context.packageManager
		val apk = pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: error("Download isn't an app")
		check(apk.packageName == context.packageName) { "Download is ${apk.packageName}, not Curator" }
		check(apk.longVersionCode == m.versionCode) { "Download is version ${apk.longVersionCode}, expected ${m.versionCode}" }
		val ours = signers(pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES))
		check(signers(apk).any { it in ours }) { "The update is signed with another key than this install" }
		return file
	}

	private fun install() {
		val f = found ?: return
		val file = f.file ?: return
		if (!installAllowed()) {
			set(UpdateState.Failed("Allow Curator to install apps to finish the update"))
			return
		}
		set(UpdateState.Installing(f.manifest.version))
		try {
			val installer = context.packageManager.packageInstaller
			val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
				setAppPackageName(context.packageName)
				setSize(file.length())
				if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
			}
			val id = installer.createSession(params)
			installer.openSession(id).use { session ->
				session.openWrite("base.apk", 0, file.length()).use { out ->
					file.inputStream().use { it.copyTo(out) }
					session.fsync(out)
				}
				// Mutable: the installer fills in the outcome.
				val done = PendingIntent.getBroadcast(
					context, id, Intent(context, InstallResult::class.java).setPackage(context.packageName),
					PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
				)
				session.commit(done.intentSender)
			}
		} catch (e: Exception) {
			DiagLog.w("update", "install failed", e)
			set(UpdateState.Failed(e.message ?: e.javaClass.simpleName))
		}
	}

	// The installer's answer ([InstallResult]). Success needs nothing: the app restarts as the new version.
	internal fun onInstallResult(status: Int, message: String?, confirmation: Intent?) {
		DiagLog.i("update", "installer: status $status ${message.orEmpty()}")
		val version = found?.manifest?.version ?: return
		when (status) {
			PackageInstaller.STATUS_SUCCESS -> {}
			PackageInstaller.STATUS_PENDING_USER_ACTION -> {
				val c = confirmation?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: return
				set(UpdateState.Ready(version))
				activity.get()?.startActivity(c) ?: run { confirm = c }
			}
			PackageInstaller.STATUS_FAILURE_ABORTED -> set(UpdateState.Ready(version))
			else -> set(UpdateState.Failed(message ?: "Android didn't install the update ($status)"))
		}
	}

	private fun installedCode(): Long = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode

	private fun get(url: String): String = open(url).inputStream.use { it.readBytes().decodeToString() }

	private fun open(url: String): HttpURLConnection = (URL(url).openConnection() as HttpURLConnection).apply {
		connectTimeout = 15_000
		readTimeout = 30_000
		setRequestProperty("Accept", "application/vnd.github+json, application/octet-stream")
		setRequestProperty("User-Agent", "Curator-Android/${BuildConfig.VERSION_NAME}")
		if (responseCode !in 200..299) error("$url: HTTP $responseCode")
	}

	private fun signers(p: PackageInfo): Set<String> {
		val info = p.signingInfo ?: return emptySet()
		val sigs = if (info.hasMultipleSigners()) info.apkContentsSigners else info.signingCertificateHistory
		return sigs.orEmpty().map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
	}

	private fun sha256(f: File): String {
		val d = MessageDigest.getInstance("SHA-256")
		f.inputStream().use { input ->
			val buf = ByteArray(64 * 1024)
			while (true) { val n = input.read(buf); if (n < 0) break; d.update(buf, 0, n) }
		}
		return hex(d.digest())
	}

	private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

	companion object {
		private const val CHECK_EVERY_MS = 6 * 60 * 60 * 1000L
	}
}

/** The installer's answer to an update's session (manifest: not exported; only our PendingIntent reaches it). */
class InstallResult : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		val app = context.applicationContext as app.curator.mobile.CuratorApp
		@Suppress("DEPRECATION")
		val confirmation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
		app.model.updater.onInstallResult(
			intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE),
			intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
			confirmation,
		)
	}
}
