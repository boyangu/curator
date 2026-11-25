package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedSlidesTest {
	private fun handles(id: String) = listOf(FeedHandle("spotify", id))
	private val track = FeedItem(
		"i1", "track", "spotify", "sp1",
		FeedPayload(title = "Moments", artists = listOf("Kidnap", "Leo Stannard"), label = "Anjunadeep", genre = "Melodic house", isrc = "GB1", bpm = 121.4, keyCamelot = "2B", durationSec = 352.0),
		null, 0, "fresh",
	)
	private val release = FeedItem(
		"i2", "album", "spotify", "al1",
		FeedPayload(
			title = "Glass Rivers", artists = listOf("Northfold"), label = "Northfold Records", genre = "Deep house", trackCount = 4,
			tracks = listOf(
				FeedTrackRef("st1", "One", listOf("Northfold"), 301.0, isrc = "GB11", bpm = 120.0, keyCamelot = "8A", genre = "Techno", handles = handles("st1")),
				FeedTrackRef("cat-2", "Two", listOf("Northfold", "Kaske"), catalogId = "cat-2", handles = listOf(FeedHandle("deezer", "9"))),
			),
		),
		null, 0, "fresh",
	)
	private val mine = Held("t1", interested = true, local = false, deleted = false)
	private fun by(spotify: Map<String, Held> = emptyMap(), isrc: Map<String, Held> = emptyMap()) = Holdings(isrc, spotify)

	@Test fun `a track card says everything it knows, in its corners`() {
		val s = slidesOf(track, Holdings.EMPTY).single()
		assertEquals(listOf("Moments", "Kidnap, Leo Stannard"), s.topLeft)
		assertNull(s.topRight)
		assertEquals(listOf("Anjunadeep", "Melodic house"), s.bottomLeft)
		assertEquals(listOf("5:52", "121", "2B"), listOf(s.duration, s.bpm, s.key))
		assertNull(s.bottomRight)
		assertEquals("sp1", s.plays?.spotifyId)
	}

	@Test fun `what is missing is left out, and a lone genre takes the first line`() {
		val bare = track.copy(payload = FeedPayload(title = "Beon C", artists = emptyList(), genre = "Deep house", label = " ", durationSec = 0.0))
		val s = slidesOf(bare, Holdings.EMPTY).single()
		assertEquals(listOf("Beon C"), s.topLeft)
		assertEquals(listOf("Deep house"), s.bottomLeft)
		assertEquals(listOf(null, null, null), listOf(s.duration, s.bpm, s.key))
	}

	@Test fun `a release opens on its cover, then a slide per track with its place`() {
		val s = slidesOf(release, Holdings.EMPTY)
		assertEquals(3, s.size)
		// The release says four tracks; the card lists the two it was given.
		assertEquals(listOf("4 tracks", "1/2", "2/2"), s.map { it.topRight })
		assertEquals(emptyList<String>(), s[0].topLeft)
		assertEquals(listOf("Northfold Records"), s[0].bottomLeft)
		assertEquals("Deep house", s[0].bottomRight)
		assertEquals(listOf(null, null, null), listOf(s[0].duration, s[0].bpm, s[0].key))
		// A track's own genre, the release's label; then the release's both.
		assertEquals(listOf("Northfold Records", "Techno"), s[1].bottomLeft)
		assertEquals(listOf("Northfold Records", "Deep house"), s[2].bottomLeft)
		assertEquals("1 track", slidesOf(release.copy(payload = release.payload.copy(trackCount = null, tracks = release.payload.tracks!!.take(1))), Holdings.EMPTY)[0].topRight)
	}

	@Test fun `a release with no tracklist is its cover alone`() {
		val s = slidesOf(release.copy(payload = FeedPayload(title = "Soon")), Holdings.EMPTY).single()
		assertNull(s.topRight)
		assertNull(s.plays)
	}

	@Test fun `the ribbon is on owned tracks, never on a release's cover`() {
		val s = slidesOf(release, by(spotify = mapOf("st1" to mine)))
		assertEquals(listOf(false, true, false), s.map { it.ribbon })
		assertTrue(slidesOf(track, by(isrc = mapOf("GB1" to Held("t", interested = false, local = true, deleted = false)))).single().ribbon)
		// Only streamed: in the library's rows, but not "In Library" (the desktop's tier).
		assertFalse(slidesOf(track, by(isrc = mapOf("GB1" to Held("t", interested = false, local = false, deleted = false)))).single().ribbon)
	}

	@Test fun `the heart is per track`() {
		val s = slidesOf(release, by(spotify = mapOf("st1" to mine)))
		assertEquals(listOf(Heart.NONE, Heart.ON, Heart.DIMMED), s.map { it.heart })
		assertEquals(Heart.OFF, slidesOf(track, Holdings.EMPTY).single().heart)
		// Not on Spotify but held: its tag can still be moved.
		assertEquals(Heart.OFF, slidesOf(track.copy(source = "catalog"), by(isrc = mapOf("GB1" to mine.copy(interested = false)))).single().heart)
		assertEquals(Heart.DIMMED, slidesOf(track, by(spotify = mapOf("sp1" to mine.copy(deleted = true)))).single().heart)
	}

	@Test fun `play starts the slide's track, and a release's first playable from its cover`() {
		assertEquals(listOf("st1", "st1", null), slidesOf(release, Holdings.EMPTY).map { it.plays?.spotifyId })
		assertEquals(listOf(null, null, null), slidesOf(release, Holdings.EMPTY, unavailable = setOf("st1")).map { it.plays })
	}

	@Test fun `a catalogue id is never taken for a Spotify one`() {
		assertNull(release.tracks[1].spotifyId)
		assertNull(track.copy(source = "catalog", sourceId = "cat-9").tracks.single().spotifyId)
		assertEquals("st9", release.copy(payload = release.payload.copy(tracks = listOf(FeedTrackRef("st9")))).tracks.single().spotifyId)
	}

	@Test fun `a live row speaks before a deleted one`() {
		val h = by(spotify = mapOf("sp1" to mine.copy(trackId = "gone", deleted = true)), isrc = mapOf("GB1" to mine))
		assertEquals("t1", h.of("GB1", "sp1")?.trackId)
		assertEquals("gone", h.of(null, "sp1")?.trackId)
	}

	@Test fun `credits keep their ids straight`() {
		val p = FeedPayload(artists = listOf("A", "B", "C"), artistIds = listOf("sa", "catalog:cb"), artistCatalogIds = listOf("ca", null))
		assertEquals(listOf(FeedArtist("A", "ca", "sa"), FeedArtist("B", "cb", null), FeedArtist("C", null, null)), p.credits)
	}

	@Test fun `a long gallery's dots are a window around the current one`() {
		assertEquals(0 until 4, dotWindow(3, 4))
		assertEquals(0 until 7, dotWindow(0, 21))
		assertEquals(7 until 14, dotWindow(10, 21))
		assertEquals(14 until 21, dotWindow(20, 21))
	}

	@Test fun `an hour-long mix reads as one`() {
		assertEquals("1:02:03", clock(3723.0))
		assertEquals("0:05", clock(5.2))
	}
}
