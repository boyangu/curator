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

	// What Android kept of the end: a freeze's stacks, from the main thread's
	// on (what it was waiting on); a native crash's own last words.
	private fun traceOf(x: ApplicationExitInfo): String? {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
		return when (x.reason) {
			ApplicationExitInfo.REASON_ANR -> {
				val text = runCatching { x.traceInputStream?.bufferedReader()?.use { it.readText() } }.getOrNull() ?: return null
				val main = text.indexOf("\"main\"").coerceAtLeast(0)
				text.substring(main, minOf(text.length, main + 2_500))
			}
			// Kept from Android 12 on; nothing before.
			ApplicationExitInfo.REASON_CRASH_NATIVE -> runCatching { x.traceInputStream?.use { abortMessage(it.readBytes()) } }.getOrNull()
			else -> null
		}
	}

	/**
	 * Why a native crash aborted, from the tombstone Android keeps of it: a
	 * protobuf (debuggerd's tombstone.proto) whose top message holds the abort
	 * message as field 14 — an uncaught C++ exception's text, an assertion's.
	 * Null when the crash left none (a bad pointer says nothing) or the bytes
	 * are not that.
	 */
	internal fun abortMessage(tombstone: ByteArray): String? {
		val b = tombstone
		var i = 0
		var bad = false
		fun varint(): Long {
			var v = 0L
			var shift = 0
			while (i < b.size && shift < 64) {
				val c = b[i++].toInt()
				v = v or ((c and 0x7f).toLong() shl shift)
				if (c and 0x80 == 0) return v
				shift += 7
			}
			bad = true
			return 0
		}
		while (i < b.size) {
			val key = varint()
			if (bad) return null
			when ((key and 7).toInt()) {
				0 -> varint()
				1 -> i += 8
				5 -> i += 4
				2 -> {
					val n = varint()
					if (bad || n < 0 || n > b.size - i) return null
					if ((key ushr 3) == ABORT_MESSAGE) return String(b, i, n.toInt(), Charsets.UTF_8).trim().take(3_000).ifEmpty { null }
					i += n.toInt()
				}
				else -> return null
			}
			if (bad) return null
		}
		return null
	}

	private const val ABORT_MESSAGE = 14L

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
