package app.curator.mobile.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayerSheetTest {
	private val h = 800f
	private fun drag(open: Boolean) = SheetDrag(tapSlop = 6f, step = 2f).apply { start(open, h) }

	@Test
	fun `the sheet follows the finger, clamped to the screen`() {
		val d = drag(open = false)
		assertEquals(300f, d.move(-300f))
		assertEquals(h, d.move(-900f))
		assertEquals(0f, drag(open = false).move(50f))
	}

	@Test
	fun `the last direction decides, not the distance`() {
		// Most of the way up, then down a little: closes.
		val d = drag(open = false)
		d.move(-700f)
		d.move(10f)
		assertFalse(d.release())
		// A short pull up: opens.
		val e = drag(open = false)
		e.move(-40f)
		assertTrue(e.release())
		// From open, down then up again: stays open.
		val f = drag(open = true)
		f.move(500f)
		f.move(-5f)
		assertTrue(f.release())
	}

	@Test
	fun `a jitter smaller than a step does not turn it`() {
		val d = drag(open = false)
		d.move(-200f)
		d.move(1f)
		assertTrue(d.release())
	}

	@Test
	fun `under the tap slop it is a tap, which toggles`() {
		val closed = drag(open = false)
		closed.move(-3f)
		closed.move(2f)
		assertTrue(closed.tap)
		assertTrue(closed.release())
		val open = drag(open = true)
		open.move(4f)
		assertTrue(open.tap)
		assertFalse(open.release())
		val moved = drag(open = false)
		moved.move(-6f)
		assertFalse(moved.tap)
	}

	@Test
	fun `the dim and the bar follow the reveal`() {
		assertEquals(0f, SheetDrag.dim(0f, h))
		assertEquals(0.4f, SheetDrag.dim(400f, h), 1e-6f)
		assertEquals(0.6f, SheetDrag.dim(h, h))
		assertEquals(1f, SheetDrag.barAlpha(0f, 160f))
		assertEquals(0.5f, SheetDrag.barAlpha(80f, 160f))
		assertEquals(0f, SheetDrag.barAlpha(400f, 160f))
	}

	@Test
	fun `the axis is decided after the slop and then kept`() {
		val lock = AxisLock(10f)
		assertEquals(Axis.UNDECIDED, lock.move(4f, -3f))
		assertEquals(Axis.VERTICAL, lock.move(1f, -8f))
		assertEquals(Axis.VERTICAL, lock.move(50f, 0f))
		val side = AxisLock(10f)
		assertEquals(Axis.HORIZONTAL, side.move(9f, 5f))
	}
}
