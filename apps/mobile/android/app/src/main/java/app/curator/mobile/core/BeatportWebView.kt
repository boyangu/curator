package app.curator.mobile.core

import android.annotation.SuppressLint
import android.app.Activity
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import app.curator.mobile.diag.DiagLog
import android.widget.FrameLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.resume

/**
 * Reads Beatport pages as the phone's own browser engine does, in a WebView
 * nobody sees: Beatport sits behind Cloudflare, which turns a plain HTTP
 * client away (403, a challenge page) but lets a real Chromium through, and
 * solves its own challenge in it when it sets one. What a page gives back is
 * its Next.js data (`__NEXT_DATA__`), the same thing the desktop reads.
 *
 * One WebView for a run of pages, so the run carries its cookies from page to
 * page as a browser would (cf_clearance among them). Every call is on the main
 * thread, as WebView requires; [read] suspends there between polls.
 *
 * The beatport-probe spike (Settings → Diagnostics) measures whether this
 * holds up on a phone before anything relies on it.
 */
class BeatportWebView(private val activity: Activity) {
	data class Page(
		/** The page's `__NEXT_DATA__` was there to read. */
		val ok: Boolean,
		/** From the load to the data (or to giving up). */
		val ms: Long,
		/** The data's size, UTF-8. */
		val bytes: Int,
		/** A Cloudflare challenge was on the screen at some point. */
		val challenged: Boolean,
		/** The first HTTP error the page's main frame got (403 for a challenge), null when none. */
		val status: Int?,
		val title: String?,
		val error: String?,
		val text: String?,
	)

	private var host: FrameLayout? = null
	private var view: WebView? = null

	// What the client's callbacks saw of the page loading now.
	private var status: Int? = null
	private var failed: String? = null
	private var gone = false

	/** Loads [url] and waits for its data, polling every [everyMs], for at most [timeoutMs]. */
	suspend fun read(url: String, timeoutMs: Long = 25_000, everyMs: Long = 400): Page = withContext(Dispatchers.Main) {
		val web = ensure()
		status = null
		failed = null
		val t0 = SystemClock.elapsedRealtime()
		web.loadUrl(url)
		var challenged = false
		var title: String? = null
		var page: Page? = null
		while (page == null) {
			delay(everyMs)
			val ms = SystemClock.elapsedRealtime() - t0
			page = when {
				gone -> {
					dispose()
					Page(false, ms, 0, challenged, status, title, "the page's renderer went away", null)
				}
				failed != null -> Page(false, ms, 0, challenged, status, title, failed, null)
				else -> {
					val state = runCatching { Json.parseToJsonElement(eval(web, STATE_JS)).jsonObject }.getOrNull()
					var text: String? = null
					if (state != null && !state["seen"]!!.jsonPrimitive.boolean) {
						title = state["title"]!!.jsonPrimitive.content
						if (state["cf"]!!.jsonPrimitive.boolean) challenged = true
						// Parsed whole: until then the script's text may still be arriving.
						if (state["next"]!!.jsonPrimitive.int >= 0 && state["ready"]!!.jsonPrimitive.content != "loading") {
							val raw = eval(web, TEXT_JS)
							// Off the main thread: a page's data is a megabyte or so of escaped JSON.
							text = withContext(Dispatchers.Default) {
								runCatching { (Json.parseToJsonElement(raw) as? JsonPrimitive)?.takeIf { it.isString }?.content }.getOrNull()
							}
						}
					}
					when {
						text != null -> Page(true, SystemClock.elapsedRealtime() - t0, text.encodeToByteArray().size, challenged, status, title, null, text)
						ms >= timeoutMs -> {
							web.stopLoading()
							Page(false, ms, 0, challenged, status, title, if (challenged) "challenge not passed" else "no page data in time", null)
						}
						else -> null
					}
				}
			}
		}
		page
	}

	/** Takes the WebView off the window and ends it; [read] makes a new one after. */
	suspend fun close() = withContext(Dispatchers.Main + NonCancellable) { dispose() }

	@SuppressLint("SetJavaScriptEnabled")
	private fun ensure(): WebView {
		view?.let { return it }
		gone = false
		val web = WebView(activity).apply {
			settings.javaScriptEnabled = true
			settings.domStorageEnabled = true
			settings.allowFileAccess = false
			settings.allowContentAccess = false
			// The data is in the HTML; pictures are only time.
			settings.blockNetworkImage = true
			settings.mediaPlaybackRequiresUserGesture = true
			// Never the focus: a page that focuses a field would raise the keyboard.
			isFocusable = false
			isFocusableInTouchMode = false
			webViewClient = Client()
			// The pages' console, to logcat only (never kept or sent): what
			// Cloudflare's challenge says when it doesn't pass.
			webChromeClient = object : WebChromeClient() {
				override fun onConsoleMessage(m: ConsoleMessage): Boolean {
					DiagLog.d("beatport-web", "${m.messageLevel()} ${m.message().take(300)} @${m.sourceId()?.take(80)}:${m.lineNumber()}")
					return true
				}
			}
		}
		// As Chrome has them (WebView's default is off): Cloudflare's challenge
		// runs in a frame of its own domain, a third party to the page.
		CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
		// Full window size, drawn, under the app's content: the page lays out at
		// a phone's size (a 1-px viewport is itself an odd thing to show a
		// bot check), and Chromium, which is drawn every frame it asks to be,
		// runs as a visible page does. At alpha 0 the platform skips drawing a
		// view altogether, and a WebView that is never drawn gets no frames
		// (requestAnimationFrame stalls). The app's screens are opaque over the
		// whole window, so not a pixel of it shows; the host takes no touches,
		// no focus, and hides it from TalkBack.
		val box = object : FrameLayout(activity) {
			override fun dispatchTouchEvent(ev: MotionEvent?) = false
		}.apply {
			importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
			descendantFocusability = ViewGroup.FOCUS_BLOCK_DESCENDANTS
			addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		}
		(activity.window.decorView as ViewGroup).addView(box, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
		host = box
		view = web
		return web
	}

	private fun dispose() {
		val web = view ?: return
		view = null
		runCatching { web.stopLoading() }
		host?.let { (it.parent as? ViewGroup)?.removeView(it) }
		host = null
		runCatching { web.destroy() }
	}

	private suspend fun eval(web: WebView, js: String): String = suspendCancellableCoroutine { cont ->
		web.evaluateJavascript(js) { if (cont.isActive) cont.resume(it ?: "null") }
	}

	private inner class Client : WebViewClient() {
		// Beatport only: a page that sends the main frame elsewhere (an ad, a
		// sign-in) goes nowhere. Frames inside the page (Cloudflare's own
		// challenge frame) load as they do in a browser.
		override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
			request.isForMainFrame && !isBeatport(request.url.scheme, request.url.host)

		override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
			if (request.isForMainFrame && status == null) status = response.statusCode
		}

		// A main frame that can't load at all (no connection, no DNS) won't come right by waiting.
		override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
			if (request.isForMainFrame && error.errorCode != ERROR_UNKNOWN) failed = "${error.errorCode} ${error.description}"
		}

		// The renderer crashed or was killed for memory: this WebView is done, the app isn't.
		override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
			gone = true
			return true
		}
	}

	companion object {
		/** Whether a main-frame navigation may go to this address: Beatport's own, over TLS. */
		fun isBeatport(scheme: String?, host: String?): Boolean =
			scheme == "https" && host != null && (host == "beatport.com" || host.endsWith(".beatport.com"))

		// Whether the data is there and how far the page is, in one cheap call.
		// `seen`: a page this reader already took its data from (the last page's
		// document stays until the next one replaces it).
		private val STATE_JS = """
			(function () {
				var n = document.getElementById('__NEXT_DATA__');
				var t = document.title || '';
				var cf = /just a moment|attention required/i.test(t) || !!document.querySelector(
					'#challenge-form, #challenge-stage, #cf-chl-widget, .cf-turnstile, script[src*="challenges.cloudflare.com"], iframe[src*="challenges.cloudflare.com"]'
				) || typeof window._cf_chl_opt !== 'undefined';
				return { seen: !!window.__curatorRead, ready: document.readyState, title: t, next: n ? n.textContent.length : -1, cf: cf };
			})()
		""".trimIndent()

		private val TEXT_JS = """
			(function () {
				var n = document.getElementById('__NEXT_DATA__');
				if (!n) return null;
				window.__curatorRead = 1;
				return n.textContent;
			})()
		""".trimIndent()
	}
}
