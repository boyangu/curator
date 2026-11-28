package app.curator.mobile.core

import android.app.Activity
import android.os.SystemClock
import android.webkit.WebView
import app.curator.mobile.diag.DiagLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The Activity on the screen, for what needs a window to work in: the hidden
 * WebView that reads Beatport ([StoreFetch]) lives in the Activity's window,
 * and the core that asks for a page knows no Activity. The Activity says when
 * it is in front (resumed) and when it no longer is (paused, destroyed), so
 * none is ever held past its time.
 */
object FrontWindow {
	@Volatile
	var activity: Activity? = null
		private set

	fun resumed(a: Activity) {
		activity = a
	}

	fun gone(a: Activity) {
		if (activity === a) activity = null
	}
}

/**
 * HTTP to the stores for the core's catalogue readers (js/shim/store-fetch.ts;
 * the reading itself is js/work.ts): the core emits `fetch`, this answers
 * `fetchDone` — once for every call the core did not give up on (`fetchAbort`)
 * first. An answer the core no longer waits for finds nobody there, so one too
 * many is harmless and one too few holds a reader until its timeout.
 *
 * Unlike the core's own HTTP ([CoreRuntime]'s onHttp: a status and bytes) an
 * answer here carries the response's headers (Retry-After, Cloudflare's
 * challenge mark) and the call can be cut.
 *
 * Two ways out, the core's choice (`via`):
 *  - "http": the platform's client, a few calls at a time;
 *  - "beatport": Beatport turns a plain client away, so its pages are read in
 *    the hidden WebView ([BeatportWebView]) of the Activity in front
 *    ([FrontWindow]), one page at a time, and answered as the page a plain
 *    client would have got: the page's data in its `__NEXT_DATA__` tag.
 */
class StoreFetch(
	/** A development build's stand-ins for stores, by URL prefix ([CloudConfig.stores]); empty in a release. */
	private val standIns: Map<String, String> = emptyMap(),
	private val answer: (JsonObject) -> Unit,
) {
	/** A `fetch` event: what to ask, and the id to answer with. */
	data class Ask(val id: Int, val via: String, val method: String, val url: String, val headers: Map<String, String>, val body: String?) {
		companion object {
			/** Null only without an id: anything else is answered, if only with why not. */
			fun of(e: JsonObject): Ask? {
				fun text(k: String) = (e[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
				val id = (e["id"] as? JsonPrimitive)?.intOrNull ?: return null
				val headers = (e["headers"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.contentOrNull?.let { k to it } }?.toMap() ?: emptyMap()
				return Ask(id, text("via") ?: "http", text("method") ?: "GET", text("url") ?: "", headers, text("body"))
			}
		}
	}

	/** A `fetchDone` call. [error]: why there is no response; "device: …" when the phone itself could not ask. */
	data class Answer(val id: Int, val status: Int = 0, val headers: Map<String, String> = emptyMap(), val body: String? = null, val error: String? = null) {
		fun toJson(): JsonObject = buildJsonObject {
			put("id", id)
			put("status", status)
			put("headers", JsonObject(headers.mapValues { JsonPrimitive(it.value) }))
			put("body", body)
			put("error", error)
		}
	}

	// ── called by the core, on its thread ───────────────────────────────────

	fun fetch(e: JsonObject) {
		val ask = Ask.of(e) ?: return
		when (ask.via) {
			"http" -> http(ask)
			"beatport" -> main.launch {
				waiting += ask
				pump()
			}
			else -> answer(Answer(ask.id, error = "no way to read via ${ask.via}").toJson())
		}
	}

	/** The core gave up on a call: cut if still running, and never answered. */
	fun abort(id: Int) {
		calls.remove(id)?.let { call ->
			call.aborted = true
			// From another thread on purpose: it is what ends a call blocked in a read.
			runCatching { call.conn?.disconnect() }
			return
		}
		main.launch {
			if (waiting.removeAll { it.id == id }) return@launch
			val r = reading?.takeIf { it.id == id } ?: return@launch
			reading = null
			r.job.cancel()
			reader?.stop()
			pump()
		}
	}

	/**
	 * No page is watched any more, or the app left the screen: the WebView
	 * goes (it belongs to a window nobody looks at), and the pages it was to
	 * read are answered as the phone's own trouble. The core has given up on
	 * them by itself when it was told the page was left.
	 */
	fun release() {
		main.launch {
			val left = waiting.map { it.id } + listOfNotNull(reading?.id)
			waiting.clear()
			reading?.job?.cancel()
			reading = null
			idle?.cancel()
			closeReader()
			for (id in left) answer(Answer(id, error = LEFT).toJson())
		}
	}

	// ── plain HTTP ──────────────────────────────────────────────────────────

	private class HttpCall {
		@Volatile var conn: HttpURLConnection? = null
		@Volatile var aborted = false
	}

	private val pool = Executors.newFixedThreadPool(4) { Thread(it, "curator-stores").apply { isDaemon = true } }
	private val calls = ConcurrentHashMap<Int, HttpCall>()

	private fun http(ask: Ask) {
		val call = HttpCall()
		calls[ask.id] = call
		pool.execute {
			val t0 = SystemClock.elapsedRealtime()
			val a = get(ask, call)
			// Given up on meanwhile: the abort took the call out, and its answer is dropped.
			if (!calls.remove(ask.id, call)) return@execute
			DiagLog.d(AREA, "http ${hostOf(ask.url)} ${a.error ?: a.status} ${a.body?.length ?: 0} chars ${SystemClock.elapsedRealtime() - t0} ms")
			answer(a.toJson())
		}
	}

	private fun get(ask: Ask, call: HttpCall): Answer {
		// The stores are all read over TLS; nothing else leaves from here.
		if (!ask.url.startsWith("https://", ignoreCase = true)) return Answer(ask.id, error = "only https is read")
		val target = standIns.entries.firstOrNull { ask.url.startsWith(it.key) }?.let { it.value + ask.url.removePrefix(it.key) } ?: ask.url
		return try {
			val conn = URL(target).openConnection() as HttpURLConnection
			call.conn = conn
			if (call.aborted) return Answer(ask.id, error = "aborted")
			conn.requestMethod = ask.method
			conn.connectTimeout = 15_000
			conn.readTimeout = 30_000
			conn.instanceFollowRedirects = true
			// Accept-Encoding stays the platform's: it asks for gzip and inflates
			// the answer itself; a reader that named one would get the bytes as sent.
			for ((k, v) in ask.headers) if (!k.equals("accept-encoding", ignoreCase = true)) conn.setRequestProperty(k, v)
			ask.body?.encodeToByteArray()?.let { bytes ->
				conn.doOutput = true
				conn.setFixedLengthStreamingMode(bytes.size)
				conn.outputStream.use { it.write(bytes) }
			}
			val status = conn.responseCode
			val headers = responseHeaders(conn.headerFields)
			val body = (if (status >= 400) conn.errorStream else conn.inputStream)?.use { readCapped(it, MAX_BODY) } ?: ByteArray(0)
			conn.disconnect()
			if (body.size > MAX_BODY) Answer(ask.id, error = "the answer is over ${MAX_BODY shr 20} MB")
			else Answer(ask.id, status, headers, body.decodeToString())
		} catch (e: Exception) {
			Answer(ask.id, error = e.message ?: e.javaClass.simpleName)
		}
	}

	// ── Beatport, in the hidden WebView (everything below on the main thread) ─

	private class Reading(val id: Int, val job: Job)

	private val main = CoroutineScope(SupervisorJob() + Dispatchers.Main)
	private val waiting = ArrayDeque<Ask>()
	private var reading: Reading? = null
	private var reader: BeatportWebView? = null
	private var readerOf: Activity? = null
	private var idle: Job? = null

	// The next page, when none is being read: one WebView, one page at a time.
	private fun pump() {
		if (reading != null) return
		val ask = waiting.removeFirstOrNull()
		if (ask == null) {
			// Kept for the next page of this visit (its cookies, Cloudflare's
			// pass among them, and a second or so of start-up), not for good.
			idle?.cancel()
			idle = main.launch {
				delay(IDLE_MS)
				closeReader()
			}
			return
		}
		idle?.cancel()
		val job = main.launch(start = CoroutineStart.LAZY) {
			val a = try {
				read(ask)
			} catch (e: CancellationException) {
				throw e
			} catch (e: Exception) {
				// A WebView that can't be made (its package is being updated), a window that went away mid-read.
				DiagLog.w(AREA, "the Beatport reader failed", e)
				Answer(ask.id, error = "device: ${e.message ?: e.javaClass.simpleName}")
			}
			// Given up on while the answer was made: someone else's turn already.
			ensureActive()
			reading = null
			answer(a.toJson())
			pump()
		}
		reading = Reading(ask.id, job)
		job.start()
	}

	private suspend fun read(ask: Ask): Answer {
		if (!isBeatportUrl(ask.url)) return Answer(ask.id, error = "not a Beatport page")
		if (WebView.getCurrentWebViewPackage() == null) return Answer(ask.id, error = NO_WEBVIEW)
		val activity = FrontWindow.activity?.takeIf { !it.isFinishing && !it.isDestroyed } ?: return Answer(ask.id, error = NO_WINDOW)
		// A WebView lives in the window it was made in.
		if (readerOf !== activity) closeReader()
		val r = reader ?: BeatportWebView(activity).also {
			reader = it
			readerOf = activity
		}
		val page = r.read(ask.url, timeoutMs = READ_MS)
		if (!page.ok) r.stop()
		DiagLog.d(AREA, "beatport ${if (page.ok) "ok" else page.error} ${page.bytes} bytes ${page.ms} ms${if (page.challenged) " challenged" else ""}")
		// Off the main thread: a page's data is a megabyte or so to wrap.
		return withContext(Dispatchers.Default) { beatportAnswer(ask.id, page) }
	}

	private suspend fun closeReader() {
		reader?.close()
		reader = null
		readerOf = null
	}

	companion object {
		private const val AREA = "stores"

		/** The largest body handed to the core: it becomes one string there. */
		const val MAX_BODY = 8 shl 20

		// Under the core's own patience with a call (catalog-work lanes.ts
		// CALL_TIMEOUT_MS, 20 s): what the WebView saw (a challenge not passed,
		// no data) is the answer, rather than a call the core gave up on.
		private const val READ_MS = 18_000L
		private const val IDLE_MS = 60_000L

		const val NO_WINDOW = "device: no window to read in"
		const val NO_WEBVIEW = "device: no WebView"
		private const val LEFT = "device: the page was left"

		/** Whether the hidden WebView may be sent there: Beatport's own pages, over TLS. */
		fun isBeatportUrl(url: String): Boolean {
			val u = runCatching { URI(url) }.getOrNull() ?: return false
			return BeatportWebView.isBeatport(u.scheme?.lowercase(), u.host?.lowercase())
		}

		/** The response's headers as the core reads them: lower-case names, the first value of each. */
		fun responseHeaders(fields: Map<String?, List<String?>?>): Map<String, String> {
			val out = LinkedHashMap<String, String>()
			for ((k, v) in fields) {
				// The status line comes under a null name.
				val name = k?.lowercase() ?: continue
				val first = v?.firstOrNull() ?: continue
				if (name !in out) out[name] = first
			}
			return out
		}

		/**
		 * A page's data as the page a plain client would have been sent: the
		 * readers (catalog-readers beatport-pages.ts) look for exactly this tag.
		 * "</" inside the data is written "<\/" — the same JSON, and nothing in
		 * it can then end the tag early.
		 */
		fun nextDataHtml(data: String): String =
			"<html><body><script id=\"__NEXT_DATA__\" type=\"application/json\">" + data.replace("</", "<\\/") + "</script></body></html>"

		/**
		 * What the WebView made of a page, in a plain client's terms: the data
		 * (200); Cloudflare's challenge not passed (403 with its mark, which
		 * parks Beatport for hours); no data in time (504). A page that could
		 * not load at all is no response (no network); a renderer the system
		 * took away is the phone's own trouble.
		 */
		fun beatportAnswer(id: Int, page: BeatportWebView.Page): Answer = when {
			// Beatport's "not found" is a page too: a plain client is sent it with
			// a 404, and the readers take that as the store no longer having it.
			page.ok && page.text != null && BeatportPages.read(page.text).route == "/404" -> Answer(id, 404, mapOf("content-type" to "text/html"), "")
			page.ok && page.text != null -> Answer(id, 200, mapOf("content-type" to "text/html"), nextDataHtml(page.text))
			// Only a challenge the page was still on when its time ran out: one
			// that showed and then lost its connection is the connection's.
			page.error == BeatportWebView.NOT_PASSED -> Answer(id, 403, mapOf("cf-mitigated" to "challenge"), "")
			page.error == BeatportWebView.NO_DATA -> Answer(id, 504, emptyMap(), "")
			page.error == BeatportWebView.RENDERER_GONE -> Answer(id, error = "device: ${page.error}")
			else -> Answer(id, error = page.error ?: "no page data")
		}

		// More than [max] bytes read means too large: the caller checks the size.
		private fun readCapped(input: InputStream, max: Int): ByteArray {
			val out = java.io.ByteArrayOutputStream(1 shl 16)
			val buf = ByteArray(1 shl 16)
			while (out.size() <= max) {
				val n = input.read(buf)
				if (n < 0) break
				out.write(buf, 0, n)
			}
			return out.toByteArray()
		}

		private fun hostOf(url: String): String = runCatching { URI(url).host }.getOrNull() ?: "?"
	}
}
