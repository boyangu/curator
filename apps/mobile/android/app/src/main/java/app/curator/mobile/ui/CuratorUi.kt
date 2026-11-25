package app.curator.mobile.ui

import android.app.Activity
import android.content.pm.ActivityInfo
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.curator.mobile.MainActivity
import app.curator.mobile.Stage
import app.curator.mobile.data.Track
import app.curator.mobile.model.accountNotice
import app.curator.mobile.model.joinNotice
import app.curator.mobile.ui.chrome.BottomChrome
import app.curator.mobile.ui.chrome.MiniPlayer
import app.curator.mobile.ui.feed.FeedModel
import app.curator.mobile.ui.feed.FeedScreen
import app.curator.mobile.ui.home.HomeScreen
import app.curator.mobile.ui.library.LibraryScreen
import app.curator.mobile.ui.list.ListActionsPage
import app.curator.mobile.ui.list.RowFieldsPage
import app.curator.mobile.ui.list.TrackListScreen
import app.curator.mobile.ui.nav.Nav
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.nav.StackHost
import app.curator.mobile.ui.nav.Tab
import app.curator.mobile.ui.settings.Action
import app.curator.mobile.ui.settings.Diagnostics
import app.curator.mobile.ui.settings.SettingsPage
import app.curator.mobile.ui.settings.Updates
import app.curator.mobile.ui.signin.AccountBanner
import app.curator.mobile.ui.signin.SignInScreen
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.track.TrackActionsPage
import app.curator.mobile.ui.track.TrackScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The app: one stack per tab, the views (§3–§6), and which screens may turn sideways. */
@Composable
fun CuratorUi(model: AppModel) {
	val nav = remember { Nav() }
	val stage by model.app.stage.collectAsState()
	val phase by model.app.core.phase.collectAsState()
	val lib by model.library.collectAsState()

	// Track (and its actions) turn with the phone; everything else stays portrait (§2).
	val activity = LocalContext.current as Activity
	val rotates = nav.top.screen.rotates
	LaunchedEffect(rotates) {
		activity.requestedOrientation = if (rotates) ActivityInfo.SCREEN_ORIENTATION_FULL_USER else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
	}

	if (lib == null) {
		when (val s = stage) {
			Stage.SignedOut -> SignInScreen(model, back = null)
			is Stage.Failed -> CannotOpen(model, s)
			else -> Opening(when (phase) {
				"installing" -> "Bringing your library to this phone…"
				"failed" -> "The sync core did not start."
				else -> "Opening the library…"
			})
		}
		return
	}

	val bottom: @Composable () -> Unit = { Bottom(model, nav) }
	StackHost(nav) { screen ->
		when (screen) {
			is Screen.TabRoot -> when (screen.tab) {
				Tab.HOME -> HomeScreen(model, bottom, openSettings = { nav.push(Screen.Settings) }) { nav.push(Screen.TrackList(it)) }
				Tab.FEED -> FeedScreen(model, bottom)
				Tab.LIBRARY -> LibraryScreen(model, bottom, push = nav::push)
				else -> Placeholder(screen.tab.label, bottom)
			}
			is Screen.TrackList -> TrackListScreen(model, screen.source, bottom, back = { nav.pop() }, push = nav::push)
			is Screen.ListActions -> ListActionsPage(model, screen.source, back = { nav.pop() }, openFields = { nav.push(Screen.RowFields(screen.source)) })
			is Screen.RowFields -> RowFieldsPage(model, screen.sample, back = { nav.pop() })
			is Screen.Track -> TrackScreen(model, screen, back = { nav.pop() }, push = nav::push, replace = nav::replaceTop)
			is Screen.TrackActions -> TrackActionsPage(model, screen.trackId, back = { nav.pop() })
			Screen.Settings -> SettingsPage(model, back = { nav.pop() }, signIn = { nav.push(Screen.SignIn) })
			Screen.SignIn -> SignInScreen(model, back = { nav.pop() })
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
		// The track before this one is not what the mini player now plays.
		if (value?.first?.id != id) value = null
		value = id?.let { withContext(Dispatchers.IO) { l.track(it)?.let { t -> t to l.hasTag(it, "interested") } } }
	}
	val account by model.app.account.collectAsState()
	val sync by model.app.core.status.collectAsState()
	val notice = accountNotice(account?.tokens != null, sync?.revoked == true, sync?.needsUpdate == true)
	// Removed or signed out: a sign-in is the way back. Out of date: the updater's section.
	val join = joinNotice(sync?.waiting == true, sync?.joining == true)
	if (notice == null && join != null) AccountBanner(join, null)
	if (notice != null) AccountBanner(notice) { nav.push(if (sync?.needsUpdate == true) Screen.Settings else Screen.SignIn) }
	BottomChrome(
		miniPlayer = {
			val known = facts
			if (known != null) {
				val (t, interested) = known
				MiniPlayer(
					model.player, t.bpm, t.key, interested,
					onInterested = { model.setTag(t.id, "interested", !interested) },
					onOpen = { nav.push(Screen.Track(t.id, null, 0, 1)) },
				)
			} else if (id != null && FeedModel.isFeedTrack(id)) {
				MiniPlayer(model.player, null, null, interested = false, onInterested = null, onOpen = null)
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

/** The library isn't here: try again, use another account, or (a build that can't open it) the log and an update. */
@Composable
private fun CannotOpen(model: AppModel, s: Stage.Failed) {
	val scope = model.app.scope
	var leaving by remember { mutableStateOf(false) }
	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.systemBars).verticalScroll(rememberScrollState())) {
		Column(Modifier.padding(horizontal = 16.dp, vertical = 48.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
			BasicText(s.why, style = T.body)
			Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				if (s.retry) Action("Try again", strong = true) { scope.launch { model.app.openLibrary() } }
				if (s.retry) Action(if (leaving) "Signing out…" else "Sign out", enabled = !leaving) { leaving = true; scope.launch { model.app.signOut(MainActivity::class.java) } }
			}
		}
		Diagnostics(model)
		Updates(model)
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
