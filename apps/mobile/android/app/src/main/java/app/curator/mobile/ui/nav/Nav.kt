package app.curator.mobile.ui.nav

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

enum class Tab(val label: String) {
	HOME("Home"), FEED("Feed"), LIBRARY("Library"), EXPLORE("Explore"), SEARCH("Search");

	companion object {
		/** The main views a sideways swipe moves between, in the tab bar's order (Search is reached by its tab, or by pulling a list down). */
		val swipeable = listOf(HOME, FEED, LIBRARY, EXPLORE)
	}
}

/** What a track list shows: one component serves all of them (§5). */
sealed interface ListSource {
	val key: String
	data class Playlist(val id: String) : ListSource { override val key get() = "playlist:$id" }
	data class Tag(val id: String) : ListSource { override val key get() = "tag:$id" }
	/** The artist's tracks in the library (the way to an artist until the phone has artist pages). */
	data class Artist(val id: String) : ListSource { override val key get() = "artist:$id" }
	/** Every track in the library, or those from one source ([filter]: a service id, or [OWNED]). One sort and filter set for all of them. */
	data class Library(val filter: String?) : ListSource { override val key get() = "library" }

	companion object {
		/** The filter for the Owned library: the files' tracks, rekordbox's and local playlists. */
		const val OWNED = "owned"
	}
}

sealed interface Screen {
	/** Pages that cover the whole screen and slide in from the right over the one below. */
	val isPage: Boolean get() = false
	/** Whether the screen may turn sideways (Track and its actions only). */
	val rotates: Boolean get() = false

	data class TabRoot(val tab: Tab) : Screen
	data class TrackList(val source: ListSource) : Screen
	/** [search]: what the list it was opened from was searched for (Next goes on through the same results). */
	data class Track(val trackId: String, val from: ListSource?, val index: Int, val count: Int, val search: String = "") : Screen { override val rotates get() = true }
	data class ListActions(val source: ListSource) : Screen { override val isPage get() = true }
	/** [sample]: the list it was opened from; its tracks fill the preview. */
	data class RowFields(val sample: ListSource?) : Screen { override val isPage get() = true }
	data class TrackActions(val trackId: String) : Screen { override val isPage get() = true; override val rotates get() = true }
	data object Settings : Screen { override val isPage get() = true }
	/** Signing in again: the session ended, the library is still here. */
	data object SignIn : Screen { override val isPage get() = true }
}

/** One back stack per tab; the tab bar switches stacks, back pops the current one. */
@Stable
class Nav {
	private val stacks: Map<Tab, MutableList<Entry>> = Tab.entries.associateWith { mutableStateListOf(Entry(Screen.TabRoot(it))) }
	var tab by mutableStateOf(Tab.HOME)
		private set

	val stack: List<Entry> get() = stacks.getValue(tab)
	val top: Entry get() = stack.last()

	/** The main view beside the current one ([dir] +1: the next to the right), or null at either end or off the main views. */
	fun beside(dir: Int): Tab? {
		val i = Tab.swipeable.indexOf(tab)
		return if (i < 0) null else Tab.swipeable.getOrNull(i + dir)
	}

	fun topOf(t: Tab): Entry = stacks.getValue(t).last()

	/** Ids for the state holder: a screen keeps its scroll position while covered. */
	class Entry(val screen: Screen) {
		val id: Long = nextId++
	}

	fun select(t: Tab) {
		// Tapping the current tab again returns to its root.
		if (t == tab) stacks.getValue(t).let { while (it.size > 1) it.removeAt(it.lastIndex) }
		tab = t
	}

	fun push(s: Screen) {
		stacks.getValue(tab).add(Entry(s))
	}

	/** A page a swipe already drew (StackHost): pushed as that same entry, so its state carries over. */
	internal fun pushEntry(e: Entry) {
		stacks.getValue(tab).add(e)
	}

	/** False at a tab's root: the system takes the back gesture then. */
	fun pop(): Boolean {
		val st = stacks.getValue(tab)
		if (st.size <= 1) return false
		st.removeAt(st.lastIndex)
		return true
	}

	/** Replaces the top (Track's next track). */
	fun replaceTop(s: Screen) {
		val st = stacks.getValue(tab)
		st[st.lastIndex] = Entry(s)
	}

	companion object {
		private var nextId = 1L
	}
}
