package app.curator.mobile.ui.nav

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChangeIgnoreConsumed
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import app.curator.mobile.ui.theme.C
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlin.math.abs

/**
 * What a screen can ask of the host: open a page with a swipe that follows
 * the finger (Track and track lists open their Actions page this way), or
 * close itself the same way. iOS-style push and pop, right to left.
 */
class PageGestures internal constructor(
	internal val scope: CoroutineScope,
	internal val begin: (Screen) -> Unit,
	internal val drag: (Float) -> Unit,
	internal val end: (Float) -> Unit,
)

val LocalPageGestures = staticCompositionLocalOf<PageGestures?> { null }

// Both edges belong to the system's back gesture (gesture navigation): a
// swipe that starts there is never ours.
private val EDGE = 32.dp

/**
 * A horizontal swipe left, started away from the edges, that opens [page]
 * and follows the finger. A child that takes the drag first (the big
 * waveform's scrub) keeps it.
 *
 * Keyed on the host's gestures alone: a screen's page never changes, and a key
 * that does (a lambda made anew on each recomposition, as a cover loads) would
 * restart the detector in the middle of a swipe.
 */
fun Modifier.swipeToOpen(gestures: PageGestures?, page: () -> Screen): Modifier = if (gestures == null) this else pointerInput(gestures) {
	val edge = EDGE.toPx()
	awaitEachGesture {
		val down = awaitFirstDown(requireUnconsumed = false)
		if (down.position.x < edge || down.position.x > size.width - edge) return@awaitEachGesture
		pageSwipe(down.id, leftward = true, onStart = { gestures.begin(page()) }, onDrag = gestures.drag, onEnd = gestures.end)
	}
}

/**
 * Follows one pointer until it lifts: past the touch slop horizontally in the
 * given direction it is a page swipe (its moves are taken from then on, so
 * the row under the finger does not also get a tap); vertically first, or a
 * move a child already took, it is someone else's (a list's scroll, the
 * waveform's scrub) and is let go. [onEnd] runs even if the gesture is
 * cancelled, so a page never stays half open.
 */
private suspend fun AwaitPointerEventScope.pageSwipe(
	id: PointerId,
	leftward: Boolean,
	onStart: () -> Unit,
	onDrag: (Float) -> Unit,
	onEnd: (Float) -> Unit,
) {
	val tracker = VelocityTracker()
	val slop = viewConfiguration.touchSlop
	var dx = 0f
	var dy = 0f
	var swiping = false
	try {
		while (true) {
			val ev = awaitPointerEvent()
			val ch = ev.changes.firstOrNull { it.id == id } ?: break
			if (!ch.pressed) break
			if (!swiping && ch.isConsumed) break
			val d = ch.positionChangeIgnoreConsumed()
			dx += d.x
			dy += d.y
			tracker.addPosition(ch.uptimeMillis, ch.position)
			if (!swiping) {
				if (abs(dy) > slop && abs(dy) > abs(dx)) break
				if ((if (leftward) -dx else dx) > slop && abs(dx) > abs(dy)) { swiping = true; onStart() } else continue
			}
			ch.consume()
			onDrag(dx)
		}
	} finally {
		if (swiping) onEnd(tracker.calculateVelocity().x)
	}
}

/**
 * Renders the current tab's stack: the top screen alone once settled (a
 * covered screen leaves the composition and the accessibility tree, its state
 * kept by the holder), the top two while one slides over the other.
 */
@Composable
fun StackHost(nav: Nav, content: @Composable (Screen) -> Unit) {
	val holder = rememberSaveableStateHolder()
	val scope = rememberCoroutineScope()
	val stack = nav.stack
	val top = stack.last()

	BoxWithConstraints(Modifier.fillMaxSize().background(C.bg)) {
		val width = with(LocalDensity.current) { maxWidth.toPx() }
		val x = remember { Animatable(0f) }
		// The entry sliding (over `under`) and the one beneath it, while one moves.
		var over by remember { mutableStateOf<Nav.Entry?>(null) }
		var under by remember { mutableStateOf<Nav.Entry?>(null) }
		var settled by remember { mutableStateOf(top) }
		var settledTab by remember { mutableStateOf(nav.tab) }
		var settledSize by remember { mutableStateOf(stack.size) }
		// A swipe in progress: opening (a page not yet pushed) or closing.
		var dragging by remember { mutableStateOf<String?>(null) }

		fun settle() { over = null; under = null; settled = nav.top; settledSize = nav.stack.size }

		LaunchedEffect(top.id, nav.tab) {
			if (nav.tab != settledTab) { settledTab = nav.tab; x.snapTo(0f); settle(); return@LaunchedEffect }
			if (top === settled) return@LaunchedEffect
			if (nav.stack.size >= settledSize) {
				// Pushed (or a swipe committed one): slide the new top in.
				if (over !== top) { under = settled; over = top; x.snapTo(width) }
				x.animateTo(0f, tween(240))
			} else {
				// Popped: slide the old top out over the one now on top.
				if (over !== settled) { over = settled; under = top; x.snapTo(0f) }
				x.animateTo(width, tween(240))
			}
			x.snapTo(0f)
			settle()
		}

		val gestures = remember(nav) {
			PageGestures(
				scope = scope,
				begin = { page ->
					dragging = "open"
					under = nav.top
					over = Nav.Entry(page)
					scope.launch { x.snapTo(width) }
				},
				drag = { dx -> scope.launch { x.snapTo(if (dragging == "open") (width + dx).coerceIn(0f, width) else dx.coerceIn(0f, width)) } },
				end = { velocity ->
					val mode = dragging
					dragging = null
					scope.launch {
						if (mode == "open") {
							if (x.value < width * 0.66f || velocity < -800f) nav.pushEntry(over!!)
							else { x.animateTo(width, tween(180)); x.snapTo(0f); settle() }
						} else {
							if (x.value > width * 0.33f || velocity > 800f) nav.pop()
							else { x.animateTo(0f, tween(180)); settle() }
						}
					}
				},
			)
		}

		// Swipe right on a page closes it (started away from the left edge).
		val closeSwipe = Modifier.pointerInput(top.id) {
			if (!top.screen.isPage) return@pointerInput
			val edge = EDGE.toPx()
			awaitEachGesture {
				val down = awaitFirstDown(requireUnconsumed = false)
				if (down.position.x < edge) return@awaitEachGesture
				pageSwipe(
					down.id, leftward = false,
					onStart = {
						dragging = "close"
						over = nav.top
						under = nav.stack.getOrNull(nav.stack.size - 2)
					},
					onDrag = gestures.drag, onEnd = gestures.end,
				)
			}
		}

		BackHandler(enabled = stack.size > 1) { nav.pop() }

		CompositionLocalProvider(LocalPageGestures provides gestures) {
			val o = over
			val u = under
			val visible = if (o == null || u == null) listOf(top) else listOf(u, o)
			// One keyed loop, one chain of modifiers for every entry: an entry
			// keeps its composition and its gesture detectors (a swipe in
			// progress) as it goes from settled to beneath to sliding; only the
			// values inside the chain change.
			for (e in visible) key(e.id) {
				val sliding = e === o
				val beneath = e === u && o != null
				Box(
					Modifier
						.fillMaxSize()
						.graphicsLayer { translationX = if (sliding) x.value else 0f }
						.drawBehind {
							// The one shadow the design allows: a page sliding over (-8px 0 24px rgba(0,0,0,.5)).
							if (!sliding) return@drawBehind
							val w = 24.dp.toPx() + 8.dp.toPx()
							drawRect(
								Brush.horizontalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.5f)), startX = -w, endX = 0f),
								topLeft = Offset(-w, 0f), size = Size(w, size.height),
							)
						}
						.background(C.bg)
						.then(if (e === top) closeSwipe else Modifier)
						// Beneath: seen but not reachable (TalkBack skips it).
						.then(if (beneath) Modifier.clearAndSetSemantics {} else Modifier),
				) { holder.SaveableStateProvider(e.id) { content(e.screen) } }
			}
		}
	}
}
