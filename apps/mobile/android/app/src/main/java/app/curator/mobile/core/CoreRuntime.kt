package app.curator.mobile.core

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import app.curator.mobile.diag.DiagLog
import app.curator.mobile.model.WorkEvent
import app.curator.mobile.model.parseWork
import androidx.annotation.Keep
import com.facebook.soloader.nativeloader.NativeLoader
import com.facebook.soloader.nativeloader.SystemDelegate
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The sync core (the desktop's sync client and library writers, run in
 * Hermes; js/entry.ts) and the one thread it lives on.
 *
 * Everything that touches the runtime runs on [thread]: starting it, calls,
 * HTTP answers, and the timer loop. The loop is driven from here, not spun
 * natively: [nativeRun] runs what is due for a few milliseconds and answers
 * when the next timer is due, and the next run is posted for then, so a call
 * or an HTTP answer never waits behind a long pull for more than a slice.
 *
 * HTTP is the platform's (TLS, transparent gzip) on a small pool; answers go
 * back to the core's thread. The catalogue readers' HTTP to the stores is its
 * own seam ([StoreFetch]): headers back, calls that can be cut, Beatport
 * through a WebView.
 */
class CoreRuntime(private val context: Context, private val onSession: (Account?) -> Unit) {
	private val thread = HandlerThread("curator-core").apply { start() }
	private val handler = Handler(thread.looper)
	private val http = Executors.newFixedThreadPool(4)
	private var nextCall = 1
	private val calls = ConcurrentHashMap<Int, CompletableDeferred<JsonElement?>>()

	private val _phase = MutableStateFlow("starting")
	/** starting → installing (a new device's library) → opening → ready; or failed. */
	val phase: StateFlow<String> = _phase

	private val _status = MutableStateFlow<SyncStatus?>(null)
	val status: StateFlow<SyncStatus?> = _status

	private val _applied = MutableSharedFlow<Applied>(extraBufferCapacity = 64)
	/** The library changed (a pull applied rows, or a local write): views reload. */
	val applied: SharedFlow<Applied> = _applied

	private val _feed = MutableSharedFlow<Unit>(extraBufferCapacity = 1, onBufferOverflow = BufferOverflow.DROP_OLDEST)
	/** feed.db changed: the feed reloads. */
	val feed: SharedFlow<Unit> = _feed

	private val _work = MutableSharedFlow<WorkEvent>(extraBufferCapacity = 256)
	/** The store reading for the artist or label page in front: where it is and what it found (js/work.ts). */
	val work: SharedFlow<WorkEvent> = _work

	/** The stores' side of that reading: the HTTP the core's readers ask for (js/shim/store-fetch.ts). */
	val stores = StoreFetch { tell("fetchDone", it) }

	private val runner = Runnable { runLoop() }

	init {
		handler.post {
			val bytes = context.assets.open("core.hbc").use { it.readBytes() }
			if (!nativeCreate(bytes)) {
				_phase.value = "failed"
				DiagLog.e("core", "the bundle did not load")
			}
			runLoop()
		}
	}

	/** One call into the core; resumes with its answer, or throws its error. */
	suspend fun call(name: String, arg: JsonObject = JsonObject(emptyMap())): JsonElement? {
		val answer = CompletableDeferred<JsonElement?>()
		handler.post {
			val id = nextCall++
			calls[id] = answer
			nativeDispatch(name, arg.toString(), id)
			runLoop()
		}
		return answer.await()
	}

	// A call nobody waits on: its `result` finds no one and is dropped (onEmit).
	private fun tell(name: String, arg: JsonObject) {
		handler.post {
			nativeDispatch(name, arg.toString(), nextCall++)
			runLoop()
		}
	}

	private fun runLoop() {
		handler.removeCallbacks(runner)
		when (val next = nativeRun(SLICE_MS)) {
			-1 -> Unit
			0 -> handler.post(runner)
			else -> handler.postDelayed(runner, next.toLong())
		}
	}

	// ── called by the native host, on the core's thread ─────────────────────

	@Keep
	private fun onEmit(json: String) {
		val e = runCatching { Json.parseToJsonElement(json).jsonObject }.getOrNull() ?: return
		when (e["type"]?.jsonPrimitive?.contentOrNull) {
			"result" -> {
				val id = e["id"]?.jsonPrimitive?.int ?: return
				val deferred = calls.remove(id) ?: return
				if (e["ok"]?.jsonPrimitive?.booleanOrNull == true) deferred.complete(e["value"])
				else deferred.completeExceptionally(CoreError(e["error"]?.jsonPrimitive?.contentOrNull ?: "the core failed"))
			}
			"phase" -> _phase.value = e["phase"]?.jsonPrimitive?.contentOrNull ?: return
			"status" -> _status.value = SyncStatus(
				lastSeq = e["lastSeq"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0,
				pending = e["pending"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 0,
				error = (e["error"] as? JsonPrimitive)?.contentOrNull,
				revoked = e["revoked"]?.jsonPrimitive?.booleanOrNull == true,
				needsUpdate = e["needsUpdate"]?.jsonPrimitive?.booleanOrNull == true,
				waiting = e["waiting"]?.jsonPrimitive?.booleanOrNull == true,
				joining = e["joining"]?.jsonPrimitive?.booleanOrNull == true,
			)
			"session" -> onSession(e["account"]?.takeIf { it !is JsonNull }?.let { Json.decodeFromJsonElement(Account.serializer(), it) })
			"log" -> (e["record"] as? JsonObject)?.let(DiagLog::record)
			"feed" -> _feed.tryEmit(Unit)
			"applied" -> _applied.tryEmit(Applied(tracks = e["tracks"]?.jsonPrimitive?.int ?: 0, playlists = e["playlists"]?.jsonPrimitive?.int ?: 0))
			"fetch" -> stores.fetch(e)
			"fetchAbort" -> stores.abort((e["id"] as? JsonPrimitive)?.intOrNull ?: return)
			"work" -> parseWork(e)?.let(_work::tryEmit)
		}
	}

	@Keep
	private fun onHttp(id: Int, method: String, url: String, headersJson: String, body: ByteArray?) {
		http.execute {
			val t0 = android.os.SystemClock.elapsedRealtime()
			var status = 0
			var bytes: ByteArray? = null
			var error: String? = null
			try {
				val conn = URL(url).openConnection() as HttpURLConnection
				conn.requestMethod = method
				conn.connectTimeout = 15_000
				conn.readTimeout = 60_000
				// Accept-Encoding is left to the platform: it asks for gzip and
				// inflates the answer itself (what fetch-transport.ts expects).
				for ((k, v) in Json.parseToJsonElement(headersJson).jsonObject) conn.setRequestProperty(k, v.jsonPrimitive.content)
				if (body != null) {
					conn.doOutput = true
					conn.setFixedLengthStreamingMode(body.size)
					conn.outputStream.use { it.write(body) }
				}
				status = conn.responseCode
				val stream = if (status >= 400) conn.errorStream else conn.inputStream
				bytes = stream?.use { readAll(it, conn.contentLengthLong) } ?: ByteArray(0)
				conn.disconnect()
			} catch (e: Exception) {
				error = e.message ?: e.javaClass.simpleName
			}
			val fetched = android.os.SystemClock.elapsedRealtime()
			handler.post {
				val handed = android.os.SystemClock.elapsedRealtime()
				nativeHttpDone(id, status, bytes, error)
				if ((bytes?.size ?: 0) > 1 shl 20) DiagLog.d("core", "http ${bytes!!.size shr 10} KB: fetch ${fetched - t0} ms, wait ${handed - fetched} ms, hand-over ${android.os.SystemClock.elapsedRealtime() - handed} ms")
				runLoop()
			}
		}
	}

	// The whole body in large reads: into an array of the announced size when
	// the answer says it (a replica part, 4–8 MB), no second copy.
	private fun readAll(input: java.io.InputStream, length: Long): ByteArray {
		if (length in 0..Int.MAX_VALUE.toLong()) {
			val out = ByteArray(length.toInt())
			var at = 0
			while (at < out.size) {
				val n = input.read(out, at, out.size - at)
				if (n < 0) throw java.io.EOFException("the answer ended at $at of ${out.size} bytes")
				at += n
			}
			return out
		}
		val out = ByteArrayOutputStream(1 shl 16)
		val buf = ByteArray(1 shl 18)
		while (true) {
			val n = input.read(buf)
			if (n < 0) break
			out.write(buf, 0, n)
		}
		return out.toByteArray()
	}

	private external fun nativeCreate(bytecode: ByteArray): Boolean
	private external fun nativeDispatch(name: String, argJson: String, id: Int)
	private external fun nativeHttpDone(id: Int, status: Int, body: ByteArray?, error: String?)
	private external fun nativeRun(budgetMs: Int): Int

	/** [waiting]: the account has no library to bring here yet (its computer publishes it); [joining]: it is being brought, row by row. */
	data class SyncStatus(val lastSeq: Long, val pending: Int, val error: String?, val revoked: Boolean, val needsUpdate: Boolean, val waiting: Boolean, val joining: Boolean)
	data class Applied(val tracks: Int, val playlists: Int)
	class CoreError(message: String) : Exception(message)

	companion object {
		// How long one turn of the core may hold its thread before a queued
		// call or HTTP answer gets its turn.
		private const val SLICE_MS = 8

		init {
			// fbjni's own Java side loads its library through SoLoader's
			// NativeLoader, which refuses until it is told how. Hermes reaches
			// that side for Intl (the first `localeCompare`), and the refusal
			// comes back as a C++ exception nothing catches: the process aborts.
			NativeLoader.initIfUninitialized(SystemDelegate())
			// fbjni first: its JNI_OnLoad keeps the VM, which Hermes needs for
			// Unicode work and its finalizer thread.
			for (lib in listOf("fbjni", "jsi", "hermesvm", "curator")) System.loadLibrary(lib)
			DiagLog.d("core", "native libraries loaded")
		}
	}
}
