package app.curator.mobile.ui.settings

import android.app.Activity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.StreamingCoverage
import app.curator.mobile.model.StreamingService
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.SourceDot
import app.curator.mobile.ui.common.SwitchRow
import app.curator.mobile.update.UpdateState
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.curator.mobile.ui.list.topLine
import app.curator.mobile.ui.theme.C
import app.curator.mobile.ui.theme.T
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * This phone's settings: the streaming service the library's own files play
 * from, each service shown with how many of those files it has (their
 * recordings' claims there), and how the app updates itself.
 */
@Composable
fun SettingsPage(model: AppModel, back: () -> Unit) {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val picked by model.streaming.collectAsState()
	val coverage by produceState<StreamingCoverage?>(null, lib, version) {
		value = lib?.let { l -> withContext(Dispatchers.IO) { l.streamingCoverage() } }
	}

	Column(
		Modifier
			.fillMaxSize()
			.background(C.bg)
			.windowInsetsPadding(WindowInsets.statusBars)
			.windowInsetsPadding(WindowInsets.navigationBars)
			.verticalScroll(rememberScrollState()),
	) {
		Row(Modifier.fillMaxWidth().height(56.dp).padding(start = 4.dp, end = 16.dp), verticalAlignment = Alignment.CenterVertically) {
			IconButton(Icon.Back, "Back", onClick = back)
			BasicText("Settings", Modifier.semantics { heading() }, style = T.screenTitle)
		}

		Column(Modifier.fillMaxWidth().topLine().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
			BasicText("Streaming service", Modifier.semantics { heading() }, style = T.label)
			BasicText(
				"Your own files play from it, as the track it has for each. A streaming track always plays from its own service.",
				style = T.secondary,
			)
		}
		Column(Modifier.fillMaxWidth().selectableGroup().padding(vertical = 4.dp)) {
			for (s in StreamingService.entries) ServiceRow(s, s == picked, coverage) { model.setStreaming(s) }
		}
		Updates(model)
		Spacer(Modifier.height(24.dp))
	}
}

/** The version, where the updater is, the automatic switch, and the one action that fits (check, install, allow installs). */
@Composable
private fun Updates(model: AppModel) {
	val updater = model.updater
	val state by updater.state.collectAsState()
	val auto by model.autoUpdate.collectAsState()
	val activity = LocalContext.current as Activity
	// Read again on coming back from the grant's page.
	var allowed by remember { mutableStateOf(updater.installAllowed()) }
	LifecycleResumeEffect(Unit) {
		allowed = updater.installAllowed()
		onPauseOrDispose {}
	}

	Column(Modifier.fillMaxWidth().topLine().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
		BasicText("Updates", Modifier.semantics { heading() }, style = T.label)
		BasicText("Curator ${updater.version}", style = T.mono(12.5.sp, C.fg2))
		BasicText(describe(state, auto), Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = T.secondary)
	}
	if (state is UpdateState.Off) return
	SwitchRow("Install updates automatically", auto, Modifier.fillMaxWidth().heightIn(min = 52.dp)) { model.setAutoUpdate(!auto) }
	Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
		if (!allowed) Action("Allow installs") { updater.allowInstalls(activity) }
		when (state) {
			is UpdateState.Available -> Action("Install ${(state as UpdateState.Available).version}") { updater.act() }
			is UpdateState.Ready -> Action("Install now") { updater.act() }
			is UpdateState.Checking, is UpdateState.Downloading, is UpdateState.Installing -> {}
			else -> Action("Check now") { updater.act() }
		}
	}
	if (!allowed) BasicText(
		"Android asks once whether Curator may install apps; after that, updates install without asking.",
		Modifier.padding(horizontal = 16.dp),
		style = T.of(12.5.sp, color = C.fg3),
	)
}

private fun describe(s: UpdateState, auto: Boolean): String = when (s) {
	is UpdateState.Off -> s.why
	UpdateState.Idle -> "Not checked yet"
	UpdateState.Checking -> "Checking…"
	is UpdateState.UpToDate -> "Up to date"
	is UpdateState.Available -> "Curator ${s.version} is out"
	is UpdateState.Downloading -> "Downloading ${s.version}… ${(s.fraction * 100).toInt()}%"
	is UpdateState.Ready -> if (auto) "${s.version} is ready: it installs when you leave Curator" else "${s.version} is ready to install"
	is UpdateState.Installing -> "Installing ${s.version}…"
	is UpdateState.Failed -> "Update failed: ${s.reason}"
}

@Composable
private fun Action(text: String, onClick: () -> Unit) {
	Box(
		Modifier
			.heightIn(min = 40.dp)
			.border(1.dp, C.line, RoundedCornerShape(4.dp))
			.clickable(role = Role.Button, onClick = onClick)
			.padding(horizontal = 14.dp),
		contentAlignment = Alignment.Center,
	) { BasicText(text, style = T.of(14.sp, color = C.fg)) }
}

@Composable
private fun ServiceRow(s: StreamingService, on: Boolean, coverage: StreamingCoverage?, onPick: () -> Unit) {
	val owned = coverage?.owned ?: 0
	val has = coverage?.by?.get(s.id) ?: 0
	val share = if (owned > 0) has.toFloat() / owned else 0f
	// A service this phone can't play through yet shows, dimmed and unpickable, under a watermark.
	Box(Modifier.fillMaxWidth()) {
		Row(
			Modifier
				.fillMaxWidth()
				.heightIn(min = 72.dp)
				.then(
					if (s.playable) Modifier.selectable(selected = on, role = Role.RadioButton, onClick = onPick)
					else Modifier.semantics(mergeDescendants = true) { stateDescription = "Coming soon"; disabled() },
				)
				.alpha(if (s.playable) 1f else 0.3f)
				.padding(horizontal = 16.dp, vertical = 10.dp),
			verticalAlignment = Alignment.CenterVertically,
			horizontalArrangement = Arrangement.spacedBy(14.dp),
		) {
			Radio(on)
			Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
				Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					SourceDot(s.id)
					BasicText(s.label, style = T.of(15.sp, color = C.fg))
				}
				BasicText(
					if (coverage == null) "Counting your files…" else "%,d of %,d of your files".format(has, owned),
					style = T.mono(12.5.sp, C.fg2),
				)
				CoverageBar(share)
			}
			if (coverage != null && owned > 0) BasicText("${(share * 100).toInt()}%", style = T.mono(13.sp, if (on) C.fg else C.fg1))
		}
		if (!s.playable) ComingSoon(Modifier.matchParentSize())
	}
}

/** The watermark across a row that isn't available yet; its row carries the words for TalkBack. */
@Composable
private fun ComingSoon(modifier: Modifier) {
	Box(modifier.clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
		BasicText(
			"COMING SOON",
			Modifier.rotate(-6f),
			style = T.of(20.sp, 600, C.fg.copy(alpha = 0.6f)).copy(letterSpacing = 6.sp),
		)
	}
}

/** The radio mark: a ring, filled with an accent dot when picked. Its row owns the selection and the semantics. */
@Composable
private fun Radio(on: Boolean) {
	Box(Modifier.size(20.dp).border(1.5.dp, if (on) C.accent else C.fg3, CircleShape), contentAlignment = Alignment.Center) {
		if (on) Box(Modifier.size(10.dp).clip(CircleShape).background(C.accent))
	}
}

/** Of the files, the share the service has. */
@Composable
private fun CoverageBar(share: Float) {
	Box(Modifier.fillMaxWidth().height(3.dp).background(C.line)) {
		Box(Modifier.fillMaxWidth(share.coerceIn(0f, 1f)).fillMaxHeight().background(C.accent))
	}
}
