package app.curator.mobile.model

import app.curator.mobile.data.Track
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamingServiceTest {
	@Test
	fun `a file plays from the main service, a streaming track from its own`() {
		assertEquals(StreamingService.TIDAL, StreamingService.forTrack("local", StreamingService.TIDAL))
		assertEquals(StreamingService.SPOTIFY, StreamingService.forTrack("local", StreamingService.SPOTIFY))
		assertEquals(StreamingService.TIDAL, StreamingService.forTrack("other", StreamingService.TIDAL))
		assertEquals(StreamingService.SPOTIFY, StreamingService.forTrack("spotify", StreamingService.TIDAL))
		assertEquals(StreamingService.TIDAL, StreamingService.forTrack("tidal", StreamingService.SPOTIFY))
	}

	private fun track(source: String, vararg streams: String) = Track(
		id = "t", recordingId = null, title = "t", version = null, artist = "", album = null, label = null, genre = null,
		released = null, bpm = null, key = null, durationSec = null, rating = null, power = null, brightness = null,
		density = null, coverUrl = null, addedAt = null, source = source, tags = emptyList(), streams = streams.toSet(),
	)

	@Test
	fun `a track is found when the service it plays through has it`() {
		val file = track("local", "spotify")
		assertTrue(file.foundOn(StreamingService.SPOTIFY))
		assertFalse(file.foundOn(StreamingService.TIDAL))
		// A streaming track is looked for on its own service, whichever is picked.
		val tidal = track("tidal", "tidal")
		assertTrue(tidal.foundOn(StreamingService.SPOTIFY))
		assertFalse(track("spotify", "tidal").foundOn(StreamingService.TIDAL))
		assertFalse(track("local").foundOn(StreamingService.SPOTIFY))
	}
}
