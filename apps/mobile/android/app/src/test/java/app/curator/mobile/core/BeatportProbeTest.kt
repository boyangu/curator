package app.curator.mobile.core

import app.curator.mobile.data.LookupTrack
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BeatportProbeTest {
	// A track search's data as the page carries it (trimmed, made-up names):
	// the search service's flat rows, the release under its own names.
	private val search = """
		{"props":{"pageProps":{"dehydratedState":{"queries":[
			{"queryKey":["me"],"state":{"data":{"release":{"id":1,"name":"Not this one"}}}},
			{"queryKey":["search-tracks",{"q":"northfold glass rivers"},"US"],"state":{"data":{"count":2,"data":[
				{"track_id":11,"track_name":"Glass Rivers","mix_name":"Extended Mix","bpm":124,
				 "artists":[{"artist_id":77,"artist_name":"Northfold"}],
				 "release":{"release_id":4801234,"release_name":"Glass Rivers EP","release_image_uri":"https://img.test/r.jpg"}},
				{"track_id":12,"track_name":"Glass Rivers","mix_name":"Dub","release":{"release_id":4801235,"release_name":"Remixes"}}
			]}}}
		]}}},"page":"/search/tracks","query":{"q":"northfold glass rivers"}}
	""".trimIndent()

	@Test fun releaseFromASearchsRowsBeforeAnythingElseOnThePage() {
		val d = BeatportPages.read(search)
		assertTrue(d.ok)
		assertEquals("/search/tracks", d.route)
		assertEquals(ReleaseRef(4801234, "glass-rivers-ep"), d.release)
		assertEquals("https://www.beatport.com/release/glass-rivers-ep/4801234", BeatportPages.releaseUrl(d.release!!))
	}

	@Test fun releaseInBeatportsOwnShapeKeepsItsSlug() {
		val page = """{"props":{"pageProps":{"dehydratedState":{"queries":[{"queryKey":["track",11],"state":{"data":
			{"id":11,"name":"Glass Rivers","release":{"id":"77","name":"Glass Rivers","slug":"glass-rivers"}}}}]}}},"page":"/track/[slug]/[id]"}"""
		assertEquals(ReleaseRef(77, "glass-rivers"), BeatportPages.read(page).release)
	}

	@Test fun aSearchWithNoRowsIsAPageWithoutARelease() {
		val d = BeatportPages.read("""{"props":{"pageProps":{"dehydratedState":{"queries":[{"queryKey":["search-tracks"],"state":{"data":{"data":[]}}}]}}},"page":"/search/tracks"}""")
		assertTrue(d.ok)
		assertNull(d.release)
	}

	@Test fun notFoundBrokenOrPropslessIsNoPage() {
		assertFalse(BeatportPages.read("""{"props":{"pageProps":{}},"page":"/404"}""").ok)
		assertFalse(BeatportPages.read("""{"props":{"pageProps":{}},"page":"/_error"}""").ok)
		assertFalse(BeatportPages.read("""<html>Just a moment...</html>""").ok)
		assertFalse(BeatportPages.read("""{"page":"/search/tracks"}""").ok)
	}

	@Test fun searchUrlEncodesAsEncodeURIComponent() {
		val t = LookupTrack("t1", "Ben Böhmer Nils Hoffmann", "Breathing", "Melodic House & Techno")
		assertEquals("Ben Böhmer Nils Hoffmann Breathing", BeatportPages.query(t))
		assertEquals(
			"https://www.beatport.com/search/tracks?q=Ben%20B%C3%B6hmer%20Nils%20Hoffmann%20Breathing",
			BeatportPages.searchUrl(BeatportPages.query(t)),
		)
		assertEquals("A%20%26%20B%20%2B%20C%2FD%3F%23", BeatportPages.encode("A & B + C/D?#"))
		assertEquals("Fink More", BeatportPages.query(LookupTrack("t2", " Fink ", "  More ", null)))
	}

	@Test fun slugsFoldAccentsAndPunctuation() {
		assertEquals("bohmer-breathing-extended-mix", BeatportPages.slugify("Böhmer — Breathing (Extended Mix)"))
		assertEquals("release", BeatportPages.slugify("…"))
	}

	@Test fun onlyBeatportOverTls() {
		assertTrue(BeatportWebView.isBeatport("https", "www.beatport.com"))
		assertTrue(BeatportWebView.isBeatport("https", "beatport.com"))
		assertFalse(BeatportWebView.isBeatport("http", "www.beatport.com"))
		assertFalse(BeatportWebView.isBeatport("https", "beatport.com.evil.test"))
		assertFalse(BeatportWebView.isBeatport("https", "notbeatport.com"))
		assertFalse(BeatportWebView.isBeatport("https", null))
	}

	@Test fun medianAndP90() {
		assertNull(median(emptyList()))
		assertNull(p90(emptyList()))
		assertEquals(3L, median(listOf(5, 1, 3)))
		assertEquals(2500L, median(listOf(4000, 1000, 2000, 3000)))
		// Nearest rank: of ten, the ninth; of twenty-nine, the twenty-seventh.
		assertEquals(9L, p90((1L..10L).toList().shuffled()))
		assertEquals(27L, p90((1L..29L).toList()))
		assertEquals(7L, p90(listOf(7)))
	}
}
