package app.curator.mobile.ui.chrome

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.model.Axis
import app.curator.mobile.model.AxisLock
import app.curator.mobile.model.SheetDrag
import app.curator.mobile.player.Player
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.nav.LocalSheetGestures
import app.curator.mobile.ui.nav.LocalSheetMotion
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.nav.SheetGestures
import app.curator.mobile.ui.nav.Tab
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.track.LocalPlayerMorph
import app.curator.mobile.ui.track.PlayerMorph

private val TAB_ICONS = mapOf(Tab.HOME to Icon.Home, Tab.FEED to Icon.Feed, Tab.LIBRARY to Icon.Library, Tab.EXPLORE to Icon.Explore, Tab.SEARCH to Icon.Search)

/** Home, Feed, Library, Explore, Search: the active one's label in fg, icon in accent. */
@Composable
fun TabBar(active: Tab, onSelect: (Tab) -> Unit) {
	Row(
		Modifier
			.fillMaxWidth()
			.background(C.bg1)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
			.windowInsetsPadding(WindowInsets.navigationBars)
			.height(56.dp)
			.padding(horizontal = 4.dp),
	) {
		for (tab in Tab.entries) {
			val on = tab == active
			Column(
				Modifier
					.weight(1f)
					.fillMaxHeight()
					.clickable(role = Role.Tab) { onSelect(tab) }
					.semantics { selected = on },
				horizontalAlignment = Alignment.CenterHorizontally,
				verticalArrangement = Arrangement.Center,
			) {
				IconGlyph(TAB_ICONS.getValue(tab), if (on) C.accent else C.fg2, 22.dp, 1.6f)
				Spacer(Modifier.height(4.dp))
				BasicText(tab.label, style = T.of(11.sp, 500, if (on) C.fg else C.fg2))
			}
		}
	}
}

/**
 * The mini player (72dp, over the tab bar): cover, title over artists, the
 * heart and play/pause. A tap on the rest opens the player, a drag up raises
 * it with the finger ([open]: the player to raise; null for a track the
 * library doesn't hold, which has no player view). Horizontal is kept for
 * swipe-to-skip later: the axis is decided after 10dp, never by the first
 * pixel. The heart and play/pause keep their own touches.
 *
 * The heart: filled while the library holds the track; a tap on an empty one
 * marks it Interested (bringing it into the library), on a filled one opens
 * Organize, as a long press on either does ([onHeart] null: no heart).
 */
@Composable
fun MiniBar(
	player: Player,
	inLibrary: Boolean,
	onHeart: (() -> Unit)?,
	onOrganize: () -> Unit,
	open: (() -> Screen)?,
) {
	val state by player.state.collectAsState()
	val t = state.track ?: return
	// Read only while drawing the border, so the bar itself never recomposes as it plays.
	val position = player.position.collectAsState()
	val sheet = LocalSheetGestures.current
	val motion = LocalSheetMotion.current
	// Its cover and names are carried into the player as it rises (PlayerMorph); hidden here meanwhile.
	val morph = LocalPlayerMorph.current
	SideEffect { morph?.barTrack = t.trackId }
	val carried = Modifier.graphicsLayer { alpha = if (morph?.carrying(motion) == true) 0f else 1f }
	fun Modifier.at(put: PlayerMorph.(LayoutCoordinates) -> Unit) = if (morph != null) onGloballyPositioned { morph.put(it) } else this
	val haptics = LocalHapticFeedback.current
	val raise: (() -> Unit)? = if (open != null && sheet != null) { { sheet.open(open()); sheet.end(true) } } else null
	val label = "Open player: ${t.title}" + (if (t.artist.isNotEmpty()) " by ${t.artist}" else "") + ". Swipe up to open"
	Row(
		Modifier
			.fillMaxWidth()
			.height(72.dp)
			.at { barTop = it.positionInRoot().y }
			.graphicsLayer { alpha = 1f - motion.step() }
			.background(C.bg2)
			.drawBehind {
				// The top border is the progress: the played part filled in.
				val h = 2.dp.toPx()
				drawRect(C.line, Offset.Zero, Size(size.width, h))
				val d = t.durationSec
				if (d > 0) drawRect(C.fg, Offset.Zero, Size(size.width * (position.value / d).coerceIn(0.0, 1.0).toFloat(), h))
				// The grip: it pulls up.
				val w = 36.dp.toPx()
				drawRoundRect(C.fg4, Offset((size.width - w) / 2, 5.dp.toPx()), Size(w, 4.dp.toPx()), CornerRadius(2.dp.toPx()))
			}
			.then(if (open != null && sheet != null) Modifier.barDrag(sheet, open) else Modifier)
			.padding(start = 12.dp, end = 4.dp, top = 6.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Row(
			Modifier
				.weight(1f)
				.semantics(mergeDescendants = true) {
					contentDescription = label
					role = Role.Button
					if (raise != null) onClick("open the player") { raise(); true }
				},
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(12.dp),
		) {
			Cover(t.coverUrl, t.trackId, 44.dp, Modifier.at { barCover = it }.then(carried))
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
				Line(t.title, T.of(14.5.sp, color = C.fg), Modifier.at { barTitle = it }.then(carried))
				if (t.artist.isNotEmpty()) Line(t.artist, T.of(12.5.sp, color = C.fg2), Modifier.at { barArtist = it }.then(carried))
			}
		}
		if (onHeart != null) {
			Box(
				Modifier
					.size(44.dp)
					.ownTouches()
					.pointerInput(onHeart, onOrganize) {
						detectTapGestures(
							onTap = { if (inLibrary) onOrganize() else onHeart() },
							onLongPress = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); onOrganize() },
						)
					}
					.semantics {
						contentDescription = if (inLibrary) "Organize" else "Add to Interested"
						role = Role.Button
						onClick { if (inLibrary) onOrganize() else onHeart(); true }
						onLongClick("organize") { onOrganize(); true }
					},
				contentAlignment = Alignment.Center,
			) { IconGlyph(if (inLibrary) Icon.HeartFill else Icon.Heart, if (inLibrary) C.accent else C.fg, 22.dp, 1.6f) }
		}
		IconButton(
			if (state.playing) Icon.Pause else Icon.Play,
			if (state.playing) "Pause" else "Play",
			tint = C.fg,
			modifier = Modifier.ownTouches(),
			onClick = { if (state.playing) player.pause() else player.play() },
		)
	}
}

/**
 * A control inside the bar keeps its touch: its down is taken after the
 * control has seen it (an outer modifier sees it second), so the bar's drag,
 * which waits for an untaken down, never starts from it.
 */
private fun Modifier.ownTouches(): Modifier = pointerInput(Unit) {
	awaitEachGesture { awaitFirstDown(requireUnconsumed = false).consume() }
}

/**
 * The bar's drag: up raises the player with the finger, and the last
 * direction decides on release (model SheetDrag); a touch that hardly moved
 * opens it; sideways is let go.
 */
private fun Modifier.barDrag(sheet: SheetGestures, open: () -> Screen): Modifier = pointerInput(sheet) {
	val drag = SheetDrag(tapSlop = 6.dp.toPx(), step = 2.dp.toPx())
	awaitEachGesture {
		val down = awaitFirstDown()
		val lock = AxisLock(10.dp.toPx())
		drag.start(open = false, height = sheet.height())
		var raising = false
		var lifted = false
		try {
			while (true) {
				val ev = awaitPointerEvent()
				val ch = ev.changes.firstOrNull { it.id == down.id } ?: break
				if (!ch.pressed) { lifted = true; break }
				val d = ch.positionChange()
				drag.move(d.y)
				when (lock.move(d.x, d.y)) {
					Axis.HORIZONTAL -> return@awaitEachGesture
					Axis.VERTICAL -> {
						if (!raising) { raising = true; sheet.open(open()) }
						sheet.drag(drag.reveal)
						ch.consume()
					}
					Axis.UNDECIDED -> {}
				}
			}
		} finally {
			if (raising) sheet.end(lifted && drag.release())
		}
		if (!raising && lifted && drag.tap) {
			sheet.open(open())
			sheet.end(true)
		}
	}
}

/** The bottom of Home and track lists: the mini player above the tab bar. */
@Composable
fun BottomChrome(miniPlayer: @Composable () -> Unit, tab: Tab, onSelect: (Tab) -> Unit) {
	Column(Modifier.fillMaxWidth()) {
		miniPlayer()
		TabBar(tab, onSelect)
	}
}
