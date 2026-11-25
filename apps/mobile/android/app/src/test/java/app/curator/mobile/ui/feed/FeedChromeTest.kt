package app.curator.mobile.ui.feed

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource.Companion.UserInput
import org.junit.Assert.assertEquals
import org.junit.Test

class FeedChromeTest {
	// A list of 5000 px to scroll, under a chrome of header 100, drawer 60, footer 300.
	private var at = 0f
	private val chrome = FeedChrome(100f, 60f) { at }.apply { footerPx = 300f }

	/** The finger moves [dy] (down is positive): as a list's scroll dispatches it. */
	private fun swipe(dy: Float, steps: Int = 10) = repeat(steps) {
		val d = Offset(0f, dy / steps)
		val pre = chrome.connection.onPreScroll(d, UserInput)
		val left = d.y - pre.y
		val moved = -((at - left).coerceIn(0f, 5000f) - at)
		at -= moved
		chrome.connection.onPostScroll(Offset(0f, moved), Offset(0f, left - moved), UserInput)
	}

	private fun assertChrome(header: Float, footer: Float, drawer: Float) {
		assertEquals("header", header, chrome.header, 0.01f)
		assertEquals("footer", footer, chrome.footer, 0.01f)
		assertEquals("drawer", drawer, chrome.drawer, 0.01f)
	}

	@Test
	fun `it opens with the header and the footer, the drawer shut`() = assertChrome(0f, 0f, 0f)

	@Test
	fun `swiping up takes the header and the footer away as far as the cards move`() {
		swipe(-40f)
		assertChrome(40f, 40f, 0f)
		swipe(-110f)
		assertChrome(100f, 150f, 0f)
		swipe(-400f)
		assertChrome(100f, 300f, 0f)
	}

	@Test
	fun `swiping down brings both back as far as the cards move, without the drawer`() {
		swipe(-2000f)
		swipe(30f)
		assertChrome(70f, 270f, 0f)
		swipe(500f)
		assertChrome(0f, 0f, 0f)
	}

	@Test
	fun `at the top the pull goes on into the drawer, and the next swipe up puts it back first`() {
		swipe(-200f)
		swipe(230f, steps = 23)
		assertEquals(0f, at, 0.01f)
		assertChrome(0f, 0f, 30f)
		swipe(500f)
		assertChrome(0f, 0f, 60f)
		swipe(-40f)
		assertEquals(0f, at, 0.01f)
		assertChrome(0f, 0f, 20f)
		swipe(-50f)
		assertEquals(30f, at, 0.01f)
		assertChrome(30f, 30f, 0f)
	}

	@Test
	fun `a jump to the top shows the header and the footer, and swiping up goes on from there`() {
		swipe(-2000f)
		at = 0f
		assertChrome(0f, 0f, 0f)
		swipe(-40f)
		assertChrome(40f, 40f, 0f)
	}

	@Test
	fun `pinned, nothing moves and the drawer is out`() {
		val c = FeedChrome(100f, 60f, pinned = true) { 900f }.apply { footerPx = 300f }
		assertEquals(Offset.Zero, c.connection.onPreScroll(Offset(0f, -50f), UserInput))
		c.connection.onPostScroll(Offset(0f, -50f), Offset.Zero, UserInput)
		assertEquals(0f, c.header, 0f)
		assertEquals(0f, c.footer, 0f)
		assertEquals(60f, c.drawer, 0f)
	}
}
