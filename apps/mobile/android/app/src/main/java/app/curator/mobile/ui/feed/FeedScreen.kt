package app.curator.mobile.ui.feed

import android.view.accessibility.AccessibilityManager
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The news feed: full-width cards under the title bar, the tab bar under
 * them. Both bars and the filters' drawer go with the scroll (FeedChrome).
 */
@Composable
fun FeedScreen(model: AppModel, bottom: @Composable () -> Unit) {
	val feed = model.feed
	val player by model.player.state.collectAsState()
	val list = rememberLazyListState()
	val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
	val density = LocalDensity.current
	val context = LocalContext.current
	val scope = rememberCoroutineScope()
	// A screen reader does not scroll by hand: everything stays in reach of it.
	val explored = remember { (context.getSystemService(AccessibilityManager::class.java))?.isTouchExplorationEnabled == true }
	val chrome = remember(density, list) {
		with(density) {
			FeedChrome(HEADER.toPx(), DRAWER.toPx(), pinned = explored) {
				if (list.firstVisibleItemIndex == 0) list.firstVisibleItemScrollOffset.toFloat() else Float.MAX_VALUE
			}
		}
	}

	LaunchedEffect(player.unavailable, player.track?.trackId) {
		val why = player.unavailable
		if (why != null && player.track?.trackId == feed.lastPlayed) feed.notice = why
	}
	LaunchedEffect(feed.shown.firstOrNull()?.id) {
		if (feed.toTop) { feed.toTop = false; list.scrollToItem(0) }
	}
	// A filter picked starts at its top; coming back to the same one keeps its place.
	var filtered by rememberSaveable { mutableStateOf(feed.filter) }
	LaunchedEffect(feed.filter) {
		if (filtered == feed.filter) return@LaunchedEffect
		filtered = feed.filter
		list.scrollToItem(0)
	}

	BoxWithConstraints(Modifier.fillMaxSize().background(C.bg).clipToBounds().nestedScroll(chrome.connection)) {
		val width = maxWidth
		val shown = feed.shown
		val foot = with(density) { chrome.footerPx.toDp() }
		LazyColumn(
			// The open drawer pushes the cards down: it never covers one.
			Modifier.fillMaxSize().offset { IntOffset(0, chrome.drawer.roundToInt()) },
			list,
			contentPadding = PaddingValues(top = top + HEADER, bottom = foot + 16.dp + if (explored) DRAWER else 0.dp),
		) {
			if (shown.isEmpty()) item("empty") { Empty(feed) }
			itemsIndexed(shown, key = { _, r -> r.id }, contentType = { _, r -> r.release }) { i, r ->
				val item = feed.item(i, r.id)
				if (item == null) Spacer(Modifier.fillMaxWidth().height(width + 98.dp))
				else FeedCard(feed, item, width, playingId = player.track?.trackId?.takeIf { player.playing })
			}
		}
		val open by remember(chrome) { derivedStateOf { chrome.drawer > 0f } }
		// A swipe on the bars is one on the cards. It is taken here, where nothing
		// moves: a bar moving along under the finger would see it stand still.
		Box(
			Modifier
				.padding(top = top)
				.fillMaxWidth()
				.clipToBounds()
				.scrollable(list, Orientation.Vertical, reverseDirection = true)
				.layout { bars, c ->
					val p = bars.measure(c)
					layout(p.width, (chrome.headerPx - chrome.header + chrome.drawer).roundToInt()) { p.place(0, 0) }
				},
		) {
			// Out of the layout when closed, so nothing can reach it behind the header.
			if (open) Filters(feed, Modifier.offset { IntOffset(0, (chrome.headerPx - chrome.header - chrome.drawerPx + chrome.drawer).roundToInt()) })
			Header(feed, open, Modifier.offset { IntOffset(0, -chrome.header.roundToInt()) }) { scope.launch { chrome.toggle() } }
		}
		// Cards never run under the status bar's icons.
		Box(Modifier.fillMaxWidth().height(top).background(C.bg))
		Notice(feed, Modifier.align(Alignment.BottomCenter).offset { IntOffset(0, (chrome.footer - chrome.footerPx).roundToInt()) })
		Column(
			Modifier
				.align(Alignment.BottomCenter)
				.fillMaxWidth()
				.onSizeChanged { chrome.footerPx = it.height.toFloat() }
				.offset { IntOffset(0, chrome.footer.roundToInt()) }
				// A tap between its buttons isn't one on the card behind.
				.pointerInput(Unit) {},
		) { bottom() }
	}
}

private val HEADER = 52.dp
private val DRAWER = 52.dp

@Composable
private fun Header(feed: FeedModel, open: Boolean, modifier: Modifier, onFilters: () -> Unit) {
	Row(
		modifier
			.fillMaxWidth()
			.height(HEADER)
			.background(C.bg)
			.drawBehind { if (!open) drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
			.padding(start = 16.dp, end = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		BasicText("Feed", Modifier.weight(1f).semantics { heading() }, style = T.screenTitle)
		val filtered = feed.filter != FeedFilter.ALL
		IconButton(
			Icon.Filter, "Filters", tint = if (filtered) C.accent else if (open) C.fg else C.fg2, size = 20.dp,
			modifier = Modifier.semantics { stateDescription = (if (open) "Open" else "Closed") + if (filtered) ", showing ${feed.filter.label}" else "" },
			onClick = onFilters,
		)
		IconButton(
			Icon.Refresh, "Refresh feed", tint = if (feed.refreshing) C.accent else C.fg2, size = 20.dp,
			modifier = Modifier.semantics { if (feed.refreshing) stateDescription = "Refreshing" },
		) { feed.refresh() }
		// No view of its own on the phone yet: shown, dimmed, as Track actions shows such.
		IconButton(Icon.Following, "Following: artists, labels, playlists", tint = C.fg4, size = 20.dp, modifier = Modifier.semantics { disabled() }) { feed.notice = "Following comes in a later pass" }
	}
}

@Composable
private fun Filters(feed: FeedModel, modifier: Modifier) {
	Row(
		modifier
			.fillMaxWidth()
			.height(DRAWER)
			.background(C.bg)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
			.horizontalScroll(rememberScrollState())
			.padding(horizontal = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(6.dp),
	) {
		val counts = feed.counts
		for (f in FeedFilter.entries) FilterChip(f, counts[f] ?: 0, f == feed.filter) { feed.filter = f }
	}
}

@Composable
private fun FilterChip(f: FeedFilter, count: Int, on: Boolean, onClick: () -> Unit) {
	val shape = RoundedCornerShape(4.dp)
	Row(
		Modifier
			.height(32.dp)
			.background(if (on) C.accentDim else C.bg, shape)
			.border(1.dp, if (on) C.accent else C.line, shape)
			.clickable(role = Role.Tab, onClick = onClick)
			.semantics { selected = on }
			.padding(horizontal = 12.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(6.dp),
	) {
		BasicText(f.label, style = T.of(13.sp, color = if (on) C.fg else C.fg1), maxLines = 1)
		BasicText("$count", style = T.mono(11.5.sp, C.fg2), maxLines = 1)
	}
}

@Composable
private fun Empty(feed: FeedModel) {
	val text = when {
		!feed.loaded -> "Opening the feed…"
		feed.filter != FeedFilter.ALL -> "Nothing here."
		feed.refreshing -> "Reading the feed…"
		else -> "Nothing new yet. New releases from the artists, labels and playlists you follow show up here."
	}
	BasicText(text, Modifier.padding(horizontal = 16.dp, vertical = 24.dp), style = T.secondary)
}

// What just happened, in a line over the cards, for a few seconds.
@Composable
private fun Notice(feed: FeedModel, modifier: Modifier) {
	val text = feed.notice ?: return
	LaunchedEffect(text) {
		delay(4_000)
		if (feed.notice == text) feed.notice = null
	}
	Box(
		modifier.padding(12.dp).background(C.bg3, RoundedCornerShape(4.dp)).border(1.dp, C.line, RoundedCornerShape(4.dp)).padding(horizontal = 12.dp, vertical = 8.dp)
			.semantics { liveRegion = LiveRegionMode.Polite },
	) { BasicText(text, style = T.of(13.sp, color = C.fg)) }
}
