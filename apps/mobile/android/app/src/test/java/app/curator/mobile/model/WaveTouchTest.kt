package app.curator.mobile.model

import app.curator.mobile.model.WaveTouch.Act
import org.junit.Assert.assertEquals
import org.junit.Test

class WaveTouchTest {
	private fun one(x: Float, y: Float = 0f, id: Long = 1) = listOf(Finger(id, x, y))
	private fun two(x1: Float, x2: Float) = listOf(Finger(1, x1, 0f), Finger(2, x2, 0f))
	private val none = emptyList<Finger>()

	@Test
	fun `one finger scrubs once past the slop, from there`() {
		val t = WaveTouch(10f, yields = false)
		assertEquals(Act.Idle(false), t.on(one(100f)))
		assertEquals(Act.Idle(false), t.on(one(108f)))
		assertEquals(Act.Begin, t.on(one(112f)))
		assertEquals(Act.Scrub(120f, 8f), t.on(one(120f)))
		assertEquals(Act.End, t.on(none))
	}

	@Test
	fun `a touch that doesn't move scrubs nothing`() {
		val t = WaveTouch(10f, yields = false)
		t.on(one(100f))
		t.on(one(105f))
		assertEquals(Act.Idle(false), t.on(none))
	}

	@Test
	fun `two fingers never scrub, also when the first lands earlier`() {
		val t = WaveTouch(10f, yields = false)
		t.on(one(100f))
		t.on(one(106f))
		assertEquals(Act.Idle(true), t.on(two(106f, 306f)))
		assertEquals(Act.Spread(1.5f), t.on(two(56f, 356f)))
		assertEquals(Act.Idle(true), t.on(none))
	}

	@Test
	fun `a second finger calls a scrub off, and the gesture never seeks`() {
		val t = WaveTouch(10f, yields = false)
		t.on(one(100f))
		assertEquals(Act.Begin, t.on(one(120f)))
		t.on(one(150f))
		assertEquals(Act.CallOff, t.on(two(150f, 350f)))
		assertEquals(Act.Spread(0.5f), t.on(two(200f, 300f)))
		assertEquals(Act.Idle(true), t.on(none))
	}

	@Test
	fun `the finger left after a pinch moves nothing, and a new pair starts afresh`() {
		val t = WaveTouch(10f, yields = false)
		t.on(one(100f))
		t.on(two(100f, 300f))
		assertEquals(Act.Idle(true), t.on(one(250f, id = 2)))
		assertEquals(Act.Idle(true), t.on(one(50f, id = 2)))
		// Another finger lands: no jump from the pair before.
		assertEquals(Act.Idle(true), t.on(listOf(Finger(2, 50f, 0f), Finger(3, 450f, 0f))))
		assertEquals(Act.Spread(0.5f), t.on(listOf(Finger(2, 50f, 0f), Finger(3, 250f, 0f))))
	}

	@Test
	fun `a pinch straight up and down zooms too, and fingers together don't run away`() {
		val t = WaveTouch(10f, yields = false)
		t.on(listOf(Finger(1, 0f, 0f), Finger(2, 0f, 100f)))
		assertEquals(Act.Spread(2f), t.on(listOf(Finger(1, 0f, 0f), Finger(2, 0f, 200f))))
		assertEquals(Act.Spread(0.1f), t.on(listOf(Finger(1, 0f, 0f), Finger(2, 0f, 1f))))
	}

	@Test
	fun `a page's scroll is left alone, and so is a move another took`() {
		val t = WaveTouch(10f, yields = true)
		t.on(one(100f))
		assertEquals(Act.Idle(false), t.on(one(102f, 20f)))
		assertEquals(Act.Idle(false), t.on(one(300f, 20f)))
		val u = WaveTouch(10f, yields = true)
		u.on(one(100f))
		u.on(one(105f), taken = true)
		assertEquals(Act.Idle(false), u.on(one(300f)))
	}

	@Test
	fun `taken away in the middle of a scrub, it is called off`() {
		val t = WaveTouch(10f, yields = false)
		t.on(one(100f))
		t.on(one(120f))
		assertEquals(Act.CallOff, t.cancel())
		assertEquals(Act.Idle(false), t.cancel())
	}
}
