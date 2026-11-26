package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackFactsTest {
	@Test
	fun `each score is its percentile out of 100, rounded`() {
		assertEquals(
			listOf(Score("Power", 58), Score("Brightness", 46), Score("Density", 41)),
			analysisScores(0.584, 0.455, 0.41),
		)
		assertEquals(listOf(Score("Power", 0), Score("Brightness", 100)), analysisScores(0.0, 1.0, null))
	}

	@Test
	fun `a score the track lacks is left out, and an unanalysed track has none`() {
		assertEquals(listOf("Power", "Density"), analysisScores(0.5, null, 0.5).map { it.label })
		assertTrue(analysisScores(null, null, null).isEmpty())
	}

	@Test
	fun `related keys are the same, the relative, and a step either way`() {
		assertEquals(listOf("8A", "8B", "7A", "9A"), relatedKeys("8A"))
		assertEquals(listOf("1B", "1A", "12B", "2B"), relatedKeys(" 1b "))
		assertEquals(listOf("12A", "12B", "11A", "1A"), relatedKeys("12A"))
		assertTrue(relatedKeys("Am").isEmpty())
		assertTrue(relatedKeys(null).isEmpty())
	}
}
