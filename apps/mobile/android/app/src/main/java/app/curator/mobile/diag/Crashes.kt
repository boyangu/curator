package app.curator.mobile.diag

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import java.io.File

/** What ended the app: an uncaught exception as it happens, anything else from Android at the next start. */
object Crashes {
	fun install() {
		val before = Thread.getDefaultUncaughtExceptionHandler()
		Thread.setDefaultUncaughtExceptionHandler { t, e ->
			DiagLog.last("crash", "uncaught on ${t.name}", e)
			before?.uncaughtException(t, e)
		}
	}

	/** Android's record of the exits since the last start: a native crash, a freeze, memory; the app's own restarts are left out. */
	fun reportExits(context: Context, seenFile: File) {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
		runCatching {
			val seen = runCatching { seenFile.readText().trim().toLong() }.getOrDefault(0)
			val exits = context.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(null, 0, 10).filter { it.timestamp > seen }
			for (x in exits.sortedBy { it.timestamp }) {
				val name = NAMES[x.reason] ?: continue
				val data = mapOf("at" to x.timestamp, "reason" to name, "status" to x.status, "importance" to x.importance, "pssKb" to x.pss, "why" to x.description)
				if (x.reason in BAD) DiagLog.e("exit", "the last run ended: $name", null, data + ("trace" to traceOf(x)))
				else DiagLog.i("exit", "the last run ended: $name", data)
			}
			exits.maxOfOrNull { it.timestamp }?.let { seenFile.writeText(it.toString()) }
		}.onFailure { DiagLog.w("exit", "reading the exit reasons failed", it) }
	}

	// A freeze's stacks, from the main thread's on: what it was waiting on.
	private fun traceOf(x: ApplicationExitInfo): String? {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || x.reason != ApplicationExitInfo.REASON_ANR) return null
		val text = runCatching { x.traceInputStream?.bufferedReader()?.use { it.readText() } }.getOrNull() ?: return null
		val main = text.indexOf("\"main\"").coerceAtLeast(0)
		return text.substring(main, minOf(text.length, main + 2_500))
	}

	private val BAD: Set<Int>
	private val NAMES: Map<Int, String>

	init {
		// Compile-time constants of API 30, only ever compared there.
		NAMES = mapOf(
			ApplicationExitInfo.REASON_ANR to "not responding",
			ApplicationExitInfo.REASON_CRASH to "crash",
			ApplicationExitInfo.REASON_CRASH_NATIVE to "native crash",
			ApplicationExitInfo.REASON_LOW_MEMORY to "low memory",
			ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE to "too much resource use",
			ApplicationExitInfo.REASON_INITIALIZATION_FAILURE to "failed to start",
			ApplicationExitInfo.REASON_SIGNALED to "signal",
			ApplicationExitInfo.REASON_USER_REQUESTED to "closed by the user",
			ApplicationExitInfo.REASON_DEPENDENCY_DIED to "a dependency died",
			ApplicationExitInfo.REASON_OTHER to "other",
		)
		BAD = setOf(ApplicationExitInfo.REASON_ANR, ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE, ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE, ApplicationExitInfo.REASON_INITIALIZATION_FAILURE)
	}
}
