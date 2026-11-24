package app.curator.mobile.ui

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.curator.mobile.data.Track
import app.curator.mobile.ui.chrome.BottomChrome
import app.curator.mobile.ui.chrome.MiniPlayer
import app.curator.mobile.ui.home.HomeScreen
import app.curator.mobile.ui.library.LibraryScreen
import app.curator.mobile.ui.list.ListActionsPage
import app.curator.mobile.ui.list.RowFieldsPage
import app.curator.mobile.ui.list.TrackListScreen
import app.curator.mobile.ui.nav.Nav
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.nav.StackHost
import app.curator.mobile.ui.nav.Tab
import app.curator.mobile.ui.settings.SettingsPage
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.track.TrackActionsPage
import app.curator.mobile.ui.track.TrackScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The app: one stack per tab, the views (§3–§6), and which screens may turn sideways. */
@Composable
fun CuratorUi(model: AppModel) {
	val nav = remember { Nav() }
	val problem by model.app.problem.collectAsState()
	val phase by model.app.core.phase.collectAsState()
	val lib by model.library.collectAsState()

	// Track (and its actions) turn with the phone; everything else stays portrait (§2).
	val activity = LocalContext.current as Activity
	val rotates = nav.top.screen.rotates
	LaunchedEffect(rotates) {
		activity.requestedOrientation = if (rotates) ActivityInfo.SCREEN_ORIENTATION_FULL_USER else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
	}

	if (lib == null) {
		Opening(problem ?: when (phase) {
			"installing" -> "Bringing your library to this phone…"
			"failed" -> "The sync core did not start."
			else -> "Opening the library…"
		})
		return
	}

	val bottom: @Composable () -> Unit = { Bottom(model, nav) }
	StackHost(nav) { screen ->
		when (screen) {
			is Screen.TabRoot -> when (screen.tab) {
				Tab.HOME -> HomeScreen(model, bottom, openSettings = { nav.push(Screen.Settings) }) { nav.push(Screen.TrackList(it)) }
				Tab.LIBRARY -> LibraryScreen(model, bottom, push = nav::push)
				else -> Placeholder(screen.tab.label, bottom)
			}
			is Screen.TrackList -> TrackListScreen(model, screen.source, bottom, back = { nav.pop() }, push = nav::push)
			is Screen.ListActions -> ListActionsPage(model, screen.source, back = { nav.pop() }, openFields = { nav.push(Screen.RowFields(screen.source)) })
			is Screen.RowFields -> RowFieldsPage(model, screen.sample, back = { nav.pop() })
			is Screen.Track -> TrackScreen(model, screen, back = { nav.pop() }, push = nav::push, replace = nav::replaceTop)
			is Screen.TrackActions -> TrackActionsPage(model, screen.trackId, back = { nav.pop() })
			Screen.Settings -> SettingsPage(model, back = { nav.pop() })
		}
	}
}

// The mini player over the tab bar, with the loaded track's BPM, key and Interested.
@Composable
private fun Bottom(model: AppModel, nav: Nav) {
	val player by model.player.state.collectAsState()
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val id = player.track?.trackId
	val facts by produceState<Pair<Track, Boolean>?>(null, id, lib, version) {
		val l = lib ?: return@produceState
		value = id?.let { withContext(Dispatchers.IO) { l.track(it)?.let { t -> t to l.hasTag(it, "interested") } } }
	}
	BottomChrome(
		miniPlayer = {
			facts?.let { (t, interested) ->
				MiniPlayer(
					model.player, t.bpm, t.key, interested,
					onInterested = { model.setTag(t.id, "interested", !interested) },
					onOpen = { nav.push(Screen.Track(t.id, null, 0, 1)) },
				)
			}
		},
		tab = nav.tab,
		onSelect = nav::select,
	)
}

@Composable
private fun Opening(text: String) {
	Box(Modifier.fillMaxSize().background(C.bg), contentAlignment = Alignment.Center) {
		BasicText(text, Modifier.padding(24.dp), style = T.body)
	}
}

@Composable
private fun Placeholder(name: String, bottom: @Composable () -> Unit) {
	Column(Modifier.fillMaxSize().background(C.bg)) {
		Box(Modifier.weight(1f).fillMaxSize(), contentAlignment = Alignment.Center) {
			Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
				BasicText(name, style = T.screenTitle)
				BasicText("Comes in a later pass.", style = T.secondary)
			}
		}
		bottom()
	}
}
