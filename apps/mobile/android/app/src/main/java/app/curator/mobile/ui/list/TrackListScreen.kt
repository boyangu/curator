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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import app.curator.mobile.data.Track
import app.curator.mobile.model.HomePin
import app.curator.mobile.model.ListView
import app.curator.mobile.model.apply
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

/** A list as loaded: its name, what it is, and every track in its own order. */
data class ListData(val name: String, val kind: String, val source: String?, val tracks: List<Track>, val pin: HomePin)

/** Loads a list (again when the library changes). One loader for every kind of list (§5). */
@Composable
fun rememberList(model: AppModel, source: ListSource): ListData? {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val data by produceState<ListData?>(null, lib, version, source) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) { load(l, source) }
	}
	return data
}

private fun load(l: Library, s: ListSource): ListData? = when (s) {
	is ListSource.Playlist -> l.playlists().firstOrNull { it.id == s.id }?.let { p ->
		ListData(p.name, "Playlist", p.source, l.playlistTracks(p.id), HomePin("playlist", p.id))
	}
	is ListSource.Tag -> l.tags().firstOrNull { it.id == s.id }?.let { t ->
		ListData(t.name, "Tag", null, l.tagTracks(t.id), HomePin("tag", t.id))
	}
}

@Composable
fun TrackListScreen(
	model: AppModel,
	source: ListSource,
	bottom: @Composable () -> Unit,
	back: () -> Unit,
	push: (Screen) -> Unit,
) {
	val data = rememberList(model, source)
	val view by model.viewState.listView(source.key).collectAsState(ListView())
	val rows by model.rows.collectAsState()
	val pins by model.pins.collectAsState()
	val metrics by model.metrics.collectAsState()
	val player by model.player.state.collectAsState()
	val scope = androidx.compose.runtime.rememberCoroutineScope()
	val shown = remember(data, view) { data?.let { view.apply(it.tracks) } ?: emptyList() }
	val level = rows.density

	// Opened lately (Home's Recent), on this device only.
	LaunchedEffect(source.key) {
		when (source) {
			is ListSource.Playlist -> model.viewState.opened("playlist", source.id)
			is ListSource.Tag -> model.viewState.opened("tag", source.id)
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
		if (data == null) {
			BasicText("Opening…", Modifier.padding(16.dp), style = T.secondary)
			Spacer(Modifier.weight(1f))
			bottom()
			return@Column
		}

		// Title block: name, pin, what it is, Play.
		Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
			Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
					Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
						BasicText(data.name, Modifier.weight(1f, fill = false), style = T.screenTitle, maxLines = 1)
						if (data.pin in pins) Box(Modifier.semantics { contentDescription = "Pinned" }) { IconGlyph(Icon.Pin, C.accent, 14.dp, 1.6f) }
					}
					val secs = data.tracks.sumOf { (it.durationSec ?: 0).toLong() }
					BasicText(
						listOfNotNull(data.kind, "${data.tracks.size} tracks", formatDuration(secs), data.source?.let { sourceName(it) }).joinToString(" · "),
						style = T.of(12.5.sp, color = C.fg2), maxLines = 1,
					)
				}
				Box(
					Modifier
						.size(44.dp)
						.clip(CircleShape)
						.background(C.accent)
						.clickable(role = Role.Button, onClickLabel = "Play") { shown.firstOrNull()?.let { scope.launch { playFrom(model, it); model.player.play() } } }
						.semantics { contentDescription = "Play" },
					contentAlignment = Alignment.Center,
				) { IconGlyph(Icon.Play, Color.Black, 18.dp) }
			}
			StateChips(view, shown.size, data.tracks.size) { push(Screen.ListActions(source)) }
		}

		LazyColumn(Modifier.weight(1f).drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }) {
			if (shown.isEmpty()) {
				item("empty") {
					BasicText(
						if (data.tracks.isEmpty()) "No tracks here yet." else "No tracks match these filters.",
						Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 32.dp),
						style = T.of(14.sp, color = C.fg2).copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center),
					)
				}
			}
			itemsIndexed(shown, key = { _, t -> t.id }) { i, t ->
				TrackRow(t, level, rows.level(level), metrics, playing = player.track?.trackId == t.id && player.playing) {
					scope.launch { playFrom(model, t) }
					push(Screen.Track(t.id, source, i, shown.size))
				}
			}
		}
		bottom()
	}
}

/** Loads a track into the player (Track opens on it). */
suspend fun playFrom(model: AppModel, t: Track) {
	val lib = model.library.value ?: return
	val providerId = if (t.source == "spotify") withContext(Dispatchers.IO) { lib.spotifyId(t.id) } else null
	model.player.load(
		app.curator.mobile.player.PlayerTrack(
			trackId = t.id, title = t.title, artist = t.artist, coverUrl = t.coverUrl,
			durationSec = (t.durationSec ?: 0).toDouble(), source = t.source, providerId = providerId,
		),
	)
}

/** One row: the active sort, each active filter (accent border), "<shown> of <total>". Opens Actions. */
@Composable
private fun StateChips(view: ListView, shown: Int, total: Int, onClick: () -> Unit) {
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
		BasicText("$shown of $total", Modifier.padding(horizontal = 8.dp), style = T.of(12.5.sp, color = C.fg1), maxLines = 1)
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
private fun DensityButton(level: Int, onClick: () -> Unit) {
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
