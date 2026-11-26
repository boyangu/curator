package app.curator.mobile.ui.list

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import app.curator.mobile.data.Library
import app.curator.mobile.data.ListQuery
import app.curator.mobile.data.ListScope
import app.curator.mobile.data.ListTotals
import app.curator.mobile.data.Track
import app.curator.mobile.model.relatedKeys
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.nav.ListSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Rows fetched per query: about three screens of the densest layout. */
const val PAGE = 100

/**
 * One list as shown, read a page at a time (§5). The first page's ids and
 * rows come in one go (a LIMIT query: what the screen shows first), then
 * every id in order (ids only, one query), and rows [PAGE] at a time as they
 * scroll into view. A 38k-track library is never in memory whole, only its
 * ids. A change to the library ([sync]) reads the ids again and lets the
 * pages in view refetch, showing the old rows until the new ones are in.
 */
@Stable
class TrackPager internal constructor(private val lib: Library, val query: ListQuery, private val scope: CoroutineScope, private var version: Int) {
	/** The ids in order, as far as known: the first page, then every one. */
	var ids by mutableStateOf<List<String>>(emptyList())
		private set
	/**
	 * Each row's key for the list: its id, with the occurrence after the first
	 * ("id#2"). A playlist can hold one track twice (75 of nov8's do), and a
	 * lazy list throws on a key it has seen.
	 */
	var keys by mutableStateOf<List<String>>(emptyList())
		private set

	private fun show(next: List<String>) {
		val seen = HashMap<String, Int>()
		keys = next.map { id -> seen.merge(id, 1, Int::plus)!!.let { n -> if (n == 1) id else "$id#$n" } }
		ids = next
	}
	/** Whether [ids] holds the whole list yet (a short list knows at once). */
	var complete by mutableStateOf(false)
		private set
	/** Whether the first page is in: until then the list is opening, not empty. */
	var started by mutableStateOf(false)
		private set
	/** The list's size and length before the view. */
	var totals by mutableStateOf<ListTotals?>(null)
		private set

	private val pages = mutableStateMapOf<Int, List<Track>>()
	// The read each page was fetched at; a page from an older one is shown until refetched.
	private val fetchedAt = HashMap<Int, Int>()
	private val fetching = HashSet<Int>()
	private var read = 0
	private var job: Job? = null

	val size: Int get() = ids.size

	init { load() }

	/** The track at [i], or null while its page is on its way (asking fetches it). */
	fun track(i: Int): Track? {
		val p = i / PAGE
		if (fetchedAt[p] != read && p !in fetching) fetch(p)
		return pages[p]?.getOrNull(i % PAGE)
	}

	/** The first page's rows, as far as fetched (the row editor's sample). */
	val firstPage: List<Track> get() = pages[0] ?: emptyList()

	/** Reads the list again when the library changed since. */
	fun sync(libraryVersion: Int) {
		if (libraryVersion == version) return
		version = libraryVersion
		load()
	}

	private fun load() {
		job?.cancel()
		job = scope.launch(Dispatchers.Main) {
			val (first, rows) = withContext(Dispatchers.IO) { lib.ids(query.ids(PAGE)).let { it to lib.tracks(it) } }
			read++
			show(first)
			pages[0] = rows
			fetchedAt[0] = read
			complete = first.size < PAGE
			started = true
			if (!complete) {
				show(withContext(Dispatchers.IO) { lib.ids(query.ids()) })
				complete = true
			}
			totals = withContext(Dispatchers.IO) { lib.totals(query.totals()) }
		}
	}

	private fun fetch(p: Int) {
		val slice = ids.subList((p * PAGE).coerceAtMost(ids.size), ((p + 1) * PAGE).coerceAtMost(ids.size))
		if (slice.isEmpty()) return
		val at = read
		fetching += p
		scope.launch(Dispatchers.Main) {
			try {
				val rows = withContext(Dispatchers.IO) { lib.tracks(slice) }
				if (at == read) { pages[p] = rows; fetchedAt[p] = at }
			} finally {
				fetching -= p
			}
		}
	}
}

/** A list source as the rows it reads: the Library's Owned are the 'local' files. */
fun ListSource.scope(): ListScope = when (this) {
	is ListSource.Playlist -> ListScope.Playlist(id)
	is ListSource.Tag -> ListScope.Tag(id)
	is ListSource.Artist -> ListScope.Artist(id)
	is ListSource.Label -> ListScope.Label(name)
	is ListSource.Set -> ListScope.Set(id)
	is ListSource.Similar -> ListScope.Similar(trackId, relatedKeys(camelot))
	is ListSource.Library -> ListScope.Library(if (filter == ListSource.OWNED) "local" else filter)
}

/** The pager for [query] (null while the view is still being read), kept up with the library. */
@Composable
fun rememberPager(model: AppModel, query: ListQuery?): TrackPager? {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val pager = remember(lib, query?.key) { if (lib == null || query == null) null else model.pager(query) }
	LaunchedEffect(pager, version) { pager?.sync(version) }
	return pager
}
