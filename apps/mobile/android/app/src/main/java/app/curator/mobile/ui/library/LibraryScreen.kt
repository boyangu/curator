package app.curator.mobile.ui.library

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.ListQuery
import app.curator.mobile.data.Lists
import app.curator.mobile.model.SearchIndex
import app.curator.mobile.model.StreamingService
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.PullSearchBox
import app.curator.mobile.ui.common.PullSearchState
import app.curator.mobile.ui.common.rememberPullSearch
import app.curator.mobile.ui.home.FilterPicker
import app.curator.mobile.ui.home.MainHeader
import app.curator.mobile.ui.home.PlaylistRow
import app.curator.mobile.ui.home.playlistLines
import app.curator.mobile.ui.home.playlistShows
import app.curator.mobile.ui.home.sourceFilters
import app.curator.mobile.ui.list.DensityButton
import app.curator.mobile.ui.list.StateChips
import app.curator.mobile.ui.list.TrackRows
import app.curator.mobile.ui.list.rememberPager
import app.curator.mobile.ui.list.rememberView
import app.curator.mobile.ui.list.scope
import app.curator.mobile.ui.nav.ListSource
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val TRACKS = "tracks"
private const val PLAYLISTS = "playlists"
private val MODES = listOf(TRACKS, PLAYLISTS)
private fun modeName(m: String?) = if (m == PLAYLISTS) "Playlists" else "Tracks"


/**
 * The Library tab: every track, or every playlist, of one source or all.
 * Which of each the pickers show is remembered on the device (ViewState).
 * Tracks keep the track lists' sort and filters (Actions, as "library") and
 * come a page at a time (TrackPager): the first screen is one LIMIT query.
 */
@Composable
fun LibraryScreen(model: AppModel, bottom: @Composable () -> Unit, push: (Screen) -> Unit) {
	val scope = rememberCoroutineScope()
	// Null until the stored choice is read, so a remembered Playlists never flashes Tracks (and its load).
	val mode by model.viewState.pick("library.mode").collectAsState(null)
	val stored by model.viewState.pick("library.source").collectAsState(null)
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val playlists by model.lists.collectAsState()
	// Until known, the picker offers every service.
	val services = StreamingService.entries.map { it.id }
	val trackSources by produceState<Set<String>>(services.toSet(), lib, version) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) { l.trackSources(services) }
	}
	val search = rememberPullSearch()

	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.statusBars)) {
		val m = mode
		val s = stored
		if (m == null || s == null) {
			MainHeader("Library") {}
			Spacer(Modifier.weight(1f))
			bottom()
			return@Column
		}
		val tracks = m != PLAYLISTS
		val p = playlists
		val filters = sourceFilters(if (tracks) trackSources else p?.playlists?.map { it.source }?.toSet() ?: services.toSet())
		// A source the other mode has and this one lacks shows All (the choice stays stored).
		val filter = s.ifEmpty { null }?.takeIf { it in filters }
		val listSource = ListSource.Library(filter)
		val rows by model.rows.collectAsState()

		MainHeader("Library") {
			FilterPicker(
				MODES, m.ifEmpty { TRACKS }, AnnotatedString(modeName(m)), T.of(14.sp, 500, C.fg1), "Choose tracks or playlists",
				onSelect = { v -> scope.launch { model.viewState.setPick("library.mode", v ?: TRACKS) } },
				names = ::modeName,
			)
			FilterPicker(
				filters, filter, AnnotatedString(app.curator.mobile.ui.home.filterName(filter)), T.of(14.sp, 500, C.fg1), "Choose a source",
				onSelect = { v -> scope.launch { model.viewState.setPick("library.source", v ?: "") } },
			)
			Spacer(Modifier.weight(1f))
			if (tracks) {
				DensityButton(rows.density) { model.setRows(rows.copy(density = if (rows.density == 3) 1 else rows.density + 1)) }
				IconButton(Icon.Menu, "List actions", tint = C.fg) { push(Screen.ListActions(listSource)) }
			}
		}
		PullSearchBox(search, if (tracks) "Search tracks" else "Search playlists")
		if (tracks) Tracks(model, listSource, search, push)
		else if (p != null) Playlists(model, p, filter, search, push)
		else Spacer(Modifier.weight(1f))
		bottom()
	}
}

// Typing waits this long for the next key before the list is searched again.
private const val SEARCH_SETTLE_MS = 150L

@Composable
private fun ColumnScope.Tracks(model: AppModel, source: ListSource.Library, search: PullSearchState, push: (Screen) -> Unit) {
	val view = rememberView(model, source)
	// Each search is a pass over the library in SQL: one per settled query, not per key (clearing is at once).
	val query by produceState(search.query, search.query) {
		if (search.query.isNotBlank()) delay(SEARCH_SETTLE_MS)
		value = search.query
	}
	val pager = rememberPager(model, view?.let { ListQuery(source.scope(), it, query) })
	if (view == null || pager == null) {
		Spacer(Modifier.weight(1f))
		return
	}
	Box(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 10.dp)) {
		StateChips(view, pager) { push(Screen.ListActions(source)) }
	}
	// Another list starts at its top.
	key(pager.query.key) {
		TrackRows(
			model, source, pager, query,
			if (query.isNotBlank()) "No tracks match \"${query.trim()}\"." else "No tracks match these filters.",
			Modifier.weight(1f).nestedScroll(search.connection), push,
		)
	}
}

@Composable
private fun ColumnScope.Playlists(model: AppModel, d: Lists, filter: String?, search: PullSearchState, push: (Screen) -> Unit) {
	val pins by model.pins.collectAsState()
	val lines = remember(d) { SearchIndex(playlistLines(d.playlists, d.folders)) { it.text } }
	val shown = lines.search(search.query).filter { playlistShows(filter, it.playlist) }
	val pinned = pins.filter { it.kind == "playlist" }.map { it.id }.toSet()
	LazyColumn(Modifier.weight(1f).nestedScroll(search.connection)) {
		item("count") { BasicText("${shown.size} playlists", Modifier.padding(start = 16.dp, top = 2.dp, bottom = 10.dp), style = T.of(12.5.sp, color = C.fg1)) }
		items(shown, key = { it.playlist.id }) { r ->
			PlaylistRow(r, r.playlist.id in pinned) { push(Screen.TrackList(ListSource.Playlist(r.playlist.id))) }
		}
	}
}
