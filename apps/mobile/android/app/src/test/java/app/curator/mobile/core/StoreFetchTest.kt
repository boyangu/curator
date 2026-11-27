package app.curator.mobile.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StoreFetchTest {
	// The readers' own pattern for the page's data (catalog-readers beatport-pages.ts).
	private val nextData = Regex("""<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>""")

	private fun page(ok: Boolean, text: String? = null, challenged: Boolean = false, status: Int? = null, error: String? = null) =
		BeatportWebView.Page(ok, ms = 1400, bytes = text?.length ?: 0, challenged = challenged, status = status, title = null, error = error, text = text)

	// ── the core's ask ──────────────────────────────────────────────────────

	@Test fun `a fetch event is read whole`() {
		val e = Json.parseToJsonElement(
			"""{"type":"fetch","id":12,"via":"beatport","method":"GET","url":"https://www.beatport.com/release/x/1","headers":{"accept":"text/html","user-agent":"UA"},"body":null}""",
		).jsonObject
		assertEquals(StoreFetch.Ask(12, "beatport", "GET", "https://www.beatport.com/release/x/1", mapOf("accept" to "text/html", "user-agent" to "UA"), null), StoreFetch.Ask.of(e))
		val post = Json.parseToJsonElement("""{"type":"fetch","id":13,"via":"http","method":"POST","url":"https://api.test/q","headers":{},"body":"{\"a\":1}"}""").jsonObject
		assertEquals("{\"a\":1}", StoreFetch.Ask.of(post)!!.body)
	}

	@Test fun `only an ask without an id has no answer to give`() {
		assertNull(StoreFetch.Ask.of(JsonObject(mapOf("type" to JsonPrimitive("fetch")))))
		// Half an ask is still answered (with why not), so its caller is not left waiting.
		assertEquals(StoreFetch.Ask(4, "http", "GET", "", emptyMap(), null), StoreFetch.Ask.of(JsonObject(mapOf("id" to JsonPrimitive(4)))))
	}

	// ── the answer ──────────────────────────────────────────────────────────

	@Test fun `an answer is worded as the core reads it`() {
		val a = StoreFetch.Answer(5, 200, mapOf("content-type" to "application/json"), "{}").toJson()
		assertEquals(setOf("id", "status", "headers", "body", "error"), a.keys)
		assertEquals(JsonPrimitive(5), a["id"])
		assertEquals(JsonPrimitive(200), a["status"])
		assertEquals(JsonObject(mapOf("content-type" to JsonPrimitive("application/json"))), a["headers"])
		assertEquals(JsonPrimitive("{}"), a["body"])
		assertEquals(JsonNull, a["error"])
	}

	@Test fun `no response is an error and nothing else`() {
		val a = StoreFetch.Answer(6, error = "Unable to resolve host").toJson()
		assertEquals(JsonPrimitive(0), a["status"])
		assertEquals(JsonObject(emptyMap()), a["headers"])
		assertEquals(JsonNull, a["body"])
		assertEquals(JsonPrimitive("Unable to resolve host"), a["error"])
	}

	@Test fun `the phone's own trouble is marked as the core tells it apart`() {
		assertEquals("device: no window to read in", StoreFetch.NO_WINDOW)
		assertTrue(StoreFetch.NO_WEBVIEW.startsWith("device:"))
		val a = StoreFetch.Answer(7, error = StoreFetch.NO_WINDOW).toJson()
		assertEquals(JsonPrimitive(0), a["status"])
		assertEquals(JsonPrimitive("device: no window to read in"), a["error"])
	}

	// ── plain HTTP's headers ────────────────────────────────────────────────

	@Test fun `response headers - lower-case names, the first value, no status line`() {
		val h = StoreFetch.responseHeaders(
			linkedMapOf(
				null to listOf("HTTP/1.1 429 Too Many Requests"),
				"Retry-After" to listOf("120"),
				"Set-Cookie" to listOf("a=1", "b=2"),
				"CF-Mitigated" to listOf("challenge"),
				"X-Empty" to emptyList(),
				"X-Null" to null,
			),
		)
		assertEquals(mapOf("retry-after" to "120", "set-cookie" to "a=1", "cf-mitigated" to "challenge"), h)
	}

	@Test fun `a name sent in two spellings keeps the first`() {
		assertEquals(mapOf("etag" to "one"), StoreFetch.responseHeaders(linkedMapOf("ETag" to listOf("one"), "etag" to listOf("two"))))
	}

	// ── Beatport's pages ────────────────────────────────────────────────────

	@Test fun `only Beatport's own pages over TLS go to the WebView`() {
		assertTrue(StoreFetch.isBeatportUrl("https://www.beatport.com/release/glass-rivers/4801234"))
		assertTrue(StoreFetch.isBeatportUrl("https://beatport.com/search/tracks?q=northfold%20glass"))
		assertTrue(StoreFetch.isBeatportUrl("HTTPS://WWW.BEATPORT.COM/label/x/1"))
		assertFalse(StoreFetch.isBeatportUrl("http://www.beatport.com/release/x/1"))
		assertFalse(StoreFetch.isBeatportUrl("https://www.beatport.com.evil.test/release/x/1"))
		assertFalse(StoreFetch.isBeatportUrl("https://notbeatport.com/"))
		assertFalse(StoreFetch.isBeatportUrl("file:///data/data/app/x"))
		assertFalse(StoreFetch.isBeatportUrl("not an address"))
		assertFalse(StoreFetch.isBeatportUrl(""))
	}

	@Test fun `a page's data comes back in the tag the readers look for`() {
		val data = """{"props":{"pageProps":{"dehydratedState":{"queries":[]}}},"page":"/release/[slug]/[id]"}"""
		val html = StoreFetch.nextDataHtml(data)
		assertEquals("""<html><body><script id="__NEXT_DATA__" type="application/json">$data</script></body></html>""", html)
		assertEquals(data, nextData.find(html)!!.groupValues[1])
	}

	@Test fun `nothing in the data ends the tag early, and it is still the same JSON`() {
		val data = """{"note":"a </script> in a name","html":"<b>x</b>"}"""
		val got = nextData.find(StoreFetch.nextDataHtml(data))!!.groupValues[1]
		assertFalse(got.contains("</"))
		assertEquals(Json.parseToJsonElement(data), Json.parseToJsonElement(got))
	}

	@Test fun `a page read is a 200 with its data`() {
		val a = StoreFetch.beatportAnswer(1, page(ok = true, text = """{"props":{}}"""))
		assertEquals(200, a.status)
		assertEquals(mapOf("content-type" to "text/html"), a.headers)
		assertEquals("""{"props":{}}""", nextData.find(a.body!!)!!.groupValues[1])
		assertNull(a.error)
	}

	@Test fun `Beatport's own not-found page is a 404, wherever a 404 is merely mentioned`() {
		val gone = StoreFetch.beatportAnswer(7, page(ok = true, text = """{"props":{"pageProps":{"statusCode":404}},"page":"/404","query":{},"buildId":"x"}"""))
		assertEquals(404, gone.status)
		assertNull(gone.error)
		// A release whose data happens to carry the words is still its page.
		val there = StoreFetch.beatportAnswer(8, page(ok = true, text = """{"props":{"pageProps":{"release":{"name":"x","slug":"p","page":"/404"}}},"page":"/release/[description]/[id]","query":{}}"""))
		assertEquals(200, there.status)
	}

	@Test fun `a challenge passed on the way is still the page`() {
		// The main frame's first answer was the challenge's 403; the page came after.
		val a = StoreFetch.beatportAnswer(1, page(ok = true, text = "{}", challenged = true, status = 403))
		assertEquals(200, a.status)
	}

	@Test fun `a challenge not passed is Cloudflare's 403`() {
		val a = StoreFetch.beatportAnswer(2, page(ok = false, challenged = true, status = 403, error = BeatportWebView.NOT_PASSED))
		assertEquals(StoreFetch.Answer(2, 403, mapOf("cf-mitigated" to "challenge"), ""), a)
	}

	@Test fun `no data in time, with no challenge, is a 504`() {
		val a = StoreFetch.beatportAnswer(3, page(ok = false, error = BeatportWebView.NO_DATA))
		assertEquals(StoreFetch.Answer(3, 504, emptyMap(), ""), a)
	}

	@Test fun `a page that could not load is no response, challenged before or not`() {
		val a = StoreFetch.beatportAnswer(4, page(ok = false, challenged = true, error = "-2 net::ERR_INTERNET_DISCONNECTED"))
		assertEquals(StoreFetch.Answer(4, error = "-2 net::ERR_INTERNET_DISCONNECTED"), a)
	}

	@Test fun `a renderer the system took is the phone's own trouble`() {
		val a = StoreFetch.beatportAnswer(5, page(ok = false, error = BeatportWebView.RENDERER_GONE))
		assertEquals(0, a.status)
		assertTrue(a.error!!.startsWith("device:"))
	}
}
