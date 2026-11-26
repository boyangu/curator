package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class CoverBandsTest {
	private val today = LocalDate.of(2026, 10, 16)

	@Test
	fun `each corner carries its lines`() {
		val b = coverBands("Hyperfall", "Yotto", "Hyperfall", 122.4, "9A", "Anjunadeep", "Melodic house", "2025-03-07", today)
		assertEquals(listOf("Hyperfall", "Yotto", "Hyperfall"), b.topLeft)
		assertEquals("122", b.bpm)
		assertEquals("9A", b.key)
		assertTrue(b.hasTopRight)
		assertEquals(listOf("Anjunadeep", "Melodic house"), b.bottomLeft)
		assertEquals("Mar, 2025", b.released)
	}

	@Test
	fun `a line with no data is left out, a corner with none is not drawn`() {
		val b = coverBands("Hyperfall", "", null, null, " ", null, "", null, today)
		assertEquals(listOf("Hyperfall"), b.topLeft)
		assertFalse(b.hasTopRight)
		assertEquals(emptyList<String>(), b.bottomLeft)
		assertNull(b.released)
		// A BPM of 0 is no BPM.
		assertNull(coverBands("x", null, null, 0.0, null, null, null, null, today).bpm)
	}

	@Test
	fun `the cover reads as one sentence`() {
		val b = coverBands("Hyperfall", "Yotto", "Hyperfall", 122.0, "9A", "Anjunadeep", "Melodic house", "2025-03-07", today)
		assertEquals("Hyperfall by Yotto, from Hyperfall. 122 BPM, key 9A. Anjunadeep, Melodic house. Released Mar, 2025.", b.spoken())
		assertEquals("Hyperfall. 122 BPM.", coverBands("Hyperfall", null, null, 122.0, null, null, null, null, today).spoken())
	}

	// The desktop's cases (library-logic release-label.test.ts), with null for its dash.
	@Test
	fun `recent full dates read as an age`() {
		assertEquals("today", releaseLabel("2026-10-16", today))
		assertEquals("1 day", releaseLabel("2026-10-15", today))
		assertEquals("14 days", releaseLabel("2026-10-02", today))
		assertEquals("30 days", releaseLabel("2026-09-16", today))
	}

	@Test
	fun `older, future or partial dates read as month and year`() {
		assertEquals("Sep, 2026", releaseLabel("2026-09-15", today))
		assertEquals("Mar, 2021", releaseLabel("2021-03-15", today))
		assertEquals("Nov, 2026", releaseLabel("2026-11-01", today))
		assertEquals("Oct, 2026", releaseLabel("2026-10", today))
		assertEquals("2021", releaseLabel("2021", today))
		assertNull(releaseLabel(null, today))
		assertNull(releaseLabel("", today))
	}
}
