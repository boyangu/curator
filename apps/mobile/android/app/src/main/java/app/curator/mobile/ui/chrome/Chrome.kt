package app.curator.mobile.ui.chrome

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.player.Player
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.KeyChip
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.common.SourceDot
import app.curator.mobile.ui.common.formatBpm
import app.curator.mobile.ui.nav.Tab
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.sourceName

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
 * What is loaded: art, title, artist and where it plays from, BPM and key,
 * Interested, play/pause; a 2dp accent line for the position. Opens Track.
 * A track the library does not hold (from the feed) has no Track view and no
 * Interested here: both null.
 */
@Composable
fun MiniPlayer(
	player: Player,
	bpm: Double?,
	key: String?,
	interested: Boolean,
	onInterested: (() -> Unit)?,
	onOpen: (() -> Unit)?,
) {
	val state by player.state.collectAsState()
	val t = state.track ?: return
	val position by player.position.collectAsState()
	Row(
		Modifier
			.fillMaxWidth()
			.height(60.dp)
			.background(C.bg2)
			.drawBehind {
				drawLine(C.line, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx())
				val progress = if (t.durationSec > 0) (position / t.durationSec).toFloat().coerceIn(0f, 1f) else 0f
				drawLine(C.accent, Offset(0f, 0f), Offset(size.width * progress, 0f), 2.dp.toPx())
			}
			.padding(start = 12.dp, end = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(10.dp),
	) {
		Cover(t.coverUrl, t.trackId, 40.dp)
		Column(
			Modifier
				.weight(1f)
				.then(if (onOpen == null) Modifier else Modifier.clickable(role = Role.Button, onClickLabel = "Open the track", onClick = onOpen)),
			verticalArrangement = Arrangement.spacedBy(3.dp),
		) {
			Line(t.title, T.of(14.sp, color = C.fg))
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				Line(t.artist, T.of(12.5.sp, color = C.fg2), Modifier.weight(1f, fill = false))
				SourceDot(t.source)
				BasicText(sourceName(t.source), style = T.of(12.5.sp, color = C.fg2), maxLines = 1)
			}
		}
		if (bpm != null) BasicText(formatBpm(bpm), style = T.mono(12.sp, C.fg1))
		KeyChip(key)
		if (onInterested != null) IconButton(Icon.Pin, if (interested) "Remove from Interested" else "Mark interested", tint = if (interested) C.accent else C.fg2, size = 20.dp, onClick = onInterested)
		IconButton(
			if (state.playing) Icon.Pause else Icon.Play,
			if (state.playing) "Pause" else "Play",
			tint = C.fg,
			onClick = { if (state.playing) player.pause() else player.play() },
		)
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
