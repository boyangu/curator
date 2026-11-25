package app.curator.mobile.ui.feed

import android.view.accessibility.AccessibilityManager
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.delay

/**
 * The news feed: full-width cards, starting right under the status bar. The
 * title, Refresh and the filters are a bar over the top of the cards, out of
 * sight until the list is scrolled back up.
 */
@Composable
fun FeedScreen(model: AppModel, bottom: @Composable () -> Unit) {
	val feed = model.feed
	val player by model.player.state.collectAsState()
	val list = rememberLazyListState()
	val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
	val density = LocalDensity.current
	val context = LocalContext.current

	// The bar follows the direction of scrolling past a few dp, so a finger
	// resting on the list does not flicker it.
	var revealed by rememberSaveable { mutableStateOf(false) }
	val scroll = remember {
		object : NestedScrollConnection {
			val slop = with(density) { 4.dp.toPx() }
			var run = 0f

			override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
				// What the list took, and what it could not at its top: pulling
				// down there asks for the bar too.
				val dy = consumed.y + available.y
				if (dy == 0f) return Offset.Zero
				run = if ((dy > 0) == (run > 0)) run + dy else dy
				if (run > slop) revealed = true else if (run < -slop) revealed = false
				return Offset.Zero
			}
		}
	}
	// With nothing to scroll, and for a screen reader (which does not scroll by
	// hand), Refresh and the filters stay in reach.
	val explored = remember { (context.getSystemService(AccessibilityManager::class.java))?.isTouchExplorationEnabled == true }
	val pinned = explored || (feed.loaded && feed.shown.isEmpty())

	LaunchedEffect(player.unavailable, player.track?.trackId) {
		val why = player.unavailable
		if (why != null && player.track?.trackId == feed.lastPlayed) feed.notice = why
	}
	LaunchedEffect(feed.shown.firstOrNull()?.id) {
		if (feed.toTop) { feed.toTop = false; list.scrollToItem(0) }
	}
	LaunchedEffect(feed.filter) { if (list.firstVisibleItemIndex > 0) list.scrollToItem(0) }

	Column(Modifier.fillMaxSize().background(C.bg)) {
		BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().nestedScroll(scroll)) {
			val width = maxWidth
			val shown = feed.shown
			LazyColumn(Modifier.fillMaxSize(), list, contentPadding = PaddingValues(top = top + if (pinned) BAR else 0.dp, bottom = 16.dp)) {
				if (shown.isEmpty()) item("empty") { Empty(feed) }
				itemsIndexed(shown, key = { _, r -> r.id }, contentType = { _, r -> r.release }) { i, r ->
					val item = feed.item(i, r.id)
					if (item == null) Spacer(Modifier.fillMaxWidth().height(width + 98.dp))
					else FeedCard(feed, item, width, playingId = player.track?.trackId?.takeIf { player.playing })
				}
			}
			Controls(feed, top, shown = revealed || pinned)
			// Cards never run under the status bar's icons.
			Box(Modifier.fillMaxWidth().height(top).background(C.bg))
			Notice(feed, Modifier.align(Alignment.BottomCenter))
		}
		bottom()
	}
}

private val BAR = 95.dp

@Composable
private fun Controls(feed: FeedModel, top: Dp, shown: Boolean) {
	val hidden by animateFloatAsState(if (shown) 0f else 1f, tween(200), label = "feed controls")
	val gone by remember { derivedStateOf { hidden >= 1f } }
	// Out of the layout when hidden, so nothing under it is covered for touch or a screen reader.
	if (gone && !shown) return
	Column(
		Modifier
			.padding(top = top)
			.fillMaxWidth()
			.graphicsLayer { translationY = -hidden * size.height * 1.1f }
			.shadow(12.dp)
			.background(C.bg)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) },
	) {
		Row(Modifier.fillMaxWidth().height(52.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
			BasicText("Feed", Modifier.weight(1f).semantics { heading() }, style = T.screenTitle)
			IconButton(
				Icon.Refresh, "Refresh feed", tint = if (feed.refreshing) C.accent else C.fg2, size = 20.dp,
				modifier = Modifier.semantics { if (feed.refreshing) stateDescription = "Refreshing" },
			) { feed.refresh() }
			// No view of its own on the phone yet: shown, dimmed, as Track actions shows such.
			IconButton(Icon.Following, "Following: artists, labels, playlists", tint = C.fg4, size = 20.dp, modifier = Modifier.semantics { disabled() }) { feed.notice = "Following comes in a later pass" }
		}
		Row(
			Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 10.dp),
			horizontalArrangement = Arrangement.spacedBy(6.dp),
		) {
			val counts = feed.counts
			for (f in FeedFilter.entries) FilterChip(f, counts[f] ?: 0, f == feed.filter) { feed.filter = f }
		}
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
