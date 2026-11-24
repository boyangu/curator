package app.curator.mobile.ui.home

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Folder
import app.curator.mobile.data.PlaylistSummary
import app.curator.mobile.model.StreamingService
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.PopupMenuAnchor
import app.curator.mobile.ui.common.SourceDot
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.sourceName

// The source pickers of Home and Library, and the playlist rows both list.

/** A picker's choices: All (null), each streaming service in [present] (the sources the list holds), then Owned. */
fun sourceFilters(present: Set<String?>): List<String?> =
	listOf(null) + StreamingService.entries.map { it.id }.filter { it in present } + ListSource.OWNED

fun filterName(filter: String?): String = when (filter) {
	null -> "All"
	ListSource.OWNED -> "Owned"
	else -> sourceName(filter)
}

/** Rekordbox's playlists and the local files' are one library here: Owned. */
fun playlistShows(filter: String?, p: PlaylistSummary) = when (filter) {
	null -> true
	ListSource.OWNED -> p.source == "rekordbox" || p.source == "local"
	else -> p.source == filter
}

/** A playlist row: its parent folder's name leads the name (grey) and sorts with it. */
class PlaylistLine(val playlist: PlaylistSummary, val folder: String?) {
	val text = if (folder == null) playlist.name else "$folder ${playlist.name}"
}

fun playlistLines(lists: List<PlaylistSummary>, folders: List<Folder>): List<PlaylistLine> {
	val names = folders.associate { it.id to it.name }
	return lists.map { PlaylistLine(it, it.folderId?.let { f -> names[f] }) }.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.text })
}

/** [label] with a caret; a tap opens the platform's menu of [filters], [selected] checked. */
@Composable
fun FilterPicker(
	filters: List<String?>,
	selected: String?,
	label: AnnotatedString,
	style: TextStyle,
	clickLabel: String,
	onSelect: (String?) -> Unit,
	modifier: Modifier = Modifier,
	names: (String?) -> String = ::filterName,
) {
	PopupMenuAnchor(filters.map(names), filters.indexOf(selected), onSelect = { onSelect(filters[it]) }, modifier = modifier) { open ->
		Row(
			Modifier
				.height(44.dp)
				.clickable(role = Role.Button, onClickLabel = clickLabel, onClick = open)
				.padding(horizontal = 8.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(4.dp),
		) {
			BasicText(label, style = style, maxLines = 1)
			IconGlyph(Icon.Caret, C.fg2, 14.dp)
		}
	}
}

@Composable
fun PlaylistRow(r: PlaylistLine, pinned: Boolean, onClick: () -> Unit) {
	val p = r.playlist
	Row(
		Modifier
			.fillMaxWidth()
			.height(56.dp)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
			.clickable(role = Role.Button, onClick = onClick)
			.padding(horizontal = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		Cover(p.coverUrl, p.id, 40.dp)
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
			BasicText(
				buildAnnotatedString {
					r.folder?.let { withStyle(SpanStyle(color = C.fg2)) { append(it) }; append(" ") }
					append(p.name)
				},
				style = T.of(14.5.sp, color = C.fg), maxLines = 1, overflow = TextOverflow.Ellipsis,
			)
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
				SourceDot(p.source)
				BasicText("${p.tracks} tracks · ${sourceName(p.source)}", style = T.of(12.5.sp, color = C.fg2), maxLines = 1)
			}
		}
		if (pinned) Box(Modifier.semantics { contentDescription = "Pinned" }) { IconGlyph(Icon.Pin, C.accent, 14.dp, 1.8f) }
	}
}
