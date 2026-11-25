package app.curator.mobile.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayheadTest {
	private fun s(sec: Double) = (sec * 1e9).toLong()

	@Test
	fun `it runs on the clock between reports and stands while paused`() {
		val p = Playhead()
		p.report(10.0, s(1.0), playing = true, now = s(1.2))
		assertEquals(10.2, p.position(s(1.2)), 1e-6)
		assertEquals(12.0, p.position(s(3.0)), 1e-6)
		p.stop(s(3.0))
		assertEquals(12.0, p.position(s(9.0)), 1e-6)
	}

	@Test
	fun `a report a little off is eased into, without a jump or a step back`() {
		for (off in listOf(-0.45, -0.1, 0.1, 0.45)) {
			val p = Playhead()
			p.report(10.0, s(0.0), playing = true, now = s(0.0))
			val before = p.position(s(2.0))
			p.report(12.0 + off, s(2.0), playing = true, now = s(2.0))
			assertEquals(before, p.position(s(2.0)), 1e-6)
			var last = before
			for (ms in 8..5000 step 8) {
				val at = p.position(s(2.0) + ms * 1_000_000L)
				assertTrue("off $off at $ms ms", at > last)
				last = at
			}
			assertEquals(17.0 + off, p.position(s(7.0)), 0.001)
		}
	}

	@Test
	fun `a report far off is a move made elsewhere`() {
		val p = Playhead()
		p.report(10.0, s(0.0), playing = true, now = s(0.0))
		p.report(60.0, s(2.0), playing = true, now = s(2.0))
		assertEquals(60.0, p.position(s(2.0)), 1e-6)
	}

	@Test
	fun `moved while paused it stays there until the service plays`() {
		val p = Playhead()
		p.report(10.0, s(0.0), playing = true, now = s(0.0))
		p.stop(s(2.0))
		p.report(12.0, s(2.0), playing = false, now = s(2.1))
		p.seek(90.0, s(4.0), service = false)
		// Spotify says again that it is paused where it stopped.
		p.report(12.0, s(5.0), playing = false, now = s(5.0))
		assertEquals(90.0, p.position(s(5.0)), 1e-6)
		p.starting(s(8.0))
		// Resumed before its seek took: the report of the old place is stale.
		p.report(12.0, s(8.1), playing = true, now = s(8.1))
		p.report(90.0, s(8.4), playing = true, now = s(8.4))
		assertEquals(91.0, p.position(s(9.4)), 0.1)
	}

	@Test
	fun `another track starts at its start and takes the service's place`() {
		val p = Playhead()
		p.seek(90.0, s(1.0), service = false)
		p.reset(s(2.0))
		assertEquals(0.0, p.position(s(3.0)), 1e-6)
		p.report(40.0, s(3.0), playing = false, now = s(3.0))
		assertEquals(40.0, p.position(s(4.0)), 1e-6)
	}

	@Test
	fun `just after a seek a report from before it doesn't pull the playhead back`() {
		val p = Playhead()
		p.report(10.0, s(0.0), playing = true, now = s(0.0))
		p.seek(90.0, s(2.0), service = true)
		p.report(12.1, s(2.1), playing = true, now = s(2.1))
		assertEquals(90.1, p.position(s(2.1)), 1e-6)
		// The one after the seek, a little late.
		p.report(90.0, s(2.4), playing = true, now = s(2.4))
		assertEquals(91.0, p.position(s(3.4)), 0.1)
		// Long after, the service is believed.
		p.report(30.0, s(6.0), playing = true, now = s(6.0))
		assertEquals(30.0, p.position(s(6.0)), 1e-6)
	}
}
