package app.curator.mobile.ui.track

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.setDate
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The playlists holding a track, or the sets it was played in: from the player's two rows, each opening its list. */
@Composable
fun TrackUsesPage(model: AppModel, screen: Screen.TrackUses, back: () -> Unit, push: (Screen) -> Unit) {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val uses by produceState<Uses?>(null, lib, version, screen.trackId) {
		value = lib?.let { l -> withContext(Dispatchers.IO) { Uses(l.playlistsOf(screen.trackId), l.setsOf(screen.trackId)) } }
	}
	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.statusBars)) {
		Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
			IconButton(Icon.Back, "Back", onClick = back)
			val n = uses?.let { if (screen.sets) it.sets.size else it.playlists.size }
			val title = when {
				n == null -> ""
				screen.sets -> "Played in $n ${if (n == 1) "set" else "sets"}"
				else -> "In $n ${if (n == 1) "playlist" else "playlists"}"
			}
			BasicText(title, Modifier.weight(1f).semantics { heading() }, style = T.of(15.sp, 500, C.fg), maxLines = 1)
		}
		val u = uses ?: return@Column
		LazyColumn(Modifier.weight(1f).windowInsetsPadding(WindowInsets.navigationBars)) {
			if (screen.sets) items(u.sets, key = { it.id }) { s ->
				val name = s.name?.takeIf { it.isNotBlank() }
				UseItem(
					cover = null,
					title = name ?: setDate(s.startedAt),
					detail = listOfNotNull(name?.let { setDate(s.startedAt) }, "${s.tracks} ${if (s.tracks == 1) "track" else "tracks"}").joinToString(" · "),
				) { push(Screen.TrackList(ListSource.Set(s.id))) }
			} else items(u.playlists, key = { it.id }) { p ->
				UseItem(cover = p.coverUrl to p.id, title = p.name, detail = null) { push(Screen.TrackList(ListSource.Playlist(p.id))) }
			}
		}
	}
}

@Composable
private fun UseItem(cover: Pair<String?, String>?, title: String, detail: String?, open: () -> Unit) {
	Row(
		Modifier
			.fillMaxWidth()
			.height(60.dp)
			.clickable(role = Role.Button, onClick = open)
			.drawBehind { drawLine(C.lineSoft, Offset(0f, size.height), Offset(size.width, size.height), 1.dp.toPx()) }
			.padding(horizontal = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
		horizontalArrangement = Arrangement.spacedBy(12.dp),
	) {
		if (cover != null) Cover(cover.first, cover.second, 40.dp) else IconGlyph(Icon.Set, C.fg2, 20.dp, 1.6f)
		Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
			Line(title, T.of(14.5.sp, color = C.fg))
			detail?.let { Line(it, T.of(12.5.sp, color = C.fg2)) }
		}
		IconGlyph(Icon.Chevron, C.fg2, 16.dp, 1.8f)
	}
}
