package app.curator.mobile.ui.track

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.curator.mobile.data.Track
import app.curator.mobile.data.TrackAnalysis
import app.curator.mobile.model.ListView
import app.curator.mobile.model.apply
import app.curator.mobile.ui.AppModel
import app.curator.mobile.ui.common.Cover
import app.curator.mobile.ui.common.Icon
import app.curator.mobile.ui.common.IconButton
import app.curator.mobile.ui.common.IconGlyph
import app.curator.mobile.ui.common.KeyChip
import app.curator.mobile.ui.common.Line
import app.curator.mobile.ui.common.SourceDot
import app.curator.mobile.ui.common.TagPill
import app.curator.mobile.ui.common.formatBpm
import app.curator.mobile.ui.common.formatTime
import app.curator.mobile.ui.list.Metrics
import app.curator.mobile.ui.list.playFrom
import app.curator.mobile.ui.list.rememberList
import app.curator.mobile.ui.nav.LocalPageGestures
import app.curator.mobile.ui.nav.Screen
import app.curator.mobile.ui.nav.swipeToOpen
import app.curator.mobile.ui.theme.C
import androidx.compose.ui.draw.drawBehind
import app.curator.mobile.ui.theme.T
import app.curator.mobile.ui.theme.sourceName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val ZOOMS = listOf(4f, 8f, 16f, 32f)

@Composable
fun TrackScreen(model: AppModel, screen: Screen.Track, back: () -> Unit, push: (Screen) -> Unit, replace: (Screen) -> Unit) {
	val lib by model.library.collectAsState()
	val version by model.version.collectAsState()
	val metrics by model.metrics.collectAsState()
	val player by model.player.state.collectAsState()
	val scope = rememberCoroutineScope()
	val loaded by produceState<Pair<Track, TrackAnalysis>?>(null, lib, version, screen.trackId) {
		val l = lib ?: return@produceState
		value = withContext(Dispatchers.IO) { l.track(screen.trackId)?.let { it to l.analysis(it.id) } }
	}
	val peaks = rememberPeaks(model, screen.trackId)
	val listName = screen.from?.let { rememberList(model, it) }
	val view by (screen.from?.let { model.viewState.listView(it.key) } ?: kotlinx.coroutines.flow.flowOf(ListView())).collectAsState(ListView())
	val rotatedOnce by model.viewState.rotatedOnce.collectAsState(true)

	// The player follows the open track (rotating keeps it: same screen, same state).
	LaunchedEffect(screen.trackId, loaded) { loaded?.first?.let { playFrom(model, it) } }

	var scrub by remember { mutableStateOf<Double?>(null) }
	var zoom by rememberSaveable { mutableFloatStateOf(16f) }
	val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
	LaunchedEffect(landscape) { if (landscape) model.viewState.rotated() }

	val (track, analysis) = loaded ?: run {
		Box(Modifier.fillMaxSize().background(C.bg)) { IconButton(Icon.Back, "Back", modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars), onClick = back) }
		return
	}
	val ours = player.track?.trackId == track.id
	val position = scrub ?: if (ours) player.positionSec else 0.0
	val duration = (track.durationSec ?: 0).toDouble().takeIf { it > 0 } ?: peaks?.seconds ?: 0.0
	val seek: (Double) -> Unit = { s -> scrub = null; model.player.seek(s.coerceIn(0.0, duration)) }
	val jump: (Int) -> Unit = { n -> seek(jumpBeats(analysis.beats, track.bpm, position, n)) }
	val cuePoint = analysis.cues.firstOrNull()?.positionSec ?: 0.0
	val playPause = { if (player.playing && ours) model.player.pause() else model.player.play() }
	val next: (() -> Unit)? = listName?.let { data ->
		val shown = view.apply(data.tracks)
		val i = shown.indexOfFirst { it.id == track.id }
		shown.getOrNull(i + 1)?.let { n -> { scope.launch { playFrom(model, n) }; replace(Screen.Track(n.id, screen.from, i + 1, shown.size)) } }
	}
	val transport = Transport(
		playing = player.playing && ours, unavailable = player.unavailable.takeIf { ours },
		onPlay = playPause, onCue = { seek(cuePoint) }, onJump = jump, onNext = next,
	)
	val gestures = LocalPageGestures.current
	val open = { push(Screen.TrackActions(track.id)) }

	if (landscape) {
		Landscape(track, analysis, peaks, position, duration, zoom, transport, back, open,
			onZoom = { factor -> zoom = (zoom * factor).coerceIn(2f, 64f) },
			onCycleZoom = { zoom = ZOOMS.firstOrNull { it > zoom + 0.01f } ?: ZOOMS.first() },
			onScrub = { scrub = it }, onSeek = seek)
	} else {
		Portrait(track, analysis, peaks, metrics, position, duration, transport,
			from = listName?.name, index = screen.index, count = screen.count,
			showHint = !rotatedOnce, back = back, openActions = open,
			onScrub = { scrub = it }, onSeek = seek,
			modifier = Modifier.swipeToOpen(gestures) { Screen.TrackActions(track.id) })
	}
}

private class Transport(
	val playing: Boolean,
	val unavailable: String?,
	val onPlay: () -> Unit,
	val onCue: () -> Unit,
	val onJump: (Int) -> Unit,
	val onNext: (() -> Unit)?,
)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Portrait(
	t: Track, a: TrackAnalysis, peaks: Peaks?, metrics: Metrics, position: Double, duration: Double, tr: Transport,
	from: String?, index: Int, count: Int, showHint: Boolean,
	back: () -> Unit, openActions: () -> Unit, onScrub: (Double) -> Unit, onSeek: (Double) -> Unit, modifier: Modifier,
) {
	Column(modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.statusBars)) {
		Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
			IconButton(Icon.Back, if (from != null) "Back to $from" else "Back", onClick = back)
			BasicText(
				buildAnnotatedString {
					if (from != null) {
						append("From ")
						withStyle(SpanStyle(color = C.fg)) { append(from) }
						append(" · ${index + 1} of $count")
					}
				},
				Modifier.weight(1f), style = T.of(13.sp, color = C.fg2).copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center), maxLines = 1,
			)
			IconButton(Icon.Menu, "Track actions", tint = C.fg, onClick = openActions)
		}
		Column(
			Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 6.dp).windowInsetsPadding(WindowInsets.navigationBars),
			verticalArrangement = Arrangement.spacedBy(18.dp),
		) {
			Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
				Cover(t.coverUrl, t.id, 116.dp)
				Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
					BasicText(t.title, Modifier.semantics { heading() }, style = T.trackTitle)
					if (t.artist.isNotEmpty()) BasicText(t.artist, style = T.of(15.sp, color = C.fg1))
					listOfNotNull(t.version, t.label).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { BasicText(it, style = T.of(13.sp, color = C.fg2)) }
					listOfNotNull(t.genre, t.released?.take(10)).joinToString(" · ").takeIf { it.isNotEmpty() }?.let { BasicText(it, style = T.of(13.sp, color = C.fg2)) }
				}
			}
			Facts(t)
			Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
				OverviewMap(peaks, duration, position, a.cues, Modifier.fillMaxWidth().height(60.dp).semantics { contentDescription = "Track overview. Tap or drag to seek" }, onScrub = onScrub, onSeek = onSeek)
				PhraseLane(a.phrases, duration, Modifier.fillMaxWidth().height(5.dp))
				Row {
					BasicText(formatTime(position), Modifier.weight(1f), style = T.mono(12.sp, C.fg2))
					BasicText("-" + formatTime(duration - position), style = T.mono(12.sp, C.fg2))
				}
			}
			Row(Modifier.fillMaxWidth().padding(top = 0.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
				Boxed("-16", "Back 16 beats", 52.dp, 48.dp, mono = true) { tr.onJump(-16) }
				Boxed("Cue", "Cue", 52.dp, 48.dp) { tr.onCue() }
				Box(
					Modifier.size(64.dp).clip(CircleShape).background(C.fg)
						.clickable(role = Role.Button, onClickLabel = if (tr.playing) "Pause" else "Play", onClick = tr.onPlay)
						.semantics { contentDescription = if (tr.playing) "Pause" else "Play" },
					contentAlignment = Alignment.Center,
				) { IconGlyph(if (tr.playing) Icon.Pause else Icon.Play, Color.Black, 24.dp) }
				BoxedIcon(Icon.Next, "Next track", 52.dp, 48.dp, enabled = tr.onNext != null) { tr.onNext?.invoke() }
				Boxed("+16", "Forward 16 beats", 52.dp, 48.dp, mono = true) { tr.onJump(16) }
			}
			tr.unavailable?.let { BasicText(it, Modifier.fillMaxWidth(), style = T.of(12.5.sp, color = C.fg2).copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center)) }
			if (showHint) {
				Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
					IconGlyph(Icon.Rotate, C.fg2, 16.dp, 1.6f)
					Spacer(Modifier.width(8.dp))
					BasicText("Turn sideways for the big waveform", style = T.of(12.5.sp, color = C.fg2))
				}
			}
			Sound(t, metrics)
			FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
				for (tag in t.tags) TagPill(tag, height = 26.dp)
				Spacer(Modifier.weight(1f))
				Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.height(26.dp)) {
					SourceDot(t.source)
					BasicText("Playing from ${sourceName(t.source)}", style = T.of(12.sp, color = C.fg2))
				}
			}
			Spacer(Modifier.height(12.dp))
		}
	}
}

// BPM / Key / Time / Rating: a 12sp label over a 17sp mono value.
@Composable
private fun Facts(t: Track) {
	Row(Modifier.fillMaxWidth().topBottomLines()) {
		Fact("BPM") { BasicText(formatBpm(t.bpm), style = T.mono(17.sp, C.fg)) }
		Fact("Key") { if (t.key != null) KeyChip(t.key, height = 22.dp, fontSize = 13f) else BasicText("–", style = T.mono(17.sp, C.fg)) }
		Fact("Time") { BasicText(formatTime(t.durationSec?.toDouble()), style = T.mono(17.sp, C.fg)) }
		Fact("Rating") {
			BasicText(
				buildAnnotatedString {
					append(t.rating?.toString() ?: "–")
					withStyle(SpanStyle(fontSize = 13.sp, color = C.fg2)) { append("/5") }
				},
				style = T.mono(17.sp, C.fg),
			)
		}
	}
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.Fact(label: String, value: @Composable () -> Unit) {
	Column(Modifier.weight(1f).padding(vertical = 9.dp).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(4.dp)) {
		BasicText(label, style = T.label)
		value()
	}
}

private fun Modifier.topBottomLines(): Modifier = drawBehind {
	val w = 1.dp.toPx()
	drawLine(C.lineSoft, androidx.compose.ui.geometry.Offset(0f, 0f), androidx.compose.ui.geometry.Offset(size.width, 0f), w)
	drawLine(C.lineSoft, androidx.compose.ui.geometry.Offset(0f, size.height), androidx.compose.ui.geometry.Offset(size.width, size.height), w)
}

// Power, Brightness, Density as the track's percentile in the library; rows
// with no value are left out (Punch: no such column on track, §4).
@Composable
private fun Sound(t: Track, m: Metrics) {
	val rows = listOfNotNull(
		m.power(t.power)?.let { "Power" to it },
		m.brightness(t.brightness)?.let { "Brightness" to it },
		m.density(t.density)?.let { "Density" to it },
	)
	if (rows.isEmpty()) return
	Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
		for ((label, v) in rows) {
			Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = "$label %.2f".format(v) }) {
				BasicText(label, Modifier.width(88.dp), style = T.of(13.sp, color = C.fg1))
				Box(Modifier.weight(1f).height(5.dp).background(C.bg3)) { Box(Modifier.fillMaxWidth(v.toFloat()).fillMaxHeight().background(C.fg2)) }
				BasicText("%.2f".format(v), Modifier.width(36.dp), style = T.mono(12.5.sp, C.fg).copy(textAlign = androidx.compose.ui.text.style.TextAlign.End))
			}
		}
	}
}

@Composable
private fun Boxed(text: String, label: String, w: Dp, h: Dp, mono: Boolean = false, onClick: () -> Unit) {
	Box(
		Modifier.size(w, h).border(1.dp, C.line).clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) { BasicText(text, style = if (mono) T.mono(12.5.sp, C.fg1) else T.of(13.sp, color = C.fg1), maxLines = 1, softWrap = false) }
}

@Composable
private fun BoxedIcon(icon: Icon, label: String, w: Dp, h: Dp, enabled: Boolean, onClick: () -> Unit) {
	Box(
		Modifier.size(w, h).border(1.dp, C.line).clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
		contentAlignment = Alignment.Center,
	) { IconGlyph(icon, if (enabled) C.fg1 else C.fg4, 20.dp) }
}

@Composable
private fun Landscape(
	t: Track, a: TrackAnalysis, peaks: Peaks?, position: Double, duration: Double, zoom: Float, tr: Transport,
	back: () -> Unit, openActions: () -> Unit, onZoom: (Float) -> Unit, onCycleZoom: () -> Unit,
	onScrub: (Double) -> Unit, onSeek: (Double) -> Unit,
) {
	val span = zoom * 4 * beatLength(a.beats, t.bpm, position)
	Column(Modifier.fillMaxSize().background(C.bg).windowInsetsPadding(WindowInsets.safeDrawing).padding(horizontal = 8.dp)) {
		Row(Modifier.fillMaxWidth().height(46.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			IconButton(Icon.Back, "Back to portrait", size = 20.dp, onClick = back)
			Cover(t.coverUrl, t.id, 30.dp)
			Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Line(t.title, T.of(15.sp, 500, C.fg), Modifier.weight(1f, fill = false))
				Line(listOf(t.artist, t.label).filter { !it.isNullOrEmpty() }.joinToString(" · "), T.of(13.5.sp, color = C.fg2), Modifier.weight(1f, fill = false))
			}
			BasicText(formatBpm(t.bpm, 1), style = T.mono(14.sp, C.fg))
			KeyChip(t.key, height = 20.dp, fontSize = 12.5f)
			// The track's power tag (p1–p5), when it carries one.
			t.tags.firstOrNull { Regex("^p\\d$").matches(it) }?.let { BasicText(it, style = T.mono(12.5.sp, C.fg2)) }
			IconButton(Icon.Menu, "Track actions", tint = C.fg, onClick = openActions)
		}
		androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxWidth().height(192.dp)) {
			BigWave(peaks, position, duration, a.beats, a.downbeats, t.bpm, zoom, a.cues, a.phrases,
				Modifier.fillMaxSize().semantics { contentDescription = "Waveform, ${zoom.toInt()} bars around the playhead. Drag to scrub" },
				onScrub = onScrub, onSeek = onSeek, onZoom = onZoom)
			// Just right of the centre playhead, over the bar numbers' row.
			readout(a.beats, a.downbeats, a.phrases, position)?.let {
				BasicText(it, Modifier.padding(start = maxWidth / 2 + 6.dp, top = 4.dp).background(Color.Black.copy(alpha = 0.6f)).padding(horizontal = 4.dp, vertical = 1.dp), style = T.mono(11.sp, C.fg))
			}
		}
		OverviewMap(
			peaks, duration, position, a.cues,
			Modifier.fillMaxWidth().height(42.dp).padding(top = 0.dp).semantics { contentDescription = "Track overview. The box is the window above" },
			window = (position - span / 2)..(position + span / 2), badge = androidx.compose.ui.geometry.Size(13f, 12f),
			onScrub = onScrub, onSeek = onSeek,
		)
		Row(Modifier.fillMaxWidth().weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
			BasicText(formatTime(position), Modifier.width(64.dp), style = T.mono(13.sp, C.fg))
			Spacer(Modifier.weight(1f))
			Boxed("-16", "Back 16 beats", 52.dp, 44.dp, mono = true) { tr.onJump(-16) }
			Boxed("-4", "Back 4 beats", 48.dp, 44.dp, mono = true) { tr.onJump(-4) }
			Boxed("Cue", "Cue", 56.dp, 44.dp) { tr.onCue() }
			Box(
				Modifier.size(64.dp, 44.dp).background(C.fg).clickable(role = Role.Button, onClick = tr.onPlay).semantics { contentDescription = if (tr.playing) "Pause" else "Play" },
				contentAlignment = Alignment.Center,
			) { IconGlyph(if (tr.playing) Icon.Pause else Icon.Play, Color.Black, 20.dp) }
			Boxed("+4", "Forward 4 beats", 48.dp, 44.dp, mono = true) { tr.onJump(4) }
			Boxed("+16", "Forward 16 beats", 52.dp, 44.dp, mono = true) { tr.onJump(16) }
			Boxed("${zoom.toInt()} bars", "Zoom: ${zoom.toInt()} bars. Tap to change", 68.dp, 44.dp) { onCycleZoom() }
			Spacer(Modifier.weight(1f))
			BasicText("-" + formatTime(duration - position), Modifier.width(64.dp), style = T.mono(13.sp, C.fg2).copy(textAlign = androidx.compose.ui.text.style.TextAlign.End))
		}
	}
}
