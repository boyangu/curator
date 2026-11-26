package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Test

class GridTest {
	private val beats = FloatArray(16) { 0.5f + it * 0.5f }

	@Test
	fun `bars start at the downbeats, a pickup included`() {
		// Two beats of pickup: the first bar starts on the third beat.
		val downs = floatArrayOf(1.5f, 3.5f, 5.5f, 7.5f)
		val m = gridMarks(beats, downs, 0.0, 4.0)
		assertEquals(listOf(null, null, 1, null, null, null, 2, null), m.map { it.bar })
		assertEquals(0.5f, m.first().sec)
	}

	@Test
	fun `a window from the middle numbers its bars as the track does`() {
		val downs = floatArrayOf(1.5f, 3.5f, 5.5f, 7.5f)
		val m = gridMarks(beats, downs, 5.2, 6.1)
		assertEquals(listOf(GridMark(5.5f, 3), GridMark(6.0f, null)), m)
	}

	@Test
	fun `a downbeat a hair off its beat is still that beat`() {
		val m = gridMarks(beats, floatArrayOf(1.51f, 3.49f), 0.0, 4.0)
		assertEquals(listOf(2, 6), m.withIndex().filter { it.value.bar != null }.map { it.index })
	}

	@Test
	fun `with no downbeats, every fourth beat starts a bar`() {
		val m = gridMarks(beats, FloatArray(0), 0.0, 8.0)
		assertEquals(listOf(1, 2, 3, 4), m.mapNotNull { it.bar })
		assertEquals(listOf(0, 4, 8, 12), m.withIndex().filter { it.value.bar != null }.map { it.index })
	}

	@Test
	fun `nothing outside the window, nothing without a grid`() {
		assertEquals(0, gridMarks(beats, FloatArray(0), 20.0, 30.0).size)
		assertEquals(0, gridMarks(FloatArray(0), FloatArray(0), 0.0, 30.0).size)
	}
}
