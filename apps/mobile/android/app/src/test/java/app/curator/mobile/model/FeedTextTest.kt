package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class FeedTextTest {
	private val zone = ZoneId.of("Asia/Jerusalem")
	private fun ms(y: Int, m: Int, d: Int, h: Int = 12) = LocalDateTime.of(y, m, d, h, 0).atZone(zone).toInstant().toEpochMilli()
	private val now = ms(2026, 11, 25)
	private fun date(at: Long) = feedDate(at, now, zone)

	private fun item(type: String = "track", origin: FeedOrigin? = null, at: Long = now, payload: FeedPayload = FeedPayload(title = "Lailonie", artists = listOf("Marsh"), albumTitle = "The album")) =
		FeedItem("i", type, "spotify", "sp", payload, origin, at, "fresh")

	@Test fun `days for two weeks, then weeks for two months`() {
		assertEquals("today", date(now))
		assertEquals("today", date(ms(2026, 11, 25, 1)))
		assertEquals("1 day", date(ms(2026, 11, 24)))
		assertEquals("13 days", date(ms(2026, 11, 12)))
		assertEquals("2 weeks", date(ms(2026, 11, 11)))
		assertEquals("8 weeks", date(now - 59 * 86_400_000L))
	}

	@Test fun `then the month, with the year once it is another`() {
		assertEquals("Sep", date(now - 60 * 86_400_000L))
		assertEquals("Jan", date(ms(2026, 1, 3)))
		assertEquals("Dec 2025", date(ms(2025, 12, 30)))
	}

	@Test fun `a date ahead of now reads as today`() {
		assertEquals("today", date(ms(2026, 11, 28)))
	}

	@Test fun `spoken, a release came out and a track was added`() {
		assertEquals("Released today", feedDateSpoken(item("album"), now, zone))
		assertEquals("Added 1 day ago", feedDateSpoken(item(at = ms(2026, 11, 24)), now, zone))
		assertEquals("Added 3 weeks ago", feedDateSpoken(item(at = ms(2026, 11, 3)), now, zone))
		assertEquals("Released in Dec 2025", feedDateSpoken(item("album", at = ms(2025, 12, 30)), now, zone))
	}

	@Test fun `a release's second line is its name alone`() {
		assertEquals("Glass Rivers", feedSubtitle(item("album", FeedOrigin("artist", "a", "Northfold"), payload = FeedPayload(title = "Glass Rivers"))))
	}

	@Test fun `a track's says why it is here, for each kind of origin`() {
		assertEquals("Hot / Cold · by Leeados", feedSubtitle(item(origin = FeedOrigin("playlist", "p", "Hot / Cold", owner = FeedOwner("u", "Leeados")))))
		assertEquals("Hot / Cold · by Leeados", feedSubtitle(item(origin = FeedOrigin("playlist", "p", "Hot / Cold")), owner = "Leeados"))
		assertEquals("Hot / Cold", feedSubtitle(item(origin = FeedOrigin("playlist", "p", "Hot / Cold", owner = FeedOwner("u", null)))))
		assertEquals("Melodic House chart · #4", feedSubtitle(item(origin = FeedOrigin("genre", "g", "Melodic House", rank = 4))))
		assertEquals("Melodic House chart", feedSubtitle(item(origin = FeedOrigin("genre", "g", "Melodic House"))))
		assertEquals("New from Marsh", feedSubtitle(item(origin = FeedOrigin("artist", "a", "Marsh"))))
		assertEquals("Anjunadeep", feedSubtitle(item(origin = FeedOrigin("label", "l", "Anjunadeep"))))
		assertEquals("The album", feedSubtitle(item(origin = FeedOrigin("browse", "b", "Elsewhere"))))
		assertEquals("The album", feedSubtitle(item(origin = null)))
	}

	@Test fun `the link is the item's own, named after its store, and only ever a web address`() {
		val spotify = "https://open.spotify.com/track/1"
		assertEquals(spotify to "Spotify", feedLink(item(payload = FeedPayload(url = spotify))))
		assertEquals(
			"https://x.bandcamp.com/a" to "Bandcamp",
			feedLink(item(payload = FeedPayload(handles = listOf(FeedHandle("deezer", "1"), FeedHandle("bandcamp", "2", "https://x.bandcamp.com/a"))))),
		)
		assertEquals("https://www.example.org/a" to "example.org", feedLink(item(payload = FeedPayload(url = "https://www.example.org/a"))))
		assertNull(feedLink(item(payload = FeedPayload(url = "spotify:track:1"))))
		assertNull(feedLink(item(payload = FeedPayload(handles = listOf(FeedHandle("x", "1", "intent://evil"))))))
	}
}
