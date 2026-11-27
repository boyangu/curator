package app.curator.mobile.ui.nav

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerId
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChangeIgnoreConsumed
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import app.curator.mobile.model.SheetDrag
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

/**
 * The player sheet's drag (model SheetDrag decides; this moves it): [open]
 * with the sheet to raise from a closed bar, [close] for the one on top;
 * then [drag] to each height it is raised by, and [end] with whether it
 * settles open. [height]: how far it travels, from the bar's top to the
 * screen's.
 */
class SheetGestures internal constructor(
	val height: () -> Float,
	val open: (Screen) -> Unit,
	val close: () -> Unit,
	val drag: (Float) -> Unit,
	val end: (Boolean) -> Unit,
)

val LocalSheetGestures = staticCompositionLocalOf<SheetGestures?> { null }

/**
 * A player sheet on the move, read while drawing: whether one is [moving],
 * how far it has been raised ([reveal], px) of how far it goes ([height]),
 * and whether the bar is part of it ([viaBar]: raised from the bar, its top
 * starting at the bar's, or lowered to it), so the bar's cover and names can
 * be carried into the player rather than faded.
 */
class SheetMotion internal constructor(val moving: () -> Boolean, val reveal: () -> Float, val height: () -> Float, val viaBar: () -> Boolean) {
	/** How far the bar has turned into the player (model SheetDrag.morph): 0 with no sheet moving. */
	fun step(): Float = if (moving()) SheetDrag.morph(reveal(), height()) else 0f

	/** How much of the player shows: all of it unless a sheet is moving. */
	fun shown(): Float = if (moving()) step() else 1f
}

val LocalSheetMotion = staticCompositionLocalOf { SheetMotion({ false }, { 0f }, { 0f }, { false }) }

// The sheet's settle, as the design times it (280 ms, cubic-bezier(.2,.8,.2,1)).
private val SETTLE = tween<Float>(280, easing = CubicBezierEasing(0.2f, 0.8f, 0.2f, 1f))

// Both edges belong to the system's back gesture (gesture navigation): a
// swipe that starts there is never ours.
private val EDGE = 32.dp

private val SHEET_SHAPE = RoundedCornerShape(topStart = 14.dp, topEnd = 14.dp)

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
		pageSwipe(down.id, accepts = { it < 0 }, onStart = { gestures.begin(page()) }, onDrag = gestures.drag, onEnd = gestures.end)
	}
}

/**
 * Follows one pointer until it lifts: past the touch slop horizontally, in a
 * direction [accepts] takes (given the first move's dx), it is a page swipe
 * (its moves are taken from then on, so the row under the finger does not
 * also get a tap); vertically first, or a move a child already took, it is
 * someone else's (a list's scroll, the waveform's scrub) and is let go.
 * [onEnd] runs even if the gesture is cancelled, so a page never stays half open.
 */
private suspend fun AwaitPointerEventScope.pageSwipe(
	id: PointerId,
	accepts: (Float) -> Boolean,
	onStart: (Float) -> Unit,
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
				if (abs(dx) > slop && abs(dx) > abs(dy)) {
					if (!accepts(dx)) break
					swiping = true
					onStart(dx)
				} else continue
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
 * kept by the holder), the top two while one slides over the other: from the
 * right for a screen, up from the bottom for the player sheet ([y], its
 * visible height), the screen beneath dimmed as it rises.
 */
@Composable
fun StackHost(
	nav: Nav,
	// Where a sheet raised from the bar rests when lowered: the bar's top, if there has been one.
	barTop: () -> Float? = { null },
	overlay: @Composable () -> Unit = {},
	content: @Composable (Screen) -> Unit,
) {
	val holder = rememberSaveableStateHolder()
	val scope = rememberCoroutineScope()
	val stack = nav.stack
	val top = stack.last()

	BoxWithConstraints(Modifier.fillMaxSize().background(C.bg)) {
		val width = with(LocalDensity.current) { maxWidth.toPx() }
		val height = with(LocalDensity.current) { maxHeight.toPx() }
		val x = remember { Animatable(0f) }
		val y = remember { Animatable(0f) }
		// Whether the entry moving is a sheet (vertical) rather than a page.
		var vertical by remember { mutableStateOf(false) }
		// Whether the sheet moving goes from or to the bar (SheetMotion.viaBar),
		// and how far it travels: up from the bar's top, or from the screen's foot.
		var viaBar by remember { mutableStateOf(false) }
		var travel by remember { mutableFloatStateOf(height) }
		fun fromBar(): Float = barTop()?.takeIf { it > 0f && it < height } ?: height
		// The entry sliding (over `under`) and the one beneath it, while one moves.
		var over by remember { mutableStateOf<Nav.Entry?>(null) }
		var under by remember { mutableStateOf<Nav.Entry?>(null) }
		var settled by remember { mutableStateOf(top) }
		var settledTab by remember { mutableStateOf(nav.tab) }
		var settledSize by remember { mutableStateOf(stack.size) }
		// A swipe in progress: opening (a page not yet pushed) or closing.
		var dragging by remember { mutableStateOf<String?>(null) }

		fun settle() { over = null; under = null; vertical = false; settled = nav.top; settledSize = nav.stack.size }

		LaunchedEffect(top.id, nav.tab) {
			if (nav.tab != settledTab) { settledTab = nav.tab; x.snapTo(0f); settle(); return@LaunchedEffect }
			if (top === settled) return@LaunchedEffect
			val pushed = nav.stack.size >= settledSize
			// Next in the player: the track changes in place, the sheet stays up.
			if (pushed && nav.stack.size == settledSize && top.screen.isSheet && settled.screen.isSheet) { settle(); return@LaunchedEffect }
			if (pushed && top.screen.isSheet) {
				// Pushed (a row's tap), not raised from the bar.
				if (over !== top) { under = settled; over = top; viaBar = false; travel = height; y.snapTo(0f) }
				vertical = true
				y.animateTo(travel, SETTLE)
				settle()
				return@LaunchedEffect
			}
			if (!pushed && settled.screen.isSheet) {
				if (over !== settled) { over = settled; under = top; viaBar = true; travel = fromBar(); y.snapTo(travel) }
				vertical = true
				y.animateTo(0f, SETTLE)
				settle()
				return@LaunchedEffect
			}
			if (pushed) {
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

		val sheets = remember(nav) {
			SheetGestures(
				height = { fromBar() },
				open = { screen ->
					dragging = "sheet"
					vertical = true
					viaBar = true
					travel = fromBar()
					under = nav.top
					over = Nav.Entry(screen)
					scope.launch { y.snapTo(0f) }
				},
				close = {
					dragging = "sheet"
					vertical = true
					viaBar = true
					travel = fromBar()
					over = nav.top
					under = nav.stack.getOrNull(nav.stack.size - 2)
					scope.launch { y.snapTo(travel) }
				},
				drag = { r -> scope.launch { y.snapTo(r.coerceIn(0f, travel)) } },
				end = { open ->
					dragging = null
					scope.launch {
						val o = over ?: return@launch
						val pushedYet = nav.top === o
						when {
							// Pushed or popped: the effect above settles it from where the finger left it.
							open && !pushedYet -> nav.pushEntry(o)
							!open && pushedYet -> nav.pop()
							else -> { y.animateTo(if (open) travel else 0f, SETTLE); settle() }
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
					down.id, accepts = { it > 0 },
					onStart = {
						dragging = "close"
						over = nav.top
						under = nav.stack.getOrNull(nav.stack.size - 2)
					},
					onDrag = gestures.drag, onEnd = gestures.end,
				)
			}
		}

		// Swipe sideways on a main view's root: the view beside it (Home, Feed,
		// Library, Explore) follows the finger in, as a pager would. Only at a
		// root: a pushed screen's swipe left is its Actions page.
		val tx = remember { Animatable(0f) }
		var beside by remember { mutableStateOf<Tab?>(null) }
		var besideDir by remember { mutableIntStateOf(0) }
		val tabSwipe = Modifier.pointerInput(top.id, nav.tab) {
			if (nav.stack.size > 1 || nav.tab !in Tab.swipeable) return@pointerInput
			val edge = EDGE.toPx()
			fun dirOf(dx: Float) = if (dx < 0) 1 else -1
			awaitEachGesture {
				val down = awaitFirstDown(requireUnconsumed = false)
				if (down.position.x < edge || down.position.x > size.width - edge) return@awaitEachGesture
				pageSwipe(
					down.id,
					accepts = { dx -> nav.beside(dirOf(dx)) != null },
					onStart = { dx -> besideDir = dirOf(dx); beside = nav.beside(besideDir) },
					onDrag = { dx -> scope.launch { tx.snapTo(if (besideDir > 0) dx.coerceIn(-width, 0f) else dx.coerceIn(0f, width)) } },
					onEnd = { velocity ->
						scope.launch {
							val t = beside ?: return@launch
							val flung = if (besideDir > 0) velocity < -800f else velocity > 800f
							if (abs(tx.value) > width * 0.33f || flung) {
								tx.animateTo(-besideDir * width, tween(180))
								// One frame: the view beside becomes the tab's top in place (same key, same composition).
								beside = null
								nav.select(t)
							} else {
								tx.animateTo(0f, tween(180))
								beside = null
							}
							tx.snapTo(0f)
						}
					},
				)
			}
		}

		BackHandler(enabled = stack.size > 1) { nav.pop() }

		val motion = remember { SheetMotion(moving = { vertical && over != null }, reveal = { y.value }, height = { travel }, viaBar = { viaBar }) }
		CompositionLocalProvider(LocalPageGestures provides gestures, LocalSheetGestures provides sheets, LocalSheetMotion provides motion) {
			val o = over
			val u = under
			val b = beside?.let { nav.topOf(it) }
			val visible = if (b != null) listOf(top, b) else if (o == null || u == null) listOf(top) else listOf(u, o)
			// One keyed loop, one chain of modifiers for every entry: an entry
			// keeps its composition and its gesture detectors (a swipe in
			// progress) as it goes from settled to beneath to sliding; only the
			// values inside the chain change.
			for (e in visible) key(e.id) {
				val sliding = e === o && b == null
				val beneath = e === u && o != null && b == null
				val rising = sliding && vertical
				Box(
					Modifier
						.fillMaxSize()
						.graphicsLayer {
							translationX = when {
								b == null -> if (sliding && !vertical) x.value else 0f
								e === b -> tx.value + besideDir * width
								else -> tx.value
							}
							translationY = if (rising) travel - y.value else 0f
							// Rounded at the top until it covers the screen.
							val round = rising && y.value < travel
							shape = if (round) SHEET_SHAPE else RectangleShape
							clip = round
						}
						.drawBehind {
							if (rising) {
								// Raised from the bar, it fades in over it with the rest (SheetMotion.shown).
								val a = motion.shown()
								// Its shadow over what it rises from (0 -8px 24px rgba(0,0,0,.5)).
								val h = 24.dp.toPx() + 8.dp.toPx()
								drawRect(
									Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.5f)), startY = -h, endY = 0f),
									topLeft = Offset(0f, -h), size = Size(size.width, h), alpha = a,
								)
								drawRect(C.bg, alpha = if (viaBar) a else 1f)
								return@drawBehind
							}
							// The one shadow the design allows: a page sliding over (-8px 0 24px rgba(0,0,0,.5)).
							if (!sliding) return@drawBehind
							val w = 24.dp.toPx() + 8.dp.toPx()
							drawRect(
								Brush.horizontalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.5f)), startX = -w, endX = 0f),
								topLeft = Offset(-w, 0f), size = Size(w, size.height),
							)
						}
						.then(if (rising) Modifier else Modifier.background(C.bg))
						// Beneath a rising sheet: dimmed with its reveal.
						.then(if (beneath && vertical) Modifier.drawWithContent { drawContent(); drawRect(Color.Black, alpha = SheetDrag.dim(y.value, travel)) } else Modifier)
						.then(if (e === top) closeSwipe.then(tabSwipe) else Modifier)
						// Beneath: seen but not reachable (TalkBack skips it).
						.then(if (beneath) Modifier.clearAndSetSemantics {} else Modifier),
				) { holder.SaveableStateProvider(e.id) { content(e.screen) } }
			}
			overlay()
		}
	}
}
