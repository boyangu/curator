package app.curator.mobile.ui.common

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min

private val BOX = 56.dp
// How far past fully shown the pull goes (at half the finger's speed) before it focuses the box.
private val FOCUS_PULL = 36.dp

/**
 * The search box above a list: a pull down at the list's top slides it in
 * from above, following the finger; pulled on past fully shown, it takes
 * focus and the keyboard comes up. Let go before it is mostly shown and it
 * slides away again; scrolling the list back up folds it away while it is
 * empty. Give the list's parent [connection] (Modifier.nestedScroll) and put
 * [PullSearchBox] above it.
 */
@Stable
class PullSearchState internal constructor(private val boxPx: Float, private val focusPx: Float) {
	/** Pixels of the box shown; past [boxPx] while pulled on. */
	var reveal by mutableFloatStateOf(0f)
		private set
	var query by mutableStateOf("")
	internal var focused by mutableStateOf(false)
	/** Bumped when the pull asks for the keyboard. */
	internal var focusAsk by mutableIntStateOf(0)
	private var settling = false

	private val held get() = query.isNotEmpty() || focused

	val connection = object : NestedScrollConnection {
		override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
			// Scrolling back up folds the box away before the list moves, unless it is in use.
			if (source != NestedScrollSource.UserInput || available.y >= 0f || reveal <= 0f || held) return Offset.Zero
			val take = max(available.y, -reveal)
			reveal += take
			return Offset(0f, take)
		}

		override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
			// What the list could not scroll down: it is at its top, so the pull is ours.
			if (source != NestedScrollSource.UserInput || available.y <= 0f || settling) return Offset.Zero
			val past = reveal >= boxPx
			reveal = min(reveal + available.y * (if (past) 0.5f else 1f), boxPx + focusPx)
			if (reveal >= boxPx + focusPx && !focused) focusAsk++
			return Offset(0f, available.y)
		}

		override suspend fun onPreFling(available: Velocity): Velocity {
			if (reveal <= 0f) return Velocity.Zero
			settleTo(if (reveal >= boxPx * 0.6f || held) boxPx else 0f)
			// A downward fling from a pull is spent on the box, not the list.
			return if (available.y > 0f) available else Velocity.Zero
		}
	}

	internal suspend fun settleTo(target: Float) {
		if (reveal == target) return
		settling = true
		try {
			animate(reveal, target, animationSpec = tween(160)) { v, _ -> reveal = v }
		} finally {
			settling = false
		}
	}
}

@Composable
fun rememberPullSearch(): PullSearchState {
	val d = LocalDensity.current
	return remember(d) { PullSearchState(with(d) { BOX.toPx() }, with(d) { FOCUS_PULL.toPx() }) }
}

@Composable
fun PullSearchBox(state: PullSearchState, placeholder: String) {
	val scope = rememberCoroutineScope()
	val focus = remember { FocusRequester() }
	val focusManager = LocalFocusManager.current
	val keyboard = LocalSoftwareKeyboardController.current
	val shownPx = state.reveal

	LaunchedEffect(state.focusAsk) {
		if (state.focusAsk == 0) return@LaunchedEffect
		focus.requestFocus()
		keyboard?.show()
	}

	fun close() {
		state.query = ""
		focusManager.clearFocus()
		keyboard?.hide()
		scope.launch { state.settleTo(0f) }
	}

	BackHandler(enabled = shownPx > 0f || state.focused) { close() }

	val boxPx = with(LocalDensity.current) { BOX.toPx() }
	val height = with(LocalDensity.current) { min(shownPx, boxPx).toDp() }
	// The box keeps its size and is uncovered from its bottom edge up: it slides in from above.
	Box(Modifier.fillMaxWidth().height(height).clipToBounds()) {
		Row(
			Modifier
				.align(Alignment.BottomStart)
				.fillMaxWidth()
				.height(BOX)
				.padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp)
				.background(C.bg2, RoundedCornerShape(8.dp))
				.padding(start = 12.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(10.dp),
		) {
			IconGlyph(Icon.Search, C.fg2, 18.dp)
			Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
				if (state.query.isEmpty()) BasicText(placeholder, style = T.of(15.sp, color = C.fg3), maxLines = 1)
				BasicTextField(
					state.query,
					onValueChange = { state.query = it },
					modifier = Modifier
						.fillMaxWidth()
						.focusRequester(focus)
						.onFocusChanged { state.focused = it.isFocused },
					singleLine = true,
					textStyle = T.of(15.sp, color = C.fg),
					cursorBrush = SolidColor(C.accent),
					keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
					keyboardActions = KeyboardActions(onSearch = { keyboard?.hide(); focusManager.clearFocus() }),
				)
			}
			if (state.query.isNotEmpty() || state.focused) IconButton(Icon.Close, "Close search", tint = C.fg2, size = 16.dp) { close() }
		}
	}
}
