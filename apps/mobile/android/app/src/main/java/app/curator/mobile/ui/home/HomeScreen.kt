package app.curator.mobile.ui.home

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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Folder
import app.curator.mobile.data.PlaylistSummary
import app.curator.mobile.data.TagSummary
import app.curator.mobile.data.ViewState
import app.curator.mobile.model.HomePin
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Chip
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.common.SourceDot
import app.curator.mobile.ui.common.formatWhen
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.Fonts
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.sourceName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class HomeData(val playlists: List<PlaylistSummary>, val folders: List<Folder>, val tags: List<TagSummary>)

@Composable
fun HomeScreen(model: AppModel, bottom: @Composable () -> Unit, open: (ListSource) -> Unit) {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val pins by model.pins.collectAsState()
	val recent by model.viewState.recent.collectAsState(emptyList())
	val data by produceState<HomeData?>(null, lib, version) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) { HomeData(l.playlists(), l.folders(), l.tags()) }
	}
	var source by rememberSaveable { mutableStateOf<String?>(null) }
	var editPins by rememberSaveable { mutableStateOf(false) }
	val open = remember { mutableStateOf(setOf<String>()) }

	Column(Modifier.fillMaxSize().background(C.bg)) {
		LazyColumn(Modifier.weight(1f).windowInsetsPadding(WindowInsets.statusBars)) {
			item("header") { Header() }
			val d = data
			if (d == null) {
				item("loading") { BasicText("Opening the library…", Modifier.padding(16.dp), style = T.secondary) }
				return@LazyColumn
			}
			val byId = d.playlists.associateBy { it.id }
			val tagsById = d.tags.associateBy { it.id }

			val recents = recent.mapNotNull { r -> recentCard(r, byId, tagsById) }
			if (recents.isNotEmpty()) {
				item("recent-h") { SectionLabel("Recent playlists", Modifier.padding(start = 16.dp, top = 6.dp, bottom = 10.dp)) }
				item("recent") {
					LazyRow(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
						items(recents, key = { it.key }) { c -> RecentCard(c) { open(c.source) } }
					}
				}
			}

			val pinned = pins.mapNotNull { p -> pinTile(p, byId, tagsById) }
			item("pins-h") {
				Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 22.dp), verticalAlignment = Alignment.CenterVertically) {
					SectionLabel("Pinned", Modifier.weight(1f))
					if (pinned.isNotEmpty()) {
						Box(Modifier.height(44.dp).clickable(role = Role.Button) { editPins = !editPins }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
							BasicText(if (editPins) "Done" else "Edit", style = T.of(12.sp, color = if (editPins) C.accent else C.fg2))
						}
					}
				}
			}
			if (pinned.isEmpty()) {
				item("pins-none") { BasicText("Pin a playlist or a tag from its actions.", Modifier.padding(horizontal = 16.dp), style = T.secondary) }
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

			// null is All; Local only when the account has local playlists.
			val sources: List<String?> = listOf(null, "spotify", "tidal", "rekordbox") + listOfNotNull("local".takeIf { s -> d.playlists.any { it.source == s } })
			item("lists-h") {
				Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 22.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
					BasicText(
						buildAnnotatedString {
							append("Playlists ")
							withStyle(SpanStyle(fontFamily = Fonts.mono, fontSize = 11.5.sp)) { append(d.playlists.size.toString()) }
						},
						Modifier.weight(1f).semantics { heading() },
						style = T.label,
					)
					for (s in sources) Chip(if (s == null) "All" else sourceName(s).removeSuffix(" files"), source == s) { source = s }
				}
			}
			val pinnedLists = pins.filter { it.kind == "playlist" }.map { it.id }.toSet()
			val rows = if (source != null) d.playlists.filter { it.source == source }.map { HomeRow.List(it, 0) } else tree(d.playlists, d.folders, open.value)
			items(rows, key = { it.key }) { r ->
				when (r) {
					is HomeRow.Dir -> FolderRow(r.folder, r.count, r.depth, r.folder.id in open.value) {
						open.value = if (r.folder.id in open.value) open.value - r.folder.id else open.value + r.folder.id
					}
					is HomeRow.List -> PlaylistRow(r.playlist, r.depth, r.playlist.id in pinnedLists) { open(ListSource.Playlist(r.playlist.id)) }
				}
			}
			item("end") { Spacer(Modifier.height(16.dp)) }
		}
		bottom()
	}
}

@Composable
private fun Header() {
	Row(Modifier.fillMaxWidth().height(52.dp).padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		// The mark: an accent square with three black bars.
		Box(Modifier.size(22.dp).background(C.accent).semantics { contentDescription = "Curator" }, contentAlignment = Alignment.CenterStart) {
			Column(Modifier.padding(horizontal = 5.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
				for (w in listOf(5, 8, 12)) Box(Modifier.width(w.dp).height(2.dp).background(Color.Black))
			}
		}
		BasicText("Curator", Modifier.weight(1f), style = T.of(14.sp, 700, Color.White))
		IconButton(Icon.Plus, "New playlist", tint = C.fg2) { }
		IconButton(Icon.Settings, "Settings", tint = C.fg2, size = 20.dp) { }
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

private sealed interface HomeRow {
	val key: String
	data class Dir(val folder: Folder, val depth: Int, val count: Int) : HomeRow { override val key get() = "f:${folder.id}" }
	data class List(val playlist: PlaylistSummary, val depth: Int) : HomeRow { override val key get() = "p:${playlist.id}" }
}

// Folders as expandable rows, their playlists indented beneath when open.
private fun tree(lists: kotlin.collections.List<PlaylistSummary>, folders: kotlin.collections.List<Folder>, open: Set<String>): kotlin.collections.List<HomeRow> {
	if (folders.isEmpty()) return lists.map { HomeRow.List(it, 0) }
	val known = folders.map { it.id }.toSet()
	val childFolders = folders.groupBy { it.parentId?.takeIf { p -> p in known } }
	val childLists = lists.groupBy { it.folderId?.takeIf { f -> f in known } }
	fun count(id: String): Int = (childLists[id]?.size ?: 0) + (childFolders[id] ?: emptyList()).sumOf { count(it.id) }
	val out = mutableListOf<HomeRow>()
	fun walk(parent: String?, depth: Int) {
		for (f in childFolders[parent] ?: emptyList()) {
			out += HomeRow.Dir(f, depth, count(f.id))
			if (f.id in open) walk(f.id, depth + 1)
		}
		for (p in childLists[parent] ?: emptyList()) out += HomeRow.List(p, depth)
	}
	walk(null, 0)
	return out
}

@Composable
private fun FolderRow(f: Folder, count: Int, depth: Int, expanded: Boolean, onToggle: () -> Unit) {
	Row(
		Modifier
			.fillMaxWidth()
			.height(56.dp)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
			.clickable(role = Role.Button, onClickLabel = if (expanded) "Collapse" else "Expand", onClick = onToggle)
			.semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
			.padding(start = (16 + depth * 16).dp, end = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Box(Modifier.size(40.dp).background(C.bg2), contentAlignment = Alignment.Center) { IconGlyph(Icon.Folder, C.fg2, 20.dp, 1.6f) }
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
			Line(f.name, T.of(14.5.sp, color = C.fg))
			BasicText("Folder · $count", style = T.of(12.5.sp, color = C.fg2))
		}
		IconGlyph(if (expanded) Icon.Caret else Icon.Chevron, C.fg3, 16.dp)
	}
}

@Composable
private fun PlaylistRow(p: PlaylistSummary, depth: Int, pinned: Boolean, onClick: () -> Unit) {
	Row(
		Modifier
			.fillMaxWidth()
			.height(56.dp)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
			.clickable(role = Role.Button, onClick = onClick)
			.padding(start = (16 + depth * 16).dp, end = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Cover(p.coverUrl, p.id, 40.dp)
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
			Line(p.name, T.of(14.5.sp, color = C.fg))
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				SourceDot(p.source)
				BasicText("${p.tracks} tracks · ${sourceName(p.source)}", style = T.of(12.5.sp, color = C.fg2), maxLines = 1)
			}
		}
		if (pinned) Box(Modifier.semantics { contentDescription = "Pinned" }) { IconGlyph(Icon.Pin, C.accent, 14.dp, 1.8f) }
	}
}
