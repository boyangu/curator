package app.curator.mobile.ui.list

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Library
import app.curator.mobile.data.ListQuery
import app.curator.mobile.data.Track
import app.curator.mobile.model.HomePin
import app.curator.mobile.model.ListView
import app.curator.mobile.model.StreamingService
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.formatDuration
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.nav.LocalPageGestures
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.nav.swipeToOpen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.sourceName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What a list is, for its header: its name, kind and source. [pin]: null when Home can't pin it (an artist's tracks, the library). */
data class ListInfo(val name: String, val kind: String, val source: String?, val pin: HomePin?)

/** A list's header facts: one row read, never its tracks (those come a page at a time: TrackPager). */
@Composable
fun rememberListInfo(model: AppModel, source: ListSource): ListInfo? {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val info by produceState<ListInfo?>(null, lib, version, source) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) { info(l, source) }
	}
	return info
}

private fun info(l: Library, s: ListSource): ListInfo? = when (s) {
	is ListSource.Playlist -> l.playlist(s.id)?.let { ListInfo(it.name, "Playlist", it.source, HomePin("playlist", s.id)) }
	is ListSource.Tag -> l.tagName(s.id)?.let { ListInfo(it, "Tag", null, HomePin("tag", s.id)) }
	is ListSource.Artist -> l.artistName(s.id)?.let { ListInfo(it, "Artist", null, null) }
	is ListSource.Library -> ListInfo("Library", "Library", null, null)
}

/** The view a list is shown with: null for the moment it takes to read, so a list never opens on the default view first. */
@Composable
fun rememberView(model: AppModel, source: ListSource): ListView? {
	val view by remember(source.key) { model.viewState.listView(source.key) }.collectAsState(null)
	return view
}

@Composable
fun TrackListScreen(
	model: AppModel,
	source: ListSource,
	bottom: @Composable () -> Unit,
	back: () -> Unit,
	push: (Screen) -> Unit,
) {
	val info = rememberListInfo(model, source)
	val view = rememberView(model, source)
	val pager = rememberPager(model, view?.let { ListQuery(source.scope(), it) })
	val rows by model.rows.collectAsState()
	val pins by model.pins.collectAsState()
	val level = rows.density

	// Opened lately (Home's Recent), on this device only.
	LaunchedEffect(source.key) {
		when (source) {
			is ListSource.Playlist -> model.viewState.opened("playlist", source.id)
			is ListSource.Tag -> model.viewState.opened("tag", source.id)
			// Recent holds what Home can open from its own lists.
			is ListSource.Artist, is ListSource.Library -> {}
		}
	}

	val gestures = LocalPageGestures.current
	Column(Modifier.fillMaxSize().background(C.bg).swipeToOpen(gestures) { Screen.ListActions(source) }) {
		Row(Modifier.windowInsetsPadding(WindowInsets.statusBars).fillMaxWidth().height(48.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
			IconButton(Icon.Back, "Back", onClick = back)
			Spacer(Modifier.weight(1f))
			DensityButton(level) { model.setRows(rows.copy(density = if (level == 3) 1 else level + 1)) }
			IconButton(Icon.Menu, "List actions", tint = C.fg) { push(Screen.ListActions(source)) }
		}
		if (info == null || view == null || pager == null) {
			Spacer(Modifier.weight(1f))
			bottom()
			return@Column
		}

		// Title block: name, pin, what it is, Play.
		Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
					Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
						BasicText(info.name, Modifier.weight(1f, fill = false), style = T.screenTitle, maxLines = 1)
						if (info.pin != null && info.pin in pins) Box(Modifier.semantics { contentDescription = "Pinned" }) { IconGlyph(Icon.Pin, C.accent, 14.dp, 1.6f) }
					}
					val totals = pager.totals
					BasicText(
						listOfNotNull(
							info.kind, totals?.let { "${it.count} tracks" }, totals?.let { formatDuration(it.seconds) }, info.source?.let { sourceName(it) },
						).joinToString(" · "),
						style = T.of(12.5.sp, color = C.fg2), maxLines = 1,
					)
				}
				Box(
					Modifier
						.size(44.dp)
						.clip(CircleShape)
						.background(C.accent)
						.clickable(role = Role.Button, onClickLabel = "Play") { pager.track(0)?.let { model.open(it, start = true) } }
						.semantics { contentDescription = "Play" },
					contentAlignment = Alignment.Center,
				) { IconGlyph(Icon.Play, Color.Black, 18.dp) }
			}
			StateChips(view, pager) { push(Screen.ListActions(source)) }
		}

		// Another view starts the list at its top.
		key(pager.query.key) { TrackRows(model, source, pager, "", "No tracks match these filters.", Modifier.weight(1f), push) }
		bottom()
	}
}

/**
 * A list's rows, read a page at a time from [pager]: a row whose page is on
 * its way holds its place, empty, for the moment it takes. A tap plays the
 * track and opens it. [empty] when the list holds nothing, [noMatch] when
 * the view or the [search] leaves nothing.
 */
@Composable
internal fun TrackRows(model: AppModel, source: ListSource, pager: TrackPager, search: String, noMatch: String, modifier: Modifier, push: (Screen) -> Unit) {
	val rows by model.rows.collectAsState()
	val metrics by model.metrics.collectAsState()
	val player by model.player.state.collectAsState()
	val main by model.streaming.collectAsState()
	val level = rows.density
	val cfg = rows.level(level)
	LazyColumn(modifier.drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }) {
		if (pager.started && pager.size == 0) {
			item("empty") {
				BasicText(
					if (pager.totals?.count == 0) "No tracks here yet." else noMatch,
					Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 32.dp),
					style = T.of(14.sp, color = C.fg2).copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center),
				)
			}
		}
		items(pager.size, key = { pager.keys[it] }, contentType = { 0 }) { i ->
			val t = pager.track(i)
			if (t == null) TrackRowPlaceholder(level)
			else TrackRow(
				t, level, cfg, metrics,
				playing = player.track?.trackId == t.id && player.playing,
				missingOn = if (t.foundOn(main)) null else StreamingService.forTrack(t.source, main),
			) {
				model.open(t, start = true)
				push(Screen.Track(t.id, source, i, pager.size, search))
			}
		}
	}
}

/** Loads a track into the player (Track opens on it); [start] plays it too (a tap on its row). */
suspend fun playFrom(model: AppModel, t: Track, start: Boolean = false) {
	val lib = model.library.value ?: return
	// A local file plays as the track its recording claims on the service picked in Settings.
	val service = StreamingService.forTrack(t.source, model.streaming.value)
	val streamId = withContext(Dispatchers.IO) { lib.streamId(t.id, service.id) }
	model.player.load(
		app.curator.mobile.player.PlayerTrack(
			trackId = t.id, title = t.title, artist = t.artist, coverUrl = t.coverUrl,
			durationSec = (t.durationSec ?: 0).toDouble(), source = t.source, service = service, streamId = streamId,
		),
	)
	// The row of the track already playing carries on rather than restarting.
	if (start && !model.player.state.value.playing) model.player.play()
}

/** One row: the active sort, each active filter (accent border), "<shown> of <total>" once both are counted. Opens Actions. */
@Composable
internal fun StateChips(view: ListView, pager: TrackPager, onClick: () -> Unit) {
	Row(
		Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Sort and filters", onClick = onClick),
		horizontalArrangement = Arrangement.spacedBy(6.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		val arrow = if (view.sort == app.curator.mobile.model.Sort.CUSTOM) "" else if (view.dir > 0) " ↑" else " ↓"
		StateChip(view.sort.chip + arrow, active = false)
		for (t in view.tags.sorted()) StateChip(t, active = true)
		if (view.bpm != app.curator.mobile.model.BpmBucket.ANY) StateChip("${view.bpm.label} BPM", active = true)
		if (view.ownedOnly) StateChip("Owned", active = true)
		val total = pager.totals?.count
		if (pager.complete && total != null) BasicText("${pager.size} of $total", Modifier.padding(horizontal = 8.dp), style = T.of(12.5.sp, color = C.fg1), maxLines = 1)
	}
}

@Composable
private fun StateChip(text: String, active: Boolean) {
	Box(
		Modifier.height(26.dp).border(1.dp, if (active) C.accent else C.line, RoundedCornerShape(4.dp)).padding(horizontal = 8.dp),
		contentAlignment = Alignment.Center,
	) { BasicText(text, style = T.of(12.5.sp, color = C.fg1), maxLines = 1) }
}

/** Cycles 1 → 2 → 3 → 1 rows; its icon shows the level as line pairs. */
@Composable
internal fun DensityButton(level: Int, onClick: () -> Unit) {
	Box(
		Modifier
			.size(44.dp)
			.clickable(role = Role.Button, onClick = onClick)
			.semantics { contentDescription = "Row detail: $level ${if (level == 1) "row" else "rows"}. Tap to change" },
		contentAlignment = Alignment.Center,
	) {
		Column(Modifier.width(20.dp), verticalArrangement = Arrangement.spacedBy(if (level == 3) 2.dp else 3.dp)) {
			for (b in 0 until level * 2) {
				Box(Modifier.fillMaxWidth(if (b % level == 0) 1f else 0.65f).height(2.dp).background(C.fg2))
			}
		}
	}
}
