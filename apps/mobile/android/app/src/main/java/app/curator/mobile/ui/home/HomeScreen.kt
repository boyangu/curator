package app.curator.mobile.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Folder
import app.curator.mobile.data.PlaylistSummary
import app.curator.mobile.data.TagSummary
import app.curator.mobile.data.ViewState
import app.curator.mobile.model.HomePin
import app.curator.mobile.model.SearchIndex
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.common.PullSearchBox
import app.curator.mobile.ui.common.rememberPullSearch
import app.curator.mobile.ui.common.SourceDot
import app.curator.mobile.ui.common.formatWhen
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.Fonts
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.sourceName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext


@Composable
fun HomeScreen(model: AppModel, bottom: @Composable () -> Unit, openSettings: () -> Unit, open: (ListSource) -> Unit) {
	val pins by model.pins.collectAsState()
	val recent by model.viewState.recent.collectAsState(emptyList())
	val data by model.lists.collectAsState()
	var source by rememberSaveable { mutableStateOf<String?>(null) }
	var editPins by rememberSaveable { mutableStateOf(false) }
	val search = rememberPullSearch()
	val lines = remember(data) { data?.let { SearchIndex(playlistLines(it.playlists, it.folders)) { l -> l.text } } }

	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.statusBars)) {
		Header(openSettings)
		PullSearchBox(search, "Search playlists")
		LazyColumn(Modifier.weight(1f).nestedScroll(search.connection)) {
			val d = data
			if (d == null || lines == null) {
				item("loading") { BasicText("Opening the library…", Modifier.padding(16.dp), style = T.secondary) }
				return@LazyColumn
			}
			val byId = d.playlists.associateBy { it.id }
			val tagsById = d.tags.associateBy { it.id }
			// While searching, only the playlists that match.
			val searching = search.query.isNotBlank()

			val recents = if (searching) emptyList() else recent.mapNotNull { r -> recentCard(r, byId, tagsById) }
			if (recents.isNotEmpty()) {
				item("recent-h") { SectionLabel("Recent playlists", Modifier.padding(start = 16.dp, top = 6.dp, bottom = 10.dp)) }
				item("recent") {
					LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
						items(recents, key = { it.key }) { c -> RecentCard(c) { open(c.source) } }
					}
				}
			}

			val pinned = if (searching) emptyList() else pins.mapNotNull { p -> pinTile(p, byId, tagsById) }
			if (pinned.isNotEmpty()) item("pins-h") {
				Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 22.dp), verticalAlignment = Alignment.CenterVertically) {
					SectionLabel("Pinned", Modifier.weight(1f))
					Box(Modifier.height(44.dp).clickable(role = Role.Button) { editPins = !editPins }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
						BasicText(if (editPins) "Done" else "Edit", style = T.of(12.sp, color = if (editPins) C.accent else C.fg2))
					}
				}
			}
			items(pinned.chunked(2), key = { row -> "pins:" + row.joinToString { it.pin.id } }) { row ->
				Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					for (tile in row) {
						PinTile(
							tile, editPins, Modifier.weight(1f),
							onOpen = { open(tile.source) },
							onMove = { by ->
								val list = pins.toMutableList()
								val i = list.indexOf(tile.pin)
								val j = (i + by).coerceIn(0, list.lastIndex)
								if (i >= 0 && i != j) { list.add(j, list.removeAt(i)); model.setPins(list) }
							},
							onUnpin = { model.setPins(pins - tile.pin) },
						)
					}
					if (row.size == 1) Spacer(Modifier.weight(1f))
				}
			}

			val filters = sourceFilters(d.playlists.map { it.source }.toSet())
			val filter = source?.takeIf { it in filters }
			val rows = lines.search(search.query).filter { playlistShows(filter, it.playlist) }
			item("lists-h") {
				FilterPicker(
					filters, filter,
					buildAnnotatedString {
						withStyle(SpanStyle(fontFamily = Fonts.mono, fontSize = 11.5.sp)) { append(rows.size.toString()) }
						append(if (filter == null) " Playlists" else " ${filterName(filter)} Playlists")
					},
					T.label, "Choose which playlists to show",
					onSelect = { source = it },
					modifier = Modifier.padding(start = 8.dp, top = 6.dp).semantics { heading() },
				)
			}
			val pinnedLists = pins.filter { it.kind == "playlist" }.map { it.id }.toSet()
			items(rows, key = { it.playlist.id }) { r ->
				PlaylistRow(r, r.playlist.id in pinnedLists) { open(ListSource.Playlist(r.playlist.id)) }
			}
			item("end") { Spacer(Modifier.height(16.dp)) }
		}
		bottom()
	}
}

@Composable
private fun Header(openSettings: () -> Unit) {
	MainHeader("Curator") {
		Spacer(Modifier.weight(1f))
		IconButton(Icon.Plus, "New playlist", tint = C.fg2) { }
		IconButton(Icon.Settings, "Settings", tint = C.fg2, size = 20.dp, onClick = openSettings)
	}
}

/** A main view's header: the mark, the view's [title], then [content] (pickers, actions). */
@Composable
fun MainHeader(title: String, content: @Composable RowScope.() -> Unit) {
	Row(Modifier.fillMaxWidth().height(52.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		// The mark: an accent square with three black bars.
		Box(Modifier.size(22.dp).background(C.accent).semantics { contentDescription = "Curator" }, contentAlignment = Alignment.CenterStart) {
			Column(Modifier.padding(horizontal = 5.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
				for (w in listOf(5, 8, 12)) Box(Modifier.width(w.dp).height(2.dp).background(Color.Black))
			}
		}
		BasicText(title, Modifier.semantics { heading() }, style = T.of(14.sp, 700, Color.White))
		content()
	}
}

@Composable
private fun SectionLabel(text: String, modifier: Modifier = Modifier) {
	BasicText(text, modifier.semantics { heading() }, style = T.label)
}

private data class Card(val key: String, val name: String, val meta: String, val cover: String?, val source: ListSource, val isTag: Boolean)

private fun recentCard(r: ViewState.Recent, lists: Map<String, PlaylistSummary>, tags: Map<String, TagSummary>): Card? = when (r.kind) {
	"playlist" -> lists[r.id]?.let { Card("p:${it.id}", it.name, "${formatWhen(r.at)} · ${it.tracks}", it.coverUrl, ListSource.Playlist(it.id), false) }
	"tag" -> tags[r.id]?.let { Card("t:${it.id}", it.name, "${formatWhen(r.at)} · ${it.tracks}", null, ListSource.Tag(it.id), true) }
	else -> null
}

@Composable
private fun RecentCard(c: Card, onClick: () -> Unit) {
	Column(Modifier.width(120.dp).clickable(role = Role.Button, onClick = onClick), verticalArrangement = Arrangement.spacedBy(6.dp)) {
		if (c.isTag) TagWell(c.source.key, 120) else Cover(c.cover, c.key, 120.dp)
		Line(c.name, T.of(13.5.sp, color = C.fg))
		BasicText(c.meta, style = T.of(12.sp, color = C.fg2), maxLines = 1)
	}
}

private data class Tile(val pin: HomePin, val name: String, val kind: String, val count: Int, val cover: String?, val tint: Color, val source: ListSource)

private fun pinTile(p: HomePin, lists: Map<String, PlaylistSummary>, tags: Map<String, TagSummary>): Tile? = when (p.kind) {
	"playlist" -> lists[p.id]?.let { Tile(p, it.name, "Playlist", it.tracks, it.coverUrl, C.fg2, ListSource.Playlist(it.id)) }
	"tag" -> tags[p.id]?.let {
		val tint = when (it.id) { "interested" -> C.accent; "basket" -> C.buy; else -> C.fg2 }
		Tile(p, it.name, "Tag", it.tracks, null, tint, ListSource.Tag(it.id))
	}
	else -> null
}

@Composable
private fun TagWell(seed: String, size: Int, tint: Color = C.fg2) {
	Box(Modifier.size(size.dp).background(C.bg2), contentAlignment = Alignment.Center) { IconGlyph(Icon.Tag, tint, if (size > 60) 36.dp else 20.dp, 1.6f) }
}

@Composable
private fun PinTile(t: Tile, editing: Boolean, modifier: Modifier, onOpen: () -> Unit, onMove: (Int) -> Unit, onUnpin: () -> Unit) {
	Row(
		modifier
			.height(52.dp)
			.background(C.bg1)
			.border(1.dp, C.lineSoft)
			.clickable(enabled = !editing, role = Role.Button, onClick = onOpen),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(10.dp),
	) {
		if (t.pin.kind == "tag") {
			Box(Modifier.size(50.dp).background(C.bg2).drawBehind { drawLine(C.lineSoft, Offset(size.width, 0f), Offset(size.width, size.height), 1.dp.toPx()) }, contentAlignment = Alignment.Center) {
				IconGlyph(Icon.Tag, t.tint, 20.dp, 1.6f)
			}
		} else Cover(t.cover, t.pin.id, 50.dp)
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
			Line(t.name, T.of(13.5.sp, color = C.fg))
			BasicText(
				buildAnnotatedString {
					append("${t.kind} · ")
					withStyle(SpanStyle(fontFamily = Fonts.mono, fontSize = 11.5.sp)) { append(t.count.toString()) }
				},
				style = T.of(12.sp, color = C.fg2), maxLines = 1,
			)
		}
		if (editing) {
			IconButton(Icon.Back, "Move ${t.name} earlier", tint = C.fg2, size = 16.dp) { onMove(-1) }
			IconButton(Icon.Close, "Unpin ${t.name}", tint = C.hot, size = 16.dp) { onUnpin() }
		}
	}
}

