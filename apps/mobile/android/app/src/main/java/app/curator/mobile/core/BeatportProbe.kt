package app.curator.mobile.core

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebView
import app.curator.mobile.data.LookupTrack
import app.curator.mobile.diag.DiagLog
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.net.URLEncoder
import java.text.Normalizer

/** A release as a page refers to it: enough for its address. */
data class ReleaseRef(val id: Long, val slug: String)

/** What the probe made of one page's data. */
data class PageData(val ok: Boolean, val route: String?, val release: ReleaseRef?, val why: String?)

/**
 * Beatport's addresses and what the probe reads off a page's `__NEXT_DATA__`:
 * the shapes the desktop's readers know (packages/providers/beatport,
 * packages/catalog-readers beatport-pages.ts / beatport-search.ts).
 */
object BeatportPages {
	private const val BASE = "https://www.beatport.com"

	/** A track search, as the desktop asks it: the words as encodeURIComponent writes them. */
	fun searchUrl(query: String): String = "$BASE/search/tracks?q=${encode(query)}"

	fun releaseUrl(r: ReleaseRef): String = "$BASE/release/${r.slug}/${r.id}"

	/** Artists, then the title, one space apart. */
	fun query(t: LookupTrack): String = "${t.artists} ${t.title}".replace(Regex("\\s+"), " ").trim()

	// URLEncoder writes form encoding (a space as '+'); a query string wants %20.
	// Its other differences from encodeURIComponent ('*' kept, '~' and '!'
	// escaped) Beatport reads the same.
	fun encode(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

	/**
	 * As beatport-search.ts's slugify, with the accents dropped rather than
	 * dashed ("böhmer", not "bo-hmer"). Beatport goes by the id; the slug is
	 * only how the address reads.
	 */
	fun slugify(name: String): String = Normalizer.normalize(name.lowercase(), Normalizer.Form.NFKD)
		.replace(Regex("\\p{M}+"), "").replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "release" }

	/**
	 * Whether a page's data is a page (JSON, with Next's props, not its 404 or
	 * error page), and the first release it refers to. A track search's rows
	 * are flat (`release: {release_id, release_name}`, the search service's
	 * names); a store page's are Beatport's own (`release: {id, name, slug}`):
	 * both are read, the search's query first, then anywhere on the page.
	 */
	fun read(text: String): PageData {
		val root = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject
			?: return PageData(false, null, null, "page data isn't JSON")
		val route = (root["page"] as? JsonPrimitive)?.contentOrNull
		if (route == "/404" || route == "/_error") return PageData(false, route, null, "not found ($route)")
		if (root["props"] !is JsonObject) return PageData(false, route, null, "page data without props")
		val queries = ((root["props"] as JsonObject)["pageProps"] as? JsonObject)?.get("dehydratedState")?.let { it as? JsonObject }?.get("queries") as? JsonArray
		val searches = queries.orEmpty().filter { q ->
			val key = ((q as? JsonObject)?.get("queryKey") as? JsonArray)?.firstOrNull()
			(key as? JsonPrimitive)?.contentOrNull?.contains("search") == true
		}
		val release = searches.firstNotNullOfOrNull(::firstRelease) ?: firstRelease(root)
		return PageData(true, route, release, null)
	}

	// Depth first, in the page's own order: the first object under a "release" key that has an id.
	private fun firstRelease(e: JsonElement): ReleaseRef? = when (e) {
		is JsonObject -> e.entries.firstNotNullOfOrNull { (k, v) -> (if (k == "release" && v is JsonObject) refOf(v) else null) ?: firstRelease(v) }
		is JsonArray -> e.firstNotNullOfOrNull(::firstRelease)
		else -> null
	}

	private fun refOf(o: JsonObject): ReleaseRef? {
		fun text(k: String) = (o[k] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
		val id = (text("release_id") ?: text("id"))?.toLongOrNull()?.takeIf { it > 0 } ?: return null
		val slug = text("slug") ?: text("release_slug") ?: slugify(text("release_name") ?: text("name") ?: "")
		return ReleaseRef(id, slug)
	}
}

/** The middle value (the mean of the two middle ones for an even count); null for none. */
fun median(xs: List<Long>): Long? {
	if (xs.isEmpty()) return null
	val s = xs.sorted()
	return if (s.size % 2 == 1) s[s.size / 2] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2
}

/** The nearest-rank 90th percentile: the value 90% of the values are at or under. */
fun p90(xs: List<Long>): Long? {
	if (xs.isEmpty()) return null
	val s = xs.sorted()
	return s[(Math.ceil(0.9 * s.size).toInt() - 1).coerceIn(0, s.size - 1)]
}

/**
 * The beatport-probe spike: can this phone read Beatport's pages through a
 * WebView nobody sees ([BeatportWebView]), fast enough and often enough to
 * fill tracks from them later, as the desktop does through FlareSolverr?
 *
 * Twenty track searches built from the library's own tracks, then ten release
 * pages those searches pointed to: one page at a time, each started at least
 * [GAP_MS] after the one before (a person's pace, not a crawler's). Every page
 * and the run's summary go to the log (area "beatport-probe"), which reaches
 * the cloud as the rest of the phone's log does.
 */
object BeatportProbe {
	const val SEARCHES = 20
	const val RELEASES = 10
	const val PLANNED = SEARCHES + RELEASES
	private const val GAP_MS = 1_500L
	private const val AREA = "beatport-probe"

	data class Progress(val done: Int, val planned: Int, val parsed: Int, val medianMs: Long?)

	data class Summary(
		val network: String,
		val parsed: Int,
		val total: Int,
		val medianMs: Long?,
		val p90Ms: Long?,
		val challenged: Int,
		val errors: Int,
	)

	/** Runs the probe over [tracks] (the searches' words) with [reader], reporting each page done. */
	suspend fun run(context: Context, reader: BeatportWebView, tracks: List<LookupTrack>, seed: Long, progress: (Progress) -> Unit): Summary {
		val network = networkKind(context)
		DiagLog.i(AREA, "start", mapOf(
			"network" to network,
			"seed" to seed,
			"tracks" to tracks.size,
			"webview" to WebView.getCurrentWebViewPackage()?.versionName,
			// Whether Cloudflare's pass from an earlier run is still on the phone; never its value.
			"clearance" to (CookieManager.getInstance().getCookie("https://www.beatport.com")?.contains("cf_clearance=") == true),
		))
		val times = ArrayList<Long>()
		var done = 0
		var challenged = 0
		var errors = 0
		var lastStart = 0L
		val releases = ArrayList<ReleaseRef>()

		suspend fun page(kind: String, url: String): PageData? {
			val wait = lastStart + GAP_MS - SystemClock.elapsedRealtime()
			if (wait > 0) delay(wait)
			lastStart = SystemClock.elapsedRealtime()
			val p = reader.read(url)
			val data = p.text?.let { withContext(Dispatchers.Default) { BeatportPages.read(it) } }
			val ok = p.ok && data?.ok == true
			if (ok) times += p.ms else errors++
			if (p.challenged) challenged++
			DiagLog.i(AREA, "page", mapOf(
				"i" to done,
				"kind" to kind,
				"ms" to p.ms,
				"ok" to ok,
				"bytes" to p.bytes,
				"challenged" to p.challenged,
				"status" to p.status,
				"title" to p.title?.take(80),
				"route" to data?.route,
				"error" to (p.error ?: data?.why),
			))
			done++
			progress(Progress(done, PLANNED, times.size, median(times)))
			return data?.takeIf { ok }
		}

		try {
			for (t in tracks.take(SEARCHES)) {
				val data = page("search", BeatportPages.searchUrl(BeatportPages.query(t)))
				data?.release?.takeIf { r -> releases.none { it.id == r.id } }?.let { releases += it }
			}
			for (r in releases.take(RELEASES)) page("release", BeatportPages.releaseUrl(r))
		} catch (e: CancellationException) {
			DiagLog.i(AREA, "cancelled", mapOf("done" to done, "parsed" to times.size))
			throw e
		}

		val after = networkKind(context)
		val summary = Summary(
			network = if (after == network) network else "mixed",
			parsed = times.size,
			total = done,
			medianMs = median(times),
			p90Ms = p90(times),
			challenged = challenged,
			errors = errors,
		)
		DiagLog.i(AREA, "summary", mapOf(
			"network" to summary.network,
			"parsed" to summary.parsed,
			"total" to summary.total,
			"medianMs" to summary.medianMs,
			"p90Ms" to summary.p90Ms,
			"challenged" to summary.challenged,
			"errors" to summary.errors,
			// Fewer than ten: the searches found fewer releases to open.
			"releases" to minOf(releases.size, RELEASES),
		))
		return summary
	}

	/** wifi, cellular or other: the network carrying the app's traffic now. */
	fun networkKind(context: Context): String {
		val cm = context.getSystemService(ConnectivityManager::class.java) ?: return "other"
		val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return "other"
		return when {
			caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
			caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
			else -> "other"
		}
	}
}
