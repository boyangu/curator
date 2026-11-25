package app.curator.mobile.ui.feed

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.unit.Velocity
import kotlin.math.max
import kotlin.math.min

/**
 * What surrounds the feed's cards: the header over them, the tab bar under
 * them and the filters' drawer below the header. All three move by what the
 * list scrolls, pixel for pixel, never on a clock of their own:
 *
 * - Scrolling on takes the header up and the tab bar down with the cards;
 *   scrolling back brings both in again, from anywhere in the list.
 * - At the list's top, pulling on (or a fling's momentum) draws the drawer
 *   out. The next scroll on puts it back before the cards move.
 *
 * Only what isn't a swipe slides by itself: the filter button, and a drawer
 * let go half open. Lengths are pixels. [fromTop]: how far the list is from
 * its top; nothing is further away than that, whatever moved the list (a
 * jump to the top, a filter that leaves it short). [pinned]: all of it stays.
 */
@Stable
class FeedChrome(val headerPx: Float, val drawerPx: Float, private val pinned: Boolean = false, private val fromTop: () -> Float) {
	private var headerGone by mutableFloatStateOf(0f)
	private var footerGone by mutableFloatStateOf(0f)
	private var drawn by mutableFloatStateOf(0f)

	/** The tab bar's height (and the mini player's), as laid out. */
	var footerPx by mutableFloatStateOf(0f)

	/** How much of the header is gone. */
	val header: Float get() = if (pinned) 0f else min(headerGone, fromTop())
	/** How much of the footer is gone. */
	val footer: Float get() = if (pinned) 0f else min(min(footerGone, fromTop()), footerPx)
	/** How much of the drawer is out; the cards are that much lower. */
	val drawer: Float get() = if (pinned) drawerPx else drawn

	val connection = object : NestedScrollConnection {
		override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
			if (pinned || available.y >= 0f || drawn <= 0f) return Offset.Zero
			val take = max(available.y, -drawn)
			drawn += take
			return Offset(0f, take)
		}

		override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
			if (pinned) return Offset.Zero
			if (consumed.y != 0f) {
				// A jump may have left these further than the list is from its top: go on from what shows.
				val h = min(headerGone, max(0f, fromTop() + consumed.y))
				val f = min(footerGone, max(0f, fromTop() + consumed.y))
				headerGone = (h - consumed.y).coerceIn(0f, headerPx)
				footerGone = (f - consumed.y).coerceIn(0f, footerPx)
			}
			// What the list couldn't scroll back: it is at its top.
			if (available.y <= 0f || drawn >= drawerPx) return Offset.Zero
			val take = min(available.y, drawerPx - drawn)
			drawn += take
			return Offset(0f, take)
		}

		override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
			if (!pinned && drawn > 0f && drawn < drawerPx) slide(if (drawn >= drawerPx / 2) drawerPx else 0f, headerGone)
			return Velocity.Zero
		}
	}

	/** The filter button: the drawer out, the header whole above it, or the drawer back in. */
	suspend fun toggle() {
		if (pinned) return
		if (drawn > 0f) slide(0f, headerGone) else slide(drawerPx, 0f)
	}

	private suspend fun slide(drawer: Float, header: Float) {
		val d0 = drawn
		val h0 = headerGone
		animate(0f, 1f, animationSpec = tween(160)) { t, _ ->
			drawn = d0 + (drawer - d0) * t
			headerGone = h0 + (header - h0) * t
		}
	}
}
