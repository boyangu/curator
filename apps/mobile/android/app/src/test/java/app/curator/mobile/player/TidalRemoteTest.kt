package app.curator.mobile.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TidalRemoteTest {
	@Test
	fun `the session's media id names the track as a whole number`() {
		assertTrue(TidalRemote.sameTrack("12345", null, "12345", "x"))
		assertTrue(TidalRemote.sameTrack("track:12345", null, "12345", "x"))
		assertFalse(TidalRemote.sameTrack("123456", "Other", "12345", "Strobe"))
	}

	@Test
	fun `without the id, the title starts with ours, folded`() {
		assertTrue(TidalRemote.sameTrack("q-7", "Strobe (Original Mix)", "12345", "Strobe"))
		assertTrue(TidalRemote.sameTrack(null, "Café Del Mar", "12345", "cafe del mar"))
		assertFalse(TidalRemote.sameTrack(null, "Ghosts 'n' Stuff", "12345", "Strobe"))
		assertFalse(TidalRemote.sameTrack(null, null, "12345", "Strobe"))
		assertFalse(TidalRemote.sameTrack(null, "Anything", "12345", ""))
	}
}
