package app.curator.mobile.diag

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPOutputStream

/** One batch as `diagnostics.upload` takes it (packages/protocol diagnostics.ts). */
fun uploadBody(installId: String, appVersion: String, device: String, records: List<JsonObject>): String = buildJsonObject {
	put("installId", installId)
	put("appVersion", appVersion)
	put("device", device)
	put("records", JsonArray(records))
}.toString()

/**
 * Sends this phone's log to its account, while its owner allows it
 * ([allowed]) and somebody is signed in: when the app comes to the front,
 * every quarter of an hour it stays there, and when asked.
 *
 * Kotlin's own, beside the sync core: a log is most wanted when the core is
 * what broke. Only the token is the core's ([token]).
 */
class Uploader(
	private val scope: CoroutineScope,
	private val allowed: () -> Boolean,
	private val apiUrl: String?,
	private val appVersion: String,
	private val device: String,
	private val token: suspend () -> String?,
) {
	sealed interface State {
		data object Idle : State
		data object Sending : State
		data class Sent(val at: Long) : State
		data class Failed(val why: String) : State
	}

	private val _state = MutableStateFlow<State>(State.Idle)
	val state: StateFlow<State> = _state

	private val one = Mutex()
	private var loop: Job? = null

	// Until then nothing is sent on its own: the server said it doesn't take
	// logs (an older one), or to come back later.
	private var notBefore = 0L

	fun onForeground() {
		loop?.cancel()
		loop = scope.launch(Dispatchers.IO) {
			// After the app's own start.
			delay(10_000)
			while (true) {
				val due = allowed() && System.currentTimeMillis() >= notBefore
				if (due) send()
				// Not allowed (yet): a sign-in or the switch is noticed soon.
				delay(if (due) EVERY_MS else RECHECK_MS)
			}
		}
	}

	fun onBackground() {
		loop?.cancel()
		loop = null
	}

	/** Settings' button: now, whatever the last answer was. */
	fun sendNow() {
		scope.launch(Dispatchers.IO) { send() }
	}

	private suspend fun send() = one.withLock {
		val url = apiUrl ?: return@withLock
		_state.value = State.Sending
		_state.value = try {
			val t = token()
			if (t == null) State.Failed("Sign in to send logs") else { sendAll(url, t); State.Sent(System.currentTimeMillis()) }
		} catch (e: Refused) {
			notBefore = System.currentTimeMillis() + e.waitMs
			State.Failed(e.why)
		} catch (e: Exception) {
			State.Failed("Couldn’t reach the cloud")
		}
	}

	private suspend fun sendAll(url: String, token: String) = withContext(Dispatchers.IO) {
		// Bounded: more than a phone keeps, so a send always ends.
		for (round in 0 until MAX_BATCHES) {
			val (installId, batch) = DiagLog.flushed { it.installId to it.unsent(MAX_RECORDS, MAX_BYTES) } ?: return@withContext
			if (batch.isEmpty()) return@withContext
			post(url, token, uploadBody(installId, appVersion, device, batch))
			val last = batch.last()["n"].toString().toLong()
			DiagLog.flushed { it.markSent(last) }
		}
	}

	private class Refused(val why: String, val waitMs: Long) : Exception(why)

	private fun post(apiUrl: String, token: String, body: String) {
		val bytes = ByteArrayOutputStream().also { o -> GZIPOutputStream(o).use { it.write(body.toByteArray()) } }.toByteArray()
		val c = URL("$apiUrl/trpc/diagnostics.upload").openConnection() as HttpURLConnection
		try {
			c.requestMethod = "POST"
			c.connectTimeout = 15_000
			c.readTimeout = 30_000
			c.doOutput = true
			c.setFixedLengthStreamingMode(bytes.size)
			c.setRequestProperty("authorization", "Bearer $token")
			c.setRequestProperty("content-type", "application/json")
			c.setRequestProperty("content-encoding", "gzip")
			c.setRequestProperty("x-curator-client", "android/$appVersion")
			c.outputStream.use { it.write(bytes) }
			when (val status = c.responseCode) {
				in 200..299 -> c.inputStream.use { it.readBytes() }
				404 -> throw Refused("This cloud doesn’t take logs yet", DAY_MS)
				429 -> throw Refused("Enough logs for now; trying later", HOUR_MS)
				else -> throw Refused("The cloud refused (HTTP $status)", EVERY_MS)
			}
		} finally {
			c.disconnect()
		}
	}

	private companion object {
		const val EVERY_MS = 15 * 60_000L
		const val RECHECK_MS = 30_000L
		const val HOUR_MS = 3_600_000L
		const val DAY_MS = 24 * HOUR_MS
		// The protocol's caps, inside the API's 1.5 MB body.
		const val MAX_RECORDS = 300
		const val MAX_BYTES = 1_000_000
		const val MAX_BATCHES = 200
	}
}
