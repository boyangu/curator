package app.curator.mobile.ui.nav

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

enum class Tab(val label: String) { HOME("Home"), FEED("Feed"), LIBRARY("Library"), EXPLORE("Explore"), SEARCH("Search") }

/** What a track list shows: one component serves all of them (§5). */
sealed interface ListSource {
	val key: String
	data class Playlist(val id: String) : ListSource { override val key get() = "playlist:$id" }
	data class Tag(val id: String) : ListSource { override val key get() = "tag:$id" }
}

sealed interface Screen {
	/** Pages that cover the whole screen and slide in from the right over the one below. */
	val isPage: Boolean get() = false
	/** Whether the screen may turn sideways (Track and its actions only). */
	val rotates: Boolean get() = false

	data class TabRoot(val tab: Tab) : Screen
	data class TrackList(val source: ListSource) : Screen
	data class Track(val trackId: String, val from: ListSource?, val index: Int, val count: Int) : Screen { override val rotates get() = true }
	data class ListActions(val source: ListSource) : Screen { override val isPage get() = true }
	/** [sample]: the list it was opened from; its tracks fill the preview. */
	data class RowFields(val sample: ListSource?) : Screen { override val isPage get() = true }
	data class TrackActions(val trackId: String) : Screen { override val isPage get() = true; override val rotates get() = true }
}

/** One back stack per tab; the tab bar switches stacks, back pops the current one. */
@Stable
class Nav {
	private val stacks: Map<Tab, MutableList<Entry>> = Tab.entries.associateWith { mutableStateListOf(Entry(Screen.TabRoot(it))) }
	var tab by mutableStateOf(Tab.HOME)
		private set

	val stack: List<Entry> get() = stacks.getValue(tab)
	val top: Entry get() = stack.last()

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
